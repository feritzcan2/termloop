//! Epic commands: epics and their tickets, the breakdowns an agent proposes
//! for the PM, and the assistant conversation a project resumes.

use rusqlite::{Connection, params};

use super::check_id;
use super::ticket::{NewTicket, check_target_sprint, insert_ticket, set_ticket_column};
use crate::epic::{
    AssistantConversation, BreakdownTask, Epic, EpicBreakdown, EpicDraft, EpicEdit,
    PROJECT_BREAKDOWNS_MAX, PROJECT_EPICS_MAX, valid_breakdown_target, valid_breakdown_tasks,
    valid_epic_description, valid_epic_title,
};
use crate::proposal::valid_proposal_summary;
use crate::store::{
    assistant_conversation, breakdown_by_id, epic_by_id, project_breakdowns, project_epics,
    ticket_by_id,
};
use crate::{PmError, PmStore, Ticket, TicketAuthor};

/// What accepting a breakdown made: its epic and the tickets created from
/// the kept tasks, in task order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedBreakdown {
    pub epic: Epic,
    pub tickets: Vec<Ticket>,
}

fn require_epic(connection: &Connection, epic_id: &str) -> Result<Epic, PmError> {
    check_id(epic_id, "epicId")?;
    epic_by_id(connection, epic_id)?.ok_or(PmError::NotFound)
}

/// An epic a ticket of `project_id` may belong to.
pub(super) fn check_ticket_epic(
    connection: &Connection,
    project_id: &str,
    epic_id: Option<&str>,
) -> Result<(), PmError> {
    if let Some(epic_id) = epic_id
        && require_epic(connection, epic_id)?.project_id != project_id
    {
        return Err(PmError::Invalid("epicId"));
    }
    Ok(())
}

fn check_epic_fields(title: Option<&str>, description: Option<&str>) -> Result<(), PmError> {
    if title.is_some_and(|title| !valid_epic_title(title)) {
        return Err(PmError::Invalid("title"));
    }
    if description.is_some_and(|description| !valid_epic_description(description)) {
        return Err(PmError::Invalid("description"));
    }
    Ok(())
}

fn count(connection: &Connection, table: &str, project_id: &str) -> Result<usize, PmError> {
    let count: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
        [project_id],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

fn insert_epic(connection: &Connection, epic: &Epic) -> Result<(), PmError> {
    if count(connection, "epics", &epic.project_id)? >= PROJECT_EPICS_MAX {
        return Err(PmError::Constraint("too many epics"));
    }
    connection.execute(
        "INSERT INTO epics (id, project_id, title, description, created_at_epoch_ms, \
             updated_at_epoch_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            epic.id,
            epic.project_id,
            epic.title,
            epic.description,
            epic.created_at_epoch_ms
        ],
    )?;
    Ok(())
}

impl PmStore {
    pub fn create_epic(
        &mut self,
        project_id: &str,
        title: &str,
        description: &str,
    ) -> Result<Epic, PmError> {
        check_id(project_id, "projectId")?;
        check_epic_fields(Some(title), Some(description))?;
        let now = self.now();
        let epic = Epic {
            id: self.new_id(),
            project_id: project_id.to_owned(),
            title: title.to_owned(),
            description: description.to_owned(),
            created_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        self.write(|transaction| insert_epic(transaction, &epic))?;
        Ok(epic)
    }

    pub fn update_epic(&mut self, epic_id: &str, edit: EpicEdit) -> Result<Epic, PmError> {
        check_epic_fields(edit.title.as_deref(), edit.description.as_deref())?;
        let now = self.now();
        self.write(|transaction| {
            let current = require_epic(transaction, epic_id)?;
            let title = edit.title.unwrap_or(current.title.clone());
            let description = edit.description.unwrap_or(current.description.clone());
            if title == current.title && description == current.description {
                return Ok(current);
            }
            transaction.execute(
                "UPDATE epics SET title = ?2, description = ?3, updated_at_epoch_ms = ?4 \
                 WHERE id = ?1",
                params![epic_id, title, description, now],
            )?;
            require_epic(transaction, epic_id)
        })
    }

    /// Deletes an epic and its waiting breakdowns; its tickets stay and
    /// belong to no epic.
    pub fn delete_epic(&mut self, epic_id: &str) -> Result<(), PmError> {
        let now = self.now();
        self.write(|transaction| {
            require_epic(transaction, epic_id)?;
            transaction.execute(
                "UPDATE tickets SET epic_id = NULL, updated_at_epoch_ms = ?2 WHERE epic_id = ?1",
                params![epic_id, now],
            )?;
            transaction.execute("DELETE FROM epics WHERE id = ?1", [epic_id])?;
            Ok(())
        })
    }

    /// Puts a ticket under an epic of its project, or under none.
    pub fn set_ticket_epic(
        &mut self,
        ticket_id: &str,
        epic_id: Option<&str>,
    ) -> Result<Ticket, PmError> {
        check_id(ticket_id, "ticketId")?;
        let now = self.now();
        self.write(|transaction| {
            let ticket = ticket_by_id(transaction, ticket_id)?.ok_or(PmError::NotFound)?;
            check_ticket_epic(transaction, &ticket.project_id, epic_id)?;
            set_ticket_column(transaction, ticket_id, "epic_id", epic_id, None, now)
        })
    }

    pub fn epics(&self, project_id: &str) -> Result<Vec<Epic>, PmError> {
        check_id(project_id, "projectId")?;
        project_epics(self.connection(), project_id)
    }

    pub fn epic(&self, epic_id: &str) -> Result<Option<Epic>, PmError> {
        check_id(epic_id, "epicId")?;
        epic_by_id(self.connection(), epic_id)
    }

    /// Keeps an agent's split of a goal into tickets for the PM; nothing
    /// changes until the PM accepts it.
    pub fn propose_epic_breakdown(
        &mut self,
        project_id: &str,
        epic_id: Option<&str>,
        epic: Option<EpicDraft>,
        tasks: Vec<BreakdownTask>,
        summary: String,
    ) -> Result<EpicBreakdown, PmError> {
        check_id(project_id, "projectId")?;
        if !valid_breakdown_target(epic_id, epic.as_ref()) {
            return Err(PmError::Invalid("epic"));
        }
        if !valid_breakdown_tasks(&tasks) {
            return Err(PmError::Invalid("tasks"));
        }
        if !valid_proposal_summary(&summary) {
            return Err(PmError::Invalid("summary"));
        }
        let breakdown = EpicBreakdown {
            id: self.new_id(),
            project_id: project_id.to_owned(),
            epic_id: epic_id.map(str::to_owned),
            epic,
            tasks,
            summary,
            created_at_epoch_ms: self.now(),
        };
        self.write(|transaction| {
            check_ticket_epic(transaction, project_id, epic_id)?;
            if count(transaction, "epic_breakdowns", project_id)? >= PROJECT_BREAKDOWNS_MAX {
                return Err(PmError::Constraint("too many waiting breakdowns"));
            }
            let epic_json = breakdown
                .epic
                .as_ref()
                .map(crate::store::to_json)
                .transpose()?;
            transaction.execute(
                "INSERT INTO epic_breakdowns (id, project_id, epic_id, epic_json, tasks_json, \
                     summary, created_at_epoch_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    breakdown.id,
                    breakdown.project_id,
                    breakdown.epic_id,
                    epic_json,
                    crate::store::to_json(&breakdown.tasks)?,
                    breakdown.summary,
                    breakdown.created_at_epoch_ms
                ],
            )?;
            Ok(breakdown.clone())
        })
    }

    pub fn epic_breakdowns(&self, project_id: &str) -> Result<Vec<EpicBreakdown>, PmError> {
        check_id(project_id, "projectId")?;
        project_breakdowns(self.connection(), project_id)
    }

    pub fn epic_breakdown(&self, breakdown_id: &str) -> Result<Option<EpicBreakdown>, PmError> {
        check_id(breakdown_id, "breakdownId")?;
        breakdown_by_id(self.connection(), breakdown_id)
    }

    /// Creates the breakdown's new epic, when it proposes one, and a ticket
    /// for each kept task (by index) under that epic in `sprint_id` or the
    /// backlog; then drops the breakdown.
    pub fn accept_epic_breakdown(
        &mut self,
        breakdown_id: &str,
        task_indices: &[usize],
        sprint_id: Option<&str>,
    ) -> Result<AcceptedBreakdown, PmError> {
        check_id(breakdown_id, "breakdownId")?;
        if let Some(sprint_id) = sprint_id {
            check_id(sprint_id, "sprintId")?;
        }
        let distinct = task_indices
            .iter()
            .enumerate()
            .all(|(position, index)| !task_indices[position + 1..].contains(index));
        if task_indices.is_empty() || !distinct {
            return Err(PmError::Invalid("taskIndices"));
        }
        let now = self.now();
        let ids = self.id_source();
        self.write(|transaction| {
            let breakdown = breakdown_by_id(transaction, breakdown_id)?.ok_or(PmError::NotFound)?;
            let project_id = breakdown.project_id.as_str();
            let mut tasks = Vec::with_capacity(task_indices.len());
            for index in task_indices {
                tasks.push(
                    breakdown
                        .tasks
                        .get(*index)
                        .ok_or(PmError::Invalid("taskIndices"))?,
                );
            }
            check_target_sprint(transaction, project_id, sprint_id)?;
            let epic = match (&breakdown.epic_id, &breakdown.epic) {
                (Some(epic_id), _) => require_epic(transaction, epic_id)?,
                (None, Some(draft)) => {
                    let epic = Epic {
                        id: ids(),
                        project_id: project_id.to_owned(),
                        title: draft.title.clone(),
                        description: draft.description.clone(),
                        created_at_epoch_ms: now,
                        updated_at_epoch_ms: now,
                    };
                    insert_epic(transaction, &epic)?;
                    epic
                }
                (None, None) => return Err(PmError::Invalid("epic")),
            };
            let mut tickets = Vec::with_capacity(tasks.len());
            for task in tasks {
                let id = ids();
                let ticket = NewTicket {
                    description: task.description.clone(),
                    description_author: TicketAuthor::Agent,
                    sprint_id: sprint_id.map(str::to_owned),
                    epic_id: Some(epic.id.clone()),
                    ..NewTicket::new(project_id, task.title.clone())
                };
                insert_ticket(transaction, &id, &ticket, now)?;
                for (position, text) in task.acceptance_criteria.iter().enumerate() {
                    transaction.execute(
                        "INSERT INTO ticket_criteria (id, ticket_id, position, text, done) \
                         VALUES (?1, ?2, ?3, ?4, 0)",
                        params![ids(), id, position, text],
                    )?;
                }
                tickets.push(ticket_by_id(transaction, &id)?.ok_or(PmError::NotFound)?);
            }
            transaction.execute("DELETE FROM epic_breakdowns WHERE id = ?1", [breakdown_id])?;
            Ok(AcceptedBreakdown { epic, tickets })
        })
    }

    pub fn reject_epic_breakdown(&mut self, breakdown_id: &str) -> Result<(), PmError> {
        check_id(breakdown_id, "breakdownId")?;
        self.write(|transaction| {
            let deleted =
                transaction.execute("DELETE FROM epic_breakdowns WHERE id = ?1", [breakdown_id])?;
            if deleted == 0 {
                return Err(PmError::NotFound);
            }
            Ok(())
        })
    }

    pub fn assistant_conversation(
        &self,
        project_id: &str,
    ) -> Result<Option<AssistantConversation>, PmError> {
        check_id(project_id, "projectId")?;
        assistant_conversation(self.connection(), project_id)
    }

    /// Records the conversation the project's assistant resumes, replacing
    /// an earlier one.
    pub fn remember_assistant_conversation(
        &mut self,
        conversation: &AssistantConversation,
    ) -> Result<(), PmError> {
        if !conversation.is_valid() {
            return Err(PmError::Invalid("conversation"));
        }
        self.write(|transaction| {
            transaction.execute(
                "INSERT INTO assistant_conversations (project_id, provider, conversation_id, \
                     cwd, started_at_epoch_ms) VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT (project_id) DO UPDATE SET provider = excluded.provider, \
                     conversation_id = excluded.conversation_id, cwd = excluded.cwd, \
                     started_at_epoch_ms = excluded.started_at_epoch_ms",
                params![
                    conversation.project_id,
                    conversation.provider,
                    conversation.conversation_id,
                    conversation.cwd,
                    conversation.started_at_epoch_ms
                ],
            )?;
            Ok(())
        })
    }

    /// Forgets the project's assistant conversation; the next launch starts
    /// a new one.
    pub fn forget_assistant_conversation(&mut self, project_id: &str) -> Result<(), PmError> {
        check_id(project_id, "projectId")?;
        self.write(|transaction| {
            transaction.execute(
                "DELETE FROM assistant_conversations WHERE project_id = ?1",
                [project_id],
            )?;
            Ok(())
        })
    }
}
