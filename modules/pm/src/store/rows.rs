//! Reads that map rows back into PM values. Every stored enum is parsed
//! strictly; an unknown value is a storage error, never a default.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};

use crate::{
    AcceptanceCriterion, Blocker, PmError, ProjectEnvironment, Sprint, SprintState, Ticket,
    TicketAuthor, TicketPriority, TicketStatus, TicketVersion, TicketVersionsSummary,
};

fn parsed<T>(row: &Row<'_>, index: usize, parse: fn(&str) -> Option<T>) -> rusqlite::Result<T> {
    let value: String = row.get(index)?;
    parse(&value).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            Type::Text,
            format!("unknown stored value {value:?}").into(),
        )
    })
}

const SPRINT_COLUMNS: &str = "id, project_id, name, goal, state, created_at_epoch_ms, \
     activated_at_epoch_ms, closed_at_epoch_ms";

fn sprint_row(row: &Row<'_>) -> rusqlite::Result<Sprint> {
    Ok(Sprint {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        goal: row.get(3)?,
        state: parsed(row, 4, SprintState::parse)?,
        created_at_epoch_ms: row.get(5)?,
        activated_at_epoch_ms: row.get(6)?,
        closed_at_epoch_ms: row.get(7)?,
    })
}

pub(crate) fn sprint_by_id(connection: &Connection, id: &str) -> Result<Option<Sprint>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {SPRINT_COLUMNS} FROM sprints WHERE id = ?1"),
            [id],
            sprint_row,
        )
        .optional()?)
}

pub(crate) fn project_sprints(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<Sprint>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SPRINT_COLUMNS} FROM sprints WHERE project_id = ?1 \
         ORDER BY created_at_epoch_ms, id"
    ))?;
    let sprints = statement
        .query_map([project_id], sprint_row)?
        .collect::<Result<_, _>>()?;
    Ok(sprints)
}

pub(crate) fn active_sprint(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<Sprint>, PmError> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {SPRINT_COLUMNS} FROM sprints WHERE project_id = ?1 AND state = 'active'"
            ),
            [project_id],
            sprint_row,
        )
        .optional()?)
}

/// Which tickets a ticket read covers; both bind one text parameter.
#[derive(Clone, Copy)]
enum TicketScope {
    Project,
    Ticket,
}

impl TicketScope {
    const fn filter(self) -> &'static str {
        match self {
            Self::Project => "t.project_id = ?1",
            Self::Ticket => "t.id = ?1",
        }
    }
}

fn load_tickets(
    connection: &Connection,
    scope: TicketScope,
    key: &str,
) -> Result<Vec<Ticket>, PmError> {
    let filter = scope.filter();
    let mut blockers = HashMap::<String, Vec<Blocker>>::new();
    let mut statement = connection.prepare(&format!(
        "SELECT b.ticket_id, b.id, b.text FROM ticket_blockers b \
         JOIN tickets t ON t.id = b.ticket_id WHERE {filter} ORDER BY b.position"
    ))?;
    let mut rows = statement.query([key])?;
    while let Some(row) = rows.next()? {
        blockers.entry(row.get(0)?).or_default().push(Blocker {
            id: row.get(1)?,
            text: row.get(2)?,
        });
    }
    let mut criteria = HashMap::<String, Vec<AcceptanceCriterion>>::new();
    let mut statement = connection.prepare(&format!(
        "SELECT c.ticket_id, c.id, c.text, c.done FROM ticket_criteria c \
         JOIN tickets t ON t.id = c.ticket_id WHERE {filter} ORDER BY c.position"
    ))?;
    let mut rows = statement.query([key])?;
    while let Some(row) = rows.next()? {
        criteria
            .entry(row.get(0)?)
            .or_default()
            .push(AcceptanceCriterion {
                id: row.get(1)?,
                text: row.get(2)?,
                done: row.get(3)?,
            });
    }
    let mut heads = HashMap::<String, (String, TicketVersionsSummary)>::new();
    let mut statement = connection.prepare(&format!(
        "SELECT v.ticket_id, v.description, v.number, v.author, v.recorded_at_epoch_ms, \
             (SELECT COUNT(*) FROM ticket_versions c WHERE c.ticket_id = v.ticket_id) \
         FROM ticket_versions v JOIN tickets t ON t.id = v.ticket_id \
         WHERE {filter} AND v.number = \
             (SELECT MAX(m.number) FROM ticket_versions m WHERE m.ticket_id = v.ticket_id)"
    ))?;
    let mut rows = statement.query([key])?;
    while let Some(row) = rows.next()? {
        heads.insert(
            row.get(0)?,
            (
                row.get(1)?,
                TicketVersionsSummary {
                    head_number: row.get(2)?,
                    head_author: parsed(row, 3, TicketAuthor::parse)?,
                    head_recorded_at_epoch_ms: row.get(4)?,
                    count: row.get(5)?,
                },
            ),
        );
    }
    let mut statement = connection.prepare(&format!(
        "SELECT t.id, t.project_id, t.title, t.status, t.priority, t.assignee, t.sprint_id, \
             t.rank, t.jira_url, t.carry_over_count, t.created_at_epoch_ms, \
             t.updated_at_epoch_ms \
         FROM tickets t WHERE {filter} \
         ORDER BY t.sprint_id IS NULL, t.sprint_id, t.rank, t.id"
    ))?;
    let tickets = statement
        .query_map([key], |row| {
            let id: String = row.get(0)?;
            let (description, versions) = match heads.remove(&id) {
                Some((description, summary)) => (description, Some(summary)),
                None => (String::new(), None),
            };
            Ok(Ticket {
                project_id: row.get(1)?,
                title: row.get(2)?,
                description,
                status: parsed(row, 3, TicketStatus::parse)?,
                priority: parsed(row, 4, TicketPriority::parse)?,
                assignee: row.get(5)?,
                sprint_id: row.get(6)?,
                rank: row.get(7)?,
                jira_url: row.get(8)?,
                carry_over_count: row.get(9)?,
                blockers: blockers.remove(&id).unwrap_or_default(),
                acceptance_criteria: criteria.remove(&id).unwrap_or_default(),
                versions,
                created_at_epoch_ms: row.get(10)?,
                updated_at_epoch_ms: row.get(11)?,
                id,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(tickets)
}

pub(crate) fn ticket_by_id(connection: &Connection, id: &str) -> Result<Option<Ticket>, PmError> {
    Ok(load_tickets(connection, TicketScope::Ticket, id)?.pop())
}

/// Every ticket of a project: sprint lanes first, then the backlog, each in
/// rank order.
pub(crate) fn project_tickets(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<Ticket>, PmError> {
    load_tickets(connection, TicketScope::Project, project_id)
}

/// Every kept description version of a ticket, newest first.
pub(crate) fn ticket_versions(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Vec<TicketVersion>, PmError> {
    let mut statement = connection.prepare(
        "SELECT ticket_id, number, description, author, recorded_at_epoch_ms \
         FROM ticket_versions WHERE ticket_id = ?1 ORDER BY number DESC",
    )?;
    let versions = statement
        .query_map([ticket_id], |row| {
            Ok(TicketVersion {
                ticket_id: row.get(0)?,
                number: row.get(1)?,
                description: row.get(2)?,
                author: parsed(row, 3, TicketAuthor::parse)?,
                recorded_at_epoch_ms: row.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(versions)
}

pub(crate) fn project_environments(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ProjectEnvironment>, PmError> {
    let mut statement = connection.prepare(
        "SELECT name, production FROM project_environments \
         WHERE project_id = ?1 ORDER BY position",
    )?;
    let environments = statement
        .query_map(params![project_id], |row| {
            Ok(ProjectEnvironment {
                name: row.get(0)?,
                production: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(environments)
}
