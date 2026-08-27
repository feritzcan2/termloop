use super::*;

#[test]
fn ordinary_agent_launch_preference_is_atomic_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-agent-launch-preference-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session_and_remember_agent_launch(
            &authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "gpt-5.6-sol",
                    "bypassPermissions",
                    "high",
                ),
                id: "selected-agent".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    drop(store);

    let reopened = Store::open(&path).unwrap();
    let saved = reopened.last_agent_launch_selection().unwrap();
    assert_eq!(saved.agent_id, "codex");
    assert_eq!(saved.selection.model, "gpt-5.6-sol");
    assert_eq!(saved.selection.permission, "bypassPermissions");
    assert_eq!(saved.selection.reasoning, "high");
    let _ = std::fs::remove_file(path);
}

#[test]
fn live_codex_launch_selection_update_is_fenced_durable_and_session_local() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-live-codex-permission-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    let resume_ref = ResumeRef::for_provider(ResumeProvider::Codex, "thread-a".into()).unwrap();
    store
        .insert_session_and_remember_agent_launch(
            &authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "gpt-5.6-sol",
                    "default",
                    "high",
                ),
                id: "live-codex".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: Some(resume_ref.clone()),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();

    let initial_revision = store.revision();
    store
        .update_running_agent_session_launch_selection(
            &authority,
            "live-codex",
            7,
            &resume_ref,
            &termloop_domain::AgentLaunchSelection::new(
                "gpt-5.6-terra",
                "bypassPermissions",
                "xhigh",
            ),
        )
        .unwrap();
    assert_eq!(store.revision(), initial_revision + 1);
    assert_eq!(store.sessions()[0].launch_selection.model, "gpt-5.6-terra");
    assert_eq!(
        store.sessions()[0].launch_selection.permission,
        "bypassPermissions"
    );
    assert_eq!(store.sessions()[0].launch_selection.reasoning, "xhigh");
    assert_eq!(
        store
            .last_agent_launch_selection()
            .unwrap()
            .selection
            .permission,
        "default"
    );
    store
        .update_running_agent_session_launch_selection(
            &authority,
            "live-codex",
            7,
            &resume_ref,
            &termloop_domain::AgentLaunchSelection::new(
                "gpt-5.6-terra",
                "bypassPermissions",
                "xhigh",
            ),
        )
        .unwrap();
    assert_eq!(store.revision(), initial_revision + 1);
    assert!(matches!(
        store.update_running_agent_session_launch_selection(
            &authority,
            "live-codex",
            8,
            &resume_ref,
            &termloop_domain::AgentLaunchSelection::default(),
        ),
        Err(StoreError::ConstraintViolation)
    ));
    let other_ref = ResumeRef::for_provider(ResumeProvider::Codex, "thread-b".into()).unwrap();
    assert!(matches!(
        store.update_running_agent_session_launch_selection(
            &authority,
            "live-codex",
            7,
            &other_ref,
            &termloop_domain::AgentLaunchSelection::default(),
        ),
        Err(StoreError::ConstraintViolation)
    ));
    drop(store);

    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.sessions()[0].launch_selection.permission,
        "bypassPermissions"
    );
    assert_eq!(
        reopened.sessions()[0].launch_selection.model,
        "gpt-5.6-terra"
    );
    assert_eq!(reopened.sessions()[0].launch_selection.reasoning, "xhigh");
    assert_eq!(
        reopened
            .last_agent_launch_selection()
            .unwrap()
            .selection
            .permission,
        "default"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn live_claude_launch_selection_update_requires_the_matching_provider_and_agent() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-live-claude-model-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    let resume_ref = ResumeRef::for_provider(
        ResumeProvider::Claude,
        "3b1c1c3e-0d1a-4c2b-9a5e-2f0f1d7c8a90".into(),
    )
    .unwrap();
    store
        .insert_session_and_remember_agent_launch(
            &authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "opus[1m]", "default", "default",
                ),
                id: "live-claude".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 3,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: Some(resume_ref.clone()),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();

    store
        .update_running_agent_session_launch_selection(
            &authority,
            "live-claude",
            3,
            &resume_ref,
            &termloop_domain::AgentLaunchSelection::new("sonnet", "default", "default"),
        )
        .unwrap();
    assert_eq!(store.sessions()[0].launch_selection.model, "sonnet");

    // A Codex reference can never move a Claude Session, whichever conversation
    // id it carries.
    let foreign_ref = ResumeRef::for_provider(ResumeProvider::Codex, "thread-a".into()).unwrap();
    assert!(matches!(
        store.update_running_agent_session_launch_selection(
            &authority,
            "live-claude",
            3,
            &foreign_ref,
            &termloop_domain::AgentLaunchSelection::new("haiku", "default", "default"),
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(matches!(
        store.update_running_agent_session_launch_selection(
            &authority,
            "live-claude",
            3,
            &resume_ref,
            &termloop_domain::AgentLaunchSelection::new("", "default", "default"),
        ),
        Err(StoreError::ConstraintViolation)
    ));
    drop(store);

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.sessions()[0].launch_selection.model, "sonnet");
    assert_eq!(
        reopened
            .last_agent_launch_selection()
            .unwrap()
            .selection
            .model,
        "opus[1m]"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn restart_reconcile_preserves_unconfirmed_agent_without_automatic_resume() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "opus[1m]",
                    "bypassPermissions",
                    "high",
                ),
                id: "logical-session".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.sessions()[0].launch_selection.model, "opus[1m]");
    assert_eq!(
        reopened.sessions()[0].launch_selection.permission,
        "bypassPermissions"
    );
    assert_eq!(reopened.sessions()[0].launch_selection.reasoning, "high");
    reopened.reconcile_restart(&authority).unwrap();
    assert_eq!(reopened.sessions()[0].id, "logical-session");
    assert_eq!(reopened.sessions()[0].lifecycle_state, "exited");
    assert_eq!(reopened.sessions()[0].resume_failure, None);
    assert_eq!(
        reopened.agent_conversation_readiness("logical-session"),
        Some(termloop_domain::AgentConversationReadiness::Unconfirmed)
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn resume_reference_establish_is_idempotent_immutable_and_restart_ready() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-resume-ref-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "resumable".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let reference = ResumeRef::for_provider(
        ResumeProvider::Claude,
        "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
    )
    .unwrap();
    store
        .establish_session_resume_ref(&authority, "resumable", reference.clone())
        .unwrap();
    let revision = store.revision();
    assert_eq!(
        store
            .establish_session_resume_ref(&authority, "resumable", reference)
            .unwrap(),
        revision
    );
    assert!(matches!(
        store.establish_session_resume_ref(
            &authority,
            "resumable",
            ResumeRef::for_provider(
                ResumeProvider::Claude,
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036".into(),
            )
            .unwrap(),
        ),
        Err(StoreError::ResumeRefReplacement)
    ));
    store
        .mark_agent_conversation_resumable(&authority, "resumable")
        .unwrap();
    store.reconcile_restart(&authority).unwrap();
    assert_eq!(store.sessions()[0].lifecycle_state, "resuming");
    assert_eq!(store.sessions()[0].runtime_epoch, 7);
    assert_eq!(
        store.agent_conversation_readiness("resumable"),
        Some(termloop_domain::AgentConversationReadiness::Resumable)
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn running_codex_resume_reference_retargets_with_exact_current_cas() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-codex-retarget-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let original = ResumeRef::for_provider(ResumeProvider::Codex, "thread-a".into()).unwrap();
    let replacement = ResumeRef::for_provider(ResumeProvider::Codex, "thread-b".into()).unwrap();
    let stale = ResumeRef::for_provider(ResumeProvider::Codex, "thread-stale".into()).unwrap();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "codex-session".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: Some(original.clone()),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();

    let before = store.revision();
    store
        .replace_running_session_resume_ref(
            &authority,
            "codex-session",
            &original,
            replacement.clone(),
        )
        .unwrap();
    assert!(store.revision() > before);
    assert_eq!(store.sessions()[0].resume_ref.as_ref(), Some(&replacement));
    assert!(matches!(
        store.replace_running_session_resume_ref(&authority, "codex-session", &stale, original,),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.sessions()[0].resume_ref.as_ref(), Some(&replacement));

    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.sessions()[0].resume_ref.as_ref(),
        Some(&replacement)
    );
    reopened
        .mark_agent_conversation_resumable(&authority, "codex-session")
        .unwrap();
    reopened.reconcile_restart(&authority).unwrap();
    assert_eq!(reopened.sessions()[0].lifecycle_state, "resuming");
    assert_eq!(
        reopened.sessions()[0].resume_ref.as_ref(),
        Some(&replacement)
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn transient_capability_probe_failure_is_requeued_on_restart() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-resume-capability-retry-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "capability-retry".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::ResumeCapabilityUnavailable),
            },
        )
        .unwrap();

    store
        .mark_agent_conversation_resumable(&authority, "capability-retry")
        .unwrap();

    store.reconcile_restart(&authority).unwrap();

    assert_eq!(store.sessions()[0].lifecycle_state, "resuming");
    assert_eq!(store.sessions()[0].resume_failure, None);
    assert_eq!(store.sessions()[0].runtime_epoch, 7);
    let _ = std::fs::remove_file(path);
}

#[test]
fn generic_restart_is_stale_and_close_deletes_only_the_descriptor() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-stale-close-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "terminal".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Terminal,
                process: ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: None,
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 3,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    store.reconcile_restart(&authority).unwrap();
    assert_eq!(store.sessions()[0].lifecycle_state, "stale");
    store
        .delete_session_descriptor(&authority, "terminal")
        .unwrap();
    assert!(store.sessions().is_empty());

    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "conflicted-agent".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 3,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: Some(
                    ResumeRef::for_provider(
                        ResumeProvider::Claude,
                        "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
                    )
                    .unwrap(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::RuntimeConflict),
            },
        )
        .unwrap();
    assert!(matches!(
        store.delete_session_descriptor(&authority, "conflicted-agent"),
        Err(StoreError::SessionNotClosable)
    ));
    let _ = std::fs::remove_file(path);
}

#[test]
fn session_rename_is_current_state_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-rename-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "rename-session".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Terminal,
                process: ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: None,
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    store
        .rename_session(&authority, "rename-session", Some("Build API".into()))
        .unwrap();
    drop(store);

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.sessions()[0].name.as_deref(), Some("Build API"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn retired_agent_topic_state_is_removed_without_losing_the_user_name() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-session-name-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        r#"{
              "schema_version": 1,
              "revision": 1,
              "mcp_tool_description_overrides": [{
                "tool": "session_topic_update",
                "description": "Retired custom topic description"
              }],
              "projects": [],
              "sessions": [{
                "id": "legacy-session",
                "project_id": "project",
                "name": "User name",
                "agent_topic": "Retired agent topic",
                "kind": "Terminal",
                "process": {
                  "program": "shell",
                  "args": [],
                  "cwd": "/tmp",
                  "agent_id": null,
                  "template_ref": null,
                  "template_version": null
                },
                "lifecycle_state": "exited",
                "runtime_epoch": 1
              }]
            }"#,
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.sessions()[0].name.as_deref(), Some("User name"));
    assert!(store.mcp_tool_description_overrides().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(persisted["sessions"][0].get("agent_topic").is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn existing_state_without_tasks_migrates_to_an_empty_current_collection() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        r#"{
              "schema_version": 1,
              "revision": 0,
              "projects": [],
              "sessions": []
            }"#,
    )
    .unwrap();
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    assert!(store.tasks().is_empty());
    store
        .insert_task(
            &authority,
            TaskRecord {
                id: "task-1".into(),
                project_id: "project-1".into(),
                title: "Task".into(),
                brief: None,
                status: TaskStatus::Open,
                archived_at_epoch_ms: None,
                branch: None,
                worktree: None,
                worktree_generation: 0,
                steward_brief_markdown: String::new(),
                steward_brief_revision: 1,
                rank: 0,
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.tasks()[0].title, "Task");
    let _ = std::fs::remove_file(path);
}

#[test]
fn marking_an_exited_session_again_does_not_create_a_revision() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-idempotent-exit-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "already-exited".into(),
                project_id: "project".into(),
                name: None,
                kind: SessionKind::Terminal,
                process: ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: None,
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let revision = store.revision();
    assert_eq!(
        store
            .mark_session_exited(&authority, "already-exited")
            .unwrap(),
        revision
    );
    assert_eq!(store.revision(), revision);
    let _ = std::fs::remove_file(path);
}

#[test]
fn ask_to_current_request_survives_source_exit_until_descriptor_delete() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-ask-to-continuation-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let agent = |id: &str, template_ref: &str, source: Option<&str>| SessionRecord {
        launch_selection: Default::default(),
        id: id.into(),
        project_id: "project".into(),
        name: None,
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: "/tmp".into(),
            agent_id: Some("claude".into()),
            template_ref: Some(template_ref.into()),
            template_version: Some(1),
        },
        lifecycle_state: "running".into(),
        runtime_epoch: 7,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: source.map(str::to_owned),
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: source.map(|_| AskToContinuation {
            conversation_id: "conversation-1".into(),
            current_request_id: Some("request-1".into()),
        }),
        resume_ref: ResumeRef::for_provider(
            ResumeProvider::Claude,
            format!(
                "019f1dae-3bf3-73d1-b3c7-08ddbbd1f0{}",
                if source.is_some() { 36 } else { 35 }
            ),
        ),
        resume_launch_guard: None,
        resume_failure: None,
    };
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            agent("source", "builtin.agent.interactive", None),
        )
        .unwrap();
    store
        .insert_session(
            &authority,
            agent("helper", "builtin.agent.ask-to-helper", Some("source")),
        )
        .unwrap();
    drop(store);

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.sessions()[1]
            .ask_to_continuation
            .as_ref()
            .and_then(|value| value.current_request_id.as_deref()),
        Some("request-1")
    );
    reopened
        .set_ask_to_current_request(&authority, "helper", "conversation-1", Some("request-2"))
        .unwrap();
    assert_eq!(
        reopened.sessions()[1]
            .ask_to_continuation
            .as_ref()
            .and_then(|value| value.current_request_id.as_deref()),
        Some("request-2")
    );
    drop(reopened);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.sessions()[1]
            .ask_to_continuation
            .as_ref()
            .and_then(|value| value.current_request_id.as_deref()),
        Some("request-2")
    );
    reopened
        .set_ask_to_current_request(&authority, "helper", "conversation-1", Some("request-3"))
        .unwrap();
    reopened.mark_session_exited(&authority, "source").unwrap();
    drop(reopened);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.sessions()[1]
            .ask_to_continuation
            .as_ref()
            .and_then(|value| value.current_request_id.as_deref()),
        Some("request-3")
    );
    assert!(matches!(
        reopened.set_ask_to_current_request(
            &authority,
            "helper",
            "conversation-1",
            Some("request-4"),
        ),
        Err(StoreError::ConstraintViolation)
    ));
    reopened.mark_session_exited(&authority, "helper").unwrap();
    drop(reopened);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.sessions()[1]
            .ask_to_continuation
            .as_ref()
            .and_then(|value| value.current_request_id.as_deref()),
        Some("request-3")
    );
    reopened
        .delete_session_descriptor(&authority, "source")
        .unwrap();
    assert_eq!(reopened.sessions()[0].ask_to_continuation, None);
    let persisted = std::fs::read_to_string(&path).unwrap();
    assert!(!persisted.contains("question text"));
    assert!(!persisted.contains("reply text"));
    assert!(!persisted.contains("bearer"));
    let _ = std::fs::remove_file(path);
}
