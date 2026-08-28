mod dispatch;
mod errors;
mod handlers;
mod task_source;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use termloop_contract::current as protocol;
use termloop_contract::current::{
    CONTRACT_IDENTITY, ControlCancelParams, ControlCancelResult, ControlEvent, ControlRequest,
    ControlResponse, ErrorCode, EventName, ProjectionInvalidatedPayload, ProjectionTopic,
    TaskProjectionTopic,
};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};
use tokio::time::Duration;
use uuid::Uuid;

use super::AppState;
use super::health::{replace_health_demand, trigger_health_for_projects};
pub(in crate::app) use dispatch::apply_configuration_plan;
use dispatch::{DispatchOutcome, PostResponseAction, dispatch};
use errors::error_response;
pub(super) use handlers::git_host_pull_request_list;
pub(super) use handlers::git_host_pull_request_list_background;
pub(super) use handlers::launch_current_worker;
pub(super) use handlers::reconcile_agent_resumes_after_start;
pub(super) use handlers::task_branch_commit_summary_list;
pub(in crate::app) use handlers::{
    launch_task_session, preview_steward_task_agent_session, preview_task_agent_session,
    project_list_local_branches, provision_task_worktree, terminate_session,
};
pub(in crate::app) use task_source::{
    TaskSourceCredentialPresence, run_deadlines as run_task_source_deadlines,
};

// A complete Playbook replacement can carry 24 active steps plus bounded saved
// pipelines, with separate Worker and Steward instructions on every step. Keep
// the transport bounded, but large enough for the schema's maximum ordinary
// ASCII document instead of silently rejecting valid Builder output at 64 KiB.
pub(in crate::app) const MAX_CONTROL_MESSAGE: usize = 8 * 1024 * 1024;
pub(in crate::app) const MAX_AGENT_OBSERVATION_POST_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONTROL_OUTBOUND_MESSAGES: usize = 64;
const MAX_CONTROL_OUTBOUND_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONTROL_CONNECTION_IN_FLIGHT: usize = 64;
const INVALIDATION_FILTER_LOCK_TIMEOUT: Duration = Duration::from_millis(100);

struct PendingControlRequest {
    abort: tokio::task::AbortHandle,
    cancellation_safe: bool,
    token: String,
}

#[derive(Clone)]
struct ControlOutbound {
    inner: Arc<StdMutex<ControlOutboundState>>,
    notify: Arc<Notify>,
}

struct ControlOutboundState {
    messages: VecDeque<ControlOutboundMessage>,
    bytes: usize,
    closing: bool,
}

struct ControlOutboundMessage {
    text: String,
    sent: Option<oneshot::Sender<()>>,
}

impl ControlOutbound {
    fn new() -> Self {
        Self {
            inner: Arc::new(StdMutex::new(ControlOutboundState {
                messages: VecDeque::new(),
                bytes: 0,
                closing: false,
            })),
            notify: Arc::new(Notify::new()),
        }
    }

    fn queue(&self, message: String) -> bool {
        self.queue_with_receipt(message, None)
    }

    fn queue_with_receipt(&self, message: String, sent: Option<oneshot::Sender<()>>) -> bool {
        let mut inner = self.inner.lock().expect("control outbound queue");
        if inner.closing {
            return false;
        }
        if inner.messages.len() >= MAX_CONTROL_OUTBOUND_MESSAGES
            || inner.bytes.saturating_add(message.len()) > MAX_CONTROL_OUTBOUND_BYTES
        {
            let slow_consumer = error_response(
                "",
                ErrorCode::SlowConsumer,
                "control client is not consuming messages",
            );
            inner.messages.clear();
            inner.bytes = slow_consumer.len();
            inner.messages.push_back(ControlOutboundMessage {
                text: slow_consumer,
                sent: None,
            });
            inner.closing = true;
            drop(inner);
            self.notify.notify_one();
            return false;
        }
        inner.bytes += message.len();
        inner.messages.push_back(ControlOutboundMessage {
            text: message,
            sent,
        });
        drop(inner);
        self.notify.notify_one();
        true
    }

    fn close(&self) {
        self.inner.lock().expect("control outbound queue").closing = true;
        self.notify.notify_one();
    }

    async fn next(&self) -> Option<ControlOutboundMessage> {
        loop {
            let notified = self.notify.notified();
            {
                let mut inner = self.inner.lock().expect("control outbound queue");
                if let Some(message) = inner.messages.pop_front() {
                    inner.bytes = inner.bytes.saturating_sub(message.text.len());
                    return Some(message);
                }
                if inner.closing {
                    return None;
                }
            }
            notified.await;
        }
    }
}

pub(super) async fn control_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // Leave enough room to receive a modestly oversized frame so the peer gets
    // the protocol's typed `requestTooLarge` response instead of a silent close.
    ws.max_message_size(MAX_CONTROL_MESSAGE * 2)
        .on_upgrade(move |socket| {
            control_socket(socket, state, ConnectionOrigin::LocalEpoch, None, None)
        })
}

pub(super) async fn agent_observation_post(
    State(state): State<AppState>,
    body: Bytes,
) -> impl IntoResponse {
    let response = match decode_agent_observation_post(&body) {
        Err(response) => response,
        Ok(request) => {
            let Some(admission) = state.runtime_health.try_admit_control() else {
                return json_control_response(error_response(
                    &request.id,
                    ErrorCode::ServiceBusy,
                    "control service is busy",
                ));
            };
            let outcome = {
                let _admission = admission;
                dispatch(request, &state, ConnectionOrigin::LocalEpoch, None).await
            };
            debug_assert!(outcome.subscription.is_none());
            debug_assert!(outcome.project_demands.is_none());
            if let Some(action) = outcome.post_response {
                let action_state = state.clone();
                tokio::spawn(async move {
                    run_post_response_action(action, action_state).await;
                });
            }
            outcome.response
        }
    };
    json_control_response(response)
}

fn json_control_response(response: String) -> impl IntoResponse {
    ([(CONTENT_TYPE, "application/json")], response)
}

fn decode_agent_observation_post(body: &[u8]) -> Result<ControlRequest, String> {
    if body.len() > MAX_AGENT_OBSERVATION_POST_BYTES {
        return Err(error_response(
            "",
            ErrorCode::RequestTooLarge,
            "agent observation request too large",
        ));
    }
    let text = std::str::from_utf8(body).map_err(|_| invalid_control_request(""))?;
    let request = decode_control_text(text)?;
    if request.method != "agent.observe" {
        return Err(error_response(
            &request.id,
            ErrorCode::CapabilityDenied,
            "agent observation endpoint only allows agent.observe",
        ));
    }
    Ok(request)
}

pub(in crate::app) async fn control_socket(
    socket: WebSocket,
    state: AppState,
    origin: ConnectionOrigin,
    remote_credential: Option<RemoteControlCredential>,
    mut revocation: Option<super::access_plane::RemoteRevocation>,
) {
    let demand_owner = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();
    let outbound = ControlOutbound::new();
    let writer_outbound = outbound.clone();
    let mut writer = tokio::spawn(async move {
        while let Some(message) = writer_outbound.next().await {
            if sink.send(Message::Text(message.text.into())).await.is_err() {
                break;
            }
            if let Some(sent) = message.sent {
                let _ = sent.send(());
            }
        }
    });
    let mut invalidations = state.invalidations.subscribe();
    let (completed_tx, mut completed_rx) = mpsc::unbounded_channel::<(String, DispatchOutcome)>();
    let mut pending = HashMap::<String, PendingControlRequest>::new();
    let mut subscribed_topics: Option<Vec<ProjectionTopic>> = None;
    let mut subscribed_projects = Vec::<String>::new();
    loop {
        tokio::select! {
            _ = wait_for_remote_revocation(&mut revocation) => break,
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let decoded = match message {
                    Message::Text(text) => decode_control_text(&text),
                    _ => Err(error_response("", ErrorCode::InvalidMessage, "control messages must be JSON text")),
                };
                let request = match decoded {
                    Ok(request) => request,
                    Err(response) => {
                        if !queue_control_message(&outbound, response) { break; }
                        continue;
                    }
                };
                if pending.contains_key(&request.id) {
                    if !queue_control_message(&outbound, error_response(&request.id, ErrorCode::InvalidMessage, "duplicate in-flight request id")) { break; }
                    continue;
                }
                if request.method == "control.cancel" {
                    let response = cancel_control_request(
                        request,
                        &state,
                        origin,
                        remote_credential.as_ref(),
                        &mut pending,
                    );
                    if !queue_control_message(&outbound, response) { break; }
                    continue;
                }
                if pending.len() >= MAX_CONTROL_CONNECTION_IN_FLIGHT {
                    if !queue_control_message(&outbound, error_response(&request.id, ErrorCode::ServiceBusy, "too many requests are already in flight on this connection")) { break; }
                    continue;
                }
                let Some(admission) = state.runtime_health.try_admit_control() else {
                    if !queue_control_message(&outbound, error_response(&request.id, ErrorCode::ServiceBusy, "control service is busy")) { break; }
                    continue;
                };
                let request_id = request.id.clone();
                let cancellation_safe = cancellation_safe_method(&request.method);
                let token = request.token.clone();
                let task_state = state.clone();
                let task_completed = completed_tx.clone();
                let task_request_id = request_id.clone();
                let task_remote_credential = remote_credential.clone();
                let task = tokio::spawn(async move {
                    let _admission = admission;
                    let response = dispatch(
                        request,
                        &task_state,
                        origin,
                        task_remote_credential.as_ref(),
                    )
                    .await;
                    let _ = task_completed.send((task_request_id, response));
                });
                pending.insert(request_id, PendingControlRequest {
                    abort: task.abort_handle(),
                    cancellation_safe,
                    token,
                });
                drop(task);
            }
            completed = completed_rx.recv() => {
                let Some((request_id, response)) = completed else { break };
                if pending.remove(&request_id).is_none() {
                    continue;
                }
                if let Some(topics) = response.subscription {
                    subscribed_topics = Some(topics);
                }
                if let Some(projects) = response.project_demands {
                    subscribed_projects = projects.clone();
                    replace_health_demand(&state, demand_owner, &projects).await;
                    trigger_health_for_projects(&state, &projects).await;
                }
                let queued = match response.post_response {
                    Some(action) => {
                        let (sent, delivered) = oneshot::channel();
                        let queued = outbound.queue_with_receipt(response.response, Some(sent));
                        if queued {
                            let action_state = state.clone();
                            tokio::spawn(async move {
                                if delivered.await.is_ok() {
                                    run_post_response_action(action, action_state).await;
                                }
                            });
                        }
                        queued
                    }
                    None => queue_control_message(&outbound, response.response),
                };
                if !queued {
                    break;
                }
            }
            invalidation = invalidations.recv() => {
                let mut payload = match invalidation {
                    Ok(payload) => payload,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        ProjectionInvalidatedPayload {
                            topics: vec![ProjectionTopic::Project, ProjectionTopic::Task, ProjectionTopic::Session, ProjectionTopic::AgentStatus, ProjectionTopic::GitHost, ProjectionTopic::BranchCommit, ProjectionTopic::Companion, ProjectionTopic::Steward, ProjectionTopic::Worker, ProjectionTopic::Routine, ProjectionTopic::KeepAwake],
                            state_revision: state.core_projection.state_revision(),
                            observation_sequence: state.core_projection.observation_sequence(),
                            entity_scopes: None,
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let Some(topics) = &subscribed_topics else { continue };
                if !payload.topics.iter().any(|topic| topics.contains(topic)) {
                    continue;
                }
                if payload.entity_scopes.is_some() {
                    match tokio::time::timeout(
                        INVALIDATION_FILTER_LOCK_TIMEOUT,
                        state.core.lock(),
                    ).await {
                        Ok(core) => {
                            let scopes = payload
                                .entity_scopes
                                .as_mut()
                                .expect("entity scopes were checked above");
                            for scope in scopes.iter_mut() {
                                if matches!(
                                    scope.topic,
                                    TaskProjectionTopic::Task
                                        | TaskProjectionTopic::GitHost
                                        | TaskProjectionTopic::BranchCommit
                                ) {
                                    scope.ids = core.filter_task_ids_for_projects(
                                        &scope.ids,
                                        &subscribed_projects,
                                    );
                                }
                            }
                            scopes.retain(|scope| !scope.ids.is_empty());
                            if scopes.is_empty() {
                                continue;
                            }
                        }
                        // A broad invalidation is safe and keeps the client
                        // convergent when the optional project filter cannot
                        // acquire Core promptly. Dropping the event could leave
                        // the projection stale until an unrelated mutation.
                        Err(_) => payload.entity_scopes = None,
                    }
                }
                let event = ControlEvent {
                    protocol_version: CONTRACT_IDENTITY.to_owned(),
                    event: EventName::ProjectionInvalidated,
                    payload: serde_json::to_value(payload).expect("invalidation payload is serializable"),
                };
                if !queue_control_message(
                    &outbound,
                    serde_json::to_string(&event).expect("control event is serializable"),
                ) {
                    break;
                }
            }
        }
    }
    for request in pending.into_values() {
        if request.cancellation_safe {
            request.abort.abort();
        }
    }
    let registry = state.health_demands.clone().lock_owned().await;
    if let Err(error) = tokio::task::spawn_blocking(move || {
        let mut registry = registry;
        registry.remove(demand_owner);
    })
    .await
    {
        tracing::error!(%error, "health demand removal worker failed");
    }
    outbound.close();
    if tokio::time::timeout(Duration::from_secs(1), &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }
}

async fn wait_for_remote_revocation(
    revocation: &mut Option<super::access_plane::RemoteRevocation>,
) {
    match revocation {
        Some(revocation) => revocation.wait().await,
        None => std::future::pending::<()>().await,
    }
}

fn cancel_control_request(
    request: ControlRequest,
    state: &AppState,
    origin: ConnectionOrigin,
    remote_credential: Option<&RemoteControlCredential>,
    pending: &mut HashMap<String, PendingControlRequest>,
) -> String {
    let scope = dispatch::request_scope(&request, state, remote_credential);
    if request.id.is_empty() || request.id.len() > 128 {
        return error_response(&request.id, ErrorCode::InvalidMessage, "invalid request id");
    }
    if request.token.len() < 32 || request.token.len() > 256 || scope.is_none() {
        return error_response(
            &request.id,
            ErrorCode::Unauthenticated,
            "invalid credential",
        );
    }
    if !protocol::validate_method_params(&request.method, &request.params) {
        return error_response(
            &request.id,
            ErrorCode::InvalidMessage,
            "params do not match the method schema",
        );
    }
    if !scope.is_some_and(|scope| scope_allows_method(scope, &request.method)) {
        return error_response(
            &request.id,
            ErrorCode::CapabilityDenied,
            "credential does not allow this method",
        );
    }
    if !origin_allows_method(origin, &request.method) {
        return error_response(
            &request.id,
            ErrorCode::CapabilityDenied,
            "connection origin does not allow this method",
        );
    }
    let params = serde_json::from_value::<ControlCancelParams>(request.params)
        .expect("validated control cancellation params");
    let cancellable = abort_pending_control_request(pending, &params.request_id, &request.token);
    if cancellable {
        state.runtime_health.record_control_cancelled();
    }
    serde_json::to_string(&ControlResponse {
        id: request.id,
        ok: true,
        result: Some(
            serde_json::to_value(ControlCancelResult {
                cancelled: cancellable,
            })
            .expect("control cancellation result is serializable"),
        ),
        error: None,
    })
    .expect("control cancellation response is serializable")
}

fn abort_pending_control_request(
    pending: &mut HashMap<String, PendingControlRequest>,
    request_id: &str,
    token: &str,
) -> bool {
    let cancellable = pending.get(request_id).is_some_and(|target| {
        target.cancellation_safe && constant_time_equal(target.token.as_bytes(), token.as_bytes())
    });
    if cancellable && let Some(target) = pending.remove(request_id) {
        target.abort.abort();
    }
    cancellable
}

fn queue_control_message(sender: &ControlOutbound, message: String) -> bool {
    sender.queue(message)
}

const PROVIDER_HOOK_EXIT_SETTLE_DELAY: Duration = Duration::from_millis(100);

async fn run_post_response_action(action: PostResponseAction, state: AppState) {
    match action {
        PostResponseAction::DeliverGeneratedInitialInput { session_id } => {
            // The observation response is now being written, so the synchronous
            // provider hook can exit. Give that tiny process boundary a bounded
            // margin before the activation paste reaches the TUI.
            tokio::time::sleep(PROVIDER_HOOK_EXIT_SETTLE_DELAY).await;
            let delivered = {
                let mut core = state.core.lock().await;
                core.deliver_pending_generated_input_after_hook_response(&session_id)
            };
            if let Err(error) = delivered {
                tracing::warn!(%error, %session_id, "failed to deliver generated initial input after provider hook response");
            }
        }
    }
}

fn invalid_control_request(id: &str) -> String {
    error_response(id, ErrorCode::InvalidMessage, "invalid control request")
}

fn decode_control_text(text: &str) -> Result<ControlRequest, String> {
    if text.len() > MAX_CONTROL_MESSAGE {
        return Err(error_response(
            "",
            ErrorCode::RequestTooLarge,
            "control request too large",
        ));
    }
    decode_current_request(text)
}

fn decode_current_request(text: &str) -> Result<ControlRequest, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| invalid_control_request(""))?;
    let Some(object) = value.as_object() else {
        return Err(invalid_control_request(""));
    };
    let response_id = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .map(str::to_owned)
        .unwrap_or_default();
    let Some(identity) = object
        .get("protocolVersion")
        .and_then(serde_json::Value::as_str)
    else {
        return Err(invalid_control_request(&response_id));
    };
    if identity != CONTRACT_IDENTITY {
        return Err(error_response(
            &response_id,
            ErrorCode::UnsupportedVersion,
            "unsupported contract identity",
        ));
    }
    serde_json::from_value(value).map_err(|_| invalid_control_request(&response_id))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::app) enum ClientScope {
    Full,
    ReadOnly,
    Companion,
    Hook,
}

#[derive(Clone)]
pub(in crate::app) struct RemoteControlCredential {
    pub(in crate::app) token: Arc<str>,
    pub(in crate::app) scope: ClientScope,
}

/// The listener and credential class establish authority; peer IP never does.
/// Both Tailscale Serve and SSH local forwarding arrive from loopback, so a
/// future access-plane connection must be tagged explicitly as RemoteDevice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::app) enum ConnectionOrigin {
    LocalEpoch,
    RemoteDevice,
}

fn read_only_method(method: &str) -> bool {
    protocol::READ_ONLY_METHODS.contains(&method)
}

fn companion_method(method: &str) -> bool {
    protocol::COMPANION_METHODS.contains(&method)
}

fn cancellation_safe_method(method: &str) -> bool {
    matches!(
        method,
        "system.version"
            | "system.capabilities"
            | "system.ping"
            | "control.subscribe"
            | "project.list"
            | "task.list"
            | "session.list"
            | "session.listArchived"
            | "session.historyList"
            | "session.historyPreview"
            | "agent.capabilityList"
            | "agent.statusList"
            | "mcp.toolSettingsGet"
            | "steward.configurationGet"
            | "worker.configurationList"
            | "runConfiguration.list"
            | "run.runtimeList"
            | "routine.configurationList"
            | "routine.runtimeList"
            | "taskSource.list"
            | "taskSource.boardList"
            | "taskSource.boardListStored"
            | "taskSource.statusList"
            | "taskSource.statusListStored"
            | "taskSource.candidateList"
            | "playbook.get"
            | "playbook.runtime"
            | "companion.transcriptList"
            | "companion.wakeNext"
            | "task.branchCommitSummaryList"
    )
}

fn scope_allows_method(scope: ClientScope, method: &str) -> bool {
    match scope {
        ClientScope::Full => !matches!(method, "companion.wakeNext" | "companion.stewardWake"),
        ClientScope::ReadOnly => read_only_method(method),
        ClientScope::Companion => companion_method(method),
        ClientScope::Hook => method == "agent.observe",
    }
}

pub(in crate::app) fn origin_allows_method(origin: ConnectionOrigin, method: &str) -> bool {
    match origin {
        ConnectionOrigin::LocalEpoch => true,
        ConnectionOrigin::RemoteDevice => {
            method != "system.shutdown"
                && method != "session.restartAgentsForClientLaunch"
                && !method.starts_with("access.")
        }
    }
}

pub(super) fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..256 {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use termloop_contract::current::ControlResponse;

    fn request_value(identity: serde_json::Value) -> serde_json::Value {
        json!({
            "id": "identity-test",
            "protocolVersion": identity,
            "token": "x".repeat(64),
            "method": "system.ping",
            "params": {}
        })
    }

    fn rejected_request(value: serde_json::Value) -> ControlResponse {
        let response = decode_current_request(&serde_json::to_string(&value).unwrap())
            .expect_err("request must be rejected");
        serde_json::from_str(&response).unwrap()
    }

    #[test]
    fn exact_contract_identity_allows_strict_request_decoding() {
        let request = decode_current_request(
            &serde_json::to_string(&request_value(json!(CONTRACT_IDENTITY))).unwrap(),
        )
        .unwrap();
        assert_eq!(request.protocol_version, CONTRACT_IDENTITY);
        assert_eq!(request.method, "system.ping");
    }

    #[test]
    fn observation_post_is_bounded_and_cannot_dispatch_other_control_methods() {
        let mut observation = request_value(json!(CONTRACT_IDENTITY));
        observation["method"] = json!("agent.observe");
        let observation = serde_json::to_vec(&observation).unwrap();
        assert_eq!(
            decode_agent_observation_post(&observation).unwrap().method,
            "agent.observe"
        );

        let denied = decode_agent_observation_post(
            serde_json::to_string(&request_value(json!(CONTRACT_IDENTITY)))
                .unwrap()
                .as_bytes(),
        )
        .unwrap_err();
        let denied: ControlResponse = serde_json::from_str(&denied).unwrap();
        assert_eq!(denied.error.unwrap().code, ErrorCode::CapabilityDenied);

        let oversized = vec![b' '; MAX_AGENT_OBSERVATION_POST_BYTES + 1];
        let oversized: ControlResponse =
            serde_json::from_str(&decode_agent_observation_post(&oversized).unwrap_err()).unwrap();
        assert_eq!(oversized.error.unwrap().code, ErrorCode::RequestTooLarge);
    }

    #[test]
    fn stale_identity_precedes_request_dto_and_dispatch_fields() {
        let stale = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let mut cases = vec![request_value(json!(stale))];
        cases[0]["params"] = json!([]);

        let mut unknown_field = request_value(json!(stale));
        unknown_field["unexpected"] = json!(true);
        cases.push(unknown_field);

        let mut invalid_credential_and_method = request_value(json!(stale));
        invalid_credential_and_method["token"] = json!("short");
        invalid_credential_and_method["method"] = json!("project.create");
        cases.push(invalid_credential_and_method);

        for value in cases {
            let response = rejected_request(value);
            assert_eq!(response.error.unwrap().code, ErrorCode::UnsupportedVersion);
        }
    }

    #[test]
    fn missing_or_non_string_identity_is_invalid_message() {
        let mut missing = request_value(json!(CONTRACT_IDENTITY));
        missing.as_object_mut().unwrap().remove("protocolVersion");
        let non_string = request_value(json!(42));

        for value in [missing, non_string] {
            let response = rejected_request(value);
            assert_eq!(response.error.unwrap().code, ErrorCode::InvalidMessage);
        }
    }

    #[test]
    fn bounded_complete_playbook_replacement_fits_the_control_transport() {
        let milestone = json!({
            "id": "step",
            "title": "Delivery step",
            "gate": "automatic",
            "check": {
                "kind": "custom",
                "instructions": "w".repeat(8_192),
                "stewardInstructions": "s".repeat(8_192),
                "actionHandling": "ask",
                "workerId": null
            },
            "retryDelaySeconds": 60,
            "condition": "c".repeat(600),
            "approver": "a".repeat(120)
        });
        let milestones = vec![milestone; 24];
        let saved_pipeline = json!({ "name": "Saved pipeline", "milestones": milestones });
        let request = json!({
            "id": "max-playbook",
            "protocolVersion": CONTRACT_IDENTITY,
            "token": "x".repeat(64),
            "method": "playbook.update",
            "params": {
                "projectId": "project",
                "activePipelineName": "Active pipeline",
                "milestones": saved_pipeline["milestones"].clone(),
                "savedPipelines": vec![saved_pipeline; 16],
                "workerId": null,
                "preferredWorkerAgentId": "codex",
                "expectedPlaybookRevision": 1,
                "expectedRevision": 1
            }
        });
        let encoded = serde_json::to_string(&request).unwrap();

        assert!(encoded.len() > 64 * 1024);
        assert!(encoded.len() <= MAX_CONTROL_MESSAGE);
        assert_eq!(decode_control_text(&encoded).unwrap().id, "max-playbook");
    }

    #[test]
    fn credentials_compare_without_content_short_circuit_and_scopes_are_explicit() {
        assert!(constant_time_equal(b"same", b"same"));
        assert!(!constant_time_equal(b"same", b"sand"));
        assert!(!constant_time_equal(b"short", b"longer"));
        assert!(read_only_method("project.list"));
        assert!(read_only_method("control.cancel"));
        assert!(companion_method("control.cancel"));
        assert!(cancellation_safe_method("project.list"));
        assert!(cancellation_safe_method("companion.wakeNext"));
        assert!(cancellation_safe_method("task.branchCommitSummaryList"));
        assert!(!cancellation_safe_method("system.keepAwake.get"));
        assert!(!cancellation_safe_method("gitHost.pullRequestList"));
        assert!(
            protocol::METHODS
                .iter()
                .filter(|method| cancellation_safe_method(method))
                .all(|method| {
                    read_only_method(method)
                        || [
                            "session.listArchived",
                            // Full-scope only because this read projects private
                            // provider transcripts from the daemon host.
                            "session.historyList",
                            "session.historyPreview",
                            "companion.transcriptList",
                            "companion.wakeNext",
                            // Board discovery is a read, but it carries
                            // one-time Jira credentials and therefore remains
                            // available only to the local Full-scope client.
                            "taskSource.boardList",
                            "taskSource.boardListStored",
                            "taskSource.statusList",
                            "taskSource.statusListStored",
                            "task.branchCommitSummaryList",
                        ]
                        .contains(method)
                })
        );
        assert!(read_only_method("task.list"));
        assert!(companion_method("companion.transcriptAppend"));
        assert!(companion_method("companion.transcriptList"));
        assert!(!companion_method("companion.proposalRespond"));
        assert!(!companion_method("companion.suggestionAccept"));
        assert!(scope_allows_method(
            ClientScope::Full,
            "companion.proposalRespond"
        ));
        assert!(scope_allows_method(
            ClientScope::Full,
            "companion.suggestionAccept"
        ));
        // Reading the keep-awake state is harmless; changing it alters the
        // host's power behavior, so only a Full-scope client may write it.
        assert!(read_only_method("system.keepAwake.get"));
        assert!(!read_only_method("system.keepAwake.set"));
        assert!(!companion_method("system.keepAwake.get"));
        assert!(!companion_method("system.keepAwake.set"));
        assert!(scope_allows_method(
            ClientScope::Full,
            "system.keepAwake.set"
        ));
        assert!(!scope_allows_method(
            ClientScope::ReadOnly,
            "system.keepAwake.set"
        ));
        assert!(!scope_allows_method(
            ClientScope::Hook,
            "system.keepAwake.get"
        ));
        assert!(!protocol::METHODS.contains(&"steward.taskCreateRequest"));
        assert!(!companion_method("companion.transcriptClear"));
        assert!(!read_only_method("project.listLocalBranches"));
        assert!(!read_only_method("project.worktreeChangeList"));
        assert!(!read_only_method("project.worktreeDiff"));
        assert!(!read_only_method("project.worktreePreImage"));
        assert!(!companion_method("project.worktreePreImage"));
        assert!(!read_only_method("task.worktreeChangeList"));
        assert!(!read_only_method("task.worktreeDiff"));
        // Whole-file content is at least as sensitive as a patch for the same
        // entry, so the pre-image read stays outside both narrow scopes.
        assert!(!read_only_method("task.worktreePreImage"));
        assert!(!companion_method("task.worktreePreImage"));
        assert!(!read_only_method("task.branchCommitSummaryList"));
        assert!(!read_only_method("task.branchCommitList"));
        assert!(!read_only_method("task.branchCommitChangeList"));
        assert!(!read_only_method("task.branchCommitDiff"));
        assert!(!read_only_method("task.inspectWorktreeRepair"));
        assert!(!read_only_method("project.create"));
        assert!(!read_only_method("task.create"));
        assert!(!read_only_method("task.bindBranch"));
        assert!(!read_only_method("task.provisionWorktree"));
        assert!(!read_only_method("task.dismissWorktreeProvisioning"));
        // Catalog reads invoke the bundled manager process, and deployment
        // changes provider files. Neither surface belongs to a narrow client.
        for method in [
            "skill.catalogGet",
            "skill.deploymentSet",
            "contextBank.catalogGet",
            "contextBank.fileGet",
            "contextBank.fileSave",
            "contextBank.siblingConflictResolve",
        ] {
            assert!(scope_allows_method(ClientScope::Full, method));
            assert!(!scope_allows_method(ClientScope::ReadOnly, method));
            assert!(!scope_allows_method(ClientScope::Companion, method));
            assert!(!scope_allows_method(ClientScope::Hook, method));
            assert!(!cancellation_safe_method(method));
        }
        assert_eq!(
            dispatch::companion_transcript_author(ClientScope::Full),
            "user"
        );
        assert!(!protocol::METHODS.contains(&"steward.report"));
        assert!(!protocol::METHODS.contains(&"steward.taskCreateConfirmationGet"));
        assert!(!protocol::METHODS.contains(&"steward.taskCreateResolve"));
        assert!(!scope_allows_method(
            ClientScope::Full,
            "companion.wakeNext"
        ));
        assert!(!scope_allows_method(
            ClientScope::Full,
            "companion.stewardWake"
        ));
        assert!(scope_allows_method(
            ClientScope::Companion,
            "companion.wakeNext"
        ));
        // Graceful daemon shutdown is a Full-scope command: read-only,
        // Companion, and hook credentials are all rejected before dispatch.
        assert!(protocol::METHODS.contains(&"system.shutdown"));
        assert!(scope_allows_method(ClientScope::Full, "system.shutdown"));
        assert!(!read_only_method("system.shutdown"));
        assert!(!companion_method("system.shutdown"));
        assert!(!scope_allows_method(
            ClientScope::ReadOnly,
            "system.shutdown"
        ));
        assert!(!scope_allows_method(
            ClientScope::Companion,
            "system.shutdown"
        ));
        assert!(!scope_allows_method(ClientScope::Hook, "system.shutdown"));
        assert_eq!(
            dispatch::companion_transcript_author(ClientScope::Companion),
            "steward"
        );
    }

    #[test]
    fn remote_device_origin_cannot_manage_daemon_or_access_plane_lifecycle() {
        for method in [
            "system.shutdown",
            "session.restartAgentsForClientLaunch",
            "access.deviceList",
            "access.deviceRevoke",
        ] {
            assert!(!origin_allows_method(
                ConnectionOrigin::RemoteDevice,
                method
            ));
            assert!(origin_allows_method(ConnectionOrigin::LocalEpoch, method));
        }
        assert!(origin_allows_method(
            ConnectionOrigin::RemoteDevice,
            "session.restartAgent"
        ));
        assert!(origin_allows_method(
            ConnectionOrigin::RemoteDevice,
            "system.keepAwake.set"
        ));
        assert!(origin_allows_method(
            ConnectionOrigin::RemoteDevice,
            "session.resumeAgent"
        ));
        assert!(origin_allows_method(
            ConnectionOrigin::RemoteDevice,
            "control.cancel"
        ));
    }

    #[tokio::test]
    async fn saturated_control_queue_reserves_a_typed_slow_consumer_error() {
        let sender = ControlOutbound::new();
        for _ in 0..MAX_CONTROL_OUTBOUND_MESSAGES {
            assert!(queue_control_message(&sender, "event".into()));
        }
        assert!(!queue_control_message(&sender, "overflow".into()));
        let response: ControlResponse =
            serde_json::from_str(&sender.next().await.unwrap().text).unwrap();
        assert_eq!(response.error.unwrap().code, ErrorCode::SlowConsumer);
        assert!(sender.next().await.is_none());
    }

    #[tokio::test]
    async fn control_queue_enforces_total_byte_budget() {
        let sender = ControlOutbound::new();
        let message = "x".repeat(MAX_CONTROL_OUTBOUND_BYTES / 2 + 1);
        assert!(sender.queue(message.clone()));
        assert!(!sender.queue(message));
        let response: ControlResponse =
            serde_json::from_str(&sender.next().await.unwrap().text).unwrap();
        assert_eq!(response.error.unwrap().code, ErrorCode::SlowConsumer);
    }

    #[tokio::test]
    async fn bounded_projection_sized_response_passes_the_real_outbound_queue() {
        let sender = ControlOutbound::new();
        let response = serde_json::to_string(&serde_json::json!({
            "id": "projection",
            "result": { "payload": "x".repeat(3 * 1024 * 1024) }
        }))
        .unwrap();
        assert!(sender.queue(response.clone()));
        assert_eq!(sender.next().await.unwrap().text, response);
    }

    #[tokio::test]
    async fn post_response_receipt_is_released_only_after_the_message_is_taken_for_send() {
        let sender = ControlOutbound::new();
        let (sent, mut receipt) = oneshot::channel();
        assert!(sender.queue_with_receipt("hook-ok".into(), Some(sent)));
        assert!(matches!(
            receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        let message = sender.next().await.unwrap();
        assert_eq!(message.text, "hook-ok");
        message.sent.unwrap().send(()).unwrap();
        receipt.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_requires_the_same_token_and_a_safe_pending_method() {
        let mut pending = HashMap::new();
        for (id, cancellation_safe) in [("safe", true), ("mutation", false)] {
            let task = tokio::spawn(std::future::pending::<()>());
            pending.insert(
                id.to_owned(),
                PendingControlRequest {
                    abort: task.abort_handle(),
                    cancellation_safe,
                    token: "a".repeat(64),
                },
            );
            drop(task);
        }
        assert!(!abort_pending_control_request(
            &mut pending,
            "safe",
            &"b".repeat(64)
        ));
        assert!(abort_pending_control_request(
            &mut pending,
            "safe",
            &"a".repeat(64)
        ));
        assert!(!abort_pending_control_request(
            &mut pending,
            "mutation",
            &"a".repeat(64)
        ));
        assert!(pending.contains_key("mutation"));
        pending.remove("mutation").unwrap().abort.abort();
    }
}
