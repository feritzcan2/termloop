use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_mcp_tool_params,
    validate_method_params, validate_method_result,
};

#[test]
fn routine_configuration_surface_is_strict_and_scoped() {
    for method in [
        "worker.configurationList",
        "worker.configurationCreate",
        "worker.configurationUpdate",
        "worker.configurationDelete",
        "routine.runNow",
    ] {
        assert!(METHODS.contains(&method));
    }
    assert!(READ_ONLY_METHODS.contains(&"worker.configurationList"));
    assert!(!METHODS.contains(&"worker.ready"));
    assert!(COMPANION_METHODS.contains(&"worker.configurationList"));
    assert!(!READ_ONLY_METHODS.contains(&"worker.configurationCreate"));
    assert!(!COMPANION_METHODS.contains(&"worker.configurationUpdate"));
    assert!(!METHODS.contains(&"worker.taskBoard"));
    assert!(!READ_ONLY_METHODS.contains(&"routine.runNow"));
    assert!(validate_method_params(
        "worker.configurationCreate",
        &json!({
            "projectId":"project-1", "name":"Worker 1", "agentId":"codex",
            "enabled":true,
            "model":"default", "permission":"default", "reasoning":"default",
            "pingIntervalSeconds":60,
            "workerPrompt":"", "systemPrompt":"",
            "expectedRevision":1
        })
    ));
    for method in [
        "routine.configurationList",
        "routine.configurationCreate",
        "routine.contextUpdate",
        "routine.configurationUpdate",
        "routine.configurationDelete",
    ] {
        assert!(METHODS.contains(&method));
    }
    assert!(READ_ONLY_METHODS.contains(&"routine.configurationList"));
    assert!(COMPANION_METHODS.contains(&"routine.configurationList"));
    assert!(!READ_ONLY_METHODS.contains(&"routine.configurationCreate"));
    assert!(!COMPANION_METHODS.contains(&"routine.configurationUpdate"));
    assert!(validate_method_params(
        "routine.configurationCreate",
        &json!({
            "projectId":"project-1", "kind":"slack", "triggerMode":"schedule",
            "name":"Slack actions",
            "workerId":"worker-1", "scheduleIntervalSeconds":300,
            "actionHandling":"off",
            "expectedRevision":1
        })
    ));
    assert!(!validate_method_params(
        "routine.configurationCreate",
        &json!({
            "projectId":"project-1", "kind":"slack", "triggerMode":"schedule",
            "name":"Slack actions",
            "workerId":"worker-1", "agentId":"codex", "scheduleIntervalSeconds":300,
            "actionHandling":"off",
            "expectedRevision":1
        })
    ));
}

#[test]
fn routine_configuration_result_is_current_field_bounded_and_not_count_limited() {
    assert!(validate_method_result(
        "worker.configurationList",
        &json!({
            "configurations":[{
                "id":"worker-1", "projectId":"project-1", "name":"Worker 1",
                "agentId":"codex", "model":"gpt-5.6-sol",
                "permission":"bypassPermissions", "reasoning":"high", "enabled":true,
                "pingIntervalSeconds":60,
                "workerPrompt":"Handle Slack Routines.",
                "systemPrompt":"Answer briefly.",
                "executorSessionId":"session-1", "generation":2,
                "updatedAtEpochMs":1
            }],
            "promptContexts":[{
                "workerId":"worker-1",
                "initialPrompt":"Activate the persistent Worker.",
                "instructionsPrompt":"Protected runtime. Handle Slack Routines. Answer briefly.",
                "instructionDelivery":"codexDeveloperInstructions",
                "protectedPrompt":"Protected runtime.",
                "wakePrompt":"Claim the next due Routine."
            }],
            "stateRevision":2
        })
    ));
    let configurations = (0..20)
        .map(|index| {
            json!({
                "id":format!("routine-{index}"), "projectId":"project-1", "kind":"slack",
                "triggerMode":"schedule",
                "name":format!("Slack actions {index}"), "workerId":"worker-1", "enabled":false,
                "scheduleIntervalSeconds":300,
                "prompt":"Visible Slack assignment instructions", "generation":1,
                "stewardInstructions":"Propose creating a Task for a new blocking follow-up.",
                "contextMarkdown":"", "contextRevision":1,
                "recentSourceKeys":[], "relatedTaskIds":[],
                "actionHandling":"off", "pendingRoutineFindings":[],
                "lastCheckStartedAtEpochMs":null,
                "lastAttemptAtEpochMs":null,
                "lastSuccessfulReportAtEpochMs":null, "updatedAtEpochMs":1
            })
        })
        .collect::<Vec<_>>();
    assert!(validate_method_result(
        "routine.configurationList",
        &json!({
            "configurations":configurations,
            "stateRevision":2
        })
    ));
    assert!(validate_method_params(
        "routine.configurationUpdate",
        &json!({
            "routineId":"routine-1", "triggerMode":"schedule", "name":"Slack actions",
            "prompt":"Use the Slack connector to inspect #product and report to the Steward.",
            "stewardInstructions":"Propose a response only for a blocking follow-up.",
            "workerId":"worker-1", "enabled":true,
            "scheduleIntervalSeconds":300, "actionHandling":"ask",
            "expectedRevision":2
        })
    ));
}

#[test]
fn routine_reports_are_natural_language_bounded_and_not_client_attributed() {
    assert!(READ_ONLY_METHODS.contains(&"routine.runtimeList"));
    assert!(COMPANION_METHODS.contains(&"routine.runtimeList"));
    assert!(!METHODS.contains(&"steward.report"));
    assert!(!validate_mcp_tool_params(
        "worker_complete_routine",
        &json!({
            "checkId":"check-1", "kind":"success",
            "message":"A current Task likely needs attention.",
            "sourceReferences":["slack://channel/message"]
        })
    ));
    assert!(validate_mcp_tool_params(
        "worker_complete_routine",
        &json!({
            "checkId":"check-1",
            "expectedContextRevision":1,
            "contextMarkdown":"# Slack\nLast scan complete.",
            "updateSummary":"The recurring scan completed with no additional findings.",
            "findings":[{
                "sourceKey":"slack:C123:1700.001",
                "summary":"A current Task likely needs attention.",
                "evidence":"The inspected message has no visible response.",
                "sourceReferences":["slack://channel/message"],
                "relatedTaskIds":[]
            }],
            "relatedTaskIds":[]
        })
    ));
    assert!(!validate_mcp_tool_params(
        "worker_complete_routine",
        &json!({
            "checkId":"check-1",
            "expectedContextRevision":1,
            "contextMarkdown":"# Slack\nLast scan complete.",
            "updateSummary":"",
            "findings":[],
            "relatedTaskIds":[]
        })
    ));
    assert!(validate_mcp_tool_params(
        "worker_report_routine_problem",
        &json!({
            "checkId":"check-1",
            "message":"Replace #replace-with-channel before enabling this Task.",
            "sourceReferences":[]
        })
    ));
    assert!(!validate_mcp_tool_params(
        "worker_report_routine_problem",
        &json!({
            "checkId":"check-1", "kind":"warning", "message":"unsupported kind",
            "sourceReferences":[]
        })
    ));
    assert!(!validate_mcp_tool_params(
        "worker_report_routine_problem",
        &json!({
            "projectId":"project-1", "routineId":"routine-1", "generation":1,
            "checkId":"check-1", "message":"spoof", "sourceReferences":[]
        })
    ));

    assert!(validate_method_result(
        "routine.runtimeList",
        &json!({
            "health":[{
                "routineId":"routine-1", "generation":1,
                "kind":"slack", "name":"Slack triage",
                "contextMarkdown":"# Slack\nLast scan complete.",
                "contextRevision":1, "relatedTaskIds":[], "state":"attention",
                "checkId":null, "deadlineEpochMs":null, "pingSent":false,
                "pendingTrigger":false,
                "attentionMessage":"Slack access is unavailable.",
                "lastAttemptAtEpochMs":10,
                "nextDueAtEpochMs":300010,
                "lastSuccessfulReportAtEpochMs":null
            }],
            "reports":[{
                "id":"report-1", "projectId":"project-1", "routineId":"routine-1",
                "checkId":"check-1", "generation":1, "kind":"problem",
                "message":"Slack access is unavailable.", "sourceReferences":[],
                "relatedTaskIds":[],
                "createdAtEpochMs":10
            }],
            "reportsTruncated":false,
            "stateRevision":2
        })
    ));
    let health = (0..20)
        .map(|index| {
            json!({
                "routineId":format!("routine-{index}"), "generation":1,
                "kind":"custom", "name":format!("Check {index}"),
                "contextMarkdown":"", "contextRevision":1,
                "relatedTaskIds":[], "state":"idle", "checkId":null,
                "deadlineEpochMs":null, "pingSent":false,
                "pendingTrigger":false, "attentionMessage":null,
                "lastAttemptAtEpochMs":null, "nextDueAtEpochMs":300010,
                "lastSuccessfulReportAtEpochMs":null
            })
        })
        .collect::<Vec<_>>();
    assert!(validate_method_result(
        "routine.runtimeList",
        &json!({
            "health":health,
            "reports":[],
            "reportsTruncated":false,
            "stateRevision":2
        })
    ));
    assert!(validate_method_params(
        "routine.runNow",
        &json!({ "routineId":"routine-1" })
    ));
    assert!(validate_method_params(
        "routine.runNow",
        &json!({ "routineId":"routine-1", "taskId":"task-1" })
    ));
    assert!(!validate_method_params(
        "routine.runNow",
        &json!({ "routineId":"routine-1", "taskId":"" })
    ));
}
