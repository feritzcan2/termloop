fn validate_config_name(name: &str) -> Result<(), InvocationError> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(InvocationError::InvalidMcpEndpoint);
    }
    Ok(())
}

fn apply_tool_approvals(
    agent_id: &str,
    arguments: &mut Vec<ResolvedArgument>,
    server: &str,
    tools: &[&str],
) -> Result<(), InvocationError> {
    validate_config_name(server)?;
    for tool in tools {
        validate_config_name(tool)?;
    }
    if tools.is_empty() {
        return Ok(());
    }
    if agent_id == "claude" {
        arguments.extend([
            ResolvedArgument::exact("--allowedTools", "authorized local application tools"),
            ResolvedArgument::exact(
                tools
                    .iter()
                    .map(|tool| format!("mcp__{server}__{tool}"))
                    .collect::<Vec<_>>()
                    .join(","),
                "authorized local application tools",
            ),
        ]);
        return Ok(());
    }
    if agent_id != "codex" {
        return Err(InvocationError::UnsupportedAgent(agent_id.into()));
    }
    for tool in tools {
        arguments.extend([
            ResolvedArgument::exact("-c", "authorized local automation tool"),
            ResolvedArgument::exact(
                format!("mcp_servers.{server}.tools.{tool}.approval_mode=\"approve\""),
                "authorized local automation tool",
            ),
        ]);
    }
    Ok(())
}

fn apply_execution_policy(
    agent_id: &str,
    arguments: &mut Vec<ResolvedArgument>,
    policy: CodexExecutionPolicy,
) -> Result<(), InvocationError> {
    if agent_id != "codex" {
        return Err(InvocationError::UnsupportedAgent(agent_id.into()));
    }
    arguments.insert(
        0,
        ResolvedArgument::exact("exec", "bounded automation execution"),
    );
    let sandbox = match policy.sandbox {
        CodexSandbox::ReadOnly => "read-only",
        CodexSandbox::WorkspaceWrite => "workspace-write",
    };
    for arg in [
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        sandbox,
        "-c",
        "approval_policy=\"never\"",
    ] {
        arguments.push(ResolvedArgument::exact(arg, "automation execution policy"));
    }
    if policy.network {
        if !matches!(policy.sandbox, CodexSandbox::WorkspaceWrite) {
            return Err(InvocationError::InvalidPromptBinding);
        }
        arguments.extend([
            ResolvedArgument::exact("-c", "automation execution policy"),
            ResolvedArgument::exact(
                "sandbox_workspace_write.network_access=true",
                "automation execution policy",
            ),
        ]);
    }
    if policy.web_search {
        arguments.extend([
            ResolvedArgument::exact("-c", "automation execution policy"),
            ResolvedArgument::exact("web_search=\"live\"", "automation execution policy"),
        ]);
    }
    for feature in ["multi_agent", "plugins", "hooks", "apps"] {
        arguments.extend([
            ResolvedArgument::exact("--disable", "automation execution policy"),
            ResolvedArgument::exact(feature, "automation execution policy"),
        ]);
    }
    Ok(())
}

impl ResolvedLaunchManifest {
    pub fn inspectable_manifest(&self) -> &InspectableLaunchManifest {
        &self.inspectable
    }
    pub fn delivered_prompt(&self) -> Option<&str> {
        self.delivered_prompt.as_deref()
    }

    pub fn set_bindings(&mut self, bindings: Vec<(String, String)>) {
        self.bindings = bindings;
    }
    pub fn add_binding(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.bindings.push((name.into(), value.into()));
    }
    /// Records the product's composed source without exposing mutable argv or
    /// allowing the public manifest to diverge from the launch transport.
    pub fn set_provenance_content(&mut self, content: &str) {
        self.inspectable.provenance.delivered_digest = content_digest(content);
        finalize_digest(&mut self.inspectable);
    }

    pub fn set_first_message_source(&mut self, source: &str) {
        for part in &mut self.inspectable.content_parts {
            if part.kind == "firstMessage" {
                part.source = source.into();
            }
        }
        finalize_digest(&mut self.inspectable);
    }

    pub fn positional_message(
        &mut self,
        content: &str,
        source: impl Into<String>,
        purpose: &'static str,
    ) -> Result<(), InvocationError> {
        if self.delivered_prompt.is_some()
            || self.initial_input.is_some()
            || content.is_empty()
            || content.contains('\0')
        {
            return Err(InvocationError::InvalidPromptBinding);
        }
        self.arguments.extend([
            ResolvedArgument::exact("--", "first-message delimiter"),
            ResolvedArgument::private(content, purpose),
        ]);
        self.delivered_prompt = Some(content.into());
        self.inspectable.content_parts.push(content_part(
            "first-message",
            "firstMessage",
            source,
            "argv",
            content,
        ));
        self.inspectable.transport = transport("argv", content);
        self.inspectable.arguments = self
            .arguments
            .iter()
            .enumerate()
            .map(|(index, arg)| arg.inspect(index))
            .collect();
        self.inspectable.provenance.delivered_digest = content_digest(content);
        finalize_digest(&mut self.inspectable);
        Ok(())
    }
}
