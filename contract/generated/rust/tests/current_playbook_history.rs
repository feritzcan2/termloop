use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn fork_history_is_a_bounded_full_control_project_read() {
    let method = "playbook.evaluationHistory";
    assert!(METHODS.contains(&method));
    assert!(!READ_ONLY_METHODS.contains(&method));
    assert!(!COMPANION_METHODS.contains(&method));
    assert!(validate_method_params(method, &json!({"projectId": "project-a"})));
    assert!(!validate_method_params(method, &json!({})));
    assert!(!validate_method_params(method, &json!({"projectId": "project-a", "sessionId": "source"})));
    let entry = json!({
        "id": "check", "projectId": "project-a", "taskId": "task-a", "taskTitle": "Search fix",
        "milestoneId": "verified", "milestoneTitle": "Dev verified",
        "sourceSessionId": "source", "sourceName": "Implementer", "sessionId": "fork",
        "agentId": "codex", "model": "gpt-6-luna", "permission": "plan",
        "startedAtEpochMs": 1, "finishedAtEpochMs": 2, "outcome": "passed", "evidence": "Verified."
    });
    let mut result = json!({"entries": [entry], "retentionLimit": 200, "stateRevision": 4});
    assert!(validate_method_result(method, &result));
    for outcome in ["inProgress", "passed", "waiting", "blocked", "failed", "interrupted"] {
        result["entries"][0]["outcome"] = json!(outcome);
        assert!(validate_method_result(method, &result));
    }
    result["entries"][0]["outcome"] = json!("unknown");
    assert!(!validate_method_result(method, &result));
    result["entries"][0] = entry.clone();
    result["entries"][0]["evidence"] = json!("ş".repeat(301));
    assert!(!validate_method_result(method, &result));
    result["entries"][0] = entry.clone();
    result["entries"][0]["nativeConversationId"] = json!("private");
    assert!(!validate_method_result(method, &result));
    result["entries"] = json!(vec![entry; 201]);
    assert!(!validate_method_result(method, &result));
}
