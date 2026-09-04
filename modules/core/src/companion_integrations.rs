//! Companion and best-effort external integration projections.

pub mod assistant_reset;
pub mod assistant_session;
pub(crate) mod finding_disposition;
pub mod playbook;
pub mod playbook_runtime;
pub mod prompt_improvement;
pub mod pull_request_changes;
pub mod steward;
pub mod tracker;
pub mod tracker_runtime;
pub mod transcript;
pub mod worker;
mod worktree_branches;

use crate::{CoreError, CoreRuntime};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use termloop_domain::{TaskRecord, TaskStatus};
use termloop_gitio::{BranchRemoteFacts, GitError, GitRunner, RemoteBranchFact};
use termloop_providers::{
    AzureDevOpsClient, AzurePullRequestQuery, AzurePullRequestScan, AzureRepository, CheckState,
    GitHostProvider, GitHubClient, Mergeability, ProviderFailure, PullRequestQuery,
    PullRequestQueryResult, PullRequestState, ReviewState, azure_name_eq, parse_azure_remote,
    parse_github_remote,
};
use termloop_store::{
    CachedPullRequest, ProviderCacheFailure, ProviderCacheHandle, ProviderCacheRow,
};

const FRESH_MS: u64 = 2 * 60 * 1_000;
const STALE_MS: u64 = 30 * 60 * 1_000;
const MAX_TASKS: usize = 40;
const MAX_CANDIDATES_PER_TASK: usize = 16;
const MAX_ALIASES: usize = 40;
const MAX_PROVIDER_QUERIES_PER_TASK_WAVE: usize = 2;
const MAX_MATCHES: usize = 16;
const MAX_REMOTE_FACTS_SCANNED: usize = 64;
const LOCAL_FACTS_TTL_MS: u64 = 30_000;
const MAX_LOCAL_FACTS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitHostProjectionQuality {
    Unavailable,
    RemoteOnly,
    RepositoryResolved,
    Matches,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitHostProjectionFreshness {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitHostProjectionReason {
    NoBranch,
    NoRemote,
    GitUnavailable,
    UnsupportedGit,
    RepositoryUnavailable,
    MalformedRemote,
    UnsupportedHost,
    ProviderUnavailable,
    Unauthorized,
    Offline,
    RateLimited,
    Timeout,
    OutputLimit,
    MalformedResponse,
    ProviderFailure,
    CandidateLimit,
    ParentUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GitHostPullRequestSummary {
    pub provider: String,
    pub host: String,
    pub repository_owner: String,
    pub repository_project: Option<String>,
    pub repository_name: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub merge_commit_oid: Option<String>,
    pub base_branch: String,
    pub head_branch: String,
    pub head_repository_owner: String,
    pub head_repository_project: Option<String>,
    pub head_repository_name: String,
    pub check_rollup: String,
    pub check_rollup_source: String,
    pub review_signal: String,
    pub review_signal_source: String,
    pub merge_conflict: String,
    pub merge_conflict_source: String,
    pub activity_at_epoch_ms: u64,
    pub activity_at_source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GitHostTaskProjection {
    /// This cache powers UI affordances only. Worker gates must inspect live
    /// provider truth with the capabilities available in their Session.
    pub usage: &'static str,
    pub task_id: String,
    pub branch_name: Option<String>,
    pub repository_provider: Option<String>,
    pub repository_host: Option<String>,
    pub repository_owner: Option<String>,
    pub repository_project: Option<String>,
    pub repository_name: Option<String>,
    pub quality: GitHostProjectionQuality,
    pub freshness: GitHostProjectionFreshness,
    pub reason: Option<GitHostProjectionReason>,
    pub matches: Vec<GitHostPullRequestSummary>,
    pub truncated: bool,
    pub candidate_truncated: bool,
    pub freshness_generation: u64,
    pub last_success_observed_at_epoch_ms: Option<u64>,
    pub last_attempt_observed_at_epoch_ms: u64,
}

#[derive(Debug)]
pub struct CachedGitHostPullRequestList {
    pub result: Value,
    pub refresh_due: bool,
}

#[derive(Debug, Clone)]
struct TaskSnapshot {
    task_id: String,
    project_id: String,
    branch_name: Option<String>,
    repository_root: Option<PathBuf>,
    worktree_path: Option<PathBuf>,
    worktree_generation: u64,
    force_refresh: bool,
}

#[derive(Clone)]
pub struct GitHostPullRequestListPlan {
    tasks: Vec<TaskSnapshot>,
    cache: ProviderCacheHandle,
    github: Option<GitHubClient>,
    azure: Option<AzureDevOpsClient>,
    local_facts: GitHostLocalFactsCache,
    observed_at: u64,
    deadline: termloop_platform::MonotonicDeadline,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LocalFactsKey {
    repository_root: PathBuf,
    branch_name: String,
    worktree_path: Option<PathBuf>,
    worktree_generation: u64,
}

#[derive(Clone)]
pub(crate) struct GitHostLocalFactsCache {
    inner: Arc<Mutex<LocalFactsInner>>,
}

#[derive(Default)]
struct LocalFactsInner {
    entries: HashMap<LocalFactsKey, LocalFactsEntry>,
    sequence: u64,
}

#[derive(Clone)]
struct LocalFactsEntry {
    result: Result<worktree_branches::ObservedBranchFacts, GitHostProjectionReason>,
    observed_at: u64,
    sequence: u64,
}

impl Default for GitHostLocalFactsCache {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LocalFactsInner::default())),
        }
    }
}

impl GitHostLocalFactsCache {
    fn get(
        &self,
        key: &LocalFactsKey,
        now: u64,
    ) -> Option<Result<worktree_branches::ObservedBranchFacts, GitHostProjectionReason>> {
        let mut inner = self.inner.lock().expect("Git-host local facts mutex");
        let entry = inner.entries.get(key)?;
        if now.saturating_sub(entry.observed_at) >= LOCAL_FACTS_TTL_MS {
            inner.entries.remove(key);
            return None;
        }
        Some(entry.result.clone())
    }

    fn insert(
        &self,
        key: LocalFactsKey,
        result: Result<worktree_branches::ObservedBranchFacts, GitHostProjectionReason>,
        now: u64,
    ) {
        let mut inner = self.inner.lock().expect("Git-host local facts mutex");
        inner.sequence = inner.sequence.wrapping_add(1);
        let sequence = inner.sequence;
        inner.entries.insert(
            key,
            LocalFactsEntry {
                result,
                observed_at: now,
                sequence,
            },
        );
        while inner.entries.len() > MAX_LOCAL_FACTS {
            let oldest = inner
                .entries
                .iter()
                .min_by(|(left_key, left), (right_key, right)| {
                    left.sequence.cmp(&right.sequence).then_with(|| {
                        (
                            &left_key.repository_root,
                            &left_key.branch_name,
                            &left_key.worktree_path,
                            left_key.worktree_generation,
                        )
                            .cmp(&(
                                &right_key.repository_root,
                                &right_key.branch_name,
                                &right_key.worktree_path,
                                right_key.worktree_generation,
                            ))
                    })
                })
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                inner.entries.remove(&oldest);
            }
        }
    }

    fn clear(&self) {
        self.inner
            .lock()
            .expect("Git-host local facts mutex")
            .entries
            .clear();
    }
}

pub struct ObservedGitHostPullRequestList {
    snapshots: Vec<TaskSnapshot>,
    projections: Vec<GitHostTaskProjection>,
    follow_up_task_ids: Vec<String>,
}

pub struct PreparedGitHostPullRequestList {
    snapshots: Vec<TaskSnapshot>,
    task_observations: Vec<LocalObservation>,
    rows: BTreeMap<String, ProviderCacheRow>,
    cache: ProviderCacheHandle,
    jobs: Vec<GitHostProviderQueryJob>,
    follow_up_task_ids: Vec<String>,
    observed_at: u64,
}

#[derive(Clone)]
pub struct GitHostProviderQueryJob {
    key: String,
    query: ProviderQueryJob,
    cache: ProviderCacheHandle,
    github: Option<GitHubClient>,
    azure: Option<AzureDevOpsClient>,
    observed_at: u64,
    deadline: termloop_platform::MonotonicDeadline,
}

#[derive(Clone)]
pub struct GitHostProviderQueryOutcome {
    key: String,
    value: ProviderQueryOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum ProviderQuery {
    Github(PullRequestQuery),
    Azure(AzurePullRequestQuery),
}

#[derive(Clone)]
enum ProviderQueryJob {
    Github(PullRequestQuery),
    Azure {
        query: AzurePullRequestQuery,
        known_target: Option<AzureRepository>,
    },
}

#[derive(Clone)]
enum ProviderQueryOutcome {
    Github(ProviderCacheRow),
    Azure {
        result: Result<AzurePullRequestScan, ProviderFailure>,
        observed_at: u64,
    },
}

#[derive(Default)]
pub(crate) struct GitHostSemanticCache {
    entries: HashMap<String, SemanticEntry>,
    sequence: u64,
}

struct SemanticEntry {
    project_id: String,
    projection: GitHostTaskProjection,
    sequence: u64,
}

impl CoreRuntime {
    pub fn git_host_task_is_automatic(&self, task_id: &str) -> bool {
        self.store
            .tasks()
            .iter()
            .any(|task| task.id == task_id && automatic_git_host_task(task))
    }

    pub fn automatic_git_host_task_ids(&self, task_ids: &[String]) -> Vec<String> {
        let requested = task_ids.iter().collect::<BTreeSet<_>>();
        self.store
            .tasks()
            .iter()
            .filter(|task| requested.contains(&task.id) && automatic_git_host_task(task))
            .map(|task| task.id.clone())
            .collect()
    }

    pub fn invalidate_git_host_local_facts(&mut self) {
        self.git_host_local_facts.clear();
    }

    pub fn invalidate_git_host_task(&mut self, task_id: &str) {
        self.git_host_change_observations.remove_task(task_id);
        if !self
            .git_host_invalidated_tasks
            .iter()
            .any(|id| id == task_id)
        {
            self.git_host_invalidated_tasks
                .push_back(task_id.to_owned());
        }
        while self.git_host_invalidated_tasks.len() > 256 {
            self.git_host_invalidated_tasks.pop_front();
        }
    }

    pub fn reconcile_git_host_demands(
        &mut self,
        active_projects: &[String],
        now: u64,
    ) -> Vec<(String, Vec<String>)> {
        self.git_host_change_observations
            .retain_projects(active_projects);
        let mut demands = Vec::new();
        for project_id in active_projects {
            let eligible = self
                .store
                .tasks()
                .iter()
                .filter(|task| task.project_id == *project_id && automatic_git_host_task(task))
                .map(|task| task.id.clone())
                .collect::<BTreeSet<_>>();
            let project_entries = self
                .git_host_projections
                .entries
                .iter()
                .filter(|(_, entry)| entry.project_id == *project_id)
                .collect::<HashMap<_, _>>();
            let task_ids = eligible
                .into_iter()
                .filter(|task_id| {
                    project_entries
                        .get(task_id)
                        .is_none_or(|entry| projection_refresh_due(&entry.projection, now))
                })
                .take(MAX_TASKS)
                .collect::<Vec<_>>();
            if !task_ids.is_empty() {
                demands.push((project_id.clone(), task_ids));
            }
        }
        demands
    }

    pub fn cached_git_host_pull_request_list(
        &self,
        project_id: &str,
        task_ids: &[String],
        now: u64,
    ) -> Result<Option<CachedGitHostPullRequestList>, CoreError> {
        let mut refresh_due = false;
        let mut projections = Vec::with_capacity(task_ids.len());
        for task in self.git_host_task_records(project_id, task_ids)? {
            if self
                .git_host_invalidated_tasks
                .iter()
                .any(|invalidated| invalidated == &task.id)
            {
                return Ok(None);
            }
            let Some(entry) = self.git_host_projections.entries.get(&task.id) else {
                return Ok(None);
            };
            let branch_name = task.branch.as_ref().map(|branch| branch.name.as_str());
            if entry.project_id != project_id
                || entry.projection.branch_name.as_deref() != branch_name
            {
                return Ok(None);
            }
            let (projection, projection_refresh_due) =
                cached_projection_for_display(&entry.projection, now);
            refresh_due |= projection_refresh_due;
            projections.push(projection);
        }
        serde_json::to_value(projections)
            .map(|result| {
                Some(CachedGitHostPullRequestList {
                    result,
                    refresh_due,
                })
            })
            .map_err(|_| CoreError::Store("projection serialization failed".into()))
    }

    pub fn plan_git_host_pull_request_list(
        &self,
        project_id: &str,
        task_ids: &[String],
        observed_at: u64,
    ) -> Result<GitHostPullRequestListPlan, CoreError> {
        let tasks = self
            .git_host_task_records(project_id, task_ids)?
            .into_iter()
            .map(|task| {
                let mut snapshot = snapshot(task);
                snapshot.force_refresh = self
                    .git_host_invalidated_tasks
                    .iter()
                    .any(|id| id == &task.id);
                snapshot
            })
            .collect();
        Ok(GitHostPullRequestListPlan {
            tasks,
            cache: self.provider_cache.clone(),
            github: self.github_client.clone(),
            azure: self.azure_devops_client.clone(),
            local_facts: self.git_host_local_facts.clone(),
            observed_at,
            deadline: termloop_platform::MonotonicDeadline::after(Duration::from_secs(10))
                .map_err(|_| CoreError::GitObservationTimedOut)?,
        })
    }

    fn git_host_task_records<'a>(
        &'a self,
        project_id: &str,
        task_ids: &[String],
    ) -> Result<Vec<&'a TaskRecord>, CoreError> {
        if task_ids.is_empty()
            || task_ids.len() > MAX_TASKS
            || task_ids.iter().collect::<BTreeSet<_>>().len() != task_ids.len()
        {
            return Err(CoreError::InvalidParams("taskIds".into()));
        }
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let project_tasks = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| (task.id.as_str(), task))
            .collect::<HashMap<_, _>>();
        task_ids
            .iter()
            .map(|task_id| {
                project_tasks
                    .get(task_id.as_str())
                    .copied()
                    .ok_or(CoreError::NotFound)
            })
            .collect()
    }

    pub fn apply_git_host_pull_request_list(
        &mut self,
        observed: ObservedGitHostPullRequestList,
    ) -> Result<(Value, Vec<String>, Vec<String>), CoreError> {
        let follow_up_task_ids = observed.follow_up_task_ids;
        let mut changed = Vec::new();
        let mut projections = Vec::with_capacity(observed.projections.len());
        for (snapshot, mut projection) in observed
            .snapshots
            .into_iter()
            .zip(observed.projections.into_iter())
        {
            let applicable = self.store.tasks().iter().any(|task| {
                task.id == snapshot.task_id
                    && task.project_id == snapshot.project_id
                    && match (
                        task.branch.as_ref(),
                        snapshot.branch_name.as_ref(),
                        snapshot.repository_root.as_ref(),
                    ) {
                        (Some(branch), Some(name), Some(root)) => {
                            branch.name == *name && root.to_string_lossy() == branch.repository_root
                        }
                        (None, None, None) => true,
                        _ => false,
                    }
                    && match (&task.worktree, &snapshot.worktree_path) {
                        (Some(worktree), Some(path)) => {
                            PathBuf::from(&worktree.path) == *path
                                && task.worktree_generation == snapshot.worktree_generation
                        }
                        (None, None) => task.worktree_generation == snapshot.worktree_generation,
                        _ => false,
                    }
            });
            if !applicable {
                projection =
                    local_unavailable(&snapshot, GitHostProjectionReason::RepositoryUnavailable);
            }
            if (projection.last_attempt_observed_at_epoch_ms > 0 || snapshot.branch_name.is_none())
                && let Some(index) = self
                    .git_host_invalidated_tasks
                    .iter()
                    .position(|id| id == &snapshot.task_id)
            {
                self.git_host_invalidated_tasks.remove(index);
            }
            if self
                .git_host_projections
                .insert(snapshot.project_id.clone(), projection.clone())
            {
                self.git_host_change_observations
                    .remove_task(&snapshot.task_id);
                changed.push(snapshot.task_id);
            }
            projections.push(projection);
        }
        serde_json::to_value(projections)
            .map(|value| (value, changed, follow_up_task_ids))
            .map_err(|_| CoreError::Store("projection serialization failed".into()))
    }
}

fn automatic_git_host_task(task: &TaskRecord) -> bool {
    task.status == TaskStatus::Open && task.branch.is_some()
}

fn provider_refresh_due(last_attempt_observed_at: u64, now: u64) -> bool {
    now.saturating_sub(last_attempt_observed_at) >= FRESH_MS
}

fn projection_refresh_due(projection: &GitHostTaskProjection, now: u64) -> bool {
    projection.freshness == GitHostProjectionFreshness::Stale
        || provider_refresh_due(projection.last_attempt_observed_at_epoch_ms, now)
}

fn cached_projection_for_display(
    projection: &GitHostTaskProjection,
    now: u64,
) -> (GitHostTaskProjection, bool) {
    let mut projection = projection.clone();
    let refresh_due = projection_refresh_due(&projection, now);
    if refresh_due && projection.freshness == GitHostProjectionFreshness::Fresh {
        projection.freshness = GitHostProjectionFreshness::Stale;
    }
    (projection, refresh_due)
}

impl GitHostPullRequestListPlan {
    pub fn degraded_observation(
        &self,
        reason: GitHostProjectionReason,
    ) -> ObservedGitHostPullRequestList {
        ObservedGitHostPullRequestList {
            snapshots: self.tasks.clone(),
            projections: self
                .tasks
                .iter()
                .map(|task| local_unavailable(task, reason))
                .collect(),
            follow_up_task_ids: Vec::new(),
        }
    }

    pub fn prepare(self) -> PreparedGitHostPullRequestList {
        let mut task_observations = self
            .tasks
            .iter()
            .map(|task| {
                let Some(key) = local_facts_key(task) else {
                    return Some(local_observation_failure(
                        task,
                        GitHostProjectionReason::NoBranch,
                    ));
                };
                self.local_facts
                    .get(&key, self.observed_at)
                    .map(|result| local_observation_from_facts(task, result))
            })
            .collect::<Vec<_>>();
        if task_observations.iter().any(Option::is_none) {
            let discovered = self
                .deadline
                .remaining()
                .ok_or(GitError::Timeout {
                    operation: termloop_gitio::GitOperation::Discover,
                })
                .and_then(|remaining| {
                    GitRunner::discover_with_timeout(remaining.min(Duration::from_millis(2_500)))
                });
            match discovered {
                Ok(runner) => {
                    for (task, observation) in self.tasks.iter().zip(task_observations.iter_mut()) {
                        if observation.is_some() {
                            continue;
                        }
                        let key = local_facts_key(task).expect("missing local facts key");
                        let result = observe_local_facts(task, self.deadline, &runner);
                        self.local_facts
                            .insert(key, result.clone(), self.observed_at);
                        *observation = Some(local_observation_from_facts(task, result));
                    }
                }
                Err(error) => {
                    let reason = map_git_error(&error);
                    for (task, observation) in self.tasks.iter().zip(task_observations.iter_mut()) {
                        if observation.is_some() {
                            continue;
                        }
                        let key = local_facts_key(task).expect("missing local facts key");
                        self.local_facts.insert(key, Err(reason), self.observed_at);
                        *observation = Some(local_observation_failure(task, reason));
                    }
                }
            }
        }
        let mut task_observations = task_observations
            .into_iter()
            .map(|observation| observation.expect("every local observation resolved"))
            .collect::<Vec<_>>();
        admit_candidates(&mut task_observations);

        let mut pending = Vec::new();
        let mut follow_up_task_ids = BTreeSet::new();
        let mut rows = BTreeMap::<String, ProviderCacheRow>::new();
        for observation in &task_observations {
            let mut refreshable = Vec::new();
            for (rank, query) in observation.candidates.iter().enumerate() {
                let key = cache_key(query);
                let cached = self.cache.get(&key);
                let cache_suppresses_refresh = cached.as_ref().is_some_and(|row| {
                    !observation.snapshot.force_refresh
                        && (self
                            .observed_at
                            .saturating_sub(row.last_attempt_observed_at)
                            < FRESH_MS
                            || row
                                .retry_after
                                .is_some_and(|retry_after| self.observed_at < retry_after))
                });
                let last_attempt = cached
                    .as_ref()
                    .map_or(0, |row| row.last_attempt_observed_at);
                if let Some(row) = cached {
                    // A bounded provider wave may defer this candidate. Keep its
                    // last safe row in the composed projection while a later wave
                    // refreshes it, rather than making previously discovered PRs
                    // disappear merely because another alias was refreshed first.
                    rows.insert(key.clone(), row);
                }
                if cache_suppresses_refresh {
                    continue;
                }
                refreshable.push((last_attempt, rank, query));
            }
            // Admit the least recently attempted candidate first so the bounded
            // wave rotates. Fixed rank order starves every alias past the bound:
            // the leading ranks fall due again each wave, so a deferred alias is
            // never refreshed and its matches eventually age past STALE_MS and
            // drop out of the composed projection.
            refreshable.sort_unstable_by_key(|(last_attempt, rank, _)| (*last_attempt, *rank));
            for (admitted, (_, _, query)) in refreshable.into_iter().enumerate() {
                if admitted < MAX_PROVIDER_QUERIES_PER_TASK_WAVE {
                    pending.push(query.clone());
                } else {
                    follow_up_task_ids.insert(observation.snapshot.task_id.clone());
                }
            }
        }
        pending.sort();
        pending.dedup();

        let mut jobs = Vec::new();
        for query in pending {
            match query {
                ProviderQuery::Github(query) => jobs.push(GitHostProviderQueryJob {
                    key: cache_key(&ProviderQuery::Github(query.clone())),
                    query: ProviderQueryJob::Github(query),
                    cache: self.cache.clone(),
                    github: self.github.clone(),
                    azure: self.azure.clone(),
                    observed_at: self.observed_at,
                    deadline: self.deadline,
                }),
                ProviderQuery::Azure(query) => {
                    let key = cache_key(&ProviderQuery::Azure(query.clone()));
                    let known_target = self
                        .cache
                        .get(&key)
                        .as_ref()
                        .and_then(|row| known_azure_target(&query, row));
                    jobs.push(GitHostProviderQueryJob {
                        key,
                        query: ProviderQueryJob::Azure {
                            query,
                            known_target,
                        },
                        cache: self.cache.clone(),
                        github: self.github.clone(),
                        azure: self.azure.clone(),
                        observed_at: self.observed_at,
                        deadline: self.deadline,
                    });
                }
            }
        }
        jobs.sort_by(|left, right| left.key.cmp(&right.key));
        PreparedGitHostPullRequestList {
            snapshots: self.tasks,
            task_observations,
            rows,
            cache: self.cache,
            jobs,
            follow_up_task_ids: follow_up_task_ids.into_iter().collect(),
            observed_at: self.observed_at,
        }
    }

    pub fn observe(self) -> ObservedGitHostPullRequestList {
        let prepared = self.prepare();
        let mut outcomes = Vec::new();
        let mut jobs = prepared.provider_jobs();
        while !jobs.is_empty() {
            let limit = jobs[0].batch_limit();
            let group = jobs[0].batch_group_key();
            let mut batch = Vec::new();
            let mut rest = Vec::new();
            for job in jobs {
                if batch.len() < limit && job.batch_group_key() == group {
                    batch.push(job);
                } else {
                    rest.push(job);
                }
            }
            outcomes.extend(GitHostProviderQueryJob::execute_batch(batch));
            jobs = rest;
        }
        prepared.complete(outcomes)
    }
}

impl PreparedGitHostPullRequestList {
    pub fn provider_jobs(&self) -> Vec<GitHostProviderQueryJob> {
        self.jobs.clone()
    }

    pub fn degraded_observation(
        &self,
        reason: GitHostProjectionReason,
    ) -> ObservedGitHostPullRequestList {
        ObservedGitHostPullRequestList {
            snapshots: self.snapshots.clone(),
            projections: self
                .snapshots
                .iter()
                .map(|task| local_unavailable(task, reason))
                .collect(),
            follow_up_task_ids: Vec::new(),
        }
    }

    pub fn complete(
        mut self,
        outcomes: Vec<GitHostProviderQueryOutcome>,
    ) -> ObservedGitHostPullRequestList {
        for outcome in outcomes {
            match outcome.value {
                ProviderQueryOutcome::Github(row) => {
                    self.rows.insert(outcome.key, row);
                }
                ProviderQueryOutcome::Azure {
                    result,
                    observed_at,
                } => {
                    let candidate = self
                        .task_observations
                        .iter()
                        .flat_map(|observation| observation.candidates.iter())
                        .find_map(|query| match query {
                            ProviderQuery::Azure(query)
                                if cache_key(&ProviderQuery::Azure(query.clone()))
                                    == outcome.key =>
                            {
                                Some(query.clone())
                            }
                            _ => None,
                        });
                    if let Some(candidate) = candidate {
                        update_row_from_azure(
                            &self.cache,
                            &mut self.rows,
                            &candidate,
                            result,
                            observed_at,
                        );
                    }
                }
            }
        }
        let projections = self
            .task_observations
            .iter()
            .map(|observation| project_task(observation, &self.rows, self.observed_at))
            .collect();
        ObservedGitHostPullRequestList {
            snapshots: self.snapshots,
            projections,
            follow_up_task_ids: self.follow_up_task_ids,
        }
    }
}

impl GitHostProviderQueryJob {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn batch_group_key(&self) -> String {
        match &self.query {
            ProviderQueryJob::Github(_) => "github|github.com".into(),
            ProviderQueryJob::Azure { query, .. } => query.repository.project_key(),
        }
    }

    pub fn batch_limit(&self) -> usize {
        match self.query {
            ProviderQueryJob::Github(_) => 20,
            ProviderQueryJob::Azure { .. } => 1,
        }
    }

    pub fn timeout_outcome(&self) -> GitHostProviderQueryOutcome {
        match &self.query {
            ProviderQueryJob::Github(query) => {
                let mut rows = BTreeMap::new();
                update_rows_from_provider(
                    &self.cache,
                    &mut rows,
                    std::slice::from_ref(query),
                    Err(ProviderFailure::Timeout),
                    self.observed_at,
                );
                GitHostProviderQueryOutcome {
                    key: self.key.clone(),
                    value: ProviderQueryOutcome::Github(
                        rows.remove(&self.key)
                            .expect("a bounded GitHub failure produces one cache row"),
                    ),
                }
            }
            ProviderQueryJob::Azure { .. } => GitHostProviderQueryOutcome {
                key: self.key.clone(),
                value: ProviderQueryOutcome::Azure {
                    result: Err(ProviderFailure::Timeout),
                    observed_at: self.observed_at,
                },
            },
        }
    }

    pub fn execute_batch(jobs: Vec<Self>) -> Vec<GitHostProviderQueryOutcome> {
        let mut outcomes = Vec::new();
        let pending = jobs
            .into_iter()
            .filter(|job| match &job.query {
                ProviderQueryJob::Github(_) => {
                    if let Some(row) = job.cache.get(&job.key)
                        && (job.observed_at.saturating_sub(row.last_attempt_observed_at) < FRESH_MS
                            || row
                                .retry_after
                                .is_some_and(|retry_after| job.observed_at < retry_after))
                    {
                        outcomes.push(GitHostProviderQueryOutcome {
                            key: job.key.clone(),
                            value: ProviderQueryOutcome::Github(row),
                        });
                        false
                    } else {
                        true
                    }
                }
                ProviderQueryJob::Azure { .. } => true,
            })
            .collect::<Vec<_>>();
        let Some(first) = pending.first() else {
            return outcomes;
        };
        if pending.len() > first.batch_limit()
            || pending
                .iter()
                .any(|job| job.batch_group_key() != first.batch_group_key())
        {
            return Vec::new();
        }
        match &first.query {
            ProviderQueryJob::Github(_) => {
                let batch = pending
                    .iter()
                    .filter_map(|job| match &job.query {
                        ProviderQueryJob::Github(query) => Some(query.clone()),
                        ProviderQueryJob::Azure { .. } => None,
                    })
                    .collect::<Vec<_>>();
                let result = match &first.github {
                    Some(client) => first
                        .deadline
                        .remaining()
                        .map(|remaining| client.query_with_timeout(&batch, remaining))
                        .unwrap_or(Err(ProviderFailure::Timeout)),
                    None => Err(ProviderFailure::ProviderUnavailable),
                };
                let mut rows = BTreeMap::new();
                update_rows_from_provider(
                    &first.cache,
                    &mut rows,
                    &batch,
                    result,
                    first.observed_at,
                );
                outcomes.extend(pending.into_iter().filter_map(|job| {
                    rows.remove(&job.key)
                        .map(|row| GitHostProviderQueryOutcome {
                            key: job.key,
                            value: ProviderQueryOutcome::Github(row),
                        })
                }));
            }
            ProviderQueryJob::Azure {
                query,
                known_target,
            } => {
                let result = match &first.azure {
                    Some(client) => first
                        .deadline
                        .remaining()
                        .map(|remaining| {
                            client.query_pull_requests_with_timeout(
                                query,
                                known_target.as_ref(),
                                remaining,
                            )
                        })
                        .unwrap_or(Err(ProviderFailure::Timeout)),
                    None => Err(ProviderFailure::ProviderUnavailable),
                };
                outcomes.push(GitHostProviderQueryOutcome {
                    key: first.key.clone(),
                    value: ProviderQueryOutcome::Azure {
                        result,
                        observed_at: first.observed_at,
                    },
                });
            }
        }
        outcomes
    }
}

impl GitHostProviderQueryOutcome {
    pub fn key(&self) -> &str {
        &self.key
    }
}

struct LocalObservation {
    snapshot: TaskSnapshot,
    candidates: Vec<ProviderQuery>,
    candidate_truncated: bool,
    local_reason: Option<GitHostProjectionReason>,
}

fn snapshot(task: &TaskRecord) -> TaskSnapshot {
    TaskSnapshot {
        task_id: task.id.clone(),
        project_id: task.project_id.clone(),
        branch_name: task.branch.as_ref().map(|branch| branch.name.clone()),
        repository_root: task
            .branch
            .as_ref()
            .map(|branch| PathBuf::from(&branch.repository_root)),
        worktree_path: task
            .worktree
            .as_ref()
            .map(|worktree| PathBuf::from(&worktree.path)),
        worktree_generation: task.worktree_generation,
        force_refresh: false,
    }
}

fn local_facts_key(snapshot: &TaskSnapshot) -> Option<LocalFactsKey> {
    Some(LocalFactsKey {
        repository_root: snapshot.repository_root.clone()?,
        branch_name: snapshot.branch_name.clone()?,
        worktree_path: snapshot.worktree_path.clone(),
        worktree_generation: snapshot.worktree_generation,
    })
}

fn observe_local_facts(
    snapshot: &TaskSnapshot,
    deadline: termloop_platform::MonotonicDeadline,
    runner: &GitRunner,
) -> Result<worktree_branches::ObservedBranchFacts, GitHostProjectionReason> {
    let (Some(branch), Some(repository_root)) = (&snapshot.branch_name, &snapshot.repository_root)
    else {
        return Err(GitHostProjectionReason::NoBranch);
    };
    worktree_branches::observe(
        runner,
        repository_root,
        branch,
        snapshot.worktree_path.as_deref(),
        deadline,
    )
    .map_err(|error| map_git_error(&error))
}

fn local_observation_from_facts(
    snapshot: &TaskSnapshot,
    result: Result<worktree_branches::ObservedBranchFacts, GitHostProjectionReason>,
) -> LocalObservation {
    match result {
        Ok(facts) => normalize_candidate_sets(snapshot, &facts),
        Err(reason) => local_observation_failure(snapshot, reason),
    }
}

fn normalize_candidate_sets(
    snapshot: &TaskSnapshot,
    facts: &worktree_branches::ObservedBranchFacts,
) -> LocalObservation {
    let mut candidates = Vec::new();
    let mut candidate_truncated = facts.candidate_truncated;
    let mut local_reason = None;
    for branch_facts in &facts.branches {
        let normalized = normalize_candidates(snapshot, branch_facts);
        candidate_truncated |= normalized.candidate_truncated;
        local_reason = local_reason.or(normalized.local_reason);
        for candidate in normalized.candidates {
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }
    candidate_truncated |= candidates.len() > MAX_CANDIDATES_PER_TASK;
    candidates.truncate(MAX_CANDIDATES_PER_TASK);
    LocalObservation {
        snapshot: snapshot.clone(),
        candidates,
        candidate_truncated,
        local_reason,
    }
}

fn local_observation_failure(
    snapshot: &TaskSnapshot,
    reason: GitHostProjectionReason,
) -> LocalObservation {
    LocalObservation {
        snapshot: snapshot.clone(),
        candidates: vec![],
        candidate_truncated: false,
        local_reason: Some(reason),
    }
}

fn normalize_candidates(snapshot: &TaskSnapshot, facts: &BranchRemoteFacts) -> LocalObservation {
    let local_branch = facts
        .local_branch
        .as_bytes()
        .strip_prefix(b"refs/heads/")
        .and_then(|branch| std::str::from_utf8(branch).ok());
    let mut ordered = Vec::<(Vec<u8>, String, bool)>::new();
    let mut explicit_heads = BTreeSet::<(Vec<u8>, bool)>::new();
    let mut remote_ref_degraded = local_branch.is_none();
    let exact_worktree_alias = snapshot.worktree_path.is_some()
        && local_branch.is_some_and(|branch| snapshot.branch_name.as_deref() != Some(branch));
    if let Some(upstream) = &facts.upstream {
        let head = if exact_worktree_alias {
            local_branch.map(str::to_owned)
        } else {
            remote_head(upstream)
        };
        if let Some(head) = head {
            ordered.push((upstream.remote.clone(), head, false));
            explicit_heads.insert((upstream.remote.clone(), false));
        } else {
            remote_ref_degraded = true;
        }
    }
    if let Some(push) = &facts.push {
        let head = if exact_worktree_alias {
            local_branch.map(str::to_owned)
        } else {
            remote_head(push)
        };
        if let Some(head) = head {
            ordered.push((push.remote.clone(), head, true));
            explicit_heads.insert((push.remote.clone(), true));
        } else {
            remote_ref_degraded = true;
        }
    }
    if let Some(local_branch) = local_branch {
        if let Some(push_default) = &facts.push_default {
            ordered.push((push_default.clone(), local_branch.to_owned(), true));
            explicit_heads.insert((push_default.clone(), true));
        }
        if !explicit_heads.contains(&(b"origin".to_vec(), false)) {
            ordered.push((b"origin".to_vec(), local_branch.to_owned(), false));
        }
        for remote in facts.remotes.iter().take(MAX_REMOTE_FACTS_SCANNED) {
            if !explicit_heads.contains(&(remote.name.clone(), false)) {
                ordered.push((remote.name.clone(), local_branch.to_owned(), false));
            }
            if !remote.push_urls.is_empty()
                && !explicit_heads.contains(&(remote.name.clone(), true))
            {
                ordered.push((remote.name.clone(), local_branch.to_owned(), true));
            }
        }
    }

    let mut candidates = Vec::new();
    let mut saw_malformed = false;
    let mut saw_unsupported = false;
    let remotes = facts
        .remotes
        .iter()
        .map(|remote| (remote.name.as_slice(), remote))
        .collect::<HashMap<_, _>>();
    'candidates: for (remote_name, head_branch, prefer_push) in ordered {
        let Some(remote) = remotes.get(remote_name.as_slice()).copied() else {
            continue;
        };
        let endpoints = if prefer_push && !remote.push_urls.is_empty() {
            &remote.push_urls
        } else {
            &remote.fetch_urls
        };
        for endpoint in endpoints {
            let github = parse_github_remote(endpoint);
            let azure = parse_azure_remote(endpoint);
            let candidate = match (github, azure) {
                (Ok(repository), _) => Some(ProviderQuery::Github(PullRequestQuery {
                    repository,
                    head_branch: head_branch.clone(),
                })),
                (_, Ok(repository)) => Some(ProviderQuery::Azure(AzurePullRequestQuery {
                    repository,
                    head_branch: head_branch.clone(),
                })),
                (Err(github), Err(azure)) => {
                    if matches!(
                        github,
                        termloop_providers::RemoteIdentityError::UnsupportedHost
                            | termloop_providers::RemoteIdentityError::UnsupportedTransport
                    ) && matches!(
                        azure,
                        termloop_providers::RemoteIdentityError::UnsupportedHost
                            | termloop_providers::RemoteIdentityError::UnsupportedTransport
                    ) {
                        saw_unsupported = true;
                    } else {
                        saw_malformed = true;
                    }
                    None
                }
            };
            if let Some(candidate) = candidate
                && !candidates.contains(&candidate)
            {
                candidates.push(candidate);
                if candidates.len() > MAX_CANDIDATES_PER_TASK {
                    break 'candidates;
                }
            }
        }
    }
    let candidate_truncated = remote_ref_degraded
        || facts.remotes.len() > MAX_REMOTE_FACTS_SCANNED
        || candidates.len() > MAX_CANDIDATES_PER_TASK;
    candidates.truncate(MAX_CANDIDATES_PER_TASK);
    let local_reason = if candidates.is_empty() {
        Some(if facts.remotes.is_empty() {
            GitHostProjectionReason::NoRemote
        } else if saw_unsupported {
            GitHostProjectionReason::UnsupportedHost
        } else if saw_malformed {
            GitHostProjectionReason::MalformedRemote
        } else {
            GitHostProjectionReason::NoRemote
        })
    } else {
        None
    };
    LocalObservation {
        snapshot: snapshot.clone(),
        candidates,
        candidate_truncated,
        local_reason,
    }
}

fn remote_head(fact: &RemoteBranchFact) -> Option<String> {
    let prefix = [b"refs/remotes/".as_slice(), fact.remote.as_slice(), b"/"].concat();
    fact.reference
        .strip_prefix(prefix.as_slice())
        .or_else(|| fact.reference.strip_prefix(b"refs/heads/"))
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn admit_candidates(observations: &mut [LocalObservation]) {
    let mut admitted = vec![Vec::new(); observations.len()];
    let mut total = 0;
    for rank in 0..MAX_CANDIDATES_PER_TASK {
        for (index, observation) in observations.iter().enumerate() {
            if total == MAX_ALIASES {
                break;
            }
            if let Some(candidate) = observation.candidates.get(rank) {
                admitted[index].push(candidate.clone());
                total += 1;
            }
        }
    }
    for (observation, candidates) in observations.iter_mut().zip(admitted) {
        observation.candidate_truncated |= candidates.len() < observation.candidates.len();
        observation.candidates = candidates;
    }
}

fn update_rows_from_provider(
    cache: &ProviderCacheHandle,
    rows: &mut BTreeMap<String, ProviderCacheRow>,
    batch: &[PullRequestQuery],
    result: Result<Vec<PullRequestQueryResult>, ProviderFailure>,
    now: u64,
) {
    match result {
        Ok(results) => {
            for result in results {
                let key = cache_key(&ProviderQuery::Github(result.query.clone()));
                let previous = cache.get(&key);
                let has_safe_success = result.failure.is_none() || !result.matches.is_empty();
                let row = ProviderCacheRow {
                    key: key.clone(),
                    matches: if has_safe_success {
                        result.matches.iter().map(cache_summary).collect()
                    } else {
                        previous
                            .as_ref()
                            .map(|row| row.matches.clone())
                            .unwrap_or_default()
                    },
                    truncated: result.truncated,
                    parent_resolved: result.parent_resolved,
                    failure: result.failure.map(cache_failure),
                    last_success_observed_at: if has_safe_success {
                        Some(now)
                    } else {
                        previous
                            .as_ref()
                            .and_then(|row| row.last_success_observed_at)
                    },
                    last_attempt_observed_at: now,
                    retry_after: result
                        .retry_after_epoch_ms
                        .or_else(|| retry_after(result.failure, now)),
                };
                let _ = cache.update(row.clone());
                rows.insert(key, row);
            }
        }
        Err(failure) => {
            for query in batch {
                let key = cache_key(&ProviderQuery::Github(query.clone()));
                let previous = cache.get(&key);
                let row = ProviderCacheRow {
                    key: key.clone(),
                    matches: previous
                        .as_ref()
                        .map(|row| row.matches.clone())
                        .unwrap_or_default(),
                    truncated: previous.as_ref().is_some_and(|row| row.truncated),
                    parent_resolved: previous.as_ref().is_none_or(|row| row.parent_resolved),
                    failure: Some(cache_failure(failure)),
                    last_success_observed_at: previous
                        .as_ref()
                        .and_then(|row| row.last_success_observed_at),
                    last_attempt_observed_at: now,
                    retry_after: retry_after(Some(failure), now),
                };
                let _ = cache.update(row.clone());
                rows.insert(key, row);
            }
        }
    }
}

fn update_row_from_azure(
    cache: &ProviderCacheHandle,
    rows: &mut BTreeMap<String, ProviderCacheRow>,
    alias: &AzurePullRequestQuery,
    result: Result<AzurePullRequestScan, ProviderFailure>,
    now: u64,
) {
    let query = ProviderQuery::Azure(alias.clone());
    let key = cache_key(&query);
    let previous = cache.get(&key);
    let (matches, truncated, parent_resolved, failure) = match &result {
        Ok(scan) => (
            scan.pull_requests.clone(),
            scan.truncated || scan.incomplete,
            scan.parent_resolved && !scan.truncated && !scan.incomplete,
            None,
        ),
        Err(failure) => (Vec::new(), false, false, Some(*failure)),
    };
    let row = ProviderCacheRow {
        key: key.clone(),
        matches: if failure.is_none() {
            matches.iter().map(cache_summary).collect()
        } else {
            previous
                .as_ref()
                .map(|row| row.matches.clone())
                .unwrap_or_default()
        },
        truncated,
        parent_resolved,
        failure: failure.map(cache_failure),
        last_success_observed_at: if failure.is_none() {
            Some(now)
        } else {
            previous
                .as_ref()
                .and_then(|row| row.last_success_observed_at)
        },
        last_attempt_observed_at: now,
        retry_after: retry_after(failure, now),
    };
    let _ = cache.update(row.clone());
    rows.insert(key, row);
}

fn project_task(
    observation: &LocalObservation,
    rows: &BTreeMap<String, ProviderCacheRow>,
    now: u64,
) -> GitHostTaskProjection {
    if observation.candidates.is_empty() {
        let reason = observation
            .local_reason
            .unwrap_or(GitHostProjectionReason::NoRemote);
        let quality = if matches!(
            reason,
            GitHostProjectionReason::NoRemote
                | GitHostProjectionReason::MalformedRemote
                | GitHostProjectionReason::UnsupportedHost
        ) {
            GitHostProjectionQuality::RemoteOnly
        } else {
            GitHostProjectionQuality::Unavailable
        };
        return GitHostTaskProjection {
            usage: "displayOnly",
            task_id: observation.snapshot.task_id.clone(),
            branch_name: observation.snapshot.branch_name.clone(),
            repository_provider: None,
            repository_host: None,
            repository_owner: None,
            repository_project: None,
            repository_name: None,
            quality,
            freshness: GitHostProjectionFreshness::Unavailable,
            reason: Some(reason),
            matches: vec![],
            truncated: false,
            candidate_truncated: observation.candidate_truncated,
            freshness_generation: 0,
            last_success_observed_at_epoch_ms: None,
            last_attempt_observed_at_epoch_ms: 0,
        };
    }
    let mut summaries = Vec::new();
    let mut all_authoritative = !observation.candidate_truncated;
    let mut truncated = false;
    let mut reason = None;
    let mut last_success = None;
    let mut last_attempt = 0;
    let mut stale = false;
    for query in &observation.candidates {
        let Some(row) = rows.get(&cache_key(query)) else {
            all_authoritative = false;
            reason = Some(GitHostProjectionReason::ProviderUnavailable);
            continue;
        };
        last_attempt = last_attempt.max(row.last_attempt_observed_at);
        last_success = last_success.max(row.last_success_observed_at);
        truncated |= row.truncated;
        if !row.parent_resolved {
            all_authoritative = false;
            reason.get_or_insert(GitHostProjectionReason::ParentUnavailable);
        }
        if let Some(failure) = row.failure {
            all_authoritative = false;
            reason = Some(map_cache_failure(failure));
        }
        if let Some(success) = row.last_success_observed_at
            && now.saturating_sub(success) <= STALE_MS
        {
            stale |= now.saturating_sub(success) >= FRESH_MS || row.failure.is_some();
            summaries.extend(row.matches.iter().map(projection_summary));
        }
    }
    summaries.sort_by(|left, right| {
        right
            .activity_at_epoch_ms
            .cmp(&left.activity_at_epoch_ms)
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.host.cmp(&right.host))
            .then_with(|| left.repository_owner.cmp(&right.repository_owner))
            .then_with(|| left.repository_project.cmp(&right.repository_project))
            .then_with(|| left.repository_name.cmp(&right.repository_name))
            .then_with(|| left.number.cmp(&right.number))
    });
    summaries.dedup_by(|left, right| {
        left.provider == right.provider
            && left.host == right.host
            && left.repository_owner == right.repository_owner
            && left.repository_project == right.repository_project
            && left.repository_name == right.repository_name
            && left.number == right.number
    });
    truncated |= summaries.len() > MAX_MATCHES;
    summaries.truncate(MAX_MATCHES);
    if truncated {
        all_authoritative = false;
    }
    if reason.is_none() && observation.candidate_truncated {
        reason = Some(GitHostProjectionReason::CandidateLimit);
    }
    let (
        repository_provider,
        repository_host,
        repository_owner,
        repository_project,
        repository_name,
    ) = candidate_identity(&observation.candidates[0]);
    GitHostTaskProjection {
        usage: "displayOnly",
        task_id: observation.snapshot.task_id.clone(),
        branch_name: observation.snapshot.branch_name.clone(),
        repository_provider: Some(repository_provider.into()),
        repository_host: Some(repository_host.into()),
        repository_owner: Some(repository_owner),
        repository_project,
        repository_name: Some(repository_name),
        quality: if !summaries.is_empty() || all_authoritative {
            GitHostProjectionQuality::Matches
        } else {
            GitHostProjectionQuality::RepositoryResolved
        },
        freshness: if stale {
            GitHostProjectionFreshness::Stale
        } else if all_authoritative {
            GitHostProjectionFreshness::Fresh
        } else {
            GitHostProjectionFreshness::Unavailable
        },
        reason,
        matches: summaries,
        truncated,
        candidate_truncated: observation.candidate_truncated,
        freshness_generation: last_attempt,
        last_success_observed_at_epoch_ms: last_success,
        last_attempt_observed_at_epoch_ms: last_attempt,
    }
}

impl GitHostSemanticCache {
    /// Drops every projection a deleted Project owned. The pull requests it
    /// held are a projection of that Project's remotes and have no subject
    /// left.
    pub(crate) fn retain_outside_project(&mut self, project_id: &str) {
        self.entries
            .retain(|_, entry| entry.project_id != project_id);
    }

    fn insert(&mut self, project_id: String, projection: GitHostTaskProjection) -> bool {
        let changed = self
            .entries
            .get(&projection.task_id)
            .is_none_or(|entry| entry.projection != projection);
        self.sequence = self.sequence.wrapping_add(1);
        self.entries.insert(
            projection.task_id.clone(),
            SemanticEntry {
                project_id: project_id.clone(),
                projection,
                sequence: self.sequence,
            },
        );
        self.enforce_project_cap(&project_id);
        while self.entries.len() > 256 {
            self.evict_oldest(None);
        }
        changed
    }

    fn enforce_project_cap(&mut self, project_id: &str) {
        while self
            .entries
            .values()
            .filter(|entry| entry.project_id == project_id)
            .count()
            > 64
        {
            self.evict_oldest(Some(project_id));
        }
    }

    fn evict_oldest(&mut self, project_id: Option<&str>) {
        let oldest = self
            .entries
            .iter()
            .filter(|(_, entry)| project_id.is_none_or(|id| entry.project_id == id))
            .min_by(|(left_id, left), (right_id, right)| {
                left.sequence
                    .cmp(&right.sequence)
                    .then_with(|| left_id.cmp(right_id))
            })
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            self.entries.remove(&id);
        }
    }
}

fn local_unavailable(
    snapshot: &TaskSnapshot,
    reason: GitHostProjectionReason,
) -> GitHostTaskProjection {
    GitHostTaskProjection {
        usage: "displayOnly",
        task_id: snapshot.task_id.clone(),
        branch_name: snapshot.branch_name.clone(),
        repository_provider: None,
        repository_host: None,
        repository_owner: None,
        repository_project: None,
        repository_name: None,
        quality: GitHostProjectionQuality::Unavailable,
        freshness: GitHostProjectionFreshness::Unavailable,
        reason: Some(reason),
        matches: vec![],
        truncated: false,
        candidate_truncated: false,
        freshness_generation: 0,
        last_success_observed_at_epoch_ms: None,
        last_attempt_observed_at_epoch_ms: 0,
    }
}

fn cache_key(query: &ProviderQuery) -> String {
    match query {
        ProviderQuery::Github(query) => format!(
            "github|github.com|{}/{}|{}",
            query.repository.owner.to_ascii_lowercase(),
            query.repository.name.to_ascii_lowercase(),
            query.head_branch
        ),
        ProviderQuery::Azure(query) => query.alias_key(),
    }
}

fn known_azure_target(
    alias: &AzurePullRequestQuery,
    row: &ProviderCacheRow,
) -> Option<AzureRepository> {
    let targets = row
        .matches
        .iter()
        .filter(|summary| {
            summary.provider == "azureDevOps"
                && summary.head_repository_owner == alias.repository.organization
                && summary
                    .head_repository_project
                    .as_deref()
                    .is_some_and(|project| azure_name_eq(project, &alias.repository.project))
                && azure_name_eq(&summary.head_repository_name, &alias.repository.name)
                && summary.head_branch == alias.head_branch
        })
        .filter_map(|summary| {
            Some(AzureRepository {
                organization: summary.repository_owner.clone(),
                project: summary.repository_project.clone()?,
                name: summary.repository_name.clone(),
            })
        })
        .collect::<BTreeSet<_>>();
    (targets.len() == 1)
        .then(|| targets.into_iter().next())
        .flatten()
}

fn candidate_identity(
    query: &ProviderQuery,
) -> (&'static str, &'static str, String, Option<String>, String) {
    match query {
        ProviderQuery::Github(query) => (
            "github",
            "github.com",
            query.repository.owner.clone(),
            None,
            query.repository.name.clone(),
        ),
        ProviderQuery::Azure(query) => (
            "azureDevOps",
            "dev.azure.com",
            query.repository.organization.clone(),
            Some(query.repository.project.clone()),
            query.repository.name.clone(),
        ),
    }
}

fn cache_summary(summary: &termloop_providers::PullRequestSummary) -> CachedPullRequest {
    CachedPullRequest {
        provider: match summary.provider {
            GitHostProvider::Github => "github",
            GitHostProvider::AzureDevOps => "azureDevOps",
        }
        .into(),
        host: summary.host.clone(),
        repository_owner: summary.repository_owner.clone(),
        repository_project: summary.repository_project.clone(),
        repository_name: summary.repository_name.clone(),
        number: summary.number,
        title: summary.title.clone(),
        url: summary.url.clone(),
        state: state_name(summary.state).into(),
        merge_commit_oid: summary.merge_commit_oid.clone(),
        base_branch: summary.base_branch.clone(),
        head_branch: summary.head_branch.clone(),
        head_repository_owner: summary.head_repository_owner.clone(),
        head_repository_project: summary.head_repository_project.clone(),
        head_repository_name: summary.head_repository_name.clone(),
        checks: checks_name(summary.checks).into(),
        review: review_name(summary.review).into(),
        mergeability: mergeability_name(summary.mergeability).into(),
        updated_at_epoch_ms: summary.updated_at_epoch_ms,
    }
}

fn projection_summary(summary: &CachedPullRequest) -> GitHostPullRequestSummary {
    let github = summary.provider == "github";
    GitHostPullRequestSummary {
        provider: summary.provider.clone(),
        host: summary.host.clone(),
        repository_owner: summary.repository_owner.clone(),
        repository_project: summary.repository_project.clone(),
        repository_name: summary.repository_name.clone(),
        number: summary.number,
        title: summary.title.clone(),
        url: summary.url.clone(),
        state: summary.state.clone(),
        merge_commit_oid: summary.merge_commit_oid.clone(),
        base_branch: summary.base_branch.clone(),
        head_branch: summary.head_branch.clone(),
        head_repository_owner: summary.head_repository_owner.clone(),
        head_repository_project: summary.head_repository_project.clone(),
        head_repository_name: summary.head_repository_name.clone(),
        check_rollup: if github {
            summary.checks.clone()
        } else {
            "unsupported".into()
        },
        check_rollup_source: if github {
            "githubStatusCheckRollup"
        } else {
            "unsupported"
        }
        .into(),
        review_signal: summary.review.clone(),
        review_signal_source: if github {
            "githubReviewDecision"
        } else {
            "azureRequiredReviewerVotes"
        }
        .into(),
        merge_conflict: match summary.mergeability.as_str() {
            "mergeable" => "noneDetected",
            "conflicting" => "conflicting",
            "blocked" => "policyBlocked",
            _ => "unknown",
        }
        .into(),
        merge_conflict_source: if github {
            "githubMergeable"
        } else {
            "azureMergeStatus"
        }
        .into(),
        activity_at_epoch_ms: summary.updated_at_epoch_ms,
        activity_at_source: if github {
            "githubUpdatedAt"
        } else {
            "azureLifecycleApproximation"
        }
        .into(),
    }
}

fn cache_failure(failure: ProviderFailure) -> ProviderCacheFailure {
    match failure {
        ProviderFailure::ProviderUnavailable => ProviderCacheFailure::ProviderUnavailable,
        ProviderFailure::Unauthorized => ProviderCacheFailure::Unauthorized,
        ProviderFailure::Offline => ProviderCacheFailure::Offline,
        ProviderFailure::RateLimited => ProviderCacheFailure::RateLimited,
        ProviderFailure::Timeout => ProviderCacheFailure::Timeout,
        ProviderFailure::OutputLimit => ProviderCacheFailure::OutputLimit,
        ProviderFailure::MalformedResponse => ProviderCacheFailure::MalformedResponse,
        ProviderFailure::ProviderFailure => ProviderCacheFailure::ProviderFailure,
    }
}

fn map_cache_failure(failure: ProviderCacheFailure) -> GitHostProjectionReason {
    match failure {
        ProviderCacheFailure::ProviderUnavailable => GitHostProjectionReason::ProviderUnavailable,
        ProviderCacheFailure::Unauthorized => GitHostProjectionReason::Unauthorized,
        ProviderCacheFailure::Offline => GitHostProjectionReason::Offline,
        ProviderCacheFailure::RateLimited => GitHostProjectionReason::RateLimited,
        ProviderCacheFailure::Timeout => GitHostProjectionReason::Timeout,
        ProviderCacheFailure::OutputLimit => GitHostProjectionReason::OutputLimit,
        ProviderCacheFailure::MalformedResponse => GitHostProjectionReason::MalformedResponse,
        ProviderCacheFailure::ProviderFailure => GitHostProjectionReason::ProviderFailure,
        ProviderCacheFailure::ParentUnavailable => GitHostProjectionReason::ParentUnavailable,
        ProviderCacheFailure::CandidateLimit => GitHostProjectionReason::CandidateLimit,
    }
}

fn retry_after(failure: Option<ProviderFailure>, now: u64) -> Option<u64> {
    failure.map(|failure| {
        let delay = match failure {
            ProviderFailure::RateLimited => 30 * 60 * 1_000,
            _ => FRESH_MS,
        };
        now.saturating_add(delay)
    })
}

fn map_git_error(error: &GitError) -> GitHostProjectionReason {
    match error {
        GitError::GitUnavailable => GitHostProjectionReason::GitUnavailable,
        GitError::UnsupportedVersion { .. } => GitHostProjectionReason::UnsupportedGit,
        GitError::Timeout { .. } => GitHostProjectionReason::Timeout,
        GitError::OutputLimitExceeded { .. } => GitHostProjectionReason::OutputLimit,
        GitError::NotRepository | GitError::MissingRegistration => {
            GitHostProjectionReason::RepositoryUnavailable
        }
        _ => GitHostProjectionReason::RepositoryUnavailable,
    }
}

fn state_name(value: PullRequestState) -> &'static str {
    match value {
        PullRequestState::Open => "open",
        PullRequestState::Draft => "draft",
        PullRequestState::Merged => "merged",
        PullRequestState::Closed => "closed",
    }
}

fn checks_name(value: CheckState) -> &'static str {
    match value {
        CheckState::Passing => "passing",
        CheckState::Failing => "failing",
        CheckState::Pending => "pending",
        CheckState::NotReported => "notReported",
        CheckState::Unsupported => "unsupported",
        CheckState::Unknown => "unknown",
    }
}

fn review_name(value: ReviewState) -> &'static str {
    match value {
        ReviewState::Approved => "approved",
        ReviewState::ChangesRequested => "changesRequested",
        ReviewState::ReviewRequired => "reviewRequired",
        ReviewState::NotReported => "notReported",
        ReviewState::Unknown => "unknown",
    }
}

fn mergeability_name(value: Mergeability) -> &'static str {
    match value {
        Mergeability::Mergeable => "mergeable",
        Mergeability::Conflicting => "conflicting",
        Mergeability::Blocked => "blocked",
        Mergeability::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn azure_worktree_facts(branches: &[&str]) -> worktree_branches::ObservedBranchFacts {
        let remote = termloop_gitio::RemoteFact {
            name: b"origin".to_vec(),
            fetch_urls: vec![b"https://dev.azure.com/valuespaces/Nucleus/_git/Nucleus".to_vec()],
            push_urls: vec![],
        };
        worktree_branches::ObservedBranchFacts {
            branches: branches
                .iter()
                .map(|branch| BranchRemoteFacts {
                    local_branch: termloop_gitio::GitRefName::from_bytes(
                        format!("refs/heads/{branch}").into_bytes(),
                    )
                    .unwrap(),
                    upstream: None,
                    push: None,
                    push_default: None,
                    remotes: vec![remote.clone()],
                })
                .collect(),
            candidate_truncated: false,
        }
    }

    #[test]
    fn shared_provider_refresh_is_due_at_exactly_two_minutes_without_jitter() {
        let observed_at = 10_000;
        assert!(!provider_refresh_due(
            observed_at,
            observed_at + 2 * 60 * 1_000 - 1
        ));
        assert!(provider_refresh_due(
            observed_at,
            observed_at + 2 * 60 * 1_000
        ));
    }

    #[test]
    fn cached_projection_is_immediate_but_marked_stale_when_refresh_is_due() {
        let observed_at = 10_000;
        let projection = GitHostTaskProjection {
            usage: "displayOnly",
            task_id: "task".into(),
            branch_name: Some("feature".into()),
            repository_provider: Some("azureDevOps".into()),
            repository_host: Some("dev.azure.com".into()),
            repository_owner: Some("valuespaces".into()),
            repository_project: Some("Nucleus".into()),
            repository_name: Some("Nucleus".into()),
            quality: GitHostProjectionQuality::Matches,
            freshness: GitHostProjectionFreshness::Fresh,
            reason: None,
            matches: vec![],
            truncated: false,
            candidate_truncated: false,
            freshness_generation: observed_at,
            last_success_observed_at_epoch_ms: Some(observed_at),
            last_attempt_observed_at_epoch_ms: observed_at,
        };

        let (fresh, refresh_due) =
            cached_projection_for_display(&projection, observed_at + FRESH_MS - 1);
        assert_eq!(fresh.freshness, GitHostProjectionFreshness::Fresh);
        assert!(!refresh_due);

        let (stale, refresh_due) =
            cached_projection_for_display(&projection, observed_at + STALE_MS + 1);
        assert_eq!(stale.freshness, GitHostProjectionFreshness::Stale);
        assert!(refresh_due);
    }

    #[test]
    fn local_facts_cache_is_bounded_expires_and_can_be_invalidated() {
        let cache = GitHostLocalFactsCache::default();
        for index in 0..=MAX_LOCAL_FACTS {
            cache.insert(
                LocalFactsKey {
                    repository_root: PathBuf::from(format!("/repo/{index:03}")),
                    branch_name: "main".into(),
                    worktree_path: None,
                    worktree_generation: 0,
                },
                Err(GitHostProjectionReason::RepositoryUnavailable),
                1,
            );
        }
        let oldest = LocalFactsKey {
            repository_root: PathBuf::from("/repo/000"),
            branch_name: "main".into(),
            worktree_path: None,
            worktree_generation: 0,
        };
        let newest = LocalFactsKey {
            repository_root: PathBuf::from(format!("/repo/{MAX_LOCAL_FACTS:03}")),
            branch_name: "main".into(),
            worktree_path: None,
            worktree_generation: 0,
        };
        assert!(cache.get(&oldest, 1).is_none());
        assert!(cache.get(&newest, LOCAL_FACTS_TTL_MS).is_some());
        assert!(cache.get(&newest, LOCAL_FACTS_TTL_MS + 1).is_none());
        cache.insert(
            newest.clone(),
            Err(GitHostProjectionReason::RepositoryUnavailable),
            100,
        );
        cache.clear();
        assert!(cache.get(&newest, 100).is_none());
    }

    #[test]
    fn semantic_cache_is_bounded_for_large_projects() {
        let mut cache = GitHostSemanticCache::default();
        for index in 0..80 {
            let task_id = format!("task-{index:03}");
            cache.insert(
                "project".into(),
                GitHostTaskProjection {
                    usage: "displayOnly",
                    task_id,
                    branch_name: None,
                    repository_provider: None,
                    repository_host: None,
                    repository_owner: None,
                    repository_project: None,
                    repository_name: None,
                    quality: GitHostProjectionQuality::Unavailable,
                    freshness: GitHostProjectionFreshness::Unavailable,
                    reason: Some(GitHostProjectionReason::NoBranch),
                    matches: vec![],
                    truncated: false,
                    candidate_truncated: false,
                    freshness_generation: 0,
                    last_success_observed_at_epoch_ms: None,
                    last_attempt_observed_at_epoch_ms: 0,
                },
            );
        }
        assert_eq!(cache.entries.len(), 64);
        assert!(!cache.entries.contains_key("task-000"));
        assert!(cache.entries.contains_key("task-079"));
    }

    #[test]
    fn azure_targeted_empty_is_authoritative_only_when_complete() {
        let alias = AzurePullRequestQuery {
            repository: termloop_providers::AzureRepository {
                organization: "fiber-teams".into(),
                project: "Fiber Tests".into(),
                name: "Widget".into(),
            },
            head_branch: "feature".into(),
        };
        let mut scan = AzurePullRequestScan {
            pull_requests: vec![],
            truncated: false,
            incomplete: false,
            parent_resolved: true,
        };
        let directory =
            std::env::temp_dir().join(format!("termloop-azure-targeted-{}", std::process::id()));
        let cache = termloop_store::Store::open(&directory)
            .unwrap()
            .open_provider_cache()
            .unwrap();
        let mut rows = BTreeMap::new();
        update_row_from_azure(&cache, &mut rows, &alias, Ok(scan.clone()), 10);
        assert!(rows.values().next().unwrap().parent_resolved);
        scan.truncated = true;
        update_row_from_azure(&cache, &mut rows, &alias, Ok(scan), 20);
        assert!(!rows.values().next().unwrap().parent_resolved);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn azure_repository_filter_is_derived_only_from_one_proven_target() {
        let alias = AzurePullRequestQuery {
            repository: AzureRepository {
                organization: "fiber-teams".into(),
                project: "Fork Project".into(),
                name: "Widget Fork".into(),
            },
            head_branch: "feature".into(),
        };
        let summary = CachedPullRequest {
            provider: "azureDevOps".into(),
            host: "dev.azure.com".into(),
            repository_owner: "fiber-teams".into(),
            repository_project: Some("Parent Project".into()),
            repository_name: "Widget".into(),
            number: 42,
            title: "PR".into(),
            url: "https://dev.azure.com/fiber-teams/Parent%20Project/_git/Widget/pullrequest/42"
                .into(),
            state: "open".into(),
            merge_commit_oid: None,
            base_branch: "main".into(),
            head_branch: "feature".into(),
            head_repository_owner: "fiber-teams".into(),
            head_repository_project: Some("Fork Project".into()),
            head_repository_name: "Widget Fork".into(),
            checks: "unknown".into(),
            review: "unknown".into(),
            mergeability: "blocked".into(),
            updated_at_epoch_ms: 10,
        };
        let projection = projection_summary(&summary);
        assert_eq!(projection.check_rollup, "unsupported");
        assert_eq!(projection.check_rollup_source, "unsupported");
        assert_eq!(
            projection.review_signal_source,
            "azureRequiredReviewerVotes"
        );
        assert_eq!(projection.merge_conflict, "policyBlocked");
        assert_eq!(projection.merge_conflict_source, "azureMergeStatus");
        assert_eq!(projection.activity_at_source, "azureLifecycleApproximation");
        let mut row = ProviderCacheRow {
            key: cache_key(&ProviderQuery::Azure(alias.clone())),
            matches: vec![summary.clone()],
            truncated: false,
            parent_resolved: true,
            failure: None,
            last_success_observed_at: Some(10),
            last_attempt_observed_at: 10,
            retry_after: None,
        };
        assert_eq!(known_azure_target(&alias, &row).unwrap().name, "Widget");
        let mut other = summary;
        other.repository_name = "Other".into();
        row.matches.push(other);
        assert!(known_azure_target(&alias, &row).is_none());
    }

    #[test]
    fn no_pr_is_authoritative_only_when_complete() {
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("feature".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: None,
            worktree_generation: 0,
            force_refresh: false,
        };
        let query = PullRequestQuery {
            repository: termloop_providers::GitHubRepository {
                owner: "acme".into(),
                name: "widget".into(),
            },
            head_branch: "feature".into(),
        };
        let observation = LocalObservation {
            snapshot,
            candidates: vec![ProviderQuery::Github(query.clone())],
            candidate_truncated: false,
            local_reason: None,
        };
        let row = ProviderCacheRow {
            key: cache_key(&ProviderQuery::Github(query.clone())),
            matches: vec![],
            truncated: false,
            parent_resolved: true,
            failure: None,
            last_success_observed_at: Some(10),
            last_attempt_observed_at: 10,
            retry_after: None,
        };
        let projection = project_task(&observation, &BTreeMap::from([(row.key.clone(), row)]), 10);
        assert_eq!(projection.quality, GitHostProjectionQuality::Matches);
        assert_eq!(projection.freshness, GitHostProjectionFreshness::Fresh);
    }

    #[test]
    fn non_utf_remote_head_ref_never_claims_authoritative_local_branch_absence() {
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("local".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: None,
            worktree_generation: 0,
            force_refresh: false,
        };
        let facts = BranchRemoteFacts {
            local_branch: termloop_gitio::GitRefName::from_bytes(b"refs/heads/local".to_vec())
                .unwrap(),
            upstream: Some(RemoteBranchFact {
                remote: b"origin".to_vec(),
                reference: b"refs/remotes/origin/\xff".to_vec(),
            }),
            push: None,
            push_default: None,
            remotes: vec![termloop_gitio::RemoteFact {
                name: b"origin".to_vec(),
                fetch_urls: vec![b"https://github.com/acme/widget.git".to_vec()],
                push_urls: vec![],
            }],
        };
        assert!(normalize_candidates(&snapshot, &facts).candidate_truncated);
    }

    #[test]
    fn non_utf_local_branch_never_becomes_an_empty_provider_alias() {
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("durable".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: None,
            worktree_generation: 0,
            force_refresh: false,
        };
        let facts = BranchRemoteFacts {
            local_branch: termloop_gitio::GitRefName::from_bytes(
                b"refs/heads/non-utf-\xff".to_vec(),
            )
            .unwrap(),
            upstream: None,
            push: None,
            push_default: None,
            remotes: vec![termloop_gitio::RemoteFact {
                name: b"origin".to_vec(),
                fetch_urls: vec![b"https://github.com/acme/widget.git".to_vec()],
                push_urls: vec![],
            }],
        };
        let observation = normalize_candidates(&snapshot, &facts);
        assert!(observation.candidates.is_empty());
        assert!(observation.candidate_truncated);
    }

    #[test]
    fn current_and_historical_worktree_branches_become_distinct_pr_candidates() {
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("termloop/generated".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: Some(PathBuf::from("/repo-worktree")),
            worktree_generation: 1,
            force_refresh: false,
        };
        let facts = azure_worktree_facts(&["UKIE-804", "termloop/generated", "UKIE-803"]);
        let observation = normalize_candidate_sets(&snapshot, &facts);
        let branches = observation
            .candidates
            .iter()
            .filter_map(|candidate| match candidate {
                ProviderQuery::Azure(query) => Some(query.head_branch.as_str()),
                ProviderQuery::Github(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(branches, vec!["UKIE-804", "termloop/generated", "UKIE-803"]);
        assert!(!observation.candidate_truncated);
    }

    #[test]
    fn two_worktree_branch_candidates_are_admitted_in_the_same_provider_wave() {
        let observed_at = 10_000;
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("termloop/generated".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: Some(PathBuf::from("/repo-worktree")),
            worktree_generation: 1,
            force_refresh: false,
        };
        let facts = azure_worktree_facts(&["UKIE-835", "termloop/generated"]);
        let local_facts = GitHostLocalFactsCache::default();
        local_facts.insert(local_facts_key(&snapshot).unwrap(), Ok(facts), observed_at);
        let directory = std::env::temp_dir().join(format!(
            "termloop-git-host-two-candidate-wave-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let store = termloop_store::Store::open(directory.join("state.json")).unwrap();
        let prepared = GitHostPullRequestListPlan {
            tasks: vec![snapshot],
            cache: store.open_provider_cache().unwrap(),
            github: None,
            azure: None,
            local_facts,
            observed_at,
            deadline: termloop_platform::MonotonicDeadline::after(Duration::from_secs(10)).unwrap(),
        }
        .prepare();

        let heads = prepared
            .jobs
            .iter()
            .filter_map(|job| match &job.query {
                ProviderQueryJob::Azure { query, .. } => Some(query.head_branch.as_str()),
                ProviderQueryJob::Github(_) => None,
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(heads, BTreeSet::from(["UKIE-835", "termloop/generated"]));
        assert!(prepared.follow_up_task_ids.is_empty());
        drop(heads);
        drop(prepared);
        drop(store);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn deferred_provider_wave_keeps_stale_matches_visible_and_refresh_due() {
        let previous_observed_at = 10_000;
        let observed_at = previous_observed_at + FRESH_MS;
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("termloop/generated".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: Some(PathBuf::from("/repo-worktree")),
            worktree_generation: 1,
            force_refresh: false,
        };
        let facts = azure_worktree_facts(&["UKIE-835-current", "termloop/generated", "UKIE-835"]);
        let local_facts = GitHostLocalFactsCache::default();
        local_facts.insert(local_facts_key(&snapshot).unwrap(), Ok(facts), observed_at);
        let directory = std::env::temp_dir().join(format!(
            "termloop-git-host-deferred-wave-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let store = termloop_store::Store::open(directory.join("state.json")).unwrap();
        let cache = store.open_provider_cache().unwrap();
        for (number, branch) in [
            (3, "UKIE-835-current"),
            (2, "termloop/generated"),
            (1, "UKIE-835"),
        ] {
            let query = AzurePullRequestQuery {
                repository: AzureRepository {
                    organization: "valuespaces".into(),
                    project: "Nucleus".into(),
                    name: "Nucleus".into(),
                },
                head_branch: branch.into(),
            };
            let row = ProviderCacheRow {
                key: cache_key(&ProviderQuery::Azure(query)),
                matches: vec![CachedPullRequest {
                    provider: "azureDevOps".into(),
                    host: "dev.azure.com".into(),
                    repository_owner: "valuespaces".into(),
                    repository_project: Some("Nucleus".into()),
                    repository_name: "Nucleus".into(),
                    number,
                    title: format!("PR {number}"),
                    url: format!(
                        "https://dev.azure.com/valuespaces/Nucleus/_git/Nucleus/pullrequest/{number}"
                    ),
                    state: "closed".into(),
                    merge_commit_oid: None,
                    base_branch: "development".into(),
                    head_branch: branch.into(),
                    head_repository_owner: "valuespaces".into(),
                    head_repository_project: Some("Nucleus".into()),
                    head_repository_name: "Nucleus".into(),
                    checks: "unknown".into(),
                    review: "unknown".into(),
                    mergeability: "unknown".into(),
                    updated_at_epoch_ms: previous_observed_at + number,
                }],
                truncated: false,
                parent_resolved: true,
                failure: None,
                last_success_observed_at: Some(previous_observed_at),
                last_attempt_observed_at: previous_observed_at,
                retry_after: None,
            };
            cache.update(row).unwrap();
        }

        let prepared = GitHostPullRequestListPlan {
            tasks: vec![snapshot],
            cache,
            github: None,
            azure: None,
            local_facts,
            observed_at,
            deadline: termloop_platform::MonotonicDeadline::after(Duration::from_secs(10)).unwrap(),
        }
        .prepare();

        assert_eq!(prepared.jobs.len(), MAX_PROVIDER_QUERIES_PER_TASK_WAVE);
        assert_eq!(prepared.rows.len(), 3);
        assert_eq!(prepared.follow_up_task_ids, vec!["task"]);
        let observed = prepared.complete(Vec::new());
        let projection = &observed.projections[0];
        assert_eq!(
            projection
                .matches
                .iter()
                .map(|pull_request| pull_request.number)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([1, 2, 3])
        );
        assert_eq!(projection.freshness, GitHostProjectionFreshness::Stale);
        assert!(projection_refresh_due(projection, observed_at));

        drop(observed);
        drop(store);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn bounded_provider_wave_rotates_to_the_least_recently_attempted_alias() {
        let observed_at = 24 * 60 * 60 * 1_000;
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("termloop/generated".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: Some(PathBuf::from("/repo-worktree")),
            worktree_generation: 1,
            force_refresh: false,
        };
        let facts = azure_worktree_facts(&["UKIE-835-current", "termloop/generated", "UKIE-835"]);
        let local_facts = GitHostLocalFactsCache::default();
        local_facts.insert(local_facts_key(&snapshot).unwrap(), Ok(facts), observed_at);
        let directory = std::env::temp_dir().join(format!(
            "termloop-git-host-wave-rotation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let store = termloop_store::Store::open(directory.join("state.json")).unwrap();
        let cache = store.open_provider_cache().unwrap();
        let alias_key = |branch: &str| {
            cache_key(&ProviderQuery::Azure(AzurePullRequestQuery {
                repository: AzureRepository {
                    organization: "valuespaces".into(),
                    project: "Nucleus".into(),
                    name: "Nucleus".into(),
                },
                head_branch: branch.into(),
            }))
        };
        // The two leading aliases fall due every wave. Only the trailing alias
        // has been starved past STALE_MS, so it must displace the lower-ranked
        // of the two rather than being deferred again.
        for (branch, last_attempt) in [
            ("UKIE-835-current", observed_at - FRESH_MS),
            ("termloop/generated", observed_at - FRESH_MS),
            ("UKIE-835", observed_at - 16 * 60 * 60 * 1_000),
        ] {
            cache
                .update(ProviderCacheRow {
                    key: alias_key(branch),
                    matches: vec![],
                    truncated: false,
                    parent_resolved: true,
                    failure: None,
                    last_success_observed_at: Some(last_attempt),
                    last_attempt_observed_at: last_attempt,
                    retry_after: None,
                })
                .unwrap();
        }

        let prepared = GitHostPullRequestListPlan {
            tasks: vec![snapshot],
            cache,
            github: None,
            azure: None,
            local_facts,
            observed_at,
            deadline: termloop_platform::MonotonicDeadline::after(Duration::from_secs(10)).unwrap(),
        }
        .prepare();

        assert_eq!(
            prepared
                .jobs
                .iter()
                .map(|job| job.key().to_owned())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([alias_key("UKIE-835"), alias_key("UKIE-835-current")])
        );
        assert_eq!(prepared.follow_up_task_ids, vec!["task"]);

        drop(prepared);
        drop(store);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn worktree_alias_never_substitutes_a_differently_named_upstream_base() {
        let snapshot = TaskSnapshot {
            task_id: "task".into(),
            project_id: "project".into(),
            branch_name: Some("termloop/generated".into()),
            repository_root: Some(PathBuf::from("/repo")),
            worktree_path: Some(PathBuf::from("/repo-worktree")),
            worktree_generation: 1,
            force_refresh: false,
        };
        let facts = BranchRemoteFacts {
            local_branch: termloop_gitio::GitRefName::from_bytes(
                b"refs/heads/UKIE-803-MASTER".to_vec(),
            )
            .unwrap(),
            upstream: Some(RemoteBranchFact {
                remote: b"origin".to_vec(),
                reference: b"refs/remotes/origin/master".to_vec(),
            }),
            push: None,
            push_default: None,
            remotes: vec![termloop_gitio::RemoteFact {
                name: b"origin".to_vec(),
                fetch_urls: vec![
                    b"https://dev.azure.com/valuespaces/Nucleus/_git/Nucleus".to_vec(),
                ],
                push_urls: vec![],
            }],
        };

        let observation = normalize_candidates(&snapshot, &facts);
        let heads = observation
            .candidates
            .iter()
            .filter_map(|candidate| match candidate {
                ProviderQuery::Azure(query) => Some(query.head_branch.as_str()),
                ProviderQuery::Github(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(heads, vec!["UKIE-803-MASTER"]);
    }

    #[test]
    fn provider_failure_takes_precedence_over_candidate_truncation() {
        let query = PullRequestQuery {
            repository: termloop_providers::GitHubRepository {
                owner: "acme".into(),
                name: "widget".into(),
            },
            head_branch: "feature".into(),
        };
        let observation = LocalObservation {
            snapshot: TaskSnapshot {
                task_id: "task".into(),
                project_id: "project".into(),
                branch_name: Some("feature".into()),
                repository_root: Some(PathBuf::from("/repo")),
                worktree_path: None,
                worktree_generation: 0,
                force_refresh: false,
            },
            candidates: vec![ProviderQuery::Github(query.clone())],
            candidate_truncated: true,
            local_reason: None,
        };
        let row = ProviderCacheRow {
            key: cache_key(&ProviderQuery::Github(query.clone())),
            matches: vec![],
            truncated: false,
            parent_resolved: true,
            failure: Some(ProviderCacheFailure::Unauthorized),
            last_success_observed_at: None,
            last_attempt_observed_at: 10,
            retry_after: Some(100),
        };
        let projection = project_task(&observation, &BTreeMap::from([(row.key.clone(), row)]), 10);
        assert_eq!(
            projection.reason,
            Some(GitHostProjectionReason::Unauthorized)
        );
        assert!(projection.candidate_truncated);
    }
}
