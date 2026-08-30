use serde_json::{Value, json};
use termloop_domain::{TaskSourceImportPolicy, TaskSourceScope};

use super::{TaskSourceCandidateView, TaskSourceFailure, TaskSourceRuntimeStatus, TaskSourceView};

pub fn task_source_view_json(view: &TaskSourceView, credential_state: &str) -> Value {
    let (scope_kind, jql, legacy_board) = match &view.configuration.scope {
        TaskSourceScope::All => ("all", None, None),
        TaskSourceScope::AssignedToMe => ("assignedToMe", None, None),
        TaskSourceScope::Board {
            board_id,
            board_name,
        } => ("all", None, Some((board_id.as_str(), board_name.as_str()))),
        TaskSourceScope::Jql { jql } => ("jql", Some(jql.as_str()), None),
    };
    let mut boards = view
        .configuration
        .boards
        .iter()
        .map(|board| json!({ "id": board.id, "name": board.name }))
        .collect::<Vec<_>>();
    if let Some((id, name)) = legacy_board {
        boards.push(json!({ "id": id, "name": name }));
    }
    json!({
        "id": view.configuration.id,
        "projectId": view.configuration.project_id,
        "provider": "jira",
        "name": view.configuration.name,
        "enabled": view.configuration.enabled,
        "generation": view.configuration.generation,
        "siteBaseUrl": view.configuration.site_base_url,
        "scopeKind": scope_kind,
        "boards": boards,
        "statuses": view.configuration.statuses.iter().map(|status| json!({
            "id": status.id,
            "name": status.name,
        })).collect::<Vec<_>>(),
        "jql": jql,
        "importPolicy": match view.configuration.import_policy {
            TaskSourceImportPolicy::Review => "review",
            TaskSourceImportPolicy::AutoAdd => "autoAdd",
        },
        "autoImportActiveTaskLimit": view.configuration.auto_import_active_task_limit,
        "refreshIntervalSeconds": view.configuration.refresh_interval_seconds,
        "credentialState": credential_state,
        "runtimeState": match view.status {
            TaskSourceRuntimeStatus::Idle => "idle",
            TaskSourceRuntimeStatus::Refreshing => "refreshing",
            TaskSourceRuntimeStatus::Attention => "attention",
            TaskSourceRuntimeStatus::Disabled => "disabled",
        },
        "failureReason": view.failure.map(task_source_failure_wire),
        "lastAttemptAtEpochMs": view.last_attempt_at_epoch_ms,
        "lastSuccessfulAtEpochMs": view.last_successful_at_epoch_ms,
        "retryAfterEpochMs": view.retry_after_epoch_ms,
        "candidateCount": view.candidate_count,
        "truncated": view.truncated,
        "createdAtEpochMs": view.configuration.created_at_epoch_ms,
        "updatedAtEpochMs": view.configuration.updated_at_epoch_ms,
    })
}

pub fn task_source_candidate_json(candidate: &TaskSourceCandidateView) -> Value {
    json!({
        "sourceId": candidate.source_id,
        "externalId": candidate.candidate.external_id,
        "key": candidate.candidate.external_ref,
        "url": candidate.candidate.url,
        "summary": candidate.candidate.title,
        "description": candidate.candidate.description,
        "statusName": candidate.candidate.status_name,
        "assigneeDisplay": candidate.candidate.assignee_display,
        "updatedAt": candidate.candidate.updated_at,
        "state": candidate.state,
        "taskId": candidate.task_id,
        "observedGeneration": candidate.observed_generation,
        "observationSequence": candidate.observation_sequence,
    })
}

pub fn task_source_failure_wire(reason: TaskSourceFailure) -> &'static str {
    match reason {
        TaskSourceFailure::CredentialsMissing => "credentialsMissing",
        TaskSourceFailure::CredentialsInvalid => "credentialsInvalid",
        TaskSourceFailure::CredentialsUnavailable => "credentialsUnavailable",
        TaskSourceFailure::ScopeInvalid => "scopeInvalid",
        TaskSourceFailure::RateLimited => "rateLimited",
        TaskSourceFailure::ProviderUnavailable => "providerUnavailable",
        TaskSourceFailure::ResponseTooLarge => "responseTooLarge",
        TaskSourceFailure::MalformedResponse => "malformedResponse",
    }
}
