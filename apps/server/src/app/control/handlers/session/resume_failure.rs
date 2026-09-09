use serde_json::Value;
use termloop_core::{AgentResumeFailureOutcome, AgentResumePlan, CoreError, ResumeFailureReason};

use super::{AppState, reap_agent_resume_plan};

pub(super) async fn fail_agent_resume_attempt(
    state: &AppState,
    session_id: &str,
    reason: ResumeFailureReason,
    plan: Box<AgentResumePlan>,
) -> Result<Value, CoreError> {
    debug_assert_eq!(session_id, plan.session_id());
    finalize_resume_failure(state, plan, AgentResumeFailureOutcome::Failed(reason)).await
}

pub(super) async fn shutdown_agent_resume_attempt(
    state: &AppState,
    plan: Box<AgentResumePlan>,
) -> Result<Value, CoreError> {
    finalize_resume_failure(state, plan, AgentResumeFailureOutcome::Shutdown).await
}

async fn finalize_resume_failure(
    state: &AppState,
    plan: Box<AgentResumePlan>,
    outcome: AgentResumeFailureOutcome,
) -> Result<Value, CoreError> {
    let failure = state.core.lock().await.begin_resume_failure(&plan, outcome);
    let failure = match failure {
        Ok(failure) => failure,
        Err(error) => {
            // Even a stale/rejected plan may still own a process. Never drop it
            // on an async worker or while Core is locked.
            reap_agent_resume_plan(plan).await;
            return Err(error);
        }
    };
    let uncertain = failure.clone();
    let observed = tokio::task::spawn_blocking(move || failure.reap(*plan))
        .await
        .unwrap_or_else(|_| uncertain.cleanup_failed());
    state.core.lock().await.complete_resume_failure(observed)
}
