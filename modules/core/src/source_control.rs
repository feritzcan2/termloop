//! Explicit Source Control requests for a Project checkout or managed Task
//! worktree: one status read plus the index, commit, and remote operations the
//! user asks for. Git output and file lists stay in a bounded runtime cache and
//! never become durable state.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use termloop_gitio::{
    GitError, GitFailureKind, GitRunner, HeadState, SourceControlRejection,
    SourceControlStatusObservation, WorktreeChangeEntry, WorktreeChangeKind, WorktreeChangeSide,
};

use crate::error::SourceControlRefusal;
use crate::workspace_files::WorkspaceFilesPlan;
use crate::{CoreError, CoreRuntime, required_string};

#[cfg(test)]
mod tests;

const OBSERVATION_CAP: usize = 64;
const ENTRY_SELECTION_MAX: usize = termloop_gitio::CHANGE_LIST_MAX_ENTRIES;
const COMMIT_MESSAGE_MAX_BYTES: usize = 64 * 1024;

/// The exact checkout a request addresses: the root the store names, plus
/// the repository identity Git reported for it when the status was read.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceControlProof {
    root: WorkspaceFilesPlan,
    worktree_root: PathBuf,
    common_dir: PathBuf,
}

#[derive(Clone)]
pub struct SourceControlRootPlan {
    root: WorkspaceFilesPlan,
}

pub struct ObservedSourceControlStatus {
    root: WorkspaceFilesPlan,
    observation: Result<(SourceControlProof, SourceControlStatusObservation), CoreError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PathAction {
    Stage,
    Unstage,
    Discard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceControlSync {
    Push,
    Pull,
    Fetch,
}

#[derive(Clone, Debug)]
enum Mutation {
    Paths {
        action: PathAction,
        tracked: Vec<PathBuf>,
        untracked: Vec<PathBuf>,
    },
    Commit {
        message: String,
    },
    Sync(SourceControlSync),
}

/// A validated request, executed outside the core lock against a freshly
/// re-inspected repository.
pub struct SourceControlMutationPlan {
    root: WorkspaceFilesPlan,
    /// Set when the request selected entries from an earlier status read; the
    /// checkout must still be that repository.
    expected: Option<SourceControlProof>,
    mutation: Mutation,
}

pub struct ExecutedSourceControl {
    root: WorkspaceFilesPlan,
    result: Result<Value, CoreError>,
}

struct CachedStatus {
    observation_id: String,
    proof: SourceControlProof,
    entries: Vec<WorktreeChangeEntry>,
}

#[derive(Default)]
pub(crate) struct SourceControlObservationCache {
    entries: VecDeque<CachedStatus>,
    next_sequence: u64,
}

impl SourceControlObservationCache {
    pub(crate) fn retain_outside_project(&mut self, project_id: &str) {
        self.entries
            .retain(|cached| cached.proof.root.project_id() != project_id);
    }

    fn insert(
        &mut self,
        proof: SourceControlProof,
        entries: Vec<WorktreeChangeEntry>,
    ) -> Result<String, CoreError> {
        self.next_sequence = self.next_sequence.checked_add(1).ok_or_else(|| {
            CoreError::Store("Source Control observation sequence overflow".into())
        })?;
        let observation_id = format!("source-control-{}", self.next_sequence);
        self.entries.push_back(CachedStatus {
            observation_id: observation_id.clone(),
            proof,
            entries,
        });
        while self.entries.len() > OBSERVATION_CAP {
            self.entries.pop_front();
        }
        Ok(observation_id)
    }

    fn selection(
        &self,
        root: &WorkspaceFilesPlan,
        observation_id: &str,
        entry_ids: &[String],
    ) -> Option<(SourceControlProof, Vec<WorktreeChangeEntry>)> {
        let cached = self
            .entries
            .iter()
            .find(|cached| cached.observation_id == observation_id && cached.proof.root == *root)?;
        let entries = entry_ids
            .iter()
            .map(|id| {
                let index = id.strip_prefix("entry-")?.parse::<usize>().ok()?;
                cached.entries.get(index).cloned()
            })
            .collect::<Option<Vec<_>>>()?;
        Some((cached.proof.clone(), entries))
    }
}

impl SourceControlRootPlan {
    pub fn project_id(&self) -> &str {
        self.root.project_id()
    }

    pub fn observe_status(self) -> ObservedSourceControlStatus {
        let observation = (|| {
            let runner =
                GitRunner::discover_with_timeout(termloop_gitio::SOURCE_CONTROL_STATUS_DEADLINE)
                    .map_err(map_git_error)?;
            let proof = inspect(&runner, &self.root)?;
            let status = runner
                .observe_source_control_status(&proof.worktree_root)
                .map_err(map_git_error)?;
            Ok((proof, status))
        })();
        ObservedSourceControlStatus {
            root: self.root,
            observation,
        }
    }
}

impl SourceControlMutationPlan {
    pub fn project_id(&self) -> &str {
        self.root.project_id()
    }

    pub fn task_id(&self) -> Option<&str> {
        self.root.task_id()
    }

    pub fn execute(self) -> ExecutedSourceControl {
        let result = self.run();
        ExecutedSourceControl {
            root: self.root,
            result,
        }
    }

    fn run(&self) -> Result<Value, CoreError> {
        let runner = GitRunner::discover().map_err(map_git_error)?;
        let proof = inspect(&runner, &self.root)?;
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| *expected != proof)
        {
            return Err(refused(SourceControlRefusal::ObservationStale));
        }
        let root = proof.worktree_root.as_path();
        match &self.mutation {
            Mutation::Paths {
                action,
                tracked,
                untracked,
            } => {
                let tracked = tracked.iter().map(PathBuf::as_path).collect::<Vec<_>>();
                let untracked = untracked.iter().map(PathBuf::as_path).collect::<Vec<_>>();
                match action {
                    PathAction::Stage => runner.stage_paths(root, &tracked),
                    PathAction::Unstage => runner.unstage_paths(root, &tracked),
                    PathAction::Discard => runner
                        .restore_worktree_paths(root, &tracked)
                        .and_then(|()| runner.remove_untracked_files(root, &untracked)),
                }
                .map_err(map_git_error)?;
                Ok(json!({}))
            }
            Mutation::Commit { message } => {
                let oid = runner
                    .commit_index(root, message.as_bytes())
                    .map_err(map_git_error)?;
                Ok(json!({ "head_oid": String::from_utf8_lossy(oid.as_bytes()) }))
            }
            Mutation::Sync(sync) => {
                let performed = run_sync(&runner, root, *sync)?;
                Ok(json!({ "action": performed }))
            }
        }
    }
}

/// Push publishes a branch that has no upstream yet: to `origin` when it
/// exists, otherwise to the repository's only remote. Anything else is the
/// user's choice, so it is refused rather than guessed.
fn run_sync(
    runner: &GitRunner,
    root: &Path,
    sync: SourceControlSync,
) -> Result<&'static str, CoreError> {
    match sync {
        SourceControlSync::Fetch => {
            runner.fetch_and_prune(root).map_err(map_git_error)?;
            Ok("fetch")
        }
        SourceControlSync::Pull => {
            runner.pull_fast_forward(root).map_err(map_git_error)?;
            Ok("pull")
        }
        SourceControlSync::Push => {
            let status = runner
                .observe_source_control_status(root)
                .map_err(map_git_error)?;
            let HeadState::Attached { branch, .. } = &status.head else {
                return Err(refused(SourceControlRefusal::NoBranch));
            };
            if status.upstream.is_some() {
                runner.push_current_branch(root).map_err(map_git_error)?;
                return Ok("push");
            }
            let short = branch
                .as_bytes()
                .strip_prefix(b"refs/heads/")
                .ok_or(refused(SourceControlRefusal::NoBranch))?;
            let remotes = runner
                .observe_branch_remotes(root, short)
                .map_err(map_git_error)?
                .remotes;
            let remote = remotes
                .iter()
                .find(|remote| remote.name == b"origin")
                .or(match remotes.as_slice() {
                    [only] => Some(only),
                    _ => None,
                })
                .ok_or(refused(SourceControlRefusal::NoRemote))?;
            runner
                .publish_current_branch(root, &remote.name)
                .map_err(map_git_error)?;
            Ok("publish")
        }
    }
}

impl CoreRuntime {
    pub fn plan_source_control_root(
        &self,
        params: &Value,
    ) -> Result<SourceControlRootPlan, CoreError> {
        Ok(SourceControlRootPlan {
            root: self.source_control_root(params)?,
        })
    }

    pub fn complete_source_control_status(
        &mut self,
        observed: ObservedSourceControlStatus,
    ) -> Result<Value, CoreError> {
        self.revalidate_workspace_root(&observed.root)?;
        let (proof, status) = observed.observation?;
        let entries = status
            .entries
            .iter()
            .enumerate()
            .map(|(index, entry)| change_entry(index, entry))
            .collect::<Result<Vec<_>, _>>()?;
        let branch = branch_projection(&status);
        let observation_id = self
            .source_control_observations
            .insert(proof, status.entries)?;
        Ok(json!({
            "project_id": observed.root.project_id(),
            "task_id": observed.root.task_id(),
            "observation_id": observation_id,
            "branch": branch,
            "entries": entries,
            "truncated": status.truncated,
        }))
    }

    pub fn plan_source_control_stage(
        &self,
        params: &Value,
    ) -> Result<SourceControlMutationPlan, CoreError> {
        self.plan_path_action(params, PathAction::Stage)
    }

    pub fn plan_source_control_unstage(
        &self,
        params: &Value,
    ) -> Result<SourceControlMutationPlan, CoreError> {
        self.plan_path_action(params, PathAction::Unstage)
    }

    pub fn plan_source_control_discard(
        &self,
        params: &Value,
    ) -> Result<SourceControlMutationPlan, CoreError> {
        self.plan_path_action(params, PathAction::Discard)
    }

    pub fn plan_source_control_commit(
        &self,
        params: &Value,
    ) -> Result<SourceControlMutationPlan, CoreError> {
        let root = self.source_control_root(params)?;
        let message = params
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::InvalidParams("message".into()))?;
        if message.len() > COMMIT_MESSAGE_MAX_BYTES || message.contains('\0') {
            return Err(CoreError::InvalidParams("message".into()));
        }
        if message.trim().is_empty() {
            return Err(refused(SourceControlRefusal::EmptyMessage));
        }
        Ok(SourceControlMutationPlan {
            root,
            expected: None,
            mutation: Mutation::Commit {
                message: message.to_owned(),
            },
        })
    }

    pub fn plan_source_control_sync(
        &self,
        params: &Value,
        sync: SourceControlSync,
    ) -> Result<SourceControlMutationPlan, CoreError> {
        Ok(SourceControlMutationPlan {
            root: self.source_control_root(params)?,
            expected: None,
            mutation: Mutation::Sync(sync),
        })
    }

    pub fn complete_source_control_mutation(
        &self,
        executed: ExecutedSourceControl,
    ) -> Result<Value, CoreError> {
        self.revalidate_workspace_root(&executed.root)?;
        let mut result = executed.result?;
        result["project_id"] = json!(executed.root.project_id());
        result["task_id"] = json!(executed.root.task_id());
        Ok(result)
    }

    fn source_control_root(&self, params: &Value) -> Result<WorkspaceFilesPlan, CoreError> {
        let project_id = required_string(params, "projectId")?;
        let task_id = match params.get("taskId") {
            None | Some(Value::Null) => None,
            Some(Value::String(task_id)) if !task_id.is_empty() => Some(task_id.as_str()),
            Some(_) => return Err(CoreError::InvalidParams("taskId".into())),
        };
        self.plan_workspace_files(&project_id, task_id, "")
    }

    fn plan_path_action(
        &self,
        params: &Value,
        action: PathAction,
    ) -> Result<SourceControlMutationPlan, CoreError> {
        let root = self.source_control_root(params)?;
        let observation_id = required_string(params, "observationId")?;
        let entry_ids = params
            .get("entryIds")
            .and_then(Value::as_array)
            .filter(|ids| !ids.is_empty() && ids.len() <= ENTRY_SELECTION_MAX)
            .and_then(|ids| {
                ids.iter()
                    .map(|id| id.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| CoreError::InvalidParams("entryIds".into()))?;
        let (proof, entries) = self
            .source_control_observations
            .selection(&root, &observation_id, &entry_ids)
            .ok_or(refused(SourceControlRefusal::ObservationStale))?;
        let (tracked, untracked) = action_paths(action, &entries)?;
        Ok(SourceControlMutationPlan {
            root,
            expected: Some(proof),
            mutation: Mutation::Paths {
                action,
                tracked,
                untracked,
            },
        })
    }
}

/// Which selected entries an action may touch, as `(index paths, untracked
/// files)`. Discard never touches staged content or an unresolved conflict:
/// both would lose work Git cannot recover from the working tree alone.
fn action_paths(
    action: PathAction,
    entries: &[WorktreeChangeEntry],
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), CoreError> {
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for entry in entries {
        let unmerged = entry.kind() == WorktreeChangeKind::Unmerged;
        let allowed = match (action, entry.side()) {
            (PathAction::Stage, WorktreeChangeSide::Unstaged | WorktreeChangeSide::Untracked) => {
                true
            }
            (PathAction::Stage, WorktreeChangeSide::Staged) => unmerged,
            (PathAction::Unstage, WorktreeChangeSide::Staged) => !unmerged,
            (PathAction::Discard, WorktreeChangeSide::Unstaged) => !unmerged,
            (PathAction::Discard, WorktreeChangeSide::Untracked) => true,
            _ => false,
        };
        if !allowed {
            return Err(refused(SourceControlRefusal::EntriesNotApplicable));
        }
        let target =
            if action == PathAction::Discard && entry.side() == WorktreeChangeSide::Untracked {
                &mut untracked
            } else {
                &mut tracked
            };
        target.push(entry.path().to_owned());
        // Unstaging a rename must restore its source path in the index too.
        if action == PathAction::Unstage {
            target.extend(entry.original_path().map(Path::to_owned));
        }
    }
    for paths in [&mut tracked, &mut untracked] {
        paths.sort();
        paths.dedup();
    }
    Ok((tracked, untracked))
}

fn inspect(runner: &GitRunner, root: &WorkspaceFilesPlan) -> Result<SourceControlProof, CoreError> {
    let facts = runner
        .inspect_repository(root.root())
        .map_err(map_git_error)?;
    let worktree_root = facts
        .worktree_root
        .ok_or(CoreError::RepositoryUnavailable)?;
    Ok(SourceControlProof {
        root: root.clone(),
        worktree_root,
        common_dir: facts.common_dir,
    })
}

fn refused(reason: SourceControlRefusal) -> CoreError {
    CoreError::SourceControlRefused { reason }
}

fn map_git_error(error: GitError) -> CoreError {
    use SourceControlRefusal as Refusal;
    let reason = match error {
        GitError::SourceControlRejected(rejection) => match rejection {
            SourceControlRejection::NothingToCommit => Refusal::NothingToCommit,
            SourceControlRejection::EmptyMessage => Refusal::EmptyMessage,
            SourceControlRejection::IdentityMissing => Refusal::IdentityMissing,
            SourceControlRejection::SigningFailed => Refusal::SigningFailed,
            SourceControlRejection::CommitRejected => Refusal::CommitRejected,
            SourceControlRejection::UnmergedPaths => Refusal::UnmergedPaths,
            SourceControlRejection::PushRejected => Refusal::PushRejected,
            SourceControlRejection::PullNotFastForward => Refusal::PullNotFastForward,
            SourceControlRejection::LocalChangesWouldBeOverwritten => {
                Refusal::LocalChangesWouldBeOverwritten
            }
            SourceControlRejection::NoUpstream => Refusal::NoUpstream,
            SourceControlRejection::NoRemote => Refusal::NoRemote,
        },
        GitError::RemoteUnavailable | GitError::RemoteRefMissing => Refusal::RemoteUnavailable,
        GitError::Timeout { .. } => Refusal::TimedOut,
        GitError::CommandFailed {
            kind: GitFailureKind::LockContention,
            ..
        } => Refusal::IndexLocked,
        GitError::GitUnavailable => return CoreError::GitUnavailable,
        GitError::UnsupportedVersion { .. } => return CoreError::GitUnsupportedVersion,
        GitError::PermissionDenied { .. }
        | GitError::CommandFailed {
            kind: GitFailureKind::DubiousOwnership,
            ..
        } => return CoreError::RepositoryPermissionDenied,
        GitError::OutputLimitExceeded { .. } => return CoreError::GitObservationOutputBound,
        GitError::CommandFailed {
            kind: GitFailureKind::CorruptRepository | GitFailureKind::InvalidConfiguration,
            ..
        } => return CoreError::CorruptRepository,
        _ => return CoreError::RepositoryUnavailable,
    };
    refused(reason)
}

fn branch_projection(status: &SourceControlStatusObservation) -> Value {
    let (name, head_state) = match &status.head {
        HeadState::Attached { branch, .. } => (short_branch(branch.as_bytes()), "attached"),
        HeadState::Unborn { branch } => (short_branch(branch.as_bytes()), "unborn"),
        HeadState::Detached { .. } => (None, "detached"),
    };
    let upstream = status.upstream.as_ref();
    let counts = upstream.and_then(|upstream| upstream.ahead_behind);
    json!({
        "name": name,
        "head_state": head_state,
        "upstream": upstream.map(|upstream| String::from_utf8_lossy(&upstream.name).into_owned()),
        "upstream_gone": upstream.is_some_and(|upstream| upstream.ahead_behind.is_none()),
        "ahead": counts.map(|(ahead, _)| ahead),
        "behind": counts.map(|(_, behind)| behind),
    })
}

fn short_branch(reference: &[u8]) -> Option<String> {
    reference
        .strip_prefix(b"refs/heads/")
        .map(|name| String::from_utf8_lossy(name).into_owned())
}

fn change_entry(index: usize, entry: &WorktreeChangeEntry) -> Result<Value, CoreError> {
    let (path, path_utf8) = display_path(entry.path())?;
    let (original_display_path, original_utf8) = entry
        .original_path()
        .map(display_path)
        .transpose()?
        .map_or((None, true), |(path, utf8)| (Some(path), utf8));
    let kind = entry.kind();
    Ok(json!({
        "entry_id": format!("entry-{index}"),
        "display_path": path,
        "original_display_path": original_display_path,
        "path_encoding": if path_utf8 && original_utf8 { "utf8" } else { "lossy" },
        "side": match entry.side() {
            WorktreeChangeSide::Staged => "staged",
            WorktreeChangeSide::Unstaged => "unstaged",
            WorktreeChangeSide::Untracked => "untracked",
        },
        "kind": match kind {
            WorktreeChangeKind::Modified => "modified",
            WorktreeChangeKind::Added => "added",
            WorktreeChangeKind::Deleted => "deleted",
            WorktreeChangeKind::Renamed => "renamed",
            WorktreeChangeKind::Copied => "copied",
            WorktreeChangeKind::Unmerged => "unmerged",
            WorktreeChangeKind::Untracked => "untracked",
        },
        "render_state": if kind == WorktreeChangeKind::Unmerged { "notShown" } else { "available" },
    }))
}

fn display_path(path: &Path) -> Result<(String, bool), CoreError> {
    let bytes = termloop_platform::process_bytes_from_os_str(path.as_os_str())
        .map_err(|_| CoreError::RepositoryUnavailable)?;
    Ok(match String::from_utf8(bytes) {
        Ok(value) => (value, true),
        Err(error) => (
            String::from_utf8_lossy(error.as_bytes()).into_owned(),
            false,
        ),
    })
}
