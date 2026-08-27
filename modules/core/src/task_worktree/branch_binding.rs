use std::path::PathBuf;

use serde_json::Value;
use termloop_domain::TaskBranchBinding;
use termloop_gitio::{GitError, GitRefName, GitRunner, RegisteredPathState, WorktreeCheckout};

use super::git_mapping::{map_git_observation_error, map_repository_input_error};
use crate::{CoreError, CoreRuntime, required_string, store_error};

pub struct TaskBranchBindingPlan {
    pub(crate) task_id: String,
    pub(crate) project_id: String,
    pub(crate) project_folder: std::path::PathBuf,
    pub(crate) repository_path: std::path::PathBuf,
    pub(crate) branch_name: String,
    pub(crate) existing_binding: Option<termloop_domain::TaskBranchBinding>,
}

pub struct ObservedTaskBranchBinding {
    pub(crate) task_id: String,
    pub(crate) project_id: String,
    pub(crate) binding: termloop_domain::TaskBranchBinding,
}

impl TaskBranchBindingPlan {
    pub fn observe(self) -> Result<ObservedTaskBranchBinding, CoreError> {
        let runner = GitRunner::discover().map_err(map_git_observation_error)?;
        self.observe_with_runner(&runner)
    }

    pub(super) fn observe_with_runner(
        self,
        runner: &GitRunner,
    ) -> Result<ObservedTaskBranchBinding, CoreError> {
        let mut full_ref = b"refs/heads/".to_vec();
        full_ref.extend_from_slice(self.branch_name.as_bytes());
        GitRefName::from_bytes(full_ref)
            .map_err(|_| CoreError::InvalidParams("branchName".into()))?;
        let identity = runner
            .inspect_repository(&self.repository_path)
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
        if main_records.next().is_some() || matches!(main.checkout, WorktreeCheckout::Bare) {
            return Err(CoreError::RepositoryUnavailable);
        }
        let main_root = match &main.path_state {
            RegisteredPathState::Present { canonical_path } => canonical_path.clone(),
            RegisteredPathState::Missing | RegisteredPathState::NotDirectory => {
                return Err(CoreError::RepositoryUnavailable);
            }
        };
        let main_identity = runner
            .inspect_repository(&main_root)
            .map_err(map_git_observation_error)?;
        if main_identity.bare
            || main_identity.common_dir != identity.common_dir
            || main_identity.worktree_root.as_ref() != Some(&main_root)
        {
            return Err(CoreError::RepositoryUnavailable);
        }
        let mut in_project_scope = false;
        for worktree in &worktrees {
            let RegisteredPathState::Present { canonical_path } = &worktree.path_state else {
                continue;
            };
            if termloop_platform::canonical_directories_overlap(
                &self.project_folder,
                canonical_path,
            )
            .map_err(|_| CoreError::RepositoryUnavailable)?
            {
                in_project_scope = true;
                break;
            }
        }
        if !in_project_scope {
            return Err(CoreError::InvalidParams("repositoryPath".into()));
        }
        let repository_root = main_root
            .into_os_string()
            .into_string()
            .map_err(|_| CoreError::InvalidParams("repositoryPath".into()))?;
        let binding = TaskBranchBinding {
            repository_root,
            name: self.branch_name,
        };
        if self.existing_binding.is_none() {
            let branch_exists = runner
                .branch_exists(&identity.resolved_path, binding.name.as_bytes())
                .map_err(|error| match error {
                    GitError::ParseFailed { .. } => CoreError::InvalidParams("branchName".into()),
                    error => map_git_observation_error(error),
                })?;
            if !branch_exists {
                return Err(CoreError::BranchNotFound);
            }
        }
        Ok(ObservedTaskBranchBinding {
            task_id: self.task_id,
            project_id: self.project_id,
            binding,
        })
    }
}

impl CoreRuntime {
    pub fn plan_task_branch_binding(
        &self,
        params: Value,
    ) -> Result<TaskBranchBindingPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let repository_path = PathBuf::from(required_string(&params, "repositoryPath")?);
        let branch_name = required_string(&params, "branchName")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if task.archived_at_epoch_ms.is_some() {
            return Err(CoreError::TaskArchived { task_id });
        }
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == task.project_id)
            .ok_or(CoreError::NotFound)?;
        Ok(TaskBranchBindingPlan {
            task_id,
            project_id: task.project_id.clone(),
            project_folder: PathBuf::from(&project.folder_path),
            repository_path,
            branch_name,
            existing_binding: task.branch.clone(),
        })
    }

    pub fn complete_task_branch_binding(
        &mut self,
        observed: ObservedTaskBranchBinding,
    ) -> Result<Value, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == observed.task_id)
            .ok_or(CoreError::NotFound)?;
        if task.archived_at_epoch_ms.is_some() {
            return Err(CoreError::TaskArchived {
                task_id: observed.task_id,
            });
        }
        if task.project_id != observed.project_id {
            return Err(CoreError::NotFound);
        }
        if task.branch.as_ref() == Some(&observed.binding) {
            return self.task_projection(task);
        }
        if task.branch.is_some() {
            return Err(CoreError::TaskBranchAlreadyBound {
                task_id: task.id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| operation.task_id == observed.task_id)
        {
            return Err(CoreError::ProvisioningAlreadyInProgress {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| operation.task_id == observed.task_id)
        {
            return Err(CoreError::RepairInProgress {
                task_id: observed.task_id.clone(),
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(holder) = self.store.tasks().iter().find(|candidate| {
            candidate.id != observed.task_id
                && candidate.project_id == observed.project_id
                && candidate.branch.as_ref() == Some(&observed.binding)
        }) {
            return Err(CoreError::BranchHeldByTask {
                task_id: holder.id.clone(),
            });
        }
        if let Some(holder) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| {
                operation.task_id != observed.task_id
                    && operation.project_id == observed.project_id
                    && operation.spec.repository_root == observed.binding.repository_root
                    && operation.spec.branch_name == observed.binding.name
            })
        {
            return Err(CoreError::BranchHeldByTask {
                task_id: holder.task_id.clone(),
            });
        }
        let task = self
            .store
            .bind_task_branch(
                &self.write_authority,
                &observed.task_id,
                observed.binding,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.task_projection(&task)
    }

    pub fn bind_task_branch(&mut self, params: Value) -> Result<Value, CoreError> {
        let observed = self.plan_task_branch_binding(params)?.observe()?;
        self.complete_task_branch_binding(observed)
    }
}
