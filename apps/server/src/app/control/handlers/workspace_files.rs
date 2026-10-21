use serde_json::Value;
use std::time::Duration;
use termloop_contract::current::{
    WorkspaceFileSearchParams, WorkspaceFileWriteParams, WorkspaceFilesParams,
};
use termloop_core::CoreError;
use tokio::time::Instant;

use super::super::super::{
    AppState,
    gates::{FairObservationGate, ObservationPriority},
};

// A timed-out filesystem call may still occupy its blocking thread. Keep its
// slot until that call returns, so repeated retries cannot grow worker count.
static FILE_OBSERVATION_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub(in crate::app) async fn observe_workspace_files(
    params: Value,
    read_file: bool,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<WorkspaceFilesParams>(params)
        .map_err(|_| CoreError::InvalidParams("workspace files".into()))?;
    let plan = state.core.lock().await.plan_workspace_files(
        &params.project_id,
        params.task_id.as_deref(),
        &params.path,
    )?;
    let observed = observe_with_deadline(
        &state.git_observation_gate,
        plan.project_id().to_owned(),
        Instant::now() + Duration::from_secs(5),
        move || {
            if read_file {
                plan.observe_file()
            } else {
                plan.observe_directory_page(params.after_name.as_deref())
            }
        },
    )
    .await?;
    state.core.lock().await.complete_workspace_files(observed)
}

pub(in crate::app) async fn search_workspace_files(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<WorkspaceFileSearchParams>(params)
        .map_err(|_| CoreError::InvalidParams("workspace file search".into()))?;
    let plan = state.core.lock().await.plan_workspace_files(
        &params.project_id,
        params.task_id.as_deref(),
        "",
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    // The walk stops itself before the request deadline and returns partial
    // results marked incomplete instead of an error.
    let walk_deadline = std::time::Instant::now() + Duration::from_secs(8);
    let observed = observe_with_deadline(
        &state.git_observation_gate,
        plan.project_id().to_owned(),
        deadline,
        move || {
            plan.observe_search(
                &params.query,
                termloop_platform::WORKSPACE_SEARCH_RESULT_LIMIT,
                walk_deadline,
            )
        },
    )
    .await?;
    state.core.lock().await.complete_workspace_files(observed)
}

/// A write is not cancellable once its blocking worker starts; a request that
/// times out may still have replaced the file, which the next read reveals.
pub(in crate::app) async fn write_workspace_file(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<WorkspaceFileWriteParams>(params)
        .map_err(|_| CoreError::InvalidParams("workspace file write".into()))?;
    let plan = state.core.lock().await.plan_workspace_files(
        &params.project_id,
        params.task_id.as_deref(),
        &params.path,
    )?;
    let observed = observe_with_deadline(
        &state.git_observation_gate,
        plan.project_id().to_owned(),
        Instant::now() + Duration::from_secs(10),
        move || plan.observe_write(&params.content, &params.expected_version),
    )
    .await?;
    state.core.lock().await.complete_workspace_files(observed)
}

async fn observe_with_deadline<T: Send + 'static>(
    gate: &FairObservationGate,
    project_id: String,
    deadline: Instant,
    observe: impl FnOnce() -> T + Send + 'static,
) -> Result<T, CoreError> {
    let worker_slot = tokio::time::timeout_at(deadline, FILE_OBSERVATION_SLOTS.acquire())
        .await
        .map_err(|_| CoreError::RepositoryUnavailable)?
        .map_err(|_| CoreError::RepositoryUnavailable)?;
    let _permit = gate
        .acquire_until(
            project_id,
            ObservationPriority::Explicit,
            deadline.min(Instant::now() + Duration::from_secs(2)),
        )
        .await
        .map_err(|_| CoreError::RepositoryUnavailable)?;
    // Filesystem calls cannot be cancelled. Release the shared observation gate
    // on timeout so a stalled volume cannot block other Project observations.
    tokio::time::timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || {
            let _worker_slot = worker_slot;
            observe()
        }),
    )
    .await
    .map_err(|_| CoreError::RepositoryUnavailable)?
    .map_err(|_| CoreError::RepositoryUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timed_out_file_reader_releases_the_git_observation_gate() {
        let gate = FairObservationGate::new();
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let (started, ready) = tokio::sync::oneshot::channel();
        let reader_gate = gate.clone();
        let reader = tokio::spawn(async move {
            observe_with_deadline(
                &reader_gate,
                "project".into(),
                Instant::now() + Duration::from_millis(100),
                move || {
                    let _ = started.send(());
                    let _ = blocked.recv();
                },
            )
            .await
        });
        ready.await.unwrap();
        assert!(matches!(
            reader.await.unwrap(),
            Err(CoreError::RepositoryUnavailable)
        ));
        let next = gate
            .acquire_until(
                "project",
                ObservationPriority::Background,
                Instant::now() + Duration::from_secs(1),
            )
            .await;
        // Unblock the detached worker even if the assertion fails.
        drop(release);
        assert!(next.is_ok());
    }

    #[tokio::test]
    async fn queue_wait_expires_without_starting_a_file_reader() {
        let gate = FairObservationGate::new();
        let _occupied = gate
            .acquire("project", ObservationPriority::Background)
            .await
            .unwrap();
        let result = observe_with_deadline(
            &gate,
            "project".into(),
            Instant::now() + Duration::from_millis(20),
            || panic!("queued reader must not start"),
        )
        .await;
        assert!(matches!(result, Err(CoreError::RepositoryUnavailable)));
    }
}
