//! Delivery check bookkeeping. The daemon starts and runs the agent; the
//! store records that a check runs, refuses a second one for the same
//! ticket, and closes it when the report lands, the agent ends, or the
//! deadline passes.

use rusqlite::{Connection, params};

use super::{check_id, require_ticket};
use crate::delivery::checks::{
    CHECK_DEADLINE_MS, DeliveryCheck, DeliveryCheckOutcome, DeliveryCheckReason, DueCheck,
    DueInputs, PROJECT_RUNNING_CHECKS_MAX, TICKET_FINISHED_CHECKS_MAX, due_check,
    valid_check_environments,
};
use crate::store::{
    all_running_checks, check_by_id, project_checks, project_environments, project_facts,
    project_probes, project_running_checks, running_check, to_json,
};
use crate::{PmError, PmStore, ProbeMatcher, ProbeStatus, SprintState, deploy_tracking_enabled};

/// A check the daemon is about to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCheck {
    pub ticket_id: String,
    pub reason: DeliveryCheckReason,
    pub environments: Vec<String>,
    /// Required for `probeChanged`, absent otherwise.
    pub probe_id: Option<String>,
}

impl From<DueCheck> for NewCheck {
    fn from(due: DueCheck) -> Self {
        Self {
            ticket_id: due.ticket_id,
            reason: due.reason,
            environments: due.environments,
            probe_id: due.probe_id,
        }
    }
}

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
    /// Records that a check starts. Refused when the project does not track
    /// deployments, the ticket already has a running check, or the project
    /// runs as many checks as it may.
    pub fn start_check(&mut self, new: NewCheck) -> Result<DeliveryCheck, PmError> {
        if !valid_check_environments(&new.environments) {
            return Err(PmError::Invalid("environments"));
        }
        if (new.reason == DeliveryCheckReason::ProbeChanged) != new.probe_id.is_some() {
            return Err(PmError::Invalid("probeId"));
        }
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, &new.ticket_id)?;
            let probes = project_probes(transaction, &ticket.project_id)?;
            let environments = project_environments(transaction, &ticket.project_id)?;
            if !deploy_tracking_enabled(&environments, &probes) {
                return Err(PmError::Constraint(
                    "the project does not track deployments",
                ));
            }
            if let Some(probe_id) = &new.probe_id {
                let usable = probes.iter().any(|probe| {
                    probe.id == *probe_id
                        && probe.status == ProbeStatus::Approved
                        && probe.matcher == ProbeMatcher::Agent
                });
                if !usable {
                    return Err(PmError::Invalid("probeId"));
                }
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
                reason: new.reason,
                environments: new.environments,
                probe_id: new.probe_id,
                started_at_epoch_ms: now,
                finished_at_epoch_ms: None,
                outcome: None,
            };
            transaction.execute(
                "INSERT INTO delivery_checks (id, project_id, ticket_id, reason, \
                     environments_json, probe_id, started_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    check.id,
                    check.project_id,
                    check.ticket_id,
                    check.reason.as_str(),
                    to_json(&check.environments)?,
                    check.probe_id,
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

    /// Tickets of the active sprint that need a check and have none
    /// running, in board order. Empty unless the project tracks
    /// deployments.
    pub fn checks_due(&self, project_id: &str) -> Result<Vec<DueCheck>, PmError> {
        let board = self.board(project_id)?;
        if !board.tracking.deploy {
            return Ok(Vec::new());
        }
        let connection = self.connection();
        let active = board
            .sprints
            .iter()
            .find(|sprint| sprint.state == SprintState::Active)
            .map(|sprint| sprint.id.clone());
        let facts = project_facts(connection, project_id)?;
        let checks = project_checks(connection, project_id)?;
        let environments: Vec<String> = board
            .environments
            .iter()
            .map(|environment| environment.name.clone())
            .collect();
        let now = self.now();
        Ok(board
            .tickets
            .iter()
            .zip(&board.deliveries)
            .filter_map(|(ticket, delivery)| {
                due_check(DueInputs {
                    delivery,
                    facts: facts.get(&ticket.id),
                    probes: &board.probes,
                    environments: &environments,
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
}
