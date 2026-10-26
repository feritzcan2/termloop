//! The loopback MCP endpoint PM agents call. Each agent authenticates with
//! its own bearer; the bearer alone decides the project, mode, and ticket a
//! tool call acts for.

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use termloop_pm::agent::{
    PM_BOARD_READ, PM_CHECK_REPORT, PM_ENVIRONMENTS_PROPOSE, PM_HOST_TOOLS, PM_OWNER_EVIDENCE_READ,
    PM_RISKS_READ, PM_SKILL_DISCOVERY_READ, PM_SKILL_DRAFT_SUBMIT, PM_SKILL_RUN_FINISH,
    PM_SKILL_TOOL_VERIFY, PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ, PM_TICKET_SUGGEST,
    PmToolError, call_pm_tool, pm_tool_access, pm_tool_definitions,
};
use termloop_pm::skill::SkillEvent;
use termloop_pm_contract::pm::EventName;

use crate::app::{AppState, agents, skills};

pub(crate) const MAX_MCP_BODY_BYTES: usize = 256 * 1024;
const MCP_PROTOCOLS: &[&str] = &["2025-06-18", "2025-11-25"];
const MCP_PROTOCOL_HEADER: &str = "mcp-protocol-version";
const SERVER_NAME: &str = "termloop-pm";
const INSTRUCTIONS: &str = "TermLoop PM tools. They read the PM board and record proposals, \
    a delivery check report, or skill drafts and run reports for the project this session was \
    launched for; none writes Jira or any external system.";

pub(super) async fn mcp_get(headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

pub(super) async fn mcp_delete(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match bearer_token(&headers).and_then(|token| state.agents.tool_context(token)) {
        Some(_) => StatusCode::NO_CONTENT.into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

pub(super) async fn mcp_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if body.len() > MAX_MCP_BODY_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Some(bearer) = bearer_token(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return rpc(json_rpc_error(Value::Null, -32700, "parse error"));
    };
    let protocol_header = supported_protocol_header(&headers);
    match handle_message(&state, bearer, &message, protocol_header).await {
        Err(status) => status.into_response(),
        Ok(None) => StatusCode::ACCEPTED.into_response(),
        Ok(Some(reply)) => rpc(reply),
    }
}

fn rpc(reply: Value) -> Response {
    (StatusCode::OK, Json(reply)).into_response()
}

/// Handles one JSON-RPC message from the agent holding `bearer`. A
/// notification gets no reply.
pub(crate) async fn handle_message(
    state: &AppState,
    bearer: &str,
    message: &Value,
    protocol_header: bool,
) -> Result<Option<Value>, StatusCode> {
    let Some((context, check_id)) = state.agents.tool_context(bearer) else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let Some(object) = message.as_object() else {
        return Ok(Some(json_rpc_error(Value::Null, -32600, "invalid request")));
    };
    let id = object.get("id").cloned();
    let method = object.get("method").and_then(Value::as_str);
    let valid = object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && method.is_some_and(|method| !method.is_empty())
        && id
            .as_ref()
            .is_none_or(|id| id.is_null() || id.is_string() || id.is_number());
    if !valid {
        return Ok(Some(json_rpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "invalid request",
        )));
    }
    let Some(id) = id else {
        return Ok(None);
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    let reply = match method.unwrap_or_default() {
        "initialize" => initialize(id, &params),
        "server/discover" => json_rpc_error(id, -32601, "method not found"),
        _ if !protocol_header => {
            json_rpc_error(id, -32600, "missing or unsupported MCP protocol version")
        }
        "ping" => json_rpc_result(id, json!({})),
        "tools/list" => {
            let tools: Vec<Value> = pm_tool_definitions(&context)
                .into_iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                    })
                })
                .collect();
            json_rpc_result(id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Ok(Some(json_rpc_error(id, -32602, "invalid tool call")));
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let outcome = match pm_tool_access(&context, name) {
                Ok(tool) if PM_HOST_TOOLS.contains(&tool) => {
                    skills::host_tool(state, &context, tool, arguments).await
                }
                _ => call_pm_tool(&mut state.store.lock(), &context, name, arguments),
            };
            let read_only = matches!(
                name,
                PM_BOARD_READ
                    | PM_TICKET_READ
                    | PM_RISKS_READ
                    | PM_SKILL_DISCOVERY_READ
                    | PM_SKILL_TOOL_VERIFY
                    | PM_OWNER_EVIDENCE_READ
            );
            if outcome.is_ok() && !read_only {
                state.board_changed(&context.project_id);
            }
            if outcome.is_ok()
                && matches!(
                    name,
                    PM_TICKET_SUGGEST
                        | PM_SKILL_DRAFT_SUBMIT
                        | PM_SKILL_RUN_FINISH
                        | PM_ENVIRONMENTS_PROPOSE
                )
            {
                skills::publish(state, &context.project_id);
            }
            if outcome.is_ok() && name == PM_TICKET_PROPOSE_DESCRIPTION {
                agents::stop_after_draft(state, bearer);
            }
            if outcome.is_ok()
                && name == PM_SKILL_RUN_FINISH
                && let Some(run) = &context.skill
            {
                skills::stop_after_finish(state, &run.run_id);
            }
            if outcome.is_ok()
                && name == PM_CHECK_REPORT
                && let (Some(check_id), Some(ticket_id)) = (&check_id, &context.ticket_id)
            {
                state.publish(
                    EventName::PmCheckChanged,
                    json!({
                        "projectId": context.project_id,
                        "ticketId": ticket_id,
                        "checkId": check_id,
                    }),
                );
                skills::note_event(state, &context.project_id, SkillEvent::DeployChanged);
            }
            match outcome {
                Ok(value) => tool_success(id, value),
                Err(error) => tool_error(id, &error),
            }
        }
        _ => json_rpc_error(id, -32601, "method not found"),
    };
    Ok(Some(reply))
}

fn initialize(id: Value, params: &Value) -> Value {
    let Some(requested) = params.get("protocolVersion").and_then(Value::as_str) else {
        return json_rpc_error(id, -32602, "missing MCP protocol version");
    };
    if !MCP_PROTOCOLS.contains(&requested) {
        return json_rpc_error(id, -32602, "unsupported MCP protocol version");
    }
    json_rpc_result(
        id,
        json!({
            "protocolVersion": requested,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
    )
}

fn supported_protocol_header(headers: &HeaderMap) -> bool {
    headers.get(MCP_PROTOCOL_HEADER).is_none_or(|value| {
        value
            .to_str()
            .ok()
            .is_some_and(|version| MCP_PROTOCOLS.contains(&version))
    })
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|token| token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(uri) = origin
        .to_str()
        .unwrap_or_default()
        .parse::<axum::http::Uri>()
    else {
        return false;
    };
    uri.authority().is_some_and(|authority| {
        matches!(
            authority.host(),
            "127.0.0.1" | "::1" | "[::1]" | "localhost"
        )
    })
}

fn tool_success(id: Value, value: Value) -> Value {
    let text = value.to_string();
    json_rpc_result(
        id,
        json!({
            "content": [{ "type": "text", "text": text }],
            "structuredContent": value,
            "isError": false,
        }),
    )
}

/// A tool failure as a tool result the agent can read: a stable code and a
/// message, never store internals.
fn tool_error(id: Value, error: &PmToolError) -> Value {
    let message = match error {
        PmToolError::Store(termloop_pm::PmError::Storage(_))
        | PmToolError::Store(termloop_pm::PmError::NewerSchema { .. }) => {
            tracing::warn!(%error, "a PM tool call failed in the store");
            "the PM store failed".to_owned()
        }
        _ => error.to_string(),
    };
    let structured = json!({ "code": error.code(), "message": message });
    json_rpc_result(
        id,
        json!({
            "content": [{ "type": "text", "text": structured.to_string() }],
            "structuredContent": structured,
            "isError": true,
        }),
    )
}

fn json_rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}
