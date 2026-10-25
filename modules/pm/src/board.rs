//! Reads. The board is assembled from current rows on every call; nothing
//! derived from it (stages, risks, check reasons, the data tier) is stored.

use crate::delivery::{TicketDelivery, ticket_delivery};
use crate::store::{
    project_environments, project_facts, project_probes, project_sources, project_sprints,
    project_tickets, sprint_by_id, ticket_by_id, ticket_facts, ticket_versions,
};
use crate::validation::check_id as check;
use crate::{
    DeliveryProbe, PmError, PmStore, ProjectEnvironment, ProjectSources, Sprint, Ticket,
    TicketDeliveryFacts, TicketVersion, Tracking,
};

/// One project's planning state: its sprints in creation order, its tickets
/// (sprint lanes, then the backlog, each in rank order), its environments in
/// delivery order, its probes, and what is derived about each ticket's
/// delivery (in ticket order).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub project_id: String,
    pub sprints: Vec<Sprint>,
    pub tickets: Vec<Ticket>,
    pub environments: Vec<ProjectEnvironment>,
    pub probes: Vec<DeliveryProbe>,
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
        let environments = project_environments(connection, project_id)?;
        let probes = project_probes(connection, project_id)?;
        let facts = project_facts(connection, project_id)?;
        let deliveries = tickets
            .iter()
            .map(|ticket| {
                ticket_delivery(
                    ticket,
                    &sprints,
                    facts.get(&ticket.id),
                    &probes,
                    &environments,
                    now,
                )
            })
            .collect();
        let tracking = Tracking::derive(
            &project_sources(connection, project_id)?,
            &environments,
            &probes,
        );
        Ok(Board {
            project_id: project_id.to_owned(),
            sprints,
            tickets,
            environments,
            probes,
            deliveries,
            tracking,
        })
    }

    pub fn ticket_facts(&self, ticket_id: &str) -> Result<Option<TicketDeliveryFacts>, PmError> {
        check(ticket_id, "ticketId")?;
        ticket_facts(self.connection(), ticket_id)
    }

    /// A project's probes in creation order.
    pub fn project_probes(&self, project_id: &str) -> Result<Vec<DeliveryProbe>, PmError> {
        check(project_id, "projectId")?;
        project_probes(self.connection(), project_id)
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
            &project_environments(connection, project_id)?,
            &project_probes(connection, project_id)?,
        ))
    }

    /// Whether the project tracks deployments: it lists environments or has
    /// an approved probe.
    pub fn deploy_tracking_enabled(&self, project_id: &str) -> Result<bool, PmError> {
        Ok(self.tracking(project_id)?.deploy)
    }

    pub fn sprint(&self, sprint_id: &str) -> Result<Option<Sprint>, PmError> {
        check(sprint_id, "sprintId")?;
        sprint_by_id(self.connection(), sprint_id)
    }

    pub fn ticket(&self, ticket_id: &str) -> Result<Option<Ticket>, PmError> {
        check(ticket_id, "ticketId")?;
        ticket_by_id(self.connection(), ticket_id)
    }

    /// Every kept description version of a ticket, newest first.
    pub fn ticket_versions(&self, ticket_id: &str) -> Result<Vec<TicketVersion>, PmError> {
        check(ticket_id, "ticketId")?;
        ticket_versions(self.connection(), ticket_id)
    }

    pub fn project_environments(
        &self,
        project_id: &str,
    ) -> Result<Vec<ProjectEnvironment>, PmError> {
        check(project_id, "projectId")?;
        project_environments(self.connection(), project_id)
    }
}
