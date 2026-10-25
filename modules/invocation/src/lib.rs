#![forbid(unsafe_code)]

mod assistant;
mod delivery_check;
mod personal_agent;
mod playbook_evaluation;
pub use delivery_check::delivery_check_for_conversation;
mod profiles;
pub use playbook_evaluation::playbook_evaluator_for_conversation;
mod improver;
mod project_workflow;
pub use improver::*;
mod task_agent;
pub use personal_agent::personal_agent_for_conversation;
pub use project_workflow::{
    project_agent_with_workflow_for_conversation, project_workflow_step_prompt,
};
use task_agent::compose_task_workflow;
pub use task_agent::*;

pub use profiles::{AgentProfile, agent_profile, agent_profiles};
use std::path::Path;
#[cfg(test)]
use termloop_launch::content_digest;
pub use termloop_launch::{
    AgentConversationLaunch, AgentObservationLaunch, AgentObservationLaunchTransport,
    CODEX_APP_SERVER_RUNTIME_PLACEHOLDER, CodexAppServerLaunch, GeneratedTerminalSubmission,
    ImageAttachment as QuickActionImageAttachment, InspectableArgument, InspectableContentPart,
    InspectableEnvironmentEntry, InspectableGeneratedFile, InspectableLaunchManifest,
    InspectableLaunchTarget, InspectableLimitation, InspectableProvenance, InspectableTransport,
    InvocationError, LaunchPayload, PromptTemplate, Provenance,
    TerminalPrompt as AskToTerminalPrompt, validate_agent_configuration,
};
use termloop_launch::{CodexProjectTrust, ResolvedLaunchManifest, bind_ordered, terminal_prompt};

pub use assistant::{
    AssistantLaunchDefaults, AssistantWakeMessage, AssistantWakeReason, ExecutorRole,
    ProvenancedPrompt, assistant_activation_message, assistant_wake_message,
    default_assistant_launch_selection, default_steward_system_prompt,
    editable_steward_system_prompt, editable_steward_system_prompt_from_effective,
    effective_steward_system_prompt, executor_prompt, resolved_steward_system_prompt,
    tracker_assignment_prompt,
};

const INTERACTIVE_AGENT_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.interactive",
    version: 7,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.interactive.md"),
};
const PROJECT_MANAGER_PLAYBOOK_POLICY_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.policy.project-manager-playbook",
    version: 4,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.policy.project-manager-playbook.md"
    ),
};
const PROJECT_MANAGER_AGENT_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.project-manager",
    version: 5,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.project-manager.md"),
};
#[cfg(test)]
const CODEX_DISABLE_STARTUP_UPDATE_CHECK: &str = "check_for_update_on_startup=false";
pub const QUICK_ACTION_FREE_PROMPT_TEMPLATE_REF: &str = "builtin.quick-action.free-prompt";
const QUICK_ACTION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: QUICK_ACTION_FREE_PROMPT_TEMPLATE_REF,
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.quick-action.free-prompt.md"),
};

const IMPROVER_RUN_CONFIGURATION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.run-configuration",
    version: 5,
    authored_body: include_str!("../../../resources/prompts/builtin.improver.run-configuration.md"),
};

const IMPROVER_RUN_CONFIGURATION_NEW_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.run-configuration-new",
    version: 6,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.improver.run-configuration-new.md"
    ),
};

const IMPROVER_STEWARD_INSTRUCTIONS_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.steward-instructions",
    version: 7,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.improver.steward-instructions.md"
    ),
};

const IMPROVER_SKILL_DEFINITION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.skill-definition",
    version: 4,
    authored_body: include_str!("../../../resources/prompts/builtin.improver.skill-definition.md"),
};

const IMPROVER_PROMPT_ASSET_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.prompt-asset",
    version: 4,
    authored_body: include_str!("../../../resources/prompts/builtin.improver.prompt-asset.md"),
};

const IMPROVER_MCP_TOOL_DESCRIPTION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.mcp-tool-description",
    version: 4,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.improver.mcp-tool-description.md"
    ),
};

const IMPROVER_ROUTINE_INSTRUCTIONS_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.routine-instructions",
    version: 12,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.improver.routine-instructions.md"
    ),
};

const AGENT_CREATOR_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.builder.agent",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.builder.agent.md"),
};

const WORKFLOW_CREATOR_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.builder.workflow",
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.builder.workflow.md"),
};

const ROUTINE_BUILDER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.builder.routine",
    version: 11,
    authored_body: include_str!("../../../resources/prompts/builtin.builder.routine.md"),
};

const PLAYBOOK_BUILDER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.builder.playbook",
    version: 26,
    authored_body: include_str!("../../../resources/prompts/builtin.builder.playbook.md"),
};

const STEWARD_EXECUTOR_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.steward.executor",
    version: 42,
    authored_body: include_str!("../../../resources/prompts/builtin.steward.executor.md"),
};

const ROUTINE_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.routine",
    version: 3,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.routine.md"),
};

const STEP_CHECK_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.step-check",
    version: 13,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.step-check.md"),
};

const TASK_EVIDENCE_POLICY_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.policy.task-evidence",
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.policy.task-evidence.md"),
};

const ASSISTANT_WAKE_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.assistant.wake",
    version: 10,
    authored_body: include_str!("../../../resources/prompts/builtin.assistant.wake.md"),
};
const ASSISTANT_ACTIVATION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.assistant.activation",
    version: 3,
    authored_body: include_str!("../../../resources/prompts/builtin.assistant.activation.md"),
};

const ASK_TO_HELPER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.ask-to-helper",
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.ask-to-helper.md"),
};

const ASK_TO_FOLLOWUP_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.ask-to-followup",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.ask-to-followup.md"),
};

const ASK_TO_REPLY_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.ask-to-reply",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.ask-to-reply.md"),
};

const ASK_TO_RESUME_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.ask-to-resume",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.ask-to-resume.md"),
};

const AGENT_WORKTREE_RELOCATION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.worktree-relocation",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.worktree-relocation.md"),
};

const AGENT_PROJECT_RELOCATION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.project-relocation",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.project-relocation.md"),
};

const STEWARD_AGENT_MESSAGE_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.steward.agent-message",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.steward.agent-message.md"),
};

const AGENT_HANDOFF_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.handoff",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.handoff.md"),
};

const AGENT_MENU_ASK_TO_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.menu-ask-to",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.menu-ask-to.md"),
};

const AGENT_MENU_HANDOVER_TO_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.menu-handover-to",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.menu-handover-to.md"),
};

const STEWARD_TASK_ASSIGNMENT_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.steward.task-assignment",
    version: 3,
    authored_body: include_str!("../../../resources/prompts/builtin.steward.task-assignment.md"),
};

const AGENT_TASK_KICKOFF_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.task-kickoff",
    version: 2,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.task-kickoff.md"),
};

const AGENT_TASK_WORKFLOW_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.task-workflow",
    version: 5,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.task-workflow.md"),
};

/// The catalog is the only source from which invocation provenance may be
/// resolved. F0 has one no-initial-message launch template; later prompt
/// features add bindings and delivered previews here rather than at call sites.
pub fn prompt_templates() -> &'static [PromptTemplate] {
    &[
        INTERACTIVE_AGENT_TEMPLATE,
        PROJECT_MANAGER_AGENT_TEMPLATE,
        QUICK_ACTION_TEMPLATE,
        personal_agent::PERSONAL_AGENT_TEMPLATE,
        profiles::SCATTERED_ORCHESTRATION_FINDER_TEMPLATE,
        profiles::EDGE_CASE_HUNTER_TEMPLATE,
        profiles::TEST_GAP_FINDER_TEMPLATE,
        profiles::ARCHITECTURE_BOUNDARY_REVIEWER_TEMPLATE,
        IMPROVER_RUN_CONFIGURATION_TEMPLATE,
        IMPROVER_RUN_CONFIGURATION_NEW_TEMPLATE,
        IMPROVER_STEWARD_INSTRUCTIONS_TEMPLATE,
        IMPROVER_SKILL_DEFINITION_TEMPLATE,
        IMPROVER_PROMPT_ASSET_TEMPLATE,
        IMPROVER_MCP_TOOL_DESCRIPTION_TEMPLATE,
        IMPROVER_ROUTINE_INSTRUCTIONS_TEMPLATE,
        ROUTINE_BUILDER_TEMPLATE,
        AGENT_CREATOR_TEMPLATE,
        WORKFLOW_CREATOR_TEMPLATE,
        PLAYBOOK_BUILDER_TEMPLATE,
        TASK_EVIDENCE_POLICY_TEMPLATE,
        PROJECT_MANAGER_PLAYBOOK_POLICY_TEMPLATE,
        STEWARD_EXECUTOR_TEMPLATE,
        ROUTINE_TRACKER_TEMPLATE,
        STEP_CHECK_TRACKER_TEMPLATE,
        ASSISTANT_WAKE_TEMPLATE,
        ASSISTANT_ACTIVATION_TEMPLATE,
        ASK_TO_HELPER_TEMPLATE,
        playbook_evaluation::PLAYBOOK_EVALUATOR_TEMPLATE,
        ASK_TO_FOLLOWUP_TEMPLATE,
        ASK_TO_REPLY_TEMPLATE,
        ASK_TO_RESUME_TEMPLATE,
        AGENT_WORKTREE_RELOCATION_TEMPLATE,
        AGENT_PROJECT_RELOCATION_TEMPLATE,
        STEWARD_AGENT_MESSAGE_TEMPLATE,
        AGENT_HANDOFF_TEMPLATE,
        AGENT_MENU_ASK_TO_TEMPLATE,
        AGENT_MENU_HANDOVER_TO_TEMPLATE,
        STEWARD_TASK_ASSIGNMENT_TEMPLATE,
        AGENT_TASK_KICKOFF_TEMPLATE,
        delivery_check::DELIVERY_CHECK_TEMPLATE,
        AGENT_TASK_WORKFLOW_TEMPLATE,
        project_workflow::PROJECT_WORKFLOW_TEMPLATE,
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickActionPreview {
    pub agent_id: String,
    pub model: String,
    pub permission: String,
    pub reasoning: String,
    pub template_ref: String,
    pub template_version: u32,
    pub delivery: &'static str,
    pub delivered_preview: String,
    pub manifest: InspectableLaunchManifest,
}

pub fn preview_quick_action(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
) -> Result<QuickActionPreview, InvocationError> {
    preview_quick_action_for_conversation(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        prompt,
        AgentConversationLaunch::Fresh { resume_ref: None },
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn preview_quick_action_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
) -> Result<QuickActionPreview, InvocationError> {
    let template = quick_action_template()?;
    validate_quick_action(agent_id, model, permission, reasoning, prompt)?;
    let resolved = resolve_launch_manifest(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        Some(prompt),
        conversation,
        observation,
        None,
    )?;
    Ok(QuickActionPreview {
        agent_id: agent_id.to_owned(),
        model: model.to_owned(),
        permission: permission.to_owned(),
        reasoning: reasoning.to_owned(),
        template_ref: template.id.to_owned(),
        template_version: template.version,
        delivery: if agent_id == "opencode" {
            "providerPromptArgument"
        } else {
            "terminalInput"
        },
        delivered_preview: prompt.to_owned(),
        manifest: resolved.inspectable_manifest().clone(),
    })
}

// The launch constructor keeps each provider choice explicit so callers cannot
// smuggle an unvalidated options bag across the invocation boundary.
#[allow(clippy::too_many_arguments)]
pub fn quick_action_agent_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    quick_action_agent_with_attachments_for_conversation(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        prompt,
        &[],
        conversation,
        observation,
        mcp,
    )
}

// The launch constructor keeps the attachment order and provider delivery in
// invocation so neither core nor a client can append launch facts after the
// inspected manifest has been resolved.
#[allow(clippy::too_many_arguments)]
pub fn quick_action_agent_with_attachments_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
    attachments: &[QuickActionImageAttachment],
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    let template = quick_action_template()?;
    validate_quick_action_with_attachments(
        agent_id,
        model,
        permission,
        reasoning,
        prompt,
        attachments,
    )?;
    resolve_launch_manifest_with_attachments(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        Some(prompt),
        conversation,
        observation,
        mcp,
        None,
        None,
        attachments,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

/// Resolves a catalog-backed Agent Profile as persistent provider instructions
/// while preserving the caller's task as the first visible conversation
/// message. Profiles are deliberately limited to the providers that can accept
/// an inspectable launch-scoped instruction layer.
#[allow(clippy::too_many_arguments)]
pub fn profile_quick_action_agent_with_attachments_for_conversation(
    profile_ref: &str,
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
    attachments: &[QuickActionImageAttachment],
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    let profile = validate_agent_profile_selection(profile_ref, agent_id)?;
    validate_quick_action_with_attachments(
        agent_id,
        model,
        permission,
        reasoning,
        prompt,
        attachments,
    )?;
    let provider_instructions = profile_provider_instructions(profile, mcp.as_ref())?;
    let mut resolved = resolve_launch_manifest_with_attachments(
        agent_id,
        cwd,
        profile.template(),
        model,
        permission,
        reasoning,
        Some(prompt),
        conversation,
        observation,
        mcp,
        Some(profile.template()),
        Some(&provider_instructions),
        attachments,
    )?;
    let delivered_prompt = resolved
        .delivered_prompt()
        .expect("profile Quick Action always resolves a first message");
    resolved.set_provenance_content(&format!("{provider_instructions}\n\n{delivered_prompt}"));
    resolved.set_bindings(vec![
        ("profileRef".into(), profile.id.into()),
        ("prompt".into(), prompt.into()),
    ]);
    Ok(resolved.into_payload())
}

#[allow(clippy::too_many_arguments)]
pub fn configured_agent_profile_for_conversation_resume(
    profile_ref: &str,
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    configured_agent_profile_for_conversation_resume_with_codex_project_trust(
        profile_ref,
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn configured_agent_profile_for_managed_worktree_conversation_resume(
    profile_ref: &str,
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    configured_agent_profile_for_conversation_resume_with_codex_project_trust(
        profile_ref,
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::ManagedWorkspace,
    )
}

#[allow(clippy::too_many_arguments)]
fn configured_agent_profile_for_conversation_resume_with_codex_project_trust(
    profile_ref: &str,
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
    let profile = validate_agent_profile_selection(profile_ref, agent_id)?;
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    let provider_instructions = profile_provider_instructions(profile, mcp.as_ref())?;
    resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        profile.template(),
        model,
        permission,
        reasoning,
        None,
        conversation,
        observation,
        mcp,
        Some(profile.template()),
        Some(&provider_instructions),
        &[],
        codex_project_trust,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

fn validate_agent_profile_selection(
    profile_ref: &str,
    agent_id: &str,
) -> Result<&'static AgentProfile, InvocationError> {
    let profile = agent_profile(profile_ref).ok_or(InvocationError::TemplateMissing)?;
    if !profile.user_invocable || !profile.supported_agent_ids.contains(&agent_id) {
        return Err(InvocationError::UnsupportedAgent(agent_id.to_owned()));
    }
    Ok(profile)
}

fn profile_provider_instructions(
    profile: &AgentProfile,
    mcp: Option<&AgentMcpLaunch<'_>>,
) -> Result<String, InvocationError> {
    let instructions =
        if let Some(protocol) = mcp.and_then(|mcp| mcp.profile.interactive_instructions()) {
            format!("{}\n\n{}", protocol.authored_body, profile.instructions())
        } else {
            profile.instructions().to_owned()
        };
    if instructions.len() > 64 * 1024 {
        return Err(InvocationError::InvalidDeveloperInstructions);
    }
    Ok(instructions)
}

fn quick_action_template() -> Result<&'static PromptTemplate, InvocationError> {
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == QUICK_ACTION_FREE_PROMPT_TEMPLATE_REF)
        .ok_or(InvocationError::TemplateMissing)?;
    if !template
        .authored_body
        .contains(&format!("id: `{}`", template.id))
        || !template.authored_body.contains("binding: `prompt`")
        || !template
            .authored_body
            .contains("binding: `imageAttachments`")
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    Ok(template)
}

include!("engine/selection.rs");

include!("engine/resolve.rs");

include!("engine/environment.rs");

include!("engine/payload.rs");

pub struct PersistentAssistantLaunch<'a> {
    pub agent_id: &'a str,
    pub model: &'a str,
    pub permission: &'a str,
    pub reasoning: &'a str,
    pub role: ExecutorRole,
    pub system_prompt: Option<&'a str>,
    pub cwd: &'a str,
    pub conversation: AgentConversationLaunch<'a>,
    pub observation: Option<AgentObservationLaunch<'a>>,
    pub mcp: AgentMcpLaunch<'a>,
}

include!("engine/provider.rs");

pub fn interactive_agent(agent_id: &str, cwd: &str) -> Result<LaunchPayload, InvocationError> {
    interactive_agent_for_conversation(
        agent_id,
        cwd,
        AgentConversationLaunch::Fresh { resume_ref: None },
        None,
        None,
    )
}

pub fn interactive_agent_with_observation(
    agent_id: &str,
    cwd: &str,
    observation: Option<AgentObservationLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    interactive_agent_for_conversation(
        agent_id,
        cwd,
        AgentConversationLaunch::Fresh { resume_ref: None },
        observation,
        None,
    )
}

pub fn interactive_agent_for_conversation(
    agent_id: &str,
    cwd: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    interactive_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

pub fn interactive_agent_for_managed_worktree_conversation(
    agent_id: &str,
    cwd: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    interactive_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::ManagedWorkspace,
    )
}

fn interactive_agent_for_conversation_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.interactive")
        .ok_or(InvocationError::TemplateMissing)?;
    if template.authored_body.trim().is_empty()
        || !template
            .authored_body
            .contains(&format!("id: `{}`", template.id))
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    resolve_launch_manifest_with_codex_project_trust(
        agent_id,
        cwd,
        template,
        "default",
        default_permission(agent_id),
        "default",
        None,
        conversation,
        observation,
        mcp,
        codex_project_trust,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

#[allow(clippy::too_many_arguments)]
pub fn configured_interactive_agent_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    configured_interactive_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn configured_interactive_agent_for_managed_worktree_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    configured_interactive_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::ManagedWorkspace,
    )
}

#[allow(clippy::too_many_arguments)]
fn configured_interactive_agent_for_conversation_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.interactive")
        .ok_or(InvocationError::TemplateMissing)?;
    if template.authored_body.trim().is_empty()
        || !template
            .authored_body
            .contains(&format!("id: `{}`", template.id))
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    resolve_launch_manifest_with_codex_project_trust(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        None,
        conversation,
        observation,
        mcp,
        codex_project_trust,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

/// Resumes one ordinary interactive provider conversation in a different
/// managed worktree. The visible relocation notice, target cwd, provider
/// resume identity, launch selection, observation configuration, and MCP
/// configuration are resolved into one manifest before any process starts.
#[allow(clippy::too_many_arguments)]
pub fn configured_interactive_agent_for_worktree_relocation(
    agent_id: &str,
    source_cwd: &str,
    target_cwd: &str,
    task_id: &str,
    task_title: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    if [source_cwd, target_cwd, task_id, task_title]
        .iter()
        .any(|value| {
            value.trim().is_empty()
                || value.len() > 4_096
                || value
                    .chars()
                    .any(|character| character.is_control() && character != '\t')
        })
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = &AGENT_WORKTREE_RELOCATION_TEMPLATE;
    let bindings = [
        ("task_id", task_id),
        ("task_title", task_title),
        ("source_cwd", source_cwd),
        ("target_cwd", target_cwd),
    ];
    let delivered_prompt = bind_ordered(template.authored_body, &bindings)?;
    let mut resolved = resolve_launch_manifest_for_managed_worktree(
        agent_id,
        target_cwd,
        template,
        model,
        permission,
        reasoning,
        Some(&delivered_prompt),
        conversation,
        observation,
        mcp,
    )?;
    resolved.set_bindings(
        bindings
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
    );
    Ok(resolved.into_payload())
}

/// Resumes an ordinary Task-attached conversation in the Project checkout.
#[allow(clippy::too_many_arguments)]
pub fn configured_interactive_agent_for_project_relocation(
    agent_id: &str,
    source_cwd: &str,
    target_cwd: &str,
    source_task_id: &str,
    source_task_title: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    if [source_cwd, target_cwd, source_task_id, source_task_title]
        .iter()
        .any(|value| {
            value.trim().is_empty()
                || value.len() > 4_096
                || value
                    .chars()
                    .any(|character| character.is_control() && character != '\t')
        })
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = &AGENT_PROJECT_RELOCATION_TEMPLATE;
    let bindings = [
        ("source_task_id", source_task_id),
        ("source_task_title", source_task_title),
        ("source_cwd", source_cwd),
        ("target_cwd", target_cwd),
    ];
    let delivered_prompt = bind_ordered(template.authored_body, &bindings)?;
    let mut resolved = resolve_launch_manifest(
        agent_id,
        target_cwd,
        template,
        model,
        permission,
        reasoning,
        Some(&delivered_prompt),
        conversation,
        observation,
        mcp,
    )?;
    resolved.set_bindings(
        bindings
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
    );
    Ok(resolved.into_payload())
}

#[allow(clippy::too_many_arguments)]
pub fn configured_ask_to_helper_for_conversation_resume(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    current_request_id: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    profile: Option<&termloop_domain::PersonalAgent>,
) -> Result<LaunchPayload, InvocationError> {
    configured_ask_to_helper_for_conversation_resume_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        current_request_id,
        conversation,
        observation,
        mcp,
        profile,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn configured_ask_to_helper_for_managed_worktree_conversation_resume(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    current_request_id: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    profile: Option<&termloop_domain::PersonalAgent>,
) -> Result<LaunchPayload, InvocationError> {
    configured_ask_to_helper_for_conversation_resume_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        current_request_id,
        conversation,
        observation,
        mcp,
        profile,
        CodexProjectTrust::ManagedWorkspace,
    )
}

#[allow(clippy::too_many_arguments)]
fn configured_ask_to_helper_for_conversation_resume_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    current_request_id: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    profile: Option<&termloop_domain::PersonalAgent>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    let template = &ASK_TO_RESUME_TEMPLATE;
    if template.authored_body.trim().is_empty()
        || !template
            .authored_body
            .contains(&format!("id: `{}`", template.id))
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    let prompt = current_request_id
        .map(|request_id| {
            if request_id.is_empty()
                || request_id.len() > 128
                || request_id.chars().any(char::is_control)
            {
                return Err(InvocationError::InvalidPromptBinding);
            }
            bind_ordered(template.authored_body, &[("request_id", request_id)])
        })
        .transpose()?;
    let provider_instructions = profile
        .map(|profile| personal_agent::personal_agent_provider_instructions(profile, mcp.as_ref()))
        .transpose()?;
    let mut resolved = resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        prompt.as_deref(),
        conversation,
        observation,
        mcp,
        profile.map(|_| &personal_agent::PERSONAL_AGENT_TEMPLATE),
        provider_instructions.as_deref(),
        &[],
        codex_project_trust,
    )?;
    if let Some(profile) = profile {
        resolved.add_binding("profileRef", profile.id.clone());
        resolved.add_binding("profileVersion", profile.version.to_string());
    }
    Ok(resolved.into_payload())
}

/// Resolves a persistent Steward through the same inspected manifest
/// used by ordinary interactive Agents. The authenticated HTTP MCP principal,
/// not prompt text or provider argv, fixes the role-specific tool catalog.
pub fn persistent_assistant_agent(
    configuration: PersistentAssistantLaunch<'_>,
) -> Result<LaunchPayload, InvocationError> {
    if configuration.role != ExecutorRole::Steward {
        return Err(InvocationError::InvalidAssistantConfiguration);
    }
    let instruction_template = configuration.role.template();
    assistant::validate_template_asset(instruction_template)?;
    let (provider_instructions, bindings) = match configuration.system_prompt {
        Some(prompt) if prompt.len() <= 16 * 1024 => (
            assistant::effective_steward_system_prompt(prompt),
            vec![("systemPrompt".into(), prompt.trim().to_owned())],
        ),
        _ => return Err(InvocationError::InvalidAssistantConfiguration),
    };
    validate_agent_configuration(
        configuration.agent_id,
        configuration.model,
        configuration.permission,
        configuration.reasoning,
    )?;
    let activation = assistant::assistant_activation_message(configuration.role)?;
    let mut manifest = resolve_launch_manifest_with_provider_instructions(
        configuration.agent_id,
        configuration.cwd,
        &ASSISTANT_ACTIVATION_TEMPLATE,
        configuration.model,
        configuration.permission,
        configuration.reasoning,
        activation.delivered_preview(),
        instruction_template,
        &provider_instructions,
        configuration.conversation,
        configuration.observation,
        configuration.mcp,
    )?;
    manifest.set_bindings(bindings);
    Ok(manifest.into_payload())
}

#[allow(clippy::too_many_arguments)]
pub fn ask_to_helper_agent_for_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    request_id: &str,
    message: &str,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
    profile: Option<&termloop_domain::PersonalAgent>,
) -> Result<LaunchPayload, InvocationError> {
    ask_to_helper_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        conversation,
        request_id,
        message,
        observation,
        mcp,
        profile,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn ask_to_helper_agent_for_managed_worktree_conversation(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    request_id: &str,
    message: &str,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
    profile: Option<&termloop_domain::PersonalAgent>,
) -> Result<LaunchPayload, InvocationError> {
    ask_to_helper_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        model,
        permission,
        reasoning,
        conversation,
        request_id,
        message,
        observation,
        mcp,
        profile,
        CodexProjectTrust::ManagedWorkspace,
    )
}

#[allow(clippy::too_many_arguments)]
fn ask_to_helper_agent_for_conversation_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    conversation: AgentConversationLaunch<'_>,
    request_id: &str,
    message: &str,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
    profile: Option<&termloop_domain::PersonalAgent>,
    codex_project_trust: CodexProjectTrust,
) -> Result<LaunchPayload, InvocationError> {
    if request_id.trim().is_empty() || message.trim().is_empty() {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.ask-to-helper")
        .ok_or(InvocationError::TemplateMissing)?;
    if template.authored_body.trim().is_empty()
        || !template
            .authored_body
            .contains(&format!("id: `{}`", template.id))
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    let delivered = bind_ask_to_prompt(template.authored_body, request_id, message)?;
    let provider_instructions = profile
        .map(|profile| personal_agent::personal_agent_provider_instructions(profile, Some(&mcp)))
        .transpose()?;
    let mut resolved = resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        None,
        conversation,
        observation,
        Some(mcp),
        profile.map(|_| &personal_agent::PERSONAL_AGENT_TEMPLATE),
        provider_instructions.as_deref(),
        &[],
        codex_project_trust,
    )?;
    resolved.positional_message(
        &delivered,
        format!("resources/prompts/{}", template.id),
        "Ask-To first message",
    )?;
    resolved.set_bindings(vec![
        ("request_id".into(), request_id.into()),
        ("message".into(), message.into()),
    ]);
    if let Some(profile) = profile {
        resolved.add_binding("profileRef", profile.id.clone());
        resolved.add_binding("profileVersion", profile.version.to_string());
    }
    resolved.set_provenance_content(
        &provider_instructions
            .as_deref()
            .map(|instructions| format!("{instructions}\n\n{delivered}"))
            .unwrap_or_else(|| delivered.clone()),
    );
    Ok(resolved.into_payload())
}

pub fn ask_to_follow_up_prompt(
    request_id: &str,
    message: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    if request_id.trim().is_empty()
        || message.trim().is_empty()
        || message
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.ask-to-followup")
        .ok_or(InvocationError::TemplateMissing)?;
    if template.authored_body.trim().is_empty()
        || !template
            .authored_body
            .contains(&format!("id: `{}`", template.id))
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    // Agent TUIs can keep Return in multiline-edit mode when a pasted payload
    // ends on a blank line. The visible delivered form is intentionally
    // trailing-trimmed before both preview and terminal submission.
    let delivered_prompt = bind_ask_to_prompt(template.authored_body, request_id, message)?;
    terminal_prompt(
        template,
        vec![
            ("request_id".into(), request_id.into()),
            ("message".into(), message.into()),
        ],
        delivered_prompt,
    )
}

pub fn ask_to_reply_prompt(
    request_id: &str,
    conversation_id: &str,
    helper_session_id: &str,
    message: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    if [request_id, conversation_id, helper_session_id, message]
        .iter()
        .any(|value| value.trim().is_empty())
        || message
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.ask-to-reply")
        .ok_or(InvocationError::TemplateMissing)?;
    if template.authored_body.trim().is_empty()
        || !template
            .authored_body
            .contains(&format!("id: `{}`", template.id))
    {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    let bindings = [
        ("request_id", request_id),
        ("conversation_id", conversation_id),
        ("helper_session_id", helper_session_id),
        ("message", message),
    ];
    let delivered_prompt = bind_ordered(template.authored_body, &bindings)?;
    terminal_prompt(
        template,
        bindings
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
        delivered_prompt,
    )
}

/// Composes the sole visible post-launch message a Project Steward may send to
/// an ordinary running agent Session. Callers receive a terminal-safe ordered
/// input sequence from the same versioned asset as the delivered preview; they
/// cannot append instructions after composition.
pub fn steward_agent_message_prompt(message: &str) -> Result<AskToTerminalPrompt, InvocationError> {
    if message.trim().is_empty()
        || message.len() > 8_192
        || message
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.steward.agent-message")
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let delivered_prompt = bind_ordered(template.authored_body, &[("message", message)])?;
    terminal_prompt(
        template,
        vec![("message".into(), message.into())],
        delivered_prompt,
    )
}

/// Composes one visible post-launch message from an authenticated Agent to an
/// exact running Agent Session. Invocation owns the complete delivered input
/// sequence; neither core nor the transport may append routing instructions
/// afterward.
pub fn agent_handoff_prompt(
    source_session_id: &str,
    message: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    if source_session_id.trim().is_empty()
        || source_session_id
            .chars()
            .any(|character| !character.is_ascii_hexdigit() && character != '-')
        || message.trim().is_empty()
        || message.chars().count() > 32_768
        || message
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.handoff")
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let bindings = [
        ("source_session_id", source_session_id),
        ("message", message),
    ];
    let delivered_prompt = bind_ordered(template.authored_body, &bindings)?;
    terminal_prompt(
        template,
        bindings
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
        delivered_prompt,
    )
}

/// Composes the visible menu request that asks an existing interactive Agent
/// to involve a tracked helper through its authenticated `ask_to` MCP tool.
pub fn agent_menu_ask_to_prompt(
    target_agent: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    if !termloop_agents::supports_tracked_helpers(target_agent) {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.menu-ask-to")
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let delivered_prompt = bind_ordered(template.authored_body, &[("target_agent", target_agent)])?;
    terminal_prompt(
        template,
        vec![("target_agent".into(), target_agent.into())],
        delivered_prompt,
    )
}

/// Composes the visible menu request that asks an existing interactive Agent
/// to hand its current request to one exact running Session through MCP.
pub fn agent_menu_handover_to_prompt(
    target_session_id: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    if target_session_id.len() != 36
        || target_session_id
            .chars()
            .enumerate()
            .any(|(index, character)| match index {
                8 | 13 | 18 | 23 => character != '-',
                _ => !character.is_ascii_hexdigit(),
            })
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.agent.menu-handover-to")
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let delivered_prompt = bind_ordered(
        template.authored_body,
        &[("target_session_id", target_session_id)],
    )?;
    terminal_prompt(
        template,
        vec![("target_session_id".into(), target_session_id.into())],
        delivered_prompt,
    )
}

fn project_manager_playbook_policy_body() -> &'static str {
    PROJECT_MANAGER_PLAYBOOK_POLICY_TEMPLATE
        .authored_body
        .splitn(3, "\n\n")
        .nth(2)
        .expect("Project Manager Playbook policy has metadata and instructions")
        .trim()
}

fn task_evidence_policy_body() -> &'static str {
    TASK_EVIDENCE_POLICY_TEMPLATE
        .authored_body
        .splitn(3, "\n\n")
        .nth(2)
        .expect("Task evidence policy has metadata and instructions")
        .trim()
}

fn bind_task_evidence_policy(authored: &str) -> Result<String, InvocationError> {
    bind_ordered(
        authored,
        &[("task_evidence_policy", task_evidence_policy_body())],
    )
}

fn bind_ask_to_prompt(
    authored: &str,
    request_id: &str,
    message: &str,
) -> Result<String, InvocationError> {
    let (before_request, after_request) = authored
        .split_once("{{request_id}}")
        .ok_or(InvocationError::InvalidPromptBinding)?;
    if after_request.contains("{{request_id}}") {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let (before_message, after_message) = after_request
        .split_once("{{message}}")
        .ok_or(InvocationError::InvalidPromptBinding)?;
    if before_request.contains("{{message}}") || after_message.contains("{{message}}") {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let mut delivered = String::with_capacity(authored.len() + request_id.len() + message.len());
    delivered.push_str(before_request);
    delivered.push_str(request_id);
    delivered.push_str(before_message);
    delivered.push_str(message);
    delivered.push_str(after_message);
    Ok(delivered)
}

#[cfg(test)]
mod tests;
