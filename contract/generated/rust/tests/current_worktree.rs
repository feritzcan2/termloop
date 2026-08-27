use termloop_contract::current::{
    TaskDto, validate_event_payload, validate_method_params, validate_method_result,
};

fn task_json() -> serde_json::Value {
    serde_json::json!({
        "id": "t1",
        "project_id": "p1",
        "title": "Build API",
        "brief": null,
        "jira_url": null,
        "status": "open",
        "archived_at_epoch_ms": null,
        "branch": null,
        "worktree": null,
        "rank": 0,
        "created_at_epoch_ms": 1,
        "updated_at_epoch_ms": 1
    })
}

fn health_json() -> serde_json::Value {
    serde_json::json!({
        "observation_sequence": 9,
        "observed_at_epoch_ms": 10,
        "path_state": "present",
        "registration_state": "matching",
        "head_state": "matching",
        "launch_ready": true,
        "checked_out_branch": "main",
        "change_count": 0,
        "tracked_state": "clean",
        "staged_state": "clean",
        "untracked_state": "absent",
        "ignored_state": "absent",
        "submodule_state": "absent",
        "worktree_lock_state": "absent",
        "index_lock_state": "absent",
        "upstream_state": "inSync",
        "summary": "healthy"
    })
}

fn presence_json() -> serde_json::Value {
    serde_json::json!({
        "observation_sequence": 10,
        "observed_at_epoch_ms": 11,
        "attached_sessions": [{ "session_id": "s1", "kind": "Terminal" }],
        "total_count": 1,
        "terminal_count": 1,
        "agent_count": 0,
        "truncated": false
    })
}

#[test]
fn cleanup_contract_requires_generation_cas_and_keeps_inspection_full_control() {
    assert!(validate_method_params(
        "task.inspectWorktreeCleanup",
        &serde_json::json!({ "taskId": "t1" })
    ));
    assert!(validate_method_params(
        "task.cleanupWorktree",
        &serde_json::json!({
            "operationId": "cleanup-1",
            "taskId": "t1",
            "expectedManagedWorktreeOperationId": "provision-1",
            "expectedWorktreeGeneration": 3,
            "cleanupMode": "safe",
            "acknowledgedContentBlockers": []
        })
    ));
    assert!(!validate_method_params(
        "task.cleanupWorktree",
        &serde_json::json!({
            "operationId": "cleanup-1",
            "taskId": "t1",
            "expectedManagedWorktreeOperationId": "provision-1"
        })
    ));
    assert!(!validate_method_params(
        "task.cleanupWorktree",
        &serde_json::json!({
            "operationId": "x".repeat(65),
            "taskId": "t1",
            "expectedManagedWorktreeOperationId": "provision-1",
            "expectedWorktreeGeneration": 3,
            "cleanupMode": "safe",
            "acknowledgedContentBlockers": []
        })
    ));
}

#[test]
fn filtered_reads_subscription_demand_and_entity_scopes_enforce_bounds() {
    assert!(validate_method_params(
        "task.list",
        &serde_json::json!({ "projectId": "p1", "archiveScope": "active", "taskIds": ["t1", "t2"] })
    ));
    assert!(!validate_method_params(
        "task.list",
        &serde_json::json!({ "projectId": "p1", "taskIds": [] })
    ));
    assert!(!validate_method_params(
        "task.list",
        &serde_json::json!({ "projectId": "p1", "taskIds": ["t1", "t1"] })
    ));
    assert!(!validate_method_params(
        "task.list",
        &serde_json::json!({ "projectId": "p1", "taskIds": (0..129).map(|i| format!("t{i}")).collect::<Vec<_>>() })
    ));
    assert!(validate_method_params(
        "control.subscribe",
        &serde_json::json!({ "topics": ["task"], "projectIds": ["p1"] })
    ));
    assert!(!validate_method_params(
        "control.subscribe",
        &serde_json::json!({ "topics": ["task"], "projectIds": ["p1", "p1"] })
    ));

    let payload = serde_json::json!({
        "topics": ["task"],
        "stateRevision": 4,
        "observationSequence": 9,
        "entityScopes": [{ "topic": "task", "ids": ["t1", "t2"] }]
    });
    assert!(validate_event_payload("projection.invalidated", &payload));
    let empty_topics = serde_json::json!({
        "topics": [],
        "stateRevision": 4,
        "observationSequence": 9
    });
    assert!(!validate_event_payload(
        "projection.invalidated",
        &empty_topics
    ));
    let duplicate_topics = serde_json::json!({
        "topics": ["task", "task"],
        "stateRevision": 4,
        "observationSequence": 9
    });
    assert!(!validate_event_payload(
        "projection.invalidated",
        &duplicate_topics
    ));
    let duplicate_ids = serde_json::json!({
        "topics": ["task"],
        "stateRevision": 4,
        "observationSequence": 9,
        "entityScopes": [{ "topic": "task", "ids": ["t1", "t1"] }]
    });
    assert!(!validate_event_payload(
        "projection.invalidated",
        &duplicate_ids
    ));
    let wrong_topic = serde_json::json!({
        "topics": ["task"],
        "stateRevision": 4,
        "observationSequence": 9,
        "entityScopes": [{ "topic": "session", "ids": ["t1"] }]
    });
    assert!(!validate_event_payload(
        "projection.invalidated",
        &wrong_topic
    ));
}

#[test]
fn task_generation_is_optional_on_wire_and_never_inferred() {
    let missing: TaskDto = serde_json::from_value(task_json()).expect("optional generation");
    assert_eq!(missing.worktree_generation, None);

    let mut emitted = task_json();
    emitted["worktree_generation"] = serde_json::json!(0);
    let task: TaskDto = serde_json::from_value(emitted).expect("new daemon task");
    assert_eq!(task.worktree_generation, Some(0));
    let encoded = serde_json::to_value(task).expect("serialize task");
    assert_eq!(encoded["worktree_generation"], 0);
}

#[test]
fn cleanup_preview_and_result_round_trip_the_complete_current_shape() {
    let preview = serde_json::json!({
        "task_id": "t1",
        "managed_worktree_operation_id": "provision-1",
        "worktree_generation": 3,
        "target_path": "/tmp/worktree",
        "decision": "refused",
        "blockers": ["sessionAttached"],
        "warnings": ["upstreamAhead"],
        "health": health_json(),
        "presence": presence_json(),
        "destructive_cleanup": { "status": "unavailable", "eligible_blockers": [] },
        "stale_resolution": { "forget_status": "unavailable", "disposal_status": "unavailable", "blockers": [] }
    });
    assert!(validate_method_result(
        "task.inspectWorktreeCleanup",
        &preview
    ));
    for required in ["launch_ready", "checked_out_branch"] {
        let mut missing = preview.clone();
        missing["health"].as_object_mut().unwrap().remove(required);
        assert!(!validate_method_result(
            "task.inspectWorktreeCleanup",
            &missing
        ));
    }

    let mut task = task_json();
    task["worktree_generation"] = serde_json::json!(3);
    task["worktree_health"] = health_json();
    task["worktree_presence"] = presence_json();
    let result = serde_json::json!({
        "task": task,
        "managed_worktree_operation_id": "provision-1",
        "worktree_generation": 3,
        "outcome": "alreadyCompleted",
        "cleanup": null
    });
    assert!(validate_method_result("task.cleanupWorktree", &result));

    let mut malformed = preview;
    malformed["blockers"] = serde_json::json!(["sessionAttached", "sessionAttached"]);
    assert!(!validate_method_result(
        "task.inspectWorktreeCleanup",
        &malformed
    ));
}

#[test]
fn cleanup_error_details_preserve_typed_generation_identity() {
    let refused = serde_json::json!({
        "code": "conflict",
        "message": "cleanup refused",
        "details": {
            "kind": "worktreeCleanupRefused",
            "taskId": "t1",
            "expectedManagedWorktreeOperationId": "provision-1",
            "expectedWorktreeGeneration": 3,
            "blockers": ["ignoredContent", "indexLock"]
        }
    });
    assert!(serde_json::from_value::<termloop_contract::current::ProtocolError>(refused).is_ok());

    let changed = serde_json::json!({
        "code": "conflict",
        "message": "proof changed",
        "details": {
            "kind": "managedWorktreeProofChanged",
            "taskId": "t1",
            "expectedManagedWorktreeOperationId": "provision-1",
            "expectedWorktreeGeneration": 3,
            "currentManagedWorktreeOperationId": null,
            "currentWorktreeGeneration": 4
        }
    });
    assert!(serde_json::from_value::<termloop_contract::current::ProtocolError>(changed).is_ok());
}
