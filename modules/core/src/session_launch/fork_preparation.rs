use super::{
    AgentLaunchPlan, AgentMcpRole, invocation_error, preview_transport_bindings,
    resolve_interactive_agent_launch_with_transport,
};
use crate::CoreError;

impl AgentLaunchPlan {
    /// Resolve after worktree observation and before provider preparation, so
    /// the App Server can create the child with the inherited launch selection.
    pub(super) fn prepare_codex_fork_launch(&mut self) -> Result<(), CoreError> {
        let source_ref = self
            .fork_source_ref
            .as_ref()
            .ok_or(CoreError::AgentUnsupported)?;
        let conversation = termloop_invocation::AgentConversationLaunch::Fork { source_ref };
        let (observation, mcp) = preview_transport_bindings(self);
        let managed = self.has_observed_managed_worktree();
        let selection = self.interactive_options.clone().unwrap_or_default();
        let launch = if matches!(self.mcp_role, AgentMcpRole::PlaybookEvaluator { .. }) {
            termloop_invocation::playbook_evaluator_for_conversation(
                &self.agent_id,
                &self.cwd,
                &selection,
                conversation.in_account(self.account.as_ref()),
                observation,
                mcp.ok_or(CoreError::AgentUnsupported)?,
                managed,
            )
        } else if let Some((request_id, message)) = self.helper_prompt.as_ref() {
            let mcp = mcp.ok_or(CoreError::AgentUnsupported)?;
            let conversation = conversation.in_account(self.account.as_ref());
            if managed {
                termloop_invocation::ask_to_helper_agent_for_managed_worktree_conversation(
                    &self.agent_id,
                    &self.cwd,
                    &selection.model,
                    &selection.permission,
                    &selection.reasoning,
                    conversation,
                    request_id,
                    message,
                    observation,
                    mcp,
                    self.helper_agent_profile.as_ref(),
                )
            } else {
                termloop_invocation::ask_to_helper_agent_for_conversation(
                    &self.agent_id,
                    &self.cwd,
                    &selection.model,
                    &selection.permission,
                    &selection.reasoning,
                    conversation,
                    request_id,
                    message,
                    observation,
                    mcp,
                    self.helper_agent_profile.as_ref(),
                )
            }
        } else {
            resolve_interactive_agent_launch_with_transport(self, conversation, observation, mcp)
        }
        .map_err(invocation_error)?;
        self.prepared_launch = Some(launch);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreRuntime;
    use serde_json::json;
    use termloop_domain::{AgentLaunchSelection, ResumeProvider, ResumeRef};

    #[test]
    fn fork_preparation_keeps_interactive_helper_and_evaluator_roles() {
        let root =
            std::env::temp_dir().join(format!("termloop-fork-prepare-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let cwd = termloop_platform::canonical_existing_directory_path(&root).unwrap();
        let mut runtime = CoreRuntime::open(
            root.join("state.json"),
            termloop_terminal::TerminalService::default(),
            1,
        )
        .unwrap();
        runtime.configure_agent_observations(crate::test_agent_observation_transport(
            root.join("provider"),
        ));
        let project = runtime
            .create_project(json!({"name":"Fork", "folderPath":cwd}))
            .unwrap();
        for role in [
            AgentMcpRole::Interactive,
            AgentMcpRole::Helper {
                request_id: Some("request-1".into()),
            },
            AgentMcpRole::PlaybookEvaluator {
                check_id: "check-1".into(),
            },
        ] {
            let mut plan = runtime
                .plan_agent_launch(json!({"projectId":project["id"],"cwd":cwd,"agentId":"codex"}))
                .unwrap();
            let helper = matches!(role, AgentMcpRole::Helper { .. });
            let evaluator = matches!(role, AgentMcpRole::PlaybookEvaluator { .. });
            plan.mcp_role = role;
            let permission = if evaluator {
                "plan"
            } else {
                "bypassPermissions"
            };
            plan.interactive_options = Some(AgentLaunchSelection::new(
                "gpt-6-astra",
                permission,
                "xhigh",
            ));
            plan.fork_source_ref =
                ResumeRef::for_provider(ResumeProvider::Codex, uuid::Uuid::new_v4().to_string());
            if helper {
                plan.helper_prompt = Some(("request-1".into(), "Review this change".into()));
            }
            plan.prepare_codex_fork_launch().unwrap();
            let launch = plan.prepared_launch.as_ref().unwrap();
            let request = launch.codex_resume_permissions().unwrap();
            assert!(request.is_fork());
            assert_eq!(
                request.native_thread_id(),
                plan.fork_source_ref.as_ref().unwrap().native_session_id
            );
            assert_eq!(request.permission().as_launch_selection(), permission);
            assert!(launch.initial_input().is_none());
            assert_eq!(
                launch.provenance().template_ref,
                if helper {
                    "builtin.agent.ask-to-helper"
                } else if evaluator {
                    "builtin.agent.playbook-evaluator"
                } else {
                    "builtin.agent.interactive"
                }
            );
            if helper {
                assert!(
                    launch
                        .delivered_prompt()
                        .unwrap()
                        .contains("Review this change")
                );
            }
            assert!(
                !launch
                    .args()
                    .iter()
                    .any(|arg| arg.contains("bypass-approvals") || arg == "--sandbox")
            );
        }
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}
