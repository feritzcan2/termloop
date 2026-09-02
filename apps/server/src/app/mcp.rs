use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use termloop_contract::current::{
    self as protocol, AskToParams, AskToTarget, ConfigurationVersionWriteParams,
    McpStewardAgentMessageParams, McpStewardBriefUpdateParams, McpStewardSystemPromptUpdateParams,
    McpStewardTaskAgentStartParams, McpStewardTaskCreateParams, McpStewardTaskIdParams,
    McpStewardTaskRenameParams, McpStewardTaskSetJiraUrlParams, McpStewardTaskUpdateBriefParams,
    McpTaskAgentTranscriptTailReadParams, ProjectionTopic, ReplyToRequestParams,
    RoutineFindingResolveParams, SendToAgentParams, WorkerRoutineCompleteParams,
    WorkerRoutineProblemParams, WorkerStepVerdictsParams, WorkerTaskAgentRequestParams,
};
use tokio::time::{Duration, Instant};

use super::AppState;
use super::core_lock::{in_operation, record_operation_duration};
use super::invalidation::{InvalidationRequest, refresh_task_presence_for_cwd};

// 32,768 Unicode scalar bindings can expand to six-byte JSON escapes plus
// framing. Keep the HTTP cap explicit without silently narrowing the schema.
const MAX_MCP_MESSAGE: usize = 256 * 1024;
const MCP_PROTOCOLS: &[&str] = &["2025-06-18", "2025-11-25"];
const MCP_PROTOCOL_HEADER: &str = "mcp-protocol-version";

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
    let Some(token) = bearer_token(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if state.mcp_authorizer.authenticate_transport(token).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn mcp_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if body.len() > MAX_MCP_MESSAGE {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Some(token) = bearer_token(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(principal) = state.mcp_authorizer.authenticate_transport(token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return json_rpc_error(Value::Null, -32700, "parse error");
    };
    let Some(object) = message.as_object() else {
        return json_rpc_error(Value::Null, -32600, "invalid request");
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || object
            .get("method")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || object
            .get("id")
            .is_some_and(|id| !(id.is_null() || id.is_string() || id.is_number()))
    {
        return json_rpc_error(
            object.get("id").cloned().unwrap_or(Value::Null),
            -32600,
            "invalid request",
        );
    }
    let id = object.get("id").cloned();
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    if id.is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = id.unwrap_or(Value::Null);

    match method {
        "initialize" => initialize(id, params, principal.role()),
        // Claude 2.1.228 probes this newer method before initialize. Refusing
        // only the method keeps the same HTTP connection usable for fallback.
        "server/discover" => json_rpc_error(id, -32601, "method not found"),
        _ if !supported_protocol_header(&headers) => {
            json_rpc_error(id, -32600, "missing or unsupported MCP protocol version")
        }
        "ping" => json_rpc_result(id, json!({})),
        "tools/list" => json_rpc_result(
            id,
            json!({
                "tools": tools_for_role(principal.role(), &state.mcp_tool_descriptions)
            }),
        ),
        "tools/call" => {
            let Ok(command_principal) = state.mcp_authorizer.authenticate(token) else {
                return core_tool_error(id, &termloop_core::CoreError::CapabilityDenied);
            };
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return json_rpc_error(id, -32602, "invalid tool call");
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            tool_call(id, name, arguments, token, &command_principal, &state).await
        }
        _ => json_rpc_error(id, -32601, "method not found"),
    }
}

fn initialize(
    id: Value,
    params: Value,
    role: &termloop_core::session_launch::AgentMcpRole,
) -> Response {
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
            "serverInfo": {
                "name": "termloop-next",
                "version": env!("CARGO_PKG_VERSION")
            },
            "instructions": role_instructions(role)
        }),
    )
}

async fn tool_call(
    id: Value,
    name: &str,
    arguments: Value,
    token: &str,
    principal: &termloop_core::McpPrincipal,
    state: &AppState,
) -> Response {
    let role = mcp_role_name(principal.role());
    let operation = Arc::<str>::from(name);
    let started = Instant::now();
    let response = in_operation(
        "mcp",
        role,
        operation.clone(),
        tool_call_inner(id, name, arguments, token, principal, state),
    )
    .await;
    record_operation_duration("mcp", role, &operation, started.elapsed());
    response
}

fn mcp_role_name(role: &termloop_core::session_launch::AgentMcpRole) -> &'static str {
    match role {
        termloop_core::session_launch::AgentMcpRole::Interactive => "interactive",
        termloop_core::session_launch::AgentMcpRole::Improver { .. } => "improver",
        termloop_core::session_launch::AgentMcpRole::Helper { .. } => "helper",
        termloop_core::session_launch::AgentMcpRole::Steward { .. } => "steward",
        termloop_core::session_launch::AgentMcpRole::Worker { .. } => "worker",
    }
}

async fn tool_call_inner(
    id: Value,
    name: &str,
    arguments: Value,
    token: &str,
    principal: &termloop_core::McpPrincipal,
    state: &AppState,
) -> Response {
    if !protocol::validate_mcp_tool_params(name, &arguments) {
        return tool_error(id, "invalidArguments", "invalid arguments", None);
    }
    let _active_command =
        if let termloop_core::session_launch::AgentMcpRole::Steward { project_id } =
            principal.role()
        {
            let state_revision = state.core.lock().await.state_revision();
            state.steward_presence.try_begin_command(
                project_id,
                name,
                state.invalidation_requests.clone(),
                state.observation_sequence.clone(),
                state_revision,
            )
        } else {
            None
        };
    let result = match (principal.role(), name) {
        (
            termloop_core::session_launch::AgentMcpRole::Improver { target },
            "configuration_version_read",
        ) => state
            .core
            .lock()
            .await
            .read_improver_configuration_version(principal.session_id(), target),
        (
            termloop_core::session_launch::AgentMcpRole::Improver { target },
            "configuration_version_write",
        ) => {
            let params: ConfigurationVersionWriteParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            let plan = state
                .core
                .lock()
                .await
                .prepare_improver_configuration_write(
                    principal.session_id(),
                    target,
                    params.expected_active_version_id,
                    params.content,
                    params.summary,
                );
            match plan {
                Ok(plan) => super::control::apply_configuration_plan(plan, state)
                    .await
                    .map(|applied| {
                        json!({
                            "activeVersionId": applied["activeVersion"]["id"],
                            "sequence": applied["activeVersion"]["sequence"],
                            "summary": applied["activeVersion"]["summary"],
                            "stateRevision": applied["stateRevision"],
                        })
                    }),
                Err(error) => Err(error),
            }
        }
        (
            termloop_core::session_launch::AgentMcpRole::Interactive
            | termloop_core::session_launch::AgentMcpRole::Improver { .. }
            | termloop_core::session_launch::AgentMcpRole::Helper { .. }
            | termloop_core::session_launch::AgentMcpRole::Steward { .. },
            "send_to_agent",
        ) => {
            let params: SendToAgentParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            state
                .core
                .lock()
                .await
                .send_to_agent(token, &params.session_id, &params.message)
        }
        (
            termloop_core::session_launch::AgentMcpRole::Interactive
            | termloop_core::session_launch::AgentMcpRole::Improver { .. }
            | termloop_core::session_launch::AgentMcpRole::Helper { .. },
            "ask_to",
        ) => {
            let params: AskToParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            let target = match params.target {
                AskToTarget::Claude => "claude",
                AskToTarget::Codex => "codex",
            };
            run_ask_to(
                token,
                termloop_core::session_launch::AskToInput {
                    target: target.into(),
                    message: params.message,
                    idempotency_key: params.idempotency_key,
                    conversation_id: params.conversation_id,
                },
                state,
            )
            .await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Helper { request_id },
            "reply_to_request",
        ) => {
            let params: ReplyToRequestParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            if request_id.as_deref() != Some(params.request_id.as_str()) {
                Err(termloop_core::CoreError::CapabilityDenied)
            } else {
                state
                    .core
                    .lock()
                    .await
                    .reply_to_request(token, &params.request_id, params.message)
            }
        }
        (termloop_core::session_launch::AgentMcpRole::Steward { project_id }, "project_read") => {
            text_result(
                state
                    .core
                    .lock()
                    .await
                    .project_projection_for_executor(project_id),
            )
        }
        (termloop_core::session_launch::AgentMcpRole::Steward { project_id }, "task_read") => {
            let params: protocol::McpTaskReadParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            read_tasks(project_id, None, params, state).await
        }
        (termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. }, "task_read") => {
            let params: protocol::McpTaskReadParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            read_tasks(project_id, Some(principal.session_id()), params, state).await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "project_read",
        ) => text_result(
            state
                .core
                .lock()
                .await
                .project_projection_for_executor(project_id),
        ),
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "agent_status_read",
        )
        | (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "agent_status_read",
        ) => text_result(
            state
                .core
                .lock()
                .await
                .agent_status_projection_for_executor(project_id),
        ),
        (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "task_agent_transcript_tail_read",
        ) => {
            let params: McpTaskAgentTranscriptTailReadParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            text_result(
                read_task_agent_transcript_tail(project_id, params.task_id.as_str(), state).await,
            )
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "routine_report_read",
        ) => text_result(
            state
                .core
                .lock()
                .await
                .list_tracker_runtime(json!({ "projectId": project_id })),
        ),
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "companion_transcript_read",
        ) => text_result(
            state
                .core
                .lock()
                .await
                .list_companion_transcript(json!({ "projectId": project_id, "limit": 50 })),
        ),
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "pull_request_read",
        )
        | (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "pull_request_read",
        ) => read_pull_requests(project_id, state).await,
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "steward_suggest",
        ) => steward_suggest(project_id, principal.session_id(), arguments, state).await,
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "routine_finding_read",
        ) => {
            let core = state.core.lock().await;
            if !core.is_current_steward_session(project_id, principal.session_id()) {
                Err(termloop_core::CoreError::CapabilityDenied)
            } else {
                text_result(core.read_routine_findings(project_id))
            }
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "routine_finding_resolve",
        ) => {
            let params: RoutineFindingResolveParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            resolve_routine_finding(project_id, principal.session_id(), params, state).await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "steward_system_prompt_read",
        ) => text_result(
            state
                .core
                .lock()
                .await
                .steward_system_prompt_for_executor(principal.session_id(), project_id),
        ),
        (termloop_core::session_launch::AgentMcpRole::Steward { project_id }, "playbook_read") => {
            text_result(
                state
                    .core
                    .lock()
                    .await
                    .playbook_projection_for_executor(project_id),
            )
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "task_set_steward_brief",
        ) => {
            let params: McpStewardBriefUpdateParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            set_steward_task_brief(project_id, principal.session_id(), params, state).await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "steward_system_prompt_update",
        ) => {
            let params: McpStewardSystemPromptUpdateParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            update_steward_system_prompt(project_id, principal.session_id(), params, state).await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "task_agent_start",
        ) => {
            let params: McpStewardTaskAgentStartParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            super::steward_task_start::start(project_id, principal.session_id(), params, state)
                .await
        }
        (termloop_core::session_launch::AgentMcpRole::Steward { project_id }, "task_create") => {
            let params: McpStewardTaskCreateParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            steward_task_command(
                project_id,
                principal.session_id(),
                "task.create",
                json!({
                    "projectId": project_id,
                    "title": params.title,
                    "brief": params.brief,
                    "worktreeIntent": "inherit",
                    "agentId": null,
                    "model": null,
                    "reasoning": null,
                    "kickoffMessage": null,
                }),
                "created",
                state,
            )
            .await
        }
        (termloop_core::session_launch::AgentMcpRole::Steward { project_id }, "task_rename") => {
            let params: McpStewardTaskRenameParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            let task_id = params.task_id.clone();
            steward_task_command(
                project_id,
                principal.session_id(),
                "task.rename",
                json!({ "taskId": task_id, "title": params.title }),
                "renamed",
                state,
            )
            .await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "task_update_brief",
        ) => {
            let params: McpStewardTaskUpdateBriefParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            let task_id = params.task_id.clone();
            steward_task_command(
                project_id,
                principal.session_id(),
                "task.updateBrief",
                json!({ "taskId": task_id, "brief": params.brief }),
                "updated",
                state,
            )
            .await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "task_set_jira_url",
        ) => {
            let params: McpStewardTaskSetJiraUrlParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            set_steward_task_jira_url(project_id, principal.session_id(), params, state).await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            name @ ("task_close" | "task_reopen" | "task_delete"),
        ) => {
            let params: McpStewardTaskIdParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            let (method, status) = match name {
                "task_close" => ("task.close", "closed"),
                "task_reopen" => ("task.reopen", "reopened"),
                _ => ("task.delete", "deleted"),
            };
            steward_task_command(
                project_id,
                principal.session_id(),
                method,
                json!({ "taskId": params.task_id }),
                status,
                state,
            )
            .await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Steward { project_id },
            "agent_message_send",
        ) => {
            let params: McpStewardAgentMessageParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            send_steward_agent_message(project_id, principal.session_id(), params, state).await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "task_agent_request",
        ) => {
            let params: WorkerTaskAgentRequestParams = serde_json::from_value(arguments)
                .expect("generated MCP validation precedes decoding");
            worker_task_agent_request(project_id, principal.session_id(), token, params, state)
                .await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Worker {
                project_id,
                worker_id: _,
            },
            "worker_get_next_routine",
        ) => worker_get_next_routine(project_id, principal.session_id(), state).await,
        (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "worker_complete_routine",
        ) => worker_complete_routine(project_id, principal.session_id(), arguments, state).await,
        (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "worker_report_routine_problem",
        ) => {
            worker_report_routine_problem(project_id, principal.session_id(), arguments, state)
                .await
        }
        (
            termloop_core::session_launch::AgentMcpRole::Worker { project_id, .. },
            "worker_report_step_verdicts",
        ) => {
            worker_report_step_verdicts(project_id, principal.session_id(), arguments, state).await
        }
        _ => Err(termloop_core::CoreError::CapabilityDenied),
    };
    match result {
        Ok(value) if protocol::validate_mcp_tool_result(name, &value) => tool_success(id, value),
        Ok(_) => tool_error(
            id,
            "invalidResult",
            "TermLoop MCP produced an invalid result",
            None,
        ),
        Err(error) => core_tool_error(id, &error),
    }
}

async fn run_ask_to(
    token: &str,
    input: termloop_core::session_launch::AskToInput,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let outcome = state.core.lock().await.plan_ask_to(token, input)?;
    let plan = match outcome {
        termloop_core::session_launch::AskToPlanOutcome::Existing(value)
        | termloop_core::session_launch::AskToPlanOutcome::FollowUp(value) => return Ok(value),
        termloop_core::session_launch::AskToPlanOutcome::Launch(plan) => *plan,
    };
    let request_id = plan
        .ask_to_request_id()
        .ok_or_else(|| termloop_core::CoreError::InvalidParams("requestId".into()))?
        .to_owned();
    let launch_state = state.clone();
    let launch_request_id = request_id.clone();
    let launch = tokio::spawn(async move {
        execute_ask_to_launch(plan, &launch_request_id, &launch_state).await
    });
    match launch.await {
        Ok(result) => result,
        Err(error) => {
            state.core.lock().await.fail_ask_to_launch(&request_id);
            Err(termloop_core::CoreError::Terminal(format!(
                "helper launch task failed: {error}"
            )))
        }
    }
}

async fn execute_ask_to_launch(
    mut plan: termloop_core::session_launch::AgentLaunchPlan,
    request_id: &str,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    plan = match tokio::task::spawn_blocking(move || -> Result<_, termloop_core::CoreError> {
        plan.observe_task_worktree(Duration::from_secs(8))?;
        plan.prepare_runtime();
        Ok(plan)
    })
    .await
    {
        Ok(Ok(plan)) => plan,
        Ok(Err(error)) => {
            state.core.lock().await.fail_ask_to_launch(request_id);
            return Err(error);
        }
        Err(error) => {
            state.core.lock().await.fail_ask_to_launch(request_id);
            return Err(termloop_core::CoreError::Terminal(format!(
                "helper runtime preparation failed: {error}"
            )));
        }
    };
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "helper status runtime unavailable; launching without observation");
    }
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_ask_to_launch(request_id, &mut plan);
        if result.is_err() {
            core.fail_ask_to_launch(request_id);
        }
        (result, core.state_revision())
    };
    tokio::task::spawn_blocking(move || drop(plan));
    let completion = result?;
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Session],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if let Some(cwd) = completion
        .session
        .get("process")
        .and_then(|process| process.get("cwd"))
        .and_then(Value::as_str)
    {
        refresh_task_presence_for_cwd(state, cwd).await;
    }
    Ok(completion.acknowledgement)
}

fn role_instructions(role: &termloop_core::session_launch::AgentMcpRole) -> &'static str {
    match role {
        termloop_core::session_launch::AgentMcpRole::Interactive => {
            "Interactive Session profile. Use ask_to whenever the user wants another Claude or Codex involved — ask, consult, discuss, second opinion, or review — including short provider-named requests in any language such as 'ask codex' or 'discuss this with codex'; the user never has to name TermLoop, MCP, or the tool, and you compose the helper's message from the current conversation. Use send_to_agent instead whenever an exact existing TermLoop Session ID is present and the user wants something delivered there — any phrasing, any language — to return an answer to a received TermLoop handoff using its exact Source Session ID, or to send the one completion/blocker report required by a visible Steward Task assignment to its exact Steward Session ID; compose that message yourself, never guess or fuzzily resolve a Session ID, the target may be in any Project or worktree, and you must not poll for a reply."
        }
        termloop_core::session_launch::AgentMcpRole::Improver { .. } => {
            "Target-bound Improve Agent profile. Read the active snapshot through configuration_version_read. Discuss and prepare changes freely, but call configuration_version_write only after the user says to apply, save, use, or an equivalent confirmation. That call applies the target's normal configuration command and records a new active snapshot only when the effective content changed; preserve every field the user did not ask to change."
        }
        termloop_core::session_launch::AgentMcpRole::Steward { .. } => {
            "Authenticated Project Steward profile. Follow the visible versioned Steward and wake prompts; the exposed MCP tools enforce Project scope and mutation authority."
        }
        termloop_core::session_launch::AgentMcpRole::Worker { .. } => {
            "Authenticated Project Worker profile. Follow the visible versioned Worker and wake prompts; the exposed MCP tools enforce Routine reporting scope. Use task_agent_transcript_tail_read when Task completion evidence depends on recent developer Agent reports. During an exact claimed Playbook step, task_agent_request may send one Task-scoped question or delegated follow-up only to the canonical Agent selected by that Task's successful scoped task_read coordinationAgent projection; the Agent may return a visible handoff to this exact Worker Session. Workers cannot contact any other Agent or launch a replacement."
        }
        termloop_core::session_launch::AgentMcpRole::Helper {
            request_id: Some(_),
        } => {
            "Reusable helper profile. Reply to the exact active request once through reply_to_request. You may also use the interactive Session tools: send_to_agent for an exact existing Session ID and one-way delivery, or ask_to for a new helper or tracked answer."
        }
        termloop_core::session_launch::AgentMcpRole::Helper { request_id: None } => {
            "Reusable helper profile. Keep this conversation available until the user closes it. No reply_to_request is currently authorized; you may use the interactive Session tools: send_to_agent for an exact existing Session ID and one-way delivery, or ask_to for a new helper or tracked answer."
        }
    }
}

fn text_result(
    value: Result<Value, termloop_core::CoreError>,
) -> Result<Value, termloop_core::CoreError> {
    value.and_then(|value| {
        serde_json::to_string(&value)
            .map(|content| json!({ "content": content }))
            .map_err(|error| termloop_core::CoreError::Store(error.to_string()))
    })
}

async fn read_tasks(
    project_id: &str,
    worker_session_id: Option<&str>,
    params: protocol::McpTaskReadParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let Some(task_id) = params.task_id else {
        if params.check_id.is_some() {
            return Err(termloop_core::CoreError::InvalidParams("checkId".into()));
        }
        return text_result(
            state
                .core
                .lock()
                .await
                .list_tasks_current(json!({ "projectId": project_id })),
        );
    };

    let worker_claim = if let Some(session_id) = worker_session_id {
        let check_id = params
            .check_id
            .as_deref()
            .ok_or_else(|| termloop_core::CoreError::InvalidParams("checkId".into()))?;
        let capability = claimed_check(state, project_id, session_id, check_id)?;
        let claimed_task_id = state.core.lock().await.tracker_check_task_id(&capability)?;
        if claimed_task_id
            .as_deref()
            .is_some_and(|claimed_task_id| claimed_task_id != task_id)
        {
            return Err(termloop_core::CoreError::CapabilityDenied);
        }
        Some((session_id.to_owned(), check_id.to_owned(), capability))
    } else {
        if params.check_id.is_some() {
            return Err(termloop_core::CoreError::InvalidParams("checkId".into()));
        }
        None
    };

    // Fail before provider or Git work when the exact Task is not in the
    // authenticated Project. Each observation path revalidates its own Task
    // binding again before committing or returning evidence.
    state
        .core
        .lock()
        .await
        .task_projection_for_executor(project_id, &task_id)?;
    let task_ids = vec![task_id.clone()];
    let (branch_commits, pull_requests) = tokio::join!(
        super::control::task_branch_commit_summary_list(
            json!({ "projectId": project_id, "taskIds": task_ids.clone() }),
            state,
        ),
        super::control::git_host_pull_request_list(
            json!({ "projectId": project_id, "taskIds": task_ids }),
            state,
        ),
    );
    let branch_commits = branch_commits?;
    let pull_requests = pull_requests?;

    let (task, agent_statuses, coordination_agent) = {
        let core = state.core.lock().await;
        if let Some((_, _, capability)) = worker_claim.as_ref() {
            let claimed_task_id = core.tracker_check_task_id(capability)?;
            if claimed_task_id
                .as_deref()
                .is_some_and(|claimed_task_id| claimed_task_id != task_id)
            {
                return Err(termloop_core::CoreError::TrackerReportStale);
            }
        }
        (
            core.task_projection_for_executor(project_id, &task_id)?,
            core.task_agent_status_projection_for_executor(project_id, &task_id)?,
            core.task_coordination_agent_projection_for_executor(project_id, &task_id)?,
        )
    };
    if let Some((session_id, check_id, _)) = worker_claim {
        let marked =
            state
                .tracker_report_capabilities
                .lock()
                .ok()
                .is_some_and(|mut capabilities| {
                    capabilities.mark_task_read(
                        &session_id,
                        &check_id,
                        &task_id,
                        super::current_epoch_ms(),
                    )
                });
        if !marked {
            return Err(termloop_core::CoreError::TrackerReportStale);
        }
    }

    text_result(Ok(task_read_projection(
        task,
        branch_commits,
        pull_requests,
        agent_statuses,
        coordination_agent,
    )))
}

fn task_read_projection(
    task: Value,
    branch_commits: Value,
    pull_requests: Value,
    agent_statuses: Value,
    coordination_agent: Value,
) -> Value {
    let effective_branch = task
        .get("worktree_health")
        .and_then(|health| health.get("checked_out_branch"))
        .and_then(Value::as_str)
        .or_else(|| {
            task.get("branch")
                .and_then(|branch| branch.get("name"))
                .and_then(Value::as_str)
        });
    let pull_request = pull_requests
        .as_array()
        .and_then(|items| items.first())
        .cloned();
    let pull_request_candidates_by_base_branch = pull_request
        .as_ref()
        .map(pull_request_candidates_by_base_branch)
        .unwrap_or_default();
    json!({
        "task": task,
        "effectiveBranch": effective_branch,
        "branchCommitSummary": branch_commits.as_array().and_then(|items| items.first()).cloned(),
        "pullRequest": pull_request,
        "pullRequestCandidatesByBaseBranch": pull_request_candidates_by_base_branch,
        "agentStatuses": agent_statuses,
        "coordinationAgent": coordination_agent,
        "evidenceSemantics": {
            "task": "durableTermLoopRecordNotDeliveryCompletionEvidence",
            "effectiveBranch": "currentCheckoutConvenienceNotUniversalDeliveryIdentity",
            "branchCommitSummary": "boundedGitObservationBranchDivergedIsNotTaskOwnedWork",
            "pullRequest": "providerProjectionUseExactHeadBaseMergeCommitAndFreshness",
            "pullRequestCandidatesByBaseBranch": "sameExactTaskProviderMatchesGroupedForStageSpecificSelectionCurrentCheckoutDoesNotInvalidateAMatchingPullRequest",
            "agentStatus": "runtimeObservation",
            "coordinationAgent": "canonicalCurrentTaskAgentForWorkerAndStewardCoordination",
            "agentPlan": "agentReportedClaimNotIndependentlyVerified",
        },
    })
}

fn pull_request_candidates_by_base_branch(pull_request: &Value) -> Vec<Value> {
    let mut groups = std::collections::BTreeMap::<String, Vec<Value>>::new();
    for candidate in pull_request
        .get("matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(base_branch) = candidate.get("base_branch").and_then(Value::as_str) else {
            continue;
        };
        groups
            .entry(base_branch.to_owned())
            .or_default()
            .push(candidate.clone());
    }
    groups
        .into_iter()
        .map(|(base_branch, matches)| {
            json!({
                "baseBranch": base_branch,
                "matches": matches,
            })
        })
        .collect()
}

async fn read_pull_requests(
    project_id: &str,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let tasks = state
        .core
        .lock()
        .await
        .list_tasks_current(json!({ "projectId": project_id }))?;
    let task_ids = task_ids_from_list(&tasks);
    if task_ids.is_empty() {
        return Ok(json!({ "content": "[]" }));
    }
    text_result(
        super::control::git_host_pull_request_list(
            json!({ "projectId": project_id, "taskIds": task_ids }),
            state,
        )
        .await,
    )
}

fn task_ids_from_list(tasks: &Value) -> Vec<String> {
    tasks
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|task| task.get("id").and_then(Value::as_str))
        .take(40)
        .map(str::to_owned)
        .collect()
}

async fn read_task_agent_transcript_tail(
    project_id: &str,
    task_id: &str,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let outcome = state.core.lock().await.plan_session_history_list(json!({
        "projectId": project_id,
        "force": true,
        "fillCache": true,
    }))?;
    if let termloop_core::session_launch::SessionHistoryListPlanOutcome::Observe(plan) = outcome {
        let cancellation = Arc::new(AtomicBool::new(false));
        let _cancel_on_drop = McpHistoryScanCancellation(cancellation.clone());
        let observed = tokio::task::spawn_blocking(move || plan.observe(&cancellation))
            .await
            .map_err(|error| {
                termloop_core::CoreError::Terminal(format!(
                    "Task Agent transcript scan failed: {error}"
                ))
            })?;
        state
            .core
            .lock()
            .await
            .complete_session_history_list(observed)?;
    }
    state
        .core
        .lock()
        .await
        .task_agent_transcript_tail_projection_for_executor(project_id, task_id)
}

struct McpHistoryScanCancellation(Arc<AtomicBool>);

impl Drop for McpHistoryScanCancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

async fn steward_suggest(
    project_id: &str,
    session_id: &str,
    arguments: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| termloop_core::CoreError::InvalidParams("content".into()))?
        .to_owned();
    let kind = arguments
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| termloop_core::CoreError::InvalidParams("kind".into()))?;
    let task_id = arguments
        .pointer("/refs/taskId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let referenced_session_id = arguments
        .pointer("/refs/sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let routine_finding_id = arguments
        .pointer("/refs/routineFindingId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let routine_finding_ids: Vec<String> = arguments
        .pointer("/refs/routineFindingIds")
        .and_then(Value::as_array)
        .map(|finding_ids| {
            finding_ids
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let dismisses_findings = matches!(kind, "update" | "attention" | "problem")
        && (routine_finding_id.is_some() || !routine_finding_ids.is_empty());
    let mut core = state.core.lock().await;
    core.append_steward_suggestion(
        session_id,
        project_id,
        kind,
        termloop_core::companion_integrations::transcript::CompanionMessageRefsInput {
            task_id,
            session_id: referenced_session_id,
            routine_finding_id,
            routine_finding_ids,
        },
        content,
        super::current_epoch_ms(),
    )?;
    let state_revision = core.state_revision();
    drop(core);
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: if dismisses_findings {
            vec![ProjectionTopic::Companion, ProjectionTopic::Routine]
        } else {
            vec![ProjectionTopic::Companion]
        },
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(json!({
        "status": if dismisses_findings {
            "deliveredAndDismissed"
        } else {
            "delivered"
        }
    }))
}

async fn resolve_routine_finding(
    project_id: &str,
    session_id: &str,
    params: RoutineFindingResolveParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let state_revision = {
        let mut core = state.core.lock().await;
        if !core.is_current_steward_session(project_id, session_id) {
            return Err(termloop_core::CoreError::CapabilityDenied);
        }
        core.resolve_routine_finding(
            project_id,
            &params.finding_id,
            &params.resolution,
            super::current_epoch_ms(),
        )?;
        core.state_revision()
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Routine],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(json!({ "status": "resolved" }))
}

async fn update_steward_system_prompt(
    project_id: &str,
    session_id: &str,
    params: McpStewardSystemPromptUpdateParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let (changed, state_revision) = {
        let mut core = state.core.lock().await;
        let changed = core.update_steward_system_prompt(
            session_id,
            project_id,
            &params.user_message_id,
            &params.expected_system_prompt,
            &params.system_prompt,
            super::current_epoch_ms(),
        )?;
        (changed, core.state_revision())
    };
    if !changed {
        return Ok(json!({ "status": "unchanged" }));
    }

    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Steward],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    // The configuration commit already revoked this Session's Steward
    // authority. Process retirement is best-effort and cannot roll back the
    // durable prompt replacement.
    let _ = super::control::terminate_session(json!({ "sessionId": session_id }), state).await;
    super::companion_supervisor::replace_steward_configuration_wake(state, project_id).await;
    Ok(json!({ "status": "restarting" }))
}

async fn steward_task_command(
    project_id: &str,
    session_id: &str,
    method: &str,
    params: Value,
    status: &str,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let automation_selection =
        (method == "task.create").then_some((protocol::TaskCreateWorktreeIntent::Inherit, None));
    let requested_task_id = params
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (task_id, created_task, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.execute_steward_task_command(session_id, project_id, method, params)?;
        let task_id = requested_task_id
            .or_else(|| result.get("id").and_then(Value::as_str).map(str::to_owned))
            .ok_or_else(|| {
                termloop_core::CoreError::Store("Task command omitted Task ID".into())
            })?;
        let action = match method {
            "task.create" => "Created Task.",
            "task.rename" => "Renamed Task.",
            "task.updateBrief" => "Updated Task brief.",
            "task.close" => "Closed Task.",
            "task.reopen" => "Reopened Task.",
            "task.delete" => "Deleted Task.",
            _ => "Updated Task.",
        };
        // The Task command is already authoritative. Transcript quota refusal
        // must not turn a successful mutation into an ambiguous MCP failure.
        let _ = core.append_steward_action(
            session_id,
            project_id,
            action,
            Some(task_id.clone()),
            None,
            super::current_epoch_ms(),
        );
        let created_task = (method == "task.create").then_some(result);
        (task_id, created_task, core.state_revision())
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Task,
            ProjectionTopic::Companion,
            ProjectionTopic::Steward,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if method == "task.delete" {
        super::health::refresh_all_health_demands(state).await;
    }
    if let (Some(task), Some((worktree_intent, agent_id))) =
        (created_task.as_ref(), automation_selection)
    {
        match super::task_automation::action_for_task(
            task,
            super::task_automation::TaskAutomationSelection {
                worktree_intent,
                worktree_prefix: None,
                agent_id,
                model: None,
                permission: None,
                reasoning: None,
                kickoff_message: None,
            },
            state,
        )
        .await
        {
            Ok(action) => super::task_automation::spawn(vec![action], state),
            Err(error) => {
                tracing::warn!(task_id = %task_id, %error, "Steward Task automation could not be planned")
            }
        }
    }
    Ok(json!({ "taskId": task_id, "status": status }))
}

async fn set_steward_task_jira_url(
    project_id: &str,
    session_id: &str,
    params: McpStewardTaskSetJiraUrlParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let (jira_url, state_revision) = {
        let mut core = state.core.lock().await;
        let jira_url = core.set_steward_task_jira_url(
            session_id,
            project_id,
            &params.task_id,
            &params.jira_url,
        )?;
        (jira_url, core.state_revision())
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(json!({
        "taskId": params.task_id,
        "jiraUrl": jira_url,
        "status": "linked",
    }))
}

async fn set_steward_task_brief(
    project_id: &str,
    session_id: &str,
    params: McpStewardBriefUpdateParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.set_steward_task_brief(
            session_id,
            project_id,
            &params.task_id,
            params.brief_markdown,
            params.expected_brief_revision,
            super::current_epoch_ms(),
        )?;
        (result, core.state_revision())
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(result)
}

async fn send_steward_agent_message(
    project_id: &str,
    steward_session_id: &str,
    params: McpStewardAgentMessageParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let mut core = state.core.lock().await;
    core.send_steward_agent_message(
        steward_session_id,
        project_id,
        &params.session_id,
        &params.message,
    )?;
    let _ = core.append_steward_action(
        steward_session_id,
        project_id,
        "Queued a message for verified Agent delivery.",
        None,
        Some(params.session_id.clone()),
        super::current_epoch_ms(),
    );
    let state_revision = core.state_revision();
    drop(core);
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Companion, ProjectionTopic::Steward],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(json!({ "sessionId": params.session_id, "status": "submitting" }))
}

async fn worker_task_agent_request(
    project_id: &str,
    worker_session_id: &str,
    token: &str,
    params: WorkerTaskAgentRequestParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let capability = claimed_check(state, project_id, worker_session_id, &params.check_id)?;
    let focused_task_id = state.core.lock().await.tracker_check_task_id(&capability)?;
    if focused_task_id.as_deref() != Some(params.task_id.as_str()) {
        return Err(termloop_core::CoreError::CapabilityDenied);
    }
    let task_read_completed =
        state
            .tracker_report_capabilities
            .lock()
            .ok()
            .is_some_and(|mut capabilities| {
                capabilities.task_was_read(
                    worker_session_id,
                    &params.check_id,
                    &params.task_id,
                    super::current_epoch_ms(),
                )
            });
    if !task_read_completed {
        return Err(termloop_core::CoreError::TrackerReportInvalid);
    }

    let mut core = state.core.lock().await;
    if core.tracker_check_task_id(&capability)?.as_deref() != Some(params.task_id.as_str()) {
        return Err(termloop_core::CoreError::TrackerReportStale);
    }
    core.ensure_task_agent_request_target_for_executor(
        project_id,
        &params.task_id,
        &params.session_id,
    )?;
    core.send_to_agent(token, &params.session_id, &params.message)
}

async fn worker_get_next_routine(
    project_id: &str,
    session_id: &str,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let now = super::current_epoch_ms();
    let (claim, state_revision) = {
        let mut core = state.core.lock().await;
        let claim = core.claim_next_worker_routine(
            project_id,
            session_id,
            termloop_platform::generate_opaque_id(),
            now,
        )?;
        (claim, core.state_revision())
    };
    let invalidation_topics = worker_claim_invalidation_topics(&claim.result);
    // The first get-next call is the Worker's readiness handshake. Wake the
    // deadline supervisor so an idle result still arms the next due time.
    state.tracker_runtime_wake.notify_one();
    if let Some(capability) = claim.capability.as_ref() {
        let issued = state
            .tracker_report_capabilities
            .lock()
            .ok()
            .is_some_and(|mut registry| {
                registry.issue(session_id.to_owned(), capability.clone(), now)
            });
        if !issued {
            state
                .core
                .lock()
                .await
                .release_worker_routine_claim(capability);
            return Err(termloop_core::CoreError::TrackerReportInvalid);
        }
    }
    if !invalidation_topics.is_empty() {
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: invalidation_topics,
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
    text_result(Ok(claim.result))
}

fn worker_claim_invalidation_topics(result: &Value) -> Vec<ProjectionTopic> {
    result
        .get("step")
        .is_some_and(Value::is_object)
        .then_some(ProjectionTopic::Playbook)
        .into_iter()
        .collect()
}

/// The Worker's proof that it holds the current claim it is reporting on.
///
/// Every Worker report path proves the same thing: a live capability for this
/// exact check, held by this exact Session in this exact Project. Keeping it in
/// one place keeps that gate one decision rather than three.
fn claimed_check(
    state: &AppState,
    project_id: &str,
    session_id: &str,
    check_id: &str,
) -> Result<
    termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability,
    termloop_core::CoreError,
> {
    let capability = state
        .tracker_report_capabilities
        .lock()
        .ok()
        .and_then(|mut capabilities| {
            capabilities.lookup(session_id, check_id, super::current_epoch_ms())
        })
        .ok_or(termloop_core::CoreError::CapabilityDenied)?;
    if capability.project_id != project_id || capability.worker_session_id != session_id {
        return Err(termloop_core::CoreError::CapabilityDenied);
    }
    Ok(capability)
}

async fn worker_complete_routine(
    project_id: &str,
    session_id: &str,
    arguments: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params: WorkerRoutineCompleteParams =
        serde_json::from_value(arguments).expect("generated MCP validation precedes decoding");
    let capability = claimed_check(state, project_id, session_id, &params.check_id)?;
    let findings = params
        .findings
        .into_iter()
        .map(|finding| {
            termloop_core::companion_integrations::tracker_runtime::WorkerRoutineFinding {
                id: termloop_platform::generate_opaque_id(),
                source_key: finding.source_key,
                summary: finding.summary,
                evidence: finding.evidence,
                source_references: finding.source_references,
                related_task_ids: finding.related_task_ids,
            }
        })
        .collect();
    let result = state.core.lock().await.complete_worker_routine(
        &capability,
        params.expected_context_revision,
        params.context_markdown,
        params.update_summary,
        findings,
        params.related_task_ids,
        termloop_platform::generate_opaque_id(),
        super::current_epoch_ms(),
    );
    let result = finish_worker_report_attempt(state, session_id, &capability, result).await?;
    if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
        capabilities.revoke_check(session_id, &capability.check_id);
    }
    let wake_reason = routine_finding_wake(&result);
    finish_routine_report(project_id, state, wake_reason).await;
    Ok(json!({ "status": worker_routine_completion_status(&result) }))
}

fn worker_routine_completion_status(result: &Value) -> &'static str {
    if result["contextMarkdownApplied"] == false {
        "completedContextPreserved"
    } else {
        "completed"
    }
}

async fn worker_report_routine_problem(
    project_id: &str,
    session_id: &str,
    arguments: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params: WorkerRoutineProblemParams =
        serde_json::from_value(arguments).expect("generated MCP validation precedes decoding");
    let capability = claimed_check(state, project_id, session_id, &params.check_id)?;
    let result = state.core.lock().await.report_worker_routine_problem(
        &capability,
        params.message,
        params.source_references,
        termloop_platform::generate_opaque_id(),
        super::current_epoch_ms(),
    );
    let result = finish_worker_report_attempt(state, session_id, &capability, result).await?;
    if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
        capabilities.revoke_check(session_id, &capability.check_id);
    }
    finish_routine_report(project_id, state, routine_finding_wake(&result)).await;
    Ok(json!({ "status": "problemReported" }))
}

/// A step Routine reports completion for its one focused Task at this stage.
/// Only a passed verdict moves that Task along the board. A current unresolved
/// waiting finding wakes the Steward unless an already-visible proposal owns
/// that decision, so a prior Steward no-op cannot strand the Task forever.
async fn worker_report_step_verdicts(
    project_id: &str,
    session_id: &str,
    arguments: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params: WorkerStepVerdictsParams =
        serde_json::from_value(arguments).expect("generated MCP validation precedes decoding");
    let capability = claimed_check(state, project_id, session_id, &params.check_id)?;
    let task_read_completed =
        state
            .tracker_report_capabilities
            .lock()
            .ok()
            .is_some_and(|mut capabilities| {
                params.verdicts.iter().all(|verdict| {
                    capabilities.task_was_read(
                        session_id,
                        &params.check_id,
                        &verdict.task_id,
                        super::current_epoch_ms(),
                    )
                })
            });
    if !task_read_completed {
        return Err(termloop_core::CoreError::TrackerReportInvalid);
    }
    let verdicts = params
        .verdicts
        .into_iter()
        .map(
            |verdict| termloop_core::companion_integrations::playbook_runtime::WorkerStepVerdict {
                task_id: verdict.task_id,
                passed: verdict.passed,
                evidence: verdict.evidence,
            },
        )
        .collect();
    let result = state.core.lock().await.report_worker_step_verdicts(
        &capability,
        verdicts,
        termloop_platform::generate_opaque_id(),
        super::current_epoch_ms(),
    );
    let result = finish_worker_report_attempt(state, session_id, &capability, result).await?;
    if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
        capabilities.revoke_check(session_id, &capability.check_id);
    }
    let wake_reason = step_verdict_wake(&result);
    finish_routine_report_for(
        project_id,
        state,
        wake_reason,
        vec![ProjectionTopic::Routine, ProjectionTopic::Playbook],
    )
    .await;
    Ok(json!({ "status": "verdictsRecorded" }))
}

fn step_verdict_wake(result: &Value) -> Option<protocol::CompanionWakeReason> {
    match (
        result["passedCount"].as_u64().unwrap_or(0) > 0,
        result["stewardReviewRequired"].as_bool().unwrap_or(false),
    ) {
        (true, true) => Some(protocol::CompanionWakeReason::PipelineMovedAndRoutineFinding),
        (true, false) => Some(protocol::CompanionWakeReason::PipelineMoved),
        (false, true) => Some(protocol::CompanionWakeReason::RoutineFinding),
        (false, false) => None,
    }
}

async fn finish_worker_report_attempt<T>(
    state: &AppState,
    session_id: &str,
    capability: &termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability,
    result: Result<T, termloop_core::CoreError>,
) -> Result<T, termloop_core::CoreError> {
    if matches!(result, Err(termloop_core::CoreError::TrackerReportStale)) {
        // The report is no longer admissible, so this exact claim must not be
        // handed to the Worker again. Releasing by the full claim tuple stays
        // safe even when a reset or edit made its Routine generation stale.
        state
            .core
            .lock()
            .await
            .release_worker_routine_claim(capability);
        if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
            capabilities.revoke_check(session_id, &capability.check_id);
        }
    }
    result
}

fn routine_finding_wake(result: &Value) -> Option<protocol::CompanionWakeReason> {
    result["stewardReviewRequired"]
        .as_bool()
        .unwrap_or_else(|| result["newPendingFindingCount"].as_u64().unwrap_or(0) > 0)
        .then_some(protocol::CompanionWakeReason::RoutineFinding)
}

async fn finish_routine_report(
    project_id: &str,
    state: &AppState,
    wake_reason: Option<protocol::CompanionWakeReason>,
) {
    finish_routine_report_for(
        project_id,
        state,
        wake_reason,
        vec![ProjectionTopic::Routine],
    )
    .await;
}

async fn finish_routine_report_for(
    project_id: &str,
    state: &AppState,
    wake_reason: Option<protocol::CompanionWakeReason>,
    topics: Vec<ProjectionTopic>,
) {
    state.tracker_runtime_wake.notify_one();
    let state_revision = state.core.lock().await.state_revision();
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics,
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if let Some(reason) = wake_reason {
        super::companion_supervisor::enqueue_current_steward_wake(state, project_id, reason).await;
    }
}

fn tools_for_role(
    role: &termloop_core::session_launch::AgentMcpRole,
    descriptions: &termloop_core::McpToolDescriptions,
) -> Vec<Value> {
    tools_for_role_with(role, |name| descriptions.description(name))
}

fn tools_for_role_with(
    role: &termloop_core::session_launch::AgentMcpRole,
    description: impl Fn(&str) -> Option<String>,
) -> Vec<Value> {
    let allowed = match role {
        termloop_core::session_launch::AgentMcpRole::Interactive => protocol::MCP_INTERACTIVE_TOOLS,
        termloop_core::session_launch::AgentMcpRole::Improver { .. } => {
            protocol::MCP_IMPROVER_TOOLS
        }
        termloop_core::session_launch::AgentMcpRole::Helper { .. } => protocol::MCP_HELPER_TOOLS,
        termloop_core::session_launch::AgentMcpRole::Steward { .. } => protocol::MCP_STEWARD_TOOLS,
        termloop_core::session_launch::AgentMcpRole::Worker { .. } => protocol::MCP_WORKER_TOOLS,
    };
    let definitions: Vec<Value> = serde_json::from_str(protocol::MCP_TOOL_DEFINITIONS_JSON)
        .expect("generated MCP definitions are valid JSON");
    definitions
        .into_iter()
        .filter_map(|mut definition| {
            let name = definition
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| allowed.contains(name))?;
            if let Some(effective) = description(name) {
                definition["description"] = Value::String(effective);
            }
            Some(definition)
        })
        .collect()
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
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(uri) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    uri.authority().is_some_and(|authority| {
        matches!(
            authority.host(),
            "127.0.0.1" | "::1" | "[::1]" | "localhost"
        )
    })
}

fn core_tool_error(id: Value, error: &termloop_core::CoreError) -> Response {
    match error {
        termloop_core::CoreError::CapabilityDenied => {
            tool_error(id, "capabilityDenied", "capability denied", None)
        }
        termloop_core::CoreError::AskToInProgress { request_id, status } => tool_error(
            id,
            "askToInProgress",
            "an Ask-To request or answer delivery is already pending",
            Some(json!({ "requestId": request_id, "status": status })),
        ),
        termloop_core::CoreError::HelperCapacityExhausted => tool_error(
            id,
            "helperCapacityExhausted",
            "live Ask-To helper capacity is exhausted",
            None,
        ),
        termloop_core::CoreError::ConversationUnavailable => tool_error(
            id,
            "conversationUnavailable",
            "Ask-To conversation is unavailable",
            None,
        ),
        termloop_core::CoreError::ConversationBusy => tool_error(
            id,
            "conversationBusy",
            "Ask-To conversation helper is busy",
            None,
        ),
        termloop_core::CoreError::AskToRequestUnavailable => {
            tool_error(id, "requestUnavailable", "Ask-To request unavailable", None)
        }
        termloop_core::CoreError::AskToRequestGone => {
            tool_error(id, "requestGone", "the asker Session is gone", None)
        }
        termloop_core::CoreError::AskToAlreadyReplied => tool_error(
            id,
            "alreadyCompleted",
            "Ask-To request already has a different answer",
            None,
        ),
        termloop_core::CoreError::AgentUnsupported => {
            tool_error(id, "helperUnavailable", "helper agent is unavailable", None)
        }
        termloop_core::CoreError::TaskAgentStartFailed {
            stage,
            retryable,
            suggested_action,
            observed_branches,
        } => tool_error(
            id,
            "taskAgentStartFailed",
            "Task Agent start did not complete",
            Some(json!({
                "stage": match stage {
                    termloop_core::TaskAgentStartStage::Planning => "planning",
                    termloop_core::TaskAgentStartStage::WorktreeProvision => "worktreeProvision",
                    termloop_core::TaskAgentStartStage::AgentLaunch => "agentLaunch",
                    termloop_core::TaskAgentStartStage::AssignmentDelivery => "assignmentDelivery",
                },
                "retryable": retryable,
                "suggestedAction": match suggested_action {
                    termloop_core::TaskAgentStartSuggestedAction::ChooseBaseBranch => "chooseBaseBranch",
                    termloop_core::TaskAgentStartSuggestedAction::ConfigureAgent => "configureAgent",
                    termloop_core::TaskAgentStartSuggestedAction::Retry => "retry",
                    termloop_core::TaskAgentStartSuggestedAction::InspectTask => "inspectTask",
                },
                "observedBranches": observed_branches,
            })),
        ),
        termloop_core::CoreError::TaskAgentAlreadyAttached {
            task_id,
            session_id,
        } => tool_error(
            id,
            "taskAgentStartFailed",
            "Task already has a current Agent; send the assignment to that Session with agent_message_send",
            Some(json!({
                "taskId": task_id,
                "sessionId": session_id,
                "suggestedAction": "messageExistingAgent",
            })),
        ),
        termloop_core::CoreError::TaskJiraUrlAlreadySet { task_id, jira_url } => tool_error(
            id,
            "jiraUrlAlreadySet",
            "Task already has a Jira URL",
            Some(json!({ "taskId": task_id, "jiraUrl": jira_url })),
        ),
        termloop_core::CoreError::CompanionProposalPending {
            proposal_message_id,
        } => tool_error(
            id,
            "proposalPending",
            "another Steward proposal is awaiting the user's decision; do not retry or send the proposed action as attention",
            Some(json!({ "proposalMessageId": proposal_message_id })),
        ),
        termloop_core::CoreError::InvalidParams(_) => {
            tool_error(id, "invalidArguments", "invalid arguments", None)
        }
        termloop_core::CoreError::TrackerReportStale => tool_error(
            id,
            "staleCheck",
            "Routine check expired or changed; call worker_get_next_routine again",
            None,
        ),
        termloop_core::CoreError::TrackerReportInvalid => {
            tool_error(id, "invalidReport", "Routine report is invalid", None)
        }
        _ => tool_error(id, "operationFailed", "TermLoop MCP operation failed", None),
    }
}

fn tool_success(id: Value, value: Value) -> Response {
    let text = serde_json::to_string(&value).expect("tool result is serializable");
    json_rpc_result(
        id,
        json!({
            "content": [{ "type": "text", "text": text }],
            "structuredContent": value,
            "isError": false
        }),
    )
}

fn tool_error(id: Value, code: &str, message: &str, details: Option<Value>) -> Response {
    let structured = json!({ "code": code, "message": message, "details": details });
    let _: protocol::McpToolError = serde_json::from_value(structured.clone())
        .expect("server MCP errors must match the generated typed error schema");
    json_rpc_result(
        id,
        json!({
            "content": [{ "type": "text", "text": serde_json::to_string(&structured).expect("tool error is serializable") }],
            "structuredContent": structured,
            "isError": true
        }),
    )
}

fn json_rpc_result(id: Value, result: Value) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
    )
        .into_response()
}

fn json_rpc_error(id: Value, code: i64, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn response_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), MAX_MCP_MESSAGE)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn tool_names(tools: &[Value]) -> Vec<&str> {
        tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect()
    }

    #[test]
    fn only_a_step_claim_invalidates_the_playbook_processing_projection() {
        assert_eq!(
            worker_claim_invalidation_topics(
                &json!({"status":"assigned","step":{"tasks":[{"taskId":"task-1"}]}})
            ),
            vec![ProjectionTopic::Playbook]
        );
        assert!(worker_claim_invalidation_topics(&json!({"status":"assigned"})).is_empty());
        assert!(worker_claim_invalidation_topics(&json!({"status":"idle"})).is_empty());
    }

    #[test]
    fn generated_tools_are_role_scoped_and_not_control_methods() {
        let descriptions = termloop_core::McpToolDescriptions::default();
        let asker = tools_for_role(
            &termloop_core::session_launch::AgentMcpRole::Interactive,
            &descriptions,
        );
        let helper = tools_for_role(
            &termloop_core::session_launch::AgentMcpRole::Helper {
                request_id: Some("request-1".into()),
            },
            &descriptions,
        );
        let improver = tools_for_role(
            &termloop_core::session_launch::AgentMcpRole::Improver {
                target: termloop_core::ImproverSessionTarget {
                    target_kind: termloop_core::ImproverSessionTargetKind::Playbook,
                    target_id: None,
                },
            },
            &descriptions,
        );
        let steward = tools_for_role(
            &termloop_core::session_launch::AgentMcpRole::Steward {
                project_id: "project-1".into(),
            },
            &descriptions,
        );
        let worker = tools_for_role(
            &termloop_core::session_launch::AgentMcpRole::Worker {
                project_id: "project-1".into(),
                worker_id: "worker-1".into(),
            },
            &descriptions,
        );
        assert_eq!(tool_names(&asker), ["ask_to", "send_to_agent"]);
        assert_eq!(
            tool_names(&helper),
            ["ask_to", "send_to_agent", "reply_to_request"]
        );
        assert_eq!(
            tool_names(&improver),
            [
                "ask_to",
                "send_to_agent",
                "configuration_version_read",
                "configuration_version_write"
            ]
        );
        assert!(!tool_names(&improver).contains(&"task_create"));
        assert!(tool_names(&steward).contains(&"task_create"));
        assert!(tool_names(&steward).contains(&"send_to_agent"));
        assert!(tool_names(&steward).contains(&"task_agent_start"));
        let task_agent_start = steward
            .iter()
            .find(|tool| tool["name"] == "task_agent_start")
            .unwrap();
        assert_eq!(task_agent_start["inputSchema"]["type"], "object");
        assert!(task_agent_start["inputSchema"]["allOf"].is_null());
        assert!(task_agent_start["inputSchema"]["properties"]["taskId"].is_object());
        assert!(task_agent_start["inputSchema"]["properties"]["assignment"].is_object());
        assert!(tool_names(&steward).contains(&"task_set_jira_url"));
        assert!(tool_names(&steward).contains(&"steward_system_prompt_read"));
        assert!(tool_names(&steward).contains(&"steward_system_prompt_update"));
        assert!(tool_names(&steward).contains(&"task_delete"));
        assert!(tool_names(&steward).contains(&"agent_message_send"));
        assert!(tool_names(&steward).contains(&"steward_suggest"));
        let steward_suggest = steward
            .iter()
            .find(|tool| tool["name"] == "steward_suggest")
            .unwrap();
        assert_eq!(
            steward_suggest["inputSchema"]["properties"]["kind"]["enum"],
            json!([
                "reply",
                "update",
                "attention",
                "problem",
                "suggestion",
                "proposal"
            ])
        );
        assert!(
            steward_suggest["description"]
                .as_str()
                .unwrap()
                .contains("user's own action")
        );
        assert!(
            steward_suggest["description"]
                .as_str()
                .unwrap()
                .contains("never for status")
        );
        assert!(
            steward_suggest["description"]
                .as_str()
                .unwrap()
                .contains("proposalPending")
        );
        let finding_refs = &steward_suggest["inputSchema"]["properties"]["refs"]["properties"];
        assert!(
            finding_refs["routineFindingId"]["description"]
                .as_str()
                .unwrap()
                .contains("exact findings[].id")
        );
        assert_eq!(finding_refs["routineFindingIds"]["maxItems"], 16);
        assert_eq!(finding_refs["routineFindingIds"]["uniqueItems"], true);
        assert!(tool_names(&steward).contains(&"routine_finding_read"));
        assert!(tool_names(&steward).contains(&"routine_finding_resolve"));
        assert!(tool_names(&steward).contains(&"playbook_read"));
        assert!(tool_names(&steward).contains(&"task_set_steward_brief"));
        assert!(!tool_names(&worker).contains(&"playbook_read"));
        assert!(!tool_names(&worker).contains(&"routine_finding_resolve"));
        assert!(!tool_names(&worker).contains(&"task_set_steward_brief"));
        assert!(!tool_names(&asker).contains(&"playbook_read"));
        assert!(!tool_names(&helper).contains(&"task_set_steward_brief"));
        assert!(!tool_names(&steward).contains(&"ask_to"));
        assert!(!tool_names(&steward).contains(&"worker_complete_routine"));
        assert!(tool_names(&worker).contains(&"worker_complete_routine"));
        let task_read = worker
            .iter()
            .find(|tool| tool["name"] == "task_read")
            .unwrap();
        assert!(task_read["inputSchema"]["properties"]["taskId"].is_object());
        assert!(task_read["inputSchema"]["properties"]["checkId"].is_object());
        assert_eq!(task_read["annotations"]["readOnlyHint"], true);
        assert_eq!(task_read["annotations"]["openWorldHint"], true);
        assert!(
            task_read["description"]
                .as_str()
                .is_some_and(|description| description.contains("successful scoped read"))
        );
        assert!(tool_names(&worker).contains(&"task_agent_transcript_tail_read"));
        assert!(!tool_names(&steward).contains(&"task_agent_transcript_tail_read"));
        assert!(tool_names(&worker).contains(&"task_agent_request"));
        assert!(!tool_names(&steward).contains(&"task_agent_request"));
        assert!(!tool_names(&worker).contains(&"send_to_agent"));
        assert!(tool_names(&worker).contains(&"worker_report_routine_problem"));
        assert!(!tool_names(&worker).contains(&"ask_to"));
        assert!(!tool_names(&worker).contains(&"task_create"));
        assert!(!tool_names(&worker).contains(&"task_agent_start"));
        assert!(!tool_names(&worker).contains(&"task_set_jira_url"));
        assert!(!tool_names(&worker).contains(&"steward_system_prompt_read"));
        assert!(!tool_names(&worker).contains(&"steward_system_prompt_update"));
        assert!(
            protocol::MCP_TOOLS
                .iter()
                .all(|tool| !protocol::METHODS.contains(tool))
        );
        let send_to_agent = asker
            .iter()
            .find(|tool| tool["name"] == "send_to_agent")
            .unwrap();
        assert!(asker[0]["inputSchema"]["properties"]["idempotencyKey"].is_object());
        assert!(send_to_agent["inputSchema"]["properties"]["sessionId"].is_object());
        assert!(
            asker[0]["description"]
                .as_str()
                .is_some_and(|description| description.contains("never substitute"))
        );
        assert!(
            send_to_agent["description"].as_str().is_some_and(
                |description| description.contains("any Project, Task, checkout, or worktree")
            )
        );
        assert!(
            send_to_agent["description"]
                .as_str()
                .is_some_and(|description| description.contains(
                    "visible `builtin.steward.task-assignment` explicitly supplies the exact Steward Session ID"
                ))
        );
        let task_agent_request = worker
            .iter()
            .find(|tool| tool["name"] == "task_agent_request")
            .unwrap();
        assert!(task_agent_request["inputSchema"]["properties"]["checkId"].is_object());
        assert!(task_agent_request["inputSchema"]["properties"]["taskId"].is_object());
        assert!(task_agent_request["inputSchema"]["properties"]["sessionId"].is_object());
        assert_eq!(task_agent_request["annotations"]["readOnlyHint"], false);
        assert!(
            task_agent_request["description"]
                .as_str()
                .is_some_and(|description| description.contains("may return one visible handoff"))
        );
    }

    #[test]
    fn effective_description_overlay_changes_no_other_generated_field() {
        let role = termloop_core::session_launch::AgentMcpRole::Interactive;
        let canonical = tools_for_role_with(&role, |_| None);
        let effective = tools_for_role_with(&role, |name| {
            (name == "ask_to").then(|| "Customized description".to_owned())
        });
        assert_eq!(effective[0]["description"], "Customized description");
        let mut expected = canonical[0].clone();
        expected["description"] = json!("Customized description");
        assert_eq!(effective[0], expected);
    }

    #[test]
    fn step_verdict_wake_preserves_movement_and_unresolved_waiting_findings() {
        assert_eq!(
            step_verdict_wake(&json!({ "passedCount": 1, "stewardReviewRequired": false })),
            Some(protocol::CompanionWakeReason::PipelineMoved)
        );
        assert_eq!(
            step_verdict_wake(&json!({ "passedCount": 0, "stewardReviewRequired": true })),
            Some(protocol::CompanionWakeReason::RoutineFinding)
        );
        assert_eq!(
            step_verdict_wake(&json!({ "passedCount": 1, "stewardReviewRequired": true })),
            Some(protocol::CompanionWakeReason::PipelineMovedAndRoutineFinding)
        );
        assert_eq!(step_verdict_wake(&json!({})), None);
    }

    #[test]
    fn routine_finding_wake_supports_novel_and_recoverable_findings() {
        assert_eq!(
            routine_finding_wake(&json!({ "newPendingFindingCount": 1 })),
            Some(protocol::CompanionWakeReason::RoutineFinding)
        );
        assert_eq!(
            routine_finding_wake(&json!({ "newPendingFindingCount": 0 })),
            None
        );
        assert_eq!(
            routine_finding_wake(&json!({
                "newPendingFindingCount": 0,
                "stewardReviewRequired": true
            })),
            Some(protocol::CompanionWakeReason::RoutineFinding)
        );
        assert_eq!(routine_finding_wake(&json!({})), None);
    }

    #[test]
    fn worker_completion_names_when_a_newer_user_context_won() {
        assert_eq!(
            worker_routine_completion_status(&json!({ "contextMarkdownApplied": false })),
            "completedContextPreserved"
        );
        assert_eq!(
            worker_routine_completion_status(&json!({ "contextMarkdownApplied": true })),
            "completed"
        );
    }

    #[test]
    fn generated_tool_validation_rejects_unknown_or_oversized_input() {
        assert!(protocol::validate_mcp_tool_params(
            "ask_to",
            &json!({ "target": "claude", "message": "review", "idempotencyKey": "retry" })
        ));
        assert!(!protocol::validate_mcp_tool_params(
            "ask_to",
            &json!({ "target": "gemini", "message": "review" })
        ));
        assert!(protocol::validate_mcp_tool_params(
            "send_to_agent",
            &json!({
                "sessionId": "123e4567-e89b-42d3-a456-426614174000",
                "message": "Review the current diff."
            })
        ));
        assert!(!protocol::validate_mcp_tool_params(
            "send_to_agent",
            &json!({ "sessionId": "the first Codex", "message": "review" })
        ));
        let maximum_escaped_message = "\u{001f}".repeat(32_768);
        let envelope = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "reply_to_request",
                "arguments": { "requestId": "request-1", "message": maximum_escaped_message }
            }
        }))
        .unwrap();
        assert!(envelope.len() <= MAX_MCP_MESSAGE);
        assert!(!protocol::validate_mcp_tool_params(
            "ask_result",
            &json!({ "requestId": "id", "waitSeconds": 1 })
        ));
        assert!(protocol::validate_mcp_tool_params(
            "task_set_jira_url",
            &json!({
                "taskId": "task-1",
                "jiraUrl": "https://example.atlassian.net/browse/TERM-42"
            })
        ));
        assert!(!protocol::validate_mcp_tool_params(
            "task_set_jira_url",
            &json!({ "taskId": "task-1", "jiraUrl": "TERM-42" })
        ));
        assert!(protocol::validate_mcp_tool_params("task_read", &json!({})));
        assert!(protocol::validate_mcp_tool_params(
            "task_read",
            &json!({ "taskId": "task-1", "checkId": "check-1" })
        ));
        assert!(!protocol::validate_mcp_tool_params(
            "task_read",
            &json!({ "taskId": "task-1", "branch": "guessed" })
        ));
        assert!(protocol::validate_mcp_tool_params(
            "task_agent_transcript_tail_read",
            &json!({ "taskId": "task-1" })
        ));
        assert!(!protocol::validate_mcp_tool_params(
            "task_agent_transcript_tail_read",
            &json!({ "taskId": "task-1", "sessionId": "session-1" })
        ));
        assert!(protocol::validate_mcp_tool_params(
            "task_agent_request",
            &json!({
                "checkId": "check-1",
                "taskId": "task-1",
                "sessionId": "123e4567-e89b-42d3-a456-426614174001",
                "message": "Investigate the exact merged behavior and return correlation evidence."
            })
        ));
        assert!(!protocol::validate_mcp_tool_params(
            "task_agent_request",
            &json!({
                "checkId": "check-1",
                "taskId": "task-1",
                "sessionId": "another-task-agent",
                "message": "Investigate it."
            })
        ));
        assert!(protocol::validate_mcp_tool_params(
            "steward_system_prompt_update",
            &json!({
                "userMessageId": "project-1:7",
                "expectedSystemPrompt": "Existing PM guidance.",
                "systemPrompt": "Be concise."
            })
        ));
        assert!(protocol::validate_mcp_tool_params(
            "steward_system_prompt_update",
            &json!({
                "userMessageId": "project-1:8",
                "expectedSystemPrompt": "Existing PM guidance.",
                "systemPrompt": ""
            })
        ));
        assert!(!protocol::validate_mcp_tool_params(
            "steward_system_prompt_update",
            &json!({
                "expectedSystemPrompt": "Existing PM guidance.",
                "systemPrompt": "Missing user provenance."
            })
        ));
    }

    #[test]
    fn scoped_task_read_combines_task_owned_delivery_evidence() {
        let projection = task_read_projection(
            json!({
                "id": "task-1",
                "branch": { "name": "termloop/exact" },
                "worktree_health": { "checked_out_branch": "termloop/current" }
            }),
            json!([{ "task_id": "task-1", "count": 2, "freshness": "fresh" }]),
            json!([{
                "taskId": "task-1",
                "matches": [
                    { "number": 43, "base_branch": "master" },
                    { "number": 42, "base_branch": "development" }
                ]
            }]),
            json!([{ "sessionId": "agent-1", "status": "idle" }]),
            json!({
                "state": "selected",
                "sessionId": "agent-1",
                "reason": "soleCurrentTaskAgent",
                "candidateSessionIds": ["agent-1"]
            }),
        );
        assert_eq!(projection["task"]["id"], "task-1");
        assert_eq!(projection["task"]["branch"]["name"], "termloop/exact");
        assert_eq!(projection["effectiveBranch"], "termloop/current");
        assert_eq!(projection["branchCommitSummary"]["count"], 2);
        assert_eq!(projection["pullRequest"]["matches"][0]["number"], 43);
        assert_eq!(
            projection["pullRequestCandidatesByBaseBranch"][0]["baseBranch"],
            "development"
        );
        assert_eq!(
            projection["pullRequestCandidatesByBaseBranch"][0]["matches"][0]["number"],
            42
        );
        assert_eq!(
            projection["pullRequestCandidatesByBaseBranch"][1]["baseBranch"],
            "master"
        );
        assert_eq!(projection["agentStatuses"][0]["sessionId"], "agent-1");
        assert_eq!(projection["coordinationAgent"]["sessionId"], "agent-1");
        assert_eq!(
            projection["evidenceSemantics"]["agentPlan"],
            "agentReportedClaimNotIndependentlyVerified"
        );
        assert_eq!(
            projection["evidenceSemantics"]["pullRequest"],
            "providerProjectionUseExactHeadBaseMergeCommitAndFreshness"
        );

        let fallback = task_read_projection(
            json!({ "id": "task-2", "branch": { "name": "termloop/fallback" } }),
            json!([]),
            json!([]),
            json!([]),
            json!({ "state": "none", "sessionId": null }),
        );
        assert_eq!(fallback["effectiveBranch"], "termloop/fallback");
        let unavailable = task_read_projection(
            json!({ "id": "task-3" }),
            json!([]),
            json!([]),
            json!([]),
            json!({ "state": "none", "sessionId": null }),
        );
        assert!(unavailable["effectiveBranch"].is_null());
        assert!(unavailable["branchCommitSummary"].is_null());
        assert!(unavailable["pullRequest"].is_null());
        assert_eq!(unavailable["pullRequestCandidatesByBaseBranch"], json!([]));
    }

    #[test]
    fn pull_request_reads_take_ids_from_the_current_paginated_task_shape() {
        assert_eq!(
            task_ids_from_list(&json!({
                "items": [{ "id": "task-1" }, { "id": "task-2" }],
                "next_cursor": null,
            })),
            ["task-1", "task-2"]
        );
        assert!(task_ids_from_list(&json!([])).is_empty());
    }

    #[tokio::test]
    async fn jira_url_replacement_returns_the_typed_append_only_error() {
        let response = response_json(core_tool_error(
            json!(7),
            &termloop_core::CoreError::TaskJiraUrlAlreadySet {
                task_id: "task-1".into(),
                jira_url: "https://example.atlassian.net/browse/TERM-42".into(),
            },
        ))
        .await;
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"],
            json!({
                "code": "jiraUrlAlreadySet",
                "message": "Task already has a Jira URL",
                "details": {
                    "taskId": "task-1",
                    "jiraUrl": "https://example.atlassian.net/browse/TERM-42"
                }
            })
        );
    }

    #[tokio::test]
    async fn existing_task_agent_error_returns_the_exact_reuse_action() {
        let response = response_json(core_tool_error(
            json!(9),
            &termloop_core::CoreError::TaskAgentAlreadyAttached {
                task_id: "task-1".into(),
                session_id: "123e4567-e89b-42d3-a456-426614174000".into(),
            },
        ))
        .await;
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"],
            json!({
                "code": "taskAgentStartFailed",
                "message": "Task already has a current Agent; send the assignment to that Session with agent_message_send",
                "details": {
                    "taskId": "task-1",
                    "sessionId": "123e4567-e89b-42d3-a456-426614174000",
                    "suggestedAction": "messageExistingAgent"
                }
            })
        );
    }

    #[tokio::test]
    async fn pending_proposal_tells_the_steward_not_to_retry_or_downgrade() {
        let response = response_json(core_tool_error(
            json!(8),
            &termloop_core::CoreError::CompanionProposalPending {
                proposal_message_id: "project-1:21".into(),
            },
        ))
        .await;
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"],
            json!({
                "code": "proposalPending",
                "message": "another Steward proposal is awaiting the user's decision; do not retry or send the proposed action as attention",
                "details": { "proposalMessageId": "project-1:21" }
            })
        );
    }

    #[tokio::test]
    async fn stale_worker_claim_tells_the_worker_to_claim_again() {
        let response = response_json(core_tool_error(
            json!(8),
            &termloop_core::CoreError::TrackerReportStale,
        ))
        .await;
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"],
            json!({
                "code": "staleCheck",
                "message": "Routine check expired or changed; call worker_get_next_routine again",
                "details": null
            })
        );
    }

    #[tokio::test]
    async fn initialization_negotiates_only_the_measured_revision_set() {
        let role = termloop_core::session_launch::AgentMcpRole::Interactive;
        for version in MCP_PROTOCOLS {
            let response = response_json(initialize(
                json!(1),
                json!({ "protocolVersion": version }),
                &role,
            ))
            .await;
            assert_eq!(response["result"]["protocolVersion"], *version);
            assert!(
                response["result"]["instructions"]
                    .as_str()
                    .is_some_and(|instructions| instructions.contains("Interactive Session"))
            );
        }
        let unsupported = response_json(initialize(
            json!(2),
            json!({ "protocolVersion": "2026-07-28" }),
            &role,
        ))
        .await;
        assert_eq!(unsupported["error"]["code"], -32602);
        let missing = response_json(initialize(json!(3), json!({}), &role)).await;
        assert_eq!(missing["error"]["code"], -32602);
    }

    #[test]
    fn protocol_header_compatibility_and_origin_checks_are_explicit() {
        let mut headers = HeaderMap::new();
        assert!(supported_protocol_header(&headers));
        headers.insert(MCP_PROTOCOL_HEADER, "2025-06-18".parse().unwrap());
        assert!(supported_protocol_header(&headers));
        headers.insert(MCP_PROTOCOL_HEADER, "2026-07-28".parse().unwrap());
        assert!(!supported_protocol_header(&headers));
        headers.insert(header::ORIGIN, "https://example.com".parse().unwrap());
        assert!(!origin_allowed(&headers));
        headers.insert(header::ORIGIN, "http://127.0.0.1:43123".parse().unwrap());
        assert!(origin_allowed(&headers));
    }
}
