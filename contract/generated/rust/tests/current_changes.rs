use termloop_contract::current::{
    METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn change_content_methods_are_full_control_only() {
    for method in [
        "task.worktreeChangeList",
        "task.worktreeDiff",
        "task.branchCommitList",
        "task.branchCommitChangeList",
        "task.branchCommitDiff",
    ] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
    }
}

#[test]
fn commit_change_shapes_are_opaque_strict_and_bounded() {
    assert!(validate_method_params(
        "task.branchCommitList",
        &serde_json::json!({ "taskId": "t1" })
    ));
    let list = serde_json::json!({
        "task_id": "t1",
        "observation_id": "commits-1",
        "branch_id": "primary",
        "branch_name": "feature/task",
        "branch_role": "primary",
        "held_by_task_id": null,
        "base_ref": "refs/remotes/origin/main",
        "base_oid": null,
        "base_evidence": null,
        "commits": [{
            "commit_id": "commit-0",
            "branch_id": "primary",
            "branch_name": "feature/task",
            "short_oid": "0123456789ab",
            "subject": "bounded commit",
            "subject_encoding": "utf8",
            "authored_at_epoch_ms": 1_000
        }],
        "truncated": false
    });
    assert!(validate_method_result("task.branchCommitList", &list));
    assert!(!validate_method_params(
        "task.branchCommitChangeList",
        &serde_json::json!({
            "taskId": "t1",
            "observationId": "commits-1",
            "commitId": "commit-0",
            "oid": "client-supplied"
        })
    ));
    assert!(validate_method_result(
        "task.branchCommitChangeList",
        &serde_json::json!({
            "task_id": "t1",
            "observation_id": "commits-1",
            "commit_id": "commit-0",
            "state": "available",
            "entries": [{
                "entry_id": "entry-0",
                "display_path": "src/main.rs",
                "original_display_path": null,
                "path_encoding": "utf8",
                "kind": "modified",
                "render_state": "available"
            }],
            "truncated": false
        })
    ));
}

#[test]
fn change_list_and_diff_shapes_are_strict_and_bounded() {
    assert!(validate_method_params(
        "task.worktreeChangeList",
        &serde_json::json!({ "taskId": "t1" })
    ));
    assert!(!validate_method_params(
        "task.worktreeChangeList",
        &serde_json::json!({ "taskId": "t1", "path": "client-supplied" })
    ));
    assert!(validate_method_params(
        "task.worktreeDiff",
        &serde_json::json!({
            "taskId": "t1",
            "observationId": "changes-1",
            "entryId": "entry-0"
        })
    ));
    let list = serde_json::json!({
        "task_id": "t1",
        "observation_id": "changes-1",
        "worktree_generation": 3,
        "entries": [{
            "entry_id": "entry-0",
            "display_path": "src/main.rs",
            "original_display_path": null,
            "path_encoding": "utf8",
            "side": "staged",
            "kind": "modified",
            "render_state": "available"
        }],
        "truncated": false
    });
    assert!(validate_method_result("task.worktreeChangeList", &list));
    let patch = serde_json::json!({
        "task_id": "t1",
        "observation_id": "changes-1",
        "entry_id": "entry-0",
        "state": "patch",
        "patch": "diff --git a/src/main.rs b/src/main.rs\n"
    });
    assert!(validate_method_result("task.worktreeDiff", &patch));
    let mut oversized = patch;
    oversized["patch"] = serde_json::json!("x".repeat(262_145));
    assert!(!validate_method_result("task.worktreeDiff", &oversized));
}
