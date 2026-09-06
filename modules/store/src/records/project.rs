use std::collections::HashSet;

use termloop_domain::ProjectRecord;

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn insert_project(
        &mut self,
        _authority: &CoreWriteAuthority,
        project: ProjectRecord,
    ) -> Result<u64, StoreError> {
        if self
            .state
            .projects
            .iter()
            .any(|value| value.id == project.id)
        {
            return Err(StoreError::AlreadyExists);
        }
        let previous = self.state.clone();
        self.state.projects.push(project);
        self.commit_or_restore(previous)
    }

    pub fn update_project_details(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        name: String,
        folder_path: String,
    ) -> Result<ProjectRecord, StoreError> {
        if let Some(operation) = self
            .state
            .session_relocation_operations
            .iter()
            .find(|operation| {
                operation.project_id == project_id
                    && operation.target == termloop_domain::SessionRelocationTarget::ProjectRoot
                    && operation.target_cwd != folder_path
            })
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        let previous = self.state.clone();
        let project = self
            .state
            .projects
            .iter_mut()
            .find(|value| value.id == project_id)
            .ok_or(StoreError::NotFound)?;
        if project.name == name && project.folder_path == folder_path {
            return Ok(project.clone());
        }
        project.name = name;
        project.folder_path = folder_path;
        let updated = project.clone();
        self.state.session_relocation_receipts.retain(|receipt| {
            receipt.project_id != project_id
                || receipt.target != termloop_domain::SessionRelocationTarget::ProjectRoot
        });
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn delete_project_and_related_records(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
    ) -> Result<ProjectRecord, StoreError> {
        let project_index = self
            .state
            .projects
            .iter()
            .position(|value| value.id == project_id)
            .ok_or(StoreError::NotFound)?;
        let task_ids = self
            .state
            .tasks
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let has_worktree = self
            .state
            .tasks
            .iter()
            .any(|task| task.project_id == project_id && task.worktree.is_some())
            || self
                .state
                .provisioning_operations
                .iter()
                .any(|operation| task_ids.contains(&operation.task_id))
            || self
                .state
                .managed_worktrees
                .iter()
                .any(|proof| task_ids.contains(&proof.task_id))
            || self
                .state
                .cleanup_operations
                .iter()
                .any(|operation| task_ids.contains(&operation.task_id))
            || self
                .state
                .repair_operations
                .iter()
                .any(|operation| task_ids.contains(&operation.task_id))
            || self
                .state
                .stale_resolution_operations
                .iter()
                .any(|operation| task_ids.contains(&operation.task_id));
        if has_worktree {
            return Err(StoreError::ProjectHasWorktrees);
        }
        let session_ids = self
            .state
            .sessions
            .iter()
            .filter(|session| session.project_id == project_id)
            .map(|session| session.id.clone())
            .collect::<HashSet<_>>();
        let previous = self.state.clone();
        let deleted = self.state.projects.remove(project_index);
        self.state
            .tasks
            .retain(|task| task.project_id != project_id);
        self.state
            .task_archive_operations
            .retain(|operation| !task_ids.contains(&operation.task_id));
        self.state.task_archive_suspensions.retain(|suspension| {
            !session_ids.contains(&suspension.session_id)
                && suspension
                    .task_id
                    .as_ref()
                    .is_none_or(|task_id| !task_ids.contains(task_id))
        });
        self.state
            .session_archive_operations
            .retain(|operation| !session_ids.contains(&operation.session_id));
        self.state
            .session_relocation_operations
            .retain(|operation| operation.project_id != project_id);
        self.state
            .session_relocation_receipts
            .retain(|receipt| receipt.project_id != project_id);
        self.state
            .issue_links
            .retain(|link| !task_ids.contains(&link.task_id));
        self.state
            .task_source_configurations
            .retain(|source| source.project_id != project_id);
        self.state
            .project_task_automation_configurations
            .retain(|configuration| configuration.project_id != project_id);
        self.state
            .provisioning_operations
            .retain(|operation| !task_ids.contains(&operation.task_id));
        self.state
            .managed_worktrees
            .retain(|proof| !task_ids.contains(&proof.task_id));
        self.state
            .cleanup_operations
            .retain(|operation| !task_ids.contains(&operation.task_id));
        self.state
            .cleanup_receipts
            .retain(|receipt| !task_ids.contains(&receipt.task_id));
        self.state
            .repair_operations
            .retain(|operation| !task_ids.contains(&operation.task_id));
        self.state
            .repair_receipts
            .retain(|receipt| !task_ids.contains(&receipt.task_id));
        self.state
            .stale_resolution_operations
            .retain(|operation| !task_ids.contains(&operation.task_id));
        self.state
            .stale_resolution_receipts
            .retain(|receipt| !task_ids.contains(&receipt.task_id));
        self.state
            .sessions
            .retain(|session| session.project_id != project_id);
        self.state
            .deleted_sessions
            .retain(|deleted| deleted.session.project_id != project_id);
        self.state
            .agent_plans
            .retain(|plan| !session_ids.contains(&plan.session_id));
        self.state
            .agent_conversation_readiness
            .retain(|record| !session_ids.contains(&record.session_id));
        self.state
            .companion_messages
            .retain(|value| value.project_id != project_id);
        self.state
            .steward_configurations
            .retain(|value| value.project_id != project_id);
        self.state
            .steward_conversation_refs
            .retain(|value| value.project_id != project_id);
        self.state
            .tracker_configurations
            .retain(|value| value.project_id != project_id);
        self.state
            .playbook_configurations
            .retain(|value| value.project_id != project_id);
        self.state
            .playbook_step_progress
            .retain(|progress| !task_ids.contains(&progress.task_id));
        self.state
            .run_configurations
            .retain(|value| value.project_id != project_id);
        self.state
            .run_setup_marks
            .retain(|value| value.project_id != project_id);
        self.state
            .configuration_versions
            .retain(|value| value.project_id != project_id);
        self.state
            .configuration_version_selections
            .retain(|value| value.project_id != project_id);
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }
}
