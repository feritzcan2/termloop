#![forbid(unsafe_code)]

mod assistant;
mod codex_config;
mod manifest;
mod submission;

pub use manifest::{
    InspectableArgument, InspectableContentPart, InspectableEnvironmentEntry,
    InspectableGeneratedFile, InspectableLaunchManifest, InspectableLaunchTarget,
    InspectableLimitation, InspectableProvenance, InspectableTransport,
};
pub use submission::GeneratedTerminalSubmission;

use codex_config::CodexProjectTrust;
use manifest::{
    ResolvedArgument, content_digest, content_part, finalize_digest, provider_limitations,
    redacted_generated_file, transport,
};
use std::path::Path;

pub use assistant::{
    AssistantLaunchDefaults, AssistantWakeMessage, AssistantWakeReason, ExecutorRole,
    ProvenancedPrompt, assistant_activation_message, assistant_wake_message,
    default_assistant_launch_selection, default_steward_system_prompt,
    editable_steward_system_prompt, editable_steward_system_prompt_from_effective,
    effective_steward_system_prompt, effective_worker_prompt, executor_prompt,
    resolved_steward_system_prompt, tracker_assignment_prompt,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provenance {
    pub template_ref: String,
    pub template_version: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct PromptTemplate {
    pub id: &'static str,
    pub version: u32,
    pub authored_body: &'static str,
}

const INTERACTIVE_AGENT_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.interactive",
    version: 7,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.interactive.md"),
};
const CODEX_DISABLE_STARTUP_UPDATE_CHECK: &str = "check_for_update_on_startup=false";
const QUICK_ACTION_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.quick-action.free-prompt",
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

const IMPROVER_WORKER_INSTRUCTIONS_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.worker-instructions",
    version: 7,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.improver.worker-instructions.md"
    ),
};

const IMPROVER_ROUTINE_INSTRUCTIONS_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.improver.routine-instructions",
    version: 7,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.improver.routine-instructions.md"
    ),
};

const ROUTINE_BUILDER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.builder.routine",
    version: 8,
    authored_body: include_str!("../../../resources/prompts/builtin.builder.routine.md"),
};

const PLAYBOOK_BUILDER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.builder.playbook",
    version: 15,
    authored_body: include_str!("../../../resources/prompts/builtin.builder.playbook.md"),
};

const STEWARD_EXECUTOR_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.steward.executor",
    version: 31,
    authored_body: include_str!("../../../resources/prompts/builtin.steward.executor.md"),
};

const WORKER_EXECUTOR_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.worker.executor",
    version: 19,
    authored_body: include_str!("../../../resources/prompts/builtin.worker.executor.md"),
};

const SLACK_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.slack",
    version: 6,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.slack.md"),
};

const JIRA_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.jira",
    version: 5,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.jira.md"),
};

const RUNTIME_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.runtime",
    version: 6,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.runtime.md"),
};

const DELIVERY_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.delivery",
    version: 6,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.delivery.md"),
};

const CI_PR_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.ci-pr",
    version: 6,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.ci-pr.md"),
};

const STEP_CHECK_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.step-check",
    version: 7,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.step-check.md"),
};

const CUSTOM_TRACKER_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.tracker.custom",
    version: 4,
    authored_body: include_str!("../../../resources/prompts/builtin.tracker.custom.md"),
};

const ASSISTANT_WAKE_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.assistant.wake",
    version: 9,
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

/// The catalog is the only source from which invocation provenance may be
/// resolved. F0 has one no-initial-message launch template; later prompt
/// features add bindings and delivered previews here rather than at call sites.
pub fn prompt_templates() -> &'static [PromptTemplate] {
    &[
        INTERACTIVE_AGENT_TEMPLATE,
        QUICK_ACTION_TEMPLATE,
        IMPROVER_RUN_CONFIGURATION_TEMPLATE,
        IMPROVER_RUN_CONFIGURATION_NEW_TEMPLATE,
        IMPROVER_STEWARD_INSTRUCTIONS_TEMPLATE,
        IMPROVER_SKILL_DEFINITION_TEMPLATE,
        IMPROVER_PROMPT_ASSET_TEMPLATE,
        IMPROVER_MCP_TOOL_DESCRIPTION_TEMPLATE,
        IMPROVER_WORKER_INSTRUCTIONS_TEMPLATE,
        IMPROVER_ROUTINE_INSTRUCTIONS_TEMPLATE,
        ROUTINE_BUILDER_TEMPLATE,
        PLAYBOOK_BUILDER_TEMPLATE,
        STEWARD_EXECUTOR_TEMPLATE,
        WORKER_EXECUTOR_TEMPLATE,
        SLACK_TRACKER_TEMPLATE,
        JIRA_TRACKER_TEMPLATE,
        RUNTIME_TRACKER_TEMPLATE,
        DELIVERY_TRACKER_TEMPLATE,
        CI_PR_TRACKER_TEMPLATE,
        STEP_CHECK_TRACKER_TEMPLATE,
        CUSTOM_TRACKER_TEMPLATE,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickActionImageAttachment {
    pub attachment_id: String,
    pub file_path: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
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
        manifest: resolved.inspectable,
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

fn quick_action_template() -> Result<&'static PromptTemplate, InvocationError> {
    let template = prompt_templates()
        .iter()
        .find(|template| template.id == "builtin.quick-action.free-prompt")
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
    /// One Worker's editable instructions, which apply to every Routine that
    /// Worker runs.
    WorkerInstructions {
        worker_id: &'a str,
        worker_name: &'a str,
        built_in_instructions: &'a str,
        /// One line per Routine this Worker runs, so the improver can tell a
        /// shared convention from a single check's detail.
        routine_summary: &'a str,
        max_bytes: usize,
    },
    /// One Routine's editable instructions — the surface that says where the
    /// answer to its recurring question actually comes from.
    RoutineInstructions {
        routine_id: &'a str,
        routine_name: &'a str,
        worker_name: &'a str,
        /// The built-in prompt for this Routine's kind.
        built_in_instructions: &'a str,
        max_bytes: usize,
    },
    /// A new scheduled Routine under one exact Worker. The Builder proposes
    /// both the Worker's factual observation and the Steward's independent
    /// response policy; no Routine exists until the user accepts it.
    RoutineBuilder {
        project_name: &'a str,
        worker_id: &'a str,
        worker_name: &'a str,
        routine_summary: &'a str,
    },
    /// The Project's delivery Playbook Builder. Its authenticated MCP profile
    /// reads current state and performs revision-checked complete replacements;
    /// these legacy bindings remain validated for launch compatibility.
    Playbook { project_name: &'a str },
}

impl ImproverTarget<'_> {
    pub fn template_ref(&self) -> &'static str {
        match self {
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
            Self::WorkerInstructions { .. } => "builtin.improver.worker-instructions",
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
            Self::WorkerInstructions {
                worker_id,
                worker_name,
                built_in_instructions,
                routine_summary,
                max_bytes,
            } => {
                bounded_binding(worker_id, 64)?;
                bounded_binding(worker_name, 200)?;
                bounded_document(built_in_instructions, false, PROMPT_DOCUMENT_MAX_BYTES)?;
                bounded_document(routine_summary, false, PROMPT_DOCUMENT_MAX_BYTES)?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("worker_name", worker_name),
                        ("built_in_instructions", built_in_instructions),
                        ("routine_summary", routine_summary),
                        ("max_bytes", &max_bytes.to_string()),
                        ("owner_id", worker_id),
                    ],
                )
            }
            Self::RoutineInstructions {
                routine_id,
                routine_name,
                worker_name,
                built_in_instructions,
                max_bytes,
            } => {
                bounded_binding(routine_id, 64)?;
                bounded_binding(routine_name, 200)?;
                bounded_binding(worker_name, 200)?;
                bounded_document(built_in_instructions, false, PROMPT_DOCUMENT_MAX_BYTES)?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("routine_name", routine_name),
                        ("worker_name", worker_name),
                        ("built_in_instructions", built_in_instructions),
                        ("owner_id", routine_id),
                        ("max_bytes", &max_bytes.to_string()),
                    ],
                )
            }
            Self::RoutineBuilder {
                project_name,
                worker_id,
                worker_name,
                routine_summary,
            } => {
                bounded_binding(project_name, 200)?;
                bounded_binding(worker_id, 64)?;
                bounded_binding(worker_name, 200)?;
                bounded_embedded_document(
                    routine_summary,
                    false,
                    ROUTINE_BUILDER_SUMMARY_MAX_BYTES,
                )?;
                bind_ordered(
                    template.authored_body,
                    &[
                        ("worker_name", worker_name),
                        ("project_name", project_name),
                        ("routine_summary", routine_summary),
                        ("worker_id", worker_id),
                    ],
                )
            }
            Self::Playbook { project_name } => {
                bounded_binding(project_name, 200)?;
                bind_ordered(template.authored_body, &[("project_name", project_name)])
            }
        }
    }
}

/// The bound for one multi-line block rendered inside an improver prompt. It is
/// generous enough for a complete built-in role prompt plus the Project's own
/// additions, and still refuses a document that could only have come from
/// somewhere other than TermLoop's own bounded state.
const PROMPT_DOCUMENT_MAX_BYTES: usize = 64 * 1024;

/// A Routine Builder receives one serialized inventory for every Routine on a
/// Worker. The inventory can legitimately exceed the per-document limit when
/// a Worker owns several fully configured Routines. Keep enough headroom for
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

pub fn validate_quick_action(
    agent_id: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
) -> Result<(), InvocationError> {
    if prompt.is_empty()
        || prompt.chars().count() > 32_768
        || prompt
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(InvocationError::InvalidPrompt);
    }
    validate_agent_configuration(agent_id, model, permission, reasoning)
}

pub fn validate_quick_action_with_attachments(
    agent_id: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
    attachments: &[QuickActionImageAttachment],
) -> Result<(), InvocationError> {
    validate_quick_action(agent_id, model, permission, reasoning, prompt)?;
    validate_image_attachments(attachments)
}

pub fn validate_image_attachments(
    attachments: &[QuickActionImageAttachment],
) -> Result<(), InvocationError> {
    if attachments.len() > 1 {
        return Err(InvocationError::InvalidImageAttachment);
    }
    for attachment in attachments {
        let path = Path::new(&attachment.file_path);
        let id = attachment.attachment_id.as_bytes();
        let valid_id = id.len() == 36
            && [8, 13, 18, 23].into_iter().all(|index| id[index] == b'-')
            && id[14] == b'4'
            && matches!(id[19], b'8' | b'9' | b'a' | b'b')
            && id.iter().enumerate().all(|(index, byte)| {
                [8, 13, 18, 23].contains(&index)
                    || (byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            });
        let valid_digest = attachment.sha256.len() == 71
            && attachment.sha256.starts_with("sha256:")
            && attachment.sha256[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
        if !valid_id
            || attachment.media_type != "image/png"
            || attachment.byte_length == 0
            || attachment.byte_length > 10 * 1024 * 1024
            || attachment.width == 0
            || attachment.width > 16_384
            || attachment.height == 0
            || attachment.height > 16_384
            || !valid_digest
            || !path.is_absolute()
            || path.file_name().and_then(|name| name.to_str()) != Some("image.png")
            || path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some(attachment.attachment_id.as_str())
            || path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                != Some("termloop-quick-action-images")
        {
            return Err(InvocationError::InvalidImageAttachment);
        }
    }
    Ok(())
}

/// Encodes one user-initiated image paste as a provider-neutral remote file
/// reference without a submit key. The path is serialized as a JSON string so
/// spaces, quotes, and platform separators remain unambiguous to every Agent
/// composer while the user continues typing the accompanying instruction.
pub fn image_attachment_terminal_paste(
    attachment: &QuickActionImageAttachment,
) -> Result<Vec<u8>, InvocationError> {
    validate_image_attachments(std::slice::from_ref(attachment))?;
    let mut reference = serde_json::to_string(&attachment.file_path)
        .map_err(|_| InvocationError::InvalidImageAttachment)?;
    reference.push(' ');
    Ok(termloop_platform::terminal_paste_input(
        reference.as_bytes(),
    ))
}

pub fn validate_agent_configuration(
    agent_id: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
) -> Result<(), InvocationError> {
    model_args(agent_id, model)?;
    permission_args(agent_id, permission)?;
    reasoning_args(agent_id, reasoning).map(|_| ())
}

fn model_args(agent_id: &str, model: &str) -> Result<Vec<String>, InvocationError> {
    match (agent_id, model) {
        ("claude" | "codex" | "gemini", "default") => Ok(vec![]),
        ("claude", "opus[1m]" | "fable" | "sonnet" | "haiku" | "opus")
        | ("codex", "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.5-pro") => {
            Ok(vec!["--model".into(), model.into()])
        }
        ("gemini", "auto" | "pro" | "flash" | "flash-lite") => Ok(vec!["-m".into(), model.into()]),
        ("claude" | "codex" | "gemini", _) => Err(InvocationError::UnsupportedModel {
            agent_id: agent_id.to_owned(),
            model: model.to_owned(),
        }),
        _ => Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    }
}

fn reasoning_args(agent_id: &str, reasoning: &str) -> Result<Vec<String>, InvocationError> {
    match (agent_id, reasoning) {
        ("claude" | "codex" | "gemini", "default") => Ok(vec![]),
        ("claude", "low" | "medium" | "high" | "xhigh" | "max") => {
            Ok(vec!["--effort".into(), reasoning.into()])
        }
        ("codex", "low" | "medium" | "high" | "xhigh" | "max") => Ok(vec![
            "-c".into(),
            format!("model_reasoning_effort=\"{reasoning}\""),
        ]),
        ("claude" | "codex" | "gemini", _) => Err(InvocationError::UnsupportedReasoning {
            agent_id: agent_id.to_owned(),
            reasoning: reasoning.to_owned(),
        }),
        _ => Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    }
}

/// TermLoop's own default permission mode for an unconfigured launch. Claude's
/// provider `default` mode asks before every edit, so a Session that nobody
/// configured used to open in manual permission mode and lost an in-session
/// switch on every resume. TermLoop launches Claude in auto (accept-edits)
/// mode instead, visibly and identically on fresh launch and resume.
pub fn default_permission(agent_id: &str) -> &'static str {
    match agent_id {
        "claude" => "acceptEdits",
        _ => "default",
    }
}

fn permission_args(agent_id: &str, permission: &str) -> Result<Vec<String>, InvocationError> {
    let args = match (agent_id, permission) {
        ("claude", "default") => vec!["--permission-mode".into(), "default".into()],
        // Claude renamed accept-edits to `auto`. Passing the legacy name still
        // launches, but the TUI then labels the Session "accept edits" while
        // TermLoop calls it auto, and an unchanged mode reads as a mode the
        // user never picked. The stored selection keeps its contract value.
        ("claude", "acceptEdits") => vec!["--permission-mode".into(), "auto".into()],
        ("claude", "plan") => vec!["--permission-mode".into(), permission.into()],
        ("claude", "bypassPermissions") => vec!["--dangerously-skip-permissions".into()],
        ("codex", "default") => vec![],
        ("codex", "acceptEdits") => {
            vec![
                "--sandbox".into(),
                "workspace-write".into(),
                "--approve-for-me".into(),
            ]
        }
        ("codex", "plan") => vec![
            "--sandbox".into(),
            "read-only".into(),
            "--ask-for-approval".into(),
            "on-request".into(),
        ],
        ("codex", "bypassPermissions") => {
            vec!["--dangerously-bypass-approvals-and-sandbox".into()]
        }
        ("gemini", "default") => vec![],
        ("gemini", "acceptEdits") => {
            vec!["--approval-mode".into(), "auto_edit".into()]
        }
        ("gemini", "plan") => vec!["--approval-mode".into(), "plan".into()],
        ("gemini", "bypassPermissions") => {
            vec!["--approval-mode".into(), "yolo".into()]
        }
        ("claude" | "codex" | "gemini", _) => {
            return Err(InvocationError::UnsupportedPermission {
                agent_id: agent_id.to_owned(),
                permission: permission.to_owned(),
            });
        }
        _ => return Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    };
    Ok(args)
}

#[allow(clippy::too_many_arguments)]
fn resolve_launch_manifest(
    agent_id: &str,
    cwd: &str,
    template: &PromptTemplate,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<ResolvedLaunchManifest, InvocationError> {
    resolve_launch_manifest_with_codex_project_trust(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        prompt,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_launch_manifest_for_managed_worktree(
    agent_id: &str,
    cwd: &str,
    template: &PromptTemplate,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<ResolvedLaunchManifest, InvocationError> {
    resolve_launch_manifest_with_codex_project_trust(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        prompt,
        conversation,
        observation,
        mcp,
        CodexProjectTrust::TermLoopManagedWorktree,
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_launch_manifest_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    template: &PromptTemplate,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<ResolvedLaunchManifest, InvocationError> {
    resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        prompt,
        conversation,
        observation,
        mcp,
        None,
        None,
        &[],
        codex_project_trust,
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_launch_manifest_with_provider_instructions(
    agent_id: &str,
    cwd: &str,
    template: &PromptTemplate,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: &str,
    provider_instructions_source: &PromptTemplate,
    provider_instructions: &str,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
) -> Result<ResolvedLaunchManifest, InvocationError> {
    if provider_instructions.trim().is_empty() || provider_instructions.len() > 64 * 1024 {
        return Err(InvocationError::InvalidDeveloperInstructions);
    }
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
        Some(mcp),
        Some(provider_instructions_source),
        Some(provider_instructions),
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_launch_manifest_with_attachments(
    agent_id: &str,
    cwd: &str,
    template: &PromptTemplate,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    provider_instructions_source: Option<&PromptTemplate>,
    provider_instructions: Option<&str>,
    attachments: &[QuickActionImageAttachment],
) -> Result<ResolvedLaunchManifest, InvocationError> {
    resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        template,
        model,
        permission,
        reasoning,
        prompt,
        conversation,
        observation,
        mcp,
        provider_instructions_source,
        provider_instructions,
        attachments,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_launch_manifest_with_attachments_and_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    template: &PromptTemplate,
    model: &str,
    permission: &str,
    reasoning: &str,
    prompt: Option<&str>,
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    provider_instructions_source: Option<&PromptTemplate>,
    provider_instructions: Option<&str>,
    attachments: &[QuickActionImageAttachment],
    codex_project_trust: CodexProjectTrust,
) -> Result<ResolvedLaunchManifest, InvocationError> {
    if template.id.trim().is_empty() {
        return Err(InvocationError::UnprovenancedPrompt);
    }
    if termloop_agents::executable_for(agent_id).is_none() {
        return Err(InvocationError::UnsupportedAgent(agent_id.to_owned()));
    }
    if observation.as_ref().is_some_and(|observation| {
        !observation_transport_matches_agent(agent_id, observation.transport)
    }) {
        return Err(InvocationError::InvalidObservationTransport);
    }
    let conversation_kind = match conversation {
        AgentConversationLaunch::Fresh { .. } | AgentConversationLaunch::Fork { .. } => "fresh",
        AgentConversationLaunch::Resume { .. } => "resume",
    };
    let interactive_provider_instructions = mcp
        .as_ref()
        .is_some_and(|mcp| mcp.profile.includes_interactive_instructions())
        .then_some(INTERACTIVE_AGENT_TEMPLATE.authored_body);
    let delivered_provider_instructions =
        provider_instructions.or(interactive_provider_instructions);
    let mut arguments = conversation_manifest_args(agent_id, conversation)?;
    if agent_id == "codex" {
        // Codex resume/fork can restore the conversation's recorded working
        // root instead of using only the child process cwd. Keep the provider's
        // effective root identical to the invocation-owned manifest target so
        // relocation cannot reopen the previous Task worktree.
        arguments.extend([
            ResolvedArgument::exact("-C", "working directory"),
            ResolvedArgument::exact(cwd, "working directory"),
        ]);
        if let Some(project_trust_override) =
            codex_config::project_trust_override(cwd, codex_project_trust)
                .map_err(|_| InvocationError::InvalidPromptBinding)?
        {
            arguments.extend([
                ResolvedArgument::exact("-c", "TermLoop-managed worktree trust"),
                ResolvedArgument::exact(project_trust_override, "TermLoop-managed worktree trust"),
            ]);
        }
    }
    if template.id == "builtin.quick-action.free-prompt"
        || model != "default"
        || permission != "default"
        || reasoning != "default"
    {
        arguments.extend(
            model_args(agent_id, model)?
                .into_iter()
                .map(|argument| ResolvedArgument::exact(argument, "model selection")),
        );
        arguments.extend(
            reasoning_args(agent_id, reasoning)?
                .into_iter()
                .map(|argument| ResolvedArgument::exact(argument, "reasoning selection")),
        );
        arguments.extend(
            permission_args(agent_id, permission)?
                .into_iter()
                .map(|argument| ResolvedArgument::exact(argument, "permission selection")),
        );
    }
    if let Some(observation) = observation.as_ref() {
        arguments.extend(observation_manifest_args(agent_id, observation));
    }
    if let Some(mcp) = mcp.as_ref() {
        arguments.extend(mcp_manifest_args(agent_id, mcp)?);
    }
    if let Some(instructions) = provider_instructions {
        match agent_id {
            "codex" => {
                let instructions = serde_json::to_string(instructions)
                    .map_err(|_| InvocationError::InvalidDeveloperInstructions)?;
                arguments.extend([
                    ResolvedArgument::exact("-c", "persistent assistant instructions"),
                    ResolvedArgument::exact(
                        format!("developer_instructions={instructions}"),
                        "persistent assistant instructions",
                    ),
                ]);
            }
            "claude" => arguments.extend([
                ResolvedArgument::exact(
                    "--append-system-prompt",
                    "persistent assistant instructions",
                ),
                ResolvedArgument::exact(instructions, "persistent assistant instructions"),
            ]),
            _ => return Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
        }
    }
    if agent_id == "codex" {
        for attachment in attachments {
            arguments.push(ResolvedArgument::exact(
                "--image",
                "Quick Action image attachment",
            ));
            arguments.push(ResolvedArgument::sensitive_path(
                attachment.file_path.clone(),
                "Quick Action image attachment path",
            ));
        }
    } else if agent_id == "claude" {
        for attachment in attachments {
            let directory = Path::new(&attachment.file_path)
                .parent()
                .expect("validated Quick Action attachment parent");
            arguments.push(ResolvedArgument::exact(
                "--add-dir",
                "Quick Action image attachment access",
            ));
            arguments.push(ResolvedArgument::sensitive_path(
                directory.to_string_lossy(),
                "Quick Action image attachment directory",
            ));
        }
    }
    if agent_id == "codex" {
        // A Codex update notice is an interactive startup modal that appears
        // before the TUI connects to its App Server. TermLoop-controlled
        // launches cannot answer that provider-owned prompt during automatic
        // resume, so keep update discovery out of every invocation manifest.
        arguments.extend([
            ResolvedArgument::exact("-c", "non-interactive provider startup"),
            ResolvedArgument::exact(
                CODEX_DISABLE_STARTUP_UPDATE_CHECK,
                "non-interactive provider startup",
            ),
        ]);
    }

    let cargo_shard_key = observation
        .as_ref()
        .map(|observation| observation.session_id);
    let mut environment = agent_launch_environment(cwd, cargo_shard_key);
    if observation.as_ref().is_some_and(|observation| {
        observation_environment_conflicts(agent_id, observation.transport, &environment)
    }) {
        return Err(InvocationError::ObservationConfigurationConflict);
    }
    if let Some(observation) = observation.as_ref() {
        match observation.transport {
            AgentObservationLaunchTransport::InlineSettings { .. }
            | AgentObservationLaunchTransport::EnvironmentSettingsPath { .. } => {
                environment = environment
                    .with_explicit("TERMLOOP_SESSION_ID", observation.session_id)
                    .with_explicit("TERMLOOP_AGENT_ID", agent_id)
                    .with_explicit("TERMLOOP_HOOK_ENDPOINT", observation.endpoint)
                    .with_explicit("TERMLOOP_HOOK_TOKEN", observation.token);
            }
            AgentObservationLaunchTransport::DaemonOwnedBridge { .. } => {}
        }
        if let AgentObservationLaunchTransport::EnvironmentSettingsPath { variable, path, .. } =
            observation.transport
        {
            environment = environment.with_explicit(variable, path);
        }
    }
    if let Some(mcp) = mcp {
        environment = environment.with_explicit("TERMLOOP_MCP_TOKEN", mcp.token);
    }

    // One resolution against the exact launch environment feeds both
    // projections of this manifest: the inspector's visible target and the
    // private spawn tuple composed in `into_payload`. Capability discovery in
    // `agents` shares the same `resolve_agent_cli` seam, so the probed CLI and
    // the launched CLI can never disagree.
    let target = termloop_agents::resolve_agent_cli(agent_id, &environment)
        .map_err(|error| agent_cli_error(agent_id, error))?;
    let executable = launch_target_utf8(agent_id, &target)?;

    let delivered =
        compose_quick_action_delivery(agent_id, prompt.unwrap_or_default(), attachments);
    let provenance_delivery = if prompt.is_some() {
        delivered.as_str()
    } else {
        delivered_provider_instructions.unwrap_or(delivered.as_str())
    };
    let terminal_delivery = prompt.map(|_| format!("{delivered}\r")).unwrap_or_default();
    let mut content_parts = prompt
        .map(|_| {
            vec![content_part(
                "first-message",
                "firstMessage",
                format!("resources/prompts/{}", template.id),
                "terminalInput",
                &delivered,
            )]
        })
        .unwrap_or_default();
    if let Some(instructions) = delivered_provider_instructions {
        content_parts.push(content_part(
            if provider_instructions.is_some() {
                "persistent-assistant-instructions"
            } else {
                "interactive-session-protocol"
            },
            if provider_instructions.is_some() {
                "providerInstructions"
            } else {
                "developerInstructions"
            },
            {
                let source = provider_instructions_source.unwrap_or(&INTERACTIVE_AGENT_TEMPLATE);
                format!("resources/prompts/{}@{}", source.id, source.version)
            },
            match agent_id {
                "codex" => "codexDeveloperInstructions",
                "claude" => "claudeAppendedSystemPrompt",
                _ => unreachable!("agent id was validated"),
            },
            instructions,
        ));
    }
    content_parts.extend(attachments.iter().enumerate().map(|(index, attachment)| {
        InspectableContentPart {
            id: format!("image-attachment-{}", index + 1),
            kind: "imageAttachment",
            source: format!("quickAction.attachment:{}", attachment.attachment_id),
            scope: "launch",
            delivery: if agent_id == "codex" {
                "providerImageArgument"
            } else {
                "terminalPathReference"
            },
            content: format!(
                "{} · {}×{} · {} bytes",
                attachment.media_type, attachment.width, attachment.height, attachment.byte_length
            ),
            byte_length: attachment.byte_length as usize,
            digest: attachment.sha256.clone(),
        }
    }));
    let inspectable_arguments = arguments
        .iter()
        .enumerate()
        .map(|(position, argument)| argument.inspect(position))
        .collect();
    let mut inspectable = InspectableLaunchManifest {
        digest: String::new(),
        target: InspectableLaunchTarget {
            agent_id: agent_id.to_owned(),
            executable,
            model: model.to_owned(),
            permission: permission.to_owned(),
            reasoning: reasoning.to_owned(),
            cwd: cwd.to_owned(),
            conversation: conversation_kind,
        },
        provenance: InspectableProvenance {
            template_ref: template.id.to_owned(),
            template_version: template.version,
            authored_digest: content_digest(template.authored_body),
            delivered_digest: content_digest(provenance_delivery),
        },
        content_parts,
        transport: if prompt.is_some() {
            transport("terminalInput", &terminal_delivery)
        } else if let Some(instructions) = delivered_provider_instructions {
            transport(
                if agent_id == "codex" {
                    "codexDeveloperInstructions"
                } else {
                    "claudeAppendedSystemPrompt"
                },
                instructions,
            )
        } else {
            transport("none", "")
        },
        arguments: inspectable_arguments,
        environment: inspect_environment(&environment),
        generated_files: observation
            .as_ref()
            .and_then(|observation| match observation.transport {
                AgentObservationLaunchTransport::InlineSettings {
                    content,
                    inspectable_content,
                } => Some(vec![redacted_generated_file(
                    "launch-scoped observation settings",
                    "inline settings argument",
                    "inline; no filesystem artifact",
                    inspectable_content,
                    content,
                )]),
                AgentObservationLaunchTransport::EnvironmentSettingsPath {
                    content,
                    inspectable_content,
                    ..
                } => Some(vec![redacted_generated_file(
                    "launch-scoped observation settings",
                    "<redacted runtime settings path>",
                    "private runtime settings overlay",
                    inspectable_content,
                    content,
                )]),
                AgentObservationLaunchTransport::DaemonOwnedBridge { .. } => None,
            })
            .unwrap_or_default(),
        limitations: provider_limitations(agent_id),
    };
    finalize_digest(&mut inspectable);
    Ok(ResolvedLaunchManifest {
        target,
        arguments,
        environment,
        provenance: Provenance {
            template_ref: template.id.to_owned(),
            template_version: template.version,
        },
        initial_input: prompt
            .map(|_| InitialInputDelivery::submitted(&delivered))
            .transpose()?,
        inspectable,
        bindings: vec![],
        delivered_prompt: prompt.map(|_| delivered),
    })
}

fn compose_quick_action_delivery(
    agent_id: &str,
    prompt: &str,
    attachments: &[QuickActionImageAttachment],
) -> String {
    if agent_id != "claude" || attachments.is_empty() {
        return prompt.to_owned();
    }
    let mut delivered = String::with_capacity(
        prompt.len()
            + attachments
                .iter()
                .map(|attachment| attachment.file_path.len() + 4)
                .sum::<usize>()
            + 52,
    );
    delivered.push_str(prompt);
    delivered.push_str(
        "\n\nTermLoop Quick Action image attachment: inspect `image.png` in the additional directory supplied for this launch.",
    );
    delivered
}

fn conversation_manifest_args(
    agent_id: &str,
    launch: AgentConversationLaunch<'_>,
) -> Result<Vec<ResolvedArgument>, InvocationError> {
    let raw = conversation_args(agent_id, launch)?;
    Ok(raw
        .into_iter()
        .enumerate()
        .map(|(position, value)| {
            if position > 0 {
                ResolvedArgument::private(value, "provider conversation identity")
            } else {
                ResolvedArgument::exact(value, "conversation mode")
            }
        })
        .collect())
}

fn observation_manifest_args(
    agent_id: &str,
    observation: &AgentObservationLaunch<'_>,
) -> Vec<ResolvedArgument> {
    observation_args(agent_id, observation)
        .into_iter()
        .enumerate()
        .map(|(position, value)| {
            if position % 2 == 0 {
                ResolvedArgument::exact(value, "agent observation transport")
            } else {
                ResolvedArgument::runtime_authority(value, "agent observation transport")
            }
        })
        .collect()
}

fn mcp_manifest_args(
    agent_id: &str,
    mcp: &AgentMcpLaunch<'_>,
) -> Result<Vec<ResolvedArgument>, InvocationError> {
    Ok(mcp_args(agent_id, mcp)?
        .into_iter()
        .enumerate()
        .map(|(position, value)| {
            if agent_id == "claude" && position == 1 {
                ResolvedArgument::runtime_authority(value, "launch-local MCP configuration")
            } else {
                ResolvedArgument::exact(value, "launch-local MCP configuration")
            }
        })
        .collect())
}

fn inspect_environment(
    environment: &termloop_platform::LaunchEnvironment,
) -> Vec<InspectableEnvironmentEntry> {
    let mut entries = environment
        .entries()
        .map(|(key, _value)| {
            let key = key.to_string_lossy().into_owned();
            match key.as_str() {
                "CARGO_TARGET_DIR" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted agent build path>".into(),
                    visibility: "redacted",
                    classification: "sensitivePath",
                    source: "invocation",
                    purpose: "Agent-shared Cargo build output",
                },
                "TERMLOOP_SESSION_ID" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted runtime correlation>".into(),
                    visibility: "redacted",
                    classification: "runtimeCorrelation",
                    source: "invocation",
                    purpose: "agent observation correlation",
                },
                "TERMLOOP_AGENT_ID" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted runtime correlation>".into(),
                    visibility: "redacted",
                    classification: "runtimeCorrelation",
                    source: "invocation",
                    purpose: "agent observation provider identity",
                },
                "TERMLOOP_HOOK_ENDPOINT" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted runtime authority>".into(),
                    visibility: "redacted",
                    classification: "runtimeAuthority",
                    source: "invocation",
                    purpose: "agent observation endpoint",
                },
                "TERMLOOP_HOOK_TOKEN" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted secret>".into(),
                    visibility: "redacted",
                    classification: "secret",
                    source: "invocation",
                    purpose: "agent observation capability",
                },
                "GEMINI_CLI_SYSTEM_DEFAULTS_PATH" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted runtime settings path>".into(),
                    visibility: "redacted",
                    classification: "sensitivePath",
                    source: "invocation",
                    purpose: "launch-scoped Gemini observation settings",
                },
                "TERMLOOP_MCP_TOKEN" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted secret>".into(),
                    visibility: "redacted",
                    classification: "secret",
                    source: "invocation",
                    purpose: "Ask-To MCP capability",
                },
                _ => {
                    let (classification, purpose) = baseline_environment_classification(&key);
                    InspectableEnvironmentEntry {
                        key,
                        display_value: "<redacted platform value>".into(),
                        visibility: "redacted",
                        classification,
                        source: "platformBaseline",
                        purpose,
                    }
                }
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.key.cmp(&right.key));
    entries
}

fn baseline_environment_classification(key: &str) -> (&'static str, &'static str) {
    let upper = key.to_ascii_uppercase();
    if matches!(upper.as_str(), "SSH_AUTH_SOCK" | "SSH_AGENT_PID") {
        ("credentialAuthority", "SSH agent capability")
    } else if matches!(
        upper.as_str(),
        "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY" | "ALL_PROXY"
    ) {
        ("proxyAuthority", "network proxy configuration")
    } else if matches!(
        upper.as_str(),
        "DBUS_SESSION_BUS_ADDRESS" | "DISPLAY" | "WAYLAND_DISPLAY"
    ) {
        ("runtimeAuthority", "desktop session capability")
    } else if matches!(
        upper.as_str(),
        "HOME"
            | "USERPROFILE"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "TMPDIR"
            | "TEMP"
            | "TMP"
            | "XDG_RUNTIME_DIR"
            | "XDG_CONFIG_HOME"
            | "XDG_DATA_HOME"
            | "SSL_CERT_FILE"
            | "SSL_CERT_DIR"
            | "NODE_EXTRA_CA_CERTS"
            | "REQUESTS_CA_BUNDLE"
    ) {
        ("sensitivePath", "approved child-process filesystem context")
    } else {
        ("platformValue", "approved child-process bootstrap")
    }
}

#[derive(Clone)]
pub struct AskToTerminalPrompt {
    provenance: Provenance,
    bindings: Vec<(String, String)>,
    delivered_prompt: String,
    terminal_input_sequence: Vec<Vec<u8>>,
}

impl std::fmt::Debug for AskToTerminalPrompt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AskToTerminalPrompt")
            .field("provenance", &self.provenance)
            .field(
                "binding_names",
                &self
                    .bindings
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .field("delivered_byte_count", &self.delivered_prompt.len())
            .finish()
    }
}

impl AskToTerminalPrompt {
    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    pub fn bindings(&self) -> impl Iterator<Item = (&str, &str)> {
        self.bindings
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    pub fn delivered_prompt(&self) -> &str {
        &self.delivered_prompt
    }

    pub fn terminal_input_sequence(&self) -> &[Vec<u8>] {
        &self.terminal_input_sequence
    }

    pub fn terminal_submission(&self) -> GeneratedTerminalSubmission {
        GeneratedTerminalSubmission::from_sequence(
            self.provenance.clone(),
            &self.terminal_input_sequence,
        )
    }
}

#[derive(Clone)]
pub struct LaunchPayload {
    program: String,
    args: Vec<String>,
    environment: termloop_platform::LaunchEnvironment,
    provenance: Provenance,
    initial_input: Option<InitialInputDelivery>,
    inspectable: InspectableLaunchManifest,
    bindings: Vec<(String, String)>,
    delivered_prompt: Option<String>,
}

struct ResolvedLaunchManifest {
    target: termloop_platform::ResolvedLaunchTarget,
    arguments: Vec<ResolvedArgument>,
    environment: termloop_platform::LaunchEnvironment,
    provenance: Provenance,
    initial_input: Option<InitialInputDelivery>,
    inspectable: InspectableLaunchManifest,
    bindings: Vec<(String, String)>,
    delivered_prompt: Option<String>,
}

#[derive(Clone)]
struct InitialInputDelivery {
    delivered: String,
    sequence: Vec<Vec<u8>>,
}

impl InitialInputDelivery {
    fn submitted(content: &str) -> Result<Self, InvocationError> {
        Ok(Self {
            delivered: format!("{content}\r"),
            // Mark generated content as one terminal paste where the host PTY
            // preserves that framing. Raw rapid characters can otherwise be
            // reclassified by agent TUIs after they have already queued Enter.
            // Every host keeps Enter as a separate, delayed sequence chunk.
            // ConPTY cannot reliably pass injected bracket markers through a
            // cooked input consumer, so platform selects unframed content on
            // Windows while retaining the delayed Enter boundary.
            sequence: termloop_platform::generated_terminal_paste_submission_sequence(
                content.as_bytes(),
            )
            .map_err(|_| InvocationError::InvalidPromptBinding)?,
        })
    }
}

impl ResolvedLaunchManifest {
    fn into_payload(self) -> LaunchPayload {
        // `ResolvedLaunchTarget::command_line` is the single spawn-composition
        // point; the manifest never assembles a `.cmd` wrapper itself. UTF-8
        // safety of the resolved pieces was proven during manifest resolution
        // and every appended argument value originates from a `String`.
        let (program, args) = self
            .target
            .command_line(self.arguments.into_iter().map(|argument| argument.value));
        LaunchPayload {
            program: program.to_string_lossy().into_owned(),
            args: args
                .into_iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect(),
            environment: self.environment,
            provenance: self.provenance,
            initial_input: self.initial_input,
            inspectable: self.inspectable,
            bindings: self.bindings,
            delivered_prompt: self.delivered_prompt,
        }
    }
}

impl std::fmt::Debug for LaunchPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LaunchPayload")
            .field("program", &self.program)
            .field("private_arg_count", &self.args.len())
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("provenance", &self.provenance)
            .finish()
    }
}

#[derive(Clone, Copy)]
pub struct AgentObservationLaunch<'a> {
    pub session_id: &'a str,
    pub endpoint: &'a str,
    pub token: &'a str,
    pub transport: AgentObservationLaunchTransport<'a>,
}

#[derive(Clone, Copy)]
pub enum AgentObservationLaunchTransport<'a> {
    InlineSettings {
        content: &'a str,
        inspectable_content: &'a str,
    },
    EnvironmentSettingsPath {
        variable: &'a str,
        path: &'a str,
        content: &'a str,
        inspectable_content: &'a str,
    },
    DaemonOwnedBridge {
        endpoint: &'a str,
    },
}

#[derive(Clone, Copy)]
pub struct AgentMcpLaunch<'a> {
    pub endpoint: &'a str,
    pub token: &'a str,
    pub claude_config_path: &'a str,
    pub profile: AgentMcpProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMcpProfile {
    Interactive,
    Improver,
    Steward,
    Worker,
    Helper,
}

impl AgentMcpProfile {
    fn includes_interactive_instructions(self) -> bool {
        matches!(self, Self::Interactive | Self::Improver)
    }
}

pub struct PersistentAssistantLaunch<'a> {
    pub agent_id: &'a str,
    pub model: &'a str,
    pub permission: &'a str,
    pub reasoning: &'a str,
    pub role: ExecutorRole,
    pub system_prompt: Option<&'a str>,
    pub worker_prompt: Option<&'a str>,
    pub cwd: &'a str,
    pub conversation: AgentConversationLaunch<'a>,
    pub observation: Option<AgentObservationLaunch<'a>>,
    pub mcp: AgentMcpLaunch<'a>,
}

#[derive(Clone)]
pub struct CodexAppServerLaunch {
    program: String,
    args: Vec<String>,
    environment: termloop_platform::LaunchEnvironment,
}

impl std::fmt::Debug for CodexAppServerLaunch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexAppServerLaunch")
            .field("program", &self.program)
            .field("private_arg_count", &self.args.len())
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl CodexAppServerLaunch {
    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }

    pub fn environment(&self) -> &termloop_platform::LaunchEnvironment {
        &self.environment
    }
}

pub fn codex_app_server(
    listen_endpoint: &str,
    cwd: &str,
    session_id: &str,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<CodexAppServerLaunch, InvocationError> {
    codex_app_server_with_project_trust(
        listen_endpoint,
        cwd,
        session_id,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

pub fn codex_app_server_for_managed_worktree(
    listen_endpoint: &str,
    cwd: &str,
    session_id: &str,
    mcp: Option<AgentMcpLaunch<'_>>,
) -> Result<CodexAppServerLaunch, InvocationError> {
    codex_app_server_with_project_trust(
        listen_endpoint,
        cwd,
        session_id,
        mcp,
        CodexProjectTrust::TermLoopManagedWorktree,
    )
}

fn codex_app_server_with_project_trust(
    listen_endpoint: &str,
    cwd: &str,
    session_id: &str,
    mcp: Option<AgentMcpLaunch<'_>>,
    codex_project_trust: CodexProjectTrust,
) -> Result<CodexAppServerLaunch, InvocationError> {
    let mut args = vec![
        "app-server".to_owned(),
        "--listen".to_owned(),
        listen_endpoint.to_owned(),
    ];
    if let Some(project_trust_override) =
        codex_config::project_trust_override(cwd, codex_project_trust)
            .map_err(|_| InvocationError::InvalidPromptBinding)?
    {
        args.extend(["-c".to_owned(), project_trust_override]);
    }
    // The App Server owns the Codex process that executes shell commands, so it
    // must inherit the same Agent-only Cargo target as the terminal client.
    let mut environment = agent_launch_environment(cwd, Some(session_id));
    if let Some(mcp) = mcp {
        args.extend(mcp_args("codex", &mcp)?);
        environment = environment.with_explicit("TERMLOOP_MCP_TOKEN", mcp.token);
    }
    args.extend([
        "-c".to_owned(),
        CODEX_DISABLE_STARTUP_UPDATE_CHECK.to_owned(),
    ]);
    // The daemon-owned App Server process uses the same resolution and spawn
    // composition seam as the PTY launch of the codex TUI.
    let target = termloop_agents::resolve_agent_cli("codex", &environment)
        .map_err(|error| agent_cli_error("codex", error))?;
    launch_target_utf8("codex", &target)?;
    let (program, args) = target.command_line(args);
    Ok(CodexAppServerLaunch {
        program: program.to_string_lossy().into_owned(),
        args: args
            .into_iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect(),
        environment,
    })
}

const AGENT_CARGO_TARGET_SHARD_COUNT: u64 = 2;

fn agent_cargo_target_shard(shard_key: Option<&str>) -> u64 {
    // FNV-1a is stable across processes and platforms. This is only a balanced
    // cache partition, not an identity or security primitive.
    let Some(shard_key) = shard_key else {
        return 0;
    };
    let hash = shard_key
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    hash % AGENT_CARGO_TARGET_SHARD_COUNT
}

fn agent_launch_environment(
    cwd: &str,
    shard_key: Option<&str>,
) -> termloop_platform::LaunchEnvironment {
    // Two shards let independent Agents compile concurrently without paying for
    // one cold target directory per Session. Both remain isolated from the
    // developer and dev-launcher build directories.
    let shard = agent_cargo_target_shard(shard_key).to_string();
    let agent_target_dir = Path::new(cwd).join("target").join("agents").join(shard);
    termloop_platform::LaunchEnvironment::os_baseline()
        .with_explicit("CARGO_TARGET_DIR", agent_target_dir)
}

fn agent_cli_error(
    agent_id: &str,
    error: termloop_agents::AgentCliResolutionError,
) -> InvocationError {
    match error {
        termloop_agents::AgentCliResolutionError::UnsupportedAgent => {
            InvocationError::UnsupportedAgent(agent_id.to_owned())
        }
        termloop_agents::AgentCliResolutionError::NotFound => {
            InvocationError::AgentCliNotFound(agent_id.to_owned())
        }
        termloop_agents::AgentCliResolutionError::Unusable => {
            InvocationError::AgentCliUnusable(agent_id.to_owned())
        }
    }
}

/// Returns the visible inspector value for the resolved CLI file and proves
/// the complete spawn composition survives `String` conversion losslessly, so
/// later `to_string_lossy` conversions of the same tuple are exact.
fn launch_target_utf8(
    agent_id: &str,
    target: &termloop_platform::ResolvedLaunchTarget,
) -> Result<String, InvocationError> {
    let (program, prefix) = target.command_line(std::iter::empty::<std::ffi::OsString>());
    if program.to_str().is_none() || prefix.iter().any(|part| part.to_str().is_none()) {
        return Err(InvocationError::AgentCliUnusable(agent_id.to_owned()));
    }
    target
        .target_path()
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| InvocationError::AgentCliUnusable(agent_id.to_owned()))
}

#[derive(Clone, Copy)]
pub enum AgentConversationLaunch<'a> {
    Fresh {
        resume_ref: Option<&'a termloop_domain::ResumeRef>,
    },
    Resume {
        resume_ref: &'a termloop_domain::ResumeRef,
    },
    Fork {
        source_ref: &'a termloop_domain::ResumeRef,
    },
}

impl LaunchPayload {
    pub fn program(&self) -> &str {
        &self.program
    }
    pub fn args(&self) -> &[String] {
        &self.args
    }
    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }
    pub fn environment(&self) -> &termloop_platform::LaunchEnvironment {
        &self.environment
    }
    pub fn environment_keys(&self) -> impl Iterator<Item = &std::ffi::OsStr> {
        self.environment.keys()
    }
    pub fn initial_input(&self) -> Option<&str> {
        self.initial_input
            .as_ref()
            .map(|input| input.delivered.as_str())
    }
    pub fn initial_input_sequence(&self) -> Option<&[Vec<u8>]> {
        self.initial_input
            .as_ref()
            .map(|input| input.sequence.as_slice())
    }
    pub fn initial_input_submission(&self) -> Option<GeneratedTerminalSubmission> {
        self.initial_input.as_ref().map(|input| {
            GeneratedTerminalSubmission::from_sequence(self.provenance.clone(), &input.sequence)
        })
    }
    pub fn inspectable_manifest(&self) -> &InspectableLaunchManifest {
        &self.inspectable
    }

    /// Binds the invocation-owned Codex runtime placeholder to the exact
    /// loopback bridge created for this attempt. Core never scans or rewrites
    /// provider argv itself, and arbitrary prepared payloads cannot acquire a
    /// runtime endpoint through this seam.
    pub fn bind_codex_app_server_endpoint(
        &mut self,
        endpoint: &str,
    ) -> Result<(), InvocationError> {
        let port = endpoint
            .strip_prefix("ws://127.0.0.1:")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .ok_or(InvocationError::InvalidRuntimeBinding)?;
        let canonical = format!("ws://127.0.0.1:{port}");
        let mut matches = self
            .args
            .windows(2)
            .enumerate()
            .filter_map(|(index, pair)| {
                (pair[0] == "--remote" && pair[1] == CODEX_APP_SERVER_RUNTIME_PLACEHOLDER)
                    .then_some(index + 1)
            });
        let index = matches
            .next()
            .ok_or(InvocationError::InvalidRuntimeBinding)?;
        if matches.next().is_some() {
            return Err(InvocationError::InvalidRuntimeBinding);
        }
        self.args[index] = canonical;
        Ok(())
    }

    pub fn bindings(&self) -> impl Iterator<Item = (&str, &str)> {
        self.bindings
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
    pub fn delivered_prompt(&self) -> Option<&str> {
        self.delivered_prompt.as_deref()
    }
}

pub const CODEX_APP_SERVER_RUNTIME_PLACEHOLDER: &str = "termloop-runtime-authority";

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
        CodexProjectTrust::TermLoopManagedWorktree,
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
        CodexProjectTrust::TermLoopManagedWorktree,
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
    resolved.bindings = bindings
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    resolved.delivered_prompt = Some(delivered_prompt);
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
    resolved.bindings = bindings
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    resolved.delivered_prompt = Some(delivered_prompt);
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
        CodexProjectTrust::TermLoopManagedWorktree,
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
    resolve_launch_manifest_with_codex_project_trust(
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
        codex_project_trust,
    )
    .map(ResolvedLaunchManifest::into_payload)
}

/// Resolves a persistent Steward or Worker through the same inspected manifest
/// used by ordinary interactive Agents. The authenticated HTTP MCP principal,
/// not prompt text or provider argv, fixes the role-specific tool catalog.
pub fn persistent_assistant_agent(
    configuration: PersistentAssistantLaunch<'_>,
) -> Result<LaunchPayload, InvocationError> {
    if !matches!(
        configuration.role,
        ExecutorRole::Steward | ExecutorRole::Worker
    ) {
        return Err(InvocationError::InvalidAssistantConfiguration);
    }
    let instruction_template = configuration.role.template();
    assistant::validate_template_asset(instruction_template)?;
    let (provider_instructions, bindings) = match (
        configuration.role,
        configuration.worker_prompt,
        configuration.system_prompt,
    ) {
        (ExecutorRole::Steward, None, Some(prompt)) if prompt.len() <= 16 * 1024 => (
            assistant::effective_steward_system_prompt(prompt),
            vec![("systemPrompt".into(), prompt.trim().to_owned())],
        ),
        (ExecutorRole::Worker, Some(worker_prompt), Some(system_prompt))
            if worker_prompt.len() <= 16 * 1024 && system_prompt.len() <= 16 * 1024 =>
        {
            (
                assistant::effective_worker_prompt(worker_prompt, system_prompt),
                vec![
                    ("workerPrompt".into(), worker_prompt.trim().to_owned()),
                    ("systemPrompt".into(), system_prompt.trim().to_owned()),
                ],
            )
        }
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
    manifest.bindings = bindings;
    manifest.delivered_prompt = Some(activation.delivered_preview().to_owned());
    Ok(manifest.into_payload())
}

pub fn ask_to_helper_agent_for_conversation(
    agent_id: &str,
    cwd: &str,
    conversation: AgentConversationLaunch<'_>,
    request_id: &str,
    message: &str,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
) -> Result<LaunchPayload, InvocationError> {
    ask_to_helper_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        conversation,
        request_id,
        message,
        observation,
        mcp,
        CodexProjectTrust::Inherit,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn ask_to_helper_agent_for_managed_worktree_conversation(
    agent_id: &str,
    cwd: &str,
    conversation: AgentConversationLaunch<'_>,
    request_id: &str,
    message: &str,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
) -> Result<LaunchPayload, InvocationError> {
    ask_to_helper_agent_for_conversation_with_codex_project_trust(
        agent_id,
        cwd,
        conversation,
        request_id,
        message,
        observation,
        mcp,
        CodexProjectTrust::TermLoopManagedWorktree,
    )
}

#[allow(clippy::too_many_arguments)]
fn ask_to_helper_agent_for_conversation_with_codex_project_trust(
    agent_id: &str,
    cwd: &str,
    conversation: AgentConversationLaunch<'_>,
    request_id: &str,
    message: &str,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: AgentMcpLaunch<'_>,
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
    let mut resolved = resolve_launch_manifest_with_codex_project_trust(
        agent_id,
        cwd,
        template,
        "default",
        "default",
        "default",
        None,
        conversation,
        observation,
        Some(mcp),
        codex_project_trust,
    )?;
    // Both providers use option parsers before their positional prompt.
    // Terminate parsing explicitly so the visible YAML-frontmatter prompt is
    // neither swallowed by Claude's variadic `--mcp-config` nor interpreted as
    // an unknown Codex option.
    resolved
        .arguments
        .push(ResolvedArgument::exact("--", "first-message delimiter"));
    resolved.arguments.push(ResolvedArgument::private(
        delivered.clone(),
        "Ask-To first message",
    ));
    resolved.bindings = vec![
        ("request_id".into(), request_id.into()),
        ("message".into(), message.into()),
    ];
    resolved.delivered_prompt = Some(delivered.clone());
    resolved.inspectable.provenance.delivered_digest = content_digest(&delivered);
    resolved.inspectable.content_parts = vec![content_part(
        "first-message",
        "firstMessage",
        format!("resources/prompts/{}", template.id),
        "argv",
        &delivered,
    )];
    resolved.inspectable.transport = transport("argv", &delivered);
    resolved.inspectable.arguments = resolved
        .arguments
        .iter()
        .enumerate()
        .map(|(position, argument)| argument.inspect(position))
        .collect();
    finalize_digest(&mut resolved.inspectable);
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
        CodexProjectTrust::TermLoopManagedWorktree,
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
        CodexProjectTrust::TermLoopManagedWorktree,
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

fn terminal_prompt(
    template: &PromptTemplate,
    bindings: Vec<(String, String)>,
    delivered_prompt: String,
) -> Result<AskToTerminalPrompt, InvocationError> {
    // Agent TUIs can keep Return in multiline-edit mode when it arrives in the
    // same input burst as a paste. Preview and submitted bytes use the same
    // trimmed delivered form, while the submit key remains a delayed second
    // chunk inside one non-interleavable terminal request.
    let delivered_prompt = delivered_prompt.trim_end().to_owned();
    let terminal_input_sequence = termloop_platform::generated_terminal_paste_submission_sequence(
        delivered_prompt.as_bytes(),
    )
    .map_err(|_| InvocationError::InvalidPromptBinding)?;
    Ok(AskToTerminalPrompt {
        provenance: Provenance {
            template_ref: template.id.to_owned(),
            template_version: template.version,
        },
        bindings,
        delivered_prompt,
        terminal_input_sequence,
    })
}

fn bind_ordered(authored: &str, bindings: &[(&str, &str)]) -> Result<String, InvocationError> {
    let mut remaining = authored;
    let mut delivered = String::with_capacity(
        authored.len() + bindings.iter().map(|(_, value)| value.len()).sum::<usize>(),
    );
    for (name, value) in bindings {
        let marker = format!("{{{{{name}}}}}");
        let (before, after) = remaining
            .split_once(&marker)
            .ok_or(InvocationError::InvalidPromptBinding)?;
        if before.contains("{{") || before.contains("}}") || after.contains(&marker) {
            return Err(InvocationError::InvalidPromptBinding);
        }
        delivered.push_str(before);
        delivered.push_str(value);
        remaining = after;
    }
    if remaining.contains("{{") || remaining.contains("}}") {
        return Err(InvocationError::InvalidPromptBinding);
    }
    delivered.push_str(remaining);
    Ok(delivered)
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

fn conversation_args(
    agent_id: &str,
    launch: AgentConversationLaunch<'_>,
) -> Result<Vec<String>, InvocationError> {
    use termloop_domain::ResumeProvider;
    let (resume_ref, mode) = match launch {
        AgentConversationLaunch::Fresh { resume_ref } => (resume_ref, "fresh"),
        AgentConversationLaunch::Resume { resume_ref } => (Some(resume_ref), "resume"),
        AgentConversationLaunch::Fork { source_ref } => (Some(source_ref), "fork"),
    };
    let Some(resume_ref) = resume_ref else {
        return Ok(vec![]);
    };
    if !resume_ref.validate()
        || !matches!(
            (agent_id, resume_ref.provider),
            ("claude", ResumeProvider::Claude)
                | ("codex", ResumeProvider::Codex)
                | ("gemini", ResumeProvider::Gemini)
        )
    {
        return Err(InvocationError::InvalidResumeReference);
    }
    match (agent_id, mode) {
        ("claude", "fresh") => Ok(vec![
            "--session-id".into(),
            resume_ref.native_session_id.clone(),
        ]),
        ("claude", "resume") => Ok(vec![
            "--resume".into(),
            resume_ref.native_session_id.clone(),
        ]),
        ("claude", "fork") => Ok(vec![
            "--resume".into(),
            resume_ref.native_session_id.clone(),
            "--fork-session".into(),
        ]),
        ("codex", "fresh") => Err(InvocationError::InvalidResumeReference),
        ("codex", "resume") => Ok(vec!["resume".into(), resume_ref.native_session_id.clone()]),
        ("codex", "fork") => Ok(vec!["fork".into(), resume_ref.native_session_id.clone()]),
        ("gemini", "resume") => Ok(vec![
            "--resume".into(),
            resume_ref.native_session_id.clone(),
        ]),
        _ => Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    }
}

fn observation_args(agent_id: &str, observation: &AgentObservationLaunch<'_>) -> Vec<String> {
    match (agent_id, observation.transport) {
        ("claude", AgentObservationLaunchTransport::InlineSettings { content, .. }) => {
            vec!["--settings".into(), content.into()]
        }
        ("codex", AgentObservationLaunchTransport::DaemonOwnedBridge { endpoint }) => {
            vec!["--remote".into(), endpoint.into()]
        }
        ("gemini", AgentObservationLaunchTransport::EnvironmentSettingsPath { .. }) => vec![],
        _ => vec![],
    }
}

fn observation_transport_matches_agent(
    agent_id: &str,
    transport: AgentObservationLaunchTransport<'_>,
) -> bool {
    matches!(
        (agent_id, transport),
        (
            "claude",
            AgentObservationLaunchTransport::InlineSettings { .. }
        ) | (
            "codex",
            AgentObservationLaunchTransport::DaemonOwnedBridge { .. }
        ) | (
            "gemini",
            AgentObservationLaunchTransport::EnvironmentSettingsPath {
                variable: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
                ..
            }
        )
    )
}

fn observation_environment_conflicts(
    agent_id: &str,
    transport: AgentObservationLaunchTransport<'_>,
    environment: &termloop_platform::LaunchEnvironment,
) -> bool {
    matches!(
        (agent_id, transport),
        (
            "gemini",
            AgentObservationLaunchTransport::EnvironmentSettingsPath {
                variable: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
                ..
            }
        )
    ) && termloop_platform::gemini_cli_system_defaults_source_present(environment)
}

fn mcp_args(agent_id: &str, mcp: &AgentMcpLaunch<'_>) -> Result<Vec<String>, InvocationError> {
    match agent_id {
        "claude" => {
            let mut args = vec!["--mcp-config".into(), mcp.claude_config_path.into()];
            if mcp.profile.includes_interactive_instructions() {
                args.extend([
                    "--append-system-prompt".into(),
                    INTERACTIVE_AGENT_TEMPLATE.authored_body.into(),
                ]);
            }
            Ok(args)
        }
        "codex" => {
            let endpoint = serde_json::to_string(mcp.endpoint)
                .map_err(|_| InvocationError::InvalidMcpEndpoint)?;
            let mut args = vec![
                "-c".into(),
                format!("mcp_servers.termloop_next.url={endpoint}"),
                "-c".into(),
                "mcp_servers.termloop_next.bearer_token_env_var=\"TERMLOOP_MCP_TOKEN\"".into(),
            ];
            if mcp.profile.includes_interactive_instructions() {
                let instructions = serde_json::to_string(INTERACTIVE_AGENT_TEMPLATE.authored_body)
                    .map_err(|_| InvocationError::InvalidDeveloperInstructions)?;
                args.extend([
                    "-c".into(),
                    format!("developer_instructions={instructions}"),
                ]);
            }
            Ok(args)
        }
        _ => Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum InvocationError {
    #[error("launch payload has no visible template provenance")]
    UnprovenancedPrompt,
    #[error("launch template is missing from the visible catalog")]
    TemplateMissing,
    #[error("unsupported agent: {0}")]
    UnsupportedAgent(String),
    #[error("agent CLI for {0} was not found on the launch PATH")]
    AgentCliNotFound(String),
    #[error("agent CLI for {0} exists but cannot be launched")]
    AgentCliUnusable(String),
    #[error("private resume reference is invalid for the selected provider")]
    InvalidResumeReference,
    #[error("Codex App Server runtime binding is invalid")]
    InvalidRuntimeBinding,
    #[error("quick action prompt is empty or exceeds its limit")]
    InvalidPrompt,
    #[error("Quick Action image attachment is invalid")]
    InvalidImageAttachment,
    #[error("unsupported model {model} for agent {agent_id}")]
    UnsupportedModel { agent_id: String, model: String },
    #[error("unsupported permission {permission} for agent {agent_id}")]
    UnsupportedPermission {
        agent_id: String,
        permission: String,
    },
    #[error("unsupported reasoning {reasoning} for agent {agent_id}")]
    UnsupportedReasoning { agent_id: String, reasoning: String },
    #[error("local MCP endpoint is invalid")]
    InvalidMcpEndpoint,
    #[error("observation transport does not belong to the selected agent")]
    InvalidObservationTransport,
    #[error("provider configuration already owns the launch-scoped observation layer")]
    ObservationConfigurationConflict,
    #[error("developer instructions cannot be represented in provider configuration")]
    InvalidDeveloperInstructions,
    #[error("visible prompt binding is invalid")]
    InvalidPromptBinding,
    #[error("assistant launch or wake configuration is invalid")]
    InvalidAssistantConfiguration,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_observation<'a>(
        session_id: &'a str,
        endpoint: &'a str,
        token: &'a str,
        content: &'a str,
        inspectable_content: &'a str,
    ) -> AgentObservationLaunch<'a> {
        AgentObservationLaunch {
            session_id,
            endpoint,
            token,
            transport: AgentObservationLaunchTransport::InlineSettings {
                content,
                inspectable_content,
            },
        }
    }

    fn codex_observation(endpoint: &str) -> AgentObservationLaunch<'_> {
        AgentObservationLaunch {
            session_id: "session",
            endpoint: "http://127.0.0.1:123/agent-observation",
            token: "",
            transport: AgentObservationLaunchTransport::DaemonOwnedBridge { endpoint },
        }
    }

    fn gemini_observation<'a>(
        session_id: &'a str,
        endpoint: &'a str,
        token: &'a str,
        path: &'a str,
        content: &'a str,
        inspectable_content: &'a str,
    ) -> AgentObservationLaunch<'a> {
        AgentObservationLaunch {
            session_id,
            endpoint,
            token,
            transport: AgentObservationLaunchTransport::EnvironmentSettingsPath {
                variable: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
                path,
                content,
                inspectable_content,
            },
        }
    }

    /// Returns only the provider-owned arguments, excluding any platform
    /// wrapper needed to launch the resolved CLI (for example
    /// `cmd.exe /d /s /c <cli>.cmd` on Windows).
    fn provider_args(launch: &LaunchPayload) -> &[String] {
        let executable = &launch.inspectable_manifest().target.executable;
        launch
            .args()
            .iter()
            .position(|argument| argument == executable)
            .map_or_else(|| launch.args(), |index| &launch.args()[index + 1..])
    }

    fn app_server_args(launch: &CodexAppServerLaunch) -> &[String] {
        let index = launch
            .args()
            .iter()
            .position(|argument| argument == "app-server")
            .expect("Codex app-server subcommand");
        &launch.args()[index..]
    }

    fn assert_terminal_submission(input: &[Vec<u8>], delivered: &str) {
        assert_eq!(
            input,
            termloop_platform::terminal_paste_submission_sequence(delivered.as_bytes())
        );
        assert_eq!(input.len(), 2);
        assert_eq!(input[1], b"\r");
    }

    #[test]
    fn baseline_authorities_are_classified_by_purpose() {
        assert_eq!(
            baseline_environment_classification("SSH_AUTH_SOCK"),
            ("credentialAuthority", "SSH agent capability")
        );
        assert_eq!(
            baseline_environment_classification("https_proxy"),
            ("proxyAuthority", "network proxy configuration")
        );
        assert_eq!(
            baseline_environment_classification("DBUS_SESSION_BUS_ADDRESS"),
            ("runtimeAuthority", "desktop session capability")
        );
        assert_eq!(
            baseline_environment_classification("HOME"),
            ("sensitivePath", "approved child-process filesystem context")
        );
        assert_eq!(
            baseline_environment_classification("TERM"),
            ("platformValue", "approved child-process bootstrap")
        );
    }

    #[test]
    fn interactive_agent_has_visible_template_provenance() {
        let launch = interactive_agent("claude", "/tmp/project").unwrap();
        let program = std::path::Path::new(launch.program());
        assert!(program.is_absolute(), "{program:?}");
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.interactive"
        );
        assert_eq!(launch.provenance().template_version, 7);
        let templates = prompt_templates();
        let unique_ids = templates
            .iter()
            .map(|template| template.id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique_ids.len(), templates.len());
        assert!(
            templates
                .iter()
                .find(|template| template.id == "builtin.agent.interactive")
                .is_some_and(|template| {
                    template
                        .authored_body
                        .contains("structured plan or task list")
                        && template.authored_body.contains("MUST use `send_to_agent`")
                        && !template.authored_body.contains("session_topic_update")
                })
        );
    }

    #[test]
    fn custom_routine_has_visible_generic_instructions() {
        let prompt = tracker_assignment_prompt(ExecutorRole::CustomTracker).unwrap();
        assert_eq!(prompt.provenance().template_ref, "builtin.tracker.custom");
        assert_eq!(prompt.provenance().template_version, 4);
        assert!(prompt.delivered_preview().contains("visible name"));
        assert!(prompt.delivered_preview().contains("actually exposed"));
        assert!(
            prompt
                .delivered_preview()
                .contains("does not create access")
        );
        assert!(prompt.delivered_preview().contains("`context.md`"));
        assert!(prompt.delivered_preview().contains("`updateSummary`"));
        assert!(prompt.delivered_preview().contains("`custom:` source keys"));
    }

    #[test]
    fn jira_routine_uses_configured_scope_without_hardcoded_workflow() {
        let prompt = tracker_assignment_prompt(ExecutorRole::JiraTracker).unwrap();
        assert_eq!(prompt.provenance().template_ref, "builtin.tracker.jira");
        assert_eq!(prompt.provenance().template_version, 5);
        assert!(prompt.delivered_preview().contains("actually exposed"));
        assert!(prompt.delivered_preview().contains("does not prove access"));
        assert!(prompt.delivered_preview().contains("editable instructions"));
        assert!(prompt.delivered_preview().contains("Do not assume"));
        assert!(prompt.delivered_preview().contains("contextMarkdown"));
        assert!(
            prompt
                .delivered_preview()
                .contains("jira:<stable-issue-id>:<material-state>")
        );
        for hardcoded_assumption in [
            "currentUser()",
            "Ready for Development",
            "last 30 days",
            "A sprint is never required",
        ] {
            assert!(!prompt.delivered_preview().contains(hardcoded_assumption));
        }
    }

    #[test]
    fn tracker_presets_use_exposed_capabilities_without_claiming_connector_access() {
        let cases = [
            (ExecutorRole::SlackTracker, "builtin.tracker.slack", 6),
            (ExecutorRole::JiraTracker, "builtin.tracker.jira", 5),
            (ExecutorRole::RuntimeTracker, "builtin.tracker.runtime", 6),
            (ExecutorRole::DeliveryTracker, "builtin.tracker.delivery", 6),
            (ExecutorRole::CiPrTracker, "builtin.tracker.ci-pr", 6),
            (
                ExecutorRole::StepCheckTracker,
                "builtin.tracker.step-check",
                7,
            ),
            (ExecutorRole::CustomTracker, "builtin.tracker.custom", 4),
        ];

        for (role, template_ref, template_version) in cases {
            let prompt = tracker_assignment_prompt(role).unwrap();
            let delivered = prompt.delivered_preview().replace('\n', " ");
            assert_eq!(prompt.provenance().template_ref, template_ref);
            assert_eq!(prompt.provenance().template_version, template_version);
            assert!(delivered.contains("actually exposed"), "{template_ref}");
            assert!(
                delivered.contains("does not prove access")
                    || delivered.contains("does not create access"),
                "{template_ref}",
            );
            assert!(
                delivered.contains("worker_report_routine_problem"),
                "{template_ref}",
            );
            assert!(!delivered.contains("Edit this prompt"), "{template_ref}");
            assert!(!delivered.contains("already available"), "{template_ref}");
        }
    }

    #[test]
    fn configured_interactive_agent_applies_saved_options_without_delivering_a_prompt() {
        let launch = configured_interactive_agent_for_conversation(
            "codex",
            "/tmp/project",
            "gpt-5.6-sol",
            "plan",
            "high",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert!(launch.args().contains(&"gpt-5.6-sol".to_owned()));
        assert!(launch.args().contains(&"read-only".to_owned()));
        assert!(
            launch
                .args()
                .iter()
                .any(|argument| argument.contains("high"))
        );
        assert_eq!(launch.initial_input(), None);
        assert_eq!(launch.inspectable_manifest().transport.kind, "none");
        assert!(launch.inspectable_manifest().content_parts.is_empty());
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.interactive"
        );
    }

    #[test]
    fn configured_resume_reapplies_bypass_permission_for_each_provider() {
        for (agent_id, provider, bypass_argument) in [
            (
                "claude",
                termloop_domain::ResumeProvider::Claude,
                "--dangerously-skip-permissions",
            ),
            (
                "codex",
                termloop_domain::ResumeProvider::Codex,
                "--dangerously-bypass-approvals-and-sandbox",
            ),
        ] {
            let resume_ref = termloop_domain::ResumeRef::for_provider(
                provider,
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
            )
            .unwrap();
            let launch = configured_interactive_agent_for_conversation(
                agent_id,
                "/tmp/project",
                "default",
                "bypassPermissions",
                "default",
                AgentConversationLaunch::Resume {
                    resume_ref: &resume_ref,
                },
                None,
                None,
            )
            .unwrap();

            assert!(
                launch
                    .args()
                    .iter()
                    .any(|argument| argument == bypass_argument)
            );
            assert_eq!(
                launch.inspectable_manifest().target.permission,
                "bypassPermissions"
            );
        }
    }

    #[test]
    fn quick_action_preview_matches_delivery_and_model_arguments() {
        let preview = preview_quick_action(
            "claude",
            "/tmp/project",
            "sonnet",
            "acceptEdits",
            "high",
            "Fix the failing test",
        )
        .unwrap();
        assert_eq!(preview.delivered_preview, "Fix the failing test");
        let launch = quick_action_agent_for_conversation(
            "claude",
            "/tmp/project",
            "sonnet",
            "acceptEdits",
            "high",
            "Fix the failing test",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            provider_args(&launch),
            [
                "--model",
                "sonnet",
                "--effort",
                "high",
                "--permission-mode",
                "auto"
            ]
        );
        assert_eq!(launch.initial_input(), Some("Fix the failing test\r"));
        assert_eq!(
            launch.initial_input_sequence(),
            Some(
                termloop_platform::terminal_paste_submission_sequence(b"Fix the failing test")
                    .as_slice()
            )
        );
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.quick-action.free-prompt"
        );
    }

    fn run_configuration_improver_target<'a>() -> ImproverTarget<'a> {
        ImproverTarget::RunConfiguration {
            configuration_id: "run-7",
            configuration_name: "Dev server",
        }
    }

    fn prompt_improver_launch(target: ImproverTarget<'_>) -> LaunchPayload {
        let template_ref = target.template_ref();
        improver_agent(
            "codex",
            "/tmp/project",
            "default",
            "default",
            "default",
            target,
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap_or_else(|error| panic!("{template_ref}: {error:?}"))
    }

    #[test]
    fn improver_assets_bind_visible_context_and_require_version_tools() {
        let targets = [
            run_configuration_improver_target(),
            ImproverTarget::StewardInstructions {
                project_name: "Nucleus",
                built_in_instructions: "Protected Steward behavior.",
                max_bytes: 16_384,
            },
            ImproverTarget::WorkerInstructions {
                worker_id: "wkr-1",
                worker_name: "Delivery Worker",
                built_in_instructions: "Protected Worker behavior.",
                routine_summary: r#"{"routines":[]}"#,
                max_bytes: 16_384,
            },
            ImproverTarget::RoutineInstructions {
                routine_id: "rtn-1",
                routine_name: "PR approved",
                worker_name: "Delivery Worker",
                built_in_instructions: "Protected Routine behavior.",
                max_bytes: 8_192,
            },
            ImproverTarget::RoutineBuilder {
                project_name: "Nucleus",
                worker_id: "wkr-1",
                worker_name: "Delivery Worker",
                routine_summary: r#"{"routines":[]}"#,
            },
            ImproverTarget::Playbook {
                project_name: "Nucleus",
            },
        ];
        for target in targets {
            let template = target.template().unwrap();
            let launch = prompt_improver_launch(target);
            let delivered = launch.delivered_prompt().unwrap();
            assert!(!delivered.contains("{{"));
            assert!(!delivered.contains("}}"));
            assert!(delivered.contains("configuration_version_read"));
            assert!(delivered.contains("configuration_version_write"));
            assert!(delivered.contains("Keep the conversation compact."));
            assert!(delivered.contains("Never echo the written payload."));
            assert!(!delivered.contains("Current editable instructions:"));
            assert!(!delivered.contains("Current Worker check:"));
            assert!(!delivered.contains("Current Steward response policy:"));
            assert!(
                template
                    .authored_body
                    .contains(&format!("version: {}", template.version)),
                "{} frontmatter version must match invocation provenance",
                template.id
            );
            assert!(!delivered.contains(".termloop/improve"));
            assert!(!provider_args(&launch).iter().any(|argument| {
                argument == "bypassPermissions" || argument == "--dangerously-skip-permissions"
            }));
        }
    }

    #[test]
    fn playbook_builder_reviews_every_step_and_declares_the_new_snapshot_contract() {
        let target = ImproverTarget::Playbook {
            project_name: "Nucleus",
        };
        let template = target.template().unwrap();
        let launch = prompt_improver_launch(target);
        let delivered = launch.delivered_prompt().unwrap();

        assert_eq!(template.version, 15);
        assert_eq!(launch.provenance().template_version, 15);
        for expected in [
            "two compact review",
            "show the complete normal path as one readable arrow sequence",
            "present the complete detailed draft",
            "configuration_version_write.content",
            "\"activePipelineName\"",
            "\"milestones\"",
            "\"savedPipelines\"",
            "\"workerId\"",
            "\"preferredWorkerAgentId\"",
            "Every saved pipeline contains exactly",
            "Every `check` contains exactly",
            "never send probe",
            "authenticated scoped",
            "Project checkout cwd or",
            "task_agent_request",
            "Worker-to-Agent coordination among the recommended options",
            "sole authority",
            "never require the Worker to re-prove that Agent identity",
            "attempt `task_agent_request` before reporting",
            "ordinary unmet evidence and is `waiting`",
        ] {
            assert!(delivered.contains(expected), "missing {expected:?}");
        }
        for invalid_creation_shape in [
            "`schemaVersion`",
            "`activePipelineId`",
            "`pipelines`",
            "`workers`",
            "`routines`",
        ] {
            assert!(
                delivered.contains(invalid_creation_shape),
                "missing rejected shape {invalid_creation_shape:?}"
            );
        }
        assert!(!delivered.contains("at most five short bullets"));
        assert!(!delivered.contains("playbook_update"));
        assert!(!delivered.contains("playbook_read"));
    }

    #[test]
    fn settings_and_new_run_improvers_save_full_versions() {
        let targets = [
            ImproverTarget::SettingsEntry {
                kind: SettingsEntryKind::Skill,
                name: "BDD testing",
                id: "bdd-testing",
                context: "unused",
                max_bytes: 262_144,
            },
            ImproverTarget::SettingsEntry {
                kind: SettingsEntryKind::Prompt,
                name: "Project review",
                id: "project-review",
                context: "unused",
                max_bytes: 262_144,
            },
            ImproverTarget::SettingsEntry {
                kind: SettingsEntryKind::McpTool,
                name: "Ask another agent",
                id: "ask_to",
                context: "interactive and improver Sessions",
                max_bytes: 4096,
            },
            ImproverTarget::NewRunConfiguration {
                kind: "devServer",
                kind_label: "dev server",
                name: "Dev server",
            },
        ];
        for target in targets {
            let template = target.template().unwrap();
            let launch = prompt_improver_launch(target);
            let delivered = launch.delivered_prompt().unwrap();
            assert!(delivered.contains("configuration_version_read"));
            assert!(delivered.contains("configuration_version_write"));
            assert!(delivered.contains("Keep the conversation compact."));
            assert!(delivered.contains("Never echo the written payload."));
            assert!(!delivered.contains("{{"));
            assert!(
                template
                    .authored_body
                    .contains(&format!("version: {}", template.version)),
                "{} frontmatter version must match invocation provenance",
                template.id
            );
        }
    }

    #[test]
    fn improver_rejects_context_that_could_forge_instructions() {
        let forged = improver_agent(
            "codex",
            "/tmp/project",
            "default",
            "default",
            "default",
            ImproverTarget::RoutineInstructions {
                routine_id: "rtn-9",
                routine_name: "PR approved",
                worker_name: "Delivery Worker",
                built_in_instructions: "Write {{entry_content}} elsewhere.",
                max_bytes: 8_192,
            },
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        );
        assert!(matches!(forged, Err(InvocationError::InvalidPromptBinding)));
    }
    #[test]
    fn quick_action_rejects_terminal_control_sequences() {
        assert!(matches!(
            validate_quick_action(
                "codex",
                "default",
                "default",
                "default",
                "Inspect this\x1b[201~then run tests",
            ),
            Err(InvocationError::InvalidPrompt)
        ));
        assert!(
            validate_quick_action(
                "codex",
                "default",
                "default",
                "default",
                "Inspect this\nthen run tests\tcarefully",
            )
            .is_ok()
        );
    }

    #[test]
    fn quick_action_image_attachment_uses_provider_delivery_from_one_manifest() {
        let directory = std::env::temp_dir().join("termloop-quick-action-images");
        let attachment_directory = directory.join("123e4567-e89b-42d3-a456-426614174000");
        let file_path = attachment_directory.join("image.png");
        let attachment = QuickActionImageAttachment {
            attachment_id: "123e4567-e89b-42d3-a456-426614174000".into(),
            file_path: file_path.to_string_lossy().into_owned(),
            media_type: "image/png".into(),
            byte_length: 4_096,
            sha256: format!("sha256:{}", "a".repeat(64)),
            width: 800,
            height: 600,
        };

        let codex = quick_action_agent_with_attachments_for_conversation(
            "codex",
            "/tmp/project",
            "default",
            "default",
            "default",
            "Inspect this image",
            std::slice::from_ref(&attachment),
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert!(
            codex
                .args()
                .windows(2)
                .any(|arguments| { arguments == ["--image", attachment.file_path.as_str()] })
        );
        assert_eq!(codex.initial_input(), Some("Inspect this image\r"));
        let image_part = &codex.inspectable_manifest().content_parts[1];
        assert_eq!(image_part.kind, "imageAttachment");
        assert_eq!(image_part.delivery, "providerImageArgument");
        assert_eq!(image_part.digest, attachment.sha256);
        assert!(
            codex
                .inspectable_manifest()
                .arguments
                .iter()
                .any(|argument| {
                    argument.classification == "sensitivePath"
                        && argument.display == "<redacted Quick Action image path>"
                })
        );

        let claude = quick_action_agent_with_attachments_for_conversation(
            "claude",
            "/tmp/project",
            "default",
            "default",
            "default",
            "Inspect this image",
            &[attachment],
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert!(claude.args().windows(2).any(|arguments| {
            arguments[0] == "--add-dir" && arguments[1] == attachment_directory.to_string_lossy()
        }));
        assert!(
            claude
                .delivered_prompt()
                .is_some_and(|prompt| prompt.contains("inspect `image.png`"))
        );
        assert!(!claude.delivered_prompt().unwrap().contains("/tmp/"));
        assert_eq!(
            claude.inspectable_manifest().content_parts[1].delivery,
            "terminalPathReference"
        );
        assert_ne!(
            codex.inspectable_manifest().digest,
            claude.inspectable_manifest().digest
        );
    }

    #[test]
    fn image_attachment_paste_is_provider_neutral_and_does_not_submit() {
        let attachment_id = "123e4567-e89b-42d3-a456-426614174000";
        let file_path = std::env::temp_dir()
            .join("termloop-quick-action-images")
            .join(attachment_id)
            .join("image.png");
        let attachment = QuickActionImageAttachment {
            attachment_id: attachment_id.into(),
            file_path: file_path.to_string_lossy().into_owned(),
            media_type: "image/png".into(),
            byte_length: 4_096,
            sha256: format!("sha256:{}", "a".repeat(64)),
            width: 800,
            height: 600,
        };

        let paste = image_attachment_terminal_paste(&attachment).unwrap();
        let expected = format!("{} ", serde_json::to_string(&attachment.file_path).unwrap());
        assert_eq!(
            paste,
            termloop_platform::terminal_paste_input(expected.as_bytes())
        );
        assert!(!paste.ends_with(b"\r"));
    }

    #[test]
    fn quick_action_image_rejects_a_path_outside_its_unique_owned_shape() {
        let attachment = QuickActionImageAttachment {
            attachment_id: "123e4567-e89b-42d3-a456-426614174000".into(),
            file_path: "/tmp/private/image.png".into(),
            media_type: "image/png".into(),
            byte_length: 1,
            sha256: format!("sha256:{}", "a".repeat(64)),
            width: 1,
            height: 1,
        };
        assert!(matches!(
            validate_quick_action_with_attachments(
                "codex",
                "default",
                "default",
                "default",
                "Inspect",
                &[attachment]
            ),
            Err(InvocationError::InvalidImageAttachment)
        ));
    }

    #[test]
    fn quick_action_rejects_cross_provider_models() {
        assert!(matches!(
            preview_quick_action(
                "codex",
                "/tmp/project",
                "opus",
                "default",
                "default",
                "Review this"
            ),
            Err(InvocationError::UnsupportedModel { .. })
        ));
    }

    #[test]
    fn quick_action_accepts_the_compact_current_codex_family() {
        for model in [
            "default",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.5-pro",
        ] {
            assert!(
                preview_quick_action(
                    "codex",
                    "/tmp/project",
                    model,
                    "default",
                    "default",
                    "Review this"
                )
                .is_ok()
            );
        }
        assert!(matches!(
            preview_quick_action(
                "codex",
                "/tmp/project",
                "gpt-5.4",
                "default",
                "default",
                "Review this"
            ),
            Err(InvocationError::UnsupportedModel { .. })
        ));
    }

    #[test]
    fn quick_action_accepts_the_installed_claude_picker_models() {
        for model in ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"] {
            assert!(
                preview_quick_action(
                    "claude",
                    "/tmp/project",
                    model,
                    "default",
                    "default",
                    "Review this"
                )
                .is_ok()
            );
        }
        assert!(matches!(
            preview_quick_action(
                "claude",
                "/tmp/project",
                "best",
                "default",
                "default",
                "Review this"
            ),
            Err(InvocationError::UnsupportedModel { .. })
        ));
    }

    #[test]
    fn gemini_launch_options_use_only_current_interactive_cli_flags() {
        assert_eq!(
            model_args("gemini", "default").unwrap(),
            Vec::<String>::new()
        );
        for model in ["auto", "pro", "flash", "flash-lite"] {
            assert_eq!(model_args("gemini", model).unwrap(), ["-m", model]);
        }
        assert!(matches!(
            model_args("gemini", "gpt-5.6-sol"),
            Err(InvocationError::UnsupportedModel { .. })
        ));
        assert_eq!(
            permission_args("gemini", "acceptEdits").unwrap(),
            ["--approval-mode", "auto_edit"]
        );
        assert_eq!(
            permission_args("gemini", "plan").unwrap(),
            ["--approval-mode", "plan"]
        );
        assert_eq!(
            permission_args("gemini", "bypassPermissions").unwrap(),
            ["--approval-mode", "yolo"]
        );
        assert!(reasoning_args("gemini", "default").unwrap().is_empty());
        assert!(matches!(
            reasoning_args("gemini", "high"),
            Err(InvocationError::UnsupportedReasoning { .. })
        ));
    }

    #[test]
    fn catalog_launch_options_are_accepted_by_their_invocation_adapter() {
        for descriptor in termloop_agents::agent_catalog() {
            for model in descriptor.models {
                assert!(
                    validate_agent_configuration(descriptor.id, model, "default", "default")
                        .is_ok(),
                    "catalog model {model} drifted for {}",
                    descriptor.id
                );
            }
            for permission in descriptor.permissions {
                assert!(
                    validate_agent_configuration(descriptor.id, "default", permission, "default")
                        .is_ok(),
                    "catalog permission {permission} drifted for {}",
                    descriptor.id
                );
            }
            for reasoning in descriptor.reasoning {
                assert!(
                    validate_agent_configuration(descriptor.id, "default", "default", reasoning)
                        .is_ok(),
                    "catalog reasoning {reasoning} drifted for {}",
                    descriptor.id
                );
            }
        }
    }

    #[test]
    fn gemini_launch_only_manifest_is_explicitly_unobserved_and_prompt_free() {
        let launch = configured_interactive_agent_for_conversation(
            "gemini",
            "/tmp/project",
            "flash",
            "plan",
            "default",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            provider_args(&launch),
            ["-m", "flash", "--approval-mode", "plan"]
        );
        assert_eq!(launch.initial_input(), None);
        assert_eq!(launch.inspectable_manifest().target.agent_id, "gemini");
        assert_eq!(launch.inspectable_manifest().target.conversation, "fresh");
        assert_eq!(launch.inspectable_manifest().transport.kind, "none");
        assert!(launch.inspectable_manifest().content_parts.is_empty());
        assert!(launch.inspectable_manifest().generated_files.is_empty());
        assert!(
            launch
                .environment_keys()
                .filter_map(|key| key.to_str())
                .all(|key| !key.starts_with("TERMLOOP_"))
        );
    }

    #[test]
    fn persistent_assistant_defaults_are_explicit_and_provider_specific() {
        assert_eq!(
            default_assistant_launch_selection("claude").unwrap(),
            AssistantLaunchDefaults {
                model: "sonnet",
                permission: "bypassPermissions",
                reasoning: "medium",
            }
        );
        assert_eq!(
            default_assistant_launch_selection("codex").unwrap(),
            AssistantLaunchDefaults {
                model: "gpt-5.6-luna",
                permission: "bypassPermissions",
                reasoning: "medium",
            }
        );
        assert!(matches!(
            default_assistant_launch_selection("other"),
            Err(InvocationError::UnsupportedAgent(agent_id)) if agent_id == "other"
        ));
    }

    #[test]
    fn quick_action_maps_codex_permission_and_reasoning_without_prompt_argv() {
        let launch = quick_action_agent_for_conversation(
            "codex",
            "/tmp/project",
            "gpt-5.6-terra",
            "plan",
            "xhigh",
            "Inspect only",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            provider_args(&launch),
            [
                "-C",
                "/tmp/project",
                "--model",
                "gpt-5.6-terra",
                "-c",
                "model_reasoning_effort=\"xhigh\"",
                "--sandbox",
                "read-only",
                "--ask-for-approval",
                "on-request",
                "-c",
                CODEX_DISABLE_STARTUP_UPDATE_CHECK,
            ]
        );
        assert_eq!(launch.initial_input(), Some("Inspect only\r"));
        assert!(!launch.args().iter().any(|arg| arg.contains("Inspect only")));
    }

    #[test]
    fn quick_action_bypass_is_an_exact_provider_flag() {
        let claude = permission_args("claude", "bypassPermissions").unwrap();
        let codex = permission_args("codex", "bypassPermissions").unwrap();
        assert_eq!(claude, ["--dangerously-skip-permissions"]);
        assert_eq!(codex, ["--dangerously-bypass-approvals-and-sandbox"]);
    }

    #[test]
    fn persistent_assistants_apply_their_selected_permission() {
        for (agent_id, expected_flag) in [
            ("codex", "--dangerously-bypass-approvals-and-sandbox"),
            ("claude", "--dangerously-skip-permissions"),
        ] {
            let steward = persistent_assistant_agent(PersistentAssistantLaunch {
                agent_id,
                model: "default",
                permission: "bypassPermissions",
                reasoning: "default",
                role: ExecutorRole::Steward,
                system_prompt: Some(""),
                worker_prompt: None,
                cwd: "/tmp/project",
                conversation: AgentConversationLaunch::Fresh { resume_ref: None },
                observation: None,
                mcp: AgentMcpLaunch {
                    endpoint: "http://127.0.0.1:1234/mcp",
                    token: "runtime-secret",
                    claude_config_path: "/tmp/termloop-agent-mcp.json",
                    profile: AgentMcpProfile::Steward,
                },
            })
            .unwrap();
            assert!(
                steward
                    .args()
                    .iter()
                    .any(|argument| argument == expected_flag)
            );
            assert_eq!(
                steward.inspectable_manifest().target.permission,
                "bypassPermissions"
            );
            let native_instructions = steward
                .inspectable_manifest()
                .content_parts
                .iter()
                .find(|part| part.id == "persistent-assistant-instructions")
                .expect("visible native Steward instructions");
            assert!(native_instructions.content.contains("steward_suggest"));
            match agent_id {
                "codex" => assert!(
                    steward
                        .args()
                        .iter()
                        .any(|argument| argument.starts_with("developer_instructions=")
                            && argument.contains("steward_suggest"))
                ),
                "claude" => assert!(steward.args().windows(2).any(|arguments| {
                    arguments[0] == "--append-system-prompt"
                        && arguments[1].contains("steward_suggest")
                })),
                _ => unreachable!(),
            }
            assert!(steward.initial_input().is_some_and(|input| {
                input.contains("Persistent Assistant Activation")
                    && input.contains("**Initial activation**")
                    && input.contains("mutation-receipt")
                    && input.contains("silent-idle")
                    && !input.contains("reply through `steward_suggest` exactly once")
                    && input.ends_with('\r')
            }));
        }

        for agent_id in ["codex", "claude"] {
            let worker = persistent_assistant_agent(PersistentAssistantLaunch {
                agent_id,
                model: "default",
                permission: "default",
                reasoning: "default",
                role: ExecutorRole::Worker,
                system_prompt: Some("Answer briefly in Turkish."),
                worker_prompt: Some("Summarize each Routine in one sentence."),
                cwd: "/tmp/project",
                conversation: AgentConversationLaunch::Fresh { resume_ref: None },
                observation: None,
                mcp: AgentMcpLaunch {
                    endpoint: "http://127.0.0.1:1234/mcp",
                    token: "runtime-secret",
                    claude_config_path: "/tmp/termloop-agent-mcp.json",
                    profile: AgentMcpProfile::Worker,
                },
            })
            .unwrap();
            assert!(
                !worker
                    .args()
                    .iter()
                    .any(|argument| argument.contains("bypass"))
            );
            assert_eq!(worker.inspectable_manifest().target.permission, "default");
            let instructions = worker
                .inspectable_manifest()
                .content_parts
                .iter()
                .find(|part| part.id == "persistent-assistant-instructions")
                .expect("visible native Worker instructions");
            assert_eq!(instructions.kind, "providerInstructions");
            assert!(instructions.content.contains("Configured Worker prompt"));
            assert!(instructions.content.contains("Configured System prompt"));
            assert!(
                instructions
                    .content
                    .contains("task_agent_transcript_tail_read")
            );
            assert!(instructions.content.contains("task_agent_request"));
            match agent_id {
                "codex" => assert!(worker.args().iter().any(|argument| {
                    argument.starts_with("developer_instructions=")
                        && argument.contains("Configured Worker prompt")
                        && argument.contains("Configured System prompt")
                })),
                "claude" => assert!(worker.args().windows(2).any(|arguments| {
                    arguments[0] == "--append-system-prompt"
                        && arguments[1].contains("Configured Worker prompt")
                        && arguments[1].contains("Configured System prompt")
                })),
                _ => unreachable!(),
            }
            assert!(worker.initial_input().is_some_and(|input| {
                input.contains("worker_get_next_routine")
                    && input.contains("worker_report_step_verdicts")
                    && !input.contains("## Configured Worker prompt")
                    && !input.contains("Summarize each Routine in one sentence.")
                    && input.ends_with('\r')
            }));
            assert_eq!(
                worker.bindings().collect::<Vec<_>>(),
                vec![
                    ("workerPrompt", "Summarize each Routine in one sentence."),
                    ("systemPrompt", "Answer briefly in Turkish."),
                ]
            );
            assert!(
                worker
                    .initial_input_sequence()
                    .and_then(|sequence| sequence.last())
                    .is_some_and(|input| input.as_slice() == b"\r")
            );
        }
    }

    #[test]
    fn persistent_worker_single_editor_suffix_round_trips_without_added_text() {
        let built_in = assistant::effective_worker_prompt("", "");
        let editable = "Handle Slack checks and summarize only new messages.";
        assert_eq!(
            assistant::effective_worker_prompt("", editable),
            format!("{built_in}\n\n{editable}")
        );
        assert_eq!(
            assistant::effective_worker_prompt(editable, ""),
            format!("{built_in}\n\n{editable}")
        );
    }

    #[test]
    fn persistent_steward_custom_instructions_cannot_erase_the_runtime_protocol() {
        let custom = "Answer briefly in Turkish.";
        let steward = persistent_assistant_agent(PersistentAssistantLaunch {
            agent_id: "codex",
            model: "gpt-5.6-sol",
            permission: "bypassPermissions",
            reasoning: "high",
            role: ExecutorRole::Steward,
            system_prompt: Some(custom),
            worker_prompt: None,
            cwd: "/tmp/project",
            conversation: AgentConversationLaunch::Fresh { resume_ref: None },
            observation: None,
            mcp: AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "runtime-secret",
                claude_config_path: "/tmp/termloop-agent-mcp.json",
                profile: AgentMcpProfile::Steward,
            },
        })
        .unwrap();

        assert_eq!(steward.inspectable_manifest().target.model, "gpt-5.6-sol");
        assert_eq!(steward.inspectable_manifest().target.reasoning, "high");

        let delivered = steward.delivered_prompt().expect("activation prompt");
        assert!(delivered.contains("Persistent Assistant Activation"));
        assert!(!delivered.contains(custom));
        let instructions = steward
            .inspectable_manifest()
            .content_parts
            .iter()
            .find(|part| part.id == "persistent-assistant-instructions")
            .expect("native instructions");
        assert!(
            instructions
                .content
                .starts_with(default_steward_system_prompt())
        );
        assert!(instructions.content.contains("**Initial activation:**"));
        assert!(instructions.content.contains("**User message:**"));
        assert!(instructions.content.contains("steward_suggest"));
        assert!(instructions.content.ends_with(custom));
        assert_eq!(
            steward.bindings().collect::<Vec<_>>(),
            vec![("systemPrompt", custom)]
        );
    }

    #[test]
    fn unsupported_agent_is_rejected_before_launch() {
        assert!(matches!(
            interactive_agent("unknown", "/tmp/project"),
            Err(InvocationError::UnsupportedAgent(_))
        ));
    }

    /// Requires a real `claude`/`codex` on the developer PATH, like every
    /// launch composition test in this module.
    #[test]
    fn spawn_tuple_and_inspector_project_the_same_resolved_cli_target() {
        let launch = interactive_agent("claude", "/tmp/project").unwrap();
        let executable = &launch.inspectable_manifest().target.executable;
        let executable_path = std::path::Path::new(executable);
        assert!(executable_path.is_absolute(), "{executable_path:?}");
        assert!(
            executable_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("claude")),
            "{executable_path:?}"
        );
        let program = std::path::Path::new(launch.program());
        assert!(program.is_absolute(), "{program:?}");
        // The private spawn tuple carries the exact inspected CLI file: as the
        // program itself for native/shebang targets, or as the `cmd.exe`
        // wrapper's script argument for Windows `.cmd` shims.
        assert!(
            launch.program() == executable
                || launch.args().iter().any(|argument| argument == executable),
            "spawn tuple does not carry the inspected target"
        );

        let app_server =
            codex_app_server("ws://127.0.0.1:4567", "/tmp/project", "session-1", None).unwrap();
        assert!(
            std::path::Path::new(app_server.program()).is_absolute(),
            "{:?}",
            app_server.program()
        );
        let expected_suffix = [
            "app-server".to_owned(),
            "--listen".to_owned(),
            "ws://127.0.0.1:4567".to_owned(),
            "-c".to_owned(),
            CODEX_DISABLE_STARTUP_UPDATE_CHECK.to_owned(),
        ];
        assert!(
            app_server.args().ends_with(&expected_suffix),
            "{:?}",
            app_server.args()
        );
        let cargo_target = app_server
            .environment()
            .entries()
            .find(|(key, _)| *key == "CARGO_TARGET_DIR")
            .map(|(_, value)| value)
            .expect("Codex App Server redirects Agent Cargo build output");
        assert_eq!(
            Path::new(cargo_target),
            Path::new("/tmp/project")
                .join("target")
                .join("agents")
                .join("1")
        );
    }

    #[test]
    fn agent_cargo_target_sharding_is_stable_and_bounded() {
        assert_eq!(agent_cargo_target_shard(None), 0);
        assert_eq!(agent_cargo_target_shard(Some("session-1")), 1);
        assert_eq!(agent_cargo_target_shard(Some("session-2")), 0);
        for session_id in ["session-1", "session-2", "019f1dae-3bf3-73d1"] {
            assert!(agent_cargo_target_shard(Some(session_id)) < AGENT_CARGO_TARGET_SHARD_COUNT);
        }
    }

    #[test]
    fn observation_environment_is_explicit_and_never_enters_arguments() {
        let launch = interactive_agent_with_observation(
            "claude",
            "/tmp/project",
            Some(claude_observation(
                "session-1",
                "http://127.0.0.1:123/agent-observation",
                "secret-token",
                "{\"hooks\":{}}",
                "{\"hooks\":{}}",
            )),
        )
        .unwrap();
        assert_eq!(
            launch
                .environment_keys()
                .filter_map(|key| key.to_str())
                .filter(|key| key.starts_with("TERMLOOP_"))
                .collect::<Vec<_>>(),
            [
                "TERMLOOP_SESSION_ID",
                "TERMLOOP_AGENT_ID",
                "TERMLOOP_HOOK_ENDPOINT",
                "TERMLOOP_HOOK_TOKEN"
            ]
        );
        let cargo_target = launch
            .environment()
            .entries()
            .find(|(key, _)| *key == "CARGO_TARGET_DIR")
            .map(|(_, value)| value)
            .expect("Agent launches redirect Cargo build output");
        assert_eq!(
            Path::new(cargo_target),
            Path::new("/tmp/project")
                .join("target")
                .join("agents")
                .join("1")
        );
        // The path exposes only a bounded shard index, never the Session
        // identity or its digest.
        assert_ne!(
            Path::new(cargo_target),
            Path::new("/tmp/project").join("target")
        );
        assert!(!cargo_target.to_string_lossy().contains("session-1"));
        assert!(
            !cargo_target
                .to_string_lossy()
                .contains(content_digest("session-1").trim_start_matches("sha256:"))
        );
        assert!(!launch.args().join(" ").contains("secret-token"));
        assert!(!format!("{launch:?}").contains("secret-token"));
        let public = serde_json::to_string(launch.inspectable_manifest()).unwrap();
        assert!(!public.contains("secret-token"));
        assert!(!public.contains("http://127.0.0.1:123/agent-observation"));
        assert!(public.contains("<redacted secret>"));
        assert!(public.contains("<redacted agent build path>"));
        assert!(!public.contains(&cargo_target.to_string_lossy().into_owned()));
        assert!(public.contains("\"classification\":\"secret\""));
        assert_eq!(launch.inspectable_manifest().generated_files.len(), 1);
        assert_eq!(
            launch.inspectable_manifest().generated_files[0].content,
            "{\"hooks\":{}}"
        );
        assert!(launch.args().iter().any(|arg| arg == "{\"hooks\":{}}"));
    }

    #[test]
    fn gemini_observation_is_a_redacted_launch_scoped_settings_overlay() {
        let private_settings = r#"{"hooks":{"BeforeAgent":[]}}"#;
        let inspectable_settings = r#"{"hooks":{"BeforeAgent":"<redacted hook>"}}"#;
        let launch = interactive_agent_with_observation(
            "gemini",
            "/tmp/project",
            Some(gemini_observation(
                "session-gemini",
                "http://127.0.0.1:123/agent-observation",
                "secret-token",
                "/private/runtime/gemini-defaults.json",
                private_settings,
                inspectable_settings,
            )),
        )
        .unwrap();
        let environment = launch
            .environment()
            .entries()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            environment
                .get("GEMINI_CLI_SYSTEM_DEFAULTS_PATH")
                .map(String::as_str),
            Some("/private/runtime/gemini-defaults.json")
        );
        assert_eq!(
            environment.get("TERMLOOP_AGENT_ID").map(String::as_str),
            Some("gemini")
        );
        assert!(!launch.args().iter().any(|argument| {
            argument.contains("GEMINI_CLI_SYSTEM_DEFAULTS_PATH")
                || argument.contains("secret-token")
        }));
        let public = serde_json::to_string(launch.inspectable_manifest()).unwrap();
        assert!(public.contains("launch-scoped observation settings"));
        assert!(public.contains("<redacted runtime settings path>"));
        assert!(public.contains("<redacted hook>"));
        assert!(!public.contains("secret-token"));
        assert!(!public.contains("/private/runtime/gemini-defaults.json"));
        assert!(!public.contains(private_settings));
    }

    #[test]
    fn observation_transport_identity_cannot_cross_provider_adapters() {
        assert!(matches!(
            interactive_agent_with_observation(
                "claude",
                "/tmp/project",
                Some(gemini_observation(
                    "session",
                    "http://127.0.0.1:123/agent-observation",
                    "token",
                    "/private/gemini.json",
                    "{}",
                    "{}",
                )),
            ),
            Err(InvocationError::InvalidObservationTransport)
        ));
        assert!(matches!(
            interactive_agent_with_observation(
                "gemini",
                "/tmp/project",
                Some(claude_observation(
                    "session",
                    "http://127.0.0.1:123/agent-observation",
                    "token",
                    "{}",
                    "{}",
                )),
            ),
            Err(InvocationError::InvalidObservationTransport)
        ));
    }

    #[test]
    fn gemini_overlay_never_replaces_an_existing_system_defaults_source() {
        let environment = termloop_platform::LaunchEnvironment::os_baseline()
            .with_explicit("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", "/managed/defaults.json");
        let observation = gemini_observation(
            "session",
            "http://127.0.0.1:123/agent-observation",
            "token",
            "/private/gemini.json",
            "{}",
            "{}",
        );
        assert!(observation_environment_conflicts(
            "gemini",
            observation.transport,
            &environment
        ));
        assert!(!observation_environment_conflicts(
            "claude",
            claude_observation(
                "session",
                "http://127.0.0.1:123/agent-observation",
                "token",
                "{}",
                "{}",
            )
            .transport,
            &environment
        ));
    }

    #[test]
    fn claude_inline_settings_keep_private_path_out_of_inspector() {
        let private =
            r#"{"hooks":{"Start":[{"hooks":[{"command":"/poison/private/termloop hook"}]}]}}"#;
        let inspectable = r#"{"hooks":{"Start":[{"hooks":[{"command":"<redacted TermLoop hook executable>"}]}]}}"#;
        let launch = interactive_agent_with_observation(
            "claude",
            "/tmp/project",
            Some(claude_observation(
                "session-1",
                "ws://private-authority",
                "private-token",
                private,
                inspectable,
            )),
        )
        .unwrap();
        assert!(launch.args().iter().any(|argument| argument == private));
        let public = serde_json::to_string(launch.inspectable_manifest()).unwrap();
        assert!(!public.contains("/poison/private"));
        assert!(public.contains("redacted TermLoop hook executable"));
        let artifact = &launch.inspectable_manifest().generated_files[0];
        assert_eq!(artifact.content_visibility, "redacted");
        assert_eq!(artifact.content_classification, "sensitivePath");
        assert_eq!(artifact.byte_length, private.len());
        assert_eq!(artifact.digest, content_digest(private));
    }

    #[test]
    fn preview_and_private_launch_share_one_redacted_manifest_digest() {
        let resume_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Claude,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        let preview = preview_quick_action_for_conversation(
            "claude",
            "/tmp/project",
            "fable",
            "plan",
            "high",
            "Inspect everything",
            AgentConversationLaunch::Fresh {
                resume_ref: Some(&resume_ref),
            },
            Some(claude_observation(
                "preview-session",
                "ws://preview-authority",
                "preview-secret",
                "{\"hooks\":{}}",
                "{\"hooks\":{}}",
            )),
        )
        .unwrap();
        let launch = quick_action_agent_for_conversation(
            "claude",
            "/tmp/project",
            "fable",
            "plan",
            "high",
            "Inspect everything",
            AgentConversationLaunch::Fresh {
                resume_ref: Some(&resume_ref),
            },
            Some(claude_observation(
                "actual-session",
                "ws://actual-authority",
                "actual-secret",
                "{\"hooks\":{}}",
                "{\"hooks\":{}}",
            )),
            None,
        )
        .unwrap();
        assert_eq!(
            preview.manifest.digest,
            launch.inspectable_manifest().digest
        );
        let public = serde_json::to_string(&preview.manifest).unwrap();
        for private in [
            &resume_ref.native_session_id,
            "preview-session",
            "preview-secret",
            "ws://preview-authority",
        ] {
            assert!(!public.contains(private));
        }
        assert_eq!(
            preview.manifest.transport.delivered_content,
            launch.initial_input().unwrap()
        );
    }

    #[test]
    fn codex_app_server_endpoint_is_non_secret_launch_metadata() {
        let launch = interactive_agent_with_observation(
            "codex",
            "/tmp/project",
            Some(codex_observation("ws://127.0.0.1:4567")),
        )
        .unwrap();
        assert_eq!(
            provider_args(&launch),
            [
                "-C",
                "/tmp/project",
                "--remote",
                "ws://127.0.0.1:4567",
                "-c",
                CODEX_DISABLE_STARTUP_UPDATE_CHECK,
            ]
        );
        assert!(
            launch
                .environment_keys()
                .filter_map(|key| key.to_str())
                .all(|key| !key.starts_with("TERMLOOP_"))
        );
        assert!(
            launch
                .environment_keys()
                .any(|key| key == "CARGO_TARGET_DIR")
        );
    }

    #[test]
    fn managed_worktree_trust_is_exact_inspectable_and_codex_scoped() {
        let cwd = "/tmp/managed.project \"quoted\"\\worktree";
        let quoted_cwd = serde_json::to_string(cwd).unwrap();
        let expected = ["projects={", &quoted_cwd, "={trust_level=\"trusted\"}}"].concat();
        let managed = interactive_agent_for_managed_worktree_conversation(
            "codex",
            cwd,
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert!(
            provider_args(&managed)
                .windows(2)
                .any(|arguments| { arguments[0] == "-c" && arguments[1] == expected })
        );
        assert!(
            managed
                .inspectable_manifest()
                .arguments
                .iter()
                .any(|argument| {
                    argument.display == expected
                        && argument.visibility == "exact"
                        && argument.purpose == "TermLoop-managed worktree trust"
                })
        );

        let project = interactive_agent_for_conversation(
            "codex",
            cwd,
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert!(
            provider_args(&project)
                .iter()
                .all(|argument| !argument.contains("trust_level="))
        );

        let claude = interactive_agent_for_managed_worktree_conversation(
            "claude",
            cwd,
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert!(
            provider_args(&claude)
                .iter()
                .all(|argument| !argument.contains("trust_level="))
        );

        let source_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "managed-fork-source".into(),
        )
        .unwrap();
        let fork = interactive_agent_for_managed_worktree_conversation(
            "codex",
            cwd,
            AgentConversationLaunch::Fork {
                source_ref: &source_ref,
            },
            None,
            None,
        )
        .unwrap();
        assert!(
            provider_args(&fork)
                .windows(2)
                .any(|arguments| { arguments[0] == "-c" && arguments[1] == expected })
        );

        let app_server = codex_app_server_for_managed_worktree(
            "ws://127.0.0.1:4567",
            cwd,
            "managed-session",
            None,
        )
        .unwrap();
        assert!(
            app_server_args(&app_server)
                .windows(2)
                .any(|arguments| { arguments[0] == "-c" && arguments[1] == expected })
        );
        let project_app_server =
            codex_app_server("ws://127.0.0.1:4567", cwd, "project-session", None).unwrap();
        assert!(
            app_server_args(&project_app_server)
                .iter()
                .all(|argument| !argument.contains("trust_level="))
        );
    }

    #[test]
    fn codex_runtime_binding_replaces_only_the_invocation_placeholder() {
        let placeholder_launch = || {
            interactive_agent_with_observation(
                "codex",
                "/tmp/project",
                Some(codex_observation(CODEX_APP_SERVER_RUNTIME_PLACEHOLDER)),
            )
            .unwrap()
        };
        let mut launch = placeholder_launch();

        launch
            .bind_codex_app_server_endpoint("ws://127.0.0.1:4567")
            .unwrap();
        assert_eq!(
            provider_args(&launch),
            [
                "-C",
                "/tmp/project",
                "--remote",
                "ws://127.0.0.1:4567",
                "-c",
                CODEX_DISABLE_STARTUP_UPDATE_CHECK,
            ]
        );
        assert!(matches!(
            launch.bind_codex_app_server_endpoint("ws://127.0.0.1:4568"),
            Err(InvocationError::InvalidRuntimeBinding)
        ));

        for invalid in [
            "ws://localhost:4567",
            "ws://127.0.0.1:0",
            "ws://127.0.0.1:4567/path",
            "https://127.0.0.1:4567",
        ] {
            assert!(matches!(
                placeholder_launch().bind_codex_app_server_endpoint(invalid),
                Err(InvocationError::InvalidRuntimeBinding)
            ));
        }
    }

    #[test]
    fn provider_resume_arguments_are_private_and_preserve_observation_args() {
        let claude_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Claude,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        let fresh = interactive_agent_for_conversation(
            "claude",
            "/tmp/project",
            AgentConversationLaunch::Fresh {
                resume_ref: Some(&claude_ref),
            },
            Some(claude_observation(
                "session-1",
                "http://127.0.0.1:123/agent-observation",
                "secret-token",
                "{\"hooks\":{}}",
                "{\"hooks\":{}}",
            )),
            Some(AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "mcp-secret",
                claude_config_path: "/tmp/termloop-mcp.json",
                profile: AgentMcpProfile::Interactive,
            }),
        )
        .unwrap();
        assert_eq!(
            provider_args(&fresh),
            [
                "--session-id",
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035",
                "--permission-mode",
                "auto",
                "--settings",
                "{\"hooks\":{}}",
                "--mcp-config",
                "/tmp/termloop-mcp.json",
                "--append-system-prompt",
                INTERACTIVE_AGENT_TEMPLATE.authored_body,
            ]
        );
        assert!(
            fresh
                .inspectable_manifest()
                .content_parts
                .iter()
                .any(|part| part.delivery == "claudeAppendedSystemPrompt"
                    && part.content.contains("structured plan or task list"))
        );
        assert!(!format!("{fresh:?}").contains(&claude_ref.native_session_id));

        let codex_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036".into(),
        )
        .unwrap();
        let resumed = interactive_agent_for_conversation(
            "codex",
            "/tmp/project",
            AgentConversationLaunch::Resume {
                resume_ref: &codex_ref,
            },
            Some(codex_observation("ws://127.0.0.1:4567")),
            Some(AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "mcp-secret",
                claude_config_path: "/unused.json",
                profile: AgentMcpProfile::Interactive,
            }),
        )
        .unwrap();
        assert_eq!(
            &provider_args(&resumed)[..10],
            [
                "resume",
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036",
                "-C",
                "/tmp/project",
                "--remote",
                "ws://127.0.0.1:4567",
                "-c",
                "mcp_servers.termloop_next.url=\"http://127.0.0.1:1234/mcp\"",
                "-c",
                "mcp_servers.termloop_next.bearer_token_env_var=\"TERMLOOP_MCP_TOKEN\""
            ]
        );
        assert_eq!(provider_args(&resumed)[10], "-c");
        assert!(provider_args(&resumed)[11].starts_with("developer_instructions="));
        assert!(provider_args(&resumed).ends_with(&[
            "-c".to_owned(),
            CODEX_DISABLE_STARTUP_UPDATE_CHECK.to_owned(),
        ]));
        assert!(
            resumed
                .inspectable_manifest()
                .arguments
                .iter()
                .any(|argument| {
                    argument.display == CODEX_DISABLE_STARTUP_UPDATE_CHECK
                        && argument.visibility == "exact"
                        && argument.purpose == "non-interactive provider startup"
                })
        );
        assert!(!format!("{resumed:?}").contains(&codex_ref.native_session_id));

        let claude_fork = interactive_agent_for_conversation(
            "claude",
            "/tmp/project",
            AgentConversationLaunch::Fork {
                source_ref: &claude_ref,
            },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            provider_args(&claude_fork),
            [
                "--resume",
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035",
                "--fork-session",
                "--permission-mode",
                "auto"
            ]
        );
        assert!(!format!("{claude_fork:?}").contains(&claude_ref.native_session_id));

        let codex_fork = interactive_agent_for_conversation(
            "codex",
            "/tmp/project",
            AgentConversationLaunch::Fork {
                source_ref: &codex_ref,
            },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            provider_args(&codex_fork),
            [
                "fork",
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036",
                "-C",
                "/tmp/project",
                "-c",
                CODEX_DISABLE_STARTUP_UPDATE_CHECK,
            ]
        );
        assert!(!format!("{codex_fork:?}").contains(&codex_ref.native_session_id));
    }

    #[test]
    fn an_unconfigured_claude_opens_in_auto_mode_on_launch_and_resume() {
        assert_eq!(default_permission("claude"), "acceptEdits");
        assert_eq!(default_permission("codex"), "default");

        let fresh = interactive_agent_for_conversation(
            "claude",
            "/tmp/project",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(&provider_args(&fresh)[..2], ["--permission-mode", "auto"]);

        // Resume reapplies the Session's recorded selection. Core records the
        // same default it launched with, so the mode survives an app restart
        // instead of falling back to Claude's ask-every-time mode.
        let resume_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Claude,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        let resumed = configured_interactive_agent_for_conversation(
            "claude",
            "/tmp/project",
            "default",
            default_permission("claude"),
            "default",
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            &provider_args(&resumed)[..4],
            [
                "--resume",
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035",
                "--permission-mode",
                "auto"
            ]
        );

        // Codex keeps its own provider default, so no permission argument is
        // composed for an unconfigured Codex launch.
        let codex = interactive_agent_for_conversation(
            "codex",
            "/tmp/project",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert!(
            !provider_args(&codex)
                .iter()
                .any(|argument| argument == "--permission-mode")
        );
    }

    #[test]
    fn launch_local_mcp_keeps_bearer_out_of_arguments_and_debug() {
        let claude = interactive_agent_for_conversation(
            "claude",
            "/tmp/project",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            Some(AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "secret-mcp-token",
                claude_config_path: "/private/runtime/agent-mcp.json",
                profile: AgentMcpProfile::Interactive,
            }),
        )
        .unwrap();
        assert_eq!(
            provider_args(&claude),
            [
                "--permission-mode",
                "auto",
                "--mcp-config",
                "/private/runtime/agent-mcp.json",
                "--append-system-prompt",
                INTERACTIVE_AGENT_TEMPLATE.authored_body,
            ]
        );
        assert!(!claude.args().join(" ").contains("secret-mcp-token"));
        assert!(!format!("{claude:?}").contains("secret-mcp-token"));

        let codex = interactive_agent_for_conversation(
            "codex",
            "/tmp/project",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            Some(AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "secret-mcp-token",
                claude_config_path: "/unused.json",
                profile: AgentMcpProfile::Interactive,
            }),
        )
        .unwrap();
        assert_eq!(
            &provider_args(&codex)[..6],
            [
                "-C",
                "/tmp/project",
                "-c",
                "mcp_servers.termloop_next.url=\"http://127.0.0.1:1234/mcp\"",
                "-c",
                "mcp_servers.termloop_next.bearer_token_env_var=\"TERMLOOP_MCP_TOKEN\""
            ]
        );
        assert_eq!(provider_args(&codex)[6], "-c");
        assert!(provider_args(&codex)[7].starts_with("developer_instructions="));
        assert!(!provider_args(&codex)[7].contains("session_topic_update"));
        assert_eq!(codex.initial_input(), None);
        assert_eq!(
            codex.inspectable_manifest().transport.kind,
            "codexDeveloperInstructions"
        );
        assert!(
            codex
                .inspectable_manifest()
                .content_parts
                .iter()
                .any(|part| {
                    part.id == "interactive-session-protocol"
                        && part.delivery == "codexDeveloperInstructions"
                        && !part.content.contains("session_topic_update")
                })
        );
        assert!(!codex.args().join(" ").contains("secret-mcp-token"));
        assert!(!format!("{codex:?}").contains("secret-mcp-token"));
        assert_eq!(
            codex
                .environment_keys()
                .filter_map(|key| key.to_str())
                .filter(|key| *key == "TERMLOOP_MCP_TOKEN")
                .collect::<Vec<_>>(),
            ["TERMLOOP_MCP_TOKEN"]
        );

        let app_server = codex_app_server(
            "ws://127.0.0.1:4567",
            "/tmp/project",
            "session-1",
            Some(AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "secret-mcp-token",
                claude_config_path: "/unused.json",
                profile: AgentMcpProfile::Interactive,
            }),
        )
        .unwrap();
        assert_eq!(
            &app_server_args(&app_server)[..7],
            [
                "app-server",
                "--listen",
                "ws://127.0.0.1:4567",
                "-c",
                "mcp_servers.termloop_next.url=\"http://127.0.0.1:1234/mcp\"",
                "-c",
                "mcp_servers.termloop_next.bearer_token_env_var=\"TERMLOOP_MCP_TOKEN\""
            ]
        );
        assert_eq!(app_server_args(&app_server)[7], "-c");
        assert!(app_server_args(&app_server)[8].starts_with("developer_instructions="));
        assert!(!app_server_args(&app_server)[8].contains("session_topic_update"));
        assert!(!app_server.args().join(" ").contains("secret-mcp-token"));
        assert!(!format!("{app_server:?}").contains("secret-mcp-token"));
        assert!(
            app_server
                .environment()
                .keys()
                .any(|key| key == "TERMLOOP_MCP_TOKEN")
        );
    }

    #[test]
    fn ask_to_helper_uses_visible_bound_prompt_as_the_delivered_initial_turn() {
        let launch = ask_to_helper_agent_for_conversation(
            "claude",
            "/tmp/project",
            AgentConversationLaunch::Fresh { resume_ref: None },
            "request-1",
            "Review the race.",
            None,
            AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "secret-mcp-token",
                claude_config_path: "/private/runtime/agent-mcp.json",
                profile: AgentMcpProfile::Helper,
            },
        )
        .unwrap();
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.ask-to-helper"
        );
        assert_eq!(launch.provenance().template_version, 2);
        let delivered = launch.delivered_prompt().expect("initial prompt");
        assert!(launch.args().iter().any(|argument| argument == delivered));
        let delimiter = launch
            .args()
            .iter()
            .position(|argument| argument == "--")
            .expect("Claude option terminator");
        assert_eq!(
            &launch.args()[delimiter.saturating_sub(2)..delimiter],
            ["--mcp-config", "/private/runtime/agent-mcp.json"]
        );
        assert_eq!(
            launch.args().get(delimiter + 1),
            Some(&delivered.to_owned())
        );
        assert_eq!(
            launch.bindings().collect::<Vec<_>>(),
            [("request_id", "request-1"), ("message", "Review the race.")]
        );
        assert!(delivered.contains("request-1"));
        assert!(delivered.contains("Review the race."));
        assert!(delivered.contains("mcp__termloop_next__reply_to_request"));
        assert!(delivered.contains("ordinary terminal text does\nnot deliver"));
        assert!(!delivered.contains("{{"));
        assert!(!format!("{launch:?}").contains("secret-mcp-token"));

        let codex = ask_to_helper_agent_for_conversation(
            "codex",
            "/tmp/project",
            AgentConversationLaunch::Fresh { resume_ref: None },
            "request-3",
            "Write a poem.",
            None,
            AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "secret-mcp-token",
                claude_config_path: "/unused.json",
                profile: AgentMcpProfile::Helper,
            },
        )
        .unwrap();
        let codex_delimiter = codex
            .args()
            .iter()
            .position(|argument| argument == "--")
            .expect("Codex option terminator");
        assert_eq!(
            codex.args().get(codex_delimiter + 1),
            Some(&codex.delivered_prompt().unwrap().to_owned())
        );

        let literal_placeholder = ask_to_helper_agent_for_conversation(
            "claude",
            "/tmp/project",
            AgentConversationLaunch::Fresh { resume_ref: None },
            "request-2",
            "Explain {{request_id}} literally.",
            None,
            AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "secret-mcp-token",
                claude_config_path: "/private/runtime/agent-mcp.json",
                profile: AgentMcpProfile::Helper,
            },
        )
        .unwrap();
        assert!(
            literal_placeholder
                .delivered_prompt()
                .unwrap()
                .contains("Explain {{request_id}} literally.")
        );
    }

    #[test]
    fn ask_to_helper_resume_recovery_is_visible_bounded_and_secret_free() {
        let resume_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Claude,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        let launch = configured_ask_to_helper_for_conversation_resume(
            "claude",
            "/tmp/project",
            "default",
            "default",
            "default",
            Some("request-1"),
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
            Some(AgentMcpLaunch {
                endpoint: "http://127.0.0.1:1234/mcp",
                token: "fresh-secret-token",
                claude_config_path: "/private/runtime/agent-mcp.json",
                profile: AgentMcpProfile::Helper,
            }),
        )
        .unwrap();
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.ask-to-resume"
        );
        assert_eq!(launch.provenance().template_version, 1);
        assert!(
            launch
                .initial_input()
                .is_some_and(|prompt| prompt.contains("request-1") && prompt.contains("restarted"))
        );
        assert!(!launch.args().join(" ").contains("fresh-secret-token"));
        assert!(!format!("{launch:?}").contains("fresh-secret-token"));

        let idle = configured_ask_to_helper_for_conversation_resume(
            "claude",
            "/tmp/project",
            "default",
            "default",
            "default",
            None,
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
            None,
        )
        .unwrap();
        assert_eq!(idle.initial_input(), None);
    }

    #[test]
    fn ask_to_follow_up_is_visible_versioned_and_terminal_safe() {
        let prompt = ask_to_follow_up_prompt(
            "request-2",
            "Consider your first answer and give one more example.\nKeep it brief.",
        )
        .unwrap();
        assert_eq!(
            prompt.provenance().template_ref,
            "builtin.agent.ask-to-followup"
        );
        assert_eq!(prompt.provenance().template_version, 1);
        assert_eq!(
            prompt.bindings().collect::<Vec<_>>(),
            [
                ("request_id", "request-2"),
                (
                    "message",
                    "Consider your first answer and give one more example.\nKeep it brief."
                )
            ]
        );
        assert!(prompt.delivered_prompt().contains("request-2"));
        assert!(prompt.delivered_prompt().contains("Consider your first answer"));
        assert!(!prompt.delivered_prompt().contains("{{"));
        assert_terminal_submission(prompt.terminal_input_sequence(), prompt.delivered_prompt());

        assert!(matches!(
            ask_to_follow_up_prompt("request-3", "unsafe\u{1b}[201~payload"),
            Err(InvocationError::InvalidPromptBinding)
        ));
    }

    #[test]
    fn ask_to_reply_is_one_visible_terminal_safe_delivery() {
        let prompt = ask_to_reply_prompt(
            "request-4",
            "conversation-2",
            "helper-7",
            "Final answer with literal {{message}} text.",
        )
        .unwrap();
        assert_eq!(
            prompt.provenance().template_ref,
            "builtin.agent.ask-to-reply"
        );
        assert_eq!(prompt.provenance().template_version, 1);
        assert!(
            prompt
                .delivered_prompt()
                .contains("TermLoop Ask-To final reply")
        );
        assert!(prompt.delivered_prompt().contains("conversation-2"));
        assert!(prompt.delivered_prompt().contains("helper-7"));
        assert!(
            prompt
                .delivered_prompt()
                .contains("Final answer with literal {{message}} text.")
        );
        assert_terminal_submission(prompt.terminal_input_sequence(), prompt.delivered_prompt());
        assert!(matches!(
            ask_to_reply_prompt(
                "request-4",
                "conversation-2",
                "helper-7",
                "unsafe\u{1b}[201~answer"
            ),
            Err(InvocationError::InvalidPromptBinding)
        ));
    }

    #[test]
    fn steward_prompt_completes_explicit_task_worktree_and_agent_requests() {
        let prompt = executor_prompt(ExecutorRole::Steward).unwrap();
        assert_eq!(prompt.provenance().template_version, 31);
        assert!(prompt.authored_preview().contains("routine_finding_read"));
        assert!(prompt.authored_preview().contains("playbook_read"));
        assert!(prompt.authored_preview().contains("task_set_steward_brief"));
        assert!(prompt.authored_preview().contains("task_agent_start"));
        assert!(prompt.authored_preview().contains("inputMode: voice"));
        assert!(
            prompt
                .authored_preview()
                .contains("idempotent and safe to retry")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("steward_system_prompt_update")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("exact newest visible\nProject chat")
        );
        assert!(prompt.authored_preview().contains("user-authored"));
        assert!(
            prompt
                .authored_preview()
                .contains("steward_system_prompt_read")
        );
        assert!(prompt.authored_preview().contains("expectedSystemPrompt"));
        assert!(
            prompt
                .authored_preview()
                .contains("`update`: factual movement")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("`attention`: the user's own action")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("chat-visible reminder is already")
        );
        assert!(prompt.authored_preview().contains("runtime"));
        assert!(prompt.authored_preview().contains("kind `acceptance`"));
        assert!(
            prompt
                .authored_preview()
                .contains("Never use\n`suggestion` for progress")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("protected built-in\nlayer is never caller input")
        );
        assert!(
            !prompt
                .authored_preview()
                .contains("task_worktree_provision")
        );
        assert!(!prompt.authored_preview().contains("task_agent_launch"));
        assert!(
            prompt
                .authored_preview()
                .contains("A Task Agent request is complete only when")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("When a Task Agent sends its assignment report")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("call `agent_message_send` to the same running Source Session")
        );
        assert!(prompt.authored_preview().contains("call `task_close`"));
        assert!(
            prompt
                .authored_preview()
                .contains("Speak like a Project Manager")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("follow their descriptions for exact arguments")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("rolling Routine context")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("A finding is a Worker's factual observation")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("set `refs.routineFindingIds` to\nevery exact `findings[].id`")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("Never use a Routine\n`routineId`")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("`proposalPending` refusal")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("downgrade the\nwould-be action to `attention`")
        );

        assert!(
            prompt
                .authored_preview()
                .contains("concise, decisive `steward_suggest` messages")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("dominant language of\nthe newest user message")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("Preserve exact identifiers, commands, errors")
        );
        assert!(
            prompt
                .authored_preview()
                .contains("does not compress Task briefs, Agent messages")
        );

        let retired =
            include_str!("../../../resources/prompts/retired/builtin.steward.executor.v2.md")
                .splitn(3, "\n\n")
                .nth(2)
                .unwrap()
                .trim();
        assert_eq!(
            resolved_steward_system_prompt(retired),
            default_steward_system_prompt()
        );
        let latest_retired =
            include_str!("../../../resources/prompts/retired/builtin.steward.executor.v29.md")
                .splitn(3, "\n\n")
                .nth(2)
                .unwrap()
                .trim();
        assert_eq!(
            resolved_steward_system_prompt(latest_retired),
            default_steward_system_prompt()
        );
        assert_eq!(
            resolved_steward_system_prompt("custom PM policy"),
            "custom PM policy"
        );
        let effective = effective_steward_system_prompt("custom PM policy");
        assert!(effective.starts_with(default_steward_system_prompt()));
        assert!(effective.ends_with("custom PM policy"));
        assert_eq!(
            editable_steward_system_prompt_from_effective(&effective),
            Some("custom PM policy")
        );
        assert_eq!(
            editable_steward_system_prompt_from_effective(default_steward_system_prompt()),
            Some("")
        );
        assert_eq!(
            editable_steward_system_prompt_from_effective("changed protected beginning"),
            None
        );

        let source = effective_steward_system_prompt(
            "Keep this first.\n\nRemove this middle instruction.\n\nKeep this last.",
        );
        let modified = source.replace("\n\nRemove this middle instruction.", "");
        assert_eq!(
            editable_steward_system_prompt_from_effective(&modified),
            Some("Keep this first.\n\nKeep this last.")
        );
    }

    #[test]
    fn pipeline_prompts_treat_a_step_title_as_a_label_not_a_yes_no_contract() {
        let worker = executor_prompt(ExecutorRole::Worker).unwrap();
        assert_eq!(worker.provenance().template_version, 19);
        assert!(
            worker
                .authored_preview()
                .contains("question, goal, activity, approval, or waiting condition")
        );
        assert!(
            worker
                .authored_preview()
                .contains("complete next-run memory")
        );
        assert!(
            worker
                .authored_preview()
                .contains("completedContextPreserved")
        );
        assert!(
            worker
                .authored_preview()
                .contains("exactly one focused Task")
        );
        assert!(worker.authored_preview().contains("`step.tasks[0].taskId`"));
        assert!(
            worker
                .authored_preview()
                .contains("`step.taskRead.arguments`")
        );
        assert!(worker.authored_preview().contains("terminal's cwd or HEAD"));
        assert!(
            worker
                .authored_preview()
                .contains("sole authority for the request target")
        );
        assert!(
            worker
                .authored_preview()
                .contains("resolve and attempt that exposed capability")
        );
        assert!(
            worker
                .authored_preview()
                .contains("absence of the outcome is not an access or configuration problem")
        );
        assert!(
            worker
                .authored_preview()
                .contains("rejects a step verdict unless")
        );

        let step = tracker_assignment_prompt(ExecutorRole::StepCheckTracker).unwrap();
        assert_eq!(step.provenance().template_version, 7);
        assert!(step.delivered_preview().contains("Its `title` is a label"));
        assert!(
            step.delivered_preview()
                .contains("Its `condition` states the")
        );
        assert!(
            step.delivered_preview()
                .contains("exactly one focused Task")
        );
        assert!(!step.delivered_preview().contains("one yes/no question"));
    }

    #[test]
    fn steward_wakes_are_reason_specific_and_silent_for_housekeeping() {
        let user = assistant_wake_message(
            ExecutorRole::Steward,
            AssistantWakeReason::StewardUserMessage,
            None,
            None,
        )
        .unwrap();
        let pipeline = assistant_wake_message(
            ExecutorRole::Steward,
            AssistantWakeReason::StewardPipelineMoved,
            None,
            None,
        )
        .unwrap();
        let startup = assistant_wake_message(
            ExecutorRole::Steward,
            AssistantWakeReason::StewardStartupRefresh,
            None,
            None,
        )
        .unwrap();
        let finding = assistant_wake_message(
            ExecutorRole::Steward,
            AssistantWakeReason::StewardRoutineFinding,
            None,
            None,
        )
        .unwrap();
        let combined = assistant_wake_message(
            ExecutorRole::Steward,
            AssistantWakeReason::StewardPipelineMovedAndRoutineFinding,
            None,
            None,
        )
        .unwrap();

        assert_eq!(user.provenance().template_version, 9);
        assert!(user.delivered_preview().contains("**User message** row"));
        assert!(
            user.delivered_preview()
                .contains("mutation receipt may fully satisfy")
        );
        assert!(user.delivered_preview().contains("kind `acceptance`"));
        assert!(
            user.delivered_preview()
                .contains("legacy exact reply `Accepted. Proceed with this suggestion.`")
        );
        assert!(
            user.delivered_preview()
                .contains("Never stand by silently after an acceptance")
        );
        assert!(
            !user
                .delivered_preview()
                .contains("Call `steward_suggest` exactly once")
        );
        assert!(
            pipeline
                .delivered_preview()
                .contains("delivery pipeline moved")
        );
        assert!(
            pipeline
                .delivered_preview()
                .contains("visible Steward wake protocol")
        );
        assert!(
            startup
                .delivered_preview()
                .contains("**Startup refresh** row")
        );
        assert!(
            startup
                .delivered_preview()
                .contains("unhandled typed `acceptance`")
        );
        assert!(
            finding
                .delivered_preview()
                .contains("**New Routine finding** row")
        );
        assert!(
            finding
                .delivered_preview()
                .contains("Routine-finding policy")
        );
        assert!(
            combined
                .delivered_preview()
                .contains("**Movement plus finding** row")
        );
        assert!(combined.delivered_preview().contains("separate"));
    }

    #[test]
    fn steward_agent_message_is_visible_versioned_and_terminal_safe() {
        let prompt =
            steward_agent_message_prompt("Please investigate Task oauth-callback.").unwrap();
        assert_eq!(
            prompt.provenance().template_ref,
            "builtin.steward.agent-message"
        );
        assert_eq!(prompt.provenance().template_version, 1);
        assert_eq!(
            prompt.bindings().collect::<Vec<_>>(),
            [("message", "Please investigate Task oauth-callback.")]
        );
        assert!(
            prompt
                .delivered_prompt()
                .contains("Project Steward coordination")
        );
        assert!(prompt.delivered_prompt().contains("oauth-callback"));
        assert!(!prompt.delivered_prompt().contains("{{message}}"));
        assert_terminal_submission(prompt.terminal_input_sequence(), prompt.delivered_prompt());
        assert!(matches!(
            steward_agent_message_prompt("unsafe\u{1b}[201~message"),
            Err(InvocationError::InvalidPromptBinding)
        ));
    }

    #[test]
    fn agent_handoff_is_visible_versioned_and_terminal_safe() {
        let source = "123e4567-e89b-42d3-a456-426614174000";
        let prompt = agent_handoff_prompt(source, "Review the current diff.").unwrap();
        assert_eq!(prompt.provenance().template_ref, "builtin.agent.handoff");
        assert_eq!(prompt.provenance().template_version, 1);
        assert_eq!(
            prompt.bindings().collect::<Vec<_>>(),
            [
                ("source_session_id", source),
                ("message", "Review the current diff.")
            ]
        );
        assert!(prompt.delivered_prompt().contains(source));
        assert!(
            prompt
                .delivered_prompt()
                .contains("Review the current diff.")
        );
        assert!(!prompt.delivered_prompt().contains("{{message}}"));
        assert_terminal_submission(prompt.terminal_input_sequence(), prompt.delivered_prompt());
        assert!(matches!(
            agent_handoff_prompt(source, "unsafe\u{1b}[201~message"),
            Err(InvocationError::InvalidPromptBinding)
        ));
    }

    #[test]
    fn agent_menu_coordination_requests_are_visible_versioned_and_terminal_safe() {
        let ask = agent_menu_ask_to_prompt("codex").unwrap();
        assert_eq!(ask.provenance().template_ref, "builtin.agent.menu-ask-to");
        assert_eq!(ask.provenance().template_version, 1);
        assert_eq!(
            ask.bindings().collect::<Vec<_>>(),
            [("target_agent", "codex")]
        );
        assert!(ask.delivered_prompt().contains("Agents → Ask to"));
        assert!(ask.delivered_prompt().contains("ask codex for help"));
        assert!(ask.delivered_prompt().contains("`ask_to`"));
        assert_terminal_submission(ask.terminal_input_sequence(), ask.delivered_prompt());
        assert!(matches!(
            agent_menu_ask_to_prompt("other"),
            Err(InvocationError::InvalidPromptBinding)
        ));

        let target = "123e4567-e89b-42d3-a456-426614174001";
        let handover = agent_menu_handover_to_prompt(target).unwrap();
        assert_eq!(
            handover.provenance().template_ref,
            "builtin.agent.menu-handover-to"
        );
        assert_eq!(handover.provenance().template_version, 1);
        assert_eq!(
            handover.bindings().collect::<Vec<_>>(),
            [("target_session_id", target)]
        );
        assert!(handover.delivered_prompt().contains(target));
        assert!(handover.delivered_prompt().contains("`send_to_agent`"));
        assert_terminal_submission(
            handover.terminal_input_sequence(),
            handover.delivered_prompt(),
        );
        assert!(matches!(
            agent_menu_handover_to_prompt("not-a-session"),
            Err(InvocationError::InvalidPromptBinding)
        ));
    }

    #[test]
    fn project_task_kickoff_is_visible_versioned_and_launch_bound() {
        let prompt = task_kickoff_prompt(
            "task-123",
            "Fix OAuth callback",
            Some("Reproduce the redirect failure."),
            Some("https://example.atlassian.net/browse/TERM-42"),
            "Implement the fix and run focused tests.",
        )
        .unwrap();
        assert_eq!(
            prompt.provenance().template_ref,
            "builtin.agent.task-kickoff"
        );
        assert_eq!(prompt.provenance().template_version, 2);
        assert_eq!(
            prompt.delivered_prompt(),
            "Implement the fix and run focused tests.\n\nTask: Fix OAuth callback\nJira: https://example.atlassian.net/browse/TERM-42\nContext: Reproduce the redirect failure."
        );
        assert!(
            prompt
                .delivered_prompt()
                .contains("Jira: https://example.atlassian.net/browse/TERM-42")
        );
        assert!(
            prompt
                .delivered_prompt()
                .contains("Context: Reproduce the redirect failure.")
        );
        assert!(prompt.delivered_prompt().contains("run focused tests"));
        assert!(!prompt.delivered_prompt().contains("Kickoff ID"));
        assert!(!prompt.delivered_prompt().contains("Task kickoff"));
        assert!(
            !prompt
                .delivered_prompt()
                .contains("builtin.agent.task-kickoff")
        );
        assert!(!prompt.delivered_prompt().contains("version:"));
        assert!(!prompt.delivered_prompt().contains("Report progress"));
        assert!(!prompt.delivered_prompt().contains("{{kickoff_message}}"));
        assert_terminal_submission(prompt.terminal_input_sequence(), prompt.delivered_prompt());
        assert!(matches!(
            task_kickoff_prompt("task", "Title", None, None, "unsafe\u{1b}message"),
            Err(InvocationError::InvalidPromptBinding)
        ));

        let launch = task_agent_with_kickoff_for_conversation(
            "codex",
            "/tmp/project",
            "gpt-5.6-sol",
            "default",
            "high",
            "task-123",
            "Fix OAuth callback",
            Some("Reproduce the redirect failure."),
            Some("https://example.atlassian.net/browse/TERM-42"),
            "Implement the fix and run focused tests.",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.task-kickoff"
        );
        assert_eq!(
            launch.inspectable_manifest().transport.kind,
            "terminalInput"
        );
        assert!(launch.initial_input().is_some_and(|input| {
            input.starts_with("Implement the fix and run focused tests.")
                && input.contains("Task: Fix OAuth callback")
                && !input.contains("Kickoff ID")
        }));
    }

    #[test]
    fn steward_task_assignment_is_stable_visible_and_terminal_safe() {
        let without_jira = steward_task_assignment_prompt(
            "task-123",
            "123e4567-e89b-42d3-a456-426614174000",
            "Fix OAuth callback",
            Some("Reproduce the redirect failure."),
            None,
            "Implement the fix and run focused tests.",
        )
        .unwrap();
        assert!(!without_jira.delivered_prompt().contains("Jira issue:"));
        let prompt = steward_task_assignment_prompt(
            "task-123",
            "123e4567-e89b-42d3-a456-426614174000",
            "Fix OAuth callback",
            Some("Reproduce the redirect failure."),
            Some("https://example.atlassian.net/browse/TERM-42"),
            "Implement the fix and run focused tests.",
        )
        .unwrap();
        assert_eq!(
            prompt.provenance().template_ref,
            "builtin.steward.task-assignment"
        );
        assert_eq!(prompt.provenance().template_version, 3);
        assert!(
            prompt
                .delivered_prompt()
                .contains("Assignment ID: `task-agent-start:task-123`")
        );
        assert!(prompt.delivered_prompt().contains("Fix OAuth callback"));
        assert!(
            prompt
                .delivered_prompt()
                .contains("Steward Session ID: `123e4567-e89b-42d3-a456-426614174000`")
        );
        assert!(
            prompt
                .delivered_prompt()
                .contains("call `send_to_agent` once")
        );
        assert!(
            prompt
                .delivered_prompt()
                .contains("Jira issue: https://example.atlassian.net/browse/TERM-42")
        );
        assert!(prompt.delivered_prompt().contains("run focused tests"));
        assert!(!prompt.delivered_prompt().contains("{{assignment}}"));
        assert_terminal_submission(prompt.terminal_input_sequence(), prompt.delivered_prompt());
        assert!(matches!(
            steward_task_assignment_prompt(
                "task",
                "123e4567-e89b-42d3-a456-426614174000",
                "Title",
                None,
                None,
                "unsafe\u{1b}[201~message"
            ),
            Err(InvocationError::InvalidPromptBinding)
        ));
        assert!(matches!(
            steward_task_assignment_prompt(
                "task",
                "123e4567-e89b-42d3-a456-426614174000",
                "Title",
                None,
                Some("https://example.atlassian.net/browse/TERM-42\u{1b}"),
                "Implement"
            ),
            Err(InvocationError::InvalidPromptBinding)
        ));

        let launch = steward_task_agent_for_conversation(
            "codex",
            "/tmp/project",
            "default",
            "default",
            "default",
            "task-123",
            "123e4567-e89b-42d3-a456-426614174000",
            "Fix OAuth callback",
            Some("Reproduce the redirect failure."),
            Some("https://example.atlassian.net/browse/TERM-42"),
            "Implement the fix and run focused tests.",
            AgentConversationLaunch::Fresh { resume_ref: None },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            launch.provenance().template_ref,
            "builtin.steward.task-assignment"
        );
        assert!(
            launch
                .initial_input()
                .is_some_and(|input| input.contains("Assignment ID: `task-agent-start:task-123`"))
        );
        assert!(launch.initial_input().is_some_and(|input| {
            input.contains("Jira issue: https://example.atlassian.net/browse/TERM-42")
        }));
        assert_eq!(
            launch.inspectable_manifest().transport.kind,
            "terminalInput"
        );
    }

    #[test]
    fn worktree_relocation_manifest_and_delivered_payload_are_one_resolution() {
        let resume_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "thread-relocation".into(),
        )
        .unwrap();
        let launch = configured_interactive_agent_for_worktree_relocation(
            "codex",
            "/repo/main",
            "/repo/.worktrees/task-42",
            "task-42",
            "Repair relocation",
            "gpt-5.6-sol",
            "acceptEdits",
            "high",
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.worktree-relocation"
        );
        assert_eq!(launch.provenance().template_version, 1);
        assert_eq!(
            launch.bindings().collect::<Vec<_>>(),
            [
                ("task_id", "task-42"),
                ("task_title", "Repair relocation"),
                ("source_cwd", "/repo/main"),
                ("target_cwd", "/repo/.worktrees/task-42"),
            ]
        );
        let delivered = launch.delivered_prompt().unwrap();
        assert_eq!(
            launch.initial_input(),
            Some(format!("{delivered}\r").as_str())
        );
        assert!(delivered.contains("paths, Git state, repository instructions"));
        assert!(delivered.contains("/repo/main"));
        assert!(delivered.contains("/repo/.worktrees/task-42"));
        assert_eq!(
            launch.inspectable_manifest().content_parts[0].content,
            delivered
        );
        assert_eq!(
            launch.inspectable_manifest().transport.delivered_content,
            format!("{delivered}\r")
        );
        assert_eq!(
            launch.inspectable_manifest().target.cwd,
            "/repo/.worktrees/task-42"
        );
        assert_eq!(launch.inspectable_manifest().target.conversation, "resume");
        assert!(provider_args(&launch).starts_with(&[
            "resume".to_owned(),
            "thread-relocation".to_owned(),
            "-C".to_owned(),
            "/repo/.worktrees/task-42".to_owned(),
        ]));
        assert!(provider_args(&launch).windows(2).any(|arguments| {
            arguments
                == [
                    "-c",
                    "projects={\"/repo/.worktrees/task-42\"={trust_level=\"trusted\"}}",
                ]
        }));
        assert!(
            launch
                .inspectable_manifest()
                .arguments
                .iter()
                .any(|argument| {
                    argument.display == "/repo/.worktrees/task-42"
                        && argument.visibility == "exact"
                        && argument.purpose == "working directory"
                })
        );
        assert!(!format!("{launch:?}").contains("thread-relocation"));
    }

    #[test]
    fn project_relocation_manifest_resumes_in_project_with_visible_provenance() {
        let resume_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "thread-project-relocation".into(),
        )
        .unwrap();
        let launch = configured_interactive_agent_for_project_relocation(
            "codex",
            "/repo/.worktrees/task-42",
            "/repo",
            "task-42",
            "Repair relocation",
            "default",
            "acceptEdits",
            "default",
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            launch.provenance().template_ref,
            "builtin.agent.project-relocation"
        );
        assert_eq!(launch.inspectable_manifest().target.cwd, "/repo");
        let delivered = launch.delivered_prompt().unwrap();
        assert!(delivered.contains("previous Task lifecycle no longer applies"));
        assert!(delivered.contains("/repo/.worktrees/task-42"));
        assert_eq!(
            launch.inspectable_manifest().content_parts[0].content,
            delivered
        );
        assert!(provider_args(&launch).starts_with(&[
            "resume".to_owned(),
            "thread-project-relocation".to_owned(),
            "-C".to_owned(),
            "/repo".to_owned(),
        ]));
        assert!(
            provider_args(&launch)
                .iter()
                .all(|argument| !argument.contains("trust_level="))
        );
        assert!(!format!("{launch:?}").contains("thread-project-relocation"));
    }
}
