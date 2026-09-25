use super::*;

#[test]
fn daemon_restart_prepares_saved_permissions_before_starting_codex() {
    check_saved_permissions(false);
}

#[test]
#[ignore = "requires installed Codex with App Server remote resume support"]
fn daemon_restart_real_codex_tui_inherits_saved_permissions() {
    check_saved_permissions(true);
}

fn check_saved_permissions(real_codex: bool) {
    use termloop_agents::CodexPermissionMode;

    for (permission, expected) in [
        ("default", CodexPermissionMode::Default),
        ("acceptEdits", CodexPermissionMode::AcceptEdits),
        ("plan", CodexPermissionMode::Plan),
        ("bypassPermissions", CodexPermissionMode::BypassPermissions),
    ] {
        let root =
            std::env::temp_dir().join(format!("termloop-resume-permissions-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let cwd = termloop_platform::canonical_existing_directory_path(&root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let state = root.join("state.json");
        let native_thread_id = Uuid::new_v4().to_string();
        let mut previous = CoreRuntime::open(&state, TerminalService::default(), 1).unwrap();
        previous
            .store
            .insert_session(
                &previous.write_authority,
                SessionRecord {
                    id: "saved-codex".into(),
                    project_id: "project-a".into(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: cwd.clone(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.agent.interactive".into()),
                        template_version: Some(1),
                    },
                    launch_selection: termloop_domain::AgentLaunchSelection::new(
                        "default", permission, "default",
                    ),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Codex,
                        native_thread_id.clone(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        previous
            .store
            .mark_agent_conversation_resumable(&previous.write_authority, "saved-codex")
            .unwrap();
        drop(previous);

        let terminal = TerminalService::default();
        let mut restarted = CoreRuntime::open(&state, terminal.clone(), 2).unwrap();
        restarted.configure_agent_observations(crate::test_agent_observation_transport(
            root.join("provider"),
        ));
        let crate::AgentResumePlanOutcome::Prepare(mut plan) = restarted
            .plan_daemon_restart_agent_resume(json!({"sessionId": "saved-codex"}), 100)
            .unwrap()
        else {
            panic!("expected automatic restart plan");
        };
        assert!(
            plan.prepared_launch.is_none(),
            "automatic resume has no preview ticket"
        );

        if real_codex {
            check_real_codex_resume(&mut plan, &root, &native_thread_id, expected);
            drop(plan);
            drop(restarted);
            std::fs::remove_dir_all(root).unwrap();
            continue;
        }

        // Stop at the provider boundary without launching an installed Codex.
        // The saved selection must already be available to its preparation.
        plan.runtime_signal_sender = None;
        assert_eq!(
            plan.prepare_runtime(),
            Err(crate::AgentResumePreparationError::ProviderRejected)
        );
        let launch = plan
            .prepared_launch
            .as_ref()
            .expect("automatic resume must compose before provider preparation");
        let permissions = launch
            .codex_resume_permissions()
            .expect("remote resume must prepare saved permissions");
        assert_eq!(permissions.native_thread_id(), native_thread_id);
        assert_eq!(permissions.permission(), expected);
        assert_eq!(launch.inspectable_manifest().target.permission, permission);
        assert!(!terminal.contains_session("saved-codex").unwrap());
        drop(plan);
        drop(restarted);
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn check_real_codex_resume(
    plan: &mut crate::AgentResumePlan,
    root: &std::path::Path,
    native_thread_id: &str,
    expected: termloop_agents::CodexPermissionMode,
) {
    let home = root.join("accounts/codex/test");
    let sessions = home.join("sessions/2026/09/25");
    std::fs::create_dir_all(&sessions).unwrap();
    let timestamp = "2026-09-25T08:00:00Z";
    let entries = [
        json!({"timestamp": timestamp, "type": "session_meta", "payload": {
            "id": native_thread_id, "timestamp": timestamp, "cwd": plan.cwd,
            "originator": "codex_cli_rs", "cli_version": "0.153.4", "source": "cli",
            "model_provider": "openai"
        }}),
        json!({"timestamp": timestamp, "type": "response_item", "payload": {
            "type": "message", "role": "user", "content": [{"type": "input_text", "text": "Permission resume fixture"}]
        }}),
        json!({"timestamp": timestamp, "type": "response_item", "payload": {
            "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Fixture complete."}]
        }}),
    ];
    std::fs::write(
        sessions.join(format!(
            "rollout-2026-09-25T08-00-00-{native_thread_id}.jsonl"
        )),
        entries
            .iter()
            .map(|entry| format!("{entry}\n"))
            .collect::<String>(),
    )
    .unwrap();
    std::fs::write(
        home.join("auth.json"),
        r#"{"OPENAI_API_KEY":"sk-local-resume-fixture"}"#,
    )
    .unwrap();
    std::fs::write(home.join("config.toml"), format!(
        "check_for_update_on_startup=false\napproval_policy=\"on-request\"\nsandbox_mode=\"read-only\"\n[projects.{}]\ntrust_level=\"trusted\"\n",
        serde_json::to_string(&plan.cwd).unwrap(),
    )).unwrap();
    plan.account = Some(termloop_agents::AgentAccountContext {
        agent_id: "codex".into(),
        account_id: "test".into(),
        name: "Test".into(),
        config_directory: Some(home),
    });
    // This fixture neither contacts TermLoop's MCP nor submits a model turn.
    plan.mcp_token = None;
    plan.mcp_role = None;
    let (sender, signals) = std::sync::mpsc::channel();
    plan.runtime_signal_sender = Some(sender);
    plan.prepare_runtime()
        .expect("real Codex automatic resume must prepare and spawn");
    let mut output = plan
        .terminal
        .subscribe(&plan.session_id, plan.runtime_epoch)
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut bytes = Vec::new();
    let mut answered_queries = 0;
    let mut status_requested = false;
    let mut status_submitted = false;
    let reader = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    loop {
        if let Ok(Ok(termloop_terminal::TerminalEvent::Output(chunk))) = reader.block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(50), output.recv()).await
        }) {
            append_headless_output_and_answer_cursor_queries(
                &plan.terminal,
                &plan.session_id,
                plan.runtime_epoch,
                &mut bytes,
                &mut answered_queries,
                chunk,
            );
        }
        if status_requested
            && !status_submitted
            && String::from_utf8_lossy(&bytes).contains("show current session configuration")
        {
            plan.terminal
                .input_user(&plan.session_id, plan.runtime_epoch, b"\r")
                .unwrap();
            status_submitted = true;
        }
        if status_submitted {
            let text = String::from_utf8_lossy(&bytes);
            if let Some(line) = text
                .split_inclusive('\n')
                .find(|line| line.ends_with('\n') && line.contains("Permissions:"))
            {
                let expected_label = match expected {
                    termloop_agents::CodexPermissionMode::Default => "Workspace (Ask for approval)",
                    termloop_agents::CodexPermissionMode::AcceptEdits => {
                        "Workspace (Approve for me)"
                    }
                    termloop_agents::CodexPermissionMode::Plan => "Read Only (Ask for approval)",
                    termloop_agents::CodexPermissionMode::BypassPermissions => "Full access",
                };
                assert!(
                    line.to_ascii_lowercase()
                        .contains(&expected_label.to_ascii_lowercase()),
                    "unexpected TUI permissions for {expected:?}: {line}"
                );
                break;
            }
        }
        match signals.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(termloop_agents::AgentRuntimeSignal {
                event: termloop_agents::AgentRuntimeEvent::ResumeRefObserved(reference),
                ..
            }) if reference.native_session_id == native_thread_id && !status_requested => {
                plan.terminal
                    .input_user(&plan.session_id, plan.runtime_epoch, b"/status")
                    .unwrap();
                status_requested = true;
            }
            _ => assert!(
                std::time::Instant::now() < deadline,
                "TUI status was not observed: {}",
                String::from_utf8_lossy(&bytes)
            ),
        }
    }
}
