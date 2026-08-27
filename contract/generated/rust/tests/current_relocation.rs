use termloop_contract::current::{METHODS, READ_ONLY_METHODS, validate_method_params};

#[test]
fn session_relocation_params_are_strict_and_full_control_only() {
    let preview = serde_json::json!({
        "sessionId": "session-1",
        "taskId": "task-1",
        "mode": "resume",
    });
    assert!(validate_method_params(
        "session.previewRelocateAgentToTask",
        &preview
    ));
    assert!(!validate_method_params(
        "session.previewRelocateAgentToTask",
        &serde_json::json!({
            "sessionId": "session-1",
            "taskId": "task-1",
            "mode": "resume",
            "cwd": "/unsafe",
        })
    ));

    let relocate = serde_json::json!({
        "sessionId": "session-1",
        "taskId": "task-1",
        "operationId": "11111111-1111-4111-8111-111111111111",
        "relocationTicket": "a".repeat(64),
    });
    assert!(validate_method_params(
        "session.relocateAgentToTask",
        &relocate
    ));
    assert!(!validate_method_params(
        "session.relocateAgentToTask",
        &serde_json::json!({
            "sessionId": "session-1",
            "taskId": "task-1",
            "operationId": "11111111-1111-4111-8111-111111111111",
            "relocationTicket": "short",
        })
    ));
    assert!(METHODS.contains(&"session.previewRelocateAgentToTask"));
    assert!(METHODS.contains(&"session.relocateAgentToTask"));
    let project_preview = serde_json::json!({
        "sessionId": "session-1",
        "projectId": "project-1",
    });
    assert!(validate_method_params(
        "session.previewRelocateAgentToProject",
        &project_preview
    ));
    let project_relocate = serde_json::json!({
        "sessionId": "session-1",
        "projectId": "project-1",
        "operationId": "11111111-1111-4111-8111-111111111111",
        "relocationTicket": "b".repeat(64),
    });
    assert!(validate_method_params(
        "session.relocateAgentToProject",
        &project_relocate
    ));
    assert!(!validate_method_params(
        "session.relocateAgentToProject",
        &serde_json::json!({
            "sessionId": "session-1",
            "projectId": "project-1",
            "taskId": "task-1",
            "operationId": "11111111-1111-4111-8111-111111111111",
            "relocationTicket": "b".repeat(64),
        })
    ));
    assert!(METHODS.contains(&"session.previewRelocateAgentToProject"));
    assert!(METHODS.contains(&"session.relocateAgentToProject"));
    assert!(!READ_ONLY_METHODS.contains(&"session.previewRelocateAgentToTask"));
    assert!(!READ_ONLY_METHODS.contains(&"session.relocateAgentToTask"));
    assert!(!READ_ONLY_METHODS.contains(&"session.previewRelocateAgentToProject"));
    assert!(!READ_ONLY_METHODS.contains(&"session.relocateAgentToProject"));
}
