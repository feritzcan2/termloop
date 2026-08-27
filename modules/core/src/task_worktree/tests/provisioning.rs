use super::*;

#[test]
fn worktree_provisioning_is_durable_and_completed_retries_do_not_write() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Provision", Value::Null);
    let task_id = task["id"].as_str().unwrap().to_owned();
    let operation_id = Uuid::new_v4().to_string();
    let destination = fixture.project_directory.with_file_name(format!(
        "{}-worktree",
        fixture
            .project_directory
            .file_name()
            .unwrap()
            .to_string_lossy()
    ));
    let params = json!({
        "operationId": operation_id,
        "taskId": task_id,
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "feature/provision",
        "branchMode": "create",
        "baseRef": "refs/heads/main",
    });
    let result = fixture
        .runtime
        .provision_task_worktree(params.clone())
        .unwrap();
    assert_eq!(result["task"]["branch"]["name"], "feature/provision");
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    assert_eq!(
        result["task"]["worktree"]["path"],
        canonical_destination.to_string_lossy().as_ref()
    );
    assert!(result["provisioning"].is_null());
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
    assert_eq!(fixture.runtime.store.managed_worktrees().len(), 1);
    assert_eq!(
        fixture.runtime.store.managed_worktrees()[0]
            .normalized_spec
            .version,
        1
    );

    let revision = fixture.runtime.state_revision();
    let updated_at = result["task"]["updated_at_epoch_ms"].clone();
    let retried = fixture
        .runtime
        .provision_task_worktree(params.clone())
        .unwrap();
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert_eq!(retried["task"]["updated_at_epoch_ms"], updated_at);

    let mut changed = params;
    changed["destinationPath"] = json!(destination.with_extension("different"));
    assert!(matches!(
        fixture.runtime.provision_task_worktree(changed),
        Err(CoreError::OperationIdReused { operation_id: reused }) if reused == operation_id
    ));

    drop(fixture);
    let _ = std::fs::remove_dir_all(destination);
}

#[test]
fn fresh_existing_destination_is_rejected_before_journaling() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Reject existing destination", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("existing-destination-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&destination).unwrap();
    let revision = fixture.runtime.state_revision();
    let error = fixture.runtime.provision_task_worktree(json!({
        "operationId": Uuid::new_v4().to_string(),
        "taskId": task["id"],
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "feature/existing-destination",
        "branchMode": "create",
        "baseRef": "refs/heads/main",
    }));
    assert!(matches!(error, Err(CoreError::WorktreePathConflict)));
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
    assert!(fixture.runtime.store.managed_worktrees().is_empty());
    let _ = std::fs::remove_dir_all(destination);
}

#[test]
fn symbolic_head_branch_name_is_rejected_before_ref_or_journal_creation() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Reject symbolic HEAD", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("invalid-head-worktree-{}", Uuid::new_v4()));
    let revision = fixture.runtime.state_revision();

    assert!(matches!(
        fixture.runtime.provision_task_worktree(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": task["id"],
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": "HEAD",
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        })),
        Err(CoreError::InvalidParams(ref field)) if field == "branchName"
    ));
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
    assert!(!destination.exists());
    let invalid_ref = GitRefName::from_bytes(b"refs/heads/HEAD".to_vec()).unwrap();
    assert!(
        runner
            .resolve_ref(&fixture.project_directory, &invalid_ref)
            .unwrap()
            .is_none()
    );
}

#[test]
fn concurrent_same_spec_returns_the_current_running_projection() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Coalesce provisioning", Value::Null);
    let first_operation_id = Uuid::new_v4().to_string();
    let destination = fixture
        .project_directory
        .with_file_name(format!("coalesced-worktree-{}", Uuid::new_v4()));
    let mut params = json!({
        "operationId": first_operation_id,
        "taskId": task["id"],
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "feature/coalesced",
        "branchMode": "create",
        "baseRef": "refs/heads/main",
    });
    let observed = fixture
        .runtime
        .plan_task_worktree_provisioning(params.clone())
        .unwrap()
        .observe()
        .unwrap();
    assert!(matches!(
        fixture
            .runtime
            .begin_task_worktree_provisioning(observed)
            .unwrap(),
        TaskWorktreeProvisioningProgress::Execute(_)
    ));
    let revision = fixture.runtime.state_revision();
    params["operationId"] = json!(Uuid::new_v4().to_string());
    let observed = fixture
        .runtime
        .plan_task_worktree_provisioning(params)
        .unwrap()
        .observe()
        .unwrap();
    let TaskWorktreeProvisioningProgress::Return(result) = fixture
        .runtime
        .begin_task_worktree_provisioning(observed)
        .unwrap()
    else {
        panic!("same-spec caller did not coalesce");
    };
    assert_eq!(result["provisioning"]["operation_id"], first_operation_id);
    assert_eq!(result["provisioning"]["status"], "running");
    assert_eq!(fixture.runtime.state_revision(), revision);
}

#[test]
fn provisioning_overlap_uses_filesystem_identity_for_symlinked_registered_checkouts() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let first = fixture.create_task("Symlinked holder", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("symlinked-worktree-{}", Uuid::new_v4()));
    fixture
        .runtime
        .provision_task_worktree(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": first["id"],
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": "feature/symlinked-holder",
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        }))
        .unwrap();
    // Relocate the registered checkout and leave a symlink at the recorded
    // location, so Git's recorded bytes and the checkout's current canonical
    // identity diverge textually.
    let recorded = termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    let relocated = fixture
        .project_directory
        .with_file_name(format!("relocated-worktree-{}", Uuid::new_v4()));
    std::fs::rename(&recorded, &relocated).unwrap();
    if let Err(error) =
        termloop_platform::test_support::create_directory_symlink(&relocated, &recorded)
    {
        eprintln!("UNMEASURED: directory symlink unavailable: {error}");
        return;
    }

    let second = fixture.create_task("Nested contender", Value::Null);
    let task = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == second["id"].as_str().unwrap())
        .unwrap()
        .clone();
    let observed = observe_provisioning_spec(
        &runner,
        &json!({
            "repositoryPath": fixture.project_directory,
            "destinationPath": relocated.join("nested-worktree"),
            "branchName": "feature/nested-contender",
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        }),
        &task,
        &fixture.project_directory,
        None,
        false,
    );
    assert!(matches!(observed, Err(CoreError::WorktreePathConflict)));
}

#[test]
fn provisioning_overlap_falls_back_to_recorded_paths_for_missing_checkouts() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let first = fixture.create_task("Missing holder", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("missing-worktree-{}", Uuid::new_v4()));
    fixture
        .runtime
        .provision_task_worktree(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": first["id"],
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": "feature/missing-holder",
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        }))
        .unwrap();
    // A registered-but-deleted checkout has no canonical identity; the overlap
    // check must still block the exact recorded destination.
    let recorded = termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    std::fs::remove_dir_all(&recorded).unwrap();

    let second = fixture.create_task("Recorded contender", Value::Null);
    let task = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == second["id"].as_str().unwrap())
        .unwrap()
        .clone();
    let observed = observe_provisioning_spec(
        &runner,
        &json!({
            "repositoryPath": fixture.project_directory,
            "destinationPath": recorded,
            "branchName": "feature/recorded-contender",
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        }),
        &task,
        &fixture.project_directory,
        None,
        false,
    );
    assert!(matches!(observed, Err(CoreError::WorktreePathConflict)));
}

#[test]
fn provisioning_branch_reservation_blocks_another_task_binding() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let first = fixture.create_task("Provisioning holder", Value::Null);
    let second = fixture.create_task("Binding contender", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("reserved-bind-worktree-{}", Uuid::new_v4()));
    let operation = reserve_create_operation(
        &mut fixture,
        &runner,
        first["id"].as_str().unwrap(),
        &destination,
        "feature/reserved-bind",
    );
    let result = fixture
        .runtime
        .complete_task_branch_binding(ObservedTaskBranchBinding {
            task_id: second["id"].as_str().unwrap().to_owned(),
            project_id: fixture.project_id.clone(),
            binding: TaskBranchBinding {
                repository_root: operation.spec.repository_root,
                name: operation.spec.branch_name,
            },
        });
    assert!(matches!(
        result,
        Err(CoreError::BranchHeldByTask { task_id }) if task_id == operation.task_id
    ));
    assert!(
        fixture
            .runtime
            .store
            .tasks()
            .iter()
            .find(|task| task.id == second["id"])
            .unwrap()
            .branch
            .is_none()
    );
}

#[test]
fn provisioning_reservation_blocks_a_different_binding_for_the_same_task() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Same Task contender", Value::Null);
    let destination = fixture
        .project_directory
        .with_file_name(format!("same-task-bind-worktree-{}", Uuid::new_v4()));
    let operation = reserve_create_operation(
        &mut fixture,
        &runner,
        task["id"].as_str().unwrap(),
        &destination,
        "feature/reserved-same-task",
    );
    let result = fixture
        .runtime
        .complete_task_branch_binding(ObservedTaskBranchBinding {
            task_id: task["id"].as_str().unwrap().to_owned(),
            project_id: fixture.project_id.clone(),
            binding: TaskBranchBinding {
                repository_root: operation.spec.repository_root,
                name: "feature/different".into(),
            },
        });
    assert!(matches!(
        result,
        Err(CoreError::ProvisioningAlreadyInProgress { operation_id })
            if operation_id == operation.operation_id
    ));
    assert!(fixture.runtime.store.tasks()[0].branch.is_none());
}

#[test]
fn provisioning_branch_reservation_blocks_a_second_destination() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let first = fixture.create_task("First provisioning", Value::Null);
    let second = fixture.create_task("Second provisioning", Value::Null);
    let first_destination = fixture
        .project_directory
        .with_file_name(format!("first-reserved-worktree-{}", Uuid::new_v4()));
    let first_operation = reserve_create_operation(
        &mut fixture,
        &runner,
        first["id"].as_str().unwrap(),
        &first_destination,
        "feature/shared-reservation",
    );
    let second_destination = fixture
        .project_directory
        .with_file_name(format!("second-reserved-worktree-{}", Uuid::new_v4()));
    let plan = fixture
        .runtime
        .plan_task_worktree_provisioning(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": second["id"],
            "repositoryPath": fixture.project_directory,
            "destinationPath": second_destination,
            "branchName": "feature/shared-reservation",
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        }))
        .unwrap();
    let observed = plan.observe().unwrap();
    assert!(matches!(
        fixture
            .runtime
            .begin_task_worktree_provisioning(observed),
        Err(CoreError::BranchHeldByTask { task_id }) if task_id == first_operation.task_id
    ));
    assert_eq!(fixture.runtime.store.provisioning_operations().len(), 1);
}

#[test]
fn worktree_added_operation_coalesces_and_explicit_retry_can_commit() {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    termloop_gitio::test_support::create_branch(
        &runner,
        &fixture.project_directory,
        "existing-worktree-added",
    )
    .unwrap();
    let task = fixture.create_task("Worktree added retry", Value::Null);
    let operation_id = Uuid::new_v4().to_string();
    let destination = fixture
        .project_directory
        .with_file_name(format!("worktree-added-retry-{}", Uuid::new_v4()));
    let params = json!({
        "operationId": operation_id,
        "taskId": task["id"],
        "repositoryPath": fixture.project_directory,
        "destinationPath": destination,
        "branchName": "existing-worktree-added",
        "branchMode": "existing",
    });
    let observed = fixture
        .runtime
        .plan_task_worktree_provisioning(params.clone())
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
    let TaskWorktreeProvisioningProgress::Execute(_verify) = fixture
        .runtime
        .apply_task_worktree_provisioning_step(add.execute())
        .unwrap()
    else {
        panic!("worktree add did not advance");
    };
    assert_eq!(
        fixture.runtime.store.provisioning_operations()[0].stage,
        ProvisioningStage::WorktreeAdded
    );

    let mut coalesced_params = params.clone();
    coalesced_params["operationId"] = json!(Uuid::new_v4().to_string());
    let coalesced = fixture
        .runtime
        .plan_task_worktree_provisioning(coalesced_params)
        .unwrap()
        .observe()
        .unwrap();
    let TaskWorktreeProvisioningProgress::Return(running) = fixture
        .runtime
        .begin_task_worktree_provisioning(coalesced)
        .unwrap()
    else {
        panic!("worktreeAdded operation did not coalesce");
    };
    assert_eq!(running["provisioning"]["operation_id"], operation_id);
    assert_eq!(running["provisioning"]["status"], "running");

    fixture
        .runtime
        .store
        .fail_task_worktree_provisioning(
            &fixture.runtime.write_authority,
            task["id"].as_str().unwrap(),
            &operation_id,
            ProvisioningFailureKind::RecoveryAttention,
            2,
        )
        .unwrap();
    let retried = fixture
        .runtime
        .plan_task_worktree_provisioning(params)
        .unwrap()
        .observe()
        .unwrap();
    let TaskWorktreeProvisioningProgress::Execute(verify) = fixture
        .runtime
        .begin_task_worktree_provisioning(retried)
        .unwrap()
    else {
        panic!("explicit worktreeAdded retry did not resume verification");
    };
    let TaskWorktreeProvisioningProgress::Return(completed) = fixture
        .runtime
        .apply_task_worktree_provisioning_step(verify.execute())
        .unwrap()
    else {
        panic!("worktreeAdded retry did not commit");
    };
    assert_eq!(
        completed["task"]["branch"]["name"],
        "existing-worktree-added"
    );
    assert!(completed["provisioning"].is_null());
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
    let _ = std::fs::remove_dir_all(destination);
}
