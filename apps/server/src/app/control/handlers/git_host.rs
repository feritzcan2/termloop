use std::collections::HashMap;
use std::sync::atomic::Ordering;

#[cfg(test)]
use serde_json::json;
use termloop_contract::current::{
    GitHostProvider, GitHostPullRequestChangeListParams, GitHostPullRequestDiffParams,
    GitHostPullRequestIdentityDto, GitHostPullRequestListParams, ProjectListLocalBranchesParams,
    ProjectWorktreeChangeListParams, ProjectWorktreeSummaryParams, ProjectionInvalidatedPayload,
    ProjectionTopic, TaskProjectionEntityScopeDto, TaskProjectionTopic,
};
use termloop_core::CoreError;
use termloop_core::companion_integrations::pull_request_changes::{
    GitHostPullRequestSelection, GitHostSelectionProvider,
};
use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tokio::time::{Duration, Instant};

use super::super::super::gates::ObservationPriority;
use super::super::super::{AppState, current_epoch_ms};

const MAX_GIT_HOST_RESPONSE_BYTES: usize = 1024 * 1024;
const GIT_HOST_CONTENT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(22);

pub(in crate::app) async fn git_host_pull_request_change_list(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let deadline = Instant::now() + GIT_HOST_CONTENT_RESPONSE_TIMEOUT;
    let params = serde_json::from_value::<GitHostPullRequestChangeListParams>(params)
        .map_err(|_| CoreError::InvalidParams("gitHost.pullRequestChangeList".into()))?;
    let selection = selection_from_dto(params.pull_request);
    let plan = {
        let core = state.core.lock().await;
        core.plan_git_host_pull_request_change_list(
            &params.task_id,
            params.expected_freshness_generation,
            selection,
        )?
    };
    let outcome = if let Some(job) = plan.job() {
        let receiver = tokio::time::timeout_at(
            deadline,
            state
                .git_host_query_scheduler
                .schedule_content(plan.project_id().to_owned(), job),
        )
        .await
        .ok();
        match receiver {
            Some(receiver) => tokio::time::timeout_at(deadline, receiver)
                .await
                .ok()
                .and_then(Result::ok),
            None => None,
        }
    } else {
        None
    };
    let result = state
        .core
        .lock()
        .await
        .apply_git_host_pull_request_change_list(plan, outcome, current_epoch_ms())?;
    if serde_json::to_vec(&result)
        .map_err(|_| CoreError::Store("PR change list serialization failed".into()))?
        .len()
        > MAX_GIT_HOST_RESPONSE_BYTES
    {
        return Err(CoreError::Store(
            "PR change list response limit exceeded".into(),
        ));
    }
    Ok(result)
}

pub(in crate::app) async fn git_host_pull_request_diff(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let deadline = Instant::now() + GIT_HOST_CONTENT_RESPONSE_TIMEOUT;
    let params = serde_json::from_value::<GitHostPullRequestDiffParams>(params)
        .map_err(|_| CoreError::InvalidParams("gitHost.pullRequestDiff".into()))?;
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_git_host_pull_request_diff(
            &params.task_id,
            &params.observation_id,
            &params.entry_id,
            current_epoch_ms(),
        )?
    };
    let outcome = if let Some(job) = plan.job() {
        let project_id = plan.project_id().ok_or(CoreError::NotFound)?.to_owned();
        let receiver = tokio::time::timeout_at(
            deadline,
            state
                .git_host_query_scheduler
                .schedule_content(project_id, job),
        )
        .await
        .ok();
        match receiver {
            Some(receiver) => tokio::time::timeout_at(deadline, receiver)
                .await
                .ok()
                .and_then(Result::ok),
            None => None,
        }
    } else {
        None
    };
    state
        .core
        .lock()
        .await
        .apply_git_host_pull_request_diff(plan, outcome, current_epoch_ms())
}

fn selection_from_dto(value: GitHostPullRequestIdentityDto) -> GitHostPullRequestSelection {
    GitHostPullRequestSelection {
        provider: match value.provider {
            GitHostProvider::Github => GitHostSelectionProvider::Github,
            GitHostProvider::AzureDevOps => GitHostSelectionProvider::AzureDevOps,
        },
        repository_owner: value.repository_owner,
        repository_project: value.repository_project,
        repository_name: value.repository_name,
        number: value.number,
    }
}

pub(in crate::app) async fn project_list_local_branches(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<ProjectListLocalBranchesParams>(params)
        .map_err(|_| CoreError::InvalidParams("project.listLocalBranches".into()))?;
    let plan = {
        let core = state.core.lock().await;
        core.plan_project_local_branch_list(&params.project_id)?
    };
    tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|_| CoreError::RepositoryUnavailable)?
}

pub(in crate::app) async fn project_worktree_summary(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<ProjectWorktreeSummaryParams>(params)
        .map_err(|_| CoreError::InvalidParams("project.worktreeSummary".into()))?;
    let plan = {
        let core = state.core.lock().await;
        core.plan_project_worktree_summary(&params.project_id)?
    };
    let _permit = state
        .git_observation_gate
        .acquire(params.project_id, ObservationPriority::Explicit)
        .await
        .map_err(|_| CoreError::GitObservationTimedOut)?;
    tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|_| CoreError::RepositoryUnavailable)?
}

pub(in crate::app) async fn project_worktree_change_list(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<ProjectWorktreeChangeListParams>(params)
        .map_err(|_| CoreError::InvalidParams("project.worktreeChangeList".into()))?;
    let plan = {
        let core = state.core.lock().await;
        core.plan_project_worktree_change_list(&params.project_id)?
    };
    let permit = state
        .git_observation_gate
        .acquire(params.project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("Project change list worker failed: {error}")))?;
    drop(permit);
    state
        .core
        .lock()
        .await
        .complete_project_worktree_change_list(observed)
}

pub(in crate::app) async fn project_worktree_diff(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_project_worktree_diff(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| {
            CoreError::Store(format!("Project worktree diff worker failed: {error}"))
        })?;
    drop(permit);
    state
        .core
        .lock()
        .await
        .complete_project_worktree_diff(observed)
}

pub(in crate::app) async fn project_worktree_pre_image(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_project_worktree_pre_image(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("Project pre-image worker failed: {error}")))?;
    drop(permit);
    state
        .core
        .lock()
        .await
        .complete_project_worktree_pre_image(observed)
}

pub(in crate::app) async fn git_host_pull_request_list(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    git_host_pull_request_list_with_priority(params, state, ObservationPriority::Explicit).await
}

pub(in crate::app) async fn git_host_pull_request_list_background(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    git_host_pull_request_list_with_priority(params, state, ObservationPriority::Background).await
}

async fn git_host_pull_request_list_with_priority(
    params: serde_json::Value,
    state: &AppState,
    priority: ObservationPriority,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<GitHostPullRequestListParams>(params)
        .map_err(|_| CoreError::InvalidParams("gitHost.pullRequestList".into()))?;
    if priority == ObservationPriority::Explicit {
        let cached = {
            let core = state.core.lock().await;
            core.cached_git_host_pull_request_list(
                &params.project_id,
                &params.task_ids,
                current_epoch_ms(),
            )?
        };
        if let Some(cached) = cached {
            let mut result = cached.result;
            bound_git_host_result(&mut result)?;
            if cached.refresh_due {
                let state = state.clone();
                tokio::spawn(async move {
                    let _ = observe_git_host_pull_request_list(
                        params,
                        &state,
                        ObservationPriority::Background,
                    )
                    .await;
                });
            }
            return Ok(result);
        }
    }
    observe_git_host_pull_request_list(params, state, priority).await
}

async fn observe_git_host_pull_request_list(
    params: GitHostPullRequestListParams,
    state: &AppState,
    priority: ObservationPriority,
) -> Result<serde_json::Value, CoreError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let plan = {
        let core = state.core.lock().await;
        core.plan_git_host_pull_request_list(
            &params.project_id,
            &params.task_ids,
            current_epoch_ms(),
        )?
    };
    let degraded = plan.degraded_observation(
        termloop_core::companion_integrations::GitHostProjectionReason::Timeout,
    );
    let prepared = match tokio::time::timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || plan.prepare()),
    )
    .await
    {
        Ok(Ok(prepared)) => Some(prepared),
        Ok(Err(_)) | Err(_) => None,
    };
    let observed = if let Some(prepared) = prepared {
        let jobs = prepared.provider_jobs();
        let receivers = tokio::time::timeout_at(
            deadline,
            state.git_host_query_scheduler.schedule(
                params.project_id.clone(),
                priority,
                jobs.clone(),
            ),
        )
        .await;
        let completed = match receivers {
            Ok(receivers) => {
                collect_keyed_receivers_before_deadline(
                    deadline,
                    jobs.iter()
                        .zip(receivers)
                        .map(|(job, receiver)| (job.key().to_owned(), receiver))
                        .collect(),
                )
                .await
            }
            Err(_) => HashMap::new(),
        };
        let outcomes = jobs
            .iter()
            .map(|job| {
                completed
                    .get(job.key())
                    .filter(|outcome| outcome.key() == job.key())
                    .cloned()
                    .unwrap_or_else(|| job.timeout_outcome())
            })
            .collect();
        prepared.complete(outcomes)
    } else {
        degraded
    };
    let (mut result, invalidated, state_revision, observation_sequence) = {
        let mut core = state.core.lock().await;
        let (result, mut changed, follow_up) = core.apply_git_host_pull_request_list(observed)?;
        changed.extend(follow_up);
        changed.sort();
        changed.dedup();
        let observation_sequence = if changed.is_empty() {
            core.observation_sequence()
        } else {
            core.next_observation_sequence()?
        };
        (result, changed, core.state_revision(), observation_sequence)
    };
    state
        .observation_sequence
        .fetch_max(observation_sequence, Ordering::Relaxed);
    bound_git_host_result(&mut result)?;
    if !invalidated.is_empty() {
        let _ = state.invalidations.send(ProjectionInvalidatedPayload {
            topics: vec![ProjectionTopic::GitHost],
            state_revision,
            observation_sequence,
            entity_scopes: Some(vec![TaskProjectionEntityScopeDto {
                topic: TaskProjectionTopic::GitHost,
                ids: invalidated,
            }]),
        });
    }
    Ok(result)
}

async fn collect_keyed_receivers_before_deadline<T>(
    deadline: Instant,
    receivers: Vec<(String, oneshot::Receiver<T>)>,
) -> HashMap<String, T>
where
    T: Send + 'static,
{
    let mut pending = JoinSet::new();
    for (key, receiver) in receivers {
        pending.spawn(async move { (key, receiver.await.ok()) });
    }
    let mut completed = HashMap::new();
    while !pending.is_empty() {
        match tokio::time::timeout_at(deadline, pending.join_next()).await {
            Ok(Some(Ok((key, Some(value))))) => {
                completed.insert(key, value);
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => break,
        }
    }
    while let Some(result) = pending.try_join_next() {
        if let Ok((key, Some(value))) = result {
            completed.insert(key, value);
        }
    }
    pending.abort_all();
    completed
}

fn bound_git_host_result(result: &mut serde_json::Value) -> Result<(), CoreError> {
    let mut encoded_len = serde_json::to_vec(result)
        .map_err(|_| CoreError::Store("projection serialization failed".into()))?
        .len();
    loop {
        if encoded_len <= MAX_GIT_HOST_RESPONSE_BYTES {
            return Ok(());
        }
        let Some(projections) = result.as_array_mut() else {
            return Err(CoreError::Store("projection result shape invalid".into()));
        };
        let candidate = projections.iter_mut().rev().find(|projection| {
            projection
                .get("matches")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|matches| !matches.is_empty())
        });
        let Some(projection) = candidate else {
            return Err(CoreError::Store(
                "projection response limit exceeded".into(),
            ));
        };
        let matches = projection
            .get_mut("matches")
            .and_then(serde_json::Value::as_array_mut)
            .expect("selected projection has matches");
        let removed = matches.pop().expect("selected projection has a match");
        let mut removed_bytes = serde_json::to_vec(&removed)
            .map_err(|_| CoreError::Store("projection serialization failed".into()))?
            .len();
        if !matches.is_empty() {
            removed_bytes += 1;
        }
        let was_truncated = projection
            .get("truncated")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        projection["truncated"] = serde_json::Value::Bool(true);
        encoded_len = encoded_len.saturating_sub(removed_bytes + usize::from(!was_truncated));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_host_result_drops_match_tails_at_serialized_cap() {
        let match_value = json!({ "title": "x".repeat(4 * 1024) });
        let mut result = serde_json::Value::Array(
            (0..40)
                .map(|index| {
                    json!({
                        "task_id": format!("task-{index}"),
                        "matches": vec![match_value.clone(); 16],
                        "truncated": false,
                    })
                })
                .collect(),
        );
        bound_git_host_result(&mut result).unwrap();
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_GIT_HOST_RESPONSE_BYTES);
        assert!(result.as_array().unwrap().iter().any(|projection| {
            projection.get("truncated") == Some(&serde_json::Value::Bool(true))
        }));
    }

    #[test]
    fn content_response_deadline_includes_scheduler_margin() {
        assert_eq!(GIT_HOST_CONTENT_RESPONSE_TIMEOUT, Duration::from_secs(22));
    }

    #[tokio::test]
    async fn git_host_deadline_preserves_completed_aliases_and_only_omits_the_slow_alias() {
        let (first_sender, first_receiver) = oneshot::channel();
        let (second_sender, second_receiver) = oneshot::channel();
        let (_slow_sender, slow_receiver) = oneshot::channel::<u8>();
        first_sender.send(1_u8).unwrap();
        second_sender.send(2_u8).unwrap();

        let completed = collect_keyed_receivers_before_deadline(
            Instant::now() + Duration::from_millis(25),
            vec![
                ("first".into(), first_receiver),
                ("slow".into(), slow_receiver),
                ("second".into(), second_receiver),
            ],
        )
        .await;

        assert_eq!(completed.get("first"), Some(&1));
        assert_eq!(completed.get("second"), Some(&2));
        assert!(!completed.contains_key("slow"));
    }
}
