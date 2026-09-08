use std::future::Future;
use std::sync::atomic::Ordering;

use serde_json::Value;
use termloop_core::CoreError;
use tokio::sync::mpsc;

use super::{
    AppState, CommitImpact, InvalidationRequest, commit_invalidation, queue_invalidation,
    refresh_task_presence_for_cwd,
};

/// Facts captured by a successful Core commit, before releasing its lock.
pub(in crate::app) struct CommittedSessionMutation {
    impact: CommitImpact,
    state_revision: u64,
    cwd: Option<String>,
}

impl CommittedSessionMutation {
    pub(in crate::app) fn launched(session: &Value, state_revision: u64, workflow: bool) -> Self {
        Self {
            impact: if workflow {
                CommitImpact::SessionWorkflow
            } else {
                CommitImpact::Session
            },
            state_revision,
            cwd: session
                .get("process")
                .and_then(|process| process.get("cwd"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }

    pub(in crate::app) fn terminated(state_revision: u64, cwd: Option<String>) -> Self {
        Self {
            impact: CommitImpact::SessionTermination,
            state_revision,
            cwd,
        }
    }
}

/// Complete every committed effect before returning the result of subsequent
/// process cleanup. The caller must have released the serialized Core lock.
pub(in crate::app) async fn finish_session_mutation<T>(
    state: &AppState,
    commit: CommittedSessionMutation,
    outcome: Result<T, CoreError>,
) -> Result<T, CoreError> {
    finish_with_presence(
        &state.invalidation_requests,
        state.observation_sequence.load(Ordering::Relaxed),
        commit,
        outcome,
        |cwd| async move { refresh_task_presence_for_cwd(state, &cwd).await },
    )
    .await
}

/// Publish the durable commit and refresh its presence while process cleanup
/// runs independently. Cleanup still controls the command result, but cannot
/// delay clients learning that the Session descriptor already changed.
pub(in crate::app) async fn finish_session_mutation_with_cleanup<T, F>(
    state: &AppState,
    commit: CommittedSessionMutation,
    cleanup: F,
) -> Result<T, CoreError>
where
    F: Future<Output = Result<T, CoreError>>,
{
    finish_with_presence_and_cleanup(
        &state.invalidation_requests,
        state.observation_sequence.load(Ordering::Relaxed),
        commit,
        cleanup,
        |cwd| async move { refresh_task_presence_for_cwd(state, &cwd).await },
    )
    .await
}

async fn finish_with_presence<T, F, P>(
    sender: &mpsc::Sender<InvalidationRequest>,
    observation_sequence: u64,
    commit: CommittedSessionMutation,
    outcome: Result<T, CoreError>,
    refresh_presence: F,
) -> Result<T, CoreError>
where
    F: FnOnce(String) -> P,
    P: Future<Output = ()>,
{
    queue_invalidation(
        sender,
        commit_invalidation(commit.impact, commit.state_revision, observation_sequence),
    )
    .await;
    if let Some(cwd) = commit.cwd {
        refresh_presence(cwd).await;
    }
    outcome
}

async fn finish_with_presence_and_cleanup<T, F, C, P>(
    sender: &mpsc::Sender<InvalidationRequest>,
    observation_sequence: u64,
    commit: CommittedSessionMutation,
    cleanup: F,
    refresh_presence: C,
) -> Result<T, CoreError>
where
    F: Future<Output = Result<T, CoreError>>,
    C: FnOnce(String) -> P,
    P: Future<Output = ()>,
{
    let committed_effects = finish_with_presence(
        sender,
        observation_sequence,
        commit,
        Ok(()),
        refresh_presence,
    );
    let (committed_effects, cleanup) = tokio::join!(committed_effects, cleanup);
    committed_effects?;
    cleanup
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use termloop_contract::current::ProjectionTopic;

    #[tokio::test]
    async fn cleanup_failure_still_publishes_and_refreshes_after_queue_backpressure() {
        let (sender, mut receiver) = mpsc::channel(1);
        sender
            .send(commit_invalidation(CommitImpact::Task, 40, 16))
            .await
            .unwrap();
        let (refreshed, mut presence) = mpsc::channel(1);
        let finish = tokio::spawn(async move {
            finish_with_presence::<(), _, _>(
                &sender,
                17,
                CommittedSessionMutation::terminated(41, Some("/task-worktree".into())),
                Err(CoreError::Terminal("reap failed".into())),
                |cwd| async move { refreshed.send(cwd).await.unwrap() },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(!finish.is_finished());
        assert!(presence.try_recv().is_err());
        assert_eq!(receiver.recv().await.unwrap().state_revision, 40);
        let error = finish.await.unwrap().unwrap_err();
        assert!(matches!(error, CoreError::Terminal(message) if message == "reap failed"));
        assert_eq!(
            receiver.recv().await.unwrap(),
            InvalidationRequest {
                topics: vec![
                    ProjectionTopic::Session,
                    ProjectionTopic::Steward,
                    ProjectionTopic::Routine
                ],
                state_revision: 41,
                observation_sequence: 17,
            }
        );
        assert_eq!(presence.recv().await.as_deref(), Some("/task-worktree"));
    }

    #[tokio::test]
    async fn launch_publication_keeps_its_commit_revision_cwd_and_workflow_scope() {
        for workflow in [false, true] {
            let (sender, mut receiver) = mpsc::channel(1);
            let session = json!({"process": {"cwd": "/task-worktree"}});
            let result = finish_with_presence(
                &sender,
                17,
                CommittedSessionMutation::launched(&session, 41, workflow),
                Ok(session.clone()),
                |cwd| async move { assert_eq!(cwd, "/task-worktree") },
            )
            .await
            .unwrap();
            assert_eq!(result, session);
            let invalidation = receiver.recv().await.unwrap();
            assert_eq!(invalidation.state_revision, 41);
            assert_eq!(invalidation.observation_sequence, 17);
            assert_eq!(
                invalidation.topics,
                if workflow {
                    vec![ProjectionTopic::Session, ProjectionTopic::Workflow]
                } else {
                    vec![ProjectionTopic::Session]
                }
            );
        }
    }

    #[tokio::test]
    async fn absent_cwd_does_not_refresh_presence() {
        let (sender, mut receiver) = mpsc::channel(1);
        finish_with_presence(
            &sender,
            0,
            CommittedSessionMutation::launched(&json!({}), 2, false),
            Ok(()),
            |_| async { panic!("no cwd to refresh") },
        )
        .await
        .unwrap();
        assert_eq!(receiver.recv().await.unwrap().state_revision, 2);
    }

    #[tokio::test]
    async fn slow_cleanup_does_not_delay_committed_effects() {
        let (sender, mut receiver) = mpsc::channel(1);
        let (refreshed, mut presence) = mpsc::channel(1);
        let (release, wait) = tokio::sync::oneshot::channel();
        let finish = tokio::spawn(async move {
            finish_with_presence_and_cleanup(
                &sender,
                17,
                CommittedSessionMutation::terminated(41, Some("/task-worktree".into())),
                async move {
                    let _ = wait.await;
                    Err::<(), _>(CoreError::Terminal("reap failed".into()))
                },
                |cwd| async move { refreshed.send(cwd).await.unwrap() },
            )
            .await
        });

        let invalidation = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(invalidation.state_revision, 41);
        assert_eq!(presence.recv().await.as_deref(), Some("/task-worktree"));
        assert!(!finish.is_finished());

        release.send(()).unwrap();
        let error = finish.await.unwrap().unwrap_err();
        assert!(matches!(error, CoreError::Terminal(message) if message == "reap failed"));
    }
}
