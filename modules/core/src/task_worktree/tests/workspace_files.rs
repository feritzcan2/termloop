use super::*;

#[test]
fn workspace_files_use_the_exact_task_root_and_reject_cross_project_selection() {
    let mut fixture = Fixture::new();
    let unbound = fixture.create_task("No worktree", Value::Null);
    assert!(matches!(
        fixture
            .runtime
            .plan_workspace_files(&fixture.project_id, unbound["id"].as_str(), ""),
        Err(CoreError::TaskWorktreeRequired { .. })
    ));
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    std::fs::write(destination.join("task-only.txt"), "Task checkout").unwrap();
    let plan = fixture
        .runtime
        .plan_workspace_files(&fixture.project_id, Some(&task_id), "task-only.txt")
        .unwrap();
    let read = fixture
        .runtime
        .complete_workspace_files(plan.observe_file())
        .unwrap();
    assert_eq!(read["content"], "Task checkout");
    let other = fixture
        .runtime
        .create_project(json!({"name":"other", "folderPath":fixture.fixture_root}))
        .unwrap();
    assert!(matches!(
        fixture
            .runtime
            .plan_workspace_files(other["id"].as_str().unwrap(), Some(&task_id), ""),
        Err(CoreError::NotFound)
    ));
    let stale = fixture
        .runtime
        .plan_workspace_files(&fixture.project_id, Some(&task_id), "")
        .unwrap()
        .observe_directory();
    let proof = fixture.runtime.store.managed_worktrees()[0].clone();
    std::fs::remove_file(destination.join("task-only.txt")).unwrap();
    fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof.operation_id,
            proof.worktree_generation,
        ))
        .unwrap();
    assert!(fixture.runtime.complete_workspace_files(stale).is_err());
}
