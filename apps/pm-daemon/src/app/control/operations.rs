//! Method handlers that reach past the store: credentials, Jira, agents,
//! delivery checks, and settings.

use serde_json::{Value, json};
use termloop_pm::agent::PmAgentMode;
use termloop_pm::{
    CHECK_ENVIRONMENTS_MAX, DeliveryCheckReason, NewCheck, PM_AGENT_PROVIDERS, PmSettings,
    SettingsEdit,
};
use termloop_pm_contract::pm::{
    PmAgentLaunchParams, PmAgentStopParams, PmCheckStartParams, PmChecksReadParams,
    PmCredentialClearParams, PmCredentialStoreParams, PmJiraApplyParams, PmProjectRef,
    PmSettingsUpdateParams, PmTicketRef,
};

use super::dispatch::{check_value, convert, nullable_string, parse, require_project, to_value};
use super::errors::{ControlError, invalid_parameter};
use crate::app::{AppState, agents, credentials, jira, scheduler};

/// The one permission under which a delivery check runs unattended.
const NON_INTERACTIVE_PERMISSION: &str = "bypassPermissions";

pub(super) fn credential_store(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmCredentialStoreParams = parse(params)?;
    let handle = credentials::store_jira_token(&*state.credentials, &params.secret)?;
    Ok(json!({ "credentialHandle": handle }))
}

pub(super) fn credential_clear(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmCredentialClearParams = parse(params)?;
    let cleared = credentials::clear(&*state.credentials, &params.credential_handle)?;
    Ok(json!({ "cleared": cleared }))
}

pub(super) async fn jira_pull(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProjectRef = parse(params)?;
    require_project(&state.store.lock(), &params.project_id)?;
    jira::pull(state, &params.project_id).await
}

pub(super) async fn jira_diff_read(
    state: &AppState,
    params: &Value,
) -> Result<Value, ControlError> {
    let params: PmTicketRef = parse(params)?;
    jira::diff(state, &params.ticket_id).await
}

pub(super) async fn jira_apply(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmJiraApplyParams = parse(params)?;
    jira::apply(state, &params.ticket_id, &params.token).await
}

pub(super) fn agent_launch(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmAgentLaunchParams = parse(params)?;
    let record = agents::launch(
        state,
        &params.project_id,
        PmAgentMode::Assistant,
        params.focus_ticket_id.as_deref(),
        None,
    )?;
    Ok(record.value())
}

pub(super) fn agent_list(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProjectRef = parse(params)?;
    require_project(&state.store.lock(), &params.project_id)?;
    Ok(json!({ "sessions": state.agents.project_sessions(&params.project_id) }))
}

pub(super) fn agent_stop(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmAgentStopParams = parse(params)?;
    Ok(json!({ "stopped": agents::stop(state, &params.session_id)? }))
}

/// Starts a requested check for each ticket, each with its own agent. A
/// ticket that cannot be checked now is refused with the reason.
pub(super) async fn check_start(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmCheckStartParams = parse(params)?;
    let environments: Vec<String> = {
        let store = state.store.lock();
        require_project(&store, &params.project_id)?;
        store
            .project_environments(&params.project_id)?
            .into_iter()
            .map(|environment| environment.name)
            .take(CHECK_ENVIRONMENTS_MAX)
            .collect()
    };
    let mut checks = Vec::new();
    let mut refused = Vec::new();
    for ticket_id in &params.ticket_ids {
        let new = NewCheck {
            ticket_id: ticket_id.clone(),
            reason: DeliveryCheckReason::Requested,
            environments: environments.clone(),
            probe_id: None,
        };
        match scheduler::start_check(state, &params.project_id, new, agents::launch_check) {
            Ok(check) => checks.push(check_value(state, &check)?),
            Err(reason) => {
                refused.push(json!({ "ticketId": ticket_id, "reason": reason.as_str() }))
            }
        }
    }
    Ok(json!({ "checks": checks, "refused": refused }))
}

pub(super) fn checks_read(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmChecksReadParams = parse(params)?;
    let store = state.store.lock();
    require_project(&store, &params.project_id)?;
    let checks = store
        .delivery_checks(&params.project_id)?
        .iter()
        .filter(|check| {
            params
                .ticket_id
                .as_deref()
                .is_none_or(|ticket| check.ticket_id == ticket)
        })
        .map(|check| check_value(state, check))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "checks": checks }))
}

pub(super) fn settings_read(state: &AppState) -> Result<Value, ControlError> {
    to_value(&state.store.lock().settings()?)
}

/// Applies the present fields; `agentAccountId: null` clears the account.
/// The result must name a catalog provider, model, and permissions, and
/// delivery checks must run non-interactively.
pub(super) fn settings_update(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let parsed: PmSettingsUpdateParams = parse(params)?;
    let edit = SettingsEdit {
        agent_provider: parsed.agent_provider.as_ref().map(convert).transpose()?,
        agent_account_id: nullable_string(params, "agentAccountId"),
        agent_model: parsed.agent_model,
        assistant_permission: parsed.assistant_permission,
        check_permission: parsed.check_permission,
    };
    let mut store = state.store.lock();
    validate_settings(&store.settings()?.edited(edit.clone()))?;
    to_value(&store.update_settings(edit)?)
}

pub(crate) fn validate_settings(settings: &PmSettings) -> Result<(), ControlError> {
    let descriptor = PM_AGENT_PROVIDERS
        .contains(&settings.agent_provider.as_str())
        .then(|| termloop_agents::agent_descriptor(&settings.agent_provider))
        .flatten()
        .ok_or_else(|| invalid_parameter("agentProvider"))?;
    if !descriptor.models.contains(&settings.agent_model.as_str()) {
        return Err(invalid_parameter("agentModel"));
    }
    if !descriptor
        .permissions
        .contains(&settings.assistant_permission.as_str())
    {
        return Err(invalid_parameter("assistantPermission"));
    }
    if settings.check_permission != NON_INTERACTIVE_PERMISSION
        || !descriptor
            .permissions
            .contains(&settings.check_permission.as_str())
    {
        return Err(invalid_parameter("checkPermission"));
    }
    Ok(())
}
