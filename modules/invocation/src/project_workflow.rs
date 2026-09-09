use super::*;

pub(super) const PROJECT_WORKFLOW_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.project-workflow",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.project-workflow.md"),
};

#[allow(clippy::too_many_arguments)]
pub fn project_workflow_step_prompt(
    execution_id: &str,
    project_name: &str,
    goal: &str,
    workflow: &termloop_domain::WorkflowConfiguration,
    current_step_index: usize,
    review_cycle: u8,
) -> Result<AskToTerminalPrompt, InvocationError> {
    let composed = compose_task_workflow(
        execution_id,
        None,
        project_name,
        None,
        None,
        goal,
        workflow,
        current_step_index,
        review_cycle,
    )?;
    terminal_prompt(
        composed.template,
        composed.bindings,
        composed.delivered_prompt,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn project_agent_with_workflow_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    execution_id: &str,
    project_name: &str,
    goal: &str,
    workflow: &termloop_domain::WorkflowConfiguration,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    let composed = compose_task_workflow(
        execution_id,
        None,
        project_name,
        None,
        None,
        goal,
        workflow,
        0,
        1,
    )?;
    resolve_launch_manifest_with_codex_project_trust(
        agent_id,
        cwd,
        composed.template,
        model,
        permission,
        reasoning,
        Some(&composed.delivered_prompt),
        conversation,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
    .map(ResolvedLaunchManifest::into_payload)
}
