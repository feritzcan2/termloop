//! Project-scoped workflow configuration commands.

use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde::Deserialize;
use serde_json::{Value, json};
use termloop_domain::{
    AgentLaunchSelection, WorkflowConfiguration, WorkflowExecution, WorkflowExecutionPhase,
    WorkflowStep,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowConfigurationInput {
    name: String,
    coordinator_agent_id: String,
    model: String,
    permission: String,
    reasoning: String,
    max_review_cycles: u8,
    steps: Vec<WorkflowStep>,
    expected_revision: u64,
}

impl CoreRuntime {
    pub(crate) fn list_workflow_configurations(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let configurations = self
            .store
            .workflow_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .map(workflow_configuration_json)
            .collect::<Vec<_>>();
        let executions = self
            .store
            .workflow_executions()
            .iter()
            .filter(|execution| execution.project_id == project_id)
            .map(|execution| workflow_execution_json(self, execution))
            .collect::<Vec<_>>();
        Ok(json!({
            "configurations": configurations,
            "executions": executions,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn create_workflow_configuration(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let input = parse_workflow_input(params)?;
        let configuration = WorkflowConfiguration {
            id: termloop_platform::generate_opaque_id(),
            project_id,
            name: input.name,
            coordinator_agent_id: input.coordinator_agent_id,
            launch_selection: AgentLaunchSelection::new(
                &input.model,
                &input.permission,
                &input.reasoning,
            ),
            max_review_cycles: input.max_review_cycles,
            steps: input.steps,
            generation: 1,
            updated_at_epoch_ms: termloop_platform::current_epoch_ms(),
        };
        let configuration = self
            .store
            .set_workflow_configuration(
                &self.write_authority,
                configuration,
                input.expected_revision,
            )
            .map_err(store_error)?;
        Ok(json!({
            "configuration": workflow_configuration_json(&configuration),
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn update_workflow_configuration(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let workflow_id = required_string(&params, "workflowId")?;
        let input = parse_workflow_input(params)?;
        let current = self
            .store
            .workflow_configurations()
            .iter()
            .find(|configuration| configuration.id == workflow_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let mut configuration = WorkflowConfiguration {
            id: current.id.clone(),
            project_id: current.project_id.clone(),
            name: input.name,
            coordinator_agent_id: input.coordinator_agent_id,
            launch_selection: AgentLaunchSelection::new(
                &input.model,
                &input.permission,
                &input.reasoning,
            ),
            max_review_cycles: input.max_review_cycles,
            steps: input.steps,
            generation: current.generation,
            updated_at_epoch_ms: current.updated_at_epoch_ms,
        };
        if configuration == current {
            if input.expected_revision != self.store.revision() {
                return Err(CoreError::RevisionConflict);
            }
            return Ok(json!({
                "configuration": workflow_configuration_json(&current),
                "stateRevision": self.store.revision(),
            }));
        }
        configuration.generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidParams("workflowId".into()))?;
        configuration.updated_at_epoch_ms = termloop_platform::current_epoch_ms();
        let configuration = self
            .store
            .set_workflow_configuration(
                &self.write_authority,
                configuration,
                input.expected_revision,
            )
            .map_err(store_error)?;
        Ok(json!({
            "configuration": workflow_configuration_json(&configuration),
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn delete_workflow_configuration(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let workflow_id = required_string(&params, "workflowId")?;
        let expected_revision = params
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))?;
        let deleted = self
            .store
            .delete_workflow_configuration(&self.write_authority, &workflow_id, expected_revision)
            .map_err(store_error)?;
        Ok(json!({
            "workflowId": deleted.id,
            "deleted": true,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn workflow_configuration(
        &self,
        workflow_id: &str,
    ) -> Result<WorkflowConfiguration, CoreError> {
        self.store
            .workflow_configurations()
            .iter()
            .find(|configuration| configuration.id == workflow_id)
            .cloned()
            .ok_or(CoreError::NotFound)
    }

    pub(crate) fn cancel_workflow_execution(&mut self, params: Value) -> Result<Value, CoreError> {
        let execution_id = required_string(&params, "executionId")?;
        let expected_revision = params
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))?;
        let removed = self
            .store
            .cancel_workflow_execution(&self.write_authority, &execution_id, expected_revision)
            .map_err(store_error)?;
        Ok(json!({
            "executionId": removed.id,
            "cancelled": true,
            "stateRevision": self.store.revision(),
        }))
    }
}

pub(crate) fn workflow_execution_json(
    runtime: &CoreRuntime,
    execution: &WorkflowExecution,
) -> Value {
    let coordinator_state = runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == execution.coordinator_session_id)
        .map(|session| session.lifecycle_state.as_str());
    let status = if execution.phase == WorkflowExecutionPhase::Completed {
        "completed"
    } else if matches!(coordinator_state, Some("running" | "resuming")) {
        "running"
    } else {
        "paused"
    };
    json!({
        "id": execution.id,
        "projectId": execution.project_id,
        "taskId": execution.task_id,
        "workflowId": execution.configuration.id,
        "workflowGeneration": execution.configuration.generation,
        "workflowName": execution.configuration.name,
        "goal": execution.goal,
        "coordinatorSessionId": execution.coordinator_session_id,
        "currentStepIndex": execution.current_step_index,
        "reviewCycle": execution.review_cycle,
        "maxReviewCycles": execution.configuration.max_review_cycles,
        "phase": execution.phase,
        "status": status,
        "steps": execution.configuration.steps,
        "participants": execution.participants.iter().map(|participant| json!({
            "stepId": participant.step_id,
            "sessionId": participant.helper_session_id,
        })).collect::<Vec<_>>(),
        "activeReviewStepIds": execution.review_requests.iter().map(|request| {
            request.step_id.clone()
        }).collect::<Vec<_>>(),
        "stepResults": execution.step_results,
        "startedAtEpochMs": execution.started_at_epoch_ms,
        "updatedAtEpochMs": execution.updated_at_epoch_ms,
    })
}

fn parse_workflow_input(mut params: Value) -> Result<WorkflowConfigurationInput, CoreError> {
    let object = params
        .as_object_mut()
        .ok_or_else(|| CoreError::InvalidParams("params".into()))?;
    object.remove("projectId");
    object.remove("workflowId");
    serde_json::from_value(params).map_err(|_| CoreError::InvalidParams("workflow".into()))
}

pub(crate) fn workflow_configuration_json(configuration: &WorkflowConfiguration) -> Value {
    json!({
        "id": configuration.id,
        "projectId": configuration.project_id,
        "name": configuration.name,
        "coordinatorAgentId": configuration.coordinator_agent_id,
        "model": configuration.launch_selection.model,
        "permission": configuration.launch_selection.permission,
        "reasoning": configuration.launch_selection.reasoning,
        "maxReviewCycles": configuration.max_review_cycles,
        "steps": configuration.steps,
        "generation": configuration.generation,
        "updatedAtEpochMs": configuration.updated_at_epoch_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Value {
        json!({
            "name": "Discuss, build, review",
            "coordinatorAgentId": "codex",
            "model": "default",
            "permission": "default",
            "reasoning": "default",
            "maxReviewCycles": 2,
            "steps": [
                {
                    "id": "discuss",
                    "kind": "discuss",
                    "title": "Discuss",
                    "instructions": "Challenge the approach.",
                    "agentId": "claude"
                },
                {
                    "id": "implement",
                    "kind": "implement",
                    "title": "Implement",
                    "instructions": "Implement and verify.",
                    "agentId": null
                }
            ],
            "expectedRevision": 0
        })
    }

    #[test]
    fn input_accepts_exact_create_or_update_identity() {
        let mut create = input();
        create["projectId"] = json!("project-1");
        assert!(parse_workflow_input(create).is_ok());

        let mut update = input();
        update["workflowId"] = json!("workflow-1");
        assert!(parse_workflow_input(update).is_ok());

        let mut unknown = input();
        unknown["surprise"] = json!(true);
        assert!(parse_workflow_input(unknown).is_err());
    }
}
