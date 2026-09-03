use std::path::{Path, PathBuf};

use serde_json::Value;
use termloop_domain::{
    ManagedWorktreeProof, WorktreeStaleResolutionBlocker, WorktreeStaleResolutionFailure,
    WorktreeStaleResolutionFailureKind, WorktreeStaleResolutionMode,
    WorktreeStaleResolutionOperation, WorktreeStaleResolutionStage,
};
use termloop_gitio::{GitRefName, GitRunner, WorktreeCheckout};
use termloop_store::BeginStaleResolutionOutcome;
use uuid::Uuid;

use super::super::git_mapping::{map_git_observation_error, worktree_registered_at};
use super::policy::{
    both_absent, cleanup_allows_stale_git_metadata, cleanup_allows_stale_resolution,
    orphaned_managed_directory, proof_changed, stale_observation_blockers,
    stale_observation_error_blocker, stale_resolution_refused,
};
use super::{
    CleanupPathState, CleanupRegistrationState, TaskWorktreeCleanupFacts, observe_cleanup_facts,
};
use crate::{CoreError, CoreRuntime, required_string, store_error};

pub struct TaskWorktreeStaleResolutionPlan {
    operation_id: String,
    task: termloop_domain::TaskRecord,
    proof: Option<ManagedWorktreeProof>,
    target_path: String,
    mode: WorktreeStaleResolutionMode,
    protected_descendants: Vec<PathBuf>,
    protected_overlaps: Vec<PathBuf>,
}

pub enum TaskWorktreeStaleResolutionPlanning {
    Return(Value),
    Observe(Box<TaskWorktreeStaleResolutionPlan>),
}

pub struct ObservedTaskWorktreeStaleResolution {
    operation_id: String,
    pub(super) task: termloop_domain::TaskRecord,
    pub(super) proof: Option<ManagedWorktreeProof>,
    target_path: String,
    mode: WorktreeStaleResolutionMode,
    facts: Result<TaskWorktreeCleanupFacts, CoreError>,
    target_kind: Option<StaleResolutionTargetKind>,
    runner: GitRunner,
    stale_target: Result<termloop_platform::StaleDisposalTargetFacts, CoreError>,
    protected_descendants: Vec<PathBuf>,
    protected_overlaps: Vec<PathBuf>,
}

pub struct TaskWorktreeStaleDisposalStep {
    operation: WorktreeStaleResolutionOperation,
    task: termloop_domain::TaskRecord,
    proof: Option<ManagedWorktreeProof>,
    target_kind: StaleResolutionTargetKind,
    runner: GitRunner,
    expected_target: termloop_platform::StaleDisposalTargetFacts,
    expected_git_metadata: bool,
    protected_descendants: Vec<PathBuf>,
    protected_overlaps: Vec<PathBuf>,
}

pub struct TaskWorktreeStaleForgetStep {
    operation: WorktreeStaleResolutionOperation,
    task: termloop_domain::TaskRecord,
    proof: Option<ManagedWorktreeProof>,
    runner: GitRunner,
}

pub struct ObservedTaskWorktreeStaleForget {
    operation: WorktreeStaleResolutionOperation,
    task: termloop_domain::TaskRecord,
    proof: Option<ManagedWorktreeProof>,
    facts: Result<TaskWorktreeCleanupFacts, CoreError>,
}

pub struct ExecutedTaskWorktreeStaleDisposal {
    operation: WorktreeStaleResolutionOperation,
    outcome: StaleDisposalExecutionOutcome,
}

enum StaleDisposalExecutionOutcome {
    Refused(Vec<WorktreeStaleResolutionBlocker>),
    Removed(Result<(), CoreError>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StaleResolutionTargetKind {
    OrphanedDirectory,
    RegisteredCheckout,
}

pub enum TaskWorktreeStaleResolutionProgress {
    Return(Value),
    Revalidate(Box<TaskWorktreeStaleForgetStep>),
    Remove(Box<TaskWorktreeStaleDisposalStep>),
}

impl TaskWorktreeStaleResolutionPlan {
    pub fn project_id(&self) -> &str {
        &self.task.project_id
    }

    pub fn observe(self) -> Result<ObservedTaskWorktreeStaleResolution, CoreError> {
        let runner =
            GitRunner::discover_with_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
                .map_err(map_git_observation_error)?;
        let (facts, target_kind) =
            match observe_stale_resolution_facts(&runner, &self.task, self.proof.as_ref()) {
                Ok(facts) => {
                    let target_kind = stale_resolution_target_kind(
                        &facts,
                        is_generation_zero_legacy_binding(&self.task, self.proof.as_ref()),
                    );
                    (Ok(facts), target_kind)
                }
                Err(error)
                    if self.mode == WorktreeStaleResolutionMode::ForgetBinding
                        && matches!(error, CoreError::RepositoryUnavailable) =>
                {
                    // The exact Task/proof/generation/path tuple remains the
                    // authority for this record-only path. Disposal still
                    // returns the observation failure above without mutation.
                    (Err(error), None)
                }
                Err(error) => return Err(error),
            };
        let stale_target = termloop_platform::inspect_stale_disposal_target(
            Path::new(&self.target_path),
            &self.protected_descendants,
            &self.protected_overlaps,
        )
        .map_err(map_stale_platform_error);
        Ok(ObservedTaskWorktreeStaleResolution {
            operation_id: self.operation_id,
            task: self.task,
            proof: self.proof,
            target_path: self.target_path,
            mode: self.mode,
            facts,
            target_kind,
            runner: runner.without_absolute_deadline(),
            stale_target,
            protected_descendants: self.protected_descendants,
            protected_overlaps: self.protected_overlaps,
        })
    }
}

impl TaskWorktreeStaleDisposalStep {
    pub fn execute(self) -> ExecutedTaskWorktreeStaleDisposal {
        let final_facts = self
            .runner
            .with_absolute_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
            .map_err(map_git_observation_error)
            .and_then(|runner| {
                observe_stale_resolution_facts(&runner, &self.task, self.proof.as_ref())
                    .map(|facts| (runner, facts))
            });
        let outcome = match final_facts {
            Ok((runner, facts))
                if stale_resolution_target_kind(
                    &facts,
                    is_generation_zero_legacy_binding(&self.task, self.proof.as_ref()),
                ) == Some(self.target_kind) =>
            {
                match termloop_platform::inspect_stale_disposal_target(
                    Path::new(&self.operation.target_path),
                    &self.protected_descendants,
                    &self.protected_overlaps,
                ) {
                    Ok(current) if current == self.expected_target => match self.target_kind {
                        StaleResolutionTargetKind::OrphanedDirectory => {
                            StaleDisposalExecutionOutcome::Removed(
                                termloop_platform::remove_stale_disposal_target_exact(
                                    Path::new(&self.operation.target_path),
                                    &self.expected_target.leaf_identity,
                                    self.expected_git_metadata,
                                )
                                .map_err(map_stale_platform_error),
                            )
                        }
                        StaleResolutionTargetKind::RegisteredCheckout => {
                            let repository_root = self
                                .task
                                .branch
                                .as_ref()
                                .map(|branch| Path::new(&branch.repository_root))
                                .expect("registered stale checkout has a branch binding");
                            let removal = runner
                                .with_absolute_timeout(
                                    termloop_gitio::CLEANUP_GIT_MUTATION_DEADLINE,
                                )
                                .map_err(map_git_observation_error)
                                .and_then(|runner| {
                                    runner
                                        .remove_worktree_exact_discarding_checkout_content(
                                            repository_root,
                                            Path::new(&self.operation.target_path),
                                        )
                                        .map_err(map_git_observation_error)
                                        .and_then(|()| {
                                            observe_stale_resolution_facts(
                                                &runner,
                                                &self.task,
                                                self.proof.as_ref(),
                                            )
                                        })
                                })
                                .and_then(|verified| {
                                    both_absent(&verified)
                                        .then_some(())
                                        .ok_or(CoreError::RepositoryUnavailable)
                                });
                            StaleDisposalExecutionOutcome::Removed(removal)
                        }
                    },
                    Ok(_) => StaleDisposalExecutionOutcome::Refused(vec![
                        WorktreeStaleResolutionBlocker::PathReplaced,
                    ]),
                    Err(error) => StaleDisposalExecutionOutcome::Refused(vec![
                        stale_observation_error_blocker(&map_stale_platform_error(error)),
                    ]),
                }
            }
            Ok((_, facts)) => StaleDisposalExecutionOutcome::Refused(stale_observation_blockers(
                &facts,
                self.proof.is_none() && self.operation.worktree_generation == 0,
                self.operation.mode,
            )),
            Err(error) => {
                StaleDisposalExecutionOutcome::Refused(vec![stale_observation_error_blocker(
                    &error,
                )])
            }
        };
        ExecutedTaskWorktreeStaleDisposal {
            operation: self.operation,
            outcome,
        }
    }
}

impl TaskWorktreeStaleForgetStep {
    pub fn observe(self) -> ObservedTaskWorktreeStaleForget {
        let facts = self
            .runner
            .with_absolute_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
            .map_err(map_git_observation_error)
            .and_then(|runner| {
                observe_stale_resolution_facts(&runner, &self.task, self.proof.as_ref())
            });
        ObservedTaskWorktreeStaleForget {
            operation: self.operation,
            task: self.task,
            proof: self.proof,
            facts,
        }
    }
}

impl CoreRuntime {
    pub fn plan_task_worktree_stale_forget(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeStaleResolutionPlanning, CoreError> {
        self.plan_task_worktree_stale_resolution(params, WorktreeStaleResolutionMode::ForgetBinding)
    }

    pub fn plan_task_worktree_stale_disposal(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeStaleResolutionPlanning, CoreError> {
        if params
            .get("acknowledgeUnverifiedDirectoryDeletion")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(CoreError::InvalidParams(
                "acknowledgeUnverifiedDirectoryDeletion".into(),
            ));
        }
        self.plan_task_worktree_stale_resolution(
            params,
            WorktreeStaleResolutionMode::DiscardDirectory,
        )
    }

    fn plan_task_worktree_stale_resolution(
        &self,
        params: Value,
        mode: WorktreeStaleResolutionMode,
    ) -> Result<TaskWorktreeStaleResolutionPlanning, CoreError> {
        let operation_id = required_string(&params, "operationId")?;
        Uuid::parse_str(&operation_id)
            .map_err(|_| CoreError::InvalidParams("operationId".into()))?;
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let expected_managed_worktree_operation_id =
            match params.get("expectedManagedWorktreeOperationId") {
                Some(Value::Null) => None,
                Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
                _ => {
                    return Err(CoreError::InvalidParams(
                        "expectedManagedWorktreeOperationId".into(),
                    ));
                }
            };
        let expected_worktree_generation = params
            .get("expectedWorktreeGeneration")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedWorktreeGeneration".into()))?;
        let target_path = required_string(&params, "targetPath")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if let Some(receipt) = self
            .store
            .stale_resolution_receipts()
            .iter()
            .find(|receipt| receipt.operation_id == operation_id)
        {
            if receipt.task_id == task_id
                && receipt.managed_worktree_operation_id == expected_managed_worktree_operation_id
                && receipt.worktree_generation == expected_worktree_generation
                && receipt.target_path == target_path
                && receipt.mode == mode
                && task.worktree.is_none()
            {
                return self
                    .task_current_projection(&task_id)
                    .map(TaskWorktreeStaleResolutionPlanning::Return);
            }
            return Err(CoreError::OperationIdReused { operation_id });
        }
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .cloned();
        if task.worktree_generation != expected_worktree_generation
            || task
                .worktree
                .as_ref()
                .is_none_or(|binding| binding.path != target_path)
            || match (&expected_managed_worktree_operation_id, &proof) {
                (Some(expected), Some(proof)) => {
                    proof.worktree_generation != expected_worktree_generation
                        || proof.operation_id != *expected
                        || proof.registered_worktree_path != target_path
                }
                (None, None) => expected_worktree_generation != 0 || task.branch.is_none(),
                _ => true,
            }
        {
            return Err(proof_changed(self, &task_id));
        }
        if let Some(current) = self
            .store
            .stale_resolution_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
            .filter(|current| {
                current.operation_id != operation_id
                    || current.managed_worktree_operation_id
                        != expected_managed_worktree_operation_id
                    || current.worktree_generation != expected_worktree_generation
                    || current.target_path != target_path
                    || current.mode != mode
            })
        {
            return Err(CoreError::StaleDisposalInProgress {
                task_id,
                operation_id: current.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::ProvisioningAlreadyInProgress {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::RepairInProgress {
                task_id,
                operation_id: operation.operation_id.clone(),
            });
        }
        let (protected_descendants, protected_overlaps) =
            self.stale_disposal_protected_paths(&task.id)?;
        Ok(TaskWorktreeStaleResolutionPlanning::Observe(Box::new(
            TaskWorktreeStaleResolutionPlan {
                operation_id,
                task,
                proof,
                target_path,
                mode,
                protected_descendants,
                protected_overlaps,
            },
        )))
    }

    pub fn begin_task_worktree_stale_resolution(
        &mut self,
        observed: ObservedTaskWorktreeStaleResolution,
    ) -> Result<TaskWorktreeStaleResolutionProgress, CoreError> {
        if let Some(proof) = &observed.proof {
            self.ensure_current_cleanup_proof(&observed.task.id, proof)?;
        } else {
            self.ensure_current_unverified_binding(&observed.task)?;
        }
        if observed.mode == WorktreeStaleResolutionMode::DiscardDirectory
            && observed.facts.as_ref().is_ok_and(both_absent)
            && self
                .store
                .stale_resolution_operations()
                .iter()
                .any(|operation| {
                    operation.task_id == observed.task.id
                        && operation.operation_id == observed.operation_id
                        && operation.mode == WorktreeStaleResolutionMode::DiscardDirectory
                        && matches!(
                            operation.stage,
                            WorktreeStaleResolutionStage::RemovalPrepared
                                | WorktreeStaleResolutionStage::RemovalInvoked
                        )
                        && operation.failure.as_ref().is_some_and(|failure| {
                            failure.kind == WorktreeStaleResolutionFailureKind::RecoveryAttention
                        })
                })
        {
            let now = termloop_platform::current_epoch_ms();
            self.store
                .verify_absent_task_worktree_stale_resolution(
                    &self.write_authority,
                    &observed.task.id,
                    &observed.operation_id,
                    now,
                )
                .map_err(store_error)?;
            let completed = self
                .store
                .complete_task_worktree_stale_resolution(
                    &self.write_authority,
                    &observed.task.id,
                    &observed.operation_id,
                    now,
                )
                .map_err(store_error)?;
            self.clear_task_worktree_projections(&observed.task.id);
            return self
                .task_projection(&completed.task)
                .map(TaskWorktreeStaleResolutionProgress::Return);
        }
        let mut blockers = match &observed.facts {
            Ok(facts) => stale_observation_blockers(
                facts,
                is_generation_zero_legacy_binding(&observed.task, observed.proof.as_ref()),
                observed.mode,
            ),
            Err(_) if observed.mode == WorktreeStaleResolutionMode::ForgetBinding => Vec::new(),
            Err(error) => vec![stale_observation_error_blocker(error)],
        };
        if !blockers.is_empty() {
            return Err(stale_resolution_refused(&observed, blockers));
        }
        let supersedes_cleanup_operation_id = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| operation.task_id == observed.task.id)
            .map(|operation| {
                let eligible = cleanup_allows_stale_resolution(operation)
                    && observed.proof.as_ref().is_some_and(|proof| {
                        operation.worktree_generation == observed.task.worktree_generation
                            && operation.managed_worktree_operation_id == proof.operation_id
                            && operation.baseline.worktree_path == observed.target_path
                            && operation.baseline.registered_worktree_path
                                == proof.registered_worktree_path
                            && operation.baseline.repository_root
                                == proof.normalized_spec.repository_root
                            && operation.baseline.repository_common_dir
                                == proof.repository_common_dir
                            && operation.baseline.branch_ref == proof.branch_ref
                    });
                if eligible {
                    Ok(operation.operation_id.clone())
                } else {
                    Err(CoreError::WorktreeStaleResolutionRefused {
                        task_id: observed.task.id.clone(),
                        expected_managed_worktree_operation_id: observed
                            .proof
                            .as_ref()
                            .map(|proof| proof.operation_id.clone()),
                        expected_worktree_generation: observed.task.worktree_generation,
                        blockers: vec![WorktreeStaleResolutionBlocker::RecoveryAttention],
                    })
                }
            })
            .transpose()?;
        let retry_allows_git_metadata =
            self.store
                .stale_resolution_operations()
                .iter()
                .any(|operation| {
                    operation.task_id == observed.task.id
                        && operation.operation_id == observed.operation_id
                        && operation.mode == WorktreeStaleResolutionMode::DiscardDirectory
                        && matches!(
                            operation.stage,
                            WorktreeStaleResolutionStage::RemovalPrepared
                                | WorktreeStaleResolutionStage::RemovalInvoked
                        )
                        && operation.failure.as_ref().is_some_and(|failure| {
                            failure.kind == WorktreeStaleResolutionFailureKind::RecoveryAttention
                        })
                });
        let cleanup_allows_git_metadata = retry_allows_git_metadata
            || self
                .store
                .cleanup_operations()
                .iter()
                .find(|operation| operation.task_id == observed.task.id)
                .is_some_and(cleanup_allows_stale_git_metadata);
        let stale_target = if observed.mode == WorktreeStaleResolutionMode::DiscardDirectory {
            match &observed.stale_target {
                Ok(facts) => {
                    if facts.has_git_metadata
                        && observed.target_kind
                            == Some(StaleResolutionTargetKind::OrphanedDirectory)
                        && !cleanup_allows_git_metadata
                    {
                        blockers.push(WorktreeStaleResolutionBlocker::GitMetadataPresent);
                    }
                    if facts.target_is_mount
                        || facts.parent_is_filesystem_root
                        || facts.protected_path_conflict
                    {
                        blockers.push(WorktreeStaleResolutionBlocker::ProtectedPath);
                    }
                    Some(facts.clone())
                }
                Err(error) => {
                    blockers.push(stale_observation_error_blocker(error));
                    None
                }
            }
        } else {
            None
        };
        if observed.mode == WorktreeStaleResolutionMode::DiscardDirectory {
            let presence = self.refresh_cleanup_presence(&observed.task.id, false)?;
            if presence.total_count > 0 {
                blockers.push(WorktreeStaleResolutionBlocker::SessionAttached);
            }
        }
        blockers.sort();
        blockers.dedup();
        if !blockers.is_empty() {
            return Err(stale_resolution_refused(&observed, blockers));
        }
        let now = termloop_platform::current_epoch_ms();
        let requested = WorktreeStaleResolutionOperation {
            operation_id: observed.operation_id.clone(),
            task_id: observed.task.id.clone(),
            managed_worktree_operation_id: observed
                .proof
                .as_ref()
                .map(|proof| proof.operation_id.clone()),
            worktree_generation: observed.task.worktree_generation,
            target_path: observed.target_path.clone(),
            mode: observed.mode,
            stage: WorktreeStaleResolutionStage::Reserved,
            failure: None,
            started_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        let mut operation = match self
            .store
            .begin_task_worktree_stale_resolution(
                &self.write_authority,
                requested,
                supersedes_cleanup_operation_id.as_deref(),
            )
            .map_err(|error| self.map_stale_store_error(error, &observed.task.id))?
        {
            BeginStaleResolutionOutcome::Completed(_) => {
                return self
                    .task_current_projection(&observed.task.id)
                    .map(TaskWorktreeStaleResolutionProgress::Return);
            }
            BeginStaleResolutionOutcome::Started(operation) => operation,
            BeginStaleResolutionOutcome::Current(current) => {
                if current.failure.is_some() {
                    self.store
                        .retry_task_worktree_stale_resolution(
                            &self.write_authority,
                            &current.task_id,
                            &current.operation_id,
                            now,
                        )
                        .map_err(store_error)?
                } else {
                    current
                }
            }
        };
        if operation.mode == WorktreeStaleResolutionMode::ForgetBinding {
            return Ok(TaskWorktreeStaleResolutionProgress::Revalidate(Box::new(
                TaskWorktreeStaleForgetStep {
                    operation,
                    task: observed.task,
                    proof: observed.proof,
                    runner: observed.runner,
                },
            )));
        }
        if operation.stage == WorktreeStaleResolutionStage::Reserved {
            operation = self
                .store
                .advance_task_worktree_stale_resolution(
                    &self.write_authority,
                    &operation.task_id,
                    &operation.operation_id,
                    WorktreeStaleResolutionStage::RemovalPrepared,
                    now,
                )
                .map_err(store_error)?;
        }
        Ok(TaskWorktreeStaleResolutionProgress::Remove(Box::new(
            TaskWorktreeStaleDisposalStep {
                operation,
                task: observed.task,
                proof: observed.proof,
                target_kind: observed
                    .target_kind
                    .expect("stale observation blockers reject an ineligible target"),
                runner: observed.runner,
                expected_git_metadata: cleanup_allows_git_metadata
                    && stale_target
                        .as_ref()
                        .is_some_and(|target| target.has_git_metadata),
                expected_target: stale_target.expect("disposal target checked above"),
                protected_descendants: observed.protected_descendants,
                protected_overlaps: observed.protected_overlaps,
            },
        )))
    }

    pub fn apply_task_worktree_stale_forget(
        &mut self,
        observed: ObservedTaskWorktreeStaleForget,
    ) -> Result<Value, CoreError> {
        if let Some(proof) = &observed.proof {
            self.ensure_current_cleanup_proof(&observed.operation.task_id, proof)?;
        } else {
            self.ensure_current_unverified_binding(&observed.task)?;
        }
        let blockers = match observed.facts {
            Ok(facts) => stale_observation_blockers(
                &facts,
                observed.proof.is_none() && observed.operation.worktree_generation == 0,
                WorktreeStaleResolutionMode::ForgetBinding,
            ),
            Err(_) => Vec::new(),
        };
        if !blockers.is_empty() {
            self.store
                .clear_task_worktree_stale_resolution_before_mutation(
                    &self.write_authority,
                    &observed.operation.task_id,
                    &observed.operation.operation_id,
                )
                .map_err(store_error)?;
            return Err(CoreError::WorktreeStaleResolutionRefused {
                task_id: observed.operation.task_id,
                expected_managed_worktree_operation_id: observed
                    .operation
                    .managed_worktree_operation_id,
                expected_worktree_generation: observed.operation.worktree_generation,
                blockers,
            });
        }
        let completed = self
            .store
            .complete_task_worktree_stale_resolution(
                &self.write_authority,
                &observed.operation.task_id,
                &observed.operation.operation_id,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&observed.operation.task_id);
        self.task_projection(&completed.task)
    }

    pub fn apply_task_worktree_stale_disposal(
        &mut self,
        executed: ExecutedTaskWorktreeStaleDisposal,
    ) -> Result<Value, CoreError> {
        match executed.outcome {
            StaleDisposalExecutionOutcome::Refused(blockers) => {
                self.store
                    .clear_task_worktree_stale_resolution_before_mutation(
                        &self.write_authority,
                        &executed.operation.task_id,
                        &executed.operation.operation_id,
                    )
                    .map_err(store_error)?;
                Err(CoreError::WorktreeStaleResolutionRefused {
                    task_id: executed.operation.task_id,
                    expected_managed_worktree_operation_id: executed
                        .operation
                        .managed_worktree_operation_id,
                    expected_worktree_generation: executed.operation.worktree_generation,
                    blockers,
                })
            }
            StaleDisposalExecutionOutcome::Removed(Err(_)) => {
                self.store
                    .fail_task_worktree_stale_resolution(
                        &self.write_authority,
                        &executed.operation.task_id,
                        &executed.operation.operation_id,
                        WorktreeStaleResolutionFailure {
                            kind: WorktreeStaleResolutionFailureKind::RecoveryAttention,
                            blockers: vec![WorktreeStaleResolutionBlocker::RecoveryAttention],
                        },
                        termloop_platform::current_epoch_ms(),
                    )
                    .map_err(store_error)?;
                Err(CoreError::WorktreeStaleDisposalRecoveryAttention {
                    task_id: executed.operation.task_id,
                    operation_id: executed.operation.operation_id,
                })
            }
            StaleDisposalExecutionOutcome::Removed(Ok(())) => {
                let now = termloop_platform::current_epoch_ms();
                self.store
                    .advance_task_worktree_stale_resolution(
                        &self.write_authority,
                        &executed.operation.task_id,
                        &executed.operation.operation_id,
                        WorktreeStaleResolutionStage::RemovalInvoked,
                        now,
                    )
                    .and_then(|_| {
                        self.store.advance_task_worktree_stale_resolution(
                            &self.write_authority,
                            &executed.operation.task_id,
                            &executed.operation.operation_id,
                            WorktreeStaleResolutionStage::RemovalVerified,
                            now,
                        )
                    })
                    .map_err(store_error)?;
                let completed = self
                    .store
                    .complete_task_worktree_stale_resolution(
                        &self.write_authority,
                        &executed.operation.task_id,
                        &executed.operation.operation_id,
                        now,
                    )
                    .map_err(store_error)?;
                self.clear_task_worktree_projections(&executed.operation.task_id);
                self.task_projection(&completed.task)
            }
        }
    }

    pub(super) fn stale_disposal_protected_paths(
        &self,
        task_id: &str,
    ) -> Result<(Vec<PathBuf>, Vec<PathBuf>), CoreError> {
        let mut descendants = self
            .store
            .projects()
            .iter()
            .map(|project| PathBuf::from(&project.folder_path))
            .chain(self.store.tasks().iter().filter_map(|task| {
                task.branch
                    .as_ref()
                    .map(|branch| PathBuf::from(&branch.repository_root))
            }))
            .collect::<Vec<_>>();
        descendants.push(termloop_platform::state_directory().map_err(map_stale_platform_error)?);
        descendants.push(termloop_platform::runtime_directory().map_err(map_stale_platform_error)?);
        descendants.sort();
        descendants.dedup();
        let mut overlaps = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.id != task_id)
            .filter_map(|task| {
                task.worktree
                    .as_ref()
                    .map(|worktree| PathBuf::from(&worktree.path))
            })
            .collect::<Vec<_>>();
        overlaps.sort();
        overlaps.dedup();
        Ok((descendants, overlaps))
    }

    fn map_stale_store_error(&self, error: termloop_store::StoreError, task_id: &str) -> CoreError {
        match error {
            termloop_store::StoreError::JournalConflict { operation_id } => {
                CoreError::StaleDisposalInProgress {
                    task_id: task_id.to_owned(),
                    operation_id,
                }
            }
            other => store_error(other),
        }
    }

    pub(crate) fn reconcile_task_worktree_stale_resolution_operations(&mut self) {
        for operation in self.store.stale_resolution_operations().to_vec() {
            match operation.stage {
                WorktreeStaleResolutionStage::Reserved => {
                    let _ = self
                        .store
                        .clear_task_worktree_stale_resolution_before_mutation(
                            &self.write_authority,
                            &operation.task_id,
                            &operation.operation_id,
                        );
                }
                WorktreeStaleResolutionStage::RemovalVerified => {
                    let _ = self.store.complete_task_worktree_stale_resolution(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        termloop_platform::current_epoch_ms(),
                    );
                }
                WorktreeStaleResolutionStage::RemovalPrepared
                | WorktreeStaleResolutionStage::RemovalInvoked => {
                    let _ = self.store.fail_task_worktree_stale_resolution(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        WorktreeStaleResolutionFailure {
                            kind: WorktreeStaleResolutionFailureKind::RecoveryAttention,
                            blockers: vec![WorktreeStaleResolutionBlocker::RecoveryAttention],
                        },
                        termloop_platform::current_epoch_ms(),
                    );
                }
            }
        }
    }
}

pub(super) fn observe_stale_resolution_facts(
    runner: &GitRunner,
    task: &termloop_domain::TaskRecord,
    proof: Option<&ManagedWorktreeProof>,
) -> Result<TaskWorktreeCleanupFacts, CoreError> {
    if let Some(proof) = proof {
        return observe_cleanup_facts(runner, proof, None);
    }
    let branch = task
        .branch
        .as_ref()
        .ok_or(CoreError::RepositoryUnavailable)?;
    let destination = task
        .worktree
        .as_ref()
        .map(|binding| Path::new(&binding.path))
        .ok_or(CoreError::RepositoryUnavailable)?;
    let repository_root = Path::new(&branch.repository_root);
    runner
        .inspect_repository(repository_root)
        .map_err(map_git_observation_error)?;
    let path_state = match termloop_platform::canonical_directory_if_exists(destination)
        .map_err(|_| CoreError::RepositoryUnavailable)?
    {
        None => CleanupPathState::Absent,
        Some(path) if path == destination => CleanupPathState::Present,
        Some(_) => CleanupPathState::Replaced,
    };
    let worktrees = runner
        .list_worktrees(repository_root)
        .map_err(map_git_observation_error)?;
    let registration = worktrees
        .into_iter()
        .find(|worktree| worktree_registered_at(worktree, destination));
    let registration_state = if registration.is_some() {
        CleanupRegistrationState::Matching
    } else {
        CleanupRegistrationState::Absent
    };
    let branch_ref = format!("refs/heads/{}", branch.name);
    let reference = GitRefName::from_bytes(branch_ref.as_bytes().to_vec())
        .map_err(map_git_observation_error)?;
    let branch_oid = runner
        .resolve_ref(repository_root, &reference)
        .map_err(map_git_observation_error)?;
    let head_oid = branch_oid
        .as_ref()
        .map(|oid| String::from_utf8_lossy(oid.as_bytes()).into_owned());
    let branch_matches = registration.as_ref().map(|registration| {
        matches!(
            &registration.checkout,
            WorktreeCheckout::Branch { reference, .. }
                if reference.as_bytes() == branch_ref.as_bytes()
        )
    });
    let head_matches = registration
        .as_ref()
        .map(|registration| match &registration.checkout {
            WorktreeCheckout::Branch { oid, .. } => oid.as_ref() == branch_oid.as_ref(),
            WorktreeCheckout::Bare | WorktreeCheckout::Detached { .. } => false,
        });
    Ok(TaskWorktreeCleanupFacts {
        path_state,
        registration_state,
        branch_matches,
        head_matches,
        alternate_checkout_matches: false,
        head_oid,
        health: None,
    })
}

pub(super) fn stale_resolution_target_kind(
    facts: &TaskWorktreeCleanupFacts,
    unverified_binding: bool,
) -> Option<StaleResolutionTargetKind> {
    if orphaned_managed_directory(facts) {
        return Some(StaleResolutionTargetKind::OrphanedDirectory);
    }
    (unverified_binding
        && facts.path_state == CleanupPathState::Present
        && facts.registration_state == CleanupRegistrationState::Matching
        && facts.branch_matches == Some(true)
        && facts.head_matches == Some(true)
        && facts.head_oid.is_some()
        && facts.health.is_none())
    .then_some(StaleResolutionTargetKind::RegisteredCheckout)
}

pub(super) fn is_generation_zero_legacy_binding(
    task: &termloop_domain::TaskRecord,
    proof: Option<&ManagedWorktreeProof>,
) -> bool {
    proof.is_none()
        && task.worktree_generation == 0
        && task.worktree.is_some()
        && task.branch.is_some()
}

pub(super) fn map_stale_platform_error(error: termloop_platform::PlatformError) -> CoreError {
    match error {
        termloop_platform::PlatformError::Io(error)
            if error.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            CoreError::RepositoryPermissionDenied
        }
        termloop_platform::PlatformError::Io(error)
            if error.kind() == std::io::ErrorKind::TimedOut =>
        {
            CoreError::GitObservationTimedOut
        }
        _ => CoreError::RepositoryUnavailable,
    }
}
