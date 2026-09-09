use super::{AgentLaunchPlan, WorkflowLaunch};
use crate::{CoreError, CoreRuntime, required_string};
use serde_json::{Value, json};
use termloop_domain::WorkflowExecutionPhase;

impl CoreRuntime {
    pub fn preview_project_workflow_launch(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let workflow_id = required_string(&params, "workflowId")?;
        let goal = required_string(&params, "goal")?;
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .ok_or(CoreError::NotFound)?;
        let configuration = self.workflow_configuration(&workflow_id)?;
        if configuration.project_id != project_id {
            return Err(CoreError::NotFound);
        }
        self.validate_workflow_agent_profiles(&configuration.steps)?;
        let execution_id = termloop_platform::generate_opaque_id();
        termloop_invocation::project_workflow_step_prompt(
            &execution_id,
            &project.name,
            &goal,
            &configuration,
            0,
            1,
        )
        .map_err(|_| CoreError::InvalidParams("goal".into()))?;
        let mut plan = self.plan_agent_launch(json!({
            "projectId": project_id,
            "cwd": project.folder_path,
            "agentId": configuration.coordinator_agent_id,
            "model": configuration.launch_selection.model,
            "permission": configuration.launch_selection.permission,
            "reasoning": configuration.launch_selection.reasoning,
        }))?;
        plan.workflow_launch = Some(WorkflowLaunch {
            execution_id,
            task_id: None,
            title: project.name.clone(),
            brief: None,
            jira_url: None,
            goal,
            configuration,
        });
        self.revalidate_workflow_launch(&plan)?;
        self.cache_agent_launch_preview(plan)
    }

    pub(super) fn revalidate_workflow_launch(
        &self,
        plan: &AgentLaunchPlan,
    ) -> Result<(), CoreError> {
        let Some(workflow) = &plan.workflow_launch else {
            return Ok(());
        };
        if self.workflow_configuration(&workflow.configuration.id)? != workflow.configuration {
            return Err(CoreError::RevisionConflict);
        }
        if workflow.task_id.is_none() {
            let project = self
                .store
                .projects()
                .iter()
                .find(|project| project.id == plan.project_id)
                .ok_or(CoreError::NotFound)?;
            if plan.task_guard.is_some()
                || project.folder_path != plan.cwd
                || project.name != workflow.title
            {
                return Err(CoreError::RevisionConflict);
            }
        }
        if self.store.workflow_executions().iter().any(|execution| {
            execution.project_id == plan.project_id
                && execution.task_id == workflow.task_id
                && execution.phase != WorkflowExecutionPhase::Completed
        }) {
            return Err(match &workflow.task_id {
                Some(task_id) => CoreError::WorkflowExecutionActive {
                    task_id: task_id.clone(),
                },
                None => CoreError::ProjectWorkflowExecutionActive {
                    project_id: plan.project_id.clone(),
                },
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_store::Store;
    use termloop_terminal::TerminalService;

    struct Fixture {
        runtime: CoreRuntime,
        root: std::path::PathBuf,
        params: Value,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "termloop-project-workflow-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let mut runtime = CoreRuntime::new(
                Store::open(root.join("state.json")).unwrap(),
                termloop_store::issue_core_write_authority_for_composition(),
                TerminalService::default(),
                1,
            )
            .unwrap();
            let project = runtime
                .handle(
                    "project.create",
                    json!({"name": "Project fixture", "folderPath": root}),
                )
                .unwrap();
            let configuration = runtime.handle("workflow.configurationCreate", json!({
                "projectId": project["id"], "name": "Build and review", "coordinatorAgentId": "codex",
                "model": "default", "permission": "acceptEdits", "reasoning": "default", "maxReviewCycles": 2,
                "steps": [
                    {"id":"implement", "kind":"implement", "title":"Implement", "instructions":"Build and verify."},
                    {"id":"review", "kind":"review", "title":"Review", "instructions":"Review the changes.", "agentId":"claude", "model":"default", "permission":"plan", "reasoning":"default"}
                ],
                "expectedRevision": runtime.state_revision(),
            })).unwrap();
            Self {
                runtime,
                root,
                params: json!({"projectId": project["id"], "workflowId": configuration["configuration"]["id"], "goal": "Ship without creating a Task"}),
            }
        }

        fn preview(&mut self) -> Value {
            self.runtime
                .preview_project_workflow_launch(self.params.clone())
                .unwrap()
        }

        fn launch_params(&self, preview: &Value) -> Value {
            let mut params = self.params.clone();
            params["launchTicket"] = preview["launch_ticket"].clone();
            params
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn project_workflow_preview_binds_the_checkout_and_never_creates_a_task() {
        let mut f = Fixture::new();
        let revision = f.runtime.state_revision();
        let preview = f.preview();
        assert_eq!(f.runtime.state_revision(), revision);
        assert!(f.runtime.store.tasks().is_empty());
        assert!(f.runtime.store.workflow_executions().is_empty());
        assert_eq!(
            preview["manifest"]["provenance"]["template_ref"],
            "builtin.agent.project-workflow"
        );
        let params = f.launch_params(&preview);
        let plan = f.runtime.take_agent_launch(params.clone()).unwrap();
        assert_eq!(plan.cwd, f.runtime.store.projects()[0].folder_path);
        assert!(plan.task_guard.is_none());
        assert!(plan.workflow_launch.as_ref().unwrap().task_id.is_none());
        let payload = plan.prepared_launch.as_ref().unwrap();
        assert_eq!(
            serde_json::to_value(payload.inspectable_manifest()).unwrap(),
            preview["manifest"]
        );
        assert!(
            payload
                .initial_input()
                .unwrap()
                .contains("Project: Project fixture")
        );
        assert!(!payload.initial_input().unwrap().contains("Task:"));
        assert!(matches!(
            f.runtime.take_agent_launch(params),
            Err(CoreError::InvalidParams(_))
        ));
    }

    #[test]
    fn workflow_ticket_rejects_wrong_scope_goal_and_project() {
        let mut f = Fixture::new();
        for (key, value) in [
            ("taskId", "fake-task"),
            ("goal", "changed"),
            ("projectId", "other"),
        ] {
            let preview = f.preview();
            let mut params = f.launch_params(&preview);
            params[key] = json!(value);
            assert!(matches!(
                f.runtime.take_agent_launch(params),
                Err(CoreError::InvalidParams(_))
            ));
        }
        let mut params = f.params.clone();
        params["projectId"] = json!("other");
        assert!(matches!(
            f.runtime.preview_project_workflow_launch(params),
            Err(CoreError::NotFound)
        ));
        let mut params = f.params.clone();
        params["goal"] = json!("   ");
        assert!(matches!(
            f.runtime.preview_project_workflow_launch(params),
            Err(CoreError::InvalidParams(_))
        ));
    }

    #[test]
    fn changed_template_or_project_checkout_invalidates_preview_and_prepared_launch() {
        let mut f = Fixture::new();
        let preview = f.preview();
        let plan = f
            .runtime
            .take_agent_launch(f.launch_params(&preview))
            .unwrap();
        let preview = f.preview();
        let mut configuration = f
            .runtime
            .workflow_configuration(f.params["workflowId"].as_str().unwrap())
            .unwrap();
        configuration.generation += 1;
        f.runtime
            .store
            .set_workflow_configuration(
                &f.runtime.write_authority,
                configuration,
                f.runtime.state_revision(),
            )
            .unwrap();
        assert!(matches!(
            f.runtime.take_agent_launch(f.launch_params(&preview)),
            Err(CoreError::RevisionConflict)
        ));
        assert!(matches!(
            f.runtime.revalidate_workflow_launch(&plan),
            Err(CoreError::RevisionConflict)
        ));

        let preview = f.preview();
        let project_id = f.params["projectId"].as_str().unwrap().to_owned();
        f.runtime
            .handle(
                "project.updateDetails",
                json!({"projectId": project_id, "name": "Renamed", "folderPath": f.root}),
            )
            .unwrap();
        assert!(matches!(
            f.runtime.take_agent_launch(f.launch_params(&preview)),
            Err(CoreError::RevisionConflict)
        ));
    }
}
