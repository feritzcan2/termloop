//! Ticket commands: creation and edits, description versions, sprint moves
//! and ordering, blockers, and acceptance criteria.

use rusqlite::{Connection, OptionalExtension, params};

use super::{
    check_id, next_rank, require_open_sprint, require_sprint, require_ticket, touch_ticket,
};
use crate::ticket::{
    TICKET_BLOCKERS_MAX, TICKET_CRITERIA_MAX, TICKET_VERSIONS_MAX, valid_assignee, valid_jira_url,
    valid_ticket_description, valid_ticket_item, valid_ticket_title,
};
use crate::{
    AcceptanceCriterion, Blocker, PmError, PmStore, SprintState, Ticket, TicketAuthor,
    TicketPriority, TicketStatus,
};

/// Everything a new ticket starts with. A non-empty description becomes its
/// version 1.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewTicket {
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub description_author: TicketAuthor,
    pub status: TicketStatus,
    pub priority: TicketPriority,
    pub assignee: Option<String>,
    pub sprint_id: Option<String>,
    pub jira_url: Option<String>,
}

impl NewTicket {
    pub fn new(project_id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            title: title.into(),
            ..Self::default()
        }
    }
}

/// The ticket fields edited together; `None` leaves a field unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TicketEdit {
    pub title: Option<String>,
    /// `Some(None)` unlinks the Jira issue.
    pub jira_url: Option<Option<String>>,
}

fn check_assignee(assignee: Option<&str>) -> Result<(), PmError> {
    if assignee.is_none_or(valid_assignee) {
        Ok(())
    } else {
        Err(PmError::Invalid("assignee"))
    }
}

fn check_jira_url(jira_url: Option<&str>) -> Result<(), PmError> {
    if jira_url.is_none_or(valid_jira_url) {
        Ok(())
    } else {
        Err(PmError::Invalid("jiraUrl"))
    }
}

fn check_item(text: &str) -> Result<(), PmError> {
    if valid_ticket_item(text) {
        Ok(())
    } else {
        Err(PmError::Invalid("text"))
    }
}

/// At most one ticket per project tracks one Jira issue.
fn ensure_jira_url_free(
    connection: &Connection,
    project_id: &str,
    jira_url: Option<&str>,
    ticket_id: Option<&str>,
) -> Result<(), PmError> {
    let Some(jira_url) = jira_url else {
        return Ok(());
    };
    let taken = connection
        .query_row(
            "SELECT id FROM tickets WHERE project_id = ?1 AND jira_url = ?2 AND id IS NOT ?3",
            params![project_id, jira_url, ticket_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if taken {
        return Err(PmError::Constraint(
            "another ticket already tracks this Jira issue",
        ));
    }
    Ok(())
}

/// A sprint a ticket of `project_id` may join.
fn check_target_sprint(
    connection: &Connection,
    project_id: &str,
    sprint_id: Option<&str>,
) -> Result<(), PmError> {
    if let Some(sprint_id) = sprint_id
        && require_open_sprint(connection, sprint_id)?.project_id != project_id
    {
        return Err(PmError::Invalid("sprintId"));
    }
    Ok(())
}

/// Records `description` as the ticket's next version unless it equals the
/// newest one, dropping versions beyond [`TICKET_VERSIONS_MAX`]. Returns the
/// head version number afterwards (0 when there is none).
pub(super) fn record_version(
    connection: &Connection,
    ticket_id: &str,
    description: &str,
    author: TicketAuthor,
    expected_head: Option<u64>,
    now: u64,
) -> Result<u64, PmError> {
    let head: Option<(u64, String)> = connection
        .query_row(
            "SELECT number, description FROM ticket_versions WHERE ticket_id = ?1 \
             ORDER BY number DESC LIMIT 1",
            [ticket_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let head_number = head.as_ref().map_or(0, |(number, _)| *number);
    if expected_head.is_some_and(|expected| expected != head_number) {
        return Err(PmError::Conflict);
    }
    let unchanged = match &head {
        Some((_, current)) => current == description,
        None => description.is_empty(),
    };
    if unchanged {
        return Ok(head_number);
    }
    let number = head_number + 1;
    connection.execute(
        "INSERT INTO ticket_versions \
             (ticket_id, number, description, author, recorded_at_epoch_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ticket_id, number, description, author.as_str(), now],
    )?;
    connection.execute(
        "DELETE FROM ticket_versions WHERE ticket_id = ?1 AND number <= ?2",
        params![ticket_id, number.saturating_sub(TICKET_VERSIONS_MAX as u64)],
    )?;
    touch_ticket(connection, ticket_id, now)?;
    Ok(number)
}

impl PmStore {
    pub fn create_ticket(&mut self, ticket: NewTicket) -> Result<Ticket, PmError> {
        check_id(&ticket.project_id, "projectId")?;
        if !valid_ticket_title(&ticket.title) {
            return Err(PmError::Invalid("title"));
        }
        if !valid_ticket_description(&ticket.description) {
            return Err(PmError::Invalid("description"));
        }
        check_assignee(ticket.assignee.as_deref())?;
        check_jira_url(ticket.jira_url.as_deref())?;
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let project_id = ticket.project_id.as_str();
            let sprint_id = ticket.sprint_id.as_deref();
            check_target_sprint(transaction, project_id, sprint_id)?;
            ensure_jira_url_free(transaction, project_id, ticket.jira_url.as_deref(), None)?;
            let rank = next_rank(transaction, project_id, sprint_id)?;
            transaction.execute(
                "INSERT INTO tickets (id, project_id, title, status, priority, assignee, \
                     sprint_id, rank, jira_url, created_at_epoch_ms, updated_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    id,
                    project_id,
                    ticket.title,
                    ticket.status.as_str(),
                    ticket.priority.as_str(),
                    ticket.assignee,
                    sprint_id,
                    rank,
                    ticket.jira_url,
                    now
                ],
            )?;
            record_version(
                transaction,
                &id,
                &ticket.description,
                ticket.description_author,
                None,
                now,
            )?;
            require_ticket(transaction, &id)
        })
    }

    pub fn update_ticket(&mut self, ticket_id: &str, edit: TicketEdit) -> Result<Ticket, PmError> {
        if edit
            .title
            .as_deref()
            .is_some_and(|title| !valid_ticket_title(title))
        {
            return Err(PmError::Invalid("title"));
        }
        check_jira_url(edit.jira_url.clone().flatten().as_deref())?;
        let now = self.now();
        self.write(|transaction| {
            let current = require_ticket(transaction, ticket_id)?;
            let title = edit.title.unwrap_or(current.title.clone());
            let jira_url = edit.jira_url.unwrap_or(current.jira_url.clone());
            if title == current.title && jira_url == current.jira_url {
                return Ok(current);
            }
            ensure_jira_url_free(
                transaction,
                &current.project_id,
                jira_url.as_deref(),
                Some(ticket_id),
            )?;
            transaction.execute(
                "UPDATE tickets SET title = ?2, jira_url = ?3, updated_at_epoch_ms = ?4 \
                 WHERE id = ?1",
                params![ticket_id, title, jira_url, now],
            )?;
            require_ticket(transaction, ticket_id)
        })
    }

    /// Saves `description` as the ticket's next immutable version and returns
    /// its number. Saving the newest version's text again records nothing.
    /// With `expected_head`, a save against an older head is a conflict.
    pub fn save_ticket_description(
        &mut self,
        ticket_id: &str,
        description: &str,
        author: TicketAuthor,
        expected_head: Option<u64>,
    ) -> Result<u64, PmError> {
        if !valid_ticket_description(description) {
            return Err(PmError::Invalid("description"));
        }
        let now = self.now();
        self.write(|transaction| {
            require_ticket(transaction, ticket_id)?;
            record_version(
                transaction,
                ticket_id,
                description,
                author,
                expected_head,
                now,
            )
        })
    }

    pub fn set_ticket_status(
        &mut self,
        ticket_id: &str,
        status: TicketStatus,
    ) -> Result<Ticket, PmError> {
        self.set_ticket_column(ticket_id, "status", Some(status.as_str()))
    }

    pub fn set_ticket_priority(
        &mut self,
        ticket_id: &str,
        priority: TicketPriority,
    ) -> Result<Ticket, PmError> {
        self.set_ticket_column(ticket_id, "priority", Some(priority.as_str()))
    }

    /// Assigns the ticket, or unassigns it with `None`.
    pub fn set_ticket_assignee(
        &mut self,
        ticket_id: &str,
        assignee: Option<&str>,
    ) -> Result<Ticket, PmError> {
        check_assignee(assignee)?;
        self.set_ticket_column(ticket_id, "assignee", assignee)
    }

    /// `column` is one of a fixed set of names, never caller text.
    fn set_ticket_column(
        &mut self,
        ticket_id: &str,
        column: &'static str,
        value: Option<&str>,
    ) -> Result<Ticket, PmError> {
        let now = self.now();
        self.write(|transaction| {
            require_ticket(transaction, ticket_id)?;
            transaction.execute(
                &format!(
                    "UPDATE tickets SET {column} = ?2, updated_at_epoch_ms = ?3 \
                     WHERE id = ?1 AND {column} IS NOT ?2"
                ),
                params![ticket_id, value, now],
            )?;
            require_ticket(transaction, ticket_id)
        })
    }

    /// Moves a ticket to the end of an open sprint of its project, or of the
    /// backlog with `None`. Leaving a closed sprint counts as a carry-over.
    pub fn move_ticket_to_sprint(
        &mut self,
        ticket_id: &str,
        sprint_id: Option<&str>,
    ) -> Result<Ticket, PmError> {
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, ticket_id)?;
            if ticket.sprint_id.as_deref() == sprint_id {
                return Ok(ticket);
            }
            check_target_sprint(transaction, &ticket.project_id, sprint_id)?;
            let leaves_closed_sprint = match ticket.sprint_id.as_deref() {
                Some(source) => require_sprint(transaction, source)?.state == SprintState::Closed,
                None => false,
            };
            let rank = next_rank(transaction, &ticket.project_id, sprint_id)?;
            transaction.execute(
                "UPDATE tickets SET sprint_id = ?2, rank = ?3, \
                     carry_over_count = carry_over_count + ?4, updated_at_epoch_ms = ?5 \
                 WHERE id = ?1",
                params![ticket_id, sprint_id, rank, leaves_closed_sprint, now],
            )?;
            require_ticket(transaction, ticket_id)
        })
    }

    /// Reorders one lane (an open sprint, or the backlog with `None`).
    /// `ordered_ticket_ids` must name exactly the lane's tickets.
    pub fn reorder_tickets(
        &mut self,
        project_id: &str,
        sprint_id: Option<&str>,
        ordered_ticket_ids: &[String],
    ) -> Result<(), PmError> {
        check_id(project_id, "projectId")?;
        let now = self.now();
        self.write(|transaction| {
            check_target_sprint(transaction, project_id, sprint_id)?;
            let mut lane = {
                let mut statement = transaction
                    .prepare("SELECT id FROM tickets WHERE project_id = ?1 AND sprint_id IS ?2")?;
                statement
                    .query_map(params![project_id, sprint_id], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let mut requested = ordered_ticket_ids.to_vec();
            lane.sort();
            requested.sort();
            if lane != requested {
                return Err(PmError::Invalid("orderedTicketIds"));
            }
            for (rank, ticket_id) in (0_i64..).zip(ordered_ticket_ids) {
                transaction.execute(
                    "UPDATE tickets SET rank = ?2, updated_at_epoch_ms = ?3 \
                     WHERE id = ?1 AND rank != ?2",
                    params![ticket_id, rank, now],
                )?;
            }
            Ok(())
        })
    }

    pub fn add_ticket_blocker(&mut self, ticket_id: &str, text: &str) -> Result<Blocker, PmError> {
        check_item(text)?;
        let blocker = Blocker {
            id: self.new_id(),
            text: text.to_owned(),
        };
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, ticket_id)?;
            if ticket.blockers.len() >= TICKET_BLOCKERS_MAX {
                return Err(PmError::Constraint("too many blockers"));
            }
            transaction.execute(
                "INSERT INTO ticket_blockers (id, ticket_id, position, text) \
                 VALUES (?1, ?2, \
                     (SELECT COALESCE(MAX(position) + 1, 0) FROM ticket_blockers \
                      WHERE ticket_id = ?2), ?3)",
                params![blocker.id, ticket_id, blocker.text],
            )?;
            touch_ticket(transaction, ticket_id, now)
        })?;
        Ok(blocker)
    }

    pub fn remove_ticket_blocker(
        &mut self,
        ticket_id: &str,
        blocker_id: &str,
    ) -> Result<Ticket, PmError> {
        self.remove_ticket_item(ticket_id, "ticket_blockers", blocker_id, "blockerId")
    }

    pub fn add_acceptance_criterion(
        &mut self,
        ticket_id: &str,
        text: &str,
    ) -> Result<AcceptanceCriterion, PmError> {
        check_item(text)?;
        let criterion = AcceptanceCriterion {
            id: self.new_id(),
            text: text.to_owned(),
            done: false,
        };
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, ticket_id)?;
            if ticket.acceptance_criteria.len() >= TICKET_CRITERIA_MAX {
                return Err(PmError::Constraint("too many acceptance criteria"));
            }
            transaction.execute(
                "INSERT INTO ticket_criteria (id, ticket_id, position, text, done) \
                 VALUES (?1, ?2, \
                     (SELECT COALESCE(MAX(position) + 1, 0) FROM ticket_criteria \
                      WHERE ticket_id = ?2), ?3, 0)",
                params![criterion.id, ticket_id, criterion.text],
            )?;
            touch_ticket(transaction, ticket_id, now)
        })?;
        Ok(criterion)
    }

    /// Checks or unchecks one acceptance criterion. Setting the state it
    /// already has changes nothing, so a retried toggle is safe.
    pub fn set_acceptance_criterion_done(
        &mut self,
        ticket_id: &str,
        criterion_id: &str,
        done: bool,
    ) -> Result<Ticket, PmError> {
        check_id(criterion_id, "criterionId")?;
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, ticket_id)?;
            let criterion = ticket
                .acceptance_criteria
                .iter()
                .find(|criterion| criterion.id == criterion_id)
                .ok_or(PmError::NotFound)?;
            if criterion.done == done {
                return Ok(ticket);
            }
            transaction.execute(
                "UPDATE ticket_criteria SET done = ?2 WHERE id = ?1",
                params![criterion_id, done],
            )?;
            touch_ticket(transaction, ticket_id, now)?;
            require_ticket(transaction, ticket_id)
        })
    }

    pub fn remove_acceptance_criterion(
        &mut self,
        ticket_id: &str,
        criterion_id: &str,
    ) -> Result<Ticket, PmError> {
        self.remove_ticket_item(ticket_id, "ticket_criteria", criterion_id, "criterionId")
    }

    /// `table` is one of a fixed set of names, never caller text.
    fn remove_ticket_item(
        &mut self,
        ticket_id: &str,
        table: &'static str,
        item_id: &str,
        item_name: &'static str,
    ) -> Result<Ticket, PmError> {
        check_id(item_id, item_name)?;
        let now = self.now();
        self.write(|transaction| {
            require_ticket(transaction, ticket_id)?;
            let removed = transaction.execute(
                &format!("DELETE FROM {table} WHERE id = ?1 AND ticket_id = ?2"),
                params![item_id, ticket_id],
            )?;
            if removed == 0 {
                return Err(PmError::NotFound);
            }
            touch_ticket(transaction, ticket_id, now)?;
            require_ticket(transaction, ticket_id)
        })
    }
}
