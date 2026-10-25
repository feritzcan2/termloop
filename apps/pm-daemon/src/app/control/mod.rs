//! The PM control plane: JSON text frames over one WebSocket per client.
//! Every request carries the run's bearer and is authenticated before it is
//! dispatched; events reach only connections that subscribed to them.

use std::collections::{HashMap, HashSet};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use termloop_pm_contract::pm::{
    CONTRACT_IDENTITY, ControlRequest, ControlResponse, ErrorCode, EventName, METHODS,
    PmCancelParams, PmSubscribeParams, validate_method_params, validate_method_result,
};
use tokio::sync::{broadcast, mpsc};

use super::AppState;
use errors::ControlError;
use errors::error;

mod dispatch;
pub(crate) mod errors;
mod operations;

pub(crate) use dispatch::dispatch;

const MAX_CONTROL_MESSAGE: usize = 8 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 64;
const OUTBOUND_QUEUE: usize = 256;
const ID_MAX_BYTES: usize = 128;
const TOKEN_MIN_BYTES: usize = 32;
const TOKEN_MAX_BYTES: usize = 256;

pub(super) async fn control_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // Room for a modestly oversized frame, so the peer gets a typed
    // `requestTooLarge` response rather than a silent close.
    ws.max_message_size(MAX_CONTROL_MESSAGE * 2)
        .on_upgrade(move |socket| control_socket(socket, state))
}

/// Byte comparison whose duration does not depend on where inputs differ.
pub(crate) fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

pub(crate) fn response(id: &str, outcome: Result<Value, ControlError>) -> ControlResponse {
    match outcome {
        Ok(result) => ControlResponse {
            id: id.to_owned(),
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => ControlResponse {
            id: id.to_owned(),
            ok: false,
            result: None,
            error: Some(error.0),
        },
    }
}

fn response_text(response: &ControlResponse) -> String {
    serde_json::to_string(response).unwrap_or_else(|_| {
        r#"{"id":"","ok":false,"error":{"code":"internal","message":"internal error"}}"#.to_owned()
    })
}

fn reject(id: &str, code: ErrorCode, message: &str) -> Box<ControlResponse> {
    Box::new(response(id, Err(error(code, message))))
}

/// Decodes and authenticates one request text. A failure is the response
/// to send back; nothing reaches dispatch unauthenticated.
pub(crate) fn decode_request(
    text: &str,
    token: &str,
) -> Result<ControlRequest, Box<ControlResponse>> {
    if text.len() > MAX_CONTROL_MESSAGE {
        return Err(reject(
            "",
            ErrorCode::RequestTooLarge,
            "control message is too large",
        ));
    }
    let value: Value = serde_json::from_str(text)
        .map_err(|_| reject("", ErrorCode::InvalidMessage, "control message is not JSON"))?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= ID_MAX_BYTES)
        .unwrap_or_default()
        .to_owned();
    if value.get("protocolVersion").and_then(Value::as_str) != Some(CONTRACT_IDENTITY) {
        return Err(reject(
            &id,
            ErrorCode::UnsupportedVersion,
            "unsupported protocol version",
        ));
    }
    let request: ControlRequest = serde_json::from_value(value)
        .map_err(|_| reject(&id, ErrorCode::InvalidMessage, "malformed control request"))?;
    if id.is_empty() {
        return Err(reject(
            "",
            ErrorCode::InvalidMessage,
            "the request id is invalid",
        ));
    }
    let token_shaped = (TOKEN_MIN_BYTES..=TOKEN_MAX_BYTES).contains(&request.token.len());
    if !token_shaped || !constant_time_equal(request.token.as_bytes(), token.as_bytes()) {
        return Err(reject(
            &id,
            ErrorCode::Unauthenticated,
            "the bearer is not valid",
        ));
    }
    if !request.params.is_object() {
        return Err(reject(
            &id,
            ErrorCode::InvalidParams,
            "params must be an object",
        ));
    }
    if !METHODS.contains(&request.method.as_str()) {
        return Err(reject(&id, ErrorCode::MethodNotFound, "unknown method"));
    }
    if !validate_method_params(&request.method, &request.params) {
        return Err(reject(
            &id,
            ErrorCode::InvalidParams,
            "params do not match the method",
        ));
    }
    Ok(request)
}

/// Runs one authenticated request and checks its result against the
/// contract, so a client never receives a result its validator rejects.
pub(crate) async fn run_request(state: &AppState, request: &ControlRequest) -> ControlResponse {
    let outcome = dispatch(state, &request.method, &request.params).await;
    let outcome = outcome.and_then(|result| {
        if validate_method_result(&request.method, &result) {
            Ok(result)
        } else {
            tracing::error!(method = %request.method, "a result fell outside the contract");
            Err(errors::internal())
        }
    });
    response(&request.id, outcome)
}

fn event_name(event: &EventName) -> &'static str {
    match event {
        EventName::PmBoardChanged => "pmBoardChanged",
        EventName::PmAgentChanged => "pmAgentChanged",
        EventName::PmCheckChanged => "pmCheckChanged",
        EventName::PmJiraPulled => "pmJiraPulled",
    }
}

async fn control_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::channel::<String>(OUTBOUND_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(text) = outbound_rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    let mut events = state.events.subscribe();
    let (completed_tx, mut completed_rx) = mpsc::unbounded_channel::<ControlResponse>();
    let mut pending = HashMap::<String, PendingRequest>::new();
    let mut subscribed = HashSet::<&'static str>::new();
    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let text = match message {
                    Message::Text(text) => text,
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Binary(_) => {
                        let reply = response("", Err(error(ErrorCode::InvalidMessage, "control messages must be JSON text")));
                        if outbound.send(response_text(&reply)).await.is_err() { break; }
                        continue;
                    }
                };
                let request = match decode_request(&text, &state.token) {
                    Ok(request) => request,
                    Err(reply) => {
                        if outbound.send(response_text(&reply)).await.is_err() { break; }
                        continue;
                    }
                };
                let immediate = match request.method.as_str() {
                    _ if pending.contains_key(&request.id) => Some(response(&request.id, Err(error(ErrorCode::InvalidMessage, "duplicate in-flight request id")))),
                    "pm_subscribe" => Some(subscribe(&request, &mut subscribed)),
                    "pm_cancel" => Some(cancel(&request, &mut pending)),
                    _ if pending.len() >= MAX_IN_FLIGHT => Some(response(&request.id, Err(error(ErrorCode::ServiceBusy, "too many requests are in flight")))),
                    _ => None,
                };
                if let Some(reply) = immediate {
                    if outbound.send(response_text(&reply)).await.is_err() { break; }
                    continue;
                }
                let task_state = state.clone();
                let task_completed = completed_tx.clone();
                let request_id = request.id.clone();
                let method = request.method.clone();
                let task = tokio::spawn(async move {
                    let reply = run_request(&task_state, &request).await;
                    let _ = task_completed.send(reply);
                });
                pending.insert(request_id, PendingRequest {
                    abort: task.abort_handle(),
                    cancellable: cancellable(&method),
                });
            }
            completed = completed_rx.recv() => {
                let Some(reply) = completed else { break };
                if pending.remove(&reply.id).is_none() {
                    continue;
                }
                if outbound.send(response_text(&reply)).await.is_err() { break; }
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if !subscribed.contains(event_name(&event.event)) {
                    continue;
                }
                let Ok(text) = serde_json::to_string(&event) else { continue };
                if outbound.send(text).await.is_err() { break; }
            }
        }
    }
    // A mutation already under way finishes; only its reply is dropped.
    for request in pending.into_values().filter(|request| request.cancellable) {
        request.abort.abort();
    }
    writer.abort();
}

fn subscribe(request: &ControlRequest, subscribed: &mut HashSet<&'static str>) -> ControlResponse {
    let outcome = serde_json::from_value::<PmSubscribeParams>(request.params.clone())
        .map_err(|_| error(ErrorCode::InvalidParams, "invalid params"))
        .map(|params| {
            subscribed.clear();
            subscribed.extend(params.events.iter().map(event_name));
            json!({ "events": params.events })
        });
    response(&request.id, outcome)
}

struct PendingRequest {
    abort: tokio::task::AbortHandle,
    cancellable: bool,
}

/// Reads may be abandoned midway. A mutation is never aborted between its
/// steps (an agent spawn, a Jira write); it runs to completion.
fn cancellable(method: &str) -> bool {
    matches!(
        method,
        "pm_system_version"
            | "pm_project_list"
            | "pm_board_read"
            | "pm_digest_read"
            | "pm_ticket_versions_read"
            | "pm_ticket_proposals_read"
            | "pm_sources_read"
            | "pm_checks_read"
            | "pm_jira_diff_read"
            | "pm_agent_list"
            | "pm_settings_read"
    )
}

fn cancel(
    request: &ControlRequest,
    pending: &mut HashMap<String, PendingRequest>,
) -> ControlResponse {
    let outcome = serde_json::from_value::<PmCancelParams>(request.params.clone())
        .map_err(|_| error(ErrorCode::InvalidParams, "invalid params"))
        .map(|params| {
            let cancelled = match pending.get(&params.request_id) {
                Some(target) if target.cancellable => {
                    target.abort.abort();
                    pending.remove(&params.request_id);
                    true
                }
                _ => false,
            };
            json!({ "cancelled": cancelled })
        });
    response(&request.id, outcome)
}
