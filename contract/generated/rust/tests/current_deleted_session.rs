use termloop_contract::current::{
    METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

fn session() -> serde_json::Value {
    serde_json::json!({
        "id": "session-1",
        "project_id": "project-1",
        "name": "Recover me",
        "kind": "Agent",
        "process": {
            "program": "codex",
            "args": [],
            "cwd": "/project",
            "agent_id": "codex",
            "template_ref": "builtin.agent.interactive",
            "template_version": 1
        },
        "lifecycle_state": "exited",
        "runtime_epoch": 3,
        "archived_at_epoch_ms": null,
        "resume_failure_reason": null,
        "retryable": true,
        "closable": true,
        "forkable": true,
        "ask_to_source_session_id": null,
        "run_configuration_id": null
    })
}

#[test]
fn deleted_agent_methods_are_schema_first_and_read_authority_is_narrow() {
    assert!(METHODS.contains(&"session.listDeleted"));
    assert!(METHODS.contains(&"session.restoreDeleted"));
    assert!(!READ_ONLY_METHODS.contains(&"session.listDeleted"));
    assert!(!READ_ONLY_METHODS.contains(&"session.restoreDeleted"));
    assert!(validate_method_params(
        "session.listDeleted",
        &serde_json::json!({ "projectId": "project-1" })
    ));
    assert!(validate_method_params(
        "session.restoreDeleted",
        &serde_json::json!({ "sessionId": "session-1" })
    ));

    assert!(validate_method_result(
        "session.listDeleted",
        &serde_json::json!([{
            "session": session(),
            "deleted_at_epoch_ms": 100,
            "purge_at_epoch_ms": 2_592_000_100_u64,
            "source_available": true,
            "restore_blocker": null
        }])
    ));
    assert!(validate_method_result(
        "session.restoreDeleted",
        &session()
    ));
}
