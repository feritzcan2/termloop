use serde_json::{Value, json};
use termloop_core::CoreError;
use termloop_core::task_worktree::{
    TaskClosePreparation, TaskWorktreeRecreationBase, TaskWorktreeRecreationPlan,
    branch_worktree_leaf,
};

use super::super::super::AppState;
use super::super::super::invalidation::{
    CommitImpact, queue_changed_commit_invalidation, queue_durable_commit_invalidation,
};

/// Recreates the checkout a closed Task lost at close on a fresh branch from
/// the latest base, before reopen resumes its parked Agents, so they come back
/// inside the Task's worktree. Any failure keeps the original branch and
/// leaves reopen's Project-root fallback in place.
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
    let local_refs = branches
        .get("branches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|branch| branch.get("exact_ref").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let sibling = |leaf: &str| -> Result<String, CoreError> {
        termloop_platform::sibling_directory_path(repository_path, leaf)
            .map_err(|_| CoreError::InvalidParams("projectId".into()))?
            .to_str()
            .ok_or_else(|| CoreError::InvalidParams("projectId".into()))
            .map(str::to_owned)
    };
    let (released, configured_base_ref) = match &plan.base {
        TaskWorktreeRecreationBase::ExistingBranch => {
            let branch_ref = format!("refs/heads/{}", plan.branch_name);
            if !local_refs.contains(&branch_ref.as_str()) {
                return Err(CoreError::InvalidParams("branchName".into()));
            }
            let destination = match &plan.destination_path {
                Some(path) => path.clone(),
                None => sibling(&plan.worktree_leaf)?,
            };
            return super::provision_task_worktree(
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
            .await
            .map(drop);
        }
        TaskWorktreeRecreationBase::FreshFromBase {
            released,
            configured_base_ref,
        } => (released, configured_base_ref),
    };
    let base_ref =
        crate::app::task_automation::select_base_ref(&branches, configured_base_ref.as_deref())?;
    let (branch_name, destination) = fresh_branch_checkout(&plan.branch_name, |name| {
        let destination = sibling(&branch_worktree_leaf(name))?;
        let taken = local_refs.contains(&format!("refs/heads/{name}").as_str())
            || std::path::Path::new(&destination).exists();
        Ok((!taken).then_some(destination))
    })?;
    state
        .core
        .lock()
        .await
        .release_task_branch_for_fresh_checkout(&plan.task_id, released)?;
    let provisioned = super::provision_task_worktree(
        json!({
            "operationId": plan.operation_id,
            "taskId": plan.task_id,
            "repositoryPath": repository_path,
            "destinationPath": destination,
            "branchName": branch_name,
            "branchMode": "create",
            "baseRef": base_ref,
        }),
        state,
    )
    .await;
    if let Err(error) = provisioned {
        // Keep the Task on its original branch; reopen then falls back to the
        // Project root exactly as before.
        if let Err(rebind) = state
            .core
            .lock()
            .await
            .rebind_task_branch_after_failed_fresh_checkout(&plan.task_id, released.clone())
        {
            tracing::warn!(%rebind, task_id = plan.task_id, "Released Task branch could not be rebound");
        }
        return Err(error);
    }
    Ok(())
}

/// Derives the first free `<branch>-r<n>` for a fresh checkout, dropping a
/// previous restore's `-r<n>` so repeated restores do not stack suffixes.
/// `available` returns the checkout folder when both the branch and the
/// folder are free.
fn fresh_branch_checkout(
    released_name: &str,
    mut available: impl FnMut(&str) -> Result<Option<String>, CoreError>,
) -> Result<(String, String), CoreError> {
    let stem = released_name
        .rsplit_once("-r")
        .filter(|(stem, number)| {
            !stem.is_empty()
                && !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit())
        })
        .map_or(released_name, |(stem, _)| stem);
    for number in 2..=99 {
        let name = format!("{stem}-r{number}");
        if let Some(destination) = available(&name)? {
            return Ok((name, destination));
        }
    }
    Err(CoreError::InvalidParams("branchName".into()))
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

#[cfg(test)]
mod tests {
    use super::fresh_branch_checkout;

    #[test]
    fn fresh_branch_names_skip_taken_names_and_never_stack_suffixes() {
        let free = |taken: &'static [&'static str]| {
            move |name: &str| Ok((!taken.contains(&name)).then(|| format!("/x/{name}")))
        };
        assert_eq!(
            fresh_branch_checkout("feature/search-d7fa6880", free(&[]))
                .unwrap()
                .0,
            "feature/search-d7fa6880-r2"
        );
        assert_eq!(
            fresh_branch_checkout(
                "feature/search-d7fa6880-r2",
                free(&["feature/search-d7fa6880-r2"])
            )
            .unwrap()
            .0,
            "feature/search-d7fa6880-r3"
        );
        assert_eq!(
            fresh_branch_checkout("termloop/fix-run-r", free(&[]))
                .unwrap()
                .0,
            "termloop/fix-run-r-r2"
        );
    }
}
