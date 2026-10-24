//! TermLoop's own reads of a Project Manager Task's delivery facts: its Jira
//! status and assignee, and the pull requests in the Project's repository
//! whose head branch or title names its Jira key.
//!
//! The read follows the plan/observe/apply boundary. Core plans under its
//! lock; the server reads the Jira credential and runs the Jira and Git-host
//! work without it; the outcome is revalidated against the current Tasks
//! before it replaces their facts. A failed read keeps the last good facts and
//! records why the newest read failed.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::GitHostProjectionReason;
use super::repository_pull_requests::{ProjectRepository, observe_repository};
use crate::{CoreError, CoreRuntime, TaskSourceFailure, TaskSourceRefreshPlan, store_error};
use termloop_domain::{
    FactSource, IssueLinkProvider, PullRequestFact, PullRequestFactChecks, PullRequestFactState,
    TaskDeliveryFacts,
};
use termloop_providers::{
    AzureDevOpsClient, CheckState, GitHubClient, IssueKeyPullRequests, JiraSearchRequest,
    JiraSearchResult, JiraSearchScope, ProviderFailure, PullRequestState, PullRequestSummary,
    valid_issue_key,
};

/// Jira answers at most this many keys per read.
const JIRA_KEYS_PER_READ: usize = 50;
/// One pass reads the pull requests of at most this many Tasks.
const PULL_REQUEST_TASKS_PER_READ: usize = 25;
const READ_DEADLINE: Duration = Duration::from_secs(60);

/// One planned read of a Project's tracked Tasks.
pub struct DeliveryFactsReadPlan {
    pub project_id: String,
    project_folder: PathBuf,
    /// Tracked Tasks with a Jira key, as `(task_id, key)`.
    tasks: Vec<(String, String)>,
    /// The Jira read, when the Project has an enabled Jira Task Source.
    pub jira: Option<TaskSourceRefreshPlan>,
    github: Option<GitHubClient>,
    azure: Option<AzureDevOpsClient>,
}

/// Each tracked Task's pull requests naming its Jira key, as
/// `(task_id, read)`.
type TaskPullRequestReads = Vec<(String, Result<IssueKeyPullRequests, ProviderFailure>)>;

/// The Git-host half of one read: the repository label and its per-Task
/// reads, or why the repository could not be read.
pub struct PullRequestFactsRead {
    result: Result<(String, TaskPullRequestReads), GitHostProjectionReason>,
}

impl CoreRuntime {
    /// Project Manager Projects with at least one tracked Task, the scope of
    /// the periodic fact read.
    pub fn delivery_facts_projects(&self) -> Vec<String> {
        let mut projects = self
            .store
            .projects()
            .iter()
            .filter(|project| {
                self.is_project_manager_project(&project.id)
                    && !self.project_manager_tracked_tasks(&project.id).is_empty()
            })
            .map(|project| project.id.clone())
            .collect::<Vec<_>>();
        projects.sort();
        projects
    }

    /// Plans one read of a Project's tracked Tasks that have a Jira key.
    /// `None` when the Project is not a Project Manager Project or no tracked
    /// Task has a key.
    pub fn plan_delivery_facts_read(&self, project_id: &str) -> Option<DeliveryFactsReadPlan> {
        if !self.is_project_manager_project(project_id) {
            return None;
        }
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)?;
        let tasks = self
            .project_manager_tracked_tasks(project_id)
            .into_iter()
            .filter_map(|task| Some((task.id.clone(), self.task_jira_key(&task.id)?)))
            .collect::<Vec<_>>();
        if tasks.is_empty() {
            return None;
        }
        let jira = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.project_id == project_id && source.enabled)
            .map(|source| TaskSourceRefreshPlan {
                source_id: source.id.clone(),
                generation: source.generation,
                request: JiraSearchRequest {
                    site_base_url: source.site_base_url.clone(),
                    scope: JiraSearchScope::Jql(jira_keys_jql(
                        tasks
                            .iter()
                            .take(JIRA_KEYS_PER_READ)
                            .map(|(_, key)| key.as_str()),
                    )),
                },
            });
        Some(DeliveryFactsReadPlan {
            project_id: project_id.to_owned(),
            project_folder: PathBuf::from(&project.folder_path),
            tasks,
            jira,
            github: self.github_client.clone(),
            azure: self.azure_devops_client.clone(),
        })
    }

    /// The Jira key of a Task's Jira link, when it has a valid one.
    pub(crate) fn task_jira_key(&self, task_id: &str) -> Option<String> {
        self.store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task_id && link.provider == IssueLinkProvider::Jira)
            .map(|link| link.external_ref.to_ascii_uppercase())
            .filter(|key| valid_issue_key(key))
    }

    /// Replaces the read Tasks' Jira and pull request facts. A Task that left
    /// the Project, closed, or changed its Jira key while the read ran is left
    /// alone. Returns whether anything changed.
    pub fn apply_delivery_facts_read(
        &mut self,
        plan: DeliveryFactsReadPlan,
        jira: Option<Result<JiraSearchResult, TaskSourceFailure>>,
        pull_requests: PullRequestFactsRead,
        now_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        if !self.is_project_manager_project(&plan.project_id) {
            return Ok(false);
        }
        let tracked = self
            .project_manager_tracked_tasks(&plan.project_id)
            .into_iter()
            .map(|task| task.id)
            .collect::<Vec<_>>();
        let mut records = Vec::new();
        for (task_id, key) in &plan.tasks {
            if !tracked.contains(task_id) || self.task_jira_key(task_id).as_ref() != Some(key) {
                continue;
            }
            let mut facts = self
                .store
                .task_delivery_facts_for(task_id)
                .cloned()
                .unwrap_or_else(|| TaskDeliveryFacts {
                    task_id: task_id.clone(),
                    ..TaskDeliveryFacts::default()
                });
            match &jira {
                Some(Ok(result)) => {
                    if let Some(issue) = result
                        .issues
                        .iter()
                        .find(|issue| issue.key.eq_ignore_ascii_case(key))
                    {
                        facts.observe_jira(
                            bounded(&issue.status_name),
                            issue.assignee_display.as_deref().map(bounded),
                            now_epoch_ms,
                        );
                    } else if plan
                        .tasks
                        .iter()
                        .take(JIRA_KEYS_PER_READ)
                        .any(|(id, _)| id == task_id)
                    {
                        facts.fail_read(FactSource::Jira, "issueNotFound".into(), now_epoch_ms);
                    }
                }
                Some(Err(failure)) => facts.fail_read(
                    FactSource::Jira,
                    crate::task_source_failure_wire(*failure).to_owned(),
                    now_epoch_ms,
                ),
                None => {}
            }
            match &pull_requests.result {
                Ok((repository, reads)) => match reads.iter().find(|(id, _)| id == task_id) {
                    Some((_, Ok(read))) => facts.observe_pull_requests(
                        repository.clone(),
                        read.pull_requests.iter().map(pull_request_fact).collect(),
                        read.truncated,
                        now_epoch_ms,
                    ),
                    Some((_, Err(failure))) => facts.fail_read(
                        FactSource::GitHost,
                        provider_failure_reason(*failure).into(),
                        now_epoch_ms,
                    ),
                    None => {}
                },
                Err(reason) => facts.fail_read(
                    FactSource::GitHost,
                    projection_reason(*reason),
                    now_epoch_ms,
                ),
            }
            records.push(facts);
        }
        if records.is_empty() {
            return Ok(false);
        }
        let before = self.store.revision();
        self.store
            .set_task_delivery_facts(&self.write_authority, records)
            .map_err(store_error)?;
        Ok(self.store.revision() != before)
    }
}

impl DeliveryFactsReadPlan {
    /// Reads the pull requests that name each Task's Jira key. Blocking; call
    /// without the core lock.
    pub fn observe_pull_requests(&self) -> PullRequestFactsRead {
        PullRequestFactsRead {
            result: self.read_pull_requests(),
        }
    }

    #[allow(clippy::type_complexity)]
    fn read_pull_requests(
        &self,
    ) -> Result<
        (
            String,
            Vec<(String, Result<IssueKeyPullRequests, ProviderFailure>)>,
        ),
        GitHostProjectionReason,
    > {
        let deadline = termloop_platform::MonotonicDeadline::after(READ_DEADLINE)
            .map_err(|_| GitHostProjectionReason::Timeout)?;
        let repository = observe_repository(&self.project_folder)?;
        let label = repository_label(&repository);
        let mut reads = Vec::new();
        for (task_id, key) in self.tasks.iter().take(PULL_REQUEST_TASKS_PER_READ) {
            let Some(remaining) = deadline.remaining() else {
                reads.push((task_id.clone(), Err(ProviderFailure::Timeout)));
                continue;
            };
            reads.push((
                task_id.clone(),
                read_issue_key_pull_requests(
                    &repository,
                    key,
                    self.github.as_ref(),
                    self.azure.as_ref(),
                    false,
                    remaining,
                ),
            ));
        }
        Ok((label, reads))
    }
}

/// The pull requests in one repository that name a Jira key. Blocking.
pub(super) fn read_issue_key_pull_requests(
    repository: &ProjectRepository,
    key: &str,
    github: Option<&GitHubClient>,
    azure: Option<&AzureDevOpsClient>,
    include_checks: bool,
    timeout: Duration,
) -> Result<IssueKeyPullRequests, ProviderFailure> {
    match repository {
        ProjectRepository::Github(repository) => github
            .ok_or(ProviderFailure::ProviderUnavailable)?
            .issue_key_pull_requests(repository, key, timeout),
        ProjectRepository::Azure(repository) => azure
            .ok_or(ProviderFailure::ProviderUnavailable)?
            .issue_key_pull_requests(repository, key, include_checks, timeout),
    }
}

/// Discovers the Project checkout's repository. Blocking.
pub(super) fn project_repository(
    project_folder: &Path,
) -> Result<ProjectRepository, GitHostProjectionReason> {
    observe_repository(project_folder)
}

pub(super) fn repository_label(repository: &ProjectRepository) -> String {
    match repository {
        ProjectRepository::Github(repository) => {
            format!("github.com/{}/{}", repository.owner, repository.name)
        }
        ProjectRepository::Azure(repository) => format!(
            "dev.azure.com/{}/{}/{}",
            repository.organization, repository.project, repository.name
        ),
    }
}

fn jira_keys_jql<'a>(keys: impl Iterator<Item = &'a str>) -> String {
    format!("key in ({})", keys.collect::<Vec<_>>().join(", "))
}

fn bounded(value: &str) -> String {
    let value = value.trim();
    value
        .chars()
        .take(termloop_domain::TASK_TRACKING_SHORT_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn pull_request_fact(summary: &PullRequestSummary) -> PullRequestFact {
    let text = |value: &str| value.chars().take(300).collect::<String>();
    PullRequestFact {
        number: summary.number,
        title: text(&summary.title),
        url: text(&summary.url),
        state: match summary.state {
            PullRequestState::Open => PullRequestFactState::Open,
            PullRequestState::Draft => PullRequestFactState::Draft,
            PullRequestState::Merged => PullRequestFactState::Merged,
            PullRequestState::Closed => PullRequestFactState::Closed,
        },
        checks: match summary.checks {
            CheckState::Passing => PullRequestFactChecks::Passing,
            CheckState::Failing => PullRequestFactChecks::Failing,
            CheckState::Pending => PullRequestFactChecks::Pending,
            CheckState::NotReported | CheckState::Unsupported | CheckState::Unknown => {
                PullRequestFactChecks::Unknown
            }
        },
        base_branch: text(&summary.base_branch),
        head_branch: text(&summary.head_branch),
        merge_commit: summary.merge_commit_oid.clone().filter(|oid| {
            (7..=64).contains(&oid.len()) && oid.chars().all(|c| c.is_ascii_hexdigit())
        }),
        updated_at_epoch_ms: summary.updated_at_epoch_ms,
    }
}

pub(super) fn provider_failure_reason(failure: ProviderFailure) -> &'static str {
    match failure {
        ProviderFailure::ProviderUnavailable => "providerUnavailable",
        ProviderFailure::Unauthorized => "unauthorized",
        ProviderFailure::Offline => "offline",
        ProviderFailure::RateLimited => "rateLimited",
        ProviderFailure::Timeout => "timeout",
        ProviderFailure::OutputLimit => "outputLimit",
        ProviderFailure::MalformedResponse => "malformedResponse",
        ProviderFailure::ProviderFailure => "providerFailure",
    }
}

fn projection_reason(reason: GitHostProjectionReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "providerFailure".into())
}

#[cfg(test)]
mod tests;
