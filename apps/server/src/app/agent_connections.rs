use super::AppState;
use serde_json::Value;
use termloop_core::{
    CoreError,
    agent_connections::{Action, Provider},
};

pub(super) async fn handle(
    method: &str,
    params: Value,
    owner: &str,
    state: &AppState,
) -> Result<Value, CoreError> {
    let connections = state.agent_connections.clone();
    let accounts = {
        let core = state.core.lock().await;
        if method == "agent.authStatusList"
            && params.get("agentId").is_none()
            && params.get("accountId").is_none()
        {
            ["codex", "claude"]
                .into_iter()
                .map(|provider| {
                    core.resolve_agent_account(provider, None)
                        .and_then(|account| account.ok_or(CoreError::NotFound))
                })
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let provider = params["agentId"]
                .as_str()
                .ok_or_else(|| CoreError::InvalidParams("agentId".into()))?;
            let account_id = params["accountId"]
                .as_str()
                .ok_or_else(|| CoreError::InvalidParams("accountId".into()))?;
            vec![
                core.resolve_agent_account(provider, Some(account_id))?
                    .ok_or(CoreError::NotFound)?,
            ]
        }
    };
    let owner = owner.to_owned();
    let method = method.to_owned();
    let capabilities = state.agent_capabilities.lock().unwrap().clone();
    let (result, refresh) = tokio::task::spawn_blocking(move || {
        if method == "agent.authStatusList" {
            let statuses = connections.status_list(&accounts, &owner);
            let changed = statuses
                .iter()
                .any(|status| status.installation_changed(&capabilities));
            serde_json::to_value(statuses)
                .map(|result| (result, changed))
                .map_err(|_| "Could not read account status.")
        } else {
            let provider = Provider::parse(params["agentId"].as_str().unwrap_or_default())?;
            let account = accounts.into_iter().next().ok_or("Account unavailable")?;
            let account_id = account.account_id.clone();
            let id = params["operationId"].as_str().unwrap_or_default();
            let result = match method.as_str() {
                "agent.install" => connections.start(account, Action::Install, &owner),
                "agent.authStart" => connections.start(account, Action::SignIn, &owner),
                "agent.authLogout" => connections.start(account, Action::SignOut, &owner),
                "agent.authGet" => connections.operation(provider, &account_id, id, &owner),
                "agent.authCancel" => connections.cancel(provider, &account_id, id, &owner),
                "agent.authSubmitCode" => connections.submit_code(
                    provider,
                    &account_id,
                    id,
                    &owner,
                    params["code"].as_str().unwrap_or_default(),
                ),
                _ => Err("Unsupported account operation."),
            }?;
            serde_json::to_value(result)
                .map(|result| (result, false))
                .map_err(|_| "Could not read setup progress.")
        }
    })
    .await
    .map_err(|_| CoreError::Terminal("Account setup worker unavailable.".into()))?
    .map_err(|error| CoreError::Terminal(error.into()))?;
    if refresh && let Ok(guard) = state.agent_capability_refresh.clone().try_lock_owned() {
        // Discovery probes several CLI commands. Account reads must not wait for
        // it, and concurrent account reads must not queue duplicate discoveries.
        let state = state.clone();
        tokio::spawn(async move {
            let _guard = guard;
            if let Err(error) = refresh_capabilities(&state).await {
                tracing::warn!(%error, "Could not refresh installed agent capabilities");
            }
        });
    }
    Ok(result)
}

async fn refresh_capabilities(state: &AppState) -> Result<(), CoreError> {
    let (capabilities, updates) = tokio::task::spawn_blocking(|| {
        let capabilities =
            termloop_core::agent_connections::discover_agent_connection_capabilities();
        let updates =
            termloop_core::agent_connections::prepare_agent_connection_capabilities(&capabilities)?;
        Ok::<_, CoreError>((capabilities, updates))
    })
    .await
    .map_err(|_| CoreError::Terminal("Agent discovery unavailable.".into()))??;
    state.core.lock().await.refresh_agent_connections(updates);
    let mut current = state.agent_capabilities.lock().unwrap();
    for capability in capabilities {
        if let Some(existing) = current
            .iter_mut()
            .find(|existing| existing.agent_id == capability.agent_id)
        {
            *existing = capability;
        }
    }
    Ok(())
}
