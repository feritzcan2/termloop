//! Repository-wide open pull requests for one Project checkout.
//!
//! The Project folder's remote configuration selects one provider repository
//! (`origin` first); the provider lists its open pull requests. Nothing is
//! cached or persisted: the result is a display-only read. The repository
//! identity alone is also available without contacting the provider.

use super::{
    GitHostProjectionReason, cache_failure, checks_name, map_cache_failure, map_git_error,
    review_name, state_name,
};
use crate::{CoreError, CoreRuntime};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use termloop_gitio::{GitRunner, RemoteFact};
pub use termloop_providers::RepositoryPullRequestFilter;
use termloop_providers::{
    AzureDevOpsClient, AzureRepository, GitHostProvider, GitHubClient, Mergeability,
    ProviderFailure, RemoteIdentityError, RepositoryPullRequest, RepositoryPullRequestList,
    parse_azure_remote, parse_github_remote,
};

const REMOTE_DEADLINE: Duration = Duration::from_millis(2_500);
const PROVIDER_DEADLINE: Duration = Duration::from_secs(8);

pub struct RepositoryPullRequestListPlan {
    project_folder: PathBuf,
    filter: RepositoryPullRequestFilter,
    github: Option<GitHubClient>,
    azure: Option<AzureDevOpsClient>,
}

pub struct ProjectRepositoryPlan {
    project_folder: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ProjectRepository {
    Github(termloop_providers::GitHubRepository),
    Azure(AzureRepository),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct RepositoryIdentity {
    repository_provider: Option<GitHostProvider>,
    repository_owner: Option<String>,
    repository_project: Option<String>,
    repository_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct ProjectRepositoryResult {
    #[serde(flatten)]
    identity: RepositoryIdentity,
    reason: Option<GitHostProjectionReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct RepositoryPullRequestListResult {
    #[serde(flatten)]
    identity: RepositoryIdentity,
    reason: Option<GitHostProjectionReason>,
    pull_requests: Vec<RepositoryPullRequestDto>,
    truncated: bool,
    observed_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct RepositoryPullRequestDto {
    number: u64,
    title: String,
    url: String,
    state: &'static str,
    base_branch: String,
    head_branch: String,
    author: Option<String>,
    check_rollup: &'static str,
    review_signal: &'static str,
    merge_conflict: &'static str,
    created_at_epoch_ms: Option<u64>,
    updated_at_epoch_ms: u64,
}

impl CoreRuntime {
    pub fn plan_repository_pull_request_list(
        &self,
        project_id: &str,
        filter: RepositoryPullRequestFilter,
    ) -> Result<RepositoryPullRequestListPlan, CoreError> {
        Ok(RepositoryPullRequestListPlan {
            project_folder: self.project_folder(project_id)?,
            filter,
            github: self.github_client.clone(),
            azure: self.azure_devops_client.clone(),
        })
    }

    pub fn plan_project_repository(
        &self,
        project_id: &str,
    ) -> Result<ProjectRepositoryPlan, CoreError> {
        Ok(ProjectRepositoryPlan {
            project_folder: self.project_folder(project_id)?,
        })
    }

    fn project_folder(&self, project_id: &str) -> Result<PathBuf, CoreError> {
        self.store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| PathBuf::from(&project.folder_path))
            .ok_or(CoreError::NotFound)
    }
}

impl ProjectRepositoryPlan {
    /// Blocking: reads local Git configuration. Never call under the core lock.
    pub fn observe(self) -> Value {
        let repository = observe_repository(&self.project_folder);
        let reason = repository.as_ref().err().copied();
        serde_json::to_value(ProjectRepositoryResult {
            identity: identity(repository.ok()),
            reason,
        })
        .expect("project repository serializes")
    }
}

pub(super) fn observe_repository(
    project_folder: &Path,
) -> Result<ProjectRepository, GitHostProjectionReason> {
    GitRunner::discover_with_timeout(REMOTE_DEADLINE)
        .and_then(|runner| runner.observe_remotes_with_timeout(project_folder, REMOTE_DEADLINE))
        .map_err(|error| map_git_error(&error))
        .and_then(|remotes| select_repository(&remotes))
}

impl RepositoryPullRequestListPlan {
    /// Blocking: runs Git and the provider CLI. Never call under the core lock.
    pub fn observe(self) -> Value {
        let repository = observe_repository(&self.project_folder);
        let listed = repository.clone().and_then(|repository| {
            self.list(&repository)
                .map_err(|failure| map_cache_failure(cache_failure(failure)))
        });
        serde_json::to_value(build_result(
            repository.ok(),
            listed,
            termloop_platform::current_epoch_ms(),
        ))
        .expect("repository pull request list serializes")
    }

    fn list(
        &self,
        repository: &ProjectRepository,
    ) -> Result<RepositoryPullRequestList, ProviderFailure> {
        match repository {
            ProjectRepository::Github(repository) => self
                .github
                .as_ref()
                .ok_or(ProviderFailure::ProviderUnavailable)?
                .list_repository_pull_requests(repository, self.filter, PROVIDER_DEADLINE),
            ProjectRepository::Azure(repository) => self
                .azure
                .as_ref()
                .ok_or(ProviderFailure::ProviderUnavailable)?
                .list_repository_pull_requests(repository, self.filter, PROVIDER_DEADLINE),
        }
    }
}

/// Picks the first supported repository, trying `origin` before the other
/// remotes in name order.
fn select_repository(remotes: &[RemoteFact]) -> Result<ProjectRepository, GitHostProjectionReason> {
    if remotes.is_empty() {
        return Err(GitHostProjectionReason::NoRemote);
    }
    let mut ordered = remotes.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|remote| remote.name != b"origin");
    let mut saw_malformed = false;
    for url in ordered.iter().flat_map(|remote| &remote.fetch_urls) {
        let github = parse_github_remote(url);
        let azure = parse_azure_remote(url);
        match (github, azure) {
            (Ok(repository), _) => return Ok(ProjectRepository::Github(repository)),
            (_, Ok(repository)) => return Ok(ProjectRepository::Azure(repository)),
            (Err(github), Err(azure)) => {
                saw_malformed |= !unsupported(github) || !unsupported(azure);
            }
        }
    }
    Err(if saw_malformed {
        GitHostProjectionReason::MalformedRemote
    } else {
        GitHostProjectionReason::UnsupportedHost
    })
}

fn unsupported(error: RemoteIdentityError) -> bool {
    matches!(
        error,
        RemoteIdentityError::UnsupportedHost | RemoteIdentityError::UnsupportedTransport
    )
}

fn build_result(
    repository: Option<ProjectRepository>,
    listed: Result<RepositoryPullRequestList, GitHostProjectionReason>,
    observed_at_epoch_ms: u64,
) -> RepositoryPullRequestListResult {
    let (pull_requests, truncated, reason) = match listed {
        Ok(list) => (
            list.pull_requests.into_iter().map(dto).collect(),
            list.truncated,
            None,
        ),
        Err(reason) => (Vec::new(), false, Some(reason)),
    };
    RepositoryPullRequestListResult {
        identity: identity(repository),
        reason,
        pull_requests,
        truncated,
        observed_at_epoch_ms,
    }
}

fn identity(repository: Option<ProjectRepository>) -> RepositoryIdentity {
    let (repository_provider, repository_owner, repository_project, repository_name) =
        match repository {
            Some(ProjectRepository::Github(repository)) => (
                Some(GitHostProvider::Github),
                Some(repository.owner),
                None,
                Some(repository.name),
            ),
            Some(ProjectRepository::Azure(repository)) => (
                Some(GitHostProvider::AzureDevOps),
                Some(repository.organization),
                Some(repository.project),
                Some(repository.name),
            ),
            None => (None, None, None, None),
        };
    RepositoryIdentity {
        repository_provider,
        repository_owner,
        repository_project,
        repository_name,
    }
}

fn dto(pull_request: RepositoryPullRequest) -> RepositoryPullRequestDto {
    let summary = pull_request.summary;
    RepositoryPullRequestDto {
        number: summary.number,
        title: summary.title,
        url: summary.url,
        state: state_name(summary.state),
        base_branch: summary.base_branch,
        head_branch: summary.head_branch,
        author: pull_request.author,
        check_rollup: checks_name(summary.checks),
        review_signal: review_name(summary.review),
        merge_conflict: match summary.mergeability {
            Mergeability::Mergeable => "noneDetected",
            Mergeability::Conflicting => "conflicting",
            Mergeability::Blocked => "policyBlocked",
            Mergeability::Unknown => "unknown",
        },
        created_at_epoch_ms: pull_request.created_at_epoch_ms,
        updated_at_epoch_ms: summary.updated_at_epoch_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_providers::{CheckState, PullRequestState, PullRequestSummary, ReviewState};

    fn remote(name: &str, url: &str) -> RemoteFact {
        RemoteFact {
            name: name.as_bytes().to_vec(),
            fetch_urls: vec![url.as_bytes().to_vec()],
            push_urls: vec![],
        }
    }

    #[test]
    fn origin_is_preferred_over_other_supported_remotes() {
        let selected = select_repository(&[
            remote("fork", "https://github.com/ferit/widget.git"),
            remote(
                "origin",
                "git@ssh.dev.azure.com:v3/ValueSpaces/Nucleus/Nucleus",
            ),
        ])
        .unwrap();
        let ProjectRepository::Azure(repository) = selected else {
            panic!("origin should win");
        };
        assert_eq!(repository.project, "Nucleus");
    }

    #[test]
    fn missing_unsupported_and_malformed_remotes_are_typed_reasons() {
        assert_eq!(
            select_repository(&[]),
            Err(GitHostProjectionReason::NoRemote)
        );
        assert_eq!(
            select_repository(&[remote("origin", "https://gitlab.com/acme/widget.git")]),
            Err(GitHostProjectionReason::UnsupportedHost)
        );
        assert_eq!(
            select_repository(&[remote("origin", "https://token@github.com/acme/widget.git")]),
            Err(GitHostProjectionReason::MalformedRemote)
        );
    }

    #[test]
    fn provider_failure_keeps_the_repository_identity_and_no_pull_requests() {
        let repository = ProjectRepository::Github(termloop_providers::GitHubRepository {
            owner: "acme".into(),
            name: "widget".into(),
        });
        let value = serde_json::to_value(build_result(
            Some(repository),
            Err(GitHostProjectionReason::Unauthorized),
            7,
        ))
        .unwrap();
        assert_eq!(value["repository_provider"], "github");
        assert_eq!(value["repository_owner"], "acme");
        assert_eq!(value["repository_project"], Value::Null);
        assert_eq!(value["reason"], "unauthorized");
        assert_eq!(value["pull_requests"], serde_json::json!([]));
        assert_eq!(value["observed_at_epoch_ms"], 7);
    }

    #[test]
    fn project_repository_reports_identity_or_reason_without_pull_requests() {
        let repository = select_repository(&[remote(
            "origin",
            "git@ssh.dev.azure.com:v3/ValueSpaces/Nucleus/Nucleus",
        )]);
        let value = serde_json::to_value(ProjectRepositoryResult {
            identity: identity(repository.ok()),
            reason: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "repository_provider": "azureDevOps",
                "repository_owner": "valuespaces",
                "repository_project": "Nucleus",
                "repository_name": "Nucleus",
                "reason": null,
            })
        );
        let missing = serde_json::to_value(ProjectRepositoryResult {
            identity: identity(None),
            reason: Some(GitHostProjectionReason::NoRemote),
        })
        .unwrap();
        assert_eq!(missing["repository_provider"], Value::Null);
        assert_eq!(missing["reason"], "noRemote");
    }

    #[test]
    fn listed_pull_requests_map_to_display_signals() {
        let summary = PullRequestSummary {
            provider: GitHostProvider::AzureDevOps,
            host: "dev.azure.com".into(),
            repository_owner: "valuespaces".into(),
            repository_project: Some("Nucleus".into()),
            repository_name: "Nucleus".into(),
            number: 15141,
            title: "Fix".into(),
            url: "https://dev.azure.com/valuespaces/Nucleus/_git/Nucleus/pullrequest/15141".into(),
            state: PullRequestState::Draft,
            merge_commit_oid: None,
            base_branch: "development".into(),
            head_branch: "feature/fix".into(),
            head_repository_owner: "valuespaces".into(),
            head_repository_project: Some("Nucleus".into()),
            head_repository_name: "Nucleus".into(),
            checks: CheckState::Unsupported,
            review: ReviewState::ReviewRequired,
            mergeability: Mergeability::Blocked,
            updated_at_epoch_ms: 9,
        };
        let value = serde_json::to_value(build_result(
            None,
            Ok(RepositoryPullRequestList {
                pull_requests: vec![RepositoryPullRequest {
                    summary,
                    author: Some("Özcan, Ferit".into()),
                    created_at_epoch_ms: Some(3),
                }],
                truncated: true,
            }),
            10,
        ))
        .unwrap();
        let pull_request = &value["pull_requests"][0];
        assert_eq!(pull_request["state"], "draft");
        assert_eq!(pull_request["check_rollup"], "unsupported");
        assert_eq!(pull_request["review_signal"], "reviewRequired");
        assert_eq!(pull_request["merge_conflict"], "policyBlocked");
        assert_eq!(pull_request["author"], "Özcan, Ferit");
        assert_eq!(value["truncated"], true);
        assert_eq!(value["reason"], Value::Null);
    }
}
