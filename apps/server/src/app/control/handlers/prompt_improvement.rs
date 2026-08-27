//! Preview and launch for versioned Improve-with-agent sessions.

use std::sync::atomic::Ordering;

use serde_json::Value;
use termloop_contract::current::ProjectionTopic;

use super::super::super::AppState;
use super::super::super::invalidation::InvalidationRequest;

pub(in crate::app::control) async fn preview_assistant_prompt_improver(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    state
        .core
        .lock()
        .await
        .preview_assistant_prompt_improver(params)
}

/// The improver redeems its own ticket kind but is otherwise an ordinary Agent
/// launch, so it shares the prepare-outside-the-lock sequence rather than
/// gaining a second launch path.
pub(in crate::app::control) async fn launch_assistant_prompt_improver(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let mut plan = {
        let mut core = state.core.lock().await;
        core.take_assistant_prompt_improver_launch(params)?
    };
    plan = tokio::task::spawn_blocking(move || {
        plan.prepare_runtime();
        plan
    })
    .await
    .map_err(|error| {
        termloop_core::CoreError::Terminal(format!("agent runtime preparation failed: {error}"))
    })?;
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "agent status runtime unavailable");
    }
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_agent_launch(&mut plan);
        (result, core.state_revision())
    };
    tokio::task::spawn_blocking(move || drop(plan));
    if result.is_ok() {
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Session],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
    result
}
