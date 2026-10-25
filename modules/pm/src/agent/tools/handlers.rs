//! Typed parameters, results, and handlers of the PM agent tools. Every
//! handler stays inside the caller's project; a delivery check also stays on
//! its one ticket.

use super::{PmToolContext, PmToolError, denied};
use crate::agent::{
    PM_CHECK_REPORT, PM_RISKS_READ, PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
    PM_TICKET_PROPOSE_DESCRIPTION, PM_TICKET_READ, PmAgentMode,
};
use crate::{
    AgentProbeReading, Board, CheckReport, DataTier, DeliveryRisk, DeliveryStage,
    EnvironmentDeployState, NewProbe, PmError, PmStore, ProbeMatcher, ProposalChange,
    ReportedEnvironment, SprintState, Ticket, TicketDelivery, TicketDeliveryFacts, TicketPriority,
    TicketProposal, TicketStatus,
};

/// Which tickets a board read lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoardScope {
    /// The active sprint's tickets.
    #[default]
    ActiveSprint,
    /// Every ticket: open sprints and the backlog.
    All,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BoardReadParams {
    #[serde(default)]
    pub scope: BoardScope,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSprint {
    pub id: String,
    pub name: String,
    pub state: SprintState,
    pub goal: Option<String>,
    pub ends_at_epoch_ms: Option<u64>,
}

/// One board card as the agent sees it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardTicket {
    pub id: String,
    pub title: String,
    pub status: TicketStatus,
    pub priority: TicketPriority,
    pub assignee: Option<String>,
    pub sprint_id: Option<String>,
    pub jira_key: Option<String>,
    pub stage: DeliveryStage,
    pub risks: usize,
    pub check_reasons: Vec<String>,
    /// A delivery check is running for the ticket.
    pub checking: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardReadResult {
    /// The furthest delivery data the project has; data beyond it is absent,
    /// not empty.
    pub tier: DataTier,
    pub environments: Vec<String>,
    pub sprints: Vec<BoardSprint>,
    pub tickets: Vec<BoardTicket>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicketReadParams {
    pub ticket_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketReadResult {
    pub ticket: Ticket,
    pub delivery: TicketDelivery,
    pub facts: Option<TicketDeliveryFacts>,
    pub pending_proposals: Vec<TicketProposal>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DescriptionProposalParams {
    pub ticket_id: String,
    /// The complete new description in Markdown.
    pub description: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AcceptanceCriteriaProposalParams {
    pub ticket_id: String,
    pub criteria: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalResult {
    pub proposal_id: String,
    pub ticket_id: String,
    /// Always false: the PM decides whether a proposal is applied.
    pub applied: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RisksReadParams {
    #[serde(default)]
    pub ticket_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRisks {
    pub ticket_id: String,
    pub title: String,
    pub risks: Vec<DeliveryRisk>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RisksReadResult {
    pub tickets: Vec<TicketRisks>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReportedEnvironmentParams {
    pub name: String,
    pub state: EnvironmentDeployState,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentProbeParams {
    pub probe_id: String,
    pub state: EnvironmentDeployState,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProbeProposalParams {
    pub environment: String,
    pub argv: Vec<String>,
    pub matcher: ProbeMatcher,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckReportParams {
    pub ticket_id: String,
    pub environments: Vec<ReportedEnvironmentParams>,
    #[serde(default)]
    pub blockers: Option<String>,
    pub notes_markdown: String,
    #[serde(default)]
    pub agent_probe: Option<AgentProbeParams>,
    #[serde(default)]
    pub probe_proposals: Vec<ProbeProposalParams>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReportResult {
    pub accepted: bool,
    pub stage: DeliveryStage,
    pub proposed_probe_ids: Vec<String>,
}

/// The ticket a call names, when the caller may touch it: it belongs to the
/// caller's project, and a delivery check names its own ticket.
fn scoped_ticket(
    store: &PmStore,
    context: &PmToolContext,
    tool: &str,
    ticket_id: &str,
) -> Result<Ticket, PmToolError> {
    if context.mode == PmAgentMode::DeliveryCheck && context.ticket_id.as_deref() != Some(ticket_id)
    {
        return Err(denied(
            tool,
            "a delivery check works on its own ticket only",
        ));
    }
    match store.ticket(ticket_id)? {
        Some(ticket) if ticket.project_id == context.project_id => Ok(ticket),
        _ => Err(PmError::NotFound.into()),
    }
}

fn delivery_of(board: &Board, ticket_id: &str) -> Result<TicketDelivery, PmToolError> {
    board
        .deliveries
        .iter()
        .find(|delivery| delivery.ticket_id == ticket_id)
        .cloned()
        .ok_or(PmToolError::Store(PmError::NotFound))
}

pub(super) fn board_read(
    store: &PmStore,
    context: &PmToolContext,
    params: BoardReadParams,
) -> Result<BoardReadResult, PmToolError> {
    let board = store.board(&context.project_id)?;
    let active = board
        .sprints
        .iter()
        .find(|sprint| sprint.state == SprintState::Active)
        .map(|sprint| sprint.id.as_str());
    let tickets = board
        .tickets
        .iter()
        .zip(&board.deliveries)
        .filter(|(ticket, _)| match params.scope {
            BoardScope::ActiveSprint => active.is_some() && ticket.sprint_id.as_deref() == active,
            BoardScope::All => true,
        })
        .map(|(ticket, delivery)| BoardTicket {
            id: ticket.id.clone(),
            title: ticket.title.clone(),
            status: ticket.status,
            priority: ticket.priority,
            assignee: ticket.assignee.clone(),
            sprint_id: ticket.sprint_id.clone(),
            jira_key: ticket.jira_issue_key(),
            stage: delivery.stage.clone(),
            risks: delivery.risks.len(),
            check_reasons: delivery.check_reasons.clone(),
            checking: delivery.checking,
        })
        .collect();
    let sprints = board
        .sprints
        .iter()
        .filter(|sprint| sprint.state != SprintState::Closed)
        .map(|sprint| BoardSprint {
            id: sprint.id.clone(),
            name: sprint.name.clone(),
            state: sprint.state,
            goal: sprint.goal.clone(),
            ends_at_epoch_ms: sprint.ends_at_epoch_ms,
        })
        .collect();
    Ok(BoardReadResult {
        tier: board.tracking.tier,
        environments: if board.tracking.deploy {
            board
                .environments
                .iter()
                .map(|environment| environment.name.clone())
                .collect()
        } else {
            Vec::new()
        },
        sprints,
        tickets,
    })
}

pub(super) fn ticket_read(
    store: &PmStore,
    context: &PmToolContext,
    params: TicketReadParams,
) -> Result<TicketReadResult, PmToolError> {
    let ticket = scoped_ticket(store, context, PM_TICKET_READ, &params.ticket_id)?;
    let board = store.board(&context.project_id)?;
    Ok(TicketReadResult {
        delivery: delivery_of(&board, &ticket.id)?,
        facts: store.ticket_facts(&ticket.id)?,
        pending_proposals: store.ticket_proposals(&ticket.id)?,
        ticket,
    })
}

fn proposal_result(proposal: TicketProposal) -> ProposalResult {
    ProposalResult {
        proposal_id: proposal.id,
        ticket_id: proposal.ticket_id,
        applied: false,
    }
}

pub(super) fn propose_description(
    store: &mut PmStore,
    context: &PmToolContext,
    params: DescriptionProposalParams,
) -> Result<ProposalResult, PmToolError> {
    let ticket = scoped_ticket(
        store,
        context,
        PM_TICKET_PROPOSE_DESCRIPTION,
        &params.ticket_id,
    )?;
    let proposal = store.propose_ticket_change(
        &ticket.id,
        ProposalChange::Description {
            description: params.description,
        },
        &params.summary,
    )?;
    Ok(proposal_result(proposal))
}

pub(super) fn propose_acceptance_criteria(
    store: &mut PmStore,
    context: &PmToolContext,
    params: AcceptanceCriteriaProposalParams,
) -> Result<ProposalResult, PmToolError> {
    let ticket = scoped_ticket(
        store,
        context,
        PM_TICKET_PROPOSE_ACCEPTANCE_CRITERIA,
        &params.ticket_id,
    )?;
    let proposal = store.propose_ticket_change(
        &ticket.id,
        ProposalChange::AcceptanceCriteria {
            criteria: params.criteria,
        },
        &params.summary,
    )?;
    Ok(proposal_result(proposal))
}

pub(super) fn risks_read(
    store: &PmStore,
    context: &PmToolContext,
    params: RisksReadParams,
) -> Result<RisksReadResult, PmToolError> {
    // A delivery check reads only its own ticket's risks.
    let only = match (&params.ticket_id, context.mode) {
        (Some(ticket_id), _) => Some(ticket_id.clone()),
        (None, PmAgentMode::DeliveryCheck) => context.ticket_id.clone(),
        (None, PmAgentMode::Assistant) => None,
    };
    if let Some(ticket_id) = &only {
        scoped_ticket(store, context, PM_RISKS_READ, ticket_id)?;
    }
    let board = store.board(&context.project_id)?;
    let tickets = board
        .tickets
        .iter()
        .zip(&board.deliveries)
        .filter(|(ticket, delivery)| {
            only.as_deref().is_none_or(|id| ticket.id == id) && !delivery.risks.is_empty()
        })
        .map(|(ticket, delivery)| TicketRisks {
            ticket_id: ticket.id.clone(),
            title: ticket.title.clone(),
            risks: delivery.risks.clone(),
        })
        .collect();
    Ok(RisksReadResult { tickets })
}

pub(super) fn check_report(
    store: &mut PmStore,
    context: &PmToolContext,
    params: CheckReportParams,
) -> Result<CheckReportResult, PmToolError> {
    let ticket = scoped_ticket(store, context, PM_CHECK_REPORT, &params.ticket_id)?;
    if !store.deploy_tracking_enabled(&context.project_id)? {
        return Err(denied(
            PM_CHECK_REPORT,
            "the project does not track deployments",
        ));
    }
    let report = CheckReport {
        ticket_id: ticket.id.clone(),
        environments: params
            .environments
            .into_iter()
            .map(|environment| ReportedEnvironment {
                name: environment.name,
                state: environment.state,
                detail: environment.detail,
            })
            .collect(),
        blockers: params.blockers,
        notes_markdown: params.notes_markdown,
        agent_probe: params.agent_probe.map(|reading| AgentProbeReading {
            probe_id: reading.probe_id,
            state: reading.state,
            detail: reading.detail,
        }),
        probe_proposals: params
            .probe_proposals
            .into_iter()
            .map(|probe| NewProbe {
                project_id: context.project_id.clone(),
                environment: probe.environment,
                argv: probe.argv,
                matcher: probe.matcher,
                reason: probe.reason,
            })
            .collect(),
    };
    let recorded = store.record_check_report(&context.project_id, report)?;
    let board = store.board(&context.project_id)?;
    Ok(CheckReportResult {
        accepted: true,
        stage: delivery_of(&board, &ticket.id)?.stage,
        proposed_probe_ids: recorded.proposed_probe_ids,
    })
}
