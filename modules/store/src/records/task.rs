use termloop_domain::{TASK_STEWARD_BRIEF_MAX_BYTES, TaskBranchBinding, TaskRecord, TaskStatus};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn insert_task(
        &mut self,
        _authority: &CoreWriteAuthority,
        task: TaskRecord,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        insert_task_record(&mut self.state.tasks, task)?;
        self.commit_or_restore(previous)
    }

    pub fn rename_task(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        title: String,
        updated_at_epoch_ms: u64,
    ) -> Result<TaskRecord, StoreError> {
        let previous = self.state.clone();
        let task = self
            .state
            .tasks
            .iter_mut()
            .find(|value| value.id == task_id)
            .ok_or(StoreError::NotFound)?;
        if task.title == title {
            return Ok(task.clone());
        }
        task.title = title;
        task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
        let updated = task.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn update_task_brief(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        brief: Option<String>,
        updated_at_epoch_ms: u64,
    ) -> Result<TaskRecord, StoreError> {
        let previous = self.state.clone();
        let (updated, changed) =
            update_task_brief_record(&mut self.state.tasks, task_id, brief, updated_at_epoch_ms)?;
        if !changed {
            return Ok(updated);
        }
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    /// Replaces the one current Steward brief on a Task. The brief revision is
    /// a document-level CAS separate from the global store revision so the
    /// Steward's read-modify-write cannot silently clobber a newer brief.
    pub fn update_task_steward_brief(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        brief_markdown: String,
        expected_brief_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<TaskRecord, StoreError> {
        if brief_markdown.len() > TASK_STEWARD_BRIEF_MAX_BYTES
            || (!brief_markdown.is_empty() && brief_markdown.trim().is_empty())
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let task = self
            .state
            .tasks
            .iter_mut()
            .find(|value| value.id == task_id)
            .ok_or(StoreError::NotFound)?;
        if task.steward_brief_revision != expected_brief_revision {
            return Err(StoreError::RevisionConflict);
        }
        if task.steward_brief_markdown == brief_markdown {
            return Ok(task.clone());
        }
        task.steward_brief_markdown = brief_markdown;
        task.steward_brief_revision += 1;
        task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
        let updated = task.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn bind_task_branch(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        binding: TaskBranchBinding,
        updated_at_epoch_ms: u64,
    ) -> Result<TaskRecord, StoreError> {
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|value| value.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let task = &self.state.tasks[task_index];
        if task.branch.as_ref() == Some(&binding) {
            return Ok(task.clone());
        }
        if task.branch.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        if let Some(operation) = self
            .state
            .provisioning_operations
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .state
            .cleanup_operations
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(holder) = self.state.tasks.iter().find(|candidate| {
            candidate.id != task_id
                && candidate.project_id == task.project_id
                && candidate.branch.as_ref() == Some(&binding)
        }) {
            return Err(StoreError::BranchHeld {
                task_id: holder.id.clone(),
            });
        }
        if let Some(holder) = self.state.provisioning_operations.iter().find(|operation| {
            operation.task_id != task_id
                && operation.project_id == task.project_id
                && operation.spec.repository_root == binding.repository_root
                && operation.spec.branch_name == binding.name
        }) {
            return Err(StoreError::BranchHeld {
                task_id: holder.task_id.clone(),
            });
        }
        let previous = self.state.clone();
        let task = &mut self.state.tasks[task_index];
        task.branch = Some(binding);
        task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
        let updated = task.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn set_task_status(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        status: TaskStatus,
        updated_at_epoch_ms: u64,
    ) -> Result<TaskRecord, StoreError> {
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        if task.status == status {
            return Ok(task.clone());
        }
        if let Some(operation) = self
            .state
            .session_relocation_operations
            .iter()
            .find(|operation| operation.target_task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        let previous = self.state.clone();
        let (updated, changed) =
            set_task_status_record(&mut self.state.tasks, task_id, status, updated_at_epoch_ms)?;
        if !changed {
            return Ok(updated);
        }
        if status == TaskStatus::Closed {
            for routine in &mut self.state.tracker_configurations {
                if !routine.trigger_mode.is_scheduled() {
                    routine
                        .pending_routine_findings
                        .retain(|finding| !finding.related_task_ids.iter().any(|id| id == task_id));
                }
            }
        }
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn delete_task(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
    ) -> Result<TaskRecord, StoreError> {
        let index = self
            .state
            .tasks
            .iter()
            .position(|value| value.id == task_id)
            .ok_or(StoreError::NotFound)?;
        if let Some(operation) = self
            .state
            .provisioning_operations
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .state
            .cleanup_operations
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .state
            .repair_operations
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .state
            .stale_resolution_operations
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .state
            .session_relocation_operations
            .iter()
            .find(|operation| operation.target_task_id == task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        let previous = self.state.clone();
        let deleted = self.state.tasks.remove(index);
        self.state
            .managed_worktrees
            .retain(|proof| proof.task_id != task_id);
        self.state
            .cleanup_receipts
            .retain(|receipt| receipt.task_id != task_id);
        self.state
            .repair_receipts
            .retain(|receipt| receipt.task_id != task_id);
        self.state
            .stale_resolution_receipts
            .retain(|receipt| receipt.task_id != task_id);
        self.state
            .session_relocation_receipts
            .retain(|receipt| receipt.target_task_id != task_id);
        self.state
            .issue_links
            .retain(|link| link.task_id != task_id);
        // A deleted Task asks no questions, so its pipeline answers go with it.
        self.state
            .playbook_step_progress
            .retain(|progress| progress.task_id != task_id);
        for routine in &mut self.state.tracker_configurations {
            routine.related_task_ids.retain(|id| id != task_id);
            routine
                .pending_routine_findings
                .retain(|finding| !finding.related_task_ids.iter().any(|id| id == task_id));
        }
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }

    pub fn delete_archived_task_with_sessions(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        archived_at_epoch_ms: u64,
        session_ids: &[String],
    ) -> Result<TaskRecord, StoreError> {
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let task = &self.state.tasks[task_index];
        if task.archived_at_epoch_ms != Some(archived_at_epoch_ms)
            || task.worktree.is_some()
            || self
                .state
                .task_archive_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
            || self
                .state
                .provisioning_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
            || self
                .state
                .cleanup_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
            || self
                .state
                .repair_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
            || self
                .state
                .stale_resolution_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
            || self
                .state
                .session_relocation_operations
                .iter()
                .any(|operation| operation.target_task_id == task_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let unique_ids = session_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let exact_cohort = self
            .state
            .task_archive_suspensions
            .iter()
            .filter(|suspension| {
                suspension.task_id.as_deref() == Some(task_id)
                    && suspension.archived_at_epoch_ms == archived_at_epoch_ms
            })
            .map(|suspension| suspension.session_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if unique_ids.len() != session_ids.len()
            || unique_ids != exact_cohort
            || session_ids.iter().any(|session_id| {
                !self.state.sessions.iter().any(|session| {
                    session.id == **session_id && session.project_id == task.project_id
                }) || !self
                    .state
                    .task_archive_suspensions
                    .iter()
                    .any(|suspension| {
                        suspension.session_id == **session_id
                            && suspension.archived_at_epoch_ms == archived_at_epoch_ms
                            && suspension.task_id.as_deref() == Some(task_id)
                    })
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state
            .sessions
            .retain(|session| !unique_ids.contains(session.id.as_str()));
        super::agent_plan::remove_agent_plans_for_sessions(&mut self.state, &unique_ids);
        self.state
            .task_archive_suspensions
            .retain(|suspension| !unique_ids.contains(suspension.session_id.as_str()));
        let deleted = self.state.tasks.remove(task_index);
        self.state
            .managed_worktrees
            .retain(|proof| proof.task_id != task_id);
        self.state
            .cleanup_receipts
            .retain(|receipt| receipt.task_id != task_id);
        self.state
            .repair_receipts
            .retain(|receipt| receipt.task_id != task_id);
        self.state
            .stale_resolution_receipts
            .retain(|receipt| receipt.task_id != task_id);
        self.state.session_relocation_receipts.retain(|receipt| {
            receipt.target_task_id != task_id && !unique_ids.contains(receipt.session_id.as_str())
        });
        self.state
            .issue_links
            .retain(|link| link.task_id != task_id);
        // A deleted Task asks no questions, so its pipeline answers go with it.
        self.state
            .playbook_step_progress
            .retain(|progress| progress.task_id != task_id);
        for routine in &mut self.state.tracker_configurations {
            routine.related_task_ids.retain(|id| id != task_id);
            routine
                .pending_routine_findings
                .retain(|finding| !finding.related_task_ids.iter().any(|id| id == task_id));
        }
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }
}

pub(super) fn insert_task_record(
    tasks: &mut Vec<TaskRecord>,
    task: TaskRecord,
) -> Result<(), StoreError> {
    if task.branch.is_some() || task.worktree.is_some() || task.worktree_generation != 0 {
        return Err(StoreError::ConstraintViolation);
    }
    if tasks.iter().any(|value| value.id == task.id) {
        return Err(StoreError::AlreadyExists);
    }
    tasks.push(task);
    Ok(())
}

pub(super) fn update_task_brief_record(
    tasks: &mut [TaskRecord],
    task_id: &str,
    brief: Option<String>,
    updated_at_epoch_ms: u64,
) -> Result<(TaskRecord, bool), StoreError> {
    let task = tasks
        .iter_mut()
        .find(|value| value.id == task_id)
        .ok_or(StoreError::NotFound)?;
    if task.brief == brief {
        return Ok((task.clone(), false));
    }
    task.brief = brief;
    task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
    Ok((task.clone(), true))
}

pub(super) fn set_task_status_record(
    tasks: &mut [TaskRecord],
    task_id: &str,
    status: TaskStatus,
    updated_at_epoch_ms: u64,
) -> Result<(TaskRecord, bool), StoreError> {
    let task = tasks
        .iter_mut()
        .find(|value| value.id == task_id)
        .ok_or(StoreError::NotFound)?;
    if task.status == status {
        return Ok((task.clone(), false));
    }
    task.status = status;
    task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
    Ok((task.clone(), true))
}
