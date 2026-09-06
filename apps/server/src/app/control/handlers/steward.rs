use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use termloop_contract::current::{self as protocol, ProjectionTopic};
use termloop_core::companion_integrations::assistant_session::StewardWakeAdmission;

use super::super::super::invalidation::InvalidationRequest;
use super::super::super::{AppState, current_epoch_ms};
use super::terminate_session;

pub(in crate::app::control) async fn delete_steward_configuration(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params = serde_json::from_value::<protocol::StewardConfigurationDeleteParams>(params)
        .expect("validated Steward delete params");
    let project_id = params.project_id;
    let (commit, terminal, state_revision) = {
        let mut core = state.core.lock().await;
        let commit = core.reset_project_assistant(
            &project_id,
            params.expected_revision,
            current_epoch_ms(),
        )?;
        (commit, core.terminal_service(), core.state_revision())
    };
    state.companion_wakes.discard(&project_id);
    if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
        for session_id in &commit.session_ids {
            capabilities.revoke_session(session_id);
        }
    }
    let termloop_core::ProjectAssistantResetCommit {
        result,
        session_ids,
        retired_runtimes,
    } = commit;
    let cleanup = tokio::task::spawn_blocking(move || {
        let mut termination_failures = 0;
        for session_id in session_ids {
            match terminal.contains_session(&session_id) {
                Ok(true) => {
                    if terminal.terminate(&session_id).is_err() {
                        termination_failures += 1;
                    }
                }
                Ok(false) => {}
                Err(_) => termination_failures += 1,
            }
        }
        let reap_failures = retired_runtimes
            .into_iter()
            .map(|runtime| runtime.reap().is_err())
            .filter(|failed| *failed)
            .count();
        (termination_failures, reap_failures)
    })
    .await
    .unwrap_or((1, 1));
    state
        .core
        .lock()
        .await
        .finish_project_assistant_reset(&project_id);
    if cleanup.0 > 0 || cleanup.1 > 0 {
        tracing::warn!(
            termination_failures = cleanup.0,
            reap_failures = cleanup.1,
            %project_id,
            "Project Assistant reset could not fully reap assistant runtimes"
        );
    }
    state.tracker_runtime_wake.notify_one();
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Task,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
            ProjectionTopic::Companion,
            ProjectionTopic::Steward,
            ProjectionTopic::Routine,
            ProjectionTopic::Playbook,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    Ok(result)
}

fn permission_name(permission: protocol::AssistantPermission) -> &'static str {
    match permission {
        protocol::AssistantPermission::Default => "default",
        protocol::AssistantPermission::AcceptEdits => "acceptEdits",
        protocol::AssistantPermission::Plan => "plan",
        protocol::AssistantPermission::BypassPermissions => "bypassPermissions",
    }
}

pub(in crate::app::control) async fn set_steward_configuration(
    params: Value,
    state: &AppState,
) -> Result<Value, termloop_core::CoreError> {
    let params = serde_json::from_value::<protocol::StewardConfigurationSetParams>(params)
        .expect("validated Steward configuration params");
    let agent_id = match params.agent_id {
        protocol::StewardAgentId::Claude => "claude",
        protocol::StewardAgentId::Codex => "codex",
    };
    let capability = state
        .agent_capabilities
        .iter()
        .find(|capability| capability.agent_id == agent_id)
        .map(|capability| {
            if capability.available {
                termloop_core::AssistantAvailability::Proven
            } else {
                termloop_core::AssistantAvailability::Unavailable
            }
        })
        .unwrap_or(termloop_core::AssistantAvailability::Unavailable);
    let (result, previous_executor_session_id, state_revision, configuration_changed) = {
        let mut core = state.core.lock().await;
        let previous_revision = core.state_revision();
        let previous_executor_session_id = core.steward_executor_session_id(&params.project_id);
        let result = core.set_steward_configuration(termloop_core::StewardConfigurationUpdate {
            project_id: &params.project_id,
            agent_id,
            model: params.model,
            permission: permission_name(params.permission).into(),
            reasoning: params.reasoning,
            enabled: params.enabled,
            system_prompt: params.system_prompt,
            expected_revision: params.expected_revision,
            capability,
            updated_at_epoch_ms: current_epoch_ms(),
        });
        let state_revision = core.state_revision();
        (
            result,
            previous_executor_session_id,
            state_revision,
            state_revision != previous_revision,
        )
    };
    if result.is_ok() && configuration_changed {
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Steward],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }

    let retained_executor_session_id = result
        .as_ref()
        .ok()
        .and_then(|value| value["configuration"]["executorSessionId"].as_str());
    if let Some(previous_session_id) = previous_executor_session_id
        .filter(|session_id| Some(session_id.as_str()) != retained_executor_session_id)
    {
        // Configuration authority is already revoked. Process reap is
        // best-effort and cannot roll that durable decision back.
        let _ = terminate_session(json!({ "sessionId": previous_session_id }), state).await;
    }

    let should_wake = params.enabled
        && result
            .as_ref()
            .is_ok_and(|value| value["configuration"]["executorSessionId"].is_null());
    if !should_wake {
        if configuration_changed && !params.enabled {
            state.companion_wakes.discard(&params.project_id);
        }
        return result;
    }

    super::super::super::companion_supervisor::replace_steward_configuration_wake(
        state,
        &params.project_id,
    )
    .await;
    result
}

/// Delivers one visible wake to the current persistent Steward or launches its
/// single ordinary Agent Session. There is no per-wake provider process.
pub(in crate::app) async fn schedule_current_steward(
    project_id: String,
    generation: u64,
    wake_id: u64,
    reason: protocol::CompanionWakeReason,
    state: AppState,
) -> Result<StewardWakeAdmission, termloop_core::CoreError> {
    if state
        .core
        .lock()
        .await
        .steward_executor_session_id(&project_id)
        .is_some()
    {
        let message =
            termloop_core::companion_integrations::assistant_session::compose_steward_wake(
                steward_wake_kind(&reason),
            )?;
        let admission = state.core.lock().await.deliver_steward_wake(
            &project_id,
            generation,
            wake_id,
            &message,
        )?;
        return Ok(admission);
    }
    let Some(permit) = state.steward_launch_gate.try_admit(project_id.clone()) else {
        return Ok(StewardWakeAdmission::Coalesced);
    };
    // A launch is an accepted handoff, not a completed process start. Remove
    // this exact wake before spawning; if execution fails, the task restores a
    // fresh current-generation wake after rollback so the Companion retries.
    state
        .companion_wakes
        .acknowledge(&project_id, generation, wake_id);
    tokio::spawn(async move {
        let _permit = permit;
        match launch_current_steward(&project_id, &state).await {
            Ok(Some(_))
                if matches!(
                    reason,
                    protocol::CompanionWakeReason::PipelineMoved
                        | protocol::CompanionWakeReason::PipelineMovedAndRoutineFinding
                        | protocol::CompanionWakeReason::RoutineFinding
                ) =>
            {
                // Initial activation is deliberately silent without a user
                // message. Redeliver this pipeline wake after launch so the
                // movement is still reported by the now-running Steward.
                super::super::super::companion_supervisor::enqueue_current_steward_wake(
                    &state,
                    &project_id,
                    reason,
                )
                .await;
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, %project_id, "persistent Steward launch failed");
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                super::super::super::companion_supervisor::enqueue_current_steward_wake(
                    &state,
                    &project_id,
                    reason,
                )
                .await;
            }
        }
    });
    Ok(StewardWakeAdmission::Admitted)
}

fn steward_wake_kind(
    reason: &protocol::CompanionWakeReason,
) -> termloop_core::companion_integrations::assistant_session::StewardWakeKind {
    use termloop_core::companion_integrations::assistant_session::StewardWakeKind;
    match reason {
        protocol::CompanionWakeReason::UserMessage => StewardWakeKind::UserMessage,
        protocol::CompanionWakeReason::PipelineMoved => StewardWakeKind::PipelineMoved,
        protocol::CompanionWakeReason::PipelineMovedAndRoutineFinding => {
            StewardWakeKind::PipelineMovedAndRoutineFinding
        }
        protocol::CompanionWakeReason::RoutineFinding => StewardWakeKind::RoutineFinding,
        protocol::CompanionWakeReason::ConfigurationChanged => {
            StewardWakeKind::ConfigurationChanged
        }
        protocol::CompanionWakeReason::StartupRefresh => StewardWakeKind::StartupRefresh,
    }
}

/// Launches the one persistent normal Agent Session for an enabled Steward.
pub(in crate::app) async fn launch_current_steward(
    requested_project_id: &str,
    state: &AppState,
) -> Result<Option<Value>, termloop_core::CoreError> {
    let Some(target) = state
        .core
        .lock()
        .await
        .request_persistent_steward_launch(requested_project_id)
    else {
        return Ok(None);
    };
    let session_id = termloop_platform::generate_uuid_v4();
    let project_id = requested_project_id.to_owned();
    let prepared = state
        .core
        .lock()
        .await
        .prepare_persistent_assistant_launch(target, session_id);
    match prepared {
        Err(error) => Err(error),
        Ok(prepared) => {
            let prepared = tokio::task::spawn_blocking(move || {
                let mut prepared = prepared;
                prepared.prepare_runtime()?;
                Ok::<_, termloop_core::CoreError>(prepared)
            })
            .await
            .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))??;
            let session_id = prepared.session_id().to_owned();
            let admitted = {
                let mut core = state.core.lock().await;
                core.admit_persistent_assistant_launch(prepared, current_epoch_ms())
            };
            let admitted = match admitted {
                Ok(admitted) => admitted,
                Err(error) => return Err(error),
            };
            let completed = tokio::task::spawn_blocking(move || admitted.execute())
                .await
                .map_err(|error| termloop_core::CoreError::Terminal(error.to_string()))
                .and_then(|completed| completed);
            let (revision, retired_runtime) = if completed.is_err() {
                let mut core = state.core.lock().await;
                match core.rollback_assistant_launch(&session_id) {
                    Ok((revision, runtime)) => (revision, runtime),
                    Err(error) => {
                        tracing::error!(%error, %project_id, "failed to roll back persistent Steward launch admission");
                        (core.state_revision(), None)
                    }
                }
            } else {
                (state.core.lock().await.state_revision(), None)
            };
            if let Some(runtime) = retired_runtime {
                let _ = tokio::task::spawn_blocking(move || runtime.reap()).await;
            }
            let _ = state.invalidation_requests.try_send(InvalidationRequest {
                topics: vec![
                    ProjectionTopic::Steward,
                    ProjectionTopic::Session,
                    ProjectionTopic::AgentStatus,
                ],
                state_revision: revision,
                observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
            });
            completed.map(Some)
        }
    }
}
