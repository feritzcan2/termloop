use super::*;

#[test]
fn provisioning_journal_and_completed_spec_are_durable_and_idempotent() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-worktree-provisioning-{}-{}.json",
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
    let spec = NormalizedWorktreeSpec {
        version: 1,
        repository_root: "/repo".into(),
        repository_common_dir: "/repo/.git".into(),
        destination_path: "/worktree".into(),
        branch_name: "feature".into(),
        branch_mode: ProvisioningBranchMode::Create,
        base_ref: Some("refs/heads/main".into()),
        base_oid: Some("a".repeat(40)),
    };
    let operation = WorktreeProvisioningOperation {
        operation_id: "operation-1".into(),
        task_id: "task-1".into(),
        project_id: "project-1".into(),
        spec: spec.clone(),
        stage: ProvisioningStage::Reserved,
        created_branch_ref: false,
        failure: None,
        started_at_epoch_ms: 2,
        updated_at_epoch_ms: 2,
    };
    assert!(matches!(
        store
            .begin_task_worktree_provisioning(&authority, operation.clone())
            .unwrap(),
        BeginProvisioningOutcome::Started(_)
    ));
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store.provisioning_operations(),
        std::slice::from_ref(&operation)
    );
    assert!(matches!(
        store
            .begin_task_worktree_provisioning(&authority, operation.clone())
            .unwrap(),
        BeginProvisioningOutcome::Current(_)
    ));
    let revision = store.revision();
    assert_eq!(store.revision(), revision);
    let mut coalesced = operation.clone();
    coalesced.operation_id = "operation-2".into();
    assert!(matches!(
        store
            .begin_task_worktree_provisioning(&authority, coalesced)
            .unwrap(),
        BeginProvisioningOutcome::Current(current) if current.operation_id == "operation-1"
    ));
    assert_eq!(store.revision(), revision);
    store
        .advance_task_worktree_provisioning(
            &authority,
            "task-1",
            "operation-1",
            ProvisioningStage::BranchCreated,
            true,
            3,
        )
        .unwrap();
    let rolled_back = store
        .record_provisioning_ref_rollback(
            &authority,
            "task-1",
            "operation-1",
            ProvisioningFailureKind::OperationFailed,
            4,
        )
        .unwrap();
    assert_eq!(rolled_back.stage, ProvisioningStage::Reserved);
    assert!(!rolled_back.created_branch_ref);
    assert_eq!(
        rolled_back.failure,
        Some(ProvisioningFailureKind::OperationFailed)
    );
    let retried = store
        .retry_task_worktree_provisioning(&authority, "task-1", "operation-1", 5)
        .unwrap();
    assert_eq!(retried.failure, None);
    store
        .advance_task_worktree_provisioning(
            &authority,
            "task-1",
            "operation-1",
            ProvisioningStage::BranchCreated,
            true,
            6,
        )
        .unwrap();
    store
        .advance_task_worktree_provisioning(
            &authority,
            "task-1",
            "operation-1",
            ProvisioningStage::WorktreeAdded,
            true,
            7,
        )
        .unwrap();
    let proof = ManagedWorktreeProof {
        task_id: "task-1".into(),
        operation_id: "operation-1".into(),
        worktree_generation: 0,
        normalized_spec_version: 1,
        normalized_spec: spec.clone(),
        repository_common_dir: "/repo/.git".into(),
        registered_worktree_path: "/worktree".into(),
        branch_ref: "refs/heads/feature".into(),
    };
    store
        .commit_task_worktree_provisioning(
            &authority,
            "task-1",
            "operation-1",
            ProvisioningCommit {
                branch: TaskBranchBinding {
                    repository_root: "/repo".into(),
                    name: "feature".into(),
                },
                worktree: TaskWorktreeBinding {
                    path: "/worktree".into(),
                },
                proof: proof.clone(),
                updated_at_epoch_ms: 8,
            },
        )
        .unwrap();
    store
        .clear_task_worktree_provisioning(&authority, "task-1", "operation-1")
        .unwrap();
    let completed_revision = store.revision();
    let mut committed_proof = proof.clone();
    committed_proof.worktree_generation = 1;
    assert!(matches!(
        store
            .begin_task_worktree_provisioning(&authority, operation.clone())
            .unwrap(),
        BeginProvisioningOutcome::Completed(found) if found == committed_proof
    ));
    assert_eq!(store.revision(), completed_revision);
    let mut changed = operation;
    changed.spec.destination_path = "/different".into();
    assert!(matches!(
        store.begin_task_worktree_provisioning(&authority, changed),
        Err(StoreError::OperationIdReused { .. })
    ));
    let _ = std::fs::remove_file(path);
}
