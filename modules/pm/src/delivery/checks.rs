//! Delivery checks: a short-lived agent the daemon starts to find out where
//! one ticket's change runs. The PM store records each check so the board
//! shows which tickets are being checked, one ticket never has two at once,
//! and a check that never reports is abandoned after a deadline. Which
//! tickets are due for one is derived on every read.
//!
//! A ticket is due when it has check reasons (see `check_reasons`), or when
//! an approved agent-matcher probe's output changed after the ticket was
//! last looked at while the ticket is merged or deployed short of
//! production. Only a project that tracks deployments has checks.

use super::TicketDelivery;
use super::facts::TicketDeliveryFacts;
use super::probe::{DeliveryProbe, ProbeMatcher, ProbeStatus};
use super::stage::DeliveryStageKind;
use crate::ticket::stored_names;
use crate::valid_environment_name;
use crate::validation::valid_id;

/// A check that has not reported by then is abandoned.
pub const CHECK_DEADLINE_MS: u64 = 20 * 60 * 1_000;
/// After a check that ended without explaining the check reasons, the same
/// reasons ask again only after this long.
pub const CHECK_RETRY_AFTER_MS: u64 = 60 * 60 * 1_000;
/// Checks one project may run at once.
pub const PROJECT_RUNNING_CHECKS_MAX: usize = 8;
/// Finished checks kept per ticket; older ones are dropped.
pub const TICKET_FINISHED_CHECKS_MAX: usize = 20;
/// Environments one check is asked about.
pub const CHECK_ENVIRONMENTS_MAX: usize = 12;

/// Why a check was started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryCheckReason {
    /// The ticket's check reasons: environments nothing answers yet.
    CheckReasons,
    /// An agent-matcher probe's output changed.
    ProbeChanged,
    /// The PM asked for one.
    Requested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryCheckOutcome {
    /// The agent's report was recorded.
    Reported,
    /// The agent ended without a report.
    Failed,
    /// No report before the deadline, or the daemon gave up on it.
    Abandoned,
}

stored_names!(DeliveryCheckReason {
    CheckReasons => "checkReasons",
    ProbeChanged => "probeChanged",
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
    pub reason: DeliveryCheckReason,
    /// The environments the check is asked about.
    pub environments: Vec<String>,
    /// The agent-matcher probe whose changed output started it.
    pub probe_id: Option<String>,
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
            && valid_check_environments(&self.environments)
            && self.probe_id.as_deref().is_none_or(valid_id)
            && (self.reason == DeliveryCheckReason::ProbeChanged) == self.probe_id.is_some()
            && self.finished_at_epoch_ms.is_some() == self.outcome.is_some()
            && self
                .finished_at_epoch_ms
                .is_none_or(|finished| finished >= self.started_at_epoch_ms)
    }
}

pub fn valid_check_environments(environments: &[String]) -> bool {
    environments.len() <= CHECK_ENVIRONMENTS_MAX
        && environments.iter().enumerate().all(|(index, name)| {
            valid_environment_name(name)
                && !environments[index + 1..]
                    .iter()
                    .any(|other| other.eq_ignore_ascii_case(name))
        })
}

/// A check the daemon should start: what to ask and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueCheck {
    pub ticket_id: String,
    pub reason: DeliveryCheckReason,
    pub environments: Vec<String>,
    pub probe_id: Option<String>,
    /// The check reasons, for the agent's first message and the board.
    pub details: Vec<String>,
}

/// What one ticket's due decision reads.
pub(crate) struct DueInputs<'a> {
    pub delivery: &'a TicketDelivery,
    pub facts: Option<&'a TicketDeliveryFacts>,
    pub probes: &'a [DeliveryProbe],
    /// The project's environment names in delivery order.
    pub environments: &'a [String],
    /// The ticket is in the active sprint.
    pub in_active_sprint: bool,
    /// The ticket's newest check, running or finished.
    pub last_check: Option<&'a DeliveryCheck>,
    pub now_epoch_ms: u64,
}

/// Whether one ticket is due for a check, and which. A running check means
/// not due. A changed agent probe comes first: it names what to look at.
pub(crate) fn due_check(inputs: DueInputs<'_>) -> Option<DueCheck> {
    let DueInputs {
        delivery,
        facts,
        probes,
        environments,
        in_active_sprint,
        last_check,
        now_epoch_ms,
    } = inputs;
    if last_check.is_some_and(DeliveryCheck::is_running) || !in_active_sprint {
        return None;
    }
    let short_of_production = matches!(
        delivery.stage.kind,
        DeliveryStageKind::Merged | DeliveryStageKind::Deployed
    );
    // The newest moment anything looked at the ticket's environments.
    let looked_at = facts
        .and_then(|facts| facts.check_notes.as_ref())
        .map(|notes| notes.recorded_at_epoch_ms)
        .max(last_check.map(|check| check.started_at_epoch_ms))
        .unwrap_or(0);
    if short_of_production {
        let changed_probe = probes.iter().find(|probe| {
            probe.status == ProbeStatus::Approved
                && probe.matcher == ProbeMatcher::Agent
                && probe
                    .last_run
                    .as_ref()
                    .and_then(|run| run.changed_at_epoch_ms)
                    .is_some_and(|changed| changed > looked_at)
        });
        if let Some(probe) = changed_probe {
            return Some(DueCheck {
                ticket_id: delivery.ticket_id.clone(),
                reason: DeliveryCheckReason::ProbeChanged,
                environments: vec![probe.environment.clone()],
                probe_id: Some(probe.id.clone()),
                details: vec![format!("The {} probe's output changed", probe.environment)],
            });
        }
    }
    if delivery.check_reasons.is_empty() {
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
    let deployed = |name: &str| {
        facts
            .and_then(|facts| facts.environment(name))
            .is_some_and(|fact| fact.state == super::facts::EnvironmentDeployState::Deployed)
    };
    Some(DueCheck {
        ticket_id: delivery.ticket_id.clone(),
        reason: DeliveryCheckReason::CheckReasons,
        environments: environments
            .iter()
            .filter(|name| !deployed(name))
            .take(CHECK_ENVIRONMENTS_MAX)
            .cloned()
            .collect(),
        probe_id: None,
        details: delivery.check_reasons.clone(),
    })
}
