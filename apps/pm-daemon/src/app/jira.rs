//! Jira reads and writes for the PM. The API token is resolved from its
//! handle for one call; every HTTP request runs on a blocking task, and the
//! store lock is never held while Jira is called.

use serde_json::{Value, json};
use termloop_pm::{
    FactRead, FactsObservation, JiraObservation, JiraPullOutcome, JiraStatusCategory,
    JiraWriteOutcome, PmStore, apply_jira_write, read_jira_issue_state, read_jira_sprints,
};
use termloop_pm_contract::pm::{EventName, PmJiraFailure};
use termloop_providers::{JiraCloudClient, JiraCredential, JiraSearchResult};

use crate::app::AppState;
use crate::app::control::errors::ControlError;
use crate::app::control::errors::{
    failure_name, from_pm, internal, jira_failed, search_failure, write_failure,
};
use crate::app::credentials;

/// Runs a blocking provider call off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ControlError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| internal())
}

fn failed_outcome(reason: &PmJiraFailure) -> Value {
    json!({ "kind": "failed", "reason": failure_name(reason) })
}

fn pull_outcome(outcome: &JiraPullOutcome) -> Value {
    match outcome {
        JiraPullOutcome::Failed(error) => failed_outcome(&search_failure(error)),
        JiraPullOutcome::Stale => json!({ "kind": "stale" }),
        JiraPullOutcome::SprintsUnsupported => json!({ "kind": "sprintsUnsupported" }),
        JiraPullOutcome::Applied(changes) => json!({
            "kind": "applied",
            "sprintsCreated": changes.sprints_created,
            "sprintsClosed": changes.sprints_closed,
            "ticketsCreated": changes.tickets_created,
            "ticketsMoved": changes.tickets_moved,
            "skipped": changes.skipped,
        }),
    }
}

/// Mirrors the project's Jira board into its sprints and tickets, then
/// records the active sprint's issue facts on the tickets that link them.
pub(crate) async fn pull(state: &AppState, project_id: &str) -> Result<Value, ControlError> {
    let plan = state.store.lock().plan_jira_sprint_pull(project_id)?;
    let outcome = match plan {
        None => failed_outcome(&PmJiraFailure::NotConfigured),
        Some(pull) => match credentials::resolve(&*state.credentials, &pull.credential_handle) {
            Err(reason) => failed_outcome(&reason),
            Ok(token) => {
                let request = pull.clone();
                let read = blocking(move || {
                    let client = JiraCloudClient::new()?;
                    let credential = JiraCredential {
                        email: &request.account_email,
                        api_token: token.expose(),
                    };
                    read_jira_sprints(&client, &request, credential)
                })
                .await?;
                let issues = read
                    .as_ref()
                    .ok()
                    .and_then(|read| read.active_issues.clone());
                let mut store = state.store.lock();
                let outcome = store.apply_jira_sprint_pull(&pull, read)?;
                if matches!(outcome, JiraPullOutcome::Applied(_))
                    && let Some(issues) = issues
                {
                    record_issue_facts(&mut store, project_id, &issues);
                }
                pull_outcome(&outcome)
            }
        },
    };
    let kind = outcome["kind"].clone();
    state.publish(
        EventName::PmJiraPulled,
        json!({ "projectId": project_id, "outcome": kind }),
    );
    if kind == "applied" {
        state.board_changed(project_id);
        state.fact_refresh.notify_one();
        crate::app::skills::note_event(
            state,
            project_id,
            termloop_pm::skill::SkillEvent::JiraPulled,
        );
    }
    Ok(json!({ "projectId": project_id, "outcome": outcome }))
}

/// Records what Jira said about each linked ticket of the project. A ticket
/// whose facts cannot be recorded is skipped.
pub(crate) fn record_issue_facts(store: &mut PmStore, project_id: &str, issues: &JiraSearchResult) {
    let Ok(board) = store.board(project_id) else {
        return;
    };
    for ticket in &board.tickets {
        let Some(key) = ticket.jira_issue_key() else {
            continue;
        };
        let Some(issue) = issues.issues.iter().find(|issue| issue.key == key) else {
            continue;
        };
        let observation = FactsObservation {
            jira: FactRead::Read(JiraObservation {
                status: issue.status_name.clone(),
                status_category: issue
                    .status_category
                    .as_deref()
                    .and_then(JiraStatusCategory::from_key),
                assignee: issue.assignee_display.clone(),
                updated_at_epoch_ms: None,
            }),
            ..FactsObservation::default()
        };
        if let Err(error) = store.record_facts(&ticket.id, observation) {
            tracing::debug!(%error, "skipped a Jira fact the store refused");
        }
    }
}

/// What writing the ticket to Jira would change, from a fresh Jira read.
pub(crate) async fn diff(state: &AppState, ticket_id: &str) -> Result<Value, ControlError> {
    let target = state.store.lock().jira_write_target(ticket_id)?;
    let token = credentials::resolve(&*state.credentials, &target.credential_handle)
        .map_err(jira_failed)?;
    let request = target.clone();
    let issue_state = blocking(move || {
        let client = JiraCloudClient::new().map_err(|_| PmJiraFailure::Unavailable)?;
        let credential = JiraCredential {
            email: &request.account_email,
            api_token: token.expose(),
        };
        read_jira_issue_state(&client, &request, credential).map_err(|error| write_failure(&error))
    })
    .await?
    .map_err(jira_failed)?;
    let diff = state
        .store
        .lock()
        .jira_write_diff(ticket_id, &issue_state)?;
    serde_json::to_value(diff).map_err(|_| internal())
}

/// Writes a confirmed diff to Jira on a second store connection, so the
/// daemon's store stays available while Jira is called.
pub(crate) async fn apply(
    state: &AppState,
    ticket_id: &str,
    confirmed_token: &str,
) -> Result<Value, ControlError> {
    let target = state.store.lock().jira_write_target(ticket_id)?;
    let token = match credentials::resolve(&*state.credentials, &target.credential_handle) {
        Ok(token) => token,
        Err(reason) => {
            return Ok(json!({ "kind": "failed", "applied": [], "reason": failure_name(&reason) }));
        }
    };
    let detached = state.store.clone();
    let (ticket, confirmed) = (ticket_id.to_owned(), confirmed_token.to_owned());
    let outcome = blocking(move || {
        let mut store = detached.open_detached()?;
        let Ok(client) = JiraCloudClient::new() else {
            return Ok(None);
        };
        let credential = JiraCredential {
            email: &target.account_email,
            api_token: token.expose(),
        };
        apply_jira_write(&mut store, &client, credential, &ticket, &confirmed).map(Some)
    })
    .await?
    .map_err(from_pm)?;
    let result = match outcome {
        None => json!({ "kind": "failed", "applied": [], "reason": "unavailable" }),
        Some(JiraWriteOutcome::Applied(changes)) => {
            json!({ "kind": "applied", "changes": changes })
        }
        Some(JiraWriteOutcome::Stale(diff)) => json!({ "kind": "stale", "diff": diff }),
        Some(JiraWriteOutcome::Failed { applied, error }) => json!({
            "kind": "failed",
            "applied": applied,
            "reason": failure_name(&write_failure(&error)),
        }),
    };
    if let Ok(Some(ticket)) = state.store.lock().ticket(ticket_id) {
        state.board_changed(&ticket.project_id);
    }
    Ok(result)
}

/// Checks the project's Jira with one read of its board's sprints; nothing
/// is applied. The detail never carries a Jira response.
pub(crate) async fn verify(state: &AppState, project_id: &str) -> (bool, &'static str) {
    let Ok(Some(pull)) = state.store.lock().plan_jira_sprint_pull(project_id) else {
        return (false, "Jira is not set up in Settings");
    };
    let Ok(token) = credentials::resolve(&*state.credentials, &pull.credential_handle) else {
        return (false, "the Jira API token is missing from the keychain");
    };
    let read = blocking(move || {
        let client = JiraCloudClient::new()?;
        let credential = JiraCredential {
            email: &pull.account_email,
            api_token: token.expose(),
        };
        read_jira_sprints(&client, &pull, credential).map(|_| ())
    })
    .await;
    match read {
        Ok(Ok(())) => (true, "the board's sprints were read"),
        _ => (false, "the board's sprints could not be read"),
    }
}
