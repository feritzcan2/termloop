use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use termloop_domain::{
    ManagedWorktreeProof, NormalizedWorktreeSpec, ProvisioningBranchMode, ProvisioningFailureKind,
    ProvisioningStage, TaskBranchBinding, TaskRecord, TaskWorktreeBinding,
    WorktreeProvisioningOperation,
};
use termloop_gitio::{
    GitRefName, GitReflogMessage, GitRunner, ObjectId, RegisteredPathState, WorktreeCheckout,
    WorktreeFacts,
};
use termloop_store::{BeginProvisioningOutcome, ProvisioningCommit};
use uuid::Uuid;

use super::git_mapping::{
    local_branch_ref, map_git_mutation_error, map_git_observation_error,
    map_repository_input_error, path_entry_is_absent, path_string, provisioning_failure_kind,
    worktree_registered_at,
};

#[derive(Debug)]
pub(crate) struct ObservedProvisioningSpec {
    pub(super) spec: NormalizedWorktreeSpec,
}

#[derive(Debug)]
pub(crate) enum ProvisioningStepSuccess {
    BranchCreated,
    WorktreeAdded,
    ReadyToCommit,
}

#[derive(Debug)]
pub(crate) struct ProvisioningStepFailure {
    error: CoreError,
    kind: ProvisioningFailureKind,
    ref_rolled_back: bool,
}
use crate::{CoreError, CoreRuntime, required_string, store_error};

pub struct TaskWorktreeProvisioningPlan {
    pub(crate) params: Value,
    pub(crate) operation_id: String,
    pub(crate) task: termloop_domain::TaskRecord,
    pub(crate) project_folder: std::path::PathBuf,
    pub(crate) prior_spec: Option<termloop_domain::NormalizedWorktreeSpec>,
    pub(crate) completed_retry: bool,
}

pub struct ObservedTaskWorktreeProvisioning {
    pub(crate) operation_id: String,
    pub(crate) task: termloop_domain::TaskRecord,
    pub(crate) observed: ObservedProvisioningSpec,
    pub(crate) runner: termloop_gitio::GitRunner,
}

pub struct TaskWorktreeProvisioningStep {
    pub(crate) operation: termloop_domain::WorktreeProvisioningOperation,
    pub(crate) runner: termloop_gitio::GitRunner,
}

pub struct ExecutedTaskWorktreeProvisioningStep {
    pub(crate) operation: termloop_domain::WorktreeProvisioningOperation,
    pub(crate) runner: termloop_gitio::GitRunner,
    pub(crate) result: Result<ProvisioningStepSuccess, ProvisioningStepFailure>,
}

pub enum TaskWorktreeProvisioningProgress {
    Return(Value),
    Execute(Box<TaskWorktreeProvisioningStep>),
}

pub struct TaskWorktreeProvisioningDismissPlan {
    pub(crate) operation: termloop_domain::WorktreeProvisioningOperation,
}

pub struct ObservedTaskWorktreeProvisioningDismissal {
    pub(crate) operation: termloop_domain::WorktreeProvisioningOperation,
}

impl TaskWorktreeProvisioningPlan {
    pub fn observe(self) -> Result<ObservedTaskWorktreeProvisioning, CoreError> {
        let runner = GitRunner::discover().map_err(map_git_observation_error)?;
        let observed = observe_provisioning_spec(
            &runner,
            &self.params,
            &self.task,
            &self.project_folder,
            self.prior_spec.as_ref(),
            self.completed_retry,
        )?;
        Ok(ObservedTaskWorktreeProvisioning {
            operation_id: self.operation_id,
            task: self.task,
            observed,
            runner,
        })
    }
}

impl TaskWorktreeProvisioningStep {
    pub fn execute(self) -> ExecutedTaskWorktreeProvisioningStep {
        let result = execute_provisioning_step(&self.runner, &self.operation);
        ExecutedTaskWorktreeProvisioningStep {
            operation: self.operation,
            runner: self.runner,
            result,
        }
    }
}

impl TaskWorktreeProvisioningDismissPlan {
    pub fn observe(self) -> Result<ObservedTaskWorktreeProvisioningDismissal, CoreError> {
        let runner = GitRunner::discover().map_err(map_git_observation_error)?;
        let operation_id = self.operation.operation_id.clone();
        let destination = Path::new(&self.operation.spec.destination_path);
        if !path_entry_is_absent(destination)
            || runner
                .list_worktrees(Path::new(&self.operation.spec.repository_root))
                .map_err(map_git_observation_error)?
                .iter()
                .any(|worktree| worktree_registered_at(worktree, destination))
        {
            return Err(CoreError::WorktreeRecoveryAttention { operation_id });
        }
        if self.operation.spec.branch_mode == ProvisioningBranchMode::Create
            && self.operation.created_branch_ref
        {
            let reference = local_branch_ref(&self.operation.spec.branch_name)?;
            if runner
                .resolve_ref(Path::new(&self.operation.spec.repository_root), &reference)
                .map_err(map_git_observation_error)?
                .is_some()
            {
                return Err(CoreError::WorktreeRecoveryAttention { operation_id });
            }
        }
        Ok(ObservedTaskWorktreeProvisioningDismissal {
            operation: self.operation,
        })
    }
}

impl CoreRuntime {
    pub fn plan_task_worktree_provisioning(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeProvisioningPlan, CoreError> {
        let operation_id = required_string(&params, "operationId")?;
        Uuid::parse_str(&operation_id)
            .map_err(|_| CoreError::InvalidParams("operationId".into()))?;
        let task_id = required_string(&params, "taskId")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if task.archived_at_epoch_ms.is_some() {
            return Err(CoreError::TaskArchived { task_id });
        }
        if operation_id_is_owned_by_another_task(&self.store, &operation_id, &task_id) {
            return Err(CoreError::OperationIdReused { operation_id });
        }
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == task.project_id)
            .ok_or(CoreError::NotFound)?;
        let completed_retry = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.operation_id == operation_id)
            .map(|proof| proof.normalized_spec.clone());
        let prior_spec = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
            .map(|operation| operation.spec.clone())
            .or_else(|| completed_retry.clone());
        Ok(TaskWorktreeProvisioningPlan {
            params,
            operation_id,
            task,
            project_folder: PathBuf::from(&project.folder_path),
            prior_spec,
            completed_retry: completed_retry.is_some(),
        })
    }

    pub fn begin_task_worktree_provisioning(
        &mut self,
        observed: ObservedTaskWorktreeProvisioning,
    ) -> Result<TaskWorktreeProvisioningProgress, CoreError> {
        let task_id = observed.task.id.clone();
        let operation_id = observed.operation_id;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&task.project_id) {
            return Err(CoreError::NotFound);
        }
        if task.project_id != observed.task.project_id
            || operation_id_is_owned_by_another_task(&self.store, &operation_id, &task_id)
        {
            return Err(CoreError::OperationIdReused { operation_id });
        }
        if task.branch.as_ref().is_some_and(|binding| {
            binding.repository_root != observed.observed.spec.repository_root
                || binding.name != observed.observed.spec.branch_name
        }) {
            return Err(CoreError::TaskBranchAlreadyBound { task_id });
        }
        self.validate_provisioning_reservation(&task, &observed.observed.spec)?;
        let now = termloop_platform::current_epoch_ms();
        let requested = WorktreeProvisioningOperation {
            operation_id,
            task_id,
            project_id: task.project_id.clone(),
            spec: observed.observed.spec,
            stage: ProvisioningStage::Reserved,
            created_branch_ref: false,
            failure: None,
            started_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        match self
            .store
            .begin_task_worktree_provisioning(&self.write_authority, requested)
            .map_err(store_error)?
        {
            BeginProvisioningOutcome::Completed(proof) => self
                .provisioning_result(&proof.task_id, false)
                .map(TaskWorktreeProvisioningProgress::Return),
            BeginProvisioningOutcome::Current(operation) if operation.failure.is_none() => self
                .provisioning_result(&operation.task_id, true)
                .map(TaskWorktreeProvisioningProgress::Return),
            BeginProvisioningOutcome::Current(operation) => {
                let operation = self
                    .store
                    .retry_task_worktree_provisioning(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        now,
                    )
                    .map_err(store_error)?;
                Ok(TaskWorktreeProvisioningProgress::Execute(Box::new(
                    TaskWorktreeProvisioningStep {
                        operation,
                        runner: observed.runner,
                    },
                )))
            }
            BeginProvisioningOutcome::Started(operation) => Ok(
                TaskWorktreeProvisioningProgress::Execute(Box::new(TaskWorktreeProvisioningStep {
                    operation,
                    runner: observed.runner,
                })),
            ),
        }
    }

    pub fn apply_task_worktree_provisioning_step(
        &mut self,
        executed: ExecutedTaskWorktreeProvisioningStep,
    ) -> Result<TaskWorktreeProvisioningProgress, CoreError> {
        let current = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| {
                operation.task_id == executed.operation.task_id
                    && operation.operation_id == executed.operation.operation_id
            })
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if current.stage != executed.operation.stage
            || current.spec != executed.operation.spec
            || current.failure.is_some()
        {
            return Err(CoreError::ProvisioningAlreadyInProgress {
                operation_id: current.operation_id,
            });
        }
        match executed.result {
            Ok(ProvisioningStepSuccess::BranchCreated) => {
                let operation = self
                    .store
                    .advance_task_worktree_provisioning(
                        &self.write_authority,
                        &current.task_id,
                        &current.operation_id,
                        ProvisioningStage::BranchCreated,
                        true,
                        termloop_platform::current_epoch_ms(),
                    )
                    .map_err(store_error)?;
                Ok(TaskWorktreeProvisioningProgress::Execute(Box::new(
                    TaskWorktreeProvisioningStep {
                        operation,
                        runner: executed.runner,
                    },
                )))
            }
            Ok(ProvisioningStepSuccess::WorktreeAdded) => {
                let operation = self
                    .store
                    .advance_task_worktree_provisioning(
                        &self.write_authority,
                        &current.task_id,
                        &current.operation_id,
                        ProvisioningStage::WorktreeAdded,
                        current.created_branch_ref,
                        termloop_platform::current_epoch_ms(),
                    )
                    .map_err(store_error)?;
                Ok(TaskWorktreeProvisioningProgress::Execute(Box::new(
                    TaskWorktreeProvisioningStep {
                        operation,
                        runner: executed.runner,
                    },
                )))
            }
            Ok(ProvisioningStepSuccess::ReadyToCommit) => {
                match self.commit_verified_provisioning(&current) {
                    Ok(task) => self
                        .provisioning_result(&task.id, false)
                        .map(TaskWorktreeProvisioningProgress::Return),
                    Err(_) => {
                        self.store
                            .fail_task_worktree_provisioning(
                                &self.write_authority,
                                &current.task_id,
                                &current.operation_id,
                                ProvisioningFailureKind::RecoveryAttention,
                                termloop_platform::current_epoch_ms(),
                            )
                            .map_err(store_error)?;
                        Err(CoreError::WorktreeRecoveryAttention {
                            operation_id: current.operation_id,
                        })
                    }
                }
            }
            Err(failure) => {
                if failure.ref_rolled_back {
                    self.store
                        .record_provisioning_ref_rollback(
                            &self.write_authority,
                            &current.task_id,
                            &current.operation_id,
                            failure.kind,
                            termloop_platform::current_epoch_ms(),
                        )
                        .map_err(store_error)?;
                } else {
                    self.store
                        .fail_task_worktree_provisioning(
                            &self.write_authority,
                            &current.task_id,
                            &current.operation_id,
                            failure.kind,
                            termloop_platform::current_epoch_ms(),
                        )
                        .map_err(store_error)?;
                }
                Err(failure.error)
            }
        }
    }

    pub fn provision_task_worktree(&mut self, params: Value) -> Result<Value, CoreError> {
        let plan = self.plan_task_worktree_provisioning(params)?;
        let observed = plan.observe()?;
        let mut progress = self.begin_task_worktree_provisioning(observed)?;
        loop {
            progress = match progress {
                TaskWorktreeProvisioningProgress::Return(value) => return Ok(value),
                TaskWorktreeProvisioningProgress::Execute(step) => {
                    self.apply_task_worktree_provisioning_step(step.execute())?
                }
            };
        }
    }

    fn validate_provisioning_reservation(
        &self,
        task: &TaskRecord,
        spec: &NormalizedWorktreeSpec,
    ) -> Result<(), CoreError> {
        for candidate in self
            .store
            .tasks()
            .iter()
            .filter(|candidate| candidate.id != task.id)
        {
            if let Some(binding) = &candidate.worktree
                && termloop_platform::normalized_absolute_paths_overlap(
                    Path::new(&spec.destination_path),
                    Path::new(&binding.path),
                )
                .map_err(|_| CoreError::WorktreePathConflict)?
            {
                return Err(CoreError::WorktreePathHeldByTask {
                    task_id: candidate.id.clone(),
                });
            }
        }
        for candidate in self
            .store
            .provisioning_operations()
            .iter()
            .filter(|candidate| candidate.task_id != task.id)
        {
            if termloop_platform::normalized_absolute_paths_overlap(
                Path::new(&spec.destination_path),
                Path::new(&candidate.spec.destination_path),
            )
            .map_err(|_| CoreError::WorktreePathConflict)?
            {
                return Err(CoreError::WorktreePathHeldByTask {
                    task_id: candidate.task_id.clone(),
                });
            }
        }
        if let Some(holder) = self.store.tasks().iter().find(|candidate| {
            candidate.id != task.id
                && candidate.project_id == task.project_id
                && candidate.branch.as_ref().is_some_and(|branch| {
                    branch.repository_root == spec.repository_root
                        && branch.name == spec.branch_name
                })
        }) {
            return Err(CoreError::BranchHeldByTask {
                task_id: holder.id.clone(),
            });
        }
        if let Some(holder) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|candidate| {
                candidate.task_id != task.id
                    && candidate.project_id == task.project_id
                    && candidate.spec.repository_root == spec.repository_root
                    && candidate.spec.branch_name == spec.branch_name
            })
        {
            return Err(CoreError::BranchHeldByTask {
                task_id: holder.task_id.clone(),
            });
        }
        Ok(())
    }

    fn provisioning_result(&self, task_id: &str, current: bool) -> Result<Value, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let task = self.task_projection(task)?;
        let provisioning = if current {
            task.get("worktree_provisioning")
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        Ok(json!({ "task": task, "provisioning": provisioning }))
    }

    fn commit_verified_provisioning(
        &mut self,
        operation: &WorktreeProvisioningOperation,
    ) -> Result<TaskRecord, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == operation.task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let branch = TaskBranchBinding {
            repository_root: operation.spec.repository_root.clone(),
            name: operation.spec.branch_name.clone(),
        };
        if task
            .branch
            .as_ref()
            .is_some_and(|existing| existing != &branch)
        {
            return Err(CoreError::TaskBranchAlreadyBound { task_id: task.id });
        }
        let proof = ManagedWorktreeProof {
            task_id: operation.task_id.clone(),
            operation_id: operation.operation_id.clone(),
            worktree_generation: 0,
            normalized_spec_version: operation.spec.version,
            normalized_spec: operation.spec.clone(),
            repository_common_dir: operation.spec.repository_common_dir.clone(),
            registered_worktree_path: operation.spec.destination_path.clone(),
            branch_ref: format!("refs/heads/{}", operation.spec.branch_name),
        };
        let task = self
            .store
            .commit_task_worktree_provisioning(
                &self.write_authority,
                &operation.task_id,
                &operation.operation_id,
                ProvisioningCommit {
                    branch,
                    worktree: TaskWorktreeBinding {
                        path: operation.spec.destination_path.clone(),
                    },
                    proof,
                    updated_at_epoch_ms: termloop_platform::current_epoch_ms(),
                },
            )
            .map_err(store_error)?;
        self.store
            .clear_task_worktree_provisioning(
                &self.write_authority,
                &operation.task_id,
                &operation.operation_id,
            )
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&task.id);
        Ok(task)
    }

    pub fn dismiss_task_worktree_provisioning(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let plan = self.plan_task_worktree_provisioning_dismissal(params)?;
        let observed = plan.observe()?;
        self.complete_task_worktree_provisioning_dismissal(observed)
    }

    pub fn plan_task_worktree_provisioning_dismissal(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeProvisioningDismissPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let operation_id = required_string(&params, "operationId")?;
        let operation = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if operation.failure.is_none() {
            return Err(CoreError::ProvisioningAlreadyInProgress { operation_id });
        }
        Ok(TaskWorktreeProvisioningDismissPlan { operation })
    }

    pub fn complete_task_worktree_provisioning_dismissal(
        &mut self,
        observed: ObservedTaskWorktreeProvisioningDismissal,
    ) -> Result<Value, CoreError> {
        let task_id = observed.operation.task_id.clone();
        let operation_id = observed.operation.operation_id.clone();
        let current = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .ok_or(CoreError::NotFound)?;
        if current != &observed.operation || current.failure.is_none() {
            return Err(CoreError::ProvisioningAlreadyInProgress { operation_id });
        }
        self.store
            .clear_task_worktree_provisioning(
                &self.write_authority,
                &task_id,
                &observed.operation.operation_id,
            )
            .map_err(store_error)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        self.task_projection(task)
    }

    pub(crate) fn reconcile_task_worktree_operations(&mut self) {
        let Ok(runner) = GitRunner::discover() else {
            return;
        };
        let operations = self.store.provisioning_operations().to_vec();
        for operation in operations {
            if operation.failure.is_some() {
                continue;
            }
            if operation.stage == ProvisioningStage::BindingCommitted {
                let valid = self.store.managed_worktrees().iter().any(|proof| {
                    proof.task_id == operation.task_id
                        && proof.operation_id == operation.operation_id
                        && proof.normalized_spec == operation.spec
                }) && self.store.tasks().iter().any(|task| {
                    task.id == operation.task_id
                        && task.worktree.as_ref().is_some_and(|worktree| {
                            worktree.path == operation.spec.destination_path
                        })
                });
                if valid {
                    let _ = self.store.clear_task_worktree_provisioning(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                    );
                } else {
                    let _ = self.store.fail_task_worktree_provisioning(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        ProvisioningFailureKind::RecoveryAttention,
                        termloop_platform::current_epoch_ms(),
                    );
                }
                continue;
            }
            let mut progress =
                TaskWorktreeProvisioningProgress::Execute(Box::new(TaskWorktreeProvisioningStep {
                    operation,
                    runner: runner.clone(),
                }));
            while let TaskWorktreeProvisioningProgress::Execute(step) = progress {
                match self.apply_task_worktree_provisioning_step(step.execute()) {
                    Ok(next) => progress = next,
                    Err(_) => break,
                }
            }
        }
    }
}

fn operation_id_is_owned_by_another_task(
    store: &termloop_store::Store,
    operation_id: &str,
    task_id: &str,
) -> bool {
    store
        .managed_worktrees()
        .iter()
        .any(|proof| proof.operation_id == operation_id && proof.task_id != task_id)
        || store
            .provisioning_operations()
            .iter()
            .any(|operation| operation.operation_id == operation_id && operation.task_id != task_id)
}

fn execute_provisioning_step(
    runner: &GitRunner,
    operation: &WorktreeProvisioningOperation,
) -> Result<ProvisioningStepSuccess, ProvisioningStepFailure> {
    let execute = || -> Result<ProvisioningStepSuccess, CoreError> {
        let repository = Path::new(&operation.spec.repository_root);
        let destination = Path::new(&operation.spec.destination_path);
        let target_ref = local_branch_ref(&operation.spec.branch_name)?;
        if operation.stage == ProvisioningStage::Reserved
            && operation.spec.branch_mode == ProvisioningBranchMode::Create
        {
            let expected = ObjectId::from_hex(
                operation
                    .spec
                    .base_oid
                    .as_deref()
                    .ok_or_else(|| CoreError::InvalidParams("baseRef".into()))?
                    .as_bytes()
                    .to_vec(),
            )
            .map_err(map_git_observation_error)?;
            let marker = provisioning_marker(&operation.operation_id)?;
            let facts = runner
                .ref_recovery_facts(repository, &target_ref)
                .map_err(map_git_observation_error)?;
            if facts.current_oid.is_none() {
                runner
                    .create_branch_ref(repository, &target_ref, &expected, &marker)
                    .map_err(map_git_mutation_error)?;
            } else if !exact_creation_marker(&facts, &expected, &marker) {
                return Err(CoreError::BranchMutationConflict);
            }
            return Ok(ProvisioningStepSuccess::BranchCreated);
        }
        if matches!(
            operation.stage,
            ProvisioningStage::Reserved | ProvisioningStage::BranchCreated
        ) {
            if operation.stage == ProvisioningStage::BranchCreated {
                let expected = ObjectId::from_hex(
                    operation
                        .spec
                        .base_oid
                        .as_deref()
                        .ok_or_else(|| CoreError::WorktreeRecoveryAttention {
                            operation_id: operation.operation_id.clone(),
                        })?
                        .as_bytes()
                        .to_vec(),
                )
                .map_err(map_git_observation_error)?;
                let marker = provisioning_marker(&operation.operation_id)?;
                let facts = runner
                    .ref_recovery_facts(repository, &target_ref)
                    .map_err(map_git_observation_error)?;
                if !operation.created_branch_ref
                    || !exact_creation_marker(&facts, &expected, &marker)
                {
                    return Err(CoreError::WorktreeRecoveryAttention {
                        operation_id: operation.operation_id.clone(),
                    });
                }
            }
            let worktrees = runner
                .list_worktrees(repository)
                .map_err(map_git_observation_error)?;
            let registered = worktrees
                .iter()
                .any(|worktree| worktree_registered_at(worktree, destination));
            if !path_entry_is_absent(destination) || registered {
                return Err(CoreError::WorktreeRecoveryAttention {
                    operation_id: operation.operation_id.clone(),
                });
            }
            if let Some(path) = checked_out_branch_path(&worktrees, &target_ref)? {
                return Err(CoreError::BranchCheckedOutElsewhere {
                    worktree_path: path,
                });
            }
            runner
                .add_worktree(repository, destination, &target_ref)
                .map_err(map_git_mutation_error)?;
            return Ok(ProvisioningStepSuccess::WorktreeAdded);
        }
        let worktrees = runner
            .list_worktrees(repository)
            .map_err(map_git_observation_error)?;
        let worktree = worktrees
            .iter()
            .find(|worktree| worktree_registered_at(worktree, destination))
            .ok_or_else(|| CoreError::WorktreeRecoveryAttention {
                operation_id: operation.operation_id.clone(),
            })?;
        verify_created_worktree(worktree, destination, &target_ref, &operation.operation_id)?;
        Ok(ProvisioningStepSuccess::ReadyToCommit)
    };

    execute().map_err(|error| {
        let mut kind = provisioning_failure_kind(&error);
        let mut ref_rolled_back = false;
        if operation.stage == ProvisioningStage::BranchCreated && operation.created_branch_ref {
            let repository = Path::new(&operation.spec.repository_root);
            let destination = Path::new(&operation.spec.destination_path);
            let rollback = local_branch_ref(&operation.spec.branch_name).and_then(|target_ref| {
                let registration_absent =
                    runner.list_worktrees(repository).is_ok_and(|worktrees| {
                        !worktrees.iter().any(|worktree| {
                            worktree_registered_at(worktree, destination)
                                || matches!(
                                    &worktree.checkout,
                                    WorktreeCheckout::Branch { reference, .. }
                                        if reference == &target_ref
                                )
                        })
                    });
                if !path_entry_is_absent(destination) || !registration_absent {
                    return Err(CoreError::WorktreeRecoveryAttention {
                        operation_id: operation.operation_id.clone(),
                    });
                }
                let marker = provisioning_marker(&operation.operation_id)?;
                rollback_created_ref(runner, repository, &target_ref, operation, &marker)
            });
            if rollback.is_ok() {
                ref_rolled_back = true;
            } else {
                kind = ProvisioningFailureKind::RecoveryAttention;
            }
        }
        let error = if kind == ProvisioningFailureKind::RecoveryAttention {
            CoreError::WorktreeRecoveryAttention {
                operation_id: operation.operation_id.clone(),
            }
        } else {
            error
        };
        ProvisioningStepFailure {
            error,
            kind,
            ref_rolled_back,
        }
    })
}

pub(super) fn observe_provisioning_spec(
    runner: &GitRunner,
    params: &Value,
    task: &TaskRecord,
    project_folder: &Path,
    prior: Option<&NormalizedWorktreeSpec>,
    completed_retry: bool,
) -> Result<ObservedProvisioningSpec, CoreError> {
    let repository_path = PathBuf::from(required_string(params, "repositoryPath")?);
    let identity = runner
        .inspect_repository(&repository_path)
        .map_err(map_repository_input_error)?;
    if identity.bare {
        return Err(CoreError::InvalidParams("repositoryPath".into()));
    }
    let worktrees = runner
        .list_worktrees(&identity.resolved_path)
        .map_err(map_git_observation_error)?;
    let mut main_records = worktrees.iter().filter(|worktree| worktree.is_main);
    let main = main_records
        .next()
        .ok_or(CoreError::RepositoryUnavailable)?;
    if main_records.next().is_some() {
        return Err(CoreError::RepositoryUnavailable);
    }
    let repository_root = match &main.path_state {
        RegisteredPathState::Present { canonical_path } => canonical_path.clone(),
        _ => return Err(CoreError::RepositoryUnavailable),
    };
    let mut in_project_scope = false;
    for worktree in &worktrees {
        let RegisteredPathState::Present { canonical_path } = &worktree.path_state else {
            continue;
        };
        if termloop_platform::canonical_directories_overlap(project_folder, canonical_path)
            .map_err(|_| CoreError::RepositoryUnavailable)?
        {
            in_project_scope = true;
            break;
        }
    }
    if !in_project_scope {
        return Err(CoreError::InvalidParams("repositoryPath".into()));
    }
    let repository_root_string = path_string(repository_root.clone(), "repositoryPath")?;
    let common_dir_string = path_string(identity.common_dir.clone(), "repositoryPath")?;
    let destination_input = PathBuf::from(required_string(params, "destinationPath")?);
    let destination = match termloop_platform::canonical_directory_if_exists(&destination_input) {
        Ok(Some(_)) if prior.is_none() => return Err(CoreError::WorktreePathConflict),
        Ok(Some(path)) => path,
        Ok(None) => {
            termloop_platform::future_directory_identity(&destination_input)
                .map_err(|_| CoreError::WorktreePathConflict)?
                .reserved_path
        }
        Err(_) => return Err(CoreError::WorktreePathConflict),
    };
    for worktree in &worktrees {
        // Compare filesystem-canonical identities while the registered checkout
        // exists: Git's recorded bytes and the canonicalized destination
        // diverge textually under symlinked prefixes (macOS /tmp ->
        // /private/tmp) and Windows junctions. A registered-but-deleted
        // checkout has no canonical path, so it deliberately falls back to the
        // recorded path under the same normalized comparison.
        let registered_identity = match &worktree.path_state {
            RegisteredPathState::Present { canonical_path } => canonical_path.as_path(),
            RegisteredPathState::Missing | RegisteredPathState::NotDirectory => {
                worktree.registered_path.as_path()
            }
        };
        if termloop_platform::normalized_absolute_paths_overlap(&destination, registered_identity)
            .map_err(|_| CoreError::WorktreePathConflict)?
        {
            let prior_destination_matches =
                prior.is_some_and(|spec| Path::new(&spec.destination_path) == destination);
            if !prior_destination_matches {
                return Err(CoreError::WorktreePathConflict);
            }
        }
    }
    let destination_string = path_string(destination, "destinationPath")?;
    let branch_name = required_string(params, "branchName")?;
    let target_ref = local_branch_ref(&branch_name)?;
    let branch_mode = match required_string(params, "branchMode")?.as_str() {
        "existing" => ProvisioningBranchMode::Existing,
        "create" => ProvisioningBranchMode::Create,
        _ => return Err(CoreError::InvalidParams("branchMode".into())),
    };
    let base_ref = params
        .get("baseRef")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if (branch_mode == ProvisioningBranchMode::Existing && base_ref.is_some())
        || (branch_mode == ProvisioningBranchMode::Create && base_ref.is_none())
    {
        return Err(CoreError::InvalidParams("baseRef".into()));
    }
    if branch_mode == ProvisioningBranchMode::Create
        && prior.is_none()
        && !base_ref.as_deref().is_some_and(selectable_remote_base_ref)
    {
        return Err(CoreError::InvalidParams("baseRef".into()));
    }
    if !completed_retry
        && task.branch.is_some()
        && branch_mode == ProvisioningBranchMode::Create
        && prior.is_none()
    {
        return Err(CoreError::InvalidParams("branchMode".into()));
    }
    if !completed_retry
        && let Some(binding) = &task.branch
        && (binding.repository_root != repository_root_string || binding.name != branch_name)
    {
        return Err(CoreError::TaskBranchAlreadyBound {
            task_id: task.id.clone(),
        });
    }
    if !completed_retry && task.worktree.is_some() {
        if let Some(proof) = prior
            && proof.repository_root == repository_root_string
            && proof.destination_path == destination_string
            && proof.branch_name == branch_name
            && proof.branch_mode == branch_mode
            && proof.base_ref == base_ref
        {
            return Ok(ObservedProvisioningSpec {
                spec: proof.clone(),
            });
        }
        return Err(CoreError::WorktreePathConflict);
    }
    let base_oid_string = if branch_mode == ProvisioningBranchMode::Create {
        let reference = GitRefName::from_bytes(
            base_ref
                .as_ref()
                .ok_or_else(|| CoreError::InvalidParams("baseRef".into()))?
                .as_bytes()
                .to_vec(),
        )
        .map_err(|_| CoreError::InvalidParams("baseRef".into()))?;
        if let Some(prior) = prior
            && prior.repository_root == repository_root_string
            && prior.destination_path == destination_string
            && prior.branch_name == branch_name
            && prior.branch_mode == branch_mode
            && prior.base_ref == base_ref
        {
            ObjectId::from_hex(
                prior
                    .base_oid
                    .as_deref()
                    .ok_or_else(|| CoreError::InvalidParams("baseRef".into()))?
                    .as_bytes()
                    .to_vec(),
            )
            .map_err(map_git_observation_error)?;
            prior.base_oid.clone()
        } else {
            let oid = runner
                .resolve_ref(&identity.resolved_path, &reference)
                .map_err(map_git_observation_error)?
                .ok_or(CoreError::BranchNotFound)?;
            let string = String::from_utf8(oid.as_bytes().to_vec())
                .map_err(|_| CoreError::RepositoryUnavailable)?;
            Some(string)
        }
    } else {
        if runner
            .resolve_ref(&identity.resolved_path, &target_ref)
            .map_err(map_git_observation_error)?
            .is_none()
        {
            return Err(CoreError::BranchNotFound);
        }
        None
    };
    if !completed_retry
        && branch_mode == ProvisioningBranchMode::Create
        && prior.is_none()
        && runner
            .resolve_ref(&identity.resolved_path, &target_ref)
            .map_err(map_git_observation_error)?
            .is_some()
    {
        return Err(CoreError::WorktreePathConflict);
    }
    let spec = NormalizedWorktreeSpec {
        version: 1,
        repository_root: repository_root_string,
        repository_common_dir: common_dir_string,
        destination_path: destination_string,
        branch_name,
        branch_mode,
        base_ref,
        base_oid: base_oid_string,
    };
    if !completed_retry && let Some(path) = checked_out_branch_path(&worktrees, &target_ref)? {
        let is_exact_prior_registration = prior.is_some_and(|prior| prior == &spec)
            && Path::new(&path) == Path::new(&spec.destination_path);
        if !is_exact_prior_registration {
            return Err(CoreError::BranchCheckedOutElsewhere {
                worktree_path: path,
            });
        }
    }
    Ok(ObservedProvisioningSpec { spec })
}

fn selectable_remote_base_ref(reference: &str) -> bool {
    reference
        .strip_prefix("refs/remotes/")
        .and_then(|name| name.split_once('/'))
        .is_some_and(|(remote, branch)| {
            !remote.is_empty() && !branch.is_empty() && branch != "HEAD"
        })
}

pub(super) fn provisioning_marker(operation_id: &str) -> Result<GitReflogMessage, CoreError> {
    GitReflogMessage::from_bytes(format!("termloop-provision:{operation_id}").into_bytes())
        .map_err(|_| CoreError::InvalidParams("operationId".into()))
}

fn exact_creation_marker(
    facts: &termloop_gitio::RefRecoveryFacts,
    expected: &ObjectId,
    marker: &GitReflogMessage,
) -> bool {
    facts.current_oid.as_ref() == Some(expected)
        && facts.entries.len() == 1
        && facts.entries[0].new_oid == *expected
        && facts.entries[0].message == marker.as_bytes()
}

fn rollback_created_ref(
    runner: &GitRunner,
    repository: &Path,
    reference: &GitRefName,
    operation: &WorktreeProvisioningOperation,
    marker: &GitReflogMessage,
) -> Result<(), CoreError> {
    let expected = ObjectId::from_hex(
        operation
            .spec
            .base_oid
            .as_deref()
            .ok_or_else(|| CoreError::WorktreeRecoveryAttention {
                operation_id: operation.operation_id.clone(),
            })?
            .as_bytes()
            .to_vec(),
    )
    .map_err(map_git_observation_error)?;
    let facts = runner
        .ref_recovery_facts(repository, reference)
        .map_err(map_git_observation_error)?;
    if !exact_creation_marker(&facts, &expected, marker) {
        return Err(CoreError::WorktreeRecoveryAttention {
            operation_id: operation.operation_id.clone(),
        });
    }
    runner
        .delete_ref_if_matches(repository, reference, &expected)
        .map_err(map_git_mutation_error)
}

fn checked_out_branch_path(
    worktrees: &[WorktreeFacts],
    reference: &GitRefName,
) -> Result<Option<String>, CoreError> {
    worktrees
        .iter()
        .find(|worktree| {
            matches!(&worktree.checkout, WorktreeCheckout::Branch { reference: current, .. } if current == reference)
        })
        .map(|worktree| path_string(worktree.registered_path.clone(), "worktreePath"))
        .transpose()
}

fn verify_created_worktree(
    worktree: &WorktreeFacts,
    destination: &Path,
    reference: &GitRefName,
    operation_id: &str,
) -> Result<(), CoreError> {
    let valid_path = matches!(
        &worktree.path_state,
        RegisteredPathState::Present { canonical_path } if canonical_path == destination
    );
    let valid_branch = matches!(
        &worktree.checkout,
        WorktreeCheckout::Branch { reference: current, oid: Some(_) } if current == reference
    );
    if valid_path && valid_branch {
        Ok(())
    } else {
        Err(CoreError::WorktreeRecoveryAttention {
            operation_id: operation_id.to_owned(),
        })
    }
}
