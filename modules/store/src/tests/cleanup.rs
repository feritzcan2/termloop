use super::*;

fn cleanup_operation(
    task_id: &str,
    cleanup_id: &str,
    proof: &ManagedWorktreeProof,
    timestamp: u64,
) -> WorktreeCleanupOperation {
    WorktreeCleanupOperation {
        operation_id: cleanup_id.into(),
        task_id: task_id.into(),
        worktree_generation: proof.worktree_generation,
        managed_worktree_operation_id: proof.operation_id.clone(),
        cleanup_mode: termloop_domain::WorktreeCleanupMode::Safe,
        acknowledged_content_blockers: vec![],
        baseline: termloop_domain::WorktreeCleanupBaseline {
            repository_root: proof.normalized_spec.repository_root.clone(),
            repository_common_dir: proof.repository_common_dir.clone(),
            worktree_path: proof.registered_worktree_path.clone(),
            registered_worktree_path: proof.registered_worktree_path.clone(),
            branch_ref: proof.branch_ref.clone(),
            checkout_branch_ref: None,
            head_oid: "b".repeat(40),
        },
        stage: WorktreeCleanupStage::Reserved,
        failure: None,
        started_at_epoch_ms: timestamp,
        updated_at_epoch_ms: timestamp,
    }
}

fn record_failed_cleanup_remove(
    store: &mut Store,
    authority: &CoreWriteAuthority,
    operation: WorktreeCleanupOperation,
    failure_kind: WorktreeCleanupFailureKind,
) {
    let task_id = operation.task_id.clone();
    let operation_id = operation.operation_id.clone();
    assert!(matches!(
        store
            .begin_task_worktree_cleanup(authority, operation)
            .unwrap(),
        BeginCleanupOutcome::Started(_)
    ));
    store
        .advance_task_worktree_cleanup(
            authority,
            &task_id,
            &operation_id,
            WorktreeCleanupStage::RemovePrepared,
            30,
        )
        .unwrap();
    store
        .fail_task_worktree_cleanup(
            authority,
            &task_id,
            &operation_id,
            WorktreeCleanupFailure {
                kind: failure_kind,
                blockers: vec![],
            },
            31,
        )
        .unwrap();
}

fn destructive_cleanup_replacement(
    original: &WorktreeCleanupOperation,
    operation_id: &str,
) -> WorktreeCleanupOperation {
    let mut replacement = original.clone();
    replacement.operation_id = operation_id.into();
    replacement.cleanup_mode = WorktreeCleanupMode::DiscardCheckoutContent;
    replacement.acknowledged_content_blockers = vec![WorktreeCleanupBlocker::UntrackedContent];
    replacement.stage = WorktreeCleanupStage::Reserved;
    replacement.failure = None;
    replacement.started_at_epoch_ms = 40;
    replacement.updated_at_epoch_ms = 40;
    replacement
}

fn finish_absent_cleanup(
    store: &mut Store,
    authority: &CoreWriteAuthority,
    operation: WorktreeCleanupOperation,
    timestamp: u64,
) -> WorktreeCleanupReceipt {
    assert!(matches!(
        store
            .begin_task_worktree_cleanup(authority, operation.clone())
            .unwrap(),
        BeginCleanupOutcome::Started(_)
    ));
    let completed = store
        .complete_task_worktree_cleanup(
            authority,
            &operation.task_id,
            &operation.operation_id,
            timestamp,
        )
        .unwrap();
    assert_eq!(
        completed.receipt.outcome,
        WorktreeCleanupOutcome::BindingCleared
    );
    store
        .clear_task_worktree_cleanup(authority, &operation.task_id, &operation.operation_id)
        .unwrap();
    completed.receipt
}

#[test]
fn destructive_cleanup_journal_accepts_initialized_submodule_content() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-submodule-cleanup-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-submodule");
    let proof = provision_cleanup_task(
        &mut store,
        &authority,
        "task-submodule",
        "proof-submodule",
        10,
    );
    let mut operation = cleanup_operation("task-submodule", "cleanup-submodule", &proof, 20);
    operation.cleanup_mode = WorktreeCleanupMode::DiscardCheckoutContent;
    operation.baseline.checkout_branch_ref = Some("refs/heads/feature/alternate-submodule".into());
    operation.acknowledged_content_blockers = vec![
        WorktreeCleanupBlocker::TrackedChanges,
        WorktreeCleanupBlocker::StagedChanges,
        WorktreeCleanupBlocker::UntrackedContent,
        WorktreeCleanupBlocker::IgnoredContent,
        WorktreeCleanupBlocker::SubmodulePresent,
    ];

    assert!(matches!(
        store
            .begin_task_worktree_cleanup(&authority, operation)
            .unwrap(),
        BeginCleanupOutcome::Started(_)
    ));
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.cleanup_operations()[0]
            .baseline
            .checkout_branch_ref
            .as_deref(),
        Some("refs/heads/feature/alternate-submodule")
    );
    drop(reopened);
    let _ = std::fs::remove_file(path);
}

#[test]
fn cleanup_journal_tuple_cas_receipt_and_global_ids_are_atomic() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-cleanup-cas-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-a");
    insert_cleanup_task(&mut store, &authority, "task-b");
    let proof_a = provision_cleanup_task(&mut store, &authority, "task-a", "proof-a", 10);
    let operation_a = cleanup_operation("task-a", "cleanup-a", &proof_a, 20);
    assert!(matches!(
        store
            .begin_task_worktree_cleanup(&authority, operation_a.clone())
            .unwrap(),
        BeginCleanupOutcome::Started(_)
    ));
    drop(store);
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["cleanup_operations"][0]
        .as_object_mut()
        .unwrap()
        .remove("cleanup_mode");
    legacy["cleanup_operations"][0]
        .as_object_mut()
        .unwrap()
        .remove("acknowledged_content_blockers");
    std::fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store.cleanup_operations(),
        std::slice::from_ref(&operation_a)
    );
    let revision = store.revision();
    let mut changed_intent = operation_a.clone();
    changed_intent.cleanup_mode = termloop_domain::WorktreeCleanupMode::DiscardCheckoutContent;
    changed_intent.acknowledged_content_blockers =
        vec![termloop_domain::WorktreeCleanupBlocker::IgnoredContent];
    assert!(matches!(
        store.begin_task_worktree_cleanup(&authority, changed_intent),
        Err(StoreError::OperationIdReused { .. })
    ));
    let mut competing_intent = operation_a.clone();
    competing_intent.operation_id = "cleanup-a-destructive".into();
    competing_intent.cleanup_mode = termloop_domain::WorktreeCleanupMode::DiscardCheckoutContent;
    competing_intent.acknowledged_content_blockers =
        vec![termloop_domain::WorktreeCleanupBlocker::IgnoredContent];
    assert!(matches!(
        store.begin_task_worktree_cleanup(&authority, competing_intent),
        Err(StoreError::JournalConflict { .. })
    ));
    assert_eq!(store.revision(), revision);
    assert!(matches!(
        store
            .begin_task_worktree_cleanup(&authority, operation_a.clone())
            .unwrap(),
        BeginCleanupOutcome::Current(current) if current.operation_id == "cleanup-a"
    ));
    let mut coalesced = operation_a.clone();
    coalesced.operation_id = "cleanup-a-coalesced".into();
    assert!(matches!(
        store
            .begin_task_worktree_cleanup(&authority, coalesced)
            .unwrap(),
        BeginCleanupOutcome::Current(current) if current.operation_id == "cleanup-a"
    ));
    assert_eq!(store.revision(), revision);
    store
        .fail_task_worktree_cleanup(
            &authority,
            "task-a",
            "cleanup-a",
            WorktreeCleanupFailure {
                kind: WorktreeCleanupFailureKind::Timeout,
                blockers: vec![],
            },
            21,
        )
        .unwrap();
    store
        .retry_task_worktree_cleanup(&authority, "task-a", "cleanup-a", 22)
        .unwrap();
    store
        .advance_task_worktree_cleanup(
            &authority,
            "task-a",
            "cleanup-a",
            WorktreeCleanupStage::RemovePrepared,
            23,
        )
        .unwrap();
    store
        .fail_task_worktree_cleanup(
            &authority,
            "task-a",
            "cleanup-a",
            WorktreeCleanupFailure {
                kind: WorktreeCleanupFailureKind::CheckoutContentAppeared,
                blockers: vec![],
            },
            24,
        )
        .unwrap();
    let retried = store
        .retry_task_worktree_cleanup(&authority, "task-a", "cleanup-a", 25)
        .unwrap();
    assert_eq!(retried.stage, WorktreeCleanupStage::Reserved);
    store
        .advance_task_worktree_cleanup(
            &authority,
            "task-a",
            "cleanup-a",
            WorktreeCleanupStage::RemovePrepared,
            26,
        )
        .unwrap();
    store
        .advance_task_worktree_cleanup(
            &authority,
            "task-a",
            "cleanup-a",
            WorktreeCleanupStage::RemovalVerified,
            27,
        )
        .unwrap();
    let completed = store
        .complete_task_worktree_cleanup(&authority, "task-a", "cleanup-a", 28)
        .unwrap();
    assert_eq!(completed.receipt.outcome, WorktreeCleanupOutcome::Removed);
    assert!(completed.task.worktree.is_none());
    assert!(completed.task.branch.is_some());
    assert_eq!(completed.task.worktree_generation, 1);
    store
        .clear_task_worktree_cleanup(&authority, "task-a", "cleanup-a")
        .unwrap();
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let completed_revision = store.revision();
    assert!(matches!(
        store
            .begin_task_worktree_cleanup(&authority, operation_a.clone())
            .unwrap(),
        BeginCleanupOutcome::Completed(receipt) if receipt.operation_id == "cleanup-a"
    ));
    assert_eq!(store.revision(), completed_revision);

    let proof_b = provision_cleanup_task(&mut store, &authority, "task-b", "proof-b", 30);
    let reused = cleanup_operation("task-b", "cleanup-a", &proof_b, 40);
    assert!(matches!(
        store.begin_task_worktree_cleanup(&authority, reused),
        Err(StoreError::OperationIdReused { .. })
    ));
    let _ = std::fs::remove_file(path);
}

#[test]
fn stale_binding_forget_atomically_clears_the_exact_pair_and_persists_one_receipt() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-stale-forget-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-stale");
    let proof = provision_cleanup_task(&mut store, &authority, "task-stale", "proof-stale", 10);
    let operation = WorktreeStaleResolutionOperation {
        operation_id: "stale-forget".into(),
        task_id: "task-stale".into(),
        managed_worktree_operation_id: Some(proof.operation_id.clone()),
        worktree_generation: proof.worktree_generation,
        target_path: proof.registered_worktree_path.clone(),
        mode: WorktreeStaleResolutionMode::ForgetBinding,
        stage: WorktreeStaleResolutionStage::Reserved,
        failure: None,
        started_at_epoch_ms: 20,
        updated_at_epoch_ms: 20,
    };
    assert!(matches!(
        store
            .begin_task_worktree_stale_resolution(&authority, operation.clone(), None)
            .unwrap(),
        BeginStaleResolutionOutcome::Started(_)
    ));
    assert!(matches!(
        store.begin_task_worktree_stale_resolution(&authority, operation, None),
        Ok(BeginStaleResolutionOutcome::Current(_))
    ));
    let commit = store
        .complete_task_worktree_stale_resolution(&authority, "task-stale", "stale-forget", 21)
        .unwrap();
    assert!(commit.task.worktree.is_none());
    assert!(store.managed_worktrees().is_empty());
    assert!(store.stale_resolution_operations().is_empty());
    assert_eq!(store.stale_resolution_receipts(), &[commit.receipt]);

    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert!(reopened.tasks()[0].worktree.is_none());
    assert!(reopened.managed_worktrees().is_empty());
    assert_eq!(reopened.stale_resolution_receipts().len(), 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn failed_safe_dirty_refusal_can_be_atomically_superseded() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-cleanup-supersede-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-supersede");
    let proof = provision_cleanup_task(
        &mut store,
        &authority,
        "task-supersede",
        "proof-supersede",
        10,
    );
    let original = cleanup_operation("task-supersede", "cleanup-safe", &proof, 20);
    store
        .begin_task_worktree_cleanup(&authority, original.clone())
        .unwrap();
    store
        .advance_task_worktree_cleanup(
            &authority,
            "task-supersede",
            "cleanup-safe",
            WorktreeCleanupStage::RemovePrepared,
            21,
        )
        .unwrap();
    store
        .fail_task_worktree_cleanup(
            &authority,
            "task-supersede",
            "cleanup-safe",
            WorktreeCleanupFailure {
                kind: WorktreeCleanupFailureKind::CheckoutContentAppeared,
                blockers: vec![],
            },
            22,
        )
        .unwrap();
    let mut replacement = original;
    replacement.operation_id = "cleanup-destructive".into();
    replacement.cleanup_mode = termloop_domain::WorktreeCleanupMode::DiscardCheckoutContent;
    replacement.acknowledged_content_blockers =
        vec![termloop_domain::WorktreeCleanupBlocker::UntrackedContent];
    replacement.stage = WorktreeCleanupStage::Reserved;
    replacement.started_at_epoch_ms = 23;
    replacement.updated_at_epoch_ms = 23;
    let replaced = store
        .supersede_failed_task_worktree_cleanup(&authority, "cleanup-safe", replacement.clone())
        .unwrap();
    assert_eq!(replaced, replacement);
    assert_eq!(
        store.cleanup_operations(),
        std::slice::from_ref(&replacement)
    );

    let revision = store.revision();
    let mut forbidden = replacement.clone();
    forbidden.operation_id = "cleanup-second".into();
    assert!(matches!(
        store.supersede_failed_task_worktree_cleanup(&authority, "cleanup-destructive", forbidden,),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.revision(), revision);
    let _ = std::fs::remove_file(path);
}

#[test]
fn any_failed_cleanup_can_be_atomically_replaced_by_fresh_destructive_intent() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-cleanup-supersede-negative-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();

    for (task_id, proof_id, cleanup_id, failure_kind) in [
        (
            "task-permission",
            "proof-permission",
            "cleanup-permission",
            WorktreeCleanupFailureKind::PermissionDenied,
        ),
        (
            "task-generic",
            "proof-generic",
            "cleanup-generic",
            WorktreeCleanupFailureKind::RemovalFailed,
        ),
    ] {
        insert_cleanup_task(&mut store, &authority, task_id);
        let proof = provision_cleanup_task(&mut store, &authority, task_id, proof_id, 10);
        let original = cleanup_operation(task_id, cleanup_id, &proof, 20);
        record_failed_cleanup_remove(&mut store, &authority, original.clone(), failure_kind);
        let replacement =
            destructive_cleanup_replacement(&original, &format!("{cleanup_id}-replacement"));
        let replaced = store
            .supersede_failed_task_worktree_cleanup(&authority, cleanup_id, replacement.clone())
            .unwrap();
        assert_eq!(replaced, replacement);
    }

    insert_cleanup_task(&mut store, &authority, "task-destructive");
    let proof = provision_cleanup_task(
        &mut store,
        &authority,
        "task-destructive",
        "proof-destructive",
        50,
    );
    let mut destructive =
        cleanup_operation("task-destructive", "cleanup-destructive-source", &proof, 60);
    destructive.cleanup_mode = WorktreeCleanupMode::DiscardCheckoutContent;
    destructive.acknowledged_content_blockers = vec![WorktreeCleanupBlocker::UntrackedContent];
    record_failed_cleanup_remove(
        &mut store,
        &authority,
        destructive.clone(),
        WorktreeCleanupFailureKind::RecoveryAttention,
    );
    let mut safe_replacement =
        cleanup_operation("task-destructive", "cleanup-safe-replacement", &proof, 70);
    safe_replacement.baseline = destructive.baseline.clone();
    let revision = store.revision();
    assert!(matches!(
        store.supersede_failed_task_worktree_cleanup(
            &authority,
            "cleanup-destructive-source",
            safe_replacement,
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.revision(), revision);

    let replacement =
        destructive_cleanup_replacement(&destructive, "cleanup-destructive-replacement");
    let replaced = store
        .supersede_failed_task_worktree_cleanup(
            &authority,
            "cleanup-destructive-source",
            replacement.clone(),
        )
        .unwrap();
    assert_eq!(replaced, replacement);

    let _ = std::fs::remove_file(path);
}

#[test]
fn three_generation_cleanup_aba_replay_is_refused_without_a_write() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-cleanup-aba-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-aba");

    let proof_p1 = provision_cleanup_task(&mut store, &authority, "task-aba", "proof-p", 10);
    assert_eq!(proof_p1.worktree_generation, 1);
    let old_cleanup = cleanup_operation("task-aba", "cleanup-old", &proof_p1, 20);
    finish_absent_cleanup(&mut store, &authority, old_cleanup.clone(), 21);

    let proof_q = provision_cleanup_task(&mut store, &authority, "task-aba", "proof-q", 30);
    assert_eq!(proof_q.worktree_generation, 2);
    let cleanup_q = cleanup_operation("task-aba", "cleanup-q", &proof_q, 40);
    finish_absent_cleanup(&mut store, &authority, cleanup_q, 41);

    let proof_p3 = provision_cleanup_task(&mut store, &authority, "task-aba", "proof-p", 50);
    assert_eq!(proof_p3.worktree_generation, 3);
    let before_revision = store.revision();
    let before_task = store.tasks()[0].clone();
    let before_proof = store.managed_worktrees()[0].clone();
    assert!(matches!(
        store.begin_task_worktree_cleanup(&authority, old_cleanup),
        Err(StoreError::ManagedWorktreeProofChanged { .. })
    ));
    assert_eq!(store.revision(), before_revision);
    assert_eq!(store.tasks()[0], before_task);
    assert_eq!(store.managed_worktrees()[0], before_proof);
    assert!(store.cleanup_operations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn completed_cleanup_replay_is_refused_after_a_replacement_generation() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-cleanup-replacement-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-replacement");

    let proof_p = provision_cleanup_task(&mut store, &authority, "task-replacement", "proof-p", 10);
    let cleanup_p = cleanup_operation("task-replacement", "cleanup-p", &proof_p, 20);
    finish_absent_cleanup(&mut store, &authority, cleanup_p.clone(), 21);

    let proof_q = provision_cleanup_task(&mut store, &authority, "task-replacement", "proof-q", 30);
    assert_eq!(proof_q.worktree_generation, 2);
    let before_revision = store.revision();
    let before_task = store.tasks()[0].clone();
    let before_proof = store.managed_worktrees()[0].clone();
    assert!(matches!(
        store.begin_task_worktree_cleanup(&authority, cleanup_p),
        Err(StoreError::ManagedWorktreeProofChanged { .. })
    ));
    assert_eq!(store.revision(), before_revision);
    assert_eq!(store.tasks()[0], before_task);
    assert_eq!(store.managed_worktrees()[0], before_proof);
    assert!(store.cleanup_operations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn generation_overflow_and_malformed_cleanup_failure_do_not_write() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-cleanup-bounds-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-failure");
    let proof = provision_cleanup_task(&mut store, &authority, "task-failure", "proof-failure", 10);
    let operation = cleanup_operation("task-failure", "cleanup-failure", &proof, 20);
    store
        .begin_task_worktree_cleanup(&authority, operation)
        .unwrap();
    let revision = store.revision();
    assert!(matches!(
        store.fail_task_worktree_cleanup(
            &authority,
            "task-failure",
            "cleanup-failure",
            WorktreeCleanupFailure {
                kind: WorktreeCleanupFailureKind::Refused,
                blockers: vec![
                    termloop_domain::WorktreeCleanupBlocker::TrackedChanges,
                    termloop_domain::WorktreeCleanupBlocker::TrackedChanges,
                ],
            },
            21,
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.revision(), revision);
    assert!(store.cleanup_operations()[0].failure.is_none());

    insert_cleanup_task(&mut store, &authority, "task-overflow");
    let task = store
        .state
        .tasks
        .iter_mut()
        .find(|task| task.id == "task-overflow")
        .unwrap();
    task.worktree_generation = u64::MAX;
    task.branch = Some(TaskBranchBinding {
        repository_root: "/repo".into(),
        name: "feature/task-overflow".into(),
    });
    let spec = NormalizedWorktreeSpec {
        version: 1,
        repository_root: "/repo".into(),
        repository_common_dir: "/repo/.git".into(),
        destination_path: "/worktrees/task-overflow".into(),
        branch_name: "feature/task-overflow".into(),
        branch_mode: ProvisioningBranchMode::Create,
        base_ref: Some("refs/heads/main".into()),
        base_oid: Some("a".repeat(40)),
    };
    let operation = WorktreeProvisioningOperation {
        operation_id: "proof-overflow".into(),
        task_id: "task-overflow".into(),
        project_id: "project-cleanup".into(),
        spec: spec.clone(),
        stage: ProvisioningStage::Reserved,
        created_branch_ref: false,
        failure: None,
        started_at_epoch_ms: 30,
        updated_at_epoch_ms: 30,
    };
    store
        .begin_task_worktree_provisioning(&authority, operation)
        .unwrap();
    store
        .advance_task_worktree_provisioning(
            &authority,
            "task-overflow",
            "proof-overflow",
            ProvisioningStage::WorktreeAdded,
            true,
            31,
        )
        .unwrap();
    let revision = store.revision();
    assert!(matches!(
        store.commit_task_worktree_provisioning(
            &authority,
            "task-overflow",
            "proof-overflow",
            ProvisioningCommit {
                branch: TaskBranchBinding {
                    repository_root: "/repo".into(),
                    name: "feature/task-overflow".into(),
                },
                worktree: TaskWorktreeBinding {
                    path: "/worktrees/task-overflow".into(),
                },
                proof: ManagedWorktreeProof {
                    task_id: "task-overflow".into(),
                    operation_id: "proof-overflow".into(),
                    worktree_generation: 0,
                    normalized_spec_version: 1,
                    normalized_spec: spec,
                    repository_common_dir: "/repo/.git".into(),
                    registered_worktree_path: "/worktrees/task-overflow".into(),
                    branch_ref: "refs/heads/feature/task-overflow".into(),
                },
                updated_at_epoch_ms: 32,
            },
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.revision(), revision);
    let overflow_task = store
        .tasks()
        .iter()
        .find(|task| task.id == "task-overflow")
        .unwrap();
    assert!(overflow_task.worktree.is_none());
    assert_eq!(overflow_task.worktree_generation, u64::MAX);
    let _ = std::fs::remove_file(path);
}
