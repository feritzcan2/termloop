use serde_json::{Value, json};
use termloop_domain::{ImproverSessionTarget, ImproverSessionTargetKind};

use super::{AgentLaunchPlan, AgentMcpRole, interactive_agent_options, invocation_error, preview_transport_bindings};
use crate::{CoreError, CoreRuntime, required_string};

const TEMPLATE: &str = "builtin.builder.workflow";

pub(super) struct WorkflowCreatorLaunch {
    params: Value,
    context: String,
}

impl CoreRuntime {
    pub fn get_workflow_creator_draft(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) { return Err(CoreError::NotFound); }
        let target = ImproverSessionTarget { target_kind: ImproverSessionTargetKind::WorkflowDraft,
            target_id: nullable_id(&params, "workflowId")?.map(str::to_owned) };
        if let Some(id) = &target.target_id {
            if self.workflow_configuration(id)?.project_id != project_id { return Err(CoreError::NotFound); }
        }
        let version = self.store.active_configuration_version(&project_id, &target);
        let proposal: Option<Value> = version.map(|version| serde_json::from_str(&version.content)
            .map_err(|_| CoreError::InvalidParams("workflow proposal".into()))).transpose()?;
        Ok(json!({ "proposal": proposal, "versionId": version.map(|version| &version.id),
            "summary": version.map(|version| version.summary.as_str()).unwrap_or("") }))
    }

    fn workflow_creator_context(&self, params: &Value) -> Result<String, CoreError> {
        let project_id = required_string(params, "projectId")?;
        let project = self.store.projects().iter().find(|p| p.id == project_id).ok_or(CoreError::NotFound)?;
        let workflow_id = nullable_id(params, "workflowId")?;
        let configuration = workflow_id.map(|id| self.workflow_configuration(id)).transpose()?;
        if configuration.as_ref().is_some_and(|value| value.project_id != project_id) {
            return Err(CoreError::NotFound);
        }
        let task = nullable_id(params, "taskId")?.map(|id| {
            self.store.tasks().iter().find(|task| task.id == id && task.project_id == project_id)
                .map(|task| json!({ "title": task.title, "brief": task.brief }))
                .ok_or(CoreError::NotFound)
        }).transpose()?;
        let draft = params.get("draft").ok_or_else(|| CoreError::InvalidParams("draft".into()))?;
        if !draft.is_null() { self.validate_workflow_draft(draft)?; }
        let mut library = self.agent_library_get()?;
        for profile in library["profiles"].as_array_mut().expect("profiles") {
            profile.as_object_mut().expect("profile").remove("instructions");
        }
        let templates = self.store.workflow_configurations().iter()
            .filter(|workflow| workflow.project_id == project_id)
            .map(|workflow| json!({ "id": workflow.id, "name": workflow.name,
                "steps": workflow.steps.iter().map(|step| json!({ "kind": step.kind, "title": step.title })).collect::<Vec<_>>() }))
            .collect::<Vec<_>>();
        let providers = termloop_agents::agent_catalog().iter()
            .filter(|agent| matches!(agent.id, "claude" | "codex"))
            .map(|agent| json!({ "agentId": agent.id, "models": agent.models, "permissions": agent.permissions, "reasoning": agent.reasoning }))
            .collect::<Vec<_>>();
        Ok(json!({ "project": project.name, "task": task, "savedTemplates": templates,
            "sourceGeneration": configuration.as_ref().map(|value| value.generation),
            "savedTemplate": configuration.as_ref().map(crate::workflow::workflow_configuration_json),
            "editorDraft": draft, "agentLibrary": library, "providers": providers }).to_string())
    }

    pub fn preview_workflow_creator(&mut self, params: Value) -> Result<Value, CoreError> {
        if params.get("templateRef").and_then(Value::as_str) != Some(TEMPLATE) {
            return Err(CoreError::InvalidParams("templateRef".into()));
        }
        let context = self.workflow_creator_context(&params)?;
        let project_id = required_string(&params, "projectId")?;
        let cwd = self.store.projects().iter().find(|p| p.id == project_id).ok_or(CoreError::NotFound)?.folder_path.clone();
        let agent_id = required_string(&params, "agentId")?;
        if !matches!(agent_id.as_str(), "claude" | "codex") { return Err(CoreError::AgentUnsupported); }
        let selection = interactive_agent_options(&params, &agent_id)?
            .ok_or_else(|| CoreError::InvalidParams("agent launch options".into()))?;
        let mut plan = self.plan_agent_launch(json!({ "projectId": project_id, "cwd": cwd, "agentId": agent_id }))?;
        if !plan.observation_transport.as_ref().is_some_and(|transport| transport.mcp_http_supported(&agent_id)) {
            return Err(CoreError::AgentCapabilityUnproven);
        }
        plan.mcp_role = AgentMcpRole::Improver { target: ImproverSessionTarget {
            target_kind: ImproverSessionTargetKind::WorkflowDraft,
            target_id: nullable_id(&params, "workflowId")?.map(str::to_owned),
        }};
        plan.set_account(self.resolve_agent_account(&agent_id, params["accountId"].as_str())?);
        plan.interactive_options = Some(selection.clone());
        plan.improver_session_name = Some("Workflow Creator".into());
        let (observation, mcp) = preview_transport_bindings(&plan);
        let launch = termloop_invocation::improver_agent(
            &plan.agent_id, &plan.cwd, &selection.model, &selection.permission, &selection.reasoning,
            termloop_invocation::ImproverTarget::WorkflowCreator { context: &context },
            termloop_invocation::AgentConversationLaunch::Fresh { resume_ref: plan.resume_ref.as_ref() }.in_account(plan.account.as_ref()),
            observation, mcp,
        ).map_err(invocation_error)?;
        let delivered = launch.delivered_prompt().expect("creator prompt").to_owned();
        let manifest = launch.inspectable_manifest().clone();
        plan.prepared_launch = Some(launch);
        plan.workflow_creator = Some(WorkflowCreatorLaunch { params, context });
        self.cache_quick_action_preview(plan, manifest, delivered)
    }

    pub fn take_workflow_creator_launch(&mut self, mut params: Value) -> Result<AgentLaunchPlan, CoreError> {
        let plan = self.take_improver_ticket(&params)?;
        params.as_object_mut().ok_or_else(|| CoreError::InvalidParams("params".into()))?.remove("launchTicket");
        if plan.workflow_creator.as_ref().is_none_or(|creator| creator.params != params) {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        self.revalidate_workflow_creator(&plan)?;
        Ok(plan)
    }

    pub(super) fn revalidate_workflow_creator(&self, plan: &AgentLaunchPlan) -> Result<(), CoreError> {
        let Some(creator) = &plan.workflow_creator else { return Ok(()); };
        let project = self.store.projects().iter().find(|p| p.id == plan.project_id).ok_or(CoreError::NotFound)?;
        if project.folder_path != plan.cwd || self.workflow_creator_context(&creator.params)? != creator.context {
            return Err(CoreError::RevisionConflict);
        }
        Ok(())
    }
}

fn nullable_id<'a>(params: &'a Value, name: &str) -> Result<Option<&'a str>, CoreError> {
    match params.get(name) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 128 => Ok(Some(value)),
        _ => Err(CoreError::InvalidParams(name.into())),
    }
}
