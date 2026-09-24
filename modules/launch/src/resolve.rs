pub fn resolve(request: LaunchRequest<'_>) -> Result<ResolvedLaunchManifest, InvocationError> {
    let LaunchRequest {
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
        executable_directory,
        explicit_configuration,
        execution,
        workspace_network,
        approved_tools,
    } = request;
    if let Some(instructions) = provider_instructions
        && (instructions.trim().is_empty() || instructions.len() > 64 * 1024)
    {
        return Err(InvocationError::InvalidDeveloperInstructions);
    }
    if execution.is_some()
        && (permission != "default"
            || !matches!(
                conversation,
                AgentConversationLaunch::Fresh { resume_ref: None }
            )
            || observation.is_some())
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let (account, conversation) = match conversation {
        AgentConversationLaunch::WithAccount {
            account,
            conversation,
        } if account.agent_id == agent_id => (Some(account), *conversation),
        AgentConversationLaunch::WithAccount { .. } => {
            return Err(InvocationError::InvalidResumeReference);
        }
        conversation => (None, conversation),
    };
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
        AgentConversationLaunch::WithAccount { .. } => {
            return Err(InvocationError::InvalidResumeReference);
        }
    };
    let inherits_codex_permissions = agent_id == "codex"
        && conversation_kind == "resume"
        && observation.as_ref().is_some_and(|observation| {
            matches!(
                observation.transport,
                AgentObservationLaunchTransport::DaemonOwnedBridge { .. }
            )
        });
    let interactive_template = mcp.as_ref().and_then(|mcp| mcp.instructions);
    let interactive_provider_instructions =
        interactive_template.map(|template| template.authored_body);
    let delivered_provider_instructions =
        provider_instructions.or(interactive_provider_instructions);
    let mut arguments = conversation_manifest_args(agent_id, conversation)?;
    if let Some(account) = account {
        arguments.extend(
            account
                .credential_args()
                .into_iter()
                .map(|arg| ResolvedArgument::exact(arg, "isolated account credentials")),
        );
    }
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
    if explicit_configuration
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
        // Codex remote resume rejects CLI permission overrides before resuming
        // the thread. The provider restores its persisted permissions instead.
        // Validate the selection even when this transport cannot override it.
        let permission_arguments = permission_args(agent_id, permission)?;
        if !inherits_codex_permissions {
            arguments.extend(
                permission_arguments
                    .into_iter()
                    .map(|argument| ResolvedArgument::exact(argument, "permission selection")),
            );
        }
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

    if let Some(enabled) = workspace_network {
        if agent_id != "codex" {
            return Err(InvocationError::UnsupportedAgent(agent_id.into()));
        }
        arguments.extend([
            ResolvedArgument::exact("-c", "workspace sandbox network policy"),
            ResolvedArgument::exact(
                format!("sandbox_workspace_write.network_access={enabled}"),
                "workspace sandbox network policy",
            ),
        ]);
    }
    if let Some(policy) = execution {
        apply_execution_policy(agent_id, &mut arguments, policy)?;
    }
    if let Some(mcp) = mcp.as_ref() {
        apply_tool_approvals(agent_id, &mut arguments, mcp.server_name, approved_tools)?;
    } else if !approved_tools.is_empty() {
        return Err(InvocationError::InvalidMcpEndpoint);
    }

    let cargo_shard_key = observation
        .as_ref()
        .map(|observation| observation.session_id);
    let mut environment = agent_launch_environment(cwd, cargo_shard_key);
    if let Some(directory) = executable_directory {
        environment = environment.with_explicit("PATH", directory);
    }
    if let Some(account) = account {
        environment = account.apply_environment(environment);
    }
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

    let delivered = prompt.unwrap_or_default().to_owned();
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
                let source = provider_instructions_source
                    .or(interactive_template)
                    .ok_or(InvocationError::UnprovenancedPrompt)?;
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
            account_id: account.map(|account| account.account_id.clone()),
            account_name: account.map(|account| account.name.clone()),
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
        limitations: provider_limitations(agent_id, inherits_codex_permissions),
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
        codex_app_server_developer_instructions: if agent_id == "codex" {
            delivered_provider_instructions.map(str::to_owned)
        } else {
            None
        },
        codex_runtime_policy: CodexRuntimePolicy {
            approved_tools: approved_tools.iter().map(|s| (*s).to_owned()).collect(),
            workspace_network,
        },
        initial_input: prompt
            .map(|_| InitialInputDelivery::submitted(&delivered))
            .transpose()?,
        inspectable,
        bindings: vec![],
        delivered_prompt: prompt.map(|_| delivered),
    })
}
