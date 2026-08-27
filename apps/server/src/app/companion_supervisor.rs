use std::collections::{HashMap, VecDeque};
use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicU8, Ordering},
};
use std::time::{Duration, Instant};

use termloop_contract::current::{CompanionWakeNextResult, CompanionWakeReason};
use tokio::sync::Notify;

use super::AppState;

const HEARTBEAT_DEADLINE: Duration = Duration::from_secs(45);
const MONITOR_INTERVAL: Duration = Duration::from_millis(250);
const MAX_RESTART_BACKOFF: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub(super) struct CompanionCredentialRegistry(Arc<StdMutex<Option<String>>>);

impl CompanionCredentialRegistry {
    fn issue(&self, token: String) {
        *self.0.lock().expect("Companion credential registry") = Some(token);
    }

    fn revoke(&self, token: &str) {
        let mut current = self.0.lock().expect("Companion credential registry");
        if current.as_deref() == Some(token) {
            *current = None;
        }
    }

    pub(super) fn matches(&self, candidate: &str) -> bool {
        self.0
            .lock()
            .expect("Companion credential registry")
            .as_deref()
            .is_some_and(|current| {
                super::control::constant_time_equal(current.as_bytes(), candidate.as_bytes())
            })
    }
}

#[derive(Clone)]
pub(super) struct CompanionHeartbeat(Arc<StdMutex<Instant>>);

impl Default for CompanionHeartbeat {
    fn default() -> Self {
        Self(Arc::new(StdMutex::new(Instant::now())))
    }
}

impl CompanionHeartbeat {
    pub(super) fn observe(&self) {
        *self.0.lock().expect("Companion heartbeat") = Instant::now();
    }

    fn overdue(&self) -> bool {
        self.0.lock().expect("Companion heartbeat").elapsed() > HEARTBEAT_DEADLINE
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SupervisorAvailability {
    Unavailable = 0,
    Starting = 1,
    Available = 2,
}

#[derive(Clone, Default)]
pub(super) struct CompanionSupervisorStatus(Arc<AtomicU8>);

impl CompanionSupervisorStatus {
    pub(super) fn availability(&self) -> SupervisorAvailability {
        match self.0.load(Ordering::Acquire) {
            1 => SupervisorAvailability::Starting,
            2 => SupervisorAvailability::Available,
            _ => SupervisorAvailability::Unavailable,
        }
    }

    fn set(&self, value: SupervisorAvailability) -> bool {
        self.0.swap(value as u8, Ordering::AcqRel) != value as u8
    }
}

impl SupervisorAvailability {
    pub(super) fn wire_name(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Starting => "starting",
            Self::Available => "available",
        }
    }
}

#[derive(Clone, Debug)]
struct PendingWake {
    reason: CompanionWakeReason,
    generation: u64,
    wake_id: u64,
}

#[derive(Clone, Debug)]
pub(super) struct InFlightWake {
    pub(super) reason: CompanionWakeReason,
    pub(super) wake_id: u64,
}

fn wake_priority(reason: &CompanionWakeReason) -> u8 {
    match reason {
        CompanionWakeReason::UserMessage => 3,
        CompanionWakeReason::PipelineMovedAndRoutineFinding => 2,
        CompanionWakeReason::RoutineFinding => 2,
        CompanionWakeReason::PipelineMoved => 2,
        CompanionWakeReason::ConfigurationChanged => 1,
        CompanionWakeReason::StartupRefresh => 0,
    }
}

#[derive(Default)]
struct WakeState {
    order: VecDeque<String>,
    pending: HashMap<String, PendingWake>,
    in_flight: Option<(String, PendingWake)>,
    next_wake_id: u64,
}

#[derive(Clone, Default)]
pub(super) struct CompanionWakeQueue {
    state: Arc<StdMutex<WakeState>>,
    notify: Arc<Notify>,
}

impl CompanionWakeQueue {
    pub(super) fn enqueue(
        &self,
        project_id: String,
        reason: CompanionWakeReason,
        generation: u64,
        project_limit: usize,
    ) -> bool {
        if project_id.is_empty() || generation == 0 || project_limit == 0 {
            return false;
        }
        let mut state = self.state.lock().expect("Companion wake queue");
        state.next_wake_id = state.next_wake_id.saturating_add(1).max(1);
        let wake_id = state.next_wake_id;
        if let Some(pending) = state.pending.get_mut(&project_id) {
            if wake_priority(&reason) >= wake_priority(&pending.reason) {
                pending.reason = reason;
            }
            pending.generation = generation;
            pending.wake_id = wake_id;
            return true;
        }
        if state.pending.len() >= project_limit {
            return false;
        }
        state.order.push_back(project_id.clone());
        state.pending.insert(
            project_id,
            PendingWake {
                reason,
                generation,
                wake_id,
            },
        );
        drop(state);
        self.notify.notify_one();
        true
    }

    pub(super) fn in_flight_wake(&self, project_id: &str, generation: u64) -> Option<InFlightWake> {
        let state = self.state.lock().expect("Companion wake queue");
        state
            .in_flight
            .as_ref()
            .filter(|(in_flight_project_id, pending)| {
                in_flight_project_id == project_id && pending.generation == generation
            })
            .map(|(_, pending)| InFlightWake {
                reason: pending.reason.clone(),
                wake_id: pending.wake_id,
            })
    }

    pub(super) async fn next(&self, wait_milliseconds: u64) -> CompanionWakeNextResult {
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(wait_milliseconds.min(30_000));
        loop {
            let notified = self.notify.notified();
            if let Some(result) = self.pop() {
                return result;
            }
            if wait_milliseconds == 0 || tokio::time::timeout_at(deadline, notified).await.is_err()
            {
                return CompanionWakeNextResult {
                    project_id: None,
                    reason: None,
                    generation: 0,
                };
            }
        }
    }

    fn pop(&self) -> Option<CompanionWakeNextResult> {
        let mut state = self.state.lock().expect("Companion wake queue");
        if let Some((project_id, pending)) = state.in_flight.as_ref() {
            return Some(CompanionWakeNextResult {
                project_id: Some(project_id.clone()),
                reason: Some(pending.reason.clone()),
                generation: pending.generation,
            });
        }
        while let Some(project_id) = state.order.pop_front() {
            let Some(pending) = state.pending.get(&project_id).cloned() else {
                continue;
            };
            state.in_flight = Some((project_id.clone(), pending.clone()));
            return Some(CompanionWakeNextResult {
                project_id: Some(project_id),
                reason: Some(pending.reason),
                generation: pending.generation,
            });
        }
        None
    }

    pub(super) fn acknowledge(&self, project_id: &str, generation: u64, wake_id: u64) {
        let mut state = self.state.lock().expect("Companion wake queue");
        let exact_in_flight =
            state
                .in_flight
                .as_ref()
                .is_some_and(|(in_flight_project_id, pending)| {
                    in_flight_project_id == project_id
                        && pending.generation == generation
                        && pending.wake_id == wake_id
                });
        if !exact_in_flight {
            return;
        }
        state.in_flight = None;
        let is_exact = state
            .pending
            .get(project_id)
            .is_some_and(|pending| pending.generation == generation && pending.wake_id == wake_id);
        if is_exact {
            state.pending.remove(project_id);
        } else if state.pending.contains_key(project_id)
            && !state.order.iter().any(|queued| queued == project_id)
        {
            state.order.push_front(project_id.to_owned());
            self.notify.notify_one();
        }
    }

    pub(super) fn discard(&self, project_id: &str) {
        let mut state = self.state.lock().expect("Companion wake queue");
        state.pending.remove(project_id);
        state.order.retain(|queued| queued != project_id);
        if state
            .in_flight
            .as_ref()
            .is_some_and(|(in_flight_project_id, _)| in_flight_project_id == project_id)
        {
            state.in_flight = None;
        }
    }
}

pub(super) async fn enqueue_current_steward_wake(
    state: &AppState,
    project_id: &str,
    reason: CompanionWakeReason,
) -> bool {
    let (wake, project_limit) = {
        let core = state.core.lock().await;
        (
            core.current_enabled_steward_wake(project_id),
            core.project_count(),
        )
    };
    wake.is_some_and(|wake| {
        state
            .companion_wakes
            .enqueue(wake.project_id, reason, wake.generation, project_limit)
    })
}

pub(super) async fn replace_steward_configuration_wake(state: &AppState, project_id: &str) -> bool {
    let (wake, project_limit, reason) = {
        let core = state.core.lock().await;
        (
            core.current_enabled_steward_wake(project_id),
            core.project_count(),
            configuration_wake_reason(core.has_current_routine_findings(project_id)),
        )
    };
    state.companion_wakes.discard(project_id);
    wake.is_some_and(|wake| {
        state
            .companion_wakes
            .enqueue(wake.project_id, reason, wake.generation, project_limit)
    })
}

fn configuration_wake_reason(has_current_routine_findings: bool) -> CompanionWakeReason {
    if has_current_routine_findings {
        CompanionWakeReason::RoutineFinding
    } else {
        CompanionWakeReason::ConfigurationChanged
    }
}

pub(super) fn startup_wake_reason(has_current_routine_findings: bool) -> CompanionWakeReason {
    if has_current_routine_findings {
        CompanionWakeReason::RoutineFinding
    } else {
        CompanionWakeReason::StartupRefresh
    }
}

pub(super) async fn observe_request(state: &AppState) {
    state.companion_last_seen.observe();
    publish_status(state, SupervisorAvailability::Available).await;
}

pub(super) async fn run(
    state: AppState,
    executable: Option<termloop_platform::ResolvedExecutable>,
    process_directory: std::path::PathBuf,
    working_directory: std::path::PathBuf,
) {
    let Some(executable) = executable else {
        publish_status(&state, SupervisorAvailability::Unavailable).await;
        return;
    };
    let mut restart_attempt = 0_u32;
    loop {
        if *state.resume_shutdown.borrow() {
            return;
        }
        publish_status(&state, SupervisorAvailability::Starting).await;
        let token = termloop_platform::generate_opaque_id();
        let environment = termloop_platform::LaunchEnvironment::isolated_process_baseline()
            .with_explicit(
                "TERMLOOP_COMPANION_CONTROL_URL",
                state.control_endpoint.as_ref(),
            )
            .with_explicit("TERMLOOP_COMPANION_TOKEN", &token);
        state.companion_credentials.issue(token.clone());
        state.companion_last_seen.observe();
        let spawned = {
            let executable = executable.clone();
            let process_directory = process_directory.clone();
            let working_directory = working_directory.clone();
            tokio::task::spawn_blocking(move || {
                termloop_platform::spawn_resolved_tracked_managed_process(
                    &executable,
                    &[],
                    &working_directory,
                    &process_directory,
                    "current",
                    &environment,
                )
            })
            .await
        };
        let mut process = match spawned {
            Ok(Ok(process)) => process,
            Ok(Err(error)) => {
                tracing::warn!(%error, "Companion process launch failed");
                state.companion_credentials.revoke(&token);
                publish_status(&state, SupervisorAvailability::Unavailable).await;
                if wait_for_restart(&state, restart_attempt).await {
                    return;
                }
                restart_attempt = restart_attempt.saturating_add(1);
                continue;
            }
            Err(error) => {
                tracing::warn!(%error, "Companion process launch task did not join");
                state.companion_credentials.revoke(&token);
                publish_status(&state, SupervisorAvailability::Unavailable).await;
                if wait_for_restart(&state, restart_attempt).await {
                    return;
                }
                restart_attempt = restart_attempt.saturating_add(1);
                continue;
            }
        };
        let mut monitor = tokio::time::interval(MONITOR_INTERVAL);
        monitor.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut shutdown = state.resume_shutdown.clone();
        let shutting_down = loop {
            tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break true;
                    }
                }
                _ = monitor.tick() => {
                    if state.companion_status.availability() == SupervisorAvailability::Available {
                        restart_attempt = 0;
                    }
                    match process.try_wait() {
                        Ok(Some(_)) => break false,
                        Ok(None) if state.companion_last_seen.overdue() => {
                            tracing::warn!("Companion heartbeat expired; replacing child");
                            break false;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(%error, "Companion process status is unavailable");
                            break false;
                        }
                    }
                }
            }
        };
        state.companion_credentials.revoke(&token);
        publish_status(&state, SupervisorAvailability::Unavailable).await;
        let _ = tokio::task::spawn_blocking(move || process.terminate()).await;
        if shutting_down || *state.resume_shutdown.borrow() {
            return;
        }
        if wait_for_restart(&state, restart_attempt).await {
            return;
        }
        restart_attempt = restart_attempt.saturating_add(1);
    }
}

async fn wait_for_restart(state: &AppState, attempt: u32) -> bool {
    let delay = restart_backoff(attempt);
    let mut shutdown = state.resume_shutdown.clone();
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        changed = shutdown.changed() => changed.is_err() || *shutdown.borrow(),
    }
}

fn restart_backoff(attempt: u32) -> Duration {
    let multiplier = 1_u32.checked_shl(attempt.min(4)).unwrap_or(16);
    Duration::from_millis(250_u64.saturating_mul(u64::from(multiplier))).min(MAX_RESTART_BACKOFF)
}

async fn publish_status(state: &AppState, availability: SupervisorAvailability) {
    if !state.companion_status.set(availability) {
        return;
    }
    let state_revision = state.core.lock().await.state_revision();
    let _ = state
        .invalidation_requests
        .try_send(super::invalidation::InvalidationRequest {
            topics: vec![termloop_contract::current::ProjectionTopic::Steward],
            state_revision,
            observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queue_is_project_deduplicated_bounded_and_timeout_idle() {
        let queue = CompanionWakeQueue::default();
        assert!(queue.enqueue("project-1".into(), CompanionWakeReason::PipelineMoved, 1, 1,));
        assert!(queue.enqueue("project-1".into(), CompanionWakeReason::UserMessage, 2, 1,));
        assert!(!queue.enqueue("project-2".into(), CompanionWakeReason::UserMessage, 1, 1,));
        let wake = queue.next(0).await;
        assert_eq!(wake.project_id.as_deref(), Some("project-1"));
        assert_eq!(wake.reason, Some(CompanionWakeReason::UserMessage));
        assert_eq!(wake.generation, 2);
        let in_flight = queue.in_flight_wake("project-1", 2).unwrap();
        assert_eq!(in_flight.reason, CompanionWakeReason::UserMessage);
        assert_eq!(queue.next(0).await.project_id.as_deref(), Some("project-1"));
        queue.acknowledge("project-1", 2, in_flight.wake_id);
        assert_eq!(queue.next(1).await.project_id, None);
    }

    #[tokio::test]
    async fn lower_priority_housekeeping_cannot_replace_a_pipeline_wake() {
        let queue = CompanionWakeQueue::default();
        assert!(queue.enqueue("project-1".into(), CompanionWakeReason::PipelineMoved, 2, 1));
        assert!(queue.enqueue(
            "project-1".into(),
            CompanionWakeReason::StartupRefresh,
            3,
            1,
        ));
        let wake = queue.next(0).await;
        assert_eq!(wake.reason, Some(CompanionWakeReason::PipelineMoved));
        assert_eq!(wake.generation, 3);
    }

    #[tokio::test]
    async fn pending_long_poll_is_notified_without_periodic_work() {
        let queue = CompanionWakeQueue::default();
        let waiter = tokio::spawn({
            let queue = queue.clone();
            async move { queue.next(5_000).await }
        });
        tokio::task::yield_now().await;
        assert!(queue.enqueue(
            "project-1".into(),
            CompanionWakeReason::StartupRefresh,
            3,
            1,
        ));
        let wake = waiter.await.unwrap();
        assert_eq!(wake.generation, 3);
    }

    #[tokio::test]
    async fn unacknowledged_wake_survives_child_reconnect_and_new_generation() {
        let queue = CompanionWakeQueue::default();
        assert!(queue.enqueue("project-1".into(), CompanionWakeReason::UserMessage, 1, 1,));
        assert_eq!(queue.next(0).await.generation, 1);
        assert_eq!(queue.next(0).await.generation, 1);
        assert!(queue.enqueue(
            "project-1".into(),
            CompanionWakeReason::ConfigurationChanged,
            2,
            1,
        ));
        let in_flight = queue.in_flight_wake("project-1", 1).unwrap();
        queue.acknowledge("project-1", 1, in_flight.wake_id);
        assert_eq!(queue.next(0).await.generation, 2);
        queue.discard("project-1");
        assert_eq!(queue.next(0).await.project_id, None);
    }

    #[tokio::test]
    async fn confirming_one_wake_cannot_consume_a_newer_wake_in_the_same_generation() {
        let queue = CompanionWakeQueue::default();
        assert!(queue.enqueue("project-1".into(), CompanionWakeReason::PipelineMoved, 2, 1,));
        assert_eq!(queue.next(0).await.generation, 2);
        let first = queue.in_flight_wake("project-1", 2).unwrap();

        assert!(queue.enqueue("project-1".into(), CompanionWakeReason::UserMessage, 2, 1,));
        queue.acknowledge("project-1", 2, first.wake_id);

        let next = queue.next(0).await;
        assert_eq!(next.reason, Some(CompanionWakeReason::UserMessage));
        let second = queue.in_flight_wake("project-1", 2).unwrap();
        assert_ne!(first.wake_id, second.wake_id);
    }

    #[tokio::test]
    async fn acknowledged_launch_wake_can_be_restored_after_process_failure() {
        let queue = CompanionWakeQueue::default();
        assert!(queue.enqueue(
            "project-1".into(),
            CompanionWakeReason::ConfigurationChanged,
            2,
            1,
        ));
        assert_eq!(queue.next(0).await.generation, 2);
        let in_flight = queue.in_flight_wake("project-1", 2).unwrap();
        queue.acknowledge("project-1", 2, in_flight.wake_id);
        assert_eq!(queue.next(0).await.project_id, None);

        assert!(queue.enqueue(
            "project-1".into(),
            CompanionWakeReason::ConfigurationChanged,
            2,
            1,
        ));
        let retried = queue.next(0).await;
        assert_eq!(retried.project_id.as_deref(), Some("project-1"));
        assert_eq!(retried.generation, 2);
    }

    #[test]
    fn configuration_refresh_preserves_current_routine_finding_demand() {
        assert_eq!(
            configuration_wake_reason(true),
            CompanionWakeReason::RoutineFinding
        );
        assert_eq!(
            configuration_wake_reason(false),
            CompanionWakeReason::ConfigurationChanged
        );
        assert_eq!(
            startup_wake_reason(true),
            CompanionWakeReason::RoutineFinding
        );
        assert_eq!(
            startup_wake_reason(false),
            CompanionWakeReason::StartupRefresh
        );
    }

    #[test]
    fn credential_rotation_rejects_stale_and_cross_token_revocation() {
        let registry = CompanionCredentialRegistry::default();
        registry.issue("a".repeat(32));
        assert!(registry.matches(&"a".repeat(32)));
        registry.issue("b".repeat(32));
        assert!(!registry.matches(&"a".repeat(32)));
        assert!(registry.matches(&"b".repeat(32)));
        registry.revoke(&"a".repeat(32));
        assert!(registry.matches(&"b".repeat(32)));
        registry.revoke(&"b".repeat(32));
        assert!(!registry.matches(&"b".repeat(32)));
    }

    #[test]
    fn restart_backoff_is_exponential_and_hard_capped() {
        assert_eq!(restart_backoff(0), Duration::from_millis(250));
        assert_eq!(restart_backoff(1), Duration::from_millis(500));
        assert_eq!(restart_backoff(4), Duration::from_secs(4));
        assert_eq!(restart_backoff(u32::MAX), Duration::from_secs(4));
        assert!(restart_backoff(u32::MAX) <= MAX_RESTART_BACKOFF);
    }
}
