use super::*;

#[test]
fn branch_binding_is_durable_idempotent_and_immutable() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-branch-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_task(
            &authority,
            TaskRecord {
                id: "task-1".into(),
                project_id: "project-1".into(),
                title: "Task".into(),
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
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    let binding = TaskBranchBinding {
        repository_root: "/repo".into(),
        name: "feature".into(),
    };
    let bound = store
        .bind_task_branch(&authority, "task-1", binding.clone(), 2)
        .unwrap();
    assert_eq!(bound.branch.as_ref(), Some(&binding));
    assert_eq!(bound.updated_at_epoch_ms, 2);
    let revision = store.revision();
    let retried = store
        .bind_task_branch(&authority, "task-1", binding, 99)
        .unwrap();
    assert_eq!(retried.updated_at_epoch_ms, 2);
    assert_eq!(store.revision(), revision);
    assert!(matches!(
        store.bind_task_branch(
            &authority,
            "task-1",
            TaskBranchBinding {
                repository_root: "/repo".into(),
                name: "other".into(),
            },
            3,
        ),
        Err(StoreError::ConstraintViolation)
    ));
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.tasks()[0].branch.as_ref().unwrap().name, "feature");
    let _ = std::fs::remove_file(path);
}

#[test]
fn task_developer_notes_are_durable_and_revision_safe() {
    use termloop_domain::TaskDeveloperNote;

    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-notes-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_task(
            &authority,
            TaskRecord {
                id: "task-notes".into(),
                project_id: "project-1".into(),
                title: "Task".into(),
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
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    let notes = vec![TaskDeveloperNote {
        id: "note-1".into(),
        text: "Review the sidebar".into(),
        completed: false,
    }];
    let updated = store
        .update_task_developer_notes(&authority, "task-notes", &[], notes.clone(), 2)
        .unwrap();
    assert_eq!(updated.developer_notes, notes);
    assert!(matches!(
        store.update_task_developer_notes(&authority, "task-notes", &[], vec![], 3),
        Err(StoreError::RevisionConflict)
    ));
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.tasks()[0].developer_notes, notes);
    let _ = std::fs::remove_file(path);
}

#[test]
fn branch_reservations_are_atomic_across_binding_and_provisioning() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-branch-reservation-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    for (rank, id) in ["task-a", "task-b"].into_iter().enumerate() {
        store
            .insert_task(
                &authority,
                TaskRecord {
                    id: id.into(),
                    project_id: "project-1".into(),
                    title: id.into(),
                    brief: None,
                    developer_notes: vec![],
                    status: TaskStatus::Open,
                    archived_at_epoch_ms: None,
                    branch: None,
                    worktree: None,
                    worktree_generation: 0,
                    steward_brief_markdown: String::new(),
                    steward_brief_revision: 1,
                    rank: rank as u64,
                    created_at_epoch_ms: 1,
                    updated_at_epoch_ms: 1,
                },
            )
            .unwrap();
    }
    let spec = NormalizedWorktreeSpec {
        version: 1,
        repository_root: "/repo".into(),
        repository_common_dir: "/repo/.git".into(),
        destination_path: "/worktree-a".into(),
        branch_name: "feature/reserved".into(),
        branch_mode: ProvisioningBranchMode::Create,
        base_ref: Some("refs/heads/main".into()),
        base_oid: Some("a".repeat(40)),
    };
    let operation = WorktreeProvisioningOperation {
        operation_id: "operation-a".into(),
        task_id: "task-a".into(),
        project_id: "project-1".into(),
        spec: spec.clone(),
        stage: ProvisioningStage::Reserved,
        created_branch_ref: false,
        failure: None,
        started_at_epoch_ms: 2,
        updated_at_epoch_ms: 2,
    };
    store
        .begin_task_worktree_provisioning(&authority, operation)
        .unwrap();

    assert!(matches!(
        store.bind_task_branch(
            &authority,
            "task-b",
            TaskBranchBinding {
                repository_root: "/repo".into(),
                name: "feature/reserved".into(),
            },
            3,
        ),
        Err(StoreError::BranchHeld { task_id }) if task_id == "task-a"
    ));
    assert!(matches!(
        store.bind_task_branch(
            &authority,
            "task-a",
            TaskBranchBinding {
                repository_root: "/repo".into(),
                name: "feature/different".into(),
            },
            3,
        ),
        Err(StoreError::JournalConflict { operation_id }) if operation_id == "operation-a"
    ));

    let mut contender_spec = spec;
    contender_spec.destination_path = "/worktree-b".into();
    assert!(matches!(
        store.begin_task_worktree_provisioning(
            &authority,
            WorktreeProvisioningOperation {
                operation_id: "operation-b".into(),
                task_id: "task-b".into(),
                project_id: "project-1".into(),
                spec: contender_spec,
                stage: ProvisioningStage::Reserved,
                created_branch_ref: false,
                failure: None,
                started_at_epoch_ms: 3,
                updated_at_epoch_ms: 3,
            },
        ),
        Err(StoreError::BranchHeld { task_id }) if task_id == "task-a"
    ));
    assert!(store.tasks().iter().all(|task| task.branch.is_none()));
    assert_eq!(store.provisioning_operations().len(), 1);
    let _ = std::fs::remove_file(path);
}
