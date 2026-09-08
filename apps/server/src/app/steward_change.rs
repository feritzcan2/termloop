use std::sync::atomic::Ordering;

use serde_json::json;
use termloop_contract::current::ProjectionTopic;
use termloop_core::CommittedStewardChange;

use super::AppState;
use super::invalidation::{InvalidationRequest, queue_invalidation};

/// Complete the effects of a successful configuration commit in one order.
/// A process cleanup failure cannot undo the commit or suppress its wake.
pub(super) async fn finish_steward_change(state: &AppState, change: CommittedStewardChange) {
    if change.changed() {
        queue_invalidation(
            &state.invalidation_requests,
            InvalidationRequest {
                topics: vec![ProjectionTopic::Steward],
                state_revision: change.state_revision(),
                observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
            },
        )
        .await;
    }
    if let Some(session_id) = change.retired_session_id() {
        if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
            capabilities.revoke_session(session_id);
        }
        let _ = super::control::terminate_session(json!({"sessionId": session_id}), state).await;
    }
    if change.changed() || change.needs_wake() {
        super::companion_supervisor::replace_committed_steward_wake(state, &change).await;
    }
}
