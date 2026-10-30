use termloop_domain::{
    IssueLink, TASK_SOURCES_PER_PROJECT_MAX, TaskRecord, TaskSourceConfiguration,
};

use super::super::{CoreWriteAuthority, Store, StoreError};

/// The current Jira content for one source-linked Task, observed by a refresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceRemoteUpdate {
    pub task_id: String,
    pub title: String,
    pub brief: Option<String>,
    pub external_updated_at: String,
}

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

    /// Jira is the authority for source-linked Task content: every update
    /// replaces the title and brief and advances the link's observed
    /// `updatedAt` in one transaction, so a Task is never left half-synced.
    pub fn apply_task_source_remote_updates(
        &mut self,
        _authority: &CoreWriteAuthority,
        updates: Vec<TaskSourceRemoteUpdate>,
        updated_at_epoch_ms: u64,
    ) -> Result<u64, StoreError> {
        if updates.is_empty() {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        for update in updates {
            if update.title.is_empty()
                || update.external_updated_at.is_empty()
                || update.external_updated_at.len() > 128
                || update
                    .external_updated_at
                    .bytes()
                    .any(|byte| byte.is_ascii_control())
            {
                self.state = previous;
                return Err(StoreError::ConstraintViolation);
            }
            let Some(link) = self
                .state
                .issue_links
                .iter_mut()
                .find(|link| link.task_id == update.task_id && link.source_id.is_some())
            else {
                self.state = previous;
                return Err(StoreError::NotFound);
            };
            link.external_updated_at = Some(update.external_updated_at);
            let Some(task) = self
                .state
                .tasks
                .iter_mut()
                .find(|task| task.id == update.task_id)
            else {
                self.state = previous;
                return Err(StoreError::NotFound);
            };
            if task.title != update.title || task.brief != update.brief {
                task.title = update.title;
                task.brief = update.brief;
                task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
            }
        }
        self.commit_or_restore(previous)
    }
}
