//! Project command/projection ownership boundary.

mod architecture;
mod changes;
pub use architecture::ProjectArchitecturePlan;
pub(crate) use changes::ProjectChangeObservationCache;
pub use changes::{
    ObservedProjectWorktreeChanges, ObservedProjectWorktreeDiff, ObservedProjectWorktreePreImage,
    ProjectWorktreeChangeListPlan, ProjectWorktreeDiffPlan, ProjectWorktreePreImagePlan,
};

use crate::{
    CodexRuntime, CoreError, CoreRuntime, ProjectDeleteBlocker, json_error, required_string,
    store_error, terminal_error,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::PathBuf;
use termloop_domain::{
    PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT, ProjectRecord,
    ProjectTaskAutomationConfiguration,
};
use termloop_gitio::{GitError, GitFailureKind, GitRunner, HeadState, RegisteredPathState};
use uuid::Uuid;

pub struct ProjectLocalBranchListPlan {
    project_folder: PathBuf,
}

pub struct ProjectWorktreeSummaryPlan {
    project_id: String,
    project_folder: PathBuf,
}

pub struct ProjectDeletePlan {
    project_id: String,
    session_ids: Vec<String>,
    task_source_ids: Vec<String>,
}

pub struct ProjectDeleteCommit {
    pub result: Value,
    pub retired_runtimes: Vec<CodexRuntime>,
    pub session_ids: Vec<String>,
    pub changed_cwds: Vec<String>,
}

impl CoreRuntime {
    pub(crate) fn create_project(&mut self, params: Value) -> Result<Value, CoreError> {
        let folder_path = canonical_project_folder(&params)?;
        let project = ProjectRecord {
            id: Uuid::new_v4().to_string(),
            name: project_name(&params)?,
            folder_path,
        };
        self.store
            .insert_project(&self.write_authority, project.clone())
            .map_err(store_error)?;
        serde_json::to_value(project).map_err(json_error)
    }

    pub(crate) fn list_projects(&self) -> Result<Value, CoreError> {
        serde_json::to_value(self.store.projects()).map_err(json_error)
    }

    pub fn project_task_automation_configuration(
        &self,
        project_id: &str,
    ) -> Result<ProjectTaskAutomationConfiguration, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        Ok(self
            .store
            .project_task_automation_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .cloned()
            .unwrap_or_else(|| ProjectTaskAutomationConfiguration {
                project_id: project_id.to_owned(),
                create_worktree: false,
                worktree_prefix: PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT.into(),
                base_ref: None,
                agent_id: None,
                model: None,
                permission: None,
                reasoning: None,
                kickoff_message: None,
            }))
    }

    pub(crate) fn get_project_task_automation(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let configuration = self.project_task_automation_configuration(&project_id)?;
        Ok(json!({
            "configuration": configuration,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn set_project_task_automation(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let create_worktree = params
            .get("createWorktree")
            .and_then(Value::as_bool)
            .ok_or_else(|| CoreError::InvalidParams("createWorktree".into()))?;
        let worktree_prefix = required_string(&params, "worktreePrefix")?
            .trim()
            .to_owned();
        let base_ref = nullable_trimmed_string(&params, "baseRef")?;
        let agent_id = nullable_trimmed_string(&params, "agentId")?;
        let model = nullable_trimmed_string(&params, "model")?;
        let permission = nullable_trimmed_string(&params, "permission")?;
        let reasoning = nullable_trimmed_string(&params, "reasoning")?;
        let kickoff_message = nullable_trimmed_string(&params, "kickoffMessage")?;
        let expected_revision = params
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))?;
        let configuration = ProjectTaskAutomationConfiguration {
            project_id,
            create_worktree,
            worktree_prefix,
            base_ref,
            agent_id,
            model,
            permission,
            reasoning,
            kickoff_message,
        };
        if !configuration.is_valid() {
            return Err(CoreError::InvalidParams("taskAutomation".into()));
        }
        self.store
            .set_project_task_automation_configuration(
                &self.write_authority,
                configuration.clone(),
                expected_revision,
            )
            .map_err(store_error)?;
        Ok(json!({
            "configuration": configuration,
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn project_projection_for_executor(&self, project_id: &str) -> Result<Value, CoreError> {
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        serde_json::to_value(vec![project]).map_err(json_error)
    }

    pub fn plan_project_local_branch_list(
        &self,
        project_id: &str,
    ) -> Result<ProjectLocalBranchListPlan, CoreError> {
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        Ok(ProjectLocalBranchListPlan {
            project_folder: PathBuf::from(&project.folder_path),
        })
    }

    pub fn plan_project_worktree_summary(
        &self,
        project_id: &str,
    ) -> Result<ProjectWorktreeSummaryPlan, CoreError> {
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        Ok(ProjectWorktreeSummaryPlan {
            project_id: project.id.clone(),
            project_folder: PathBuf::from(&project.folder_path),
        })
    }

    pub(crate) fn update_project_details(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let name = project_name(&params)?;
        let folder_path = canonical_project_folder(&params)?;
        let project = self
            .store
            .update_project_details(&self.write_authority, &project_id, name, folder_path)
            .map_err(store_error)?;
        serde_json::to_value(project).map_err(json_error)
    }

    pub(crate) fn delete_project(&mut self, params: Value) -> Result<Value, CoreError> {
        let plan = self.begin_project_delete(params)?;
        let terminal = self.terminal_service();
        for session_id in plan.session_ids() {
            let contains_session = match terminal.contains_session(session_id) {
                Ok(contains_session) => contains_session,
                Err(error) => {
                    self.cancel_project_delete(&plan);
                    return Err(terminal_error(error));
                }
            };
            if contains_session && let Err(error) = terminal.terminate(session_id) {
                self.cancel_project_delete(&plan);
                return Err(terminal_error(error));
            }
        }
        let commit = self.complete_project_delete(plan)?;
        drop(commit.retired_runtimes);
        Ok(commit.result)
    }

    pub fn begin_project_delete(&mut self, params: Value) -> Result<ProjectDeletePlan, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self
            .store
            .projects()
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(CoreError::NotFound);
        }
        if self.project_delete_reservations.contains(&project_id)
            || self
                .project_assistant_reset_reservations
                .contains(&project_id)
        {
            return Err(CoreError::RevisionConflict);
        }
        if self.project_delete_has_worktree(&project_id) {
            return Err(CoreError::ProjectDeleteBlocked(
                ProjectDeleteBlocker::Worktrees,
            ));
        }
        let session_ids = self
            .store
            .sessions()
            .iter()
            .filter(|session| session.project_id == project_id)
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let task_source_ids = self
            .store
            .task_source_configurations()
            .iter()
            .filter(|source| source.project_id == project_id)
            .map(|source| source.id.clone())
            .collect::<Vec<_>>();
        self.project_delete_reservations.insert(project_id.clone());
        Ok(ProjectDeletePlan {
            project_id,
            session_ids,
            task_source_ids,
        })
    }

    pub fn cancel_project_delete(&mut self, plan: &ProjectDeletePlan) {
        self.project_delete_reservations.remove(&plan.project_id);
    }

    pub fn complete_project_delete(
        &mut self,
        plan: ProjectDeletePlan,
    ) -> Result<ProjectDeleteCommit, CoreError> {
        let project_id = plan.project_id;
        if !self.project_delete_reservations.contains(&project_id) {
            return Err(CoreError::RevisionConflict);
        }
        if !self
            .store
            .projects()
            .iter()
            .any(|project| project.id == project_id)
        {
            self.project_delete_reservations.remove(&project_id);
            return Err(CoreError::NotFound);
        }
        if self.project_delete_has_worktree(&project_id) {
            self.project_delete_reservations.remove(&project_id);
            return Err(CoreError::ProjectDeleteBlocked(
                ProjectDeleteBlocker::Worktrees,
            ));
        }
        let task_ids = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        let sessions = self
            .store
            .sessions()
            .iter()
            .filter(|session| session.project_id == project_id)
            .map(|session| (session.id.clone(), session.process.cwd.clone()))
            .collect::<Vec<_>>();
        let session_ids = sessions
            .iter()
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        let session_id_set = session_ids.iter().cloned().collect::<HashSet<_>>();
        let changed_cwds = sessions
            .into_iter()
            .map(|(_, cwd)| cwd)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        self.store
            .delete_project_and_related_records(&self.write_authority, &project_id)
            .map_err(store_error)
            .inspect_err(|_| {
                self.project_delete_reservations.remove(&project_id);
            })?;
        let retired_runtimes = session_ids
            .iter()
            .filter_map(|session_id| self.codex_runtimes.remove(session_id))
            .collect::<Vec<_>>();
        for session_id in &session_ids {
            self.agent_observations.remove(session_id);
            self.daemon_restart_handoffs.remove(session_id);
            self.agent_terminal_holds.remove(session_id);
            self.resume_reservations.remove(session_id);
            self.provider_history_repair_reservations.remove(session_id);
            self.resume_ready.remove(session_id);
            self.resume_failure_reaps.remove(session_id);
            self.pending_agent_forks.remove(session_id);
            self.pending_agent_resume_refs.remove(session_id);
            self.agent_conversation_activity.remove(session_id);
            self.claude_turn_watches.remove(session_id);
            self.forget_ask_to_session(session_id);
        }
        self.fork_source_session_ids
            .retain(|session_id, source_id| {
                !session_id_set.contains(session_id) && !session_id_set.contains(source_id)
            });
        self.retain_run_runtimes_outside_project(&project_id);
        self.git_host_invalidated_tasks
            .retain(|task_id| !task_ids.contains(task_id));
        for task_id in &task_ids {
            self.clear_task_worktree_projections(task_id);
            self.git_host_change_observations.remove_task(task_id);
        }
        // Runtime projections of a deleted Project have no subject left, and
        // several of them hold its file lists, diffs, or pending launch
        // payloads. They are bounded and disposable, but a deleted Project must
        // not be readable through one of them until its TTL happens to pass.
        let task_id_set = task_ids.iter().cloned().collect::<HashSet<_>>();
        self.project_change_observations
            .retain_outside_project(&project_id);
        self.worktree_change_observations
            .retain_outside_tasks(&task_id_set);
        self.branch_commit_observations
            .retain_outside_tasks(&task_id_set);
        self.git_host_projections
            .retain_outside_project(&project_id);
        self.retain_previews_outside_project(&project_id, &session_id_set, &task_id_set);
        self.project_delete_reservations.remove(&project_id);
        self.retain_current_tracker_runtime();
        self.retain_current_task_source_runtime();
        Ok(ProjectDeleteCommit {
            result: serde_json::json!({ "projectId": project_id, "deleted": true }),
            retired_runtimes,
            session_ids,
            changed_cwds,
        })
    }

    /// Drops every inspected-but-unconfirmed preview bound to the deleted
    /// Project, its Sessions, or its Tasks. Each ticket carries a launch or
    /// retirement authorization for a subject that no longer exists, so none of
    /// them may survive the delete and wait for a confirmation.
    fn retain_previews_outside_project(
        &mut self,
        project_id: &str,
        session_ids: &HashSet<String>,
        task_ids: &HashSet<String>,
    ) {
        self.quick_action_previews
            .retain(|(_, ticket)| ticket.project_id() != project_id);
        self.agent_launch_previews
            .retain(|(_, ticket)| ticket.project_id() != project_id);
        self.agent_resume_previews
            .retain(|(_, ticket)| !session_ids.contains(ticket.session_id()));
        self.session_relocation_previews
            .retain(|(_, ticket)| ticket.project_id() != project_id);
        self.session_archive_previews
            .retain(|(_, ticket)| !session_ids.contains(ticket.session_id()));
        self.task_archive_previews
            .retain(|(_, ticket)| !task_ids.contains(ticket.task_id()));
    }

    fn project_delete_has_worktree(&self, project_id: &str) -> bool {
        let task_ids = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.id.as_str())
            .collect::<HashSet<_>>();
        self.store
            .tasks()
            .iter()
            .any(|task| task.project_id == project_id && task.worktree.is_some())
            || self
                .store
                .provisioning_operations()
                .iter()
                .any(|operation| task_ids.contains(operation.task_id.as_str()))
            || self
                .store
                .managed_worktrees()
                .iter()
                .any(|proof| task_ids.contains(proof.task_id.as_str()))
            || self
                .store
                .cleanup_operations()
                .iter()
                .any(|operation| task_ids.contains(operation.task_id.as_str()))
            || self
                .store
                .repair_operations()
                .iter()
                .any(|operation| task_ids.contains(operation.task_id.as_str()))
            || self
                .store
                .stale_resolution_operations()
                .iter()
                .any(|operation| task_ids.contains(operation.task_id.as_str()))
    }
}

impl ProjectDeletePlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn session_ids(&self) -> &[String] {
        &self.session_ids
    }

    pub fn task_source_ids(&self) -> &[String] {
        &self.task_source_ids
    }
}

impl ProjectLocalBranchListPlan {
    pub fn observe(self) -> Result<Value, CoreError> {
        let runner =
            GitRunner::discover_with_timeout(termloop_gitio::HEALTH_GIT_SUBPROCESS_DEADLINE)
                .map_err(map_git_observation_error)?;
        self.observe_with_runner(&runner)
    }

    fn observe_with_runner(self, runner: &GitRunner) -> Result<Value, CoreError> {
        let identity = runner
            .inspect_repository(&self.project_folder)
            .map_err(map_project_repository_error)?;
        if identity.bare {
            return Err(CoreError::RepositoryUnavailable);
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
            RegisteredPathState::Present { canonical_path } => canonical_path,
            RegisteredPathState::Missing | RegisteredPathState::NotDirectory => {
                return Err(CoreError::RepositoryUnavailable);
            }
        };
        let repository_root = repository_root
            .to_str()
            .ok_or(CoreError::RepositoryUnavailable)?
            .to_owned();
        let observed = runner
            .list_local_branches(&identity.resolved_path)
            .map_err(map_git_observation_error)?;
        let remote_branches = runner
            .list_remote_branches(&identity.resolved_path)
            .map_err(map_git_observation_error)?;
        project_local_branch_projection(repository_root, observed, remote_branches)
    }
}

impl ProjectWorktreeSummaryPlan {
    pub fn observe(self) -> Result<Value, CoreError> {
        let runner =
            GitRunner::discover_with_timeout(termloop_gitio::HEALTH_GIT_SUBPROCESS_DEADLINE)
                .map_err(map_git_observation_error)?;
        let observed = runner
            .inspect_worktree_health(&self.project_folder)
            .map_err(map_project_repository_error)?;
        let checked_out_branch = match &observed.repository.head {
            HeadState::Attached { branch, .. } | HeadState::Unborn { branch } => {
                local_branch_name(branch.as_bytes())?
            }
            HeadState::Detached { .. } => None,
        };
        let change_count = observed
            .status
            .change_count
            .ok_or(CoreError::RepositoryUnavailable)?;
        Ok(serde_json::json!({
            "project_id": self.project_id,
            "checked_out_branch": checked_out_branch,
            "change_count": change_count,
        }))
    }
}

fn local_branch_name(reference: &[u8]) -> Result<Option<&str>, CoreError> {
    let reference = std::str::from_utf8(reference).map_err(|_| CoreError::RepositoryUnavailable)?;
    let branch = reference
        .strip_prefix("refs/heads/")
        .ok_or(CoreError::RepositoryUnavailable)?;
    if branch.is_empty() || branch.chars().count() > 1024 {
        return Err(CoreError::RepositoryUnavailable);
    }
    Ok(Some(branch))
}

fn project_local_branch_projection(
    repository_root: String,
    observed: termloop_gitio::LocalBranchList,
    remote_branches: termloop_gitio::RemoteBranchList,
) -> Result<Value, CoreError> {
    let mut truncated = observed.truncated;
    let mut branches = Vec::with_capacity(observed.branches.len());
    for reference in observed.branches {
        let Ok(exact_ref) = std::str::from_utf8(reference.as_bytes()) else {
            truncated = true;
            continue;
        };
        let Some(name) = exact_ref.strip_prefix("refs/heads/") else {
            return Err(CoreError::RepositoryUnavailable);
        };
        if name.is_empty() || name.chars().count() > 1024 || exact_ref.chars().count() > 1024 {
            truncated = true;
            continue;
        }
        branches.push(serde_json::json!({
            "name": name,
            "exact_ref": exact_ref,
        }));
    }
    let mut base_branches_truncated = remote_branches.truncated;
    let mut base_branches = Vec::with_capacity(remote_branches.branches.len());
    for reference in remote_branches.branches {
        let Ok(exact_ref) = std::str::from_utf8(reference.as_bytes()) else {
            base_branches_truncated = true;
            continue;
        };
        let Some(name) = exact_ref.strip_prefix("refs/remotes/") else {
            return Err(CoreError::RepositoryUnavailable);
        };
        if name.is_empty()
            || !name.contains('/')
            || name.ends_with("/HEAD")
            || name.chars().count() > 1024
            || exact_ref.chars().count() > 1024
        {
            base_branches_truncated = true;
            continue;
        }
        base_branches.push(serde_json::json!({
            "name": name,
            "exact_ref": exact_ref,
        }));
    }
    Ok(serde_json::json!({
        "repository_root": repository_root,
        "branches": branches,
        "base_branches": base_branches,
        "base_branches_truncated": base_branches_truncated,
        "truncated": truncated,
    }))
}

fn map_project_repository_error(error: GitError) -> CoreError {
    match error {
        GitError::NotRepository | GitError::MissingRegistration => CoreError::RepositoryUnavailable,
        error => map_git_observation_error(error),
    }
}

fn map_git_observation_error(error: GitError) -> CoreError {
    match error {
        GitError::GitUnavailable => CoreError::GitUnavailable,
        GitError::UnsupportedVersion { .. } => CoreError::GitUnsupportedVersion,
        GitError::PermissionDenied { .. } => CoreError::RepositoryPermissionDenied,
        GitError::Timeout { .. } => CoreError::GitObservationTimedOut,
        GitError::OutputLimitExceeded { .. } => CoreError::GitObservationOutputBound,
        GitError::CommandFailed {
            kind: GitFailureKind::CorruptRepository | GitFailureKind::InvalidConfiguration,
            ..
        } => CoreError::CorruptRepository,
        GitError::CommandFailed {
            kind: GitFailureKind::UnsupportedRepository,
            ..
        } => CoreError::UnsupportedRepository,
        GitError::CommandFailed {
            kind: GitFailureKind::DubiousOwnership,
            ..
        } => CoreError::RepositoryPermissionDenied,
        _ => CoreError::RepositoryUnavailable,
    }
}

fn nullable_trimmed_string(params: &Value, field: &str) -> Result<Option<String>, CoreError> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim().to_owned())),
        _ => Err(CoreError::InvalidParams(field.into())),
    }
}

fn project_name(params: &Value) -> Result<String, CoreError> {
    let name = required_string(params, "name")?;
    let name = name.trim();
    if name.chars().count() > 120 {
        return Err(CoreError::InvalidParams("name".into()));
    }
    Ok(name.to_owned())
}

fn canonical_project_folder(params: &Value) -> Result<String, CoreError> {
    let folder_path = required_string(params, "folderPath")?;
    termloop_platform::canonical_existing_directory(&folder_path)
        .map_err(|_| CoreError::InvalidParams("folderPath".into()))?
        .into_os_string()
        .into_string()
        .map_err(|_| CoreError::InvalidParams("folderPath".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use termloop_store::Store;
    use termloop_terminal::TerminalService;

    fn runtime() -> (CoreRuntime, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-project-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        (
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap(),
            path,
        )
    }

    #[test]
    fn project_creation_requires_a_real_absolute_directory() {
        let (mut runtime, state_path) = runtime();
        assert!(matches!(
            runtime.create_project(json!({ "name": "Bad", "folderPath": "relative" })),
            Err(CoreError::InvalidParams(field)) if field == "folderPath"
        ));
        let missing = std::env::temp_dir().join(format!("missing-{}", Uuid::new_v4()));
        assert!(matches!(
            runtime.create_project(json!({ "name": "Missing", "folderPath": missing })),
            Err(CoreError::InvalidParams(field)) if field == "folderPath"
        ));
        assert!(
            runtime
                .list_projects()
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn project_creation_persists_the_canonical_directory() {
        let (mut runtime, state_path) = runtime();
        let directory = std::env::temp_dir();
        let project = runtime
            .create_project(json!({ "name": "  Valid  ", "folderPath": directory }))
            .unwrap();
        assert_eq!(project["name"], "Valid");
        assert_eq!(
            project["folder_path"],
            termloop_platform::canonical_existing_directory_path(&directory)
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap()
        );
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn project_task_automation_defaults_off_and_is_revision_checked() {
        let (mut runtime, state_path) = runtime();
        let project = runtime
            .create_project(json!({ "name": "Automation", "folderPath": std::env::temp_dir() }))
            .unwrap();
        let project_id = project["id"].as_str().unwrap();
        let initial = runtime
            .get_project_task_automation(json!({ "projectId": project_id }))
            .unwrap();
        assert_eq!(initial["configuration"]["createWorktree"], false);
        assert_eq!(initial["configuration"]["worktreePrefix"], "termloop");
        assert_eq!(initial["configuration"]["baseRef"], Value::Null);
        assert_eq!(initial["configuration"]["agentId"], Value::Null);
        let revision = initial["stateRevision"].as_u64().unwrap();
        let updated = runtime
            .set_project_task_automation(json!({
                "projectId": project_id,
                "createWorktree": true,
                "worktreePrefix": "feature",
                "baseRef": "refs/remotes/origin/development",
                "agentId": "codex",
                "model": "gpt-5.6-sol",
                "permission": "bypassPermissions",
                "reasoning": "high",
                "kickoffMessage": "Implement and verify this Task.",
                "expectedRevision": revision,
            }))
            .unwrap();
        assert_eq!(updated["configuration"]["agentId"], "codex");
        assert_eq!(updated["configuration"]["worktreePrefix"], "feature");
        assert_eq!(
            updated["configuration"]["baseRef"],
            "refs/remotes/origin/development"
        );
        assert_eq!(updated["configuration"]["model"], "gpt-5.6-sol");
        assert_eq!(updated["configuration"]["permission"], "bypassPermissions");
        assert_eq!(updated["configuration"]["reasoning"], "high");
        assert_eq!(
            updated["configuration"]["kickoffMessage"],
            "Implement and verify this Task."
        );
        assert!(matches!(
            runtime.set_project_task_automation(json!({
                "projectId": project_id,
                "createWorktree": false,
                "worktreePrefix": "termloop",
                "baseRef": null,
                "agentId": null,
                "model": null,
                "permission": null,
                "reasoning": null,
                "kickoffMessage": null,
                "expectedRevision": revision,
            })),
            Err(CoreError::RevisionConflict)
        ));
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn project_details_update_atomically_and_survive_reopen() {
        let (mut runtime, state_path) = runtime();
        let project = runtime
            .create_project(json!({ "name": "Before", "folderPath": std::env::temp_dir() }))
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        let directory = std::env::temp_dir().join(format!("termloop-project-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let updated = runtime
            .update_project_details(json!({
                "projectId": project_id,
                "name": "  After  ",
                "folderPath": directory
            }))
            .unwrap();
        assert_eq!(updated["name"], "After");
        assert_eq!(
            updated["folder_path"],
            termloop_platform::canonical_existing_directory_path(&directory)
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap()
        );
        let revision = runtime.state_revision();
        let missing = std::env::temp_dir().join(format!("missing-{}", Uuid::new_v4()));
        assert!(matches!(
            runtime.update_project_details(json!({
                "projectId": project_id,
                "name": "Partial",
                "folderPath": missing
            })),
            Err(CoreError::InvalidParams(field)) if field == "folderPath"
        ));
        assert_eq!(runtime.state_revision(), revision);
        assert_eq!(runtime.list_projects().unwrap()[0]["name"], "After");
        drop(runtime);
        let reopened = CoreRuntime::open(&state_path, TerminalService::default(), 2).unwrap();
        assert_eq!(reopened.list_projects().unwrap()[0], updated);
        let _ = std::fs::remove_file(state_path);
        let _ = std::fs::remove_dir(directory);
    }

    #[test]
    fn project_delete_blocks_a_task_worktree() {
        let (mut runtime, state_path) = runtime();
        let project = runtime
            .create_project(json!({ "name": "Delete", "folderPath": std::env::temp_dir() }))
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        runtime
            .store
            .insert_task(
                &runtime.write_authority,
                termloop_domain::TaskRecord {
                    id: "task-1".into(),
                    project_id: project_id.clone(),
                    title: "Task".into(),
                    brief: None,
                    developer_notes: vec![],
                    status: termloop_domain::TaskStatus::Open,
                    archived_at_epoch_ms: None,
                    branch: None,
                    worktree: None,
                    worktree_generation: 0,
                    steward_brief_markdown: String::new(),
                    steward_brief_revision: 1,
                    rank: 0,
                    created_at_epoch_ms: 1,
                    updated_at_epoch_ms: 1,
                },
            )
            .unwrap();
        let repository_root = std::env::temp_dir().to_string_lossy().into_owned();
        runtime
            .store
            .begin_task_worktree_provisioning(
                &runtime.write_authority,
                termloop_domain::WorktreeProvisioningOperation {
                    operation_id: "provision-task-1".into(),
                    task_id: "task-1".into(),
                    project_id: project_id.clone(),
                    spec: termloop_domain::NormalizedWorktreeSpec {
                        version: 1,
                        repository_root: repository_root.clone(),
                        repository_common_dir: format!("{repository_root}/.git"),
                        destination_path: format!("{repository_root}/task-1"),
                        branch_name: "feature/task-1".into(),
                        branch_mode: termloop_domain::ProvisioningBranchMode::Create,
                        base_ref: Some("refs/heads/main".into()),
                        base_oid: Some("a".repeat(40)),
                    },
                    stage: termloop_domain::ProvisioningStage::Reserved,
                    created_branch_ref: false,
                    failure: None,
                    started_at_epoch_ms: 1,
                    updated_at_epoch_ms: 1,
                },
            )
            .unwrap();
        assert!(matches!(
            runtime.delete_project(json!({ "projectId": project_id })),
            Err(CoreError::ProjectDeleteBlocked(
                ProjectDeleteBlocker::Worktrees
            ))
        ));
        assert!(runtime.project_exists(&project_id));
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn project_delete_cascades_tasks_and_force_closes_running_sessions() {
        let (mut runtime, state_path) = runtime();
        let project = runtime
            .create_project(json!({ "name": "Delete", "folderPath": std::env::temp_dir() }))
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        runtime
            .store
            .insert_task(
                &runtime.write_authority,
                termloop_domain::TaskRecord {
                    id: "task-1".into(),
                    project_id: project_id.clone(),
                    title: "Task".into(),
                    brief: None,
                    developer_notes: vec![],
                    status: termloop_domain::TaskStatus::Open,
                    archived_at_epoch_ms: None,
                    branch: None,
                    worktree: None,
                    worktree_generation: 0,
                    steward_brief_markdown: String::new(),
                    steward_brief_revision: 1,
                    rank: 0,
                    created_at_epoch_ms: 1,
                    updated_at_epoch_ms: 1,
                },
            )
            .unwrap();
        let session = runtime
            .launch_terminal(json!({
                "projectId": project_id,
                "cwd": std::env::temp_dir(),
            }))
            .unwrap();
        let session_id = session["id"].as_str().unwrap().to_owned();
        assert!(runtime.terminal.contains_session(&session_id).unwrap());
        let reservation = runtime
            .begin_project_delete(json!({ "projectId": project_id }))
            .unwrap();
        assert!(!runtime.project_exists(&project_id));
        runtime.cancel_project_delete(&reservation);
        assert!(runtime.project_exists(&project_id));
        assert_eq!(
            runtime
                .delete_project(json!({ "projectId": project_id }))
                .unwrap(),
            json!({ "projectId": project_id, "deleted": true })
        );
        assert!(runtime.store.projects().is_empty());
        assert!(runtime.store.tasks().is_empty());
        assert!(runtime.store.sessions().is_empty());
        assert!(!runtime.terminal.contains_session(&session_id).unwrap());
        assert!(matches!(
            runtime.delete_project(json!({ "projectId": project_id })),
            Err(CoreError::NotFound)
        ));
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn local_branch_projection_is_read_only_lossless_and_marks_omissions() {
        let (runtime, state_path) = runtime();
        assert!(matches!(
            runtime.plan_project_local_branch_list("missing"),
            Err(CoreError::NotFound)
        ));
        let revision = runtime.state_revision();
        let projection = project_local_branch_projection(
            "/repository".into(),
            termloop_gitio::LocalBranchList {
                branches: vec![
                    termloop_gitio::GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap(),
                    termloop_gitio::GitRefName::from_bytes(b"refs/heads/non-\xff".to_vec())
                        .unwrap(),
                ],
                truncated: false,
            },
            termloop_gitio::RemoteBranchList {
                branches: vec![
                    termloop_gitio::GitRefName::from_bytes(
                        b"refs/remotes/origin/development".to_vec(),
                    )
                    .unwrap(),
                    termloop_gitio::GitRefName::from_bytes(
                        b"refs/remotes/origin/non-\xff".to_vec(),
                    )
                    .unwrap(),
                ],
                truncated: false,
            },
        )
        .unwrap();
        assert_eq!(
            projection,
            json!({
                "repository_root": "/repository",
                "branches": [{ "name": "main", "exact_ref": "refs/heads/main" }],
                "base_branches": [{
                    "name": "origin/development",
                    "exact_ref": "refs/remotes/origin/development"
                }],
                "base_branches_truncated": true,
                "truncated": true,
            })
        );
        assert_eq!(runtime.state_revision(), revision);
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn project_worktree_summary_uses_only_an_exact_utf8_local_branch() {
        assert_eq!(
            local_branch_name(b"refs/heads/feature/sidebar").unwrap(),
            Some("feature/sidebar")
        );
        assert!(local_branch_name(b"refs/remotes/origin/main").is_err());
        assert!(local_branch_name(b"refs/heads/non-\xff").is_err());
    }

    #[test]
    fn project_worktree_summary_observes_the_project_checkout_without_writing_state() {
        let (mut runtime, state_path) = runtime();
        let directory =
            std::env::temp_dir().join(format!("termloop-project-summary-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let runner = GitRunner::discover().unwrap();
        termloop_gitio::test_support::initialize_repository(&runner, &directory).unwrap();
        std::fs::write(directory.join("changed.txt"), b"local\n").unwrap();
        let project = runtime
            .create_project(json!({ "name": "Summary", "folderPath": directory }))
            .unwrap();
        let revision = runtime.state_revision();

        let project_id = project["id"].as_str().unwrap();
        let mut summary = None;
        for _ in 0..4 {
            match runtime
                .plan_project_worktree_summary(project_id)
                .unwrap()
                .observe()
            {
                Ok(observed) => {
                    summary = Some(observed);
                    break;
                }
                Err(CoreError::GitObservationTimedOut) => {}
                Err(error) => panic!("project summary observation failed: {error:?}"),
            }
        }
        let summary = summary.expect("project summary observation repeatedly timed out");

        assert_eq!(summary["checked_out_branch"], "main");
        assert_eq!(summary["change_count"], 1);
        assert_eq!(runtime.state_revision(), revision);
        drop(runtime);
        let _ = std::fs::remove_file(state_path);
        let _ = std::fs::remove_dir_all(directory);
    }
}
