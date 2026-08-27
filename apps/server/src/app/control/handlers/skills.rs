use serde_json::Value;
use termloop_contract::current as protocol;
use termloop_core::{CoreError, SkillCatalogPlan, SkillDeploymentAgent};

use super::super::super::AppState;

pub(in crate::app) async fn get_skill_catalog(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::SkillCatalogGetParams>(params)
        .expect("validated skill catalog params");
    let plan = {
        let core = state.core.lock().await;
        core.plan_skill_catalog(params.project_id.as_deref())?
    };
    observe_catalog(plan, state).await
}

pub(in crate::app) async fn set_skill_deployment(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::SkillDeploymentSetParams>(params)
        .expect("validated skill deployment params");
    let agent = match params.agent {
        protocol::SkillAgent::Claude => SkillDeploymentAgent::Claude,
        protocol::SkillAgent::Codex => SkillDeploymentAgent::Codex,
    };
    let plan = {
        let core = state.core.lock().await;
        core.plan_skill_deployment(
            params.project_id.as_deref(),
            &params.skill_id,
            agent,
            params.deployed,
        )?
    };
    let manager = state.skill_manager.clone();
    tokio::task::spawn_blocking(move || {
        let scope = platform_scope(plan.catalog());
        let agent = match plan.agent() {
            SkillDeploymentAgent::Claude => termloop_platform::SkillAgent::Claude,
            SkillDeploymentAgent::Codex => termloop_platform::SkillAgent::Codex,
        };
        manager
            .set_deployment(scope, plan.skill_id(), agent, plan.deployed())
            .map_err(|error| CoreError::Terminal(error.to_string()))
            .and_then(|catalog| {
                serde_json::to_value(catalog)
                    .map_err(|error| CoreError::Terminal(error.to_string()))
            })
    })
    .await
    .map_err(|_| CoreError::Terminal("skill deployment worker stopped unexpectedly".into()))?
}

pub(in crate::app) async fn get_skill_definition(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::SkillDefinitionGetParams>(params)
        .expect("validated skill definition params");
    let plan = {
        let core = state.core.lock().await;
        core.plan_skill_catalog(params.project_id.as_deref())?
    };
    let manager = state.skill_manager.clone();
    tokio::task::spawn_blocking(move || {
        manager
            .read_definition(platform_scope(&plan), &params.skill_id)
            .map_err(skill_error)
            .and_then(|definition| {
                serde_json::to_value(definition)
                    .map_err(|error| CoreError::Terminal(error.to_string()))
            })
    })
    .await
    .map_err(|_| CoreError::Terminal("skill definition worker stopped unexpectedly".into()))?
}

pub(in crate::app) async fn save_skill_definition(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::SkillDefinitionSaveParams>(params)
        .expect("validated skill definition save params");
    let plan = {
        let core = state.core.lock().await;
        core.plan_skill_catalog(params.project_id.as_deref())?
    };
    let manager = state.skill_manager.clone();
    tokio::task::spawn_blocking(move || {
        manager
            .write_definition(
                platform_scope(&plan),
                &params.skill_id,
                &params.expected_content_sha256,
                &params.content,
            )
            .map_err(skill_error)
            .and_then(|definition| {
                serde_json::to_value(definition)
                    .map_err(|error| CoreError::Terminal(error.to_string()))
            })
    })
    .await
    .map_err(|_| CoreError::Terminal("skill definition worker stopped unexpectedly".into()))?
}

fn skill_error(error: termloop_platform::SkillManagerError) -> CoreError {
    match error {
        termloop_platform::SkillManagerError::SkillNotFound => CoreError::NotFound,
        other => CoreError::Terminal(other.to_string()),
    }
}

async fn observe_catalog(plan: SkillCatalogPlan, state: &AppState) -> Result<Value, CoreError> {
    let manager = state.skill_manager.clone();
    tokio::task::spawn_blocking(move || {
        manager
            .catalog(platform_scope(&plan))
            .map_err(|error| CoreError::Terminal(error.to_string()))
            .and_then(|catalog| {
                serde_json::to_value(catalog)
                    .map_err(|error| CoreError::Terminal(error.to_string()))
            })
    })
    .await
    .map_err(|_| CoreError::Terminal("skill catalog worker stopped unexpectedly".into()))?
}

pub(in crate::app::control) fn platform_scope(
    plan: &SkillCatalogPlan,
) -> termloop_platform::SkillCatalogScope {
    match (plan.project_directory(), plan.project_name()) {
        (Some(directory), Some(name)) => {
            termloop_platform::SkillCatalogScope::project(directory, name)
        }
        _ => termloop_platform::SkillCatalogScope::global(),
    }
}
