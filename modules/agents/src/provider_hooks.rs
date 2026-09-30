use crate::{BuiltinAgentAdapter, agent_descriptor};
use serde_json::json;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHookSettingsDelivery {
    InlineSettings,
    EnvironmentSettingsPath { variable: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHookSettings {
    pub delivery: ProviderHookSettingsDelivery,
    pub content: String,
    pub inspectable_content: String,
    pub companion_script: Option<String>,
}

pub fn provider_hook_settings(
    agent_id: &str,
    executable: &Path,
) -> Result<Option<ProviderHookSettings>, serde_json::Error> {
    let Some(descriptor) = agent_descriptor(agent_id) else {
        return Ok(None);
    };
    match descriptor.adapter {
        BuiltinAgentAdapter::Claude => {
            let command = format!("\"{}\" hook", executable.display());
            claude_hook_settings(&command).map(Some)
        }
        BuiltinAgentAdapter::Gemini => {
            let command =
                termloop_platform::powershell_or_posix_hook_command(executable, &["hook"]);
            gemini_hook_settings(&command).map(Some)
        }
        BuiltinAgentAdapter::OpenCode => opencode_hook_settings(executable).map(Some),
        BuiltinAgentAdapter::Codex => Ok(None),
    }
}

pub fn supports_provider_hook_observation(agent_id: &str) -> bool {
    agent_descriptor(agent_id).is_some_and(|descriptor| {
        matches!(
            descriptor.adapter,
            BuiltinAgentAdapter::Claude
                | BuiltinAgentAdapter::Gemini
                | BuiltinAgentAdapter::OpenCode
        )
    })
}

fn claude_hook_settings(command: &str) -> Result<ProviderHookSettings, serde_json::Error> {
    const HOOK_TIMEOUT_SECONDS: u64 = 3;
    const EVENTS: &[&str] = &[
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "TaskCreated",
        "TaskCompleted",
        "Notification",
        "PreCompact",
        "Stop",
        "StopFailure",
        "SessionEnd",
    ];
    let build = |hook_command: &str| {
        EVENTS
            .iter()
            .map(|event| {
                (
                    (*event).into(),
                    json!([{ "matcher": "", "hooks": [{
                        "type": "command",
                        "command": hook_command,
                        "timeout": HOOK_TIMEOUT_SECONDS,
                    }] }]),
                )
            })
            .collect::<serde_json::Map<String, serde_json::Value>>()
    };
    Ok(ProviderHookSettings {
        delivery: ProviderHookSettingsDelivery::InlineSettings,
        content: serde_json::to_string(&json!({ "hooks": build(command) }))?,
        inspectable_content: serde_json::to_string_pretty(&json!({
            "hooks": build("<redacted TermLoop hook executable>")
        }))?,
        companion_script: None,
    })
}

fn gemini_hook_settings(command: &str) -> Result<ProviderHookSettings, serde_json::Error> {
    const HOOK_TIMEOUT_MILLISECONDS: u64 = 3_000;
    const EVENTS: &[&str] = &[
        "SessionStart",
        "BeforeAgent",
        "BeforeTool",
        "AfterTool",
        "Notification",
        "PreCompress",
        "AfterAgent",
        "SessionEnd",
    ];
    let hook_environment = || {
        json!({
            "TERMLOOP_HOOK_ENDPOINT": "${TERMLOOP_HOOK_ENDPOINT}",
            "TERMLOOP_HOOK_TOKEN": "${TERMLOOP_HOOK_TOKEN}",
            "TERMLOOP_SESSION_ID": "${TERMLOOP_SESSION_ID}",
            "TERMLOOP_AGENT_ID": "${TERMLOOP_AGENT_ID}",
        })
    };
    let build = |hook_command: &str| {
        EVENTS
            .iter()
            .map(|event| {
                (
                    (*event).into(),
                    json!([{ "matcher": "*", "hooks": [{
                        "name": "termloop-observation",
                        "type": "command",
                        "command": hook_command,
                        "timeout": HOOK_TIMEOUT_MILLISECONDS,
                        "env": hook_environment(),
                    }] }]),
                )
            })
            .collect::<serde_json::Map<String, serde_json::Value>>()
    };
    Ok(ProviderHookSettings {
        delivery: ProviderHookSettingsDelivery::EnvironmentSettingsPath {
            variable: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
        },
        content: serde_json::to_string(&json!({ "hooks": build(command) }))?,
        inspectable_content: serde_json::to_string_pretty(&json!({
            "hooks": build("<redacted TermLoop hook executable>")
        }))?,
        companion_script: None,
    })
}

fn opencode_hook_settings(executable: &Path) -> Result<ProviderHookSettings, serde_json::Error> {
    // The server replaces this marker with the private runtime file URL before
    // writing the overlay. OpenCode merges this config with the user's config.
    let config = json!({"plugin": ["__TERMLOOP_OPENCODE_PLUGIN_URL__"]});
    let executable = serde_json::to_string(&executable.to_string_lossy())?;
    Ok(ProviderHookSettings {
        delivery: ProviderHookSettingsDelivery::EnvironmentSettingsPath {
            variable: "OPENCODE_TUI_CONFIG",
        },
        content: serde_json::to_string(&config)?,
        inspectable_content: serde_json::to_string_pretty(&config)?,
        companion_script: Some(
            include_str!("../assets/opencode-observation.js")
                .replace("__TERMLOOP_HOOK_EXECUTABLE__", &executable),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_launch_scoped_provider_owns_its_event_matrix_and_timeout_units() {
        let executable = Path::new("/private/termloop hook");
        let claude = provider_hook_settings("claude", executable)
            .unwrap()
            .unwrap();
        let claude_json: serde_json::Value = serde_json::from_str(&claude.content).unwrap();
        assert_eq!(
            claude.delivery,
            ProviderHookSettingsDelivery::InlineSettings
        );
        assert!(claude_json["hooks"].get("UserPromptSubmit").is_some());
        assert!(claude_json["hooks"].get("BeforeAgent").is_none());
        assert_eq!(
            claude_json["hooks"]["SessionStart"][0]["hooks"][0]["timeout"],
            3
        );

        let gemini = provider_hook_settings("gemini", executable)
            .unwrap()
            .unwrap();
        assert_eq!(
            gemini.delivery,
            ProviderHookSettingsDelivery::EnvironmentSettingsPath {
                variable: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH"
            }
        );
        let gemini_json: serde_json::Value = serde_json::from_str(&gemini.content).unwrap();
        assert!(gemini_json["hooks"].get("BeforeAgent").is_some());
        assert!(gemini_json["hooks"].get("UserPromptSubmit").is_none());
        assert_eq!(
            gemini_json["hooks"]["SessionStart"][0]["hooks"][0]["timeout"],
            3_000
        );
        assert_eq!(
            gemini_json["hooks"]["SessionStart"][0]["hooks"][0]["env"]["TERMLOOP_HOOK_TOKEN"],
            "${TERMLOOP_HOOK_TOKEN}"
        );
        assert_eq!(
            gemini_json["hooks"]["SessionStart"][0]["hooks"][0]["env"]["TERMLOOP_AGENT_ID"],
            "${TERMLOOP_AGENT_ID}"
        );
        assert!(!gemini.inspectable_content.contains("/private/termloop"));

        let opencode = provider_hook_settings("opencode", executable)
            .unwrap()
            .unwrap();
        assert_eq!(
            opencode.delivery,
            ProviderHookSettingsDelivery::EnvironmentSettingsPath {
                variable: "OPENCODE_TUI_CONFIG"
            }
        );
        assert!(
            opencode
                .content
                .contains("__TERMLOOP_OPENCODE_PLUGIN_URL__")
        );
        let script = opencode.companion_script.unwrap();
        assert!(script.contains("/private/termloop hook"));
        assert!(script.contains("session.status"));
        assert!(!opencode.inspectable_content.contains("/private/termloop"));
    }

    #[test]
    fn bridge_and_unknown_providers_do_not_claim_hook_settings() {
        assert!(
            provider_hook_settings("codex", Path::new("termloop"))
                .unwrap()
                .is_none()
        );
        assert!(
            provider_hook_settings("unknown", Path::new("termloop"))
                .unwrap()
                .is_none()
        );
        assert!(!supports_provider_hook_observation("codex"));
        assert!(!supports_provider_hook_observation("unknown"));
        assert!(supports_provider_hook_observation("claude"));
        assert!(supports_provider_hook_observation("gemini"));
    }
}
