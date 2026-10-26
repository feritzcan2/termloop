//! The Playbook: saving a project's steps, a setup's proposal the PM reviews,
//! and the verdicts the PM gives by hand. Agent verdicts land through a
//! check report.

use rusqlite::{Connection, Transaction, params};

use super::{check_id, require_ticket};
use crate::playbook::{
    Playbook, PlaybookProposal, PlaybookStep, StepEvaluator, StepVerdict, StepVerdictRecord,
    valid_playbook_steps, valid_playbook_summary, valid_step_evidence,
};
use crate::store::{playbook_proposal, project_playbook, to_json};
use crate::{PmError, PmStore};

/// What a PM-marked step says as its evidence.
pub const MARKED_PASSED_EVIDENCE: &str = "Marked passed by the project manager.";

/// Replaces a stored verdict.
pub(super) fn store_verdict(
    connection: &Connection,
    record: &StepVerdictRecord,
) -> Result<(), PmError> {
    if !valid_step_evidence(&record.evidence) || record.evaluator == StepEvaluator::Facts {
        return Err(PmError::Invalid("evidence"));
    }
    connection.execute(
        "INSERT INTO playbook_verdicts (ticket_id, step_id, verdict, evidence, evaluator, \
             decided_at_epoch_ms, next_attempt_at_epoch_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT (ticket_id, step_id) DO UPDATE SET \
             verdict = excluded.verdict, evidence = excluded.evidence, \
             evaluator = excluded.evaluator, \
             decided_at_epoch_ms = excluded.decided_at_epoch_ms, \
             next_attempt_at_epoch_ms = excluded.next_attempt_at_epoch_ms",
        params![
            record.ticket_id,
            record.step_id,
            record.verdict.as_str(),
            record.evidence,
            record.evaluator.as_str(),
            record.decided_at_epoch_ms,
            record.next_attempt_at_epoch_ms
        ],
    )?;
    Ok(())
}

/// Stores the next steps. A stored verdict survives only for a step still
/// asked the same way.
fn replace_playbook(
    transaction: &Transaction<'_>,
    project_id: &str,
    steps: Vec<PlaybookStep>,
    now: u64,
) -> Result<Playbook, PmError> {
    let previous = project_playbook(transaction, project_id)?;
    let playbook = Playbook {
        project_id: project_id.to_owned(),
        revision: previous.revision + 1,
        steps,
        updated_at_epoch_ms: now,
    };
    for step in &previous.steps {
        let kept = playbook
            .step(&step.id)
            .is_some_and(|next| step.same_question(next));
        if !kept {
            transaction.execute(
                "DELETE FROM playbook_verdicts WHERE step_id = ?2 \
                 AND ticket_id IN (SELECT id FROM tickets WHERE project_id = ?1)",
                params![project_id, step.id],
            )?;
        }
    }
    transaction.execute(
        "INSERT INTO playbooks (project_id, revision, steps_json, updated_at_epoch_ms) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (project_id) DO UPDATE SET revision = excluded.revision, \
             steps_json = excluded.steps_json, \
             updated_at_epoch_ms = excluded.updated_at_epoch_ms",
        params![
            project_id,
            playbook.revision,
            to_json(&playbook.steps)?,
            now
        ],
    )?;
    Ok(playbook)
}

fn valid_steps(steps: &[PlaybookStep]) -> Result<(), PmError> {
    if valid_playbook_steps(steps) {
        Ok(())
    } else {
        Err(PmError::Invalid("steps"))
    }
}

impl PmStore {
    /// The project's Playbook; the default steps when it never saved one.
    pub fn playbook(&self, project_id: &str) -> Result<Playbook, PmError> {
        check_id(project_id, "projectId")?;
        project_playbook(self.connection(), project_id)
    }

    /// Replaces the project's steps. `base_revision` is the revision the PM
    /// edited; a save over a newer one is refused.
    pub fn save_playbook(
        &mut self,
        project_id: &str,
        base_revision: u64,
        steps: Vec<PlaybookStep>,
    ) -> Result<Playbook, PmError> {
        check_id(project_id, "projectId")?;
        valid_steps(&steps)?;
        let now = self.now();
        self.write(|transaction| {
            if project_playbook(transaction, project_id)?.revision != base_revision {
                return Err(PmError::Constraint(
                    "the playbook changed since it was read",
                ));
            }
            replace_playbook(transaction, project_id, steps, now)
        })
    }

    /// Keeps what a Playbook setup found for the PM, replacing an earlier
    /// proposal.
    pub fn propose_playbook(
        &mut self,
        project_id: &str,
        summary: String,
        steps: Vec<PlaybookStep>,
    ) -> Result<PlaybookProposal, PmError> {
        check_id(project_id, "projectId")?;
        if !valid_playbook_summary(&summary) {
            return Err(PmError::Invalid("summary"));
        }
        valid_steps(&steps)?;
        let proposal = PlaybookProposal {
            project_id: project_id.to_owned(),
            summary,
            steps,
            created_at_epoch_ms: self.now(),
        };
        self.write(|transaction| {
            transaction.execute(
                "INSERT INTO playbook_proposals (project_id, summary, steps_json, \
                     created_at_epoch_ms) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT (project_id) DO UPDATE SET summary = excluded.summary, \
                     steps_json = excluded.steps_json, \
                     created_at_epoch_ms = excluded.created_at_epoch_ms",
                params![
                    proposal.project_id,
                    proposal.summary,
                    to_json(&proposal.steps)?,
                    proposal.created_at_epoch_ms
                ],
            )?;
            Ok(proposal.clone())
        })
    }

    pub fn playbook_proposal(&self, project_id: &str) -> Result<Option<PlaybookProposal>, PmError> {
        check_id(project_id, "projectId")?;
        playbook_proposal(self.connection(), project_id)
    }

    /// Saves the steps the PM kept from the proposal, as edited, and drops
    /// the proposal.
    pub fn apply_playbook_proposal(
        &mut self,
        project_id: &str,
        steps: Vec<PlaybookStep>,
    ) -> Result<Playbook, PmError> {
        check_id(project_id, "projectId")?;
        valid_steps(&steps)?;
        let now = self.now();
        self.write(|transaction| {
            if playbook_proposal(transaction, project_id)?.is_none() {
                return Err(PmError::NotFound);
            }
            transaction.execute(
                "DELETE FROM playbook_proposals WHERE project_id = ?1",
                [project_id],
            )?;
            replace_playbook(transaction, project_id, steps, now)
        })
    }

    pub fn discard_playbook_proposal(&mut self, project_id: &str) -> Result<(), PmError> {
        check_id(project_id, "projectId")?;
        self.write(|transaction| {
            let removed = transaction.execute(
                "DELETE FROM playbook_proposals WHERE project_id = ?1",
                [project_id],
            )?;
            if removed == 0 {
                Err(PmError::NotFound)
            } else {
                Ok(())
            }
        })
    }

    /// The PM's own answer for one step of one ticket: passed, or cleared so
    /// the step is looked at again.
    pub fn mark_step(
        &mut self,
        ticket_id: &str,
        step_id: &str,
        passed: bool,
    ) -> Result<(), PmError> {
        check_id(step_id, "stepId")?;
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, ticket_id)?;
            if project_playbook(transaction, &ticket.project_id)?
                .step(step_id)
                .is_none()
            {
                return Err(PmError::NotFound);
            }
            if passed {
                store_verdict(
                    transaction,
                    &StepVerdictRecord {
                        ticket_id: ticket.id,
                        step_id: step_id.to_owned(),
                        verdict: StepVerdict::Passed,
                        evidence: MARKED_PASSED_EVIDENCE.to_owned(),
                        evaluator: StepEvaluator::ProjectManager,
                        decided_at_epoch_ms: now,
                        next_attempt_at_epoch_ms: None,
                    },
                )
            } else {
                transaction.execute(
                    "DELETE FROM playbook_verdicts WHERE ticket_id = ?1 AND step_id = ?2",
                    params![ticket.id, step_id],
                )?;
                Ok(())
            }
        })
    }
}
