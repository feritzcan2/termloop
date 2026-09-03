use std::sync::{Arc, atomic::Ordering};

use serde_json::{Value, json};
use termloop_contract::current::{McpStewardTaskAgentStartParams, ProjectionTopic};
use termloop_core::{
    CoreError, StewardTaskAgentAssignmentState, TaskAgentStartStage, TaskAgentStartSuggestedAction,
};
use tokio::sync::Mutex;
use tokio::time::{Duration, Instant};

use super::invalidation::InvalidationRequest;
use super::{AppState, ObservationPriority};

pub(super) async fn start(
    project_id: &str,
    steward_session_id: &str,
    params: McpStewardTaskAgentStartParams,
    state: &AppState,
) -> Result<Value, CoreError> {
    let request_lock = task_start_lock(state, &params.task_id);
    let _request = request_lock.lock().await;

    let mut plan = state
        .core
        .lock()
        .await
        .plan_steward_task_agent_start(
            steward_session_id,
            project_id,
            &params.task_id,
            params.agent_id.as_deref(),
            params.model.as_deref(),
        )
        .map_err(|error| stage_error(error, TaskAgentStartStage::Planning, false, false))?;

    if plan.existing_worktree_path().is_none() {
        let branch_projection =
            super::control::project_list_local_branches(json!({ "projectId": project_id }), state)
                .await
                .map_err(|error| stage_error(error, TaskAgentStartStage::Planning, true, false))?;
        let repository_path = branch_projection
            .get("repository_root")
            .and_then(Value::as_str)
            .ok_or_else(|| start_error(TaskAgentStartStage::Planning, true, false))?;
        // Re-authorize after branch/path observation and before the mutation.
        plan = state
            .core
            .lock()
            .await
            .plan_steward_task_agent_start(
                steward_session_id,
                project_id,
                &params.task_id,
                params.agent_id.as_deref(),
                params.model.as_deref(),
            )
            .map_err(|error| stage_error(error, TaskAgentStartStage::Planning, false, false))?;
        if plan.existing_worktree_path().is_none() {
            let destination =
                termloop_platform::sibling_directory_path(repository_path, plan.worktree_leaf())
                    .map_err(|_| start_error(TaskAgentStartStage::Planning, false, false))?;
            let destination = destination
                .to_str()
                .ok_or_else(|| start_error(TaskAgentStartStage::Planning, false, false))?;
            let branch = select_provisioning_branch(
                plan.existing_branch_name(),
                plan.planned_branch_name(),
                &branch_projection,
                params.base_branch.as_deref(),
            )?;
            let mut provision_params = json!({
                "operationId": plan.operation_id(),
                "taskId": plan.task_id(),
                "repositoryPath": repository_path,
                "destinationPath": destination,
                "branchName": branch.name,
                "branchMode": branch.mode_name(),
            });
            if let Some(base_ref) = branch.base_ref {
                provision_params["baseRef"] = json!(base_ref);
            }
            super::control::provision_task_worktree(provision_params, state)
                .await
                .map_err(|error| {
                    stage_error(error, TaskAgentStartStage::WorktreeProvision, true, false)
                })?;
        }
    }

    refresh_checked_out_branch(project_id, &params.task_id, state).await;
    plan = state
        .core
        .lock()
        .await
        .plan_steward_task_agent_start(
            steward_session_id,
            project_id,
            &params.task_id,
            params.agent_id.as_deref(),
            params.model.as_deref(),
        )
        .map_err(|error| stage_error(error, TaskAgentStartStage::Planning, false, false))?;
    let worktree_path = plan
        .existing_worktree_path()
        .ok_or_else(|| start_error(TaskAgentStartStage::WorktreeProvision, true, false))?
        .to_owned();

    let existing_session = state
        .core
        .lock()
        .await
        .reusable_steward_task_agent_session(
            steward_session_id,
            project_id,
            &params.task_id,
            plan.agent_id(),
            plan.launch_selection(),
        )
        .map_err(|error| stage_error(error, TaskAgentStartStage::AgentLaunch, false, false))?;
    let (session_id, reused_session) = match existing_session {
        Some(session_id) => (session_id, true),
        None => {
            let preview = super::control::preview_steward_task_agent_session(
                json!({
                    "taskId": params.task_id,
                    "agentId": plan.agent_id(),
                    "model": plan.launch_selection().model,
                    "permission": plan.launch_selection().permission,
                    "reasoning": plan.launch_selection().reasoning,
                }),
                steward_session_id,
                &params.task_id,
                &params.assignment,
                Instant::now() + Duration::from_secs(15),
                state,
            )
            .await
            .map_err(|error| stage_error(error, TaskAgentStartStage::AgentLaunch, true, false))?;
            let launch_ticket = preview
                .get("launch_ticket")
                .and_then(Value::as_str)
                .ok_or_else(|| start_error(TaskAgentStartStage::AgentLaunch, true, false))?;
            let launched = super::control::launch_task_session(
                json!({
                    "taskId": params.task_id,
                    "agentId": plan.agent_id(),
                    "model": plan.launch_selection().model,
                    "permission": plan.launch_selection().permission,
                    "reasoning": plan.launch_selection().reasoning,
                    "launchTicket": launch_ticket,
                }),
                true,
                Instant::now() + Duration::from_secs(15),
                state,
            )
            .await
            .map_err(|error| stage_error(error, TaskAgentStartStage::AgentLaunch, true, false))?;
            let session_id = launched
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| start_error(TaskAgentStartStage::AgentLaunch, true, false))?
                .to_owned();
            (session_id, false)
        }
    };

    await_assignment_delivery(
        state,
        steward_session_id,
        project_id,
        &params.task_id,
        &session_id,
        &params.assignment,
    )
    .await?;

    let state_revision = {
        let mut core = state.core.lock().await;
        // The Agent start is already authoritative. A full transcript must not
        // turn ready success into an ambiguous retryable failure.
        let _ = core.append_steward_action(
            steward_session_id,
            project_id,
            "Started Task Agent and delivered its assignment.",
            Some(params.task_id.clone()),
            Some(session_id.clone()),
            super::current_epoch_ms(),
        );
        core.state_revision()
    };
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Companion, ProjectionTopic::Steward],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });

    Ok(json!({
        "taskId": plan.task_id(),
        "sessionId": session_id,
        "branchName": plan.branch_name(),
        "worktreePath": worktree_path,
        "agentId": plan.agent_id(),
        "model": plan.launch_selection().model,
        "permission": plan.launch_selection().permission,
        "reasoning": plan.launch_selection().reasoning,
        "assignmentDelivered": true,
        "reusedSession": reused_session,
        "status": "ready",
    }))
}

/// Refreshes the one live checkout fact used to name the branch in the start
/// result. Failure is intentionally a fallback to the durable Task branch: a
/// transient read must not make an otherwise launchable registered worktree
/// unusable.
async fn refresh_checked_out_branch(project_id: &str, task_id: &str, state: &AppState) {
    let plan = match state.core.lock().await.plan_task_worktree_health(task_id) {
        Ok(plan) => plan,
        Err(_) => return,
    };
    let Ok(permit) = state
        .git_observation_gate
        .acquire_until(
            project_id,
            ObservationPriority::Explicit,
            Instant::now() + Duration::from_secs(3),
        )
        .await
    else {
        return;
    };
    let observer = plan.clone();
    let Ok(Ok(observation)) = tokio::task::spawn_blocking(move || observer.observe_shared()).await
    else {
        return;
    };
    drop(permit);
    let (applied, state_revision) = {
        let mut core = state.core.lock().await;
        let applied = core.apply_observed_task_worktree_health(
            plan.with_observation(Ok(observation)),
            super::current_epoch_ms(),
        );
        (applied, core.state_revision())
    };
    if let Ok(applied) = applied
        && applied.changed
    {
        state
            .observation_sequence
            .fetch_max(applied.observation_sequence, Ordering::Relaxed);
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Task],
            state_revision,
            observation_sequence: applied.observation_sequence,
        });
    }
}

async fn await_assignment_delivery(
    state: &AppState,
    steward_session_id: &str,
    project_id: &str,
    task_id: &str,
    session_id: &str,
    assignment: &str,
) -> Result<(), CoreError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let assignment_state = state
            .core
            .lock()
            .await
            .steward_task_agent_assignment_state(
                steward_session_id,
                project_id,
                task_id,
                session_id,
            )
            .map_err(|error| {
                stage_error(error, TaskAgentStartStage::AssignmentDelivery, true, false)
            })?;
        match assignment_state {
            StewardTaskAgentAssignmentState::Delivered => return Ok(()),
            StewardTaskAgentAssignmentState::ReadyForDirectDelivery => {
                state
                    .core
                    .lock()
                    .await
                    .send_steward_task_assignment(
                        steward_session_id,
                        project_id,
                        task_id,
                        session_id,
                        assignment,
                    )
                    .map_err(|error| {
                        stage_error(error, TaskAgentStartStage::AssignmentDelivery, true, false)
                    })?;
            }
            StewardTaskAgentAssignmentState::Pending if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            StewardTaskAgentAssignmentState::Pending => {
                return Err(start_error(
                    TaskAgentStartStage::AssignmentDelivery,
                    true,
                    false,
                ));
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProvisioningBranch {
    name: String,
    base_ref: Option<String>,
}

impl ProvisioningBranch {
    fn mode_name(&self) -> &'static str {
        if self.base_ref.is_some() {
            "create"
        } else {
            "existing"
        }
    }
}

fn select_provisioning_branch(
    existing_branch_name: Option<&str>,
    planned_branch_name: &str,
    projection: &Value,
    requested_base: Option<&str>,
) -> Result<ProvisioningBranch, CoreError> {
    if let Some(bound) = existing_branch_name {
        return Ok(ProvisioningBranch {
            name: bound.to_owned(),
            base_ref: None,
        });
    }
    let planned_ref = format!("refs/heads/{planned_branch_name}");
    if observed_branch_refs(projection).any(|candidate| candidate == planned_ref) {
        return Ok(ProvisioningBranch {
            name: planned_branch_name.to_owned(),
            base_ref: None,
        });
    }
    Ok(ProvisioningBranch {
        name: planned_branch_name.to_owned(),
        base_ref: Some(select_base_ref(projection, requested_base)?),
    })
}

fn select_base_ref(projection: &Value, requested: Option<&str>) -> Result<String, CoreError> {
    let observed = observed_branch_refs(projection).collect::<Vec<_>>();
    let observed_branches = observed
        .iter()
        .filter_map(|branch| branch.strip_prefix("refs/heads/"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let selected = if let Some(requested) = requested {
        let requested = requested.strip_prefix("refs/heads/").unwrap_or(requested);
        let exact = format!("refs/heads/{requested}");
        observed
            .iter()
            .any(|candidate| *candidate == exact)
            .then_some(exact)
    } else {
        ["development", "dev", "main", "master"]
            .into_iter()
            .map(|name| format!("refs/heads/{name}"))
            .find(|candidate| observed.iter().any(|observed| observed == candidate))
    };
    selected.ok_or_else(|| base_selection_error(observed_branches))
}

fn observed_branch_refs(projection: &Value) -> impl Iterator<Item = &str> {
    projection
        .get("branches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|branch| branch.get("exact_ref").and_then(Value::as_str))
}

fn start_error(stage: TaskAgentStartStage, retryable: bool, choose_base: bool) -> CoreError {
    CoreError::TaskAgentStartFailed {
        stage,
        retryable,
        suggested_action: if choose_base {
            TaskAgentStartSuggestedAction::ChooseBaseBranch
        } else if retryable {
            TaskAgentStartSuggestedAction::Retry
        } else {
            TaskAgentStartSuggestedAction::InspectTask
        },
        observed_branches: Vec::new(),
    }
}

fn base_selection_error(observed_branches: Vec<String>) -> CoreError {
    CoreError::TaskAgentStartFailed {
        stage: TaskAgentStartStage::Planning,
        retryable: false,
        suggested_action: TaskAgentStartSuggestedAction::ChooseBaseBranch,
        observed_branches,
    }
}

fn stage_error(
    error: CoreError,
    stage: TaskAgentStartStage,
    retryable: bool,
    choose_base: bool,
) -> CoreError {
    match error {
        CoreError::CapabilityDenied
        | CoreError::AgentUnsupported
        | CoreError::InvalidParams(_)
        | CoreError::TaskAgentStartFailed { .. }
        | CoreError::TaskAgentAlreadyAttached { .. } => error,
        _ => start_error(stage, retryable_for(&error, retryable), choose_base),
    }
}

fn retryable_for(error: &CoreError, fallback: bool) -> bool {
    if matches!(
        error,
        CoreError::BranchHeldByTask { .. }
            | CoreError::TaskBranchAlreadyBound { .. }
            | CoreError::WorktreePathHeldByTask { .. }
            | CoreError::OperationIdReused { .. }
            | CoreError::BranchCheckedOutElsewhere { .. }
            | CoreError::WorktreeRecoveryAttention { .. }
            | CoreError::WorktreePathConflict
            | CoreError::WorktreeLocked
            | CoreError::TaskWorktreeCleanupRequired { .. }
            | CoreError::RepositoryPermissionDenied
            | CoreError::GitUnsupportedVersion
            | CoreError::CorruptRepository
            | CoreError::UnsupportedRepository
    ) {
        return false;
    }
    matches!(
        error,
        CoreError::ProvisioningAlreadyInProgress { .. }
            | CoreError::BranchMutationConflict
            | CoreError::RevisionConflict
            | CoreError::ConversationBusy
            | CoreError::GitObservationTimedOut
            | CoreError::RepositoryUnavailable
            | CoreError::GitUnavailable
            | CoreError::Store(_)
            | CoreError::Terminal(_)
    ) || fallback
}

fn task_start_lock(state: &AppState, task_id: &str) -> Arc<Mutex<()>> {
    let mut locks = state
        .steward_task_start_locks
        .lock()
        .expect("Task Agent start lock registry poisoned");
    if let Some(lock) = locks.get(task_id).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    locks.insert(task_id.to_owned(), Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_selection_is_observed_exact_and_deterministic() {
        let projection = json!({
            "branches": [
                { "name": "main", "exact_ref": "refs/heads/main" },
                { "name": "development", "exact_ref": "refs/heads/development" }
            ]
        });
        assert_eq!(
            select_base_ref(&projection, None).unwrap(),
            "refs/heads/development"
        );
        assert_eq!(
            select_base_ref(&projection, Some("main")).unwrap(),
            "refs/heads/main"
        );
        assert_eq!(
            select_base_ref(&projection, Some("refs/heads/main")).unwrap(),
            "refs/heads/main"
        );
        let error = select_base_ref(&projection, Some("missing")).unwrap_err();
        assert!(matches!(
            error,
            CoreError::TaskAgentStartFailed {
                stage: TaskAgentStartStage::Planning,
                suggested_action: TaskAgentStartSuggestedAction::ChooseBaseBranch,
                ref observed_branches,
                ..
            } if observed_branches == &["main", "development"]
        ));
        assert!(matches!(
            stage_error(
                CoreError::TaskAgentStartFailed {
                    stage: TaskAgentStartStage::Planning,
                    retryable: false,
                    suggested_action: TaskAgentStartSuggestedAction::ConfigureAgent,
                    observed_branches: vec![],
                },
                TaskAgentStartStage::Planning,
                false,
                false,
            ),
            CoreError::TaskAgentStartFailed {
                suggested_action: TaskAgentStartSuggestedAction::ConfigureAgent,
                ..
            }
        ));
    }

    #[test]
    fn branch_bound_and_preexisting_planned_branches_are_reused() {
        let projection = json!({
            "branches": [
                { "exact_ref": "refs/heads/main" },
                { "exact_ref": "refs/heads/termloop/fix-task" }
            ]
        });
        assert_eq!(
            select_provisioning_branch(
                Some("already-bound"),
                "termloop/new-name",
                &projection,
                None,
            )
            .unwrap(),
            ProvisioningBranch {
                name: "already-bound".into(),
                base_ref: None,
            }
        );
        assert_eq!(
            select_provisioning_branch(None, "termloop/fix-task", &projection, None).unwrap(),
            ProvisioningBranch {
                name: "termloop/fix-task".into(),
                base_ref: None,
            }
        );
        assert_eq!(
            select_provisioning_branch(None, "termloop/new-task", &projection, None).unwrap(),
            ProvisioningBranch {
                name: "termloop/new-task".into(),
                base_ref: Some("refs/heads/main".into()),
            }
        );
    }

    #[test]
    fn staged_failures_do_not_hide_authorization_or_validation_refusals() {
        assert!(matches!(
            stage_error(
                CoreError::CapabilityDenied,
                TaskAgentStartStage::Planning,
                false,
                false,
            ),
            CoreError::CapabilityDenied
        ));
        assert!(matches!(
            stage_error(
                CoreError::AgentUnsupported,
                TaskAgentStartStage::AgentLaunch,
                false,
                false,
            ),
            CoreError::AgentUnsupported
        ));
        assert!(matches!(
            stage_error(
                CoreError::WorktreePathConflict,
                TaskAgentStartStage::WorktreeProvision,
                true,
                false,
            ),
            CoreError::TaskAgentStartFailed {
                retryable: false,
                suggested_action: TaskAgentStartSuggestedAction::InspectTask,
                ..
            }
        ));
        assert!(matches!(
            stage_error(
                CoreError::TaskAgentAlreadyAttached {
                    task_id: "task-1".into(),
                    session_id: "123e4567-e89b-42d3-a456-426614174000".into(),
                },
                TaskAgentStartStage::AgentLaunch,
                true,
                false,
            ),
            CoreError::TaskAgentAlreadyAttached { task_id, session_id }
                if task_id == "task-1"
                    && session_id == "123e4567-e89b-42d3-a456-426614174000"
        ));
    }
}
