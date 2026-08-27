use std::path::Path;

use termloop_domain::{
    ManagedWorktreeProof, WorktreeCleanupFailure, WorktreeCleanupFailureKind,
    WorktreeCleanupOperation, WorktreeCleanupStage, WorktreeStaleResolutionMode,
};
use termloop_gitio::GitRunner;

use super::super::git_mapping::map_git_observation_error;
use super::super::health::comparison_key;
use super::{ObservedTaskWorktreeCleanup, observe_cleanup_facts};
use crate::{CoreError, CoreRuntime};

pub struct TaskWorktreeCleanupRecoveryPlan {
    operation: WorktreeCleanupOperation,
    proof: ManagedWorktreeProof,
    expected_task_archived_at_epoch_ms: Option<u64>,
}

impl TaskWorktreeCleanupRecoveryPlan {
    pub fn observe(self) -> Result<ObservedTaskWorktreeCleanup, CoreError> {
        let runner =
            GitRunner::discover_with_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
                .map_err(map_git_observation_error)?;
        let facts = observe_cleanup_facts(&runner, &self.proof)?;
        Ok(ObservedTaskWorktreeCleanup {
            expected_task_archived_at_epoch_ms: self.expected_task_archived_at_epoch_ms,
            operation_id: self.operation.operation_id,
            task_id: self.operation.task_id,
            expected_managed_worktree_operation_id: self.operation.managed_worktree_operation_id,
            expected_worktree_generation: self.operation.worktree_generation,
            cleanup_mode: self.operation.cleanup_mode,
            acknowledged_content_blockers: self.operation.acknowledged_content_blockers.clone(),
            supersedes_operation_id: None,
            proof: self.proof,
            facts,
            runner: runner.without_absolute_deadline(),
        })
    }
}

impl CoreRuntime {
    pub(crate) fn cleanup_reservation_for_cwd(&self, cwd: &Path) -> Option<(String, String)> {
        self.store
            .cleanup_operations()
            .iter()
            .filter(|operation| operation.failure.is_none())
            .find_map(|operation| {
                let target = Path::new(&operation.baseline.worktree_path);
                let identity = comparison_key(target)
                    .ok()
                    .zip(comparison_key(cwd).ok())
                    .is_some_and(|(target, cwd)| target.contains_or_equals(&cwd));
                identity.then(|| (operation.task_id.clone(), operation.operation_id.clone()))
            })
            .or_else(|| {
                self.store
                    .stale_resolution_operations()
                    .iter()
                    .filter(|operation| {
                        operation.mode == WorktreeStaleResolutionMode::DiscardDirectory
                    })
                    .find_map(|operation| {
                        let target = Path::new(&operation.target_path);
                        let identity = comparison_key(target)
                            .ok()
                            .zip(comparison_key(cwd).ok())
                            .is_some_and(|(target, cwd)| target.contains_or_equals(&cwd));
                        identity
                            .then(|| (operation.task_id.clone(), operation.operation_id.clone()))
                    })
            })
    }

    pub(crate) fn reconcile_task_worktree_cleanup_operations(&mut self) {
        let operations = self.store.cleanup_operations().to_vec();
        for operation in operations {
            match operation.stage {
                WorktreeCleanupStage::Reserved => {
                    let _ = self.store.fail_task_worktree_cleanup(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        WorktreeCleanupFailure {
                            kind: WorktreeCleanupFailureKind::OperationFailed,
                            blockers: vec![],
                        },
                        termloop_platform::current_epoch_ms(),
                    );
                }
                WorktreeCleanupStage::RemovePrepared | WorktreeCleanupStage::RemovalVerified => {
                    // The server recovery scheduler observes these stages out of lock.
                }
                WorktreeCleanupStage::BindingCleared => {
                    if self.store.cleanup_receipts().iter().any(|receipt| {
                        receipt.task_id == operation.task_id
                            && receipt.operation_id == operation.operation_id
                    }) {
                        let _ = self.store.clear_task_worktree_cleanup(
                            &self.write_authority,
                            &operation.task_id,
                            &operation.operation_id,
                        );
                    } else {
                        let _ = self.mark_cleanup_attention(&operation);
                    }
                }
            }
        }
    }

    pub fn plan_task_worktree_cleanup_recovery(&mut self) -> Vec<TaskWorktreeCleanupRecoveryPlan> {
        let operations = self.store.cleanup_operations().to_vec();
        let mut plans = Vec::new();
        for operation in operations {
            if !matches!(
                operation.stage,
                WorktreeCleanupStage::RemovePrepared | WorktreeCleanupStage::RemovalVerified
            ) {
                continue;
            }
            if let Some(proof) = self
                .store
                .managed_worktrees()
                .iter()
                .find(|proof| proof.task_id == operation.task_id)
                .cloned()
            {
                let expected_task_archived_at_epoch_ms = self
                    .store
                    .tasks()
                    .iter()
                    .find(|task| task.id == operation.task_id)
                    .and_then(|task| task.archived_at_epoch_ms);
                plans.push(TaskWorktreeCleanupRecoveryPlan {
                    operation,
                    proof,
                    expected_task_archived_at_epoch_ms,
                });
            } else {
                let _ = self.mark_cleanup_attention(&operation);
            }
        }
        plans
    }
}
