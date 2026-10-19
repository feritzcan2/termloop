use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use termloop_contract::current::{
    PlaybookEvaluationCompleteParams, ProjectionTopic, RoutineAssignmentStatus,
};
use termloop_core::CoreError;
use termloop_core::companion_integrations::tracker_runtime::StewardRoutineClaim;
use termloop_core::session_launch::PlaybookEvaluationLaunch;

use super::AppState;

const STEP_ROUTING_RETRY_MS: u64 = 30_000;

pub(super) fn invalid_report_message(arguments: &Value) -> String {
    let evidence_size = arguments["evidence"]
        .as_str()
        .map(|evidence| format!(" Received {} bytes.", evidence.len()))
        .unwrap_or_default();
    format!(
        "Expected only checkId (1-128 characters), status (satisfied/pending/blocked), and evidence (1-600 UTF-8 bytes).{evidence_size} Nothing was recorded; correct the arguments and retry the same check."
    )
}

/// Both scheduled wakes and explicit next-assignment calls use this path.
pub(super) async fn route_assignment(
    state: &AppState,
    claim: &mut StewardRoutineClaim,
) -> Result<bool, CoreError> {
    let outcome = state.core.lock().await.plan_playbook_evaluation(claim)?;
    let delegated = match outcome {
        PlaybookEvaluationLaunch::Steward(result) => {
            claim.result = result;
            Ok(false)
        }
        PlaybookEvaluationLaunch::Delegated(result) | PlaybookEvaluationLaunch::Skipped(result) => {
            claim.result = result;
            Ok(true)
        }
        PlaybookEvaluationLaunch::Fork {
            plan,
            check_id,
            result,
        } => {
            let launched = super::control::launch_playbook_evaluation_fork(*plan, state).await;
            settle_evaluator_launch(state, claim, launched, check_id, result).await
        }
        PlaybookEvaluationLaunch::Fresh {
            plan,
            check_id,
            result,
        } => {
            let launched = super::agent_launch::execute_agent_launch(state, *plan).await;
            settle_evaluator_launch(state, claim, launched, check_id, result).await
        }
    }?;
    if delegated || claim.result.get("step").is_some_and(Value::is_object) {
        let state_revision = state.core.lock().await.state_revision();
        super::invalidation::queue_invalidation(
            &state.invalidation_requests,
            super::invalidation::InvalidationRequest {
                topics: vec![ProjectionTopic::Playbook],
                state_revision,
                observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
            },
        )
        .await;
    }
    Ok(delegated)
}

async fn settle_evaluator_launch(
    state: &AppState,
    claim: &mut StewardRoutineClaim,
    launched: Result<Value, CoreError>,
    check_id: String,
    result: Value,
) -> Result<bool, CoreError> {
    match launched {
        Ok(_) => {
            claim.result = result;
        }
        Err(error) => {
            tracing::warn!(%error, "Task Playbook evaluator unavailable; leaving the step waiting");
            claim.result = state
                .core
                .lock()
                .await
                .fail_playbook_evaluation_launch(&check_id)?;
            reap_obsolete_evaluators(state).await;
        }
    }
    Ok(true)
}

/// Routes one admitted step claim to its evaluator. A claim that cannot be
/// routed is handed back with a short floor so it is retried, not spun.
pub(super) async fn route_playbook_step(state: AppState, mut claim: StewardRoutineClaim) {
    if let Err(error) = route_assignment(&state, &mut claim).await {
        tracing::warn!(%error, "Playbook step routing failed");
        if let Some(capability) = claim.capability.as_ref() {
            let retry_at =
                termloop_platform::current_epoch_ms().saturating_add(STEP_ROUTING_RETRY_MS);
            state
                .core
                .lock()
                .await
                .postpone_playbook_step(capability, retry_at);
        }
    }
    state.tracker_runtime_wake.notify_one();
}

pub(super) async fn complete(
    token: &str,
    params: PlaybookEvaluationCompleteParams,
    state: &AppState,
) -> Result<Value, CoreError> {
    let verdict = match params.status {
        RoutineAssignmentStatus::Satisfied => {
            termloop_core::companion_integrations::playbook_runtime::PlaybookStepVerdict::Passed
        }
        RoutineAssignmentStatus::Pending => {
            termloop_core::companion_integrations::playbook_runtime::PlaybookStepVerdict::Waiting
        }
        RoutineAssignmentStatus::Blocked => {
            termloop_core::companion_integrations::playbook_runtime::PlaybookStepVerdict::Blocked
        }
    };
    let completion = state.core.lock().await.complete_playbook_evaluation(
        token,
        &params.check_id,
        verdict,
        params.evidence,
    );
    let completion = match completion {
        Err(CoreError::TrackerReportStale) => {
            // The fork stops on a stale answer. Retire it and re-queue the
            // step now instead of leaving the Task shown as checking until
            // the claim deadline.
            let cleanup_state = state.clone();
            tokio::spawn(async move {
                reap_obsolete_evaluators(&cleanup_state).await;
                cleanup_state.tracker_runtime_wake.notify_one();
            });
            return Err(CoreError::TrackerReportStale);
        }
        completion => completion?,
    };
    let project_id = completion["projectId"]
        .as_str()
        .expect("Core completion project");
    let result = &completion["result"];
    super::mcp::finish_routine_report_for(
        project_id,
        state,
        super::mcp::step_verdict_wake(result),
        vec![
            ProjectionTopic::Routine,
            ProjectionTopic::Playbook,
            ProjectionTopic::Task,
        ],
    )
    .await;
    state.tracker_runtime_wake.notify_one();
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        reap_obsolete_evaluators(&cleanup_state).await;
    });
    Ok(json!({"status": "completed", "stewardReviewRequired": result["stewardReviewRequired"]}))
}

pub(super) async fn reap_obsolete_evaluators(state: &AppState) {
    let (sessions, changed_revision) = {
        let mut core = state.core.lock().await;
        let before = core.state_revision();
        let sessions = core.obsolete_playbook_evaluator_sessions();
        (
            sessions,
            (before != core.state_revision()).then_some(core.state_revision()),
        )
    };
    if let Some(state_revision) = changed_revision {
        super::invalidation::queue_invalidation(
            &state.invalidation_requests,
            super::invalidation::InvalidationRequest {
                topics: vec![ProjectionTopic::Playbook],
                state_revision,
                observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
            },
        )
        .await;
    }
    let sessions = match sessions {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!(%error, "Playbook evaluator cleanup deferred");
            return;
        }
    };
    for session_id in sessions {
        match super::control::terminate_session(json!({"sessionId": session_id}), state).await {
            Ok(_) | Err(CoreError::NotFound) => {}
            Err(error) => {
                tracing::warn!(%error, "Playbook evaluator termination deferred");
                continue;
            }
        }
        let retired = {
            state
                .core
                .lock()
                .await
                .retire_playbook_evaluator_descriptor(&session_id)
        };
        match retired {
            Ok(()) => {
                let state_revision = state.core.lock().await.state_revision();
                super::invalidation::queue_durable_commit_invalidation(
                    state,
                    super::invalidation::CommitImpact::SessionAgent,
                    state_revision,
                )
                .await;
            }
            Err(CoreError::NotFound) => {}
            Err(error) => {
                tracing::warn!(%error, "Playbook evaluator descriptor retirement deferred");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_report_explains_the_advertised_byte_limit_without_echoing_evidence() {
        let tools: Value =
            serde_json::from_str(termloop_contract::current::MCP_TOOL_DEFINITIONS_JSON).unwrap();
        let schema = &tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "playbook_evaluation_complete")
            .unwrap()["inputSchema"];
        let limit = schema["properties"]["evidence"]["x-utf8-max-bytes"]
            .as_u64()
            .unwrap();
        let message = invalid_report_message(&json!({"evidence": "ş".repeat(620)}));
        assert!(message.contains(&format!("1-{limit} UTF-8 bytes")));
        assert!(message.contains("Received 1240 bytes"));
        assert!(message.contains("Nothing was recorded"));
        assert!(message.contains("retry the same check"));
        assert!(!message.contains('ş'));
        assert!(message.len() <= 256);
        assert!(!invalid_report_message(&json!({})).contains("Received"));
    }
}
