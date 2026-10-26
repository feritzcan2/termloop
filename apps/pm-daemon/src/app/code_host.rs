//! A project's code host, found from its folder's git remotes rather than
//! typed by hand: the `origin` remote first, then the others, each read as a
//! GitHub or an Azure DevOps repository.

use std::path::{Path, PathBuf};
use std::time::Duration;

use termloop_gitio::{GitError, GitRunner};
use termloop_pm::{GitHubSource, PmError, PmStore, ProjectSources};
use termloop_providers::{
    AzureDevOpsClient, AzureRepository, GitHubClient, GitHubRepository, IssueKeyPullRequests,
    ProviderFailure, parse_azure_remote, parse_github_remote,
};

use crate::app::AppState;

/// How long one read of a folder's remote configuration may take.
pub(crate) const REMOTES_TIMEOUT: Duration = Duration::from_secs(2);
const PULL_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// The project's one code host, read for pull requests naming an issue key.
#[derive(Debug, PartialEq)]
pub(crate) enum CodeHost {
    GitHub(GitHubRepository),
    Azure(AzureRepository),
}

impl CodeHost {
    pub(crate) fn of(sources: ProjectSources) -> Option<Self> {
        match (sources.github, sources.azure_devops) {
            (Some(github), _) => Some(Self::GitHub(GitHubRepository {
                owner: github.owner,
                name: github.name,
            })),
            (None, Some(azure)) => Some(Self::Azure(azure)),
            (None, None) => None,
        }
    }

    fn parse(url: &[u8]) -> Option<Self> {
        parse_github_remote(url)
            .map(Self::GitHub)
            .or_else(|_| parse_azure_remote(url).map(Self::Azure))
            .ok()
    }

    /// One read per key on GitHub, which searches by key; one listing for
    /// every key on Azure DevOps, which cannot.
    pub(crate) fn pull_requests(
        &self,
        provider_directory: &Path,
        keys: &[String],
    ) -> Vec<Result<IssueKeyPullRequests, ProviderFailure>> {
        match self {
            Self::GitHub(repository) => {
                let client = GitHubClient::new(provider_directory);
                keys.iter()
                    .map(|key| {
                        client.issue_key_pull_requests(repository, key, PULL_REQUEST_TIMEOUT)
                    })
                    .collect()
            }
            Self::Azure(repository) => AzureDevOpsClient::new(provider_directory)
                .issue_keys_pull_requests(repository, keys, true, PULL_REQUEST_TIMEOUT)
                .unwrap_or_else(|failure| keys.iter().map(|_| Err(failure)).collect()),
        }
    }
}

/// The host the folder's remotes name; none outside a repository. An error
/// means the remotes could not be read, so the stored host stays.
fn detect(folder: &Path) -> Result<Option<CodeHost>, GitError> {
    let mut remotes =
        match GitRunner::discover()?.observe_remotes_with_timeout(folder, REMOTES_TIMEOUT) {
            Err(GitError::NotRepository) => return Ok(None),
            read => read?,
        };
    remotes.sort_by_key(|remote| remote.name != b"origin");
    Ok(remotes
        .iter()
        .flat_map(|remote| &remote.fetch_urls)
        .find_map(|url| CodeHost::parse(url)))
}

/// Detects off the async runtime; no folder names no host.
pub(crate) async fn detect_in(folder: Option<&str>) -> Result<Option<CodeHost>, GitError> {
    let Some(folder) = folder.map(PathBuf::from) else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || detect(&folder))
        .await
        .unwrap_or(Err(GitError::GitUnavailable))
}

/// Stores a detected host in place of the project's, keeping its Jira
/// source; an unread folder keeps the stored one. Returns whether it changed.
pub(crate) fn store(
    store: &mut PmStore,
    project_id: &str,
    detected: Result<Option<CodeHost>, GitError>,
) -> Result<bool, PmError> {
    let Ok(host) = detected else {
        return Ok(false);
    };
    let current = store.project_sources(project_id)?;
    let (github, azure_devops) = match host {
        Some(CodeHost::GitHub(github)) => (
            Some(GitHubSource {
                owner: github.owner,
                name: github.name,
            }),
            None,
        ),
        Some(CodeHost::Azure(azure)) => (None, Some(azure)),
        None => (None, None),
    };
    let wanted = ProjectSources {
        github,
        azure_devops,
        ..current.clone()
    };
    if wanted.normalized().as_ref() == Some(&current) {
        return Ok(false);
    }
    store.set_project_sources(project_id, &wanted)?;
    Ok(true)
}

/// Follows a changed remote: the fact refresh runs this for every project
/// with a folder before it reads pull requests.
pub(crate) async fn refresh(state: &AppState, project_id: &str) {
    let Ok(Some(project)) = state.store.lock().project(project_id) else {
        return;
    };
    if project.folder.is_none() {
        return;
    }
    let detected = detect_in(project.folder.as_deref()).await;
    match store(&mut state.store.lock(), project_id, detected) {
        Ok(true) => state.board_changed(project_id),
        Ok(false) => {}
        Err(error) => tracing::debug!(%error, "kept the stored code host"),
    }
}
