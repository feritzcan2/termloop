//! Task Agent status records: in a Project opened as Project Manager, the one
//! canonical Agent of a Task records its current investigation of that Task —
//! who works on it, its tracker status, pull requests, and environments.
//!
//! The record is the Task's one current brief, replaced whole under a
//! revision CAS; it is never an appended history. Developer Projects keep the
//! brief Steward-only.

use super::*;
use termloop_domain::{IssueLinkProvider, ProjectMode, TASK_STEWARD_BRIEF_MAX_BYTES};

/// Why a running Project Manager Task Agent is asked to check its Task again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskReinvestigationReason {
    Requested,
    Scheduled,
}

impl TaskReinvestigationReason {
    fn as_prompt_text(self) -> &'static str {
        match self {
            Self::Requested => "the project manager asked for a fresh check",
            Self::Scheduled => "the periodic check is due",
        }
    }
}

impl CoreRuntime {
    /// The one running Agent of an open Task in a Project opened as Project
    /// Manager, if exactly one is current.
    fn project_manager_task_agent_session(
        &self,
        task_id: &str,
    ) -> Result<(termloop_domain::TaskRecord, String), CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?
            .clone();
        if task.status != termloop_domain::TaskStatus::Open
            || task.archived_at_epoch_ms.is_some()
            || !self.is_project_manager_project(&task.project_id)
        {
            return Err(CoreError::CapabilityDenied);
        }
        let coordination =
            self.task_coordination_agent_projection_for_executor(&task.project_id, &task.id)?;
        let session_id = coordination["sessionId"]
            .as_str()
            .filter(|_| coordination["state"] == "selected")
            .ok_or(CoreError::NotFound)?
            .to_owned();
        Ok((task, session_id))
    }

    /// Asks the Task's running Agent, through the visible re-investigation
    /// template, to check the Task again and replace its status record.
    pub fn request_task_reinvestigation(
        &mut self,
        task_id: &str,
        reason: TaskReinvestigationReason,
    ) -> Result<Value, CoreError> {
        let (task, session_id) = self.project_manager_task_agent_session(task_id)?;
        let prompt = termloop_invocation::task_reinvestigation_prompt(
            &task.id,
            &task.title,
            reason.as_prompt_text(),
        )
        .map_err(|_| CoreError::InvalidParams("taskId".into()))?;
        self.submit_generated_terminal_input(&session_id, prompt.terminal_submission())?;
        Ok(json!({ "taskId": task.id, "sessionId": session_id, "status": "submitting" }))
    }

    pub(crate) fn request_task_reinvestigation_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let task_id = crate::required_string(&params, "taskId")?;
        self.request_task_reinvestigation(&task_id, TaskReinvestigationReason::Requested)
    }

    /// Open Tasks of Project Manager Projects whose one Agent is running and
    /// could take a scheduled re-investigation now.
    pub fn project_manager_reinvestigation_task_ids(&self) -> Vec<String> {
        self.store
            .tasks()
            .iter()
            .filter(|task| {
                task.status == termloop_domain::TaskStatus::Open
                    && task.archived_at_epoch_ms.is_none()
                    && self.is_project_manager_project(&task.project_id)
                    && self.task_in_active_sprint(&task.id)
            })
            .filter(|task| self.project_manager_task_agent_session(&task.id).is_ok())
            .map(|task| task.id.clone())
            .collect()
    }

    fn project_manager_task_agent_task(
        &self,
        token: &str,
    ) -> Result<termloop_domain::TaskRecord, CoreError> {
        let (_, project_id, task) = self
            .task_agent_own_task(token)?
            .ok_or(CoreError::CapabilityDenied)?;
        if self.project_mode(&project_id)? != ProjectMode::ProjectManager {
            return Err(CoreError::CapabilityDenied);
        }
        Ok(task)
    }

    pub fn read_task_agent_status(&self, token: &str) -> Result<Value, CoreError> {
        let task = self.project_manager_task_agent_task(token)?;
        let jira_url = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task.id && link.provider == IssueLinkProvider::Jira)
            .and_then(|link| link.url.clone());
        Ok(json!({
            "taskId": task.id,
            "title": task.title,
            "description": task.brief,
            "jiraUrl": jira_url,
            "ticketVersion": self.store.task_ticket_head(&task.id).map(|head| head.number),
            "statusMarkdown": task.steward_brief_markdown,
            "statusRevision": task.steward_brief_revision,
            "tracking": self.store.task_tracking(&task.id).map(|record| json!({
                "developer": record.developer,
                "jiraStatus": record.jira_status,
                "environments": record.environments,
                "blockers": record.blockers,
                "note": record.note,
            })),
        }))
    }

    /// The Task Agent records its findings and updates its Task's ticket. A
    /// changed ticket — title, description, or tracked facts — is saved as a
    /// new version by the Agent; the project manager's sprint and note stay.
    pub fn record_task_agent_status(
        &mut self,
        token: &str,
        status_markdown: String,
        expected_status_revision: u64,
        update: TaskAgentTicketUpdate,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let task = self.project_manager_task_agent_task(token)?;
        if status_markdown.trim().is_empty() || status_markdown.len() > TASK_STEWARD_BRIEF_MAX_BYTES
        {
            return Err(CoreError::InvalidParams("statusMarkdown".into()));
        }
        if task.steward_brief_revision != expected_status_revision {
            return Err(CoreError::RevisionConflict);
        }
        let mut content = self
            .store
            .task_ticket_content(&task.id)
            .ok_or(CoreError::NotFound)?;
        let current = content.clone();
        if let Some(tracking) = &update.tracking {
            let text = |key: &str| {
                tracking
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            };
            content.developer = text("developer");
            content.jira_status = text("jiraStatus");
            content.environments =
                crate::project::tracking_environments(tracking)?.unwrap_or_default();
            content.blockers = text("blockers");
        }
        if let Some(ticket) = &update.ticket {
            if let Some(title) = ticket.get("title").and_then(Value::as_str) {
                content.title = title.trim().to_owned();
            }
            if let Some(description) = ticket.get("description").and_then(Value::as_str) {
                content.brief = Some(description.trim().to_owned()).filter(|text| !text.is_empty());
            }
        }
        let ticket_version = if content != current
            || self.store.task_ticket_head(&task.id).is_none() && update.ticket.is_some()
        {
            if !content.is_valid() {
                return Err(CoreError::InvalidParams(
                    if update.ticket.is_some() {
                        "ticket"
                    } else {
                        "tracking"
                    }
                    .into(),
                ));
            }
            let summary = update
                .change_summary
                .map(|summary| summary.trim().to_owned())
                .filter(|summary| !summary.is_empty());
            if summary.as_ref().is_some_and(|summary| {
                summary.chars().count() > termloop_domain::TASK_TICKET_SUMMARY_MAX_CHARS
            }) {
                return Err(CoreError::InvalidParams("changeSummary".into()));
            }
            Some(self.save_ticket(
                &task.id,
                content,
                termloop_domain::TicketAuthor::Agent,
                summary,
                update.expected_version,
            )?)
        } else {
            self.store
                .task_ticket_head(&task.id)
                .map(|head| head.number)
        };
        let task = self
            .store
            .update_task_steward_brief(
                &self.write_authority,
                &task.id,
                status_markdown,
                expected_status_revision,
                updated_at_epoch_ms,
            )
            .map_err(store_error)?;
        Ok(json!({
            "taskId": task.id,
            "status": "recorded",
            "statusRevision": task.steward_brief_revision,
            "ticketVersion": ticket_version,
        }))
    }
}

/// What a Task Agent changes on its Task's ticket with one status record.
#[derive(Debug, Clone, Default)]
pub struct TaskAgentTicketUpdate {
    pub tracking: Option<Value>,
    pub ticket: Option<Value>,
    pub change_summary: Option<String>,
    pub expected_version: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_integrations::playbook_runtime::tests::pipeline_runtime;
    use crate::runtime::playbook_evaluation::tests::attach_agents;
    use crate::session_launch::AgentMcpRole;

    fn with_task_agent() -> (CoreRuntime, std::path::PathBuf, String) {
        let (mut runtime, root, project_id) = pipeline_runtime();
        attach_agents(&mut runtime, &root, &["implementer"]);
        runtime.mcp_authorizer.register(
            "implementer".into(),
            1,
            AgentMcpRole::Interactive,
            "implementer-token".into(),
        );
        (runtime, root, project_id)
    }

    fn open_as_project_manager(runtime: &mut CoreRuntime, project_id: &str) {
        let revision = runtime.state_revision();
        runtime
            .handle(
                "project.modeSet",
                json!({"projectId": project_id, "mode": "projectManager", "expectedRevision": revision}),
            )
            .unwrap();
    }

    #[test]
    fn only_project_manager_tasks_with_one_current_agent_are_reinvestigated() {
        let (mut runtime, root, project_id) = with_task_agent();
        assert!(
            runtime
                .project_manager_reinvestigation_task_ids()
                .is_empty()
        );
        assert!(matches!(
            runtime.request_task_reinvestigation("task-1", TaskReinvestigationReason::Requested),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.request_task_reinvestigation("missing", TaskReinvestigationReason::Requested),
            Err(CoreError::NotFound)
        ));
        open_as_project_manager(&mut runtime, &project_id);
        // Only Tasks of the active sprint are checked again.
        assert!(
            runtime
                .project_manager_reinvestigation_task_ids()
                .is_empty()
        );
        let board = runtime
            .handle(
                "projectManager.sprintCreate",
                json!({"projectId": project_id, "name": "Sprint 1", "state": "active"}),
            )
            .unwrap();
        let sprint_id = board["sprints"][0]["id"].as_str().unwrap().to_owned();
        for task_id in ["task-1", "task-2"] {
            runtime
                .handle(
                    "projectManager.taskTrackingSet",
                    json!({"taskId": task_id, "sprintId": sprint_id}),
                )
                .unwrap();
        }
        // task-1 has its one Agent; task-2 has none and is never asked.
        assert_eq!(
            runtime.project_manager_reinvestigation_task_ids(),
            ["task-1"]
        );
        assert!(matches!(
            runtime.request_task_reinvestigation("task-2", TaskReinvestigationReason::Scheduled),
            Err(CoreError::NotFound)
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_tasks_of_the_active_sprint_keep_an_agent_and_tasks_are_created_locally() {
        let (mut runtime, root, project_id) = with_task_agent();
        assert!(matches!(
            runtime.handle("projectManager.boardGet", json!({"projectId": project_id})),
            Err(CoreError::CapabilityDenied)
        ));
        open_as_project_manager(&mut runtime, &project_id);
        let board = runtime
            .handle(
                "projectManager.sprintCreate",
                json!({"projectId": project_id, "name": "Sprint 1"}),
            )
            .unwrap();
        let sprint_id = board["sprints"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(board["sprints"][0]["state"], "planned");
        for task_id in ["task-1", "task-2"] {
            runtime
                .handle(
                    "projectManager.taskTrackingSet",
                    json!({"taskId": task_id, "sprintId": sprint_id, "note": "Watch the release"}),
                )
                .unwrap();
        }
        // A planned sprint keeps no Agent: task-1's running one is stopped.
        let plan = runtime.project_manager_agent_reconciliation(&project_id);
        assert!(plan.start_task_ids.is_empty());
        assert_eq!(plan.stop_session_ids, ["implementer"]);

        runtime
            .handle(
                "projectManager.sprintUpdate",
                json!({"sprintId": sprint_id, "name": "Sprint 1", "state": "active"}),
            )
            .unwrap();
        let plan = runtime.project_manager_agent_reconciliation(&project_id);
        assert_eq!(plan.start_task_ids, ["task-2"]);
        assert!(plan.stop_session_ids.is_empty());
        assert!(matches!(
            runtime.handle(
                "projectManager.sprintCreate",
                json!({"projectId": project_id, "name": "Sprint 2", "state": "active"}),
            ),
            Err(CoreError::Store(_))
                | Err(CoreError::InvalidParams(_))
                | Err(CoreError::RevisionConflict)
        ));

        let created = runtime
            .handle(
                "projectManager.taskCreate",
                json!({
                    "projectId": project_id,
                    "title": "Restrict CORS origins",
                    "jiraUrl": "https://example.atlassian.net/browse/PAY-42",
                    "sprintId": sprint_id,
                    "developer": "Ada",
                    "jiraStatus": "In Progress",
                }),
            )
            .unwrap();
        let task_id = created["task"]["id"].as_str().unwrap().to_owned();
        assert_eq!(
            created["task"]["jira_url"],
            "https://example.atlassian.net/browse/PAY-42"
        );
        assert!(runtime.task_in_active_sprint(&task_id));
        assert!(matches!(
            runtime.handle(
                "projectManager.taskCreate",
                json!({"projectId": project_id, "title": "Again", "jiraUrl": "https://example.atlassian.net/browse/PAY-42"}),
            ),
            Err(CoreError::InvalidParams(field)) if field == "jiraUrl"
        ));

        let board = runtime
            .handle(
                "projectManager.sprintDelete",
                json!({"sprintId": sprint_id}),
            )
            .unwrap();
        assert!(board["sprints"].as_array().unwrap().is_empty());
        assert!(
            board["tracking"]
                .as_array()
                .unwrap()
                .iter()
                .all(|record| record["sprintId"].is_null())
        );
        assert!(!runtime.task_in_active_sprint(&task_id));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_developer_project_keeps_the_task_status_steward_only() {
        let (mut runtime, root, _) = with_task_agent();
        assert!(matches!(
            runtime.read_task_agent_status("implementer-token"),
            Err(CoreError::CapabilityDenied)
        ));
        let revision = runtime.state_revision();
        assert!(matches!(
            runtime.record_task_agent_status(
                "implementer-token",
                "Merged".into(),
                0,
                TaskAgentTicketUpdate::default(),
                1
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert_eq!(runtime.state_revision(), revision);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_project_manager_task_agent_replaces_its_own_task_status_under_a_revision_check() {
        let (mut runtime, root, project_id) = with_task_agent();
        open_as_project_manager(&mut runtime, &project_id);
        let read = runtime.read_task_agent_status("implementer-token").unwrap();
        assert_eq!(read["taskId"], "task-1");
        assert_eq!(read["statusMarkdown"], "");
        let revision = read["statusRevision"].as_u64().unwrap();

        let recorded = runtime
            .record_task_agent_status(
                "implementer-token",
                "## Observed\n- PR #42 merged (GitHub)".into(),
                revision,
                TaskAgentTicketUpdate {
                    tracking: Some(json!({
                        "developer": "Ada",
                        "jiraStatus": "In Review",
                        "environments": [{"name": "Staging", "state": "deployed", "detail": "v1.4"}],
                        "blockers": null,
                    })),
                    ticket: Some(json!({"description": "## Goal\n- Ship the CORS fix"})),
                    change_summary: Some("Staging runs v1.4".into()),
                    expected_version: Some(0),
                },
                1,
            )
            .unwrap();
        assert_eq!(recorded["status"], "recorded");
        let tracking = runtime.store.task_tracking("task-1").unwrap();
        assert_eq!(tracking.developer.as_deref(), Some("Ada"));
        assert_eq!(tracking.environments[0].name, "Staging");
        assert_eq!(
            runtime.read_task_agent_status("implementer-token").unwrap()["tracking"]["jiraStatus"],
            "In Review"
        );
        assert_eq!(recorded["statusRevision"], revision + 1);
        assert!(matches!(
            runtime.record_task_agent_status(
                "implementer-token",
                "Stale".into(),
                revision,
                TaskAgentTicketUpdate::default(),
                2
            ),
            Err(CoreError::RevisionConflict)
        ));
        assert!(matches!(
            runtime.record_task_agent_status("implementer-token", "  ".into(), revision + 1, TaskAgentTicketUpdate::default(), 3),
            Err(CoreError::InvalidParams(field)) if field == "statusMarkdown"
        ));
        let read = runtime.read_task_agent_status("implementer-token").unwrap();
        assert_eq!(
            read["statusMarkdown"],
            "## Observed\n- PR #42 merged (GitHub)"
        );

        // The Agent's ticket change is a version the project manager can
        // compare, overwrite only from the newest version, and restore.
        let versions = runtime
            .handle("projectManager.ticketVersions", json!({"taskId": "task-1"}))
            .unwrap();
        let versions = versions["versions"].as_array().unwrap();
        assert_eq!(
            versions.len(),
            2,
            "the original ticket and the Agent's update"
        );
        assert_eq!(versions[0]["author"], "agent");
        assert_eq!(versions[0]["summary"], "Staging runs v1.4");
        assert_eq!(
            versions[0]["content"]["brief"],
            "## Goal\n- Ship the CORS fix"
        );
        assert_eq!(versions[0]["content"]["developer"], "Ada");
        assert_eq!(versions[1]["number"], 1);
        assert_eq!(recorded["ticketVersion"], 2);
        assert!(matches!(
            runtime.handle(
                "projectManager.ticketSave",
                json!({"taskId": "task-1", "title": "Mine", "expectedVersion": 1}),
            ),
            Err(CoreError::RevisionConflict)
        ));
        let saved = runtime
            .handle(
                "projectManager.ticketSave",
                json!({"taskId": "task-1", "title": "CORS fix", "brief": "Mine", "note": "Ask QA", "expectedVersion": 2}),
            )
            .unwrap();
        assert_eq!(saved["version"], 3);
        assert_eq!(saved["board"]["tickets"][0]["author"], "projectManager");
        let restored = runtime
            .handle(
                "projectManager.ticketRestore",
                json!({"taskId": "task-1", "number": 2, "expectedVersion": 3}),
            )
            .unwrap();
        assert_eq!(restored["version"], 4);
        let task = runtime
            .store
            .tasks()
            .iter()
            .find(|task| task.id == "task-1")
            .unwrap();
        assert_eq!(task.brief.as_deref(), Some("## Goal\n- Ship the CORS fix"));
        assert_eq!(runtime.store.task_tracking("task-1").unwrap().note, None);
        assert_eq!(
            runtime
                .store
                .task_ticket_head("task-1")
                .unwrap()
                .summary
                .as_deref(),
            Some("Restored version 2")
        );

        // A Session that is not the Task's Agent cannot speak for any Task.
        runtime.mcp_authorizer.register(
            "stranger".into(),
            1,
            AgentMcpRole::Interactive,
            "stranger-token".into(),
        );
        assert!(runtime.read_task_agent_status("stranger-token").is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
