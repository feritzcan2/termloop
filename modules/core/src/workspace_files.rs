//! Ephemeral file observations scoped to a durable Project or managed Task root.
use std::path::{Path, PathBuf};

use serde_json::Value;
use termloop_domain::ManagedWorktreeProof;

use crate::{CoreError, CoreRuntime, json_error};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceFilesPlan {
    project_id: String,
    project_folder: PathBuf,
    task_id: Option<String>,
    proof: Option<ManagedWorktreeProof>,
    path: String,
}

pub struct ObservedWorkspaceFiles {
    plan: WorkspaceFilesPlan,
    result: Result<Value, CoreError>,
}

impl WorkspaceFilesPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe_directory(self) -> ObservedWorkspaceFiles {
        self.observe_directory_page(None)
    }

    pub fn observe_directory_page(self, after_name: Option<&str>) -> ObservedWorkspaceFiles {
        let result = (|| {
            let root = self.root();
            let listing =
                termloop_platform::list_workspace_directory_page(root, &self.path, after_name)
                    .map_err(file_error)?;
            serde_json::to_value(listing).map_err(json_error)
        })();
        ObservedWorkspaceFiles { plan: self, result }
    }

    pub fn observe_file(self) -> ObservedWorkspaceFiles {
        let result = (|| {
            let root = self.root();
            let content =
                termloop_platform::read_workspace_file(root, &self.path).map_err(file_error)?;
            serde_json::to_value(content).map_err(json_error)
        })();
        ObservedWorkspaceFiles { plan: self, result }
    }

    fn root(&self) -> &Path {
        self.proof
            .as_ref()
            .map_or(self.project_folder.as_path(), |proof| {
                Path::new(&proof.registered_worktree_path)
            })
    }
}

impl CoreRuntime {
    pub fn plan_workspace_files(
        &self,
        project_id: &str,
        task_id: Option<&str>,
        path: &str,
    ) -> Result<WorkspaceFilesPlan, CoreError> {
        termloop_platform::validate_workspace_relative_path(path).map_err(|_| {
            CoreError::InvalidParams("path must be relative to the workspace".into())
        })?;
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let project = self
            .store
            .projects()
            .iter()
            .find(|p| p.id == project_id)
            .ok_or(CoreError::NotFound)?;
        let proof = if let Some(task_id) = task_id {
            let task = self
                .store
                .tasks()
                .iter()
                .find(|t| t.id == task_id && t.project_id == project_id)
                .ok_or(CoreError::NotFound)?;
            let proof = self
                .store
                .managed_worktrees()
                .iter()
                .find(|p| p.task_id == task_id)
                .ok_or_else(|| CoreError::TaskWorktreeRequired {
                    task_id: task_id.to_owned(),
                })?;
            if task.worktree.as_ref().map(|w| w.path.as_str())
                != Some(proof.registered_worktree_path.as_str())
                || task.worktree_generation != proof.worktree_generation
            {
                return Err(changed_proof(proof));
            }
            Some(proof.clone())
        } else {
            None
        };
        Ok(WorkspaceFilesPlan {
            project_id: project_id.to_owned(),
            project_folder: PathBuf::from(&project.folder_path),
            task_id: task_id.map(str::to_owned),
            proof,
            path: path.to_owned(),
        })
    }

    pub fn complete_workspace_files(
        &self,
        observed: ObservedWorkspaceFiles,
    ) -> Result<Value, CoreError> {
        let plan = &observed.plan;
        let current =
            self.plan_workspace_files(&plan.project_id, plan.task_id.as_deref(), &plan.path)?;
        if current != *plan {
            return Err(current
                .proof
                .as_ref()
                .map_or(CoreError::RepositoryUnavailable, changed_proof));
        }
        observed.result
    }
}

fn changed_proof(proof: &ManagedWorktreeProof) -> CoreError {
    CoreError::ManagedWorktreeProofChanged {
        task_id: proof.task_id.clone(),
        current_managed_worktree_operation_id: Some(proof.operation_id.clone()),
        current_worktree_generation: proof.worktree_generation,
    }
}

fn file_error(error: std::io::Error) -> CoreError {
    match error.kind() {
        std::io::ErrorKind::NotFound => CoreError::NotFound,
        std::io::ErrorKind::PermissionDenied => CoreError::RepositoryPermissionDenied,
        std::io::ErrorKind::InvalidInput => CoreError::InvalidParams(error.to_string()),
        _ => CoreError::RepositoryUnavailable,
    }
}
