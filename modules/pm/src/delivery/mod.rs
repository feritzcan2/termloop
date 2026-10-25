//! Delivery: what the PM observes about each ticket on its way to
//! production, and what is derived from it on every read (stage, risks,
//! check reasons, data tier). Only observations and probes are stored.

pub(crate) mod check_reasons;
pub(crate) mod checks;
pub(crate) mod facts;
pub(crate) mod probe;
pub(crate) mod risks;
pub(crate) mod stage;
pub(crate) mod tracking;

use facts::{EnvironmentDeployState, FactSource, TicketDeliveryFacts};
use risks::{DeliveryRisk, RiskInputs, delivery_risks};
use stage::{DeliveryStage, delivery_stage};

use crate::{DeliveryProbe, ProjectEnvironment, Sprint, SprintState, Ticket};

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
    pub deployed_environments: Vec<String>,
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
            deployed_environments: facts
                .environments
                .iter()
                .filter(|environment| environment.state == EnvironmentDeployState::Deployed)
                .map(|environment| environment.name.clone())
                .collect(),
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
    pub stage: DeliveryStage,
    pub risks: Vec<DeliveryRisk>,
    /// Only tickets of the active sprint ask for a delivery check.
    pub check_reasons: Vec<String>,
    pub facts: Option<FactsSummary>,
    /// A delivery check is running for the ticket.
    pub checking: bool,
}

/// One ticket's delivery, derived from current rows.
pub(crate) fn ticket_delivery(
    ticket: &Ticket,
    sprints: &[Sprint],
    facts: Option<&TicketDeliveryFacts>,
    probes: &[DeliveryProbe],
    environments: &[ProjectEnvironment],
    now_epoch_ms: u64,
) -> TicketDelivery {
    let sprint = ticket
        .sprint_id
        .as_deref()
        .and_then(|sprint_id| sprints.iter().find(|sprint| sprint.id == sprint_id));
    let stage = delivery_stage(ticket.status, facts, environments);
    let risks = delivery_risks(RiskInputs {
        ticket,
        sprint,
        facts,
        stage: &stage,
        environments,
        now_epoch_ms,
    });
    let check_reasons = if sprint.is_some_and(|sprint| sprint.state == SprintState::Active) {
        check_reasons::check_reasons(&stage, facts, probes, environments)
    } else {
        Vec::new()
    };
    TicketDelivery {
        ticket_id: ticket.id.clone(),
        stage,
        risks,
        check_reasons,
        facts: facts.map(|facts| FactsSummary::of(facts, now_epoch_ms)),
        checking: false,
    }
}
