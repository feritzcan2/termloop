use termloop_domain::{
    ProjectEnvironment, ProjectEnvironments, ProjectMode, ProjectModeSetting,
    valid_project_environments,
};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    /// Replaces the daemon-wide experimental Project Manager mode switch.
    /// Turning it off keeps every stored Project mode; they only stop taking
    /// effect until it is turned on again.
    pub fn set_project_manager_mode_enabled(
        &mut self,
        _authority: &CoreWriteAuthority,
        enabled: bool,
    ) -> Result<u64, StoreError> {
        if self.state.project_manager_mode_enabled == enabled {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.project_manager_mode_enabled = enabled;
        self.commit_or_restore(previous)
    }

    /// Replaces one Project's current mode. `Developer` is stored as the
    /// absence of a record, so switching back removes it.
    pub fn set_project_mode(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        mode: ProjectMode,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(StoreError::NotFound);
        }
        let current = self
            .state
            .project_mode_settings
            .iter()
            .find(|setting| setting.project_id == project_id)
            .map_or(ProjectMode::Developer, |setting| setting.mode);
        if current == mode {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state
            .project_mode_settings
            .retain(|setting| setting.project_id != project_id);
        if mode != ProjectMode::Developer {
            self.state.project_mode_settings.push(ProjectModeSetting {
                project_id: project_id.to_owned(),
                mode,
            });
        }
        self.commit_or_restore(previous)
    }
}

impl Store {
    /// Replaces one Project's environment list; an empty list removes it.
    pub fn set_project_environments(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        environments: Vec<ProjectEnvironment>,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(StoreError::NotFound);
        }
        if !environments.is_empty() && !valid_project_environments(&environments) {
            return Err(StoreError::ConstraintViolation);
        }
        if self.project_environments(project_id) == environments.as_slice() {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state
            .project_environments
            .retain(|record| record.project_id != project_id);
        if !environments.is_empty() {
            self.state.project_environments.push(ProjectEnvironments {
                project_id: project_id.to_owned(),
                environments,
            });
        }
        self.commit_or_restore(previous)
    }
}
