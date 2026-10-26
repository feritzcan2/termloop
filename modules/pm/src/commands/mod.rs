//! Named write commands. Each runs as one transaction through
//! [`PmStore::write`](crate::PmStore) and validates every parameter before
//! touching a row.

mod check_report;
mod checks;
mod facts;
mod jira_mirror;
mod jira_write;
mod note;
mod playbook;
mod project;
mod proposal;
mod skill;
mod skill_channels;
mod sources;
mod sprint;
mod ticket;

use rusqlite::{Connection, OptionalExtension, params};

pub use check_report::{CheckReport, RecordedCheckReport};
pub use facts::{FactRead, FactsObservation, JiraObservation, PullRequestsObservation};
pub use jira_mirror::{
    JIRA_PULL_NEW_TICKETS_MAX, JiraPullChanges, JiraPullOutcome, JiraSprintImportOutcome,
    JiraSprintImportRead, JiraSprintPull, JiraSprintRead, read_jira_sprint_import,
    read_jira_sprints,
};
pub use jira_write::{
    JiraChange, JiraIssueState, JiraWriteDiff, JiraWriteOutcome, JiraWriteTarget, apply_jira_write,
    read_jira_issue_state,
};
pub use playbook::MARKED_PASSED_EVIDENCE;
pub use proposal::ProposalOrigin;
pub use skill::{SKILL_DISCOVERY_MAX_BYTES, SKILL_PAUSE_AFTER_FAILURES, SKILL_RETRY_AFTER_MS};
pub use skill_channels::{ChannelWatermark, SKILL_SLACK_RETENTION_MS, slack_ts_at, slack_ts_key};
pub(crate) use skill_channels::{TS_FRACTION_MAX_DIGITS, TS_SECONDS_MAX_DIGITS};
pub use sprint::{ClosedSprint, DeletedSprint};
pub use ticket::{NewTicket, TicketEdit};

use crate::store::{sprint_by_id, ticket_by_id};
pub(crate) use crate::validation::check_id;
use crate::{PmError, Sprint, SprintState, Ticket};

fn require_sprint(connection: &Connection, sprint_id: &str) -> Result<Sprint, PmError> {
    check_id(sprint_id, "sprintId")?;
    sprint_by_id(connection, sprint_id)?.ok_or(PmError::NotFound)
}

/// A sprint that still accepts changes and tickets.
fn require_open_sprint(connection: &Connection, sprint_id: &str) -> Result<Sprint, PmError> {
    let sprint = require_sprint(connection, sprint_id)?;
    if sprint.state == SprintState::Closed {
        return Err(PmError::Constraint("the sprint is closed"));
    }
    Ok(sprint)
}

fn require_ticket(connection: &Connection, ticket_id: &str) -> Result<Ticket, PmError> {
    check_id(ticket_id, "ticketId")?;
    ticket_by_id(connection, ticket_id)?.ok_or(PmError::NotFound)
}

/// The rank after the last ticket of one lane: a sprint, or the backlog for
/// `None`.
fn next_rank(
    connection: &Connection,
    project_id: &str,
    sprint_id: Option<&str>,
) -> Result<i64, PmError> {
    let last: Option<i64> = connection
        .query_row(
            "SELECT MAX(rank) FROM tickets WHERE project_id = ?1 AND sprint_id IS ?2",
            params![project_id, sprint_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    last.map_or(Ok(0), |rank| {
        rank.checked_add(1)
            .ok_or(PmError::Constraint("ticket rank overflow"))
    })
}

fn touch_ticket(connection: &Connection, ticket_id: &str, now: u64) -> Result<(), PmError> {
    connection.execute(
        "UPDATE tickets SET updated_at_epoch_ms = ?2 WHERE id = ?1",
        params![ticket_id, now],
    )?;
    Ok(())
}
