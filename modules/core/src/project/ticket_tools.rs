//! The ticket tools of an Agent in a Project opened as Project Manager. The
//! project manager talks to an ordinary Agent of the Project and asks it to
//! read or rewrite tickets; every write becomes a ticket version authored by
//! the Agent, which the project manager can compare and restore. The Agent
//! never records delivery facts here: TermLoop reads those itself.

use serde_json::{Value, json};
use termloop_domain::{
    TASK_TICKET_BRIEF_MAX_CHARS, TASK_TICKET_SUMMARY_MAX_CHARS, TASK_TICKET_TITLE_MAX_CHARS,
    TaskRecord, TaskStatus, TicketAuthor,
};

use crate::session_launch::AgentMcpRole;
use crate::{CoreError, CoreRuntime};

/// One ticket change an Agent saves at the project manager's request.
#[derive(Debug, Clone, Default)]
pub struct AgentTicketWrite {
    pub task_id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub change_summary: String,
    pub expected_ticket_version: Option<u64>,
}

impl CoreRuntime {
    /// The Project Manager Project of the authenticated running ordinary
    /// Agent Session.
    fn ticket_tool_project(&self, token: &str) -> Result<String, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        if !matches!(principal.role(), AgentMcpRole::Interactive) {
            return Err(CoreError::CapabilityDenied);
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == principal.session_id()
                    && session.runtime_epoch == principal.runtime_epoch()
                    && session.lifecycle_state == "running"
            })
            .ok_or(CoreError::CapabilityDenied)?;
        if !self.is_project_manager_project(&session.project_id) {
            return Err(CoreError::CapabilityDenied);
        }
        Ok(session.project_id.clone())
    }

    /// An open Task of the Agent's Project; any other Task is not found.
    fn ticket_tool_task(&self, project_id: &str, task_id: &str) -> Result<TaskRecord, CoreError> {
        self.task_record(task_id)
            .ok()
            .filter(|task| open_in_project(task, project_id))
            .ok_or(CoreError::NotFound)
    }

    /// `task_ticket_read`: one Task's ticket and facts, or the Project's open
    /// Tasks without a `taskId`.
    pub fn read_project_manager_ticket(
        &self,
        token: &str,
        task_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        let project_id = self.ticket_tool_project(token)?;
        if let Some(task_id) = task_id {
            let task = self.ticket_tool_task(&project_id, task_id)?;
            return Ok(self.delivery_check_task_json(&task));
        }
        let mut tasks = self
            .store
            .tasks()
            .iter()
            .filter(|task| open_in_project(task, &project_id))
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.rank);
        let sprint_name = |task_id: &str| {
            let sprint_id = self.store.task_tracking(task_id)?.sprint_id.as_deref()?;
            self.store
                .project_sprints()
                .iter()
                .find(|sprint| sprint.id == sprint_id)
                .map(|sprint| sprint.name.clone())
        };
        Ok(json!({
            "projectId": project_id,
            "tasks": tasks.into_iter().map(|task| json!({
                "taskId": task.id,
                "jiraKey": self.task_jira_key(&task.id),
                "title": task.title,
                "sprint": sprint_name(&task.id),
                "inActiveSprint": self.task_in_active_sprint(&task.id),
                "ticketVersion": self.store.task_ticket_head(&task.id).map(|head| head.number),
            })).collect::<Vec<_>>(),
        }))
    }

    /// `task_ticket_write`: saves the Agent's ticket change as a new version.
    pub fn write_project_manager_ticket(
        &mut self,
        token: &str,
        write: AgentTicketWrite,
    ) -> Result<Value, CoreError> {
        let project_id = self.ticket_tool_project(token)?;
        let task = self.ticket_tool_task(&project_id, &write.task_id)?;
        let invalid = |field: &str| CoreError::InvalidParams(field.into());
        if write.title.is_none() && write.description.is_none() {
            return Err(invalid("description"));
        }
        let summary = write.change_summary.trim().to_owned();
        if summary.is_empty() || summary.chars().count() > TASK_TICKET_SUMMARY_MAX_CHARS {
            return Err(invalid("changeSummary"));
        }
        let current = self
            .store
            .task_ticket_content(&task.id)
            .ok_or(CoreError::NotFound)?;
        let mut content = current.clone();
        if let Some(title) = &write.title {
            content.title = title.trim().to_owned();
            if content.title.is_empty()
                || content.title.chars().count() > TASK_TICKET_TITLE_MAX_CHARS
            {
                return Err(invalid("title"));
            }
        }
        if let Some(description) = &write.description {
            let description = description.trim();
            if description.chars().count() > TASK_TICKET_BRIEF_MAX_CHARS {
                return Err(invalid("description"));
            }
            content.brief = Some(description.to_owned()).filter(|text| !text.is_empty());
        }
        let head = self
            .store
            .task_ticket_head(&task.id)
            .map(|head| head.number);
        if content == current {
            return Ok(json!({
                "taskId": task.id,
                "ticketVersion": head,
                "ticketChanged": false,
            }));
        }
        // A ticket without versions is version 0 to compare against.
        let version = self.save_ticket(
            &task.id,
            content,
            TicketAuthor::Agent,
            Some(summary),
            Some(write.expected_ticket_version.unwrap_or(0)),
            false,
        )?;
        Ok(json!({
            "taskId": task.id,
            "ticketVersion": version,
            "ticketChanged": true,
        }))
    }
}

fn open_in_project(task: &TaskRecord, project_id: &str) -> bool {
    task.project_id == project_id
        && task.status == TaskStatus::Open
        && task.archived_at_epoch_ms.is_none()
}

#[cfg(test)]
mod tests;
