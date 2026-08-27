use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, MCP_STEWARD_TOOLS, MCP_TOOL_DEFINITIONS_JSON, METHODS, READ_ONLY_METHODS,
    validate_mcp_tool_params, validate_mcp_tool_result,
};

#[test]
fn steward_task_authority_is_mcp_only_named_and_not_companion_scoped() {
    for retired in [
        "steward.taskCreateConfirmationGet",
        "steward.taskCreateResolve",
        "steward.taskCreateRequest",
    ] {
        assert!(!METHODS.contains(&retired));
        assert!(!READ_ONLY_METHODS.contains(&retired));
        assert!(!COMPANION_METHODS.contains(&retired));
    }
    for tool in [
        "task_agent_start",
        "task_create",
        "task_rename",
        "task_update_brief",
        "task_set_jira_url",
        "task_close",
        "task_reopen",
        "task_delete",
        "agent_message_send",
    ] {
        assert!(MCP_STEWARD_TOOLS.contains(&tool));
        assert!(!METHODS.contains(&tool));
    }
    let definitions: serde_json::Value = serde_json::from_str(MCP_TOOL_DEFINITIONS_JSON).unwrap();
    let jira_tool = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "task_set_jira_url")
        .unwrap();
    assert!(
        jira_tool["description"]
            .as_str()
            .is_some_and(|description| description.contains("before starting its Agent"))
    );
    assert!(validate_mcp_tool_params(
        "task_create",
        &json!({"title":"Investigate OAuth"})
    ));
    assert!(!validate_mcp_tool_params(
        "task_create",
        &json!({"projectId":"project-1","title":"Investigate OAuth"})
    ));
    assert!(validate_mcp_tool_result(
        "task_create",
        &json!({"taskId":"task-1","status":"created"})
    ));
    assert!(validate_mcp_tool_params(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "assignment":"Investigate and fix the callback.",
            "baseBranch":"main"
        })
    ));
    assert!(!validate_mcp_tool_params(
        "task_agent_start",
        &json!({
            "projectId":"project-1",
            "taskId":"task-1",
            "assignment":"Investigate."
        })
    ));
    assert!(validate_mcp_tool_params(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "agentId":"codex",
            "assignment":"Investigate."
        })
    ));
    assert!(!validate_mcp_tool_params(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "agentId":"codex",
            "permission":"bypassPermissions",
            "assignment":"Investigate."
        })
    ));
    assert!(validate_mcp_tool_result(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "sessionId":"session-1",
            "branchName":"termloop/task-task1",
            "worktreePath":"/project-task_worktree",
            "agentId":"codex",
            "model":"gpt-5.6-sol",
            "permission":"bypassPermissions",
            "reasoning":"high",
            "assignmentDelivered":true,
            "reusedSession":false,
            "status":"ready"
        })
    ));
    assert!(validate_mcp_tool_params(
        "agent_message_send",
        &json!({"sessionId":"session-1","message":"Please investigate."})
    ));
    assert!(validate_mcp_tool_params(
        "task_set_jira_url",
        &json!({
            "taskId":"task-1",
            "jiraUrl":"https://example.atlassian.net/browse/TERM-42/"
        })
    ));
    assert!(!validate_mcp_tool_params(
        "task_set_jira_url",
        &json!({"taskId":"task-1","jiraUrl":"TERM-42"})
    ));
    assert!(validate_mcp_tool_result(
        "task_set_jira_url",
        &json!({
            "taskId":"task-1",
            "jiraUrl":"https://example.atlassian.net/browse/TERM-42",
            "status":"linked"
        })
    ));
    assert!(!validate_mcp_tool_result(
        "task_set_jira_url",
        &json!({
            "taskId":"task-1",
            "jiraUrl":"https://example.atlassian.net/browse/TERM-42/",
            "status":"linked"
        })
    ));
}

#[test]
fn destructive_and_update_results_are_exact() {
    assert!(validate_mcp_tool_result(
        "task_delete",
        &json!({"taskId":"task-1","status":"deleted"})
    ));
    assert!(!validate_mcp_tool_result(
        "task_delete",
        &json!({"taskId":"task-1","status":"closed"})
    ));
    assert!(!validate_mcp_tool_result(
        "task_update_brief",
        &json!({"taskId":"task-1","status":"updated","history":[]})
    ));
}
