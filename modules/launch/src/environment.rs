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
    mcp: &McpConnection<'_>,
) -> Result<Vec<ResolvedArgument>, InvocationError> {
    Ok(mcp_args(agent_id, mcp, true)?
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
                "CODEX_HOME" | "CLAUDE_CONFIG_DIR" => InspectableEnvironmentEntry {
                    key,
                    display_value: "<redacted account directory>".into(),
                    visibility: "redacted",
                    classification: "sensitivePath",
                    source: "invocation",
                    purpose: "selected provider account",
                },
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
