use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use termloop_domain::{
    ManagedWorktreeProof, WorktreeRepairBlocker, WorktreeRepairFailure, WorktreeRepairFailureKind,
    WorktreeRepairOperation, WorktreeRepairStage,
};
use termloop_gitio::{
    GitError, GitRunner, HeadState, RegisteredPathState, WorktreeCheckout,
    WorktreeHealthObservation, WorktreeRepairFacts,
};
use termloop_store::BeginRepairOutcome;

use crate::{CoreError, CoreRuntime, required_string, store_error};

#[derive(Debug, Clone)]
pub struct TaskWorktreeRepairPlan {
    task_id: String,
    project_id: String,
    proof: ManagedWorktreeProof,
    old_path: String,
    candidate_path: String,
    operation_id: Option<String>,
    expected_operation_id: Option<String>,
    expected_generation: Option<u64>,
    other_task_paths: Vec<String>,
    live_sessions: Vec<(String, String)>,
    attached_session_ids: Vec<String>,
    candidate_conflict: bool,
}

pub struct ObservedTaskWorktreeRepair {
    plan: TaskWorktreeRepairPlan,
    facts: Result<WorktreeRepairFacts, WorktreeRepairBlocker>,
}

pub enum TaskWorktreeRepairProgress {
    Return(Value),
    Execute(Box<TaskWorktreeRepairExecution>),
    Verify(Box<TaskWorktreeRepairVerification>),
}

pub struct TaskWorktreeRepairExecution {
    operation: WorktreeRepairOperation,
    common_dir: String,
    candidate_path: String,
}

pub struct ExecutedTaskWorktreeRepair {
    operation: WorktreeRepairOperation,
    result: Result<(), GitError>,
}

pub struct TaskWorktreeRepairVerification {
    operation: WorktreeRepairOperation,
    proof: ManagedWorktreeProof,
}

pub struct VerifiedTaskWorktreeRepair {
    operation: WorktreeRepairOperation,
    observation: Option<WorktreeHealthObservation>,
}

impl TaskWorktreeRepairPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe(mut self) -> ObservedTaskWorktreeRepair {
        if let Ok(candidate) = termloop_platform::canonical_existing_directory(&self.candidate_path)
            && let Some(candidate) = candidate.to_str()
        {
            self.candidate_path = candidate.to_owned();
        }
        let candidate_key = super::health::comparison_key(Path::new(&self.candidate_path)).ok();
        self.candidate_conflict = self.other_task_paths.iter().any(|path| {
            candidate_key.as_ref().is_some_and(|candidate| {
                super::health::comparison_key(Path::new(path))
                    .ok()
                    .is_some_and(|other| {
                        candidate.contains_or_equals(&other) || other.contains_or_equals(candidate)
                    })
            })
        });
        self.attached_session_ids = self
            .live_sessions
            .iter()
            .filter(|(_, cwd)| {
                candidate_key.as_ref().is_some_and(|candidate| {
                    super::health::comparison_key(Path::new(cwd))
                        .ok()
                        .is_some_and(|session| candidate.contains_or_equals(&session))
                }) || Path::new(cwd).starts_with(&self.old_path)
            })
            .take(64)
            .map(|(id, _)| id.clone())
            .collect();
        let facts = observe_repair_facts(&self);
        ObservedTaskWorktreeRepair { plan: self, facts }
    }
}

impl TaskWorktreeRepairExecution {
    pub fn execute(self) -> ExecutedTaskWorktreeRepair {
        let result =
            GitRunner::discover_with_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
                .and_then(|runner| {
                    runner.repair_worktree_link(
                        Path::new(&self.common_dir),
                        Path::new(&self.candidate_path),
                    )
                });
        ExecutedTaskWorktreeRepair {
            operation: self.operation,
            result,
        }
    }
}

impl TaskWorktreeRepairVerification {
    pub fn observe(self) -> VerifiedTaskWorktreeRepair {
        let observation = GitRunner::discover_with_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
            .and_then(|runner| runner.inspect_worktree_health(Path::new(&self.operation.candidate_path)))
            .ok()
            .filter(|observation| {
                observation.repository.common_dir == PathBuf::from(&self.proof.repository_common_dir)
                    && observation.repository.worktree_root.as_deref() == Some(Path::new(&self.operation.candidate_path))
                    && matches!(observation.repository.head, HeadState::Attached { ref branch, .. } if branch.as_bytes() == self.proof.branch_ref.as_bytes())
                    && observation.registration.as_ref().is_some_and(|registration| {
                        matches!(&registration.path_state, RegisteredPathState::Present { canonical_path } if canonical_path == Path::new(&self.operation.candidate_path))
                            && matches!(&registration.checkout, WorktreeCheckout::Branch { reference, .. } if reference.as_bytes() == self.proof.branch_ref.as_bytes())
                    })
            });
        VerifiedTaskWorktreeRepair {
            operation: self.operation,
            observation,
        }
    }
}

impl CoreRuntime {
    pub fn plan_task_worktree_repair_inspection(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeRepairPlan, CoreError> {
        self.repair_plan(params, false)
    }

    pub fn plan_task_worktree_repair(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeRepairPlan, CoreError> {
        self.repair_plan(params, true)
    }

    pub fn plan_task_worktree_repair_dismissal(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeRepairPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let operation_id = required_string(&params, "operationId")?;
        let operation = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(CoreError::NotFound)?;
        if operation.stage != WorktreeRepairStage::Reserved || operation.failure.is_none() {
            return Err(CoreError::WorktreeRepairRecoveryAttention {
                task_id,
                operation_id,
            });
        }
        self.repair_plan(
            json!({
                "taskId": operation.task_id,
                "candidatePath": operation.candidate_path,
                "operationId": operation.operation_id,
                "expectedManagedWorktreeOperationId": operation.managed_worktree_operation_id,
                "expectedWorktreeGeneration": operation.expected_worktree_generation,
            }),
            true,
        )
    }

    fn repair_plan(
        &self,
        params: Value,
        mutation: bool,
    ) -> Result<TaskWorktreeRepairPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let candidate_path = required_string(&params, "candidatePath")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let old_path = task
            .worktree
            .as_ref()
            .ok_or_else(|| CoreError::TaskWorktreeRequired {
                task_id: task_id.clone(),
            })?
            .path
            .clone();
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .cloned()
            .ok_or_else(|| CoreError::TaskWorktreeUnavailable {
                task_id: task_id.clone(),
                reason: crate::TaskWorktreeUnavailableReason::ManagedProofMissing,
            })?;
        let other_task_paths = self
            .store
            .tasks()
            .iter()
            .filter(|candidate| candidate.id != task_id)
            .filter_map(|candidate| {
                candidate
                    .worktree
                    .as_ref()
                    .map(|binding| binding.path.clone())
            })
            .collect();
        let mut live_sessions = self
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.lifecycle_state == "running"
                    || self.resume_reservations.contains(&session.id)
                    || self
                        .provider_history_repair_reservations
                        .contains(&session.id)
            })
            .map(|session| (session.id.clone(), session.process.cwd.clone()))
            .collect::<Vec<_>>();
        live_sessions.extend(
            self.store
                .session_relocation_operations()
                .iter()
                .filter(|operation| operation.target_task_id == task_id)
                .map(|operation| (operation.session_id.clone(), operation.target_cwd.clone())),
        );
        let (operation_id, expected_operation_id, expected_generation) = if mutation {
            let operation_id = required_string(&params, "operationId")?;
            uuid::Uuid::parse_str(&operation_id)
                .map_err(|_| CoreError::InvalidParams("operationId".into()))?;
            (
                Some(operation_id),
                Some(required_string(
                    &params,
                    "expectedManagedWorktreeOperationId",
                )?),
                Some(
                    params
                        .get("expectedWorktreeGeneration")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| {
                            CoreError::InvalidParams("expectedWorktreeGeneration".into())
                        })?,
                ),
            )
        } else {
            (None, None, None)
        };
        if let Some(provisioning) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::ProvisioningAlreadyInProgress {
                operation_id: provisioning.operation_id.clone(),
            });
        }
        if let Some(cleanup) = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::CleanupInProgress {
                task_id,
                operation_id: cleanup.operation_id.clone(),
            });
        }
        if let Some(repair) = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
            && operation_id.as_deref() != Some(repair.operation_id.as_str())
        {
            return Err(CoreError::RepairInProgress {
                task_id,
                operation_id: repair.operation_id.clone(),
            });
        }
        Ok(TaskWorktreeRepairPlan {
            task_id,
            project_id: task.project_id.clone(),
            proof,
            old_path,
            candidate_path,
            operation_id,
            expected_operation_id,
            expected_generation,
            other_task_paths,
            live_sessions,
            attached_session_ids: Vec::new(),
            candidate_conflict: false,
        })
    }

    pub fn apply_task_worktree_repair_inspection(
        &self,
        observed: ObservedTaskWorktreeRepair,
    ) -> Result<Value, CoreError> {
        self.ensure_repair_plan_current(&observed.plan)?;
        Ok(repair_preview_json(&observed))
    }

    pub fn begin_task_worktree_repair(
        &mut self,
        observed: ObservedTaskWorktreeRepair,
    ) -> Result<TaskWorktreeRepairProgress, CoreError> {
        self.ensure_repair_plan_current(&observed.plan)?;
        if self.store.tasks().iter().any(|task| {
            task.id != observed.plan.task_id
                && task.worktree.as_ref().is_some_and(|binding| {
                    Path::new(&binding.path).starts_with(&observed.plan.candidate_path)
                        || Path::new(&observed.plan.candidate_path).starts_with(&binding.path)
                })
        }) {
            return Err(CoreError::WorktreeRepairRefused {
                task_id: observed.plan.task_id.clone(),
                expected_managed_worktree_operation_id: observed.plan.proof.operation_id.clone(),
                expected_worktree_generation: observed.plan.proof.worktree_generation,
                blockers: vec![WorktreeRepairBlocker::CandidatePathConflict],
            });
        }
        if self.store.sessions().iter().any(|session| {
            (session.lifecycle_state == "running"
                || self.resume_reservations.contains(&session.id)
                || self
                    .provider_history_repair_reservations
                    .contains(&session.id))
                && (Path::new(&session.process.cwd).starts_with(&observed.plan.old_path)
                    || Path::new(&session.process.cwd).starts_with(&observed.plan.candidate_path))
        }) {
            return Err(CoreError::WorktreeRepairRefused {
                task_id: observed.plan.task_id.clone(),
                expected_managed_worktree_operation_id: observed.plan.proof.operation_id.clone(),
                expected_worktree_generation: observed.plan.proof.worktree_generation,
                blockers: vec![WorktreeRepairBlocker::SessionAttached],
            });
        }
        if self
            .store
            .session_relocation_operations()
            .iter()
            .any(|operation| operation.target_task_id == observed.plan.task_id)
        {
            return Err(CoreError::WorktreeRepairRefused {
                task_id: observed.plan.task_id.clone(),
                expected_managed_worktree_operation_id: observed.plan.proof.operation_id.clone(),
                expected_worktree_generation: observed.plan.proof.worktree_generation,
                blockers: vec![WorktreeRepairBlocker::SessionAttached],
            });
        }
        if let Some(provisioning) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| operation.task_id == observed.plan.task_id)
        {
            return Err(CoreError::ProvisioningAlreadyInProgress {
                operation_id: provisioning.operation_id.clone(),
            });
        }
        if let Some(cleanup) = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| operation.task_id == observed.plan.task_id)
        {
            return Err(CoreError::CleanupInProgress {
                task_id: observed.plan.task_id.clone(),
                operation_id: cleanup.operation_id.clone(),
            });
        }
        if let Some(repair) = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| operation.task_id == observed.plan.task_id)
            && observed.plan.operation_id.as_deref() != Some(repair.operation_id.as_str())
        {
            return Err(CoreError::RepairInProgress {
                task_id: observed.plan.task_id.clone(),
                operation_id: repair.operation_id.clone(),
            });
        }
        if let Some(receipt) = self.store.repair_receipts().iter().find(|receipt| {
            observed.plan.operation_id.as_deref() == Some(receipt.operation_id.as_str())
        }) {
            if receipt.task_id == observed.plan.task_id
                && observed.plan.expected_operation_id.as_deref()
                    == Some(receipt.managed_worktree_operation_id.as_str())
                && observed.plan.expected_generation == Some(receipt.previous_worktree_generation)
                && observed.plan.candidate_path == receipt.candidate_path
            {
                return Ok(TaskWorktreeRepairProgress::Return(self.repair_result(
                    &receipt.task_id,
                    receipt.previous_worktree_generation,
                    receipt.worktree_generation,
                    "alreadyCompleted",
                )?));
            }
            return Err(CoreError::OperationIdReused {
                operation_id: receipt.operation_id.clone(),
            });
        }
        let blockers = repair_blockers(&observed);
        if let Some(current) = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| {
                operation.task_id == observed.plan.task_id
                    && observed.plan.operation_id.as_deref()
                        == Some(operation.operation_id.as_str())
            })
            .cloned()
        {
            let candidate_matches =
                termloop_platform::canonical_existing_directory(&observed.plan.candidate_path)
                    .ok()
                    .and_then(|path| path.into_os_string().into_string().ok())
                    .is_some_and(|path| path == current.candidate_path);
            if observed.plan.expected_operation_id.as_deref()
                != Some(current.managed_worktree_operation_id.as_str())
                || observed.plan.expected_generation != Some(current.expected_worktree_generation)
                || !candidate_matches
            {
                return Err(CoreError::OperationIdReused {
                    operation_id: current.operation_id,
                });
            }
            if matches!(
                current.stage,
                WorktreeRepairStage::Reserved | WorktreeRepairStage::RepairPrepared
            ) && blockers.is_empty()
            {
                let resumed = self
                    .store
                    .resume_task_worktree_repair_before_mutation(
                        &self.write_authority,
                        &current.task_id,
                        &current.operation_id,
                        termloop_platform::current_epoch_ms(),
                    )
                    .map_err(store_error)?;
                let prepared = if resumed.stage == WorktreeRepairStage::Reserved {
                    self.store
                        .advance_task_worktree_repair(
                            &self.write_authority,
                            &resumed.task_id,
                            &resumed.operation_id,
                            WorktreeRepairStage::RepairPrepared,
                            termloop_platform::current_epoch_ms(),
                        )
                        .map_err(store_error)?
                } else {
                    resumed
                };
                return Ok(TaskWorktreeRepairProgress::Execute(Box::new(
                    TaskWorktreeRepairExecution {
                        operation: prepared,
                        common_dir: observed.plan.proof.repository_common_dir,
                        candidate_path: current.candidate_path,
                    },
                )));
            }
            if current.stage != WorktreeRepairStage::Reserved {
                return Ok(TaskWorktreeRepairProgress::Verify(Box::new(
                    TaskWorktreeRepairVerification {
                        operation: current,
                        proof: observed.plan.proof,
                    },
                )));
            }
            return Err(CoreError::WorktreeRepairRecoveryAttention {
                task_id: current.task_id,
                operation_id: current.operation_id,
            });
        }
        let operation_id = observed
            .plan
            .operation_id
            .clone()
            .ok_or_else(|| CoreError::InvalidParams("operationId".into()))?;
        let expected_operation_id =
            observed.plan.expected_operation_id.clone().ok_or_else(|| {
                CoreError::InvalidParams("expectedManagedWorktreeOperationId".into())
            })?;
        let expected_generation = observed
            .plan
            .expected_generation
            .ok_or_else(|| CoreError::InvalidParams("expectedWorktreeGeneration".into()))?;
        if expected_operation_id != observed.plan.proof.operation_id
            || expected_generation != observed.plan.proof.worktree_generation
        {
            return Err(CoreError::ManagedWorktreeProofChanged {
                task_id: observed.plan.task_id,
                current_managed_worktree_operation_id: Some(observed.plan.proof.operation_id),
                current_worktree_generation: observed.plan.proof.worktree_generation,
            });
        }
        if !blockers.is_empty() {
            return Err(CoreError::WorktreeRepairRefused {
                task_id: observed.plan.task_id,
                expected_managed_worktree_operation_id: expected_operation_id,
                expected_worktree_generation: expected_generation,
                blockers,
            });
        }
        let candidate_path = observed
            .facts
            .as_ref()
            .ok()
            .and_then(|facts| facts.candidate_path.to_str())
            .ok_or_else(|| CoreError::InvalidParams("candidatePath".into()))?
            .to_owned();
        let now = termloop_platform::current_epoch_ms();
        let operation = WorktreeRepairOperation {
            operation_id,
            task_id: observed.plan.task_id.clone(),
            managed_worktree_operation_id: expected_operation_id,
            expected_worktree_generation: expected_generation,
            candidate_path: candidate_path.clone(),
            stage: WorktreeRepairStage::Reserved,
            failure: None,
            started_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        match self
            .store
            .begin_task_worktree_repair(&self.write_authority, operation)
            .map_err(store_error)?
        {
            BeginRepairOutcome::Completed(receipt) => {
                Ok(TaskWorktreeRepairProgress::Return(self.repair_result(
                    &receipt.task_id,
                    receipt.previous_worktree_generation,
                    receipt.worktree_generation,
                    "alreadyCompleted",
                )?))
            }
            BeginRepairOutcome::Current(current)
                if current.stage != WorktreeRepairStage::Reserved || current.failure.is_some() =>
            {
                Err(CoreError::WorktreeRepairRecoveryAttention {
                    task_id: current.task_id,
                    operation_id: current.operation_id,
                })
            }
            BeginRepairOutcome::Started(current) | BeginRepairOutcome::Current(current) => {
                let prepared = self
                    .store
                    .advance_task_worktree_repair(
                        &self.write_authority,
                        &current.task_id,
                        &current.operation_id,
                        WorktreeRepairStage::RepairPrepared,
                        now,
                    )
                    .map_err(store_error)?;
                Ok(TaskWorktreeRepairProgress::Execute(Box::new(
                    TaskWorktreeRepairExecution {
                        operation: prepared,
                        common_dir: observed.plan.proof.repository_common_dir,
                        candidate_path,
                    },
                )))
            }
        }
    }

    pub fn apply_task_worktree_repair_execution(
        &mut self,
        executed: ExecutedTaskWorktreeRepair,
    ) -> Result<TaskWorktreeRepairProgress, CoreError> {
        let operation = executed.operation;
        if executed.result.is_err() {
            let failure = WorktreeRepairFailure {
                kind: WorktreeRepairFailureKind::RecoveryAttention,
                blockers: vec![WorktreeRepairBlocker::RecoveryAttention],
            };
            self.store
                .fail_task_worktree_repair(
                    &self.write_authority,
                    &operation.task_id,
                    &operation.operation_id,
                    failure,
                    termloop_platform::current_epoch_ms(),
                )
                .map_err(store_error)?;
            return Err(CoreError::WorktreeRepairRecoveryAttention {
                task_id: operation.task_id,
                operation_id: operation.operation_id,
            });
        }
        let invoked = self
            .store
            .advance_task_worktree_repair(
                &self.write_authority,
                &operation.task_id,
                &operation.operation_id,
                WorktreeRepairStage::RepairInvoked,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == invoked.task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        Ok(TaskWorktreeRepairProgress::Verify(Box::new(
            TaskWorktreeRepairVerification {
                operation: invoked,
                proof,
            },
        )))
    }

    pub fn apply_task_worktree_repair_verification(
        &mut self,
        verified: VerifiedTaskWorktreeRepair,
    ) -> Result<Value, CoreError> {
        let Some(observation) = verified.observation else {
            let failure = WorktreeRepairFailure {
                kind: WorktreeRepairFailureKind::RecoveryAttention,
                blockers: vec![WorktreeRepairBlocker::RecoveryAttention],
            };
            self.store
                .fail_task_worktree_repair(
                    &self.write_authority,
                    &verified.operation.task_id,
                    &verified.operation.operation_id,
                    failure,
                    termloop_platform::current_epoch_ms(),
                )
                .map_err(store_error)?;
            return Err(CoreError::WorktreeRepairRecoveryAttention {
                task_id: verified.operation.task_id,
                operation_id: verified.operation.operation_id,
            });
        };
        self.store
            .advance_task_worktree_repair(
                &self.write_authority,
                &verified.operation.task_id,
                &verified.operation.operation_id,
                WorktreeRepairStage::Verified,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        let commit = self
            .store
            .complete_task_worktree_repair(
                &self.write_authority,
                &verified.operation.task_id,
                &verified.operation.operation_id,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&commit.task.id);
        let _ = self.apply_task_worktree_health(
            &commit.task.id,
            observation,
            termloop_platform::current_epoch_ms(),
        );
        self.repair_result(
            &commit.task.id,
            commit.receipt.previous_worktree_generation,
            commit.receipt.worktree_generation,
            "repaired",
        )
    }

    pub fn apply_task_worktree_repair_dismissal(
        &mut self,
        observed: ObservedTaskWorktreeRepair,
    ) -> Result<Value, CoreError> {
        self.ensure_repair_plan_current(&observed.plan)?;
        if !repair_blockers(&observed).is_empty() {
            return Err(CoreError::WorktreeRepairRecoveryAttention {
                task_id: observed.plan.task_id,
                operation_id: observed.plan.operation_id.unwrap_or_default(),
            });
        }
        let task_id = observed.plan.task_id;
        let operation_id = observed
            .plan
            .operation_id
            .ok_or_else(|| CoreError::InvalidParams("operationId".into()))?;
        self.store
            .dismiss_task_worktree_repair(&self.write_authority, &task_id, &operation_id)
            .map_err(store_error)?;
        self.task_current_projection(&task_id)
    }

    pub fn reconcile_task_worktree_repair_operations(&mut self) {
        let operations = self.store.repair_operations().to_vec();
        for operation in operations {
            if operation.stage != WorktreeRepairStage::Reserved || operation.failure.is_none() {
                let _ = self.store.fail_task_worktree_repair(
                    &self.write_authority,
                    &operation.task_id,
                    &operation.operation_id,
                    WorktreeRepairFailure {
                        kind: WorktreeRepairFailureKind::RecoveryAttention,
                        blockers: vec![WorktreeRepairBlocker::RecoveryAttention],
                    },
                    termloop_platform::current_epoch_ms(),
                );
            }
        }
    }

    fn ensure_repair_plan_current(&self, plan: &TaskWorktreeRepairPlan) -> Result<(), CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == plan.task_id)
            .ok_or(CoreError::NotFound)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == plan.task_id);
        if !task
            .worktree
            .as_ref()
            .zip(proof)
            .is_some_and(|(binding, proof)| {
                binding.path == plan.old_path
                    && task.worktree_generation == plan.proof.worktree_generation
                    && proof == &plan.proof
            })
        {
            return Err(CoreError::ManagedWorktreeProofChanged {
                task_id: plan.task_id.clone(),
                current_managed_worktree_operation_id: proof
                    .map(|proof| proof.operation_id.clone()),
                current_worktree_generation: task.worktree_generation,
            });
        }
        Ok(())
    }

    fn repair_result(
        &self,
        task_id: &str,
        previous: u64,
        generation: u64,
        outcome: &str,
    ) -> Result<Value, CoreError> {
        Ok(
            json!({"task":self.task_current_projection(task_id)?,"previous_worktree_generation":previous,"worktree_generation":generation,"outcome":outcome,"repair":null}),
        )
    }
}

fn observe_repair_facts(
    plan: &TaskWorktreeRepairPlan,
) -> Result<WorktreeRepairFacts, WorktreeRepairBlocker> {
    if matches!(
        termloop_platform::path_entry_state(Path::new(&plan.old_path)),
        Ok(termloop_platform::PathEntryState::Present)
    ) {
        let same_path = termloop_platform::canonical_existing_directory(&plan.old_path)
            .ok()
            .zip(termloop_platform::canonical_existing_directory(&plan.candidate_path).ok())
            .is_some_and(|(old, candidate)| old == candidate);
        if !same_path {
            return Err(WorktreeRepairBlocker::OldPathStillPresent);
        }
    }
    if plan.candidate_conflict {
        return Err(WorktreeRepairBlocker::CandidatePathConflict);
    }
    if !plan.attached_session_ids.is_empty() {
        return Err(WorktreeRepairBlocker::SessionAttached);
    }
    match termloop_platform::path_entry_state(Path::new(&plan.candidate_path)) {
        Ok(termloop_platform::PathEntryState::Absent) => {
            return Err(WorktreeRepairBlocker::CandidateMissing);
        }
        Err(_) => return Err(WorktreeRepairBlocker::ObservationFailed),
        _ => {}
    }
    let runner = GitRunner::discover_with_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
        .map_err(map_repair_git_error)?;
    runner
        .inspect_worktree_repair(
            Path::new(&plan.candidate_path),
            Path::new(&plan.proof.repository_common_dir),
            Path::new(&plan.old_path),
        )
        .map_err(map_repair_git_error)
}

fn repair_blockers(observed: &ObservedTaskWorktreeRepair) -> Vec<WorktreeRepairBlocker> {
    let mut blockers = Vec::new();
    match &observed.facts {
        Err(blocker) => blockers.push(*blocker),
        Ok(facts) => {
            if !facts.registration_matches_proof {
                blockers.push(WorktreeRepairBlocker::RegistrationEvidenceMissing);
            }
            if !facts.repair_class_supported {
                blockers.push(
                    if facts.candidate_is_current_path
                        && facts.bilateral_link_matches
                        && !facts.registration_missing_on_disk
                    {
                        WorktreeRepairBlocker::RegistrationAlreadyMatching
                    } else {
                        WorktreeRepairBlocker::RegistrationEvidenceAmbiguous
                    },
                );
            }
            if facts.branch_ref != observed.plan.proof.branch_ref.as_bytes() {
                blockers.push(WorktreeRepairBlocker::BranchMismatch);
            }
            if !facts.head_matches_branch {
                blockers.push(WorktreeRepairBlocker::HeadMismatch);
            }
            if facts.worktree_locked {
                blockers.push(WorktreeRepairBlocker::WorktreeLock);
            }
            if facts.index_locked {
                blockers.push(WorktreeRepairBlocker::IndexLock);
            }
        }
    }
    blockers
}

fn repair_preview_json(observed: &ObservedTaskWorktreeRepair) -> Value {
    let blockers = repair_blockers(observed);
    let decision = if blockers.is_empty() {
        "allowed"
    } else if blockers.iter().any(|b| {
        matches!(
            b,
            WorktreeRepairBlocker::ObservationFailed
                | WorktreeRepairBlocker::Timeout
                | WorktreeRepairBlocker::OutputLimit
        )
    }) {
        "unknown"
    } else {
        "refused"
    };
    let candidate_path = observed
        .facts
        .as_ref()
        .ok()
        .and_then(|facts| facts.candidate_path.to_str())
        .unwrap_or(&observed.plan.candidate_path);
    json!({"task_id":observed.plan.task_id,"managed_worktree_operation_id":observed.plan.proof.operation_id,"worktree_generation":observed.plan.proof.worktree_generation,"current_path":observed.plan.old_path,"candidate_path":candidate_path,"decision":decision,"blockers":blockers,"attached_session_ids":observed.plan.attached_session_ids,"observed_at_epoch_ms":termloop_platform::current_epoch_ms()})
}

fn map_repair_git_error(error: GitError) -> WorktreeRepairBlocker {
    match error {
        GitError::PermissionDenied { .. } => WorktreeRepairBlocker::PermissionDenied,
        GitError::UnsupportedVersion { .. } => WorktreeRepairBlocker::UnsupportedGit,
        GitError::Timeout { .. } => WorktreeRepairBlocker::Timeout,
        GitError::OutputLimitExceeded { .. } => WorktreeRepairBlocker::OutputLimit,
        GitError::MissingRegistration => WorktreeRepairBlocker::RegistrationEvidenceMissing,
        _ => WorktreeRepairBlocker::ObservationFailed,
    }
}

pub fn repair_blocker_name(blocker: &WorktreeRepairBlocker) -> &'static str {
    match blocker {
        WorktreeRepairBlocker::NoBinding => "noBinding",
        WorktreeRepairBlocker::ManagedProofMissing => "managedProofMissing",
        WorktreeRepairBlocker::ManagedProofMismatch => "managedProofMismatch",
        WorktreeRepairBlocker::ProvisioningInProgress => "provisioningInProgress",
        WorktreeRepairBlocker::CleanupInProgress => "cleanupInProgress",
        WorktreeRepairBlocker::RepairInProgress => "repairInProgress",
        WorktreeRepairBlocker::CommonRepositoryUnavailable => "commonRepositoryUnavailable",
        WorktreeRepairBlocker::CommonRepositoryChanged => "commonRepositoryChanged",
        WorktreeRepairBlocker::CandidateMissing => "candidateMissing",
        WorktreeRepairBlocker::CandidateReplaced => "candidateReplaced",
        WorktreeRepairBlocker::OldPathStillPresent => "oldPathStillPresent",
        WorktreeRepairBlocker::CandidatePathConflict => "candidatePathConflict",
        WorktreeRepairBlocker::RegistrationAlreadyMatching => "registrationAlreadyMatching",
        WorktreeRepairBlocker::RegistrationEvidenceMissing => "registrationEvidenceMissing",
        WorktreeRepairBlocker::RegistrationEvidenceAmbiguous => "registrationEvidenceAmbiguous",
        WorktreeRepairBlocker::BranchMismatch => "branchMismatch",
        WorktreeRepairBlocker::HeadMismatch => "headMismatch",
        WorktreeRepairBlocker::SessionAttached => "sessionAttached",
        WorktreeRepairBlocker::WorktreeLock => "worktreeLock",
        WorktreeRepairBlocker::IndexLock => "indexLock",
        WorktreeRepairBlocker::PermissionDenied => "permissionDenied",
        WorktreeRepairBlocker::UnsupportedGit => "unsupportedGit",
        WorktreeRepairBlocker::Timeout => "timeout",
        WorktreeRepairBlocker::OutputLimit => "outputLimit",
        WorktreeRepairBlocker::ObservationFailed => "observationFailed",
        WorktreeRepairBlocker::RecoveryAttention => "recoveryAttention",
    }
}

pub(crate) fn repair_operation_json(operation: &WorktreeRepairOperation) -> Value {
    let dismissible =
        operation.stage == WorktreeRepairStage::Reserved && operation.failure.is_some();
    json!({
        "operation_id": operation.operation_id,
        "managed_worktree_operation_id": operation.managed_worktree_operation_id,
        "expected_worktree_generation": operation.expected_worktree_generation,
        "candidate_path": operation.candidate_path,
        "stage": operation.stage,
        "status": if operation.failure.is_some() { "failed" } else { "running" },
        "dismissible": dismissible,
        "failure": operation.failure.as_ref().map(|failure| json!({
            "kind": failure.kind,
            "blockers": failure.blockers,
        })),
    })
}
