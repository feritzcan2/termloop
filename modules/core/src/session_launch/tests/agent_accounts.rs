use super::*;

#[test]
fn named_account_launch_is_pinned_and_legacy_resume_keeps_the_server_user() {
    let root = std::env::temp_dir().join(format!("termloop-account-launch-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut core =
        CoreRuntime::open(root.join("state.json"), TerminalService::default(), 1).unwrap();
    let project = core
        .handle(
            "project.create",
            json!({"name":"Accounts","folderPath":cwd}),
        )
        .unwrap();
    let created = core
        .handle(
            "agent.accountCreate",
            json!({"agentId":"claude","name":"Work","expectedRevision":core.state_revision()}),
        )
        .unwrap();
    let id = created["createdAccountId"].as_str().unwrap();
    let mut plan = core
        .plan_agent_launch(
            json!({"projectId":project["id"],"cwd":cwd,"agentId":"claude","accountId":id}),
        )
        .unwrap();
    assert!(!plan.account_prepared);
    assert!(
        core.complete_agent_launch(&mut plan).is_err(),
        "an unprepared account must never fall back to global credentials"
    );
    plan.prepare_runtime();
    assert!(plan.account_prepared);
    let launch = resolve_interactive_agent_launch(&plan).unwrap();
    assert_eq!(
        launch.inspectable_manifest().target.account_name.as_deref(),
        Some("Work")
    );
    assert_eq!(
        launch.inspectable_manifest().target.account_id.as_deref(),
        Some(id)
    );
    let directory = plan
        .account
        .as_ref()
        .unwrap()
        .config_directory
        .as_ref()
        .unwrap();
    assert!(
        launch
            .environment()
            .entries()
            .any(|(key, value)| key == "CLAUDE_CONFIG_DIR" && value == directory.as_os_str())
    );
    assert!(
        !serde_json::to_string(launch.inspectable_manifest())
            .unwrap()
            .contains(directory.to_str().unwrap())
    );
    core.handle(
        "agent.accountSetDefault",
        json!({"agentId":"claude","accountId":id,"expectedRevision":core.state_revision()}),
    )
    .unwrap();
    let pinned = effective_launch_selection(&plan);
    let fresh = core
        .plan_agent_launch(json!({"projectId":project["id"],"cwd":cwd,"agentId":"claude"}))
        .unwrap();
    assert_eq!(
        effective_launch_selection(&fresh).account_id.as_deref(),
        Some(id)
    );
    core.handle(
        "agent.accountSetDefault",
        json!({"agentId":"claude","accountId":"default","expectedRevision":core.state_revision()}),
    )
    .unwrap();
    assert_eq!(effective_launch_selection(&plan), pinned);
    assert_eq!(effective_launch_selection(&fresh), pinned);
    assert!(core.resolve_agent_account("codex", Some(id)).is_err());
    assert!(
        core.resolve_agent_account("claude", Some("../escape"))
            .is_err()
    );
    assert!(core.resolve_agent_account("gemini", Some(id)).is_err());
    assert!(
        core.resolve_agent_account("claude", Some("default"))
            .unwrap()
            .unwrap()
            .config_directory
            .is_none()
    );
    let serialized = serde_json::to_value(&pinned).unwrap();
    assert_eq!(serialized["accountId"], id);
    assert!(!pinned.is_default());
    let source = SessionRecord {
        id: "named-source".into(),
        project_id: project["id"].as_str().unwrap().into(),
        name: Some("Named source".into()),
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: cwd.clone(),
            agent_id: Some("claude".into()),
            template_ref: Some("builtin.agent.interactive".into()),
            template_version: Some(1),
        },
        launch_selection: pinned.clone(),
        lifecycle_state: "running".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: ResumeRef::for_provider(ResumeProvider::Claude, Uuid::new_v4().to_string()),
        resume_launch_guard: None,
        resume_failure: None,
    };
    core.store
        .insert_session(&core.write_authority, source.clone())
        .unwrap();
    core.configure_agent_observations(crate::test_agent_observation_transport(root.clone()));
    let fork = core
        .plan_agent_fork(json!({"sessionId":source.id}))
        .unwrap();
    assert_eq!(fork.account, plan.account);
    assert_eq!(effective_launch_selection(&fork), pinned);
    let mut switched = pinned.clone();
    switched.account_id = Some("default".into());
    assert!(
        core.store
            .update_running_agent_session_launch_selection(
                &core.write_authority,
                &source.id,
                1,
                source.resume_ref.as_ref().unwrap(),
                &switched
            )
            .is_err()
    );
    let restart = core
        .plan_running_agent_restart(json!({"sessionId":source.id}), 10)
        .unwrap();
    if let crate::AgentResumePlanOutcome::Prepare(restart) = restart {
        assert_eq!(restart.account, plan.account);
        assert_eq!(restart.launch_selection, pinned);
    } else {
        panic!("expected a restart plan");
    }
    drop(core);
    let reopened =
        CoreRuntime::open(root.join("state.json"), TerminalService::default(), 2).unwrap();
    assert_eq!(
        reopened
            .resolve_agent_account("claude", pinned.account_id.as_deref())
            .unwrap(),
        plan.account
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn account_change_cannot_retarget_a_quick_action_preview_ticket() {
    let root = std::env::temp_dir().join(format!("termloop-account-preview-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut core =
        CoreRuntime::open(root.join("state.json"), TerminalService::default(), 1).unwrap();
    let project = core
        .handle(
            "project.create",
            json!({"name":"Accounts","folderPath":cwd}),
        )
        .unwrap();
    let created = core
        .handle(
            "agent.accountCreate",
            json!({"agentId":"claude","name":"Work","expectedRevision":core.state_revision()}),
        )
        .unwrap();
    let mut params = json!({"projectId":project["id"],"cwd":cwd,"agentId":"claude","accountId":created["createdAccountId"],"model":"default","permission":"default","reasoning":"default","templateRef":"builtin.quick-action.free-prompt","bindings":{"prompt":"Check this change"},"attachments":[]});
    let preview = core.preview_quick_action(params.clone()).unwrap();
    params["launchTicket"] = preview["launch_ticket"].clone();
    params["accountId"] = json!("default");
    assert!(core.take_quick_action_launch(params).is_err());
    assert!(core.store.sessions().is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_session_switches_account_and_pins_the_account_against_removal() {
    let root = std::env::temp_dir().join(format!("termloop-account-switch-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut core =
        CoreRuntime::open(root.join("state.json"), TerminalService::default(), 1).unwrap();
    let project = core
        .handle(
            "project.create",
            json!({"name":"Accounts","folderPath":cwd}),
        )
        .unwrap();
    let created = core
        .handle(
            "agent.accountCreate",
            json!({"agentId":"claude","name":"Work","expectedRevision":core.state_revision()}),
        )
        .unwrap();
    let id = created["createdAccountId"].as_str().unwrap().to_owned();
    let mut selection: termloop_domain::AgentLaunchSelection = serde_json::from_value(
        json!({"model":"default","permission":"default","reasoning":"default"}),
    )
    .unwrap();
    selection.account_id = Some("default".into());
    let session = SessionRecord {
        id: "switching".into(),
        project_id: project["id"].as_str().unwrap().into(),
        name: None,
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: cwd.clone(),
            agent_id: Some("claude".into()),
            template_ref: Some("builtin.agent.interactive".into()),
            template_version: Some(1),
        },
        launch_selection: selection,
        lifecycle_state: "exited".into(),
        runtime_epoch: 3,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: None,
        resume_launch_guard: None,
        resume_failure: None,
    };
    core.store
        .insert_session(&core.write_authority, session.clone())
        .unwrap();

    assert!(
        core.plan_agent_account_switch(
            &json!({"sessionId":"switching","accountId":Uuid::new_v4().to_string()})
        )
        .is_err()
    );
    let plan = core
        .plan_agent_account_switch(&json!({"sessionId":"switching","accountId":id}))
        .unwrap();
    assert!(!plan.unchanged && !plan.running);
    assert_eq!(plan.from.account_id, "default");
    assert_eq!(plan.to.account_id, id);
    plan.share_transcript().unwrap();
    let projected = core.apply_agent_account_switch(&plan).unwrap();
    assert_eq!(projected["id"], "switching");
    assert_eq!(projected["agent_account_id"], id.as_str());
    let stored = core
        .store
        .sessions()
        .iter()
        .find(|value| value.id == "switching")
        .unwrap();
    assert_eq!(
        stored.launch_selection.account_id.as_deref(),
        Some(id.as_str())
    );
    assert_eq!(
        core.session_agent_account(stored)
            .unwrap()
            .unwrap()
            .account_id,
        id
    );

    let Err(CoreError::InvalidParams(blocked)) = core.delete_agent_account(
        json!({"agentId":"claude","accountId":id,"expectedRevision":core.state_revision()}),
    ) else {
        panic!("a pinned account must not be removed");
    };
    assert!(blocked.starts_with("1 Session still uses this account"));
    assert!(
        core.delete_agent_account(
            json!({"agentId":"claude","accountId":"default","expectedRevision":core.state_revision()}),
        )
        .is_err()
    );
    let back = core
        .plan_agent_account_switch(&json!({"sessionId":"switching","accountId":"default"}))
        .unwrap();
    core.apply_agent_account_switch(&back).unwrap();
    let (list, removed) = core
        .delete_agent_account(
            json!({"agentId":"claude","accountId":id,"expectedRevision":core.state_revision()}),
        )
        .unwrap();
    assert_eq!(removed.account_id, id);
    assert!(removed.config_directory.is_some());
    assert!(
        list["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|account| account["accountId"] != id.as_str())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_claude_conversation_missing_from_its_account_fails_resume_without_retry() {
    let root = std::env::temp_dir().join(format!("termloop-account-missing-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut core =
        CoreRuntime::open(root.join("state.json"), TerminalService::default(), 1).unwrap();
    let project = core
        .handle(
            "project.create",
            json!({"name":"Accounts","folderPath":cwd}),
        )
        .unwrap();
    let created = core
        .handle(
            "agent.accountCreate",
            json!({"agentId":"claude","name":"Work","expectedRevision":core.state_revision()}),
        )
        .unwrap();
    let mut selection: termloop_domain::AgentLaunchSelection = serde_json::from_value(
        json!({"model":"default","permission":"default","reasoning":"default"}),
    )
    .unwrap();
    selection.account_id = Some(created["createdAccountId"].as_str().unwrap().into());
    core.store
        .insert_session(
            &core.write_authority,
            SessionRecord {
                id: "missing-transcript".into(),
                project_id: project["id"].as_str().unwrap().into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                launch_selection: selection,
                lifecycle_state: "running".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    core.configure_agent_observations(crate::test_agent_observation_transport(root.clone()));
    let crate::AgentResumePlanOutcome::Prepare(mut plan) = core
        .plan_running_agent_restart(json!({"sessionId":"missing-transcript"}), 10)
        .unwrap()
    else {
        panic!("expected a restart plan");
    };
    // Claude would exit with "No conversation found"; preparation reports the
    // loss before any provider process starts, and the mapped reason is final.
    assert_eq!(
        plan.prepare_runtime(),
        Err(AgentResumePreparationError::ConversationUnavailable)
    );
    assert!(!ResumeFailureReason::ProviderSessionUnavailable.is_retryable());
    std::fs::remove_dir_all(root).unwrap();
}
