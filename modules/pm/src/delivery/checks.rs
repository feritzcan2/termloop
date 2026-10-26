//! Delivery checks: a short-lived agent the daemon starts to tell whether
//! one ticket passed one Playbook step, following that step's instructions.
//! The PM store records each check so the board shows which tickets are
//! being checked, one ticket never has two at once, and a check that never
//! reports is abandoned after a deadline. Which tickets are due for one is
//! derived on every read.
//!
//! A ticket of the active sprint is due when its next step is agent-checked,
//! its facts did not pass that step, and the step's last answer asked to look
//! again by now (see [`crate::playbook::agent_step_due`]).

use crate::playbook::{Playbook, TicketPlaybook, agent_step_due};
use crate::ticket::stored_names;
use crate::validation::valid_id;

/// A check that has not reported by then is abandoned.
pub const CHECK_DEADLINE_MS: u64 = 20 * 60 * 1_000;
/// After a check that ended without a verdict, the step asks again only
/// after this long.
pub const CHECK_RETRY_AFTER_MS: u64 = 60 * 60 * 1_000;
/// Checks one project may run at once.
pub const PROJECT_RUNNING_CHECKS_MAX: usize = 8;
/// Finished checks kept per ticket; older ones are dropped.
pub const TICKET_FINISHED_CHECKS_MAX: usize = 20;

/// Why a check was started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryCheckReason {
    /// The ticket's next step was due for a look.
    Due,
    /// The PM asked for one.
    Requested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryCheckOutcome {
    /// The agent's verdict was recorded.
    Reported,
    /// The agent ended without a verdict.
    Failed,
    /// No verdict before the deadline, or the daemon gave up on it.
    Abandoned,
}

stored_names!(DeliveryCheckReason {
    Due => "due",
    Requested => "requested",
});
stored_names!(DeliveryCheckOutcome {
    Reported => "reported",
    Failed => "failed",
    Abandoned => "abandoned",
});

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeliveryCheck {
    pub id: String,
    pub project_id: String,
    pub ticket_id: String,
    /// The Playbook step the check looks at.
    pub step_id: String,
    pub reason: DeliveryCheckReason,
    pub started_at_epoch_ms: u64,
    pub finished_at_epoch_ms: Option<u64>,
    pub outcome: Option<DeliveryCheckOutcome>,
}

impl DeliveryCheck {
    pub fn is_running(&self) -> bool {
        self.finished_at_epoch_ms.is_none()
    }

    pub fn is_valid(&self) -> bool {
        valid_id(&self.id)
            && valid_id(&self.project_id)
            && valid_id(&self.ticket_id)
            && valid_id(&self.step_id)
            && self.finished_at_epoch_ms.is_some() == self.outcome.is_some()
            && self
                .finished_at_epoch_ms
                .is_none_or(|finished| finished >= self.started_at_epoch_ms)
    }
}

/// A check the daemon should start: which ticket and step.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueCheck {
    pub ticket_id: String,
    pub step_id: String,
    pub reason: DeliveryCheckReason,
}

/// What one ticket's due decision reads.
pub(crate) struct DueInputs<'a> {
    pub ticket_id: &'a str,
    pub playbook: &'a Playbook,
    pub progress: &'a TicketPlaybook,
    /// The ticket is in the active sprint.
    pub in_active_sprint: bool,
    /// The ticket's newest check, running or finished.
    pub last_check: Option<&'a DeliveryCheck>,
    pub now_epoch_ms: u64,
}

/// Whether one ticket is due for a check of its next step. A running check
/// means not due; so does a check that ended without a verdict lately.
pub(crate) fn due_check(inputs: DueInputs<'_>) -> Option<DueCheck> {
    let DueInputs {
        ticket_id,
        playbook,
        progress,
        in_active_sprint,
        last_check,
        now_epoch_ms,
    } = inputs;
    if !in_active_sprint || last_check.is_some_and(DeliveryCheck::is_running) {
        return None;
    }
    let retry_waiting = last_check.is_some_and(|check| {
        check.outcome != Some(DeliveryCheckOutcome::Reported)
            && check
                .finished_at_epoch_ms
                .is_some_and(|finished| now_epoch_ms < finished + CHECK_RETRY_AFTER_MS)
    });
    if retry_waiting {
        return None;
    }
    let step = agent_step_due(playbook, progress, now_epoch_ms)?;
    Some(DueCheck {
        ticket_id: ticket_id.to_owned(),
        step_id: step.id.clone(),
        reason: DeliveryCheckReason::Due,
    })
}
