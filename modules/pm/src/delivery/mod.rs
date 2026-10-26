//! Delivery: what the PM observes about each ticket on its way to done, and
//! what is derived from it on every read (where it stands on the Playbook,
//! risks, data tier). Only observations and verdicts are stored.

pub(crate) mod checks;
pub(crate) mod facts;
pub(crate) mod risks;
pub(crate) mod tracking;

use facts::{FactSource, TicketDeliveryFacts};
use risks::{DeliveryRisk, RiskInputs, delivery_risks};

use crate::playbook::{Playbook, StepVerdictRecord, TicketPlaybook, ticket_playbook};
use crate::{Sprint, Ticket};

/// The few facts a board card shows.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactsSummary {
    pub recorded_at_epoch_ms: u64,
    /// Recorded longer ago than the staleness bound.
    pub stale: bool,
    pub jira_status: Option<String>,
    pub jira_assignee: Option<String>,
    pub pull_requests: usize,
    pub failed_reads: Vec<FactSource>,
}

impl FactsSummary {
    pub fn of(facts: &TicketDeliveryFacts, now_epoch_ms: u64) -> Self {
        Self {
            recorded_at_epoch_ms: facts.recorded_at_epoch_ms,
            stale: facts.is_stale(now_epoch_ms),
            jira_status: facts.jira.as_ref().map(|jira| jira.status.clone()),
            jira_assignee: facts.jira.as_ref().and_then(|jira| jira.assignee.clone()),
            pull_requests: facts.pull_request_items().len(),
            failed_reads: facts
                .read_failures
                .iter()
                .map(|failure| failure.source)
                .collect(),
        }
    }
}

/// Everything derived about one ticket's delivery for the board.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketDelivery {
    pub ticket_id: String,
    /// Where the ticket stands on its project's Playbook.
    pub playbook: TicketPlaybook,
    pub risks: Vec<DeliveryRisk>,
    pub facts: Option<FactsSummary>,
    /// A delivery check is running for the ticket.
    pub checking: bool,
}

/// One ticket's delivery, derived from current rows.
pub(crate) fn ticket_delivery(
    ticket: &Ticket,
    sprints: &[Sprint],
    playbook: &Playbook,
    facts: Option<&TicketDeliveryFacts>,
    verdicts: &[StepVerdictRecord],
    now_epoch_ms: u64,
) -> TicketDelivery {
    let sprint = ticket
        .sprint_id
        .as_deref()
        .and_then(|sprint_id| sprints.iter().find(|sprint| sprint.id == sprint_id));
    let progress = ticket_playbook(playbook, ticket.status, facts, verdicts);
    let risks = delivery_risks(RiskInputs {
        ticket,
        sprint,
        facts,
        playbook,
        progress: &progress,
        now_epoch_ms,
    });
    TicketDelivery {
        ticket_id: ticket.id.clone(),
        playbook: progress,
        risks,
        facts: facts.map(|facts| FactsSummary::of(facts, now_epoch_ms)),
        checking: false,
    }
}
