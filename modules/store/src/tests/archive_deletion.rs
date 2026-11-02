use super::*;

fn pending_task_archive_fixture() -> (Store, CoreWriteAuthority) {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-archive-deletion-{}.json",
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-cleanup".into(),
                name: "Project".into(),
                folder_path: "/repo".into(),
            },
        )
        .unwrap();
    insert_cleanup_task(&mut store, &authority, "archived-task");
    for id in ["archived-agent", "surviving-agent"] {
        store
            .insert_session(
                &authority,
                SessionRecord {
                    id: id.into(),
                    project_id: "project-cleanup".into(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: "/repo".into(),
                        agent_id: Some("codex".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "exited".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    fork_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                    launch_selection: Default::default(),
                },
            )
            .unwrap();
    }
    store
        .begin_task_archive(
            &authority,
            termloop_domain::TaskArchiveOperation {
                operation_id: "archive".into(),
                task_id: "archived-task".into(),
                project_id: "project-cleanup".into(),
                worktree_path: None,
                worktree_generation: 0,
                targets: vec![termloop_domain::TaskArchiveTarget {
                    session_id: "archived-agent".into(),
                    runtime_epoch: 1,
                    prior_lifecycle_state: "exited".into(),
                    prior_resume_failure: None,
                    was_live_agent: false,
                }],
                state: termloop_domain::TaskArchiveOperationState::Prepared,
            },
        )
        .unwrap();
    (store, authority)
}

fn archived_task_fixture() -> (Store, CoreWriteAuthority) {
    let (mut store, authority) = pending_task_archive_fixture();
    store
        .commit_task_archive(&authority, "archived-task", "archive", 100)
        .unwrap();
    (store, authority)
}

#[test]
fn an_agent_held_by_an_unfinished_task_archive_cannot_be_deleted() {
    let (mut store, authority) = pending_task_archive_fixture();
    let journal_conflict = |result: Result<_, StoreError>| matches!(result, Err(StoreError::JournalConflict { operation_id }) if operation_id == "archive");
    assert!(journal_conflict(
        store
            .move_agent_session_to_deleted(&authority, "archived-agent", 100)
            .map(|_| ())
    ));
    assert!(journal_conflict(
        store
            .delete_session_descriptor(&authority, "archived-agent")
            .map(|_| ())
    ));
    store
        .move_agent_session_to_deleted(&authority, "surviving-agent", 100)
        .unwrap();
    assert!(Store::open(&store.path).is_ok());
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn loading_drops_a_task_archive_target_whose_agent_was_already_deleted() {
    let (store, _) = pending_task_archive_fixture();
    let mut written = serde_json::to_value(&store.state).unwrap();
    written["sessions"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["id"] != "archived-agent");
    written["agent_conversation_readiness"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["sessionId"] != "archived-agent");
    std::fs::write(&store.path, serde_json::to_vec(&written).unwrap()).unwrap();
    let reopened = Store::open(&store.path).unwrap();
    let operations = reopened.task_archive_operations();
    assert_eq!(operations.len(), 1);
    assert!(operations[0].targets.is_empty());
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn archived_task_deletion_removes_only_its_session_readiness_and_reopens() {
    let (mut store, authority) = archived_task_fixture();
    let survivor = store.agent_conversation_readiness("surviving-agent");
    store
        .delete_archived_task_with_sessions(
            &authority,
            "archived-task",
            100,
            &["archived-agent".into()],
        )
        .unwrap();
    assert_eq!(store.agent_conversation_readiness("archived-agent"), None);
    assert_eq!(
        store.agent_conversation_readiness("surviving-agent"),
        survivor
    );
    let reopened = Store::open(&store.path).unwrap();
    assert!(reopened.tasks().is_empty());
    assert!(reopened.task_archive_suspensions().is_empty());
    assert_eq!(reopened.sessions().len(), 1);
    assert_eq!(reopened.sessions()[0].id, "surviving-agent");
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn archived_task_deletion_restores_session_sidecars_on_failed_commit() {
    let (mut store, authority) = archived_task_fixture();
    let path = store.path.clone();
    let before = serde_json::to_value(&store.state).unwrap();
    // An existing file cannot serve as the parent directory of a state file.
    store.path = path.join("cannot-write.json");
    assert!(matches!(
        store.delete_archived_task_with_sessions(
            &authority,
            "archived-task",
            100,
            &["archived-agent".into()],
        ),
        Err(StoreError::Io(_))
    ));
    assert_eq!(serde_json::to_value(&store.state).unwrap(), before);
    assert_eq!(
        serde_json::to_value(Store::open(&path).unwrap().state).unwrap(),
        before
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn schema_60_repairs_readiness_left_by_archived_task_deletion() {
    let (store, _) = archived_task_fixture();
    let mut legacy = serde_json::to_value(&store.state).unwrap();
    legacy["schema_version"] = json!(60);
    legacy["tasks"] = json!([]);
    legacy["task_archive_suspensions"] = json!([]);
    legacy["sessions"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["id"] != "archived-agent");
    std::fs::write(&store.path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let reopened = Store::open(&store.path).unwrap();
    assert_eq!(
        reopened.agent_conversation_readiness("archived-agent"),
        None
    );
    assert_eq!(
        reopened.agent_conversation_readiness("surviving-agent"),
        store.agent_conversation_readiness("surviving-agent")
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&store.path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["agent_conversation_readiness"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(Store::open(&store.path).is_ok());
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn readiness_migration_does_not_hide_missing_or_duplicate_live_records() {
    let (store, _) = archived_task_fixture();
    for duplicate in [false, true] {
        let mut legacy = serde_json::to_value(&store.state).unwrap();
        legacy["schema_version"] = json!(60);
        let rows = legacy["agent_conversation_readiness"]
            .as_array_mut()
            .unwrap();
        if duplicate {
            rows.push(rows[0].clone());
        } else {
            rows.pop();
        }
        std::fs::write(&store.path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(matches!(
            Store::open(&store.path),
            Err(StoreError::CorruptRecord)
        ));
    }
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn archived_task_deletion_frees_its_jira_issue_for_a_fresh_import() {
    use termloop_domain::{
        IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, TaskSourceBranchNaming,
        TaskSourceConfiguration, TaskSourceImportPolicy, TaskSourceProvider, TaskSourceScope,
    };
    let (mut store, authority) = archived_task_fixture();
    store
        .insert_task_source_configuration(
            &authority,
            TaskSourceConfiguration {
                id: "source-1".into(),
                project_id: "project-cleanup".into(),
                provider: TaskSourceProvider::Jira,
                name: "Jira work".into(),
                enabled: true,
                generation: 1,
                site_base_url: "https://example.atlassian.net".into(),
                scope: TaskSourceScope::AssignedToMe,
                boards: vec![],
                statuses: vec![],
                import_policy: TaskSourceImportPolicy::Review,
                auto_import_active_task_limit:
                    termloop_domain::TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT,
                refresh_interval_seconds: 900,
                ignored_external_ids: vec![],
                branch_naming: TaskSourceBranchNaming::Title,
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    let link = |task_id: &str| IssueLink {
        task_id: task_id.into(),
        provider: IssueLinkProvider::Jira,
        external_ref: "TERM-42".into(),
        source_id: Some("source-1".into()),
        external_id: Some("10042".into()),
        external_updated_at: Some("2026-08-26T10:00:00.000+0000".into()),
        url: Some("https://example.atlassian.net/browse/TERM-42".into()),
        sync_authority: IssueLinkSyncAuthority::None,
    };
    store
        .insert_task_jira_issue_link(&authority, link("archived-task"))
        .unwrap();

    store
        .delete_archived_task_with_sessions(
            &authority,
            "archived-task",
            100,
            &["archived-agent".into()],
        )
        .unwrap();
    assert!(store.issue_links().is_empty());

    let reimported = TaskRecord {
        id: "reimported-task".into(),
        project_id: "project-cleanup".into(),
        title: "Imported".into(),
        brief: None,
        developer_notes: vec![],
        status: TaskStatus::Open,
        archived_at_epoch_ms: None,
        branch: None,
        worktree: None,
        worktree_generation: 0,
        steward_brief_markdown: String::new(),
        steward_brief_revision: 1,
        rank: 0,
        created_at_epoch_ms: 200,
        updated_at_epoch_ms: 200,
    };
    store
        .insert_task_from_source(&authority, reimported, link("reimported-task"))
        .unwrap();
    let reopened = Store::open(&store.path).unwrap();
    assert_eq!(reopened.issue_links().len(), 1);
    assert_eq!(reopened.issue_links()[0].task_id, "reimported-task");
    std::fs::remove_file(&store.path).unwrap();
}
