use termloop_core::{CoreError, SourceControlMutationPlan, SourceControlSync};

use super::super::super::AppState;
use super::super::super::gates::ObservationPriority;
use super::super::super::health::HealthTrigger;

pub(in crate::app::control) async fn source_control_status(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = state.core.lock().await.plan_source_control_root(&params)?;
    let permit = state
        .git_observation_gate
        .acquire(plan.project_id().to_owned(), ObservationPriority::Explicit)
        .await?;
    let observed = tokio::task::spawn_blocking(move || plan.observe_status())
        .await
        .map_err(|error| {
            CoreError::Store(format!("Source Control status worker failed: {error}"))
        })?;
    drop(permit);
    state
        .core
        .lock()
        .await
        .complete_source_control_status(observed)
}

#[derive(Clone, Copy)]
pub(in crate::app::control) enum SourceControlRequest {
    Stage,
    Unstage,
    Discard,
    Commit,
    Sync(SourceControlSync),
}

/// Runs one explicit Source Control mutation. Git work runs outside the core
/// lock and does not take the shared observation gate, so a slow push never
/// starves status reads. A request that times out on the client may still
/// have reached Git; the next status read shows the outcome.
pub(in crate::app::control) async fn source_control_mutation(
    params: serde_json::Value,
    request: SourceControlRequest,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan: SourceControlMutationPlan = {
        let core = state.core.lock().await;
        match request {
            SourceControlRequest::Stage => core.plan_source_control_stage(&params),
            SourceControlRequest::Unstage => core.plan_source_control_unstage(&params),
            SourceControlRequest::Discard => core.plan_source_control_discard(&params),
            SourceControlRequest::Commit => core.plan_source_control_commit(&params),
            SourceControlRequest::Sync(sync) => core.plan_source_control_sync(&params, sync),
        }?
    };
    let project_id = plan.project_id().to_owned();
    let task_id = plan.task_id().map(str::to_owned);
    let executed = tokio::task::spawn_blocking(move || plan.execute())
        .await
        .map_err(|error| CoreError::Store(format!("Source Control worker failed: {error}")))?;
    let (result, target) = {
        let core = state.core.lock().await;
        let result = core.complete_source_control_mutation(executed);
        let target = task_id.and_then(|task_id| {
            core.task_worktree_watch_targets(&[project_id])
                .into_iter()
                .find(|target| target.task_id == task_id)
        });
        (result, target)
    };
    // Even a refused request may have changed the checkout (a hook that
    // edited files, a partial push), so the Task's cached counts re-observe.
    if let Some(target) = target {
        let _ = state
            .health_triggers
            .send(HealthTrigger::Target {
                target,
                unknown: false,
            })
            .await;
    }
    result
}
