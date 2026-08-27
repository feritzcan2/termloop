use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use termloop_contract::current::{self as protocol, ProjectionTopic};

use super::super::super::invalidation::InvalidationRequest;
use super::super::super::{AppState, current_epoch_ms};
use super::terminate_session;

fn agent_name(agent: protocol::StewardAgentId) -> &'static str {
    match agent {
        protocol::StewardAgentId::Claude => "claude",
        protocol::StewardAgentId::Codex => "codex",
    }
}

fn permission_name(permission: protocol::AssistantPermission) -> &'static str {
    match permission {
        protocol::AssistantPermission::Default => "default",
        protocol::AssistantPermission::AcceptEdits => "acceptEdits",
        protocol::AssistantPermission::Plan => "plan",
        protocol::AssistantPermission::BypassPermissions => "bypassPermissions",
    }
}

fn availability(state: &AppState, agent_id: &str) -> termloop_core::AssistantAvailability {
    if state
        .agent_capabilities
        .iter()
        .any(|capability| capability.agent_id == agent_id && capability.available)
    {
        termloop_core::AssistantAvailability::Proven
    } else {
        termloop_core::AssistantAvailability::Unavailable
    }
}

pub(in crate::app::control) async fn create_worker_configuration(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params = serde_json::from_value::<protocol::WorkerConfigurationCreateParams>(params)
        .expect("validated Worker create params");
    let agent_id = agent_name(params.agent_id);
    let worker_id = termloop_platform::generate_opaque_id();
    let (result, revision) = {
        let mut core = state.core.lock().await;
        let result = core.create_worker_configuration(
            worker_id.clone(),
            &params.project_id,
            params.name,
            agent_id,
            params.enabled,
            params.model,
            permission_name(params.permission).into(),
            params.reasoning,
            params.ping_interval_seconds,
            params.worker_prompt,
            params.system_prompt,
            params.expected_revision,
            availability(state, agent_id),
            current_epoch_ms(),
        );
        (result, core.state_revision())
    };
    publish(&result, state, revision);
    if params.enabled
        && result.is_ok()
        && let Err(error) = launch_current_worker(&worker_id, state).await
    {
        tracing::warn!(worker_id = %worker_id, error = %error, "new Worker was saved but its launch did not complete");
    }
    result
}

pub(in crate::app::control) async fn update_worker_configuration(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params = serde_json::from_value::<protocol::WorkerConfigurationUpdateParams>(params)
        .expect("validated Worker update params");
    let agent_id = agent_name(params.agent_id);
    let (result, old_session, revision) = {
        let mut core = state.core.lock().await;
        let old_session = core.worker_executor_session_id(&params.worker_id);
        let result = core.update_worker_configuration(
            &params.worker_id,
            params.name,
            agent_id,
            params.model,
            permission_name(params.permission).into(),
            params.reasoning,
            params.enabled,
            params.ping_interval_seconds,
            params.worker_prompt,
            params.system_prompt,
            params.expected_revision,
            availability(state, agent_id),
            current_epoch_ms(),
        );
        (result, old_session, core.state_revision())
    };
    publish(&result, state, revision);
    let retained = result
        .as_ref()
        .ok()
        .and_then(|value| value["configuration"]["executorSessionId"].as_str());
    if let Some(session_id) = old_session.filter(|id| Some(id.as_str()) != retained) {
        if let Ok(mut registry) = state.tracker_report_capabilities.lock() {
            registry.revoke_session(&session_id);
        }
        let _ = terminate_session(json!({"sessionId": session_id}), state).await;
    }
    if params.enabled
        && result
            .as_ref()
            .is_ok_and(|value| value["configuration"]["executorSessionId"].is_null())
    {
        launch_current_worker(&params.worker_id, state).await?;
    }
    result
}

pub(in crate::app::control) async fn delete_worker_configuration(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params = serde_json::from_value::<protocol::WorkerConfigurationDeleteParams>(params)
        .expect("validated Worker delete params");
    let mut core = state.core.lock().await;
    let result = core.delete_worker_configuration(
        &params.worker_id,
        params.expected_revision,
        current_epoch_ms(),
    );
    publish(&result, state, core.state_revision());
    result
}

pub(in crate::app) async fn launch_current_worker(
    worker_id: &str,
    state: &AppState,
) -> Result<(), termloop_core::CoreError> {
    let Some(target) = state
        .core
        .lock()
        .await
        .request_persistent_worker_launch(worker_id)
    else {
        return Ok(());
    };
    match &target.identity {
        termloop_core::companion_integrations::assistant_session::PersistentAssistantIdentity::Worker { .. } => {}
        termloop_core::companion_integrations::assistant_session::PersistentAssistantIdentity::Steward { .. } => return Err(termloop_core::CoreError::RevisionConflict),
    }
    let session_id = termloop_platform::generate_uuid_v4();
    let prepared = state
        .core
        .lock()
        .await
        .prepare_persistent_assistant_launch(target, session_id.clone())?;
    let prepared = tokio::task::spawn_blocking(move || {
        let mut prepared = prepared;
        prepared.prepare_runtime()?;
        Ok::<_, termloop_core::CoreError>(prepared)
    })
    .await
    .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))??;
    let admitted = state
        .core
        .lock()
        .await
        .admit_persistent_assistant_launch(prepared, current_epoch_ms());
    let admitted = match admitted {
        Ok(value) => value,
        Err(error) => return Err(error),
    };
    if let Err(error) = tokio::task::spawn_blocking(move || admitted.execute())
        .await
        .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))
        .and_then(|value| value)
    {
        let retired_runtime = state
            .core
            .lock()
            .await
            .rollback_assistant_launch(&session_id)
            .ok()
            .and_then(|(_, runtime)| runtime);
        if let Some(runtime) = retired_runtime {
            let _ = tokio::task::spawn_blocking(move || runtime.reap()).await;
        }
        return Err(error);
    }
    let revision = state.core.lock().await.state_revision();
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Worker,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
        ],
        state_revision: revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(())
}

fn publish(result: &Result<Value, termloop_core::CoreError>, state: &AppState, revision: u64) {
    if result.is_ok() {
        state.tracker_runtime_wake.notify_one();
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Worker, ProjectionTopic::Routine],
            state_revision: revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
}
