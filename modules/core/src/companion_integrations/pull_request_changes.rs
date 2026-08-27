use super::*;
use crate::{CoreError, CoreRuntime};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use termloop_providers::{
    ProviderPullRequestChange, ProviderPullRequestChangeKind, ProviderPullRequestChangeList,
    ProviderPullRequestDiff, ProviderPullRequestDiffState, PullRequestChangeIdentity,
};

const OBSERVATION_TTL_MS: u64 = 60_000;
const MAX_OBSERVATIONS: usize = 64;
const MAX_OBSERVATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 256;
const GIT_HOST_CONTENT_JOB_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LIST_RESPONSE_BYTES: usize = 1024 * 1024;
const LIST_RESPONSE_FIXED_RESERVE: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GitHostSelectionProvider {
    Github,
    AzureDevOps,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct GitHostPullRequestSelection {
    pub provider: GitHostSelectionProvider,
    pub repository_owner: String,
    pub repository_project: Option<String>,
    pub repository_name: String,
    pub number: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestChangesReason {
    StaleProjection,
    ProviderUnavailable,
    Unauthorized,
    Offline,
    RateLimited,
    Timeout,
    OutputLimit,
    MalformedResponse,
    ProviderFailure,
    Changed,
}

#[derive(Clone)]
pub struct PullRequestChangeListPlan {
    snapshot: ChangeTaskSnapshot,
    expected_generation: u64,
    selection: GitHostPullRequestSelection,
    job: Option<GitHostContentJob>,
    preflight_reason: Option<PullRequestChangesReason>,
}

#[derive(Clone)]
pub struct PullRequestDiffPlan {
    task_id: String,
    observation_id: String,
    entry_id: String,
    snapshot: Option<ChangeTaskSnapshot>,
    expected_generation: Option<u64>,
    selection: Option<GitHostPullRequestSelection>,
    job: Option<GitHostContentJob>,
    preflight_reason: Option<PullRequestChangesReason>,
}

#[derive(Clone)]
struct ChangeTaskSnapshot {
    task_id: String,
    project_id: String,
    branch_name: String,
    repository_root: String,
}

#[derive(Clone)]
pub struct GitHostContentJob {
    key: String,
    work: GitHostContentWork,
    github: Option<GitHubClient>,
    azure: Option<AzureDevOpsClient>,
    deadline: termloop_platform::MonotonicDeadline,
}

#[derive(Clone)]
enum GitHostContentWork {
    List(PullRequestChangeIdentity),
    Diff {
        observation: Box<ProviderPullRequestChangeList>,
        change: ProviderPullRequestChange,
    },
}

#[derive(Clone)]
pub struct GitHostContentOutcome {
    key: String,
    value: GitHostContentOutcomeValue,
}

#[derive(Clone)]
enum GitHostContentOutcomeValue {
    List(Box<Result<ProviderPullRequestChangeList, ProviderFailure>>),
    Diff(Result<ProviderPullRequestDiff, ProviderFailure>),
}

#[derive(Default)]
pub(crate) struct PullRequestChangeObservationCache {
    entries: HashMap<String, ChangeObservation>,
    sequence: u64,
    next_id: u64,
    total_bytes: usize,
}

#[derive(Clone)]
struct ChangeObservation {
    task_id: String,
    project_id: String,
    snapshot: ChangeTaskSnapshot,
    freshness_generation: u64,
    selection: GitHostPullRequestSelection,
    provider: ProviderPullRequestChangeList,
    observed_at: u64,
    last_access_sequence: u64,
    bytes: usize,
}

impl CoreRuntime {
    pub fn plan_git_host_pull_request_change_list(
        &self,
        task_id: &str,
        expected_generation: u64,
        selection: GitHostPullRequestSelection,
    ) -> Result<PullRequestChangeListPlan, CoreError> {
        validate_selection(&selection)?;
        let snapshot = task_snapshot(self, task_id)?;
        let preflight_reason =
            (!projection_contains(self, &snapshot, expected_generation, &selection))
                .then_some(PullRequestChangesReason::StaleProjection);
        let deadline = termloop_platform::MonotonicDeadline::after(GIT_HOST_CONTENT_JOB_TIMEOUT)
            .map_err(|_| CoreError::Store("provider deadline could not be created".into()))?;
        let job = preflight_reason.is_none().then(|| {
            let identity = provider_identity(&selection);
            GitHostContentJob {
                key: format!("content:list:{}:{expected_generation}", identity.key()),
                work: GitHostContentWork::List(identity),
                github: self.github_client.clone(),
                azure: self.azure_devops_client.clone(),
                deadline,
            }
        });
        Ok(PullRequestChangeListPlan {
            snapshot,
            expected_generation,
            selection,
            job,
            preflight_reason,
        })
    }

    pub fn apply_git_host_pull_request_change_list(
        &mut self,
        plan: PullRequestChangeListPlan,
        outcome: Option<GitHostContentOutcome>,
        observed_at: u64,
    ) -> Result<Value, CoreError> {
        if let Some(reason) = plan.preflight_reason {
            return Ok(unavailable_list(
                &plan.snapshot.task_id,
                &plan.selection,
                reason,
            ));
        }
        if !projection_contains(
            self,
            &plan.snapshot,
            plan.expected_generation,
            &plan.selection,
        ) {
            return Ok(unavailable_list(
                &plan.snapshot.task_id,
                &plan.selection,
                PullRequestChangesReason::Changed,
            ));
        }
        let result = match outcome.map(|outcome| outcome.value) {
            Some(GitHostContentOutcomeValue::List(result)) => *result,
            _ => Err(ProviderFailure::Timeout),
        };
        let mut provider = match result {
            Ok(provider) if selection_matches_provider(&plan.selection, &provider.identity) => {
                provider
            }
            Ok(_) => {
                return Ok(unavailable_list(
                    &plan.snapshot.task_id,
                    &plan.selection,
                    PullRequestChangesReason::Changed,
                ));
            }
            Err(failure) => {
                return Ok(unavailable_list(
                    &plan.snapshot.task_id,
                    &plan.selection,
                    map_provider_failure(failure),
                ));
            }
        };
        if provider.changes.len() > MAX_ENTRIES {
            return Ok(unavailable_list(
                &plan.snapshot.task_id,
                &plan.selection,
                PullRequestChangesReason::OutputLimit,
            ));
        }
        bound_provider_for_wire(&mut provider);
        let Some(observation_id) = self.git_host_change_observations.insert(
            self.runtime_epoch,
            plan.snapshot.clone(),
            plan.expected_generation,
            plan.selection.clone(),
            provider.clone(),
            observed_at,
        ) else {
            return Ok(unavailable_list(
                &plan.snapshot.task_id,
                &plan.selection,
                PullRequestChangesReason::OutputLimit,
            ));
        };
        Ok(json!({
            "task_id": plan.snapshot.task_id,
            "pull_request": selection_json(&plan.selection),
            "state": "available",
            "reason": Value::Null,
            "observation_id": observation_id,
            "entries": provider.changes.iter().enumerate().map(entry_json).collect::<Vec<_>>(),
            "truncated": provider.truncated,
        }))
    }

    pub fn plan_git_host_pull_request_diff(
        &mut self,
        task_id: &str,
        observation_id: &str,
        entry_id: &str,
        observed_at: u64,
    ) -> Result<PullRequestDiffPlan, CoreError> {
        if !self.store.tasks().iter().any(|task| task.id == task_id) {
            return Err(CoreError::NotFound);
        }
        let observation =
            self.git_host_change_observations
                .get(observation_id, task_id, observed_at);
        let Some(observation) = observation else {
            return Ok(PullRequestDiffPlan::unavailable(
                task_id,
                observation_id,
                entry_id,
                PullRequestChangesReason::StaleProjection,
            ));
        };
        if !projection_contains(
            self,
            &observation.snapshot,
            observation.freshness_generation,
            &observation.selection,
        ) {
            self.git_host_change_observations.remove(observation_id);
            return Ok(PullRequestDiffPlan::unavailable(
                task_id,
                observation_id,
                entry_id,
                PullRequestChangesReason::Changed,
            ));
        }
        let Some(index) = parse_entry_id(entry_id) else {
            return Err(CoreError::InvalidParams("entryId".into()));
        };
        let Some(change) = observation.provider.changes.get(index).cloned() else {
            return Err(CoreError::InvalidParams("entryId".into()));
        };
        let deadline = termloop_platform::MonotonicDeadline::after(GIT_HOST_CONTENT_JOB_TIMEOUT)
            .map_err(|_| CoreError::Store("provider deadline could not be created".into()))?;
        let job = GitHostContentJob {
            // The opaque observation ID binds provider revision, both repository
            // identities, immutable versions, and the exact sanitized entry facts.
            // Coalescing across observations could otherwise deliver a patch for a
            // different Azure iteration/path while keeping private paths out of the
            // scheduler key.
            key: diff_job_key(observation_id, entry_id),
            work: GitHostContentWork::Diff {
                observation: Box::new(observation.provider.clone()),
                change,
            },
            github: self.github_client.clone(),
            azure: self.azure_devops_client.clone(),
            deadline,
        };
        Ok(PullRequestDiffPlan {
            task_id: task_id.into(),
            observation_id: observation_id.into(),
            entry_id: entry_id.into(),
            snapshot: Some(observation.snapshot),
            expected_generation: Some(observation.freshness_generation),
            selection: Some(observation.selection),
            job: Some(job),
            preflight_reason: None,
        })
    }

    pub fn apply_git_host_pull_request_diff(
        &mut self,
        plan: PullRequestDiffPlan,
        outcome: Option<GitHostContentOutcome>,
        observed_at: u64,
    ) -> Result<Value, CoreError> {
        if let Some(reason) = plan.preflight_reason {
            return Ok(unavailable_diff(&plan, reason));
        }
        let applicable = plan
            .snapshot
            .as_ref()
            .zip(plan.expected_generation)
            .zip(plan.selection.as_ref())
            .is_some_and(|((snapshot, generation), selection)| {
                projection_contains(self, snapshot, generation, selection)
            });
        if !applicable
            || !self.git_host_change_observations.contains(
                &plan.observation_id,
                &plan.task_id,
                observed_at,
            )
        {
            return Ok(unavailable_diff(&plan, PullRequestChangesReason::Changed));
        }
        let result = match outcome.map(|outcome| outcome.value) {
            Some(GitHostContentOutcomeValue::Diff(result)) => result,
            _ => Err(ProviderFailure::Timeout),
        };
        match result {
            Err(failure) => Ok(unavailable_diff(&plan, map_provider_failure(failure))),
            Ok(diff) => Ok(diff_json(&plan, diff)),
        }
    }
}

fn bound_provider_for_wire(provider: &mut ProviderPullRequestChangeList) {
    let mut admitted = 0_usize;
    let mut bytes = LIST_RESPONSE_FIXED_RESERVE;
    for (index, change) in provider.changes.iter().enumerate() {
        let Some(entry_bytes) = serde_json::to_vec(&entry_json((index, change))).ok() else {
            provider.truncated = true;
            break;
        };
        if bytes.saturating_add(entry_bytes.len()).saturating_add(1) > MAX_LIST_RESPONSE_BYTES {
            provider.truncated = true;
            break;
        }
        bytes = bytes.saturating_add(entry_bytes.len()).saturating_add(1);
        admitted += 1;
    }
    if admitted < provider.changes.len() {
        provider.changes.truncate(admitted);
        provider.truncated = true;
    }
}

impl PullRequestChangeListPlan {
    pub fn job(&self) -> Option<GitHostContentJob> {
        self.job.clone()
    }

    pub fn project_id(&self) -> &str {
        &self.snapshot.project_id
    }
}

impl PullRequestDiffPlan {
    fn unavailable(
        task_id: &str,
        observation_id: &str,
        entry_id: &str,
        reason: PullRequestChangesReason,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            observation_id: observation_id.into(),
            entry_id: entry_id.into(),
            snapshot: None,
            expected_generation: None,
            selection: None,
            job: None,
            preflight_reason: Some(reason),
        }
    }

    pub fn job(&self) -> Option<GitHostContentJob> {
        self.job.clone()
    }

    pub fn project_id(&self) -> Option<&str> {
        self.snapshot
            .as_ref()
            .map(|snapshot| snapshot.project_id.as_str())
    }
}

impl GitHostContentJob {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn execute(self) -> GitHostContentOutcome {
        let value = match &self.work {
            GitHostContentWork::List(identity) => match identity.provider {
                GitHostProvider::Github => GitHostContentOutcomeValue::List(Box::new(
                    self.github
                        .as_ref()
                        .ok_or(ProviderFailure::ProviderUnavailable)
                        .and_then(|client| {
                            self.deadline
                                .remaining()
                                .ok_or(ProviderFailure::Timeout)
                                .and_then(|remaining| {
                                    client
                                        .list_pull_request_changes_with_timeout(identity, remaining)
                                })
                        }),
                )),
                GitHostProvider::AzureDevOps => GitHostContentOutcomeValue::List(Box::new(
                    self.azure
                        .as_ref()
                        .ok_or(ProviderFailure::ProviderUnavailable)
                        .and_then(|client| {
                            self.deadline
                                .remaining()
                                .ok_or(ProviderFailure::Timeout)
                                .and_then(|remaining| {
                                    client
                                        .list_pull_request_changes_with_timeout(identity, remaining)
                                })
                        }),
                )),
            },
            GitHostContentWork::Diff {
                observation,
                change,
            } => match observation.identity.provider {
                GitHostProvider::Github => GitHostContentOutcomeValue::Diff(
                    self.github
                        .as_ref()
                        .ok_or(ProviderFailure::ProviderUnavailable)
                        .and_then(|client| {
                            self.deadline
                                .remaining()
                                .ok_or(ProviderFailure::Timeout)
                                .and_then(|remaining| {
                                    client.pull_request_diff_with_timeout(
                                        observation,
                                        change,
                                        remaining,
                                    )
                                })
                        }),
                ),
                GitHostProvider::AzureDevOps => GitHostContentOutcomeValue::Diff(
                    self.azure
                        .as_ref()
                        .ok_or(ProviderFailure::ProviderUnavailable)
                        .and_then(|client| {
                            self.deadline
                                .remaining()
                                .ok_or(ProviderFailure::Timeout)
                                .and_then(|remaining| {
                                    client.pull_request_diff_with_timeout(
                                        observation,
                                        change,
                                        remaining,
                                    )
                                })
                        }),
                ),
            },
        };
        GitHostContentOutcome {
            key: self.key,
            value,
        }
    }

    pub fn timeout_outcome(&self) -> GitHostContentOutcome {
        let value = match self.work {
            GitHostContentWork::List(_) => {
                GitHostContentOutcomeValue::List(Box::new(Err(ProviderFailure::Timeout)))
            }
            GitHostContentWork::Diff { .. } => {
                GitHostContentOutcomeValue::Diff(Err(ProviderFailure::Timeout))
            }
        };
        GitHostContentOutcome {
            key: self.key.clone(),
            value,
        }
    }
}

impl GitHostContentOutcome {
    pub fn key(&self) -> &str {
        &self.key
    }
}

impl PullRequestChangeObservationCache {
    fn insert(
        &mut self,
        runtime_epoch: u64,
        snapshot: ChangeTaskSnapshot,
        freshness_generation: u64,
        selection: GitHostPullRequestSelection,
        provider: ProviderPullRequestChangeList,
        observed_at: u64,
    ) -> Option<String> {
        let bytes = observation_bytes(&snapshot, freshness_generation, &selection, &provider)?;
        if bytes > MAX_OBSERVATION_BYTES {
            return None;
        }
        self.next_id = self.next_id.wrapping_add(1);
        self.sequence = self.sequence.wrapping_add(1);
        let id = format!("prc-{runtime_epoch:x}-{:x}", self.next_id);
        let observation = ChangeObservation {
            task_id: snapshot.task_id.clone(),
            project_id: snapshot.project_id.clone(),
            snapshot,
            freshness_generation,
            selection,
            provider,
            observed_at,
            last_access_sequence: self.sequence,
            bytes,
        };
        if let Some(previous) = self.entries.insert(id.clone(), observation) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.bytes);
        }
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        while self.entries.len() > MAX_OBSERVATIONS || self.total_bytes > MAX_OBSERVATION_BYTES {
            self.evict_oldest();
        }
        self.entries.contains_key(&id).then_some(id)
    }

    fn get(&mut self, id: &str, task_id: &str, now: u64) -> Option<ChangeObservation> {
        let expired = self
            .entries
            .get(id)
            .is_some_and(|entry| now.saturating_sub(entry.observed_at) >= OBSERVATION_TTL_MS);
        if expired {
            self.remove(id);
            return None;
        }
        self.sequence = self.sequence.wrapping_add(1);
        let entry = self
            .entries
            .get_mut(id)
            .filter(|entry| entry.task_id == task_id)?;
        entry.last_access_sequence = self.sequence;
        Some(entry.clone())
    }

    fn contains(&mut self, id: &str, task_id: &str, now: u64) -> bool {
        self.get(id, task_id, now).is_some()
    }

    pub(crate) fn remove(&mut self, id: &str) {
        if let Some(removed) = self.entries.remove(id) {
            self.total_bytes = self.total_bytes.saturating_sub(removed.bytes);
        }
    }

    pub(crate) fn remove_task(&mut self, task_id: &str) {
        let ids = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.task_id == task_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.remove(&id);
        }
    }

    pub(crate) fn retain_projects(&mut self, projects: &[String]) {
        let projects = projects.iter().collect::<BTreeSet<_>>();
        let ids = self
            .entries
            .iter()
            .filter(|(_, entry)| !projects.contains(&entry.project_id))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.remove(&id);
        }
    }

    fn evict_oldest(&mut self) {
        let id = self
            .entries
            .iter()
            .min_by(|(left_id, left), (right_id, right)| {
                left.last_access_sequence
                    .cmp(&right.last_access_sequence)
                    .then_with(|| left_id.cmp(right_id))
            })
            .map(|(id, _)| id.clone());
        if let Some(id) = id {
            self.remove(&id);
        }
    }
}

fn observation_bytes(
    snapshot: &ChangeTaskSnapshot,
    freshness_generation: u64,
    selection: &GitHostPullRequestSelection,
    provider: &ProviderPullRequestChangeList,
) -> Option<usize> {
    serde_json::to_vec(&json!({
        "task": [&snapshot.task_id, &snapshot.project_id, &snapshot.branch_name, &snapshot.repository_root],
        "generation": freshness_generation,
        "selection": selection_json(selection),
        "base": provider.base_version,
        "head": provider.head_version,
        "revision": provider.provider_revision,
        "targetRepository": provider.target_repository_id,
        "sourceRepository": provider.source_repository_id,
        "sourceProject": provider.source_repository_project,
        "changes": provider.changes.iter().map(|change| json!({
            "path": change.path,
            "originalPath": change.original_path,
            "kind": change_kind_name(change.kind),
            "ordinal": change.ordinal,
            "version": change.file_version,
        })).collect::<Vec<_>>(),
        "truncated": provider.truncated,
    }))
    .ok()
    .map(|bytes| bytes.len())
}

fn task_snapshot(runtime: &CoreRuntime, task_id: &str) -> Result<ChangeTaskSnapshot, CoreError> {
    let task = runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .ok_or(CoreError::NotFound)?;
    let branch = task.branch.as_ref().ok_or(CoreError::NotFound)?;
    Ok(ChangeTaskSnapshot {
        task_id: task.id.clone(),
        project_id: task.project_id.clone(),
        branch_name: branch.name.clone(),
        repository_root: branch.repository_root.clone(),
    })
}

fn projection_contains(
    runtime: &CoreRuntime,
    snapshot: &ChangeTaskSnapshot,
    generation: u64,
    selection: &GitHostPullRequestSelection,
) -> bool {
    let task_matches = runtime.store.tasks().iter().any(|task| {
        task.id == snapshot.task_id
            && task.project_id == snapshot.project_id
            && task.branch.as_ref().is_some_and(|branch| {
                branch.name == snapshot.branch_name
                    && branch.repository_root == snapshot.repository_root
            })
    });
    task_matches
        && runtime
            .git_host_projections
            .entries
            .get(&snapshot.task_id)
            .is_some_and(|entry| {
                entry.projection.freshness_generation == generation
                    && entry
                        .projection
                        .matches
                        .iter()
                        .any(|summary| selection_matches_summary(selection, summary))
            })
}

fn validate_selection(selection: &GitHostPullRequestSelection) -> Result<(), CoreError> {
    let valid_common = selection.number > 0
        && !selection.repository_owner.is_empty()
        && selection.repository_owner.chars().count() <= 100
        && !selection.repository_name.is_empty()
        && selection.repository_name.chars().count() <= 100
        && !selection.repository_owner.chars().any(char::is_control)
        && !selection.repository_name.chars().any(char::is_control);
    let valid_provider =
        match selection.provider {
            GitHostSelectionProvider::Github => selection.repository_project.is_none(),
            GitHostSelectionProvider::AzureDevOps => selection
                .repository_project
                .as_ref()
                .is_some_and(|project| {
                    !project.is_empty()
                        && project.chars().count() <= 64
                        && !project.chars().any(char::is_control)
                }),
        };
    if valid_common && valid_provider {
        Ok(())
    } else {
        Err(CoreError::InvalidParams("pullRequest".into()))
    }
}

fn selection_matches_summary(
    selection: &GitHostPullRequestSelection,
    summary: &GitHostPullRequestSummary,
) -> bool {
    let provider_matches = matches!(
        (selection.provider, summary.provider.as_str()),
        (GitHostSelectionProvider::Github, "github")
            | (GitHostSelectionProvider::AzureDevOps, "azureDevOps")
    );
    provider_matches
        && selection.number == summary.number
        && match selection.provider {
            GitHostSelectionProvider::Github => {
                selection
                    .repository_owner
                    .eq_ignore_ascii_case(&summary.repository_owner)
                    && selection
                        .repository_name
                        .eq_ignore_ascii_case(&summary.repository_name)
                    && selection.repository_project.is_none()
                    && summary.repository_project.is_none()
            }
            GitHostSelectionProvider::AzureDevOps => {
                selection
                    .repository_owner
                    .eq_ignore_ascii_case(&summary.repository_owner)
                    && azure_name_eq(&selection.repository_name, &summary.repository_name)
                    && selection
                        .repository_project
                        .as_deref()
                        .is_some_and(|project| {
                            summary
                                .repository_project
                                .as_deref()
                                .is_some_and(|actual| azure_name_eq(project, actual))
                        })
            }
        }
}

fn selection_matches_provider(
    selection: &GitHostPullRequestSelection,
    identity: &PullRequestChangeIdentity,
) -> bool {
    selection.number == identity.number
        && match selection.provider {
            GitHostSelectionProvider::Github => {
                identity.provider == GitHostProvider::Github
                    && identity.repository_project.is_none()
                    && selection
                        .repository_owner
                        .eq_ignore_ascii_case(&identity.repository_owner)
                    && selection
                        .repository_name
                        .eq_ignore_ascii_case(&identity.repository_name)
            }
            GitHostSelectionProvider::AzureDevOps => {
                identity.provider == GitHostProvider::AzureDevOps
                    && selection
                        .repository_owner
                        .eq_ignore_ascii_case(&identity.repository_owner)
                    && azure_name_eq(&selection.repository_name, &identity.repository_name)
                    && selection
                        .repository_project
                        .as_deref()
                        .is_some_and(|project| {
                            identity
                                .repository_project
                                .as_deref()
                                .is_some_and(|actual| azure_name_eq(project, actual))
                        })
            }
        }
}

fn provider_identity(selection: &GitHostPullRequestSelection) -> PullRequestChangeIdentity {
    PullRequestChangeIdentity {
        provider: match selection.provider {
            GitHostSelectionProvider::Github => GitHostProvider::Github,
            GitHostSelectionProvider::AzureDevOps => GitHostProvider::AzureDevOps,
        },
        repository_owner: selection.repository_owner.clone(),
        repository_project: selection.repository_project.clone(),
        repository_name: selection.repository_name.clone(),
        number: selection.number,
    }
}

fn selection_json(selection: &GitHostPullRequestSelection) -> Value {
    json!({
        "provider": match selection.provider { GitHostSelectionProvider::Github => "github", GitHostSelectionProvider::AzureDevOps => "azureDevOps" },
        "repository_owner": selection.repository_owner,
        "repository_project": selection.repository_project,
        "repository_name": selection.repository_name,
        "number": selection.number,
    })
}

fn entry_json((index, change): (usize, &ProviderPullRequestChange)) -> Value {
    json!({
        "entry_id": format!("e-{index}"),
        "display_path": safe_display_path(&change.path),
        "original_display_path": change.original_path.as_deref().map(safe_display_path),
        "path_encoding": "utf8",
        "kind": change_kind_name(change.kind),
        "render_state": "available",
    })
}

fn safe_display_path(value: &str) -> String {
    let value = value.strip_prefix('/').unwrap_or(value);
    let mut output = String::new();
    for character in value.chars().take(4096) {
        if character.is_control()
            || matches!(character, '\u{2028}' | '\u{2029}')
            || matches!(character, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            output.push('�');
        } else {
            output.push(character);
        }
    }
    if output.is_empty() {
        "(unnamed)".into()
    } else {
        output
    }
}

fn change_kind_name(kind: ProviderPullRequestChangeKind) -> &'static str {
    match kind {
        ProviderPullRequestChangeKind::Modified => "modified",
        ProviderPullRequestChangeKind::Added => "added",
        ProviderPullRequestChangeKind::Deleted => "deleted",
        ProviderPullRequestChangeKind::Renamed => "renamed",
        ProviderPullRequestChangeKind::Copied => "copied",
    }
}

fn parse_entry_id(value: &str) -> Option<usize> {
    let digits = value.strip_prefix("e-")?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

fn diff_job_key(observation_id: &str, entry_id: &str) -> String {
    format!("content:diff:{observation_id}:{entry_id}")
}

fn reason_name(reason: PullRequestChangesReason) -> &'static str {
    match reason {
        PullRequestChangesReason::StaleProjection => "staleProjection",
        PullRequestChangesReason::ProviderUnavailable => "providerUnavailable",
        PullRequestChangesReason::Unauthorized => "unauthorized",
        PullRequestChangesReason::Offline => "offline",
        PullRequestChangesReason::RateLimited => "rateLimited",
        PullRequestChangesReason::Timeout => "timeout",
        PullRequestChangesReason::OutputLimit => "outputLimit",
        PullRequestChangesReason::MalformedResponse => "malformedResponse",
        PullRequestChangesReason::ProviderFailure => "providerFailure",
        PullRequestChangesReason::Changed => "changed",
    }
}

fn map_provider_failure(failure: ProviderFailure) -> PullRequestChangesReason {
    match failure {
        ProviderFailure::ProviderUnavailable => PullRequestChangesReason::ProviderUnavailable,
        ProviderFailure::Unauthorized => PullRequestChangesReason::Unauthorized,
        ProviderFailure::Offline => PullRequestChangesReason::Offline,
        ProviderFailure::RateLimited => PullRequestChangesReason::RateLimited,
        ProviderFailure::Timeout => PullRequestChangesReason::Timeout,
        ProviderFailure::OutputLimit => PullRequestChangesReason::OutputLimit,
        ProviderFailure::MalformedResponse => PullRequestChangesReason::MalformedResponse,
        ProviderFailure::ProviderFailure => PullRequestChangesReason::ProviderFailure,
    }
}

fn unavailable_list(
    task_id: &str,
    selection: &GitHostPullRequestSelection,
    reason: PullRequestChangesReason,
) -> Value {
    json!({
        "task_id": task_id,
        "pull_request": selection_json(selection),
        "state": "unavailable",
        "reason": reason_name(reason),
        "observation_id": Value::Null,
        "entries": [],
        "truncated": false,
    })
}

fn unavailable_diff(plan: &PullRequestDiffPlan, reason: PullRequestChangesReason) -> Value {
    json!({
        "task_id": plan.task_id,
        "observation_id": plan.observation_id,
        "entry_id": plan.entry_id,
        "state": "unavailable",
        "reason": reason_name(reason),
        "patch": Value::Null,
    })
}

fn diff_json(plan: &PullRequestDiffPlan, diff: ProviderPullRequestDiff) -> Value {
    let (state, reason) = match diff.state {
        ProviderPullRequestDiffState::Patch => ("patch", None),
        ProviderPullRequestDiffState::Binary => ("binary", None),
        ProviderPullRequestDiffState::NotShown => ("notShown", None),
        ProviderPullRequestDiffState::Truncated => ("truncated", None),
        ProviderPullRequestDiffState::NonUtf8 => ("nonUtf8", None),
        ProviderPullRequestDiffState::Changed => {
            ("unavailable", Some(PullRequestChangesReason::Changed))
        }
    };
    json!({
        "task_id": plan.task_id,
        "observation_id": plan.observation_id,
        "entry_id": plan.entry_id,
        "state": state,
        "reason": reason.map(reason_name),
        "patch": diff.patch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_ids_are_opaque_ordinals_and_display_paths_hide_controls() {
        assert_eq!(parse_entry_id("e-12"), Some(12));
        assert_eq!(parse_entry_id("../12"), None);
        assert_eq!(safe_display_path("/src/a\u{202e}.rs"), "src/a�.rs");
        assert_eq!(safe_display_path("/src/a\u{2028}.rs"), "src/a�.rs");
    }

    #[test]
    fn pull_request_file_list_is_truncated_before_the_wire_byte_cap() {
        let selection = GitHostPullRequestSelection {
            provider: GitHostSelectionProvider::Github,
            repository_owner: "acme".into(),
            repository_project: None,
            repository_name: "widget".into(),
            number: 1,
        };
        let mut provider = ProviderPullRequestChangeList {
            identity: provider_identity(&selection),
            base_version: "a".repeat(40),
            head_version: "b".repeat(40),
            provider_revision: None,
            target_repository_id: None,
            source_repository_id: None,
            source_repository_project: None,
            changes: (0..MAX_ENTRIES)
                .map(|index| ProviderPullRequestChange {
                    path: format!("{index}-{}", "x".repeat(16 * 1024)),
                    original_path: None,
                    kind: ProviderPullRequestChangeKind::Modified,
                    ordinal: index,
                    file_version: None,
                })
                .collect(),
            truncated: false,
        };
        bound_provider_for_wire(&mut provider);
        let entries = provider
            .changes
            .iter()
            .enumerate()
            .map(entry_json)
            .collect::<Vec<_>>();
        assert!(provider.truncated);
        assert!(entries.len() < MAX_ENTRIES);
        assert!(
            serde_json::to_vec(&entries).unwrap().len() + LIST_RESPONSE_FIXED_RESERVE
                <= MAX_LIST_RESPONSE_BYTES
        );
    }

    #[test]
    fn observation_cache_expires_bounds_and_tears_down_by_task() {
        let mut cache = PullRequestChangeObservationCache::default();
        let selection = GitHostPullRequestSelection {
            provider: GitHostSelectionProvider::Github,
            repository_owner: "acme".into(),
            repository_project: None,
            repository_name: "widget".into(),
            number: 1,
        };
        let provider = ProviderPullRequestChangeList {
            identity: provider_identity(&selection),
            base_version: "a".repeat(40),
            head_version: "b".repeat(40),
            provider_revision: None,
            target_repository_id: None,
            source_repository_id: None,
            source_repository_project: None,
            changes: vec![],
            truncated: false,
        };
        let snapshot = ChangeTaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: "feature".into(),
            repository_root: "/repo".into(),
        };
        let id = cache
            .insert(
                1,
                snapshot.clone(),
                7,
                selection.clone(),
                provider.clone(),
                100,
            )
            .unwrap();
        assert!(cache.get(&id, "task", 100).is_some());
        assert!(cache.get(&id, "task", 100 + OBSERVATION_TTL_MS).is_none());
        assert_eq!(cache.total_bytes, 0);

        let mut ids = Vec::new();
        for index in 0..=MAX_OBSERVATIONS {
            let mut snapshot = snapshot.clone();
            snapshot.task_id = format!("task-{index}");
            snapshot.project_id = if index == MAX_OBSERVATIONS {
                "other-project".into()
            } else {
                "project".into()
            };
            ids.push(
                cache
                    .insert(
                        1,
                        snapshot,
                        7,
                        selection.clone(),
                        provider.clone(),
                        200 + index as u64,
                    )
                    .unwrap(),
            );
        }
        assert_eq!(cache.entries.len(), MAX_OBSERVATIONS);
        assert!(!cache.entries.contains_key(&ids[0]));
        cache.retain_projects(&["project".into()]);
        assert!(
            cache
                .entries
                .values()
                .all(|entry| entry.project_id == "project")
        );
        cache.remove_task("task-1");
        assert!(
            cache
                .entries
                .values()
                .all(|entry| entry.task_id != "task-1")
        );
        assert!(cache.total_bytes <= MAX_OBSERVATION_BYTES);

        let mut byte_cache = PullRequestChangeObservationCache::default();
        let mut large_provider = provider;
        large_provider.changes.push(ProviderPullRequestChange {
            path: "x".repeat(120_000),
            original_path: None,
            kind: ProviderPullRequestChangeKind::Modified,
            ordinal: 0,
            file_version: None,
        });
        let mut first_large_id = None;
        for index in 0..40 {
            let mut snapshot = snapshot.clone();
            snapshot.task_id = format!("large-{index}");
            let id = byte_cache
                .insert(
                    1,
                    snapshot,
                    7,
                    selection.clone(),
                    large_provider.clone(),
                    300 + index,
                )
                .unwrap();
            first_large_id.get_or_insert(id);
        }
        assert!(byte_cache.total_bytes <= MAX_OBSERVATION_BYTES);
        assert!(
            !byte_cache
                .entries
                .contains_key(first_large_id.as_ref().unwrap())
        );
    }

    #[test]
    fn diff_scheduler_key_is_scoped_to_one_opaque_observation_entry() {
        assert_eq!(diff_job_key("prc-1", "e-0"), diff_job_key("prc-1", "e-0"));
        assert_ne!(diff_job_key("prc-1", "e-0"), diff_job_key("prc-2", "e-0"));
        assert_ne!(diff_job_key("prc-1", "e-0"), diff_job_key("prc-1", "e-1"));
        assert!(!diff_job_key("prc-1", "e-0").contains("private/path"));
    }

    #[test]
    fn cross_provider_identity_shape_is_rejected_before_provider_work() {
        let invalid = GitHostPullRequestSelection {
            provider: GitHostSelectionProvider::Github,
            repository_owner: "acme".into(),
            repository_project: Some("project".into()),
            repository_name: "widget".into(),
            number: 1,
        };
        assert!(validate_selection(&invalid).is_err());
    }

    #[test]
    fn content_jobs_leave_room_for_sequential_provider_cli_calls() {
        assert_eq!(GIT_HOST_CONTENT_JOB_TIMEOUT, Duration::from_secs(20));
    }
}
