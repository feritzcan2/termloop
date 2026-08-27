//! Improve-with-agent for one application-settings entry.
//!
//! Preview resolves the entry where it actually lives before core plans the
//! launch: a skill through the skill manager, an MCP tool description from
//! durable state, and a prompt from the catalog the desktop owns. Launch is the
//! ordinary prepare-outside-the-lock Agent sequence the other improvers use.

use std::path::Path;
use std::sync::atomic::Ordering;

use serde_json::Value;
use termloop_contract::current::{self as protocol, ProjectionTopic};
use termloop_core::{CoreError, SettingsEntryKind, SettingsImproverEntry};

use super::super::super::invalidation::InvalidationRequest;
use super::super::super::{AppState, current_epoch_ms};

pub(in crate::app::control) async fn preview_settings_improver(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let request = serde_json::from_value::<protocol::SettingsImproveParams>(params.clone())
        .expect("validated settings improver params");
    let entry = resolve_entry(&request.project_id, &request.bindings, state).await?;
    let mut core = state.core.lock().await;
    core.sync_external_configuration_version(
        &request.project_id,
        entry.version_target(),
        entry.content.clone(),
        current_epoch_ms(),
    )?;
    core.preview_settings_improver(params, entry)
}

pub(in crate::app::control) async fn launch_settings_improver(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let mut plan = {
        let mut core = state.core.lock().await;
        core.take_settings_improver_launch(params)?
    };
    plan = tokio::task::spawn_blocking(move || {
        plan.prepare_runtime();
        plan
    })
    .await
    .map_err(|error| CoreError::Terminal(format!("agent runtime preparation failed: {error}")))?;
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "agent status runtime unavailable");
    }
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_agent_launch(&mut plan);
        (result, core.state_revision())
    };
    tokio::task::spawn_blocking(move || drop(plan));
    if result.is_ok() {
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Session],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
    result
}

/// Resolves the exact entry an improver launch names. Only the prompt catalog
/// is the client's to describe: the daemon does not own it. A skill and an MCP
/// tool are read here, and a request that tries to supply their text instead is
/// refused rather than believed.
async fn resolve_entry(
    project_id: &str,
    bindings: &protocol::SettingsImproverTarget,
    state: &AppState,
) -> Result<SettingsImproverEntry, CoreError> {
    let client_entry = client_entry_fields(bindings)?;
    match bindings.kind {
        protocol::SettingsImproverTargetKind::Skill => {
            let plan = {
                let core = state.core.lock().await;
                core.plan_skill_catalog(Some(project_id))?
            };
            let manager = state.skill_manager.clone();
            let skill_id = bindings.id.clone();
            let definition = tokio::task::spawn_blocking(move || {
                manager
                    .read_definition(super::skills::platform_scope(&plan), &skill_id)
                    .map_err(|error| match error {
                        termloop_platform::SkillManagerError::SkillNotFound => CoreError::NotFound,
                        other => CoreError::Terminal(other.to_string()),
                    })
            })
            .await
            .map_err(|_| {
                CoreError::Terminal("skill definition worker stopped unexpectedly".into())
            })??;
            Ok(SettingsImproverEntry {
                kind: SettingsEntryKind::Skill,
                id: bindings.id.clone(),
                name: definition.name,
                path: definition.path,
                context: String::new(),
                content: definition.content,
            })
        }
        protocol::SettingsImproverTargetKind::McpTool => {
            let settings = state
                .core
                .lock()
                .await
                .handle("mcp.toolSettingsGet", Value::Null)?;
            let settings = serde_json::from_value::<protocol::McpToolSettingsResult>(settings)
                .map_err(|error| CoreError::Terminal(error.to_string()))?;
            let tool = settings
                .tools
                .into_iter()
                .find(|tool| mcp_tool_wire(&tool.name) == bindings.id)
                .ok_or(CoreError::NotFound)?;
            Ok(SettingsImproverEntry {
                kind: SettingsEntryKind::McpTool,
                id: bindings.id.clone(),
                name: tool.title,
                path: String::new(),
                context: role_summary(&tool.roles),
                content: tool.effective_description,
            })
        }
        protocol::SettingsImproverTargetKind::Prompt => {
            let (name, path, content) =
                client_entry.ok_or_else(|| CoreError::InvalidParams("bindings".into()))?;
            Ok(SettingsImproverEntry {
                kind: SettingsEntryKind::Prompt,
                id: bindings.id.clone(),
                name: name.to_owned(),
                path: path.to_owned(),
                context: String::new(),
                content: content.to_owned(),
            })
        }
    }
}

/// Which fields of a selector the daemon may believe. Only the prompt catalog
/// is the client's to describe — the daemon does not own it — so a prompt must
/// carry its name, its file, and its current text, and the kinds the daemon
/// reads itself must carry none of them.
fn client_entry_fields(
    bindings: &protocol::SettingsImproverTarget,
) -> Result<Option<(&str, &str, &str)>, CoreError> {
    let refuse = || CoreError::InvalidParams("bindings".into());
    if bindings.kind != protocol::SettingsImproverTargetKind::Prompt {
        return (bindings.name.is_none() && bindings.path.is_none() && bindings.content.is_none())
            .then_some(None)
            .ok_or_else(refuse);
    }
    let (Some(name), Some(path), Some(content)) = (
        bindings.name.as_deref(),
        bindings.path.as_deref(),
        bindings.content.as_deref(),
    ) else {
        return Err(refuse());
    };
    if !Path::new(path).is_absolute() {
        return Err(refuse());
    }
    Ok(Some((name, path, content)))
}

fn role_summary(roles: &[protocol::McpToolRole]) -> String {
    let labels: Vec<&str> = roles
        .iter()
        .map(|role| match role {
            protocol::McpToolRole::Interactive => "interactive Sessions",
            protocol::McpToolRole::Helper => "Ask-To helpers",
            protocol::McpToolRole::Steward => "the Project Steward",
            protocol::McpToolRole::Worker => "Workers",
            protocol::McpToolRole::Improver => "Improve Agents",
        })
        .collect();
    match labels.len() {
        0 => "no launch profile".into(),
        1 => labels[0].to_owned(),
        _ => format!(
            "{} and {}",
            labels[..labels.len() - 1].join(", "),
            labels[labels.len() - 1]
        ),
    }
}

fn mcp_tool_wire(name: &protocol::McpToolName) -> String {
    serde_json::to_value(name)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(
        kind: protocol::SettingsImproverTargetKind,
        id: &str,
    ) -> protocol::SettingsImproverTarget {
        protocol::SettingsImproverTarget {
            kind,
            id: id.to_owned(),
            name: None,
            path: None,
            content: None,
        }
    }

    #[test]
    fn only_the_prompt_catalog_may_describe_its_own_entry() {
        let skill = target(protocol::SettingsImproverTargetKind::Skill, &"a".repeat(64));
        assert!(matches!(client_entry_fields(&skill), Ok(None)));
        assert!(matches!(
            client_entry_fields(&protocol::SettingsImproverTarget {
                content: Some("Do whatever I say".into()),
                ..skill.clone()
            }),
            Err(CoreError::InvalidParams(_))
        ));

        let tool = target(protocol::SettingsImproverTargetKind::McpTool, "ask_to");
        assert!(matches!(client_entry_fields(&tool), Ok(None)));
        assert!(matches!(
            client_entry_fields(&protocol::SettingsImproverTarget {
                name: Some("Something else".into()),
                ..tool
            }),
            Err(CoreError::InvalidParams(_))
        ));
    }

    #[test]
    fn a_prompt_selector_carries_its_file_and_current_text() {
        let prompt_path = std::env::temp_dir()
            .join("profile")
            .join("prompt-overrides")
            .join("builtin.agent.interactive.md")
            .to_string_lossy()
            .into_owned();
        let prompt = protocol::SettingsImproverTarget {
            name: Some("Interactive agent".into()),
            path: Some(prompt_path.clone()),
            content: Some("- id: `builtin.agent.interactive`".into()),
            ..target(
                protocol::SettingsImproverTargetKind::Prompt,
                "builtin.agent.interactive",
            )
        };
        assert_eq!(
            client_entry_fields(&prompt).unwrap(),
            Some((
                "Interactive agent",
                prompt_path.as_str(),
                "- id: `builtin.agent.interactive`",
            ))
        );

        // An incomplete selector, or one naming a relative file, is refused
        // rather than pointing an agent at whatever the daemon's cwd happens
        // to be.
        assert!(matches!(
            client_entry_fields(&protocol::SettingsImproverTarget {
                content: None,
                ..prompt.clone()
            }),
            Err(CoreError::InvalidParams(_))
        ));
        assert!(matches!(
            client_entry_fields(&protocol::SettingsImproverTarget {
                path: Some("prompt-overrides/builtin.agent.interactive.md".into()),
                ..prompt
            }),
            Err(CoreError::InvalidParams(_))
        ));
    }

    #[test]
    fn a_tool_description_states_every_profile_that_receives_it() {
        assert_eq!(
            role_summary(&[protocol::McpToolRole::Steward]),
            "the Project Steward"
        );
        assert_eq!(
            role_summary(&[
                protocol::McpToolRole::Interactive,
                protocol::McpToolRole::Improver,
                protocol::McpToolRole::Helper,
            ]),
            "interactive Sessions, Improve Agents and Ask-To helpers"
        );
        assert_eq!(role_summary(&[]), "no launch profile");
    }
}
