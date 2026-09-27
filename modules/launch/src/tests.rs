use super::*;

#[test]
fn external_product_names_cannot_inject_provider_configuration() {
    let mut arguments = Vec::new();
    for name in ["", "app.tools", "app\nother", "app=untrusted", "app[0]"] {
        assert!(apply_tool_approvals("codex", &mut arguments, name, &["save"]).is_err());
        assert!(apply_tool_approvals("codex", &mut arguments, "my_app", &[name]).is_err());
        assert!(arguments.is_empty());
    }
    apply_tool_approvals("codex", &mut arguments, "my_app", &["save"]).unwrap();
    assert_eq!(
        arguments[1].value,
        "mcp_servers.my_app.tools.save.approval_mode=\"approve\""
    );
}

#[test]
fn opaque_conversation_identity_is_validated_and_debug_redacted() {
    let handle = ConversationHandle::from_native("codex", "private-thread-id".into()).unwrap();
    assert!(!format!("{handle:?}").contains("private-thread-id"));
    assert_eq!(
        conversation_args("codex", handle.resume()).unwrap(),
        ["resume", "private-thread-id"]
    );
    assert!(conversation_args("claude", handle.resume()).is_err());
    assert!(ConversationHandle::from_native("other", "private-thread-id".into()).is_err());
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
fn quick_action_bypass_is_an_exact_provider_flag() {
    let claude = permission_args("claude", "bypassPermissions").unwrap();
    let codex = permission_args("codex", "bypassPermissions").unwrap();
    assert_eq!(claude, ["--dangerously-skip-permissions"]);
    assert_eq!(codex, ["--dangerously-bypass-approvals-and-sandbox"]);
}

#[test]
fn codex_accept_edits_uses_the_self_contained_approval_flag() {
    assert_eq!(
        permission_args("codex", "acceptEdits").unwrap(),
        ["--approve-for-me"]
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
fn claude_approval_is_scoped_to_the_products_named_tools() {
    let mut args = Vec::new();
    apply_tool_approvals("claude", &mut args, "example", &["report", "inbox"]).unwrap();
    assert_eq!(
        args.iter().map(|a| a.value.as_str()).collect::<Vec<_>>(),
        ["--allowedTools", "mcp__example__report,mcp__example__inbox"]
    );
    assert!(apply_tool_approvals("claude", &mut Vec::new(), "example", &["*"]).is_err());
}
#[test]
fn workspace_network_policy_is_explicit_without_widening_filesystem_permissions() {
    let template = PromptTemplate {
        id: "example",
        version: 1,
        authored_body: "Example",
    };
    let mut request = LaunchRequest::interactive("codex", "/tmp/example", &template);
    request.permission = "plan";
    request.workspace_network = Some(true);
    let payload = resolve(request).unwrap().into_payload();
    assert!(
        payload
            .args()
            .iter()
            .any(|a| a == "sandbox_workspace_write.network_access=true")
    );
    assert!(payload.args().iter().any(|a| a == "read-only"));
    assert!(
        !payload
            .args()
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox")
    );
}

#[test]
fn execution_server_keeps_named_tool_policy_for_remote_resume() {
    let mcp = McpConnection {
        endpoint: "http://127.0.0.1:4567/mcp",
        token: "private",
        claude_config_path: "/tmp/mcp.json",
        server_name: "example",
        instructions: None,
    };
    let policy = CodexRuntimePolicy {
        approved_tools: vec!["report".into()],
        workspace_network: Some(true),
    };
    let launch = codex_app_server_with_project_trust(
        "ws://127.0.0.1:4568",
        "/tmp",
        "policy-proof",
        Some(mcp),
        None,
        None,
        CodexProjectTrust::Inherit,
        None,
        &policy,
    )
    .unwrap();
    assert!(
        launch
            .args()
            .iter()
            .any(|a| a == "mcp_servers.example.tools.report.approval_mode=\"approve\"")
    );
    assert!(
        launch
            .args()
            .iter()
            .any(|a| a == "sandbox_workspace_write.network_access=true")
    );
    assert!(!launch.args().iter().any(|a| a.contains("bypass")));
}

#[test]
fn remote_resume_routes_network_permissions_to_server_not_tui() {
    let template = PromptTemplate {
        id: "resume-test",
        version: 1,
        authored_body: "Continue",
    };
    let handle =
        ConversationHandle::from_native("codex", "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036".into())
            .unwrap();
    for enabled in [true, false] {
        let mut request = LaunchRequest::interactive("codex", "/tmp/example", &template);
        request.conversation = handle.resume();
        request.permission = "bypassPermissions";
        request.workspace_network = Some(enabled);
        request.observation = Some(AgentObservationLaunch {
            session_id: "session",
            endpoint: "http://localhost/hook",
            token: "token",
            transport: AgentObservationLaunchTransport::DaemonOwnedBridge {
                endpoint: CODEX_APP_SERVER_RUNTIME_PLACEHOLDER,
            },
        });
        let payload = resolve(request).unwrap().into_payload();
        assert!(
            !payload
                .args()
                .iter()
                .any(|a| a.contains("sandbox_workspace_write")
                    || a.contains("bypass-approvals")
                    || a == "--sandbox")
        );
    }
}

#[test]
fn remote_fork_prepares_permissions_and_binds_only_the_new_thread() {
    let template = PromptTemplate {
        id: "fork-test",
        version: 1,
        authored_body: "Continue",
    };
    let source = "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036";
    let child = "019f1dae-3bf3-73d1-b3c7-08ddbbd1f037";
    let handle = ConversationHandle::from_native("codex", source.into()).unwrap();
    for permission in ["default", "acceptEdits", "plan", "bypassPermissions"] {
        let mut request = LaunchRequest::interactive("codex", "/tmp/example", &template);
        request.conversation = handle.fork();
        request.permission = permission;
        request.workspace_network = Some(false);
        request.observation = Some(AgentObservationLaunch {
            session_id: "session",
            endpoint: "http://localhost/hook",
            token: "token",
            transport: AgentObservationLaunchTransport::DaemonOwnedBridge {
                endpoint: CODEX_APP_SERVER_RUNTIME_PLACEHOLDER,
            },
        });
        let mut payload = resolve(request).unwrap().into_payload();
        let preparation = payload.codex_resume_permissions().unwrap();
        assert!(preparation.is_fork());
        assert_eq!(preparation.native_thread_id(), source);
        for forbidden in permission_args("codex", permission).unwrap() {
            assert!(!payload.args().contains(&forbidden));
        }
        assert!(
            !payload
                .args()
                .iter()
                .any(|a| a.contains("sandbox_workspace_write"))
        );
        let preview = serde_json::to_string(payload.inspectable_manifest()).unwrap();
        assert!(!preview.contains(source));
        assert!(payload.bind_codex_fork_thread(source, source).is_err());
        assert!(
            payload
                .bind_codex_fork_thread("wrong-source", child)
                .is_err()
        );
        assert!(payload.bind_codex_fork_thread(source, "").is_err());
        payload.bind_codex_fork_thread(source, child).unwrap();
        assert!(payload.args().windows(2).any(|p| p == ["resume", child]));
        assert!(!payload.args().iter().any(|a| a == source || a == "fork"));
        assert!(payload.bind_codex_fork_thread(source, child).is_err());
        assert_eq!(
            preview,
            serde_json::to_string(payload.inspectable_manifest()).unwrap()
        );
        payload
            .bind_codex_app_server_endpoint("ws://127.0.0.1:4567")
            .unwrap();
    }
}
