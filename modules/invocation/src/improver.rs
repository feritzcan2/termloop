//! Improver launches: the Agents that rewrite one run configuration, Steward
//! instructions, settings entry, Routine, or Playbook for the user to review.

use super::*;

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

/// One improvable TermLoop surface an "Improve with agent" launch is bound to.
///
/// Each variant resolves its own visible template, so the delivered
/// instructions describe that exact surface — how to verify it, what its
/// fields mean, what must never be proposed — instead of a generic
/// "edit this configuration" prompt. Adding an improvable surface means adding
/// a variant and its asset here, never composing instructions at a call site.
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
        /// The Project is opened as Project Manager: the Builder researches
        /// how the Project ships and designs delivery-tracking steps.
        project_manager: bool,
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

    pub(crate) fn template(&self) -> Result<&'static PromptTemplate, InvocationError> {
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
    pub(crate) fn delivered_prompt(&self) -> Result<String, InvocationError> {
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
            Self::Playbook {
                project_name,
                project_manager,
            } => {
                bounded_binding(project_name, 200)?;
                let project_manager_policy = if project_manager {
                    format!("\n\n{}", project_manager_playbook_policy_body())
                } else {
                    String::new()
                };
                bind_ordered(
                    template.authored_body,
                    &[
                        ("project_name", project_name),
                        ("task_evidence_policy", task_evidence_policy_body()),
                        ("project_manager_policy", project_manager_policy.as_str()),
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
