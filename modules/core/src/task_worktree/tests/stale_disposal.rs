use super::*;

#[test]
fn missing_repository_and_worktree_can_forget_the_managed_binding_without_touching_files() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    std::fs::remove_dir_all(&destination).unwrap();
    std::fs::remove_dir_all(fixture.project_directory.join(".git")).unwrap();

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["decision"], "unknown");
    assert_eq!(preview["blockers"], json!(["repositoryUnavailable"]));
    assert_eq!(preview["stale_resolution"]["forget_status"], "available");
    assert_eq!(
        preview["stale_resolution"]["disposal_status"],
        "unavailable"
    );
    let TaskWorktreeStaleResolutionPlanning::Observe(disposal_plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(stale_resolution_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            Some(&proof_id),
            generation,
            &canonical_destination,
            true,
        ))
        .unwrap()
    else {
        panic!("missing checkout disposal unexpectedly replayed");
    };
    assert!(matches!(
        disposal_plan.observe(),
        Err(CoreError::RepositoryUnavailable)
    ));

    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_forget(stale_resolution_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            Some(&proof_id),
            generation,
            &canonical_destination,
            false,
        ))
        .unwrap()
    else {
        panic!("missing checkout forget unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Revalidate(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("record-only forget skipped final tuple validation");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_forget(step.observe())
        .unwrap();
    assert!(task["worktree"].is_null());
    assert!(!canonical_destination.exists());
    assert!(fixture.runtime.store.managed_worktrees().is_empty());

    fixture
        .runtime
        .delete_task(json!({ "taskId": task_id }))
        .unwrap();
    assert!(
        fixture
            .runtime
            .store
            .tasks()
            .iter()
            .all(|task| task.id != task_id)
    );
}

#[test]
fn orphaned_managed_directory_can_forget_after_cleanup_attention_without_touching_files_or_sessions()
 {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("keep.txt"), "keep me\n").unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                launch_selection: Default::default(),
                id: "stale-forget-session".into(),
                project_id: fixture.project_id.clone(),
                name: None,
                kind: termloop_domain::SessionKind::Terminal,
                process: termloop_domain::ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: destination.to_string_lossy().into_owned(),
                    agent_id: None,
                    template_ref: None,
                    template_version: None,
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

    let cleanup_id = Uuid::new_v4().to_string();
    assert!(matches!(
        fixture.runtime.cleanup_task_worktree(cleanup_params(
            &task_id,
            &cleanup_id,
            &proof_id,
            generation,
        )),
        Err(CoreError::WorktreeCleanupRecoveryAttention { operation_id })
            if operation_id == cleanup_id
    ));
    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["decision"], "refused");
    assert_eq!(preview["stale_resolution"]["forget_status"], "available");
    assert_eq!(
        preview["stale_resolution"]["disposal_status"],
        "sessionRetirementRequired"
    );
    assert!(
        preview["blockers"]
            .as_array()
            .unwrap()
            .contains(&json!("orphanedManagedDirectory"))
    );
    assert!(
        !preview["blockers"]
            .as_array()
            .unwrap()
            .contains(&json!("observationFailed"))
    );

    let blocked_disposal_id = Uuid::new_v4().to_string();
    let TaskWorktreeStaleResolutionPlanning::Observe(blocked_plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(stale_resolution_params(
            &task_id,
            &blocked_disposal_id,
            Some(&proof_id),
            generation,
            &canonical_destination,
            true,
        ))
        .unwrap()
    else {
        panic!("attached-session disposal unexpectedly replayed");
    };
    assert!(matches!(
        fixture
            .runtime
            .begin_task_worktree_stale_resolution(blocked_plan.observe().unwrap()),
        Err(CoreError::WorktreeStaleResolutionRefused { blockers, .. })
            if blockers == vec![termloop_domain::WorktreeStaleResolutionBlocker::SessionAttached]
    ));
    assert_eq!(
        std::fs::read_to_string(destination.join("keep.txt")).unwrap(),
        "keep me\n"
    );
    assert!(
        fixture
            .runtime
            .store
            .stale_resolution_operations()
            .is_empty()
    );
    let operation_id = Uuid::new_v4().to_string();
    let plan = fixture
        .runtime
        .plan_task_worktree_stale_forget(stale_resolution_params(
            &task_id,
            &operation_id,
            Some(&proof_id),
            generation,
            &canonical_destination,
            false,
        ))
        .unwrap();
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = plan else {
        panic!("stale forget unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Revalidate(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("record-only stale resolution skipped final observation");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_forget(step.observe())
        .unwrap();
    assert!(task["worktree"].is_null());
    assert_eq!(
        std::fs::read_to_string(destination.join("keep.txt")).unwrap(),
        "keep me\n"
    );
    assert!(
        fixture
            .runtime
            .store
            .sessions()
            .iter()
            .any(|session| session.id == "stale-forget-session"
                && session.lifecycle_state == "running")
    );
    assert!(fixture.runtime.store.cleanup_operations().is_empty());
    assert!(
        fixture
            .runtime
            .store
            .stale_resolution_operations()
            .is_empty()
    );
    assert_eq!(fixture.runtime.store.stale_resolution_receipts().len(), 1);
    fixture
        .runtime
        .delete_task(json!({ "taskId": task_id }))
        .unwrap();
    assert!(destination.exists());
    let _ = std::fs::remove_dir_all(destination);
}

#[test]
fn acknowledged_orphaned_directory_disposal_removes_only_the_exact_leaf_then_clears_binding() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
    std::fs::create_dir_all(destination.join("nested")).unwrap();
    std::fs::write(destination.join("nested/unverified.txt"), "delete me\n").unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();

    let operation_id = Uuid::new_v4().to_string();
    let plan = fixture
        .runtime
        .plan_task_worktree_stale_disposal(stale_resolution_params(
            &task_id,
            &operation_id,
            Some(&proof_id),
            generation,
            &canonical_destination,
            true,
        ))
        .unwrap();
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = plan else {
        panic!("stale disposal unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Remove(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("stale disposal did not reserve exact removal");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_disposal(step.execute())
        .unwrap();
    assert!(task["worktree"].is_null());
    assert!(!destination.exists());
    assert!(fixture.project_directory.exists());
    assert!(fixture.runtime.store.managed_worktrees().is_empty());
    assert!(
        fixture
            .runtime
            .store
            .stale_resolution_operations()
            .is_empty()
    );
    assert_eq!(fixture.runtime.store.stale_resolution_receipts().len(), 1);
}

#[test]
fn failed_remove_prepared_cleanup_can_delete_the_remaining_stale_folder() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(
        destination.join(".git"),
        "gitdir: /already-removed/managed-worktree\n",
    )
    .unwrap();
    std::fs::write(destination.join("remaining.txt"), "delete\n").unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    let cleanup_id = Uuid::new_v4().to_string();
    assert!(matches!(
        fixture.runtime.cleanup_task_worktree(cleanup_params(
            &task_id,
            &cleanup_id,
            &proof_id,
            generation,
        )),
        Err(CoreError::WorktreeCleanupRecoveryAttention { .. })
    ));
    fixture.rewrite_state_and_reopen(|state| {
        let cleanup = state["cleanup_operations"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|operation| operation["operation_id"] == cleanup_id)
            .unwrap();
        cleanup["stage"] = json!("removePrepared");
        cleanup["failure"]["kind"] = json!("operationFailed");
    });
    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["stale_resolution"]["disposal_status"], "available");
    let operation_id = Uuid::new_v4().to_string();
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(stale_resolution_params(
            &task_id,
            &operation_id,
            Some(&proof_id),
            generation,
            &canonical_destination,
            true,
        ))
        .unwrap()
    else {
        panic!("removePrepared cleanup recovery unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Remove(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("failed removePrepared cleanup was not superseded");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_disposal(step.execute())
        .unwrap();
    assert!(task["worktree"].is_null());
    assert!(!destination.exists());
    assert!(fixture.runtime.store.cleanup_operations().is_empty());
}

#[test]
fn proofless_registered_checkout_is_removed_through_git_before_task_deletion() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _proof_id, _generation) = provision_cleanup_fixture(&mut fixture);
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    let task_id_for_rewrite = task_id.clone();
    fixture.rewrite_state_and_reopen(|state| {
        state["managed_worktrees"]
            .as_array_mut()
            .unwrap()
            .retain(|proof| proof["task_id"] != task_id_for_rewrite);
    });
    let non_legacy_preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(
        non_legacy_preview["stale_resolution"]["disposal_status"],
        "unavailable"
    );
    assert!(matches!(
        fixture
            .runtime
            .plan_task_worktree_stale_disposal(stale_resolution_params(
                &task_id,
                &Uuid::new_v4().to_string(),
                None,
                1,
                &canonical_destination,
                true,
            )),
        Err(CoreError::ManagedWorktreeProofChanged { .. })
    ));

    let task_id_for_rewrite = task_id.clone();
    fixture.rewrite_state_and_reopen(|state| {
        let task = state["tasks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|task| task["id"] == task_id_for_rewrite)
            .unwrap();
        task["worktree_generation"] = json!(0);
    });

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["managed_worktree_operation_id"], Value::Null);
    assert_eq!(preview["worktree_generation"], 0);
    assert_eq!(preview["stale_resolution"]["forget_status"], "available");
    assert_eq!(preview["stale_resolution"]["disposal_status"], "available");
    assert_eq!(preview["blockers"], json!(["managedProofMissing"]));

    let operation_id = Uuid::new_v4().to_string();
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(stale_resolution_params(
            &task_id,
            &operation_id,
            None,
            0,
            &canonical_destination,
            true,
        ))
        .unwrap()
    else {
        panic!("proofless registered checkout unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Remove(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("proofless registered checkout was not prepared for removal");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_disposal(step.execute())
        .unwrap();
    assert!(task["worktree"].is_null());
    assert!(!destination.exists());
    let runner = GitRunner::discover().unwrap();
    let branch = GitRefName::from_bytes(b"refs/heads/feature/cleanup".to_vec()).unwrap();
    assert!(
        runner
            .resolve_ref(&fixture.project_directory, &branch)
            .unwrap()
            .is_some()
    );
    fixture
        .runtime
        .delete_task(json!({ "taskId": task_id }))
        .unwrap();
}

#[test]
fn proofless_orphan_can_forget_its_binding_without_touching_the_folder() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _proof_id, _generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("keep.txt"), "keep\n").unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    let task_id_for_rewrite = task_id.clone();
    fixture.rewrite_state_and_reopen(|state| {
        state["managed_worktrees"]
            .as_array_mut()
            .unwrap()
            .retain(|proof| proof["task_id"] != task_id_for_rewrite);
        let task = state["tasks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|task| task["id"] == task_id_for_rewrite)
            .unwrap();
        task["worktree_generation"] = json!(0);
    });

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["stale_resolution"]["forget_status"], "available");
    assert_eq!(preview["stale_resolution"]["disposal_status"], "available");

    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_forget(stale_resolution_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            None,
            0,
            &canonical_destination,
            false,
        ))
        .unwrap()
    else {
        panic!("proofless orphan forget unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Revalidate(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("proofless orphan forget skipped final tuple validation");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_forget(step.observe())
        .unwrap();
    assert!(task["worktree"].is_null());
    assert_eq!(
        std::fs::read_to_string(destination.join("keep.txt")).unwrap(),
        "keep\n"
    );
    assert!(
        fixture
            .runtime
            .store
            .stale_resolution_operations()
            .is_empty()
    );
    assert!(destination.exists());
}

#[test]
fn registration_mismatch_can_forget_the_binding_without_removing_either_checkout() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    let foreign_destination = fixture
        .project_directory
        .with_file_name(format!("foreign-worktree-{}", Uuid::new_v4()));
    termloop_gitio::test_support::create_branch(
        &runner,
        &fixture.project_directory,
        "feature/foreign-registration",
    )
    .unwrap();
    let foreign_ref =
        GitRefName::from_bytes(b"refs/heads/feature/foreign-registration".to_vec()).unwrap();
    runner
        .add_worktree(
            &fixture.project_directory,
            &foreign_destination,
            &foreign_ref,
        )
        .unwrap();
    std::fs::write(destination.join("keep-task.txt"), "keep task checkout\n").unwrap();
    std::fs::write(
        foreign_destination.join("keep-foreign.txt"),
        "keep foreign checkout\n",
    )
    .unwrap();

    let foreign_git_file = std::fs::read(foreign_destination.join(".git")).unwrap();
    std::fs::write(destination.join(".git"), foreign_git_file).unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["decision"], "refused");
    assert_eq!(preview["stale_resolution"]["forget_status"], "available");
    assert_eq!(
        preview["stale_resolution"]["disposal_status"],
        "unavailable"
    );

    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_forget(stale_resolution_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            Some(&proof_id),
            generation,
            &canonical_destination,
            false,
        ))
        .unwrap()
    else {
        panic!("registration mismatch forget unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Revalidate(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("registration mismatch forget skipped final tuple validation");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_forget(step.observe())
        .unwrap();

    assert!(task["worktree"].is_null());
    assert_eq!(
        std::fs::read_to_string(destination.join("keep-task.txt")).unwrap(),
        "keep task checkout\n"
    );
    assert_eq!(
        std::fs::read_to_string(foreign_destination.join("keep-foreign.txt")).unwrap(),
        "keep foreign checkout\n"
    );
    assert!(destination.exists());
    assert!(foreign_destination.exists());
}

#[test]
fn missing_checkout_and_branch_can_forget_the_binding_before_task_deletion() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let registered_destination =
        PathBuf::from(&fixture.runtime.store.managed_worktrees()[0].registered_worktree_path);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
    let branch = GitRefName::from_bytes(b"refs/heads/feature/cleanup".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.project_directory, &branch)
        .unwrap()
        .unwrap();
    runner
        .delete_ref_if_matches(&fixture.project_directory, &branch, &oid)
        .unwrap();

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["decision"], "allowed");
    assert_eq!(preview["stale_resolution"]["forget_status"], "available");
    assert_eq!(
        preview["stale_resolution"]["disposal_status"],
        "unavailable"
    );

    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_forget(stale_resolution_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            Some(&proof_id),
            generation,
            &registered_destination,
            false,
        ))
        .unwrap()
    else {
        panic!("missing checkout forget unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Revalidate(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("missing checkout forget skipped final tuple validation");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_forget(step.observe())
        .unwrap();

    assert!(task["worktree"].is_null());
    assert!(!destination.exists());
    fixture
        .runtime
        .delete_task(json!({ "taskId": task_id }))
        .unwrap();
}

#[test]
fn stale_disposal_hard_gates_mutate_neither_target_nor_state() {
    let mut protected = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut protected);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&protected.project_directory, &destination)
        .unwrap();
    let nested_project = destination.join("nested-project");
    std::fs::create_dir_all(&nested_project).unwrap();
    std::fs::write(destination.join("keep.txt"), "keep\n").unwrap();
    protected
        .runtime
        .create_project(json!({ "name": "Nested", "folderPath": nested_project }))
        .unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = protected
        .runtime
        .plan_task_worktree_stale_disposal(stale_resolution_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            Some(&proof_id),
            generation,
            &canonical_destination,
            true,
        ))
        .unwrap()
    else {
        panic!("protected stale target unexpectedly replayed");
    };
    assert!(matches!(
        protected
            .runtime
            .begin_task_worktree_stale_resolution(plan.observe().unwrap()),
        Err(CoreError::WorktreeStaleResolutionRefused { blockers, .. })
            if blockers == vec![termloop_domain::WorktreeStaleResolutionBlocker::ProtectedPath]
    ));
    assert_eq!(
        std::fs::read_to_string(destination.join("keep.txt")).unwrap(),
        "keep\n"
    );
    assert!(
        protected
            .runtime
            .store
            .stale_resolution_operations()
            .is_empty()
    );

    let mut replaced = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut replaced);
    let registered_destination =
        PathBuf::from(&replaced.runtime.store.managed_worktrees()[0].registered_worktree_path);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&replaced.project_directory, &destination)
        .unwrap();
    std::fs::write(&destination, "replacement file\n").unwrap();
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = replaced
        .runtime
        .plan_task_worktree_stale_disposal(stale_resolution_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            Some(&proof_id),
            generation,
            &registered_destination,
            true,
        ))
        .unwrap()
    else {
        panic!("replaced stale target unexpectedly replayed");
    };
    assert!(matches!(
        plan.observe(),
        Err(CoreError::RepositoryUnavailable)
    ));
    assert_eq!(
        std::fs::read_to_string(&destination).unwrap(),
        "replacement file\n"
    );
    assert!(
        replaced
            .runtime
            .store
            .stale_resolution_operations()
            .is_empty()
    );
}

#[test]
fn stale_disposal_recovery_reuses_the_exact_prepared_operation_after_fresh_observation() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("retry.txt"), "retry\n").unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    let operation_id = Uuid::new_v4().to_string();
    let params = stale_resolution_params(
        &task_id,
        &operation_id,
        Some(&proof_id),
        generation,
        &canonical_destination,
        true,
    );
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(params.clone())
        .unwrap()
    else {
        panic!("stale disposal unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Remove(_prepared) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("stale disposal did not enter prepared stage");
    };
    fixture
        .runtime
        .store
        .fail_task_worktree_stale_resolution(
            &fixture.runtime.write_authority,
            &task_id,
            &operation_id,
            termloop_domain::WorktreeStaleResolutionFailure {
                kind: termloop_domain::WorktreeStaleResolutionFailureKind::RecoveryAttention,
                blockers: vec![termloop_domain::WorktreeStaleResolutionBlocker::RecoveryAttention],
            },
            termloop_platform::current_epoch_ms(),
        )
        .unwrap();
    std::fs::write(
        destination.join(".git"),
        "gitdir: /already-removed/managed-worktree\n",
    )
    .unwrap();

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["stale_resolution"]["forget_status"], "unavailable");
    assert_eq!(preview["stale_resolution"]["disposal_status"], "available");
    let projected = fixture
        .runtime
        .list_tasks_current(json!({ "projectId": fixture.project_id, "taskIds": [task_id] }))
        .unwrap();
    assert_eq!(
        projected["items"][0]["worktree_stale_resolution"]["operation_id"],
        operation_id
    );

    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(params)
        .unwrap()
    else {
        panic!("prepared recovery unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Remove(step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("prepared recovery did not resume removal");
    };
    let task = fixture
        .runtime
        .apply_task_worktree_stale_disposal(step.execute())
        .unwrap();
    assert!(task["worktree"].is_null());
    assert!(!destination.exists());
}

#[test]
fn interrupted_stale_disposal_completes_when_exact_target_is_freshly_absent() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("removed-before-crash.txt"), "gone\n").unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    let operation_id = Uuid::new_v4().to_string();
    let params = stale_resolution_params(
        &task_id,
        &operation_id,
        Some(&proof_id),
        generation,
        &canonical_destination,
        true,
    );
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(params.clone())
        .unwrap()
    else {
        panic!("interrupted disposal unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Remove(_step) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("interrupted disposal did not enter removalPrepared");
    };
    std::fs::remove_dir_all(&destination).unwrap();
    fixture
        .runtime
        .store
        .fail_task_worktree_stale_resolution(
            &fixture.runtime.write_authority,
            &task_id,
            &operation_id,
            termloop_domain::WorktreeStaleResolutionFailure {
                kind: termloop_domain::WorktreeStaleResolutionFailureKind::RecoveryAttention,
                blockers: vec![termloop_domain::WorktreeStaleResolutionBlocker::RecoveryAttention],
            },
            termloop_platform::current_epoch_ms(),
        )
        .unwrap();

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["stale_resolution"]["forget_status"], "unavailable");
    assert_eq!(preview["stale_resolution"]["disposal_status"], "available");
    let TaskWorktreeStaleResolutionPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_stale_disposal(params)
        .unwrap()
    else {
        panic!("absent recovery unexpectedly replayed");
    };
    let TaskWorktreeStaleResolutionProgress::Return(task) = fixture
        .runtime
        .begin_task_worktree_stale_resolution(plan.observe().unwrap())
        .unwrap()
    else {
        panic!("absent recovery did not complete the binding clear");
    };
    assert!(task["worktree"].is_null());
    assert!(
        fixture
            .runtime
            .store
            .stale_resolution_operations()
            .is_empty()
    );
    assert_eq!(fixture.runtime.store.stale_resolution_receipts().len(), 1);
}
