use termloop_domain::{
    PlaybookConfiguration, PlaybookStepProgress, StewardConfiguration, TrackerConfiguration,
    WorkerConfiguration,
};

use super::super::{CoreWriteAuthority, CurrentState, Store, StoreError};

/// One atomic replacement of the user-owned Playbook and every internal
/// on-demand check needed to execute it. A Worker may be created in the same
/// transaction when the Project has no execution capacity yet, and the first
/// executable Playbook may activate its already-configured Steward.
#[derive(Debug, Clone)]
pub struct PlaybookApply {
    pub configuration: PlaybookConfiguration,
    pub steward_configuration: Option<StewardConfiguration>,
    pub create_worker: Option<WorkerConfiguration>,
    pub upsert_routines: Vec<TrackerConfiguration>,
    pub delete_routine_ids: Vec<String>,
}

/// Whether one answer contradicts the state it is stored in.
///
/// The same rule decides a write and a load: an answer belongs to exactly one
/// existing Task, answers a question that Task's Project is asking on the
/// pipeline it is walking right now, and is the only answer that Task gives to
/// that question. Writing rows the loader would reject would produce a state
/// file that no longer reopens, so both paths ask this one question.
pub(crate) fn step_progress_conflicts(
    state: &CurrentState,
    progress: &PlaybookStepProgress,
    others: &[PlaybookStepProgress],
) -> bool {
    let Some(task) = state.tasks.iter().find(|task| task.id == progress.task_id) else {
        return true;
    };
    !progress.is_valid()
        || !state.playbook_configurations.iter().any(|configuration| {
            configuration.project_id == task.project_id
                && configuration.progress_matches_current_step(progress)
        })
        || others.iter().any(|candidate| {
            candidate.task_id == progress.task_id && candidate.milestone_id == progress.milestone_id
        })
}

impl Store {
    pub fn playbook_configurations(&self) -> &[PlaybookConfiguration] {
        &self.state.playbook_configurations
    }

    /// The one Playbook document this Project keeps, if it has one.
    pub fn playbook_for_project(&self, project_id: &str) -> Option<&PlaybookConfiguration> {
        self.state
            .playbook_configurations
            .iter()
            .find(|configuration| configuration.project_id == project_id)
    }

    /// Every Task's current answer to the questions its Project is asking.
    pub fn playbook_step_progress(&self) -> &[PlaybookStepProgress] {
        &self.state.playbook_step_progress
    }

    /// Applies a complete Playbook execution plan in one durable commit.
    /// There is no observable revision in which the document exists without
    /// its checks, or its checks exist without the document that owns them.
    pub fn apply_playbook(
        &mut self,
        _authority: &CoreWriteAuthority,
        apply: PlaybookApply,
        expected_revision: u64,
    ) -> Result<PlaybookConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let previous = self.state.clone();
        let mut next = previous.clone();

        if let Some(steward) = apply.steward_configuration {
            if steward.project_id != apply.configuration.project_id || !steward.enabled {
                return Err(StoreError::ConstraintViolation);
            }
            let Some(current) = next
                .steward_configurations
                .iter_mut()
                .find(|current| current.project_id == steward.project_id)
            else {
                return Err(StoreError::ConstraintViolation);
            };
            *current = steward.clone();
            super::configuration_version::record_steward_version(
                &mut next,
                &steward,
                None,
                "Playbook activated Steward",
            );
        }

        if let Some(worker) = apply.create_worker {
            if next
                .worker_configurations
                .iter()
                .any(|current| current.id == worker.id)
            {
                return Err(StoreError::AlreadyExists);
            }
            next.worker_configurations.push(worker.clone());
            super::configuration_version::record_worker_version(
                &mut next,
                &worker,
                None,
                "Playbook created Worker",
            );
        }

        let upsert_ids = apply
            .upsert_routines
            .iter()
            .map(|routine| routine.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if apply
            .delete_routine_ids
            .iter()
            .any(|id| upsert_ids.contains(id.as_str()))
        {
            return Err(StoreError::ConstraintViolation);
        }
        let deleted_routines = next
            .tracker_configurations
            .iter()
            .filter(|routine| apply.delete_routine_ids.iter().any(|id| id == &routine.id))
            .map(|routine| (routine.project_id.clone(), routine.id.clone()))
            .collect::<Vec<_>>();
        next.tracker_configurations
            .retain(|routine| !apply.delete_routine_ids.iter().any(|id| id == &routine.id));
        for routine in apply.upsert_routines {
            match next
                .tracker_configurations
                .iter()
                .position(|current| current.id == routine.id)
            {
                Some(index) => next.tracker_configurations[index] = routine.clone(),
                None => next.tracker_configurations.push(routine.clone()),
            }
            super::configuration_version::record_routine_version(
                &mut next,
                &routine,
                None,
                "Playbook saved Routine",
            );
        }
        for (project_id, routine_id) in deleted_routines {
            let target = termloop_domain::ImproverSessionTarget {
                target_kind: termloop_domain::ImproverSessionTargetKind::RoutineInstructions,
                target_id: Some(routine_id),
            };
            super::configuration_version::remove_configuration_target_state(
                &mut next,
                &project_id,
                &target,
            );
        }

        match next
            .playbook_configurations
            .iter()
            .position(|current| current.project_id == apply.configuration.project_id)
        {
            Some(index) => next.playbook_configurations[index] = apply.configuration.clone(),
            None => next
                .playbook_configurations
                .push(apply.configuration.clone()),
        }
        super::configuration_version::record_playbook_version(
            &mut next,
            &apply.configuration,
            None,
            "Playbook saved",
        );

        // Step answers are current state for the active pipeline. Replacing the
        // document retires every answer that the next active pipeline no longer
        // asks, in the same transaction as the checks and document.
        let project_task_ids = next
            .tasks
            .iter()
            .filter(|task| task.project_id == apply.configuration.project_id)
            .map(|task| task.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        next.playbook_step_progress.retain(|progress| {
            !project_task_ids.contains(progress.task_id.as_str())
                || apply.configuration.progress_matches_current_step(progress)
        });

        crate::validation::validate_current_state(&next)
            .map_err(|_| StoreError::ConstraintViolation)?;
        self.state = next;
        self.commit_or_restore(previous)?;
        Ok(apply.configuration)
    }

    /// Replaces the one current Playbook document for its Project, creating it
    /// when absent. Document-revision monotonicity is checked by core; the
    /// store enforces validity, project existence, and the global revision CAS.
    ///
    /// Stored verdicts are scoped to the pipeline a Project is actually
    /// walking, so this drops in the same transaction every answer the next
    /// document no longer asks for. Splitting that into a second command would
    /// leave a revision in which a Task's position is read from answers to
    /// questions that are gone.
    pub fn set_playbook_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration: PlaybookConfiguration,
        expected_revision: u64,
    ) -> Result<PlaybookConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !configuration.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == configuration.project_id)
            // Every step names the Routine that checks it; that Routine must
            // already exist in this Project, or the step could never be decided.
            // Kept pipelines are checked too: one naming a deleted Routine
            // would only break later, the moment the user switched back to it.
            || configuration.all_milestones().any(|milestone| {
                !self.state.tracker_configurations.iter().any(|routine| {
                    routine.id == milestone.routine_id
                        && routine.project_id == configuration.project_id
                })
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let project_task_ids = self.project_task_ids(&configuration.project_id);
        let retained = |progress: &PlaybookStepProgress| {
            !project_task_ids.contains(&progress.task_id)
                || configuration.progress_matches_current_step(progress)
        };
        let current_index = self
            .state
            .playbook_configurations
            .iter()
            .position(|current| current.project_id == configuration.project_id);
        if current_index.map(|index| &self.state.playbook_configurations[index])
            == Some(&configuration)
            && self.state.playbook_step_progress.iter().all(retained)
        {
            return Ok(configuration);
        }
        let previous = self.state.clone();
        if let Some(index) = current_index {
            self.state.playbook_configurations[index] = configuration.clone();
        } else {
            self.state
                .playbook_configurations
                .push(configuration.clone());
        }
        super::configuration_version::record_playbook_version(
            &mut self.state,
            &configuration,
            None,
            "Playbook saved",
        );
        self.state.playbook_step_progress.retain(retained);
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    /// Records the focused Task's answer to one pipeline step. The command
    /// retains its vector shape so validation and persistence remain atomic.
    pub fn record_playbook_step_progress(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        answers: Vec<PlaybookStepProgress>,
        expected_revision: u64,
    ) -> Result<Vec<PlaybookStepProgress>, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if self.playbook_for_project(project_id).is_none() {
            return Err(StoreError::NotFound);
        }
        if step_progress_batch_is_invalid(&self.state, project_id, &answers) {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        apply_step_progress(&mut self.state, &answers);
        if self.state.playbook_step_progress == previous.playbook_step_progress {
            return Ok(answers);
        }
        self.commit_or_restore(previous)?;
        Ok(answers)
    }

    /// Records one pipeline verdict batch and the exact on-demand Routine
    /// state derived from that same batch in one durable commit. Waiting
    /// findings must never exist without their verdict, and a moved Task must
    /// never retain a finding that the same run made stale.
    pub fn record_playbook_step_progress_with_routine(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        answers: Vec<PlaybookStepProgress>,
        routine: TrackerConfiguration,
        expected_revision: u64,
    ) -> Result<Vec<PlaybookStepProgress>, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if self.playbook_for_project(project_id).is_none()
            || routine.project_id != project_id
            || routine.trigger_mode.is_scheduled()
            || step_progress_batch_is_invalid(&self.state, project_id, &answers)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let Some(routine_index) = self
            .state
            .tracker_configurations
            .iter()
            .position(|current| current.id == routine.id && current.project_id == project_id)
        else {
            return Err(StoreError::NotFound);
        };
        if answers.iter().any(|answer| answer.routine_id != routine.id) {
            return Err(StoreError::ConstraintViolation);
        }

        let previous = self.state.clone();
        let mut next = previous.clone();
        apply_step_progress(&mut next, &answers);
        next.tracker_configurations[routine_index] = routine;
        crate::validation::validate_current_state(&next)
            .map_err(|_| StoreError::ConstraintViolation)?;
        self.state = next;
        self.commit_or_restore(previous)?;
        Ok(answers)
    }

    /// Replaces every current pipeline answer for exactly one Task in one
    /// commit. Core owns which answers represent the requested position; the
    /// Store only proves that the complete replacement belongs to this Task
    /// and to questions its Project is currently asking.
    pub fn replace_task_playbook_progress(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        task_id: &str,
        answers: Vec<PlaybookStepProgress>,
        expected_revision: u64,
    ) -> Result<Vec<PlaybookStepProgress>, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !self
            .state
            .tasks
            .iter()
            .any(|task| task.id == task_id && task.project_id == project_id)
            || self.playbook_for_project(project_id).is_none()
            || answers.iter().any(|answer| answer.task_id != task_id)
        {
            return Err(StoreError::ConstraintViolation);
        }

        let mut next = self.state.clone();
        next.playbook_step_progress
            .retain(|progress| progress.task_id != task_id);
        next.playbook_step_progress.extend(answers.iter().cloned());
        for routine in &mut next.tracker_configurations {
            if !routine.trigger_mode.is_scheduled() {
                routine
                    .pending_routine_findings
                    .retain(|finding| !finding.related_task_ids.iter().any(|id| id == task_id));
            }
        }
        if crate::validation::validate_current_state(&next).is_err() {
            return Err(StoreError::ConstraintViolation);
        }
        if next.playbook_step_progress == self.state.playbook_step_progress
            && next.tracker_configurations == self.state.tracker_configurations
        {
            return Ok(answers);
        }
        let previous = std::mem::replace(&mut self.state, next);
        self.commit_or_restore(previous)?;
        Ok(answers)
    }

    fn project_task_ids(&self, project_id: &str) -> Vec<String> {
        self.state
            .tasks
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.id.clone())
            .collect()
    }
}

fn step_progress_batch_is_invalid(
    state: &CurrentState,
    project_id: &str,
    answers: &[PlaybookStepProgress],
) -> bool {
    answers.iter().enumerate().any(|(index, answer)| {
        // The batch is addressed to one Project, so an answer for a Task
        // outside it is refused before the shared rule resolves that Task's
        // own Project and finds a question there.
        !state
            .tasks
            .iter()
            .any(|task| task.id == answer.task_id && task.project_id == project_id)
            || step_progress_conflicts(state, answer, &answers[index + 1..])
    })
}

fn apply_step_progress(state: &mut CurrentState, answers: &[PlaybookStepProgress]) {
    for answer in answers {
        let existing = state.playbook_step_progress.iter().position(|current| {
            current.task_id == answer.task_id && current.milestone_id == answer.milestone_id
        });
        match existing {
            Some(index) => state.playbook_step_progress[index] = answer.clone(),
            None => state.playbook_step_progress.push(answer.clone()),
        }
    }
}
