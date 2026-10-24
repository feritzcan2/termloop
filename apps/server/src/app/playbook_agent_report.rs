//! Task Agent Playbook step tools: the Agent working a Task reads where its
//! Task stands and reports that its own work reached, or is blocked at, the
//! current step. Core decides what the report may change; this layer only
//! wakes the step scheduler and invalidates the projections it touched.

use std::sync::atomic::Ordering;

use serde_json::Value;
use termloop_contract::current::{
    PlaybookStepReportParams, ProjectionTopic, TaskStatusRecordParams,
};
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

/// A Project Manager Task Agent replaces its Task's status record. Core owns
/// the Task-Agent identity, Project-mode, and revision checks.
pub(super) async fn record_status(
    token: &str,
    params: TaskStatusRecordParams,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.record_task_agent_status(
            token,
            params.status_markdown,
            params.expected_status_revision,
            termloop_core::companion_integrations::tracker_runtime::TaskAgentTicketUpdate {
                tracking: params.tracking,
                ticket: params.ticket,
                change_summary: params.change_summary,
                expected_version: params.expected_ticket_version,
            },
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
