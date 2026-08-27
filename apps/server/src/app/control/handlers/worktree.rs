use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

use termloop_contract::current::ProjectionTopic;
use termloop_core::CoreError;
use tokio::sync::Mutex;

use super::super::super::AppState;
use super::super::super::gates::ObservationPriority;
use super::super::super::health::refresh_all_health_demands;
use super::super::super::invalidation::{
    InvalidationRequest, invalidate_automatic_git_host_task, publish_scoped_task_invalidation,
    publish_task_invalidation_now, queue_task_invalidation,
};

const BRANCH_COMMIT_GATE_WAIT: Duration = Duration::from_secs(4);

pub(in crate::app::control) async fn bind_task_branch(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let task_id = params
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_branch_binding(params)?
    };
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|_| CoreError::RepositoryUnavailable)??;
    let (result, previous_revision, current_revision) = {
        let mut core = state.core.lock().await;
        let previous_revision = core.state_revision();
        let result = core.complete_task_branch_binding(observed);
        let current_revision = core.state_revision();
        (result, previous_revision, current_revision)
    };
    if result.is_ok() && current_revision != previous_revision {
        invalidate_automatic_git_host_task(state, &task_id).await;
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Task],
            state_revision: current_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
    result
}

pub(in crate::app::control) async fn inspect_task_worktree_cleanup(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let planning = {
        let core = state.core.lock().await;
        core.plan_task_worktree_cleanup_inspection(params)?
    };
    match planning {
        termloop_core::task_worktree::TaskWorktreeCleanupInspectionPlanning::Return(value) => {
            Ok(value)
        }
        termloop_core::task_worktree::TaskWorktreeCleanupInspectionPlanning::Observe(plan) => {
            // Explicit inspections use the same Project-fair two-job gate as
            // background health. The inner runner owns the absolute deadline
            // and process-tree termination, so await the worker to completion.
            let project_id = plan.project_id().to_owned();
            let _permit = state
                .git_observation_gate
                .acquire(project_id, ObservationPriority::Explicit)
                .await
                .map_err(|_| CoreError::GitObservationTimedOut)?;
            let observed = tokio::task::spawn_blocking(move || plan.observe())
                .await
                .map_err(|error| CoreError::Store(format!("cleanup inspector failed: {error}")))?;
            let mut core = state.core.lock().await;
            core.apply_task_worktree_cleanup_inspection(observed)
        }
    }
}

pub(in crate::app::control) async fn task_worktree_change_list(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_change_list(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("change list worker failed: {error}")))?;
    drop(permit);
    let mut core = state.core.lock().await;
    core.complete_task_worktree_change_list(observed)
}

pub(in crate::app::control) async fn task_worktree_diff(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_task_worktree_diff(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("worktree diff worker failed: {error}")))?;
    drop(permit);
    let core = state.core.lock().await;
    core.complete_task_worktree_diff(observed)
}

pub(in crate::app::control) async fn task_worktree_pre_image(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_task_worktree_pre_image(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("worktree pre-image worker failed: {error}")))?;
    drop(permit);
    let core = state.core.lock().await;
    core.complete_task_worktree_pre_image(observed)
}

pub(in crate::app::control) async fn task_branch_commit_summary_list(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let initial_plan = {
        let mut core = state.core.lock().await;
        core.plan_task_branch_commit_summary_list(params.clone())?
    };
    if !initial_plan.requires_observation() {
        let mut core = state.core.lock().await;
        return core.complete_task_branch_commit_summary_list(initial_plan.observe());
    }
    let project_id = initial_plan.project_id().to_owned();
    let gate_deadline = tokio::time::Instant::now() + BRANCH_COMMIT_GATE_WAIT;
    let permit = match state
        .git_observation_gate
        .acquire_until(project_id, ObservationPriority::Explicit, gate_deadline)
        .await
    {
        Ok(permit) => permit,
        Err(_) => {
            let mut core = state.core.lock().await;
            return core.complete_task_branch_commit_summary_list(
                initial_plan.observation_unavailable(CoreError::GitObservationTimedOut),
            );
        }
    };
    // A request can spend time behind another observation for the same Project.
    // Re-plan after admission so a result cached by that earlier request turns
    // this call into a cheap read instead of duplicate Git work.
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_task_branch_commit_summary_list(params)?
    };
    let refreshed_watch_targets = plan.requires_observation();
    let observed = if refreshed_watch_targets {
        tokio::task::spawn_blocking(move || plan.observe())
            .await
            .map_err(|error| CoreError::Store(format!("branch commit worker failed: {error}")))?
    } else {
        plan.observe()
    };
    drop(permit);
    let result = {
        let mut core = state.core.lock().await;
        core.complete_task_branch_commit_summary_list(observed)
    };
    if result.is_ok() && refreshed_watch_targets {
        let state = state.clone();
        tokio::spawn(async move {
            refresh_all_health_demands(&state).await;
        });
    }
    result
}

pub(in crate::app::control) async fn task_branch_commit_list(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_branch_commit_list(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("commit list worker failed: {error}")))?;
    drop(permit);
    let mut core = state.core.lock().await;
    core.complete_task_branch_commit_list(observed)
}

pub(in crate::app::control) async fn task_branch_commit_change_list(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_task_branch_commit_change_list(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("commit changes worker failed: {error}")))?;
    drop(permit);
    let mut core = state.core.lock().await;
    core.complete_task_branch_commit_change_list(observed)
}

pub(in crate::app::control) async fn task_branch_commit_diff(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let mut core = state.core.lock().await;
        core.plan_task_branch_commit_diff(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("commit diff worker failed: {error}")))?;
    drop(permit);
    let core = state.core.lock().await;
    core.complete_task_branch_commit_diff(observed)
}

pub(in crate::app::control) async fn inspect_task_worktree_repair(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_repair_inspection(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("repair inspection worker failed: {error}")))?;
    drop(permit);
    let core = state.core.lock().await;
    core.apply_task_worktree_repair_inspection(observed)
}

pub(in crate::app::control) async fn repair_task_worktree(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let operation_id = params
        .get("operationId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let request_lock = repair_request_lock(state, &operation_id);
    let _request_guard = request_lock.lock().await;
    let task_id = params
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_repair(params)?
    };
    let project_id = plan.project_id().to_owned();
    let mut repair_changed = false;
    let result = async {
        let permit = state
            .git_observation_gate
            .acquire(&project_id, ObservationPriority::Explicit)
            .await?;
        let observed = tokio::task::spawn_blocking(move || plan.observe())
            .await
            .map_err(|error| CoreError::Store(format!("repair observer failed: {error}")))?;
        drop(permit);
        let mut progress = {
            let mut core = state.core.lock().await;
            let previous = core.state_revision();
            let progress = core.begin_task_worktree_repair(observed);
            let current = core.state_revision();
            if current != previous {
                repair_changed = true;
            }
            progress?
        };
        loop {
            progress = match progress {
                termloop_core::task_worktree::TaskWorktreeRepairProgress::Return(value) => {
                    return Ok(value);
                }
                termloop_core::task_worktree::TaskWorktreeRepairProgress::Execute(step) => {
                    let permit = state
                        .git_observation_gate
                        .acquire(&project_id, ObservationPriority::Explicit)
                        .await?;
                    let executed = tokio::task::spawn_blocking(move || step.execute())
                        .await
                        .map_err(|error| {
                            CoreError::Store(format!("repair worker failed: {error}"))
                        })?;
                    drop(permit);
                    let mut core = state.core.lock().await;
                    let previous = core.state_revision();
                    let next = core.apply_task_worktree_repair_execution(executed);
                    let current = core.state_revision();
                    if current != previous {
                        repair_changed = true;
                    }
                    next?
                }
                termloop_core::task_worktree::TaskWorktreeRepairProgress::Verify(step) => {
                    let permit = state
                        .git_observation_gate
                        .acquire(&project_id, ObservationPriority::Explicit)
                        .await?;
                    let verified = tokio::task::spawn_blocking(move || step.observe())
                        .await
                        .map_err(|error| {
                            CoreError::Store(format!("repair verification worker failed: {error}"))
                        })?;
                    drop(permit);
                    let mut core = state.core.lock().await;
                    let previous = core.state_revision();
                    let result = core.apply_task_worktree_repair_verification(verified);
                    let current = core.state_revision();
                    if current != previous {
                        repair_changed = true;
                    }
                    return result;
                }
            };
        }
    }
    .await;
    let (current_revision, core_observation_sequence) = {
        let core = state.core.lock().await;
        (core.state_revision(), core.observation_sequence())
    };
    state
        .observation_sequence
        .fetch_max(core_observation_sequence, Ordering::Relaxed);
    if repair_changed {
        publish_scoped_task_invalidation(state, current_revision, &task_id);
    }
    result
}

fn repair_request_lock(state: &AppState, operation_id: &str) -> Arc<Mutex<()>> {
    let mut locks = state
        .repair_request_locks
        .lock()
        .expect("repair request lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(operation_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(operation_id.to_owned(), Arc::downgrade(&lock));
    lock
}

pub(in crate::app::control) async fn dismiss_task_worktree_repair(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let task_id = params
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_repair_dismissal(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(project_id, ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("repair dismissal observer failed: {error}")))?;
    drop(permit);
    let mut core = state.core.lock().await;
    let previous = core.state_revision();
    let result = core.apply_task_worktree_repair_dismissal(observed);
    let revision = core.state_revision();
    drop(core);
    if result.is_ok() && revision != previous {
        publish_scoped_task_invalidation(state, revision, &task_id);
    }
    result
}

pub(in crate::app::control) async fn cleanup_task_worktree(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let task_id = params
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let planning = {
        let core = state.core.lock().await;
        core.plan_task_worktree_cleanup(params)?
    };
    let (observed, cleanup_project_id) = match planning {
        termloop_core::task_worktree::TaskWorktreeCleanupPlanning::Return(value) => {
            return Ok(value);
        }
        termloop_core::task_worktree::TaskWorktreeCleanupPlanning::Finalize(finalization) => {
            let (result, previous_revision, revision) = {
                let mut core = state.core.lock().await;
                let previous = core.state_revision();
                let result = core.finalize_task_worktree_cleanup(*finalization);
                (result, previous, core.state_revision())
            };
            if result.is_ok() && revision != previous_revision {
                publish_scoped_task_invalidation(state, revision, &task_id);
            }
            return result;
        }
        termloop_core::task_worktree::TaskWorktreeCleanupPlanning::Observe(plan) => {
            let project_id = plan.project_id().to_owned();
            let _permit = state
                .git_observation_gate
                .acquire(&project_id, ObservationPriority::Explicit)
                .await
                .map_err(|_| CoreError::GitObservationTimedOut)?;
            let observed = tokio::task::spawn_blocking(move || plan.observe())
                .await
                .map_err(|error| CoreError::Store(format!("cleanup observer failed: {error}")))??;
            (observed, project_id)
        }
    };
    let (begin_result, previous_revision, revision) = {
        let mut core = state.core.lock().await;
        let previous = core.state_revision();
        let progress = core.begin_task_worktree_cleanup(observed);
        (progress, previous, core.state_revision())
    };
    let mut cleanup_changed = revision != previous_revision;
    let mut progress = match begin_result {
        Ok(progress) => progress,
        Err(error) => {
            if cleanup_changed {
                publish_scoped_task_invalidation(state, revision, &task_id);
            }
            return Err(error);
        }
    };
    loop {
        progress = match progress {
            termloop_core::task_worktree::TaskWorktreeCleanupProgress::Return(value) => {
                if cleanup_changed {
                    let revision = state.core.lock().await.state_revision();
                    publish_scoped_task_invalidation(state, revision, &task_id);
                }
                return Ok(value);
            }
            termloop_core::task_worktree::TaskWorktreeCleanupProgress::Revalidate(step)
            | termloop_core::task_worktree::TaskWorktreeCleanupProgress::Verify(step) => {
                let _permit = state
                    .git_observation_gate
                    .acquire(&cleanup_project_id, ObservationPriority::Explicit)
                    .await
                    .map_err(|_| CoreError::GitObservationTimedOut)?;
                let observed = tokio::task::spawn_blocking(move || step.observe())
                    .await
                    .map_err(|error| {
                        CoreError::Store(format!("cleanup observation worker failed: {error}"))
                    })??;
                let (next, previous_revision, revision) = {
                    let mut core = state.core.lock().await;
                    let previous = core.state_revision();
                    let next = core.apply_task_worktree_cleanup_observation(observed);
                    (next, previous, core.state_revision())
                };
                if revision != previous_revision {
                    cleanup_changed = true;
                }
                match next {
                    Ok(next) => next,
                    Err(error) => {
                        if cleanup_changed {
                            publish_scoped_task_invalidation(state, revision, &task_id);
                        }
                        return Err(error);
                    }
                }
            }
            termloop_core::task_worktree::TaskWorktreeCleanupProgress::Remove(step) => {
                let _permit = state
                    .git_observation_gate
                    .acquire(&cleanup_project_id, ObservationPriority::Explicit)
                    .await
                    .map_err(|_| CoreError::GitObservationTimedOut)?;
                let executed = tokio::task::spawn_blocking(move || step.execute())
                    .await
                    .map_err(|error| {
                        CoreError::Store(format!("cleanup removal worker failed: {error}"))
                    })?;
                let (next, previous_revision, revision) = {
                    let mut core = state.core.lock().await;
                    let previous = core.state_revision();
                    let next = core.apply_task_worktree_cleanup_removal(executed);
                    (next, previous, core.state_revision())
                };
                if revision != previous_revision {
                    cleanup_changed = true;
                }
                match next {
                    Ok(next) => next,
                    Err(error) => {
                        if cleanup_changed {
                            publish_scoped_task_invalidation(state, revision, &task_id);
                        }
                        return Err(error);
                    }
                }
            }
        };
    }
}

pub(in crate::app::control) async fn resolve_stale_task_worktree(
    params: serde_json::Value,
    discard_directory: bool,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let task_id = params
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let planning = {
        let core = state.core.lock().await;
        if discard_directory {
            core.plan_task_worktree_stale_disposal(params)?
        } else {
            core.plan_task_worktree_stale_forget(params)?
        }
    };
    let plan = match planning {
        termloop_core::task_worktree::TaskWorktreeStaleResolutionPlanning::Return(value) => {
            return Ok(value);
        }
        termloop_core::task_worktree::TaskWorktreeStaleResolutionPlanning::Observe(plan) => plan,
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire(&project_id, ObservationPriority::Explicit)
        .await
        .map_err(|_| CoreError::GitObservationTimedOut)?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("stale observer failed: {error}")))??;
    drop(permit);
    let (progress, previous_revision, revision) = {
        let mut core = state.core.lock().await;
        let previous = core.state_revision();
        let progress = core.begin_task_worktree_stale_resolution(observed);
        (progress, previous, core.state_revision())
    };
    if revision != previous_revision {
        publish_scoped_task_invalidation(state, revision, &task_id);
    }
    match progress? {
        termloop_core::task_worktree::TaskWorktreeStaleResolutionProgress::Return(value) => {
            Ok(value)
        }
        termloop_core::task_worktree::TaskWorktreeStaleResolutionProgress::Revalidate(step) => {
            let observed = tokio::task::spawn_blocking(move || step.observe())
                .await
                .map_err(|error| {
                    CoreError::Store(format!("stale forget observer failed: {error}"))
                })?;
            let (result, previous_revision, revision) = {
                let mut core = state.core.lock().await;
                let previous = core.state_revision();
                let result = core.apply_task_worktree_stale_forget(observed);
                (result, previous, core.state_revision())
            };
            if revision != previous_revision {
                publish_scoped_task_invalidation(state, revision, &task_id);
            }
            result
        }
        termloop_core::task_worktree::TaskWorktreeStaleResolutionProgress::Remove(step) => {
            let executed = tokio::task::spawn_blocking(move || step.execute())
                .await
                .map_err(|error| {
                    CoreError::Store(format!("stale disposal worker failed: {error}"))
                })?;
            let (result, previous_revision, revision) = {
                let mut core = state.core.lock().await;
                let previous = core.state_revision();
                let result = core.apply_task_worktree_stale_disposal(executed);
                (result, previous, core.state_revision())
            };
            if revision != previous_revision {
                publish_scoped_task_invalidation(state, revision, &task_id);
            }
            result
        }
    }
}

pub(in crate::app) async fn provision_task_worktree(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_provisioning(params)?
    };
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("provisioning observer failed: {error}")))??;
    let (mut progress, previous_revision, current_revision) = {
        let mut core = state.core.lock().await;
        let previous_revision = core.state_revision();
        let progress = core.begin_task_worktree_provisioning(observed);
        let current_revision = core.state_revision();
        (progress?, previous_revision, current_revision)
    };
    if current_revision != previous_revision {
        publish_task_invalidation_now(state, current_revision);
    }
    loop {
        let step = match progress {
            termloop_core::TaskWorktreeProvisioningProgress::Return(value) => return Ok(value),
            termloop_core::TaskWorktreeProvisioningProgress::Execute(step) => step,
        };
        let executed = tokio::task::spawn_blocking(move || step.execute())
            .await
            .map_err(|error| CoreError::Store(format!("provisioning worker failed: {error}")))?;
        let (result, previous_revision, current_revision) = {
            let mut core = state.core.lock().await;
            let previous_revision = core.state_revision();
            let result = core.apply_task_worktree_provisioning_step(executed);
            let current_revision = core.state_revision();
            (result, previous_revision, current_revision)
        };
        if current_revision != previous_revision {
            queue_task_invalidation(state, current_revision);
        }
        progress = result?;
    }
}

pub(in crate::app::control) async fn dismiss_task_worktree_provisioning(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_provisioning_dismissal(params)?
    };
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("dismiss observer failed: {error}")))??;
    let (result, previous_revision, current_revision) = {
        let mut core = state.core.lock().await;
        let previous_revision = core.state_revision();
        let result = core.complete_task_worktree_provisioning_dismissal(observed);
        let current_revision = core.state_revision();
        (result, previous_revision, current_revision)
    };
    if result.is_ok() && current_revision != previous_revision {
        queue_task_invalidation(state, current_revision);
    }
    result
}
