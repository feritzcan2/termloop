//! A delivery check's report: the agent's verdict on one Playbook step of
//! one ticket, with its evidence. It lands in the PM store only; nothing
//! external is written.

use super::checks::close_check;
use super::playbook::store_verdict;
use super::{check_id, require_ticket};
use crate::delivery::checks::{DeliveryCheck, DeliveryCheckOutcome};
use crate::playbook::{StepEvaluator, StepVerdict, StepVerdictRecord, valid_step_evidence};
use crate::store::{project_playbook, running_check};
use crate::{PmError, PmStore};

const MINUTE_MS: u64 = 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckReport {
    pub ticket_id: String,
    pub step_id: String,
    pub verdict: StepVerdict,
    /// One or two factual sentences: what was read and what it showed.
    pub evidence: String,
}

/// What recording a report changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCheckReport {
    pub verdict: StepVerdictRecord,
    /// The ticket's running check, now closed as reported.
    pub finished_check: Option<DeliveryCheck>,
}

impl PmStore {
    /// Records one check's verdict about a ticket of `project_id` in one
    /// transaction. A step not passed is looked at again after its retry
    /// time. The ticket's running check, if any, is closed as reported. An
    /// invalid report records nothing.
    pub fn record_check_report(
        &mut self,
        project_id: &str,
        report: CheckReport,
    ) -> Result<RecordedCheckReport, PmError> {
        check_id(project_id, "projectId")?;
        check_id(&report.step_id, "stepId")?;
        if !valid_step_evidence(&report.evidence) {
            return Err(PmError::Invalid("evidence"));
        }
        let now = self.now();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, &report.ticket_id)?;
            if ticket.project_id != project_id {
                return Err(PmError::NotFound);
            }
            let playbook = project_playbook(transaction, project_id)?;
            let agent = playbook
                .step(&report.step_id)
                .and_then(|step| step.agent.as_ref())
                .ok_or(PmError::Constraint("the step is not checked by an agent"))?;
            let verdict = StepVerdictRecord {
                ticket_id: ticket.id.clone(),
                step_id: report.step_id,
                verdict: report.verdict,
                evidence: report.evidence,
                evaluator: StepEvaluator::Agent,
                decided_at_epoch_ms: now,
                next_attempt_at_epoch_ms: (report.verdict != StepVerdict::Passed)
                    .then(|| now + u64::from(agent.retry_minutes) * MINUTE_MS),
            };
            store_verdict(transaction, &verdict)?;
            let finished_check = running_check(transaction, &ticket.id)?
                .map(|check| close_check(transaction, &check, DeliveryCheckOutcome::Reported, now))
                .transpose()?;
            Ok(RecordedCheckReport {
                verdict,
                finished_check,
            })
        })
    }
}
