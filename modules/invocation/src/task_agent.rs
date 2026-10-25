//! Managed Task Agent launches: the Project-configured kickoff, the Task
//! workflow, and the Steward's Task assignment.

use super::*;

/// Composes the Project-configured first message for one managed Task Agent.
/// Task context comes from Core rather than user-authored template expansion.
pub fn task_kickoff_prompt(
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    kickoff_message: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    let composed = compose_task_kickoff(task_id, title, brief, jira_url, kickoff_message)?;
    terminal_prompt(
        composed.template,
        composed.bindings,
        composed.delivered_prompt,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn task_agent_with_kickoff_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    kickoff_message: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    task_agent_with_kickoff_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        task_id,
        title,
        brief,
        jira_url,
        kickoff_message,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn task_agent_with_kickoff_for_managed_worktree_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    kickoff_message: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    task_agent_with_kickoff_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        task_id,
        title,
        brief,
        jira_url,
        kickoff_message,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::ManagedWorkspace,
    )
}

#[allow(clippy::too_many_arguments)]
fn task_agent_with_kickoff_for_conversation_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    kickoff_message: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    let composed = compose_task_kickoff(task_id, title, brief, jira_url, kickoff_message)?;
    task_agent_with_composed_message(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        composed,
        conversation,
        observation,
        mcp,
        codex_project_trust,
    )
}

#[allow(clippy::too_many_arguments)]
fn task_agent_with_composed_message(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    composed: ComposedTaskKickoff,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
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
        codex_project_trust,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

pub(crate) struct ComposedTaskKickoff {
    pub(crate) template: &'static PromptTemplate,
    pub(crate) bindings: Vec<(String, String)>,
    pub(crate) delivered_prompt: String,
}

fn compose_task_kickoff(
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    kickoff_message: &str,
) -> Result<ComposedTaskKickoff, InvocationError> {
    if kickoff_message.trim().is_empty() || kickoff_message.len() > 8_192 {
        return Err(InvocationError::InvalidPromptBinding);
    }
    compose_task_message(
        "builtin.agent.task-kickoff",
        task_id,
        &[
            ("kickoff_message", kickoff_message.to_owned()),
            ("title", title.to_owned()),
        ],
        title,
        brief,
        jira_url,
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
fn compose_task_message(
    template_id: &str,
    task_id: &str,
    leading: &[(&'static str, String)],
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    trailing: &[(&'static str, String)],
) -> Result<ComposedTaskKickoff, InvocationError> {
    let brief_context = brief
        .map(|brief| format!("Context: {brief}\n"))
        .unwrap_or_default();
    let jira_context = jira_url
        .map(|jira_url| format!("Jira: {jira_url}\n"))
        .unwrap_or_default();
    let delivered_bindings: Vec<(&str, String)> = leading
        .iter()
        .cloned()
        .chain([
            ("jira_context", jira_context),
            ("brief_context", brief_context),
        ])
        .chain(trailing.iter().cloned())
        .collect();
    if task_id.trim().is_empty()
        || title.trim().is_empty()
        || jira_url.is_some_and(|jira_url| jira_url.trim().is_empty() || jira_url.len() > 2_048)
        || std::iter::once(task_id)
            .chain(delivered_bindings.iter().map(|(_, value)| value.as_str()))
            .any(|value| {
                value
                    .chars()
                    .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
            })
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == template_id)
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let message_template = template
        .authored_body
        .split_once("\n---\n")
        .map(|(_, message)| message.trim_start())
        .ok_or(InvocationError::UnprovenancedPrompt)?;
    let borrowed: Vec<(&str, &str)> = delivered_bindings
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let delivered_prompt = bind_ordered(message_template, &borrowed)?;
    Ok(ComposedTaskKickoff {
        template,
        bindings: std::iter::once(("task_id".to_owned(), task_id.to_owned()))
            .chain(
                delivered_bindings
                    .into_iter()
                    .map(|(name, value)| (name.to_owned(), value)),
            )
            .collect(),
        delivered_prompt,
    })
}

/// Composes the visible first message for a saved workflow coordinator.
pub fn task_workflow_prompt(
    execution_id: &str,
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    goal: &str,
    workflow: &termloop_domain::WorkflowConfiguration,
) -> Result<AskToTerminalPrompt, InvocationError> {
    let composed = compose_task_workflow(
        execution_id,
        Some(task_id),
        title,
        brief,
        jira_url,
        goal,
        workflow,
        0,
        1,
    )?;
    terminal_prompt(
        composed.template,
        composed.bindings,
        composed.delivered_prompt,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn task_agent_with_workflow_for_managed_worktree_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    execution_id: &str,
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    goal: &str,
    workflow: &termloop_domain::WorkflowConfiguration,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    let composed = compose_task_workflow(
        execution_id,
        Some(task_id),
        title,
        brief,
        jira_url,
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
        CodexProjectTrust::ManagedWorkspace,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compose_task_workflow(
    execution_id: &str,
    task_id: Option<&str>,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    goal: &str,
    workflow: &termloop_domain::WorkflowConfiguration,
    current_step_index: usize,
    review_cycle: u8,
) -> Result<ComposedTaskKickoff, InvocationError> {
    use std::fmt::Write as _;

    let brief_context = brief
        .map(|brief| format!("Context: {brief}\n"))
        .unwrap_or_default();
    let jira_context = jira_url
        .map(|jira_url| format!("Jira: {jira_url}\n"))
        .unwrap_or_default();
    let mut workflow_steps = String::new();
    for (index, step) in workflow.steps.iter().enumerate() {
        let kind = match step.kind {
            termloop_domain::WorkflowStepKind::Discuss => "DISCUSS",
            termloop_domain::WorkflowStepKind::Implement => "IMPLEMENT",
            termloop_domain::WorkflowStepKind::Review => "REVIEW",
            termloop_domain::WorkflowStepKind::Fix => "FIX",
        };
        writeln!(workflow_steps, "{}. {} — {}", index + 1, kind, step.title)
            .map_err(|_| InvocationError::InvalidPromptBinding)?;
        if let Some(agent_id) = &step.agent_id {
            writeln!(workflow_steps, "   Helper Agent: {agent_id}")
                .map_err(|_| InvocationError::InvalidPromptBinding)?;
        }
        if let Some(profile_ref) = &step.profile_ref {
            writeln!(workflow_steps, "   Agent template: {profile_ref}")
                .map_err(|_| InvocationError::InvalidPromptBinding)?;
        }
        if let Some(reuse_step_id) = &step.reuse_step_id {
            writeln!(
                workflow_steps,
                "   Conversation: reuse helper from step `{reuse_step_id}`"
            )
            .map_err(|_| InvocationError::InvalidPromptBinding)?;
        } else if step.agent_id.is_some() {
            writeln!(workflow_steps, "   Conversation: start fresh")
                .map_err(|_| InvocationError::InvalidPromptBinding)?;
        }
        writeln!(workflow_steps, "   Instructions: {}", step.instructions)
            .map_err(|_| InvocationError::InvalidPromptBinding)?;
    }
    let current_step = workflow
        .steps
        .get(current_step_index)
        .ok_or(InvocationError::InvalidPromptBinding)?;
    let step_kind = match current_step.kind {
        termloop_domain::WorkflowStepKind::Discuss => "DISCUSS",
        termloop_domain::WorkflowStepKind::Implement => "IMPLEMENT",
        termloop_domain::WorkflowStepKind::Review => "REVIEW",
        termloop_domain::WorkflowStepKind::Fix => "FIX",
    };
    let review_group_count = workflow.steps[current_step_index..]
        .iter()
        .take_while(|step| step.kind == termloop_domain::WorkflowStepKind::Review)
        .count();
    let step_action = match current_step.kind {
        termloop_domain::WorkflowStepKind::Discuss => {
            "Use `workflow_delegate` once with the exact question and context the configured discussion participant needs. TermLoop chooses that participant. When its answer arrives, incorporate the advice, then call `workflow_step_complete` with outcome `completed` and a concise `summary` of the decision for the workflow sidebar.".to_owned()
        }
        termloop_domain::WorkflowStepKind::Review => {
            format!(
                "This is one parallel review group with {review_group_count} independent reviewer(s). Call `workflow_delegate` {review_group_count} time(s), in the configured review-step order, without waiting between calls. Each call routes the next reviewer and, when configured, reuses only that reviewer's declared conversation. Wait until every reviewer answer has arrived. Then call `workflow_step_complete` {review_group_count} time(s), again in configured order: use outcome `approved` when that reviewer has no actionable change, or `changesRequested` when the Fix step must address its findings, with that reviewer's concise `summary`. Core waits for all reviewers and combines their outcomes; do not collapse them into one report."
            )
        }
        termloop_domain::WorkflowStepKind::Implement => {
            "Perform this implementation yourself in the current working directory and run proportionate verification. When the step is genuinely complete, call `workflow_step_complete` with outcome `completed` and a concise `summary` of what changed and what was verified for the workflow sidebar.".to_owned()
        }
        termloop_domain::WorkflowStepKind::Fix => {
            "Address the actionable findings collected from every reviewer in this review cycle yourself and run proportionate verification. When the step is genuinely complete, call `workflow_step_complete` with outcome `completed` and a concise `summary` of fixes and verification for the workflow sidebar. TermLoop will either re-run the parallel review group or finish at the configured cycle limit.".to_owned()
        }
    };
    let review_cycles = workflow.max_review_cycles.to_string();
    let review_cycle = review_cycle.to_string();
    let step_number = (current_step_index + 1).to_string();
    let step_count = workflow.steps.len().to_string();
    if execution_id.trim().is_empty()
        || task_id.is_some_and(|id| id.trim().is_empty())
        || title.trim().is_empty()
        || goal.trim().is_empty()
        || goal.len() > termloop_domain::WORKFLOW_GOAL_MAX_BYTES
        || !workflow.is_valid()
        || jira_url.is_some_and(|jira_url| jira_url.trim().is_empty() || jira_url.len() > 2_048)
        || [
            task_id.unwrap_or(&workflow.project_id),
            title,
            brief_context.as_str(),
            jira_context.as_str(),
            workflow.name.as_str(),
            goal,
            workflow_steps.as_str(),
            current_step.title.as_str(),
            current_step.instructions.as_str(),
            step_action.as_str(),
        ]
        .iter()
        .any(|value| {
            value
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        })
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| {
            template.id
                == if task_id.is_some() {
                    "builtin.agent.task-workflow"
                } else {
                    "builtin.agent.project-workflow"
                }
        })
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let message_template = template
        .authored_body
        .split_once("\n---\n")
        .map(|(_, message)| message.trim_start())
        .ok_or(InvocationError::UnprovenancedPrompt)?;
    let delivered_bindings = [
        ("workflow_name", workflow.name.as_str()),
        ("goal", goal),
        ("title", title),
        ("jira_context", jira_context.as_str()),
        ("brief_context", brief_context.as_str()),
        ("workflow_steps", workflow_steps.as_str()),
        ("step_number", step_number.as_str()),
        ("step_count", step_count.as_str()),
        ("step_kind", step_kind),
        ("step_title", current_step.title.as_str()),
        ("review_cycle", review_cycle.as_str()),
        ("max_review_cycles", review_cycles.as_str()),
        ("step_instructions", current_step.instructions.as_str()),
        ("execution_id", execution_id),
        ("step_action", step_action.as_str()),
    ];
    let delivered_prompt = bind_ordered(message_template, &delivered_bindings)?;
    Ok(ComposedTaskKickoff {
        template,
        bindings: std::iter::once(if let Some(task_id) = task_id {
            ("task_id".to_owned(), task_id.to_owned())
        } else {
            ("project_id".to_owned(), workflow.project_id.clone())
        })
        .chain(std::iter::once((
            "workflow_id".to_owned(),
            workflow.id.clone(),
        )))
        .chain(std::iter::once((
            "workflow_generation".to_owned(),
            workflow.generation.to_string(),
        )))
        .chain(
            delivered_bindings
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value.to_owned())),
        )
        .collect(),
        delivered_prompt,
    })
}

/// Composes the next Core-owned step as one visible generated terminal input.
#[allow(clippy::too_many_arguments)]
pub fn task_workflow_step_prompt(
    execution_id: &str,
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    goal: &str,
    workflow: &termloop_domain::WorkflowConfiguration,
    current_step_index: usize,
    review_cycle: u8,
) -> Result<AskToTerminalPrompt, InvocationError> {
    let composed = compose_task_workflow(
        execution_id,
        Some(task_id),
        title,
        brief,
        jira_url,
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

/// Composes the initial visible assignment for one managed Task Agent. The
/// stable Task-derived assignment identity lets a retry be recognized without
/// adding durable delivery history.
pub fn steward_task_assignment_prompt(
    task_id: &str,
    steward_session_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    assignment: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    let composed = compose_steward_task_assignment(
        task_id,
        steward_session_id,
        title,
        brief,
        jira_url,
        assignment,
    )?;
    terminal_prompt(
        composed.template,
        composed.bindings,
        composed.delivered_prompt,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn steward_task_agent_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    task_id: &str,
    steward_session_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    assignment: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    steward_task_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        task_id,
        steward_session_id,
        title,
        brief,
        jira_url,
        assignment,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn steward_task_agent_for_managed_worktree_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    task_id: &str,
    steward_session_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    assignment: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    steward_task_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        task_id,
        steward_session_id,
        title,
        brief,
        jira_url,
        assignment,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::ManagedWorkspace,
    )
}

#[allow(clippy::too_many_arguments)]
fn steward_task_agent_for_conversation_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    task_id: &str,
    steward_session_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    assignment: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    let composed = compose_steward_task_assignment(
        task_id,
        steward_session_id,
        title,
        brief,
        jira_url,
        assignment,
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
        codex_project_trust,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

struct ComposedStewardTaskAssignment {
    template: &'static PromptTemplate,
    bindings: Vec<(String, String)>,
    delivered_prompt: String,
}

fn compose_steward_task_assignment(
    task_id: &str,
    steward_session_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    assignment: &str,
) -> Result<ComposedStewardTaskAssignment, InvocationError> {
    let brief = brief.unwrap_or("No current Task brief.");
    let jira_context = jira_url
        .map(|jira_url| format!("Jira issue: {jira_url}\n"))
        .unwrap_or_default();
    if task_id.trim().is_empty()
        || steward_session_id.trim().is_empty()
        || title.trim().is_empty()
        || assignment.trim().is_empty()
        || assignment.len() > 8_192
        || jira_url.is_some_and(|jira_url| jira_url.trim().is_empty() || jira_url.len() > 2_048)
        || [
            task_id,
            steward_session_id,
            title,
            brief,
            jira_context.as_str(),
            assignment,
        ]
        .iter()
        .any(|value| {
            value
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        })
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.steward.task-assignment")
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let bindings = [
        ("task_id", task_id),
        ("title", title),
        ("steward_session_id", steward_session_id),
        ("jira_context", jira_context.as_str()),
        ("brief", brief),
        ("assignment", assignment),
    ];
    let delivered_prompt = bind_ordered(template.authored_body, &bindings)?;
    Ok(ComposedStewardTaskAssignment {
        template,
        bindings: bindings
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
        delivered_prompt,
    })
}
