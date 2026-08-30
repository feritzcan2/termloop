use std::collections::{HashMap, HashSet};

use serde_json::Value;
use termloop_domain::{
    IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, TaskRecord, TaskSourceProvider,
    TaskSourceScope, TaskStatus,
};
use termloop_providers::{JiraIssueSnapshot, JiraSearchRequest, JiraSearchResult, JiraSearchScope};

pub use termloop_domain::{
    TaskSourceBoardSelection, TaskSourceConfiguration, TaskSourceImportPolicy,
    TaskSourceStatusSelection,
};

mod observer;
mod projection;
pub use observer::{
    JiraTaskSourceRefreshObserver, TaskSourceBoard, TaskSourceBoardList, TaskSourceBoardObserver,
    TaskSourceJiraObserver, TaskSourceRefreshObserver, TaskSourceStatus, TaskSourceStatusList,
    UnavailableTaskSourceRefreshObserver,
};
pub use projection::{task_source_candidate_json, task_source_failure_wire, task_source_view_json};

use crate::task_worktree::{BRIEF_LIMIT, TITLE_LIMIT};
use crate::{CoreError, CoreRuntime, store_error};

const ASSIGNED_TO_ME_JQL: &str = "assignee = currentUser() ORDER BY updated DESC";
const ALL_ISSUES_JQL: &str = "ORDER BY updated DESC";
const TASK_SOURCE_DUE_BATCH_MAX: usize = 64;
const TASK_SOURCE_REFRESH_STALE_AFTER_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSourceFailure {
    CredentialsMissing,
    CredentialsInvalid,
    CredentialsUnavailable,
    ScopeInvalid,
    RateLimited,
    ProviderUnavailable,
    ResponseTooLarge,
    MalformedResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSourceRuntimeStatus {
    Idle,
    Refreshing,
    Attention,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskSourceCandidateObservation {
    candidate: TaskSourceCandidateSnapshot,
    matches_scope: bool,
    observed_generation: u64,
    observation_sequence: u64,
}

/// Provider-neutral work item observed from a configured Task Source.
///
/// Provider adapters normalize into this shape at the refresh boundary so Task
/// creation policy does not need to know whether the source is Jira or a future
/// issue provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceCandidateSnapshot {
    pub external_id: String,
    pub external_ref: String,
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub status_name: String,
    pub assignee_display: Option<String>,
    pub updated_at: String,
}

impl From<JiraIssueSnapshot> for TaskSourceCandidateSnapshot {
    fn from(issue: JiraIssueSnapshot) -> Self {
        Self {
            external_id: issue.external_id,
            external_ref: issue.key,
            url: issue.url,
            title: issue.summary,
            description: issue.description,
            status_name: issue.status_name,
            assignee_display: issue.assignee_display,
            updated_at: issue.updated_at,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TaskSourceRuntimeEntry {
    refreshing: bool,
    refresh_started_at_epoch_ms: Option<u64>,
    failure: Option<TaskSourceFailure>,
    last_attempt_at_epoch_ms: Option<u64>,
    last_successful_at_epoch_ms: Option<u64>,
    retry_after_epoch_ms: Option<u64>,
    truncated: bool,
    observation_sequence: u64,
    candidates: Vec<TaskSourceCandidateObservation>,
}

#[derive(Debug, Default)]
pub(crate) struct TaskSourceRuntimeState {
    entries: HashMap<String, TaskSourceRuntimeEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceView {
    pub configuration: TaskSourceConfiguration,
    pub status: TaskSourceRuntimeStatus,
    pub failure: Option<TaskSourceFailure>,
    pub last_attempt_at_epoch_ms: Option<u64>,
    pub last_successful_at_epoch_ms: Option<u64>,
    pub retry_after_epoch_ms: Option<u64>,
    pub candidate_count: usize,
    pub truncated: bool,
    pub observation_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceCandidateView {
    pub source_id: String,
    pub candidate: TaskSourceCandidateSnapshot,
    pub state: &'static str,
    pub task_id: Option<String>,
    pub observed_generation: u64,
    pub observation_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceRefreshPlan {
    pub source_id: String,
    pub generation: u64,
    pub request: JiraSearchRequest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskSourceRefreshOutcome {
    Success(JiraSearchResult),
    Failure {
        reason: TaskSourceFailure,
        retry_after_seconds: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceRefreshApply {
    pub source_id: String,
    pub candidate_count: usize,
    pub truncated: bool,
    pub observation_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceMutation {
    pub source: TaskSourceConfiguration,
    pub state_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceDelete {
    pub source_id: String,
    pub state_revision: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskSourceImport {
    pub task: Value,
    pub state_revision: u64,
}

impl CoreRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn create_task_source(
        &mut self,
        source_id: String,
        project_id: &str,
        name: String,
        site_base_url: String,
        scope_kind: &str,
        boards: Vec<TaskSourceBoardSelection>,
        statuses: Vec<TaskSourceStatusSelection>,
        jql: Option<String>,
        import_policy: &str,
        auto_import_active_task_limit: u64,
        refresh_interval_seconds: u64,
        expected_revision: u64,
        now_epoch_ms: u64,
    ) -> Result<TaskSourceMutation, CoreError> {
        if expected_revision != self.store.revision() {
            return Err(CoreError::RevisionConflict);
        }
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let source = TaskSourceConfiguration {
            id: source_id,
            project_id: project_id.to_owned(),
            provider: TaskSourceProvider::Jira,
            name: normalized_name(name)?,
            enabled: true,
            generation: 1,
            site_base_url: termloop_providers::normalize_jira_site_base_url(&site_base_url)
                .map_err(|_| CoreError::InvalidParams("siteBaseUrl".into()))?,
            scope: source_scope(scope_kind, jql)?,
            boards: source_boards(boards)?,
            statuses: source_statuses(statuses)?,
            import_policy: source_import_policy(import_policy)?,
            auto_import_active_task_limit,
            refresh_interval_seconds,
            ignored_external_ids: vec![],
            created_at_epoch_ms: now_epoch_ms,
            updated_at_epoch_ms: now_epoch_ms,
        };
        if !source.is_valid() {
            return Err(CoreError::InvalidParams("taskSource".into()));
        }
        self.store
            .insert_task_source_configuration(&self.write_authority, source.clone())
            .map_err(store_error)?;
        Ok(TaskSourceMutation {
            source,
            state_revision: self.store.revision(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_task_source(
        &mut self,
        source_id: &str,
        name: String,
        enabled: bool,
        site_base_url: String,
        scope_kind: &str,
        boards: Vec<TaskSourceBoardSelection>,
        statuses: Vec<TaskSourceStatusSelection>,
        jql: Option<String>,
        import_policy: &str,
        auto_import_active_task_limit: u64,
        refresh_interval_seconds: u64,
        expected_generation: u64,
        expected_revision: u64,
        now_epoch_ms: u64,
    ) -> Result<TaskSourceMutation, CoreError> {
        if expected_revision != self.store.revision() {
            return Err(CoreError::RevisionConflict);
        }
        let mut source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        if source.generation != expected_generation {
            return Err(CoreError::RevisionConflict);
        }
        let next_site = termloop_providers::normalize_jira_site_base_url(&site_base_url)
            .map_err(|_| CoreError::InvalidParams("siteBaseUrl".into()))?;
        let next_scope = source_scope(scope_kind, jql)?;
        let next_boards = source_boards(boards)?;
        let next_statuses = source_statuses(statuses)?;
        let next_name = normalized_name(name)?;
        let next_import_policy = source_import_policy(import_policy)?;
        let query_changed = source.site_base_url != next_site
            || source.scope != next_scope
            || source.boards != next_boards
            || source.statuses != next_statuses;
        if source.name == next_name
            && source.enabled == enabled
            && source.site_base_url == next_site
            && source.scope == next_scope
            && source.boards == next_boards
            && source.statuses == next_statuses
            && source.import_policy == next_import_policy
            && source.auto_import_active_task_limit == auto_import_active_task_limit
            && source.refresh_interval_seconds == refresh_interval_seconds
        {
            return Ok(TaskSourceMutation {
                source,
                state_revision: self.store.revision(),
            });
        }
        let observation_sequence = query_changed
            .then(|| self.next_observation_sequence())
            .transpose()?;
        source.name = next_name;
        source.enabled = enabled;
        source.site_base_url = next_site;
        source.scope = next_scope;
        source.boards = next_boards;
        source.statuses = next_statuses;
        source.import_policy = next_import_policy;
        source.auto_import_active_task_limit = auto_import_active_task_limit;
        source.refresh_interval_seconds = refresh_interval_seconds;
        source.generation = source
            .generation
            .checked_add(1)
            .ok_or_else(|| CoreError::Store("Task Source generation overflow".into()))?;
        source.updated_at_epoch_ms = next_updated_at(source.updated_at_epoch_ms, now_epoch_ms)?;
        self.store
            .replace_task_source_configuration(&self.write_authority, source.clone())
            .map_err(store_error)?;
        if let Some(sequence) = observation_sequence {
            let runtime = self
                .task_source_runtime
                .entries
                .entry(source_id.to_owned())
                .or_default();
            runtime.refreshing = false;
            runtime.refresh_started_at_epoch_ms = None;
            runtime.failure = None;
            runtime.last_attempt_at_epoch_ms = None;
            runtime.last_successful_at_epoch_ms = None;
            runtime.retry_after_epoch_ms = None;
            runtime.truncated = false;
            runtime.observation_sequence = sequence;
            runtime.candidates.clear();
        }
        if !source.enabled
            && let Some(runtime) = self.task_source_runtime.entries.get_mut(source_id)
        {
            runtime.refreshing = false;
            runtime.refresh_started_at_epoch_ms = None;
        }
        Ok(TaskSourceMutation {
            source,
            state_revision: self.store.revision(),
        })
    }

    pub fn delete_task_source(
        &mut self,
        source_id: &str,
        expected_generation: u64,
        expected_revision: u64,
    ) -> Result<TaskSourceDelete, CoreError> {
        if expected_revision != self.store.revision() {
            return Err(CoreError::RevisionConflict);
        }
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        if source.generation != expected_generation {
            return Err(CoreError::RevisionConflict);
        }
        self.store
            .delete_task_source_configuration(&self.write_authority, source_id)
            .map_err(store_error)?;
        self.task_source_runtime.entries.remove(source_id);
        Ok(TaskSourceDelete {
            source_id: source_id.to_owned(),
            state_revision: self.store.revision(),
        })
    }

    pub fn task_source_views(&self, project_id: &str) -> Result<Vec<TaskSourceView>, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        Ok(self
            .store
            .task_source_configurations()
            .iter()
            .filter(|source| source.project_id == project_id)
            .cloned()
            .map(|source| self.task_source_view(source))
            .collect())
    }

    pub fn due_task_source_refreshes(&self, now_epoch_ms: u64) -> Vec<(String, u64)> {
        self.store
            .task_source_configurations()
            .iter()
            .filter(|source| source.enabled)
            .filter(|source| self.project_exists(&source.project_id))
            .filter(|source| {
                let runtime = self.task_source_runtime.entries.get(&source.id);
                if let Some(runtime) = runtime
                    && runtime.refreshing
                {
                    return !refresh_is_active(runtime, now_epoch_ms);
                }
                if runtime
                    .and_then(|runtime| runtime.retry_after_epoch_ms)
                    .is_some_and(|retry_at| retry_at > now_epoch_ms)
                {
                    return false;
                }
                runtime
                    .and_then(|runtime| runtime.last_attempt_at_epoch_ms)
                    .and_then(|last_attempt| {
                        source
                            .refresh_interval_seconds
                            .checked_mul(1_000)
                            .and_then(|interval| last_attempt.checked_add(interval))
                    })
                    .is_none_or(|due_at| due_at <= now_epoch_ms)
            })
            .take(TASK_SOURCE_DUE_BATCH_MAX)
            .map(|source| (source.id.clone(), source.generation))
            .collect()
    }

    pub fn task_source_view_by_id(&self, source_id: &str) -> Result<TaskSourceView, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        Ok(self.task_source_view(source))
    }

    /// Current source-owned WIP for automatic intake. Closed or archived Tasks
    /// release their slot; unrelated Tasks in the same Project never consume a
    /// source's limit.
    pub fn active_task_source_task_count(&self, source_id: &str) -> Result<u64, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        let linked_task_ids = self
            .store
            .issue_links()
            .iter()
            .filter(|link| link.source_id.as_deref() == Some(source_id))
            .map(|link| link.task_id.as_str())
            .collect::<HashSet<_>>();
        u64::try_from(
            self.store
                .tasks()
                .iter()
                .filter(|task| {
                    linked_task_ids.contains(task.id.as_str())
                        && task.status == TaskStatus::Open
                        && task.archived_at_epoch_ms.is_none()
                })
                .count(),
        )
        .map_err(|_| CoreError::Store("Task Source active Task count overflow".into()))
    }

    pub fn record_task_source_credentials_set(
        &mut self,
        source_id: &str,
        expected_generation: u64,
    ) -> Result<u64, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        if source.generation != expected_generation {
            return Err(CoreError::RevisionConflict);
        }
        let sequence = self.next_observation_sequence()?;
        let runtime = self
            .task_source_runtime
            .entries
            .entry(source_id.to_owned())
            .or_default();
        if runtime.failure.is_some_and(|failure| {
            matches!(
                failure,
                TaskSourceFailure::CredentialsMissing
                    | TaskSourceFailure::CredentialsInvalid
                    | TaskSourceFailure::CredentialsUnavailable
            )
        }) {
            runtime.failure = None;
            runtime.retry_after_epoch_ms = None;
        }
        runtime.observation_sequence = sequence;
        Ok(sequence)
    }

    fn task_source_view(&self, source: TaskSourceConfiguration) -> TaskSourceView {
        let runtime = self.task_source_runtime.entries.get(&source.id);
        TaskSourceView {
            status: if !source.enabled {
                TaskSourceRuntimeStatus::Disabled
            } else if runtime.is_some_and(|runtime| runtime.refreshing) {
                TaskSourceRuntimeStatus::Refreshing
            } else if runtime.and_then(|runtime| runtime.failure).is_some() {
                TaskSourceRuntimeStatus::Attention
            } else {
                TaskSourceRuntimeStatus::Idle
            },
            failure: runtime.and_then(|runtime| runtime.failure),
            last_attempt_at_epoch_ms: runtime.and_then(|runtime| runtime.last_attempt_at_epoch_ms),
            last_successful_at_epoch_ms: runtime
                .and_then(|runtime| runtime.last_successful_at_epoch_ms),
            retry_after_epoch_ms: runtime.and_then(|runtime| runtime.retry_after_epoch_ms),
            candidate_count: runtime.map_or(0, |runtime| runtime.candidates.len()),
            truncated: runtime.is_some_and(|runtime| runtime.truncated),
            observation_sequence: runtime.map_or(0, |runtime| runtime.observation_sequence),
            configuration: source,
        }
    }

    pub fn prepare_task_source_refresh(
        &mut self,
        source_id: &str,
        expected_generation: u64,
        now_epoch_ms: u64,
    ) -> Result<TaskSourceRefreshPlan, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        if source.generation != expected_generation {
            return Err(CoreError::RevisionConflict);
        }
        if !source.enabled {
            return Err(CoreError::InvalidParams("sourceId".into()));
        }
        let entry = self
            .task_source_runtime
            .entries
            .entry(source.id.clone())
            .or_default();
        if refresh_is_active(entry, now_epoch_ms) {
            return Err(CoreError::InvalidParams("refreshInProgress".into()));
        }
        entry.refreshing = true;
        entry.refresh_started_at_epoch_ms = Some(now_epoch_ms);
        entry.last_attempt_at_epoch_ms = Some(now_epoch_ms);
        let request = refresh_request(&source);
        Ok(TaskSourceRefreshPlan {
            source_id: source.id,
            generation: source.generation,
            request,
        })
    }

    pub fn apply_task_source_refresh(
        &mut self,
        plan: TaskSourceRefreshPlan,
        outcome: TaskSourceRefreshOutcome,
        now_epoch_ms: u64,
    ) -> Result<TaskSourceRefreshApply, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == plan.source_id)
            .cloned()
            .ok_or(CoreError::RevisionConflict)?;
        if source.generation != plan.generation || !source.enabled {
            if let Some(entry) = self.task_source_runtime.entries.get_mut(&plan.source_id) {
                entry.refreshing = false;
                entry.refresh_started_at_epoch_ms = None;
            }
            return Err(CoreError::RevisionConflict);
        }
        let sequence = self.next_observation_sequence()?;
        let entry = self
            .task_source_runtime
            .entries
            .entry(plan.source_id.clone())
            .or_default();
        entry.refreshing = false;
        entry.refresh_started_at_epoch_ms = None;
        entry.last_attempt_at_epoch_ms = Some(now_epoch_ms);
        entry.observation_sequence = sequence;
        match outcome {
            TaskSourceRefreshOutcome::Success(result) => {
                let mut truncated = result.truncated || result.issues.len() > 50;
                let mut current_ids = HashSet::new();
                let mut candidates = Vec::with_capacity(result.issues.len().min(50));
                for issue in result.issues.into_iter().take(50) {
                    let candidate = TaskSourceCandidateSnapshot::from(issue);
                    if !current_ids.insert(candidate.external_id.clone()) {
                        truncated = true;
                        continue;
                    }
                    candidates.push(TaskSourceCandidateObservation {
                        candidate,
                        matches_scope: true,
                        observed_generation: source.generation,
                        observation_sequence: sequence,
                    });
                }
                for previous in &entry.candidates {
                    if candidates.len() >= 50 {
                        break;
                    }
                    if !current_ids.contains(&previous.candidate.external_id) {
                        let mut previous = previous.clone();
                        previous.matches_scope = false;
                        previous.observed_generation = source.generation;
                        previous.observation_sequence = sequence;
                        candidates.push(previous);
                    }
                }
                entry.candidates = candidates;
                entry.failure = None;
                entry.retry_after_epoch_ms = None;
                entry.truncated = truncated;
                entry.last_successful_at_epoch_ms = Some(now_epoch_ms);
            }
            TaskSourceRefreshOutcome::Failure {
                reason,
                retry_after_seconds,
            } => {
                entry.failure = Some(reason);
                entry.retry_after_epoch_ms = retry_after_seconds
                    .and_then(|seconds| seconds.checked_mul(1_000))
                    .and_then(|delay| now_epoch_ms.checked_add(delay));
            }
        }
        Ok(TaskSourceRefreshApply {
            source_id: plan.source_id,
            candidate_count: entry.candidates.len(),
            truncated: entry.truncated,
            observation_sequence: sequence,
        })
    }

    pub fn task_source_candidates(
        &self,
        source_id: &str,
    ) -> Result<Vec<TaskSourceCandidateView>, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        let candidates = self
            .task_source_runtime
            .entries
            .get(source_id)
            .map_or(&[][..], |runtime| runtime.candidates.as_slice());
        Ok(candidates
            .iter()
            .map(|candidate| self.task_source_candidate_view(source, candidate))
            .collect())
    }

    #[allow(clippy::too_many_arguments)] // Each argument is an independently validated command proof or intent field.
    pub fn ignore_task_source_candidate(
        &mut self,
        source_id: &str,
        external_id: &str,
        expected_generation: u64,
        expected_observation_sequence: u64,
        expected_revision: u64,
        ignored: bool,
        now_epoch_ms: u64,
    ) -> Result<(TaskSourceCandidateView, u64, u64), CoreError> {
        if expected_revision != self.store.revision() {
            return Err(CoreError::RevisionConflict);
        }
        let mut source = self.current_candidate_source(
            source_id,
            external_id,
            expected_generation,
            expected_observation_sequence,
        )?;
        let already_ignored = source
            .ignored_external_ids
            .iter()
            .any(|value| value == external_id);
        if ignored == already_ignored {
            let candidate = self.current_candidate_view(source_id, external_id)?;
            return Ok((candidate, source.generation, self.store.revision()));
        }
        if ignored {
            let candidate = self.current_candidate_observation(source_id, external_id)?;
            if self.find_linked_task(&source, external_id).is_some()
                || self
                    .find_possible_legacy_task(&source, &candidate.candidate)
                    .is_some()
            {
                return Err(CoreError::InvalidParams("externalId".into()));
            }
            source.ignored_external_ids.push(external_id.to_owned());
        } else {
            source
                .ignored_external_ids
                .retain(|value| value != external_id);
        }
        source.updated_at_epoch_ms = next_updated_at(source.updated_at_epoch_ms, now_epoch_ms)?;
        self.store
            .replace_task_source_configuration(&self.write_authority, source.clone())
            .map_err(store_error)?;
        let sequence = self.next_observation_sequence()?;
        let runtime = self
            .task_source_runtime
            .entries
            .get_mut(source_id)
            .ok_or(CoreError::RevisionConflict)?;
        for candidate in &mut runtime.candidates {
            candidate.observed_generation = source.generation;
            candidate.observation_sequence = sequence;
        }
        runtime.observation_sequence = sequence;
        let candidate = self.current_candidate_view(source_id, external_id)?;
        Ok((candidate, source.generation, self.store.revision()))
    }

    #[allow(clippy::too_many_arguments)] // Each argument is an independently validated command proof or intent field.
    pub fn import_task_source_candidate(
        &mut self,
        source_id: &str,
        external_id: &str,
        expected_generation: u64,
        expected_observation_sequence: u64,
        expected_revision: u64,
        task_id: String,
        now_epoch_ms: u64,
    ) -> Result<TaskSourceImport, CoreError> {
        let source = self.current_candidate_source(
            source_id,
            external_id,
            expected_generation,
            expected_observation_sequence,
        )?;
        if let Some(existing_task) = self.find_linked_task(&source, external_id) {
            return Ok(TaskSourceImport {
                task: self.task_projection(existing_task)?,
                state_revision: self.store.revision(),
            });
        }
        if expected_revision != self.store.revision() {
            return Err(CoreError::RevisionConflict);
        }
        if source
            .ignored_external_ids
            .iter()
            .any(|value| value == external_id)
        {
            return Err(CoreError::InvalidParams("externalId".into()));
        }
        let candidate = self
            .current_candidate_observation(source_id, external_id)?
            .clone();
        if self
            .find_possible_legacy_task(&source, &candidate.candidate)
            .is_some()
        {
            return Err(CoreError::InvalidParams("externalId".into()));
        }
        if !candidate.matches_scope {
            return Err(CoreError::InvalidParams("externalId".into()));
        }
        let rank = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == source.project_id)
            .map(|task| task.rank)
            .max()
            .map_or(Ok(0), |rank| {
                rank.checked_add(1)
                    .ok_or_else(|| CoreError::Store("Task rank overflow".into()))
            })?;
        let task = TaskRecord {
            id: task_id,
            project_id: source.project_id,
            title: imported_title(&candidate.candidate),
            brief: imported_brief(&candidate.candidate),
            status: TaskStatus::Open,
            archived_at_epoch_ms: None,
            branch: None,
            worktree: None,
            worktree_generation: 0,
            steward_brief_markdown: String::new(),
            steward_brief_revision: 1,
            rank,
            created_at_epoch_ms: now_epoch_ms,
            updated_at_epoch_ms: now_epoch_ms,
        };
        let link = IssueLink {
            task_id: task.id.clone(),
            provider: IssueLinkProvider::Jira,
            external_ref: candidate.candidate.external_ref,
            source_id: Some(source.id),
            external_id: Some(candidate.candidate.external_id),
            external_updated_at: Some(candidate.candidate.updated_at),
            url: Some(candidate.candidate.url),
            sync_authority: IssueLinkSyncAuthority::None,
        };
        self.store
            .insert_task_from_source(&self.write_authority, task.clone(), link)
            .map_err(store_error)?;
        Ok(TaskSourceImport {
            task: self.task_projection(&task)?,
            state_revision: self.store.revision(),
        })
    }

    pub fn retain_current_task_source_runtime(&mut self) {
        let source_ids = self
            .store
            .task_source_configurations()
            .iter()
            .map(|source| source.id.as_str())
            .collect::<HashSet<_>>();
        self.task_source_runtime
            .entries
            .retain(|source_id, _| source_ids.contains(source_id.as_str()));
    }

    fn current_candidate_source(
        &self,
        source_id: &str,
        external_id: &str,
        expected_generation: u64,
        expected_observation_sequence: u64,
    ) -> Result<TaskSourceConfiguration, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if !self.project_exists(&source.project_id) {
            return Err(CoreError::NotFound);
        }
        let candidate = self.current_candidate_observation(source_id, external_id)?;
        if source.generation != expected_generation
            || candidate.observed_generation != expected_generation
            || candidate.observation_sequence != expected_observation_sequence
        {
            return Err(CoreError::RevisionConflict);
        }
        Ok(source)
    }

    fn current_candidate_observation(
        &self,
        source_id: &str,
        external_id: &str,
    ) -> Result<&TaskSourceCandidateObservation, CoreError> {
        self.task_source_runtime
            .entries
            .get(source_id)
            .and_then(|runtime| {
                runtime
                    .candidates
                    .iter()
                    .find(|candidate| candidate.candidate.external_id == external_id)
            })
            .ok_or(CoreError::NotFound)
    }

    fn current_candidate_view(
        &self,
        source_id: &str,
        external_id: &str,
    ) -> Result<TaskSourceCandidateView, CoreError> {
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.id == source_id)
            .ok_or(CoreError::NotFound)?;
        let candidate = self.current_candidate_observation(source_id, external_id)?;
        Ok(self.task_source_candidate_view(source, candidate))
    }

    fn task_source_candidate_view(
        &self,
        source: &TaskSourceConfiguration,
        candidate: &TaskSourceCandidateObservation,
    ) -> TaskSourceCandidateView {
        let linked = self.find_linked_issue(source, &candidate.candidate.external_id);
        let possible_duplicate = linked
            .is_none()
            .then(|| self.find_possible_legacy_task(source, &candidate.candidate))
            .flatten();
        let state = if let Some((link, _)) = linked {
            if link
                .external_updated_at
                .as_deref()
                .is_some_and(|updated_at| updated_at != candidate.candidate.updated_at)
            {
                "changed"
            } else {
                "added"
            }
        } else if possible_duplicate.is_some() {
            "possibleDuplicate"
        } else if source
            .ignored_external_ids
            .iter()
            .any(|value| value == &candidate.candidate.external_id)
        {
            "ignored"
        } else if !candidate.matches_scope {
            "noLongerMatches"
        } else {
            "new"
        };
        TaskSourceCandidateView {
            source_id: source.id.clone(),
            candidate: candidate.candidate.clone(),
            state,
            task_id: linked
                .map(|(_, task)| task.id.clone())
                .or_else(|| possible_duplicate.map(|task| task.id.clone())),
            observed_generation: candidate.observed_generation,
            observation_sequence: candidate.observation_sequence,
        }
    }

    fn find_linked_task<'a>(
        &'a self,
        source: &TaskSourceConfiguration,
        external_id: &str,
    ) -> Option<&'a TaskRecord> {
        self.find_linked_issue(source, external_id)
            .map(|(_, task)| task)
    }

    fn find_linked_issue<'a>(
        &'a self,
        source: &TaskSourceConfiguration,
        external_id: &str,
    ) -> Option<(&'a IssueLink, &'a TaskRecord)> {
        let link = self.store.issue_links().iter().find(|link| {
            link.provider == IssueLinkProvider::Jira
                && link.external_id.as_deref() == Some(external_id)
                && link
                    .url
                    .as_deref()
                    .is_some_and(|url| same_jira_site(url, &source.site_base_url))
        })?;
        self.store
            .tasks()
            .iter()
            .find(|task| task.id == link.task_id)
            .map(|task| (link, task))
    }

    fn find_possible_legacy_task<'a>(
        &'a self,
        source: &TaskSourceConfiguration,
        candidate: &TaskSourceCandidateSnapshot,
    ) -> Option<&'a TaskRecord> {
        let task_id = self.store.issue_links().iter().find_map(|link| {
            (link.provider == IssueLinkProvider::Jira
                && link.source_id.is_none()
                && link.external_id.is_none()
                && link
                    .external_ref
                    .eq_ignore_ascii_case(&candidate.external_ref)
                && link
                    .url
                    .as_deref()
                    .is_some_and(|url| same_jira_site(url, &source.site_base_url))
                && same_jira_site(&candidate.url, &source.site_base_url))
            .then_some(link.task_id.as_str())
        })?;
        self.store.tasks().iter().find(|task| task.id == task_id)
    }
}

fn same_jira_site(issue_url: &str, site_base_url: &str) -> bool {
    let issue_authority = issue_url
        .strip_prefix("https://")
        .and_then(|rest| rest.split_once('/'))
        .filter(|(_, path)| path.starts_with("browse/"))
        .map(|(authority, _)| authority);
    let site_authority = site_base_url.strip_prefix("https://");
    issue_authority
        .zip(site_authority)
        .is_some_and(|(issue, site)| issue.eq_ignore_ascii_case(site))
}

fn source_scope(kind: &str, jql: Option<String>) -> Result<TaskSourceScope, CoreError> {
    match (kind, jql) {
        ("all", None) => Ok(TaskSourceScope::All),
        ("assignedToMe", None) => Ok(TaskSourceScope::AssignedToMe),
        ("jql", Some(jql)) if !jql.trim().is_empty() => Ok(TaskSourceScope::Jql {
            jql: jql.trim().to_owned(),
        }),
        _ => Err(CoreError::InvalidParams("scope".into())),
    }
}

fn source_import_policy(value: &str) -> Result<TaskSourceImportPolicy, CoreError> {
    match value {
        "review" => Ok(TaskSourceImportPolicy::Review),
        "autoAdd" => Ok(TaskSourceImportPolicy::AutoAdd),
        _ => Err(CoreError::InvalidParams("importPolicy".into())),
    }
}

fn source_boards(
    mut boards: Vec<TaskSourceBoardSelection>,
) -> Result<Vec<TaskSourceBoardSelection>, CoreError> {
    for board in &mut boards {
        board.name = board.name.trim().to_owned();
    }
    if boards.len() > termloop_domain::TASK_SOURCE_BOARDS_MAX
        || boards.iter().any(|board| !board.is_valid())
        || boards.iter().enumerate().any(|(index, board)| {
            boards[index + 1..]
                .iter()
                .any(|candidate| candidate.id == board.id)
        })
    {
        return Err(CoreError::InvalidParams("boards".into()));
    }
    Ok(boards)
}

fn source_statuses(
    mut statuses: Vec<TaskSourceStatusSelection>,
) -> Result<Vec<TaskSourceStatusSelection>, CoreError> {
    for status in &mut statuses {
        status.name = status.name.trim().to_owned();
    }
    if statuses.len() > termloop_domain::TASK_SOURCE_STATUSES_MAX
        || statuses.iter().any(|status| !status.is_valid())
        || statuses.iter().enumerate().any(|(index, status)| {
            statuses[index + 1..]
                .iter()
                .any(|candidate| candidate.id == status.id)
        })
    {
        return Err(CoreError::InvalidParams("statuses".into()));
    }
    Ok(statuses)
}

fn refresh_request(source: &TaskSourceConfiguration) -> JiraSearchRequest {
    let (jql, legacy_board) = match &source.scope {
        TaskSourceScope::All => (None, None),
        TaskSourceScope::AssignedToMe => (Some(ASSIGNED_TO_ME_JQL.to_owned()), None),
        TaskSourceScope::Jql { jql } => (Some(jql.clone()), None),
        TaskSourceScope::Board { board_id, .. } => (None, Some(board_id.clone())),
    };
    let mut board_ids = source
        .boards
        .iter()
        .map(|board| board.id.clone())
        .collect::<Vec<_>>();
    if let Some(board_id) = legacy_board {
        board_ids.push(board_id);
    }
    JiraSearchRequest {
        site_base_url: source.site_base_url.clone(),
        scope: if board_ids.is_empty() {
            JiraSearchScope::Jql(jql.unwrap_or_else(|| ALL_ISSUES_JQL.to_owned()))
        } else {
            JiraSearchScope::Boards {
                board_ids,
                jql,
                status_ids: source
                    .statuses
                    .iter()
                    .map(|status| status.id.clone())
                    .collect(),
            }
        },
    }
}

fn normalized_name(value: String) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.len() > termloop_domain::TASK_SOURCE_NAME_MAX_BYTES {
        return Err(CoreError::InvalidParams("name".into()));
    }
    Ok(value.to_owned())
}

fn next_updated_at(previous: u64, now: u64) -> Result<u64, CoreError> {
    previous
        .checked_add(1)
        .map(|minimum| now.max(minimum))
        .ok_or_else(|| CoreError::Store("Task Source timestamp overflow".into()))
}

fn refresh_is_active(entry: &TaskSourceRuntimeEntry, now_epoch_ms: u64) -> bool {
    entry.refreshing
        && entry.refresh_started_at_epoch_ms.is_some_and(|started_at| {
            now_epoch_ms.saturating_sub(started_at) < TASK_SOURCE_REFRESH_STALE_AFTER_MS
        })
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn imported_title(candidate: &TaskSourceCandidateSnapshot) -> String {
    truncate_utf8(candidate.title.trim(), TITLE_LIMIT)
}

fn imported_brief(candidate: &TaskSourceCandidateSnapshot) -> Option<String> {
    candidate
        .description
        .as_deref()
        .map(str::trim)
        .map(|value| truncate_utf8(value, BRIEF_LIMIT))
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use termloop_terminal::TerminalService;

    struct Fixture {
        runtime: CoreRuntime,
        root: std::path::PathBuf,
        project_id: String,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "termloop-core-task-source-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let project_root = root.join("project");
            std::fs::create_dir_all(&project_root).unwrap();
            let mut runtime =
                CoreRuntime::open(root.join("state.json"), TerminalService::default(), 1).unwrap();
            let project = runtime
                .create_project(json!({"name":"Project","folderPath":project_root}))
                .unwrap();
            Self {
                runtime,
                root,
                project_id: project["id"].as_str().unwrap().into(),
            }
        }

        fn create_source(&mut self) -> TaskSourceMutation {
            let revision = self.runtime.state_revision();
            self.runtime
                .create_task_source(
                    "source-1".into(),
                    &self.project_id,
                    "Assigned Jira work".into(),
                    "https://example.atlassian.net".into(),
                    "assignedToMe",
                    vec![],
                    vec![],
                    None,
                    "review",
                    5,
                    900,
                    revision,
                    10,
                )
                .unwrap()
        }

        fn refresh(&mut self, summary: &str, description: &str) -> TaskSourceRefreshApply {
            self.refresh_at(summary, description, "2026-08-26T10:00:00.000+0000")
        }

        fn refresh_at(
            &mut self,
            summary: &str,
            description: &str,
            updated_at: &str,
        ) -> TaskSourceRefreshApply {
            let plan = self
                .runtime
                .prepare_task_source_refresh("source-1", 1, 20)
                .unwrap();
            self.runtime
                .apply_task_source_refresh(
                    plan,
                    TaskSourceRefreshOutcome::Success(JiraSearchResult {
                        issues: vec![JiraIssueSnapshot {
                            external_id: "10042".into(),
                            key: "TERM-42".into(),
                            url: "https://example.atlassian.net/browse/TERM-42".into(),
                            summary: summary.into(),
                            description: Some(description.into()),
                            status_name: "Open".into(),
                            assignee_display: Some("Ada".into()),
                            updated_at: updated_at.into(),
                        }],
                        truncated: false,
                    }),
                    21,
                )
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn source_policy_persists_auto_add_without_task_automation() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let revision = fixture.runtime.state_revision();
        let mutation = fixture
            .runtime
            .update_task_source(
                "source-1",
                "Assigned Jira work".into(),
                true,
                "https://example.atlassian.net".into(),
                "assignedToMe",
                vec![],
                vec![],
                None,
                "autoAdd",
                5,
                900,
                1,
                revision,
                30,
            )
            .unwrap();
        assert_eq!(
            mutation.source.import_policy,
            TaskSourceImportPolicy::AutoAdd
        );
        let view = fixture.runtime.task_source_view_by_id("source-1").unwrap();
        let projected = task_source_view_json(&view, "present");
        assert_eq!(projected["importPolicy"], "autoAdd");
        assert_eq!(projected["autoImportActiveTaskLimit"], 5);
        assert!(projected.get("createWorktree").is_none());
        assert!(projected.get("agentId").is_none());
    }

    #[test]
    fn refresh_import_is_idempotent_and_remote_changes_do_not_overwrite_task() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let refresh = fixture.refresh("Initial summary", "Initial description");
        let candidate = fixture.runtime.task_source_candidates("source-1").unwrap()[0].clone();
        assert_eq!(candidate.state, "new");
        let revision = fixture.runtime.state_revision();
        let imported = fixture
            .runtime
            .import_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                revision,
                "task-imported".into(),
                30,
            )
            .unwrap();
        assert_eq!(imported.task["title"], "Initial summary");
        assert_eq!(imported.task["brief"], "Initial description");
        let repeated = fixture
            .runtime
            .import_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                revision,
                "task-duplicate".into(),
                31,
            )
            .unwrap();
        assert_eq!(repeated.task["id"], "task-imported");
        assert_eq!(fixture.runtime.store.tasks().len(), 1);
        assert_eq!(
            fixture.runtime.task_source_candidates("source-1").unwrap()[0].state,
            "added"
        );

        fixture
            .runtime
            .handle(
                "task.rename",
                json!({"taskId":"task-imported","title":"Local title"}),
            )
            .unwrap();
        assert_eq!(
            fixture.runtime.task_source_candidates("source-1").unwrap()[0].state,
            "added",
            "local Task edits are not remote Jira changes"
        );

        fixture.refresh_at(
            "Remote rename",
            "Changed remote description",
            "2026-08-26T11:00:00.000+0000",
        );
        let candidate = fixture.runtime.task_source_candidates("source-1").unwrap()[0].clone();
        assert_eq!(candidate.state, "changed");
        assert_eq!(
            fixture.runtime.store.tasks()[0].title,
            "Local title",
            "remote refresh must not overwrite local Task authority"
        );
    }

    #[test]
    fn active_source_task_count_releases_a_slot_when_the_task_closes() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let refresh = fixture.refresh("Initial summary", "Initial description");
        let revision = fixture.runtime.state_revision();
        fixture
            .runtime
            .import_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                revision,
                "task-imported".into(),
                30,
            )
            .unwrap();
        assert_eq!(
            fixture
                .runtime
                .active_task_source_task_count("source-1")
                .unwrap(),
            1
        );
        fixture
            .runtime
            .handle("task.close", json!({"taskId":"task-imported"}))
            .unwrap();
        assert_eq!(
            fixture
                .runtime
                .active_task_source_task_count("source-1")
                .unwrap(),
            0
        );
    }

    #[test]
    fn imported_snapshot_is_trimmed_bounded_and_not_immediately_marked_changed() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let summary = format!("  {}  ", "s".repeat(TITLE_LIMIT + 20));
        let description = format!("  {}  ", "d".repeat(BRIEF_LIMIT + 20));
        let refresh = fixture.refresh(&summary, &description);
        let revision = fixture.runtime.state_revision();
        let imported = fixture
            .runtime
            .import_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                revision,
                "task-imported".into(),
                30,
            )
            .unwrap();
        assert_eq!(imported.task["title"].as_str().unwrap().len(), TITLE_LIMIT);
        assert_eq!(imported.task["brief"].as_str().unwrap().len(), BRIEF_LIMIT);
        assert_eq!(
            fixture.runtime.task_source_candidates("source-1").unwrap()[0].state,
            "added"
        );
    }

    #[test]
    fn legacy_jira_link_is_a_visible_non_importable_possible_duplicate() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let task = fixture
            .runtime
            .handle(
                "task.create",
                json!({
                    "projectId": fixture.project_id,
                    "title": "Legacy Jira Task",
                    "brief": null,
                    "worktreeIntent": "none"
                }),
            )
            .unwrap();
        let task_id = task["id"].as_str().unwrap().to_owned();
        fixture
            .runtime
            .store
            .insert_task_jira_issue_link(
                &fixture.runtime.write_authority,
                IssueLink {
                    task_id: task_id.clone(),
                    provider: IssueLinkProvider::Jira,
                    external_ref: "term-42".into(),
                    source_id: None,
                    external_id: None,
                    external_updated_at: None,
                    url: Some("https://EXAMPLE.atlassian.net/browse/term-42".into()),
                    sync_authority: IssueLinkSyncAuthority::None,
                },
            )
            .unwrap();
        let refresh = fixture.refresh("Candidate", "Description");
        let candidate = &fixture.runtime.task_source_candidates("source-1").unwrap()[0];
        assert_eq!(candidate.state, "possibleDuplicate");
        assert_eq!(candidate.task_id.as_deref(), Some(task_id.as_str()));

        assert!(matches!(
            fixture.runtime.ignore_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                fixture.runtime.state_revision(),
                true,
                30,
            ),
            Err(CoreError::InvalidParams(field)) if field == "externalId"
        ));
        assert!(matches!(
            fixture.runtime.import_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                fixture.runtime.state_revision(),
                "must-not-be-created".into(),
                30,
            ),
            Err(CoreError::InvalidParams(field)) if field == "externalId"
        ));
        assert_eq!(fixture.runtime.store.tasks().len(), 1);
    }

    #[test]
    fn project_delete_reservation_fences_task_source_operations() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let plan = fixture
            .runtime
            .begin_project_delete(json!({"projectId": fixture.project_id}))
            .unwrap();
        assert!(matches!(
            fixture.runtime.task_source_view_by_id("source-1"),
            Err(CoreError::NotFound)
        ));
        assert!(fixture.runtime.due_task_source_refreshes(1_000).is_empty());
        let revision = fixture.runtime.state_revision();
        assert!(matches!(
            fixture.runtime.update_task_source(
                "source-1",
                "Renamed".into(),
                true,
                "https://example.atlassian.net".into(),
                "assignedToMe",
                vec![],
                vec![],
                None,
                "review",
                5,
                900,
                1,
                revision,
                30,
            ),
            Err(CoreError::NotFound)
        ));
        fixture.runtime.cancel_project_delete(&plan);
        assert!(fixture.runtime.task_source_view_by_id("source-1").is_ok());
    }

    #[test]
    fn project_delete_drops_task_source_runtime_projection() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        fixture.refresh("Candidate", "Description");
        assert!(
            fixture
                .runtime
                .task_source_runtime
                .entries
                .contains_key("source-1")
        );

        let plan = fixture
            .runtime
            .begin_project_delete(json!({"projectId": fixture.project_id}))
            .unwrap();
        fixture.runtime.complete_project_delete(plan).unwrap();

        assert!(
            !fixture
                .runtime
                .task_source_runtime
                .entries
                .contains_key("source-1")
        );
    }

    #[test]
    fn credential_change_advances_the_source_observation_without_durable_write() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let revision = fixture.runtime.state_revision();
        let before = fixture.runtime.observation_sequence();

        let sequence = fixture
            .runtime
            .record_task_source_credentials_set("source-1", 1)
            .unwrap();

        assert!(sequence > before);
        assert_eq!(fixture.runtime.state_revision(), revision);
        assert_eq!(
            fixture
                .runtime
                .task_source_view_by_id("source-1")
                .unwrap()
                .observation_sequence,
            sequence
        );
    }

    #[test]
    fn boards_and_assignee_scope_are_durable_and_combined_in_the_refresh_request() {
        let mut fixture = Fixture::new();
        let revision = fixture.runtime.state_revision();
        let mutation = fixture
            .runtime
            .create_task_source(
                "source-board".into(),
                &fixture.project_id,
                "Payments board".into(),
                "https://example.atlassian.net".into(),
                "assignedToMe",
                vec![
                    TaskSourceBoardSelection {
                        id: "84".into(),
                        name: "Payments".into(),
                    },
                    TaskSourceBoardSelection {
                        id: "17".into(),
                        name: "Platform".into(),
                    },
                ],
                vec![TaskSourceStatusSelection {
                    id: "10000".into(),
                    name: "In Progress".into(),
                }],
                None,
                "review",
                5,
                900,
                revision,
                10,
            )
            .unwrap();
        assert_eq!(mutation.source.scope, TaskSourceScope::AssignedToMe);
        assert_eq!(mutation.source.boards.len(), 2);

        let plan = fixture
            .runtime
            .prepare_task_source_refresh("source-board", 1, 20)
            .unwrap();
        assert_eq!(
            plan.request.scope,
            JiraSearchScope::Boards {
                board_ids: vec!["84".into(), "17".into()],
                jql: Some(ASSIGNED_TO_ME_JQL.into()),
                status_ids: vec!["10000".into()],
            }
        );
    }

    #[test]
    fn changing_board_filters_retires_candidates_until_the_new_scope_is_observed() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        fixture.refresh("Old candidate", "Old scope");
        assert_eq!(
            fixture
                .runtime
                .task_source_candidates("source-1")
                .unwrap()
                .len(),
            1
        );
        let revision = fixture.runtime.state_revision();
        let mutation = fixture
            .runtime
            .update_task_source(
                "source-1",
                "Assigned Jira work".into(),
                true,
                "https://example.atlassian.net".into(),
                "assignedToMe",
                vec![TaskSourceBoardSelection {
                    id: "84".into(),
                    name: "Payments".into(),
                }],
                vec![],
                None,
                "review",
                5,
                900,
                1,
                revision,
                30,
            )
            .unwrap();

        assert!(
            fixture
                .runtime
                .task_source_candidates("source-1")
                .unwrap()
                .is_empty()
        );
        let view = fixture.runtime.task_source_view_by_id("source-1").unwrap();
        assert_eq!(view.candidate_count, 0);
        assert_eq!(view.last_successful_at_epoch_ms, None);
        let plan = fixture
            .runtime
            .prepare_task_source_refresh("source-1", mutation.source.generation, 40)
            .unwrap();
        assert_eq!(
            plan.request.scope,
            JiraSearchScope::Boards {
                board_ids: vec!["84".into()],
                jql: Some(ASSIGNED_TO_ME_JQL.into()),
                status_ids: vec![],
            }
        );
    }

    #[test]
    fn stale_refresh_is_discarded_after_configuration_generation_changes() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        fixture.refresh("Existing", "Candidate");
        let plan = fixture
            .runtime
            .prepare_task_source_refresh("source-1", 1, 30)
            .unwrap();
        let revision = fixture.runtime.state_revision();
        fixture
            .runtime
            .update_task_source(
                "source-1",
                "Renamed".into(),
                true,
                "https://example.atlassian.net".into(),
                "assignedToMe",
                vec![],
                vec![],
                None,
                "review",
                5,
                900,
                1,
                revision,
                30,
            )
            .unwrap();
        assert!(matches!(
            fixture.runtime.apply_task_source_refresh(
                plan,
                TaskSourceRefreshOutcome::Success(JiraSearchResult {
                    issues: vec![],
                    truncated: false,
                }),
                32,
            ),
            Err(CoreError::RevisionConflict)
        ));
        assert_eq!(
            fixture
                .runtime
                .task_source_candidates("source-1")
                .unwrap()
                .len(),
            1,
            "a stale observation must not erase the last good candidate snapshot"
        );
    }

    #[test]
    fn a_stuck_refresh_is_reclaimed_after_the_bounded_timeout() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        fixture
            .runtime
            .prepare_task_source_refresh("source-1", 1, 20)
            .unwrap();
        assert!(matches!(
            fixture
                .runtime
                .prepare_task_source_refresh("source-1", 1, 21),
            Err(CoreError::InvalidParams(field)) if field == "refreshInProgress"
        ));
        assert!(
            fixture
                .runtime
                .due_task_source_refreshes(20 + TASK_SOURCE_REFRESH_STALE_AFTER_MS - 1)
                .is_empty()
        );
        assert_eq!(
            fixture
                .runtime
                .due_task_source_refreshes(20 + TASK_SOURCE_REFRESH_STALE_AFTER_MS),
            [("source-1".into(), 1)]
        );
        assert!(
            fixture
                .runtime
                .prepare_task_source_refresh("source-1", 1, 20 + TASK_SOURCE_REFRESH_STALE_AFTER_MS)
                .is_ok()
        );
    }

    #[test]
    fn ignore_is_durable_and_requires_current_candidate_snapshot() {
        let mut fixture = Fixture::new();
        fixture.create_source();
        let refresh = fixture.refresh("Candidate", "Description");
        let revision = fixture.runtime.state_revision();
        let (ignored, generation, _) = fixture
            .runtime
            .ignore_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                revision,
                true,
                30,
            )
            .unwrap();
        assert_eq!(ignored.state, "ignored");
        assert_eq!(generation, 1);
        assert_eq!(
            fixture.runtime.store.task_source_configurations()[0].ignored_external_ids,
            ["10042"]
        );
        assert!(matches!(
            fixture.runtime.ignore_task_source_candidate(
                "source-1",
                "10042",
                1,
                refresh.observation_sequence,
                fixture.runtime.state_revision(),
                false,
                31,
            ),
            Err(CoreError::RevisionConflict)
        ));
    }
}
