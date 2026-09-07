use std::sync::atomic::Ordering;

use serde_json::Value;
use termloop_contract::current::ProjectionTopic;
use termloop_core::{AgentLaunchCommit, AgentLaunchPlan, CoreError};

use super::super::AppState;
use super::super::invalidation::{InvalidationRequest, refresh_task_presence_for_cwd};

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
    publish_agent_launch(&commit, workflow_launch, state).await;
    Ok(commit.session)
}

async fn publish_agent_launch(commit: &AgentLaunchCommit, workflow_launch: bool, state: &AppState) {
    let observation_sequence = state.observation_sequence.load(Ordering::Relaxed);
    let _ = state
        .invalidation_requests
        .try_send(agent_launch_invalidation(
            commit,
            workflow_launch,
            observation_sequence,
        ));
    if let Some(cwd) = session_cwd(&commit.session) {
        refresh_task_presence_for_cwd(state, cwd).await;
    }
}

fn agent_launch_invalidation(
    commit: &AgentLaunchCommit,
    workflow_launch: bool,
    observation_sequence: u64,
) -> InvalidationRequest {
    InvalidationRequest {
        topics: if workflow_launch {
            vec![ProjectionTopic::Session, ProjectionTopic::Workflow]
        } else {
            vec![ProjectionTopic::Session]
        },
        state_revision: commit.state_revision,
        observation_sequence,
    }
}

fn session_cwd(session: &Value) -> Option<&str> {
    session
        .get("process")
        .and_then(|process| process.get("cwd"))
        .and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn launch_publication_uses_the_commit_revision_and_session_cwd() {
        let commit = AgentLaunchCommit {
            session: json!({"process": {"cwd": "/tmp/task-worktree"}}),
            state_revision: 41,
        };

        let invalidation = agent_launch_invalidation(&commit, false, 17);

        assert_eq!(invalidation.topics, [ProjectionTopic::Session]);
        assert_eq!(invalidation.state_revision, 41);
        assert_eq!(invalidation.observation_sequence, 17);
        assert_eq!(session_cwd(&commit.session), Some("/tmp/task-worktree"));
    }

    #[test]
    fn workflow_launch_also_invalidates_the_workflow_projection() {
        let commit = AgentLaunchCommit {
            session: json!({}),
            state_revision: 42,
        };

        assert_eq!(
            agent_launch_invalidation(&commit, true, 18).topics,
            [ProjectionTopic::Session, ProjectionTopic::Workflow]
        );
    }
}
