use super::{Action, Operation, Phase, Provider, Status};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use termloop_platform::{
    CommandRequest, CommandTermination, LaunchEnvironment, PrivateCommandExit,
    PrivateCommandRequest, resolve_launch_target, run_command, run_private_command,
    user_home_directory,
};

pub(super) fn status(provider: Provider, check_auth: bool) -> Status {
    let environment = LaunchEnvironment::os_baseline();
    let target = resolve_launch_target(provider.command(), &environment).ok();
    let mut status = Status {
        agent_id: provider,
        label: match provider {
            Provider::Codex => "Codex",
            Provider::Claude => "Claude",
        },
        installed: target.is_some(),
        version: None,
        auth_state: "unknown",
        install_supported: termloop_platform::user_cli_install_prefix().is_some()
            && resolve_launch_target("npm", &environment).is_ok(),
        busy: false,
        operation: None,
    };
    let Some(target) = target else {
        return status;
    };
    let (program, args) = target.command_line(["--version"]);
    if let Ok(result) = run_command(
        CommandRequest::new(program)
            .args(args)
            .timeout(Duration::from_secs(5))
            .output_limit(1024),
    ) && result.success()
    {
        status.version = String::from_utf8(result.stdout).ok().and_then(|text| {
            text.lines()
                .next()
                .map(|line| line.chars().filter(|c| !c.is_control()).take(128).collect())
        });
    }
    if !check_auth {
        return status;
    }
    let args = match provider {
        Provider::Codex => vec!["login", "status"],
        Provider::Claude => vec!["auth", "status", "--json"],
    };
    let (program, args) = target.command_line(args);
    if let Ok(result) = run_command(
        CommandRequest::new(program)
            .args(args)
            .timeout(Duration::from_secs(8))
            .output_limit(8192),
    ) {
        status.auth_state = match provider {
            Provider::Codex if result.success() => "signedIn",
            Provider::Codex
                if result.termination == (CommandTermination::Exited { code: 1 })
                    && String::from_utf8_lossy(&result.stderr).contains("Not logged in") =>
            {
                "signedOut"
            }
            Provider::Claude => match serde_json::from_slice::<Value>(&result.stdout)
                .ok()
                .and_then(|value| value["loggedIn"].as_bool())
            {
                Some(true) if result.success() => "signedIn",
                Some(false) => "signedOut",
                _ => "unknown",
            },
            _ => "unknown",
        };
    }
    status
}

pub(super) fn run(
    provider: Provider,
    action: Action,
    snapshot: Arc<Mutex<Operation>>,
    cancel: Arc<AtomicBool>,
    input: mpsc::SyncSender<Vec<u8>>,
    receiver: mpsc::Receiver<Vec<u8>>,
    registry: PathBuf,
) {
    let result = run_inner(
        provider,
        action,
        &snapshot,
        cancel.clone(),
        input,
        receiver,
        registry,
    );
    let mut operation = snapshot.lock().unwrap();
    // A structured success ends the app server intentionally; cleanup happens
    // before publishing terminal state so another client cannot overlap it.
    match result {
        Ok(true) => operation.finish(
            Phase::Succeeded,
            match action {
                Action::Install => "Installed. Ready to sign in.",
                Action::SignIn => "Signed in on this server.",
                Action::SignOut => "Signed out on this server.",
            },
        ),
        Ok(false) if cancel.load(Ordering::Acquire) => {
            operation.finish(Phase::Cancelled, "Setup cancelled.")
        }
        Ok(false) => operation.finish(Phase::Expired, "Setup timed out. Start a new attempt."),
        Err(message) => operation.finish(Phase::Failed, message),
    }
}

fn run_inner(
    provider: Provider,
    action: Action,
    snapshot: &Arc<Mutex<Operation>>,
    cancel: Arc<AtomicBool>,
    input: mpsc::SyncSender<Vec<u8>>,
    receiver: mpsc::Receiver<Vec<u8>>,
    registry: PathBuf,
) -> Result<bool, &'static str> {
    let home = user_home_directory().ok_or("The server user’s home directory is unavailable.")?;
    let environment = LaunchEnvironment::os_baseline()
        .with_explicit("BROWSER", "echo")
        .with_explicit("NO_COLOR", "1");
    let (command, args) = match action {
        Action::Install => {
            let prefix = termloop_platform::user_cli_install_prefix()
                .ok_or("Install this CLI manually on Windows, then refresh.")?;
            snapshot.lock().unwrap().phase = Phase::Installing;
            snapshot.lock().unwrap().message =
                "Installing the official provider package for this server user…".into();
            (
                "npm",
                vec![
                    "install".into(),
                    "--global".into(),
                    "--prefix".into(),
                    prefix.into_os_string(),
                    "--no-audit".into(),
                    "--no-fund".into(),
                    "--registry=https://registry.npmjs.org".into(),
                    match provider {
                        Provider::Codex => "@openai/codex@latest",
                        Provider::Claude => "@anthropic-ai/claude-code@latest",
                    }
                    .into(),
                ],
            )
        }
        Action::SignIn if provider == Provider::Codex => (
            "codex",
            vec!["app-server".into(), "--listen".into(), "stdio://".into()],
        ),
        Action::SignIn => (
            "claude",
            vec!["auth".into(), "login".into(), "--claudeai".into()],
        ),
        Action::SignOut => (
            provider.command(),
            if provider == Provider::Codex {
                vec!["logout".into()]
            } else {
                vec!["auth".into(), "logout".into()]
            },
        ),
    };
    let target = resolve_launch_target(command, &environment).map_err(|_| "CLI unavailable. Install Node.js and npm on this server to enable installation, or install the provider CLI manually.")?;
    let (program, args) = target.command_line(args);
    let structured = provider == Provider::Codex && action == Action::SignIn;
    if structured {
        send_json(
            &input,
            json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"termloop_accounts","version":"1.0.0"}}}),
        )?;
    }
    let operation_id = snapshot.lock().unwrap().operation_id.clone();
    let mut dialogue = Dialogue {
        provider,
        buffer: Vec::new(),
        login_id: None,
        completed: false,
        failed: false,
    };
    let outcome = run_private_command(PrivateCommandRequest {
        program, args, cwd: home, environment, timeout: Duration::from_secs(15 * 60), output_limit: 256 * 1024,
        record_path: registry.join(format!("{operation_id}.process")),
    }, receiver, cancel.clone(), |bytes, stderr| {
        if action != Action::SignIn || (structured && stderr) { return; }
        if cancel.load(Ordering::Acquire) { return; }
        if structured {
            dialogue.buffer.extend_from_slice(bytes);
            while let Some(end) = dialogue.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = dialogue.buffer.drain(..=end).collect();
                if let Ok(message) = serde_json::from_slice::<Value>(&line) {
                    dialogue.codex_message(&message, snapshot, &input);
                }
            }
            if dialogue.completed || dialogue.failed { cancel.store(true, Ordering::Release); }
        } else {
            dialogue.buffer.extend_from_slice(bytes);
            if let Some(url) = claude_login_url(&dialogue.buffer) {
                let mut operation = snapshot.lock().unwrap();
                if operation.verification_url.is_none() {
                    operation.verification_url = Some(url); operation.phase = Phase::AwaitingCode; operation.accepts_code = true;
                    operation.message = "Open the sign-in page on this computer. If it gives you a code, paste it below.".into();
                }
            }
        }
    }).map_err(|_| "Could not run the provider CLI. Check its installation and retry.")?;
    if dialogue.failed {
        return Err(
            "Provider sign-in failed. Enable device-code login in ChatGPT settings if required, or update the CLI and retry.",
        );
    }
    match outcome {
        PrivateCommandExit::Exited(true) => {
            if action == Action::Install && !status(provider, false).installed {
                return Err(
                    "Installation finished but the CLI is not discoverable. Check this server’s PATH.",
                );
            }
            if action == Action::SignIn && status(provider, true).auth_state != "signedIn" {
                return Err(
                    "The provider did not confirm sign-in. Refresh or start a new attempt.",
                );
            }
            Ok(true)
        }
        PrivateCommandExit::Cancelled if dialogue.completed => Ok(true),
        PrivateCommandExit::Cancelled | PrivateCommandExit::TimedOut => Ok(false),
        PrivateCommandExit::OutputLimit => {
            Err("Provider output exceeded the setup limit. Update the CLI and retry.")
        }
        PrivateCommandExit::Exited(false) => Err(
            "The provider command failed. Check network access and the CLI installation, then retry.",
        ),
    }
}

struct Dialogue {
    provider: Provider,
    buffer: Vec<u8>,
    login_id: Option<String>,
    completed: bool,
    failed: bool,
}
impl Dialogue {
    fn codex_message(
        &mut self,
        value: &Value,
        snapshot: &Arc<Mutex<Operation>>,
        input: &mpsc::SyncSender<Vec<u8>>,
    ) {
        if value.get("error").is_some() {
            self.failed = true;
            return;
        }
        match value["id"].as_u64() {
            Some(1) => {
                self.failed |= send_json(input, json!({"method":"initialized"})).is_err();
                self.failed |= send_json(input, json!({"id":2,"method":"account/login/start","params":{"type":"chatgptDeviceCode"}})).is_err();
            }
            Some(2) => {
                let result = &value["result"];
                let (Some(id), Some(url), Some(code)) = (
                    result["loginId"].as_str(),
                    result["verificationUrl"].as_str(),
                    result["userCode"].as_str(),
                ) else {
                    self.failed = true;
                    return;
                };
                if id.len() > 128
                    || !valid_login_url(self.provider, url)
                    || code.len() > 128
                    || code.chars().any(char::is_control)
                {
                    self.failed = true;
                    return;
                }
                self.login_id = Some(id.into());
                let mut operation = snapshot.lock().unwrap();
                operation.phase = Phase::AwaitingBrowser;
                operation.verification_url = Some(url.into());
                operation.user_code = Some(code.into());
                operation.message =
                    "Open the sign-in page on this computer and enter this one-time code.".into();
            }
            _ if value["method"] == "account/login/completed"
                && value["params"]["loginId"].as_str() == self.login_id.as_deref()
                && self.login_id.is_some() =>
            {
                self.completed = value["params"]["success"] == true;
                self.failed = !self.completed;
            }
            _ => {}
        }
    }
}

fn send_json(input: &mpsc::SyncSender<Vec<u8>>, value: Value) -> Result<(), &'static str> {
    input
        .try_send(format!("{value}\n").into_bytes())
        .map_err(|_| "Provider input unavailable.")
}

fn valid_login_url(provider: Provider, url: &str) -> bool {
    if url.len() > 4096
        || url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return false;
    }
    match provider {
        Provider::Codex => url == "https://auth.openai.com/codex/device",
        Provider::Claude => [
            "https://claude.com/cai/oauth/authorize?",
            "https://claude.ai/oauth/authorize?",
            "https://platform.claude.com/oauth/authorize?",
            "https://console.anthropic.com/oauth/authorize?",
        ]
        .iter()
        .any(|prefix| url.starts_with(prefix)),
    }
}

fn claude_login_url(bytes: &[u8]) -> Option<String> {
    // Parse only the dedicated login command's challenge, never Session PTYs.
    // Require a delimiter: stream chunks can split the URL at any byte.
    let text = String::from_utf8_lossy(bytes);
    for (start, _) in text.match_indices("https://") {
        let tail = &text[start..];
        let Some(end) = tail.find(|c: char| c.is_whitespace() || c.is_control()) else {
            continue;
        };
        let url = &tail[..end];
        if valid_login_url(Provider::Claude, url) {
            return Some(url.into());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_urls_are_exact_provider_origins_and_complete_stream_values() {
        assert!(valid_login_url(
            Provider::Codex,
            "https://auth.openai.com/codex/device"
        ));
        for url in [
            "https://auth.openai.com.evil.test/codex/device",
            "https://evil.test/",
            "http://auth.openai.com/codex/device",
            "https://auth.openai.com/codex/device?next=evil",
            "https://claude.ai@evil.test/oauth/authorize?",
        ] {
            assert!(!valid_login_url(Provider::Codex, url));
            assert!(!valid_login_url(Provider::Claude, url));
        }
        let first = b"Open https://claude.ai/oauth/authorize?state=abc";
        assert!(claude_login_url(first).is_none());
        let mut complete = first.to_vec();
        complete.extend_from_slice(b"def&code_challenge=xyz\nPaste code here: ");
        assert_eq!(
            claude_login_url(&complete).unwrap(),
            "https://claude.ai/oauth/authorize?state=abcdef&code_challenge=xyz"
        );
    }

    #[test]
    fn codex_device_auth_requires_matching_structured_completion() {
        let operation = Arc::new(Mutex::new(Operation {
            agent_id: Provider::Codex,
            operation_id: "our-operation".into(),
            action: Action::SignIn,
            phase: Phase::Starting,
            verification_url: None,
            user_code: None,
            accepts_code: false,
            message: String::new(),
            expires_at_epoch_ms: 10,
        }));
        let (input, receiver) = mpsc::sync_channel(8);
        let mut dialogue = Dialogue {
            provider: Provider::Codex,
            buffer: vec![],
            login_id: None,
            completed: false,
            failed: false,
        };
        dialogue.codex_message(&json!({"id":1,"result":{}}), &operation, &input);
        assert_eq!(
            serde_json::from_slice::<Value>(&receiver.recv().unwrap()).unwrap()["method"],
            "initialized"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&receiver.recv().unwrap()).unwrap()["params"]["type"],
            "chatgptDeviceCode"
        );
        dialogue.codex_message(&json!({"id":2,"result":{"loginId":"native-private-id","verificationUrl":"https://auth.openai.com/codex/device","userCode":"ABCD-1234"}}), &operation, &input);
        assert_eq!(operation.lock().unwrap().phase, Phase::AwaitingBrowser);
        assert!(
            !serde_json::to_string(&*operation.lock().unwrap())
                .unwrap()
                .contains("native-private-id")
        );
        dialogue.codex_message(&json!({"method":"account/login/completed","params":{"loginId":"other","success":true}}), &operation, &input);
        assert!(!dialogue.completed);
        dialogue.codex_message(&json!({"method":"account/login/completed","params":{"loginId":"native-private-id","success":true}}), &operation, &input);
        assert!(dialogue.completed);
    }
}
