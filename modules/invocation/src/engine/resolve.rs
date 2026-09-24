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
        CodexProjectTrust::ManagedWorkspace,
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
    resolve_launch_manifest_with_environment(
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
        codex_project_trust,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn resolve_launch_manifest_with_environment(
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
    executable_directory: Option<&Path>,
) -> Result<ResolvedLaunchManifest, InvocationError> {
    let delivered = compose_quick_action_delivery(agent_id, prompt.unwrap_or_default(), attachments);
    termloop_launch::resolve(termloop_launch::LaunchRequest {
        agent_id, cwd, template, model, permission, reasoning,
        prompt: prompt.map(|_| delivered.as_str()), conversation, observation,
        mcp: mcp.map(AgentMcpLaunch::connection), provider_instructions_source,
        provider_instructions, attachments, codex_project_trust, executable_directory,
        explicit_configuration: template.id == QUICK_ACTION_FREE_PROMPT_TEMPLATE_REF,
        execution: None, workspace_network: None, approved_tools: &[],
    })
}
