use termloop_domain::{WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX, WorkflowConfiguration};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn workflow_configurations(&self) -> &[WorkflowConfiguration] {
        &self.state.workflow_configurations
    }

    pub fn set_workflow_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration: WorkflowConfiguration,
        expected_revision: u64,
    ) -> Result<WorkflowConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let current_index = self
            .state
            .workflow_configurations
            .iter()
            .position(|current| current.id == configuration.id);
        let project_count = self
            .state
            .workflow_configurations
            .iter()
            .filter(|current| current.project_id == configuration.project_id)
            .count();
        if !configuration.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == configuration.project_id)
            || (current_index.is_none() && project_count >= WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX)
            || current_index.is_some_and(|index| {
                self.state.workflow_configurations[index].project_id != configuration.project_id
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        if current_index.map(|index| &self.state.workflow_configurations[index])
            == Some(&configuration)
        {
            return Ok(configuration);
        }
        let previous = self.state.clone();
        if let Some(index) = current_index {
            self.state.workflow_configurations[index] = configuration.clone();
        } else {
            self.state
                .workflow_configurations
                .push(configuration.clone());
        }
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    pub fn delete_workflow_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration_id: &str,
        expected_revision: u64,
    ) -> Result<WorkflowConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let index = self
            .state
            .workflow_configurations
            .iter()
            .position(|configuration| configuration.id == configuration_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let deleted = self.state.workflow_configurations.remove(index);
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }
}
