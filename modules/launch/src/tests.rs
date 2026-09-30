use super::*;

#[test]
fn opencode_v2_uses_private_server_configuration_for_every_model_and_permission() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-opencode-v2-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    termloop_platform::test_support::write_cli_fixture(
        &directory,
        "opencode",
        "#!/bin/sh\nif [ \"$1\" = --help ]; then printf '  --standalone  Private server\\n  --auto  Auto approve\\n  --prompt <text>  Prompt\\n'; exit 0; fi\nexit 1\n",
        "@echo off\r\nif \"%1\"==\"--help\" (echo   --standalone  Private server& echo   --auto  Auto approve& echo   --prompt ^<text^>  Prompt& exit /b 0)\r\nexit /b 1\r\n",
    ).unwrap();
    let template = PromptTemplate {
        id: "opencode-v2-test",
        version: 1,
        authored_body: "Inspect the project",
    };
    let descriptor = termloop_agents::agent_descriptor("opencode").unwrap();
    for model in descriptor.models {
        for permission in descriptor.permissions {
            let mut request = LaunchRequest::interactive("opencode", "/tmp/example", &template);
            request.executable_directory = Some(&directory);
            request.model = model;
            request.permission = permission;
            request.prompt = Some("--help\nTürkçe 'literal' $HOME");
            let payload = resolve(request).unwrap().into_payload();
            assert!(
                !payload
                    .args()
                    .iter()
                    .any(|arg| arg == "--model" || arg == "--agent")
            );
            assert_eq!(
                payload.args().iter().any(|arg| arg == "--auto"),
                *permission == "bypassPermissions"
            );
            assert_eq!(
                payload.args().last().unwrap(),
                "--prompt=--help\nTürkçe 'literal' $HOME"
            );
            assert!(payload.initial_input_submission().is_none());
            let has_config = *model != "default" || *permission == "plan";
            assert_eq!(
                payload.args().iter().any(|arg| arg == "--standalone"),
                has_config
            );
            let config = payload
                .environment
                .entries()
                .find(|(key, _)| *key == "OPENCODE_CONFIG_CONTENT");
            assert_eq!(config.is_some(), has_config);
            if let Some((_, config)) = config {
                let config: serde_json::Value =
                    serde_json::from_str(config.to_str().unwrap()).unwrap();
                assert_eq!(
                    config.get("model").and_then(|value| value.as_str()),
                    (*model != "default").then_some(*model)
                );
                assert_eq!(
                    config.get("default_agent").and_then(|value| value.as_str()),
                    (*permission == "plan").then_some("plan")
                );
                assert!(config.get("permissions").is_none());
            }
            let manifest = payload.inspectable_manifest();
            assert_eq!(manifest.target.model, *model);
            assert_eq!(manifest.target.permission, *permission);
            assert_eq!(
                manifest
                    .environment
                    .iter()
                    .any(|entry| entry.key == "OPENCODE_CONFIG_CONTENT"
                        && entry.source == "invocation"
                        && entry.visibility == "redacted"),
                has_config
            );
            assert_eq!(
                manifest
                    .arguments
                    .iter()
                    .map(|arg| arg.display.as_str())
                    .collect::<Vec<_>>(),
                payload
                    .args()
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
            );
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn opencode_initial_prompt_is_literal_and_never_replayed_through_the_terminal() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-opencode-prompt-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(&directory).unwrap();
    termloop_platform::test_support::write_cli_fixture(
        &directory,
        "opencode",
        "#!/bin/sh\nexit 0\n",
        "@echo off\r\nexit /b 0\r\n",
    )
    .unwrap();
    let template = PromptTemplate {
        id: "opencode-prompt-test",
        version: 1,
        authored_body: "Inspect the project",
    };
    for prompt in [
        "Review this project",
        "--help\nTürkçe 'quoted' \"text\" $HOME `literal`",
    ] {
        let mut request = LaunchRequest::interactive("opencode", "/tmp/example", &template);
        request.executable_directory = Some(&directory);
        request.model = "opencode-go/kimi-k2.7-code";
        request.permission = "plan";
        request.prompt = Some(prompt);
        let payload = resolve(request).unwrap().into_payload();
        assert!(
            payload
                .args()
                .windows(2)
                .any(|args| args == ["--model", "opencode-go/kimi-k2.7-code"])
        );
        assert!(
            payload
                .args()
                .windows(2)
                .any(|args| args == ["--agent", "plan"])
        );
        assert_eq!(
            payload
                .args()
                .iter()
                .filter(|arg| arg.starts_with("--prompt="))
                .count(),
            1
        );
        assert_eq!(
            payload.args().last().unwrap(),
            &format!("--prompt={prompt}")
        );
        assert!(payload.initial_input_submission().is_none());
        let manifest = payload.inspectable_manifest();
        assert_eq!(manifest.transport.kind, "providerPromptArgument");
        assert_eq!(manifest.transport.delivered_content, prompt);
        assert_eq!(manifest.transport.byte_length, prompt.len());
        assert_eq!(manifest.provenance.delivered_digest, content_digest(prompt));
        assert_eq!(manifest.content_parts[0].content, prompt);
        assert_eq!(
            manifest.arguments.last().unwrap().display,
            format!("--prompt={prompt}")
        );
    }
    let mut request = LaunchRequest::interactive("opencode", "/tmp/example", &template);
    request.executable_directory = Some(&directory);
    let payload = resolve(request).unwrap().into_payload();
    assert!(!payload.args().iter().any(|arg| arg.starts_with("--prompt")));
    assert_eq!(payload.inspectable_manifest().transport.kind, "none");
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn codex_image_prompt_is_one_literal_argument_without_a_terminal_submission() {
    let template = PromptTemplate {
        id: "image-prompt-test",
        version: 1,
        authored_body: "Inspect the image",
    };
    let attachments = [ImageAttachment {
        attachment_id: "123e4567-e89b-42d3-a456-426614174000".into(),
        file_path: "/tmp/image folder/image.png".into(),
        media_type: "image/png".into(),
        byte_length: 100,
        sha256: format!("sha256:{}", "a".repeat(64)),
        width: 1,
        height: 1,
    }];
    for prompt in [
        "Inspect this image",
        "--help\nBu görseli incele: 'quoted' \"text\" $HOME `literal`\n",
    ] {
        let mut request = LaunchRequest::interactive("codex", "/tmp/example", &template);
        request.prompt = Some(prompt);
        request.attachments = &attachments;
        let payload = resolve(request).unwrap().into_payload();
        assert!(
            payload
                .args()
                .windows(2)
                .any(|args| { args == ["--image", attachments[0].file_path.as_str()] })
        );
        assert_eq!(&payload.args()[payload.args().len() - 2..], ["--", prompt]);
        assert_eq!(
            payload.args().iter().filter(|arg| *arg == prompt).count(),
            1
        );
        assert!(payload.initial_input_submission().is_none());
        let manifest = payload.inspectable_manifest();
        assert_eq!(manifest.transport.kind, "providerPromptArgument");
        assert_eq!(manifest.transport.delivered_content, prompt);
        assert_eq!(manifest.transport.byte_length, prompt.len());
        assert_eq!(manifest.transport.digest, content_digest(prompt));
        assert_eq!(manifest.provenance.delivered_digest, content_digest(prompt));
        assert_eq!(manifest.content_parts[0].content, prompt);
        assert_eq!(manifest.arguments.last().unwrap().display, prompt);

        // Text-only launches still use the generated terminal submission.
        let mut request = LaunchRequest::interactive("codex", "/tmp/example", &template);
        request.prompt = Some(prompt);
        let payload = resolve(request).unwrap().into_payload();
        assert!(!payload.args().iter().any(|arg| arg == prompt));
        assert_eq!(
            payload.initial_input(),
            Some(format!("{prompt}\r").as_str())
        );
        assert!(payload.initial_input_submission().is_some());
        assert_eq!(
            payload.inspectable_manifest().transport.kind,
            "terminalInput"
        );
    }

    let mut request = LaunchRequest::interactive("codex", "/tmp/example", &template);
    request.attachments = &attachments;
    let payload = resolve(request).unwrap().into_payload();
    assert!(!payload.args().iter().any(|arg| arg == "--"));
    assert!(payload.initial_input_submission().is_none());
}

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
fn opencode_go_launch_options_match_the_interactive_cli() {
    assert!(model_args("opencode", "default").unwrap().is_empty());
    assert_eq!(
        model_args("opencode", "opencode-go/kimi-k2.7-code").unwrap(),
        ["--model", "opencode-go/kimi-k2.7-code"]
    );
    assert!(matches!(
        model_args("opencode", "kimi-k2.7-code"),
        Err(InvocationError::UnsupportedModel { .. })
    ));
    assert_eq!(
        permission_args("opencode", "plan").unwrap(),
        ["--agent", "plan"]
    );
    assert_eq!(
        permission_args("opencode", "bypassPermissions").unwrap(),
        ["--auto"]
    );
    assert!(matches!(
        permission_args("opencode", "acceptEdits"),
        Err(InvocationError::UnsupportedPermission { .. })
    ));
    assert!(reasoning_args("opencode", "default").unwrap().is_empty());

    let handle = ConversationHandle::from_native("opencode", "ses_abc123".into()).unwrap();
    assert_eq!(
        conversation_args("opencode", handle.resume()).unwrap(),
        ["--session", "ses_abc123"]
    );
    assert_eq!(
        conversation_args("opencode", handle.fork()).unwrap(),
        ["--session", "ses_abc123", "--fork"]
    );
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
