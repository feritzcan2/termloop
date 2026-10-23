use serde_json::{Value, json};
use termloop_core::CoreError;
use termloop_core::task_worktree::{TaskClosePreparation, TaskWorktreeRecreationPlan};

use super::super::super::AppState;
use super::super::super::invalidation::{
    CommitImpact, queue_changed_commit_invalidation, queue_durable_commit_invalidation,
};

/// Recreates the checkout a closed Task lost at close, before reopen resumes
/// its parked Agents, so they come back inside the Task's worktree. Any
/// failure leaves reopen's Project-root fallback in place.
pub(in crate::app) async fn recreate_reopened_task_worktree(params: &Value, state: &AppState) {
    let Some(task_id) = params.get("taskId").and_then(Value::as_str) else {
        return;
    };
    let plan = state.core.lock().await.plan_task_reopen_worktree(task_id);
    let Some(plan) = plan else {
        return;
    };
    if let Err(error) = recreate_task_worktree(&plan, state).await {
        tracing::warn!(%error, task_id, "Reopened Task worktree could not be recreated");
    }
}

/// Recreates the Task checkout a deleted Agent worked in, at its exact former
/// path, so restore reopens the Agent inside the Task. Without it, restore
/// falls back to the Project root.
pub(in crate::app) async fn recreate_deleted_session_worktree(params: &Value, state: &AppState) {
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let plan = state
        .core
        .lock()
        .await
        .plan_deleted_session_worktree(session_id);
    let Some(plan) = plan else {
        return;
    };
    if plan
        .destination_path
        .as_deref()
        .is_some_and(|path| std::path::Path::new(path).exists())
    {
        return;
    }
    if let Err(error) = recreate_task_worktree(&plan, state).await {
        tracing::warn!(%error, session_id, "Deleted Agent's Task worktree could not be recreated");
    }
}

async fn recreate_task_worktree(
    plan: &TaskWorktreeRecreationPlan,
    state: &AppState,
) -> Result<(), CoreError> {
    let branches =
        super::project_list_local_branches(json!({ "projectId": plan.project_id }), state).await?;
    let repository_path = branches
        .get("repository_root")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?;
    let branch_ref = format!("refs/heads/{}", plan.branch_name);
    let branch_exists = branches
        .get("branches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|branch| branch.get("exact_ref").and_then(Value::as_str) == Some(branch_ref.as_str()));
    if !branch_exists {
        return Err(CoreError::InvalidParams("branchName".into()));
    }
    let destination = match &plan.destination_path {
        Some(path) => path.clone(),
        None => termloop_platform::sibling_directory_path(repository_path, &plan.worktree_leaf)
            .map_err(|_| CoreError::InvalidParams("projectId".into()))?
            .to_str()
            .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?
            .to_owned(),
    };
    super::provision_task_worktree(
        json!({
            "operationId": plan.operation_id,
            "taskId": plan.task_id,
            "repositoryPath": repository_path,
            "destinationPath": destination,
            "branchName": plan.branch_name,
            "branchMode": "existing",
        }),
        state,
    )
    .await?;
    Ok(())
}

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
