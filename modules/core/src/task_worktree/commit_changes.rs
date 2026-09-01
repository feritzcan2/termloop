use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use termloop_domain::TaskBranchBinding;
use termloop_gitio::{
    BranchCommit, BranchCommitListObservation, CommitChangeEntry, CommitChangesObservation,
    GitRunner, ObjectId, WorktreeDiffObservation,
};

use super::changes::{display_path, kind_name, project_diff_content};
use crate::{CoreError, CoreRuntime, required_string};

const COMMIT_OBSERVATION_CAP: usize = 64;
const COMMIT_OBSERVATION_TTL_MS: u64 = 60_000;
const ALL_CHANGES_ID: &str = "all";

#[derive(Clone)]
struct CachedCommit {
    commit: BranchCommit,
    entries: Option<Vec<CommitChangeEntry>>,
}

struct CachedCommitObservation {
    observation_id: String,
    task_id: String,
    selection: TaskCommitBranchSelection,
    repository_common_dir: PathBuf,
    range: Option<BranchRangeSnapshot>,
    all_entries: Option<Vec<CommitChangeEntry>>,
    expires_at_epoch_ms: u64,
    commits: Vec<CachedCommit>,
}

#[derive(Clone)]
struct BranchRangeSnapshot {
    base_oid: ObjectId,
    branch_tip_oid: ObjectId,
}

#[derive(Clone)]
enum BranchChangeTarget {
    All {
        base_oid: ObjectId,
        branch_tip_oid: ObjectId,
    },
    Commit(BranchCommit),
}

#[derive(Default)]
pub(crate) struct BranchCommitObservationCache {
    entries: VecDeque<CachedCommitObservation>,
    next_sequence: u64,
}

impl BranchCommitObservationCache {
    /// Drops every cached commit observation belonging to the given Tasks.
    pub(crate) fn retain_outside_tasks(&mut self, task_ids: &std::collections::HashSet<String>) {
        self.entries
            .retain(|observation| !task_ids.contains(&observation.task_id));
    }

    fn retain_fresh(&mut self, now: u64) {
        self.entries
            .retain(|observation| observation.expires_at_epoch_ms > now);
    }

    fn insert(
        &mut self,
        task_id: String,
        selection: TaskCommitBranchSelection,
        repository_common_dir: PathBuf,
        range: Option<BranchRangeSnapshot>,
        commits: Vec<BranchCommit>,
        now: u64,
    ) -> Result<String, CoreError> {
        self.retain_fresh(now);
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| CoreError::Store("commit observation sequence overflow".into()))?;
        let observation_id = format!("commits-{}", self.next_sequence);
        self.entries.push_back(CachedCommitObservation {
            observation_id: observation_id.clone(),
            task_id,
            selection,
            repository_common_dir,
            range,
            all_entries: None,
            expires_at_epoch_ms: now.saturating_add(COMMIT_OBSERVATION_TTL_MS),
            commits: commits
                .into_iter()
                .map(|commit| CachedCommit {
                    commit,
                    entries: None,
                })
                .collect(),
        });
        while self.entries.len() > COMMIT_OBSERVATION_CAP {
            self.entries.pop_front();
        }
        Ok(observation_id)
    }

    fn target(
        &mut self,
        task_id: &str,
        observation_id: &str,
        commit_id: &str,
        now: u64,
    ) -> Option<(TaskCommitBranchSelection, PathBuf, BranchChangeTarget)> {
        self.retain_fresh(now);
        let observation = self.entries.iter().find(|observation| {
            observation.task_id == task_id && observation.observation_id == observation_id
        })?;
        let target = if commit_id == ALL_CHANGES_ID {
            let range = observation.range.as_ref()?;
            BranchChangeTarget::All {
                base_oid: range.base_oid.clone(),
                branch_tip_oid: range.branch_tip_oid.clone(),
            }
        } else {
            let index = opaque_index(commit_id, "commit-")?;
            BranchChangeTarget::Commit(observation.commits.get(index)?.commit.clone())
        };
        Some((
            observation.selection.clone(),
            observation.repository_common_dir.clone(),
            target,
        ))
    }

    fn store_entries(
        &mut self,
        task_id: &str,
        observation_id: &str,
        commit_id: &str,
        entries: Vec<CommitChangeEntry>,
        now: u64,
    ) -> bool {
        self.retain_fresh(now);
        let Some(observation) = self.entries.iter_mut().find(|observation| {
            observation.task_id == task_id && observation.observation_id == observation_id
        }) else {
            return false;
        };
        if commit_id == ALL_CHANGES_ID {
            observation.all_entries = Some(entries);
        } else {
            let Some(index) = opaque_index(commit_id, "commit-") else {
                return false;
            };
            let Some(commit) = observation.commits.get_mut(index) else {
                return false;
            };
            commit.entries = Some(entries);
        }
        true
    }

    fn diff_target(
        &mut self,
        task_id: &str,
        observation_id: &str,
        commit_id: &str,
        entry_id: &str,
        now: u64,
    ) -> Option<(
        TaskCommitBranchSelection,
        PathBuf,
        BranchChangeTarget,
        CommitChangeEntry,
    )> {
        let (selection, common_dir, target) =
            self.target(task_id, observation_id, commit_id, now)?;
        let observation = self.entries.iter().find(|observation| {
            observation.task_id == task_id && observation.observation_id == observation_id
        })?;
        let entry_index = opaque_index(entry_id, "entry-")?;
        let entries = if commit_id == ALL_CHANGES_ID {
            observation.all_entries.as_ref()?
        } else {
            let commit_index = opaque_index(commit_id, "commit-")?;
            observation.commits.get(commit_index)?.entries.as_ref()?
        };
        let entry = entries.get(entry_index)?.clone();
        Some((selection, common_dir, target, entry))
    }
}

#[derive(Clone)]
pub struct TaskBranchCommitListPlan {
    task_id: String,
    project_id: String,
    selection: TaskCommitBranchSelection,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TaskCommitBranchSelection {
    branch_id: String,
    binding: TaskBranchBinding,
    recorded_base: Option<(String, String)>,
    frozen_base: bool,
    display_base_ref: Option<String>,
    base_oid: Option<String>,
    base_evidence: Option<&'static str>,
    role: &'static str,
    held_by_task_id: Option<String>,
}

pub struct ObservedTaskBranchCommitList {
    plan: TaskBranchCommitListPlan,
    observation: Result<BranchCommitListObservation, CoreError>,
}

#[derive(Clone)]
pub struct TaskBranchCommitChangeListPlan {
    task_id: String,
    project_id: String,
    observation_id: String,
    commit_id: String,
    selection: TaskCommitBranchSelection,
    repository_common_dir: PathBuf,
    target: BranchChangeTarget,
}

pub struct ObservedTaskBranchCommitChanges {
    plan: TaskBranchCommitChangeListPlan,
    observation: Result<CommitChangesObservation, CoreError>,
}

#[derive(Clone)]
pub struct TaskBranchCommitDiffPlan {
    task_id: String,
    project_id: String,
    observation_id: String,
    commit_id: String,
    entry_id: String,
    selection: TaskCommitBranchSelection,
    repository_common_dir: PathBuf,
    target: BranchChangeTarget,
    entry: CommitChangeEntry,
}

pub struct ObservedTaskBranchCommitDiff {
    plan: TaskBranchCommitDiffPlan,
    observation: Result<WorktreeDiffObservation, CoreError>,
}

impl TaskBranchCommitListPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe(self) -> ObservedTaskBranchCommitList {
        let observation = GitRunner::discover()
            .map_err(super::git_mapping::map_git_observation_error)
            .and_then(|runner| {
                let repository = Path::new(&self.selection.binding.repository_root);
                match (&self.selection.recorded_base, self.selection.frozen_base) {
                    (Some((base_ref, base_oid)), true) => runner
                        .list_branch_commits_with_recorded_base(
                            repository,
                            self.selection.binding.name.as_bytes(),
                            base_ref.as_bytes(),
                            base_oid.as_bytes(),
                        ),
                    (Some((base_ref, _)), false) => runner.list_branch_commits_with_current_base(
                        repository,
                        self.selection.binding.name.as_bytes(),
                        base_ref.as_bytes(),
                    ),
                    (None, _) => runner
                        .list_branch_commits(repository, self.selection.binding.name.as_bytes()),
                }
                .map_err(super::git_mapping::map_git_observation_error)
            });
        ObservedTaskBranchCommitList {
            plan: self,
            observation,
        }
    }
}

impl TaskBranchCommitChangeListPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe(self) -> ObservedTaskBranchCommitChanges {
        let observation = observe_repository(&self.selection.binding, &self.repository_common_dir)
            .and_then(|runner| {
                let repository = Path::new(&self.selection.binding.repository_root);
                match &self.target {
                    BranchChangeTarget::All {
                        base_oid,
                        branch_tip_oid,
                    } => runner.list_branch_range_changes(repository, base_oid, branch_tip_oid),
                    BranchChangeTarget::Commit(commit) => {
                        runner.list_commit_changes(repository, commit)
                    }
                }
                .map_err(super::git_mapping::map_git_observation_error)
            });
        ObservedTaskBranchCommitChanges {
            plan: self,
            observation,
        }
    }
}

impl TaskBranchCommitDiffPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe(self) -> ObservedTaskBranchCommitDiff {
        let observation = observe_repository(&self.selection.binding, &self.repository_common_dir)
            .and_then(|runner| {
                let repository = Path::new(&self.selection.binding.repository_root);
                match &self.target {
                    BranchChangeTarget::All {
                        base_oid,
                        branch_tip_oid,
                    } => runner.diff_branch_range_change(
                        repository,
                        base_oid,
                        branch_tip_oid,
                        &self.entry,
                    ),
                    BranchChangeTarget::Commit(commit) => {
                        runner.diff_commit_change(repository, commit, &self.entry)
                    }
                }
                .map_err(super::git_mapping::map_git_observation_error)
            });
        ObservedTaskBranchCommitDiff {
            plan: self,
            observation,
        }
    }
}

impl CoreRuntime {
    pub fn plan_task_branch_commit_list(
        &self,
        params: Value,
    ) -> Result<TaskBranchCommitListPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let branch_id = match params.get("branchId") {
            None => "primary",
            Some(Value::String(value)) if !value.is_empty() => value,
            _ => return Err(CoreError::InvalidParams("branchId".into())),
        };
        let selection = self.task_commit_branch_selection(&task_id, branch_id)?;
        Ok(TaskBranchCommitListPlan {
            task_id,
            project_id: task.project_id.clone(),
            selection,
        })
    }

    pub fn complete_task_branch_commit_list(
        &mut self,
        observed: ObservedTaskBranchCommitList,
    ) -> Result<Value, CoreError> {
        self.revalidate_task_commit_branch_selection(
            &observed.plan.task_id,
            &observed.plan.selection,
        )?;
        let observation = observed.observation?;
        let observed_base_ref = std::str::from_utf8(observation.base_ref.as_bytes())
            .map_err(|_| CoreError::RepositoryUnavailable)?
            .to_owned();
        let base_ref = observed
            .plan
            .selection
            .display_base_ref
            .clone()
            .or_else(|| {
                (observed.plan.selection.branch_id == "primary").then_some(observed_base_ref)
            });
        let base_oid = observed.plan.selection.base_oid.clone().or_else(|| {
            std::str::from_utf8(observation.base_oid.as_bytes())
                .ok()
                .map(str::to_owned)
        });
        let commits = observation.commits;
        let projected = commits
            .iter()
            .enumerate()
            .map(|commit| project_commit(commit, &observed.plan.selection))
            .collect::<Result<Vec<_>, _>>()?;
        let observation_id = self.branch_commit_observations.insert(
            observed.plan.task_id.clone(),
            observed.plan.selection.clone(),
            observation.repository_common_dir,
            observation
                .branch_tip_oid
                .map(|branch_tip_oid| BranchRangeSnapshot {
                    base_oid: observation.base_oid,
                    branch_tip_oid,
                }),
            commits,
            termloop_platform::current_epoch_ms(),
        )?;
        Ok(json!({
            "task_id": observed.plan.task_id,
            "observation_id": observation_id,
            "branch_id": observed.plan.selection.branch_id,
            "branch_name": observed.plan.selection.binding.name,
            "branch_role": observed.plan.selection.role,
            "held_by_task_id": observed.plan.selection.held_by_task_id,
            "base_ref": base_ref,
            "base_oid": base_oid,
            "base_evidence": observed.plan.selection.base_evidence,
            "commits": projected,
            "truncated": observation.truncated,
        }))
    }

    pub fn plan_task_branch_commit_change_list(
        &mut self,
        params: Value,
    ) -> Result<TaskBranchCommitChangeListPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let observation_id = required_string(&params, "observationId")?;
        let commit_id = required_string(&params, "commitId")?;
        let (selection, repository_common_dir, target) = self
            .branch_commit_observations
            .target(
                &task_id,
                &observation_id,
                &commit_id,
                termloop_platform::current_epoch_ms(),
            )
            .ok_or(CoreError::BranchMutationConflict)?;
        let project_id = self.revalidate_task_commit_branch_selection(&task_id, &selection)?;
        Ok(TaskBranchCommitChangeListPlan {
            task_id,
            project_id,
            observation_id,
            commit_id,
            selection,
            repository_common_dir,
            target,
        })
    }

    pub fn complete_task_branch_commit_change_list(
        &mut self,
        observed: ObservedTaskBranchCommitChanges,
    ) -> Result<Value, CoreError> {
        self.revalidate_task_commit_branch_selection(
            &observed.plan.task_id,
            &observed.plan.selection,
        )?;
        let observation = observed.observation?;
        let entries = observation.entries;
        let projected = entries
            .iter()
            .enumerate()
            .map(project_entry)
            .collect::<Result<Vec<_>, _>>()?;
        if !self.branch_commit_observations.store_entries(
            &observed.plan.task_id,
            &observed.plan.observation_id,
            &observed.plan.commit_id,
            entries,
            termloop_platform::current_epoch_ms(),
        ) {
            return Err(CoreError::BranchMutationConflict);
        }
        Ok(json!({
            "task_id": observed.plan.task_id,
            "observation_id": observed.plan.observation_id,
            "commit_id": observed.plan.commit_id,
            "state": if observation.renderable { "available" } else { "notShown" },
            "entries": projected,
            "truncated": observation.truncated,
        }))
    }

    pub fn plan_task_branch_commit_diff(
        &mut self,
        params: Value,
    ) -> Result<TaskBranchCommitDiffPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let observation_id = required_string(&params, "observationId")?;
        let commit_id = required_string(&params, "commitId")?;
        let entry_id = required_string(&params, "entryId")?;
        let (selection, repository_common_dir, target, entry) = self
            .branch_commit_observations
            .diff_target(
                &task_id,
                &observation_id,
                &commit_id,
                &entry_id,
                termloop_platform::current_epoch_ms(),
            )
            .ok_or(CoreError::BranchMutationConflict)?;
        let project_id = self.revalidate_task_commit_branch_selection(&task_id, &selection)?;
        Ok(TaskBranchCommitDiffPlan {
            task_id,
            project_id,
            observation_id,
            commit_id,
            entry_id,
            selection,
            repository_common_dir,
            target,
            entry,
        })
    }

    pub fn complete_task_branch_commit_diff(
        &self,
        observed: ObservedTaskBranchCommitDiff,
    ) -> Result<Value, CoreError> {
        self.revalidate_task_commit_branch_selection(
            &observed.plan.task_id,
            &observed.plan.selection,
        )?;
        let diff = observed.observation?;
        let (state, patch) = project_diff_content(diff.content);
        Ok(json!({
            "task_id": observed.plan.task_id,
            "observation_id": observed.plan.observation_id,
            "commit_id": observed.plan.commit_id,
            "entry_id": observed.plan.entry_id,
            "state": state,
            "patch": patch,
        }))
    }

    fn revalidate_task_commit_branch_selection(
        &self,
        task_id: &str,
        expected: &TaskCommitBranchSelection,
    ) -> Result<String, CoreError> {
        let current = self.task_commit_branch_selection(task_id, &expected.branch_id)?;
        if &current != expected {
            return Err(CoreError::BranchMutationConflict);
        }
        self.store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .map(|task| task.project_id.clone())
            .ok_or(CoreError::BranchMutationConflict)
    }

    fn task_commit_branch_selection(
        &self,
        task_id: &str,
        branch_id: &str,
    ) -> Result<TaskCommitBranchSelection, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if branch_id == "primary" {
            let binding = task
                .branch
                .clone()
                .ok_or(CoreError::BranchMutationConflict)?;
            let recorded_base = self.task_recorded_branch_base(task_id, &binding);
            return Ok(TaskCommitBranchSelection {
                branch_id: "primary".into(),
                binding,
                recorded_base,
                frozen_base: false,
                display_base_ref: None,
                base_oid: None,
                base_evidence: None,
                role: "primary",
                held_by_task_id: None,
            });
        }
        let membership = self
            .store
            .task_branch_sets()
            .iter()
            .find(|set| set.task_id == task_id)
            .and_then(|set| {
                set.memberships
                    .iter()
                    .find(|membership| membership.id == branch_id)
            })
            .ok_or(CoreError::NotFound)?;
        let name = membership
            .ref_name
            .strip_prefix("refs/heads/")
            .filter(|name| !name.is_empty())
            .ok_or(CoreError::BranchMutationConflict)?
            .to_owned();
        let internal_base_ref = membership
            .parent_ref_name
            .clone()
            .unwrap_or_else(|| membership.ref_name.clone());
        let (role, held_by_task_id) = associated_branch_role(
            self,
            task,
            &membership.repository_root,
            &membership.ref_name,
        );
        Ok(TaskCommitBranchSelection {
            branch_id: membership.id.clone(),
            binding: TaskBranchBinding {
                repository_root: membership.repository_root.clone(),
                name,
            },
            recorded_base: Some((internal_base_ref, membership.first_observed_oid.clone())),
            frozen_base: true,
            display_base_ref: membership.parent_ref_name.clone(),
            base_oid: Some(membership.first_observed_oid.clone()),
            base_evidence: Some(match membership.evidence {
                termloop_domain::TaskBranchMembershipEvidence::CurrentBranch => "currentBranch",
                termloop_domain::TaskBranchMembershipEvidence::WorktreeReflog => "worktreeReflog",
                termloop_domain::TaskBranchMembershipEvidence::BranchCreationReflog => {
                    "branchCreationReflog"
                }
            }),
            role,
            held_by_task_id,
        })
    }
}

fn observe_repository(
    binding: &TaskBranchBinding,
    expected_common_dir: &Path,
) -> Result<GitRunner, CoreError> {
    let runner = GitRunner::discover().map_err(super::git_mapping::map_git_observation_error)?;
    let facts = runner
        .inspect_repository(Path::new(&binding.repository_root))
        .map_err(super::git_mapping::map_git_observation_error)?;
    if facts.common_dir != expected_common_dir {
        return Err(CoreError::BranchMutationConflict);
    }
    Ok(runner)
}

fn associated_branch_role(
    runtime: &CoreRuntime,
    task: &termloop_domain::TaskRecord,
    repository_root: &str,
    ref_name: &str,
) -> (&'static str, Option<String>) {
    let is_base = task
        .branch
        .as_ref()
        .and_then(|binding| runtime.task_recorded_branch_base(&task.id, binding))
        .and_then(|(reference, _)| display_ref_name(reference.as_bytes()).ok())
        .is_some_and(|name| format!("refs/heads/{name}") == ref_name);
    if is_base {
        return ("baseBranch", None);
    }
    match runtime.store.tasks().iter().find(|candidate| {
        candidate.id != task.id
            && candidate.project_id == task.project_id
            && candidate.branch.as_ref().is_some_and(|binding| {
                binding.repository_root == repository_root
                    && format!("refs/heads/{}", binding.name) == ref_name
            })
    }) {
        Some(holder) => ("heldByOtherTask", Some(holder.id.clone())),
        None => ("associated", None),
    }
}

fn display_ref_name(bytes: &[u8]) -> Result<String, CoreError> {
    let reference = std::str::from_utf8(bytes).map_err(|_| CoreError::RepositoryUnavailable)?;
    reference
        .strip_prefix("refs/heads/")
        .or_else(|| {
            reference
                .strip_prefix("refs/remotes/")
                .and_then(|value| value.split_once('/').map(|(_, branch)| branch))
        })
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(CoreError::RepositoryUnavailable)
}

fn project_commit(
    (index, commit): (usize, &BranchCommit),
    selection: &TaskCommitBranchSelection,
) -> Result<Value, CoreError> {
    let oid = std::str::from_utf8(commit.oid().as_bytes())
        .map_err(|_| CoreError::RepositoryUnavailable)?;
    let (subject, encoding) = display_bytes(commit.subject(), 512);
    Ok(json!({
        "commit_id": format!("commit-{index}"),
        "branch_id": selection.branch_id,
        "branch_name": selection.binding.name,
        "short_oid": oid.chars().take(12).collect::<String>(),
        "subject": subject,
        "subject_encoding": encoding,
        "authored_at_epoch_ms": commit.authored_at_epoch_ms().filter(|value| *value <= 9_007_199_254_740_991),
    }))
}

fn project_entry((index, entry): (usize, &CommitChangeEntry)) -> Result<Value, CoreError> {
    let (display_value, path_utf8) = display_path(entry.path())?;
    let (original_display_path, original_utf8) = entry
        .original_path()
        .map(display_path)
        .transpose()?
        .map_or((None, true), |(path, utf8)| (Some(path), utf8));
    Ok(json!({
        "entry_id": format!("entry-{index}"),
        "display_path": display_value,
        "original_display_path": original_display_path,
        "path_encoding": if path_utf8 && original_utf8 { "utf8" } else { "lossy" },
        "kind": kind_name(entry.kind()),
        "render_state": "available",
    }))
}

fn display_bytes(bytes: &[u8], max_chars: usize) -> (String, &'static str) {
    let (value, encoding) = match std::str::from_utf8(bytes) {
        Ok(value) => (value.to_owned(), "utf8"),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), "lossy"),
    };
    (value.chars().take(max_chars).collect(), encoding)
}

fn opaque_index(value: &str, prefix: &str) -> Option<usize> {
    value.strip_prefix(prefix)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_cache_is_bounded_and_expires() {
        let mut cache = BranchCommitObservationCache::default();
        let binding = TaskBranchBinding {
            repository_root: "/repo".into(),
            name: "feature".into(),
        };
        let selection = TaskCommitBranchSelection {
            branch_id: "primary".into(),
            binding,
            recorded_base: None,
            frozen_base: false,
            display_base_ref: None,
            base_oid: None,
            base_evidence: None,
            role: "primary",
            held_by_task_id: None,
        };
        for index in 0..(COMMIT_OBSERVATION_CAP + 2) {
            cache
                .insert(
                    format!("task-{index}"),
                    selection.clone(),
                    PathBuf::from("/repo/.git"),
                    Some(BranchRangeSnapshot {
                        base_oid: ObjectId::from_hex(
                            b"1111111111111111111111111111111111111111".to_vec(),
                        )
                        .unwrap(),
                        branch_tip_oid: ObjectId::from_hex(
                            b"2222222222222222222222222222222222222222".to_vec(),
                        )
                        .unwrap(),
                    }),
                    vec![],
                    10,
                )
                .unwrap();
        }
        assert_eq!(cache.entries.len(), COMMIT_OBSERVATION_CAP);
        cache.retain_fresh(10 + COMMIT_OBSERVATION_TTL_MS);
        assert!(cache.entries.is_empty());
    }
}
