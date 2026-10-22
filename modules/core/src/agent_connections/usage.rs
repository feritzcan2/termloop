//! Signed-in identity and subscription limits for one server-user account.
//! Reads only: no credential is written, refreshed, or returned.

use super::Provider;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, atomic::AtomicBool, mpsc};
use std::time::Duration;
use termloop_agents::AgentAccountContext;
use termloop_platform::{
    LaunchEnvironment, PrivateCommandExit, PrivateCommandRequest, resolve_launch_target,
    run_private_command, user_home_directory,
};
use termloop_providers::{AgentUsageWindow, AgentUsageWindowKind, ClaudeUsageError};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub email: Option<String>,
    pub organization_name: Option<String>,
    pub plan: Option<String>,
}

impl Identity {
    fn from_parts(
        email: Option<&str>,
        organization: Option<&str>,
        plan: Option<&str>,
    ) -> Option<Self> {
        let identity = Self {
            email: bounded(email, 320),
            organization_name: bounded(organization, 200),
            plan: bounded(plan, 64),
        };
        (identity != Self::default()).then_some(identity)
    }

    /// Claude `auth status --json` already names the signed-in user.
    pub(super) fn from_claude_status(status: &Value) -> Option<Self> {
        Self::from_parts(
            status["email"].as_str(),
            status["orgName"].as_str(),
            status["subscriptionType"].as_str(),
        )
    }

    fn from_codex_account(result: &Value) -> Option<Self> {
        let account = &result["account"];
        Self::from_parts(
            account["email"].as_str(),
            None,
            account["planType"].as_str(),
        )
    }
}

fn bounded(value: Option<&str>, limit: usize) -> Option<String> {
    let value: String = value?
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect();
    (!value.is_empty()).then_some(value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageState {
    Ok,
    SignedOut,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub agent_id: Provider,
    pub account_id: String,
    pub state: UsageState,
    pub identity: Option<Identity>,
    pub windows: Vec<AgentUsageWindow>,
    pub fetched_at_epoch_ms: u64,
    pub message: Option<String>,
}

pub(super) fn unread(account: &AgentAccountContext, state: UsageState, message: &str) -> Usage {
    Usage {
        agent_id: Provider::parse(&account.agent_id).expect("validated account provider"),
        account_id: account.account_id.clone(),
        state,
        identity: None,
        windows: vec![],
        fetched_at_epoch_ms: termloop_platform::current_epoch_ms(),
        message: Some(message.into()),
    }
}

pub(super) fn usage(
    account: &AgentAccountContext,
    identity: Option<Identity>,
    registry: &Path,
) -> Usage {
    let provider = Provider::parse(&account.agent_id).expect("validated account provider");
    let mut usage = Usage {
        agent_id: provider,
        account_id: account.account_id.clone(),
        state: UsageState::Unavailable,
        identity,
        windows: vec![],
        fetched_at_epoch_ms: termloop_platform::current_epoch_ms(),
        message: None,
    };
    match provider {
        Provider::Claude => {
            match termloop_providers::claude_oauth_usage(account.config_directory.as_deref()) {
                Ok(windows) => {
                    usage.state = UsageState::Ok;
                    usage.windows = windows;
                }
                Err(error) => {
                    usage.state = if error == ClaudeUsageError::SignedOut {
                        UsageState::SignedOut
                    } else {
                        UsageState::Unavailable
                    };
                    usage.message = Some(error.to_string());
                }
            }
        }
        Provider::Codex => match codex_requests(
            account,
            registry,
            &[
                ("account/read", json!({"refreshToken": false})),
                ("account/rateLimits/read", Value::Null),
            ],
        ) {
            Some(results) if results[0]["account"].is_object() => {
                usage.identity = Identity::from_codex_account(&results[0]).or(usage.identity);
                usage.windows = codex_windows(&results[1]["rateLimits"]);
                usage.state = UsageState::Ok;
                if usage.windows.is_empty() {
                    usage.message =
                        Some("Codex reported no subscription limits for this sign-in".into());
                }
            }
            Some(_) => {
                usage.state = UsageState::SignedOut;
                usage.message = Some("Sign in to Codex to see its limits".into());
            }
            None => usage.message = Some("Codex usage is unavailable right now".into()),
        },
    }
    usage
}

/// The signed-in Codex identity, read without refreshing its token.
pub(super) fn codex_identity(account: &AgentAccountContext, registry: &Path) -> Option<Identity> {
    let results = codex_requests(
        account,
        registry,
        &[("account/read", json!({"refreshToken": false}))],
    )?;
    Identity::from_codex_account(&results[0])
}

fn codex_windows(limits: &Value) -> Vec<AgentUsageWindow> {
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|name| {
            let window = &limits[name];
            let minutes = window["windowDurationMins"]
                .as_u64()
                .and_then(|m| u32::try_from(m).ok());
            let (kind, label) = match minutes {
                Some(300) => (AgentUsageWindowKind::Session, "Session".to_owned()),
                Some(10_080) => (AgentUsageWindowKind::Weekly, "Weekly".to_owned()),
                Some(minutes) if minutes % 1440 == 0 => (
                    AgentUsageWindowKind::Other,
                    format!("{} days", minutes / 1440),
                ),
                Some(minutes) if minutes % 60 == 0 => (
                    AgentUsageWindowKind::Other,
                    format!("{} hours", minutes / 60),
                ),
                _ => (AgentUsageWindowKind::Other, "Limit".to_owned()),
            };
            AgentUsageWindow::new(
                kind,
                label,
                window["usedPercent"].as_f64()?,
                minutes,
                window["resetsAt"]
                    .as_u64()
                    .map(|seconds| seconds.saturating_mul(1000)),
            )
        })
        .collect()
}

/// Runs one short `codex app-server` dialogue and returns each request's
/// result in order, or `None` when any request failed or timed out.
fn codex_requests(
    account: &AgentAccountContext,
    registry: &Path,
    requests: &[(&str, Value)],
) -> Option<Vec<Value>> {
    account.prepare().ok()?;
    let environment = account.apply_environment(LaunchEnvironment::os_baseline());
    let target = resolve_launch_target("codex", &environment).ok()?;
    let args = account
        .credential_args()
        .into_iter()
        .map(Into::into)
        .chain(["app-server", "--listen", "stdio://"].map(Into::into))
        .collect::<Vec<std::ffi::OsString>>();
    let (program, args) = target.command_line(args);
    let (input, receiver) = mpsc::sync_channel(requests.len() + 2);
    let send = |value: Value| input.try_send(format!("{value}\n").into_bytes()).is_ok();
    send(json!({"id": 0, "method": "initialize", "params": {"clientInfo": {"name": "termloop_accounts", "version": "1.0.0"}}}))
        .then_some(())?;
    let cancel = Arc::new(AtomicBool::new(false));
    let mut buffer = Vec::new();
    let mut results = vec![Value::Null; requests.len()];
    let mut pending = requests.len();
    let mut failed = false;
    std::fs::create_dir_all(registry).ok()?;
    let outcome = run_private_command(
        PrivateCommandRequest {
            program,
            args,
            cwd: user_home_directory().unwrap_or_else(std::env::temp_dir),
            environment,
            timeout: Duration::from_secs(10),
            output_limit: 256 * 1024,
            record_path: registry.join(format!("usage-{}.process", uuid::Uuid::new_v4())),
        },
        receiver,
        cancel.clone(),
        |bytes, stderr| {
            if stderr || failed || pending == 0 {
                return;
            }
            buffer.extend_from_slice(bytes);
            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = buffer.drain(..=end).collect();
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                match message["id"].as_u64() {
                    _ if message.get("error").is_some() && message.get("id").is_some() => {
                        failed = true
                    }
                    Some(0) => {
                        failed |= !send(json!({"method": "initialized"}));
                        for (index, (method, params)) in requests.iter().enumerate() {
                            let mut request = json!({"id": index + 1, "method": method});
                            if !params.is_null() {
                                request["params"] = params.clone();
                            }
                            failed |= !send(request);
                        }
                    }
                    Some(id) if (1..=results.len() as u64).contains(&id) => {
                        let slot = &mut results[id as usize - 1];
                        if slot.is_null() {
                            *slot = message["result"].clone();
                            pending -= 1;
                        }
                    }
                    _ => {}
                }
            }
            if failed || pending == 0 {
                cancel.store(true, std::sync::atomic::Ordering::Release);
            }
        },
    )
    .ok()?;
    (!failed
        && pending == 0
        && matches!(
            outcome,
            PrivateCommandExit::Cancelled | PrivateCommandExit::Exited(_)
        ))
    .then_some(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_are_read_from_each_providers_own_account_shape() {
        assert_eq!(
            Identity::from_claude_status(&json!({
                "loggedIn": true, "email": " a@b.c ", "orgName": "Acme", "subscriptionType": "max"
            })),
            Some(Identity {
                email: Some("a@b.c".into()),
                organization_name: Some("Acme".into()),
                plan: Some("max".into()),
            })
        );
        assert_eq!(
            Identity::from_claude_status(&json!({"loggedIn": false})),
            None
        );
        assert_eq!(
            Identity::from_codex_account(
                &json!({"account": {"type": "chatgpt", "email": "x@y.z", "planType": "pro"}})
            ),
            Some(Identity {
                email: Some("x@y.z".into()),
                organization_name: None,
                plan: Some("pro".into()),
            })
        );
    }

    #[test]
    fn codex_windows_name_session_and_weekly_limits_and_convert_reset_seconds() {
        let windows = codex_windows(&json!({
            "primary": {"usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 1_800_000_000u64},
            "secondary": {"usedPercent": 101, "windowDurationMins": 10080, "resetsAt": null}
        }));
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].kind, AgentUsageWindowKind::Session);
        assert_eq!(windows[0].resets_at_epoch_ms, Some(1_800_000_000_000));
        assert_eq!(windows[1].label, "Weekly");
        assert_eq!(windows[1].used_percent, 100.0);
        assert!(codex_windows(&Value::Null).is_empty());
    }
}
