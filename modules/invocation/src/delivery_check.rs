use super::*;

pub(super) const DELIVERY_CHECK_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.delivery-check",
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.delivery-check.md"),
};

/// A temporary delivery check in a Project opened as Project Manager. It runs
/// in the Project checkout, reads its scope through its own MCP tools, and
/// records one report.
pub fn delivery_check_for_conversation(
    agent_id: &str,
    cwd: &str,
    selection: &termloop_domain::AgentLaunchSelection,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
) -> Result<LaunchPayload, InvocationError> {
    let template = &DELIVERY_CHECK_TEMPLATE;
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
        CodexProjectTrust::Inherit,
    )?;
    resolved.positional_message(
        template.authored_body,
        "resources/prompts/builtin.agent.delivery-check.md",
        "Project Manager delivery check",
    )?;
    resolved.set_provenance_content(template.authored_body);
    Ok(resolved.into_payload())
}
