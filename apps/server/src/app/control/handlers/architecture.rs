use termloop_contract::current::{
    ProjectArchitectureGraphParams, ProjectArchitectureNodeParams,
    ProjectArchitectureRefreshParams, ProjectArchitectureSummaryParams,
};
use termloop_core::CoreError;

use super::super::super::AppState;

pub(in crate::app) async fn project_architecture_summary(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<ProjectArchitectureSummaryParams>(params)
        .map_err(|_| CoreError::InvalidParams("project.architectureSummary".into()))?;
    let plan = {
        let core = state.core.lock().await;
        core.plan_project_architecture(&params.project_id)?
    };
    tokio::task::spawn_blocking(move || plan.summary())
        .await
        .map_err(|error| CoreError::Store(format!("Architecture summary worker failed: {error}")))?
}

pub(in crate::app) async fn project_architecture_graph(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<ProjectArchitectureGraphParams>(params)
        .map_err(|_| CoreError::InvalidParams("project.architectureGraph".into()))?;
    let plan = {
        let core = state.core.lock().await;
        core.plan_project_architecture(&params.project_id)?
    };
    let depth = params.depth.unwrap_or(2) as usize;
    let limit = params.limit.unwrap_or(240) as usize;
    tokio::task::spawn_blocking(move || {
        plan.graph(
            params.center_node_id.as_deref(),
            params.community_key.as_deref(),
            depth,
            limit,
        )
    })
    .await
    .map_err(|error| CoreError::Store(format!("Architecture graph worker failed: {error}")))?
}

pub(in crate::app) async fn project_architecture_node(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<ProjectArchitectureNodeParams>(params)
        .map_err(|_| CoreError::InvalidParams("project.architectureNode".into()))?;
    let plan = {
        let core = state.core.lock().await;
        core.plan_project_architecture(&params.project_id)?
    };
    tokio::task::spawn_blocking(move || plan.node(&params.node_id))
        .await
        .map_err(|error| CoreError::Store(format!("Architecture node worker failed: {error}")))?
}

pub(in crate::app) async fn project_architecture_refresh(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let params = serde_json::from_value::<ProjectArchitectureRefreshParams>(params)
        .map_err(|_| CoreError::InvalidParams("project.architectureRefresh".into()))?;
    let _permit = state
        .architecture_refresh_gate
        .try_admit(params.project_id.clone())
        .ok_or(CoreError::RevisionConflict)?;
    let plan = {
        let core = state.core.lock().await;
        core.plan_project_architecture(&params.project_id)?
    };
    tokio::task::spawn_blocking(move || plan.refresh())
        .await
        .map_err(|error| CoreError::Store(format!("Architecture refresh worker failed: {error}")))?
}
