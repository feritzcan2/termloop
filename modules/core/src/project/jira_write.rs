//! Changes a Project Manager confirms for the Jira issue of a Task: the
//! ticket's title and description pushed to Jira, and the sprint Jira keeps
//! the issue in. Core plans each change under its lock; the server reads and
//! writes Jira with the Task Source's stored credential outside it. Nothing
//! here is stored: Jira is the record of what was written.

use serde_json::{Value, json};
use termloop_domain::IssueLinkProvider;
use termloop_providers::{
    JIRA_DESCRIPTION_MAX_CHARS, JiraIssueText, markdown_to_jira_wiki, normalize_jira_site_base_url,
};

use crate::{
    CoreError, CoreRuntime, JiraIssueWrite, JiraIssueWriteOutcome, JiraWriteFailure,
    required_string, task_source_failure_wire,
};

const JIRA_UPDATED_MAX_CHARS: usize = 128;

/// One planned read of, or change to, a Task's Jira issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraIssueWritePlan {
    pub project_id: String,
    pub task_id: String,
    pub source_id: String,
    pub site_base_url: String,
    pub issue_key: String,
    pub write: JiraIssueWrite,
}

impl CoreRuntime {
    /// Plans `projectManager.jiraIssueRead`, `projectManager.jiraIssuePush`,
    /// or `projectManager.jiraSprintMove` for one Jira-linked Task.
    pub fn plan_jira_issue_write(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<JiraIssueWritePlan, CoreError> {
        let project_id = required_string(params, "projectId")?;
        let task_id = required_string(params, "taskId")?;
        self.ensure_project_manager_project(&project_id)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::NotFound)?;
        let issue_key = self
            .task_jira_key(&task_id)
            .ok_or_else(|| CoreError::InvalidParams("taskId".into()))?;
        let issue_url = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task_id && link.provider == IssueLinkProvider::Jira)
            .and_then(|link| link.url.clone())
            .unwrap_or_default();
        // The credential goes only to the site the Task's issue lives on.
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .filter(|source| source.project_id == project_id && source.enabled)
            .find(|source| {
                normalize_jira_site_base_url(&source.site_base_url).is_ok_and(|site| {
                    issue_url
                        .to_ascii_lowercase()
                        .starts_with(&format!("{}/browse/", site.to_ascii_lowercase()))
                })
            })
            .ok_or_else(|| CoreError::InvalidParams("taskSource".into()))?;
        let write = match method {
            "projectManager.jiraIssueRead" => JiraIssueWrite::Read,
            "projectManager.jiraIssuePush" => {
                let expected_version = params
                    .get("expectedTicketVersion")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| CoreError::InvalidParams("expectedTicketVersion".into()))?;
                let expected_updated = required_string(params, "expectedJiraUpdated")?;
                if expected_updated.chars().count() > JIRA_UPDATED_MAX_CHARS {
                    return Err(CoreError::InvalidParams("expectedJiraUpdated".into()));
                }
                // Only a saved ticket version goes to Jira, and only the one
                // the Project Manager reviewed.
                let head = self
                    .store
                    .task_ticket_head(&task_id)
                    .ok_or_else(|| CoreError::InvalidParams("expectedTicketVersion".into()))?;
                if head.number != expected_version {
                    return Err(CoreError::RevisionConflict);
                }
                let description = markdown_to_jira_wiki(task.brief.as_deref().unwrap_or_default());
                if description.chars().count() > JIRA_DESCRIPTION_MAX_CHARS {
                    return Err(CoreError::InvalidParams("description".into()));
                }
                JiraIssueWrite::Update {
                    summary: task.title.clone(),
                    description,
                    expected_updated,
                }
            }
            "projectManager.jiraSprintMove" => {
                if !self.sprints_follow_jira(&project_id) {
                    return Err(CoreError::CapabilityDenied);
                }
                let sprint_id = match params.get("sprintId") {
                    Some(Value::Null) => None,
                    Some(Value::String(sprint_id)) => Some(
                        self.store
                            .project_sprints()
                            .iter()
                            .find(|sprint| {
                                sprint.id == *sprint_id && sprint.project_id == project_id
                            })
                            .and_then(|sprint| sprint.jira.as_ref())
                            .map(|mirror| mirror.sprint_id)
                            .ok_or_else(|| CoreError::InvalidParams("sprintId".into()))?,
                    ),
                    _ => return Err(CoreError::InvalidParams("sprintId".into())),
                };
                JiraIssueWrite::Move { sprint_id }
            }
            _ => return Err(CoreError::MethodNotFound),
        };
        Ok(JiraIssueWritePlan {
            project_id,
            task_id,
            source_id: source.id.clone(),
            site_base_url: source.site_base_url.clone(),
            issue_key,
            write,
        })
    }

    /// What one planned read or change found, with the current board.
    pub fn jira_issue_write_result(
        &self,
        plan: &JiraIssueWritePlan,
        outcome: &JiraIssueWriteOutcome,
    ) -> Value {
        let (name, issue, failure) = match outcome {
            JiraIssueWriteOutcome::Read(issue) => ("read", Some(issue), None),
            JiraIssueWriteOutcome::Updated(issue) => ("updated", issue.as_ref(), None),
            JiraIssueWriteOutcome::JiraChanged(issue) => ("jiraChanged", Some(issue), None),
            JiraIssueWriteOutcome::Moved => ("moved", None, None),
            JiraIssueWriteOutcome::Failed(failure) => ("failed", None, Some(*failure)),
        };
        json!({
            "taskId": plan.task_id,
            "outcome": name,
            "issue": issue.map(issue_json),
            "failureReason": failure.map(jira_write_failure_wire),
            "board": self.project_manager_board(&plan.project_id),
        })
    }
}

fn issue_json(issue: &JiraIssueText) -> Value {
    json!({
        "key": issue.key,
        "summary": issue.summary,
        "description": issue.description,
        "updated": issue.updated,
    })
}

pub fn jira_write_failure_wire(failure: JiraWriteFailure) -> &'static str {
    match failure {
        JiraWriteFailure::Source(reason) => task_source_failure_wire(reason),
        JiraWriteFailure::Forbidden => "forbidden",
        JiraWriteFailure::NotFound => "notFound",
        JiraWriteFailure::Rejected => "rejected",
    }
}

#[cfg(test)]
mod tests;
