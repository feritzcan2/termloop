//! Sprint lifecycle: backlog -> planned -> active -> closed. A project has at
//! most one active sprint, and closing a sprint carries its unfinished
//! tickets over, counting each carry-over on the ticket.

use rusqlite::params;

use super::{check_id, next_rank, require_open_sprint, require_sprint};
use crate::sprint::{PROJECT_OPEN_SPRINTS_MAX, valid_sprint_goal, valid_sprint_name};
use crate::store::active_sprint;
use crate::{PmError, PmStore, Sprint, SprintState};

/// A closed sprint and the tickets it carried over, in their previous order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedSprint {
    pub sprint: Sprint,
    pub carried_over_ticket_ids: Vec<String>,
}

fn check_goal(goal: Option<&str>) -> Result<(), PmError> {
    if goal.is_none_or(valid_sprint_goal) {
        Ok(())
    } else {
        Err(PmError::Invalid("goal"))
    }
}

impl PmStore {
    /// Creates a sprint in the backlog or planned state; a sprint becomes
    /// active only through [`Self::activate_sprint`].
    pub fn create_sprint(
        &mut self,
        project_id: &str,
        name: &str,
        goal: Option<&str>,
        state: SprintState,
    ) -> Result<Sprint, PmError> {
        check_id(project_id, "projectId")?;
        if !valid_sprint_name(name) {
            return Err(PmError::Invalid("name"));
        }
        check_goal(goal)?;
        if !matches!(state, SprintState::Backlog | SprintState::Planned) {
            return Err(PmError::Invalid("state"));
        }
        let sprint = Sprint {
            id: self.new_id(),
            project_id: project_id.to_owned(),
            name: name.to_owned(),
            goal: goal.map(str::to_owned),
            state,
            created_at_epoch_ms: self.now(),
            activated_at_epoch_ms: None,
            closed_at_epoch_ms: None,
        };
        self.write(|transaction| {
            let open: usize = transaction.query_row(
                "SELECT COUNT(*) FROM sprints WHERE project_id = ?1 AND state != 'closed'",
                [project_id],
                |row| row.get(0),
            )?;
            if open >= PROJECT_OPEN_SPRINTS_MAX {
                return Err(PmError::Constraint("too many open sprints"));
            }
            transaction.execute(
                "INSERT INTO sprints (id, project_id, name, goal, state, created_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    sprint.id,
                    sprint.project_id,
                    sprint.name,
                    sprint.goal,
                    sprint.state.as_str(),
                    sprint.created_at_epoch_ms
                ],
            )?;
            Ok(())
        })?;
        Ok(sprint)
    }

    pub fn rename_sprint(&mut self, sprint_id: &str, name: &str) -> Result<Sprint, PmError> {
        if !valid_sprint_name(name) {
            return Err(PmError::Invalid("name"));
        }
        self.write(|transaction| {
            require_open_sprint(transaction, sprint_id)?;
            transaction.execute(
                "UPDATE sprints SET name = ?2 WHERE id = ?1",
                params![sprint_id, name],
            )?;
            require_sprint(transaction, sprint_id)
        })
    }

    /// Sets or clears (`None`) the sprint goal.
    pub fn set_sprint_goal(
        &mut self,
        sprint_id: &str,
        goal: Option<&str>,
    ) -> Result<Sprint, PmError> {
        check_goal(goal)?;
        self.write(|transaction| {
            require_open_sprint(transaction, sprint_id)?;
            transaction.execute(
                "UPDATE sprints SET goal = ?2 WHERE id = ?1",
                params![sprint_id, goal],
            )?;
            require_sprint(transaction, sprint_id)
        })
    }

    /// Schedules a backlog sprint. A planned sprint stays as it is.
    pub fn plan_sprint(&mut self, sprint_id: &str) -> Result<Sprint, PmError> {
        self.write(|transaction| {
            let sprint = require_open_sprint(transaction, sprint_id)?;
            match sprint.state {
                SprintState::Planned => return Ok(sprint),
                SprintState::Backlog => {}
                SprintState::Active | SprintState::Closed => {
                    return Err(PmError::Constraint("the sprint has already started"));
                }
            }
            transaction.execute(
                "UPDATE sprints SET state = 'planned' WHERE id = ?1",
                [sprint_id],
            )?;
            require_sprint(transaction, sprint_id)
        })
    }

    /// Starts a backlog or planned sprint. Refused while another sprint of
    /// the project is active; activating the active sprint changes nothing.
    pub fn activate_sprint(&mut self, sprint_id: &str) -> Result<Sprint, PmError> {
        let now = self.now();
        self.write(|transaction| {
            let sprint = require_open_sprint(transaction, sprint_id)?;
            if sprint.state == SprintState::Active {
                return Ok(sprint);
            }
            if active_sprint(transaction, &sprint.project_id)?.is_some() {
                return Err(PmError::Constraint("another sprint is already active"));
            }
            transaction.execute(
                "UPDATE sprints SET state = 'active', activated_at_epoch_ms = ?2 WHERE id = ?1",
                params![sprint_id, now],
            )?;
            require_sprint(transaction, sprint_id)
        })
    }

    /// Closes a sprint. Its unfinished tickets move, in order, to the end of
    /// `carry_over_to` (another open sprint of the project) or of the
    /// backlog, and each one's carry-over count grows by one. Done tickets
    /// stay with the closed sprint.
    pub fn close_sprint(
        &mut self,
        sprint_id: &str,
        carry_over_to: Option<&str>,
    ) -> Result<ClosedSprint, PmError> {
        let now = self.now();
        self.write(|transaction| {
            let sprint = require_open_sprint(transaction, sprint_id)?;
            if let Some(target_id) = carry_over_to {
                let target = require_open_sprint(transaction, target_id)?;
                if target.id == sprint.id || target.project_id != sprint.project_id {
                    return Err(PmError::Invalid("carryOverTo"));
                }
            }
            let carried = {
                let mut statement = transaction.prepare(
                    "SELECT id FROM tickets WHERE sprint_id = ?1 AND status != 'done' \
                     ORDER BY rank, id",
                )?;
                statement
                    .query_map([sprint_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let first_rank = next_rank(transaction, &sprint.project_id, carry_over_to)?;
            for (offset, ticket_id) in carried.iter().enumerate() {
                let rank = i64::try_from(offset)
                    .ok()
                    .and_then(|offset| first_rank.checked_add(offset))
                    .ok_or(PmError::Constraint("ticket rank overflow"))?;
                transaction.execute(
                    "UPDATE tickets SET sprint_id = ?2, rank = ?3, \
                         carry_over_count = carry_over_count + 1, updated_at_epoch_ms = ?4 \
                     WHERE id = ?1",
                    params![ticket_id, carry_over_to, rank, now],
                )?;
            }
            transaction.execute(
                "UPDATE sprints SET state = 'closed', closed_at_epoch_ms = ?2 WHERE id = ?1",
                params![sprint_id, now],
            )?;
            Ok(ClosedSprint {
                sprint: require_sprint(transaction, sprint_id)?,
                carried_over_ticket_ids: carried,
            })
        })
    }
}
