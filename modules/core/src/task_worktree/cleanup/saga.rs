use std::path::Path;

use serde_json::Value;
use termloop_domain::{
    ManagedWorktreeProof, WorktreeCleanupBaseline, WorktreeCleanupBlocker, WorktreeCleanupFailure,
    WorktreeCleanupFailureKind, WorktreeCleanupMode, WorktreeCleanupOperation,
    WorktreeCleanupStage,
};
use termloop_gitio::{GitError, GitRunner};
use termloop_store::BeginCleanupOutcome;
use uuid::Uuid;

use super::super::git_mapping::map_git_observation_error;
use super::policy::{
    both_absent, cleanup_failure_kind, cleanup_intent, cleanup_operation_id_is_owned,
    cleanup_refused, post_removal_matches, proof_changed, push_unique, requires_recovery_attention,
    unauthorized_cleanup_blockers,
};
use super::projection::outcome_name;
use super::{CleanupPathState, TaskWorktreeCleanupFacts, observe_cleanup_facts};
use crate::{CoreError, CoreRuntime, required_string, store_error};

pub struct TaskWorktreeCleanupPlan {
    project_id: String,
    expected_task_archived_at_epoch_ms: Option<u64>,
    operation_id: String,
    task_id: String,
    expected_managed_worktree_operation_id: String,
    expected_worktree_generation: u64,
    cleanup_mode: WorktreeCleanupMode,
    acknowledged_content_blockers: Vec<WorktreeCleanupBlocker>,
    supersedes_operation_id: Option<String>,
    proof: ManagedWorktreeProof,
}

pub enum TaskWorktreeCleanupPlanning {
    Return(Value),
    Observe(Box<TaskWorktreeCleanupPlan>),
    Finalize(Box<TaskWorktreeCleanupFinalization>),
}

pub struct TaskWorktreeCleanupFinalization {
    task_id: String,
    operation_id: String,
    receipt: termloop_domain::WorktreeCleanupReceipt,
}

pub struct ObservedTaskWorktreeCleanup {
    pub(super) expected_task_archived_at_epoch_ms: Option<u64>,
    pub(super) operation_id: String,
    pub(super) task_id: String,
    pub(super) expected_managed_worktree_operation_id: String,
    pub(super) expected_worktree_generation: u64,
    pub(super) cleanup_mode: WorktreeCleanupMode,
    pub(super) acknowledged_content_blockers: Vec<WorktreeCleanupBlocker>,
    pub(super) supersedes_operation_id: Option<String>,
    pub(super) proof: ManagedWorktreeProof,
    pub(super) facts: TaskWorktreeCleanupFacts,
    pub(super) runner: GitRunner,
}

pub struct TaskWorktreeCleanupObservationStep {
    expected_task_archived_at_epoch_ms: Option<u64>,
    operation: WorktreeCleanupOperation,
    proof: ManagedWorktreeProof,
    runner: GitRunner,
}

pub struct TaskWorktreeCleanupRemovalStep {
    expected_task_archived_at_epoch_ms: Option<u64>,
    operation: WorktreeCleanupOperation,
    proof: ManagedWorktreeProof,
    runner: GitRunner,
}

pub struct ExecutedTaskWorktreeCleanupRemoval {
    expected_task_archived_at_epoch_ms: Option<u64>,
    operation: WorktreeCleanupOperation,
    proof: ManagedWorktreeProof,
    runner: GitRunner,
    result: Result<(), GitError>,
}

pub enum TaskWorktreeCleanupProgress {
    Return(Value),
    Revalidate(Box<TaskWorktreeCleanupObservationStep>),
    Remove(Box<TaskWorktreeCleanupRemovalStep>),
    Verify(Box<TaskWorktreeCleanupObservationStep>),
}

impl TaskWorktreeCleanupPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe(self) -> Result<ObservedTaskWorktreeCleanup, CoreError> {
        let runner =
            GitRunner::discover_with_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
                .map_err(map_git_observation_error)?;
        let facts = observe_cleanup_facts(&runner, &self.proof)?;
        Ok(ObservedTaskWorktreeCleanup {
            expected_task_archived_at_epoch_ms: self.expected_task_archived_at_epoch_ms,
            operation_id: self.operation_id,
            task_id: self.task_id,
            expected_managed_worktree_operation_id: self.expected_managed_worktree_operation_id,
            expected_worktree_generation: self.expected_worktree_generation,
            cleanup_mode: self.cleanup_mode,
            acknowledged_content_blockers: self.acknowledged_content_blockers,
            supersedes_operation_id: self.supersedes_operation_id,
            proof: self.proof,
            facts,
            runner: runner.without_absolute_deadline(),
        })
    }
}

impl TaskWorktreeCleanupObservationStep {
    pub fn observe(self) -> Result<ObservedTaskWorktreeCleanup, CoreError> {
        let runner = self
            .runner
            .with_absolute_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
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

impl TaskWorktreeCleanupRemovalStep {
    pub fn execute(self) -> ExecutedTaskWorktreeCleanupRemoval {
        let bounded_runner = self
            .runner
            .clone()
            .with_absolute_timeout(termloop_gitio::CLEANUP_GIT_MUTATION_DEADLINE);
        let result = match bounded_runner {
            Ok(runner) => match self.operation.cleanup_mode {
                WorktreeCleanupMode::Safe => runner.remove_worktree_non_force(
                    Path::new(&self.operation.baseline.repository_root),
                    Path::new(&self.operation.baseline.worktree_path),
                ),
                WorktreeCleanupMode::DiscardCheckoutContent => runner
                    .remove_worktree_exact_discarding_checkout_content(
                        Path::new(&self.operation.baseline.repository_root),
                        Path::new(&self.operation.baseline.worktree_path),
                    ),
            },
            Err(error) => Err(error),
        };
        ExecutedTaskWorktreeCleanupRemoval {
            expected_task_archived_at_epoch_ms: self.expected_task_archived_at_epoch_ms,
            operation: self.operation,
            proof: self.proof,
            runner: self.runner,
            result,
        }
    }
}

impl CoreRuntime {
    pub fn plan_task_worktree_cleanup(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeCleanupPlanning, CoreError> {
        let operation_id = required_string(&params, "operationId")?;
        Uuid::parse_str(&operation_id)
            .map_err(|_| CoreError::InvalidParams("operationId".into()))?;
        let task_id = required_string(&params, "taskId")?;
        let expected_task_archived_at_epoch_ms = self.ensure_task_cleanup_allowed(&task_id)?;
        let expected_managed_worktree_operation_id =
            required_string(&params, "expectedManagedWorktreeOperationId")?;
        let expected_worktree_generation = params
            .get("expectedWorktreeGeneration")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedWorktreeGeneration".into()))?;
        let (cleanup_mode, acknowledged_content_blockers) = cleanup_intent(&params)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if let Some(repair) = self
            .store
            .repair_operations()
            .iter()
            .find(|repair| repair.task_id == task_id)
        {
            return Err(CoreError::RepairInProgress {
                task_id,
                operation_id: repair.operation_id.clone(),
            });
        }

        let retained_receipt = self
            .store
            .cleanup_receipts()
            .iter()
            .find(|receipt| receipt.operation_id == operation_id)
            .cloned();
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .cloned();
        let Some(proof) = proof else {
            if task.worktree.is_none()
                && task.worktree_generation == expected_worktree_generation
                && retained_receipt.as_ref().is_some_and(|receipt| {
                    receipt.task_id == task_id
                        && receipt.worktree_generation == expected_worktree_generation
                        && receipt.managed_worktree_operation_id
                            == expected_managed_worktree_operation_id
                        && (receipt.cleanup_mode != cleanup_mode
                            || receipt.acknowledged_content_blockers
                                != acknowledged_content_blockers)
                })
            {
                return Err(CoreError::OperationIdReused { operation_id });
            }
            if task.worktree.is_none()
                && task.worktree_generation == expected_worktree_generation
                && retained_receipt.as_ref().is_some_and(|receipt| {
                    receipt.task_id == task_id
                        && receipt.worktree_generation == expected_worktree_generation
                        && receipt.managed_worktree_operation_id
                            == expected_managed_worktree_operation_id
                        && receipt.cleanup_mode == cleanup_mode
                        && receipt.acknowledged_content_blockers == acknowledged_content_blockers
                })
                && let Some(receipt) = retained_receipt
            {
                if self.store.cleanup_operations().iter().any(|operation| {
                    operation.task_id == task_id
                        && operation.operation_id == operation_id
                        && operation.stage == WorktreeCleanupStage::BindingCleared
                }) {
                    return Ok(TaskWorktreeCleanupPlanning::Finalize(Box::new(
                        TaskWorktreeCleanupFinalization {
                            task_id,
                            operation_id,
                            receipt,
                        },
                    )));
                }
                return self
                    .cleanup_result(&task_id, &receipt, "alreadyCompleted", None)
                    .map(TaskWorktreeCleanupPlanning::Return);
            }
            if task.worktree.is_none() && task.worktree_generation == expected_worktree_generation {
                return Err(CoreError::WorktreeCleanupRefused {
                    task_id,
                    expected_managed_worktree_operation_id,
                    expected_worktree_generation,
                    blockers: vec![WorktreeCleanupBlocker::NoBinding],
                });
            }
            return Err(proof_changed(self, &task_id));
        };
        if task.worktree_generation != expected_worktree_generation
            || proof.worktree_generation != expected_worktree_generation
            || proof.operation_id != expected_managed_worktree_operation_id
        {
            return Err(proof_changed(self, &task_id));
        }
        if cleanup_operation_id_is_owned(
            &self.store,
            &operation_id,
            Some((&task_id, &operation_id)),
        ) {
            return Err(CoreError::OperationIdReused { operation_id });
        }
        let mut supersedes_operation_id = None;
        if let Some(current) = self
            .store
            .cleanup_operations()
            .iter()
            .find(|current| current.task_id == task_id)
        {
            let same_intent = current.cleanup_mode == cleanup_mode
                && current.acknowledged_content_blockers == acknowledged_content_blockers;
            if current.operation_id == operation_id {
                if !same_intent {
                    return Err(CoreError::OperationIdReused { operation_id });
                }
                if current.failure.is_none() {
                    return self
                        .cleanup_running_result(current)
                        .map(TaskWorktreeCleanupPlanning::Return);
                }
            } else if current.failure.is_none() && same_intent {
                return self
                    .cleanup_running_result(current)
                    .map(TaskWorktreeCleanupPlanning::Return);
            } else if current.failure.is_some()
                && cleanup_mode == WorktreeCleanupMode::DiscardCheckoutContent
            {
                supersedes_operation_id = Some(current.operation_id.clone());
            } else {
                return Err(CoreError::CleanupInProgress {
                    task_id,
                    operation_id: current.operation_id.clone(),
                });
            }
        }
        Ok(TaskWorktreeCleanupPlanning::Observe(Box::new(
            TaskWorktreeCleanupPlan {
                project_id: task.project_id.clone(),
                expected_task_archived_at_epoch_ms,
                operation_id,
                task_id,
                expected_managed_worktree_operation_id,
                expected_worktree_generation,
                cleanup_mode,
                acknowledged_content_blockers,
                supersedes_operation_id,
                proof,
            },
        )))
    }

    pub fn finalize_task_worktree_cleanup(
        &mut self,
        finalization: TaskWorktreeCleanupFinalization,
    ) -> Result<Value, CoreError> {
        let operation = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| {
                operation.task_id == finalization.task_id
                    && operation.operation_id == finalization.operation_id
                    && operation.stage == WorktreeCleanupStage::BindingCleared
            })
            .ok_or(CoreError::NotFound)?;
        if operation.worktree_generation != finalization.receipt.worktree_generation
            || operation.managed_worktree_operation_id
                != finalization.receipt.managed_worktree_operation_id
        {
            return Err(proof_changed(self, &finalization.task_id));
        }
        self.store
            .clear_task_worktree_cleanup(
                &self.write_authority,
                &finalization.task_id,
                &finalization.operation_id,
            )
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&finalization.task_id);
        self.cleanup_result(
            &finalization.task_id,
            &finalization.receipt,
            "alreadyCompleted",
            None,
        )
    }

    pub fn begin_task_worktree_cleanup(
        &mut self,
        observed: ObservedTaskWorktreeCleanup,
    ) -> Result<TaskWorktreeCleanupProgress, CoreError> {
        self.ensure_observed_cleanup_tuple(&observed)?;
        self.cache_cleanup_health(&observed)?;
        let presence = self.refresh_cleanup_presence(
            &observed.task_id,
            observed.facts.path_state == CleanupPathState::Absent,
        )?;
        let (blockers, _) = self.cleanup_policy(&observed, &presence, Some(&observed.operation_id));
        let blockers = unauthorized_cleanup_blockers(
            observed.cleanup_mode,
            &observed.acknowledged_content_blockers,
            blockers,
        );
        if !blockers.is_empty() {
            if requires_recovery_attention(&blockers) {
                if let Some(previous_operation_id) = &observed.supersedes_operation_id {
                    let previous = self
                        .store
                        .cleanup_operations()
                        .iter()
                        .find(|operation| operation.operation_id == *previous_operation_id)
                        .cloned()
                        .ok_or(CoreError::NotFound)?;
                    self.mark_cleanup_attention(&previous)?;
                    return Err(CoreError::WorktreeCleanupRecoveryAttention {
                        operation_id: previous.operation_id,
                    });
                }
                let now = termloop_platform::current_epoch_ms();
                let requested =
                    requested_cleanup_operation(&observed, cleanup_baseline(&observed)?, now);
                let operation = match self
                    .store
                    .begin_task_worktree_cleanup(&self.write_authority, requested)
                    .map_err(|error| self.map_cleanup_store_error(error, &observed.task_id))?
                {
                    BeginCleanupOutcome::Started(operation)
                    | BeginCleanupOutcome::Current(operation) => operation,
                    BeginCleanupOutcome::Completed(receipt) => {
                        return self
                            .cleanup_result(&receipt.task_id, &receipt, "alreadyCompleted", None)
                            .map(TaskWorktreeCleanupProgress::Return);
                    }
                };
                self.mark_cleanup_attention(&operation)?;
                return Err(CoreError::WorktreeCleanupRecoveryAttention {
                    operation_id: operation.operation_id,
                });
            }
            return Err(cleanup_refused(&observed, blockers));
        }
        let baseline = cleanup_baseline(&observed)?;
        let now = termloop_platform::current_epoch_ms();
        let requested = requested_cleanup_operation(&observed, baseline, now);
        let begin = if let Some(previous_operation_id) = &observed.supersedes_operation_id {
            self.store
                .supersede_failed_task_worktree_cleanup(
                    &self.write_authority,
                    previous_operation_id,
                    requested,
                )
                .map(BeginCleanupOutcome::Started)
        } else {
            self.store
                .begin_task_worktree_cleanup(&self.write_authority, requested)
        }
        .map_err(|error| self.map_cleanup_store_error(error, &observed.task_id))?;
        match begin {
            BeginCleanupOutcome::Completed(receipt) => self
                .cleanup_result(&receipt.task_id, &receipt, "alreadyCompleted", None)
                .map(TaskWorktreeCleanupProgress::Return),
            BeginCleanupOutcome::Current(operation) if operation.failure.is_none() => self
                .cleanup_running_result(&operation)
                .map(TaskWorktreeCleanupProgress::Return),
            BeginCleanupOutcome::Current(operation) => {
                let operation = self
                    .store
                    .retry_task_worktree_cleanup(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        now,
                    )
                    .map_err(store_error)?;
                Ok(TaskWorktreeCleanupProgress::Revalidate(Box::new(
                    TaskWorktreeCleanupObservationStep {
                        expected_task_archived_at_epoch_ms: observed
                            .expected_task_archived_at_epoch_ms,
                        operation,
                        proof: observed.proof,
                        runner: observed.runner,
                    },
                )))
            }
            BeginCleanupOutcome::Started(operation) if both_absent(&observed.facts) => self
                .complete_cleanup_binding_clear(&operation, "bindingCleared")
                .map(TaskWorktreeCleanupProgress::Return),
            BeginCleanupOutcome::Started(operation) => Ok(TaskWorktreeCleanupProgress::Revalidate(
                Box::new(TaskWorktreeCleanupObservationStep {
                    expected_task_archived_at_epoch_ms: observed.expected_task_archived_at_epoch_ms,
                    operation,
                    proof: observed.proof,
                    runner: observed.runner,
                }),
            )),
        }
    }

    pub fn apply_task_worktree_cleanup_observation(
        &mut self,
        observed: ObservedTaskWorktreeCleanup,
    ) -> Result<TaskWorktreeCleanupProgress, CoreError> {
        self.ensure_observed_cleanup_tuple(&observed)?;
        self.cache_cleanup_health(&observed)?;
        let operation = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| {
                operation.task_id == observed.task_id
                    && operation.operation_id == observed.operation_id
            })
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let presence = self.refresh_cleanup_presence(
            &observed.task_id,
            observed.facts.path_state == CleanupPathState::Absent,
        )?;
        match operation.stage {
            WorktreeCleanupStage::Reserved => {
                let (mut blockers, _) =
                    self.cleanup_policy(&observed, &presence, Some(&operation.operation_id));
                if observed.facts.head_oid.as_deref() != Some(&operation.baseline.head_oid) {
                    push_unique(&mut blockers, WorktreeCleanupBlocker::HeadMismatch);
                }
                let blockers = unauthorized_cleanup_blockers(
                    operation.cleanup_mode,
                    &operation.acknowledged_content_blockers,
                    blockers,
                );
                if !blockers.is_empty() {
                    if requires_recovery_attention(&blockers) {
                        self.mark_cleanup_attention(&operation)?;
                        return Err(CoreError::WorktreeCleanupRecoveryAttention {
                            operation_id: operation.operation_id,
                        });
                    }
                    self.store
                        .clear_task_worktree_cleanup(
                            &self.write_authority,
                            &operation.task_id,
                            &operation.operation_id,
                        )
                        .map_err(store_error)?;
                    return Err(cleanup_refused(&observed, blockers));
                }
                if both_absent(&observed.facts) {
                    return self
                        .complete_cleanup_binding_clear(&operation, "bindingCleared")
                        .map(TaskWorktreeCleanupProgress::Return);
                }
                let operation = self
                    .store
                    .advance_task_worktree_cleanup(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        WorktreeCleanupStage::RemovePrepared,
                        termloop_platform::current_epoch_ms(),
                    )
                    .map_err(store_error)?;
                Ok(TaskWorktreeCleanupProgress::Remove(Box::new(
                    TaskWorktreeCleanupRemovalStep {
                        expected_task_archived_at_epoch_ms: observed
                            .expected_task_archived_at_epoch_ms,
                        operation,
                        proof: observed.proof,
                        runner: observed.runner,
                    },
                )))
            }
            WorktreeCleanupStage::RemovePrepared => {
                if post_removal_matches(&observed.facts, &operation) {
                    let operation = self
                        .store
                        .advance_task_worktree_cleanup(
                            &self.write_authority,
                            &operation.task_id,
                            &operation.operation_id,
                            WorktreeCleanupStage::RemovalVerified,
                            termloop_platform::current_epoch_ms(),
                        )
                        .map_err(store_error)?;
                    self.complete_cleanup_binding_clear(&operation, "removed")
                        .map(TaskWorktreeCleanupProgress::Return)
                } else {
                    self.mark_cleanup_attention(&operation)?;
                    Err(CoreError::WorktreeCleanupRecoveryAttention {
                        operation_id: operation.operation_id,
                    })
                }
            }
            WorktreeCleanupStage::RemovalVerified => {
                if post_removal_matches(&observed.facts, &operation) {
                    self.complete_cleanup_binding_clear(&operation, "removed")
                        .map(TaskWorktreeCleanupProgress::Return)
                } else {
                    self.mark_cleanup_attention(&operation)?;
                    Err(CoreError::WorktreeCleanupRecoveryAttention {
                        operation_id: operation.operation_id,
                    })
                }
            }
            WorktreeCleanupStage::BindingCleared => {
                let receipt = self
                    .store
                    .cleanup_receipts()
                    .iter()
                    .find(|receipt| receipt.task_id == operation.task_id)
                    .cloned()
                    .ok_or(CoreError::WorktreeCleanupRecoveryAttention {
                        operation_id: operation.operation_id.clone(),
                    })?;
                self.store
                    .clear_task_worktree_cleanup(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                    )
                    .map_err(store_error)?;
                self.cleanup_result(
                    &operation.task_id,
                    &receipt,
                    outcome_name(receipt.outcome),
                    None,
                )
                .map(TaskWorktreeCleanupProgress::Return)
            }
        }
    }

    pub fn apply_task_worktree_cleanup_removal(
        &mut self,
        executed: ExecutedTaskWorktreeCleanupRemoval,
    ) -> Result<TaskWorktreeCleanupProgress, CoreError> {
        let current = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| {
                operation.task_id == executed.operation.task_id
                    && operation.operation_id == executed.operation.operation_id
            })
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if current.stage != WorktreeCleanupStage::RemovePrepared || current.failure.is_some() {
            return Err(CoreError::CleanupInProgress {
                task_id: current.task_id,
                operation_id: current.operation_id,
            });
        }
        match executed.result {
            Ok(()) => Ok(TaskWorktreeCleanupProgress::Verify(Box::new(
                TaskWorktreeCleanupObservationStep {
                    expected_task_archived_at_epoch_ms: executed.expected_task_archived_at_epoch_ms,
                    operation: current,
                    proof: executed.proof,
                    runner: executed.runner,
                },
            ))),
            Err(error) => {
                let (core_error, kind) = match error {
                    GitError::CheckoutContentChanged => (
                        CoreError::WorktreePathConflict,
                        WorktreeCleanupFailureKind::CheckoutContentAppeared,
                    ),
                    GitError::PathConflict => (
                        CoreError::WorktreePathConflict,
                        WorktreeCleanupFailureKind::RemovalFailed,
                    ),
                    GitError::WorktreeLocked => (
                        CoreError::WorktreeLocked,
                        WorktreeCleanupFailureKind::RemovalFailed,
                    ),
                    other => {
                        let core_error = map_git_observation_error(other);
                        let kind = cleanup_failure_kind(&core_error);
                        (core_error, kind)
                    }
                };
                self.store
                    .fail_task_worktree_cleanup(
                        &self.write_authority,
                        &current.task_id,
                        &current.operation_id,
                        WorktreeCleanupFailure {
                            kind,
                            blockers: vec![],
                        },
                        termloop_platform::current_epoch_ms(),
                    )
                    .map_err(store_error)?;
                Err(core_error)
            }
        }
    }

    #[cfg(test)]
    pub fn cleanup_task_worktree(&mut self, params: Value) -> Result<Value, CoreError> {
        let observed = match self.plan_task_worktree_cleanup(params)? {
            TaskWorktreeCleanupPlanning::Return(value) => return Ok(value),
            TaskWorktreeCleanupPlanning::Observe(plan) => plan.observe()?,
            TaskWorktreeCleanupPlanning::Finalize(finalization) => {
                return self.finalize_task_worktree_cleanup(*finalization);
            }
        };
        let mut progress = self.begin_task_worktree_cleanup(observed)?;
        loop {
            progress = match progress {
                TaskWorktreeCleanupProgress::Return(value) => return Ok(value),
                TaskWorktreeCleanupProgress::Revalidate(step)
                | TaskWorktreeCleanupProgress::Verify(step) => {
                    self.apply_task_worktree_cleanup_observation(step.observe()?)?
                }
                TaskWorktreeCleanupProgress::Remove(step) => {
                    self.apply_task_worktree_cleanup_removal(step.execute())?
                }
            };
        }
    }
}

fn cleanup_baseline(
    observed: &ObservedTaskWorktreeCleanup,
) -> Result<WorktreeCleanupBaseline, CoreError> {
    let head_oid = observed
        .facts
        .head_oid
        .clone()
        .ok_or_else(|| cleanup_refused(observed, vec![WorktreeCleanupBlocker::HeadMismatch]))?;
    Ok(WorktreeCleanupBaseline {
        repository_root: observed.proof.normalized_spec.repository_root.clone(),
        repository_common_dir: observed.proof.repository_common_dir.clone(),
        worktree_path: observed.proof.registered_worktree_path.clone(),
        registered_worktree_path: observed.proof.registered_worktree_path.clone(),
        branch_ref: observed.proof.branch_ref.clone(),
        head_oid,
    })
}

fn requested_cleanup_operation(
    observed: &ObservedTaskWorktreeCleanup,
    baseline: WorktreeCleanupBaseline,
    now: u64,
) -> WorktreeCleanupOperation {
    WorktreeCleanupOperation {
        operation_id: observed.operation_id.clone(),
        task_id: observed.task_id.clone(),
        worktree_generation: observed.expected_worktree_generation,
        managed_worktree_operation_id: observed.expected_managed_worktree_operation_id.clone(),
        cleanup_mode: observed.cleanup_mode,
        acknowledged_content_blockers: observed.acknowledged_content_blockers.clone(),
        baseline,
        stage: WorktreeCleanupStage::Reserved,
        failure: None,
        started_at_epoch_ms: now,
        updated_at_epoch_ms: now,
    }
}
