use termloop_providers::{
    JiraBoardSource, JiraCloudClient, JiraCredential, JiraIssueSource, JiraSearchError,
    JiraSearchResult, JiraSprint, JiraSprintListResult, JiraSprintSource, JiraSprintState,
};

use super::{TaskSourceFailure, TaskSourceRefreshOutcome, TaskSourceRefreshPlan};
use crate::CoreError;

/// Executes the blocking provider observation owned by the Task Source boundary.
/// The server calls this outside the serialized Core lock.
pub trait TaskSourceRefreshObserver: Send + Sync {
    fn observe(
        &self,
        plan: &TaskSourceRefreshPlan,
        email: &str,
        api_token: &str,
    ) -> TaskSourceRefreshOutcome;
}

pub trait TaskSourceBoardObserver: Send + Sync {
    fn list_boards(
        &self,
        site_base_url: &str,
        email: &str,
        api_token: &str,
        board_id: Option<&str>,
    ) -> Result<TaskSourceBoardList, TaskSourceFailure>;

    fn list_statuses(
        &self,
        site_base_url: &str,
        email: &str,
        api_token: &str,
        board_ids: &[String],
    ) -> Result<TaskSourceStatusList, TaskSourceFailure>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceBoard {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub location_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceBoardList {
    pub boards: Vec<TaskSourceBoard>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceStatus {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSourceStatusList {
    pub statuses: Vec<TaskSourceStatus>,
}

/// One Jira sprint read: each board's active and future sprints and the
/// issues of the one sprint taken as active.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraSprintObservation {
    pub boards: Vec<JiraBoardSprints>,
    /// The first active sprint in board order, with its issues.
    pub active: Option<(JiraSprint, JiraSearchResult)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraBoardSprints {
    pub board_id: u64,
    /// `None` for a board without sprints, such as a kanban board.
    pub sprints: Option<Vec<JiraSprint>>,
    pub truncated: bool,
}

pub trait TaskSourceSprintObserver: Send + Sync {
    fn observe_sprints(
        &self,
        site_base_url: &str,
        email: &str,
        api_token: &str,
        board_ids: &[u64],
    ) -> Result<JiraSprintObservation, TaskSourceFailure>;
}

pub trait TaskSourceJiraObserver:
    TaskSourceRefreshObserver + TaskSourceBoardObserver + TaskSourceSprintObserver
{
}

impl<T> TaskSourceJiraObserver for T where
    T: TaskSourceRefreshObserver + TaskSourceBoardObserver + TaskSourceSprintObserver
{
}

pub struct JiraTaskSourceRefreshObserver {
    client: JiraCloudClient,
}

#[derive(Debug, Default)]
pub struct UnavailableTaskSourceRefreshObserver;

impl TaskSourceRefreshObserver for UnavailableTaskSourceRefreshObserver {
    fn observe(
        &self,
        _plan: &TaskSourceRefreshPlan,
        _email: &str,
        _api_token: &str,
    ) -> TaskSourceRefreshOutcome {
        TaskSourceRefreshOutcome::Failure {
            reason: TaskSourceFailure::ProviderUnavailable,
            retry_after_seconds: None,
        }
    }
}

impl TaskSourceBoardObserver for UnavailableTaskSourceRefreshObserver {
    fn list_boards(
        &self,
        _site_base_url: &str,
        _email: &str,
        _api_token: &str,
        _board_id: Option<&str>,
    ) -> Result<TaskSourceBoardList, TaskSourceFailure> {
        Err(TaskSourceFailure::ProviderUnavailable)
    }

    fn list_statuses(
        &self,
        _site_base_url: &str,
        _email: &str,
        _api_token: &str,
        _board_ids: &[String],
    ) -> Result<TaskSourceStatusList, TaskSourceFailure> {
        Err(TaskSourceFailure::ProviderUnavailable)
    }
}

impl TaskSourceSprintObserver for UnavailableTaskSourceRefreshObserver {
    fn observe_sprints(
        &self,
        _site_base_url: &str,
        _email: &str,
        _api_token: &str,
        _board_ids: &[u64],
    ) -> Result<JiraSprintObservation, TaskSourceFailure> {
        Err(TaskSourceFailure::ProviderUnavailable)
    }
}

impl JiraTaskSourceRefreshObserver {
    pub fn new() -> Result<Self, CoreError> {
        JiraCloudClient::new()
            .map(|client| Self { client })
            .map_err(|_| CoreError::Store("Jira Task Source client is unavailable".into()))
    }
}

impl TaskSourceRefreshObserver for JiraTaskSourceRefreshObserver {
    fn observe(
        &self,
        plan: &TaskSourceRefreshPlan,
        email: &str,
        api_token: &str,
    ) -> TaskSourceRefreshOutcome {
        self.client
            .search(&plan.request, JiraCredential { email, api_token })
            .map(TaskSourceRefreshOutcome::Success)
            .unwrap_or_else(TaskSourceRefreshOutcome::from)
    }
}

impl TaskSourceBoardObserver for JiraTaskSourceRefreshObserver {
    fn list_boards(
        &self,
        site_base_url: &str,
        email: &str,
        api_token: &str,
        board_id: Option<&str>,
    ) -> Result<TaskSourceBoardList, TaskSourceFailure> {
        self.client
            .list_boards(site_base_url, JiraCredential { email, api_token }, board_id)
            .map(|result| TaskSourceBoardList {
                boards: result
                    .boards
                    .into_iter()
                    .map(|board| TaskSourceBoard {
                        id: board.id,
                        name: board.name,
                        kind: board.kind,
                        location_name: board.location_name,
                    })
                    .collect(),
                truncated: result.truncated,
            })
            .map_err(task_source_failure_from)
    }

    fn list_statuses(
        &self,
        site_base_url: &str,
        email: &str,
        api_token: &str,
        board_ids: &[String],
    ) -> Result<TaskSourceStatusList, TaskSourceFailure> {
        self.client
            .list_statuses(
                site_base_url,
                JiraCredential { email, api_token },
                board_ids,
            )
            .map(|result| TaskSourceStatusList {
                statuses: result
                    .statuses
                    .into_iter()
                    .map(|status| TaskSourceStatus {
                        id: status.id,
                        name: status.name,
                    })
                    .collect(),
            })
            .map_err(task_source_failure_from)
    }
}

impl TaskSourceSprintObserver for JiraTaskSourceRefreshObserver {
    fn observe_sprints(
        &self,
        site_base_url: &str,
        email: &str,
        api_token: &str,
        board_ids: &[u64],
    ) -> Result<JiraSprintObservation, TaskSourceFailure> {
        let credential = || JiraCredential { email, api_token };
        let mut boards = Vec::with_capacity(board_ids.len());
        for board_id in board_ids {
            let board = match self
                .client
                .list_sprints(site_base_url, credential(), *board_id)
                .map_err(task_source_failure_from)?
            {
                JiraSprintListResult::Sprints { sprints, truncated } => JiraBoardSprints {
                    board_id: *board_id,
                    sprints: Some(sprints),
                    truncated,
                },
                JiraSprintListResult::SprintsUnsupported => JiraBoardSprints {
                    board_id: *board_id,
                    sprints: None,
                    truncated: false,
                },
            };
            boards.push(board);
        }
        let active = boards
            .iter()
            .flat_map(|board| board.sprints.iter().flatten())
            .find(|sprint| sprint.state == JiraSprintState::Active)
            .cloned();
        let active = match active {
            Some(sprint) => {
                let issues = self
                    .client
                    .sprint_issues(site_base_url, credential(), sprint.id)
                    .map_err(task_source_failure_from)?;
                Some((sprint, issues))
            }
            None => None,
        };
        Ok(JiraSprintObservation { boards, active })
    }
}

fn task_source_failure_from(error: JiraSearchError) -> TaskSourceFailure {
    match error {
        JiraSearchError::InvalidSite | JiraSearchError::ScopeInvalid => {
            TaskSourceFailure::ScopeInvalid
        }
        JiraSearchError::Unauthorized => TaskSourceFailure::CredentialsInvalid,
        JiraSearchError::RateLimited { .. } => TaskSourceFailure::RateLimited,
        JiraSearchError::Unavailable => TaskSourceFailure::ProviderUnavailable,
        JiraSearchError::ResponseTooLarge => TaskSourceFailure::ResponseTooLarge,
        JiraSearchError::MalformedResponse => TaskSourceFailure::MalformedResponse,
    }
}

impl From<JiraSearchError> for TaskSourceRefreshOutcome {
    fn from(error: JiraSearchError) -> Self {
        let retry_after_seconds = match &error {
            JiraSearchError::RateLimited {
                retry_after_seconds,
            } => *retry_after_seconds,
            _ => None,
        };
        let reason = task_source_failure_from(error);
        Self::Failure {
            reason,
            retry_after_seconds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_observer_keeps_daemon_fallback_typed() {
        let outcome = UnavailableTaskSourceRefreshObserver.observe(
            &TaskSourceRefreshPlan {
                source_id: "source-1".into(),
                generation: 1,
                request: termloop_providers::JiraSearchRequest {
                    site_base_url: "https://example.atlassian.net".into(),
                    scope: termloop_providers::JiraSearchScope::Jql(
                        "assignee = currentUser()".into(),
                    ),
                },
            },
            "user@example.com",
            "token",
        );
        assert_eq!(
            outcome,
            TaskSourceRefreshOutcome::Failure {
                reason: TaskSourceFailure::ProviderUnavailable,
                retry_after_seconds: None,
            }
        );
    }
}
