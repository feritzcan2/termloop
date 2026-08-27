use super::*;
use termloop_domain::{
    NormalizedWorktreeSpec, ProcessDescriptor, ProjectRecord, ProjectTaskAutomationConfiguration,
    ProvisioningBranchMode, ProvisioningStage, SessionKind, SessionRecord, TaskRecord, TaskStatus,
    WorktreeProvisioningOperation,
};

fn project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        name: id.into(),
        folder_path: format!("/projects/{id}"),
    }
}

fn task(id: &str, project_id: &str) -> TaskRecord {
    TaskRecord {
        id: id.into(),
        project_id: project_id.into(),
        title: id.into(),
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
    }
}

#[test]
fn project_task_automation_is_revision_checked_and_deleted_with_the_project() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-project-task-automation-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-automation"))
        .unwrap();
    let revision = store.revision();
    store
        .set_project_task_automation_configuration(
            &authority,
            ProjectTaskAutomationConfiguration {
                project_id: "project-automation".into(),
                create_worktree: true,
                agent_id: Some("codex".into()),
                model: Some("gpt-5.6-sol".into()),
                permission: Some("bypassPermissions".into()),
                reasoning: Some("high".into()),
                kickoff_message: Some("Implement and verify this Task.".into()),
            },
            revision,
        )
        .unwrap();
    assert!(matches!(
        store.set_project_task_automation_configuration(
            &authority,
            ProjectTaskAutomationConfiguration {
                project_id: "project-automation".into(),
                create_worktree: false,
                agent_id: None,
                model: None,
                permission: None,
                reasoning: None,
                kickoff_message: None,
            },
            revision,
        ),
        Err(StoreError::RevisionConflict)
    ));
    store
        .delete_project_and_related_records(&authority, "project-automation")
        .unwrap();
    assert!(store.project_task_automation_configurations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_delete_blocks_only_worktrees_and_cascades_running_sessions() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-project-delete-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    for project_id in ["project-worktree", "project-cascade"] {
        store
            .insert_project(&authority, project(project_id))
            .unwrap();
    }
    store
        .insert_task(&authority, task("task-worktree", "project-worktree"))
        .unwrap();
    store
        .begin_task_worktree_provisioning(
            &authority,
            WorktreeProvisioningOperation {
                operation_id: "provision-task-worktree".into(),
                task_id: "task-worktree".into(),
                project_id: "project-worktree".into(),
                spec: NormalizedWorktreeSpec {
                    version: 1,
                    repository_root: "/projects/project-worktree".into(),
                    repository_common_dir: "/projects/project-worktree/.git".into(),
                    destination_path: "/worktrees/task-worktree".into(),
                    branch_name: "feature/task-worktree".into(),
                    branch_mode: ProvisioningBranchMode::Create,
                    base_ref: Some("refs/heads/main".into()),
                    base_oid: Some("a".repeat(40)),
                },
                stage: ProvisioningStage::Reserved,
                created_branch_ref: false,
                failure: None,
                started_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    assert!(matches!(
        store.delete_project_and_related_records(&authority, "project-worktree"),
        Err(StoreError::ProjectHasWorktrees)
    ));

    store
        .insert_task(&authority, task("task-cascade", "project-cascade"))
        .unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "running-session".into(),
                project_id: "project-cascade".into(),
                name: None,
                kind: SessionKind::Terminal,
                process: ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: "/projects/project-cascade".into(),
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
    store
        .delete_project_and_related_records(&authority, "project-cascade")
        .unwrap();
    assert!(
        store
            .projects()
            .iter()
            .all(|project| project.id != "project-cascade")
    );
    assert!(
        store
            .tasks()
            .iter()
            .all(|task| task.project_id != "project-cascade")
    );
    assert!(
        store
            .sessions()
            .iter()
            .all(|session| session.project_id != "project-cascade")
    );
    let _ = std::fs::remove_file(path);
}
