use serde_json::Value;
use termloop_core::CoreError;
use termloop_core::task_worktree::TaskClosePreparation;

use super::super::super::AppState;
use super::super::super::invalidation::{
    CommitImpact, queue_changed_commit_invalidation, queue_durable_commit_invalidation,
};

/// Closes a Task and parks the live Agents in its checkout. Core plans the
/// cohort under the lock; the PTYs are terminated outside it.
pub(in crate::app) async fn close_task(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let prepared = {
        let mut core = state.core.lock().await;
        let previous_revision = core.state_revision();
        let preparation = core.prepare_task_close(params);
        let current_revision = core.state_revision();
        match preparation {
            Ok(TaskClosePreparation::Retire(plan)) => {
                let runtimes = core.detach_task_close_runtimes(&plan);
                Ok((plan, runtimes, current_revision))
            }
            Ok(TaskClosePreparation::Closed(result)) => {
                Err((Ok(result), previous_revision, current_revision))
            }
            Err(error) => Err((Err(error), previous_revision, current_revision)),
        }
    };
    let (plan, runtimes, prepared_revision) = match prepared {
        Ok(prepared) => prepared,
        Err((result, previous_revision, current_revision)) => {
            queue_changed_commit_invalidation(
                state,
                CommitImpact::TaskSessionAgent,
                previous_revision,
                current_revision,
            )
            .await;
            return result;
        }
    };
    queue_durable_commit_invalidation(state, CommitImpact::TaskSessionAgent, prepared_revision)
        .await;
    let terminal = state.terminal.clone();
    let session_ids = plan.session_ids();
    let retirement = tokio::task::spawn_blocking(move || -> Result<(), CoreError> {
        drop(runtimes);
        for session_id in session_ids {
            if terminal
                .contains_session(&session_id)
                .map_err(|error| CoreError::Terminal(error.to_string()))?
            {
                terminal
                    .terminate(&session_id)
                    .map_err(|error| CoreError::Terminal(error.to_string()))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| CoreError::Terminal(error.to_string()))
    .and_then(std::convert::identity);
    let (result, completed_revision) = {
        let mut core = state.core.lock().await;
        let result = match retirement {
            Ok(()) => core.complete_task_close(plan),
            Err(error) => {
                tracing::warn!(%error, task_id = plan.task_id(), "Task close could not stop its Agents");
                core.abandon_task_close(plan);
                Err(error)
            }
        };
        (result, core.state_revision())
    };
    queue_changed_commit_invalidation(
        state,
        CommitImpact::TaskSessionAgent,
        prepared_revision,
        completed_revision,
    )
    .await;
    result
}
