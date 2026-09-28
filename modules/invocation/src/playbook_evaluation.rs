use super::*;

pub(super) const PLAYBOOK_EVALUATOR_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.playbook-evaluator",
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.playbook-evaluator.md"),
};

#[allow(clippy::too_many_arguments)]
pub fn playbook_evaluator_for_conversation(
    agent_id: &str,
    cwd: &str,
    selection: &termloop_domain::AgentLaunchSelection,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
    managed_worktree: bool,
) -> Result<LaunchPayload, InvocationError> {
    let template = &PLAYBOOK_EVALUATOR_TEMPLATE;
    let mut resolved = resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        template,
        &selection.model,
        &selection.permission,
        &selection.reasoning,
        None,
        conversation,
        observation,
        Some(mcp),
        None,
        None,
        &[],
        if managed_worktree {
            CodexProjectTrust::ManagedWorkspace
        } else {
            CodexProjectTrust::Inherit
        },
    )?;
    resolved.positional_message(
        template.authored_body,
        "resources/prompts/builtin.agent.playbook-evaluator.md",
        "Task Playbook evaluation",
    )?;
    resolved.set_provenance_content(template.authored_body);
    Ok(resolved.into_payload())
}
