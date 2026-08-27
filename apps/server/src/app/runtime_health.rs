use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

use axum::{Json, extract::State};
use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Duration;

use super::{AppState, current_epoch_ms};

const MAX_CONTROL_IN_FLIGHT: usize = 128;

#[derive(Clone)]
pub(super) struct RuntimeHealth {
    inner: Arc<RuntimeHealthInner>,
}

struct RuntimeHealthInner {
    control_admission: Arc<Semaphore>,
    control_in_flight: AtomicUsize,
    control_rejected: AtomicU64,
    control_cancelled: AtomicU64,
    event_loop_heartbeat_epoch_ms: AtomicU64,
}

pub(super) struct ControlAdmissionPermit {
    health: RuntimeHealth,
    _permit: OwnedSemaphorePermit,
}

impl Drop for ControlAdmissionPermit {
    fn drop(&mut self) {
        self.health
            .inner
            .control_in_flight
            .fetch_sub(1, Ordering::AcqRel);
    }
}

impl RuntimeHealth {
    pub(super) fn new() -> Self {
        Self {
            inner: Arc::new(RuntimeHealthInner {
                control_admission: Arc::new(Semaphore::new(MAX_CONTROL_IN_FLIGHT)),
                control_in_flight: AtomicUsize::new(0),
                control_rejected: AtomicU64::new(0),
                control_cancelled: AtomicU64::new(0),
                event_loop_heartbeat_epoch_ms: AtomicU64::new(current_epoch_ms()),
            }),
        }
    }

    pub(super) fn try_admit_control(&self) -> Option<ControlAdmissionPermit> {
        let permit = match self.inner.control_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.inner.control_rejected.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        };
        self.inner.control_in_flight.fetch_add(1, Ordering::AcqRel);
        Some(ControlAdmissionPermit {
            health: self.clone(),
            _permit: permit,
        })
    }

    pub(super) fn record_control_cancelled(&self) {
        self.inner.control_cancelled.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) async fn run_heartbeat(self) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            self.inner
                .event_loop_heartbeat_epoch_ms
                .store(current_epoch_ms(), Ordering::Release);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeHealthResponse {
    status: &'static str,
    runtime_epoch: u64,
    state_revision: u64,
    observation_sequence: u64,
    event_loop_heartbeat_epoch_ms: u64,
    control_in_flight: usize,
    control_capacity: usize,
    control_rejected: u64,
    control_cancelled: u64,
    core_lock: super::core_lock::CoreLockHealth,
}

pub(super) async fn healthz(State(state): State<AppState>) -> Json<RuntimeHealthResponse> {
    let core_lock = state.core.health();
    let status = if core_lock.held_milliseconds >= 1_000 {
        "degraded"
    } else {
        "ok"
    };
    Json(RuntimeHealthResponse {
        status,
        runtime_epoch: state.runtime_epoch,
        state_revision: state.core_projection.state_revision(),
        observation_sequence: state.core_projection.observation_sequence(),
        event_loop_heartbeat_epoch_ms: state
            .runtime_health
            .inner
            .event_loop_heartbeat_epoch_ms
            .load(Ordering::Acquire),
        control_in_flight: state
            .runtime_health
            .inner
            .control_in_flight
            .load(Ordering::Acquire),
        control_capacity: MAX_CONTROL_IN_FLIGHT,
        control_rejected: state
            .runtime_health
            .inner
            .control_rejected
            .load(Ordering::Relaxed),
        control_cancelled: state
            .runtime_health
            .inner
            .control_cancelled
            .load(Ordering::Relaxed),
        core_lock,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_admission_is_bounded_and_recovers_capacity_on_drop() {
        let health = RuntimeHealth::new();
        let permits = (0..MAX_CONTROL_IN_FLIGHT)
            .map(|_| health.try_admit_control().expect("capacity is available"))
            .collect::<Vec<_>>();
        assert!(health.try_admit_control().is_none());
        drop(permits);
        assert!(health.try_admit_control().is_some());
    }
}
