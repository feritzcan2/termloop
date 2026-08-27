//! Runtime keep-awake supervision.
//!
//! Core owns the durable preference and decides whether a hold is *wanted*.
//! This module owns the single process-wide OS hold that answers it, and the
//! runtime facts a client needs to render an honest state.
//!
//! The hold lives in the daemon rather than the desktop on purpose: agents
//! keep running when no window is open, and they can be launched from clients
//! that have no window at all.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};

use termloop_contract::current::{
    KeepAwakeLimitation, KeepAwakeMode, KeepAwakeReason, KeepAwakeState, KeepAwakeStatusResult,
    ProjectionTopic,
};
use termloop_platform::{
    KeepAwakeError, KeepAwakeHold, KeepAwakeOverride, KeepAwakeRequest, keep_awake_overrides,
    keep_awake_supported, release_stale_keep_awake,
};
use tokio::sync::broadcast;
use tokio::time::{Duration, MissedTickBehavior};

use super::AppState;
use super::invalidation::InvalidationRequest;

#[derive(Clone, Default)]
pub(super) struct KeepAwakeSupervisor {
    inner: Arc<Mutex<HoldState>>,
}

/// What core wanted, stamped with the durable revision it was read at.
///
/// The revision is the fence that makes concurrent reconciles safe: intents
/// are read under the core lock but applied after releasing it, so without it
/// a slow reader holding a stale "keep awake" could re-acquire the hold after
/// a newer write already turned the preference off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct KeepAwakeIntent {
    pub(super) wanted: bool,
    pub(super) keep_display_awake: bool,
    pub(super) state_revision: u64,
}

/// Why no hold is held, when one was wanted.
///
/// The two cases read very differently to a user: a host that has no mechanism
/// at all can never honor the setting, while a refusal is a condition that may
/// clear. A Linux build has a mechanism compiled in but still reports the
/// former when systemd-logind is absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HoldFailure {
    NoMechanism,
    Refused,
}

#[derive(Default)]
struct HoldState {
    hold: Option<KeepAwakeHold>,
    /// The shape the live hold was taken with, so a changed display
    /// preference retakes it instead of silently keeping the previous one.
    keeps_display_awake: bool,
    /// How the most recent acquisition failed. Any success, or no longer
    /// wanting a hold, clears it.
    failure: Option<HoldFailure>,
    /// The revision of the newest intent already applied. Monotonic, so a
    /// later-arriving older intent is discarded rather than replayed.
    applied_revision: Option<u64>,
    /// Stale macOS clamshell cleanup is a transition/startup check, not a
    /// one-second polling task while policy remains off.
    stale_release_checked: bool,
}

impl KeepAwakeSupervisor {
    fn state(&self) -> MutexGuard<'_, HoldState> {
        // The guarded value is an owned OS handle plus a few flags. A panic
        // while holding it cannot leave them inconsistent, so recovering from
        // poisoning is preferable to losing the ability to release the hold.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Brings the OS hold in line with an intent core produced.
    ///
    /// Runs on a blocking worker: the Windows backend parks on a channel while
    /// its dedicated thread raises the request, and joins that thread on
    /// release, neither of which belongs on an async executor thread.
    pub(super) async fn apply(&self, intent: KeepAwakeIntent) {
        let supervisor = self.clone();
        let _ = tokio::task::spawn_blocking(move || supervisor.apply_blocking(intent)).await;
    }

    fn apply_blocking(&self, intent: KeepAwakeIntent) {
        let mut state = self.state();
        // Strictly older intents lost the race and must not be replayed. Equal
        // revisions are applied: the same revision can legitimately produce a
        // different intent when a Session process exits without a durable
        // write, and applying it is idempotent anyway.
        if state
            .applied_revision
            .is_some_and(|applied| applied > intent.state_revision)
        {
            return;
        }
        state.applied_revision = Some(intent.state_revision);
        let KeepAwakeIntent {
            wanted,
            keep_display_awake,
            ..
        } = intent;
        if !wanted {
            state.hold = None;
            if !state.stale_release_checked {
                match release_stale_keep_awake() {
                    Ok(complete) => state.stale_release_checked = complete,
                    Err(error) => {
                        tracing::warn!(%error, "a stale keep-awake override could not be released");
                        state.stale_release_checked = true;
                    }
                }
            }
            state.failure = None;
            return;
        }
        state.stale_release_checked = false;
        if state.hold.is_some() && state.keeps_display_awake == keep_display_awake {
            return;
        }
        // Release first so this process never overlaps two holds, and so a
        // display-preference change actually takes effect.
        state.hold = None;
        match KeepAwakeHold::acquire(KeepAwakeRequest { keep_display_awake }) {
            Ok(hold) => {
                state.hold = Some(hold);
                state.keeps_display_awake = keep_display_awake;
                state.failure = None;
            }
            Err(error) => {
                // Also reported through the status DTO; this line exists so an
                // operator can see the OS reason, which the DTO reduces to a
                // single typed value.
                tracing::warn!(%error, "the operating system refused a keep-awake hold");
                state.failure = Some(match error {
                    // A Linux build carries a mechanism but still has none at
                    // runtime when systemd-logind is missing.
                    KeepAwakeError::Unsupported => HoldFailure::NoMechanism,
                    KeepAwakeError::Undescribable | KeepAwakeError::Refused { .. } => {
                        HoldFailure::Refused
                    }
                });
            }
        }
    }

    /// Composes the client-facing status from the preference, the current
    /// Session projection, and the runtime hold.
    pub(super) fn status(
        &self,
        mode: KeepAwakeMode,
        keep_display_awake: bool,
        eligible_agent_count: u32,
        expires_at_epoch_ms: Option<u64>,
        now_epoch_ms: u64,
    ) -> KeepAwakeStatusResult {
        let (held, failure) = {
            let state = self.state();
            (state.hold.is_some(), state.failure)
        };
        // Order matters, and user intent comes first: someone who chose Off on
        // an unsupported host asked for nothing and should see their own
        // choice, not a platform complaint about a hold nobody wanted.
        let (resolved_state, reason) = if mode == KeepAwakeMode::Off {
            (KeepAwakeState::Inactive, Some(KeepAwakeReason::ModeOff))
        } else if expires_at_epoch_ms.is_some_and(|expires_at| expires_at <= now_epoch_ms) {
            (
                KeepAwakeState::Inactive,
                Some(KeepAwakeReason::TimerExpired),
            )
        } else if !keep_awake_supported() || failure == Some(HoldFailure::NoMechanism) {
            (
                KeepAwakeState::Unsupported,
                Some(KeepAwakeReason::UnsupportedPlatform),
            )
        } else if failure == Some(HoldFailure::Refused) {
            (KeepAwakeState::Failed, Some(KeepAwakeReason::PlatformError))
        } else if held {
            (KeepAwakeState::Active, None)
        } else {
            (
                KeepAwakeState::Inactive,
                Some(KeepAwakeReason::NoRunningAgents),
            )
        };
        KeepAwakeStatusResult {
            mode,
            keep_display_awake,
            state: resolved_state,
            eligible_agent_count,
            reason,
            expires_at_epoch_ms,
            limitations: limitations(),
        }
    }
}

/// What the OS can still override while a hold is active. These are properties
/// of the mechanism, not observations: holding an assertion never proves what
/// a closed lid will do, so the UI states them instead of promising uptime.
fn limitations() -> Vec<KeepAwakeLimitation> {
    keep_awake_overrides()
        .iter()
        .map(|value| match value {
            KeepAwakeOverride::LidClose => KeepAwakeLimitation::LidClose,
            KeepAwakeOverride::UserInitiatedSleep => KeepAwakeLimitation::UserInitiatedSleep,
            KeepAwakeOverride::LowBattery => KeepAwakeLimitation::LowBattery,
            KeepAwakeOverride::ThermalEmergency => KeepAwakeLimitation::ThermalEmergency,
        })
        .collect()
}

/// Reads core's current intent and applies it, returning the composed status.
///
/// Core is read under its serialized lock and the OS call happens after the
/// guard is dropped, so an assertion never runs while the core lock is held.
pub(super) async fn reconcile(state: &AppState) -> KeepAwakeStatusResult {
    let now_epoch_ms = super::current_epoch_ms();
    let (mode, eligible, expires_at_epoch_ms, intent) = {
        let mut core = state.core.lock().await;
        if let Err(error) = core.expire_keep_awake_timer(now_epoch_ms) {
            // Keep reporting the expired timer rather than pretending Off was
            // persisted. The next reconciliation retries the named command.
            tracing::warn!(%error, "the elapsed keep-awake timer could not be turned off");
        }
        let preference = core.keep_awake_preference();
        (
            contract_mode(preference.mode),
            u32::try_from(core.running_agent_session_count()).unwrap_or(u32::MAX),
            preference.expires_at_epoch_ms,
            KeepAwakeIntent {
                wanted: core.keep_awake_hold_is_wanted(now_epoch_ms),
                keep_display_awake: preference.keep_display_awake,
                state_revision: core.state_revision(),
            },
        )
    };
    state.keep_awake.apply(intent).await;
    state.keep_awake.status(
        mode,
        intent.keep_display_awake,
        eligible,
        expires_at_epoch_ms,
        now_epoch_ms,
    )
}

/// Keeps the OS hold in step with Session lifecycle.
///
/// Session-topic invalidation is the daemon's single choke point for "the set
/// of live Sessions may have changed" — launch, exit, resume, archive and
/// restore all pass through it — so one subscriber covers every path without
/// scattering hold management across command handlers.
pub(super) async fn supervise(state: AppState) {
    let mut invalidations = state.invalidations.subscribe();
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    timer.tick().await;
    // A daemon restart has no hold yet, so an `always` preference has to be
    // re-established before waiting for anything to happen.
    let mut published = reconcile(&state).await;
    loop {
        tokio::select! {
            result = invalidations.recv() => match result {
                Ok(payload) => {
                    if payload.topics.contains(&ProjectionTopic::Session) {
                        reconcile_and_publish(&state, &mut published).await;
                    }
                }
                // Dropped payloads may have contained the Session topic, so
                // reconcile rather than assume nothing changed. A lagging
                // subscriber here usually means the desktop lagged too, so the
                // change still has to be announced.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    reconcile_and_publish(&state, &mut published).await;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = timer.tick() => {
                reconcile_and_publish(&state, &mut published).await;
            }
        }
    }
}

/// Reconciles and, when the projection actually moved, announces it.
///
/// Session churn flips the hold without any client asking, so subscribers are
/// told when the status changed rather than on every Session event.
async fn reconcile_and_publish(state: &AppState, published: &mut KeepAwakeStatusResult) {
    let status = reconcile(state).await;
    if status == *published {
        return;
    }
    *published = status;
    let state_revision = state.core.lock().await.state_revision();
    publish_invalidation(state, state_revision).await;
}

/// Announces that the keep-awake projection changed so subscribed clients
/// re-read it. The payload carries no status of its own: clients read the
/// current value through `system.keepAwake.get`.
pub(super) async fn publish_invalidation(state: &AppState, state_revision: u64) {
    let request = InvalidationRequest {
        topics: vec![ProjectionTopic::KeepAwake],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    };
    let _ = state.invalidation_requests.send(request).await;
}

pub(super) fn contract_mode(mode: termloop_core::KeepAwakeMode) -> KeepAwakeMode {
    match mode {
        termloop_core::KeepAwakeMode::Off => KeepAwakeMode::Off,
        termloop_core::KeepAwakeMode::WhileAgentsRun => KeepAwakeMode::WhileAgentsRun,
        termloop_core::KeepAwakeMode::Always => KeepAwakeMode::Always,
    }
}

pub(super) fn core_mode(mode: &KeepAwakeMode) -> termloop_core::KeepAwakeMode {
    match mode {
        KeepAwakeMode::Off => termloop_core::KeepAwakeMode::Off,
        KeepAwakeMode::WhileAgentsRun => termloop_core::KeepAwakeMode::WhileAgentsRun,
        KeepAwakeMode::Always => termloop_core::KeepAwakeMode::Always,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(wanted: bool, keep_display_awake: bool, state_revision: u64) -> KeepAwakeIntent {
        KeepAwakeIntent {
            wanted,
            keep_display_awake,
            state_revision,
        }
    }

    /// Off is reported as a deliberate choice, on every host. An unsupported
    /// platform is not a complaint worth making about a hold nobody asked for.
    #[test]
    fn a_disabled_preference_holds_nothing_and_names_itself_as_the_reason() {
        let supervisor = KeepAwakeSupervisor::default();
        supervisor.apply_blocking(intent(false, false, 1));
        let status = supervisor.status(KeepAwakeMode::Off, false, 0, None, 0);
        assert_eq!(status.eligible_agent_count, 0);
        assert_eq!(status.state, KeepAwakeState::Inactive);
        assert_eq!(status.reason, Some(KeepAwakeReason::ModeOff));
    }

    /// An enabled preference with no agent running is inactive for that
    /// reason, not because anything failed.
    #[test]
    fn an_enabled_preference_without_agents_reports_no_running_agents() {
        let supervisor = KeepAwakeSupervisor::default();
        supervisor.apply_blocking(intent(false, false, 1));
        let status = supervisor.status(KeepAwakeMode::WhileAgentsRun, false, 0, None, 0);
        if keep_awake_supported() {
            assert_eq!(status.state, KeepAwakeState::Inactive);
            assert_eq!(status.reason, Some(KeepAwakeReason::NoRunningAgents));
        } else {
            assert_eq!(status.state, KeepAwakeState::Unsupported);
        }
    }

    #[test]
    fn a_wanted_hold_reports_active_and_releasing_returns_to_inactive() {
        let supervisor = KeepAwakeSupervisor::default();
        supervisor.apply_blocking(intent(true, false, 1));
        let active = supervisor.status(KeepAwakeMode::WhileAgentsRun, false, 2, None, 0);
        if !keep_awake_supported() {
            assert_eq!(active.state, KeepAwakeState::Unsupported);
            return;
        }
        assert_eq!(active.state, KeepAwakeState::Active);
        assert_eq!(active.reason, None);
        assert_eq!(active.eligible_agent_count, 2);

        supervisor.apply_blocking(intent(false, false, 2));
        let released = supervisor.status(KeepAwakeMode::WhileAgentsRun, false, 0, None, 0);
        assert_eq!(released.state, KeepAwakeState::Inactive);
        assert_eq!(released.reason, Some(KeepAwakeReason::NoRunningAgents));
    }

    #[test]
    fn an_expired_timer_reports_inactive_even_if_a_hold_is_present() {
        let supervisor = KeepAwakeSupervisor::default();
        supervisor.apply_blocking(intent(true, false, 1));
        let status = supervisor.status(KeepAwakeMode::Always, false, 0, Some(100), 100);
        assert_eq!(status.state, KeepAwakeState::Inactive);
        assert_eq!(status.reason, Some(KeepAwakeReason::TimerExpired));
        assert_eq!(status.expires_at_epoch_ms, Some(100));
    }

    /// The race the revision fence exists for: a reconcile that read "keep
    /// awake" before a newer write turned the preference off must not be able
    /// to re-acquire the hold when it finally lands.
    #[test]
    fn a_stale_intent_cannot_reacquire_a_hold_a_newer_write_released() {
        if !keep_awake_supported() {
            return;
        }
        let supervisor = KeepAwakeSupervisor::default();
        // A reader observed "keep awake" at revision 10 and has not applied it.
        let stale = intent(true, false, 10);
        // A newer write turned it off at revision 11 and applied first.
        supervisor.apply_blocking(intent(false, false, 11));
        assert_eq!(
            supervisor
                .status(KeepAwakeMode::Off, false, 0, None, 0)
                .state,
            KeepAwakeState::Inactive
        );

        supervisor.apply_blocking(stale);
        assert!(
            supervisor.state().hold.is_none(),
            "a stale intent re-acquired the hold after a newer release"
        );

        // The fence must not wedge the supervisor: the next current intent
        // still takes effect.
        supervisor.apply_blocking(intent(true, false, 12));
        assert_eq!(
            supervisor
                .status(KeepAwakeMode::WhileAgentsRun, false, 1, None, 0)
                .state,
            KeepAwakeState::Active
        );
    }

    /// Applying the same intent twice must not churn the OS assertion, and a
    /// changed display preference must actually retake it.
    #[test]
    fn repeated_apply_is_idempotent_and_a_display_change_retakes_the_hold() {
        if !keep_awake_supported() {
            return;
        }
        let supervisor = KeepAwakeSupervisor::default();
        supervisor.apply_blocking(intent(true, false, 1));
        supervisor.apply_blocking(intent(true, false, 1));
        assert!(!supervisor.state().keeps_display_awake);
        assert_eq!(
            supervisor
                .status(KeepAwakeMode::Always, false, 0, None, 0)
                .state,
            KeepAwakeState::Active
        );

        supervisor.apply_blocking(intent(true, true, 2));
        assert!(supervisor.state().keeps_display_awake);
        assert_eq!(
            supervisor
                .status(KeepAwakeMode::Always, true, 0, None, 0)
                .state,
            KeepAwakeState::Active
        );
    }

    /// The UI must always be able to tell the user what the OS can still do,
    /// and must not invent limitations on a host that has no mechanism.
    #[test]
    fn limitations_are_reported_exactly_when_the_host_is_supported() {
        // Which conditions apply is platform's fact, not the server's: this
        // asserts only that every one it reports survives the mapping.
        assert_eq!(limitations().is_empty(), !keep_awake_supported());
        assert_eq!(limitations().len(), keep_awake_overrides().len());
    }
}
