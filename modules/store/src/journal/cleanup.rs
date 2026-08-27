use termloop_domain::{
    WorktreeCleanupFailure, WorktreeCleanupFailureKind, WorktreeCleanupMode,
    WorktreeCleanupOperation, WorktreeCleanupOutcome, WorktreeCleanupReceipt, WorktreeCleanupStage,
};

use crate::validation::{validate_cleanup_failure, validate_cleanup_intent};

use super::super::{
    BeginCleanupOutcome, CleanupCommit, CoreWriteAuthority, CurrentState, Store, StoreError,
    operation_id_owned_anywhere,
};

impl Store {
    pub fn begin_task_worktree_cleanup(
        &mut self,
        _authority: &CoreWriteAuthority,
        operation: WorktreeCleanupOperation,
    ) -> Result<BeginCleanupOutcome, StoreError> {
        validate_cleanup_intent(
            operation.cleanup_mode,
            &operation.acknowledged_content_blockers,
        )?;
        if let Some(receipt) = self
            .state
            .cleanup_receipts
            .iter()
            .find(|receipt| receipt.operation_id == operation.operation_id)
        {
            return if receipt.task_id == operation.task_id
                && receipt.worktree_generation == operation.worktree_generation
                && receipt.managed_worktree_operation_id == operation.managed_worktree_operation_id
                && receipt.cleanup_mode == operation.cleanup_mode
                && receipt.acknowledged_content_blockers == operation.acknowledged_content_blockers
            {
                ensure_cleanup_receipt_is_current(&self.state, receipt)?;
                Ok(BeginCleanupOutcome::Completed(receipt.clone()))
            } else {
                Err(StoreError::OperationIdReused {
                    operation_id: operation.operation_id.clone(),
                })
            };
        }
        if let Some(current) = self
            .state
            .cleanup_operations
            .iter()
            .find(|current| current.operation_id == operation.operation_id)
        {
            return if current.task_id == operation.task_id
                && current.worktree_generation == operation.worktree_generation
                && current.managed_worktree_operation_id == operation.managed_worktree_operation_id
                && current.baseline == operation.baseline
                && current.cleanup_mode == operation.cleanup_mode
                && current.acknowledged_content_blockers == operation.acknowledged_content_blockers
            {
                Ok(BeginCleanupOutcome::Current(current.clone()))
            } else {
                Err(StoreError::OperationIdReused {
                    operation_id: operation.operation_id.clone(),
                })
            };
        }
        if operation_id_owned_anywhere(&self.state, &operation.operation_id) {
            return Err(StoreError::OperationIdReused {
                operation_id: operation.operation_id.clone(),
            });
        }
        ensure_cleanup_tuple(&self.state, &operation)?;
        if let Some(current) = self
            .state
            .provisioning_operations
            .iter()
            .find(|candidate| candidate.task_id == operation.task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
        }
        if let Some(current) = self
            .state
            .repair_operations
            .iter()
            .find(|candidate| candidate.task_id == operation.task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
        }
        if let Some(current) = self
            .state
            .stale_resolution_operations
            .iter()
            .find(|candidate| candidate.task_id == operation.task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
        }
        if let Some(current) = self
            .state
            .session_relocation_operations
            .iter()
            .find(|candidate| candidate.target_task_id == operation.task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
        }
        if let Some(current) = self
            .state
            .cleanup_operations
            .iter()
            .find(|current| current.task_id == operation.task_id)
        {
            return if current.worktree_generation == operation.worktree_generation
                && current.managed_worktree_operation_id == operation.managed_worktree_operation_id
                && current.cleanup_mode == operation.cleanup_mode
                && current.acknowledged_content_blockers == operation.acknowledged_content_blockers
            {
                Ok(BeginCleanupOutcome::Current(current.clone()))
            } else {
                Err(StoreError::JournalConflict {
                    operation_id: current.operation_id.clone(),
                })
            };
        }
        if operation.stage != WorktreeCleanupStage::Reserved || operation.failure.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.cleanup_operations.push(operation.clone());
        self.commit_or_restore(previous)?;
        Ok(BeginCleanupOutcome::Started(operation))
    }

    pub fn advance_task_worktree_cleanup(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        stage: WorktreeCleanupStage,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeCleanupOperation, StoreError> {
        let operation = checked_current_cleanup(&self.state, task_id, operation_id)?;
        if operation.stage == stage && operation.failure.is_none() {
            return Ok(operation);
        }
        let valid = matches!(
            (operation.stage, stage),
            (
                WorktreeCleanupStage::Reserved,
                WorktreeCleanupStage::RemovePrepared
            ) | (
                WorktreeCleanupStage::RemovePrepared,
                WorktreeCleanupStage::RemovalVerified
            )
        );
        if !valid {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let operation = current_cleanup_mut(&mut self.state, task_id, operation_id)?;
        operation.stage = stage;
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn fail_task_worktree_cleanup(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        failure: WorktreeCleanupFailure,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeCleanupOperation, StoreError> {
        let operation = checked_current_cleanup(&self.state, task_id, operation_id)?;
        validate_cleanup_failure(&failure)?;
        if operation.failure.as_ref() == Some(&failure) {
            return Ok(operation);
        }
        let previous = self.state.clone();
        let operation = current_cleanup_mut(&mut self.state, task_id, operation_id)?;
        operation.failure = Some(failure);
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn retry_task_worktree_cleanup(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeCleanupOperation, StoreError> {
        let operation = checked_current_cleanup(&self.state, task_id, operation_id)?;
        if operation.failure.is_none() {
            return Ok(operation);
        }
        let retry_stage = if operation.cleanup_mode == WorktreeCleanupMode::Safe
            && operation.stage == WorktreeCleanupStage::RemovePrepared
            && operation.failure.as_ref().is_some_and(|failure| {
                failure.kind == WorktreeCleanupFailureKind::CheckoutContentAppeared
            }) {
            WorktreeCleanupStage::Reserved
        } else {
            operation.stage
        };
        let previous = self.state.clone();
        let operation = current_cleanup_mut(&mut self.state, task_id, operation_id)?;
        operation.stage = retry_stage;
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn supersede_failed_task_worktree_cleanup(
        &mut self,
        _authority: &CoreWriteAuthority,
        previous_operation_id: &str,
        replacement: WorktreeCleanupOperation,
    ) -> Result<WorktreeCleanupOperation, StoreError> {
        validate_cleanup_intent(
            replacement.cleanup_mode,
            &replacement.acknowledged_content_blockers,
        )?;
        if replacement.stage != WorktreeCleanupStage::Reserved || replacement.failure.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        let index = self
            .state
            .cleanup_operations
            .iter()
            .position(|operation| {
                operation.task_id == replacement.task_id
                    && operation.operation_id == previous_operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let previous_operation = &self.state.cleanup_operations[index];
        if previous_operation.failure.is_none()
            || replacement.cleanup_mode != WorktreeCleanupMode::DiscardCheckoutContent
            || previous_operation.worktree_generation != replacement.worktree_generation
            || previous_operation.managed_worktree_operation_id
                != replacement.managed_worktree_operation_id
        {
            return Err(StoreError::ConstraintViolation);
        }
        if operation_id_owned_anywhere(&self.state, &replacement.operation_id) {
            return Err(StoreError::OperationIdReused {
                operation_id: replacement.operation_id,
            });
        }
        ensure_cleanup_tuple(&self.state, &replacement)?;
        let previous = self.state.clone();
        self.state.cleanup_operations[index] = replacement.clone();
        self.commit_or_restore(previous)?;
        Ok(replacement)
    }

    pub fn complete_task_worktree_cleanup(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        completed_at_epoch_ms: u64,
    ) -> Result<CleanupCommit, StoreError> {
        let operation = checked_current_cleanup(&self.state, task_id, operation_id)?;
        if operation.failure.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        let outcome = match operation.stage {
            WorktreeCleanupStage::Reserved => WorktreeCleanupOutcome::BindingCleared,
            WorktreeCleanupStage::RemovalVerified => WorktreeCleanupOutcome::Removed,
            WorktreeCleanupStage::RemovePrepared | WorktreeCleanupStage::BindingCleared => {
                return Err(StoreError::ConstraintViolation);
            }
        };
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let task = &mut self.state.tasks[task_index];
        let cleared_worktree_path = task.worktree.as_ref().map(|binding| binding.path.clone());
        task.worktree = None;
        task.updated_at_epoch_ms = completed_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
        let updated_task = task.clone();
        self.state
            .managed_worktrees
            .retain(|proof| proof.task_id != task_id);
        // A re-provisioned checkout at this exact path starts without local
        // dependencies again, so its run setup marks are no longer current.
        if let Some(path) = cleared_worktree_path {
            self.state
                .run_setup_marks
                .retain(|mark| mark.worktree_path != path);
        }
        let receipt = WorktreeCleanupReceipt {
            operation_id: operation.operation_id.clone(),
            task_id: task_id.to_owned(),
            worktree_generation: operation.worktree_generation,
            managed_worktree_operation_id: operation.managed_worktree_operation_id.clone(),
            cleanup_mode: operation.cleanup_mode,
            acknowledged_content_blockers: operation.acknowledged_content_blockers.clone(),
            outcome,
            completed_at_epoch_ms,
        };
        self.state
            .cleanup_receipts
            .retain(|candidate| candidate.task_id != task_id);
        self.state.cleanup_receipts.push(receipt.clone());
        let journal = current_cleanup_mut(&mut self.state, task_id, operation_id)?;
        journal.stage = WorktreeCleanupStage::BindingCleared;
        journal.failure = None;
        journal.updated_at_epoch_ms = completed_at_epoch_ms;
        self.commit_or_restore(previous)?;
        Ok(CleanupCommit {
            task: updated_task,
            receipt,
        })
    }

    pub fn clear_task_worktree_cleanup(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
    ) -> Result<u64, StoreError> {
        let index = self
            .state
            .cleanup_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        self.state.cleanup_operations.remove(index);
        self.commit_or_restore(previous)
    }
}

fn current_cleanup<'a>(
    state: &'a CurrentState,
    task_id: &str,
    operation_id: &str,
) -> Result<&'a WorktreeCleanupOperation, StoreError> {
    state
        .cleanup_operations
        .iter()
        .find(|operation| operation.task_id == task_id && operation.operation_id == operation_id)
        .ok_or(StoreError::NotFound)
}

fn current_cleanup_mut<'a>(
    state: &'a mut CurrentState,
    task_id: &str,
    operation_id: &str,
) -> Result<&'a mut WorktreeCleanupOperation, StoreError> {
    state
        .cleanup_operations
        .iter_mut()
        .find(|operation| operation.task_id == task_id && operation.operation_id == operation_id)
        .ok_or(StoreError::NotFound)
}

fn checked_current_cleanup(
    state: &CurrentState,
    task_id: &str,
    operation_id: &str,
) -> Result<WorktreeCleanupOperation, StoreError> {
    let operation = current_cleanup(state, task_id, operation_id)?.clone();
    ensure_cleanup_tuple(state, &operation)?;
    Ok(operation)
}

fn ensure_cleanup_receipt_is_current(
    state: &CurrentState,
    receipt: &WorktreeCleanupReceipt,
) -> Result<(), StoreError> {
    let task = state
        .tasks
        .iter()
        .find(|task| task.id == receipt.task_id)
        .ok_or(StoreError::NotFound)?;
    if task.worktree_generation == receipt.worktree_generation
        && task.worktree.is_none()
        && !state
            .managed_worktrees
            .iter()
            .any(|proof| proof.task_id == receipt.task_id)
    {
        Ok(())
    } else {
        Err(StoreError::ManagedWorktreeProofChanged {
            task_id: receipt.task_id.clone(),
        })
    }
}

fn ensure_cleanup_tuple(
    state: &CurrentState,
    operation: &WorktreeCleanupOperation,
) -> Result<(), StoreError> {
    let task = state
        .tasks
        .iter()
        .find(|task| task.id == operation.task_id)
        .ok_or(StoreError::NotFound)?;
    let proof = state
        .managed_worktrees
        .iter()
        .find(|proof| proof.task_id == operation.task_id)
        .ok_or_else(|| StoreError::ManagedWorktreeProofChanged {
            task_id: operation.task_id.clone(),
        })?;
    let matches = operation.worktree_generation > 0
        && task.worktree_generation == operation.worktree_generation
        && proof.worktree_generation == operation.worktree_generation
        && proof.operation_id == operation.managed_worktree_operation_id
        && task.worktree.as_ref().is_some_and(|binding| {
            binding.path == operation.baseline.worktree_path
                && binding.path == operation.baseline.registered_worktree_path
        })
        && task.branch.as_ref().is_some_and(|binding| {
            binding.repository_root == operation.baseline.repository_root
                && proof.branch_ref == operation.baseline.branch_ref
        })
        && proof.repository_common_dir == operation.baseline.repository_common_dir
        && proof.registered_worktree_path == operation.baseline.registered_worktree_path;
    if matches {
        Ok(())
    } else {
        Err(StoreError::ManagedWorktreeProofChanged {
            task_id: operation.task_id.clone(),
        })
    }
}
