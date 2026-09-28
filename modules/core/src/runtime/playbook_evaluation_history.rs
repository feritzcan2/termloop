use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde_json::{Value, json};
use termloop_domain::{
    PlaybookEvaluationOutcome as Outcome, PlaybookEvaluationRecord, PlaybookStepProgress,
    PlaybookStepVerdict,
};

impl CoreRuntime {
    pub(crate) fn playbook_evaluation_history(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let mut entries = self
            .store
            .playbook_evaluations()
            .iter()
            .filter(|record| record.project_id == project_id)
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| (b.started_at_epoch_ms, &b.id).cmp(&(a.started_at_epoch_ms, &a.id)));
        Ok(
            json!({"entries": entries, "retentionLimit": termloop_domain::PLAYBOOK_EVALUATIONS_PER_PROJECT_MAX, "stateRevision": self.store.revision()}),
        )
    }

    pub(crate) fn completed_evaluation_record(
        &self,
        check_id: &str,
        answer: &PlaybookStepProgress,
    ) -> Option<PlaybookEvaluationRecord> {
        let mut record = self
            .store
            .playbook_evaluations()
            .iter()
            .find(|r| r.id == check_id && r.outcome == Outcome::InProgress)?
            .clone();
        record.outcome = match answer.verdict {
            PlaybookStepVerdict::Passed => Outcome::Passed,
            PlaybookStepVerdict::Waiting => Outcome::Waiting,
            PlaybookStepVerdict::Blocked => Outcome::Blocked,
        };
        record.finished_at_epoch_ms = Some(answer.decided_at_epoch_ms);
        record.evidence = answer.evidence.clone();
        Some(record)
    }

    pub(crate) fn interrupt_evaluation_record(
        &mut self,
        check_id: &str,
        outcome: Outcome,
        evidence: &str,
    ) -> Result<(), CoreError> {
        let Some(mut record) = self
            .store
            .playbook_evaluations()
            .iter()
            .find(|r| r.id == check_id && r.outcome == Outcome::InProgress)
            .cloned()
        else {
            return Ok(());
        };
        record.outcome = outcome;
        record.evidence = evidence.into();
        record.finished_at_epoch_ms =
            Some(termloop_platform::current_epoch_ms().max(record.started_at_epoch_ms));
        self.store
            .finish_playbook_evaluation(&self.write_authority, record)
            .map_err(store_error)
    }
}
