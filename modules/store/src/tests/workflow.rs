use super::*;
use termloop_domain::{
    AgentLaunchSelection, ProjectRecord, WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX,
    WorkflowConfiguration, WorkflowStep, WorkflowStepKind,
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
            },
            WorkflowStep {
                id: "implement".into(),
                kind: WorkflowStepKind::Implement,
                title: "Implement".into(),
                instructions: "Implement and verify the agreed approach.".into(),
                agent_id: None,
                reuse_step_id: None,
            },
            WorkflowStep {
                id: "review".into(),
                kind: WorkflowStepKind::Review,
                title: "Review".into(),
                instructions: "Review the result and report concrete findings.".into(),
                agent_id: Some("claude".into()),
                reuse_step_id: Some("discuss".into()),
            },
        ],
        generation: 1,
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
