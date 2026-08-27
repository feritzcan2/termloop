//! Ephemeral, bounded Git content observations for the durable Project checkout.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use termloop_gitio::{
    GitRunner, PreImageContent, PreImageObservation, PreImageRevision, WorktreeChangeEntry,
    WorktreeChangeKind, WorktreeChangeSide, WorktreeChangesObservation, WorktreeDiffContent,
    WorktreeDiffObservation,
};

use crate::{CoreError, CoreRuntime, required_string};

const OBSERVATION_CAP: usize = 64;
const OBSERVATION_TTL_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProjectCheckoutProof {
    project_id: String,
    project_folder: PathBuf,
    worktree_root: PathBuf,
    common_dir: PathBuf,
}

#[derive(Clone)]
pub struct ProjectWorktreeChangeListPlan {
    project_id: String,
    project_folder: PathBuf,
}

pub struct ObservedProjectWorktreeChanges {
    observation: Result<(ProjectCheckoutProof, WorktreeChangesObservation), CoreError>,
}

#[derive(Clone)]
struct ProjectChangeSelection {
    proof: ProjectCheckoutProof,
    observation_id: String,
    entry_id: String,
    entry: WorktreeChangeEntry,
}

#[derive(Clone)]
pub struct ProjectWorktreeDiffPlan {
    selection: ProjectChangeSelection,
}

pub struct ObservedProjectWorktreeDiff {
    plan: ProjectWorktreeDiffPlan,
    observation: Result<WorktreeDiffObservation, CoreError>,
}

#[derive(Clone)]
pub struct ProjectWorktreePreImagePlan {
    selection: ProjectChangeSelection,
}

pub struct ObservedProjectWorktreePreImage {
    plan: ProjectWorktreePreImagePlan,
    observation: Result<PreImageObservation, CoreError>,
}

struct CachedProjectChangeObservation {
    observation_id: String,
    proof: ProjectCheckoutProof,
    expires_at_epoch_ms: u64,
    entries: Vec<WorktreeChangeEntry>,
}

#[derive(Default)]
pub(crate) struct ProjectChangeObservationCache {
    entries: VecDeque<CachedProjectChangeObservation>,
    next_sequence: u64,
}

impl ProjectChangeObservationCache {
    /// Drops every cached observation of one Project. Deleting a Project must
    /// not leave its file lists readable through an observation id that
    /// outlives it.
    pub(crate) fn retain_outside_project(&mut self, project_id: &str) {
        self.entries
            .retain(|observation| observation.proof.project_id != project_id);
    }

    fn retain_fresh(&mut self, now: u64) {
        self.entries
            .retain(|observation| observation.expires_at_epoch_ms > now);
    }

    fn insert(
        &mut self,
        proof: ProjectCheckoutProof,
        entries: Vec<WorktreeChangeEntry>,
        now: u64,
    ) -> Result<String, CoreError> {
        self.retain_fresh(now);
        self.next_sequence = self.next_sequence.checked_add(1).ok_or_else(|| {
            CoreError::Store("Project change observation sequence overflow".into())
        })?;
        let observation_id = format!("project-changes-{}", self.next_sequence);
        self.entries.push_back(CachedProjectChangeObservation {
            observation_id: observation_id.clone(),
            proof,
            expires_at_epoch_ms: now.saturating_add(OBSERVATION_TTL_MS),
            entries,
        });
        while self.entries.len() > OBSERVATION_CAP {
            self.entries.pop_front();
        }
        Ok(observation_id)
    }

    fn lookup(
        &mut self,
        project_id: &str,
        observation_id: &str,
        entry_id: &str,
        now: u64,
    ) -> Option<(ProjectCheckoutProof, WorktreeChangeEntry)> {
        self.retain_fresh(now);
        let observation = self.entries.iter().find(|observation| {
            observation.proof.project_id == project_id
                && observation.observation_id == observation_id
        })?;
        let index = entry_id.strip_prefix("entry-")?.parse::<usize>().ok()?;
        observation
            .entries
            .get(index)
            .cloned()
            .map(|entry| (observation.proof.clone(), entry))
    }
}

impl ProjectWorktreeChangeListPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn observe(self) -> ObservedProjectWorktreeChanges {
        let observation = observe_change_list(&self.project_id, &self.project_folder);
        ObservedProjectWorktreeChanges { observation }
    }
}

impl ProjectWorktreeDiffPlan {
    pub fn project_id(&self) -> &str {
        &self.selection.proof.project_id
    }

    pub fn observe(self) -> ObservedProjectWorktreeDiff {
        let observation = verified_runner(&self.selection.proof).and_then(|runner| {
            runner
                .diff_worktree_change(&self.selection.proof.project_folder, &self.selection.entry)
                .map_err(super::map_git_observation_error)
        });
        ObservedProjectWorktreeDiff {
            plan: self,
            observation,
        }
    }
}

impl ProjectWorktreePreImagePlan {
    pub fn project_id(&self) -> &str {
        &self.selection.proof.project_id
    }

    pub fn observe(self) -> ObservedProjectWorktreePreImage {
        let observation = verified_runner(&self.selection.proof).and_then(|runner| {
            runner
                .read_worktree_change_pre_image(
                    &self.selection.proof.project_folder,
                    &self.selection.entry,
                )
                .map_err(super::map_git_observation_error)
        });
        ObservedProjectWorktreePreImage {
            plan: self,
            observation,
        }
    }
}

impl CoreRuntime {
    pub fn plan_project_worktree_change_list(
        &self,
        project_id: &str,
    ) -> Result<ProjectWorktreeChangeListPlan, CoreError> {
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        Ok(ProjectWorktreeChangeListPlan {
            project_id: project.id.clone(),
            project_folder: PathBuf::from(&project.folder_path),
        })
    }

    pub fn complete_project_worktree_change_list(
        &mut self,
        observed: ObservedProjectWorktreeChanges,
    ) -> Result<Value, CoreError> {
        let (proof, observation) = observed.observation?;
        self.revalidate_project_folder(&proof)?;
        let entries = observation.entries;
        let projected = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| project_change_entry(index, entry))
            .collect::<Result<Vec<_>, _>>()?;
        let project_id = proof.project_id.clone();
        let observation_id = self.project_change_observations.insert(
            proof,
            entries,
            termloop_platform::current_epoch_ms(),
        )?;
        Ok(json!({
            "project_id": project_id,
            "observation_id": observation_id,
            "entries": projected,
            "truncated": observation.truncated,
        }))
    }

    pub fn plan_project_worktree_diff(
        &mut self,
        params: Value,
    ) -> Result<ProjectWorktreeDiffPlan, CoreError> {
        Ok(ProjectWorktreeDiffPlan {
            selection: self.resolve_project_change(params)?,
        })
    }

    pub fn complete_project_worktree_diff(
        &self,
        observed: ObservedProjectWorktreeDiff,
    ) -> Result<Value, CoreError> {
        let selection = &observed.plan.selection;
        self.revalidate_project_folder(&selection.proof)?;
        let (state, patch) = project_diff_content(observed.observation?.content);
        Ok(json!({
            "project_id": selection.proof.project_id,
            "observation_id": selection.observation_id,
            "entry_id": selection.entry_id,
            "state": state,
            "patch": patch,
        }))
    }

    pub fn plan_project_worktree_pre_image(
        &mut self,
        params: Value,
    ) -> Result<ProjectWorktreePreImagePlan, CoreError> {
        Ok(ProjectWorktreePreImagePlan {
            selection: self.resolve_project_change(params)?,
        })
    }

    pub fn complete_project_worktree_pre_image(
        &self,
        observed: ObservedProjectWorktreePreImage,
    ) -> Result<Value, CoreError> {
        let selection = &observed.plan.selection;
        self.revalidate_project_folder(&selection.proof)?;
        let pre_image = observed.observation?;
        let (state, content) = project_pre_image_content(pre_image.content);
        Ok(json!({
            "project_id": selection.proof.project_id,
            "observation_id": selection.observation_id,
            "entry_id": selection.entry_id,
            "state": state,
            "revision": revision_name(pre_image.revision),
            "content": content,
        }))
    }

    fn resolve_project_change(
        &mut self,
        params: Value,
    ) -> Result<ProjectChangeSelection, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let observation_id = required_string(&params, "observationId")?;
        let entry_id = required_string(&params, "entryId")?;
        let Some((proof, entry)) = self.project_change_observations.lookup(
            &project_id,
            &observation_id,
            &entry_id,
            termloop_platform::current_epoch_ms(),
        ) else {
            return Err(CoreError::RepositoryUnavailable);
        };
        self.revalidate_project_folder(&proof)?;
        Ok(ProjectChangeSelection {
            proof,
            observation_id,
            entry_id,
            entry,
        })
    }

    fn revalidate_project_folder(&self, proof: &ProjectCheckoutProof) -> Result<(), CoreError> {
        let current = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == proof.project_id)
            .ok_or(CoreError::NotFound)?;
        if Path::new(&current.folder_path) == proof.project_folder {
            Ok(())
        } else {
            Err(CoreError::RepositoryUnavailable)
        }
    }
}

fn observe_change_list(
    project_id: &str,
    project_folder: &Path,
) -> Result<(ProjectCheckoutProof, WorktreeChangesObservation), CoreError> {
    let runner = GitRunner::discover_with_timeout(termloop_gitio::HEALTH_GIT_SUBPROCESS_DEADLINE)
        .map_err(super::map_git_observation_error)?;
    let facts = runner
        .inspect_repository(project_folder)
        .map_err(super::map_git_observation_error)?;
    let worktree_root = facts
        .worktree_root
        .ok_or(CoreError::RepositoryUnavailable)?;
    let proof = ProjectCheckoutProof {
        project_id: project_id.to_owned(),
        project_folder: project_folder.to_owned(),
        worktree_root,
        common_dir: facts.common_dir,
    };
    let changes = runner
        .list_worktree_changes(project_folder)
        .map_err(super::map_git_observation_error)?;
    Ok((proof, changes))
}

fn verified_runner(proof: &ProjectCheckoutProof) -> Result<GitRunner, CoreError> {
    let runner = GitRunner::discover_with_timeout(termloop_gitio::HEALTH_GIT_SUBPROCESS_DEADLINE)
        .map_err(super::map_git_observation_error)?;
    let facts = runner
        .inspect_repository(&proof.project_folder)
        .map_err(super::map_git_observation_error)?;
    if facts.worktree_root.as_ref() != Some(&proof.worktree_root)
        || facts.common_dir != proof.common_dir
    {
        return Err(CoreError::RepositoryUnavailable);
    }
    Ok(runner)
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

fn display_path(path: &Path) -> Result<(String, bool), CoreError> {
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

fn kind_name(kind: WorktreeChangeKind) -> &'static str {
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

fn project_diff_content(content: WorktreeDiffContent) -> (&'static str, Option<String>) {
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

fn project_pre_image_content(content: PreImageContent) -> (&'static str, Option<String>) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_store::Store;
    use termloop_terminal::TerminalService;
    use uuid::Uuid;

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
    fn project_delete_drops_the_change_observations_it_cached() {
        let state_path = std::env::temp_dir().join(format!(
            "termloop-project-changes-delete-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        let directory = std::env::temp_dir().join(format!(
            "termloop-project-checkout-delete-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let runner = GitRunner::discover().unwrap();
        termloop_gitio::test_support::initialize_repository(&runner, &directory).unwrap();
        std::fs::write(directory.join("tracked.txt"), b"base\n").unwrap();
        termloop_gitio::test_support::commit_all(&runner, &directory, "tracked fixture").unwrap();
        std::fs::write(directory.join("tracked.txt"), b"changed\n").unwrap();

        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&state_path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project = runtime
            .create_project(json!({ "name": "Project", "folderPath": directory }))
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        let observed = runtime
            .plan_project_worktree_change_list(&project_id)
            .unwrap()
            .observe();
        let list = runtime
            .complete_project_worktree_change_list(observed)
            .unwrap();
        let observation_id = list["observation_id"].as_str().unwrap().to_owned();
        let entry_id = list["entries"][0]["entry_id"].as_str().unwrap().to_owned();
        assert!(!runtime.project_change_observations.entries.is_empty());

        runtime
            .delete_project(json!({ "projectId": project_id }))
            .unwrap();

        // The cached observation held this Project's changed-file list, so it
        // goes with the Project rather than waiting out its own TTL.
        assert!(runtime.project_change_observations.entries.is_empty());
        assert!(
            runtime
                .plan_project_worktree_diff(json!({
                    "projectId": project_id,
                    "observationId": observation_id,
                    "entryId": entry_id,
                }))
                .is_err()
        );

        drop(runtime);
        let _ = std::fs::remove_file(state_path);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn project_change_list_diff_and_pre_image_are_ephemeral_and_project_scoped() {
        let state_path = std::env::temp_dir().join(format!(
            "termloop-project-changes-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        let directory =
            std::env::temp_dir().join(format!("termloop-project-checkout-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let runner = GitRunner::discover().unwrap();
        termloop_gitio::test_support::initialize_repository(&runner, &directory).unwrap();
        std::fs::write(directory.join("tracked.txt"), b"base\n").unwrap();
        termloop_gitio::test_support::commit_all(&runner, &directory, "tracked fixture").unwrap();
        std::fs::write(directory.join("tracked.txt"), b"changed\n").unwrap();

        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&state_path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project = runtime
            .create_project(json!({ "name": "Project", "folderPath": directory }))
            .unwrap();
        let project_id = project["id"].as_str().unwrap();
        let revision = runtime.state_revision();
        let observed = runtime
            .plan_project_worktree_change_list(project_id)
            .unwrap()
            .observe();
        let list = runtime
            .complete_project_worktree_change_list(observed)
            .unwrap();
        assert_eq!(list["project_id"], project_id);
        assert_eq!(list["entries"].as_array().unwrap().len(), 1);

        let entry_id = list["entries"][0]["entry_id"].as_str().unwrap();
        let observation_id = list["observation_id"].as_str().unwrap();
        let diff_plan = runtime
            .plan_project_worktree_diff(json!({
                "projectId": project_id,
                "observationId": observation_id,
                "entryId": entry_id,
            }))
            .unwrap();
        let diff = runtime
            .complete_project_worktree_diff(diff_plan.observe())
            .unwrap();
        assert_eq!(diff["state"], "patch");
        let pre_image_plan = runtime
            .plan_project_worktree_pre_image(json!({
                "projectId": project_id,
                "observationId": observation_id,
                "entryId": entry_id,
            }))
            .unwrap();
        let pre_image = runtime
            .complete_project_worktree_pre_image(pre_image_plan.observe())
            .unwrap();
        assert_eq!(pre_image["state"], "content");
        assert_eq!(runtime.state_revision(), revision);

        drop(runtime);
        let _ = std::fs::remove_file(state_path);
        let _ = std::fs::remove_dir_all(directory);
    }
}
