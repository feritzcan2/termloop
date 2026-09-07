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
    let owner = owner.to_owned();
    let method = method.to_owned();
    let refresh = method == "agent.authStatusList";
    let result = tokio::task::spawn_blocking(move || {
        if method == "agent.authStatusList" {
            serde_json::to_value(connections.status_list(&owner))
                .map_err(|_| "Could not read account status.")
        } else {
            let provider = Provider::parse(params["agentId"].as_str().unwrap_or_default())?;
            let id = params["operationId"].as_str().unwrap_or_default();
            let result = match method.as_str() {
                "agent.install" => connections.start(provider, Action::Install, &owner),
                "agent.authStart" => connections.start(provider, Action::SignIn, &owner),
                "agent.authLogout" => connections.start(provider, Action::SignOut, &owner),
                "agent.authGet" => connections.operation(provider, id, &owner),
                "agent.authCancel" => connections.cancel(provider, id, &owner),
                "agent.authSubmitCode" => connections.submit_code(
                    provider,
                    id,
                    &owner,
                    params["code"].as_str().unwrap_or_default(),
                ),
                _ => Err("Unsupported account operation."),
            }?;
            serde_json::to_value(result).map_err(|_| "Could not read setup progress.")
        }
    })
    .await
    .map_err(|_| CoreError::Terminal("Account setup worker unavailable.".into()))?
    .map_err(|error| CoreError::Terminal(error.into()))?;
    if refresh {
        refresh_capabilities(state).await?;
    }
    Ok(result)
}

async fn refresh_capabilities(state: &AppState) -> Result<(), CoreError> {
    // One discovery at a time. No serialized core lock is held over CLI work.
    let _refresh = state.agent_capability_refresh.lock().await;
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
