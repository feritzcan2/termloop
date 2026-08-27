use termloop_contract::current::{
    METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn branch_commit_summary_is_bounded_and_full_control_only() {
    assert!(METHODS.contains(&"task.branchCommitSummaryList"));
    assert!(!READ_ONLY_METHODS.contains(&"task.branchCommitSummaryList"));
    assert!(validate_method_params(
        "task.branchCommitSummaryList",
        &serde_json::json!({ "projectId": "project-1", "taskIds": ["task-1"] })
    ));
    assert!(!validate_method_params(
        "task.branchCommitSummaryList",
        &serde_json::json!({ "projectId": "project-1", "taskIds": ["task-1", "task-1"] })
    ));
    assert!(!validate_method_params(
        "task.branchCommitSummaryList",
        &serde_json::json!({ "projectId": "project-1", "taskIds": [] })
    ));
}

#[test]
fn branch_commit_summary_result_is_strict_and_typed() {
    let available = serde_json::json!([{
        "task_id": "task-1",
        "count": 6,
        "base_ref": "refs/remotes/origin/main",
        "not_in_base": {
            "count": 2,
            "base_ref": "refs/remotes/origin/main",
            "freshness": "fresh",
            "reason": null
        },
        "freshness": "fresh",
        "reason": null
    }]);
    assert!(validate_method_result(
        "task.branchCommitSummaryList",
        &available
    ));
    let unavailable = serde_json::json!([{
        "task_id": "task-2",
        "count": null,
        "base_ref": null,
        "not_in_base": {
            "count": null,
            "base_ref": null,
            "freshness": "unavailable",
            "reason": "ambiguousRemote"
        },
        "freshness": "unavailable",
        "reason": "ambiguousRemote"
    }]);
    assert!(validate_method_result(
        "task.branchCommitSummaryList",
        &unavailable
    ));
    let mut timestamped = available;
    timestamped[0]["observed_at_epoch_ms"] = serde_json::json!(1);
    assert!(!validate_method_result(
        "task.branchCommitSummaryList",
        &timestamped
    ));
}
