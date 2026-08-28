//! Demand-driven Routine deadline supervision. With no active check this task
//! performs zero periodic work and waits only for a runtime wake notification.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::time::Duration;

use termloop_contract::current::ProjectionTopic;

use super::AppState;
use super::invalidation::InvalidationRequest;

#[allow(dead_code, reason = "F4-03B2 is the first capability issuer")]
const REPORT_CAPABILITIES_MAX: usize = 256;
const REPORT_CAPABILITY_GRACE_MS: u64 = 60 * 1_000;
const WAKE_DELIVERY_RETRY_MS: u64 = 5_000;

#[derive(Default)]
pub(super) struct TrackerReportCapabilityRegistry {
    entries: HashMap<String, Vec<TrackerReportGrant>>,
}

struct TrackerReportGrant {
    capability: termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability,
    task_reads: HashSet<String>,
}

impl TrackerReportCapabilityRegistry {
    fn prune_expired(&mut self, now_epoch_ms: u64) {
        self.entries.retain(|_, grants| {
            grants.retain(|grant| {
                now_epoch_ms
                    <= grant
                        .capability
                        .deadline_epoch_ms
                        .saturating_add(REPORT_CAPABILITY_GRACE_MS)
            });
            !grants.is_empty()
        });
    }

    pub(super) fn lookup(
        &mut self,
        session_id: &str,
        check_id: &str,
        now_epoch_ms: u64,
    ) -> Option<termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability>
    {
        self.prune_expired(now_epoch_ms);
        self.entries
            .get(session_id)
            .and_then(|grants| {
                grants
                    .iter()
                    .find(|grant| grant.capability.check_id == check_id)
            })
            .map(|grant| grant.capability.clone())
    }

    pub(super) fn mark_task_read(
        &mut self,
        session_id: &str,
        check_id: &str,
        task_id: &str,
        now_epoch_ms: u64,
    ) -> bool {
        self.prune_expired(now_epoch_ms);
        let Some(grant) = self.entries.get_mut(session_id).and_then(|grants| {
            grants
                .iter_mut()
                .find(|grant| grant.capability.check_id == check_id)
        }) else {
            return false;
        };
        grant.task_reads.insert(task_id.to_owned());
        true
    }

    pub(super) fn task_was_read(
        &mut self,
        session_id: &str,
        check_id: &str,
        task_id: &str,
        now_epoch_ms: u64,
    ) -> bool {
        self.prune_expired(now_epoch_ms);
        self.entries
            .get(session_id)
            .and_then(|grants| {
                grants
                    .iter()
                    .find(|grant| grant.capability.check_id == check_id)
            })
            .is_some_and(|grant| grant.task_reads.contains(task_id))
    }

    #[cfg(test)]
    fn consume(
        &mut self,
        session_id: &str,
        check_id: &str,
        now_epoch_ms: u64,
    ) -> Option<termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability>
    {
        self.prune_expired(now_epoch_ms);
        let grants = self.entries.get_mut(session_id)?;
        let index = grants
            .iter()
            .position(|grant| grant.capability.check_id == check_id)?;
        let capability = grants.remove(index).capability;
        if grants.is_empty() {
            self.entries.remove(session_id);
        }
        Some(capability)
    }

    #[allow(dead_code, reason = "F4-03B2 is the first capability issuer")]
    pub(super) fn issue(
        &mut self,
        session_id: String,
        capability: termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability,
        now_epoch_ms: u64,
    ) -> bool {
        self.prune_expired(now_epoch_ms);
        let issued_count = self.entries.values().map(Vec::len).sum::<usize>();
        if session_id.is_empty() || issued_count >= REPORT_CAPABILITIES_MAX {
            return false;
        }
        let grants = self.entries.entry(session_id).or_default();
        if let Some(existing) = grants
            .iter()
            .find(|grant| grant.capability.check_id == capability.check_id)
        {
            return existing.capability == capability;
        }
        grants.push(TrackerReportGrant {
            capability,
            task_reads: HashSet::new(),
        });
        true
    }

    pub(super) fn revoke_session(&mut self, session_id: &str) {
        self.entries.remove(session_id);
    }

    pub(super) fn revoke_check(&mut self, session_id: &str, check_id: &str) {
        if let Some(grants) = self.entries.get_mut(session_id) {
            grants.retain(|grant| grant.capability.check_id != check_id);
            if grants.is_empty() {
                self.entries.remove(session_id);
            }
        }
    }

    pub(super) fn retain_current(&mut self, core: &termloop_core::CoreRuntime, now_epoch_ms: u64) {
        self.prune_expired(now_epoch_ms);
        self.entries.retain(|_, grants| {
            grants.retain(|grant| core.tracker_check_is_current(&grant.capability));
            !grants.is_empty()
        });
    }
}

pub(super) async fn run_tracker_deadlines(state: AppState) {
    loop {
        let next_wake = {
            let mut core = state.core.lock().await;
            match (
                core.next_tracker_deadline_epoch_ms(),
                core.next_tracker_schedule_epoch_ms(),
            ) {
                (Some(left), Some(right)) => Some(left.min(right)),
                (Some(value), None) | (None, Some(value)) => Some(value),
                (None, None) => None,
            }
        };
        let Some(next_wake) = next_wake else {
            state.tracker_runtime_wake.notified().await;
            continue;
        };
        let now = termloop_platform::current_epoch_ms();
        let delay = Duration::from_millis(next_wake.saturating_sub(now));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {
                let (changed, due, state_revision) = {
                    let mut core = state.core.lock().await;
                    let now = termloop_platform::current_epoch_ms();
                    let advance = core.advance_tracker_deadlines(now).unwrap_or_else(|error| {
                        tracing::warn!(%error, "failed to advance Routine deadlines");
                        termloop_core::companion_integrations::tracker_runtime::TrackerDeadlineAdvance {
                            changed: false,
                        }
                    });
                    let due = core.admit_due_worker_wakes(now);
                    if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
                        capabilities.retain_current(&core, now);
                    }
                    (advance, due, core.state_revision())
                };
                if changed.changed {
                    publish_tracker_runtime_invalidation(&state, state_revision);
                }
                for wake in due {
                    deliver_due_worker_wake(&state, wake).await;
                }
            }
            _ = state.tracker_runtime_wake.notified() => {}
        }
    }
}

fn publish_tracker_runtime_invalidation(state: &AppState, state_revision: u64) {
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Routine,
            ProjectionTopic::Worker,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
}

async fn deliver_due_worker_wake(
    state: &AppState,
    wake: termloop_core::companion_integrations::tracker_runtime::DueWorkerWake,
) {
    let message =
        match termloop_core::companion_integrations::assistant_session::compose_worker_routine_wake(
        ) {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!(worker_id = wake.worker_id, %error, "Routine wake composition failed");
                return;
            }
        };
    // Keep the Core guard out of the `if let` scrutinee. Scrutinee
    // temporaries live through the matching branch, and the failure branch
    // needs to lock Core again to schedule a retry. Leaving the guard in the
    // scrutinee therefore self-deadlocks the whole control plane whenever a
    // wake cannot be delivered.
    let delivery = {
        let mut core = state.core.lock().await;
        core.deliver_worker_routine_wake(&wake, &message)
    };
    if let Err(error) = delivery {
        tracing::warn!(worker_id = wake.worker_id, %error, "Routine wake delivery failed");
        let retry_at = termloop_platform::current_epoch_ms().saturating_add(WAKE_DELIVERY_RETRY_MS);
        state
            .core
            .lock()
            .await
            .fail_worker_wake_delivery(&wake, retry_at);
        state.tracker_runtime_wake.notify_one();
    }
    publish_tracker_runtime_invalidation(state, state.core.lock().await.state_revision());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability(
        id: usize,
        deadline_epoch_ms: u64,
    ) -> termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability {
        termloop_core::companion_integrations::tracker_runtime::TrackerCheckCapability {
            project_id: "project".into(),
            tracker_id: format!("tracker-{id}"),
            check_id: format!("check-{id}"),
            generation: 1,
            claimed_at_epoch_ms: 0,
            deadline_epoch_ms,
            worker_id: format!("worker-{id}"),
            worker_generation: 1,
            worker_session_id: format!("session-{id}"),
        }
    }

    #[test]
    fn report_capabilities_are_bounded_consumed_and_expire() {
        let mut registry = TrackerReportCapabilityRegistry::default();
        for index in 0..REPORT_CAPABILITIES_MAX {
            assert!(registry.issue(format!("session-{index}"), capability(index, 100), 0));
        }
        assert!(!registry.issue("overflow-session".into(), capability(999, 100), 0));
        assert!(registry.lookup("session-0", "check-0", 0).is_some());
        assert!(registry.consume("session-0", "wrong", 0).is_none());
        assert!(registry.lookup("session-0", "check-0", 0).is_some());
        assert!(registry.consume("session-0", "check-0", 0).is_some());
        assert!(registry.lookup("session-0", "check-0", 0).is_none());
        assert!(registry.lookup("session-1", "check-1", 60_101).is_none());
        assert!(registry.issue("fresh-session".into(), capability(1000, 70_000), 60_101));
    }

    #[test]
    fn one_worker_session_holds_and_consumes_a_batched_task_set() {
        let mut registry = TrackerReportCapabilityRegistry::default();
        assert!(registry.issue("worker-session".into(), capability(1, 100), 0,));
        assert!(registry.issue("worker-session".into(), capability(2, 100), 0,));

        assert_eq!(
            registry
                .lookup("worker-session", "check-2", 0)
                .unwrap()
                .tracker_id,
            "tracker-2"
        );
        assert!(registry.consume("worker-session", "check-2", 0).is_some());
        assert!(registry.lookup("worker-session", "check-1", 0).is_some());
        assert!(registry.consume("worker-session", "check-1", 0).is_some());
        assert!(registry.lookup("worker-session", "check-1", 0).is_none());
    }

    #[test]
    fn task_read_receipts_are_exact_to_session_check_and_task() {
        let mut registry = TrackerReportCapabilityRegistry::default();
        assert!(registry.issue("worker-session".into(), capability(1, 100), 0));
        assert!(!registry.task_was_read("worker-session", "check-1", "task-1", 0));
        assert!(!registry.mark_task_read("other-session", "check-1", "task-1", 0));
        assert!(registry.mark_task_read("worker-session", "check-1", "task-1", 0));
        assert!(registry.task_was_read("worker-session", "check-1", "task-1", 0));
        assert!(!registry.task_was_read("worker-session", "check-1", "task-2", 0));
        assert!(!registry.task_was_read("worker-session", "check-2", "task-1", 0));
    }
}
