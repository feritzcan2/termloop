use std::collections::VecDeque;
use std::path::Path;

use serde_json::{Value, json};
use termloop_domain::ManagedWorktreeProof;
use termloop_gitio::{
    GitRunner, PreImageContent, PreImageObservation, PreImageRevision, WorktreeChangeEntry,
    WorktreeChangeKind, WorktreeChangeSide, WorktreeChangesObservation, WorktreeDiffContent,
    WorktreeDiffObservation,
};

use crate::{CoreError, CoreRuntime, required_string};

const CHANGE_OBSERVATION_CAP: usize = 64;
const CHANGE_OBSERVATION_TTL_MS: u64 = 60_000;

#[derive(Clone)]
pub struct TaskWorktreeChangeListPlan {
    task_id: String,
    project_id: String,
    proof: ManagedWorktreeProof,
}

pub struct ObservedTaskWorktreeChanges {
    plan: TaskWorktreeChangeListPlan,
    observation: Result<WorktreeChangesObservation, CoreError>,
}

/// One entry of a live change observation, resolved and authorized: the Task, its
/// Project, the opaque observation/entry identifiers, the captured worktree proof,
/// and the exact entry. Every per-entry content read is planned from this, so all
/// of them share one gate and none accepts a caller-supplied path.
#[derive(Clone)]
struct ChangeEntrySelection {
    task_id: String,
    project_id: String,
    observation_id: String,
    entry_id: String,
    proof: ManagedWorktreeProof,
    entry: WorktreeChangeEntry,
}

#[derive(Clone)]
pub struct TaskWorktreeDiffPlan {
    selection: ChangeEntrySelection,
}

pub struct ObservedTaskWorktreeDiff {
    plan: TaskWorktreeDiffPlan,
    observation: Result<WorktreeDiffObservation, CoreError>,
}

#[derive(Clone)]
pub struct TaskWorktreePreImagePlan {
    selection: ChangeEntrySelection,
}

pub struct ObservedTaskWorktreePreImage {
    plan: TaskWorktreePreImagePlan,
    observation: Result<PreImageObservation, CoreError>,
}

struct CachedChangeObservation {
    observation_id: String,
    task_id: String,
    proof: ManagedWorktreeProof,
    expires_at_epoch_ms: u64,
    entries: Vec<WorktreeChangeEntry>,
}

#[derive(Default)]
pub(crate) struct WorktreeChangeObservationCache {
    entries: VecDeque<CachedChangeObservation>,
    next_sequence: u64,
}

impl WorktreeChangeObservationCache {
    /// Drops every cached observation belonging to the given Tasks, so a
    /// deleted Task's changed files stay unreadable once it is gone.
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
        proof: ManagedWorktreeProof,
        entries: Vec<WorktreeChangeEntry>,
        now: u64,
    ) -> Result<String, CoreError> {
        self.retain_fresh(now);
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| CoreError::Store("change observation sequence overflow".into()))?;
        let observation_id = format!("changes-{}", self.next_sequence);
        self.entries.push_back(CachedChangeObservation {
            observation_id: observation_id.clone(),
            task_id,
            proof,
            expires_at_epoch_ms: now.saturating_add(CHANGE_OBSERVATION_TTL_MS),
            entries,
        });
        while self.entries.len() > CHANGE_OBSERVATION_CAP {
            self.entries.pop_front();
        }
        Ok(observation_id)
    }

    fn lookup(
        &mut self,
        task_id: &str,
        observation_id: &str,
        entry_id: &str,
        now: u64,
    ) -> Option<(ManagedWorktreeProof, WorktreeChangeEntry)> {
        self.retain_fresh(now);
        let observation = self.entries.iter().find(|observation| {
            observation.task_id == task_id && observation.observation_id == observation_id
        })?;
        let index = entry_id.strip_prefix("entry-")?.parse::<usize>().ok()?;
        observation
            .entries
            .get(index)
            .cloned()
            .map(|entry| (observation.proof.clone(), entry))
    }
}

impl TaskWorktreeChangeListPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe(self) -> ObservedTaskWorktreeChanges {
        let observation = observe_changes(&self.proof);
        ObservedTaskWorktreeChanges {
            plan: self,
            observation,
        }
    }
}

impl TaskWorktreeDiffPlan {
    pub fn project_id(&self) -> &str {
        &self.selection.project_id
    }

    pub fn observe(self) -> ObservedTaskWorktreeDiff {
        let observation = observe_diff(&self.selection.proof, &self.selection.entry);
        ObservedTaskWorktreeDiff {
            plan: self,
            observation,
        }
    }
}

impl TaskWorktreePreImagePlan {
    pub fn project_id(&self) -> &str {
        &self.selection.project_id
    }

    pub fn observe(self) -> ObservedTaskWorktreePreImage {
        let observation = observe_pre_image(&self.selection.proof, &self.selection.entry);
        ObservedTaskWorktreePreImage {
            plan: self,
            observation,
        }
    }
}

impl CoreRuntime {
    pub fn plan_task_worktree_change_list(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeChangeListPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let project_id = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .map(|task| task.project_id.clone())
            .ok_or(CoreError::NotFound)?;
        let proof = self.current_change_proof(&task_id)?;
        Ok(TaskWorktreeChangeListPlan {
            task_id,
            project_id,
            proof,
        })
    }

    pub fn complete_task_worktree_change_list(
        &mut self,
        observed: ObservedTaskWorktreeChanges,
    ) -> Result<Value, CoreError> {
        self.revalidate_change_proof(&observed.plan.task_id, &observed.plan.proof)?;
        let observation = observed.observation?;
        let now = termloop_platform::current_epoch_ms();
        let entries = observation.entries;
        let observation_id = self.worktree_change_observations.insert(
            observed.plan.task_id.clone(),
            observed.plan.proof.clone(),
            entries.clone(),
            now,
        )?;
        let projected = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| project_change_entry(index, entry))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({
            "task_id": observed.plan.task_id,
            "observation_id": observation_id,
            "worktree_generation": observed.plan.proof.worktree_generation,
            "entries": projected,
            "truncated": observation.truncated,
        }))
    }

    /// Resolve and authorize one entry of a live change observation. Both content
    /// reads plan from this, so a caller can only ever name an entry the same gate
    /// already admitted.
    fn resolve_change_entry(&mut self, params: Value) -> Result<ChangeEntrySelection, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let observation_id = required_string(&params, "observationId")?;
        let entry_id = required_string(&params, "entryId")?;
        let project_id = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .map(|task| task.project_id.clone())
            .ok_or(CoreError::NotFound)?;
        let Some((proof, entry)) = self.worktree_change_observations.lookup(
            &task_id,
            &observation_id,
            &entry_id,
            termloop_platform::current_epoch_ms(),
        ) else {
            return Err(proof_changed(&self.store, &task_id));
        };
        let current = self
            .current_change_proof(&task_id)
            .map_err(|_| proof_changed(&self.store, &task_id))?;
        if proof != current {
            return Err(proof_changed(&self.store, &task_id));
        }
        Ok(ChangeEntrySelection {
            task_id,
            project_id,
            observation_id,
            entry_id,
            proof,
            entry,
        })
    }

    pub fn plan_task_worktree_diff(
        &mut self,
        params: Value,
    ) -> Result<TaskWorktreeDiffPlan, CoreError> {
        Ok(TaskWorktreeDiffPlan {
            selection: self.resolve_change_entry(params)?,
        })
    }

    pub fn complete_task_worktree_diff(
        &self,
        observed: ObservedTaskWorktreeDiff,
    ) -> Result<Value, CoreError> {
        let selection = &observed.plan.selection;
        self.revalidate_change_proof(&selection.task_id, &selection.proof)?;
        let diff = observed.observation?;
        let (state, patch) = project_diff_content(diff.content);
        Ok(json!({
            "task_id": selection.task_id,
            "observation_id": selection.observation_id,
            "entry_id": selection.entry_id,
            "state": state,
            "patch": patch,
        }))
    }

    pub fn plan_task_worktree_pre_image(
        &mut self,
        params: Value,
    ) -> Result<TaskWorktreePreImagePlan, CoreError> {
        Ok(TaskWorktreePreImagePlan {
            selection: self.resolve_change_entry(params)?,
        })
    }

    pub fn complete_task_worktree_pre_image(
        &self,
        observed: ObservedTaskWorktreePreImage,
    ) -> Result<Value, CoreError> {
        let selection = &observed.plan.selection;
        self.revalidate_change_proof(&selection.task_id, &selection.proof)?;
        let pre_image = observed.observation?;
        let (state, content) = project_pre_image_content(pre_image.content);
        Ok(json!({
            "task_id": selection.task_id,
            "observation_id": selection.observation_id,
            "entry_id": selection.entry_id,
            "state": state,
            "revision": revision_name(pre_image.revision),
            "content": content,
        }))
    }

    fn current_change_proof(&self, task_id: &str) -> Result<ManagedWorktreeProof, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .cloned()
            .ok_or_else(|| CoreError::TaskWorktreeRequired {
                task_id: task_id.to_owned(),
            })?;
        if proof.worktree_generation != task.worktree_generation
            || task.worktree.as_ref().map(|binding| binding.path.as_str())
                != Some(proof.registered_worktree_path.as_str())
        {
            return Err(proof_changed(&self.store, task_id));
        }
        Ok(proof)
    }

    fn revalidate_change_proof(
        &self,
        task_id: &str,
        expected: &ManagedWorktreeProof,
    ) -> Result<(), CoreError> {
        let current = self.current_change_proof(task_id)?;
        if &current == expected {
            Ok(())
        } else {
            Err(proof_changed(&self.store, task_id))
        }
    }
}

/// Discover Git and prove the checkout is still the exact managed worktree the
/// proof describes, before any observation reads it. Every observation goes
/// through here so the identity gate cannot be omitted by a new caller.
fn verified_runner(proof: &ManagedWorktreeProof) -> Result<GitRunner, CoreError> {
    let runner = GitRunner::discover_with_timeout(termloop_gitio::HEALTH_GIT_SUBPROCESS_DEADLINE)
        .map_err(super::git_mapping::map_git_observation_error)?;
    verify_repository_identity(&runner, proof)?;
    Ok(runner)
}

fn worktree_path(proof: &ManagedWorktreeProof) -> &Path {
    Path::new(&proof.registered_worktree_path)
}

fn observe_changes(proof: &ManagedWorktreeProof) -> Result<WorktreeChangesObservation, CoreError> {
    verified_runner(proof)?
        .list_worktree_changes(worktree_path(proof))
        .map_err(super::git_mapping::map_git_observation_error)
}

fn observe_diff(
    proof: &ManagedWorktreeProof,
    entry: &WorktreeChangeEntry,
) -> Result<WorktreeDiffObservation, CoreError> {
    verified_runner(proof)?
        .diff_worktree_change(worktree_path(proof), entry)
        .map_err(super::git_mapping::map_git_observation_error)
}

fn observe_pre_image(
    proof: &ManagedWorktreeProof,
    entry: &WorktreeChangeEntry,
) -> Result<PreImageObservation, CoreError> {
    verified_runner(proof)?
        .read_worktree_change_pre_image(worktree_path(proof), entry)
        .map_err(super::git_mapping::map_git_observation_error)
}

fn verify_repository_identity(
    runner: &GitRunner,
    proof: &ManagedWorktreeProof,
) -> Result<(), CoreError> {
    let facts = runner
        .inspect_repository(Path::new(&proof.registered_worktree_path))
        .map_err(super::git_mapping::map_git_observation_error)?;
    if facts.worktree_root.as_deref() != Some(Path::new(&proof.registered_worktree_path))
        || facts.common_dir != Path::new(&proof.repository_common_dir)
    {
        return Err(CoreError::ManagedWorktreeProofChanged {
            task_id: proof.task_id.clone(),
            current_managed_worktree_operation_id: Some(proof.operation_id.clone()),
            current_worktree_generation: proof.worktree_generation,
        });
    }
    Ok(())
}

fn project_change_entry(index: usize, entry: &WorktreeChangeEntry) -> Result<Value, CoreError> {
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
        "side": side_name(entry.side()),
        "kind": kind_name(entry.kind()),
        "render_state": change_render_state(entry.kind()),
    }))
}

fn change_render_state(kind: WorktreeChangeKind) -> &'static str {
    if kind == WorktreeChangeKind::Unmerged {
        "notShown"
    } else {
        "available"
    }
}

pub(super) fn display_path(path: &Path) -> Result<(String, bool), CoreError> {
    let bytes = termloop_platform::process_bytes_from_os_str(path.as_os_str())
        .map_err(|_| CoreError::RepositoryUnavailable)?;
    match String::from_utf8(bytes) {
        Ok(value) => Ok((value, true)),
        Err(error) => Ok((
            String::from_utf8_lossy(error.as_bytes()).into_owned(),
            false,
        )),
    }
}

fn side_name(side: WorktreeChangeSide) -> &'static str {
    match side {
        WorktreeChangeSide::Staged => "staged",
        WorktreeChangeSide::Unstaged => "unstaged",
        WorktreeChangeSide::Untracked => "untracked",
    }
}

pub(super) fn kind_name(kind: WorktreeChangeKind) -> &'static str {
    match kind {
        WorktreeChangeKind::Modified => "modified",
        WorktreeChangeKind::Added => "added",
        WorktreeChangeKind::Deleted => "deleted",
        WorktreeChangeKind::Renamed => "renamed",
        WorktreeChangeKind::Copied => "copied",
        WorktreeChangeKind::Unmerged => "unmerged",
        WorktreeChangeKind::Untracked => "untracked",
    }
}

pub(super) fn project_diff_content(content: WorktreeDiffContent) -> (&'static str, Option<String>) {
    match content {
        WorktreeDiffContent::Patch(bytes) => match String::from_utf8(bytes) {
            Ok(patch) => ("patch", Some(patch)),
            Err(_) => ("nonUtf8", None),
        },
        WorktreeDiffContent::Binary => ("binary", None),
        WorktreeDiffContent::Truncated => ("truncated", None),
        WorktreeDiffContent::NotShown => ("notShown", None),
    }
}

pub(super) fn project_pre_image_content(
    content: PreImageContent,
) -> (&'static str, Option<String>) {
    match content {
        PreImageContent::Content(bytes) => match String::from_utf8(bytes) {
            Ok(text) => ("content", Some(text)),
            Err(_) => ("nonUtf8", None),
        },
        PreImageContent::Absent => ("absent", None),
        PreImageContent::Binary => ("binary", None),
        PreImageContent::Truncated => ("truncated", None),
        PreImageContent::NotShown => ("notShown", None),
    }
}

fn revision_name(revision: PreImageRevision) -> &'static str {
    match revision {
        PreImageRevision::Index => "index",
        PreImageRevision::Head => "head",
    }
}

fn proof_changed(store: &termloop_store::Store, task_id: &str) -> CoreError {
    let current = store
        .managed_worktrees()
        .iter()
        .find(|proof| proof.task_id == task_id);
    let generation = store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .map_or(0, |task| task.worktree_generation);
    CoreError::ManagedWorktreeProofChanged {
        task_id: task_id.to_owned(),
        current_managed_worktree_operation_id: current.map(|proof| proof.operation_id.clone()),
        current_worktree_generation: generation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_changes_are_renderable_but_unmerged_changes_are_not() {
        assert_eq!(
            change_render_state(WorktreeChangeKind::Untracked),
            "available"
        );
        assert_eq!(
            change_render_state(WorktreeChangeKind::Unmerged),
            "notShown"
        );
    }

    #[test]
    fn cache_is_bounded_and_expired_observations_are_removed() {
        let mut cache = WorktreeChangeObservationCache::default();
        let proof = ManagedWorktreeProof {
            task_id: "task".into(),
            operation_id: "operation".into(),
            worktree_generation: 1,
            normalized_spec_version: 2,
            repository_common_dir: "/repo/.git".into(),
            registered_worktree_path: "/repo".into(),
            branch_ref: "refs/heads/main".into(),
            normalized_spec: termloop_domain::NormalizedWorktreeSpec {
                version: 2,
                repository_root: "/repo".into(),
                repository_common_dir: "/repo/.git".into(),
                destination_path: "/repo".into(),
                branch_name: "main".into(),
                branch_mode: termloop_domain::ProvisioningBranchMode::Existing,
                base_ref: None,
                base_oid: None,
            },
        };
        for index in 0..(CHANGE_OBSERVATION_CAP + 2) {
            cache
                .insert(format!("task-{index}"), proof.clone(), vec![], 10)
                .unwrap();
        }
        assert_eq!(cache.entries.len(), CHANGE_OBSERVATION_CAP);
        cache.retain_fresh(10 + CHANGE_OBSERVATION_TTL_MS);
        assert!(cache.entries.is_empty());
    }
}
