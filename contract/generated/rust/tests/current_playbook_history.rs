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

#[test]
fn a_task_timeline_is_a_bounded_full_control_read_of_one_task() {
    let method = "playbook.taskTimeline";
    assert!(METHODS.contains(&method));
    assert!(!READ_ONLY_METHODS.contains(&method));
    assert!(!COMPANION_METHODS.contains(&method));
    assert!(validate_method_params(method, &json!({"projectId": "p", "taskId": "t"})));
    assert!(!validate_method_params(method, &json!({"projectId": "p"})));
    let evaluation = json!({
        "id": "check", "projectId": "p", "taskId": "t", "taskTitle": "Fix",
        "milestoneId": "review", "milestoneTitle": "Review",
        "sourceSessionId": null, "sourceName": null, "sessionId": "fork",
        "agentId": "claude", "model": "default", "permission": "plan",
        "startedAtEpochMs": 1, "finishedAtEpochMs": 2, "outcome": "rewound", "evidence": "New PR.",
        "agentReport": {"status": "reached", "evidence": "Opened PR #4.", "reportedAtEpochMs": 1},
        "criteria": [{"criterion": "PR open", "status": "met", "evidence": "PR #5."}],
        "pullRequestNumber": 5,
        "rewoundTo": {"milestoneId": "build", "title": "Build"}
    });
    let mut result = json!({"taskId": "t", "truncated": false, "stateRevision": 3, "entries": [
        {"kind": "evaluation", "atEpochMs": 2, "milestoneId": "review", "milestoneTitle": "Review", "evaluation": evaluation},
        {"kind": "decision", "atEpochMs": 3, "milestoneId": "build", "milestoneTitle": null,
         "decision": {"verdict": "passed", "evaluator": "user", "evidence": "Set manually.", "pullRequestNumber": null}},
        {"kind": "agentReport", "atEpochMs": 4, "milestoneId": "review", "milestoneTitle": "Review",
         "agentReport": {"sessionId": "agent", "status": "blocked", "evidence": "Needs access."}},
        {"kind": "steward", "atEpochMs": 5, "milestoneId": null, "milestoneTitle": null,
         "steward": {"messageId": "m", "messageKind": "action", "content": "Handled finding."}}
    ]});
    assert!(validate_method_result(method, &result));
    result["entries"][0]["evaluation"]["criteria"][0]["status"] = json!("maybe");
    assert!(!validate_method_result(method, &result));
    result["entries"][0]["evaluation"]["criteria"] = json!(vec![json!({"criterion": "c", "status": "met", "evidence": "e"}); 13]);
    assert!(!validate_method_result(method, &result));
    result["entries"][0]["evaluation"]["criteria"] = json!([]);
    result["entries"][3]["steward"]["content"] = json!("x".repeat(2001));
    assert!(!validate_method_result(method, &result));
    result["entries"][3]["steward"]["content"] = json!("ok");
    let entry = result["entries"][3].clone();
    result["entries"] = json!(vec![entry; 101]);
    assert!(!validate_method_result(method, &result));
}
