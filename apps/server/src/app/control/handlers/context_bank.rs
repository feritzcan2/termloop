use serde_json::Value;
use termloop_contract::current as protocol;
use termloop_core::{ContextBankCatalogPlan, CoreError};

use super::super::super::AppState;

pub(in crate::app) async fn get_context_bank_catalog(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::ContextBankCatalogGetParams>(params)
        .expect("validated Context Bank catalog params");
    let plan = {
        let core = state.core.lock().await;
        core.plan_context_bank_catalog(&params.project_id)?
    };
    observe_catalog(plan).await
}

pub(in crate::app) async fn get_context_bank_file(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::ContextBankFileGetParams>(params)
        .expect("validated Context Bank file params");
    let plan = {
        let core = state.core.lock().await;
        core.plan_context_bank_file(&params.project_id, &params.file_id)?
    };
    tokio::task::spawn_blocking(move || {
        termloop_platform::read_context_bank_file(
            plan.catalog().project_directory(),
            plan.file_id(),
        )
        .map_err(context_bank_error)
        .and_then(serialize)
    })
    .await
    .map_err(|_| CoreError::Terminal("Context Bank file worker stopped unexpectedly".into()))?
}

pub(in crate::app) async fn save_context_bank_file(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::ContextBankFileSaveParams>(params)
        .expect("validated Context Bank file save params");
    let plan = {
        let core = state.core.lock().await;
        core.plan_context_bank_file(&params.project_id, &params.file_id)?
    };
    tokio::task::spawn_blocking(move || {
        termloop_platform::write_context_bank_file(
            plan.catalog().project_directory(),
            plan.file_id(),
            &params.expected_content_sha256,
            &params.content,
        )
        .map_err(context_bank_error)
        .and_then(serialize)
    })
    .await
    .map_err(|_| CoreError::Terminal("Context Bank file worker stopped unexpectedly".into()))?
}

async fn observe_catalog(plan: ContextBankCatalogPlan) -> Result<Value, CoreError> {
    tokio::task::spawn_blocking(move || {
        termloop_platform::context_bank_catalog(plan.project_directory(), plan.project_name())
            .map_err(context_bank_error)
            .and_then(serialize)
    })
    .await
    .map_err(|_| CoreError::Terminal("Context Bank catalog worker stopped unexpectedly".into()))?
}

fn context_bank_error(error: termloop_platform::ContextBankError) -> CoreError {
    match error {
        termloop_platform::ContextBankError::FileNotFound => CoreError::NotFound,
        other => CoreError::Terminal(other.to_string()),
    }
}

fn serialize(value: impl serde::Serialize) -> Result<Value, CoreError> {
    serde_json::to_value(value).map_err(|error| CoreError::Terminal(error.to_string()))
}
