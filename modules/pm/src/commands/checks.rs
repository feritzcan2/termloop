//! Delivery check bookkeeping. The daemon starts and runs the agent; the
//! store records that a check runs, refuses a second one for the same
//! ticket, and closes it when the report lands, the agent ends, or the
//! deadline passes.

use rusqlite::{Connection, params};

use super::{check_id, require_ticket};
use crate::delivery::checks::{
    CHECK_DEADLINE_MS, DeliveryCheck, DeliveryCheckOutcome, DeliveryCheckReason, DueCheck,
    DueInputs, PROJECT_RUNNING_CHECKS_MAX, TICKET_FINISHED_CHECKS_MAX, due_check,
};
use crate::playbook::ticket_playbook;
use crate::store::{
    all_running_checks, check_by_id, project_checks, project_playbook, project_running_checks,
    running_check, ticket_facts, ticket_verdicts,
};
use crate::{PmError, PmStore, SprintState};

/// Closes a running check and drops the ticket's oldest finished checks
/// beyond the bound.
pub(super) fn close_check(
    connection: &Connection,
    check: &DeliveryCheck,
    outcome: DeliveryCheckOutcome,
    now: u64,
) -> Result<DeliveryCheck, PmError> {
    let finished = now.max(check.started_at_epoch_ms);
    connection.execute(
        "UPDATE delivery_checks SET finished_at_epoch_ms = ?2, outcome = ?3 WHERE id = ?1",
        params![check.id, finished, outcome.as_str()],
    )?;
    connection.execute(
        "DELETE FROM delivery_checks WHERE id IN ( \
             SELECT id FROM delivery_checks \
             WHERE ticket_id = ?1 AND finished_at_epoch_ms IS NOT NULL \
             ORDER BY started_at_epoch_ms DESC, id DESC LIMIT -1 OFFSET ?2)",
        params![check.ticket_id, TICKET_FINISHED_CHECKS_MAX],
    )?;
    Ok(DeliveryCheck {
        finished_at_epoch_ms: Some(finished),
        outcome: Some(outcome),
        ..check.clone()
    })
}

impl PmStore {
    /// Records that a check of one step starts. Refused when the step is not
    /// agent-checked, the ticket already has a running check, or the project
    /// runs as many checks as it may.
    pub fn start_check(&mut self, new: DueCheck) -> Result<DeliveryCheck, PmError> {
        check_id(&new.step_id, "stepId")?;
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, &new.ticket_id)?;
            let checked = project_playbook(transaction, &ticket.project_id)?
                .step(&new.step_id)
                .is_some_and(|step| step.agent.is_some());
            if !checked {
                return Err(PmError::Constraint("the step is not checked by an agent"));
            }
            if running_check(transaction, &ticket.id)?.is_some() {
                return Err(PmError::Constraint(
                    "a check is already running for the ticket",
                ));
            }
            if project_running_checks(transaction, &ticket.project_id)?.len()
                >= PROJECT_RUNNING_CHECKS_MAX
            {
                return Err(PmError::Constraint("too many running checks"));
            }
            let check = DeliveryCheck {
                id,
                project_id: ticket.project_id,
                ticket_id: ticket.id,
                step_id: new.step_id,
                reason: new.reason,
                started_at_epoch_ms: now,
                finished_at_epoch_ms: None,
                outcome: None,
            };
            transaction.execute(
                "INSERT INTO delivery_checks (id, project_id, ticket_id, step_id, reason, \
                     started_at_epoch_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    check.id,
                    check.project_id,
                    check.ticket_id,
                    check.step_id,
                    check.reason.as_str(),
                    check.started_at_epoch_ms
                ],
            )?;
            Ok(check)
        })
    }

    /// Closes a running check with its outcome; a finished one is refused.
    pub fn finish_check(
        &mut self,
        check_id_value: &str,
        outcome: DeliveryCheckOutcome,
    ) -> Result<DeliveryCheck, PmError> {
        check_id(check_id_value, "checkId")?;
        let now = self.now();
        self.write(|transaction| {
            let check = check_by_id(transaction, check_id_value)?.ok_or(PmError::NotFound)?;
            if !check.is_running() {
                return Err(PmError::Constraint("the check already finished"));
            }
            close_check(transaction, &check, outcome, now)
        })
    }

    /// Abandons every check still running past the deadline at
    /// `now_epoch_ms`, across projects. The daemon calls this on its
    /// schedule, and after a restart with `u64::MAX` since no agent of an
    /// earlier run is still alive.
    pub fn abandon_stale_checks(
        &mut self,
        now_epoch_ms: u64,
    ) -> Result<Vec<DeliveryCheck>, PmError> {
        let now = self.now();
        self.write(|transaction| {
            all_running_checks(transaction)?
                .iter()
                .filter(|check| {
                    check.started_at_epoch_ms.saturating_add(CHECK_DEADLINE_MS) <= now_epoch_ms
                })
                .map(|check| close_check(transaction, check, DeliveryCheckOutcome::Abandoned, now))
                .collect()
        })
    }

    /// A project's kept checks, oldest first.
    pub fn delivery_checks(&self, project_id: &str) -> Result<Vec<DeliveryCheck>, PmError> {
        check_id(project_id, "projectId")?;
        project_checks(self.connection(), project_id)
    }

    /// Tickets of the active sprint whose next step an agent should look
    /// at now and that have no check running, in board order.
    pub fn checks_due(&self, project_id: &str) -> Result<Vec<DueCheck>, PmError> {
        let board = self.board(project_id)?;
        if !board.tracking.deploy {
            return Ok(Vec::new());
        }
        let active = board
            .sprints
            .iter()
            .find(|sprint| sprint.state == SprintState::Active)
            .map(|sprint| sprint.id.clone());
        let checks = project_checks(self.connection(), project_id)?;
        let now = self.now();
        Ok(board
            .tickets
            .iter()
            .zip(&board.deliveries)
            .filter_map(|(ticket, delivery)| {
                due_check(DueInputs {
                    ticket_id: &ticket.id,
                    playbook: &board.playbook,
                    progress: &delivery.playbook,
                    in_active_sprint: active.is_some() && ticket.sprint_id == active,
                    last_check: checks
                        .iter()
                        .rev()
                        .find(|check| check.ticket_id == ticket.id),
                    now_epoch_ms: now,
                })
            })
            .collect())
    }

    /// The check the PM asks for: the ticket's next step, when an agent
    /// checks it, whatever its retry time says. `None` when the next step is
    /// not agent-checked or every step passed.
    pub fn requested_check(&self, ticket_id: &str) -> Result<Option<DueCheck>, PmError> {
        let connection = self.connection();
        let ticket = require_ticket(connection, ticket_id)?;
        let playbook = project_playbook(connection, &ticket.project_id)?;
        let progress = ticket_playbook(
            &playbook,
            ticket.status,
            ticket_facts(connection, &ticket.id)?.as_ref(),
            &ticket_verdicts(connection, &ticket.id)?,
        );
        Ok(progress
            .next_index()
            .map(|index| &playbook.steps[index])
            .filter(|step| step.agent.is_some())
            .map(|step| DueCheck {
                ticket_id: ticket.id.clone(),
                step_id: step.id.clone(),
                reason: DeliveryCheckReason::Requested,
            }))
    }
}
