use super::*;

#[test]
fn helper_and_fork_observations_expose_their_exact_scope_but_previews_do_not_repeat_it() {
    let root = std::env::temp_dir().join(format!("termloop-launch-observation-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut core =
        CoreRuntime::open(root.join("state.json"), TerminalService::default(), 1).unwrap();
    let project = core
        .handle(
            "project.create",
            json!({"name": "Launch", "folderPath": root}),
        )
        .unwrap();
    let project_id = project["id"].as_str().unwrap();
    let mut plan = core
        .plan_agent_launch(json!({"projectId": project_id, "cwd": root, "agentId": "claude"}))
        .unwrap();
    assert!(plan.launch_observation_scope().is_none());

    plan.task_guard = Some(TaskLaunchGuard {
        task_id: "task".into(),
        managed_worktree_operation_id: "operation".into(),
        worktree_generation: 1,
        cwd: plan.cwd.clone(),
        repository_common_dir: "repository".into(),
        branch_ref: "refs/heads/task".into(),
    });
    plan.task_guard_requires_observation = true;
    assert_eq!(plan.launch_observation_scope(), Some(("task", project_id)));

    // An ordinary preview already owns its observation. Execution must only
    // revalidate the durable tuple, without repeating preview or consuming a slot.
    plan.task_guard_requires_observation = false;
    assert!(plan.launch_observation_scope().is_none());

    plan.fork_worktree_plan = Some(TaskWorktreeLaunchPlan {
        task_id: "task".into(),
        project_id: project_id.into(),
        cwd: plan.cwd.clone(),
        managed_worktree_operation_id: "operation".into(),
        worktree_generation: 1,
        repository_common_dir: "repository".into(),
        branch_ref: "refs/heads/task".into(),
        agent_id: Some("claude".into()),
        interactive_options: None,
    });
    assert_eq!(plan.launch_observation_scope(), Some(("task", project_id)));
    drop(plan);
    drop(core);
    std::fs::remove_dir_all(root).unwrap();
}
