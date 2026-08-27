use termloop_domain::{
    RUN_CONFIGURATIONS_PER_PROJECT_MAX, RUN_SETUP_MARKS_PER_PROJECT_MAX, RunConfiguration,
    RunSetupMark, SessionKind, SessionRecord,
};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn run_configurations(&self) -> &[RunConfiguration] {
        &self.state.run_configurations
    }

    pub fn run_setup_marks(&self) -> &[RunSetupMark] {
        &self.state.run_setup_marks
    }

    pub fn set_run_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration: RunConfiguration,
        expected_revision: u64,
    ) -> Result<RunConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let current_index = self
            .state
            .run_configurations
            .iter()
            .position(|current| current.id == configuration.id);
        let project_count = self
            .state
            .run_configurations
            .iter()
            .filter(|current| current.project_id == configuration.project_id)
            .count();
        if !configuration.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == configuration.project_id)
            || (current_index.is_none() && project_count >= RUN_CONFIGURATIONS_PER_PROJECT_MAX)
            || current_index.is_some_and(|index| {
                self.state.run_configurations[index].project_id != configuration.project_id
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        if current_index.map(|index| &self.state.run_configurations[index]) == Some(&configuration)
        {
            return Ok(configuration);
        }
        let previous = self.state.clone();
        if let Some(index) = current_index {
            self.state.run_configurations[index] = configuration.clone();
        } else {
            self.state.run_configurations.push(configuration.clone());
        }
        super::configuration_version::record_run_configuration_version(
            &mut self.state,
            &configuration,
            None,
            "Configuration saved",
        );
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    pub fn delete_run_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration_id: &str,
        expected_revision: u64,
    ) -> Result<RunConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let index = self
            .state
            .run_configurations
            .iter()
            .position(|configuration| configuration.id == configuration_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let deleted = self.state.run_configurations.remove(index);
        let target = termloop_domain::ImproverSessionTarget {
            target_kind: termloop_domain::ImproverSessionTargetKind::RunConfiguration,
            target_id: Some(configuration_id.to_owned()),
        };
        super::configuration_version::remove_configuration_target_state(
            &mut self.state,
            &deleted.project_id,
            &target,
        );
        self.state
            .run_setup_marks
            .retain(|mark| mark.configuration_id != configuration_id);
        for session in &mut self.state.sessions {
            if session.run_configuration_id.as_deref() == Some(configuration_id) {
                session.run_configuration_id = None;
            }
        }
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }

    /// Replaces the current setup mark for one exact configuration/worktree
    /// tuple. This is a mark inside another command's transaction; callers own
    /// revision policy.
    pub fn record_run_setup_mark(
        &mut self,
        _authority: &CoreWriteAuthority,
        mark: RunSetupMark,
    ) -> Result<(), StoreError> {
        if !mark.is_valid()
            || !self.state.run_configurations.iter().any(|configuration| {
                configuration.id == mark.configuration_id
                    && configuration.project_id == mark.project_id
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        replace_bounded_setup_mark(&mut self.state.run_setup_marks, mark);
        self.commit_or_restore(previous)?;
        Ok(())
    }

    /// Atomically admits one Terminal Session and the optional current setup
    /// mark produced by that exact launch.
    pub fn insert_run_session(
        &mut self,
        _authority: &CoreWriteAuthority,
        session: SessionRecord,
        setup_mark: Option<RunSetupMark>,
    ) -> Result<u64, StoreError> {
        let configuration_id = session
            .run_configuration_id
            .as_deref()
            .ok_or(StoreError::ConstraintViolation)?;
        if session.kind != SessionKind::Terminal
            || self
                .state
                .sessions
                .iter()
                .any(|value| value.id == session.id)
            || !self.state.run_configurations.iter().any(|configuration| {
                configuration.id == configuration_id
                    && configuration.project_id == session.project_id
            })
            || setup_mark.as_ref().is_some_and(|mark| {
                !mark.is_valid()
                    || mark.project_id != session.project_id
                    || mark.configuration_id != configuration_id
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.sessions.push(session);
        if let Some(mark) = setup_mark {
            replace_bounded_setup_mark(&mut self.state.run_setup_marks, mark);
        }
        self.commit_or_restore(previous)
    }
}

fn replace_bounded_setup_mark(marks: &mut Vec<RunSetupMark>, mark: RunSetupMark) {
    marks.retain(|current| {
        !(current.configuration_id == mark.configuration_id
            && current.worktree_path == mark.worktree_path)
    });
    while marks
        .iter()
        .filter(|current| current.project_id == mark.project_id)
        .count()
        >= RUN_SETUP_MARKS_PER_PROJECT_MAX
    {
        let Some(oldest) = marks
            .iter()
            .enumerate()
            .filter(|(_, current)| current.project_id == mark.project_id)
            .min_by_key(|(_, current)| current.completed_at_epoch_ms)
            .map(|(index, _)| index)
        else {
            break;
        };
        marks.remove(oldest);
    }
    marks.push(mark);
}
