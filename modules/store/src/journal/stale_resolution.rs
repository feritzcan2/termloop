use termloop_domain::{
    WorktreeCleanupStage, WorktreeStaleResolutionFailure, WorktreeStaleResolutionFailureKind,
    WorktreeStaleResolutionMode, WorktreeStaleResolutionOperation, WorktreeStaleResolutionReceipt,
    WorktreeStaleResolutionStage,
};

use crate::validation::validate_stale_resolution_failure;

use super::super::{
    BeginStaleResolutionOutcome, CoreWriteAuthority, CurrentState, StaleResolutionCommit, Store,
    StoreError, ensure_stale_resolution_tuple, operation_id_owned_anywhere,
};

impl Store {
    pub fn begin_task_worktree_stale_resolution(
        &mut self,
        _authority: &CoreWriteAuthority,
        operation: WorktreeStaleResolutionOperation,
        supersedes_cleanup_operation_id: Option<&str>,
    ) -> Result<BeginStaleResolutionOutcome, StoreError> {
        if let Some(receipt) = self
            .state
            .stale_resolution_receipts
            .iter()
            .find(|receipt| receipt.operation_id == operation.operation_id)
        {
            return if stale_receipt_matches_operation(receipt, &operation)
                && self.state.tasks.iter().any(|task| {
                    task.id == receipt.task_id
                        && task.worktree.is_none()
                        && task.worktree_generation == receipt.worktree_generation
                }) {
                Ok(BeginStaleResolutionOutcome::Completed(receipt.clone()))
            } else {
                Err(StoreError::OperationIdReused {
                    operation_id: operation.operation_id,
                })
            };
        }
        if let Some(current) = self
            .state
            .stale_resolution_operations
            .iter()
            .find(|current| current.operation_id == operation.operation_id)
        {
            return if stale_operations_have_same_intent(current, &operation) {
                Ok(BeginStaleResolutionOutcome::Current(current.clone()))
            } else {
                Err(StoreError::OperationIdReused {
                    operation_id: operation.operation_id,
                })
            };
        }
        if operation_id_owned_anywhere(&self.state, &operation.operation_id) {
            return Err(StoreError::OperationIdReused {
                operation_id: operation.operation_id,
            });
        }
        ensure_stale_resolution_tuple(&self.state, &operation)?;
        if operation.stage != WorktreeStaleResolutionStage::Reserved || operation.failure.is_some()
        {
            return Err(StoreError::ConstraintViolation);
        }
        for current in &self.state.provisioning_operations {
            if current.task_id == operation.task_id {
                return Err(StoreError::JournalConflict {
                    operation_id: current.operation_id.clone(),
                });
            }
        }
        for current in &self.state.repair_operations {
            if current.task_id == operation.task_id {
                return Err(StoreError::JournalConflict {
                    operation_id: current.operation_id.clone(),
                });
            }
        }
        for current in &self.state.session_relocation_operations {
            if current.target_task_id == operation.task_id {
                return Err(StoreError::JournalConflict {
                    operation_id: current.operation_id.clone(),
                });
            }
        }
        let cleanup_index = self
            .state
            .cleanup_operations
            .iter()
            .position(|current| current.task_id == operation.task_id);
        if let Some(index) = cleanup_index {
            let current = &self.state.cleanup_operations[index];
            if Some(current.operation_id.as_str()) != supersedes_cleanup_operation_id
                || !matches!(
                    current.stage,
                    WorktreeCleanupStage::Reserved | WorktreeCleanupStage::RemovePrepared
                )
            {
                return Err(StoreError::JournalConflict {
                    operation_id: current.operation_id.clone(),
                });
            }
        } else if supersedes_cleanup_operation_id.is_some() {
            return Err(StoreError::NotFound);
        }
        if let Some(current) = self
            .state
            .stale_resolution_operations
            .iter()
            .find(|current| current.task_id == operation.task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
        }
        let previous = self.state.clone();
        if let Some(index) = cleanup_index {
            self.state.cleanup_operations.remove(index);
        }
        self.state
            .stale_resolution_operations
            .push(operation.clone());
        self.commit_or_restore(previous)?;
        Ok(BeginStaleResolutionOutcome::Started(operation))
    }

    pub fn advance_task_worktree_stale_resolution(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        stage: WorktreeStaleResolutionStage,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeStaleResolutionOperation, StoreError> {
        let index = current_stale_resolution_index(&self.state, task_id, operation_id)?;
        let current = &self.state.stale_resolution_operations[index];
        if current.stage == stage && current.failure.is_none() {
            return Ok(current.clone());
        }
        let valid = current.mode == WorktreeStaleResolutionMode::DiscardDirectory
            && matches!(
                (current.stage, stage),
                (
                    WorktreeStaleResolutionStage::Reserved,
                    WorktreeStaleResolutionStage::RemovalPrepared
                ) | (
                    WorktreeStaleResolutionStage::RemovalPrepared,
                    WorktreeStaleResolutionStage::RemovalInvoked
                ) | (
                    WorktreeStaleResolutionStage::RemovalInvoked,
                    WorktreeStaleResolutionStage::RemovalVerified
                )
            );
        if !valid {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let operation = &mut self.state.stale_resolution_operations[index];
        operation.stage = stage;
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn fail_task_worktree_stale_resolution(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        failure: WorktreeStaleResolutionFailure,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeStaleResolutionOperation, StoreError> {
        validate_stale_resolution_failure(&failure)?;
        let index = current_stale_resolution_index(&self.state, task_id, operation_id)?;
        if self.state.stale_resolution_operations[index]
            .failure
            .as_ref()
            == Some(&failure)
        {
            return Ok(self.state.stale_resolution_operations[index].clone());
        }
        let previous = self.state.clone();
        let operation = &mut self.state.stale_resolution_operations[index];
        operation.failure = Some(failure);
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn retry_task_worktree_stale_resolution(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeStaleResolutionOperation, StoreError> {
        let index = current_stale_resolution_index(&self.state, task_id, operation_id)?;
        let current = &self.state.stale_resolution_operations[index];
        if current.mode != WorktreeStaleResolutionMode::DiscardDirectory
            || current.stage != WorktreeStaleResolutionStage::RemovalPrepared
            || current.failure.as_ref().is_none_or(|failure| {
                failure.kind != WorktreeStaleResolutionFailureKind::RecoveryAttention
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let operation = &mut self.state.stale_resolution_operations[index];
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn verify_absent_task_worktree_stale_resolution(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeStaleResolutionOperation, StoreError> {
        let index = current_stale_resolution_index(&self.state, task_id, operation_id)?;
        let current = &self.state.stale_resolution_operations[index];
        ensure_stale_resolution_tuple(&self.state, current)?;
        if current.mode != WorktreeStaleResolutionMode::DiscardDirectory
            || !matches!(
                current.stage,
                WorktreeStaleResolutionStage::RemovalPrepared
                    | WorktreeStaleResolutionStage::RemovalInvoked
            )
            || current.failure.as_ref().is_none_or(|failure| {
                failure.kind != WorktreeStaleResolutionFailureKind::RecoveryAttention
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let operation = &mut self.state.stale_resolution_operations[index];
        operation.stage = WorktreeStaleResolutionStage::RemovalVerified;
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn clear_task_worktree_stale_resolution_before_mutation(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
    ) -> Result<u64, StoreError> {
        let index = current_stale_resolution_index(&self.state, task_id, operation_id)?;
        let operation = &self.state.stale_resolution_operations[index];
        if !matches!(
            operation.stage,
            WorktreeStaleResolutionStage::Reserved | WorktreeStaleResolutionStage::RemovalPrepared
        ) || operation.failure.is_some()
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.stale_resolution_operations.remove(index);
        self.commit_or_restore(previous)
    }

    pub fn complete_task_worktree_stale_resolution(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        completed_at_epoch_ms: u64,
    ) -> Result<StaleResolutionCommit, StoreError> {
        let operation_index = current_stale_resolution_index(&self.state, task_id, operation_id)?;
        let operation = self.state.stale_resolution_operations[operation_index].clone();
        ensure_stale_resolution_tuple(&self.state, &operation)?;
        let valid_stage = match operation.mode {
            WorktreeStaleResolutionMode::ForgetBinding => {
                operation.stage == WorktreeStaleResolutionStage::Reserved
            }
            WorktreeStaleResolutionMode::DiscardDirectory => {
                operation.stage == WorktreeStaleResolutionStage::RemovalVerified
            }
        };
        if !valid_stage || operation.failure.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let task = &mut self.state.tasks[task_index];
        task.worktree = None;
        task.updated_at_epoch_ms = completed_at_epoch_ms.max(task.updated_at_epoch_ms + 1);
        let updated_task = task.clone();
        self.state
            .managed_worktrees
            .retain(|proof| proof.task_id != task_id);
        let receipt = WorktreeStaleResolutionReceipt {
            operation_id: operation.operation_id.clone(),
            task_id: operation.task_id.clone(),
            managed_worktree_operation_id: operation.managed_worktree_operation_id.clone(),
            worktree_generation: operation.worktree_generation,
            target_path: operation.target_path.clone(),
            mode: operation.mode,
            completed_at_epoch_ms,
        };
        self.state
            .stale_resolution_receipts
            .retain(|candidate| candidate.task_id != task_id);
        self.state.stale_resolution_receipts.push(receipt.clone());
        self.state
            .stale_resolution_operations
            .remove(operation_index);
        self.commit_or_restore(previous)?;
        Ok(StaleResolutionCommit {
            task: updated_task,
            receipt,
        })
    }
}

fn stale_operations_have_same_intent(
    left: &WorktreeStaleResolutionOperation,
    right: &WorktreeStaleResolutionOperation,
) -> bool {
    left.task_id == right.task_id
        && left.managed_worktree_operation_id == right.managed_worktree_operation_id
        && left.worktree_generation == right.worktree_generation
        && left.target_path == right.target_path
        && left.mode == right.mode
}

fn stale_receipt_matches_operation(
    receipt: &WorktreeStaleResolutionReceipt,
    operation: &WorktreeStaleResolutionOperation,
) -> bool {
    receipt.task_id == operation.task_id
        && receipt.managed_worktree_operation_id == operation.managed_worktree_operation_id
        && receipt.worktree_generation == operation.worktree_generation
        && receipt.target_path == operation.target_path
        && receipt.mode == operation.mode
}

fn current_stale_resolution_index(
    state: &CurrentState,
    task_id: &str,
    operation_id: &str,
) -> Result<usize, StoreError> {
    state
        .stale_resolution_operations
        .iter()
        .position(|operation| {
            operation.task_id == task_id && operation.operation_id == operation_id
        })
        .ok_or(StoreError::NotFound)
}
