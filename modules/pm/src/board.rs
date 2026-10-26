//! Reads. The board is assembled from current rows on every call; nothing
//! derived from it (Playbook positions, risks, the data tier) is stored.

use crate::delivery::{TicketDelivery, ticket_delivery};
use crate::playbook::Playbook;
use crate::store::{
    project_facts, project_playbook, project_running_checks, project_sources, project_sprints,
    project_tickets, project_verdicts, proposal_by_id, sprint_by_id, ticket_by_id, ticket_facts,
    ticket_versions,
};
use crate::validation::check_id as check;
use crate::{
    PmError, PmStore, ProjectSources, Sprint, Ticket, TicketDeliveryFacts, TicketProposal,
    TicketVersion, Tracking,
};

/// One project's planning state: its sprints in creation order, its tickets
/// (sprint lanes, then the backlog, each in rank order), its Playbook, and
/// what is derived about each ticket's delivery (in ticket order).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub project_id: String,
    pub sprints: Vec<Sprint>,
    pub tickets: Vec<Ticket>,
    pub playbook: Playbook,
    pub deliveries: Vec<TicketDelivery>,
    pub tracking: Tracking,
}

impl PmStore {
    pub fn board(&self, project_id: &str) -> Result<Board, PmError> {
        check(project_id, "projectId")?;
        let connection = self.connection();
        let now = self.now();
        let sprints = project_sprints(connection, project_id)?;
        let tickets = project_tickets(connection, project_id)?;
        let playbook = project_playbook(connection, project_id)?;
        let facts = project_facts(connection, project_id)?;
        let verdicts = project_verdicts(connection, project_id)?;
        let running = project_running_checks(connection, project_id)?;
        let deliveries = tickets
            .iter()
            .map(|ticket| {
                let mut delivery = ticket_delivery(
                    ticket,
                    &sprints,
                    &playbook,
                    facts.get(&ticket.id),
                    verdicts
                        .get(&ticket.id)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                    now,
                );
                delivery.checking = running.iter().any(|check| check.ticket_id == ticket.id);
                delivery
            })
            .collect();
        let tracking = Tracking::derive(&project_sources(connection, project_id)?, &playbook);
        Ok(Board {
            project_id: project_id.to_owned(),
            sprints,
            tickets,
            playbook,
            deliveries,
            tracking,
        })
    }

    pub fn ticket_facts(&self, ticket_id: &str) -> Result<Option<TicketDeliveryFacts>, PmError> {
        check(ticket_id, "ticketId")?;
        ticket_facts(self.connection(), ticket_id)
    }

    pub fn project_sources(&self, project_id: &str) -> Result<ProjectSources, PmError> {
        check(project_id, "projectId")?;
        project_sources(self.connection(), project_id)
    }

    /// What kinds of delivery data the project has.
    pub fn tracking(&self, project_id: &str) -> Result<Tracking, PmError> {
        check(project_id, "projectId")?;
        let connection = self.connection();
        Ok(Tracking::derive(
            &project_sources(connection, project_id)?,
            &project_playbook(connection, project_id)?,
        ))
    }

    pub fn sprint(&self, sprint_id: &str) -> Result<Option<Sprint>, PmError> {
        check(sprint_id, "sprintId")?;
        sprint_by_id(self.connection(), sprint_id)
    }

    pub fn ticket(&self, ticket_id: &str) -> Result<Option<Ticket>, PmError> {
        check(ticket_id, "ticketId")?;
        ticket_by_id(self.connection(), ticket_id)
    }

    /// Every ticket of a project, without the board's delivery derivations.
    pub fn project_tickets(&self, project_id: &str) -> Result<Vec<Ticket>, PmError> {
        check(project_id, "projectId")?;
        project_tickets(self.connection(), project_id)
    }

    pub fn proposal(&self, proposal_id: &str) -> Result<Option<TicketProposal>, PmError> {
        check(proposal_id, "proposalId")?;
        proposal_by_id(self.connection(), proposal_id)
    }

    /// Every kept description version of a ticket, newest first.
    pub fn ticket_versions(&self, ticket_id: &str) -> Result<Vec<TicketVersion>, PmError> {
        check(ticket_id, "ticketId")?;
        ticket_versions(self.connection(), ticket_id)
    }
}
