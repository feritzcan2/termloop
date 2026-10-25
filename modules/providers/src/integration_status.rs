//! Bounded, non-interactive connection probes for the Git-host CLIs and the
//! daemon-held Azure DevOps personal access token.
//!
//! Probes only report typed connection facts. They never return credential
//! material, and the stored Azure DevOps token reaches `az` exclusively as the
//! `AZURE_DEVOPS_EXT_PAT` child environment variable — never argv, logs, or
//! results.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use termloop_platform::{
    CommandRequest, CommandTermination, LaunchEnvironment, MonotonicDeadline, SecureSecret,
};

use super::{
    GITHUB_HOST, ProviderFailure, azure_cli_request, github_cli_request, valid_github_login,
};

/// Environment variable the `azure-devops` CLI extension reads a PAT from.
pub const AZURE_DEVOPS_PAT_ENVIRONMENT: &str = "AZURE_DEVOPS_EXT_PAT";
const AZURE_DEVOPS_PAT_MAX_BYTES: usize = 1_024;
const ACCOUNT_MAX_BYTES: usize = 120;
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
const PROBE_MAX_TIMEOUT: Duration = Duration::from_secs(20);

static PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Shared, replaceable Azure DevOps PAT. Every clone observes the same value,
/// so the daemon can install or remove the token without rebuilding clients.
#[derive(Clone, Default)]
pub struct AzureDevOpsCredential {
    token: Arc<RwLock<Option<SecureSecret>>>,
    generation: Arc<AtomicU64>,
}

impl std::fmt::Debug for AzureDevOpsCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AzureDevOpsCredential")
            .field("present", &self.is_present())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Azure DevOps personal access token is invalid")]
pub struct InvalidAzureDevOpsToken;

impl AzureDevOpsCredential {
    /// Installs (`Some`) or removes (`None`) the token. A malformed token is
    /// rejected and leaves the current value unchanged.
    pub fn replace(&self, token: Option<SecureSecret>) -> Result<(), InvalidAzureDevOpsToken> {
        if token
            .as_ref()
            .is_some_and(|token| !valid_azure_devops_personal_access_token(token.expose()))
        {
            return Err(InvalidAzureDevOpsToken);
        }
        *self.token.write().unwrap_or_else(PoisonError::into_inner) = token;
        self.generation.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Changes on every install or removal so clients can drop failure
    /// suppression recorded under the previous credential.
    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn is_present(&self) -> bool {
        self.token
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// Adds the token to one `az` request's child environment when present.
    pub(crate) fn apply(&self, request: CommandRequest) -> CommandRequest {
        let token = self.token.read().unwrap_or_else(PoisonError::into_inner);
        match token
            .as_ref()
            .and_then(|token| std::str::from_utf8(token.expose()).ok())
        {
            Some(value) => request.environment(AZURE_DEVOPS_PAT_ENVIRONMENT, value),
            None => request,
        }
    }
}

/// A PAT is a bounded run of visible ASCII; whitespace and control bytes are
/// never valid in an environment-delivered secret.
pub fn valid_azure_devops_personal_access_token(value: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= AZURE_DEVOPS_PAT_MAX_BYTES
        && value.iter().all(u8::is_ascii_graphic)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegrationProbeState {
    Connected,
    NotInstalled,
    NotAuthenticated,
    ExtensionMissing,
    Offline,
    RateLimited,
    Timeout,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegrationProbeCredential {
    Cli,
    PersonalAccessToken,
}

/// Secret-free result of one provider probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationProbe {
    pub state: IntegrationProbeState,
    pub account: Option<String>,
    pub credential: Option<IntegrationProbeCredential>,
    pub retry_after_epoch_ms: Option<u64>,
}

impl IntegrationProbe {
    pub fn degraded(state: IntegrationProbeState) -> Self {
        Self {
            state,
            account: None,
            credential: None,
            retry_after_epoch_ms: None,
        }
    }

    fn connected(credential: IntegrationProbeCredential, account: Option<String>) -> Self {
        Self {
            state: IntegrationProbeState::Connected,
            account,
            credential: Some(credential),
            retry_after_epoch_ms: None,
        }
    }
}

/// Probes `gh` for github.com: installed, authenticated, and the signed-in
/// login. The whole probe is bounded by `timeout`.
pub fn probe_github_cli(registry_directory: &Path, timeout: Duration) -> IntegrationProbe {
    let Some(mut runner) = CliProbeRunner::new(
        CliProgram::GitHub,
        LaunchEnvironment::os_baseline(),
        None,
        registry_directory,
        timeout,
    ) else {
        return IntegrationProbe::degraded(IntegrationProbeState::Timeout);
    };
    probe_github(&mut runner)
}

/// Probes `az` and its `azure-devops` extension. A stored PAT is the
/// credential when present; otherwise the `az login` account is used.
pub fn probe_azure_devops_cli(
    registry_directory: &Path,
    credential: &AzureDevOpsCredential,
    timeout: Duration,
) -> IntegrationProbe {
    let Some(mut runner) = CliProbeRunner::new(
        CliProgram::Azure,
        LaunchEnvironment::os_baseline(),
        Some(credential.clone()),
        registry_directory,
        timeout,
    ) else {
        return IntegrationProbe::degraded(IntegrationProbeState::Timeout);
    };
    probe_azure(&mut runner, credential.is_present())
}

struct ProbeOutput {
    termination: CommandTermination,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

impl ProbeOutput {
    fn success(&self) -> bool {
        self.termination == (CommandTermination::Exited { code: 0 }) && !self.truncated
    }

    fn timed_out(&self) -> bool {
        self.termination == CommandTermination::TimedOut
    }

    fn diagnostics(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.stderr).to_ascii_lowercase();
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&self.stdout).to_ascii_lowercase());
        text
    }
}

/// The CLI could not be resolved or spawned.
struct ProbeNotInstalled;

trait ProbeRunner {
    fn run(&mut self, arguments: &[&str]) -> Result<ProbeOutput, ProbeNotInstalled>;
}

#[derive(Clone, Copy)]
enum CliProgram {
    GitHub,
    Azure,
}

struct CliProbeRunner {
    program: CliProgram,
    environment: LaunchEnvironment,
    credential: Option<AzureDevOpsCredential>,
    registry_directory: PathBuf,
    deadline: MonotonicDeadline,
}

impl CliProbeRunner {
    fn new(
        program: CliProgram,
        environment: LaunchEnvironment,
        credential: Option<AzureDevOpsCredential>,
        registry_directory: &Path,
        timeout: Duration,
    ) -> Option<Self> {
        Some(Self {
            program,
            environment,
            credential,
            registry_directory: registry_directory.to_owned(),
            deadline: MonotonicDeadline::after(timeout.min(PROBE_MAX_TIMEOUT)).ok()?,
        })
    }

    fn request(&self) -> Result<CommandRequest, ProviderFailure> {
        let request = match self.program {
            CliProgram::GitHub => github_cli_request(self.environment.clone())?,
            CliProgram::Azure => azure_cli_request(self.environment.clone())?,
        };
        Ok(match &self.credential {
            Some(credential) => credential.apply(request),
            None => request,
        })
    }
}

impl ProbeRunner for CliProbeRunner {
    fn run(&mut self, arguments: &[&str]) -> Result<ProbeOutput, ProbeNotInstalled> {
        let Some(remaining) = self.deadline.remaining() else {
            return Ok(ProbeOutput {
                termination: CommandTermination::TimedOut,
                stdout: Vec::new(),
                stderr: Vec::new(),
                truncated: false,
            });
        };
        let request = self.request().map_err(|_| ProbeNotInstalled)?;
        let id = PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let outcome = termloop_platform::run_command(
            request
                .args(arguments.iter().copied())
                .timeout(remaining)
                .output_limit(PROBE_OUTPUT_LIMIT)
                .tracked(&self.registry_directory, format!("integration-probe-{id}")),
        )
        .map_err(|_| ProbeNotInstalled)?;
        Ok(ProbeOutput {
            truncated: outcome.stdout_truncated || outcome.stderr_truncated,
            termination: outcome.termination,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
        })
    }
}

fn probe_github(runner: &mut dyn ProbeRunner) -> IntegrationProbe {
    use IntegrationProbeState as State;
    match runner.run(&["--version"]) {
        Err(ProbeNotInstalled) => return IntegrationProbe::degraded(State::NotInstalled),
        Ok(output) if output.timed_out() => return IntegrationProbe::degraded(State::Timeout),
        Ok(output) if !output.success() => return IntegrationProbe::degraded(State::Failed),
        Ok(_) => {}
    }
    match runner.run(&["auth", "status", "--hostname", GITHUB_HOST]) {
        Err(ProbeNotInstalled) => return IntegrationProbe::degraded(State::NotInstalled),
        Ok(output) if output.timed_out() => return IntegrationProbe::degraded(State::Timeout),
        Ok(output) if !output.success() => {
            return IntegrationProbe::degraded(
                classify_transport(&output.diagnostics()).unwrap_or(State::NotAuthenticated),
            );
        }
        Ok(_) => {}
    }
    match runner.run(&["api", "--hostname", GITHUB_HOST, "user", "--jq", ".login"]) {
        Err(ProbeNotInstalled) => IntegrationProbe::degraded(State::NotInstalled),
        Ok(output) if output.timed_out() => IntegrationProbe::degraded(State::Timeout),
        Ok(output) if !output.success() => {
            let diagnostics = output.diagnostics();
            IntegrationProbe::degraded(classify_transport(&diagnostics).unwrap_or(
                if unauthorized(&diagnostics) {
                    State::NotAuthenticated
                } else {
                    State::Failed
                },
            ))
        }
        Ok(output) => IntegrationProbe::connected(
            IntegrationProbeCredential::Cli,
            github_login(&output.stdout),
        ),
    }
}

/// A saved PAT is reported in every state so clients can offer to replace or
/// remove it even while the CLI itself is missing.
fn probe_azure(runner: &mut dyn ProbeRunner, token_present: bool) -> IntegrationProbe {
    let mut probe = probe_azure_cli(runner, token_present);
    if token_present {
        probe.credential = Some(IntegrationProbeCredential::PersonalAccessToken);
    }
    probe
}

fn probe_azure_cli(runner: &mut dyn ProbeRunner, token_present: bool) -> IntegrationProbe {
    use IntegrationProbeState as State;
    match runner.run(&["version", "--output", "json", "--only-show-errors"]) {
        Err(ProbeNotInstalled) => return IntegrationProbe::degraded(State::NotInstalled),
        Ok(output) if output.timed_out() => return IntegrationProbe::degraded(State::Timeout),
        Ok(output) if !output.success() => return IntegrationProbe::degraded(State::Failed),
        Ok(_) => {}
    }
    match runner.run(&[
        "extension",
        "show",
        "--name",
        "azure-devops",
        "--output",
        "json",
        "--only-show-errors",
    ]) {
        Err(ProbeNotInstalled) => return IntegrationProbe::degraded(State::NotInstalled),
        Ok(output) if output.timed_out() => return IntegrationProbe::degraded(State::Timeout),
        Ok(output) if !output.success() => {
            return IntegrationProbe::degraded(State::ExtensionMissing);
        }
        Ok(_) => {}
    }
    if token_present {
        return IntegrationProbe::connected(IntegrationProbeCredential::PersonalAccessToken, None);
    }
    match runner.run(&[
        "account",
        "show",
        "--query",
        "user.name",
        "--output",
        "tsv",
        "--only-show-errors",
    ]) {
        Err(ProbeNotInstalled) => IntegrationProbe::degraded(State::NotInstalled),
        Ok(output) if output.timed_out() => IntegrationProbe::degraded(State::Timeout),
        Ok(output) if !output.success() => IntegrationProbe::degraded(
            classify_transport(&output.diagnostics()).unwrap_or(State::NotAuthenticated),
        ),
        Ok(output) => IntegrationProbe::connected(
            IntegrationProbeCredential::Cli,
            bounded_account(&output.stdout),
        ),
    }
}

/// Network and throttling failures are typed independently of the command
/// that observed them; `None` leaves the command-specific mapping in charge.
fn classify_transport(diagnostics: &str) -> Option<IntegrationProbeState> {
    if diagnostics.contains("rate limit")
        || diagnostics.contains("429")
        || diagnostics.contains("too many requests")
    {
        Some(IntegrationProbeState::RateLimited)
    } else if diagnostics.contains("could not resolve")
        || diagnostics.contains("no such host")
        || diagnostics.contains("error connecting")
        || diagnostics.contains("connection")
        || diagnostics.contains("network")
        || diagnostics.contains("dial tcp")
    {
        Some(IntegrationProbeState::Offline)
    } else if diagnostics.contains("timed out") || diagnostics.contains("timeout") {
        Some(IntegrationProbeState::Timeout)
    } else {
        None
    }
}

fn unauthorized(diagnostics: &str) -> bool {
    diagnostics.contains("401")
        || diagnostics.contains("bad credentials")
        || diagnostics.contains("not logged")
        || diagnostics.contains("authentication")
        || diagnostics.contains("gh auth login")
}

/// Accepts only the exact GitHub login grammar so arbitrary CLI output can
/// never become an account label.
fn github_login(stdout: &[u8]) -> Option<String> {
    let value = std::str::from_utf8(stdout).ok()?.trim();
    valid_github_login(value).then(|| value.to_owned())
}

/// First non-empty line, free of control characters, at most 120 bytes.
fn bounded_account(stdout: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(stdout).ok()?;
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    if line.chars().any(char::is_control) {
        return None;
    }
    let mut end = line.len().min(ACCOUNT_MAX_BYTES);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    let bounded = line[..end].trim_end();
    (!bounded.is_empty()).then(|| bounded.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct FakeRunner {
        responses: VecDeque<Result<ProbeOutput, ProbeNotInstalled>>,
        calls: Vec<Vec<String>>,
    }

    impl FakeRunner {
        fn new(responses: Vec<Result<ProbeOutput, ProbeNotInstalled>>) -> Self {
            Self {
                responses: responses.into(),
                calls: Vec::new(),
            }
        }
    }

    impl ProbeRunner for FakeRunner {
        fn run(&mut self, arguments: &[&str]) -> Result<ProbeOutput, ProbeNotInstalled> {
            self.calls
                .push(arguments.iter().map(|value| (*value).to_owned()).collect());
            self.responses
                .pop_front()
                .expect("unexpected extra probe command")
        }
    }

    fn exited(code: i32, stdout: &str, stderr: &str) -> Result<ProbeOutput, ProbeNotInstalled> {
        Ok(ProbeOutput {
            termination: CommandTermination::Exited { code },
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
            truncated: false,
        })
    }

    fn timed_out() -> Result<ProbeOutput, ProbeNotInstalled> {
        Ok(ProbeOutput {
            termination: CommandTermination::TimedOut,
            stdout: Vec::new(),
            stderr: Vec::new(),
            truncated: false,
        })
    }

    fn github(responses: Vec<Result<ProbeOutput, ProbeNotInstalled>>) -> IntegrationProbe {
        probe_github(&mut FakeRunner::new(responses))
    }

    fn azure(
        token_present: bool,
        responses: Vec<Result<ProbeOutput, ProbeNotInstalled>>,
    ) -> IntegrationProbe {
        probe_azure(&mut FakeRunner::new(responses), token_present)
    }

    #[test]
    fn github_connected_probe_reports_cli_credential_and_exact_login() {
        let mut runner = FakeRunner::new(vec![
            exited(0, "gh version 2.60.0\n", ""),
            exited(
                0,
                "",
                "github.com\n  Logged in to github.com account octo-cat\n",
            ),
            exited(0, "octo-cat\n", ""),
        ]);
        let probe = probe_github(&mut runner);
        assert_eq!(
            probe,
            IntegrationProbe {
                state: IntegrationProbeState::Connected,
                account: Some("octo-cat".into()),
                credential: Some(IntegrationProbeCredential::Cli),
                retry_after_epoch_ms: None,
            }
        );
        assert_eq!(
            runner.calls[1],
            ["auth", "status", "--hostname", "github.com"]
        );
        assert_eq!(
            runner.calls[2],
            ["api", "--hostname", "github.com", "user", "--jq", ".login"]
        );
    }

    #[test]
    fn github_degraded_states_are_typed() {
        assert_eq!(
            github(vec![Err(ProbeNotInstalled)]).state,
            IntegrationProbeState::NotInstalled
        );
        assert_eq!(
            github(vec![timed_out()]).state,
            IntegrationProbeState::Timeout
        );
        assert_eq!(
            github(vec![
                exited(0, "gh version", ""),
                exited(
                    1,
                    "",
                    "You are not logged into any GitHub hosts. To log in, run: gh auth login"
                ),
            ])
            .state,
            IntegrationProbeState::NotAuthenticated
        );
        assert_eq!(
            github(vec![
                exited(0, "gh version", ""),
                exited(1, "", "error connecting to api.github.com"),
            ])
            .state,
            IntegrationProbeState::Offline
        );
        assert_eq!(
            github(vec![
                exited(0, "gh version", ""),
                exited(0, "", "Logged in"),
                exited(
                    1,
                    "",
                    "gh: API rate limit exceeded for user ID 1. (HTTP 403)"
                ),
            ])
            .state,
            IntegrationProbeState::RateLimited
        );
        assert_eq!(
            github(vec![
                exited(0, "gh version", ""),
                exited(0, "", "Logged in"),
                exited(1, "", "gh: Bad credentials (HTTP 401)"),
            ])
            .state,
            IntegrationProbeState::NotAuthenticated
        );
        assert_eq!(
            github(vec![
                exited(0, "gh version", ""),
                exited(0, "", "Logged in"),
                timed_out(),
            ])
            .state,
            IntegrationProbeState::Timeout
        );
        let degraded = github(vec![
            exited(0, "gh version", ""),
            exited(1, "", "token ghp_secretvalue is invalid"),
        ]);
        assert_eq!(degraded.account, None);
        assert_eq!(degraded.credential, None);
    }

    #[test]
    fn github_login_rejects_anything_but_the_login_grammar() {
        assert_eq!(github_login(b"octo-cat\n"), Some("octo-cat".into()));
        assert_eq!(github_login(b""), None);
        assert_eq!(github_login(b"two words"), None);
        assert_eq!(github_login(b"-leading"), None);
        assert_eq!(github_login("a".repeat(40).as_bytes()), None);
    }

    #[test]
    fn azure_probe_maps_install_extension_and_credential_states() {
        assert_eq!(
            azure(false, vec![Err(ProbeNotInstalled)]).state,
            IntegrationProbeState::NotInstalled
        );
        assert_eq!(
            azure(false, vec![timed_out()]).state,
            IntegrationProbeState::Timeout
        );
        assert_eq!(
            azure(
                false,
                vec![
                    exited(0, "{}", ""),
                    exited(1, "", "ERROR: The extension azure-devops is not installed."),
                ]
            )
            .state,
            IntegrationProbeState::ExtensionMissing
        );
        assert_eq!(
            azure(
                false,
                vec![
                    exited(0, "{}", ""),
                    exited(0, "{}", ""),
                    exited(1, "", "ERROR: Please run 'az login' to setup account."),
                ]
            )
            .state,
            IntegrationProbeState::NotAuthenticated
        );
        assert_eq!(
            azure(
                false,
                vec![
                    exited(0, "{}", ""),
                    exited(0, "{}", ""),
                    exited(0, "ada@example.com\n", ""),
                ]
            ),
            IntegrationProbe {
                state: IntegrationProbeState::Connected,
                account: Some("ada@example.com".into()),
                credential: Some(IntegrationProbeCredential::Cli),
                retry_after_epoch_ms: None,
            }
        );
    }

    #[test]
    fn azure_stored_token_is_the_credential_without_an_account_lookup() {
        let mut runner = FakeRunner::new(vec![exited(0, "{}", ""), exited(0, "{}", "")]);
        let probe = probe_azure(&mut runner, true);
        assert_eq!(
            probe,
            IntegrationProbe {
                state: IntegrationProbeState::Connected,
                account: None,
                credential: Some(IntegrationProbeCredential::PersonalAccessToken),
                retry_after_epoch_ms: None,
            }
        );
        assert_eq!(runner.calls.len(), 2);
        assert!(runner.calls[1].contains(&"azure-devops".to_owned()));
    }

    #[test]
    fn account_labels_are_bounded_and_control_free() {
        assert_eq!(bounded_account(b"\n  ada \n"), Some("ada".into()));
        assert_eq!(bounded_account(b"bad\x07bell"), None);
        assert_eq!(bounded_account(b"   "), None);
        let long = "é".repeat(100);
        let bounded = bounded_account(long.as_bytes()).unwrap();
        assert!(bounded.len() <= ACCOUNT_MAX_BYTES);
        assert!(bounded.chars().all(|character| character == 'é'));
    }

    #[test]
    fn token_validation_rejects_whitespace_control_and_oversize_values() {
        assert!(valid_azure_devops_personal_access_token(b"abc123"));
        assert!(!valid_azure_devops_personal_access_token(b""));
        assert!(!valid_azure_devops_personal_access_token(b"has space"));
        assert!(!valid_azure_devops_personal_access_token(b"line\nbreak"));
        assert!(!valid_azure_devops_personal_access_token(
            "a".repeat(1_025).as_bytes()
        ));
        let credential = AzureDevOpsCredential::default();
        assert_eq!(
            credential.replace(SecureSecret::new(b"bad token".to_vec())),
            Err(InvalidAzureDevOpsToken)
        );
        assert!(!credential.is_present());
        credential
            .replace(SecureSecret::new(b"pat-value".to_vec()))
            .unwrap();
        assert!(credential.is_present());
        assert!(!format!("{credential:?}").contains("pat-value"));
        credential.replace(None).unwrap();
        assert!(!credential.is_present());
    }

    fn fixture_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "termloop-integration-probe-{label}-{}-{}",
            std::process::id(),
            termloop_platform::current_epoch_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// A fake `az` echoes whether the PAT arrived through its environment, so
    /// this proves the real request composition without a real CLI.
    #[test]
    fn stored_token_reaches_az_only_through_its_environment_variable() {
        let directory = fixture_directory("pat");
        termloop_platform::test_support::write_cli_fixture(
            &directory,
            "az",
            "#!/bin/sh\nprintf 'args=%s pat=(%s)\\n' \"$*\" \"$AZURE_DEVOPS_EXT_PAT\"\n",
            "@echo off\r\necho args=%* pat=(%AZURE_DEVOPS_EXT_PAT%)\r\n",
        )
        .unwrap();
        let environment = LaunchEnvironment::os_baseline()
            .with_explicit("PATH", &directory)
            .with_explicit(AZURE_DEVOPS_PAT_ENVIRONMENT, "");
        let credential = AzureDevOpsCredential::default();
        let run = |credential: &AzureDevOpsCredential| {
            let mut runner = CliProbeRunner::new(
                CliProgram::Azure,
                environment.clone(),
                Some(credential.clone()),
                &directory,
                Duration::from_secs(20),
            )
            .unwrap();
            let output = runner.run(&["version"]).ok().unwrap();
            assert!(output.success());
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        assert!(!run(&credential).contains("pat-value"));
        credential
            .replace(SecureSecret::new(b"pat-value".to_vec()))
            .unwrap();
        let stdout = run(&credential);
        assert!(stdout.contains("pat=(pat-value)"), "{stdout}");
        assert!(stdout.contains("args=version "), "{stdout}");
        assert!(!stdout.contains("args=version pat-value"));
        credential.replace(None).unwrap();
        assert!(!run(&credential).contains("pat-value"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn missing_cli_probe_is_not_installed() {
        let directory = fixture_directory("missing");
        let environment = LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        for program in [CliProgram::GitHub, CliProgram::Azure] {
            let mut runner = CliProbeRunner::new(
                program,
                environment.clone(),
                None,
                &directory,
                Duration::from_secs(5),
            )
            .unwrap();
            let probe = match program {
                CliProgram::GitHub => probe_github(&mut runner),
                CliProgram::Azure => probe_azure(&mut runner, false),
            };
            assert_eq!(probe.state, IntegrationProbeState::NotInstalled);
        }
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn azure_client_requests_carry_the_shared_token() {
        let directory = fixture_directory("client");
        let credential = AzureDevOpsCredential::default();
        let with_token =
            super::super::AzureDevOpsClient::new(&directory).with_credential(credential.clone());
        let without_token = super::super::AzureDevOpsClient::new(&directory);
        credential
            .replace(SecureSecret::new(b"pat-value".to_vec()))
            .unwrap();
        // Both clients start at the same record sequence, so the requests
        // differ only by the credential's environment delta.
        match (
            with_token.base_request(Duration::from_secs(1)),
            without_token.base_request(Duration::from_secs(1)),
        ) {
            (Ok(with_token), Ok(without_token)) => {
                assert_ne!(with_token, without_token);
                assert_eq!(with_token, credential.apply(without_token));
            }
            (Err(left), Err(right)) => {
                assert_eq!(left, ProviderFailure::ProviderUnavailable);
                assert_eq!(right, ProviderFailure::ProviderUnavailable);
            }
            _ => panic!("credential must not change CLI resolution"),
        }
        let _ = std::fs::remove_dir_all(directory);
    }
}
