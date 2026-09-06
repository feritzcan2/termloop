use serde_json::json;
use termloop_contract::current::{
    MCP_HELPER_TOOLS, MCP_IMPROVER_TOOLS, MCP_INTERACTIVE_TOOLS, MCP_STEWARD_TOOLS,
    MCP_TOOL_DEFINITIONS_JSON, MCP_TOOLS, METHODS, McpToolError,
    validate_mcp_tool_params, validate_mcp_tool_result,
};

#[test]
fn role_profile_tools_are_generated_bounded_and_not_control_methods() {
    assert_eq!(MCP_INTERACTIVE_TOOLS, ["ask_to", "send_to_agent"]);
    assert_eq!(
        MCP_IMPROVER_TOOLS,
        [
            "ask_to",
            "send_to_agent",
            "configuration_version_read",
            "configuration_version_write"
        ]
    );
    assert!(MCP_STEWARD_TOOLS.contains(&"task_create"));
    assert!(MCP_STEWARD_TOOLS.contains(&"send_to_agent"));
    assert!(MCP_STEWARD_TOOLS.contains(&"task_set_jira_url"));
    assert!(MCP_STEWARD_TOOLS.contains(&"steward_system_prompt_read"));
    assert!(MCP_STEWARD_TOOLS.contains(&"steward_system_prompt_update"));
    assert!(MCP_STEWARD_TOOLS.contains(&"steward_suggest"));
    assert!(MCP_STEWARD_TOOLS.contains(&"routine_finding_read"));
    assert!(MCP_STEWARD_TOOLS.contains(&"routine_finding_resolve"));
    assert!(!MCP_INTERACTIVE_TOOLS.contains(&"steward_system_prompt_update"));
    assert!(MCP_STEWARD_TOOLS.contains(&"steward_next_assignment"));
    assert!(MCP_STEWARD_TOOLS.contains(&"steward_complete_assignment"));
    assert!(MCP_STEWARD_TOOLS.contains(&"task_agent_transcript_tail_read"));
    assert!(MCP_STEWARD_TOOLS.contains(&"task_agent_request"));
    assert_eq!(
        MCP_HELPER_TOOLS,
        ["ask_to", "send_to_agent", "reply_to_request"]
    );
    assert!(MCP_TOOLS.iter().all(|tool| !METHODS.contains(tool)));
    let definitions: serde_json::Value = serde_json::from_str(MCP_TOOL_DEFINITIONS_JSON).unwrap();
    assert_eq!(definitions.as_array().unwrap().len(), MCP_TOOLS.len());
    assert!(
        definitions[0]["description"]
            .as_str()
            .is_some_and(|description| description.contains("never substitute"))
    );
    assert_eq!(
        definitions[0]["inputSchema"]["properties"]["message"]["maxLength"],
        32_768
    );
    assert_eq!(
        definitions[0]["inputSchema"]["properties"]["conversationId"]["maxLength"],
        128
    );
}

#[test]
fn mcp_tool_errors_are_schema_generated_and_strict() {
    let error: McpToolError = serde_json::from_value(json!({
        "code": "askToInProgress",
        "message": "pending",
        "details": { "requestId": "request-1", "status": "pending" }
    }))
    .unwrap();
    assert!(matches!(
        error.code,
        termloop_contract::current::McpToolErrorCode::AskToInProgress
    ));
    let jira_error: McpToolError = serde_json::from_value(json!({
        "code": "jiraUrlAlreadySet",
        "message": "already linked",
        "details": {
            "taskId": "task-1",
            "jiraUrl": "https://example.atlassian.net/browse/TERM-42"
        }
    }))
    .unwrap();
    assert!(matches!(
        jira_error.code,
        termloop_contract::current::McpToolErrorCode::JiraUrlAlreadySet
    ));
    let existing_agent: McpToolError = serde_json::from_value(json!({
        "code": "taskAgentStartFailed",
        "message": "use the existing Agent",
        "details": {
            "taskId": "task-1",
            "sessionId": "123e4567-e89b-42d3-a456-426614174000",
            "suggestedAction": "messageExistingAgent"
        }
    }))
    .unwrap();
    let existing_agent_details = existing_agent.details.unwrap();
    assert_eq!(
        existing_agent_details.session_id.as_deref(),
        Some("123e4567-e89b-42d3-a456-426614174000")
    );
    assert_eq!(
        existing_agent_details.suggested_action.as_deref(),
        Some("messageExistingAgent")
    );
    let pending_proposal: McpToolError = serde_json::from_value(json!({
        "code": "proposalPending",
        "message": "awaiting a decision",
        "details": { "proposalMessageId": "project-1:21" }
    }))
    .unwrap();
    assert!(matches!(
        pending_proposal.code,
        termloop_contract::current::McpToolErrorCode::ProposalPending
    ));
    assert_eq!(
        pending_proposal
            .details
            .unwrap()
            .proposal_message_id
            .as_deref(),
        Some("project-1:21")
    );
    assert!(
        serde_json::from_value::<McpToolError>(json!({
            "code": "unknown",
            "message": "nope",
            "details": null
        }))
        .is_err()
    );
}

#[test]
fn ask_to_tool_validation_is_strict_and_generated() {
    assert!(validate_mcp_tool_params(
        "ask_to",
        &json!({"target":"claude","message":"review","idempotencyKey":"retry-1","conversationId":"conversation-1"})
    ));
    assert!(!validate_mcp_tool_params(
        "ask_to",
        &json!({"target":"gemini","message":"review"})
    ));
    assert!(!validate_mcp_tool_params(
        "ask_to",
        &json!({"target":"claude","message":"review","waitSeconds":30})
    ));
    assert!(validate_mcp_tool_result(
        "ask_to",
        &json!({"requestId":"request-1","conversationId":"conversation-1","status":"completed"})
    ));
    assert!(!validate_mcp_tool_result(
        "ask_to",
        &json!({"requestId":"request-1","conversationId":"conversation-1","status":"unknown"})
    ));
    assert!(!validate_mcp_tool_result(
        "ask_to",
        &json!({"requestId":"request-1","conversationId":"conversation-1","status":"completed","message":"answers are pushed"})
    ));
}

#[test]
fn send_to_agent_requires_an_exact_session_id_and_strict_result() {
    let session_id = "123e4567-e89b-42d3-a456-426614174000";
    assert!(validate_mcp_tool_params(
        "send_to_agent",
        &json!({"sessionId":session_id,"message":"Review the current diff."})
    ));
    assert!(!validate_mcp_tool_params(
        "send_to_agent",
        &json!({"sessionId":"the first Codex","message":"review"})
    ));
    assert!(validate_mcp_tool_result(
        "send_to_agent",
        &json!({"sessionId":session_id,"status":"delivered"})
    ));
    assert!(validate_mcp_tool_result(
        "send_to_agent",
        &json!({
            "sessionId": session_id,
            "status": "failed",
            "reason": "targetAgentTurnFailed",
            "suggestedAction": "waitForUser",
            "message": "The target Agent's previous turn failed."
        })
    ));
    assert!(!validate_mcp_tool_result(
        "send_to_agent",
        &json!({"sessionId":session_id,"status":"failed"})
    ));
    assert!(!validate_mcp_tool_result(
        "send_to_agent",
        &json!({
            "sessionId": session_id,
            "status": "delivered",
            "reason": "targetAgentTurnFailed"
        })
    ));
    assert!(!validate_mcp_tool_result(
        "send_to_agent",
        &json!({"sessionId":session_id,"status":"pending"})
    ));
}

#[test]
fn steward_messages_are_typed_and_cannot_claim_actions() {
    assert!(validate_mcp_tool_params(
        "steward_suggest",
        &json!({"kind":"proposal","content":"May I start it?","refs":{"taskId":"task-1"}})
    ));
    assert!(!validate_mcp_tool_params(
        "steward_suggest",
        &json!({"content":"Untyped"})
    ));
    assert!(!validate_mcp_tool_params(
        "steward_suggest",
        &json!({"kind":"action","content":"I created it."})
    ));
}

#[test]
fn steward_task_agent_selection_is_optional_bounded_and_reported() {
    let definitions: serde_json::Value = serde_json::from_str(MCP_TOOL_DEFINITIONS_JSON).unwrap();
    let definition = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|definition| definition["name"] == "task_agent_start")
        .unwrap();
    assert!(
        definition["description"]
            .as_str()
            .is_some_and(|description| description.contains("messageExistingAgent"))
    );
    assert_eq!(
        definition["inputSchema"]["properties"]["agentId"]["enum"],
        json!(["claude", "codex"])
    );
    assert!(
        definition["inputSchema"]["properties"]["model"]["enum"]
            .as_array()
            .is_some_and(|models| models.contains(&json!("fable"))
                && models.contains(&json!("opus"))
                && models.contains(&json!("gpt-5.6-sol")))
    );
    assert!(validate_mcp_tool_params(
        "task_agent_start",
        &json!({"taskId":"task-1","assignment":"Implement it."})
    ));
    assert!(validate_mcp_tool_params(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "assignment":"Implement it.",
            "agentId":"claude",
            "model":"fable"
        })
    ));
    assert!(validate_mcp_tool_params(
        "task_agent_start",
        &json!({"taskId":"task-1","assignment":"Implement it.","agentId":"codex"})
    ));
    // The transport keeps one simple object-shaped tool declaration for model
    // callers. Core remains the authority that rejects a model without its
    // provider or a cross-provider model at execution time.
    assert!(validate_mcp_tool_params(
        "task_agent_start",
        &json!({"taskId":"task-1","assignment":"Implement it.","model":"fable"})
    ));
    assert!(validate_mcp_tool_params(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "assignment":"Implement it.",
            "agentId":"codex",
            "model":"opus"
        })
    ));
    assert!(validate_mcp_tool_result(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "sessionId":"session-1",
            "branchName":"termloop/task-1",
            "worktreePath":"/tmp/task-1",
            "agentId":"claude",
            "model":"opus",
            "permission":"default",
            "reasoning":"default",
            "assignmentDelivered":true,
            "reusedSession":false,
            "status":"ready"
        })
    ));
    assert!(!validate_mcp_tool_result(
        "task_agent_start",
        &json!({
            "taskId":"task-1",
            "sessionId":"session-1",
            "branchName":"termloop/task-1",
            "worktreePath":"/tmp/task-1",
            "agentId":"codex",
            "model":"opus",
            "permission":"default",
            "reasoning":"default",
            "assignmentDelivered":true,
            "reusedSession":false,
            "status":"ready"
        })
    ));
}

#[test]
fn steward_system_prompt_update_requires_exact_user_message_provenance() {
    assert!(validate_mcp_tool_params(
        "steward_system_prompt_update",
        &json!({
            "userMessageId": "project-1:7",
            "expectedSystemPrompt": "Preserve existing guidance.",
            "systemPrompt": "Be concise and preserve the Project Manager role."
        })
    ));
    assert!(validate_mcp_tool_params(
        "steward_system_prompt_update",
        &json!({
            "userMessageId": "project-1:8",
            "expectedSystemPrompt": "Preserve existing guidance.",
            "systemPrompt": ""
        })
    ));
    assert!(!validate_mcp_tool_params(
        "steward_system_prompt_update",
        &json!({
            "expectedSystemPrompt": "Preserve existing guidance.",
            "systemPrompt": "Missing provenance"
        })
    ));
    assert!(!validate_mcp_tool_params(
        "steward_system_prompt_update",
        &json!({
            "userMessageId": "project-1:7",
            "expectedSystemPrompt": "Preserve existing guidance.",
            "systemPrompt": "",
            "projectId": "project-2"
        })
    ));
    assert!(!validate_mcp_tool_params(
        "steward_system_prompt_update",
        &json!({
            "userMessageId": "project-1:7",
            "systemPrompt": "Missing exact source document."
        })
    ));
    assert!(validate_mcp_tool_result(
        "steward_system_prompt_update",
        &json!({"status": "restarting"})
    ));
    assert!(validate_mcp_tool_result(
        "steward_system_prompt_update",
        &json!({"status": "unchanged"})
    ));
}
