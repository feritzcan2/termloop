use super::*;

fn fixture() -> (Fixture, Value, PathBuf) {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Provisioning revalidation", Value::Null);
    let repository =
        termloop_platform::canonical_existing_directory_path(&fixture.project_directory).unwrap();
    let destination = repository.with_file_name("revalidation-worktree");
    let params = json!({
        "operationId": Uuid::new_v4().to_string(),
        "taskId": task["id"],
        "repositoryPath": repository,
        "destinationPath": destination,
        "branchName": "feature/revalidation",
        "branchMode": "create",
        "baseRef": "refs/remotes/origin/main",
    });
    (fixture, params, destination)
}

fn observe(fixture: &Fixture, params: &Value) -> ObservedTaskWorktreeProvisioning {
    fixture
        .runtime
        .plan_task_worktree_provisioning(params.clone())
        .unwrap()
        .observe()
        .unwrap()
}

fn next_step(
    fixture: &mut Fixture,
    step: Box<TaskWorktreeProvisioningStep>,
) -> Box<TaskWorktreeProvisioningStep> {
    let TaskWorktreeProvisioningProgress::Execute(next) = fixture
        .runtime
        .apply_task_worktree_provisioning_step(step.execute())
        .unwrap()
    else {
        panic!("expected another provisioning step");
    };
    next
}

fn begin(fixture: &mut Fixture, params: &Value) -> Box<TaskWorktreeProvisioningStep> {
    let observed = observe(fixture, params);
    let TaskWorktreeProvisioningProgress::Execute(step) = fixture
        .runtime
        .begin_task_worktree_provisioning(observed)
        .unwrap()
    else {
        panic!("expected provisioning to start");
    };
    step
}

fn assert_no_provisioning(fixture: &Fixture, params: &Value, destination: &Path, revision: u64) {
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
    assert!(fixture.runtime.store.managed_worktrees().is_empty());
    assert!(!destination.exists());
    assert!(
        GitRunner::discover()
            .unwrap()
            .resolve_ref(
                &fixture.project_directory,
                &local_branch_ref(params["branchName"].as_str().unwrap()).unwrap(),
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn archive_during_observation_rejects_provisioning_without_mutation() {
    let (mut fixture, params, destination) = fixture();
    let observed = observe(&fixture, &params);
    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": params["taskId"] }))
        .unwrap();
    fixture
        .runtime
        .archive_task(json!({
            "taskId": params["taskId"],
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    let revision = fixture.runtime.state_revision();
    assert!(
        matches!(fixture.runtime.begin_task_worktree_provisioning(observed),
        Err(CoreError::TaskArchived { task_id }) if task_id == params["taskId"])
    );
    assert_no_provisioning(&fixture, &params, &destination, revision);
}

#[test]
fn archive_reservation_during_observation_rejects_provisioning() {
    let (mut fixture, params, destination) = fixture();
    let observed = observe(&fixture, &params);
    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": params["taskId"] }))
        .unwrap();
    let archive_id = Uuid::new_v4().to_string();
    let archive = fixture
        .runtime
        .prepare_task_archive(json!({
            "taskId": params["taskId"],
            "operationId": archive_id,
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    let revision = fixture.runtime.state_revision();
    assert!(
        matches!(fixture.runtime.begin_task_worktree_provisioning(observed),
        Err(CoreError::ArchiveInProgress { operation_id, .. }) if operation_id == archive_id)
    );
    assert_no_provisioning(&fixture, &params, &destination, revision);
    fixture.runtime.complete_task_archive(archive).unwrap();
}

#[test]
fn project_folder_change_invalidates_provisioning_observation() {
    let (mut fixture, params, destination) = fixture();
    let observed = observe(&fixture, &params);
    let other = fixture.fixture_root.join("other-project");
    std::fs::create_dir_all(&other).unwrap();
    fixture
        .runtime
        .update_project_details(json!({
            "projectId": fixture.project_id, "name": "Moved", "folderPath": other,
        }))
        .unwrap();
    let revision = fixture.runtime.state_revision();
    assert!(
        matches!(fixture.runtime.begin_task_worktree_provisioning(observed),
        Err(CoreError::InvalidParams(field)) if field == "repositoryPath")
    );
    assert_no_provisioning(&fixture, &params, &destination, revision);
}

#[test]
fn project_rename_keeps_observation_valid_and_folder_is_reserved_through_commit() {
    let (mut fixture, params, _) = fixture();
    let observed = observe(&fixture, &params);
    let rename = json!({
        "projectId": fixture.project_id, "name": "Renamed", "folderPath": fixture.project_directory,
    });
    fixture
        .runtime
        .update_project_details(rename.clone())
        .unwrap();
    let other = fixture.fixture_root.join("other-project");
    std::fs::create_dir_all(&other).unwrap();
    let move_project = json!({
        "projectId": fixture.project_id, "name": "Moved", "folderPath": other,
    });
    let mut progress = fixture
        .runtime
        .begin_task_worktree_provisioning(observed)
        .unwrap();
    while let TaskWorktreeProvisioningProgress::Execute(step) = progress {
        let revision = fixture.runtime.state_revision();
        assert!(
            matches!(fixture.runtime.update_project_details(move_project.clone()),
            Err(CoreError::ProvisioningAlreadyInProgress { operation_id }) if operation_id == params["operationId"])
        );
        assert_eq!(fixture.runtime.state_revision(), revision);
        fixture
            .runtime
            .update_project_details(rename.clone())
            .unwrap();
        progress = fixture
            .runtime
            .apply_task_worktree_provisioning_step(step.execute())
            .unwrap();
    }
    fixture
        .runtime
        .update_project_details(move_project)
        .unwrap();
}

#[test]
fn verification_timeout_retries_existing_worktree_without_dismissing_journal() {
    let (mut fixture, mut params, destination) = fixture();
    let create = begin(&mut fixture, &params);
    let add = next_step(&mut fixture, create);
    let mut verify = next_step(&mut fixture, add);
    verify.runner = verify.runner.with_limits(Duration::ZERO, 1024);
    assert!(matches!(
        fixture
            .runtime
            .apply_task_worktree_provisioning_step(verify.execute()),
        Err(CoreError::GitObservationTimedOut)
    ));
    let operation = fixture.runtime.store.provisioning_operations()[0].clone();
    assert_eq!(operation.stage, ProvisioningStage::WorktreeAdded);
    assert_eq!(operation.failure, Some(ProvisioningFailureKind::Timeout));
    assert!(destination.exists());
    // The desktop uses a fresh request ID; Core must still resume the exact journal.
    params["operationId"] = json!(Uuid::new_v4().to_string());
    let result = fixture.runtime.provision_task_worktree(params).unwrap();
    assert!(result["provisioning"].is_null());
    assert_eq!(
        fixture.runtime.store.managed_worktrees()[0].operation_id,
        operation.operation_id
    );
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
}

fn attach_steward(fixture: &mut Fixture) {
    fixture
        .runtime
        .set_steward_configuration(crate::StewardConfigurationUpdate {
            project_id: &fixture.project_id,
            agent_id: "codex",
            model: "default".into(),
            permission: "bypassPermissions".into(),
            reasoning: "default".into(),
            enabled: true,
            system_prompt: String::new(),
            expected_revision: fixture.runtime.state_revision(),
            capability: crate::AssistantAvailability::Proven,
            updated_at_epoch_ms: 1,
        })
        .unwrap();
    fixture
        .runtime
        .store
        .attach_steward_executor_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                id: "retry-steward".into(),
                project_id: fixture.project_id.clone(),
                name: None,
                kind: termloop_domain::SessionKind::Agent,
                process: termloop_domain::ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: fixture.project_directory.to_string_lossy().into_owned(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.steward.executor".into()),
                    template_version: Some(4),
                },
                launch_selection: Default::default(),
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
            &fixture.project_id,
            1,
            2,
        )
        .unwrap();
}

#[test]
fn steward_retry_keeps_created_branch_spec_even_after_task_rename() {
    let (mut fixture, params, _) = fixture();
    attach_steward(&mut fixture);
    let create = begin(&mut fixture, &params);
    let mut add = next_step(&mut fixture, create);
    add.runner = add.runner.with_limits(Duration::ZERO, 1024);
    assert!(
        fixture
            .runtime
            .apply_task_worktree_provisioning_step(add.execute())
            .is_err()
    );
    assert_eq!(
        fixture.runtime.store.provisioning_operations()[0].failure,
        Some(ProvisioningFailureKind::RecoveryAttention)
    );
    fixture
        .runtime
        .rename_task(json!({ "taskId": params["taskId"], "title": "Renamed task" }))
        .unwrap();
    let plan = fixture
        .runtime
        .plan_steward_task_agent_start(
            "retry-steward",
            &fixture.project_id,
            params["taskId"].as_str().unwrap(),
            Some("codex"),
            None,
        )
        .unwrap();
    let retry = plan.worktree_provisioning_retry_params().unwrap();
    assert_eq!(retry, params);
    let result = fixture.runtime.provision_task_worktree(retry).unwrap();
    assert_eq!(result["task"]["branch"]["name"], params["branchName"]);
    assert!(fixture.runtime.store.provisioning_operations().is_empty());
    let plan = fixture
        .runtime
        .plan_steward_task_agent_start(
            "retry-steward",
            &fixture.project_id,
            params["taskId"].as_str().unwrap(),
            Some("codex"),
            None,
        )
        .unwrap();
    assert!(plan.worktree_provisioning_retry_params().is_none());
}
