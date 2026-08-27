use termloop_domain::{
    TaskRecord, TaskWorktreeBinding, WorktreeRepairFailure, WorktreeRepairOperation,
    WorktreeRepairReceipt, WorktreeRepairStage,
};

use super::super::{
    BeginRepairOutcome, CoreWriteAuthority, RepairCommit, Store, StoreError, ensure_repair_tuple,
    operation_id_owned_anywhere,
};

impl Store {
    pub fn begin_task_worktree_repair(
        &mut self,
        _authority: &CoreWriteAuthority,
        operation: WorktreeRepairOperation,
    ) -> Result<BeginRepairOutcome, StoreError> {
        if let Some(receipt) = self
            .state
            .repair_receipts
            .iter()
            .find(|receipt| receipt.operation_id == operation.operation_id)
        {
            return if receipt.task_id == operation.task_id
                && receipt.managed_worktree_operation_id == operation.managed_worktree_operation_id
                && receipt.previous_worktree_generation == operation.expected_worktree_generation
                && receipt.candidate_path == operation.candidate_path
            {
                let task = self
                    .state
                    .tasks
                    .iter()
                    .find(|task| task.id == receipt.task_id)
                    .ok_or(StoreError::NotFound)?;
                let proof = self
                    .state
                    .managed_worktrees
                    .iter()
                    .find(|proof| proof.task_id == receipt.task_id)
                    .ok_or(StoreError::ManagedWorktreeProofChanged {
                        task_id: receipt.task_id.clone(),
                    })?;
                if task.worktree_generation != receipt.worktree_generation
                    || proof.worktree_generation != receipt.worktree_generation
                    || proof.registered_worktree_path != receipt.candidate_path
                {
                    return Err(StoreError::ManagedWorktreeProofChanged {
                        task_id: receipt.task_id.clone(),
                    });
                }
                Ok(BeginRepairOutcome::Completed(receipt.clone()))
            } else {
                Err(StoreError::OperationIdReused {
                    operation_id: operation.operation_id,
                })
            };
        }
        if let Some(current) = self
            .state
            .repair_operations
            .iter()
            .find(|current| current.operation_id == operation.operation_id)
        {
            return if current.task_id == operation.task_id
                && current.managed_worktree_operation_id == operation.managed_worktree_operation_id
                && current.expected_worktree_generation == operation.expected_worktree_generation
                && current.candidate_path == operation.candidate_path
            {
                Ok(BeginRepairOutcome::Current(current.clone()))
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
        ensure_repair_tuple(&self.state, &operation)?;
        if let Some(current) = self
            .state
            .provisioning_operations
            .iter()
            .find(|current| current.task_id == operation.task_id)
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
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
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
        if let Some(current) = self
            .state
            .session_relocation_operations
            .iter()
            .find(|current| current.target_task_id == operation.task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
        }
        if let Some(current) = self
            .state
            .repair_operations
            .iter()
            .find(|current| current.task_id == operation.task_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: current.operation_id.clone(),
            });
        }
        if operation.stage != WorktreeRepairStage::Reserved || operation.failure.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.repair_operations.push(operation.clone());
        self.commit_or_restore(previous)?;
        Ok(BeginRepairOutcome::Started(operation))
    }

    pub fn advance_task_worktree_repair(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        stage: WorktreeRepairStage,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeRepairOperation, StoreError> {
        let index = self
            .state
            .repair_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let current = &self.state.repair_operations[index];
        ensure_repair_tuple(&self.state, current)?;
        if current.stage == stage {
            if current.failure.is_none() {
                return Ok(current.clone());
            }
            if stage != WorktreeRepairStage::Verified {
                return Err(StoreError::ConstraintViolation);
            }
        }
        let valid = matches!(
            (current.stage, stage),
            (
                WorktreeRepairStage::Reserved,
                WorktreeRepairStage::RepairPrepared
            ) | (
                WorktreeRepairStage::RepairPrepared,
                WorktreeRepairStage::RepairInvoked
            ) | (
                WorktreeRepairStage::RepairInvoked,
                WorktreeRepairStage::Verified
            ) | (
                WorktreeRepairStage::RepairPrepared,
                WorktreeRepairStage::Verified
            )
        );
        let recovering_verified = stage == WorktreeRepairStage::Verified
            && matches!(
                current.stage,
                WorktreeRepairStage::RepairPrepared
                    | WorktreeRepairStage::RepairInvoked
                    | WorktreeRepairStage::Verified
            );
        if (current.failure.is_some() || !valid) && !recovering_verified {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let operation = &mut self.state.repair_operations[index];
        operation.stage = stage;
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let result = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(result)
    }

    pub fn resume_task_worktree_repair_before_mutation(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeRepairOperation, StoreError> {
        let index = self
            .state
            .repair_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let current = &self.state.repair_operations[index];
        ensure_repair_tuple(&self.state, current)?;
        if !matches!(
            current.stage,
            WorktreeRepairStage::Reserved | WorktreeRepairStage::RepairPrepared
        ) {
            return Err(StoreError::ConstraintViolation);
        }
        if current.failure.is_none() {
            return Ok(current.clone());
        }
        let previous = self.state.clone();
        let operation = &mut self.state.repair_operations[index];
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let result = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(result)
    }

    pub fn fail_task_worktree_repair(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        failure: WorktreeRepairFailure,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeRepairOperation, StoreError> {
        let index = self
            .state
            .repair_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let operation = &mut self.state.repair_operations[index];
        operation.failure = Some(failure);
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let result = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(result)
    }

    pub fn complete_task_worktree_repair(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        completed_at_epoch_ms: u64,
    ) -> Result<RepairCommit, StoreError> {
        let operation = self
            .state
            .repair_operations
            .iter()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .cloned()
            .ok_or(StoreError::NotFound)?;
        ensure_repair_tuple(&self.state, &operation)?;
        if operation.stage != WorktreeRepairStage::Verified || operation.failure.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        let next_generation = operation
            .expected_worktree_generation
            .checked_add(1)
            .ok_or(StoreError::ConstraintViolation)?;
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let proof_index = self
            .state
            .managed_worktrees
            .iter()
            .position(|proof| proof.task_id == task_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let task = &mut self.state.tasks[task_index];
        task.worktree = Some(TaskWorktreeBinding {
            path: operation.candidate_path.clone(),
        });
        task.worktree_generation = next_generation;
        task.updated_at_epoch_ms = completed_at_epoch_ms;
        let proof = &mut self.state.managed_worktrees[proof_index];
        proof.registered_worktree_path = operation.candidate_path.clone();
        proof.worktree_generation = next_generation;
        let receipt = WorktreeRepairReceipt {
            operation_id: operation.operation_id.clone(),
            task_id: task_id.into(),
            managed_worktree_operation_id: operation.managed_worktree_operation_id.clone(),
            previous_worktree_generation: operation.expected_worktree_generation,
            worktree_generation: next_generation,
            candidate_path: operation.candidate_path.clone(),
            completed_at_epoch_ms,
        };
        self.state
            .repair_operations
            .retain(|candidate| candidate.task_id != task_id);
        self.state
            .repair_receipts
            .retain(|candidate| candidate.task_id != task_id);
        self.state.repair_receipts.push(receipt.clone());
        let result = RepairCommit {
            task: self.state.tasks[task_index].clone(),
            proof: self.state.managed_worktrees[proof_index].clone(),
            receipt,
        };
        self.commit_or_restore(previous)?;
        Ok(result)
    }

    pub fn dismiss_task_worktree_repair(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
    ) -> Result<TaskRecord, StoreError> {
        let index = self
            .state
            .repair_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let operation = &self.state.repair_operations[index];
        if operation.stage != WorktreeRepairStage::Reserved || operation.failure.is_none() {
            return Err(StoreError::ConstraintViolation);
        }
        ensure_repair_tuple(&self.state, operation)?;
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        self.state.repair_operations.remove(index);
        self.commit_or_restore(previous)?;
        Ok(task)
    }
}
