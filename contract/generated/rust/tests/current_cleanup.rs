use termloop_contract::current::{
    CONTRACT_IDENTITY, TaskWorktreeCleanupPreviewDto, validate_method_params,
};

#[test]
fn destructive_cleanup_contract_is_strict() {
    assert!(CONTRACT_IDENTITY.starts_with("sha256:"));
    let base = serde_json::json!({
        "operationId":"cleanup-1","taskId":"task-1",
        "expectedManagedWorktreeOperationId":"proof-1","expectedWorktreeGeneration":2
    });
    assert!(!validate_method_params("task.cleanupWorktree", &base));
    assert!(validate_method_params(
        "task.cleanupWorktree",
        &serde_json::json!({
            "operationId":"cleanup-1","taskId":"task-1",
            "expectedManagedWorktreeOperationId":"proof-1","expectedWorktreeGeneration":2,
            "cleanupMode":"safe","acknowledgedContentBlockers":[]
        })
    ));
    assert!(validate_method_params(
        "task.cleanupWorktree",
        &serde_json::json!({
            "operationId":"cleanup-1","taskId":"task-1",
            "expectedManagedWorktreeOperationId":"proof-1","expectedWorktreeGeneration":2,
            "cleanupMode":"discardCheckoutContent",
            "acknowledgedContentBlockers":["ignoredContent","untrackedContent"]
        })
    ));
    assert!(!validate_method_params(
        "task.cleanupWorktree",
        &serde_json::json!({
            "operationId":"cleanup-1","taskId":"task-1",
            "expectedManagedWorktreeOperationId":"proof-1","expectedWorktreeGeneration":2,
            "cleanupMode":"discardCheckoutContent",
            "acknowledgedContentBlockers":["ignoredContent","ignoredContent"]
        })
    ));
    let stale = serde_json::json!({
        "operationId":"stale-1","taskId":"task-1",
        "expectedManagedWorktreeOperationId":"proof-1","expectedWorktreeGeneration":2,
        "targetPath":"/repo-task"
    });
    assert!(validate_method_params("task.forgetStaleWorktree", &stale));
    assert!(!validate_method_params("task.discardStaleWorktree", &stale));
    let mut acknowledged_stale = stale;
    acknowledged_stale["acknowledgeUnverifiedDirectoryDeletion"] = serde_json::json!(true);
    assert!(validate_method_params(
        "task.discardStaleWorktree",
        &acknowledged_stale
    ));
    acknowledged_stale["acknowledgeUnverifiedDirectoryDeletion"] = serde_json::json!(false);
    assert!(!validate_method_params(
        "task.discardStaleWorktree",
        &acknowledged_stale
    ));

    let preview = serde_json::json!({
        "task_id":"task-1","managed_worktree_operation_id":"proof-1",
        "worktree_generation":2,"target_path":"/repo-task","decision":"refused",
        "blockers":["ignoredContent"],"warnings":[],"health":null,"presence":null,
        "destructive_cleanup":{"status":"available","eligible_blockers":["ignoredContent"]},
        "stale_resolution":{"forget_status":"unavailable","disposal_status":"unavailable","blockers":[]}
    });
    assert!(serde_json::from_value::<TaskWorktreeCleanupPreviewDto>(preview).is_ok());
}
