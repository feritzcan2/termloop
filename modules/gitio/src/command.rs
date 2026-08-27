use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::time::Duration;

use termloop_platform::{CommandOutcome, CommandRequest, CommandTermination};

use crate::error::{command_failure, map_platform_error};
use crate::{GitError, GitOperation};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
pub const HEALTH_GIT_SUBPROCESS_DEADLINE: Duration = Duration::from_millis(2_500);
pub const CLEANUP_GIT_SUBPROCESS_DEADLINE: Duration = Duration::from_secs(5);
pub const CLEANUP_GIT_MUTATION_DEADLINE: Duration = Duration::from_secs(60);
const HEALTH_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

/// Git for Windows writes CRLF for line-oriented stdout when the pipe is in
/// text mode. Payload bytes stay exact; parsers remove only the transport-level
/// carriage return immediately before a parsed newline.
pub(crate) fn strip_git_line_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitVersion {
    pub major: u16,
    pub minor: u16,
    pub patch: u16,
    pub vendor_suffix: Option<String>,
}

impl std::fmt::Display for GitVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(suffix) = &self.vendor_suffix {
            write!(formatter, " {suffix}")?;
        }
        Ok(())
    }
}

impl GitVersion {
    fn at_least(&self, major: u16, minor: u16, patch: u16) -> bool {
        (self.major, self.minor, self.patch) >= (major, minor, patch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitCapabilities {
    pub repository_observation: bool,
    pub worktree_porcelain_nul: bool,
}

#[derive(Clone)]
pub struct GitRunner {
    program: OsString,
    version: GitVersion,
    capabilities: GitCapabilities,
    timeout: Duration,
    output_limit: usize,
    absolute_deadline: Option<termloop_platform::MonotonicDeadline>,
}

impl std::fmt::Debug for GitRunner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitRunner")
            .field("program", &"<redacted>")
            .field("version", &self.version)
            .field("capabilities", &self.capabilities)
            .field("timeout", &self.timeout)
            .field("output_limit", &self.output_limit)
            .field(
                "absolute_deadline",
                &self.absolute_deadline.map(|_| "bounded"),
            )
            .finish()
    }
}

impl GitRunner {
    pub fn discover() -> Result<Self, GitError> {
        Self::discover_program("git")
    }

    pub fn discover_program(program: impl Into<OsString>) -> Result<Self, GitError> {
        Self::discover_program_with_timeout(program, Duration::from_secs(10))
            .map(Self::without_absolute_deadline)
    }

    /// Starts one absolute observation deadline before executable discovery.
    /// Every command run by the returned runner consumes the same remaining
    /// budget, so platform timeout handling can terminate the actual process
    /// tree instead of an async caller merely dropping a blocking future.
    pub fn discover_with_timeout(timeout: Duration) -> Result<Self, GitError> {
        Self::discover_program_with_timeout("git", timeout)
    }

    pub fn discover_program_with_timeout(
        program: impl Into<OsString>,
        timeout: Duration,
    ) -> Result<Self, GitError> {
        let program = program.into();
        let deadline = termloop_platform::MonotonicDeadline::after(timeout)
            .map_err(|error| map_platform_error(error, GitOperation::Discover))?;
        let discovery_timeout = deadline
            .remaining()
            .filter(|remaining| !remaining.is_zero())
            .ok_or(GitError::Timeout {
                operation: GitOperation::Discover,
            })?;
        let outcome = termloop_platform::run_command(
            base_request(&program, None, [OsString::from("--version")])
                .timeout(discovery_timeout)
                .output_limit(16 * 1024),
        )
        .map_err(|error| map_platform_error(error, GitOperation::Discover))?;
        ensure_complete(&outcome, GitOperation::Discover)?;
        if !outcome.success() {
            let stderr = String::from_utf8_lossy(&outcome.stderr);
            if stderr.contains("xcrun") || stderr.contains("developer tools") {
                return Err(GitError::GitUnavailable);
            }
            return Err(command_failure(
                GitOperation::Discover,
                outcome.termination,
                &outcome.stderr,
            ));
        }
        let version = parse_version(&outcome.stdout)?;
        let capabilities = GitCapabilities {
            repository_observation: version.at_least(2, 36, 0),
            worktree_porcelain_nul: version.at_least(2, 36, 0),
        };
        if !capabilities.repository_observation {
            return Err(GitError::UnsupportedVersion {
                version: version.to_string(),
                capability: "repository observation",
            });
        }
        Ok(Self {
            program,
            version,
            capabilities,
            timeout: DEFAULT_TIMEOUT,
            output_limit: DEFAULT_OUTPUT_LIMIT,
            absolute_deadline: Some(deadline),
        })
    }

    pub fn version(&self) -> &GitVersion {
        &self.version
    }

    pub fn capabilities(&self) -> GitCapabilities {
        self.capabilities
    }

    pub fn with_limits(mut self, timeout: Duration, output_limit: usize) -> Self {
        self.timeout = timeout;
        self.output_limit = output_limit;
        self
    }

    /// Clears a completed observation's deadline before the runner is carried
    /// into a later, separately bounded mutation stage.
    pub fn without_absolute_deadline(mut self) -> Self {
        self.absolute_deadline = None;
        self
    }

    /// Applies a fresh absolute deadline to a later observation or mutation
    /// stage while preserving the already-discovered executable/version.
    pub fn with_absolute_timeout(mut self, timeout: Duration) -> Result<Self, GitError> {
        self.absolute_deadline = Some(
            termloop_platform::MonotonicDeadline::after(timeout)
                .map_err(|error| map_platform_error(error, GitOperation::Discover))?,
        );
        Ok(self)
    }

    pub(crate) fn with_shared_observation_budget(
        mut self,
        timeout: Duration,
        output_limit: usize,
    ) -> Result<Self, GitError> {
        self.timeout = timeout;
        self.output_limit = output_limit;
        if self.absolute_deadline.is_none() {
            self.absolute_deadline = Some(
                termloop_platform::MonotonicDeadline::after(timeout)
                    .map_err(|error| map_platform_error(error, GitOperation::Discover))?,
            );
        }
        Ok(self)
    }

    pub(crate) fn execute<I, S>(
        &self,
        operation: GitOperation,
        cwd: &Path,
        args: I,
    ) -> Result<CommandOutcome, GitError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.execute_with_limits(operation, cwd, args, self.timeout, self.output_limit)
    }

    fn execute_with_limits<I, S>(
        &self,
        operation: GitOperation,
        cwd: &Path,
        args: I,
        timeout: Duration,
        output_limit: usize,
    ) -> Result<CommandOutcome, GitError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let timeout = match self.absolute_deadline {
            Some(deadline) => deadline
                .remaining()
                .filter(|remaining| !remaining.is_zero())
                .map(|remaining| remaining.min(timeout))
                .ok_or(GitError::Timeout { operation })?,
            None => timeout,
        };
        let outcome = termloop_platform::run_command(
            base_request(&self.program, Some(cwd), args)
                .timeout(timeout)
                .output_limit(output_limit),
        )
        .map_err(|error| map_platform_error(error, operation))?;
        ensure_complete(&outcome, operation)?;
        Ok(outcome)
    }

    pub(crate) fn checked<I, S>(
        &self,
        operation: GitOperation,
        cwd: &Path,
        args: I,
    ) -> Result<CommandOutcome, GitError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let outcome = self.execute(operation, cwd, args)?;
        if outcome.success() {
            Ok(outcome)
        } else {
            Err(command_failure(
                operation,
                outcome.termination,
                &outcome.stderr,
            ))
        }
    }
}

pub(crate) struct GitCommandScope<'a> {
    runner: &'a GitRunner,
    deadline: Option<termloop_platform::MonotonicDeadline>,
    output_limit: usize,
    command_count: usize,
}

impl<'a> GitCommandScope<'a> {
    pub(crate) fn new(runner: &'a GitRunner) -> Self {
        Self {
            runner,
            deadline: None,
            output_limit: runner.output_limit,
            command_count: 0,
        }
    }

    pub(crate) fn bounded(runner: &'a GitRunner, timeout: Duration) -> Result<Self, GitError> {
        let deadline = match runner.absolute_deadline {
            Some(deadline) => deadline,
            None => termloop_platform::MonotonicDeadline::after(timeout)
                .map_err(|error| map_platform_error(error, GitOperation::Health))?,
        };
        Ok(Self {
            runner,
            deadline: Some(deadline),
            output_limit: runner.output_limit.min(HEALTH_OUTPUT_LIMIT),
            command_count: 0,
        })
    }

    pub(crate) fn command_count(&self) -> usize {
        self.command_count
    }

    pub(crate) fn execute<I, S>(
        &mut self,
        operation: GitOperation,
        cwd: &Path,
        args: I,
    ) -> Result<CommandOutcome, GitError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let timeout = match self.deadline {
            Some(deadline) => deadline
                .remaining()
                .filter(|remaining| !remaining.is_zero())
                .map(|remaining| remaining.min(self.runner.timeout))
                .ok_or(GitError::Timeout { operation })?,
            None => self.runner.timeout,
        };
        self.command_count += 1;
        self.runner
            .execute_with_limits(operation, cwd, args, timeout, self.output_limit)
    }

    pub(crate) fn checked<I, S>(
        &mut self,
        operation: GitOperation,
        cwd: &Path,
        args: I,
    ) -> Result<CommandOutcome, GitError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let outcome = self.execute(operation, cwd, args)?;
        if outcome.success() {
            Ok(outcome)
        } else {
            Err(command_failure(
                operation,
                outcome.termination,
                &outcome.stderr,
            ))
        }
    }
}

/// Deterministic Git configuration injected into every invocation through the
/// `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` mechanism.
///
/// `long_path_opt_in` is platform's OS fact: hosts that enforce the legacy
/// Windows `MAX_PATH` limit need Git's `core.longpaths` opt-in so managed
/// worktree destinations (deep `termloop-<slug>-<id>_worktree` siblings)
/// survive `git worktree add` and every later operation.
pub(crate) fn injected_git_config(long_path_opt_in: bool) -> Vec<(&'static str, &'static str)> {
    let mut entries = vec![("core.fsmonitor", "false")];
    if long_path_opt_in {
        entries.push(("core.longpaths", "true"));
    }
    entries
}

fn base_request<I, S>(program: &OsStr, cwd: Option<&Path>, args: I) -> CommandRequest
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut request = CommandRequest::new(program)
        .args(args)
        .environment("GIT_OPTIONAL_LOCKS", "0")
        .environment("GIT_TERMINAL_PROMPT", "0")
        .environment("LC_ALL", "C")
        .environment("LANG", "C")
        .remove_environment("GIT_DIR")
        .remove_environment("GIT_WORK_TREE")
        .remove_environment("GIT_COMMON_DIR")
        .remove_environment("GIT_INDEX_FILE")
        .remove_environment("GIT_OBJECT_DIRECTORY")
        .remove_environment("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .remove_environment("GIT_CEILING_DIRECTORIES")
        .remove_environment("GIT_DISCOVERY_ACROSS_FILESYSTEM")
        .remove_environment("GIT_NAMESPACE")
        .remove_environment("GIT_SHALLOW_FILE")
        .remove_environment("GIT_REPLACE_REF_BASE")
        .remove_environment("GIT_CONFIG_PARAMETERS");
    let config = injected_git_config(termloop_platform::host_requires_long_path_opt_in());
    request = request.environment("GIT_CONFIG_COUNT", config.len().to_string());
    for (index, (key, value)) in config.into_iter().enumerate() {
        request = request
            .environment(format!("GIT_CONFIG_KEY_{index}"), key)
            .environment(format!("GIT_CONFIG_VALUE_{index}"), value);
    }
    request = request
        .remove_environment("GIT_TRACE")
        .remove_environment("GIT_TRACE2")
        .remove_environment("GIT_TRACE2_BRIEF")
        .remove_environment("GIT_TRACE2_CONFIG_PARAMS")
        .remove_environment("GIT_TRACE2_DST_DEBUG")
        .remove_environment("GIT_TRACE2_ENV_VARS")
        .remove_environment("GIT_TRACE2_EVENT")
        .remove_environment("GIT_TRACE2_PARENT_NAME")
        .remove_environment("GIT_TRACE2_PERF")
        .remove_environment("GIT_TRACE_CURL")
        .remove_environment("GIT_TRACE_CURL_NO_DATA")
        .remove_environment("GIT_TRACE_FSMONITOR")
        .remove_environment("GIT_TRACE_PACKET")
        .remove_environment("GIT_TRACE_PACK_ACCESS")
        .remove_environment("GIT_TRACE_PERFORMANCE")
        .remove_environment("GIT_TRACE_REFS")
        .remove_environment("GIT_TRACE_REDACT")
        .remove_environment("GIT_TRACE_SETUP")
        .remove_environment("GIT_TRACE_SHALLOW");
    if let Some(cwd) = cwd {
        request = request.cwd(cwd);
    }
    request
}

fn ensure_complete(outcome: &CommandOutcome, operation: GitOperation) -> Result<(), GitError> {
    if outcome.termination == CommandTermination::TimedOut {
        return Err(GitError::Timeout { operation });
    }
    if outcome.stdout_truncated || outcome.stderr_truncated {
        return Err(GitError::OutputLimitExceeded { operation });
    }
    Ok(())
}

fn parse_version(bytes: &[u8]) -> Result<GitVersion, GitError> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| GitError::ParseFailed {
            operation: GitOperation::Discover,
        })?
        .trim();
    let value = value
        .strip_prefix("git version ")
        .ok_or(GitError::ParseFailed {
            operation: GitOperation::Discover,
        })?;
    let (number, suffix) = value
        .split_once(char::is_whitespace)
        .map_or((value, None), |(number, suffix)| {
            (number, Some(suffix.trim().to_owned()))
        });
    let mut parts = number.split('.');
    let major = parse_version_part(parts.next())?;
    let minor = parse_version_part(parts.next())?;
    let patch = parts.next().map_or(Ok(0), |part| {
        let numeric = part
            .bytes()
            .take_while(u8::is_ascii_digit)
            .collect::<Vec<_>>();
        std::str::from_utf8(&numeric)
            .ok()
            .and_then(|part| part.parse().ok())
            .ok_or(GitError::ParseFailed {
                operation: GitOperation::Discover,
            })
    })?;
    Ok(GitVersion {
        major,
        minor,
        patch,
        vendor_suffix: suffix.filter(|value| !value.is_empty()),
    })
}

fn parse_version_part(value: Option<&str>) -> Result<u16, GitError> {
    value
        .and_then(|value| value.parse().ok())
        .ok_or(GitError::ParseFailed {
            operation: GitOperation::Discover,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_config_disables_fsmonitor_and_opts_into_long_paths_only_when_required() {
        assert_eq!(
            injected_git_config(false),
            vec![("core.fsmonitor", "false")]
        );
        assert_eq!(
            injected_git_config(true),
            vec![("core.fsmonitor", "false"), ("core.longpaths", "true")]
        );
    }

    #[test]
    fn parses_vendor_and_patchless_versions() {
        assert_eq!(
            parse_version(b"git version 2.50.1 (Apple Git-155)\n").unwrap(),
            GitVersion {
                major: 2,
                minor: 50,
                patch: 1,
                vendor_suffix: Some("(Apple Git-155)".into())
            }
        );
        assert_eq!(parse_version(b"git version 2.36\n").unwrap().patch, 0);
        assert!(parse_version(b"not git\n").is_err());
        assert!(
            parse_version(b"git version 2.36.0 vendor-a\n")
                .unwrap()
                .at_least(2, 36, 0)
        );
        assert!(
            !parse_version(b"git version 2.35.9 vendor-z\n")
                .unwrap()
                .at_least(2, 36, 0)
        );
    }
}
