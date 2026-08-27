use std::sync::atomic::Ordering;

use termloop_contract::current::ProjectionTopic;
use termloop_core::CoreError;
use termloop_terminal::TerminalError;

use super::super::super::AppState;
use super::super::super::invalidation::{InvalidationRequest, refresh_task_presence_for_cwd};

pub(in crate::app::control) async fn delete_project(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let (plan, terminal) = {
        let mut core = state.core.lock().await;
        let plan = core.begin_project_delete(params)?;
        (plan, core.terminal_service())
    };
    let _task_source_guards =
        super::super::task_source::lock_sources(state, plan.task_source_ids()).await;
    let task_source_ids = plan.task_source_ids().to_vec();
    let credential_escrow =
        match super::super::task_source::take_credentials(state, plan.task_source_ids()).await {
            Ok(escrow) => escrow,
            Err(error) => {
                state.core.lock().await.cancel_project_delete(&plan);
                return Err(error);
            }
        };
    let session_ids = plan.session_ids().to_vec();
    let termination_ids = session_ids.clone();
    let termination = tokio::task::spawn_blocking(move || {
        for session_id in termination_ids {
            if !terminal
                .contains_session(&session_id)
                .map_err(|error| error.to_string())?
            {
                continue;
            }
            match terminal.terminate(&session_id) {
                Ok(()) | Err(TerminalError::SessionNotFound) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok::<(), String>(())
    })
    .await;
    let termination = match termination {
        Ok(termination) => termination,
        Err(error) => {
            let restoration =
                super::super::task_source::restore_credentials(state, credential_escrow).await;
            state.core.lock().await.cancel_project_delete(&plan);
            restoration?;
            return Err(CoreError::Terminal(format!(
                "Project Session termination failed: {error}"
            )));
        }
    };
    if let Err(error) = termination {
        let restoration =
            super::super::task_source::restore_credentials(state, credential_escrow).await;
        state.core.lock().await.cancel_project_delete(&plan);
        restoration?;
        return Err(CoreError::Terminal(error));
    }

    let (commit, state_revision) = {
        let mut core = state.core.lock().await;
        let commit = core.complete_project_delete(plan);
        let state_revision = core.state_revision();
        (commit, state_revision)
    };
    let commit = match commit {
        Ok(commit) => commit,
        Err(error) => {
            super::super::task_source::restore_credentials(state, credential_escrow).await?;
            return Err(error);
        }
    };
    drop(credential_escrow);
    for source_id in &task_source_ids {
        super::super::task_source::forget_credential_state(state, source_id);
    }
    let termloop_core::project::ProjectDeleteCommit {
        result,
        retired_runtimes,
        session_ids,
        changed_cwds,
    } = commit;
    if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
        for session_id in &session_ids {
            capabilities.revoke_session(session_id);
        }
    }
    let reap_failures = tokio::task::spawn_blocking(move || {
        retired_runtimes
            .into_iter()
            .map(|runtime| runtime.reap().is_err())
            .filter(|failed| *failed)
            .count()
    })
    .await
    .unwrap_or(1);
    if reap_failures > 0 {
        tracing::warn!(
            reap_failures,
            "Project deletion could not fully reap provider runtimes"
        );
    }
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Project,
            ProjectionTopic::Task,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
            ProjectionTopic::Companion,
            ProjectionTopic::Steward,
            ProjectionTopic::Worker,
            ProjectionTopic::Routine,
            ProjectionTopic::TaskSource,
            ProjectionTopic::Run,
            ProjectionTopic::Playbook,
            ProjectionTopic::GitHost,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    for cwd in changed_cwds {
        refresh_task_presence_for_cwd(state, &cwd).await;
    }
    Ok(result)
}
