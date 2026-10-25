//! Runs a Project Manager's confirmed Jira change, or the read before it,
//! with the Task Source's stored credential outside the core lock.

use serde_json::Value;
use termloop_core::project::JiraIssueWritePlan;
use termloop_core::{CoreError, JiraIssueWriteOutcome, JiraWriteFailure, TaskSourceFailure};

use super::super::AppState;
use super::task_source::{
    credential_presence_for_failure, expose_credential, read_stored_credential,
    set_credential_state,
};

/// `projectManager.jiraIssueRead`, `projectManager.jiraIssuePush`, and
/// `projectManager.jiraSprintMove`. A moved issue's sprints are read from
/// Jira again before the board is returned.
pub(super) async fn project_manager_jira_issue(
    method: &str,
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let plan = state
        .core
        .lock()
        .await
        .plan_jira_issue_write(method, &params)?;
    let outcome = write_issue(state, &plan).await;
    if outcome == JiraIssueWriteOutcome::Moved
        && let Err(error) =
            super::super::delivery_checks::sync_sprints(state, &plan.project_id).await
    {
        tracing::debug!(?error, "Sprint read after a Jira sprint move failed");
    }
    Ok(state
        .core
        .lock()
        .await
        .jira_issue_write_result(&plan, &outcome))
}

async fn write_issue(state: &AppState, plan: &JiraIssueWritePlan) -> JiraIssueWriteOutcome {
    let secret = match read_stored_credential(state, &plan.source_id).await {
        Ok(secret) => secret,
        Err(reason) => return JiraIssueWriteOutcome::Failed(JiraWriteFailure::Source(reason)),
    };
    let observer = state.task_source_refresh_observer.clone();
    let site_base_url = plan.site_base_url.clone();
    let issue_key = plan.issue_key.clone();
    let write = plan.write.clone();
    let outcome = tokio::task::spawn_blocking(move || match expose_credential(&secret) {
        Ok((email, token)) => {
            observer.write_issue(&site_base_url, email, token, &issue_key, &write)
        }
        Err(reason) => JiraIssueWriteOutcome::Failed(JiraWriteFailure::Source(reason)),
    })
    .await
    .unwrap_or(JiraIssueWriteOutcome::Failed(JiraWriteFailure::Source(
        TaskSourceFailure::ProviderUnavailable,
    )));
    let failure = match &outcome {
        JiraIssueWriteOutcome::Failed(JiraWriteFailure::Source(reason)) => Some(*reason),
        _ => None,
    };
    set_credential_state(
        state,
        &plan.source_id,
        credential_presence_for_failure(failure),
    );
    outcome
}
