use serde_json::Value;
use termloop_core::{AgentLaunchPlan, CoreError};

use super::super::AppState;
use super::super::invalidation::{CommittedSessionMutation, finish_session_mutation};

/// Runs the one ordinary Agent launch lifecycle after a caller has redeemed its
/// feature-specific preview ticket. Preparation and disposal can own provider
/// processes, so both stay off the async worker and outside the serialized core
/// lock. Core retains the spawn/insert/compensate transaction itself.
pub(in crate::app::control) async fn execute_agent_launch(
    state: &AppState,
    mut plan: AgentLaunchPlan,
) -> Result<Value, CoreError> {
    let workflow_launch = plan.is_workflow_launch();
    plan = tokio::task::spawn_blocking(move || {
        plan.prepare_runtime();
        plan
    })
    .await
    .map_err(|error| CoreError::Terminal(format!("agent runtime preparation failed: {error}")))?;
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "agent status runtime unavailable");
    }

    let result = state.core.lock().await.complete_agent_launch(&mut plan);
    // Move the possibly process-owning plan to the blocking pool before error
    // propagation so failure cannot run ManagedProcess::drop on this task.
    std::mem::drop(tokio::task::spawn_blocking(move || drop(plan)));
    let commit = result?;
    let effects =
        CommittedSessionMutation::launched(&commit.session, commit.state_revision, workflow_launch);
    finish_session_mutation(state, effects, Ok(commit.session)).await
}
