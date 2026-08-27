use std::sync::{Arc, Weak, atomic::Ordering};

use serde_json::{Value, json};
use termloop_contract::current as protocol;
use termloop_core::{
    CoreError, TaskSourceBoardList, TaskSourceFailure, TaskSourceRefreshOutcome,
    TaskSourceStatusList, TaskSourceView, task_source_candidate_json, task_source_view_json,
};
use termloop_platform::{SecureCredentialError, SecureCredentialKey, SecureSecret};
use tokio::sync::Mutex;

use super::super::AppState;
use super::super::invalidation::InvalidationRequest;

const JIRA_CREDENTIAL_SERVICE: &str = "dev.termloop.task-source.jira";
const TASK_SOURCE_SCHEDULER_TICK: tokio::time::Duration = tokio::time::Duration::from_secs(30);
const TASK_SOURCE_CREDENTIAL_READ_TIMEOUT: tokio::time::Duration =
    tokio::time::Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::app) enum TaskSourceCredentialPresence {
    None,
    Present,
    Invalid,
    Unavailable,
}

pub(in crate::app::control) struct CredentialEscrow {
    values: Vec<(SecureCredentialKey, SecureSecret)>,
    previous_states: Vec<(String, Option<TaskSourceCredentialPresence>)>,
}

pub(in crate::app::control) async fn lock_sources(
    state: &AppState,
    source_ids: &[String],
) -> Vec<tokio::sync::OwnedMutexGuard<()>> {
    let mut source_ids = source_ids.to_vec();
    source_ids.sort_unstable();
    source_ids.dedup();
    let mut guards = Vec::with_capacity(source_ids.len());
    for source_id in source_ids {
        guards.push(refresh_lock(state, &source_id).lock_owned().await);
    }
    guards
}

pub(in crate::app::control) async fn take_credentials(
    state: &AppState,
    source_ids: &[String],
) -> Result<CredentialEscrow, CoreError> {
    let keys = source_ids
        .iter()
        .map(|source_id| credential_key(source_id))
        .collect::<Result<Vec<_>, _>>()?;
    let store = state.secure_credentials.clone();
    let values = tokio::task::spawn_blocking(move || {
        let mut values = Vec::new();
        for key in keys {
            match store.get(&key) {
                Ok(secret) => values.push((key, secret)),
                Err(SecureCredentialError::NotFound) => {}
                Err(error) => return Err(credential_error(error)),
            }
        }
        let mut deleted = 0;
        for (key, _) in &values {
            match store.delete(key) {
                Ok(()) | Err(SecureCredentialError::NotFound) => deleted += 1,
                Err(error) => {
                    let mut rollback_error = None;
                    for (key, secret) in values.iter().take(deleted) {
                        if let Err(error) = store.set(key, secret) {
                            rollback_error.get_or_insert(error);
                        }
                    }
                    if let Some(error) = rollback_error {
                        return Err(credential_error(error));
                    }
                    return Err(credential_error(error));
                }
            }
        }
        Ok(values)
    })
    .await
    .map_err(|_| CoreError::Store("secure credential worker failed".into()))??;
    let previous_states =
        replace_credential_states(state, source_ids, TaskSourceCredentialPresence::None);
    Ok(CredentialEscrow {
        values,
        previous_states,
    })
}

pub(in crate::app::control) async fn restore_credentials(
    state: &AppState,
    escrow: CredentialEscrow,
) -> Result<(), CoreError> {
    let CredentialEscrow {
        values,
        previous_states,
    } = escrow;
    let source_ids = previous_states
        .iter()
        .map(|(source_id, _)| source_id.clone())
        .collect::<Vec<_>>();
    let store = state.secure_credentials.clone();
    let restoration = tokio::task::spawn_blocking(move || {
        let mut failure = None;
        for (key, secret) in values {
            if let Err(error) = store.set(&key, &secret) {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(credential_error(error));
        }
        Ok(())
    })
    .await
    .map_err(|_| CoreError::Store("secure credential worker failed".into()))?;
    match restoration {
        Ok(()) => restore_credential_states(state, previous_states),
        Err(error) => {
            replace_credential_states(
                state,
                &source_ids,
                TaskSourceCredentialPresence::Unavailable,
            );
            return Err(error);
        }
    }
    Ok(())
}

pub(in crate::app) async fn run_deadlines(state: AppState) {
    let mut interval = tokio::time::interval(TASK_SOURCE_SCHEDULER_TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let due = state
            .core
            .lock()
            .await
            .due_task_source_refreshes(super::super::current_epoch_ms());
        for (source_id, generation) in due {
            let state = state.clone();
            tokio::spawn(async move {
                let _ = refresh(
                    json!({"sourceId": source_id, "expectedGeneration": generation}),
                    &state,
                )
                .await;
            });
        }
    }
}

pub(super) async fn list(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceListParams>(params)
        .expect("validated Task Source list params");
    let (views, state_revision, observation_sequence) = {
        let core = state.core.lock().await;
        (
            core.task_source_views(&params.project_id)?,
            core.state_revision(),
            core.observation_sequence(),
        )
    };
    let credential_states = state
        .task_source_credential_states
        .lock()
        .ok()
        .map(|states| states.clone());
    let sources = views
        .iter()
        .map(|view| {
            let presence = credential_states
                .as_ref()
                .and_then(|states| states.get(&view.configuration.id).copied())
                .unwrap_or(TaskSourceCredentialPresence::Unavailable);
            task_source_view_json(view, credential_state_wire(presence))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "sources": sources,
        "stateRevision": state_revision,
        "observationSequence": observation_sequence,
    }))
}

pub(super) async fn board_list(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceBoardListParams>(params)
        .expect("validated Task Source board list params");
    validate_credential_parts(&params.email, &params.api_token)?;
    let observer = state.task_source_refresh_observer.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        observer.list_boards(
            &params.site_base_url,
            &params.email,
            &params.api_token,
            params.board_id.as_deref(),
        )
    })
    .await
    .unwrap_or(Err(TaskSourceFailure::ProviderUnavailable));
    Ok(board_list_result(outcome))
}

pub(super) async fn board_list_stored(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceStoredBoardListParams>(params)
        .expect("validated stored Task Source board list params");
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    {
        let core = state.core.lock().await;
        let view = core.task_source_view_by_id(&params.source_id)?;
        validate_stored_discovery_target(&view, &params.site_base_url, params.expected_generation)?;
    }
    let outcome = match read_stored_credential(state, &params.source_id).await {
        Ok(secret) => {
            let observer = state.task_source_refresh_observer.clone();
            let site_base_url = params.site_base_url;
            let board_id = params.board_id;
            tokio::task::spawn_blocking(move || match expose_credential(&secret) {
                Ok((email, token)) => {
                    observer.list_boards(&site_base_url, email, token, board_id.as_deref())
                }
                Err(reason) => Err(reason),
            })
            .await
            .unwrap_or(Err(TaskSourceFailure::ProviderUnavailable))
        }
        Err(reason) => Err(reason),
    };
    set_credential_state(
        state,
        &params.source_id,
        credential_presence_for_failure(outcome.as_ref().err().copied()),
    );
    Ok(board_list_result(outcome))
}

fn board_list_result(outcome: Result<TaskSourceBoardList, TaskSourceFailure>) -> Value {
    match outcome {
        Ok(result) => json!({
            "boards": result.boards.into_iter().map(|board| json!({
                "id": board.id,
                "name": board.name,
                "kind": board.kind,
                "locationName": board.location_name,
            })).collect::<Vec<_>>(),
            "truncated": result.truncated,
            "failureReason": null,
        }),
        Err(reason) => json!({
            "boards": [],
            "truncated": false,
            "failureReason": termloop_core::task_source_failure_wire(reason),
        }),
    }
}

pub(super) async fn status_list(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceStatusListParams>(params)
        .expect("validated Task Source status list params");
    validate_credential_parts(&params.email, &params.api_token)?;
    let observer = state.task_source_refresh_observer.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        observer.list_statuses(
            &params.site_base_url,
            &params.email,
            &params.api_token,
            &params.board_ids,
        )
    })
    .await
    .unwrap_or(Err(TaskSourceFailure::ProviderUnavailable));
    Ok(status_list_result(outcome))
}

pub(super) async fn status_list_stored(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceStoredStatusListParams>(params)
        .expect("validated stored Task Source status list params");
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    {
        let core = state.core.lock().await;
        let view = core.task_source_view_by_id(&params.source_id)?;
        validate_stored_discovery_target(&view, &params.site_base_url, params.expected_generation)?;
    }
    let outcome = match read_stored_credential(state, &params.source_id).await {
        Ok(secret) => {
            let observer = state.task_source_refresh_observer.clone();
            let site_base_url = params.site_base_url;
            let board_ids = params.board_ids;
            tokio::task::spawn_blocking(move || match expose_credential(&secret) {
                Ok((email, token)) => {
                    observer.list_statuses(&site_base_url, email, token, &board_ids)
                }
                Err(reason) => Err(reason),
            })
            .await
            .unwrap_or(Err(TaskSourceFailure::ProviderUnavailable))
        }
        Err(reason) => Err(reason),
    };
    set_credential_state(
        state,
        &params.source_id,
        credential_presence_for_failure(outcome.as_ref().err().copied()),
    );
    Ok(status_list_result(outcome))
}

fn status_list_result(outcome: Result<TaskSourceStatusList, TaskSourceFailure>) -> Value {
    match outcome {
        Ok(result) => json!({
            "statuses": result.statuses.into_iter().map(|status| json!({
                "id": status.id,
                "name": status.name,
            })).collect::<Vec<_>>(),
            "failureReason": null,
        }),
        Err(reason) => json!({
            "statuses": [],
            "failureReason": termloop_core::task_source_failure_wire(reason),
        }),
    }
}

fn validate_stored_discovery_target(
    view: &TaskSourceView,
    requested_site_base_url: &str,
    expected_generation: u64,
) -> Result<(), CoreError> {
    if view.configuration.generation != expected_generation {
        return Err(CoreError::RevisionConflict);
    }
    if view.configuration.site_base_url != requested_site_base_url {
        return Err(CoreError::InvalidParams("siteBaseUrl".into()));
    }
    Ok(())
}

pub(super) async fn create(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceCreateParams>(params)
        .expect("validated Task Source create params");
    let (mutation, view) = {
        let mut core = state.core.lock().await;
        let mutation = core.create_task_source(
            termloop_platform::generate_opaque_id(),
            &params.project_id,
            params.name,
            params.site_base_url,
            scope_kind(params.scope_kind),
            selected_boards(params.boards),
            selected_statuses(params.statuses),
            params.jql,
            import_policy(params.import_policy),
            params.auto_import_active_task_limit,
            params.refresh_interval_seconds,
            params.expected_revision,
            super::super::current_epoch_ms(),
        )?;
        let view = core.task_source_view_by_id(&mutation.source.id)?;
        (mutation, view)
    };
    set_credential_state(
        state,
        &view.configuration.id,
        TaskSourceCredentialPresence::None,
    );
    publish(state, mutation.state_revision, view.observation_sequence);
    Ok(json!({
        "source": task_source_view_json(&view, "none"),
        "stateRevision": mutation.state_revision,
    }))
}

pub(super) async fn update(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceUpdateParams>(params)
        .expect("validated Task Source update params");
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    let (mutation, view) = {
        let mut core = state.core.lock().await;
        let mutation = core.update_task_source(
            &params.source_id,
            params.name,
            params.enabled,
            params.site_base_url,
            scope_kind(params.scope_kind),
            selected_boards(params.boards),
            selected_statuses(params.statuses),
            params.jql,
            import_policy(params.import_policy),
            params.auto_import_active_task_limit,
            params.refresh_interval_seconds,
            params.expected_generation,
            params.expected_revision,
            super::super::current_epoch_ms(),
        )?;
        let view = core.task_source_view_by_id(&mutation.source.id)?;
        (mutation, view)
    };
    let credential_state = cached_credential_state(state, &view.configuration.id);
    publish(state, mutation.state_revision, view.observation_sequence);
    Ok(json!({
        "source": task_source_view_json(&view, credential_state),
        "stateRevision": mutation.state_revision,
    }))
}

pub(super) async fn credentials_set(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceCredentialsSetParams>(params)
        .expect("validated Task Source credential params");
    validate_credential_parts(&params.email, &params.api_token)?;
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    {
        let core = state.core.lock().await;
        let view = core.task_source_view_by_id(&params.source_id)?;
        if view.configuration.generation != params.expected_generation {
            return Err(CoreError::RevisionConflict);
        }
    }
    let key = credential_key(&params.source_id)?;
    let secret = credential_secret(&params.email, &params.api_token)?;
    let store = state.secure_credentials.clone();
    tokio::task::spawn_blocking(move || store.set(&key, &secret))
        .await
        .map_err(|_| CoreError::Store("secure credential worker failed".into()))?
        .map_err(credential_error)?;
    let (sequence, state_revision) = {
        let mut core = state.core.lock().await;
        let sequence =
            core.record_task_source_credentials_set(&params.source_id, params.expected_generation)?;
        (sequence, core.state_revision())
    };
    set_credential_state(
        state,
        &params.source_id,
        TaskSourceCredentialPresence::Present,
    );
    state
        .observation_sequence
        .fetch_max(sequence, Ordering::Relaxed);
    publish(state, state_revision, sequence);
    Ok(json!({"sourceId": params.source_id, "credentialState": "present"}))
}

pub(super) async fn delete(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceDeleteParams>(params)
        .expect("validated Task Source delete params");
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    {
        let core = state.core.lock().await;
        let view = core.task_source_view_by_id(&params.source_id)?;
        if view.configuration.generation != params.expected_generation
            || core.state_revision() != params.expected_revision
        {
            return Err(CoreError::RevisionConflict);
        }
    }
    let source_ids = [params.source_id.clone()];
    let escrow = take_credentials(state, &source_ids).await?;
    let deleted = match state.core.lock().await.delete_task_source(
        &params.source_id,
        params.expected_generation,
        params.expected_revision,
    ) {
        Ok(deleted) => deleted,
        Err(error) => {
            restore_credentials(state, escrow).await?;
            return Err(error);
        }
    };
    drop(escrow);
    forget_credential_state(state, &params.source_id);
    publish(state, deleted.state_revision, 0);
    Ok(json!({
        "sourceId": deleted.source_id,
        "deleted": true,
        "stateRevision": deleted.state_revision,
    }))
}

pub(super) async fn refresh(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceRefreshParams>(params)
        .expect("validated Task Source refresh params");
    let now_epoch_ms = super::super::current_epoch_ms();
    let before = {
        let core = state.core.lock().await;
        let view = core.task_source_view_by_id(&params.source_id)?;
        if view.configuration.generation != params.expected_generation {
            return Err(CoreError::RevisionConflict);
        }
        view
    };
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    let current = state
        .core
        .lock()
        .await
        .task_source_view_by_id(&params.source_id)?;
    if current.configuration.generation != params.expected_generation {
        return Err(CoreError::RevisionConflict);
    }
    if current
        .retry_after_epoch_ms
        .is_some_and(|retry_after| retry_after > now_epoch_ms)
    {
        return Ok(refresh_result(&current));
    }
    let coalesced = (before.status == termloop_core::TaskSourceRuntimeStatus::Refreshing
        && current.status != termloop_core::TaskSourceRuntimeStatus::Refreshing)
        || current.last_attempt_at_epoch_ms != before.last_attempt_at_epoch_ms
        || current.last_successful_at_epoch_ms != before.last_successful_at_epoch_ms;
    if coalesced {
        return Ok(refresh_result(&current));
    }
    let plan = state.core.lock().await.prepare_task_source_refresh(
        &params.source_id,
        params.expected_generation,
        now_epoch_ms,
    )?;
    let outcome = observe_refresh(state, &plan).await;
    let failure = match &outcome {
        TaskSourceRefreshOutcome::Success(_) => None,
        TaskSourceRefreshOutcome::Failure { reason, .. } => Some(*reason),
    };
    let applied = state.core.lock().await.apply_task_source_refresh(
        plan,
        outcome,
        super::super::current_epoch_ms(),
    )?;
    state
        .observation_sequence
        .fetch_max(applied.observation_sequence, Ordering::Relaxed);
    publish(
        state,
        state.core.lock().await.state_revision(),
        applied.observation_sequence,
    );
    let automations = if failure.is_none() {
        super::super::task_automation::auto_import_after_refresh(
            &applied.source_id,
            applied.observation_sequence,
            state,
        )
        .await?
    } else {
        Vec::new()
    };
    drop(_guard);
    super::super::task_automation::spawn(automations, state);
    Ok(json!({
        "sourceId": applied.source_id,
        "refreshed": failure.is_none(),
        "failureReason": failure.map(termloop_core::task_source_failure_wire),
        "candidateCount": applied.candidate_count,
        "truncated": applied.truncated,
        "observationSequence": applied.observation_sequence,
    }))
}

fn refresh_result(view: &TaskSourceView) -> Value {
    json!({
        "sourceId": view.configuration.id,
        "refreshed": view.failure.is_none(),
        "failureReason": view.failure.map(termloop_core::task_source_failure_wire),
        "candidateCount": view.candidate_count,
        "truncated": view.truncated,
        "observationSequence": view.observation_sequence,
    })
}

pub(super) async fn candidate_list(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceCandidateListParams>(params)
        .expect("validated Task Source candidate list params");
    let core = state.core.lock().await;
    let view = core.task_source_view_by_id(&params.source_id)?;
    let candidates = core
        .task_source_candidates(&params.source_id)?
        .iter()
        .map(task_source_candidate_json)
        .collect::<Vec<_>>();
    Ok(json!({
        "sourceId": params.source_id,
        "candidates": candidates,
        "lastSuccessfulAtEpochMs": view.last_successful_at_epoch_ms,
        "stateRevision": core.state_revision(),
        "observationSequence": view.observation_sequence,
    }))
}

pub(super) async fn candidate_import(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::TaskSourceCandidateImportParams>(params)
        .expect("validated Task Source candidate import params");
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    let (imported, changed) = {
        let mut core = state.core.lock().await;
        let before_revision = core.state_revision();
        let imported = core.import_task_source_candidate(
            &params.source_id,
            &params.external_id,
            params.expected_generation,
            params.expected_observation_sequence,
            params.expected_revision,
            termloop_platform::generate_uuid_v4(),
            super::super::current_epoch_ms(),
        )?;
        let changed = imported.state_revision != before_revision;
        (imported, changed)
    };
    publish_import(
        state,
        imported.state_revision,
        params.expected_observation_sequence,
    );
    let automation = if changed {
        Some(
            super::super::task_automation::action_for_task(
                &imported.task,
                super::super::task_automation::TaskAutomationSelection {
                    worktree_intent: params.worktree_intent,
                    worktree_prefix: params.worktree_prefix,
                    agent_id: params.agent_id,
                    model: params.model,
                    permission: params.permission,
                    reasoning: params.reasoning,
                    kickoff_message: params.kickoff_message,
                },
                state,
            )
            .await?,
        )
    } else {
        None
    };
    drop(_guard);
    if let Some(automation) = automation {
        super::super::task_automation::spawn(vec![automation], state);
    }
    Ok(json!({"task": imported.task, "stateRevision": imported.state_revision}))
}

pub(super) async fn candidate_ignore(
    params: Value,
    state: &AppState,
    ignored: bool,
) -> Result<Value, CoreError> {
    let params = candidate_params(params);
    let lock = refresh_lock(state, &params.source_id);
    let _guard = lock.lock().await;
    let (candidate, source_generation, state_revision) =
        state.core.lock().await.ignore_task_source_candidate(
            &params.source_id,
            &params.external_id,
            params.expected_generation,
            params.expected_observation_sequence,
            params.expected_revision,
            ignored,
            super::super::current_epoch_ms(),
        )?;
    publish(state, state_revision, candidate.observation_sequence);
    Ok(json!({
        "candidate": task_source_candidate_json(&candidate),
        "sourceGeneration": source_generation,
        "stateRevision": state_revision,
    }))
}

fn candidate_params(params: Value) -> protocol::TaskSourceCandidateMutationParams {
    serde_json::from_value(params).expect("validated Task Source candidate mutation params")
}

async fn observe_refresh(
    state: &AppState,
    plan: &termloop_core::TaskSourceRefreshPlan,
) -> TaskSourceRefreshOutcome {
    let secret = match read_stored_credential(state, &plan.source_id).await {
        Ok(secret) => secret,
        Err(reason) => {
            return TaskSourceRefreshOutcome::Failure {
                reason,
                retry_after_seconds: None,
            };
        }
    };
    let plan = plan.clone();
    let source_id = plan.source_id.clone();
    let observer = state.task_source_refresh_observer.clone();
    let outcome = match tokio::task::spawn_blocking(move || match expose_credential(&secret) {
        Ok((email, token)) => observer.observe(&plan, email, token),
        Err(reason) => TaskSourceRefreshOutcome::Failure {
            reason,
            retry_after_seconds: None,
        },
    })
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => TaskSourceRefreshOutcome::Failure {
            reason: TaskSourceFailure::ProviderUnavailable,
            retry_after_seconds: None,
        },
    };
    let failure = match &outcome {
        TaskSourceRefreshOutcome::Failure { reason, .. } => Some(*reason),
        TaskSourceRefreshOutcome::Success(_) => None,
    };
    set_credential_state(state, &source_id, credential_presence_for_failure(failure));
    outcome
}

async fn read_stored_credential(
    state: &AppState,
    source_id: &str,
) -> Result<SecureSecret, TaskSourceFailure> {
    let key = credential_key(source_id).map_err(|_| TaskSourceFailure::CredentialsUnavailable)?;
    let store = state.secure_credentials.clone();
    match tokio::time::timeout(
        TASK_SOURCE_CREDENTIAL_READ_TIMEOUT,
        tokio::task::spawn_blocking(move || store.get(&key)),
    )
    .await
    {
        Ok(Ok(Ok(secret))) => Ok(secret),
        Ok(Ok(Err(SecureCredentialError::NotFound))) => {
            set_credential_state(state, source_id, TaskSourceCredentialPresence::None);
            Err(TaskSourceFailure::CredentialsMissing)
        }
        Ok(Ok(Err(SecureCredentialError::Unavailable))) | Ok(Err(_)) | Err(_) => {
            set_credential_state(state, source_id, TaskSourceCredentialPresence::Unavailable);
            Err(TaskSourceFailure::CredentialsUnavailable)
        }
    }
}

fn expose_credential(secret: &SecureSecret) -> Result<(&str, &str), TaskSourceFailure> {
    let separator = secret
        .expose()
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(TaskSourceFailure::CredentialsUnavailable)?;
    let email = std::str::from_utf8(&secret.expose()[..separator])
        .map_err(|_| TaskSourceFailure::CredentialsUnavailable)?;
    let token = std::str::from_utf8(&secret.expose()[separator + 1..])
        .map_err(|_| TaskSourceFailure::CredentialsUnavailable)?;
    Ok((email, token))
}

fn credential_presence_for_failure(
    failure: Option<TaskSourceFailure>,
) -> TaskSourceCredentialPresence {
    match failure {
        Some(TaskSourceFailure::CredentialsInvalid) => TaskSourceCredentialPresence::Invalid,
        Some(TaskSourceFailure::CredentialsMissing) => TaskSourceCredentialPresence::None,
        Some(TaskSourceFailure::CredentialsUnavailable) => {
            TaskSourceCredentialPresence::Unavailable
        }
        _ => TaskSourceCredentialPresence::Present,
    }
}

fn validate_credential_parts(email: &str, token: &str) -> Result<(), CoreError> {
    let valid_email = email.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty()
            && !domain.is_empty()
            && !domain.contains('@')
            && email.len() <= 254
            && !email
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
    });
    if !valid_email
        || token.is_empty()
        || token.len() > 1_024
        || token
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(CoreError::InvalidParams("credentials".into()));
    }
    Ok(())
}

fn credential_secret(email: &str, token: &str) -> Result<SecureSecret, CoreError> {
    let mut bytes = Vec::with_capacity(email.len() + token.len() + 1);
    bytes.extend_from_slice(email.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(token.as_bytes());
    SecureSecret::new(bytes).ok_or_else(|| CoreError::InvalidParams("credentials".into()))
}

fn credential_key(source_id: &str) -> Result<SecureCredentialKey, CoreError> {
    SecureCredentialKey::new(JIRA_CREDENTIAL_SERVICE, source_id)
        .ok_or_else(|| CoreError::InvalidParams("sourceId".into()))
}

fn credential_state_wire(presence: TaskSourceCredentialPresence) -> &'static str {
    match presence {
        TaskSourceCredentialPresence::None => "none",
        TaskSourceCredentialPresence::Present => "present",
        TaskSourceCredentialPresence::Invalid => "invalid",
        TaskSourceCredentialPresence::Unavailable => "unavailable",
    }
}

fn cached_credential_state(state: &AppState, source_id: &str) -> &'static str {
    state
        .task_source_credential_states
        .lock()
        .ok()
        .and_then(|states| states.get(source_id).copied())
        .map(credential_state_wire)
        .unwrap_or("unavailable")
}

fn set_credential_state(state: &AppState, source_id: &str, presence: TaskSourceCredentialPresence) {
    if let Ok(mut states) = state.task_source_credential_states.lock() {
        states.insert(source_id.to_owned(), presence);
    }
}

fn replace_credential_states(
    state: &AppState,
    source_ids: &[String],
    replacement: TaskSourceCredentialPresence,
) -> Vec<(String, Option<TaskSourceCredentialPresence>)> {
    let Ok(mut states) = state.task_source_credential_states.lock() else {
        return source_ids
            .iter()
            .cloned()
            .map(|source_id| (source_id, None))
            .collect();
    };
    source_ids
        .iter()
        .map(|source_id| {
            let previous = states.insert(source_id.clone(), replacement);
            (source_id.clone(), previous)
        })
        .collect()
}

fn restore_credential_states(
    state: &AppState,
    previous_states: Vec<(String, Option<TaskSourceCredentialPresence>)>,
) {
    let Ok(mut states) = state.task_source_credential_states.lock() else {
        return;
    };
    for (source_id, previous) in previous_states {
        if let Some(previous) = previous {
            states.insert(source_id, previous);
        } else {
            states.remove(&source_id);
        }
    }
}

pub(in crate::app::control) fn forget_credential_state(state: &AppState, source_id: &str) {
    if let Ok(mut states) = state.task_source_credential_states.lock() {
        states.remove(source_id);
    }
}

fn credential_error(error: SecureCredentialError) -> CoreError {
    CoreError::Store(error.to_string())
}

fn scope_kind(value: protocol::TaskSourceScopeKind) -> &'static str {
    match value {
        protocol::TaskSourceScopeKind::All => "all",
        protocol::TaskSourceScopeKind::AssignedToMe => "assignedToMe",
        protocol::TaskSourceScopeKind::Jql => "jql",
    }
}

fn import_policy(value: protocol::TaskSourceImportPolicy) -> &'static str {
    match value {
        protocol::TaskSourceImportPolicy::Review => "review",
        protocol::TaskSourceImportPolicy::AutoAdd => "autoAdd",
    }
}

fn selected_boards(
    boards: Vec<protocol::TaskSourceBoardSelectionDto>,
) -> Vec<termloop_core::TaskSourceBoardSelection> {
    boards
        .into_iter()
        .map(|board| termloop_core::TaskSourceBoardSelection {
            id: board.id,
            name: board.name,
        })
        .collect()
}

fn selected_statuses(
    statuses: Vec<protocol::TaskSourceStatusDto>,
) -> Vec<termloop_core::TaskSourceStatusSelection> {
    statuses
        .into_iter()
        .map(|status| termloop_core::TaskSourceStatusSelection {
            id: status.id,
            name: status.name,
        })
        .collect()
}

fn refresh_lock(state: &AppState, source_id: &str) -> Arc<Mutex<()>> {
    let mut locks = state
        .task_source_refresh_locks
        .lock()
        .expect("Task Source refresh lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(source_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(source_id.to_owned(), Arc::downgrade(&lock));
    lock
}

fn publish(state: &AppState, state_revision: u64, observation_sequence: u64) {
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![protocol::ProjectionTopic::TaskSource],
        state_revision,
        observation_sequence,
    });
}

fn publish_import(state: &AppState, state_revision: u64, observation_sequence: u64) {
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            protocol::ProjectionTopic::TaskSource,
            protocol::ProjectionTopic::Task,
        ],
        state_revision,
        observation_sequence,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_projection_exposes_only_cached_state() {
        assert_eq!(
            credential_state_wire(TaskSourceCredentialPresence::None),
            "none"
        );
        assert_eq!(
            credential_state_wire(TaskSourceCredentialPresence::Present),
            "present"
        );
        assert_eq!(
            credential_state_wire(TaskSourceCredentialPresence::Invalid),
            "invalid"
        );
        assert_eq!(
            credential_state_wire(TaskSourceCredentialPresence::Unavailable),
            "unavailable"
        );
    }

    #[test]
    fn credential_validation_rejects_empty_or_control_bearing_values() {
        assert!(validate_credential_parts("ada@example.com", "token").is_ok());
        assert!(validate_credential_parts("invalid", "token").is_err());
        assert!(validate_credential_parts("ada@example.com", "").is_err());
        assert!(validate_credential_parts("ada@example.com", "line\nbreak").is_err());
    }
}
