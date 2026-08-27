use termloop_domain::{
    ProvisioningFailureKind, ProvisioningStage, TaskRecord, WorktreeProvisioningOperation,
};

use super::super::{
    BeginProvisioningOutcome, CoreWriteAuthority, ProvisioningCommit, Store, StoreError,
    operation_id_owned_by_cleanup,
};

impl Store {
    pub fn begin_task_worktree_provisioning(
        &mut self,
        _authority: &CoreWriteAuthority,
        operation: WorktreeProvisioningOperation,
    ) -> Result<BeginProvisioningOutcome, StoreError> {
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == operation.task_id)
            .ok_or(StoreError::NotFound)?;
        if task.project_id != operation.project_id
            || task.branch.as_ref().is_some_and(|binding| {
                binding.repository_root != operation.spec.repository_root
                    || binding.name != operation.spec.branch_name
            })
        {
            return Err(StoreError::ConstraintViolation);
        }
        if operation_id_owned_by_cleanup(&self.state, &operation.operation_id)
            || self
                .state
                .repair_operations
                .iter()
                .any(|current| current.operation_id == operation.operation_id)
            || self
                .state
                .repair_receipts
                .iter()
                .any(|current| current.operation_id == operation.operation_id)
            || self
                .state
                .stale_resolution_operations
                .iter()
                .any(|current| current.operation_id == operation.operation_id)
            || self
                .state
                .stale_resolution_receipts
                .iter()
                .any(|current| current.operation_id == operation.operation_id)
        {
            return Err(StoreError::OperationIdReused {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(current) = self
            .state
            .cleanup_operations
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
        if let Some(proof) = self
            .state
            .managed_worktrees
            .iter()
            .find(|proof| proof.operation_id == operation.operation_id)
        {
            return if proof.task_id == operation.task_id && proof.normalized_spec == operation.spec
            {
                Ok(BeginProvisioningOutcome::Completed(proof.clone()))
            } else {
                Err(StoreError::OperationIdReused {
                    operation_id: operation.operation_id.clone(),
                })
            };
        }
        if self.state.provisioning_operations.iter().any(|current| {
            current.operation_id == operation.operation_id
                && (current.task_id != operation.task_id || current.spec != operation.spec)
        }) {
            return Err(StoreError::OperationIdReused {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(current) = self
            .state
            .provisioning_operations
            .iter()
            .find(|current| current.task_id == operation.task_id)
        {
            return if current.spec == operation.spec {
                Ok(BeginProvisioningOutcome::Current(current.clone()))
            } else {
                Err(StoreError::JournalConflict {
                    operation_id: current.operation_id.clone(),
                })
            };
        }
        if task.worktree.is_some() {
            return Err(StoreError::ConstraintViolation);
        }
        if let Some(holder) = self.state.tasks.iter().find(|candidate| {
            candidate.id != operation.task_id
                && candidate.project_id == operation.project_id
                && candidate.branch.as_ref().is_some_and(|binding| {
                    binding.repository_root == operation.spec.repository_root
                        && binding.name == operation.spec.branch_name
                })
        }) {
            return Err(StoreError::BranchHeld {
                task_id: holder.id.clone(),
            });
        }
        if let Some(holder) = self.state.provisioning_operations.iter().find(|candidate| {
            candidate.task_id != operation.task_id
                && candidate.project_id == operation.project_id
                && candidate.spec.repository_root == operation.spec.repository_root
                && candidate.spec.branch_name == operation.spec.branch_name
        }) {
            return Err(StoreError::BranchHeld {
                task_id: holder.task_id.clone(),
            });
        }
        if let Some(holder) = self.state.tasks.iter().find(|candidate| {
            candidate.id != operation.task_id
                && candidate
                    .worktree
                    .as_ref()
                    .is_some_and(|binding| binding.path == operation.spec.destination_path)
        }) {
            return Err(StoreError::WorktreePathHeld {
                task_id: holder.id.clone(),
            });
        }
        if let Some(holder) =
            self.state.provisioning_operations.iter().find(|candidate| {
                candidate.spec.destination_path == operation.spec.destination_path
            })
        {
            return Err(StoreError::WorktreePathHeld {
                task_id: holder.task_id.clone(),
            });
        }
        let previous = self.state.clone();
        self.state.provisioning_operations.push(operation.clone());
        self.commit_or_restore(previous)?;
        Ok(BeginProvisioningOutcome::Started(operation))
    }

    pub fn advance_task_worktree_provisioning(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        stage: ProvisioningStage,
        created_branch_ref: bool,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeProvisioningOperation, StoreError> {
        let previous = self.state.clone();
        let operation = self
            .state
            .provisioning_operations
            .iter_mut()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        if operation.stage == stage && operation.created_branch_ref == created_branch_ref {
            return Ok(operation.clone());
        }
        let valid = matches!(
            (operation.stage, stage),
            (
                ProvisioningStage::Reserved,
                ProvisioningStage::BranchCreated
            ) | (
                ProvisioningStage::Reserved,
                ProvisioningStage::WorktreeAdded
            ) | (
                ProvisioningStage::BranchCreated,
                ProvisioningStage::WorktreeAdded
            )
        );
        if !valid {
            return Err(StoreError::ConstraintViolation);
        }
        operation.stage = stage;
        operation.created_branch_ref = created_branch_ref;
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn fail_task_worktree_provisioning(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        failure: ProvisioningFailureKind,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeProvisioningOperation, StoreError> {
        let previous = self.state.clone();
        let operation = self
            .state
            .provisioning_operations
            .iter_mut()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        if operation.failure == Some(failure) {
            return Ok(operation.clone());
        }
        operation.failure = Some(failure);
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn retry_task_worktree_provisioning(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeProvisioningOperation, StoreError> {
        let previous = self.state.clone();
        let operation = self
            .state
            .provisioning_operations
            .iter_mut()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        if operation.failure.is_none() {
            return Ok(operation.clone());
        }
        operation.failure = None;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn record_provisioning_ref_rollback(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        failure: ProvisioningFailureKind,
        updated_at_epoch_ms: u64,
    ) -> Result<WorktreeProvisioningOperation, StoreError> {
        let previous = self.state.clone();
        let operation = self
            .state
            .provisioning_operations
            .iter_mut()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        if operation.stage != ProvisioningStage::BranchCreated || !operation.created_branch_ref {
            return Err(StoreError::ConstraintViolation);
        }
        operation.stage = ProvisioningStage::Reserved;
        operation.created_branch_ref = false;
        operation.failure = Some(failure);
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = operation.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn commit_task_worktree_provisioning(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
        commit: ProvisioningCommit,
    ) -> Result<TaskRecord, StoreError> {
        let ProvisioningCommit {
            branch,
            worktree,
            proof,
            updated_at_epoch_ms,
        } = commit;
        let operation_index = self
            .state
            .provisioning_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let operation = &self.state.provisioning_operations[operation_index];
        if operation.stage != ProvisioningStage::WorktreeAdded
            || operation.spec != proof.normalized_spec
            || operation.spec.repository_root != branch.repository_root
            || operation.spec.branch_name != branch.name
            || proof.task_id != task_id
            || proof.operation_id != operation_id
            || proof.registered_worktree_path != worktree.path
        {
            return Err(StoreError::ConstraintViolation);
        }
        let task_index = self
            .state
            .tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or(StoreError::NotFound)?;
        let task = &self.state.tasks[task_index];
        if task.worktree.is_some()
            || task.project_id != operation.project_id
            || task
                .branch
                .as_ref()
                .is_some_and(|existing| existing != &branch)
            || self.state.managed_worktrees.iter().any(|candidate| {
                candidate.task_id != task_id && candidate.registered_worktree_path == worktree.path
            })
            || self
                .state
                .cleanup_operations
                .iter()
                .any(|candidate| candidate.task_id == task_id)
            || self
                .state
                .repair_operations
                .iter()
                .any(|candidate| candidate.task_id == task_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        if let Some(holder) = self.state.tasks.iter().find(|candidate| {
            candidate.id != task_id
                && candidate.project_id == task.project_id
                && candidate.branch.as_ref() == Some(&branch)
        }) {
            return Err(StoreError::BranchHeld {
                task_id: holder.id.clone(),
            });
        }
        if let Some(holder) = self.state.provisioning_operations.iter().find(|candidate| {
            candidate.task_id != task_id
                && candidate.project_id == task.project_id
                && candidate.spec.repository_root == branch.repository_root
                && candidate.spec.branch_name == branch.name
        }) {
            return Err(StoreError::BranchHeld {
                task_id: holder.task_id.clone(),
            });
        }
        let previous = self.state.clone();
        let next_generation = self.state.tasks[task_index]
            .worktree_generation
            .checked_add(1)
            .ok_or(StoreError::ConstraintViolation)?;
        let mut proof = proof;
        proof.worktree_generation = next_generation;
        let task = &mut self.state.tasks[task_index];
        task.branch = Some(branch);
        task.worktree = Some(worktree);
        task.worktree_generation = next_generation;
        task.updated_at_epoch_ms = updated_at_epoch_ms;
        let updated = task.clone();
        self.state
            .managed_worktrees
            .retain(|candidate| candidate.task_id != task_id);
        self.state.managed_worktrees.push(proof);
        self.state.provisioning_operations[operation_index].stage =
            ProvisioningStage::BindingCommitted;
        self.state.provisioning_operations[operation_index].failure = None;
        self.state.provisioning_operations[operation_index].updated_at_epoch_ms =
            updated_at_epoch_ms;
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn clear_task_worktree_provisioning(
        &mut self,
        _authority: &CoreWriteAuthority,
        task_id: &str,
        operation_id: &str,
    ) -> Result<u64, StoreError> {
        let index = self
            .state
            .provisioning_operations
            .iter()
            .position(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        self.state.provisioning_operations.remove(index);
        self.commit_or_restore(previous)
    }
}
