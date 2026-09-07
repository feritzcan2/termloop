use termloop_core::CoreError;
use tokio::time::Instant;

use super::super::super::AppState;
use super::super::super::gates::ObservationPriority;

pub(in crate::app::control) async fn preview_task_workflow_session(
    params: serde_json::Value,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let task_id = params
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let workflow_id = params
        .get("workflowId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let goal = params
        .get("goal")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_workflow_launch(params)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire_until(&project_id, ObservationPriority::Explicit, deadline)
        .await
        .map_err(|_| task_launch_timeout(&task_id))?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| task_launch_timeout(&task_id))?;
    let observed = tokio::task::spawn_blocking(move || plan.observe(remaining))
        .await
        .map_err(|error| CoreError::Store(format!("Task launch observation failed: {error}")))??;
    drop(permit);
    let agent_plan = {
        let core = state.core.lock().await;
        let plan = core.complete_task_agent_launch_plan(observed)?;
        core.attach_task_workflow(plan, &task_id, &workflow_id, &goal)?
    };
    state
        .core
        .lock()
        .await
        .preview_prepared_task_agent_launch(agent_plan)
}

fn task_launch_timeout(task_id: &str) -> CoreError {
    CoreError::TaskWorktreeUnavailable {
        task_id: task_id.to_owned(),
        reason: termloop_core::TaskWorktreeUnavailableReason::Timeout,
    }
}
