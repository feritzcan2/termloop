use termloop_domain::{
    IssueLink, TASK_SOURCES_PER_PROJECT_MAX, TaskRecord, TaskSourceConfiguration,
};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn insert_task_source_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        source: TaskSourceConfiguration,
    ) -> Result<u64, StoreError> {
        if !source.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == source.project_id)
            || self
                .state
                .task_source_configurations
                .iter()
                .any(|candidate| candidate.id == source.id)
            || self
                .state
                .task_source_configurations
                .iter()
                .filter(|candidate| candidate.project_id == source.project_id)
                .count()
                >= TASK_SOURCES_PER_PROJECT_MAX
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.task_source_configurations.push(source);
        self.commit_or_restore(previous)
    }

    pub fn replace_task_source_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        source: TaskSourceConfiguration,
    ) -> Result<u64, StoreError> {
        if !source.is_valid() {
            return Err(StoreError::ConstraintViolation);
        }
        let index = self
            .state
            .task_source_configurations
            .iter()
            .position(|candidate| candidate.id == source.id)
            .ok_or(StoreError::NotFound)?;
        if self.state.task_source_configurations[index].project_id != source.project_id
            || self.state.task_source_configurations[index].provider != source.provider
        {
            return Err(StoreError::ConstraintViolation);
        }
        if self.state.task_source_configurations[index] == source {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.task_source_configurations[index] = source;
        self.commit_or_restore(previous)
    }

    pub fn delete_task_source_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        source_id: &str,
    ) -> Result<TaskSourceConfiguration, StoreError> {
        let index = self
            .state
            .task_source_configurations
            .iter()
            .position(|source| source.id == source_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let deleted = self.state.task_source_configurations.remove(index);
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }

    pub fn insert_task_from_source(
        &mut self,
        _authority: &CoreWriteAuthority,
        task: TaskRecord,
        link: IssueLink,
    ) -> Result<u64, StoreError> {
        if link.task_id != task.id {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let mutation =
            super::task::insert_task_record(&mut self.state.tasks, task).and_then(|()| {
                super::issue_link::insert_jira_issue_link_record(
                    &self.state.tasks,
                    &self.state.task_source_configurations,
                    &mut self.state.issue_links,
                    link,
                )
            });
        if let Err(error) = mutation {
            self.state = previous;
            return Err(error);
        }
        self.commit_or_restore(previous)
    }
}
