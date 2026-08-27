use termloop_contract::current::{
    CONTRACT_IDENTITY, ProtocolError, READ_ONLY_METHODS, TaskRepairWorktreeResult,
    TaskWorktreeRepairPreviewDto, validate_method_params,
};

#[test]
fn repair_surface_is_generated_and_exact() {
    assert!(CONTRACT_IDENTITY.starts_with("sha256:"));
    assert_eq!(CONTRACT_IDENTITY.len(), 71);
    assert!(!READ_ONLY_METHODS.contains(&"task.inspectWorktreeRepair"));
    assert!(validate_method_params(
        "task.inspectWorktreeRepair",
        &serde_json::json!({"taskId":"t1","candidatePath":"/repo-moved"})
    ));
    assert!(validate_method_params(
        "task.repairWorktree",
        &serde_json::json!({
            "operationId":"repair-1","taskId":"t1","candidatePath":"/repo-moved",
            "expectedManagedWorktreeOperationId":"provision-1","expectedWorktreeGeneration":2
        })
    ));
    assert!(!validate_method_params(
        "task.repairWorktree",
        &serde_json::json!({
            "operationId":"repair-1","taskId":"t1","candidatePath":"/repo-moved",
            "expectedManagedWorktreeOperationId":"provision-1","expectedWorktreeGeneration":2,"force":true
        })
    ));
    let _: TaskWorktreeRepairPreviewDto = serde_json::from_value(serde_json::json!({
        "task_id":"t1","managed_worktree_operation_id":"provision-1","worktree_generation":2,
        "current_path":"/repo-old","candidate_path":"/repo-moved","decision":"allowed","blockers":[],
        "attached_session_ids":[],"observed_at_epoch_ms":1
    })).unwrap();
}

#[test]
fn repair_results_and_errors_keep_recovery_details() {
    let result = serde_json::json!({
        "task":{"id":"t1","project_id":"p1","title":"Task","brief":null,"jira_url":null,"status":"open","archived_at_epoch_ms":null,"branch":null,"worktree":null,"rank":0,"created_at_epoch_ms":1,"updated_at_epoch_ms":1},
        "previous_worktree_generation":2,"worktree_generation":3,"outcome":"repaired","repair":null
    });
    assert!(serde_json::from_value::<TaskRepairWorktreeResult>(result).is_ok());
    let error = serde_json::json!({"code":"conflict","message":"opaque","details":{"kind":"worktreeRepairRecoveryAttention","taskId":"t1","operationId":"repair-1"}});
    assert!(serde_json::from_value::<ProtocolError>(error).is_ok());
}
