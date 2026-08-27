use super::*;

#[test]
fn clean_worktree_cleanup_preserves_task_branch_and_replays_without_writing() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let operation_id = Uuid::new_v4().to_string();
    let params = cleanup_params(&task_id, &operation_id, &proof_id, generation);
    assert!(matches!(
        fixture.runtime.delete_task(json!({ "taskId": task_id })),
        Err(CoreError::TaskWorktreeCleanupRequired { .. })
    ));

    let result = fixture
        .runtime
        .cleanup_task_worktree(params.clone())
        .unwrap();
    assert_eq!(result["outcome"], "removed");
    assert!(result["task"]["worktree"].is_null());
    assert_eq!(result["task"]["branch"]["name"], "feature/cleanup");
    assert_eq!(result["task"]["worktree_generation"], generation);
    assert!(!destination.exists());
    assert!(fixture.runtime.store.managed_worktrees().is_empty());
    assert!(fixture.runtime.store.cleanup_operations().is_empty());

    let revision = fixture.runtime.state_revision();
    let replay = fixture
        .runtime
        .cleanup_task_worktree(params.clone())
        .unwrap();
    assert_eq!(replay["outcome"], "alreadyCompleted");
    assert_eq!(fixture.runtime.state_revision(), revision);

    let different_id = cleanup_params(&task_id, &Uuid::new_v4().to_string(), &proof_id, generation);
    assert!(matches!(
        fixture.runtime.cleanup_task_worktree(different_id),
        Err(CoreError::WorktreeCleanupRefused { blockers, .. })
            if blockers == vec![WorktreeCleanupBlocker::NoBinding]
    ));

    let replacement = fixture
        .project_directory
        .with_file_name(format!("cleanup-replacement-{}", Uuid::new_v4()));
    fixture
        .runtime
        .provision_task_worktree(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": task_id,
            "repositoryPath": fixture.project_directory,
            "destinationPath": replacement,
            "branchName": "feature/cleanup",
            "branchMode": "existing",
        }))
        .unwrap();
    let revision = fixture.runtime.state_revision();
    assert!(matches!(
        fixture.runtime.cleanup_task_worktree(params),
        Err(CoreError::ManagedWorktreeProofChanged { .. })
    ));
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert!(replacement.exists());
    let _ = std::fs::remove_dir_all(replacement);
}

#[test]
fn exact_alternate_attached_branch_cleanup_preserves_both_branch_refs() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::checkout_new_branch(
        &runner,
        &destination,
        "feature/alternate-cleanup",
    )
    .unwrap();

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["decision"], "allowed");
    assert_eq!(preview["blockers"], json!([]));
    assert_eq!(
        preview["health"]["checked_out_branch"],
        "feature/alternate-cleanup"
    );

    let result = fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    assert_eq!(result["outcome"], "removed");
    assert_eq!(result["task"]["branch"]["name"], "feature/cleanup");
    assert!(!destination.exists());

    for reference in [
        "refs/heads/feature/cleanup",
        "refs/heads/feature/alternate-cleanup",
    ] {
        let reference = GitRefName::from_bytes(reference.as_bytes().to_vec()).unwrap();
        assert!(
            runner
                .resolve_ref(&fixture.project_directory, &reference)
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn dirty_alternate_attached_branch_uses_existing_destructive_acknowledgement() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::checkout_new_branch(
        &runner,
        &destination,
        "feature/alternate-dirty",
    )
    .unwrap();
    std::fs::write(destination.join("local.txt"), "local\n").unwrap();

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["decision"], "refused");
    assert_eq!(preview["blockers"], json!(["untrackedContent"]));
    assert_eq!(preview["destructive_cleanup"]["status"], "available");

    let result = fixture
        .runtime
        .cleanup_task_worktree(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": task_id,
            "expectedManagedWorktreeOperationId": proof_id,
            "expectedWorktreeGeneration": generation,
            "cleanupMode": "discardCheckoutContent",
            "acknowledgedContentBlockers": ["untrackedContent"],
        }))
        .unwrap();
    assert_eq!(result["outcome"], "removed");
    assert!(!destination.exists());
    for reference in [
        "refs/heads/feature/cleanup",
        "refs/heads/feature/alternate-dirty",
    ] {
        let reference = GitRefName::from_bytes(reference.as_bytes().to_vec()).unwrap();
        assert!(
            runner
                .resolve_ref(&fixture.project_directory, &reference)
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn alternate_branch_that_detaches_before_final_revalidation_is_not_removed() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::checkout_new_branch(
        &runner,
        &destination,
        "feature/alternate-race",
    )
    .unwrap();
    let operation_id = Uuid::new_v4().to_string();
    let plan = match fixture
        .runtime
        .plan_task_worktree_cleanup(cleanup_params(
            &task_id,
            &operation_id,
            &proof_id,
            generation,
        ))
        .unwrap()
    {
        TaskWorktreeCleanupPlanning::Observe(plan) => plan,
        TaskWorktreeCleanupPlanning::Return(_) | TaskWorktreeCleanupPlanning::Finalize(_) => {
            panic!("cleanup unexpectedly completed")
        }
    };
    let progress = fixture
        .runtime
        .begin_task_worktree_cleanup(plan.observe().unwrap())
        .unwrap();
    let TaskWorktreeCleanupProgress::Revalidate(step) = progress else {
        panic!("cleanup did not enter final revalidation")
    };

    termloop_gitio::test_support::detach_head(&runner, &destination).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .apply_task_worktree_cleanup_observation(step.observe().unwrap()),
        Err(CoreError::WorktreeCleanupRecoveryAttention { operation_id: current })
            if current == operation_id
    ));
    assert!(destination.exists());
    assert_eq!(fixture.runtime.store.managed_worktrees().len(), 1);
}

#[test]
fn cleanup_absent_pair_clears_binding_while_one_sided_absence_needs_attention() {
    let mut safe = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut safe);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&safe.project_directory, &destination)
        .unwrap();
    let result = safe
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    assert_eq!(result["outcome"], "bindingCleared");
    assert!(result["task"]["branch"].is_object());

    let mut ambiguous = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut ambiguous);
    std::fs::remove_dir_all(&destination).unwrap();
    let operation_id = Uuid::new_v4().to_string();
    assert!(matches!(
        ambiguous.runtime.cleanup_task_worktree(cleanup_params(
            &task_id,
            &operation_id,
            &proof_id,
            generation,
        )),
        Err(CoreError::WorktreeCleanupRecoveryAttention { operation_id: current })
            if current == operation_id
    ));
    assert_eq!(ambiguous.runtime.store.cleanup_operations().len(), 1);
    assert_eq!(
        ambiguous.runtime.store.cleanup_operations()[0]
            .failure
            .as_ref()
            .unwrap()
            .kind,
        WorktreeCleanupFailureKind::RecoveryAttention
    );
    let health = ambiguous
        .runtime
        .cached_task_worktree_health(&task_id)
        .expect("one-sided observation replaces stale health");
    assert_eq!(health.path_state, WorktreePathProjectionState::Absent);
    assert_eq!(
        health.registration_state,
        WorktreeRegistrationProjectionState::Matching
    );
}

#[test]
fn cleanup_dirty_and_ignored_facts_refuse_before_journaling() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    std::fs::write(destination.join(".gitignore"), ".env\n").unwrap();
    std::fs::write(destination.join(".env"), "secret fixture\n").unwrap();
    let revision = fixture.runtime.state_revision();
    assert!(matches!(
        fixture.runtime.cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        )),
        Err(CoreError::WorktreeCleanupRefused { blockers, .. })
            if blockers.contains(&WorktreeCleanupBlocker::UntrackedContent)
                && blockers.contains(&WorktreeCleanupBlocker::IgnoredContent)
    ));
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert!(fixture.runtime.store.cleanup_operations().is_empty());
    assert!(destination.exists());
}

#[test]
fn acknowledged_destructive_cleanup_discards_only_the_exact_managed_checkout() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    std::fs::write(destination.join(".gitignore"), ".env\n").unwrap();
    std::fs::write(destination.join(".env"), "secret fixture\n").unwrap();
    let operation_id = Uuid::new_v4().to_string();
    let result = fixture
        .runtime
        .cleanup_task_worktree(json!({
            "operationId": operation_id,
            "taskId": task_id,
            "expectedManagedWorktreeOperationId": proof_id,
            "expectedWorktreeGeneration": generation,
            "cleanupMode": "discardCheckoutContent",
            "acknowledgedContentBlockers": ["untrackedContent", "ignoredContent"],
        }))
        .unwrap();
    assert_eq!(result["outcome"], "removed");
    assert_eq!(result["task"]["branch"]["name"], "feature/cleanup");
    assert!(result["task"]["worktree"].is_null());
    assert!(!destination.exists());
    assert!(fixture.project_directory.exists());
    let receipt = fixture.runtime.store.cleanup_receipts().first().unwrap();
    assert_eq!(
        receipt.cleanup_mode,
        termloop_domain::WorktreeCleanupMode::DiscardCheckoutContent
    );
    assert_eq!(receipt.acknowledged_content_blockers.len(), 2);
}

#[test]
fn failed_safe_dirty_refusal_can_be_superseded_by_fresh_destructive_intent() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let safe_operation_id = Uuid::new_v4().to_string();
    let removal = prepare_cleanup_removal(
        &mut fixture,
        cleanup_params(&task_id, &safe_operation_id, &proof_id, generation),
    );
    std::fs::write(destination.join("late-untracked.txt"), "late writer\n").unwrap();
    assert!(matches!(
        fixture
            .runtime
            .apply_task_worktree_cleanup_removal(removal.execute()),
        Err(CoreError::WorktreePathConflict)
    ));
    let failed = fixture.runtime.store.cleanup_operations().first().unwrap();
    assert_eq!(failed.operation_id, safe_operation_id);
    assert_eq!(
        failed.failure.as_ref().map(|failure| failure.kind),
        Some(termloop_domain::WorktreeCleanupFailureKind::CheckoutContentAppeared)
    );

    let destructive_operation_id = Uuid::new_v4().to_string();
    let result = fixture
        .runtime
        .cleanup_task_worktree(json!({
            "operationId": destructive_operation_id,
            "taskId": task_id,
            "expectedManagedWorktreeOperationId": proof_id,
            "expectedWorktreeGeneration": generation,
            "cleanupMode": "discardCheckoutContent",
            "acknowledgedContentBlockers": ["untrackedContent"],
        }))
        .unwrap();
    assert_eq!(result["outcome"], "removed");
    assert!(!destination.exists());
    assert!(fixture.runtime.store.cleanup_operations().is_empty());
    let receipt = fixture.runtime.store.cleanup_receipts().first().unwrap();
    assert_eq!(receipt.operation_id, destructive_operation_id);
    assert_eq!(
        receipt.cleanup_mode,
        termloop_domain::WorktreeCleanupMode::DiscardCheckoutContent
    );
}

#[test]
fn failed_permission_cleanup_can_be_replaced_after_fresh_destructive_observation() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let safe_operation_id = Uuid::new_v4().to_string();
    let _removal = prepare_cleanup_removal(
        &mut fixture,
        cleanup_params(&task_id, &safe_operation_id, &proof_id, generation),
    );
    fixture
        .runtime
        .store
        .fail_task_worktree_cleanup(
            &fixture.runtime.write_authority,
            &task_id,
            &safe_operation_id,
            termloop_domain::WorktreeCleanupFailure {
                kind: WorktreeCleanupFailureKind::PermissionDenied,
                blockers: vec![],
            },
            termloop_platform::current_epoch_ms(),
        )
        .unwrap();
    let replacement_operation_id = Uuid::new_v4().to_string();
    let result = fixture
        .runtime
        .cleanup_task_worktree(json!({
            "operationId": replacement_operation_id,
            "taskId": task_id,
            "expectedManagedWorktreeOperationId": proof_id,
            "expectedWorktreeGeneration": generation,
            "cleanupMode": "discardCheckoutContent",
            "acknowledgedContentBlockers": ["untrackedContent"],
        }))
        .unwrap();
    assert_eq!(result["outcome"], "removed");
    assert!(!destination.exists());
    assert!(fixture.runtime.store.cleanup_operations().is_empty());
    assert_eq!(
        fixture.runtime.store.cleanup_receipts()[0].operation_id,
        replacement_operation_id
    );
}

#[test]
fn failed_destructive_cleanup_allows_fresh_destructive_but_not_safe_intent() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let destructive_operation_id = Uuid::new_v4().to_string();
    let _removal = prepare_cleanup_removal(
        &mut fixture,
        json!({
            "operationId": destructive_operation_id,
            "taskId": task_id,
            "expectedManagedWorktreeOperationId": proof_id,
            "expectedWorktreeGeneration": generation,
            "cleanupMode": "discardCheckoutContent",
            "acknowledgedContentBlockers": ["ignoredContent"],
        }),
    );
    fixture
        .runtime
        .store
        .fail_task_worktree_cleanup(
            &fixture.runtime.write_authority,
            &task_id,
            &destructive_operation_id,
            termloop_domain::WorktreeCleanupFailure {
                kind: WorktreeCleanupFailureKind::RecoveryAttention,
                blockers: vec![],
            },
            termloop_platform::current_epoch_ms(),
        )
        .unwrap();
    let revision = fixture.runtime.store.revision();
    assert!(matches!(
        fixture.runtime.plan_task_worktree_cleanup(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        )),
        Err(CoreError::CleanupInProgress { .. })
    ));
    assert_eq!(fixture.runtime.store.revision(), revision);
    assert_eq!(
        fixture.runtime.store.cleanup_operations()[0].operation_id,
        destructive_operation_id
    );

    let replacement_operation_id = Uuid::new_v4().to_string();
    let result = fixture
        .runtime
        .cleanup_task_worktree(json!({
            "operationId": replacement_operation_id,
            "taskId": task_id,
            "expectedManagedWorktreeOperationId": proof_id,
            "expectedWorktreeGeneration": generation,
            "cleanupMode": "discardCheckoutContent",
            "acknowledgedContentBlockers": ["untrackedContent"],
        }))
        .unwrap();
    assert_eq!(result["outcome"], "removed");
    assert!(!destination.exists());
    assert_eq!(
        fixture.runtime.store.cleanup_receipts()[0].operation_id,
        replacement_operation_id
    );
}

#[test]
fn safe_dirty_refusal_can_retry_without_reusing_a_new_operation() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let operation_id = Uuid::new_v4().to_string();
    let params = cleanup_params(&task_id, &operation_id, &proof_id, generation);
    let plan = match fixture
        .runtime
        .plan_task_worktree_cleanup(params.clone())
        .unwrap()
    {
        TaskWorktreeCleanupPlanning::Observe(plan) => plan,
        TaskWorktreeCleanupPlanning::Return(_) | TaskWorktreeCleanupPlanning::Finalize(_) => {
            panic!("cleanup unexpectedly completed")
        }
    };
    let progress = fixture
        .runtime
        .begin_task_worktree_cleanup(plan.observe().unwrap())
        .unwrap();
    let TaskWorktreeCleanupProgress::Revalidate(step) = progress else {
        panic!("cleanup did not enter final revalidation");
    };
    let progress = fixture
        .runtime
        .apply_task_worktree_cleanup_observation(step.observe().unwrap())
        .unwrap();
    let TaskWorktreeCleanupProgress::Remove(step) = progress else {
        panic!("cleanup did not prepare the remove primitive");
    };
    let late_file = destination.join("late.txt");
    std::fs::write(&late_file, "late writer\n").unwrap();
    assert!(matches!(
        fixture
            .runtime
            .apply_task_worktree_cleanup_removal(step.execute()),
        Err(CoreError::WorktreePathConflict)
    ));
    let journal = &fixture.runtime.store.cleanup_operations()[0];
    assert_eq!(journal.stage, WorktreeCleanupStage::RemovePrepared);
    assert_eq!(
        journal.failure.as_ref().unwrap().kind,
        WorktreeCleanupFailureKind::CheckoutContentAppeared
    );
    assert!(
        fixture
            .runtime
            .cleanup_reservation_for_cwd(&destination)
            .is_none()
    );
    assert!(
        fixture
            .runtime
            .plan_agent_launch(json!({
                "projectId": fixture.project_id,
                "cwd": destination,
                "agentId": "codex",
            }))
            .is_ok()
    );
    assert!(matches!(
        fixture.runtime.plan_task_worktree_cleanup(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        )),
        Err(CoreError::CleanupInProgress { .. })
    ));

    std::fs::remove_file(late_file).unwrap();
    let result = fixture.runtime.cleanup_task_worktree(params).unwrap();
    assert_eq!(result["outcome"], "removed");
    assert!(!destination.exists());
}
