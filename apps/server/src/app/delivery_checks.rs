//! Projects opened as Project Manager: the periodic Jira and Git-host read of
//! their tracked Tasks' delivery facts, and short-lived delivery check Agents
//! with their cleanup. Core owns every decision; this only runs the planned
//! work outside the core lock and publishes what changed.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{Value, json};
use termloop_contract::current::{self as protocol, ProjectionTopic};
use termloop_core::{CoreError, TaskSourceRefreshOutcome};

use super::AppState;
use super::invalidation::InvalidationRequest;

const TICK: Duration = Duration::from_secs(60);
/// How often each Project's facts are read without being asked.
const FACTS_INTERVAL_MS: u64 = 10 * 60 * 1000;

/// Reads each Project Manager Project's facts about every ten minutes and
/// retires finished or abandoned delivery checks. The schedule is runtime-only.
pub(super) async fn run_delivery_facts(state: AppState) {
    let mut last_read = HashMap::<String, u64>::new();
    loop {
        tokio::time::sleep(TICK).await;
        reap(&state).await;
        let projects = state.core.lock().await.delivery_facts_projects();
        let now = super::current_epoch_ms();
        for project_id in due_projects(&mut last_read, projects, now) {
            if let Err(error) = refresh_facts(&state, &project_id).await {
                tracing::debug!(%project_id, ?error, "Delivery facts read deferred");
            }
        }
    }
}

/// A Project first seen is read right away; then once per interval.
fn due_projects(
    last_read: &mut HashMap<String, u64>,
    projects: Vec<String>,
    now: u64,
) -> Vec<String> {
    last_read.retain(|project_id, _| projects.contains(project_id));
    projects
        .into_iter()
        .filter(|project_id| {
            let due = last_read
                .get(project_id)
                .is_none_or(|read| now.saturating_sub(*read) >= FACTS_INTERVAL_MS);
            if due {
                last_read.insert(project_id.clone(), now);
            }
            due
        })
        .collect()
}

/// Reads one Project's Jira and pull request facts now. Returns whether they
/// changed.
pub(super) async fn refresh_facts(state: &AppState, project_id: &str) -> Result<bool, CoreError> {
    let Some(plan) = state.core.lock().await.plan_delivery_facts_read(project_id) else {
        return Ok(false);
    };
    let jira = match plan.jira.clone() {
        Some(jira_plan) => Some(match super::control::observe_jira(state, jira_plan).await {
            TaskSourceRefreshOutcome::Success(result) => Ok(result),
            TaskSourceRefreshOutcome::Failure { reason, .. } => Err(reason),
        }),
        None => None,
    };
    let (plan, pull_requests) = tokio::task::spawn_blocking(move || {
        let pull_requests = plan.observe_pull_requests();
        (plan, pull_requests)
    })
    .await
    .map_err(|_| CoreError::Store("Delivery facts read failed".into()))?;
    let changed = state.core.lock().await.apply_delivery_facts_read(
        plan,
        jira,
        pull_requests,
        super::current_epoch_ms(),
    )?;
    if changed {
        publish_task_change(state).await;
    }
    Ok(changed)
}

/// Applies one Project Manager sprint, tracking, or Task command. A change to
/// the active sprint changes which Tasks are tracked, so their facts are read
/// right away in the background.
pub(super) async fn project_manager_command(
    method: &str,
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let (result, previous_revision, current_revision) = {
        let mut core = state.core.lock().await;
        let previous_revision = core.state_revision();
        let result = core.handle(method, params)?;
        (result, previous_revision, core.state_revision())
    };
    super::invalidation::queue_changed_commit_invalidation(
        state,
        super::invalidation::CommitImpact::Task,
        previous_revision,
        current_revision,
    )
    .await;
    if let Some(project_id) = result
        .get("projectId")
        .or_else(|| result.get("board").and_then(|board| board.get("projectId")))
        .and_then(Value::as_str)
    {
        let state = state.clone();
        let project_id = project_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = refresh_facts(&state, &project_id).await {
                tracing::debug!(%project_id, ?error, "Delivery facts read deferred");
            }
        });
    }
    Ok(result)
}

/// `projectManager.factsRefresh`: reads the Project's facts now and answers
/// with its board.
pub(super) async fn refresh_command(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?
        .to_owned();
    state.core.lock().await.handle(
        "projectManager.boardGet",
        json!({ "projectId": project_id }),
    )?;
    refresh_facts(state, &project_id).await?;
    state.core.lock().await.handle(
        "projectManager.boardGet",
        json!({ "projectId": project_id }),
    )
}

/// `projectManager.checkRequest`: starts one delivery check unless a running
/// one already covers its Tasks.
pub(super) async fn request_check(params: Value, state: &AppState) -> Result<Value, CoreError> {
    let launch = state
        .core
        .lock()
        .await
        .plan_requested_delivery_check(&params)?;
    let Some(launch) = launch else {
        return Ok(json!({ "status": "alreadyRunning", "sessionId": null, "taskIds": [] }));
    };
    let check_id = launch.check_id.clone();
    let task_ids = launch.task_ids.clone();
    let session_id = launch.plan.session_id().to_owned();
    match super::agent_launch::execute_agent_launch(state, *launch.plan).await {
        Ok(_) => {
            publish_task_change(state).await;
            Ok(json!({ "status": "started", "sessionId": session_id, "taskIds": task_ids }))
        }
        Err(error) => {
            state
                .core
                .lock()
                .await
                .fail_delivery_check_launch(&check_id);
            reap(state).await;
            Err(error)
        }
    }
}

/// `delivery_check_record`: records the check's report, then retires it.
pub(super) async fn record(
    token: &str,
    params: protocol::DeliveryCheckRecordParams,
    state: &AppState,
) -> Result<Value, CoreError> {
    let report = termloop_core::DeliveryCheckReport {
        check_id: params.check_id,
        tasks: params
            .tasks
            .into_iter()
            .map(|task| termloop_core::DeliveryCheckTaskReport {
                task_id: task.task_id,
                environments: task
                    .environments
                    .into_iter()
                    .map(|environment| termloop_core::DeliveryCheckEnvironment {
                        name: environment.name,
                        state: environment.state,
                        detail: environment.detail,
                    })
                    .collect(),
                blockers: task.blockers,
                notes_markdown: task.notes_markdown,
                ticket_proposal: task.ticket_proposal.map(|proposal| {
                    termloop_core::DeliveryCheckTicketProposal {
                        title: proposal.title,
                        description: proposal.description,
                        summary: proposal.summary,
                    }
                }),
            })
            .collect(),
    };
    let recorded =
        state
            .core
            .lock()
            .await
            .record_delivery_check(token, report, super::current_epoch_ms())?;
    publish_task_change(state).await;
    let cleanup = state.clone();
    tokio::spawn(async move { reap(&cleanup).await });
    Ok(json!({ "status": "recorded", "taskIds": recorded["taskIds"] }))
}

/// Terminates and retires every delivery check Session no running check owns.
pub(super) async fn reap(state: &AppState) {
    let sessions = state
        .core
        .lock()
        .await
        .obsolete_delivery_check_sessions(super::current_epoch_ms());
    let mut changed = false;
    for session_id in sessions {
        match super::control::terminate_session(json!({ "sessionId": session_id }), state).await {
            Ok(_) | Err(CoreError::NotFound) => {}
            Err(error) => {
                tracing::warn!(%error, "Delivery check termination deferred");
                continue;
            }
        }
        match state
            .core
            .lock()
            .await
            .retire_delivery_check_descriptor(&session_id)
        {
            Ok(()) => changed = true,
            Err(CoreError::NotFound) => {}
            Err(error) => tracing::warn!(%error, "Delivery check retirement deferred"),
        }
    }
    if changed {
        let state_revision = state.core.lock().await.state_revision();
        super::invalidation::queue_durable_commit_invalidation(
            state,
            super::invalidation::CommitImpact::SessionAgent,
            state_revision,
        )
        .await;
        publish_task_change(state).await;
    }
}

async fn publish_task_change(state: &AppState) {
    let state_revision = state.core.lock().await.state_revision();
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_are_read_on_first_sight_and_then_once_per_interval() {
        let mut last = HashMap::new();
        assert_eq!(due_projects(&mut last, vec!["a".into()], 0), ["a"]);
        assert!(due_projects(&mut last, vec!["a".into()], FACTS_INTERVAL_MS - 1).is_empty());
        assert_eq!(
            due_projects(&mut last, vec!["a".into()], FACTS_INTERVAL_MS),
            ["a"]
        );
        // A Project that leaves and returns is read again at once.
        assert!(due_projects(&mut last, vec![], FACTS_INTERVAL_MS + 1).is_empty());
        assert_eq!(
            due_projects(&mut last, vec!["a".into()], FACTS_INTERVAL_MS + 2),
            ["a"]
        );
    }
}
