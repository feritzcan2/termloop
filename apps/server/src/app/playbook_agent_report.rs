//! Task Agent Playbook step tools: the Agent working a Task reads where its
//! Task stands and reports that its own work reached, or is blocked at, the
//! current step. Core decides what the report may change; this layer only
//! wakes the step scheduler and invalidates the projections it touched.

use std::sync::atomic::Ordering;

use serde_json::Value;
use termloop_contract::current::{PlaybookStepReportParams, ProjectionTopic};
use termloop_core::companion_integrations::tracker_runtime::AgentStepReportStatus;

use super::AppState;
use super::invalidation::InvalidationRequest;

pub(super) async fn read_step(
    token: &str,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    state.core.lock().await.read_task_agent_playbook_step(token)
}

pub(super) async fn report_step(
    token: &str,
    params: PlaybookStepReportParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let status = match params.status.as_str() {
        "reached" => AgentStepReportStatus::Reached,
        "blocked" => AgentStepReportStatus::Blocked,
        _ => return Err(termloop_core::CoreError::InvalidParams("status".into())),
    };
    let (receipt, state_revision) = {
        let mut core = state.core.lock().await;
        let receipt = core.report_task_agent_playbook_step(
            token,
            &params.milestone_id,
            params.playbook_revision,
            status,
            &params.evidence,
            super::current_epoch_ms(),
        )?;
        (receipt, core.state_revision())
    };
    if receipt.wake_step_scheduler {
        state.tracker_runtime_wake.notify_one();
    }
    let mut topics = vec![ProjectionTopic::Playbook];
    if receipt.position_changed {
        topics.extend([ProjectionTopic::Routine, ProjectionTopic::Task]);
    }
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics,
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(receipt.result)
}
