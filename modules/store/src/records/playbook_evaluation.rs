use crate::{CoreWriteAuthority, CurrentState, Store, StoreError};
use termloop_domain::{
    PLAYBOOK_EVALUATIONS_PER_PROJECT_MAX, PlaybookEvaluationOutcome, PlaybookEvaluationRecord,
};

pub(crate) fn records_are_invalid(state: &CurrentState) -> bool {
    let mut ids = std::collections::HashSet::new();
    let mut counts = std::collections::HashMap::new();
    state.playbook_evaluations.iter().any(|record| {
        let count = counts.entry(&record.project_id).or_insert(0usize);
        *count += 1;
        !record.is_valid()
            || !ids.insert(&record.id)
            || *count > PLAYBOOK_EVALUATIONS_PER_PROJECT_MAX
            || !state.projects.iter().any(|p| p.id == record.project_id)
    })
}

pub(super) fn apply_finished(
    state: &mut CurrentState,
    record: PlaybookEvaluationRecord,
) -> Result<(), StoreError> {
    if !record.is_valid() || record.outcome == PlaybookEvaluationOutcome::InProgress {
        return Err(StoreError::ConstraintViolation);
    }
    let current = state
        .playbook_evaluations
        .iter_mut()
        .find(|entry| entry.id == record.id)
        .ok_or(StoreError::NotFound)?;
    if *current == record {
        return Ok(());
    }
    if current.outcome != PlaybookEvaluationOutcome::InProgress {
        return Err(StoreError::ConstraintViolation);
    }
    let mut expected = current.clone();
    expected.outcome = record.outcome;
    expected.evidence = record.evidence.clone();
    expected.finished_at_epoch_ms = record.finished_at_epoch_ms;
    if expected != record {
        return Err(StoreError::ConstraintViolation);
    }
    *current = record;
    Ok(())
}

impl Store {
    pub fn playbook_evaluations(&self) -> &[PlaybookEvaluationRecord] {
        &self.state.playbook_evaluations
    }

    pub fn start_playbook_evaluation(
        &mut self,
        _authority: &CoreWriteAuthority,
        record: PlaybookEvaluationRecord,
    ) -> Result<(), StoreError> {
        if !record.is_valid()
            || record.outcome != PlaybookEvaluationOutcome::InProgress
            || !self
                .state
                .projects
                .iter()
                .any(|p| p.id == record.project_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        if let Some(existing) = self
            .state
            .playbook_evaluations
            .iter()
            .find(|r| r.id == record.id)
        {
            return if existing == &record {
                Ok(())
            } else {
                Err(StoreError::ConstraintViolation)
            };
        }
        let previous = self.state.clone();
        if self
            .state
            .playbook_evaluations
            .iter()
            .filter(|r| r.project_id == record.project_id)
            .count()
            >= PLAYBOOK_EVALUATIONS_PER_PROJECT_MAX
        {
            let oldest = self
                .state
                .playbook_evaluations
                .iter()
                .enumerate()
                .filter(|(_, r)| {
                    r.project_id == record.project_id
                        && r.outcome != PlaybookEvaluationOutcome::InProgress
                })
                .min_by_key(|(_, r)| (r.started_at_epoch_ms, &r.id))
                .map(|(i, _)| i)
                .ok_or(StoreError::ConstraintViolation)?;
            self.state.playbook_evaluations.remove(oldest);
        }
        self.state.playbook_evaluations.push(record);
        self.commit_or_restore(previous).map(|_| ())
    }

    pub fn finish_playbook_evaluation(
        &mut self,
        _authority: &CoreWriteAuthority,
        record: PlaybookEvaluationRecord,
    ) -> Result<(), StoreError> {
        let previous = self.state.clone();
        apply_finished(&mut self.state, record)?;
        if self.state.playbook_evaluations == previous.playbook_evaluations {
            return Ok(());
        }
        self.commit_or_restore(previous).map(|_| ())
    }

    pub fn interrupt_playbook_evaluations_on_restart(
        &mut self,
        _authority: &CoreWriteAuthority,
        now: u64,
    ) -> Result<(), StoreError> {
        let previous = self.state.clone();
        for record in &mut self.state.playbook_evaluations {
            if record.outcome == PlaybookEvaluationOutcome::InProgress {
                record.outcome = PlaybookEvaluationOutcome::Interrupted;
                record.finished_at_epoch_ms = Some(now.max(record.started_at_epoch_ms));
                record.evidence =
                    "The application restarted before this check recorded a result.".into();
            }
        }
        if self.state.playbook_evaluations == previous.playbook_evaluations {
            return Ok(());
        }
        self.commit_or_restore(previous).map(|_| ())
    }
}
