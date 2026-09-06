use termloop_domain::TrackerConfiguration;

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn tracker_configurations(&self) -> &[TrackerConfiguration] {
        &self.state.tracker_configurations
    }

    pub fn set_tracker_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration: TrackerConfiguration,
        expected_revision: u64,
    ) -> Result<TrackerConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let current_index = self
            .state
            .tracker_configurations
            .iter()
            .position(|current| current.id == configuration.id);
        let related_tasks_match = configuration.related_task_ids.iter().all(|task_id| {
            self.state
                .tasks
                .iter()
                .any(|task| task.id == *task_id && task.project_id == configuration.project_id)
        });
        if !configuration.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == configuration.project_id)
            || !related_tasks_match
            || current_index.is_some_and(|index| {
                self.state.tracker_configurations[index].project_id != configuration.project_id
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        if current_index.map(|index| &self.state.tracker_configurations[index])
            == Some(&configuration)
        {
            return Ok(configuration);
        }
        let previous = self.state.clone();
        if let Some(index) = current_index {
            self.state.tracker_configurations[index] = configuration.clone();
        } else {
            self.state
                .tracker_configurations
                .push(configuration.clone());
        }
        super::configuration_version::record_routine_version(
            &mut self.state,
            &configuration,
            None,
            "Configuration saved",
        );
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    pub fn delete_tracker_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        tracker_id: &str,
        expected_revision: u64,
    ) -> Result<TrackerConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let index = self
            .state
            .tracker_configurations
            .iter()
            .position(|configuration| configuration.id == tracker_id)
            .ok_or(StoreError::NotFound)?;
        if self
            .state
            .playbook_configurations
            .iter()
            .flat_map(|configuration| configuration.all_milestones())
            .any(|milestone| milestone.routine_id == tracker_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let deleted = self.state.tracker_configurations.remove(index);
        let target = termloop_domain::ImproverSessionTarget {
            target_kind: termloop_domain::ImproverSessionTargetKind::RoutineInstructions,
            target_id: Some(tracker_id.to_owned()),
        };
        super::configuration_version::remove_configuration_target_state(
            &mut self.state,
            &deleted.project_id,
            &target,
        );
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }
}
