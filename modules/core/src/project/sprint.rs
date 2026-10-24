//! Local sprints and the Project Manager's own tracking record per Task, for
//! Projects opened as Project Manager. Sprints are TermLoop's own; a Task
//! copied from Jira keeps only its IssueLink sidecar. TermLoop keeps delivery
//! facts for the open Tasks of the one active sprint.

use serde_json::{Value, json};
use termloop_domain::{
    IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, ProjectSprint, SprintState, TaskRecord,
    TaskStatus, TaskTrackingRecord,
};
use termloop_providers::{JiraSearchRequest, JiraSearchResult, JiraSearchScope};

use crate::{CoreError, CoreRuntime, TaskSourceRefreshPlan, required_string, store_error};

const TASK_TITLE_MAX_CHARS: usize = 160;
const TASK_BRIEF_MAX_CHARS: usize = 8_000;
const JIRA_QUERY_MAX_CHARS: usize = 200;

impl CoreRuntime {
    pub(super) fn ensure_project_manager_project(&self, project_id: &str) -> Result<(), CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        if !self.is_project_manager_project(project_id) {
            return Err(CoreError::CapabilityDenied);
        }
        Ok(())
    }

    pub(crate) fn project_manager_board_command(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        self.ensure_project_manager_project(&project_id)?;
        Ok(self.project_manager_board(&project_id))
    }

    pub(crate) fn project_manager_board(&self, project_id: &str) -> Value {
        let sprints = self
            .store
            .project_sprints()
            .iter()
            .filter(|sprint| sprint.project_id == project_id)
            .map(sprint_json)
            .collect::<Vec<_>>();
        let tracking = self
            .store
            .task_tracking_records()
            .iter()
            .filter(|record| {
                self.store
                    .tasks()
                    .iter()
                    .any(|task| task.id == record.task_id && task.project_id == project_id)
            })
            .map(tracking_json)
            .collect::<Vec<_>>();
        json!({
            "projectId": project_id,
            "sprints": sprints,
            "tracking": tracking,
            "facts": self.project_facts_json(project_id),
            "tickets": self.ticket_heads(project_id),
            "proposals": self.ticket_proposals_json(project_id),
            "checks": self
                .running_delivery_checks(project_id)
                .into_iter()
                .map(|(session_id, task_ids)| json!({ "sessionId": session_id, "taskIds": task_ids }))
                .collect::<Vec<_>>(),
            "stateRevision": self.store.revision(),
        })
    }

    pub(crate) fn create_project_sprint_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        self.ensure_project_manager_project(&project_id)?;
        let name = sprint_name(&params)?;
        let state = optional_sprint_state(&params)?.unwrap_or_default();
        self.store
            .create_project_sprint(
                &self.write_authority,
                ProjectSprint {
                    id: termloop_platform::generate_uuid_v4(),
                    project_id: project_id.clone(),
                    name,
                    state,
                    created_at_epoch_ms: termloop_platform::current_epoch_ms(),
                },
            )
            .map_err(store_error)?;
        Ok(self.project_manager_board(&project_id))
    }

    pub(crate) fn update_project_sprint_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let sprint_id = required_string(&params, "sprintId")?;
        let project_id = self.sprint_project_id(&sprint_id)?;
        self.ensure_project_manager_project(&project_id)?;
        let name = sprint_name(&params)?;
        let state = optional_sprint_state(&params)?
            .ok_or_else(|| CoreError::InvalidParams("state".into()))?;
        self.store
            .update_project_sprint(&self.write_authority, &sprint_id, &name, state)
            .map_err(store_error)?;
        Ok(self.project_manager_board(&project_id))
    }

    pub(crate) fn delete_project_sprint_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let sprint_id = required_string(&params, "sprintId")?;
        let project_id = self.sprint_project_id(&sprint_id)?;
        self.ensure_project_manager_project(&project_id)?;
        self.store
            .delete_project_sprint(&self.write_authority, &sprint_id)
            .map_err(store_error)?;
        Ok(self.project_manager_board(&project_id))
    }

    /// Replaces a Task's sprint and what the Project Manager states about it.
    pub(crate) fn set_task_tracking_command(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self.task_record(&task_id)?;
        self.ensure_project_manager_project(&task.project_id)?;
        let record = TaskTrackingRecord {
            task_id: task.id.clone(),
            sprint_id: optional_text(&params, "sprintId")?,
            developer: optional_text(&params, "developer")?,
            blockers: optional_text(&params, "blockers")?,
            note: optional_text(&params, "note")?,
            updated_at_epoch_ms: termloop_platform::current_epoch_ms(),
        };
        self.store
            .set_task_tracking(&self.write_authority, record)
            .map_err(store_error)?;
        Ok(self.project_manager_board(&task.project_id))
    }

    /// Creates a local Task, optionally copied from one Jira issue, directly
    /// into a sprint or the backlog.
    pub(crate) fn create_project_manager_task_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        self.ensure_project_manager_project(&project_id)?;
        let title = bounded_text(&params, "title", TASK_TITLE_MAX_CHARS)?
            .ok_or_else(|| CoreError::InvalidParams("title".into()))?;
        let brief = bounded_text(&params, "brief", TASK_BRIEF_MAX_CHARS)?;
        let link = optional_text(&params, "jiraUrl")?
            .map(|url| {
                termloop_providers::normalize_jira_issue_url(&url)
                    .map_err(|_| CoreError::InvalidParams("jiraUrl".into()))
            })
            .transpose()?;
        let rank = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.rank)
            .max()
            .map_or(Ok(0), |rank| {
                rank.checked_add(1)
                    .ok_or_else(|| CoreError::Store("Task rank overflow".into()))
            })?;
        let now = termloop_platform::current_epoch_ms();
        let task = TaskRecord {
            id: termloop_platform::generate_uuid_v4(),
            project_id: project_id.clone(),
            title,
            brief,
            developer_notes: Vec::new(),
            status: TaskStatus::Open,
            archived_at_epoch_ms: None,
            branch: None,
            worktree: None,
            worktree_generation: 0,
            steward_brief_markdown: String::new(),
            steward_brief_revision: 1,
            rank,
            created_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        let record = TaskTrackingRecord {
            task_id: task.id.clone(),
            sprint_id: optional_text(&params, "sprintId")?,
            developer: optional_text(&params, "developer")?,
            updated_at_epoch_ms: now,
            ..TaskTrackingRecord::default()
        };
        if !record.is_valid()
            || record.sprint_id.as_deref().is_some_and(|sprint_id| {
                self.sprint_project_id(sprint_id).ok().as_deref() != Some(project_id.as_str())
            })
        {
            return Err(CoreError::InvalidParams("tracking".into()));
        }
        match link {
            Some(normalized) => self
                .store
                .insert_task_from_source(
                    &self.write_authority,
                    task.clone(),
                    IssueLink {
                        task_id: task.id.clone(),
                        provider: IssueLinkProvider::Jira,
                        external_ref: normalized.external_ref,
                        source_id: None,
                        external_id: None,
                        external_updated_at: None,
                        url: Some(normalized.url),
                        sync_authority: IssueLinkSyncAuthority::None,
                    },
                )
                .map_err(|error| match error {
                    termloop_store::StoreError::ConstraintViolation => {
                        CoreError::InvalidParams("jiraUrl".into())
                    }
                    error => store_error(error),
                })?,
            None => self
                .store
                .insert_task(&self.write_authority, task.clone())
                .map_err(store_error)?,
        };
        self.store
            .set_task_tracking(&self.write_authority, record)
            .map_err(store_error)?;
        let content = self
            .store
            .task_ticket_content(&task.id)
            .ok_or(CoreError::NotFound)?;
        let created = match self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task.id)
        {
            Some(link) => format!("Copied from {}", link.external_ref),
            None => "Created".to_owned(),
        };
        self.save_ticket(
            &task.id,
            content,
            termloop_domain::TicketAuthor::ProjectManager,
            Some(created),
            None,
            false,
        )?;
        Ok(json!({
            "task": self.task_projection(&task)?,
            "board": self.project_manager_board(&project_id),
        }))
    }

    /// Plans one bounded Jira search through the Project's first enabled Jira
    /// Task Source. A bare issue key looks that issue up; other text matches
    /// summaries and descriptions.
    pub fn plan_project_manager_jira_search(
        &self,
        params: &Value,
    ) -> Result<TaskSourceRefreshPlan, CoreError> {
        let project_id = required_string(params, "projectId")?;
        self.ensure_project_manager_project(&project_id)?;
        let query = bounded_text(params, "query", JIRA_QUERY_MAX_CHARS)?
            .ok_or_else(|| CoreError::InvalidParams("query".into()))?;
        let source = self
            .store
            .task_source_configurations()
            .iter()
            .find(|source| source.project_id == project_id && source.enabled)
            .ok_or_else(|| CoreError::InvalidParams("taskSource".into()))?;
        Ok(TaskSourceRefreshPlan {
            source_id: source.id.clone(),
            generation: source.generation,
            request: JiraSearchRequest {
                site_base_url: source.site_base_url.clone(),
                scope: JiraSearchScope::Jql(jira_search_jql(&query)),
            },
        })
    }

    pub fn project_manager_jira_search_result(
        &self,
        project_id: &str,
        result: JiraSearchResult,
    ) -> Value {
        let linked =
            self.store
                .issue_links()
                .iter()
                .filter(|link| link.provider == IssueLinkProvider::Jira)
                .filter_map(|link| {
                    let task =
                        self.store.tasks().iter().find(|task| {
                            task.id == link.task_id && task.project_id == project_id
                        })?;
                    Some((link.url.clone()?, task.id.clone()))
                })
                .collect::<Vec<_>>();
        json!({
            "issues": result.issues.iter().map(|issue| json!({
                "key": issue.key,
                "url": issue.url,
                "summary": issue.summary,
                "description": issue.description,
                "statusName": issue.status_name,
                "assigneeDisplay": issue.assignee_display,
                "taskId": linked.iter().find(|(url, _)| *url == issue.url).map(|(_, task_id)| task_id),
            })).collect::<Vec<_>>(),
            "truncated": result.truncated,
            "failureReason": null,
        })
    }

    /// Whether this open Task belongs to its Project's active sprint.
    pub fn task_in_active_sprint(&self, task_id: &str) -> bool {
        let Ok(task) = self.task_record(task_id) else {
            return false;
        };
        task.status == TaskStatus::Open
            && task.archived_at_epoch_ms.is_none()
            && self
                .store
                .active_sprint(&task.project_id)
                .is_some_and(|sprint| {
                    self.store
                        .task_tracking(task_id)
                        .and_then(|record| record.sprint_id.as_deref())
                        == Some(sprint.id.as_str())
                })
    }

    fn sprint_project_id(&self, sprint_id: &str) -> Result<String, CoreError> {
        self.store
            .project_sprints()
            .iter()
            .find(|sprint| sprint.id == sprint_id)
            .map(|sprint| sprint.project_id.clone())
            .ok_or(CoreError::NotFound)
    }

    pub(crate) fn task_record(&self, task_id: &str) -> Result<TaskRecord, CoreError> {
        self.store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)
    }
}

pub(crate) fn sprint_json(sprint: &ProjectSprint) -> Value {
    json!({
        "id": sprint.id,
        "name": sprint.name,
        "state": sprint.state,
        "createdAtEpochMs": sprint.created_at_epoch_ms,
    })
}

pub(crate) fn tracking_json(record: &TaskTrackingRecord) -> Value {
    json!({
        "taskId": record.task_id,
        "sprintId": record.sprint_id,
        "developer": record.developer,
        "blockers": record.blockers,
        "note": record.note,
        "updatedAtEpochMs": record.updated_at_epoch_ms,
    })
}

/// A key such as `PAY-42` looks the issue up; anything else is a quoted text
/// search over the newest issues.
fn jira_search_jql(query: &str) -> String {
    let key_like = query.split_once('-').is_some_and(|(project, number)| {
        !project.is_empty()
            && project
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
            && project
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphabetic())
            && !number.is_empty()
            && number.chars().all(|character| character.is_ascii_digit())
    });
    if key_like {
        return format!("key = \"{}\"", query.to_ascii_uppercase());
    }
    let escaped = query.replace('\\', "\\\\").replace('"', "\\\"");
    format!("text ~ \"{escaped}\" ORDER BY updated DESC")
}

fn sprint_name(params: &Value) -> Result<String, CoreError> {
    let name = required_string(params, "name")?.trim().to_owned();
    termloop_domain::valid_sprint_name(&name)
        .then_some(name)
        .ok_or_else(|| CoreError::InvalidParams("name".into()))
}

fn optional_sprint_state(params: &Value) -> Result<Option<SprintState>, CoreError> {
    match params.get("state") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| CoreError::InvalidParams("state".into())),
    }
}

/// A trimmed string, with blank meaning absent.
pub(super) fn optional_text(params: &Value, key: &str) -> Result<Option<String>, CoreError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            Ok(Some(value.trim().to_owned()).filter(|value| !value.is_empty()))
        }
        Some(_) => Err(CoreError::InvalidParams(key.into())),
    }
}

pub(super) fn bounded_text(
    params: &Value,
    key: &str,
    limit: usize,
) -> Result<Option<String>, CoreError> {
    let value = optional_text(params, key)?;
    if value
        .as_ref()
        .is_some_and(|value| value.chars().count() > limit)
    {
        return Err(CoreError::InvalidParams(key.into()));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jira_search_looks_up_keys_and_quotes_free_text() {
        assert_eq!(jira_search_jql("pay-42"), "key = \"PAY-42\"");
        assert_eq!(
            jira_search_jql("cors \"origin\""),
            "text ~ \"cors \\\"origin\\\"\" ORDER BY updated DESC"
        );
        assert_eq!(
            jira_search_jql("front-end"),
            "text ~ \"front-end\" ORDER BY updated DESC"
        );
    }
}
