//! Method handlers that reach past the store: project folders, credentials,
//! Jira, agents, delivery checks, and settings.

use std::path::Path;

use serde_json::{Value, json};
use termloop_pm::agent::AssistantTask;
use termloop_pm::{PM_AGENT_PROVIDERS, PmError, PmSettings, SettingsEdit, valid_setting_value};
use termloop_pm_contract::pm::{
    PmAgentCatalog, PmAgentCatalogPermissions, PmAgentCatalogProvider, PmAgentLaunchParams,
    PmAgentStopParams, PmAssistantTask, PmCheckStartParams, PmChecksReadParams,
    PmCredentialClearParams, PmCredentialStoreParams, PmJiraApplyParams, PmJiraSprintImportParams,
    PmProjectCreateParams, PmProjectRef, PmProjectUpdateParams, PmSettingsUpdateParams,
    PmTicketRef,
};

use super::dispatch::{check_value, convert, nullable_string, parse, require_project, to_value};
use super::errors::{ControlError, invalid_parameter};
use crate::app::{AppState, agents, code_host, credentials, jira, scheduler};

/// The one permission under which a delivery check runs unattended.
const NON_INTERACTIVE_PERMISSION: &str = "bypassPermissions";

pub(super) async fn project_create(
    state: &AppState,
    params: &Value,
) -> Result<Value, ControlError> {
    let params: PmProjectCreateParams = parse(params)?;
    let detected = code_host::detect_in(params.folder.as_deref()).await;
    let mut store = state.store.lock();
    let project = store.create_project(&params.name, params.folder.as_deref())?;
    code_host::store(&mut store, &project.id, detected)?;
    to_value(&project)
}

/// Sets the folder agents start in, and the code host its remote names.
pub(super) async fn project_update(
    state: &AppState,
    params: &Value,
) -> Result<Value, ControlError> {
    let params: PmProjectUpdateParams = parse(params)?;
    // Agents start in this folder, so it must be a directory now.
    if params
        .folder
        .as_deref()
        .is_some_and(|folder| !Path::new(folder).is_dir())
    {
        return Err(invalid_parameter("folder"));
    }
    let detected = code_host::detect_in(params.folder.as_deref()).await;
    let (project, changed) = {
        let mut store = state.store.lock();
        let project = store.set_project_folder(&params.project_id, params.folder.as_deref())?;
        let changed = code_host::store(&mut store, &project.id, detected)?;
        (project, changed)
    };
    if changed {
        state.board_changed(&project.id);
        // Only this project's pull requests are read again, not every source.
        let (state, project_id) = (state.clone(), project.id.clone());
        tokio::spawn(
            async move { scheduler::refresh_pull_request_facts(&state, &project_id).await },
        );
    }
    to_value(&project)
}

/// Deletes a project and everything stored for it. Its running agents are
/// stopped first; its Jira token is dropped unless another project still
/// names it.
pub(super) fn project_delete(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmProjectRef = parse(params)?;
    require_project(&state.store.lock(), &params.project_id)?;
    for session_id in state.agents.running_project_sessions(&params.project_id) {
        agents::stop(state, &session_id)?;
    }
    let (sources, handle_shared) = {
        let mut store = state.store.lock();
        let (_, sources) = store.delete_project(&params.project_id)?;
        let mut handle_shared = false;
        if let Some(jira) = &sources.jira {
            for other in store.projects()? {
                let other = store.project_sources(&other.id)?.jira;
                handle_shared |=
                    other.is_some_and(|other| other.credential_handle == jira.credential_handle);
            }
        }
        (sources, handle_shared)
    };
    if let Some(jira) = sources.jira.filter(|_| !handle_shared) {
        // The project is gone either way; a token left behind is only logged.
        if let Err(error) = credentials::clear(&*state.credentials, &jira.credential_handle) {
            tracing::warn!(?error, "failed to drop a deleted project's Jira token");
        }
    }
    // No board event: a client reading the deleted board would only fail.
    Ok(json!({ "deleted": true }))
}

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

pub(super) async fn jira_sprint_import(
    state: &AppState,
    params: &Value,
) -> Result<Value, ControlError> {
    let params: PmJiraSprintImportParams = parse(params)?;
    require_project(&state.store.lock(), &params.project_id)?;
    jira::import_sprint(state, &params.project_id, params.jira_sprint_id).await
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
    let task = match params.task {
        None | Some(PmAssistantTask::Brief) => AssistantTask::Brief,
        Some(PmAssistantTask::UpdateDescription) => AssistantTask::UpdateDescription,
    };
    let record = agents::launch_assistant(
        state,
        &params.project_id,
        params.focus_ticket_id.as_deref(),
        task,
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

/// Starts a requested check of each ticket's next Playbook step, each with
/// its own agent. A ticket that cannot be checked now is refused with the
/// reason.
pub(super) async fn check_start(state: &AppState, params: &Value) -> Result<Value, ControlError> {
    let params: PmCheckStartParams = parse(params)?;
    require_project(&state.store.lock(), &params.project_id)?;
    let mut checks = Vec::new();
    let mut refused = Vec::new();
    for ticket_id in &params.ticket_ids {
        let requested = state.store.lock().requested_check(ticket_id);
        let started = match requested {
            Ok(Some(due)) => {
                scheduler::start_check(state, &params.project_id, due, agents::launch_check)
            }
            Ok(None) => Err(scheduler::Refusal::NoAgentStep),
            Err(PmError::NotFound | PmError::Invalid(_)) => Err(scheduler::Refusal::NotFound),
            Err(error) => return Err(error.into()),
        };
        match started {
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

/// The providers, models, and permission modes `pm_settings_update` accepts,
/// read from the agent catalog: exactly the values `validate_settings` allows.
pub(super) fn agent_catalog_read() -> Result<Value, ControlError> {
    let providers = PM_AGENT_PROVIDERS
        .iter()
        .filter_map(|id| termloop_agents::agent_descriptor(id))
        .map(|descriptor| {
            let owned = |values: &[&str], keep: fn(&str) -> bool| {
                values
                    .iter()
                    .filter(|value| keep(value))
                    .map(|value| (*value).to_owned())
                    .collect()
            };
            Ok(PmAgentCatalogProvider {
                id: convert(&descriptor.id)?,
                label: descriptor.label.to_owned(),
                models: owned(descriptor.models, valid_setting_value),
                permissions: PmAgentCatalogPermissions {
                    assistant: owned(descriptor.permissions, |_| true),
                    check: owned(descriptor.permissions, |permission| {
                        permission == NON_INTERACTIVE_PERMISSION
                    }),
                },
            })
        })
        .collect::<Result<Vec<_>, ControlError>>()?;
    to_value(&PmAgentCatalog { providers })
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
        check_model: parsed.check_model,
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
    if !descriptor.models.contains(&settings.check_model.as_str()) {
        return Err(invalid_parameter("checkModel"));
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
