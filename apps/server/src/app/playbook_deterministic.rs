use std::time::Duration;

use termloop_contract::current::ProjectionTopic;
use termloop_core::companion_integrations::playbook_deterministic::DeterministicStepOutcome;
use termloop_core::companion_integrations::tracker_runtime::StewardRoutineClaim;

use super::AppState;

/// Extra time for the blocking task to report its own provider timeout before
/// the server gives up on it.
const OBSERVATION_MARGIN: Duration = Duration::from_secs(2);

/// Answers a fresh step claim from a live Git-host read when its step has a
/// deterministic check. Returns `true` when the verdict was recorded and the
/// claim is finished; `false` hands the claim to the Routine evaluator, with
/// any fallback reason already noted on the claim.
///
/// The plan is taken under the core lock, the Git/provider read runs without
/// it, and the result is applied under the lock after revalidation.
pub(super) async fn try_record(state: &AppState, claim: &StewardRoutineClaim) -> bool {
    let Some(capability) = claim.capability.as_ref() else {
        return false;
    };
    let Some(plan) = state
        .core
        .lock()
        .await
        .plan_deterministic_step_check(capability)
    else {
        return false;
    };
    let fallback = plan.clone();
    let observation = match tokio::time::timeout(
        plan.timeout() + OBSERVATION_MARGIN,
        tokio::task::spawn_blocking(move || plan.observe()),
    )
    .await
    {
        Ok(Ok(observation)) => observation,
        Ok(Err(error)) => {
            tracing::warn!(%error, "Playbook deterministic check read failed");
            fallback.failed()
        }
        Err(_) => fallback.timed_out(),
    };
    let outcome = state
        .core
        .lock()
        .await
        .apply_deterministic_step_check(observation, termloop_platform::current_epoch_ms());
    match outcome {
        Ok(DeterministicStepOutcome::Recorded { project_id, result }) => {
            super::mcp::finish_routine_report_for(
                &project_id,
                state,
                super::mcp::step_verdict_wake(&result),
                vec![
                    ProjectionTopic::Routine,
                    ProjectionTopic::Playbook,
                    ProjectionTopic::Task,
                ],
            )
            .await;
            true
        }
        Ok(DeterministicStepOutcome::Routine) => false,
        Err(error) => {
            tracing::warn!(%error, "Playbook deterministic verdict not recorded; asking the Routine");
            false
        }
    }
}
