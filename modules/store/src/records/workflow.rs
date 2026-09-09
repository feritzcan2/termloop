use termloop_domain::{
    SavedAgentLaunchSelection, SessionKind, SessionRecord, WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX,
    WorkflowConfiguration, WorkflowExecution, WorkflowExecutionPhase,
};

use super::super::{CoreWriteAuthority, Store, StoreError};
use super::session_admission::FreshSessionAdmission;
use crate::CurrentState;

impl Store {
    pub fn workflow_configurations(&self) -> &[WorkflowConfiguration] {
        &self.state.workflow_configurations
    }

    pub fn workflow_executions(&self) -> &[WorkflowExecution] {
        &self.state.workflow_executions
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

    /// Admits the coordinator Session and its one current execution snapshot
    /// atomically, so a spawned coordinator never becomes detached from the
    /// Core state machine after a storage failure.
    pub fn insert_workflow_coordinator_session(
        &mut self,
        _authority: &CoreWriteAuthority,
        session: SessionRecord,
        execution: WorkflowExecution,
    ) -> Result<u64, StoreError> {
        self.admit_fresh_session(
            session,
            FreshSessionAdmission::Workflow {
                execution: &execution,
            },
        )
    }

    pub fn replace_workflow_execution(
        &mut self,
        _authority: &CoreWriteAuthority,
        expected: &WorkflowExecution,
        replacement: WorkflowExecution,
    ) -> Result<u64, StoreError> {
        if !replacement.is_valid()
            || replacement.id != expected.id
            || replacement.task_id != expected.task_id
            || replacement.project_id != expected.project_id
            || replacement.configuration != expected.configuration
            || replacement.goal != expected.goal
            || replacement.coordinator_session_id != expected.coordinator_session_id
            || replacement.started_at_epoch_ms != expected.started_at_epoch_ms
        {
            return Err(StoreError::ConstraintViolation);
        }
        let index = self
            .state
            .workflow_executions
            .iter()
            .position(|execution| execution.id == expected.id)
            .ok_or(StoreError::NotFound)?;
        if self.state.workflow_executions[index] != *expected {
            return Err(StoreError::RevisionConflict);
        }
        if replacement == *expected {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.workflow_executions[index] = replacement;
        self.commit_or_restore(previous)
    }

    pub fn cancel_workflow_execution(
        &mut self,
        _authority: &CoreWriteAuthority,
        execution_id: &str,
        expected_revision: u64,
    ) -> Result<WorkflowExecution, StoreError> {
        if self.state.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        let index = self
            .state
            .workflow_executions
            .iter()
            .position(|execution| execution.id == execution_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let removed = self.state.workflow_executions.remove(index);
        self.commit_or_restore(previous)?;
        Ok(removed)
    }
}

pub(super) fn validate_workflow_coordinator_session(
    state: &CurrentState,
    session: &SessionRecord,
    execution: &WorkflowExecution,
) -> Result<SavedAgentLaunchSelection, StoreError> {
    if session.kind != SessionKind::Agent
        || session.id != execution.coordinator_session_id
        || session.project_id != execution.project_id
        || session.process.agent_id.as_deref()
            != Some(execution.configuration.coordinator_agent_id.as_str())
        || !execution.is_valid()
        || state.sessions.iter().any(|value| value.id == session.id)
        || state.workflow_executions.iter().any(|current| {
            current.shares_scope(execution) && current.phase != WorkflowExecutionPhase::Completed
        })
    {
        return Err(StoreError::ConstraintViolation);
    }
    let scope_exists = state
        .projects
        .iter()
        .any(|project| project.id == execution.project_id)
        && execution.task_id.as_ref().is_none_or(|task_id| {
            state
                .tasks
                .iter()
                .any(|task| &task.id == task_id && task.project_id == execution.project_id)
        });
    let preference =
        session.process.agent_id.as_deref().map(|agent_id| {
            SavedAgentLaunchSelection::new(agent_id, session.launch_selection.clone())
        });
    if !scope_exists {
        return Err(StoreError::ConstraintViolation);
    }
    preference
        .filter(SavedAgentLaunchSelection::is_valid)
        .ok_or(StoreError::ConstraintViolation)
}

pub(super) fn apply_workflow_coordinator_execution(
    state: &mut CurrentState,
    execution: &WorkflowExecution,
) {
    state
        .workflow_executions
        .retain(|current| !current.shares_scope(execution));
    state.workflow_executions.push(execution.clone());
}
