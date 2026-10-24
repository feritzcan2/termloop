//! Versioned Project Manager tickets. A ticket is a Task's title, Markdown
//! description, and tracked delivery facts; every save by the Project Manager
//! or the Task Agent becomes a numbered version that can be compared and
//! restored.

use serde_json::{Value, json};
use termloop_domain::{
    TASK_TICKET_BRIEF_MAX_CHARS, TASK_TICKET_SUMMARY_MAX_CHARS, TASK_TICKET_TITLE_MAX_CHARS,
    TaskTicketContent, TaskTicketVersion, TicketAuthor,
};

use super::sprint::{bounded_text, environments, optional_text};
use crate::{CoreError, CoreRuntime, required_string, store_error};

impl CoreRuntime {
    /// Saves the whole ticket as the Project Manager edited it.
    pub(crate) fn save_task_ticket_command(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self.task_record(&task_id)?;
        self.ensure_project_manager_project(&task.project_id)?;
        let content = TaskTicketContent {
            title: bounded_text(&params, "title", TASK_TICKET_TITLE_MAX_CHARS)?
                .ok_or_else(|| CoreError::InvalidParams("title".into()))?,
            brief: bounded_text(&params, "brief", TASK_TICKET_BRIEF_MAX_CHARS)?,
            developer: optional_text(&params, "developer")?,
            jira_status: optional_text(&params, "jiraStatus")?,
            environments: environments(&params)?.unwrap_or_default(),
            blockers: optional_text(&params, "blockers")?,
            note: optional_text(&params, "note")?,
        };
        let version = self.save_ticket(
            &task.id,
            content,
            TicketAuthor::ProjectManager,
            ticket_summary(&params, "summary")?,
            expected_version(&params)?,
        )?;
        Ok(self.ticket_saved(&task.project_id, &task.id, version))
    }

    /// Every kept version of a Task's ticket, newest first.
    pub(crate) fn task_ticket_versions_command(&self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self.task_record(&task_id)?;
        self.ensure_project_manager_project(&task.project_id)?;
        let mut versions = self
            .store
            .task_ticket_versions()
            .iter()
            .filter(|version| version.task_id == task.id)
            .collect::<Vec<_>>();
        versions.sort_by(|left, right| right.number.cmp(&left.number));
        Ok(json!({
            "taskId": task.id,
            "versions": versions.into_iter().map(version_json).collect::<Vec<_>>(),
        }))
    }

    /// Saves an earlier version's content as the newest version.
    pub(crate) fn restore_task_ticket_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self.task_record(&task_id)?;
        self.ensure_project_manager_project(&task.project_id)?;
        let number = params
            .get("number")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("number".into()))?;
        let content = self
            .store
            .task_ticket_versions()
            .iter()
            .find(|version| version.task_id == task.id && version.number == number)
            .map(|version| version.content.clone())
            .ok_or(CoreError::NotFound)?;
        let version = self.save_ticket(
            &task.id,
            content,
            TicketAuthor::ProjectManager,
            Some(format!("Restored version {number}")),
            expected_version(&params)?,
        )?;
        Ok(self.ticket_saved(&task.project_id, &task.id, version))
    }

    pub(crate) fn save_ticket(
        &mut self,
        task_id: &str,
        content: TaskTicketContent,
        author: TicketAuthor,
        summary: Option<String>,
        expected_version: Option<u64>,
    ) -> Result<u64, CoreError> {
        if !content.is_valid() {
            return Err(CoreError::InvalidParams("ticket".into()));
        }
        self.store
            .save_task_ticket(
                &self.write_authority,
                task_id,
                content,
                author,
                summary,
                expected_version,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)
    }

    /// The newest version of each of a Project's tickets, for the board.
    pub(super) fn ticket_heads(&self, project_id: &str) -> Vec<Value> {
        self.store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .filter_map(|task| self.store.task_ticket_head(&task.id))
            .map(|head| {
                json!({
                    "taskId": head.task_id,
                    "number": head.number,
                    "author": head.author,
                    "summary": head.summary,
                    "createdAtEpochMs": head.created_at_epoch_ms,
                })
            })
            .collect()
    }

    fn ticket_saved(&self, project_id: &str, task_id: &str, version: u64) -> Value {
        json!({
            "taskId": task_id,
            "version": version,
            "board": self.project_manager_board(project_id),
        })
    }
}

pub(crate) fn ticket_summary(params: &Value, key: &str) -> Result<Option<String>, CoreError> {
    bounded_text(params, key, TASK_TICKET_SUMMARY_MAX_CHARS)
}

pub(crate) fn expected_version(params: &Value) -> Result<Option<u64>, CoreError> {
    match params.get("expectedVersion") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| CoreError::InvalidParams("expectedVersion".into())),
    }
}

pub(crate) fn ticket_content_json(content: &TaskTicketContent) -> Value {
    json!({
        "title": content.title,
        "brief": content.brief,
        "developer": content.developer,
        "jiraStatus": content.jira_status,
        "environments": content.environments.iter().map(|environment| json!({
            "name": environment.name,
            "state": environment.state,
            "detail": environment.detail,
        })).collect::<Vec<_>>(),
        "blockers": content.blockers,
        "note": content.note,
    })
}

fn version_json(version: &TaskTicketVersion) -> Value {
    json!({
        "number": version.number,
        "author": version.author,
        "summary": version.summary,
        "createdAtEpochMs": version.created_at_epoch_ms,
        "content": ticket_content_json(&version.content),
    })
}
