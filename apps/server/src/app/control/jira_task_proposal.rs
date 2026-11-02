//! Control handlers for an Agent-proposed Jira issue. Approval plans under
//! the Core lock, creates the issue with the Task Source's stored credentials
//! outside it, then applies the outcome; the credential never leaves this
//! process and never appears in the result or an error.

use serde_json::Value;
use termloop_core::{CoreError, TaskSourceFailure};

use super::super::AppState;
use super::super::invalidation::{publish_session_invalidation, publish_task_invalidation_now};
use super::task_source::{expose_credential, read_stored_credential};

pub(super) async fn approve(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let plan = state
        .core
        .lock()
        .await
        .plan_jira_task_proposal_approval(&params)?;
    publish_session_invalidation(state).await;
    let outcome = match read_stored_credential(state, &plan.source_id).await {
        Ok(secret) => {
            let observer = state.task_source_refresh_observer.clone();
            let site_base_url = plan.site_base_url.clone();
            let draft = plan.draft.clone();
            tokio::task::spawn_blocking(move || match expose_credential(&secret) {
                Ok((email, token)) => observer.create_issue(&site_base_url, email, token, &draft),
                Err(reason) => Err(credential_failure(reason)),
            })
            .await
            .unwrap_or_else(|_| Err("TermLoop could not reach Jira".into()))
        }
        Err(reason) => Err(credential_failure(reason)),
    };
    let created = outcome.is_ok();
    let result = state.core.lock().await.apply_jira_task_proposal_creation(
        plan,
        outcome,
        uuid::Uuid::new_v4().to_string(),
        super::super::current_epoch_ms(),
    );
    if created {
        let revision = state.core.lock().await.state_revision();
        publish_task_invalidation_now(state, revision);
    }
    publish_session_invalidation(state).await;
    result
}

pub(super) async fn respond(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let result = state.core.lock().await.respond_jira_task_proposal(&params);
    if result.is_ok() {
        publish_session_invalidation(state).await;
    }
    result
}

fn credential_failure(reason: TaskSourceFailure) -> String {
    match reason {
        TaskSourceFailure::CredentialsMissing => {
            "The Jira Task Source has no saved credentials; add them in Project settings"
        }
        TaskSourceFailure::CredentialsInvalid => {
            "Jira rejected the Task Source credentials; update them in Project settings"
        }
        _ => "TermLoop could not read the Jira Task Source credentials",
    }
    .to_owned()
}
