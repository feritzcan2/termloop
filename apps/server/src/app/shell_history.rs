//! Schedules Core's shell-history checkpoints without holding the Core lock
//! across filesystem or process observation. One writer owns all fixed slots.

use std::time::Duration;

use termloop_core::ShellHistoryStore;
use tokio::sync::oneshot;

use super::{AppState, ProjectionTopic};

pub(super) struct ShellHistoryWriter {
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl ShellHistoryWriter {
    pub(super) fn spawn(state: AppState, mut store: ShellHistoryStore) -> Self {
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let finishing = tokio::select! {
                    _ = &mut stopped => true,
                    _ = interval.tick() => false,
                };
                let plan = state.core.lock().await.plan_shell_history_checkpoint();
                let observed = tokio::task::spawn_blocking(move || {
                    let checkpoint = plan.checkpoint(&mut store);
                    (store, checkpoint)
                })
                .await;
                let (returned_store, checkpoint) = match observed {
                    Ok(observed) => observed,
                    Err(error) => {
                        tracing::warn!(%error, "terminal history writer stopped");
                        return;
                    }
                };
                store = returned_store;
                for error in &checkpoint.errors {
                    tracing::warn!(%error, "terminal history checkpoint failed; retry pending");
                }
                let (before, after) = {
                    let mut core = state.core.lock().await;
                    let before = core.state_revision();
                    if let Err(error) = core.apply_shell_directory_observations(checkpoint) {
                        tracing::warn!(%error, "terminal directory observation could not be committed");
                    }
                    (before, core.state_revision())
                };
                if before != after && !finishing {
                    super::invalidation::queue_invalidation(
                        &state.invalidation_requests,
                        super::InvalidationRequest {
                            topics: vec![ProjectionTopic::Session, ProjectionTopic::Task],
                            state_revision: after,
                            observation_sequence: state
                                .observation_sequence
                                .load(std::sync::atomic::Ordering::Relaxed),
                        },
                    )
                    .await;
                }
                if finishing {
                    return;
                }
            }
        });
        Self { stop, task }
    }

    pub(super) async fn finish(self) {
        let _ = self.stop.send(());
        if let Err(error) = self.task.await {
            tracing::warn!(%error, "terminal history final checkpoint did not complete");
        }
    }
}
