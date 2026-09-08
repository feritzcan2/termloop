use super::*;

fn archived_task_fixture() -> (Store, CoreWriteAuthority) {
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
    store
        .commit_task_archive(&authority, "archived-task", "archive", 100)
        .unwrap();
    (store, authority)
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
