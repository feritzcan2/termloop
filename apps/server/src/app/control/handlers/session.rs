use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use termloop_contract::current::ProjectionTopic;
use termloop_core::CoreError;
use termloop_terminal::TerminalService;
use tokio::time::{Duration, Instant};

use super::super::super::AppState;
use super::super::super::core_lock::in_operation;
use super::super::super::gates::{
    AGENT_RELOCATION_ATTEMPT_TIMEOUT, AGENT_RESUME_ATTEMPT_TIMEOUT,
    AGENT_RESUME_FINALIZATION_TIMEOUT, AGENT_RESUME_SHUTDOWN_TIMEOUT,
    AGENT_RESUME_STABILITY_WINDOW, FairResumePermit, MAX_ACTIVE_AGENT_RESUMES,
    MAX_ACTIVE_STEWARD_RESUMES, MAX_ACTIVE_WORKER_RESUMES, ObservationPriority, ResumeGateError,
};
use super::super::super::invalidation::{
    InvalidationRequest, publish_agent_resume_invalidation, publish_session_invalidation,
    refresh_task_presence_for_cwd,
};

pub(in crate::app::control) async fn launch_agent_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let mut plan = state.core.lock().await.take_agent_launch(params)?;
    plan = tokio::task::spawn_blocking(move || {
        plan.prepare_runtime();
        plan
    })
    .await
    .map_err(|error| CoreError::Terminal(format!("agent runtime preparation failed: {error}")))?;
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "agent status runtime unavailable");
    }
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_agent_launch(&mut plan);
        (result, core.state_revision())
    };
    tokio::task::spawn_blocking(move || drop(plan));
    if let Ok(value) = &result {
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Session],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
        if let Some(cwd) = value
            .get("process")
            .and_then(|process| process.get("cwd"))
            .and_then(serde_json::Value::as_str)
        {
            refresh_task_presence_for_cwd(state, cwd).await;
        }
    }
    result
}

pub(in crate::app::control) async fn fork_agent_session(
    params: serde_json::Value,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    const STARTUP_RETRY_DELAYS: [Duration; 3] = [
        Duration::from_millis(200),
        Duration::from_millis(600),
        Duration::from_millis(1_200),
    ];

    for attempt in 1..=STARTUP_RETRY_DELAYS.len() + 1 {
        match fork_agent_session_once(params.clone(), deadline, state).await {
            Ok(value) => return Ok(value),
            Err(failure) => {
                let retry_delay = STARTUP_RETRY_DELAYS.get(attempt - 1).copied();
                let retryable = failure.is_startup_exit()
                    && retry_delay.is_some_and(|delay| {
                        deadline.saturating_duration_since(Instant::now()) > delay
                    });
                if !retryable {
                    if let Some((session_id, runtime_epoch)) = failure.child.as_ref()
                        && !retain_failed_agent_fork(state, session_id, *runtime_epoch).await
                    {
                        publish_session_invalidation(state).await;
                        return Err(CoreError::AgentForkUnavailable {
                            reason: termloop_core::AgentForkUnavailableReason::RuntimeConflict,
                        });
                    }
                    publish_session_invalidation(state).await;
                    return Err(failure.error);
                }
                let Some((session_id, runtime_epoch)) = failure.child.as_ref() else {
                    return Err(failure.error);
                };
                if !rollback_failed_agent_fork(state, session_id, *runtime_epoch).await {
                    publish_session_invalidation(state).await;
                    return Err(CoreError::AgentForkUnavailable {
                        reason: termloop_core::AgentForkUnavailableReason::RuntimeConflict,
                    });
                }
                publish_session_invalidation(state).await;
                let retry_delay = retry_delay.expect("retryable attempts have a delay");
                tracing::warn!(
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "fork child exited during startup; retrying with backoff"
                );
                tokio::time::sleep(retry_delay).await;
            }
        }
    }
    unreachable!("the bounded fork attempt loop always returns")
}

pub(in crate::app::control) async fn repair_provider_history(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let session_id = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let plan = state
        .core
        .lock()
        .await
        .plan_provider_history_repair(params)?;
    // Own the full plan/observe/apply sequence in a coordinator task. If the
    // requesting socket cancels while the blocking filesystem mutation is in
    // flight, the coordinator still commits or releases the exact reservation.
    let coordinator_state = state.clone();
    let coordinator_session_id = session_id.clone();
    let coordinator = tokio::spawn(async move {
        let worker = tokio::task::spawn_blocking(move || {
            let observed = plan.execute();
            (plan, observed)
        })
        .await;
        let (plan, observed) = match worker {
            Ok(value) => value,
            Err(error) => {
                coordinator_state
                    .core
                    .lock()
                    .await
                    .cancel_provider_history_repair(&coordinator_session_id);
                return Err(CoreError::Terminal(format!(
                    "provider history repair worker failed: {error}"
                )));
            }
        };
        let observed = match observed {
            Ok(observed) => observed,
            Err(error) => {
                coordinator_state
                    .core
                    .lock()
                    .await
                    .cancel_provider_history_repair(&coordinator_session_id);
                return Err(error);
            }
        };
        let result = coordinator_state
            .core
            .lock()
            .await
            .complete_provider_history_repair(plan, observed);
        if result.is_ok() {
            publish_session_invalidation(&coordinator_state).await;
        }
        result
    });
    coordinator
        .await
        .map_err(|error| CoreError::Terminal(format!("repair coordinator failed: {error}")))?
}

struct AgentForkAttemptFailure {
    error: CoreError,
    child: Option<(String, u64)>,
}

impl AgentForkAttemptFailure {
    fn with_child(error: CoreError, session_id: &str, runtime_epoch: u64) -> Self {
        Self {
            error,
            child: Some((session_id.to_owned(), runtime_epoch)),
        }
    }

    fn is_startup_exit(&self) -> bool {
        matches!(
            &self.error,
            CoreError::AgentForkUnavailable {
                reason: termloop_core::AgentForkUnavailableReason::StartupExited,
            }
        )
    }
}

impl From<CoreError> for AgentForkAttemptFailure {
    fn from(error: CoreError) -> Self {
        Self { error, child: None }
    }
}

async fn fork_agent_session_once(
    params: serde_json::Value,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, AgentForkAttemptFailure> {
    let mut plan = {
        let core = state.core.lock().await;
        core.plan_agent_fork(params)?
    };
    let task_scope = plan
        .fork_task_scope()
        .map(|(task_id, project_id)| (task_id.to_owned(), project_id.to_owned()));
    let permit = if let Some((task_id, project_id)) = task_scope.as_ref() {
        Some(
            state
                .git_observation_gate
                .acquire_until(project_id.as_str(), ObservationPriority::Explicit, deadline)
                .await
                .map_err(|_| task_launch_timeout(task_id))?,
        )
    } else {
        None
    };
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| {
            task_scope
                .as_ref()
                .map(|(task_id, _)| task_launch_timeout(task_id))
                .unwrap_or(CoreError::AgentForkUnavailable {
                    reason: termloop_core::AgentForkUnavailableReason::RuntimeConflict,
                })
        })?;
    plan = tokio::task::spawn_blocking(move || -> Result<_, CoreError> {
        plan.observe_fork_worktree(remaining)?;
        plan.prepare_runtime();
        plan.verify_fork_source_history()?;
        Ok(plan)
    })
    .await
    .map_err(|error| CoreError::Terminal(format!("agent fork preparation failed: {error}")))??;
    drop(permit);
    if !plan.fork_runtime_ready() {
        return Err(CoreError::AgentForkUnavailable {
            reason: termloop_core::AgentForkUnavailableReason::RuntimeConflict,
        }
        .into());
    }
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "forked agent status runtime unavailable");
    }
    let session_id = plan.session_id().to_owned();
    let runtime_epoch = plan.runtime_epoch();
    let startup_deadline = deadline.min(Instant::now() + AGENT_RESUME_ATTEMPT_TIMEOUT);
    let result = {
        let mut core = state.core.lock().await;
        match core.complete_agent_launch(&mut plan) {
            Ok(value) => {
                match state
                    .terminal
                    .set_exit_replay_retention(&session_id, runtime_epoch, true)
                {
                    Ok(()) => Ok(value),
                    Err(error) => Err(AgentForkAttemptFailure::with_child(
                        CoreError::Terminal(error.to_string()),
                        &session_id,
                        runtime_epoch,
                    )),
                }
            }
            Err(error) => Err(error.into()),
        }
    };
    tokio::task::spawn_blocking(move || drop(plan));
    let value = result?;
    if let Err(reason) = wait_for_agent_fork_startup(
        state,
        &session_id,
        runtime_epoch,
        startup_deadline,
        AGENT_RESUME_STABILITY_WINDOW,
    )
    .await
    {
        return Err(AgentForkAttemptFailure::with_child(
            CoreError::AgentForkUnavailable { reason },
            &session_id,
            runtime_epoch,
        ));
    }
    let confirmation = {
        let mut core = state.core.lock().await;
        match core.confirm_agent_fork_conversation(&session_id, runtime_epoch) {
            Ok(()) => state
                .terminal
                .set_exit_replay_retention(&session_id, runtime_epoch, false)
                .map(|()| core.state_revision())
                .map_err(|error| {
                    AgentForkAttemptFailure::with_child(
                        CoreError::Terminal(error.to_string()),
                        &session_id,
                        runtime_epoch,
                    )
                }),
            Err(error) => Err(AgentForkAttemptFailure::with_child(
                error,
                &session_id,
                runtime_epoch,
            )),
        }
    };
    let state_revision = confirmation?;
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Session],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if let Some(cwd) = value
        .get("process")
        .and_then(|process| process.get("cwd"))
        .and_then(serde_json::Value::as_str)
    {
        refresh_task_presence_for_cwd(state, cwd).await;
    }
    Ok(value)
}

pub(in crate::app::control) async fn preview_agent_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state.core.lock().await.preview_agent_launch(params)
}

pub(in crate::app::control) async fn list_session_history(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let outcome = state.core.lock().await.plan_session_history_list(params)?;
    match outcome {
        termloop_core::session_launch::SessionHistoryListPlanOutcome::Current(value) => Ok(value),
        termloop_core::session_launch::SessionHistoryListPlanOutcome::Observe(plan) => {
            let cancellation = Arc::new(AtomicBool::new(false));
            let _cancel_on_drop = SessionHistoryScanCancellation(cancellation.clone());
            let observed = tokio::task::spawn_blocking(move || plan.observe(&cancellation))
                .await
                .map_err(|error| {
                    CoreError::Terminal(format!("agent history scan failed: {error}"))
                })?;
            state
                .core
                .lock()
                .await
                .complete_session_history_list(observed)
        }
    }
}

pub(in crate::app::control) async fn session_history_preview(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state.core.lock().await.session_history_preview(params)
}

struct SessionHistoryScanCancellation(Arc<AtomicBool>);

impl Drop for SessionHistoryScanCancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(in crate::app::control) async fn preview_session_history_resume(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = state
        .core
        .lock()
        .await
        .plan_session_history_resume(&params)?;
    let observed = tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Terminal(format!("history resume check failed: {error}")))??;
    state
        .core
        .lock()
        .await
        .complete_session_history_resume_preview(observed, &params)
}

pub(in crate::app::control) async fn preview_quick_action(
    mut params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state.attachments.hydrate_quick_action(&mut params).await?;
    state.core.lock().await.preview_quick_action(params)
}

pub(in crate::app::control) async fn paste_agent_image(
    mut params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state.attachments.hydrate_quick_action(&mut params).await?;
    state.core.lock().await.paste_agent_image(params)
}

pub(in crate::app::control) async fn launch_quick_action(
    mut params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state.attachments.hydrate_quick_action(&mut params).await?;
    let mut plan = {
        let mut core = state.core.lock().await;
        core.take_quick_action_launch(params)?
    };
    // Preview cached the exact semantic payload. Runtime preparation may bind
    // invocation's single-use Codex loopback placeholder, but cannot append or
    // reinterpret provider arguments.
    plan = tokio::task::spawn_blocking(move || {
        plan.prepare_runtime();
        plan
    })
    .await
    .map_err(|error| CoreError::Terminal(format!("agent runtime preparation failed: {error}")))?;
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "agent status runtime unavailable");
    }
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_agent_launch(&mut plan);
        (result, core.state_revision())
    };
    tokio::task::spawn_blocking(move || drop(plan));
    if result.is_ok() {
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Session],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
    result
}

pub(in crate::app::control) async fn preview_run_configuration_improver(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state
        .core
        .lock()
        .await
        .preview_run_configuration_improver(params)
}

/// The improver redeems its own ticket kind but is otherwise an ordinary Agent
/// launch, so it shares Quick Action's prepare-outside-the-lock sequence rather
/// than gaining a second launch path.
pub(in crate::app::control) async fn launch_run_configuration_improver(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let mut plan = {
        let mut core = state.core.lock().await;
        core.take_run_configuration_improver_launch(params)?
    };
    plan = tokio::task::spawn_blocking(move || {
        plan.prepare_runtime();
        plan
    })
    .await
    .map_err(|error| CoreError::Terminal(format!("agent runtime preparation failed: {error}")))?;
    if let Some(error) = plan.observation_warning() {
        tracing::warn!(%error, "agent status runtime unavailable");
    }
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_agent_launch(&mut plan);
        (result, core.state_revision())
    };
    tokio::task::spawn_blocking(move || drop(plan));
    if result.is_ok() {
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Session],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
    }
    result
}

pub(in crate::app) async fn launch_task_session(
    params: serde_json::Value,
    agent: bool,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    if agent {
        let requested = params
            .get("agentId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !state
            .agent_capabilities
            .iter()
            .any(|capability| capability.agent_id == requested && capability.available)
        {
            return Err(CoreError::AgentUnsupported);
        }
        let mut agent_plan = state.core.lock().await.take_agent_launch(params)?;
        agent_plan = tokio::task::spawn_blocking(move || {
            agent_plan.prepare_runtime();
            agent_plan
        })
        .await
        .map_err(|error| {
            CoreError::Terminal(format!("agent runtime preparation failed: {error}"))
        })?;
        if let Some(error) = agent_plan.observation_warning() {
            tracing::warn!(%error, "agent status runtime unavailable");
        }
        let result = state
            .core
            .lock()
            .await
            .complete_agent_launch(&mut agent_plan)?;
        tokio::task::spawn_blocking(move || drop(agent_plan));
        let state_revision = state.core.lock().await.state_revision();
        let _ = state.invalidation_requests.try_send(InvalidationRequest {
            topics: vec![ProjectionTopic::Session],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
        if let Some(cwd) = result
            .get("process")
            .and_then(|process| process.get("cwd"))
            .and_then(serde_json::Value::as_str)
        {
            refresh_task_presence_for_cwd(state, cwd).await;
        }
        return Ok(result);
    }
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_launch(params, agent)?
    };
    let task_id = plan.task_id().to_owned();
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire_until(&project_id, ObservationPriority::Explicit, deadline)
        .await
        .map_err(|_| task_launch_timeout(&task_id))?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| task_launch_timeout(&task_id))?;
    let observed = tokio::task::spawn_blocking(move || plan.observe(remaining))
        .await
        .map_err(|error| CoreError::Store(format!("Task launch observation failed: {error}")))??;
    drop(permit);
    let result = if agent {
        let mut agent_plan = {
            let core = state.core.lock().await;
            core.complete_task_agent_launch_plan(observed)?
        };
        agent_plan = tokio::task::spawn_blocking(move || {
            agent_plan.prepare_runtime();
            agent_plan
        })
        .await
        .map_err(|error| {
            CoreError::Terminal(format!("agent runtime preparation failed: {error}"))
        })?;
        let result = {
            let mut core = state.core.lock().await;
            core.complete_agent_launch(&mut agent_plan)
        };
        tokio::task::spawn_blocking(move || drop(agent_plan));
        result
    } else {
        let mut core = state.core.lock().await;
        core.complete_task_terminal_launch(observed)
    }?;
    let state_revision = state.core.lock().await.state_revision();
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Session,
            ProjectionTopic::Steward,
            ProjectionTopic::Worker,
            ProjectionTopic::Routine,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if let Some(cwd) = result
        .get("process")
        .and_then(|process| process.get("cwd"))
        .and_then(serde_json::Value::as_str)
    {
        refresh_task_presence_for_cwd(state, cwd).await;
    }
    Ok(result)
}

pub(in crate::app) async fn launch_task_run(
    params: serde_json::Value,
    restart: bool,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let task_id = params
        .get("taskId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("taskId".into()))?
        .to_owned();
    let configuration_id = params
        .get("configurationId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("configurationId".into()))?
        .to_owned();
    let force_setup = params
        .get("forceSetup")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| CoreError::InvalidParams("forceSetup".into()))?;
    let current_session_id = state
        .core
        .lock()
        .await
        .active_run_session(Some(&task_id), &configuration_id);
    if let Some(session_id) = current_session_id {
        if !restart {
            return state.core.lock().await.run_session_projection(&session_id);
        }
        replace_previous_run_session(&session_id, state).await?;
    }
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_launch(params, false)?
    };
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire_until(&project_id, ObservationPriority::Explicit, deadline)
        .await
        .map_err(|_| task_launch_timeout(&task_id))?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| task_launch_timeout(&task_id))?;
    let observed = tokio::task::spawn_blocking(move || plan.observe(remaining))
        .await
        .map_err(|error| CoreError::Store(format!("Task run observation failed: {error}")))??;
    drop(permit);
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_task_run_launch(observed, &configuration_id, force_setup);
        (result, core.state_revision())
    };
    let result = result?;
    if let Some(session_id) = result
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
    {
        observe_run_terminal(session_id, state.clone());
    }
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Session, ProjectionTopic::Run],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if let Some(cwd) = result
        .get("process")
        .and_then(|process| process.get("cwd"))
        .and_then(serde_json::Value::as_str)
    {
        refresh_task_presence_for_cwd(state, cwd).await;
    }
    Ok(result)
}

pub(in crate::app) async fn launch_project_run(
    params: serde_json::Value,
    restart: bool,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let project_id = params
        .get("projectId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?
        .to_owned();
    let configuration_id = params
        .get("configurationId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("configurationId".into()))?
        .to_owned();
    let force_setup = params
        .get("forceSetup")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| CoreError::InvalidParams("forceSetup".into()))?;
    let current_session_id = state
        .core
        .lock()
        .await
        .active_run_session(None, &configuration_id);
    if let Some(session_id) = current_session_id {
        if !restart {
            return state.core.lock().await.run_session_projection(&session_id);
        }
        replace_previous_run_session(&session_id, state).await?;
    }
    let (result, state_revision) = {
        let mut core = state.core.lock().await;
        let result = core.complete_project_run_launch(&project_id, &configuration_id, force_setup);
        (result, core.state_revision())
    };
    let result = result?;
    if let Some(session_id) = result
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
    {
        observe_run_terminal(session_id, state.clone());
    }
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Session, ProjectionTopic::Run],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if let Some(cwd) = result
        .get("process")
        .and_then(|process| process.get("cwd"))
        .and_then(serde_json::Value::as_str)
    {
        refresh_task_presence_for_cwd(state, cwd).await;
    }
    Ok(result)
}

/// Restart means one run keeps one Session, so the replaced process is both
/// terminated and closed. Terminating alone marks the descriptor exited and
/// keeps it — correct for a Session the user stopped and may still want to
/// read, wrong for one this command is about to supersede.
async fn replace_previous_run_session(session_id: &str, state: &AppState) -> Result<(), CoreError> {
    terminate_session(json!({ "sessionId": session_id }), state).await?;
    close_session(json!({ "sessionId": session_id }), state).await?;
    Ok(())
}

fn observe_run_terminal(session_id: String, state: AppState) {
    let Ok(mut subscription) = state.terminal.subscribe(&session_id, state.runtime_epoch) else {
        return;
    };
    tokio::spawn(async move {
        loop {
            match subscription.recv_delivery().await {
                Ok(delivery) => match delivery.event {
                    termloop_terminal::TerminalEvent::Output(bytes) => {
                        let (changed, state_revision) = {
                            let mut core = state.core.lock().await;
                            let changed = core.record_run_terminal_output(&session_id, &bytes);
                            (changed, core.state_revision())
                        };
                        if changed {
                            let _ = state.invalidation_requests.try_send(InvalidationRequest {
                                topics: vec![ProjectionTopic::Run],
                                state_revision,
                                observation_sequence: state
                                    .observation_sequence
                                    .load(Ordering::Relaxed),
                            });
                        }
                    }
                    termloop_terminal::TerminalEvent::Eof => break,
                    termloop_terminal::TerminalEvent::Gap(_) => {}
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

pub(in crate::app) async fn preview_task_agent_session(
    params: serde_json::Value,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let kickoff_message = params
        .get("kickoffMessage")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    preview_task_agent_session_with_initial_message(
        params,
        kickoff_message
            .as_deref()
            .map(TaskAgentInitialMessage::Kickoff),
        deadline,
        state,
    )
    .await
}

pub(in crate::app) async fn preview_steward_task_agent_session(
    params: serde_json::Value,
    steward_session_id: &str,
    task_id: &str,
    assignment: &str,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    preview_task_agent_session_with_initial_message(
        params,
        Some(TaskAgentInitialMessage::StewardAssignment {
            steward_session_id,
            task_id,
            assignment,
        }),
        deadline,
        state,
    )
    .await
}

enum TaskAgentInitialMessage<'a> {
    Kickoff(&'a str),
    StewardAssignment {
        steward_session_id: &'a str,
        task_id: &'a str,
        assignment: &'a str,
    },
}

async fn preview_task_agent_session_with_initial_message(
    params: serde_json::Value,
    initial_message: Option<TaskAgentInitialMessage<'_>>,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = {
        let core = state.core.lock().await;
        core.plan_task_worktree_launch(params, true)?
    };
    let task_id = plan.task_id().to_owned();
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire_until(&project_id, ObservationPriority::Explicit, deadline)
        .await
        .map_err(|_| task_launch_timeout(&task_id))?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| task_launch_timeout(&task_id))?;
    let observed = tokio::task::spawn_blocking(move || plan.observe(remaining))
        .await
        .map_err(|error| CoreError::Store(format!("Task launch observation failed: {error}")))??;
    drop(permit);
    let agent_plan = {
        let core = state.core.lock().await;
        let plan = core.complete_task_agent_launch_plan(observed)?;
        match initial_message {
            Some(TaskAgentInitialMessage::StewardAssignment {
                steward_session_id,
                task_id,
                assignment,
            }) => {
                core.attach_steward_task_assignment(plan, steward_session_id, task_id, assignment)?
            }
            Some(TaskAgentInitialMessage::Kickoff(message)) => {
                core.attach_task_kickoff(plan, &task_id, message)?
            }
            None => plan,
        }
    };
    state
        .core
        .lock()
        .await
        .preview_prepared_task_agent_launch(agent_plan)
}

fn task_launch_timeout(task_id: &str) -> CoreError {
    CoreError::TaskWorktreeUnavailable {
        task_id: task_id.to_owned(),
        reason: termloop_core::TaskWorktreeUnavailableReason::Timeout,
    }
}

pub(in crate::app) async fn terminate_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let session_id = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let requires_ownership_recovery = state
        .core
        .lock()
        .await
        .session_resume_failure(&session_id)
        .is_some_and(|failure| {
            matches!(
                failure,
                termloop_core::ResumeFailureReason::RuntimeOwnershipUncertain
                    | termloop_core::ResumeFailureReason::RuntimeConflict
            )
        });
    if requires_ownership_recovery {
        let retired_codex_runtime = state
            .core
            .lock()
            .await
            .reserve_retryable_session_termination(&session_id)?;
        let recovery =
            recover_agent_runtime_ownership(state, &session_id, retired_codex_runtime).await;
        if !matches!(recovery, Ok(None)) {
            state
                .core
                .lock()
                .await
                .cancel_retryable_session_termination(&session_id);
            return match recovery {
                Ok(Some(_)) => Err(CoreError::Terminal(
                    "runtime ownership recovery could not prove the previous process exited".into(),
                )),
                Err(error) => Err(error),
                Ok(None) => unreachable!(),
            };
        }
    }
    let (result, runtime, state_revision, cwd) = {
        let mut core = state.core.lock().await;
        let cwd = core.session_cwd(&session_id);
        let (result, runtime) = core.terminate_session(params)?;
        (result, runtime, core.state_revision(), cwd)
    };
    if let Some(runtime) = runtime {
        // The descriptor is already exited and the core lock is released, but
        // an immediate explicit resume must not race the retired provider's
        // session-scoped ownership record. Reap outside the core lock and wait
        // for that bounded ownership handoff before acknowledging terminate.
        tokio::task::spawn_blocking(move || runtime.reap())
            .await
            .map_err(|error| CoreError::Terminal(error.to_string()))?
            .map_err(|_| {
                CoreError::Terminal(
                    "terminated Session runtime ownership could not be released".into(),
                )
            })?;
    }
    if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
        capabilities.revoke_session(&session_id);
    }
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        // Exiting a assistant atomically clears its current
        // Steward/Worker pointer in Store. Publish every projection changed
        // by that commit rather than leaving the Project panel stale until an
        // unrelated refresh.
        topics: vec![
            ProjectionTopic::Session,
            ProjectionTopic::Steward,
            ProjectionTopic::Worker,
            ProjectionTopic::Routine,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
    if let Some(cwd) = cwd {
        refresh_task_presence_for_cwd(state, &cwd).await;
    }
    Ok(result)
}

pub(in crate::app::control) async fn resume_agent_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    run_agent_resume_session(
        params,
        state,
        None,
        false,
        true,
        "manualRetry",
        Instant::now() + AGENT_RESUME_ATTEMPT_TIMEOUT,
    )
    .await
}

pub(in crate::app::control) async fn restart_agent_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    run_agent_resume_session(
        params,
        state,
        None,
        true,
        false,
        "manualRefresh",
        Instant::now() + AGENT_RESUME_ATTEMPT_TIMEOUT,
    )
    .await
}

pub(in crate::app::control) async fn preview_resume_agent_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state.core.lock().await.preview_agent_resume(params)
}

pub(in crate::app::control) async fn preview_relocate_agent_session(
    params: serde_json::Value,
    deadline: Instant,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let outcome = state
        .core
        .lock()
        .await
        .plan_session_relocation_preview(params)?;
    let termloop_core::SessionRelocationPreviewOutcome::Observe(plan) = outcome else {
        let termloop_core::SessionRelocationPreviewOutcome::Current(value) = outcome else {
            unreachable!("relocation preview has only current or observation outcomes")
        };
        return Ok(value);
    };
    let task_id = plan.task_id().to_owned();
    let project_id = plan.project_id().to_owned();
    let permit = state
        .git_observation_gate
        .acquire_until(&project_id, ObservationPriority::Explicit, deadline)
        .await
        .map_err(|_| task_launch_timeout(&task_id))?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| task_launch_timeout(&task_id))?;
    let observed = tokio::task::spawn_blocking(move || plan.observe(remaining))
        .await
        .map_err(|error| CoreError::Store(format!("relocation observation failed: {error}")))?;
    drop(permit);
    state
        .core
        .lock()
        .await
        .complete_session_relocation_preview(observed)
}

pub(in crate::app::control) async fn preview_relocate_agent_to_project(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    state
        .core
        .lock()
        .await
        .preview_session_relocation_to_project(params)
}

pub(in crate::app::control) async fn relocate_agent_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    run_agent_resume_session(
        params,
        state,
        None,
        false,
        false,
        "relocation",
        Instant::now() + AGENT_RELOCATION_ATTEMPT_TIMEOUT,
    )
    .await
}

async fn run_agent_resume_session(
    params: serde_json::Value,
    state: &AppState,
    preacquired_permit: Option<FairResumePermit>,
    restart_running: bool,
    ticketed: bool,
    trigger: &'static str,
    attempt_deadline: Instant,
) -> Result<serde_json::Value, CoreError> {
    let session_id_param = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("sessionId".into()))?
        .to_owned();
    record_resume_cycle(state, &session_id_param, trigger, "request", None, None);
    let requires_ownership_recovery = !restart_running
        && state
            .core
            .lock()
            .await
            .session_resume_failure(&session_id_param)
            .is_some_and(|failure| {
                matches!(
                    failure,
                    termloop_core::ResumeFailureReason::RuntimeOwnershipUncertain
                        | termloop_core::ResumeFailureReason::RuntimeConflict
                )
            });
    if requires_ownership_recovery {
        record_resume_cycle(
            state,
            &session_id_param,
            trigger,
            "ownershipRecoveryStarted",
            None,
            None,
        );
        let retired_codex_runtime = state
            .core
            .lock()
            .await
            .detach_agent_runtime_for_ownership_recovery(&session_id_param);
        let recovery_failure =
            recover_agent_runtime_ownership(state, &session_id_param, retired_codex_runtime)
                .await?;
        if let Some(detail) = recovery_failure {
            record_resume_cycle(
                state,
                &session_id_param,
                trigger,
                "ownershipRecoveryFailed",
                Some(detail),
                None,
            );
            let value = state
                .core
                .lock()
                .await
                .mark_agent_resume_ownership_uncertain(&session_id_param)?;
            publish_agent_resume_invalidation(state, &session_id_param).await;
            return Ok(value);
        }
        record_resume_cycle(
            state,
            &session_id_param,
            trigger,
            "ownershipRecoveryComplete",
            None,
            None,
        );
    }
    let client_restart_observed_at_epoch_ms =
        restart_running.then(termloop_platform::current_epoch_ms);
    let (outcome, plan_changed_state, latest_observation_sequence) = {
        let mut core = state.core.lock().await;
        let previous_revision = core.state_revision();
        let outcome = if restart_running {
            core.plan_running_agent_restart(
                params,
                client_restart_observed_at_epoch_ms
                    .expect("running restart has an observation timestamp"),
            )?
        } else if trigger == "daemonStartup" {
            core.plan_daemon_restart_agent_resume(params, termloop_platform::current_epoch_ms())?
        } else if trigger == "relocation" {
            core.plan_ticketed_agent_relocation(params)?
        } else if ticketed {
            core.plan_ticketed_agent_resume(params)?
        } else {
            core.plan_agent_resume(params)?
        };
        (
            outcome,
            core.state_revision() != previous_revision,
            core.observation_sequence(),
        )
    };
    state
        .observation_sequence
        .fetch_max(latest_observation_sequence, Ordering::Relaxed);
    let mut plan = match outcome {
        termloop_core::AgentResumePlanOutcome::Current(value) => {
            record_resume_cycle_from_projection(
                state,
                &session_id_param,
                trigger,
                "notPrepared",
                &value,
            );
            if plan_changed_state {
                publish_agent_resume_invalidation(state, &session_id_param).await;
            }
            return Ok(value);
        }
        termloop_core::AgentResumePlanOutcome::Prepare(plan) => *plan,
    };
    let session_id = plan.session_id().to_owned();
    let project_id = plan.project_id().to_owned();
    let relocation_source_cwd = plan.relocation_cwds().map(|(source, _)| source.to_owned());
    record_resume_cycle(
        state,
        &session_id,
        trigger,
        "planned",
        Some(plan.agent_id()),
        Some(plan.runtime_epoch()),
    );
    let attempt_cancellation = plan.cancellation();
    if plan_changed_state {
        publish_agent_resume_invalidation(state, &session_id_param).await;
    }
    // Automatic recovery and explicit Retry share one preparation budget. A
    // repeated request sees the reservation above and returns current state;
    // it never waits behind or duplicates the original attempt.
    let mut shutdown = state.resume_shutdown.clone();
    let gate_result = if let Some(permit) = preacquired_permit {
        Ok(permit)
    } else {
        tokio::select! {
            result = tokio::time::timeout_at(
                attempt_deadline,
                state
                    .agent_resume_gates
                    .for_lane(plan.resume_lane())
                    .acquire(project_id),
            ) => match result {
                Ok(result) => result,
                Err(_) => Err(ResumeGateError::TimedOut),
            },
            _ = shutdown.changed() => Err(ResumeGateError::Stopped),
        }
    };
    let _resume_permit = match gate_result {
        Ok(permit) => permit,
        Err(ResumeGateError::Full) => {
            record_resume_cycle(
                state,
                &session_id,
                trigger,
                "admissionFailed",
                Some("queueFull"),
                None,
            );
            let value = fail_agent_resume_attempt(
                state,
                &session_id,
                termloop_core::ResumeFailureReason::ResumeQueueFull,
                plan,
            )
            .await?;
            publish_agent_resume_invalidation(state, &session_id_param).await;
            return Ok(value);
        }
        Err(ResumeGateError::TimedOut) => {
            record_resume_cycle(
                state,
                &session_id,
                trigger,
                "admissionFailed",
                Some("timedOut"),
                None,
            );
            attempt_cancellation.store(true, Ordering::Release);
            let value = fail_agent_resume_attempt(
                state,
                &session_id,
                termloop_core::ResumeFailureReason::StartupTimedOut,
                plan,
            )
            .await?;
            publish_agent_resume_invalidation(state, &session_id_param).await;
            return Ok(value);
        }
        Err(ResumeGateError::Stopped) => {
            record_resume_cycle(
                state,
                &session_id,
                trigger,
                "cancelled",
                Some("shutdown"),
                None,
            );
            attempt_cancellation.store(true, Ordering::Release);
            let value = state
                .core
                .lock()
                .await
                .cancel_agent_resume_for_shutdown(&session_id)?;
            reap_agent_resume_plan(plan).await;
            return Ok(value);
        }
    };
    record_resume_cycle(
        state,
        &session_id,
        trigger,
        "admitted",
        None,
        Some(plan.runtime_epoch()),
    );
    record_resume_cycle(
        state,
        &session_id,
        trigger,
        "preparationStarted",
        None,
        Some(plan.runtime_epoch()),
    );
    let mut preparation_worker = tokio::task::spawn_blocking(move || {
        let result = plan.prepare_runtime();
        (plan, result)
    });
    let prepared = tokio::select! {
        result = tokio::time::timeout_at(attempt_deadline, &mut preparation_worker) => Some(result),
        _ = shutdown.changed() => None,
    };
    let Some(prepared) = prepared else {
        attempt_cancellation.store(true, Ordering::Release);
        return match tokio::time::timeout(AGENT_RESUME_SHUTDOWN_TIMEOUT, &mut preparation_worker)
            .await
        {
            Ok(Ok((cancelled_plan, _))) => {
                record_resume_cycle(
                    state,
                    &session_id,
                    trigger,
                    "cancelled",
                    Some("shutdown"),
                    None,
                );
                reap_agent_resume_plan(cancelled_plan).await;
                state
                    .core
                    .lock()
                    .await
                    .cancel_agent_resume_for_shutdown(&session_id)
            }
            Ok(Err(_)) => state
                .core
                .lock()
                .await
                .mark_agent_resume_ownership_uncertain(&session_id),
            Err(_) => state.core.lock().await.current_agent_resume(&session_id),
        };
    };
    let (mut plan, preparation) = match prepared {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            record_resume_cycle(
                state,
                &session_id,
                trigger,
                "preparationFailed",
                Some("workerJoin"),
                None,
            );
            let value = state
                .core
                .lock()
                .await
                .mark_agent_resume_ownership_uncertain(&session_id)?;
            publish_agent_resume_invalidation(state, &session_id_param).await;
            return Ok(value);
        }
        Err(_) => {
            attempt_cancellation.store(true, Ordering::Release);
            match tokio::time::timeout(AGENT_RESUME_SHUTDOWN_TIMEOUT, &mut preparation_worker).await
            {
                Ok(Ok((timed_out_plan, _))) => {
                    record_resume_cycle(
                        state,
                        &session_id,
                        trigger,
                        "preparationFailed",
                        Some("timedOut"),
                        None,
                    );
                    let value = fail_agent_resume_attempt(
                        state,
                        &session_id,
                        termloop_core::ResumeFailureReason::StartupTimedOut,
                        timed_out_plan,
                    )
                    .await?;
                    publish_agent_resume_invalidation(state, &session_id_param).await;
                    return Ok(value);
                }
                Ok(Err(_)) => {
                    record_resume_cycle(
                        state,
                        &session_id,
                        trigger,
                        "preparationFailed",
                        Some("workerJoin"),
                        None,
                    );
                    let value = state
                        .core
                        .lock()
                        .await
                        .mark_agent_resume_ownership_uncertain(&session_id)?;
                    publish_agent_resume_invalidation(state, &session_id_param).await;
                    return Ok(value);
                }
                Err(_) => {
                    record_resume_cycle(
                        state,
                        &session_id,
                        trigger,
                        "preparationCleanupDeferred",
                        None,
                        None,
                    );
                    // The blocking worker cannot be aborted safely. Keep its
                    // reservation non-admittable, return the current resuming
                    // projection, and let one coordinator-owned continuation
                    // reap it and publish the final retryable state.
                    let cleanup_state = state.clone();
                    let cleanup_session_id = session_id.clone();
                    let cleanup_invalidation_id = session_id_param.clone();
                    let cleanup_trigger = trigger;
                    tokio::spawn(async move {
                        let result = match preparation_worker.await {
                            Ok((timed_out_plan, _)) => {
                                fail_agent_resume_attempt(
                                    &cleanup_state,
                                    &cleanup_session_id,
                                    termloop_core::ResumeFailureReason::StartupTimedOut,
                                    timed_out_plan,
                                )
                                .await
                            }
                            Err(_) => cleanup_state
                                .core
                                .lock()
                                .await
                                .mark_agent_resume_ownership_uncertain(&cleanup_session_id),
                        };
                        if result.is_ok() {
                            record_resume_cycle(
                                &cleanup_state,
                                &cleanup_session_id,
                                cleanup_trigger,
                                "preparationCleanupComplete",
                                None,
                                None,
                            );
                            publish_agent_resume_invalidation(
                                &cleanup_state,
                                &cleanup_invalidation_id,
                            )
                            .await;
                        }
                    });
                    return state.core.lock().await.current_agent_resume(&session_id);
                }
            }
        }
    };
    if let Err(error) = preparation {
        let reason = match error {
            termloop_core::AgentResumePreparationError::RuntimeConflict => {
                termloop_core::ResumeFailureReason::RuntimeConflict
            }
            termloop_core::AgentResumePreparationError::PtySpawnFailed => {
                termloop_core::ResumeFailureReason::PtySpawnFailed
            }
            termloop_core::AgentResumePreparationError::TargetUnavailable => {
                termloop_core::ResumeFailureReason::CwdUnavailable
            }
            termloop_core::AgentResumePreparationError::ProviderRejected => {
                termloop_core::ResumeFailureReason::ResumeRejected
            }
            termloop_core::AgentResumePreparationError::ProviderHistoryDamaged => {
                termloop_core::ResumeFailureReason::ProviderHistoryDamaged
            }
            termloop_core::AgentResumePreparationError::DaemonInterrupted => {
                termloop_core::ResumeFailureReason::DaemonInterrupted
            }
            termloop_core::AgentResumePreparationError::RuntimeOwnershipUncertain => {
                termloop_core::ResumeFailureReason::RuntimeOwnershipUncertain
            }
        };
        record_resume_cycle(
            state,
            &session_id,
            trigger,
            "preparationFailed",
            Some(resume_failure_diagnostic(reason)),
            Some(plan.runtime_epoch()),
        );
        let value = fail_agent_resume_attempt(state, &session_id, reason, plan).await?;
        publish_agent_resume_invalidation(state, &session_id_param).await;
        return Ok(value);
    }
    let relocation_target_start = if plan.is_relocation() {
        let mut core = state.core.lock().await;
        Some(core.mark_agent_relocation_target_starting(&plan))
    } else {
        None
    };
    if let Some(Err(error)) = relocation_target_start {
        record_resume_cycle(
            state,
            &session_id,
            trigger,
            "targetStartingFailed",
            Some("durableGuard"),
            Some(plan.runtime_epoch()),
        );
        tracing::warn!(%error, session_id = %session_id, "relocation target start guard failed");
        let value = fail_agent_resume_attempt(
            state,
            &session_id,
            termloop_core::ResumeFailureReason::CwdUnavailable,
            plan,
        )
        .await?;
        publish_agent_resume_invalidation(state, &session_id_param).await;
        return Ok(value);
    }
    record_resume_cycle(
        state,
        &session_id,
        trigger,
        "preparationComplete",
        None,
        Some(plan.runtime_epoch()),
    );
    // Planning publishes `resuming` before blocking provider preparation, so
    // an eager desktop attach can race the PTY spawn. Publish the same Session
    // projection again now that the provisional runtime is attachable. Its
    // projected epoch is owned by Core's exact resume reservation.
    publish_session_invalidation(state).await;
    let resume_runtime_epoch = plan.runtime_epoch();
    // Daemon-start recovery often reaches provider startup before any desktop
    // surface attaches. Keep a bounded observer on the replay+live stream so
    // an interactive TUI cannot block before readiness on an unanswered DSR.
    let mut startup_terminal = state
        .terminal
        .subscribe(&session_id, resume_runtime_epoch)
        .ok();
    let mut cursor_query_tail = VecDeque::with_capacity(4);
    let readiness = tokio::time::timeout_at(attempt_deadline, async {
        loop {
            // Drop the Core guard before sleeping. A guard created in a
            // `match` scrutinee otherwise lives through the selected arm and
            // can stall the entire control plane for every poll interval.
            let readiness = {
                let core = state.core.lock().await;
                core.agent_resume_readiness(&session_id)
            };
            let runtime_running = readiness
                .is_some_and(|ready| !ready)
                .then(|| {
                    state
                        .terminal
                        .session_is_running(&session_id, resume_runtime_epoch)
                        .ok()
                })
                .flatten();
            match agent_resume_startup_poll(readiness, runtime_running) {
                AgentResumeStartupPoll::Ready => return AgentResumeReadiness::Ready,
                AgentResumeStartupPoll::ProcessExited => {
                    return AgentResumeReadiness::ProcessExited;
                }
                AgentResumeStartupPoll::ReservationMissing => {
                    return AgentResumeReadiness::ReservationMissing;
                }
                AgentResumeStartupPoll::Waiting => {
                    if let Some(terminal) = startup_terminal.as_mut() {
                        if pump_startup_terminal(
                            &state.terminal,
                            terminal,
                            &session_id,
                            &mut cursor_query_tail,
                            Duration::from_millis(20),
                        )
                        .await
                            == StartupTerminalPump::Exited
                        {
                            return AgentResumeReadiness::ProcessExited;
                        }
                    } else {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        }
    });
    tokio::pin!(readiness);
    let readiness = tokio::select! {
        result = &mut readiness => result.unwrap_or(AgentResumeReadiness::TimedOut),
        _ = shutdown.changed() => {
            attempt_cancellation.store(true, Ordering::Release);
            let value = state
                .core
                .lock()
                .await
                .cancel_agent_resume_for_shutdown(&session_id)?;
            reap_agent_resume_plan(plan).await;
            return Ok(value);
        }
    };
    if readiness != AgentResumeReadiness::Ready {
        let reason = if readiness == AgentResumeReadiness::ProcessExited {
            termloop_core::ResumeFailureReason::ResumeRejected
        } else {
            termloop_core::ResumeFailureReason::StartupTimedOut
        };
        record_resume_cycle(
            state,
            &session_id,
            trigger,
            "readinessFailed",
            Some(resume_failure_diagnostic(reason)),
            Some(plan.runtime_epoch()),
        );
        let value = fail_agent_resume_attempt(state, &session_id, reason, plan).await?;
        publish_agent_resume_invalidation(state, &session_id_param).await;
        return Ok(value);
    }
    record_resume_cycle(
        state,
        &session_id,
        trigger,
        "readinessObserved",
        None,
        Some(plan.runtime_epoch()),
    );
    // Provider readiness can precede a rejected resume process exiting. Keep
    // the reservation until the exact PTY generation survives a short bounded
    // stability window, so the exit reconciler records a retryable resume
    // failure instead of committing `running` and immediately retiring it as
    // an ordinary same-daemon exit.
    if attempt_deadline.saturating_duration_since(Instant::now()) < AGENT_RESUME_STABILITY_WINDOW {
        let value = fail_agent_resume_attempt(
            state,
            &session_id,
            termloop_core::ResumeFailureReason::StartupTimedOut,
            plan,
        )
        .await?;
        publish_agent_resume_invalidation(state, &session_id_param).await;
        return Ok(value);
    }
    tokio::select! {
        _ = tokio::time::sleep(AGENT_RESUME_STABILITY_WINDOW) => {}
        _ = shutdown.changed() => {
            attempt_cancellation.store(true, Ordering::Release);
            let value = state
                .core
                .lock()
                .await
                .cancel_agent_resume_for_shutdown(&session_id)?;
            reap_agent_resume_plan(plan).await;
            return Ok(value);
        }
    }
    let finalization_deadline = Instant::now() + AGENT_RESUME_FINALIZATION_TIMEOUT;
    let terminal = state.terminal.clone();
    let liveness_session_id = session_id.clone();
    let liveness_epoch = plan.runtime_epoch();
    let liveness = tokio::time::timeout_at(
        finalization_deadline,
        tokio::task::spawn_blocking(move || {
            terminal.session_is_running(&liveness_session_id, liveness_epoch)
        }),
    )
    .await;
    let stability_failure = match liveness {
        Ok(Ok(Ok(true))) => None,
        Ok(Ok(Ok(false))) => Some(termloop_core::ResumeFailureReason::ResumeRejected),
        Ok(Ok(Err(_))) | Ok(Err(_)) | Err(_) => {
            Some(termloop_core::ResumeFailureReason::RuntimeOwnershipUncertain)
        }
    };
    if let Some(reason) = stability_failure {
        record_resume_cycle(
            state,
            &session_id,
            trigger,
            "stabilityFailed",
            Some(resume_failure_diagnostic(reason)),
            Some(plan.runtime_epoch()),
        );
        let value = fail_agent_resume_attempt(state, &session_id, reason, plan).await?;
        publish_agent_resume_invalidation(state, &session_id_param).await;
        return Ok(value);
    }
    record_resume_cycle(
        state,
        &session_id,
        trigger,
        "stabilityConfirmed",
        None,
        Some(plan.runtime_epoch()),
    );
    let target_validation = plan.target_validation();
    let target_valid = tokio::time::timeout_at(
        finalization_deadline,
        tokio::task::spawn_blocking(move || target_validation.validate()),
    )
    .await;
    if !matches!(target_valid, Ok(Ok(Ok(())))) {
        record_resume_cycle(
            state,
            &session_id,
            trigger,
            "targetRevalidationFailed",
            None,
            Some(plan.runtime_epoch()),
        );
        let value = fail_agent_resume_attempt(
            state,
            &session_id,
            termloop_core::ResumeFailureReason::CwdUnavailable,
            plan,
        )
        .await?;
        publish_agent_resume_invalidation(state, &session_id_param).await;
        return Ok(value);
    }
    let result = {
        let Ok(mut core) = tokio::time::timeout_at(finalization_deadline, state.core.lock()).await
        else {
            record_resume_cycle(
                state,
                &session_id,
                trigger,
                "commitFailed",
                Some("coreBusy"),
                Some(plan.runtime_epoch()),
            );
            let value = fail_agent_resume_attempt(
                state,
                &session_id,
                termloop_core::ResumeFailureReason::DaemonInterrupted,
                plan,
            )
            .await?;
            publish_agent_resume_invalidation(state, &session_id_param).await;
            return Ok(value);
        };
        core.complete_agent_resume(&mut plan)
    };
    reap_agent_resume_plan(plan).await;
    let value = match result {
        Ok(value) => {
            record_resume_cycle_from_projection(state, &session_id, trigger, "committed", &value);
            value
        }
        Err(_) => {
            record_resume_cycle(state, &session_id, trigger, "commitFailed", None, None);
            let mut core = state.core.lock().await;
            core.fail_agent_resume(
                &session_id,
                termloop_core::ResumeFailureReason::DaemonInterrupted,
            )?
        }
    };
    publish_agent_resume_invalidation(state, &session_id_param).await;
    if let Some(source_cwd) = relocation_source_cwd {
        refresh_task_presence_for_cwd(state, &source_cwd).await;
    }
    Ok(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentResumeReadiness {
    Ready,
    ProcessExited,
    ReservationMissing,
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentResumeStartupPoll {
    Ready,
    Waiting,
    ProcessExited,
    ReservationMissing,
}

fn agent_resume_startup_poll(
    readiness: Option<bool>,
    runtime_running: Option<bool>,
) -> AgentResumeStartupPoll {
    match readiness {
        Some(true) => AgentResumeStartupPoll::Ready,
        Some(false) if runtime_running == Some(false) => AgentResumeStartupPoll::ProcessExited,
        Some(false) => AgentResumeStartupPoll::Waiting,
        None => AgentResumeStartupPoll::ReservationMissing,
    }
}

async fn reap_agent_resume_plan(mut plan: termloop_core::AgentResumePlan) -> bool {
    tokio::task::spawn_blocking(move || plan.reap_uncommitted_runtime().is_ok())
        .await
        .unwrap_or(false)
}

async fn wait_for_agent_fork_startup(
    state: &AppState,
    session_id: &str,
    runtime_epoch: u64,
    deadline: Instant,
    stability_window: Duration,
) -> Result<(), termloop_core::AgentForkUnavailableReason> {
    let mut terminal = state
        .terminal
        .subscribe(session_id, runtime_epoch)
        .map_err(|_| termloop_core::AgentForkUnavailableReason::RuntimeConflict)?;
    // The fork request intentionally remains unpublished until the provider
    // confirms a child conversation, so no desktop terminal is attached yet.
    // Answer the one startup DSR that interactive TUIs use to locate the
    // cursor; otherwise a headless fork can exit before reaching App Server.
    let mut cursor_query_tail = VecDeque::with_capacity(4);
    loop {
        let readiness = state
            .core
            .lock()
            .await
            .agent_fork_readiness(session_id, runtime_epoch);
        match readiness {
            Ok(true) => break,
            Ok(false) => {}
            Err(reason) => return Err(reason),
        }
        match state.terminal.session_is_running(session_id, runtime_epoch) {
            Ok(true) => {}
            Ok(false) => {
                return Err(termloop_core::AgentForkUnavailableReason::StartupExited);
            }
            Err(_) => return Err(termloop_core::AgentForkUnavailableReason::RuntimeConflict),
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(termloop_core::AgentForkUnavailableReason::StartupTimedOut);
        };
        let poll_interval = Duration::from_millis(20).min(remaining);
        if pump_startup_terminal(
            &state.terminal,
            &mut terminal,
            session_id,
            &mut cursor_query_tail,
            poll_interval,
        )
        .await
            == StartupTerminalPump::Exited
        {
            return Err(termloop_core::AgentForkUnavailableReason::StartupExited);
        }
    }

    if deadline.saturating_duration_since(Instant::now()) < stability_window {
        return Err(termloop_core::AgentForkUnavailableReason::StartupTimedOut);
    }
    tokio::time::sleep(stability_window).await;
    match state.terminal.session_is_running(session_id, runtime_epoch) {
        Ok(true) => Ok(()),
        Ok(false) => Err(termloop_core::AgentForkUnavailableReason::StartupExited),
        Err(_) => Err(termloop_core::AgentForkUnavailableReason::RuntimeConflict),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupTerminalPump {
    Alive,
    CursorPositionAnswered,
    Exited,
}

async fn pump_startup_terminal(
    terminal_service: &TerminalService,
    terminal: &mut termloop_terminal::TerminalSubscription,
    session_id: &str,
    cursor_query_tail: &mut VecDeque<u8>,
    poll_interval: Duration,
) -> StartupTerminalPump {
    match tokio::time::timeout(poll_interval, terminal.recv()).await {
        Ok(Ok(termloop_terminal::TerminalEvent::Output(bytes))) => {
            if !contains_cursor_position_query(cursor_query_tail, &bytes) {
                StartupTerminalPump::Alive
            } else if terminal_service
                .input(
                    session_id,
                    termloop_terminal::HEADLESS_CURSOR_POSITION_REPORT,
                )
                .is_ok()
            {
                StartupTerminalPump::CursorPositionAnswered
            } else {
                StartupTerminalPump::Exited
            }
        }
        Ok(Ok(termloop_terminal::TerminalEvent::Gap(_)))
        | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
            cursor_query_tail.clear();
            StartupTerminalPump::Alive
        }
        Ok(Ok(termloop_terminal::TerminalEvent::Eof))
        | Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => StartupTerminalPump::Exited,
        Err(_) => StartupTerminalPump::Alive,
    }
}

fn contains_cursor_position_query(tail: &mut VecDeque<u8>, bytes: &[u8]) -> bool {
    const QUERY: &[u8] = b"\x1b[6n";
    let mut found = false;
    for byte in bytes {
        tail.push_back(*byte);
        if tail.len() > QUERY.len() {
            tail.pop_front();
        }
        if tail.len() == QUERY.len() && tail.iter().copied().eq(QUERY.iter().copied()) {
            found = true;
            tail.clear();
        }
    }
    found
}

async fn rollback_failed_agent_fork(
    state: &AppState,
    session_id: &str,
    runtime_epoch: u64,
) -> bool {
    let retired_codex_runtime = match state
        .core
        .lock()
        .await
        .retire_failed_agent_fork(session_id, runtime_epoch)
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::warn!(
                %error,
                session_id,
                runtime_epoch,
                "failed fork rollback could not retire its child descriptor"
            );
            return false;
        }
    };
    let terminal = state.terminal.clone();
    let terminal_session_id = session_id.to_owned();
    let ownership_absent = tokio::task::spawn_blocking(move || {
        reap_in_memory_agent_runtime(terminal, terminal_session_id, retired_codex_runtime)
    })
    .await
    .unwrap_or(false);
    if !ownership_absent {
        tracing::warn!(
            session_id,
            runtime_epoch,
            "failed fork rollback could not prove child runtime absence"
        );
        return false;
    }
    let deleted = state
        .core
        .lock()
        .await
        .delete_failed_agent_fork_descriptor(session_id, runtime_epoch)
        .is_ok();
    if !deleted {
        tracing::warn!(
            session_id,
            runtime_epoch,
            "failed fork rollback could not delete its retired child descriptor"
        );
    }
    deleted
}

async fn retain_failed_agent_fork(state: &AppState, session_id: &str, runtime_epoch: u64) -> bool {
    let terminal = state.terminal.clone();
    let terminal_session_id = session_id.to_owned();
    let output_retained = tokio::task::spawn_blocking(move || {
        terminal
            .terminate_and_retain_output(&terminal_session_id)
            .is_ok()
    })
    .await
    .unwrap_or(false);
    if !output_retained {
        tracing::warn!(
            session_id,
            runtime_epoch,
            "failed fork could not retain its terminal output"
        );
        return false;
    }
    let retired_codex_runtime = match state
        .core
        .lock()
        .await
        .retain_failed_agent_fork(session_id, runtime_epoch)
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::warn!(
                %error,
                session_id,
                runtime_epoch,
                "failed fork could not retain its exited child for inspection"
            );
            return false;
        }
    };
    tokio::task::spawn_blocking(move || drop(retired_codex_runtime));
    true
}

async fn fail_agent_resume_attempt(
    state: &AppState,
    session_id: &str,
    reason: termloop_core::ResumeFailureReason,
    plan: termloop_core::AgentResumePlan,
) -> Result<serde_json::Value, CoreError> {
    // Keep the in-memory reservation until the prepared/retired runtime has
    // been reaped. Otherwise a concurrent Retry can observe the durable
    // failure and race the previous attempt's PTY registry cleanup.
    state
        .core
        .lock()
        .await
        .begin_agent_resume_failure_reap(session_id)?;
    let ownership_absent = reap_agent_resume_plan(plan).await;
    let reason = if ownership_absent {
        reason
    } else {
        termloop_core::ResumeFailureReason::RuntimeOwnershipUncertain
    };
    state
        .core
        .lock()
        .await
        .fail_agent_resume(session_id, reason)
}

fn record_resume_cycle(
    state: &AppState,
    session_id: &str,
    trigger: &'static str,
    phase: &'static str,
    detail: Option<&str>,
    runtime_epoch: Option<u64>,
) {
    let line = json!({
        "timestampMs": termloop_platform::current_epoch_ms(),
        "sessionId": session_id,
        "trigger": trigger,
        "phase": phase,
        "detail": detail,
        "runtimeEpoch": runtime_epoch,
    })
    .to_string();
    if state.resume_diagnostics.append_line(&line).is_err() {
        tracing::warn!("agent resume diagnostic log write failed");
    }
    tracing::info!(
        session_id,
        trigger,
        phase,
        detail,
        runtime_epoch,
        "agent resume cycle"
    );
}

fn record_resume_cycle_from_projection(
    state: &AppState,
    session_id: &str,
    trigger: &'static str,
    phase: &'static str,
    projection: &serde_json::Value,
) {
    let lifecycle = projection
        .get("lifecycle_state")
        .and_then(serde_json::Value::as_str);
    let failure = projection
        .get("resume_failure_reason")
        .and_then(serde_json::Value::as_str);
    let detail = match (lifecycle, failure) {
        (Some(lifecycle), Some(failure)) => Some(format!("{lifecycle}:{failure}")),
        (Some(lifecycle), None) => Some(lifecycle.to_owned()),
        _ => None,
    };
    record_resume_cycle(
        state,
        session_id,
        trigger,
        phase,
        detail.as_deref(),
        projection
            .get("runtime_epoch")
            .and_then(serde_json::Value::as_u64),
    );
}

fn resume_failure_diagnostic(reason: termloop_core::ResumeFailureReason) -> &'static str {
    match reason {
        termloop_core::ResumeFailureReason::ResumeRefMissing => "resumeRefMissing",
        termloop_core::ResumeFailureReason::InvalidResumeRef => "invalidResumeRef",
        termloop_core::ResumeFailureReason::ResumeCapabilityUnavailable => {
            "resumeCapabilityUnavailable"
        }
        termloop_core::ResumeFailureReason::RuntimeOwnershipUncertain => {
            "runtimeOwnershipUncertain"
        }
        termloop_core::ResumeFailureReason::ProviderSessionUnavailable => {
            "providerSessionUnavailable"
        }
        termloop_core::ResumeFailureReason::ProviderHistoryDamaged => "providerHistoryDamaged",
        termloop_core::ResumeFailureReason::ResumeRejected => "resumeRejected",
        termloop_core::ResumeFailureReason::ProviderMismatch => "providerMismatch",
        termloop_core::ResumeFailureReason::StartupTimedOut => "startupTimedOut",
        termloop_core::ResumeFailureReason::DaemonInterrupted => "daemonInterrupted",
        termloop_core::ResumeFailureReason::ResumeQueueFull => "resumeQueueFull",
        termloop_core::ResumeFailureReason::PtySpawnFailed => "ptySpawnFailed",
        termloop_core::ResumeFailureReason::CwdUnavailable => "cwdUnavailable",
        termloop_core::ResumeFailureReason::LaunchReserved => "launchReserved",
        termloop_core::ResumeFailureReason::RuntimeConflict => "runtimeConflict",
    }
}

fn reap_in_memory_agent_runtime(
    terminal: TerminalService,
    session_id: String,
    retired_codex_runtime: Option<termloop_core::CodexRuntime>,
) -> bool {
    let provider_reaped = retired_codex_runtime
        .map(termloop_core::CodexRuntime::reap)
        .transpose()
        .is_ok();
    let terminal_reaped = match terminal.contains_session(&session_id) {
        Ok(true) => terminal.terminate(&session_id).is_ok(),
        Ok(false) => true,
        Err(_) => false,
    };
    provider_reaped && terminal_reaped
}

async fn recover_agent_runtime_ownership(
    state: &AppState,
    session_id: &str,
    retired_codex_runtime: Option<termloop_core::CodexRuntime>,
) -> Result<Option<&'static str>, CoreError> {
    let terminal = state.terminal.clone();
    let terminal_session_id = session_id.to_owned();
    let in_memory_runtime_reaped = tokio::task::spawn_blocking(move || {
        reap_in_memory_agent_runtime(terminal, terminal_session_id, retired_codex_runtime)
    })
    .await
    .unwrap_or(false);
    if !in_memory_runtime_reaped {
        return Ok(Some("inMemoryRuntime"));
    }

    let provider_directory = state.provider_process_directory.clone();
    let pty_directory = state.pty_process_directory.clone();
    let recovery_session_id = session_id.to_owned();
    let recovery = tokio::task::spawn_blocking(move || {
        [provider_directory, pty_directory]
            .into_iter()
            .map(|directory| {
                termloop_platform::recover_tracked_managed_process(
                    directory.as_ref(),
                    &recovery_session_id,
                )
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| CoreError::Terminal("runtime ownership recovery was interrupted".into()))?;
    let ownership_proven_absent = recovery.is_ok_and(|reports| {
        reports.iter().all(|report| {
            report.failures == 0
                && report.uncertain_record_ids.is_empty()
                && report.unscoped_failures == 0
        })
    });
    Ok((!ownership_proven_absent).then_some("trackedProcess"))
}

pub(in crate::app::control) async fn close_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let result = {
        let mut core = state.core.lock().await;
        core.close_session(params)?
    };
    publish_session_invalidation(state).await;
    Ok(result)
}

pub(in crate::app::control) async fn list_deleted_sessions(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let plan = state.core.lock().await.plan_deleted_session_list(params)?;
    tokio::task::spawn_blocking(move || plan.observe())
        .await
        .map_err(|error| CoreError::Store(format!("Deleted Agent inspection failed: {error}")))
}

pub(in crate::app::control) async fn restore_deleted_session(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let (plan, terminal) = {
        let mut core = state.core.lock().await;
        (
            core.plan_deleted_session_restore(params)?,
            core.terminal_service(),
        )
    };
    let session_id = plan.session_id().to_owned();
    let observe_terminal = terminal.clone();
    let observed = match tokio::task::spawn_blocking(move || plan.observe(observe_terminal)).await {
        Ok(result) => result?,
        Err(error) => {
            let _ = terminal.terminate(&session_id);
            return Err(CoreError::Terminal(format!(
                "Deleted Agent restoration was interrupted: {error}"
            )));
        }
    };
    let result = state
        .core
        .lock()
        .await
        .apply_deleted_session_restore(observed);
    if result.is_err() {
        let cleanup_terminal = terminal.clone();
        let cleanup_session_id = session_id.clone();
        let _ =
            tokio::task::spawn_blocking(move || cleanup_terminal.terminate(&cleanup_session_id))
                .await;
    } else {
        publish_session_invalidation(state).await;
    }
    result
}

pub(in crate::app::control) async fn restart_agents_for_client_launch(
    params: serde_json::Value,
    state: &AppState,
) -> Result<serde_json::Value, CoreError> {
    let client_launch_id = params
        .get("clientLaunchId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidParams("clientLaunchId".into()))?
        .to_owned();
    let candidates = state.core.lock().await.client_launch_restart_snapshot()?;
    let (already_accepted, candidate_count) = state
        .client_launch_restarts
        .lock()
        .map_err(|_| CoreError::Store("client launch registry was poisoned".into()))?
        .accept(client_launch_id, candidates.len());
    if !already_accepted {
        let state = state.clone();
        tokio::spawn(run_client_launch_restarts(state, candidates));
    }
    Ok(json!({
        "alreadyAccepted": already_accepted,
        "candidateCount": candidate_count,
    }))
}

async fn run_client_launch_restarts(
    state: AppState,
    candidates: Vec<termloop_core::AgentResumeCandidate>,
) {
    run_automatic_resume_lanes(state, candidates, true, "clientLaunch").await;
}

pub(in crate::app) async fn reconcile_agent_resumes_after_start(state: AppState) {
    let candidates = match state.core.lock().await.startup_resume_session_ids() {
        Ok(candidates) => candidates,
        Err(error) => {
            tracing::error!(%error, "failed to classify the bounded automatic resume queue");
            return;
        }
    };
    run_automatic_resume_lanes(state, candidates, false, "daemonStartup").await;
}

async fn run_automatic_resume_lanes(
    state: AppState,
    candidates: Vec<termloop_core::AgentResumeCandidate>,
    restart_running: bool,
    trigger: &'static str,
) {
    let mut lanes = tokio::task::JoinSet::new();
    for lane in [
        termloop_core::AgentResumeLane::Ordinary,
        termloop_core::AgentResumeLane::Steward,
        termloop_core::AgentResumeLane::Worker,
    ] {
        let candidates = candidates
            .iter()
            .filter(|candidate| candidate.lane() == lane)
            .cloned()
            .collect::<VecDeque<_>>();
        if candidates.is_empty() {
            continue;
        }
        let state = state.clone();
        lanes.spawn(run_automatic_resume_lane(
            state,
            lane,
            candidates,
            restart_running,
            trigger,
        ));
    }
    while lanes.join_next().await.is_some() {}
}

async fn run_automatic_resume_lane(
    state: AppState,
    lane: termloop_core::AgentResumeLane,
    mut candidates: VecDeque<termloop_core::AgentResumeCandidate>,
    restart_running: bool,
    trigger: &'static str,
) {
    let max_active = match lane {
        termloop_core::AgentResumeLane::Ordinary => MAX_ACTIVE_AGENT_RESUMES,
        termloop_core::AgentResumeLane::Steward => MAX_ACTIVE_STEWARD_RESUMES,
        termloop_core::AgentResumeLane::Worker => MAX_ACTIVE_WORKER_RESUMES,
    };
    let mut attempts = tokio::task::JoinSet::new();
    loop {
        while attempts.len() < max_active {
            let Some(candidate) = candidates.pop_front() else {
                break;
            };
            if *state.resume_shutdown.borrow() {
                return;
            }
            let attempt_deadline = Instant::now() + AGENT_RESUME_ATTEMPT_TIMEOUT;
            let mut shutdown = state.resume_shutdown.clone();
            let permit = tokio::select! {
                result = tokio::time::timeout_at(
                    attempt_deadline,
                    state
                        .agent_resume_gates
                        .for_lane(lane)
                        .acquire(candidate.project_id().to_owned()),
                ) => match result {
                    Ok(Ok(permit)) => Some(permit),
                    _ => None,
                },
                _ = shutdown.changed() => None,
            };
            let Some(permit) = permit else {
                if restart_running && !*state.resume_shutdown.borrow() {
                    candidates.push_back(candidate);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    break;
                }
                if !*state.resume_shutdown.borrow() {
                    let state = state.clone();
                    attempts.spawn(async move {
                        run_automatic_resume_attempt(
                            candidate.session_id().to_owned(),
                            &state,
                            None,
                            restart_running,
                            trigger,
                            attempt_deadline,
                        )
                        .await;
                    });
                }
                continue;
            };
            let state = state.clone();
            attempts.spawn(async move {
                run_automatic_resume_attempt(
                    candidate.session_id().to_owned(),
                    &state,
                    Some(permit),
                    restart_running,
                    trigger,
                    attempt_deadline,
                )
                .await;
            });
        }
        if attempts.is_empty() {
            if candidates.is_empty() {
                return;
            }
            continue;
        }
        let _ = attempts.join_next().await;
    }
}

/// A daemon-start recovery is already automatic user intent for a Session that
/// was running before the daemon stopped. Claude can fail to publish its
/// SessionStart hook when several provider processes initialize together even
/// though the exact same conversation starts immediately on a later manual
/// Retry. Give only the typed startup timeout one fresh, bounded attempt after
/// the first plan has fully failed and reaped its PTY. The second call goes
/// through normal planning and admission again; it never reuses launch data or
/// recurses into another retry.
async fn run_automatic_resume_attempt(
    session_id: String,
    state: &AppState,
    permit: Option<FairResumePermit>,
    restart_running: bool,
    trigger: &'static str,
    attempt_deadline: Instant,
) {
    let operation = Arc::<str>::from(format!("session.resumeAgent:{session_id}"));
    in_operation(
        "resume",
        "internal",
        operation,
        run_automatic_resume_attempt_inner(
            session_id,
            state,
            permit,
            restart_running,
            trigger,
            attempt_deadline,
        ),
    )
    .await;
}

async fn run_automatic_resume_attempt_inner(
    session_id: String,
    state: &AppState,
    permit: Option<FairResumePermit>,
    restart_running: bool,
    trigger: &'static str,
    attempt_deadline: Instant,
) {
    let first = run_agent_resume_session(
        json!({ "sessionId": &session_id }),
        state,
        permit,
        restart_running,
        false,
        trigger,
        attempt_deadline,
    )
    .await;
    if !should_retry_daemon_startup_timeout(trigger, &first) || *state.resume_shutdown.borrow() {
        return;
    }

    tokio::time::sleep(Duration::from_millis(250)).await;
    if *state.resume_shutdown.borrow() {
        return;
    }
    let _ = run_agent_resume_session(
        json!({ "sessionId": &session_id }),
        state,
        None,
        false,
        false,
        "daemonStartupRetry",
        Instant::now() + AGENT_RESUME_ATTEMPT_TIMEOUT,
    )
    .await;
}

fn should_retry_daemon_startup_timeout(
    trigger: &str,
    result: &Result<serde_json::Value, CoreError>,
) -> bool {
    trigger == "daemonStartup"
        && result.as_ref().ok().is_some_and(|projection| {
            projection
                .get("lifecycle_state")
                .and_then(serde_json::Value::as_str)
                == Some("resumeFailed")
                && projection
                    .get("resume_failure_reason")
                    .and_then(serde_json::Value::as_str)
                    == Some("startupTimedOut")
                && projection
                    .get("retryable")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_cursor_response_fixture() {
        if std::env::var_os("TERMLOOP_TEST_HEADLESS_CURSOR_RESPONSE").is_none() {
            return;
        }
        use std::io::{BufRead, Write};

        std::io::stdout().write_all(b"\x1b[6n").unwrap();
        std::io::stdout().flush().unwrap();
        let mut response = String::new();
        std::io::stdin().lock().read_line(&mut response).unwrap();
        assert_eq!(
            response.trim_end_matches(['\r', '\n']).as_bytes(),
            termloop_terminal::HEADLESS_CURSOR_POSITION_REPORT
        );
    }

    #[test]
    fn ownership_retry_reaps_the_conflicting_in_memory_pty_registry_entry() {
        let terminal = TerminalService::default();
        let session_id = "ownership-conflict".to_owned();
        let (program, args) = termloop_platform::default_shell();
        terminal
            .spawn(termloop_terminal::PtySpawnSpec {
                session_id: session_id.clone(),
                runtime_epoch: 7,
                program,
                args,
                cwd: std::env::current_dir().unwrap().display().to_string(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: false,
            })
            .unwrap();
        assert!(terminal.contains_session(&session_id).unwrap());
        assert!(reap_in_memory_agent_runtime(
            terminal.clone(),
            session_id.clone(),
            None,
        ));
        assert!(!terminal.contains_session(&session_id).unwrap());
    }

    #[test]
    fn task_launch_queue_timeout_preserves_the_typed_unavailable_reason() {
        assert!(matches!(
            task_launch_timeout("task-1"),
            CoreError::TaskWorktreeUnavailable {
                task_id,
                reason: termloop_core::TaskWorktreeUnavailableReason::Timeout,
            } if task_id == "task-1"
        ));
    }

    #[test]
    fn automatic_resume_lanes_have_independent_caps() {
        assert_eq!(MAX_ACTIVE_AGENT_RESUMES, 7);
        assert_eq!(MAX_ACTIVE_STEWARD_RESUMES, 1);
        assert_eq!(MAX_ACTIVE_WORKER_RESUMES, 7);
    }

    #[test]
    fn relocation_has_a_ten_second_startup_budget() {
        assert_eq!(AGENT_RELOCATION_ATTEMPT_TIMEOUT, Duration::from_secs(10));
        assert_eq!(AGENT_RESUME_ATTEMPT_TIMEOUT, Duration::from_secs(30));
    }

    #[test]
    fn cursor_position_query_detection_survives_terminal_chunk_boundaries() {
        let mut tail = VecDeque::new();
        assert!(!contains_cursor_position_query(&mut tail, b"prefix\x1b["));
        assert!(contains_cursor_position_query(&mut tail, b"6nsuffix"));
        assert!(!contains_cursor_position_query(&mut tail, b"plain output"));
    }

    #[tokio::test]
    async fn startup_terminal_pump_answers_a_headless_cursor_query() {
        if termloop_platform::host_requires_long_path_opt_in() {
            eprintln!(
                "UNMEASURED: raw headless ConPTY fixture; renderer-backed Windows PTY coverage lives in core session-launch tests"
            );
            return;
        }
        let terminal = TerminalService::default();
        let session_id = "headless-cursor-response";
        terminal
            .spawn(termloop_terminal::PtySpawnSpec {
                session_id: session_id.into(),
                runtime_epoch: 7,
                program: std::env::current_exe()
                    .unwrap()
                    .into_os_string()
                    .into_string()
                    .unwrap(),
                args: vec![
                    "--exact".into(),
                    "app::control::handlers::session::tests::headless_cursor_response_fixture"
                        .into(),
                    "--nocapture".into(),
                ],
                cwd: std::env::current_dir().unwrap().display().to_string(),
                environment: termloop_platform::LaunchEnvironment::os_baseline()
                    .with_explicit("TERMLOOP_TEST_HEADLESS_CURSOR_RESPONSE", "1"),
                recent_output_replay: true,
            })
            .unwrap();
        let mut subscription = terminal.subscribe(session_id, 7).unwrap();
        let mut cursor_query_tail = VecDeque::new();

        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match pump_startup_terminal(
                    &terminal,
                    &mut subscription,
                    session_id,
                    &mut cursor_query_tail,
                    Duration::from_millis(100),
                )
                .await
                {
                    StartupTerminalPump::Alive => {}
                    StartupTerminalPump::CursorPositionAnswered => {
                        // The fixture runs under the test harness's canonical
                        // terminal mode; a real TUI reads the CPR in raw mode.
                        let submit = termloop_platform::terminal_paste_submission_sequence(b"");
                        terminal.input(session_id, &submit[1]).unwrap();
                    }
                    StartupTerminalPump::Exited => break,
                }
            }
        })
        .await
        .unwrap();

        let mut reaped = Vec::new();
        for _ in 0..100 {
            reaped = terminal.reap_exited().unwrap();
            if !reaped.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(reaped.len(), 1);
        assert_eq!(reaped[0].session_id, session_id);
        assert_eq!(reaped[0].exit_code, 0);
    }

    #[test]
    fn daemon_startup_retries_only_the_exact_typed_timeout() {
        let timed_out = Ok(json!({
            "lifecycle_state": "resumeFailed",
            "resume_failure_reason": "startupTimedOut",
            "retryable": true,
        }));
        assert!(should_retry_daemon_startup_timeout(
            "daemonStartup",
            &timed_out
        ));
        assert!(!should_retry_daemon_startup_timeout(
            "daemonStartupRetry",
            &timed_out
        ));
        assert!(!should_retry_daemon_startup_timeout(
            "manualRetry",
            &timed_out
        ));
        assert!(!should_retry_daemon_startup_timeout(
            "daemonStartup",
            &Ok(json!({
                "lifecycle_state": "resumeFailed",
                "resume_failure_reason": "resumeRejected",
                "retryable": true,
            })),
        ));
    }

    #[test]
    fn resume_readiness_fails_fast_after_the_provider_process_exits() {
        assert_eq!(
            agent_resume_startup_poll(Some(false), Some(false)),
            AgentResumeStartupPoll::ProcessExited,
        );
        assert_eq!(
            agent_resume_startup_poll(Some(false), Some(true)),
            AgentResumeStartupPoll::Waiting,
        );
        assert_eq!(
            agent_resume_startup_poll(Some(false), None),
            AgentResumeStartupPoll::Waiting,
        );
        assert_eq!(
            agent_resume_startup_poll(Some(true), Some(false)),
            AgentResumeStartupPoll::Ready,
        );
    }
}
