use serde_json::Value;
use termloop_core::{AgentLaunchPlan, CoreError, CoreRuntime};
use tokio::time::{Duration, Instant};

use super::AppState;
use super::gates::{
    AGENT_RESUME_ATTEMPT_TIMEOUT, FairObservationGate, FairObservationPermit, ObservationPriority,
};
use super::invalidation::{CommittedSessionMutation, finish_session_mutation};

#[cfg(test)]
mod tests;

const LAUNCH_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Copy)]
enum LaunchPreparation {
    Ordinary,
    Helper,
    Fork,
}

impl LaunchPreparation {
    fn label(self) -> &'static str {
        match self {
            Self::Ordinary => "agent",
            Self::Helper => "helper",
            Self::Fork => "fork",
        }
    }
}

pub(super) async fn execute_agent_launch(
    state: &AppState,
    plan: AgentLaunchPlan,
) -> Result<Value, CoreError> {
    let workflow_launch = plan.is_workflow_launch();
    let commit = execute_launch_attempt(
        state,
        plan,
        LaunchPreparation::Ordinary,
        Instant::now() + LAUNCH_OBSERVATION_TIMEOUT,
        |core, plan, _| core.complete_agent_launch(plan),
    )
    .await?;
    let effects =
        CommittedSessionMutation::launched(&commit.session, commit.state_revision, workflow_launch);
    finish_session_mutation(state, effects, Ok(commit.session)).await
}

pub(super) async fn execute_ask_to_launch(
    state: &AppState,
    plan: AgentLaunchPlan,
    request_id: &str,
) -> Result<Value, CoreError> {
    let result = execute_launch_attempt(
        state,
        plan,
        LaunchPreparation::Helper,
        Instant::now() + LAUNCH_OBSERVATION_TIMEOUT,
        |core, plan, _| {
            let result = core.complete_ask_to_launch(request_id, plan);
            if result.is_err() {
                core.fail_ask_to_launch(request_id);
            }
            result
        },
    )
    .await;
    let completion = match result {
        Ok(completion) => completion,
        Err(error) => {
            // Also covers queue, observation and preparation failure. Core's
            // failure transition is idempotent if commit already rejected it.
            state.core.lock().await.fail_ask_to_launch(request_id);
            return Err(error);
        }
    };
    let effects =
        CommittedSessionMutation::launched(&completion.session, completion.state_revision, false);
    finish_session_mutation(state, effects, Ok(completion.acknowledgement)).await
}

/// A committed child is not yet a successful fork. Even retention failure must
/// return its exact identity so the fork owner can retain or roll back the child.
#[must_use]
pub(super) struct PendingAgentFork {
    pub session: Value,
    pub session_id: String,
    pub runtime_epoch: u64,
    pub startup_deadline: Instant,
    pub retention: Result<(), CoreError>,
}

pub(super) async fn execute_agent_fork_attempt(
    state: &AppState,
    plan: AgentLaunchPlan,
    deadline: Instant,
) -> Result<PendingAgentFork, CoreError> {
    execute_launch_attempt(
        state,
        plan,
        LaunchPreparation::Fork,
        deadline,
        |core, plan, prepared_at| {
            let session_id = plan.session_id().to_owned();
            let runtime_epoch = plan.runtime_epoch();
            let startup_deadline = deadline.min(prepared_at + AGENT_RESUME_ATTEMPT_TIMEOUT);
            let commit = core.complete_agent_launch(plan)?;
            // Keep retention adjacent to commit under the same Core lock: the exit
            // reconciler must not consume the child before fork readiness is known.
            let retention = state
                .terminal
                .set_exit_replay_retention(&session_id, runtime_epoch, true)
                .map_err(|error| CoreError::Terminal(error.to_string()));
            Ok(PendingAgentFork {
                session: commit.session,
                session_id,
                runtime_epoch,
                startup_deadline,
                retention,
            })
        },
    )
    .await
}

/// All AgentLaunchPlan execution passes through this owner. The named entry
/// points above retain their Core commands and completion semantics; this seam
/// owns preparation, lock boundaries and disposal, including cancelled futures.
async fn execute_launch_attempt<T>(
    state: &AppState,
    plan: AgentLaunchPlan,
    preparation: LaunchPreparation,
    deadline: Instant,
    commit: impl FnOnce(&mut CoreRuntime, &mut AgentLaunchPlan, Instant) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let mut plan =
        prepare_launch_plan(&state.git_observation_gate, plan, preparation, deadline).await?;
    if let Some(error) = plan.get_mut().observation_warning() {
        tracing::warn!(%error, launch_kind = preparation.label(), "agent status runtime unavailable");
    }
    let prepared_at = Instant::now();
    let result = {
        let mut core = state.core.lock().await;
        commit(&mut core, plan.get_mut(), prepared_at)
    };
    // Schedule process-owning disposal before propagating any commit error.
    drop(plan);
    result
}

async fn prepare_launch_plan(
    gate: &FairObservationGate,
    plan: AgentLaunchPlan,
    preparation: LaunchPreparation,
    deadline: Instant,
) -> Result<BlockingDrop<AgentLaunchPlan>, CoreError> {
    let mut plan = BlockingDrop::new(plan);
    let task_scope = plan
        .get_mut()
        .launch_observation_scope()
        .map(|(task, project)| (task.to_owned(), project.to_owned()));
    let permit = acquire_launch_observation(gate, task_scope.as_ref(), deadline).await?;
    run_blocking_preparation(plan, permit, preparation.label(), move |launch| {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| launch_observation_timeout(task_scope.as_ref(), preparation))?;
        if matches!(preparation, LaunchPreparation::Fork) {
            launch.observe_fork_worktree(remaining)?;
        } else {
            launch.observe_task_worktree(remaining)?;
        }
        launch.prepare_runtime();
        if matches!(preparation, LaunchPreparation::Fork) {
            launch.verify_fork_source_history()?;
            if !launch.fork_runtime_ready() {
                return Err(CoreError::AgentForkUnavailable {
                    reason: termloop_core::AgentForkUnavailableReason::RuntimeConflict,
                });
            }
        }
        Ok(())
    })
    .await
}

async fn run_blocking_preparation<T: Send + 'static>(
    mut plan: BlockingDrop<T>,
    permit: Option<FairObservationPermit>,
    label: &'static str,
    prepare: impl FnOnce(&mut T) -> Result<(), CoreError> + Send + 'static,
) -> Result<BlockingDrop<T>, CoreError> {
    tokio::task::spawn_blocking(move || {
        // The blocking job retains the permit even if its awaiting task is
        // cancelled. A queued successor cannot overlap the unfinished Git work.
        let _permit = permit;
        prepare(plan.get_mut())?;
        Ok(plan)
    })
    .await
    .map_err(|error| CoreError::Terminal(format!("{label} runtime preparation failed: {error}")))?
}

async fn acquire_launch_observation(
    gate: &FairObservationGate,
    task_scope: Option<&(String, String)>,
    deadline: Instant,
) -> Result<Option<FairObservationPermit>, CoreError> {
    let Some((task_id, project_id)) = task_scope else {
        return Ok(None);
    };
    gate.acquire_until(project_id.as_str(), ObservationPriority::Explicit, deadline)
        .await
        .map(Some)
        .map_err(|_| task_launch_timeout(task_id))
}

fn launch_observation_timeout(
    task_scope: Option<&(String, String)>,
    preparation: LaunchPreparation,
) -> CoreError {
    match task_scope {
        Some((task_id, _)) => task_launch_timeout(task_id),
        None if matches!(preparation, LaunchPreparation::Fork) => CoreError::AgentForkUnavailable {
            reason: termloop_core::AgentForkUnavailableReason::RuntimeConflict,
        },
        None => CoreError::GitObservationTimedOut,
    }
}

fn task_launch_timeout(task_id: &str) -> CoreError {
    CoreError::TaskWorktreeUnavailable {
        task_id: task_id.to_owned(),
        reason: termloop_core::TaskWorktreeUnavailableReason::Timeout,
    }
}

/// Ownership travels through the blocking worker's result, so cancellation
/// while waiting for preparation or the Core lock cannot reap on an async worker.
struct BlockingDrop<T: Send + 'static>(Option<T>);

impl<T: Send + 'static> BlockingDrop<T> {
    fn new(value: T) -> Self {
        Self(Some(value))
    }

    fn get_mut(&mut self) -> &mut T {
        self.0.as_mut().expect("blocking-owned value")
    }
}

impl<T: Send + 'static> Drop for BlockingDrop<T> {
    fn drop(&mut self) {
        if let Some(value) = self.0.take() {
            std::mem::drop(tokio::task::spawn_blocking(move || drop(value)));
        }
    }
}
