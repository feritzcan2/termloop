use super::*;
use termloop_domain::{
    AgentLaunchSelection, ProcessDescriptor, ProjectRecord, SessionKind, SessionRecord, TaskRecord,
    TaskStatus, WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX, WorkflowConfiguration, WorkflowExecution,
    WorkflowExecutionPhase, WorkflowStep, WorkflowStepKind,
};

fn project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        name: id.into(),
        folder_path: format!("/tmp/{id}"),
    }
}

fn configuration(id: &str, project_id: &str) -> WorkflowConfiguration {
    WorkflowConfiguration {
        id: id.into(),
        project_id: project_id.into(),
        name: format!("Workflow {id}"),
        coordinator_agent_id: "codex".into(),
        launch_selection: AgentLaunchSelection::default(),
        max_review_cycles: 2,
        steps: vec![
            WorkflowStep {
                id: "discuss".into(),
                kind: WorkflowStepKind::Discuss,
                title: "Discuss".into(),
                instructions: "Challenge the proposed approach.".into(),
                agent_id: Some("claude".into()),
                reuse_step_id: None,
                launch_selection: Some(AgentLaunchSelection::new(
                    "default",
                    "bypassPermissions",
                    "default",
                )),
            },
            WorkflowStep {
                id: "implement".into(),
                kind: WorkflowStepKind::Implement,
                title: "Implement".into(),
                instructions: "Implement and verify the agreed approach.".into(),
                agent_id: None,
                reuse_step_id: None,
                launch_selection: None,
            },
            WorkflowStep {
                id: "review".into(),
                kind: WorkflowStepKind::Review,
                title: "Review".into(),
                instructions: "Review the result and report concrete findings.".into(),
                agent_id: Some("claude".into()),
                reuse_step_id: Some("discuss".into()),
                launch_selection: None,
            },
        ],
        generation: 1,
        updated_at_epoch_ms: 1,
    }
}

fn task(id: &str, project_id: &str) -> TaskRecord {
    TaskRecord {
        id: id.into(),
        project_id: project_id.into(),
        title: "Workflow task".into(),
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
    }
}

fn coordinator_session(id: &str, project_id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        project_id: project_id.into(),
        name: Some("Discuss, implement, review".into()),
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "codex".into(),
            args: vec![],
            cwd: format!("/tmp/{project_id}"),
            agent_id: Some("codex".into()),
            template_ref: Some("builtin.agent.task-workflow".into()),
            template_version: Some(3),
        },
        launch_selection: AgentLaunchSelection::default(),
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
    }
}

fn execution(
    id: &str,
    task_id: &str,
    coordinator_session_id: &str,
    configuration: WorkflowConfiguration,
) -> WorkflowExecution {
    WorkflowExecution {
        id: id.into(),
        project_id: configuration.project_id.clone(),
        task_id: task_id.into(),
        configuration,
        goal: "Ship Core-managed workflows.".into(),
        coordinator_session_id: coordinator_session_id.into(),
        current_step_index: 0,
        review_cycle: 1,
        phase: WorkflowExecutionPhase::AwaitingCoordinator,
        coordinator_prompt_pending: false,
        current_request_id: None,
        participants: vec![],
        review_requests: vec![],
        step_results: vec![],
        review_changes_requested: false,
        started_at_epoch_ms: 1,
        updated_at_epoch_ms: 1,
    }
}

fn open_store(label: &str) -> (std::path::PathBuf, CoreWriteAuthority, Store) {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-workflow-{label}-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let store = Store::open(&path).unwrap();
    (path, authority, store)
}

#[test]
fn schema_50_migrates_to_empty_workflow_current_state() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-workflow-migration-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 50,
            "revision": 4,
            "projects": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.workflow_configurations().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["workflow_configurations"], serde_json::json!([]));
    assert_eq!(persisted["workflow_executions"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_51_migrates_to_an_empty_current_execution_set() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-workflow-execution-migration-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 51,
            "revision": 4,
            "projects": [],
            "sessions": [],
            "workflow_configurations": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.workflow_executions().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["workflow_executions"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_52_migrates_existing_executions_to_empty_step_results() {
    let (path, authority, mut store) = open_store("step-result-migration");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .insert_task(&authority, task("task-a", "project-a"))
        .unwrap();
    let configuration = store
        .set_workflow_configuration(
            &authority,
            configuration("workflow-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    store
        .insert_workflow_coordinator_session(
            &authority,
            coordinator_session("coordinator-1", "project-a"),
            execution("execution-1", "task-a", "coordinator-1", configuration),
        )
        .unwrap();
    drop(store);

    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["schema_version"] = serde_json::json!(52);
    legacy["workflow_executions"][0]
        .as_object_mut()
        .unwrap()
        .remove("stepResults");
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let migrated = Store::open(&path).unwrap();
    assert!(migrated.workflow_executions()[0].step_results.is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["workflow_executions"][0]["stepResults"],
        serde_json::json!([])
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_53_migrates_existing_executions_to_empty_review_requests() {
    let (path, authority, mut store) = open_store("parallel-review-migration");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .insert_task(&authority, task("task-a", "project-a"))
        .unwrap();
    let configuration = store
        .set_workflow_configuration(
            &authority,
            configuration("workflow-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    store
        .insert_workflow_coordinator_session(
            &authority,
            coordinator_session("coordinator-1", "project-a"),
            execution("execution-1", "task-a", "coordinator-1", configuration),
        )
        .unwrap();
    drop(store);

    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["schema_version"] = serde_json::json!(53);
    legacy["workflow_executions"][0]
        .as_object_mut()
        .unwrap()
        .remove("reviewRequests");
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let migrated = Store::open(&path).unwrap();
    assert!(migrated.workflow_executions()[0].review_requests.is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["workflow_executions"][0]["reviewRequests"],
        serde_json::json!([])
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_54_migrates_fresh_workflow_helpers_to_bypass_launches() {
    let (path, authority, mut store) = open_store("workflow-helper-launch-migration");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .insert_task(&authority, task("task-a", "project-a"))
        .unwrap();
    let configuration = store
        .set_workflow_configuration(
            &authority,
            configuration("workflow-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    store
        .insert_workflow_coordinator_session(
            &authority,
            coordinator_session("coordinator-1", "project-a"),
            execution("execution-1", "task-a", "coordinator-1", configuration),
        )
        .unwrap();
    drop(store);

    let mut legacy: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["schema_version"] = serde_json::json!(54);
    for configuration in legacy["workflow_configurations"].as_array_mut().unwrap() {
        for step in configuration["steps"].as_array_mut().unwrap() {
            step.as_object_mut().unwrap().remove("launchSelection");
        }
    }
    for execution in legacy["workflow_executions"].as_array_mut().unwrap() {
        for step in execution["configuration"]["steps"].as_array_mut().unwrap() {
            step.as_object_mut().unwrap().remove("launchSelection");
        }
    }
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let migrated = Store::open(&path).unwrap();
    for configuration in [
        &migrated.workflow_configurations()[0],
        &migrated.workflow_executions()[0].configuration,
    ] {
        assert_eq!(
            configuration.steps[0].launch_selection,
            Some(AgentLaunchSelection::new(
                "default",
                "bypassPermissions",
                "default",
            ))
        );
        assert!(configuration.steps[1].launch_selection.is_none());
        assert!(configuration.steps[2].launch_selection.is_none());
    }
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    let _ = std::fs::remove_file(path);
}

#[test]
fn workflow_configuration_crud_is_revisioned_and_project_scoped() {
    let (path, authority, mut store) = open_store("crud");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();

    assert!(matches!(
        store.set_workflow_configuration(
            &authority,
            configuration("workflow-1", "missing"),
            store.revision(),
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(matches!(
        store
            .set_workflow_configuration(&authority, configuration("workflow-1", "project-a"), 999,),
        Err(StoreError::RevisionConflict)
    ));

    let created = store
        .set_workflow_configuration(
            &authority,
            configuration("workflow-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    assert_eq!(
        store.workflow_configurations(),
        std::slice::from_ref(&created)
    );

    let revision = store.revision();
    store
        .set_workflow_configuration(&authority, created.clone(), revision)
        .unwrap();
    assert_eq!(store.revision(), revision);

    let deleted = store
        .delete_workflow_configuration(&authority, &created.id, store.revision())
        .unwrap();
    assert_eq!(deleted, created);
    assert!(store.workflow_configurations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn workflow_configuration_count_is_bounded_and_project_delete_cascades() {
    let (path, authority, mut store) = open_store("bounds");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    for index in 0..WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX {
        store
            .set_workflow_configuration(
                &authority,
                configuration(&format!("workflow-{index}"), "project-a"),
                store.revision(),
            )
            .unwrap();
    }
    assert!(matches!(
        store.set_workflow_configuration(
            &authority,
            configuration("one-too-many", "project-a"),
            store.revision(),
        ),
        Err(StoreError::ConstraintViolation)
    ));

    store
        .delete_project_and_related_records(&authority, "project-a")
        .unwrap();
    assert!(store.workflow_configurations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn coordinator_and_current_execution_are_atomic_bounded_and_durable() {
    let (path, authority, mut store) = open_store("execution");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .insert_task(&authority, task("task-a", "project-a"))
        .unwrap();
    let configuration = store
        .set_workflow_configuration(
            &authority,
            configuration("workflow-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    let first = execution(
        "execution-1",
        "task-a",
        "coordinator-1",
        configuration.clone(),
    );
    store
        .insert_workflow_coordinator_session(
            &authority,
            coordinator_session("coordinator-1", "project-a"),
            first.clone(),
        )
        .unwrap();
    assert_eq!(store.workflow_executions(), std::slice::from_ref(&first));

    assert!(matches!(
        store.insert_workflow_coordinator_session(
            &authority,
            coordinator_session("coordinator-2", "project-a"),
            execution("execution-2", "task-a", "coordinator-2", configuration,),
        ),
        Err(StoreError::ConstraintViolation)
    ));

    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.workflow_executions(), std::slice::from_ref(&first));
    let removed = reopened
        .cancel_workflow_execution(&authority, &first.id, reopened.revision())
        .unwrap();
    assert_eq!(removed, first);
    assert!(reopened.workflow_executions().is_empty());
    let _ = std::fs::remove_file(path);
}
