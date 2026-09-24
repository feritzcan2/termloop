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
    mcp: Option<McpConnection<'_>>,
    developer_instructions: Option<&str>,
    account: Option<&termloop_agents::AgentAccountContext>,
) -> Result<CodexAppServerLaunch, InvocationError> {
    codex_app_server_with_project_trust(
        listen_endpoint,
        cwd,
        session_id,
        mcp,
        developer_instructions,
        account,
        CodexProjectTrust::Inherit,
        None,
        &CodexRuntimePolicy::default(),
    )
}

pub fn codex_app_server_for_managed_worktree(
    listen_endpoint: &str,
    cwd: &str,
    session_id: &str,
    mcp: Option<McpConnection<'_>>,
    developer_instructions: Option<&str>,
    account: Option<&termloop_agents::AgentAccountContext>,
) -> Result<CodexAppServerLaunch, InvocationError> {
    codex_app_server_with_project_trust(
        listen_endpoint,
        cwd,
        session_id,
        mcp,
        developer_instructions,
        account,
        CodexProjectTrust::ManagedWorkspace,
        None,
        &CodexRuntimePolicy::default(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn codex_app_server_with_project_trust(
    listen_endpoint: &str,
    cwd: &str,
    session_id: &str,
    mcp: Option<McpConnection<'_>>,
    developer_instructions: Option<&str>,
    account: Option<&termloop_agents::AgentAccountContext>,
    codex_project_trust: CodexProjectTrust,
    executable_directory: Option<&Path>,
    policy: &CodexRuntimePolicy,
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
    if let Some(directory) = executable_directory {
        if !directory.is_absolute() {
            return Err(InvocationError::InvalidPromptBinding);
        }
        environment = environment.with_explicit("PATH", directory);
    }
    if let Some(account) = account {
        if account.agent_id != "codex" {
            return Err(InvocationError::InvalidResumeReference);
        }
        environment = account.apply_environment(environment);
        args.extend(account.credential_args());
    }
    if let Some(mcp) = mcp {
        args.extend(mcp_args("codex", &mcp, developer_instructions.is_none())?);
        environment = environment.with_explicit("TERMLOOP_MCP_TOKEN", mcp.token);
        let mut tool_arguments = Vec::new();
        let tools: Vec<_> = policy.approved_tools.iter().map(String::as_str).collect();
        apply_tool_approvals("codex", &mut tool_arguments, mcp.server_name, &tools)?;
        args.extend(tool_arguments.into_iter().map(|argument| argument.value));
    }
    if let Some(enabled) = policy.workspace_network {
        args.extend([
            "-c".to_owned(),
            format!("sandbox_workspace_write.network_access={enabled}"),
        ]);
    }
    if let Some(instructions) = developer_instructions {
        args.extend(codex_developer_instructions_args(instructions)?);
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
    WithAccount {
        account: &'a termloop_agents::AgentAccountContext,
        conversation: &'a AgentConversationLaunch<'a>,
    },
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

impl<'a> AgentConversationLaunch<'a> {
    pub fn in_account(&'a self, account: Option<&'a termloop_agents::AgentAccountContext>) -> Self {
        account.map_or(*self, |account| Self::WithAccount {
            account,
            conversation: self,
        })
    }
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
    pub fn codex_app_server_developer_instructions(&self) -> Option<&str> {
        self.codex_app_server_developer_instructions.as_deref()
    }
    pub fn codex_runtime_policy(&self) -> &CodexRuntimePolicy {
        &self.codex_runtime_policy
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
