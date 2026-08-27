use std::collections::VecDeque;
use std::future::Future;
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex as StdMutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, MutexGuard, watch};

const CORE_LOCK_STALL_THRESHOLD: Duration = Duration::from_secs(1);
const CORE_LOCK_STALL_REPORT_INTERVAL: Duration = Duration::from_secs(5);
const CORE_LOCK_WATCH_INTERVAL: Duration = Duration::from_millis(250);
const CORE_LOCK_FATAL_THRESHOLD: Duration = Duration::from_secs(30);
const SLOW_OPERATION_THRESHOLD: Duration = Duration::from_secs(5);
const MAX_TRACKED_WAITERS: usize = 256;

tokio::task_local! {
    static OPERATION_CONTEXT: OperationContext;
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct OperationContext {
    channel: &'static str,
    role: &'static str,
    operation: Arc<str>,
}

impl OperationContext {
    fn background() -> Self {
        Self {
            channel: "background",
            role: "internal",
            operation: Arc::from("background"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SourceLocation {
    file: &'static str,
    line: u32,
}

impl SourceLocation {
    #[track_caller]
    fn caller() -> Self {
        let caller = std::panic::Location::caller();
        Self {
            file: caller.file(),
            line: caller.line(),
        }
    }
}

#[derive(Clone)]
struct Actor {
    id: u64,
    context: OperationContext,
    source: SourceLocation,
    started_at: Instant,
}

#[derive(Default)]
struct TelemetryState {
    next_id: u64,
    owner: Option<Actor>,
    waiters: VecDeque<Actor>,
    waiter_count: usize,
}

#[derive(Default)]
struct CoreLockTelemetry {
    state: StdMutex<TelemetryState>,
}

impl CoreLockTelemetry {
    fn begin_wait(
        self: &Arc<Self>,
        context: OperationContext,
        source: SourceLocation,
    ) -> WaitRegistration {
        let mut state = self.lock_state();
        state.next_id = state.next_id.wrapping_add(1).max(1);
        let id = state.next_id;
        state.waiter_count = state.waiter_count.saturating_add(1);
        if state.waiters.len() < MAX_TRACKED_WAITERS {
            state.waiters.push_back(Actor {
                id,
                context: context.clone(),
                source,
                started_at: Instant::now(),
            });
        }
        drop(state);
        WaitRegistration {
            telemetry: self.clone(),
            id,
            context,
            source,
            started_at: Instant::now(),
            active: true,
        }
    }

    fn acquired(&self, id: u64, context: OperationContext, source: SourceLocation) {
        let mut state = self.lock_state();
        state.waiter_count = state.waiter_count.saturating_sub(1);
        state.waiters.retain(|waiter| waiter.id != id);
        state.owner = Some(Actor {
            id,
            context,
            source,
            started_at: Instant::now(),
        });
    }

    fn cancel_wait(&self, id: u64) {
        let mut state = self.lock_state();
        state.waiter_count = state.waiter_count.saturating_sub(1);
        state.waiters.retain(|waiter| waiter.id != id);
    }

    fn release(&self, id: u64) {
        let mut state = self.lock_state();
        if state.owner.as_ref().is_some_and(|owner| owner.id == id) {
            state.owner = None;
        }
    }

    fn snapshot(&self) -> LockSnapshot {
        let state = self.lock_state();
        let now = Instant::now();
        LockSnapshot {
            owner: state.owner.as_ref().map(|owner| ActorSnapshot {
                id: owner.id,
                context: owner.context.clone(),
                source: owner.source,
                elapsed: now.saturating_duration_since(owner.started_at),
            }),
            oldest_waiter: state.waiters.front().map(|waiter| ActorSnapshot {
                id: waiter.id,
                context: waiter.context.clone(),
                source: waiter.source,
                elapsed: now.saturating_duration_since(waiter.started_at),
            }),
            waiter_count: state.waiter_count,
            tracked_waiter_count: state.waiters.len(),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, TelemetryState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct WaitRegistration {
    telemetry: Arc<CoreLockTelemetry>,
    id: u64,
    context: OperationContext,
    source: SourceLocation,
    started_at: Instant,
    active: bool,
}

impl WaitRegistration {
    fn acquired(mut self) -> AcquiredLock {
        let waited = self.started_at.elapsed();
        self.telemetry
            .acquired(self.id, self.context.clone(), self.source);
        self.active = false;
        AcquiredLock {
            id: self.id,
            context: self.context.clone(),
            source: self.source,
            waited,
            acquired_at: Instant::now(),
        }
    }
}

impl Drop for WaitRegistration {
    fn drop(&mut self) {
        if self.active {
            self.telemetry.cancel_wait(self.id);
        }
    }
}

struct AcquiredLock {
    id: u64,
    context: OperationContext,
    source: SourceLocation,
    waited: Duration,
    acquired_at: Instant,
}

#[derive(Clone)]
struct ActorSnapshot {
    id: u64,
    context: OperationContext,
    source: SourceLocation,
    elapsed: Duration,
}

struct LockSnapshot {
    owner: Option<ActorSnapshot>,
    oldest_waiter: Option<ActorSnapshot>,
    waiter_count: usize,
    tracked_waiter_count: usize,
}

#[derive(Clone)]
pub(super) struct CoreProjectionSnapshot {
    state_revision: Arc<AtomicU64>,
    observation_sequence: Arc<AtomicU64>,
}

impl CoreProjectionSnapshot {
    pub(super) fn new(
        state_revision: u64,
        current_observation_sequence: u64,
        observation_sequence: Arc<AtomicU64>,
    ) -> Self {
        observation_sequence.fetch_max(current_observation_sequence, Ordering::Relaxed);
        Self {
            state_revision: Arc::new(AtomicU64::new(state_revision)),
            observation_sequence,
        }
    }

    fn update(&self, state_revision: u64, observation_sequence: u64) {
        self.state_revision
            .fetch_max(state_revision, Ordering::Release);
        self.observation_sequence
            .fetch_max(observation_sequence, Ordering::Release);
    }

    pub(super) fn state_revision(&self) -> u64 {
        self.state_revision.load(Ordering::Acquire)
    }

    pub(super) fn observation_sequence(&self) -> u64 {
        self.observation_sequence.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CoreLockHealth {
    pub(super) held_milliseconds: u64,
    pub(super) waiter_count: usize,
    pub(super) tracked_waiter_count: usize,
    pub(super) owner_channel: Option<&'static str>,
    pub(super) owner_role: Option<&'static str>,
    pub(super) owner_operation: Option<String>,
    pub(super) fatal: bool,
}

type CoreProjectionObserver<T> = (CoreProjectionSnapshot, fn(&T) -> (u64, u64));

pub(super) struct MonitoredMutex<T> {
    inner: Arc<Mutex<T>>,
    telemetry: Arc<CoreLockTelemetry>,
    projection: Option<CoreProjectionObserver<T>>,
}

impl<T> Clone for MonitoredMutex<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            telemetry: self.telemetry.clone(),
            projection: self.projection.clone(),
        }
    }
}

impl<T> MonitoredMutex<T> {
    #[cfg(test)]
    pub(super) fn new(value: T) -> Self {
        Self {
            inner: Arc::new(Mutex::new(value)),
            telemetry: Arc::new(CoreLockTelemetry::default()),
            projection: None,
        }
    }

    pub(super) fn new_with_projection(
        value: T,
        projection: CoreProjectionSnapshot,
        extractor: fn(&T) -> (u64, u64),
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(value)),
            telemetry: Arc::new(CoreLockTelemetry::default()),
            projection: Some((projection, extractor)),
        }
    }

    #[track_caller]
    pub(super) fn lock(&self) -> impl Future<Output = MonitoredMutexGuard<'_, T>> + '_ {
        let source = SourceLocation::caller();
        let context = OPERATION_CONTEXT
            .try_with(Clone::clone)
            .unwrap_or_else(|_| OperationContext::background());
        async move {
            let waiting = self.telemetry.begin_wait(context, source);
            let guard = self.inner.lock().await;
            let acquired = waiting.acquired();
            if acquired.waited >= CORE_LOCK_STALL_THRESHOLD {
                tracing::warn!(
                    event = "core_lock_wait",
                    channel = acquired.context.channel,
                    role = acquired.context.role,
                    operation = %acquired.context.operation,
                    source_file = acquired.source.file,
                    source_line = acquired.source.line,
                    wait_ms = duration_ms(acquired.waited),
                    "core lock acquisition exceeded the stall threshold"
                );
            }
            MonitoredMutexGuard {
                guard: Some(guard),
                telemetry: self.telemetry.clone(),
                acquired,
                projection: self.projection.clone(),
            }
        }
    }

    pub(super) fn health(&self) -> CoreLockHealth {
        let snapshot = self.telemetry.snapshot();
        let held = snapshot
            .owner
            .as_ref()
            .map(|owner| owner.elapsed)
            .unwrap_or_default();
        CoreLockHealth {
            held_milliseconds: duration_ms(held),
            waiter_count: snapshot.waiter_count,
            tracked_waiter_count: snapshot.tracked_waiter_count,
            owner_channel: snapshot.owner.as_ref().map(|owner| owner.context.channel),
            owner_role: snapshot.owner.as_ref().map(|owner| owner.context.role),
            owner_operation: snapshot
                .owner
                .as_ref()
                .map(|owner| owner.context.operation.to_string()),
            fatal: held >= CORE_LOCK_FATAL_THRESHOLD,
        }
    }

    pub(super) async fn watch_stalls(
        self,
        mut shutdown: watch::Receiver<bool>,
        resume_stall_marker_path: Arc<PathBuf>,
    ) {
        let mut interval = tokio::time::interval(CORE_LOCK_WATCH_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        let mut last_reported_owner = None::<(u64, Instant)>;
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let snapshot = self.telemetry.snapshot();
                    let Some(owner) = snapshot.owner else {
                        last_reported_owner = None;
                        continue;
                    };
                    if owner.elapsed < CORE_LOCK_STALL_THRESHOLD {
                        continue;
                    }
                    if owner.elapsed >= CORE_LOCK_FATAL_THRESHOLD {
                        tracing::error!(
                            event = "core_lock_fatal_stall",
                            owner_channel = owner.context.channel,
                            owner_role = owner.context.role,
                            owner_operation = %owner.context.operation,
                            owner_source_file = owner.source.file,
                            owner_source_line = owner.source.line,
                            held_ms = duration_ms(owner.elapsed),
                            waiter_count = snapshot.waiter_count,
                            "serialized core lock is unrecoverably stalled; terminating for supervisor recovery"
                        );
                        if let Some(session_id) = resume_session_id(&owner.context.operation) {
                            let marker = serde_json::to_vec(&serde_json::json!({
                                "version": 1,
                                "sessionId": session_id,
                            }))
                            .expect("resume stall marker is serializable");
                            if let Err(error) = termloop_platform::atomic_replace_private_file(
                                resume_stall_marker_path.as_ref(),
                                &marker,
                            ) {
                                tracing::error!(%error, "failed to persist the resume stall quarantine marker");
                            }
                        }
                        termloop_platform::terminate_for_unrecoverable_runtime_stall();
                    }
                    let now = Instant::now();
                    let should_report = last_reported_owner.is_none_or(|(owner_id, reported_at)| {
                        owner_id != owner.id
                            || now.saturating_duration_since(reported_at)
                                >= CORE_LOCK_STALL_REPORT_INTERVAL
                    });
                    if !should_report {
                        continue;
                    }
                    last_reported_owner = Some((owner.id, now));
                    let oldest = snapshot.oldest_waiter;
                    tracing::warn!(
                        event = "core_lock_stall",
                        owner_channel = owner.context.channel,
                        owner_role = owner.context.role,
                        owner_operation = %owner.context.operation,
                        owner_source_file = owner.source.file,
                        owner_source_line = owner.source.line,
                        held_ms = duration_ms(owner.elapsed),
                        waiter_count = snapshot.waiter_count,
                        tracked_waiter_count = snapshot.tracked_waiter_count,
                        oldest_waiter_channel = oldest.as_ref().map(|waiter| waiter.context.channel).unwrap_or("none"),
                        oldest_waiter_role = oldest.as_ref().map(|waiter| waiter.context.role).unwrap_or("none"),
                        oldest_waiter_operation = %oldest.as_ref().map(|waiter| waiter.context.operation.as_ref()).unwrap_or("none"),
                        oldest_waiter_source_file = oldest.as_ref().map(|waiter| waiter.source.file).unwrap_or("none"),
                        oldest_waiter_source_line = oldest.as_ref().map(|waiter| waiter.source.line).unwrap_or(0),
                        oldest_wait_ms = oldest.as_ref().map(|waiter| duration_ms(waiter.elapsed)).unwrap_or(0),
                        "serialized core lock remains held"
                    );
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return;
                    }
                }
            }
        }
    }

    #[cfg(test)]
    fn snapshot(&self) -> LockSnapshot {
        self.telemetry.snapshot()
    }
}

fn resume_session_id(operation: &str) -> Option<&str> {
    let session_id = operation.strip_prefix("session.resumeAgent:")?;
    (!session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then_some(session_id)
}

pub(super) struct MonitoredMutexGuard<'a, T> {
    guard: Option<MutexGuard<'a, T>>,
    telemetry: Arc<CoreLockTelemetry>,
    acquired: AcquiredLock,
    projection: Option<CoreProjectionObserver<T>>,
}

impl<T> Deref for MonitoredMutexGuard<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        self.guard.as_deref().expect("monitored mutex guard")
    }
}

impl<T> DerefMut for MonitoredMutexGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard.as_deref_mut().expect("monitored mutex guard")
    }
}

impl<T> Drop for MonitoredMutexGuard<'_, T> {
    fn drop(&mut self) {
        if let Some((projection, extractor)) = &self.projection
            && let Some(guard) = self.guard.as_deref()
        {
            let (state_revision, observation_sequence) = extractor(guard);
            projection.update(state_revision, observation_sequence);
        }
        self.guard.take();
        let held = self.acquired.acquired_at.elapsed();
        self.telemetry.release(self.acquired.id);
        if held >= CORE_LOCK_STALL_THRESHOLD {
            tracing::warn!(
                event = "core_lock_hold",
                channel = self.acquired.context.channel,
                role = self.acquired.context.role,
                operation = %self.acquired.context.operation,
                source_file = self.acquired.source.file,
                source_line = self.acquired.source.line,
                held_ms = duration_ms(held),
                "core lock hold exceeded the stall threshold"
            );
        }
    }
}

pub(super) async fn in_operation<T>(
    channel: &'static str,
    role: &'static str,
    operation: Arc<str>,
    future: impl Future<Output = T>,
) -> T {
    OPERATION_CONTEXT
        .scope(
            OperationContext {
                channel,
                role,
                operation,
            },
            future,
        )
        .await
}

pub(super) fn record_operation_duration(
    channel: &'static str,
    role: &'static str,
    operation: &str,
    elapsed: Duration,
) {
    // Companion wake is an intentional long poll. Reporting each empty poll as
    // a slow request hides actual gateway and core stalls in operational logs.
    if channel == "control" && operation == "companion.wakeNext" {
        return;
    }
    if elapsed >= SLOW_OPERATION_THRESHOLD {
        tracing::warn!(
            event = "slow_operation",
            channel,
            role,
            operation,
            elapsed_ms = duration_ms(elapsed),
            "operation exceeded the slow-request threshold"
        );
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn owner_and_waiter_snapshots_keep_operation_and_call_site() {
        let lock = MonitoredMutex::new(7_u8);
        let owner = in_operation("control", "full", Arc::from("task.list"), async {
            lock.lock().await
        })
        .await;
        let waiting_lock = lock.clone();
        let waiter = tokio::spawn(async move {
            in_operation("mcp", "steward", Arc::from("task_create"), async move {
                let guard = waiting_lock.lock().await;
                *guard
            })
            .await
        });
        for _ in 0..20 {
            if lock.snapshot().waiter_count == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
        let snapshot = lock.snapshot();
        let owner_snapshot = snapshot.owner.expect("owner is tracked");
        assert_eq!(owner_snapshot.context.operation.as_ref(), "task.list");
        assert!(owner_snapshot.source.file.ends_with("core_lock.rs"));
        let waiter_snapshot = snapshot.oldest_waiter.expect("waiter is tracked");
        assert_eq!(waiter_snapshot.context.operation.as_ref(), "task_create");
        assert_eq!(snapshot.waiter_count, 1);
        drop(owner);
        assert_eq!(waiter.await.unwrap(), 7);
    }

    #[tokio::test]
    async fn releasing_a_guard_updates_the_lock_free_projection() {
        let observation_sequence = Arc::new(AtomicU64::new(2));
        let projection = CoreProjectionSnapshot::new(1, 2, observation_sequence);
        let lock =
            MonitoredMutex::new_with_projection((1_u64, 2_u64), projection.clone(), |value| *value);
        {
            let mut value = lock.lock().await;
            *value = (7, 11);
        }
        assert_eq!(projection.state_revision(), 7);
        assert_eq!(projection.observation_sequence(), 11);
    }

    #[test]
    fn waiter_detail_is_bounded_while_total_count_remains_visible() {
        let telemetry = Arc::new(CoreLockTelemetry::default());
        let registrations = (0..(MAX_TRACKED_WAITERS + 20))
            .map(|_| telemetry.begin_wait(OperationContext::background(), SourceLocation::caller()))
            .collect::<Vec<_>>();
        let snapshot = telemetry.snapshot();
        assert_eq!(snapshot.waiter_count, MAX_TRACKED_WAITERS + 20);
        assert_eq!(snapshot.tracked_waiter_count, MAX_TRACKED_WAITERS);
        drop(registrations);
        assert_eq!(telemetry.snapshot().waiter_count, 0);
    }

    #[test]
    fn only_an_exact_bounded_resume_operation_yields_a_quarantine_identity() {
        assert_eq!(
            resume_session_id("session.resumeAgent:session-123"),
            Some("session-123")
        );
        assert_eq!(resume_session_id("session.resumeAgent"), None);
        assert_eq!(resume_session_id("session.resumeAgent:../../state"), None);
        assert_eq!(
            resume_session_id(&format!("session.resumeAgent:{}", "a".repeat(129))),
            None
        );
    }
}
