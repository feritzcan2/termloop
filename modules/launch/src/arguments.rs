fn conversation_args(
    agent_id: &str,
    launch: AgentConversationLaunch<'_>,
) -> Result<Vec<String>, InvocationError> {
    use termloop_domain::ResumeProvider;
    let (resume_ref, mode) = match launch {
        AgentConversationLaunch::Fresh { resume_ref } => (resume_ref, "fresh"),
        AgentConversationLaunch::Resume { resume_ref } => (Some(resume_ref), "resume"),
        AgentConversationLaunch::Fork { source_ref } => (Some(source_ref), "fork"),
        AgentConversationLaunch::WithAccount { .. } => {
            return Err(InvocationError::InvalidResumeReference);
        }
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

fn codex_developer_instructions_args(instructions: &str) -> Result<[String; 2], InvocationError> {
    if instructions.trim().is_empty() || instructions.len() > 64 * 1024 {
        return Err(InvocationError::InvalidDeveloperInstructions);
    }
    let instructions = serde_json::to_string(instructions)
        .map_err(|_| InvocationError::InvalidDeveloperInstructions)?;
    Ok([
        "-c".into(),
        format!("developer_instructions={instructions}"),
    ])
}

fn mcp_args(
    agent_id: &str,
    mcp: &McpConnection<'_>,
    include_interactive_instructions: bool,
) -> Result<Vec<String>, InvocationError> {
    validate_config_name(mcp.server_name)?;
    match agent_id {
        "claude" => {
            let mut args = vec!["--mcp-config".into(), mcp.claude_config_path.into()];
            if include_interactive_instructions && mcp.instructions.is_some() {
                args.extend([
                    "--append-system-prompt".into(),
                    mcp.instructions.expect("checked instructions").authored_body.into(),
                ]);
            }
            Ok(args)
        }
        "codex" => {
            let endpoint = serde_json::to_string(mcp.endpoint)
                .map_err(|_| InvocationError::InvalidMcpEndpoint)?;
            let server = mcp.server_name;
            let mut args = vec![
                "-c".into(),
                format!("mcp_servers.{server}.url={endpoint}"),
                "-c".into(),
                format!("mcp_servers.{server}.bearer_token_env_var=\"TERMLOOP_MCP_TOKEN\""),
            ];
            if include_interactive_instructions && mcp.instructions.is_some() {
                args.extend(codex_developer_instructions_args(
                    mcp.instructions.expect("checked instructions").authored_body,
                )?);
            }
            Ok(args)
        }
        _ => Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    }
}
