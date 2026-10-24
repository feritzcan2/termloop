//! The delivery facts of Project Manager Tasks as the board and delivery
//! checks read them, and the Project Manager's own corrections to them.

use serde_json::{Value, json};
use termloop_domain::{
    EnvironmentDeployState, FactSource, IssueLinkProvider, TASK_TRACKING_SHORT_MAX_CHARS,
    TaskDeliveryFacts, TaskRecord, TaskStatus,
};

use super::sprint::{bounded_text, optional_text};
use crate::{CoreError, CoreRuntime, required_string, store_error};

impl CoreRuntime {
    /// The Tasks TermLoop keeps facts for: the open Tasks of the Project's
    /// active sprint.
    pub(crate) fn project_manager_tracked_tasks(&self, project_id: &str) -> Vec<TaskRecord> {
        if !self.is_project_manager_project(project_id) {
            return Vec::new();
        }
        let mut tasks = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id && self.task_in_active_sprint(&task.id))
            .cloned()
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.rank);
        tasks
    }

    /// Everything a delivery check is told about one Task.
    pub(crate) fn delivery_check_task_json(&self, task: &TaskRecord) -> Value {
        let tracking = self.store.task_tracking(&task.id);
        json!({
            "taskId": task.id,
            "title": task.title,
            "description": task.brief,
            "jiraUrl": self
                .store
                .issue_links()
                .iter()
                .find(|link| link.task_id == task.id && link.provider == IssueLinkProvider::Jira)
                .and_then(|link| link.url.clone()),
            "jiraKey": self.task_jira_key(&task.id),
            "ticketVersion": self.store.task_ticket_head(&task.id).map(|head| head.number),
            "facts": facts_json(self.store.task_delivery_facts_for(&task.id), &task.id),
            "projectManager": {
                "developer": tracking.and_then(|record| record.developer.clone()),
                "blockers": tracking.and_then(|record| record.blockers.clone()),
                "note": tracking.and_then(|record| record.note.clone()),
            },
        })
    }

    /// The facts of every Task of a Project, for the board.
    pub(super) fn project_facts_json(&self, project_id: &str) -> Vec<Value> {
        self.store
            .task_delivery_facts()
            .iter()
            .filter(|facts| {
                self.store
                    .tasks()
                    .iter()
                    .any(|task| task.id == facts.task_id && task.project_id == project_id)
            })
            .map(|facts| facts_json(Some(facts), &facts.task_id))
            .collect()
    }

    /// The Project Manager states or corrects one environment of a Task, or
    /// removes it with `remove`.
    pub(crate) fn set_task_environment_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self.task_record(&task_id)?;
        self.ensure_project_manager_project(&task.project_id)?;
        let name = bounded_text(&params, "name", TASK_TRACKING_SHORT_MAX_CHARS)?
            .ok_or_else(|| CoreError::InvalidParams("name".into()))?;
        let mut facts = self
            .store
            .task_delivery_facts_for(&task.id)
            .cloned()
            .unwrap_or_else(|| TaskDeliveryFacts {
                task_id: task.id.clone(),
                ..TaskDeliveryFacts::default()
            });
        if params.get("remove").and_then(Value::as_bool) == Some(true) {
            if facts.environment(&name).is_none() {
                return Err(CoreError::NotFound);
            }
            facts
                .environments
                .retain(|environment| !environment.name.eq_ignore_ascii_case(&name));
        } else {
            let state = params
                .get("state")
                .cloned()
                .and_then(|state| serde_json::from_value::<EnvironmentDeployState>(state).ok())
                .ok_or_else(|| CoreError::InvalidParams("state".into()))?;
            let detail = bounded_text(&params, "detail", TASK_TRACKING_SHORT_MAX_CHARS)?;
            facts.observe_environment(
                &name,
                state,
                detail,
                FactSource::ProjectManager,
                termloop_platform::current_epoch_ms(),
            );
        }
        if !facts.is_valid() {
            return Err(CoreError::InvalidParams("environments".into()));
        }
        self.store
            .set_task_delivery_facts(&self.write_authority, vec![facts])
            .map_err(store_error)?;
        Ok(self.project_manager_board(&task.project_id))
    }

    /// The Tasks a requested delivery check covers: the named open Tasks of a
    /// Project Manager Project, or every tracked Task when none is named.
    pub(crate) fn delivery_check_scope(
        &self,
        project_id: &str,
        task_ids: Option<Vec<String>>,
    ) -> Result<Vec<String>, CoreError> {
        self.ensure_project_manager_project(project_id)?;
        let scope = match task_ids {
            Some(task_ids) => {
                for task_id in &task_ids {
                    let task = self.task_record(task_id)?;
                    if task.project_id != project_id
                        || task.status != TaskStatus::Open
                        || task.archived_at_epoch_ms.is_some()
                    {
                        return Err(CoreError::InvalidParams("taskIds".into()));
                    }
                }
                task_ids
            }
            None => self
                .project_manager_tracked_tasks(project_id)
                .into_iter()
                .map(|task| task.id)
                .collect(),
        };
        let mut scope = scope;
        scope.dedup();
        if scope.is_empty() {
            return Err(CoreError::InvalidParams("taskIds".into()));
        }
        scope.truncate(crate::runtime::delivery_check::MAX_CHECK_TASKS);
        Ok(scope)
    }

    /// The optional Task ID list of a check request.
    pub(crate) fn requested_check_task_ids(
        params: &Value,
    ) -> Result<Option<Vec<String>>, CoreError> {
        match params.get("taskIds") {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    optional_text(&json!({ "id": value }), "id")?
                        .ok_or_else(|| CoreError::InvalidParams("taskIds".into()))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            Some(_) => Err(CoreError::InvalidParams("taskIds".into())),
        }
    }
}

pub(crate) fn facts_json(facts: Option<&TaskDeliveryFacts>, task_id: &str) -> Value {
    let Some(facts) = facts else {
        return json!({
            "taskId": task_id,
            "jira": null,
            "pullRequests": null,
            "environments": [],
            "checkNotes": null,
            "readFailures": [],
        });
    };
    json!({
        "taskId": facts.task_id,
        "jira": facts.jira,
        "pullRequests": facts.pull_requests,
        "environments": facts.environments,
        "checkNotes": facts.check_notes,
        "readFailures": facts.read_failures,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use termloop_domain::{EnvironmentDeployState, FactSource};

    use crate::CoreError;

    #[test]
    fn the_project_manager_owns_the_ticket_and_settles_a_check_proposal() {
        let (mut runtime, root, project_id) =
            crate::runtime::delivery_check::tests::project_manager_runtime();
        let saved = runtime
            .handle(
                "projectManager.ticketSave",
                json!({"taskId": "task-1", "title": "Ship CORS fix", "brief": "## Goal\n- Restrict origins", "expectedVersion": 0}),
            )
            .unwrap();
        assert_eq!(saved["version"], 2, "the ticket as it was is version 1");
        runtime
            .store
            .set_task_ticket_proposal(
                &runtime.write_authority,
                termloop_domain::TaskTicketProposal {
                    task_id: "task-1".into(),
                    title: None,
                    brief: Some("## Goal\n- Restrict origins\n## Status\n- On staging".into()),
                    summary: "Staging runs v1.4".into(),
                    base_version: 2,
                    proposed_at_epoch_ms: 3,
                },
            )
            .unwrap();
        let board = runtime.project_manager_board(&project_id);
        assert_eq!(board["proposals"][0]["summary"], "Staging runs v1.4");
        // Accepting is checked against the newest version the Project Manager saw.
        assert!(matches!(
            runtime.handle(
                "projectManager.proposalAccept",
                json!({"taskId": "task-1", "expectedVersion": 1}),
            ),
            Err(CoreError::RevisionConflict)
        ));
        let accepted = runtime
            .handle(
                "projectManager.proposalAccept",
                json!({"taskId": "task-1", "expectedVersion": 2}),
            )
            .unwrap();
        assert_eq!(accepted["version"], 3);
        assert!(
            accepted["board"]["proposals"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(accepted["board"]["tickets"][0]["author"], "agent");
        let task = runtime.task_record("task-1").unwrap();
        assert_eq!(task.title, "Ship CORS fix", "an unproposed title stays");
        assert!(task.brief.unwrap().contains("On staging"));
        assert!(matches!(
            runtime.handle(
                "projectManager.proposalDismiss",
                json!({"taskId": "task-1"})
            ),
            Err(CoreError::NotFound)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_project_manager_states_corrects_and_removes_environments() {
        let (mut runtime, root, project_id) =
            crate::runtime::delivery_check::tests::project_manager_runtime();
        let board = runtime
            .handle(
                "projectManager.environmentSet",
                json!({"taskId": "task-1", "name": "Production", "state": "deployed", "detail": "Released Monday"}),
            )
            .unwrap();
        assert_eq!(board["projectId"], project_id.as_str());
        let facts = runtime.store.task_delivery_facts_for("task-1").unwrap();
        let production = facts.environment("production").unwrap();
        assert_eq!(production.state, EnvironmentDeployState::Deployed);
        assert_eq!(production.source, FactSource::ProjectManager);
        assert!(matches!(
            runtime.handle(
                "projectManager.environmentSet",
                json!({"taskId": "task-1", "name": "Production", "state": "live"}),
            ),
            Err(CoreError::InvalidParams(field)) if field == "state"
        ));
        runtime
            .handle(
                "projectManager.environmentSet",
                json!({"taskId": "task-1", "name": "production", "remove": true}),
            )
            .unwrap();
        assert!(runtime.store.task_delivery_facts_for("task-1").is_none());
        assert!(matches!(
            runtime.handle(
                "projectManager.environmentSet",
                json!({"taskId": "task-1", "name": "Production", "remove": true}),
            ),
            Err(CoreError::NotFound)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_the_open_tasks_of_the_active_sprint_are_tracked() {
        let (mut runtime, root, project_id) =
            crate::runtime::delivery_check::tests::project_manager_runtime();
        let tracked = |runtime: &crate::CoreRuntime| {
            runtime
                .project_manager_tracked_tasks(&project_id)
                .into_iter()
                .map(|task| task.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(tracked(&runtime), ["task-1", "task-2"]);
        runtime
            .handle(
                "projectManager.taskTrackingSet",
                json!({"taskId": "task-2", "sprintId": null, "note": "Next sprint"}),
            )
            .unwrap();
        assert_eq!(tracked(&runtime), ["task-1"]);
        assert_eq!(
            runtime
                .store
                .task_tracking("task-2")
                .unwrap()
                .note
                .as_deref(),
            Some("Next sprint")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
