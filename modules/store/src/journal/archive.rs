use termloop_domain::{
    ResumeFailureReason, SessionArchiveOperation, SessionArchiveOperationState, SessionRecord,
    TaskArchiveOperation, TaskArchiveOperationState, TaskArchiveSuspension, TaskStatus,
    TaskSuspensionReason, WorktreeCleanupOutcome, WorktreeStaleResolutionMode,
};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn begin_session_archive(
        &mut self,
        _authority: &CoreWriteAuthority,
        operation: SessionArchiveOperation,
    ) -> Result<u64, StoreError> {
        let session = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == operation.session_id)
            .ok_or(StoreError::NotFound)?;
        if session.project_id != operation.project_id
            || session.runtime_epoch != operation.runtime_epoch
            || session.archived_at_epoch_ms.is_some()
            || session.lifecycle_state != "running"
            || self
                .state
                .session_archive_operations
                .iter()
                .any(|current| current.session_id == operation.session_id)
            || self
                .state
                .session_relocation_operations
                .iter()
                .any(|current| current.session_id == operation.session_id)
            || super::super::operation_id_owned_anywhere(&self.state, &operation.operation_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.session_archive_operations.push(operation);
        self.commit_or_restore(previous)
    }

    pub fn mark_session_archive_recovery_attention(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        operation_id: &str,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let operation = self
            .state
            .session_archive_operations
            .iter_mut()
            .find(|operation| {
                operation.session_id == session_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        if operation.state == SessionArchiveOperationState::RecoveryAttention {
            return Ok(self.state.revision);
        }
        operation.state = SessionArchiveOperationState::RecoveryAttention;
        self.commit_or_restore(previous)
    }

    pub fn commit_session_archive(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        operation_id: &str,
        archived_at_epoch_ms: u64,
    ) -> Result<SessionRecord, StoreError> {
        let operation_index = self
            .state
            .session_archive_operations
            .iter()
            .position(|operation| {
                operation.session_id == session_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let operation = self.state.session_archive_operations[operation_index].clone();
        let session = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.project_id != operation.project_id
            || session.runtime_epoch != operation.runtime_epoch
            || session.archived_at_epoch_ms.is_some()
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .expect("validated session remains");
        session.lifecycle_state = "exited".into();
        session.resume_failure = None;
        session.archived_at_epoch_ms = Some(archived_at_epoch_ms);
        let archived = session.clone();
        self.state
            .session_archive_operations
            .remove(operation_index);
        self.commit_or_restore(previous)?;
        Ok(archived)
    }

    pub fn begin_task_archive(
        &mut self,
        _authority: &CoreWriteAuthority,
        operation: TaskArchiveOperation,
    ) -> Result<u64, StoreError> {
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == operation.task_id)
            .ok_or(StoreError::NotFound)?;
        if task.archived_at_epoch_ms.is_some()
            || task.project_id != operation.project_id
            || self
                .state
                .task_archive_operations
                .iter()
                .any(|current| current.task_id == operation.task_id)
            || self
                .state
                .session_relocation_operations
                .iter()
                .any(|current| current.target_task_id == operation.task_id)
            || super::super::operation_id_owned_anywhere(&self.state, &operation.operation_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.task_archive_operations.push(operation);
        self.commit_or_restore(previous)
    }

    pub fn mark_task_archive_recovery_attention(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let operation = self
            .state
            .task_archive_operations
            .iter_mut()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        if operation.state == TaskArchiveOperationState::RecoveryAttention {
            return Ok(self.state.revision);
        }
        operation.state = TaskArchiveOperationState::RecoveryAttention;
        self.commit_or_restore(previous)
    }

    pub fn commit_task_archive(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        archived_at_epoch_ms: u64,
    ) -> Result<u64, StoreError> {
        let operation_index = self
            .state
            .task_archive_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let operation = self.state.task_archive_operations[operation_index].clone();
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        if self.state.tasks[task_index].archived_at_epoch_ms.is_some()
            || operation.targets.iter().any(|target| {
                self.state
                    .task_archive_suspensions
                    .iter()
                    .any(|suspension| suspension.session_id == target.session_id)
                    || !self.state.sessions.iter().any(|session| {
                        session.id == target.session_id
                            && session.project_id == operation.project_id
                            && session.runtime_epoch == target.runtime_epoch
                    })
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        for target in &operation.targets {
            let session = self
                .state
                .sessions
                .iter_mut()
                .find(|session| session.id == target.session_id)
                .ok_or(StoreError::NotFound)?;
            if target.was_live_agent {
                session.lifecycle_state = "exited".into();
                session.resume_failure = None;
            }
            self.state
                .task_archive_suspensions
                .push(TaskArchiveSuspension {
                    task_id: Some(task_id.to_owned()),
                    session_id: target.session_id.clone(),
                    archived_at_epoch_ms,
                    prior_lifecycle_state: target.prior_lifecycle_state.clone(),
                    prior_resume_failure: target.prior_resume_failure,
                    reason: TaskSuspensionReason::Archived,
                });
        }
        let task = &mut self.state.tasks[task_index];
        task.archived_at_epoch_ms = Some(archived_at_epoch_ms);
        task.updated_at_epoch_ms = archived_at_epoch_ms;
        for routine in &mut self.state.tracker_configurations {
            if !routine.trigger_mode.is_scheduled() {
                routine
                    .pending_routine_findings
                    .retain(|finding| !finding.related_task_ids.iter().any(|id| id == task_id));
            }
        }
        self.state.task_archive_operations.remove(operation_index);
        self.commit_or_restore(previous)
    }

    pub fn abandon_task_archive(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
    ) -> Result<u64, StoreError> {
        let index = self
            .state
            .task_archive_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id
                    && operation.operation_id == operation_id
                    && operation.state == TaskArchiveOperationState::RecoveryAttention
            })
            .ok_or(StoreError::ConstraintViolation)?;
        let previous = self.state.clone();
        self.state.task_archive_operations.remove(index);
        self.commit_or_restore(previous)
    }

    pub fn restore_task_archive(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        session_ids: &[String],
        updated_at_epoch_ms: u64,
    ) -> Result<Vec<String>, StoreError> {
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let archived_at = self.state.tasks[task_index]
            .archived_at_epoch_ms
            .ok_or(StoreError::ConstraintViolation)?;
        if session_ids.iter().any(|session_id| {
            !self
                .state
                .task_archive_suspensions
                .iter()
                .any(|suspension| {
                    suspension.session_id == *session_id
                        && suspension.archived_at_epoch_ms == archived_at
                        && suspension
                            .task_id
                            .as_ref()
                            .is_none_or(|suspension_task_id| suspension_task_id == task_id)
                })
        }) {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let mut resumable = Vec::new();
        for session_id in session_ids {
            let suspension_index = self
                .state
                .task_archive_suspensions
                .iter()
                .position(|suspension| {
                    suspension.session_id == *session_id
                        && suspension
                            .task_id
                            .as_ref()
                            .is_none_or(|suspension_task_id| suspension_task_id == task_id)
                })
                .ok_or(StoreError::ConstraintViolation)?;
            let suspension = self.state.task_archive_suspensions.remove(suspension_index);
            let session = self
                .state
                .sessions
                .iter_mut()
                .find(|session| session.id == *session_id)
                .ok_or(StoreError::NotFound)?;
            if suspension.prior_lifecycle_state == "running" {
                session.lifecycle_state = "resumeFailed".into();
                session.resume_failure = Some(ResumeFailureReason::DaemonInterrupted);
                resumable.push(session_id.clone());
            } else {
                session.lifecycle_state = suspension.prior_lifecycle_state;
                session.resume_failure = suspension.prior_resume_failure;
            }
        }
        let task = &mut self.state.tasks[task_index];
        task.archived_at_epoch_ms = None;
        task.updated_at_epoch_ms = updated_at_epoch_ms;
        self.commit_or_restore(previous)?;
        Ok(resumable)
    }

    /// Converts an already parked Task into ordinary closed current state only
    /// after Core's cleanup path has durably proven that the checkout itself was
    /// removed. The Session descriptors and resume pointers remain suspended;
    /// reopening consumes this exact sidecar cohort.
    pub fn finalize_archived_task_as_closed_after_worktree_removal(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<termloop_domain::TaskRecord, StoreError> {
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let archived_at = self.state.tasks[task_index]
            .archived_at_epoch_ms
            .ok_or(StoreError::ConstraintViolation)?;
        let generation = self.state.tasks[task_index].worktree_generation;
        let project_id = self.state.tasks[task_index].project_id.clone();
        let project_folder = self
            .state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| project.folder_path.clone())
            .ok_or(StoreError::ConstraintViolation)?;
        let removal_proven = self.state.cleanup_receipts.iter().any(|receipt| {
            receipt.task_id == task_id
                && receipt.worktree_generation == generation
                && receipt.outcome == WorktreeCleanupOutcome::Removed
        }) || self.state.stale_resolution_receipts.iter().any(|receipt| {
            receipt.task_id == task_id
                && receipt.worktree_generation == generation
                && receipt.mode == WorktreeStaleResolutionMode::DiscardDirectory
        });
        if self.state.tasks[task_index].worktree.is_some()
            || !removal_proven
            || self
                .state
                .task_archive_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
            || self
                .state
                .cleanup_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
            || self
                .state
                .stale_resolution_operations
                .iter()
                .any(|operation| operation.task_id == task_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        for suspension in self
            .state
            .task_archive_suspensions
            .iter_mut()
            .filter(|suspension| {
                suspension.task_id.as_deref() == Some(task_id)
                    && suspension.archived_at_epoch_ms == archived_at
            })
        {
            suspension.reason = TaskSuspensionReason::ClosedWorktreeRemoved;
            let session = self
                .state
                .sessions
                .iter_mut()
                .find(|session| session.id == suspension.session_id)
                .ok_or(StoreError::ConstraintViolation)?;
            // The managed checkout is gone by definition. Keep the same
            // provider conversation resumable from the durable Project root.
            session.process.cwd = project_folder.clone();
        }
        let task = &mut self.state.tasks[task_index];
        task.archived_at_epoch_ms = None;
        task.status = TaskStatus::Closed;
        task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
        let updated = task.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn reopen_task_with_suspended_sessions(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<(termloop_domain::TaskRecord, Vec<String>), StoreError> {
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        if self.state.tasks[task_index].status != TaskStatus::Closed
            || self.state.tasks[task_index].archived_at_epoch_ms.is_some()
        {
            return Err(StoreError::ConstraintViolation);
        }
        let session_ids = self
            .state
            .task_archive_suspensions
            .iter()
            .filter(|suspension| {
                suspension.task_id.as_deref() == Some(task_id)
                    && suspension.reason == TaskSuspensionReason::ClosedWorktreeRemoved
            })
            .map(|suspension| suspension.session_id.clone())
            .collect::<Vec<_>>();
        let previous = self.state.clone();
        let mut resumable = Vec::new();
        for session_id in &session_ids {
            let suspension_index = self
                .state
                .task_archive_suspensions
                .iter()
                .position(|suspension| {
                    suspension.session_id == *session_id
                        && suspension.task_id.as_deref() == Some(task_id)
                        && suspension.reason == TaskSuspensionReason::ClosedWorktreeRemoved
                })
                .ok_or(StoreError::ConstraintViolation)?;
            let suspension = self.state.task_archive_suspensions.remove(suspension_index);
            let session = self
                .state
                .sessions
                .iter_mut()
                .find(|session| session.id == *session_id)
                .ok_or(StoreError::NotFound)?;
            if suspension.prior_lifecycle_state == "running" {
                session.lifecycle_state = "resumeFailed".into();
                session.resume_failure = Some(ResumeFailureReason::DaemonInterrupted);
                resumable.push(session_id.clone());
            } else {
                session.lifecycle_state = suspension.prior_lifecycle_state;
                session.resume_failure = suspension.prior_resume_failure;
            }
        }
        let task = &mut self.state.tasks[task_index];
        task.status = TaskStatus::Open;
        task.updated_at_epoch_ms = updated_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
        let updated = task.clone();
        self.commit_or_restore(previous)?;
        Ok((updated, resumable))
    }
}
