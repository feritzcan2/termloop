#![forbid(unsafe_code)]

mod assistant;
mod personal_agent;
mod profiles;
mod project_workflow;
pub use personal_agent::personal_agent_for_conversation;
pub use project_workflow::{
    project_agent_with_workflow_for_conversation, project_workflow_step_prompt,
};

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
    version: 4,
    authored_body: include_str!("../../../resources/prompts/builtin.improver.run-configuration.md"),
};

const IMPROVER_RUN_CONFIGURATION_NEW_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.run-configuration-new",
    version: 5,
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
    version: 21,
    authored_body: include_str!("../../../resources/prompts/builtin.builder.playbook.md"),
};

const STEWARD_EXECUTOR_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.steward.executor",
    version: 39,
    authored_body: include_str!("../../../resources/prompts/builtin.steward.executor.md"),
};

const ROUTINE_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.routine",
    version: 3,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.routine.md"),
};

const STEP_CHECK_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.step-check",
    version: 11,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.step-check.md"),
};

const TASK_EVIDENCE_POLICY_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.policy.task-evidence",
    version: 1,
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
        STEWARD_EXECUTOR_TEMPLATE,
        ROUTINE_TRACKER_TEMPLATE,
        STEP_CHECK_TRACKER_TEMPLATE,
        ASSISTANT_WAKE_TEMPLATE,
        ASSISTANT_ACTIVATION_TEMPLATE,
        ASK_TO_HELPER_TEMPLATE,
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
        delivery: "terminalInput",
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
    let instructions = if mcp.is_some_and(|mcp| mcp.profile.includes_interactive_instructions()) {
        format!(
            "{}\n\n{}",
            INTERACTIVE_AGENT_TEMPLATE.authored_body,
            profile.instructions()
        )
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

/// One improvable TermLoop surface an "Improve with agent" launch is bound to.
///
/// Each variant resolves its own visible template, so the delivered
/// instructions describe that exact surface — how to verify it, what its
/// fields mean, what must never be proposed — instead of a generic
/// "edit this configuration" prompt. Adding an improvable surface means adding
/// a variant and its asset here, never composing instructions at a call site.
/// Which application-settings catalog an entry improver is aimed at. A skill
/// and a prompt are files the improver edits itself; an MCP tool description is
/// daemon state, so that improver saves through its own narrow MCP profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsEntryKind {
    Skill,
    Prompt,
    McpTool,
}

impl SettingsEntryKind {
    /// The contract value for this kind. A selector and a resolved entry are
    /// compared on it, so one spelling serves both sides.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Prompt => "prompt",
            Self::McpTool => "mcpTool",
        }
    }
}

pub enum ImproverTarget<'a> {
    WorkflowCreator {
        context: &'a str,
    },
    AgentCreator {
        project_name: &'a str,
    },
    /// One entry of an application-settings catalog: a skill's SKILL.md, a
    /// built-in prompt, or an MCP tool description. The improver has direct
    /// version-write authority over that entry after user confirmation.
    SettingsEntry {
        kind: SettingsEntryKind,
        /// What the entry is called where the user found it.
        name: &'a str,
        /// Catalog id, rendered only for a prompt: its file is named after it.
        id: &'a str,
        /// Which launch profiles receive an MCP tool. Empty for the others.
        context: &'a str,
        max_bytes: usize,
    },
    RunConfiguration {
        configuration_id: &'a str,
        configuration_name: &'a str,
    },
    /// A run configuration this Project does not have yet.
    NewRunConfiguration {
        /// Wire value of the kind, which the complete snapshot carries exactly.
        kind: &'a str,
        /// Human label for the same kind, used where the prompt addresses the
        /// user's own words rather than the stored value.
        kind_label: &'a str,
        /// Suggested name the agent starts from.
        name: &'a str,
    },
    /// The Project's editable Steward instructions. The improver rewrites only
    /// the editable part; the built-in role prompt is bound as read-only
    /// context so the editable value neither restates nor contradicts it.
    StewardInstructions {
        project_name: &'a str,
        built_in_instructions: &'a str,
        max_bytes: usize,
    },
    /// One Routine's editable instructions — the surface that says where the
    /// answer to its recurring question actually comes from.
    RoutineInstructions {
        routine_id: &'a str,
        routine_name: &'a str,
        project_name: &'a str,
        /// The built-in prompt for this Routine's kind.
        built_in_instructions: &'a str,
        max_bytes: usize,
    },
    /// A new scheduled Routine for one exact Project. The Builder proposes
    /// both the factual observation and the Steward's response
    /// response policy; no Routine exists until the user accepts it.
    RoutineBuilder {
        project_name: &'a str,
        routine_summary: &'a str,
    },
    /// The Project's delivery Playbook Builder. Its authenticated MCP profile
    /// reads current state and performs revision-checked complete replacements;
    /// these legacy bindings remain validated for launch compatibility.
    Playbook {
        project_name: &'a str,
    },
}

impl ImproverTarget<'_> {
    pub fn template_ref(&self) -> &'static str {
        match self {
            Self::WorkflowCreator { .. } => "builtin.builder.workflow",
            Self::AgentCreator { .. } => "builtin.builder.agent",
            Self::SettingsEntry {
                kind: SettingsEntryKind::Skill,
                ..
            } => "builtin.improver.skill-definition",
            Self::SettingsEntry {
                kind: SettingsEntryKind::Prompt,
                ..
            } => "builtin.improver.prompt-asset",
            Self::SettingsEntry {
                kind: SettingsEntryKind::McpTool,
                ..
            } => "builtin.improver.mcp-tool-description",
            Self::RunConfiguration { .. } => "builtin.improver.run-configuration",
            Self::NewRunConfiguration { .. } => "builtin.improver.run-configuration-new",
            Self::StewardInstructions { .. } => "builtin.improver.steward-instructions",
            Self::RoutineInstructions { .. } => "builtin.improver.routine-instructions",
            Self::RoutineBuilder { .. } => "builtin.builder.routine",
            Self::Playbook { .. } => "builtin.builder.playbook",
        }
    }

    fn template(&self) -> Result<&'static PromptTemplate, InvocationError> {
        let template_ref = self.template_ref();
        let template = prompt_templates()
            .iter()
            .find(|template| template.id == template_ref)
            .ok_or(InvocationError::TemplateMissing)?;
        if template.authored_body.trim().is_empty()
            || !template
                .authored_body
                .contains(&format!("id: `{}`", template.id))
        {
            return Err(InvocationError::UnprovenancedPrompt);
        }
        Ok(template)
    }

    /// The complete delivered instructions. The improver has no generated
    /// system-instruction part: everything it is told is this one visible
    /// terminal-input prompt, so preview bytes and delivered bytes are equal.
    fn delivered_prompt(&self) -> Result<String, InvocationError> {
        let template = self.template()?;
        match *self {
            Self::WorkflowCreator { context } => {
                bounded_embedded_document(context, false, 256 * 1024)?;
                bind_ordered(template.authored_body, &[("context", context)])
            }
            Self::AgentCreator { project_name } => {
                bounded_binding(project_name, 200)?;
                bind_ordered(template.authored_body, &[("project_name", project_name)])
            }
            Self::SettingsEntry {
                kind,
                name,
                id,
                context,
                max_bytes,
            } => {
                bounded_binding(name, 200)?;
                bounded_binding(id, 256)?;
                let max_bytes = max_bytes.to_string();
                let mut bindings: Vec<(&str, &str)> = vec![("entry_name", name)];
                match kind {
                    SettingsEntryKind::Skill => {}
                    SettingsEntryKind::Prompt => {
                        bindings.push(("entry_id", id));
                    }
                    SettingsEntryKind::McpTool => {
                        bounded_binding(context, 200)?;
                        bindings.push(("entry_context", context));
                    }
                }
                bindings.push(("max_bytes", &max_bytes));
                bind_ordered(template.authored_body, &bindings)
            }
            Self::RunConfiguration {
                configuration_id,
                configuration_name,
            } => {
                bounded_binding(configuration_id, 64)?;
                bounded_binding(configuration_name, 80)?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("configuration_name", configuration_name),
                        ("configuration_id", configuration_id),
                    ],
                )
            }
            Self::NewRunConfiguration {
                kind,
                kind_label,
                name,
            } => {
                bounded_binding(kind, 40)?;
                bounded_binding(kind_label, 40)?;
                bounded_binding(name, 80)?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("run_kind_label", kind_label),
                        ("run_name", name),
                        ("run_kind", kind),
                    ],
                )
            }
            Self::StewardInstructions {
                project_name,
                built_in_instructions,
                max_bytes,
            } => {
                bounded_binding(project_name, 200)?;
                bounded_document(built_in_instructions, false, PROMPT_DOCUMENT_MAX_BYTES)?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("project_name", project_name),
                        ("built_in_instructions", built_in_instructions),
                        ("max_bytes", &max_bytes.to_string()),
                    ],
                )
            }
            Self::RoutineInstructions {
                routine_id,
                routine_name,
                project_name,
                built_in_instructions,
                max_bytes,
            } => {
                bounded_binding(routine_id, 64)?;
                bounded_binding(routine_name, 200)?;
                bounded_binding(project_name, 200)?;
                bounded_document(built_in_instructions, false, PROMPT_DOCUMENT_MAX_BYTES)?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("routine_name", routine_name),
                        ("project_name", project_name),
                        ("built_in_instructions", built_in_instructions),
                        ("owner_id", routine_id),
                        ("max_bytes", &max_bytes.to_string()),
                        ("task_evidence_policy", task_evidence_policy_body()),
                    ],
                )
            }
            Self::RoutineBuilder {
                project_name,
                routine_summary,
            } => {
                bounded_binding(project_name, 200)?;
                bounded_embedded_document(
                    routine_summary,
                    false,
                    ROUTINE_BUILDER_SUMMARY_MAX_BYTES,
                )?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("project_name", project_name),
                        ("routine_summary", routine_summary),
                        ("task_evidence_policy", task_evidence_policy_body()),
                    ],
                )
            }
            Self::Playbook { project_name } => {
                bounded_binding(project_name, 200)?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("project_name", project_name),
                        ("task_evidence_policy", task_evidence_policy_body()),
                    ],
                )
            }
        }
    }
}

/// The bound for one multi-line block rendered inside an improver prompt. It is
/// generous enough for a complete built-in role prompt plus the Project's own
/// additions, and still refuses a document that could only have come from
/// somewhere other than TermLoop's own bounded state.
const PROMPT_DOCUMENT_MAX_BYTES: usize = 64 * 1024;

/// A Routine Builder receives one serialized inventory for every Routine in a
/// Project. The inventory can legitimately exceed the per-document limit when
/// a Project owns several fully configured Routines. Keep enough headroom for
/// the authored prompt inside the terminal input ceiling.
const ROUTINE_BUILDER_SUMMARY_MAX_BYTES: usize = 160 * 1024;

/// A multi-line binding. Unlike a single-line binding it keeps newlines, and it
/// may be empty when emptiness is itself the fact the asset explains — a
/// Project that has added no instructions yet. It never carries a marker, so a
/// stored value cannot forge a binding site.
fn bounded_document(
    value: &str,
    may_be_empty: bool,
    max_bytes: usize,
) -> Result<(), InvocationError> {
    if (!may_be_empty && value.trim().is_empty())
        || value.len() > max_bytes
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        || value.contains("{{")
        || value.contains("}}")
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    Ok(())
}

/// A data document inserted as one already-bound value. `bind_ordered` never
/// scans inserted values for later markers, so literal template syntax inside
/// the Routine inventory remains inert while authored template markers stay
/// strictly validated.
fn bounded_embedded_document(
    value: &str,
    may_be_empty: bool,
    max_bytes: usize,
) -> Result<(), InvocationError> {
    if (!may_be_empty && value.trim().is_empty())
        || value.len() > max_bytes
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    Ok(())
}

fn bounded_binding(value: &str, max_bytes: usize) -> Result<(), InvocationError> {
    if value.trim().is_empty()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
        || value.contains("{{")
        || value.contains("}}")
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    Ok(())
}

/// The launch constructor for Improve-with-agent. The improver is an ordinary
/// Agent: it receives the caller's permission selection and never
/// `bypassPermissions`. Every target receives Core's same closed version role.
#[allow(clippy::too_many_arguments)]
pub fn improver_agent(
    agent_id: &str,
    cwd: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    target: ImproverTarget<'_>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<LaunchPayload, InvocationError> {
    let template = target.template()?;
    let delivered = target.delivered_prompt()?;
    validate_agent_configuration(agent_id, model, permission, reasoning)?;
    resolve_launch_manifest(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        Some(&delivered),
        conversation,
        observation,
        mcp,
    )
    .map(ResolvedLaunchManifest::into_payload)
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

struct ComposedTaskKickoff {
    template: &'static PromptTemplate,
    bindings: Vec<(String, String)>,
    delivered_prompt: String,
}

fn compose_task_kickoff(
    task_id: &str,
    title: &str,
    brief: Option<&str>,
    jira_url: Option<&str>,
    kickoff_message: &str,
) -> Result<ComposedTaskKickoff, InvocationError> {
    let brief_context = brief
        .map(|brief| format!("Context: {brief}\n"))
        .unwrap_or_default();
    let jira_context = jira_url
        .map(|jira_url| format!("Jira: {jira_url}\n"))
        .unwrap_or_default();
    if task_id.trim().is_empty()
        || title.trim().is_empty()
        || kickoff_message.trim().is_empty()
        || kickoff_message.len() > 8_192
        || jira_url.is_some_and(|jira_url| jira_url.trim().is_empty() || jira_url.len() > 2_048)
        || [
            task_id,
            title,
            brief_context.as_str(),
            jira_context.as_str(),
            kickoff_message,
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
        .find(|template| template.id == "builtin.agent.task-kickoff")
        .ok_or(InvocationError::TemplateMissing)?;
    assistant::validate_template_asset(template)?;
    let message_template = template
        .authored_body
        .split_once("\n---\n")
        .map(|(_, message)| message.trim_start())
        .ok_or(InvocationError::UnprovenancedPrompt)?;
    let delivered_bindings = [
        ("kickoff_message", kickoff_message),
        ("title", title),
        ("jira_context", jira_context.as_str()),
        ("brief_context", brief_context.as_str()),
    ];
    let delivered_prompt = bind_ordered(message_template, &delivered_bindings)?;
    Ok(ComposedTaskKickoff {
        template,
        bindings: std::iter::once(("task_id".to_owned(), task_id.to_owned()))
            .chain(
                delivered_bindings
                    .into_iter()
                    .map(|(name, value)| (name.to_owned(), value.to_owned())),
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
fn compose_task_workflow(
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
