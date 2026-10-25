//! Reads. The board is assembled from current rows on every call; nothing
//! derived from it is stored.

use crate::store::{
    project_environments, project_sprints, project_tickets, sprint_by_id, ticket_by_id,
    ticket_versions,
};
use crate::validation::check_id as check;
use crate::{PmError, PmStore, ProjectEnvironment, Sprint, Ticket, TicketVersion};

/// One project's planning state: its sprints in creation order, its tickets
/// (sprint lanes, then the backlog, each in rank order), and its
/// environments in delivery order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub project_id: String,
    pub sprints: Vec<Sprint>,
    pub tickets: Vec<Ticket>,
    pub environments: Vec<ProjectEnvironment>,
}

impl PmStore {
    pub fn board(&self, project_id: &str) -> Result<Board, PmError> {
        check(project_id, "projectId")?;
        let connection = self.connection();
        Ok(Board {
            project_id: project_id.to_owned(),
            sprints: project_sprints(connection, project_id)?,
            tickets: project_tickets(connection, project_id)?,
            environments: project_environments(connection, project_id)?,
        })
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
