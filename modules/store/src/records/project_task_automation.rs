use termloop_domain::ProjectTaskAutomationConfiguration;

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn set_project_task_automation_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration: ProjectTaskAutomationConfiguration,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !configuration.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == configuration.project_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        if let Some(existing) = self
            .state
            .project_task_automation_configurations
            .iter_mut()
            .find(|candidate| candidate.project_id == configuration.project_id)
        {
            if *existing == configuration {
                return Ok(self.state.revision);
            }
            *existing = configuration;
        } else {
            self.state
                .project_task_automation_configurations
                .push(configuration);
        }
        self.commit_or_restore(previous)
    }
}
