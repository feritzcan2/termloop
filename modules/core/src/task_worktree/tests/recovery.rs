use super::*;

#[test]
fn completed_cleanup_retry_finalizes_a_lingering_binding_cleared_journal() {
    let mut fixture = Fixture::new();
    let (task_id, _destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let operation_id = Uuid::new_v4().to_string();
    let params = cleanup_params(&task_id, &operation_id, &proof_id, generation);
    let removal = prepare_cleanup_removal(&mut fixture, params.clone());
    let progress = fixture
        .runtime
        .apply_task_worktree_cleanup_removal(removal.execute())
        .unwrap();
    assert!(matches!(progress, TaskWorktreeCleanupProgress::Verify(_)));
    fixture
        .runtime
        .store
        .advance_task_worktree_cleanup(
            &fixture.runtime.write_authority,
            &task_id,
            &operation_id,
            WorktreeCleanupStage::RemovalVerified,
            100,
        )
        .unwrap();
    fixture
        .runtime
        .store
        .complete_task_worktree_cleanup(
            &fixture.runtime.write_authority,
            &task_id,
            &operation_id,
            101,
        )
        .unwrap();
    assert_eq!(
        fixture.runtime.store.cleanup_operations()[0].stage,
        WorktreeCleanupStage::BindingCleared
    );
    assert!(matches!(
        fixture.runtime.delete_task(json!({ "taskId": task_id })),
        Err(CoreError::CleanupInProgress { .. })
    ));

    let finalization = match fixture.runtime.plan_task_worktree_cleanup(params).unwrap() {
        TaskWorktreeCleanupPlanning::Finalize(finalization) => finalization,
        _ => panic!("receipt replay did not enter journal finalization"),
    };
    let replay = fixture
        .runtime
        .finalize_task_worktree_cleanup(*finalization)
        .unwrap();
    assert_eq!(replay["outcome"], "alreadyCompleted");
    assert!(fixture.runtime.store.cleanup_operations().is_empty());
    assert!(
        fixture
            .runtime
            .delete_task(json!({ "taskId": task_id }))
            .is_ok()
    );
}

#[test]
fn cleanup_revalidation_refuses_new_presence_and_releases_the_reservation() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let operation_id = Uuid::new_v4().to_string();
    let params = cleanup_params(&task_id, &operation_id, &proof_id, generation);
    let plan = match fixture.runtime.plan_task_worktree_cleanup(params).unwrap() {
        TaskWorktreeCleanupPlanning::Observe(plan) => plan,
        TaskWorktreeCleanupPlanning::Return(_) | TaskWorktreeCleanupPlanning::Finalize(_) => {
            panic!("new cleanup unexpectedly completed")
        }
    };
    let progress = fixture
        .runtime
        .begin_task_worktree_cleanup(plan.observe().unwrap())
        .unwrap();
    let TaskWorktreeCleanupProgress::Revalidate(step) = progress else {
        panic!("cleanup did not reserve before final revalidation");
    };
    let revision = fixture.runtime.state_revision();
    let coalesced = fixture
        .runtime
        .plan_task_worktree_cleanup(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    assert!(matches!(
        coalesced,
        TaskWorktreeCleanupPlanning::Return(value) if value["outcome"] == "running"
    ));
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert!(matches!(
        fixture.runtime.delete_task(json!({ "taskId": task_id })),
        Err(CoreError::CleanupInProgress { .. })
    ));

    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                launch_selection: Default::default(),
                id: "resume-blocked-by-cleanup".into(),
                project_id: fixture.project_id.clone(),
                name: None,
                kind: termloop_domain::SessionKind::Agent,
                process: termloop_domain::ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: termloop_platform::canonical_existing_directory_path(&destination)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: termloop_domain::ResumeRef::for_provider(
                    termloop_domain::ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(termloop_domain::ResumeFailureReason::ResumeRejected),
            },
        )
        .unwrap();
    let mut transport = crate::test_agent_observation_transport(std::env::temp_dir());
    transport.agents.remove("codex");
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    fixture.runtime.configure_agent_observations(transport);
    let blocked_resume = fixture
        .runtime
        .plan_agent_resume(json!({"sessionId":"resume-blocked-by-cleanup"}))
        .unwrap();
    assert!(matches!(
        blocked_resume,
        crate::AgentResumePlanOutcome::Current(_)
    ));
    assert_eq!(
        fixture
            .runtime
            .store
            .sessions()
            .iter()
            .find(|session| session.id == "resume-blocked-by-cleanup")
            .and_then(|session| session.resume_failure),
        Some(termloop_domain::ResumeFailureReason::LaunchReserved)
    );

    for method in ["terminal", "agent"] {
        let error = if method == "terminal" {
            fixture.runtime.launch_terminal(json!({
                "projectId": fixture.project_id,
                "cwd": destination,
            }))
        } else {
            fixture
                .runtime
                .plan_agent_launch(json!({
                    "projectId": fixture.project_id,
                    "cwd": destination,
                    "agentId": "codex",
                }))
                .map(|_| Value::Null)
        }
        .unwrap_err();
        assert!(matches!(
            error,
            CoreError::CleanupInProgress { ref task_id, ref operation_id }
                if task_id == &fixture.runtime.store.tasks()[0].id
                    && operation_id == &fixture.runtime.store.cleanup_operations()[0].operation_id
        ));
    }

    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                launch_selection: Default::default(),
                id: "cleanup-race-session".into(),
                project_id: fixture.project_id.clone(),
                name: None,
                kind: termloop_domain::SessionKind::Agent,
                process: termloop_domain::ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: termloop_platform::canonical_existing_directory_path(&destination)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "resuming".into(),
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
    fixture
        .runtime
        .resume_reservations
        .insert("cleanup-race-session".into());
    let observed = step.observe().unwrap();
    let cleanup_error = match fixture
        .runtime
        .apply_task_worktree_cleanup_observation(observed)
    {
        Ok(_) => panic!("cleanup unexpectedly continued"),
        Err(error) => error,
    };
    assert!(
        matches!(&cleanup_error, CoreError::WorktreeCleanupRefused { blockers, .. }
            if blockers.contains(&WorktreeCleanupBlocker::SessionAttached)),
        "unexpected cleanup result: {cleanup_error:?}"
    );
    assert!(fixture.runtime.store.cleanup_operations().is_empty());
    assert!(destination.exists());
}

#[test]
fn restart_recovery_never_reissues_an_ambiguous_remove() {
    let mut present = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut present);
    let operation_id = Uuid::new_v4().to_string();
    let _unexecuted = prepare_cleanup_removal(
        &mut present,
        cleanup_params(&task_id, &operation_id, &proof_id, generation),
    );
    let mut recovered =
        CoreRuntime::open(present.state_path.clone(), TerminalService::default(), 2).unwrap();
    assert!(destination.exists());
    assert_eq!(recovered.store.cleanup_operations().len(), 1);
    assert!(recovered.store.cleanup_operations()[0].failure.is_none());
    let plan = recovered
        .plan_task_worktree_cleanup_recovery()
        .pop()
        .unwrap();
    assert!(matches!(
        recovered.apply_task_worktree_cleanup_observation(plan.observe().unwrap()),
        Err(CoreError::WorktreeCleanupRecoveryAttention { .. })
    ));

    let mut removed = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut removed);
    let operation_id = Uuid::new_v4().to_string();
    let step = prepare_cleanup_removal(
        &mut removed,
        cleanup_params(&task_id, &operation_id, &proof_id, generation),
    );
    let _executed = step.execute();
    assert!(!destination.exists());
    let mut recovered =
        CoreRuntime::open(removed.state_path.clone(), TerminalService::default(), 2).unwrap();
    assert_eq!(recovered.store.cleanup_operations().len(), 1);
    let plan = recovered
        .plan_task_worktree_cleanup_recovery()
        .pop()
        .unwrap();
    let result = recovered
        .apply_task_worktree_cleanup_observation(plan.observe().unwrap())
        .unwrap();
    assert!(matches!(result, TaskWorktreeCleanupProgress::Return(_)));
    assert!(recovered.store.cleanup_operations().is_empty());
    assert!(recovered.store.tasks()[0].worktree.is_none());
    assert!(recovered.store.tasks()[0].branch.is_some());
}

#[test]
fn restart_recovery_verifies_the_alternate_checkout_when_the_task_branch_is_missing() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::checkout_new_branch(
        &runner,
        &destination,
        "feature/recovery-alternate",
    )
    .unwrap();
    let task_branch = GitRefName::from_bytes(b"refs/heads/feature/cleanup".to_vec()).unwrap();
    let task_branch_oid = runner
        .resolve_ref(&fixture.project_directory, &task_branch)
        .unwrap()
        .unwrap();
    runner
        .delete_ref_if_matches(&fixture.project_directory, &task_branch, &task_branch_oid)
        .unwrap();
    std::fs::write(destination.join("local.txt"), "local\n").unwrap();

    let operation_id = Uuid::new_v4().to_string();
    let removal = prepare_cleanup_removal(
        &mut fixture,
        json!({
            "operationId": operation_id,
            "taskId": task_id,
            "expectedManagedWorktreeOperationId": proof_id,
            "expectedWorktreeGeneration": generation,
            "cleanupMode": "discardCheckoutContent",
            "acknowledgedContentBlockers": ["untrackedContent"],
        }),
    );
    assert_eq!(
        fixture.runtime.store.cleanup_operations()[0]
            .baseline
            .checkout_branch_ref
            .as_deref(),
        Some("refs/heads/feature/recovery-alternate")
    );
    let _executed = removal.execute();
    assert!(!destination.exists());

    let mut recovered =
        CoreRuntime::open(fixture.state_path.clone(), TerminalService::default(), 2).unwrap();
    let plan = recovered
        .plan_task_worktree_cleanup_recovery()
        .pop()
        .unwrap();
    let result = recovered
        .apply_task_worktree_cleanup_observation(plan.observe().unwrap())
        .unwrap();
    assert!(matches!(result, TaskWorktreeCleanupProgress::Return(_)));
    assert!(recovered.store.cleanup_operations().is_empty());
    assert!(recovered.store.tasks()[0].worktree.is_none());
    let alternate =
        GitRefName::from_bytes(b"refs/heads/feature/recovery-alternate".to_vec()).unwrap();
    assert!(
        runner
            .resolve_ref(&fixture.project_directory, &alternate)
            .unwrap()
            .is_some()
    );
}

#[test]
fn final_commit_conflict_becomes_durable_recovery_attention() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    termloop_gitio::test_support::create_branch(
        &runner,
        &fixture.project_directory,
        "existing-final-conflict",
    )
    .unwrap();
    let task = fixture.create_task("Commit conflict", Value::Null);
    let holder = fixture.create_task("Injected holder", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("final-conflict-worktree-{}", Uuid::new_v4()));
    let params = json!({
        "operationId": Uuid::new_v4().to_string(),
        "taskId": task["id"],
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "existing-final-conflict",
        "branchMode": "existing",
    });
    let observed = fixture
        .runtime
        .plan_task_worktree_provisioning(params)
        .unwrap()
        .observe()
        .unwrap();
    let TaskWorktreeProvisioningProgress::Execute(add) = fixture
        .runtime
        .begin_task_worktree_provisioning(observed)
        .unwrap()
    else {
        panic!("existing-branch provisioning did not start");
    };
    let TaskWorktreeProvisioningProgress::Execute(verify) = fixture
        .runtime
        .apply_task_worktree_provisioning_step(add.execute())
        .unwrap()
    else {
        panic!("worktree add did not advance");
    };
    let operation = fixture.runtime.store.provisioning_operations()[0].clone();
    let mut persisted: Value =
        serde_json::from_slice(&std::fs::read(&fixture.state_path).unwrap()).unwrap();
    let holder_record = persisted["tasks"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|candidate| candidate["id"] == holder["id"])
        .unwrap();
    holder_record["branch"] = json!({
        "repository_root": operation.spec.repository_root,
        "name": operation.spec.branch_name,
    });
    std::fs::write(
        &fixture.state_path,
        serde_json::to_vec_pretty(&persisted).unwrap(),
    )
    .unwrap();
    fixture.runtime.store = Store::open(&fixture.state_path).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .apply_task_worktree_provisioning_step(verify.execute()),
        Err(CoreError::WorktreeRecoveryAttention { operation_id })
            if operation_id == operation.operation_id
    ));
    let journal = fixture
        .runtime
        .store
        .provisioning_operations()
        .iter()
        .find(|candidate| candidate.operation_id == operation.operation_id)
        .unwrap();
    assert_eq!(journal.stage, ProvisioningStage::WorktreeAdded);
    assert_eq!(
        journal.failure,
        Some(ProvisioningFailureKind::RecoveryAttention)
    );
    assert!(
        fixture
            .runtime
            .store
            .tasks()
            .iter()
            .find(|candidate| candidate.id == operation.task_id)
            .unwrap()
            .worktree
            .is_none()
    );
    assert!(destination.exists());
    let _ = std::fs::remove_dir_all(destination);
}

#[test]
fn successful_ref_rollback_allows_same_operation_retry() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Retry rolled back ref", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("rollback-retry-worktree-{}", Uuid::new_v4()));
    let operation_id = Uuid::new_v4().to_string();
    let params = json!({
        "operationId": operation_id,
        "taskId": task["id"],
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "feature/rollback-retry",
        "branchMode": "create",
        "baseRef": "refs/heads/main",
    });
    let mut observed = fixture
        .runtime
        .plan_task_worktree_provisioning(params.clone())
        .unwrap()
        .observe()
        .unwrap();
    let fail_once = fixture.project_directory.join("fail-worktree-add-once");
    std::fs::write(&fail_once, b"fail").unwrap();
    let fake = FakeGit::compile(
        "fail-add-once",
        &format!(
            r#"
            fn main() {{
                let args: Vec<_> = std::env::args_os().skip(1).collect();
                let marker = std::path::Path::new({fail_once:?});
                if args.first().is_some_and(|arg| arg == "worktree")
                    && args.get(1).is_some_and(|arg| arg == "add")
                    && marker.exists()
                {{
                    std::fs::remove_file(marker).unwrap();
                    eprintln!("fatal: injected worktree add failure");
                    std::process::exit(128);
                }}
                let program = std::ffi::OsString::from("git");
                let status = std::process::Command::new(program).args(args).status().unwrap();
                std::process::exit(status.code().unwrap_or(1));
            }}
            "#,
            fail_once = fail_once,
        ),
    );
    observed.runner = GitRunner::discover_program(&fake.program).unwrap();
    let TaskWorktreeProvisioningProgress::Execute(create_ref) = fixture
        .runtime
        .begin_task_worktree_provisioning(observed)
        .unwrap()
    else {
        panic!("new provisioning did not start");
    };
    let TaskWorktreeProvisioningProgress::Execute(add_worktree) = fixture
        .runtime
        .apply_task_worktree_provisioning_step(create_ref.execute())
        .unwrap()
    else {
        panic!("branch creation did not advance");
    };
    assert!(
        fixture
            .runtime
            .apply_task_worktree_provisioning_step(add_worktree.execute())
            .is_err()
    );
    let journal = &fixture.runtime.store.provisioning_operations()[0];
    assert_eq!(journal.stage, ProvisioningStage::Reserved);
    assert!(!journal.created_branch_ref);
    assert!(journal.failure.is_some());
    assert!(
        runner
            .resolve_ref(
                &fixture.project_directory,
                &local_branch_ref("feature/rollback-retry").unwrap(),
            )
            .unwrap()
            .is_none()
    );
    let retried = fixture.runtime.provision_task_worktree(params).unwrap();
    assert_eq!(retried["task"]["branch"]["name"], "feature/rollback-retry");
    assert!(retried["provisioning"].is_null());
    let _ = std::fs::remove_dir_all(destination);
}

#[test]
fn reconciler_recovers_exact_branch_marker_and_preserves_an_external_ref() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();

    let recovered_task = fixture.create_task("Recover marker", Value::Null);
    let recovered_destination = fixture
        .project_directory
        .with_file_name(format!("recovered-worktree-{}", Uuid::new_v4()));
    let recovered = reserve_create_operation(
        &mut fixture,
        &runner,
        recovered_task["id"].as_str().unwrap(),
        &recovered_destination,
        "feature/recovered",
    );
    let target = local_branch_ref("feature/recovered").unwrap();
    let oid = ObjectId::from_hex(
        recovered
            .spec
            .base_oid
            .as_deref()
            .unwrap()
            .as_bytes()
            .to_vec(),
    )
    .unwrap();
    runner
        .create_branch_ref(
            &fixture.project_directory,
            &target,
            &oid,
            &provisioning_marker(&recovered.operation_id).unwrap(),
        )
        .unwrap();
    fixture.runtime.reconcile_task_worktree_operations();
    let recovered_record = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == recovered.task_id)
        .unwrap();
    assert_eq!(
        recovered_record
            .worktree
            .as_ref()
            .map(|binding| binding.path.as_str()),
        Some(
            termloop_platform::canonical_existing_directory_path(&recovered_destination)
                .unwrap()
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(fixture.runtime.store.provisioning_operations().is_empty());

    let ambiguous_task = fixture.create_task("Ambiguous marker", Value::Null);
    let ambiguous_destination = fixture
        .project_directory
        .with_file_name(format!("ambiguous-worktree-{}", Uuid::new_v4()));
    let ambiguous = reserve_create_operation(
        &mut fixture,
        &runner,
        ambiguous_task["id"].as_str().unwrap(),
        &ambiguous_destination,
        "feature/ambiguous",
    );
    let ambiguous_ref = local_branch_ref("feature/ambiguous").unwrap();
    let ambiguous_oid = ObjectId::from_hex(
        ambiguous
            .spec
            .base_oid
            .as_deref()
            .unwrap()
            .as_bytes()
            .to_vec(),
    )
    .unwrap();
    runner
        .create_branch_ref(
            &fixture.project_directory,
            &ambiguous_ref,
            &ambiguous_oid,
            &GitReflogMessage::from_bytes(b"termloop-provision:wrong-operation".to_vec()).unwrap(),
        )
        .unwrap();
    fixture.runtime.reconcile_task_worktree_operations();
    let failed = fixture
        .runtime
        .store
        .provisioning_operations()
        .iter()
        .find(|operation| operation.operation_id == ambiguous.operation_id)
        .unwrap();
    assert_eq!(
        failed.failure,
        Some(ProvisioningFailureKind::BranchConflict)
    );
    assert!(
        runner
            .resolve_ref(&fixture.project_directory, &ambiguous_ref)
            .unwrap()
            .is_some()
    );
    assert!(!ambiguous_destination.exists());
    assert!(
        fixture
            .runtime
            .store
            .tasks()
            .iter()
            .find(|task| task.id == ambiguous.task_id)
            .unwrap()
            .worktree
            .is_none()
    );
    fixture
        .runtime
        .dismiss_task_worktree_provisioning(json!({
            "taskId": ambiguous.task_id,
            "operationId": ambiguous.operation_id,
        }))
        .unwrap();
    assert!(
        fixture
            .runtime
            .store
            .provisioning_operations()
            .iter()
            .all(|operation| operation.operation_id != ambiguous.operation_id)
    );
    assert!(
        runner
            .resolve_ref(&fixture.project_directory, &ambiguous_ref)
            .unwrap()
            .is_some()
    );

    termloop_gitio::test_support::create_branch(
        &runner,
        &fixture.project_directory,
        "existing-gap",
    )
    .unwrap();
    let gap_task = fixture.create_task("Add gap", Value::Null);
    let gap_destination = fixture
        .project_directory
        .with_file_name(format!("gap-worktree-{}", Uuid::new_v4()));
    let gap_operation = reserve_existing_operation(
        &mut fixture,
        &runner,
        gap_task["id"].as_str().unwrap(),
        &gap_destination,
        "existing-gap",
    );
    runner
        .add_worktree(
            &fixture.project_directory,
            &gap_destination,
            &local_branch_ref("existing-gap").unwrap(),
        )
        .unwrap();
    fixture.runtime.reconcile_task_worktree_operations();
    let failed_gap = fixture
        .runtime
        .store
        .provisioning_operations()
        .iter()
        .find(|operation| operation.operation_id == gap_operation.operation_id)
        .unwrap();
    assert_eq!(
        failed_gap.failure,
        Some(ProvisioningFailureKind::RecoveryAttention)
    );
    assert!(gap_destination.exists());
    assert!(
        fixture
            .runtime
            .store
            .tasks()
            .iter()
            .find(|task| task.id == gap_operation.task_id)
            .unwrap()
            .worktree
            .is_none()
    );

    termloop_gitio::test_support::create_branch(
        &runner,
        &fixture.project_directory,
        "dismiss-safe",
    )
    .unwrap();
    let dismiss_task = fixture.create_task("Dismiss safe", Value::Null);
    let dismiss_destination = fixture
        .project_directory
        .with_file_name(format!("dismiss-worktree-{}", Uuid::new_v4()));
    let dismiss_operation = reserve_existing_operation(
        &mut fixture,
        &runner,
        dismiss_task["id"].as_str().unwrap(),
        &dismiss_destination,
        "dismiss-safe",
    );
    fixture
        .runtime
        .store
        .fail_task_worktree_provisioning(
            &fixture.runtime.write_authority,
            &dismiss_operation.task_id,
            &dismiss_operation.operation_id,
            ProvisioningFailureKind::OperationFailed,
            2,
        )
        .unwrap();
    let dismissed = fixture
        .runtime
        .dismiss_task_worktree_provisioning(json!({
            "taskId": dismiss_operation.task_id,
            "operationId": dismiss_operation.operation_id,
        }))
        .unwrap();
    assert!(dismissed.get("worktree_provisioning").is_none());

    let _ = std::fs::remove_dir_all(recovered_destination);
    let _ = std::fs::remove_dir_all(gap_destination);
}

#[test]
fn branch_created_recovery_refuses_a_ref_recreated_after_the_journal_boundary() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Ref ownership changed", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("ref-recreated-worktree-{}", Uuid::new_v4()));
    let params = json!({
        "operationId": Uuid::new_v4().to_string(),
        "taskId": task["id"],
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "feature/ref-recreated",
        "branchMode": "create",
        "baseRef": "refs/heads/main",
    });
    let observed = fixture
        .runtime
        .plan_task_worktree_provisioning(params)
        .unwrap()
        .observe()
        .unwrap();
    let TaskWorktreeProvisioningProgress::Execute(create_ref) = fixture
        .runtime
        .begin_task_worktree_provisioning(observed)
        .unwrap()
    else {
        panic!("new provisioning did not start");
    };
    let TaskWorktreeProvisioningProgress::Execute(_add_worktree) = fixture
        .runtime
        .apply_task_worktree_provisioning_step(create_ref.execute())
        .unwrap()
    else {
        panic!("branch creation did not reach its journal boundary");
    };
    let operation = fixture.runtime.store.provisioning_operations()[0].clone();
    assert_eq!(operation.stage, ProvisioningStage::BranchCreated);
    assert!(operation.created_branch_ref);

    let target_ref = local_branch_ref("feature/ref-recreated").unwrap();
    let original_oid = runner
        .resolve_ref(&fixture.project_directory, &target_ref)
        .unwrap()
        .unwrap();
    runner
        .delete_ref_if_matches(&fixture.project_directory, &target_ref, &original_oid)
        .unwrap();
    std::fs::write(fixture.project_directory.join("new-tip.txt"), b"new tip\n").unwrap();
    termloop_gitio::test_support::commit_all(
        &runner,
        &fixture.project_directory,
        "create a different tip",
    )
    .unwrap();
    let main_ref = local_branch_ref("main").unwrap();
    let replacement_oid = runner
        .resolve_ref(&fixture.project_directory, &main_ref)
        .unwrap()
        .unwrap();
    runner
        .create_branch_ref(
            &fixture.project_directory,
            &target_ref,
            &replacement_oid,
            &GitReflogMessage::from_bytes(b"external-ref-recreation".to_vec()).unwrap(),
        )
        .unwrap();

    fixture.runtime.reconcile_task_worktree_operations();

    let failed = fixture
        .runtime
        .store
        .provisioning_operations()
        .iter()
        .find(|candidate| candidate.operation_id == operation.operation_id)
        .unwrap();
    assert_eq!(
        failed.failure,
        Some(ProvisioningFailureKind::RecoveryAttention)
    );
    assert!(!destination.exists());
    assert_eq!(
        runner
            .resolve_ref(&fixture.project_directory, &target_ref)
            .unwrap(),
        Some(replacement_oid)
    );
    assert!(
        fixture
            .runtime
            .store
            .tasks()
            .iter()
            .find(|candidate| candidate.id == operation.task_id)
            .unwrap()
            .worktree
            .is_none()
    );
}

#[test]
fn dismiss_preserves_an_external_ref_that_won_the_create_race() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("External branch won", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("external-ref-race-{}", Uuid::new_v4()));
    let operation_id = Uuid::new_v4().to_string();
    let params = json!({
        "operationId": operation_id,
        "taskId": task["id"],
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "feature/external-race",
        "branchMode": "create",
        "baseRef": "refs/heads/main",
    });
    let observed = fixture
        .runtime
        .plan_task_worktree_provisioning(params)
        .unwrap()
        .observe()
        .unwrap();
    let TaskWorktreeProvisioningProgress::Execute(create_ref) = fixture
        .runtime
        .begin_task_worktree_provisioning(observed)
        .unwrap()
    else {
        panic!("new provisioning did not start");
    };
    termloop_gitio::test_support::create_branch(
        &runner,
        &fixture.project_directory,
        "feature/external-race",
    )
    .unwrap();
    assert!(matches!(
        fixture
            .runtime
            .apply_task_worktree_provisioning_step(create_ref.execute()),
        Err(CoreError::BranchMutationConflict)
    ));
    let failed = fixture.runtime.store.provisioning_operations()[0].clone();
    assert_eq!(failed.stage, ProvisioningStage::Reserved);
    assert!(!failed.created_branch_ref);
    assert_eq!(
        failed.failure,
        Some(ProvisioningFailureKind::BranchConflict)
    );

    let dismissed = fixture
        .runtime
        .dismiss_task_worktree_provisioning(json!({
            "taskId": task["id"],
            "operationId": operation_id,
        }))
        .unwrap();

    assert!(dismissed.get("worktree_provisioning").is_none());
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
    assert!(!destination.exists());
    assert!(
        runner
            .resolve_ref(
                &fixture.project_directory,
                &local_branch_ref("feature/external-race").unwrap(),
            )
            .unwrap()
            .is_some()
    );
}
