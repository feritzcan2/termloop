#[cfg(test)]
use termloop_domain::ImproverSessionTargetKind;
use termloop_domain::{SessionKind, StewardAgentId};

use super::AgentMcpRole;
use crate::AgentObservationTransport;

const ASK_TO_HELPER_TEMPLATE: &str = "builtin.agent.ask-to-helper";
const ASSISTANT_ACTIVATION_TEMPLATE: &str = "builtin.assistant.activation";
const STEWARD_TEMPLATE: &str = "builtin.steward.executor";
const PLAYBOOK_BUILDER_TEMPLATE: &str = "builtin.builder.playbook";
const MCP_TOOL_IMPROVER_TEMPLATE: &str = "builtin.improver.mcp-tool-description";

pub(super) fn derive_resumed_mcp_role(
    session: &termloop_domain::SessionRecord,
    _sessions: &[termloop_domain::SessionRecord],
    steward_configurations: &[termloop_domain::StewardConfiguration],
    transport: &AgentObservationTransport,
) -> Option<AgentMcpRole> {
    if session.kind != SessionKind::Agent {
        return None;
    }
    let agent_id = session.process.agent_id.as_deref()?;
    if !transport.mcp_http_supported(agent_id) {
        return None;
    }

    let steward_links = steward_configurations
        .iter()
        .filter(|configuration| {
            configuration.executor_session_id.as_deref() == Some(session.id.as_str())
        })
        .collect::<Vec<_>>();
    if steward_links.len() > 1 {
        return None;
    }

    // Persistent assistants launch through the shared visible activation
    // template. Their closed MCP role comes from the exact current durable
    // executor binding, not from the activation message's provenance.
    if let Some(configuration) = steward_links.first() {
        return (matches!(
            session.process.template_ref.as_deref(),
            Some(ASSISTANT_ACTIVATION_TEMPLATE | STEWARD_TEMPLATE)
        ) && configuration.enabled
            && configuration.project_id == session.project_id
            && configured_agent_id(configuration.agent_id) == agent_id)
            .then(|| AgentMcpRole::Steward {
                project_id: configuration.project_id.clone(),
            });
    }
    match session.process.template_ref.as_deref() {
        Some(
            PLAYBOOK_BUILDER_TEMPLATE
            | MCP_TOOL_IMPROVER_TEMPLATE
            | "builtin.improver.steward-instructions"
            | "builtin.improver.routine-instructions"
            | "builtin.builder.routine"
            | "builtin.improver.run-configuration"
            | "builtin.improver.run-configuration-new"
            | "builtin.improver.skill-definition"
            | "builtin.improver.prompt-asset",
        ) if steward_links.is_empty()
            && session.ask_to_source_session_id.is_none()
            && session.ask_to_continuation.is_none() =>
        {
            session
                .improver_target
                .as_ref()
                .filter(|target| target.is_well_formed())
                .cloned()
                .map(|target| AgentMcpRole::Improver { target })
        }
        Some(ASK_TO_HELPER_TEMPLATE) => {
            if !steward_links.is_empty() {
                return None;
            }
            let request_id = session
                .ask_to_continuation
                .as_ref()
                .filter(|continuation| continuation.is_well_formed())
                .and_then(|continuation| continuation.current_request_id.clone());
            Some(AgentMcpRole::Helper { request_id })
        }
        // A detached persistent-assistant Session must never fall back to the
        // ordinary interactive MCP profile.
        Some(ASSISTANT_ACTIVATION_TEMPLATE | STEWARD_TEMPLATE) => None,
        _ => (steward_links.is_empty()
            && session.ask_to_source_session_id.is_none()
            && session.ask_to_continuation.is_none())
        .then_some(AgentMcpRole::Interactive),
    }
}

fn configured_agent_id(agent_id: StewardAgentId) -> &'static str {
    match agent_id {
        StewardAgentId::Claude => "claude",
        StewardAgentId::Codex => "codex",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{
        AskToContinuation, ImproverSessionTarget, ProcessDescriptor, SessionRecord,
        StewardConfiguration,
    };

    fn transport() -> AgentObservationTransport {
        crate::test_agent_observation_transport(std::env::temp_dir())
    }

    fn session(id: &str, template_ref: &str) -> SessionRecord {
        SessionRecord {
            launch_selection: Default::default(),
            id: id.into(),
            project_id: "project-1".into(),
            name: None,
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: "claude".into(),
                args: vec![],
                cwd: "/tmp".into(),
                agent_id: Some("claude".into()),
                template_ref: Some(template_ref.into()),
                template_version: Some(1),
            },
            lifecycle_state: "running".into(),
            runtime_epoch: 1,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: None,
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: None,
            resume_launch_guard: None,
            resume_failure: None,
        }
    }

    fn steward(session_id: &str) -> StewardConfiguration {
        StewardConfiguration {
            project_id: "project-1".into(),
            agent_id: StewardAgentId::Claude,
            model: "default".into(),
            permission: "default".into(),
            reasoning: "default".into(),
            enabled: true,
            system_prompt: String::new(),
            executor_session_id: Some(session_id.into()),
            generation: 1,
            updated_at_epoch_ms: 1,
        }
    }

    #[test]
    fn exact_current_identity_restores_each_closed_role() {
        let source = session("source", "builtin.agent.interactive");
        let mut helper = session("helper", ASK_TO_HELPER_TEMPLATE);
        helper.ask_to_source_session_id = Some(source.id.clone());
        helper.ask_to_continuation = Some(AskToContinuation {
            conversation_id: "conversation-1".into(),
            current_request_id: Some("request-1".into()),
        });
        let steward_session = session("steward", ASSISTANT_ACTIVATION_TEMPLATE);
        let sessions = vec![source.clone(), helper.clone(), steward_session.clone()];
        let steward_configurations = vec![steward(&steward_session.id)];
        let transport = transport();

        assert_eq!(
            derive_resumed_mcp_role(&source, &sessions, &[], &transport),
            Some(AgentMcpRole::Interactive)
        );
        assert_eq!(
            derive_resumed_mcp_role(&helper, &sessions, &steward_configurations, &transport),
            Some(AgentMcpRole::Helper {
                request_id: Some("request-1".into())
            })
        );
        assert_eq!(
            derive_resumed_mcp_role(
                &steward_session,
                &sessions,
                &steward_configurations,
                &transport,
            ),
            Some(AgentMcpRole::Steward {
                project_id: "project-1".into()
            })
        );
    }

    #[test]
    fn stale_or_mismatched_steward_identity_gets_no_mcp_role() {
        let transport = transport();
        let stale_steward = session("stale-steward", STEWARD_TEMPLATE);
        assert_eq!(
            derive_resumed_mcp_role(
                &stale_steward,
                std::slice::from_ref(&stale_steward),
                &[],
                &transport,
            ),
            None
        );

        let steward_session = session("steward", ASSISTANT_ACTIVATION_TEMPLATE);
        let mut disabled = steward(&steward_session.id);
        disabled.enabled = false;
        assert_eq!(
            derive_resumed_mcp_role(
                &steward_session,
                std::slice::from_ref(&steward_session),
                &[disabled],
                &transport,
            ),
            None
        );

        let mut wrong_project = steward(&steward_session.id);
        wrong_project.project_id = "project-2".into();
        assert_eq!(
            derive_resumed_mcp_role(
                &steward_session,
                std::slice::from_ref(&steward_session),
                &[wrong_project],
                &transport,
            ),
            None
        );

        let linked_ordinary = session("linked", "builtin.agent.interactive");
        assert_eq!(
            derive_resumed_mcp_role(
                &linked_ordinary,
                std::slice::from_ref(&linked_ordinary),
                &[steward(&linked_ordinary.id)],
                &transport,
            ),
            None
        );
    }

    #[test]
    fn resume_lanes_separate_the_persistent_steward_from_ordinary_sessions() {
        assert_eq!(
            AgentMcpRole::Improver {
                target: ImproverSessionTarget {
                    target_kind: ImproverSessionTargetKind::Playbook,
                    target_id: None,
                },
            }
            .resume_lane(),
            crate::AgentResumeLane::Ordinary
        );
        assert_eq!(
            AgentMcpRole::Interactive.resume_lane(),
            crate::AgentResumeLane::Ordinary
        );
        assert_eq!(
            AgentMcpRole::Helper { request_id: None }.resume_lane(),
            crate::AgentResumeLane::Ordinary
        );
        assert_eq!(
            AgentMcpRole::Steward {
                project_id: "project-1".into()
            }
            .resume_lane(),
            crate::AgentResumeLane::Steward
        );
    }

    #[test]
    fn resumed_improvers_keep_only_their_exact_target_bound_role() {
        for (template, target_kind, target_id) in [
            (
                MCP_TOOL_IMPROVER_TEMPLATE,
                ImproverSessionTargetKind::SettingsMcpTool,
                Some("ask_to".to_owned()),
            ),
            (
                PLAYBOOK_BUILDER_TEMPLATE,
                ImproverSessionTargetKind::Playbook,
                None,
            ),
        ] {
            let mut improver = session("improver", template);
            improver.improver_target = Some(ImproverSessionTarget {
                target_kind,
                target_id: target_id.clone(),
            });
            assert_eq!(
                derive_resumed_mcp_role(
                    &improver,
                    std::slice::from_ref(&improver),
                    &[],
                    &transport(),
                ),
                Some(AgentMcpRole::Improver {
                    target: ImproverSessionTarget {
                        target_kind,
                        target_id,
                    },
                })
            );

            improver.improver_target = None;
            assert_eq!(
                derive_resumed_mcp_role(
                    &improver,
                    std::slice::from_ref(&improver),
                    &[],
                    &transport(),
                ),
                None
            );
        }
    }
}
