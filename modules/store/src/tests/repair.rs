use super::*;

#[test]
fn repair_commit_atomically_rekeys_proof_and_increments_generation_once() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-repair-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-repair");
    let proof = provision_cleanup_task(
        &mut store,
        &authority,
        "task-repair",
        "provision-repair",
        10,
    );
    let operation = WorktreeRepairOperation {
        operation_id: "repair-1".into(),
        task_id: "task-repair".into(),
        managed_worktree_operation_id: proof.operation_id.clone(),
        expected_worktree_generation: 1,
        candidate_path: "/worktrees/task-repair-moved".into(),
        stage: WorktreeRepairStage::Reserved,
        failure: None,
        started_at_epoch_ms: 20,
        updated_at_epoch_ms: 20,
    };
    assert!(matches!(
        store
            .begin_task_worktree_repair(&authority, operation)
            .unwrap(),
        BeginRepairOutcome::Started(_)
    ));
    for stage in [
        WorktreeRepairStage::RepairPrepared,
        WorktreeRepairStage::RepairInvoked,
        WorktreeRepairStage::Verified,
    ] {
        store
            .advance_task_worktree_repair(&authority, "task-repair", "repair-1", stage, 21)
            .unwrap();
    }
    let committed = store
        .complete_task_worktree_repair(&authority, "task-repair", "repair-1", 22)
        .unwrap();
    assert_eq!(committed.task.worktree_generation, 2);
    assert_eq!(committed.proof.worktree_generation, 2);
    assert_eq!(
        committed.proof.registered_worktree_path,
        "/worktrees/task-repair-moved"
    );
    assert_eq!(committed.proof.operation_id, "provision-repair");
    assert_eq!(committed.proof.normalized_spec, proof.normalized_spec);
    let _ = std::fs::remove_file(path);
}

#[test]
fn failed_prepared_repair_can_resume_or_verify_after_fresh_external_observation() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-repair-retry-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-repair-retry");
    let proof = provision_cleanup_task(
        &mut store,
        &authority,
        "task-repair-retry",
        "provision-repair-retry",
        10,
    );
    let operation = WorktreeRepairOperation {
        operation_id: "repair-retry".into(),
        task_id: "task-repair-retry".into(),
        managed_worktree_operation_id: proof.operation_id,
        expected_worktree_generation: proof.worktree_generation,
        candidate_path: "/worktrees/task-repair-retry-moved".into(),
        stage: WorktreeRepairStage::Reserved,
        failure: None,
        started_at_epoch_ms: 20,
        updated_at_epoch_ms: 20,
    };
    store
        .begin_task_worktree_repair(&authority, operation)
        .unwrap();
    store
        .advance_task_worktree_repair(
            &authority,
            "task-repair-retry",
            "repair-retry",
            WorktreeRepairStage::RepairPrepared,
            21,
        )
        .unwrap();
    store
        .fail_task_worktree_repair(
            &authority,
            "task-repair-retry",
            "repair-retry",
            WorktreeRepairFailure {
                kind: WorktreeRepairFailureKind::RecoveryAttention,
                blockers: vec![WorktreeRepairBlocker::RecoveryAttention],
            },
            22,
        )
        .unwrap();

    let resumed = store
        .resume_task_worktree_repair_before_mutation(
            &authority,
            "task-repair-retry",
            "repair-retry",
            23,
        )
        .unwrap();
    assert_eq!(resumed.stage, WorktreeRepairStage::RepairPrepared);
    assert!(resumed.failure.is_none());

    store
        .fail_task_worktree_repair(
            &authority,
            "task-repair-retry",
            "repair-retry",
            WorktreeRepairFailure {
                kind: WorktreeRepairFailureKind::RecoveryAttention,
                blockers: vec![WorktreeRepairBlocker::RecoveryAttention],
            },
            24,
        )
        .unwrap();
    let verified = store
        .advance_task_worktree_repair(
            &authority,
            "task-repair-retry",
            "repair-retry",
            WorktreeRepairStage::Verified,
            25,
        )
        .unwrap();
    assert!(verified.failure.is_none());
    store
        .complete_task_worktree_repair(&authority, "task-repair-retry", "repair-retry", 26)
        .unwrap();
    assert!(store.repair_operations().is_empty());
    let _ = std::fs::remove_file(path);
}
