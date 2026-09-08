use termloop_domain::{AgentLaunchSelection, PersonalAgent};

use crate::{
    AgentConversationLaunch, AgentMcpLaunch, AgentObservationLaunch, InvocationError,
    LaunchPayload, PromptTemplate, QuickActionImageAttachment,
};

pub(super) const PERSONAL_AGENT_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.personal",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.personal.md"),
};

pub(super) fn personal_agent_provider_instructions(
    profile: &PersonalAgent,
    mcp: Option<&AgentMcpLaunch<'_>>,
) -> Result<String, InvocationError> {
    if !profile.is_valid() {
        return Err(InvocationError::InvalidDeveloperInstructions);
    }
    let instructions = crate::bind_ordered(
        PERSONAL_AGENT_TEMPLATE.authored_body,
        &[
            ("profileRef", profile.id.as_str()),
            ("profileVersion", profile.version.to_string().as_str()),
            ("instructions", profile.instructions.as_str()),
        ],
    )?;
    let instructions = if mcp.is_some_and(|mcp| mcp.profile.includes_interactive_instructions()) {
        format!(
            "{}\n\n{instructions}",
            crate::INTERACTIVE_AGENT_TEMPLATE.authored_body
        )
    } else {
        instructions
    };
    if instructions.len() > 64 * 1024 {
        return Err(InvocationError::InvalidDeveloperInstructions);
    }
    Ok(instructions)
}

#[allow(clippy::too_many_arguments)]
pub fn personal_agent_for_conversation(
    profile: &PersonalAgent,
    agent_id: &str,
    cwd: &str,
    selection: &AgentLaunchSelection,
    prompt: Option<&str>,
    attachments: &[QuickActionImageAttachment],
    conversation: AgentConversationLaunch<'_>,
    observation: Option<AgentObservationLaunch<'_>>,
    mcp: Option<AgentMcpLaunch<'_>>,
    managed_worktree: bool,
) -> Result<LaunchPayload, InvocationError> {
    if !matches!(agent_id, "claude" | "codex") {
        return Err(InvocationError::UnsupportedAgent(agent_id.to_owned()));
    }
    crate::validate_agent_configuration(
        agent_id,
        &selection.model,
        &selection.permission,
        &selection.reasoning,
    )?;
    if let Some(prompt) = prompt {
        crate::validate_quick_action_with_attachments(
            agent_id,
            &selection.model,
            &selection.permission,
            &selection.reasoning,
            prompt,
            attachments,
        )?;
    }
    let instructions = personal_agent_provider_instructions(profile, mcp.as_ref())?;
    let mut resolved = crate::resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        &PERSONAL_AGENT_TEMPLATE,
        &selection.model,
        &selection.permission,
        &selection.reasoning,
        prompt,
        conversation,
        observation,
        mcp,
        Some(&PERSONAL_AGENT_TEMPLATE),
        Some(&instructions),
        attachments,
        if managed_worktree {
            crate::CodexProjectTrust::TermLoopManagedWorktree
        } else {
            crate::CodexProjectTrust::Inherit
        },
    )?;
    resolved.bindings = vec![
        ("profileRef".into(), profile.id.clone()),
        ("profileVersion".into(), profile.version.to_string()),
        ("instructions".into(), profile.instructions.clone()),
    ];
    if let Some(prompt) = prompt {
        resolved.bindings.push(("prompt".into(), prompt.into()));
    }
    resolved.inspectable.provenance.delivered_digest = crate::content_digest(&format!(
        "{instructions}\n\n{}",
        resolved.delivered_prompt.as_deref().unwrap_or_default()
    ));
    crate::finalize_digest(&mut resolved.inspectable);
    Ok(resolved.into_payload())
}
