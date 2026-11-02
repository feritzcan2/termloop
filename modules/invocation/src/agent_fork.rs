use termloop_domain::AgentLaunchSelection;

use crate::{
    AgentConversationLaunch, AgentMcpLaunch, AgentObservationLaunch, InvocationError,
    LaunchPayload, PromptTemplate,
};

pub(super) const AGENT_FORK_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.fork",
    version: 3,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.fork.md"),
};

pub(super) const AGENT_FORK_ACTIVE_SOURCE_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.fork.active",
    version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.fork.active.md"),
};

/// The visible fork notice exactly as authored, with its binding marker intact.
/// Settings show this so the user sees what a fork receives before enabling it.
pub fn agent_fork_notice_template() -> &'static PromptTemplate {
    &AGENT_FORK_TEMPLATE
}

/// The paragraph added after the notice only when the source Agent was still
/// working at fork time, warning that it may keep changing shared state.
pub fn agent_fork_active_source_template() -> &'static PromptTemplate {
    &AGENT_FORK_ACTIVE_SOURCE_TEMPLATE
}

/// Codex takes the fork's developer instructions as given, so the interactive
/// protocol travels with the notice. Claude keeps the source conversation's
/// system prompt (which already carries that protocol) and only learns the
/// notice through its SessionStart context, so it receives the notice alone.
fn agent_fork_provider_instructions(
    agent_id: &str,
    source_session_id: &str,
    source_active: bool,
    mcp: Option<&AgentMcpLaunch<'_>>,
) -> Result<String, InvocationError> {
    if source_session_id.trim().is_empty()
        || source_session_id.len() > 256
        || source_session_id.chars().any(char::is_control)
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let mut notice = crate::bind_ordered(
        AGENT_FORK_TEMPLATE.authored_body,
        &[("source_session_id", source_session_id)],
    )?;
    if source_active {
        notice = format!(
            "{}\n\n{}",
            notice.trim_end(),
            AGENT_FORK_ACTIVE_SOURCE_TEMPLATE.authored_body
        );
    }
    let instructions = if agent_id == "codex"
        && mcp.is_some_and(|mcp| mcp.profile.includes_interactive_instructions())
    {
        format!(
            "{}\n\n{notice}",
            crate::INTERACTIVE_AGENT_TEMPLATE.authored_body
        )
    } else {
        notice
    };
    if instructions.len() > 64 * 1024 {
        return Err(InvocationError::InvalidDeveloperInstructions);
    }
    Ok(instructions)
}

/// Launches an ordinary interactive native fork whose persistent provider
/// instructions carry the visible fork notice after the interactive protocol.
/// The Session keeps the interactive template as its provenance so every
/// interactive-only capability still recognizes it; the notice is an
/// additional instruction source, never a first message.
#[allow(clippy::too_many_arguments)]
pub fn interactive_agent_fork_for_conversation(
    agent_id: &str,
    cwd: &str,
    selection: &AgentLaunchSelection,
    source_session_id: &str,
    source_active: bool,
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
    let instructions =
        agent_fork_provider_instructions(agent_id, source_session_id, source_active, mcp.as_ref())?;
    let mut resolved = crate::resolve_launch_manifest_with_attachments_and_codex_project_trust(
        agent_id,
        cwd,
        &crate::INTERACTIVE_AGENT_TEMPLATE,
        &selection.model,
        &selection.permission,
        &selection.reasoning,
        None,
        conversation,
        observation,
        mcp,
        Some(&AGENT_FORK_TEMPLATE),
        Some(&instructions),
        &[],
        if managed_worktree {
            crate::CodexProjectTrust::ManagedWorkspace
        } else {
            crate::CodexProjectTrust::Inherit
        },
    )?;
    resolved.set_bindings(vec![(
        "source_session_id".into(),
        source_session_id.to_owned(),
    )]);
    resolved.set_provenance_content(&instructions);
    Ok(resolved.into_payload())
}
