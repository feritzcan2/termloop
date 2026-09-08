use serde_json::{Value, json};
use termloop_domain::{ImproverSessionTarget, ImproverSessionTargetKind};

use super::{
    AgentLaunchPlan, AgentMcpRole, McpPrincipal, interactive_agent_options, invocation_error,
    preview_transport_bindings,
};
use crate::{CoreError, CoreRuntime, required_string};

const TEMPLATE: &str = "builtin.builder.agent";

impl CoreRuntime {
    pub fn preview_agent_creator(&mut self, params: Value) -> Result<Value, CoreError> {
        if params.get("templateRef").and_then(Value::as_str) != Some(TEMPLATE) {
            return Err(CoreError::InvalidParams("templateRef".into()));
        }
        let project_id = required_string(&params, "projectId")?;
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let agent_id = required_string(&params, "agentId")?;
        if !matches!(agent_id.as_str(), "claude" | "codex") {
            return Err(CoreError::AgentUnsupported);
        }
        let selection = interactive_agent_options(&params, &agent_id)?
            .ok_or_else(|| CoreError::InvalidParams("agent launch options".into()))?;
        let mut plan = self.plan_agent_launch(json!({
            "projectId": project_id, "cwd": project.folder_path, "agentId": agent_id,
        }))?;
        if !plan
            .observation_transport
            .as_ref()
            .is_some_and(|transport| transport.mcp_http_supported(&agent_id))
        {
            return Err(CoreError::AgentCapabilityUnproven);
        }
        plan.mcp_role = AgentMcpRole::Improver {
            target: ImproverSessionTarget {
                target_kind: ImproverSessionTargetKind::AgentCreator,
                target_id: None,
            },
        };
        plan.set_account(self.resolve_agent_account(&agent_id, params["accountId"].as_str())?);
        plan.interactive_options = Some(selection.clone());
        plan.improver_session_name = Some("Agent Creator".into());
        let (observation, mcp) = preview_transport_bindings(&plan);
        let launch = termloop_invocation::improver_agent(
            &plan.agent_id,
            &plan.cwd,
            &selection.model,
            &selection.permission,
            &selection.reasoning,
            termloop_invocation::ImproverTarget::AgentCreator {
                project_name: &project.name,
            },
            termloop_invocation::AgentConversationLaunch::Fresh {
                resume_ref: plan.resume_ref.as_ref(),
            }
            .in_account(plan.account.as_ref()),
            observation,
            mcp,
        )
        .map_err(invocation_error)?;
        let delivered = launch
            .delivered_prompt()
            .expect("creator prompt")
            .to_owned();
        let manifest = launch.inspectable_manifest().clone();
        plan.prepared_launch = Some(launch);
        self.cache_quick_action_preview(plan, manifest, delivered)
    }

    pub fn take_agent_creator_launch(
        &mut self,
        params: Value,
    ) -> Result<AgentLaunchPlan, CoreError> {
        let plan = self.take_improver_ticket(&params)?;
        if !plan.mcp_role.is_agent_creator() {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        Ok(plan)
    }

    fn require_agent_creator(&self, principal: &McpPrincipal) -> Result<(), CoreError> {
        let valid = principal.role().is_agent_creator()
            && principal.runtime_epoch() == self.runtime_epoch
            && self.store.sessions().iter().any(|session| {
                session.id == principal.session_id()
                    && session.runtime_epoch == self.runtime_epoch
                    && session.lifecycle_state == "running"
                    && session.process.template_ref.as_deref() == Some(TEMPLATE)
                    && session.improver_target.as_ref().is_some_and(|target| {
                        target.target_kind == ImproverSessionTargetKind::AgentCreator
                            && target.target_id.is_none()
                    })
            });
        if valid {
            Ok(())
        } else {
            Err(CoreError::CapabilityDenied)
        }
    }

    pub fn read_agent_creator_library(&self, principal: &McpPrincipal) -> Result<Value, CoreError> {
        self.require_agent_creator(principal)?;
        let mut library = self.agent_library_get()?;
        // Summaries avoid returning up to 2 MiB of unrelated agent instructions
        // through the bounded MCP text response.
        for profile in library["profiles"]
            .as_array_mut()
            .expect("library profiles")
        {
            profile
                .as_object_mut()
                .expect("profile object")
                .remove("instructions");
        }
        let providers: Vec<Value> = termloop_agents::agent_catalog()
            .iter()
            .filter(|agent| matches!(agent.id, "claude" | "codex"))
            .map(|agent| {
                json!({ "agentId": agent.id, "models": agent.models,
                "permissions": agent.permissions, "reasoning": agent.reasoning })
            })
            .collect();
        Ok(json!({ "library": library, "providers": providers }))
    }

    pub fn create_agent_from_creator(
        &mut self,
        principal: &McpPrincipal,
        params: Value,
    ) -> Result<Value, CoreError> {
        self.require_agent_creator(principal)?;
        let library = self.create_agent_profile(params)?;
        let profile = library["profiles"]
            .as_array()
            .and_then(|profiles| profiles.last())
            .ok_or(CoreError::NotFound)?;
        Ok(json!({ "id": profile["id"], "name": profile["name"], "revision": library["revision"] }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
    use termloop_store::Store;
    use termloop_terminal::TerminalService;

    fn runtime() -> (CoreRuntime, String, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("termloop-agent-creator-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = CoreRuntime::new(
            Store::open(root.join("state.json")).unwrap(),
            termloop_store::issue_core_write_authority_for_composition(),
            TerminalService::default(),
            7,
        )
        .unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({"name":"Creator project","folderPath":root}),
            )
            .unwrap();
        runtime.configure_agent_observations(crate::test_agent_observation_transport(
            root.join("provider"),
        ));
        (runtime, project["id"].as_str().unwrap().into(), root)
    }

    fn selection(project: &str) -> Value {
        json!({"projectId":project,"agentId":"claude","model":"sonnet","permission":"acceptEdits","reasoning":"high","templateRef":TEMPLATE})
    }

    #[test]
    fn creator_preview_pins_selection_and_rejects_retargeted_or_replayed_tickets() {
        let (mut runtime, project, root) = runtime();
        let params = selection(&project);
        let preview = runtime.preview_agent_creator(params.clone()).unwrap();
        assert!(
            preview["delivered_preview"]
                .as_str()
                .unwrap()
                .contains("Creator project")
        );
        assert!(
            preview["delivered_preview"]
                .as_str()
                .unwrap()
                .contains("agent_profile_create")
        );
        let mut launch = params.clone();
        launch["launchTicket"] = preview["launch_ticket"].clone();
        let plan = runtime.take_agent_creator_launch(launch.clone()).unwrap();
        assert!(plan.mcp_role.is_agent_creator());
        assert_eq!(plan.improver_session_name.as_deref(), Some("Agent Creator"));
        assert_eq!(
            serde_json::to_value(
                plan.prepared_launch
                    .as_ref()
                    .unwrap()
                    .inspectable_manifest()
            )
            .unwrap(),
            preview["manifest"]
        );
        assert!(runtime.take_agent_creator_launch(launch).is_err());
        for field in ["projectId", "model", "templateRef"] {
            let preview = runtime.preview_agent_creator(params.clone()).unwrap();
            let mut changed = params.clone();
            changed["launchTicket"] = preview["launch_ticket"].clone();
            changed[field] = json!("changed");
            assert!(runtime.take_agent_creator_launch(changed).is_err());
        }
        let mut unsupported = params;
        unsupported["agentId"] = json!("gemini");
        assert!(runtime.preview_agent_creator(unsupported).is_err());
        drop(plan);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creator_saves_durably_with_scoped_authority_and_library_revision() {
        let (mut runtime, project, root) = runtime();
        let preview = runtime.preview_agent_creator(selection(&project)).unwrap();
        let mut launch = selection(&project);
        launch["launchTicket"] = preview["launch_ticket"].clone();
        let plan = runtime.take_agent_creator_launch(launch).unwrap();
        let session = SessionRecord {
            id: "creator".into(),
            project_id: project.clone(),
            name: Some("Agent Creator".into()),
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: "claude".into(),
                args: vec![],
                cwd: root.to_string_lossy().into(),
                agent_id: Some("claude".into()),
                template_ref: Some(TEMPLATE.into()),
                template_version: Some(1),
            },
            launch_selection: plan.interactive_options.clone().unwrap(),
            lifecycle_state: "running".into(),
            runtime_epoch: 7,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: None,
            improver_target: super::super::improver_session_target(&plan),
            ask_to_continuation: None,
            resume_ref: None,
            resume_launch_guard: None,
            resume_failure: None,
        };
        runtime
            .store
            .insert_session(&runtime.write_authority, session)
            .unwrap();
        runtime.mcp_authorizer.register(
            "creator".into(),
            7,
            plan.mcp_role.clone(),
            "creator-token".into(),
        );
        let principal = runtime
            .mcp_authorizer
            .authenticate("creator-token")
            .unwrap();
        let read = runtime.read_agent_creator_library(&principal).unwrap();
        assert_eq!(read["providers"].as_array().unwrap().len(), 2);
        assert_eq!(read["library"]["revision"], 0);
        assert!(read["library"]["profiles"][0].get("instructions").is_none());
        let draft = json!({"name":"Release reviewer","description":"Review release changes","category":"Quality",
            "instructions":"İncele; preserve literal {{prompt}}.","agentId":"codex","model":"gpt-5.6-sol",
            "permission":"plan","reasoning":"high","expectedRevision":0});
        let created = runtime
            .create_agent_from_creator(&principal, draft.clone())
            .unwrap();
        assert!(
            created["id"]
                .as_str()
                .unwrap()
                .starts_with("custom.agent-profile.")
        );
        assert_eq!(created["revision"], 1);
        assert!(matches!(
            runtime.create_agent_from_creator(&principal, draft.clone()),
            Err(CoreError::RevisionConflict)
        ));
        let mut invalid = draft.clone();
        invalid["expectedRevision"] = json!(1);
        invalid["model"] = json!("unsupported");
        assert!(
            runtime
                .create_agent_from_creator(&principal, invalid)
                .is_err()
        );
        runtime.mcp_authorizer.register(
            "creator".into(),
            7,
            AgentMcpRole::Interactive,
            "ordinary-token".into(),
        );
        let ordinary = runtime
            .mcp_authorizer
            .authenticate("ordinary-token")
            .unwrap();
        assert!(matches!(
            runtime.read_agent_creator_library(&ordinary),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.create_agent_from_creator(&ordinary, draft.clone()),
            Err(CoreError::CapabilityDenied)
        ));
        runtime.mcp_authorizer.register(
            "creator".into(),
            6,
            plan.mcp_role.clone(),
            "stale-token".into(),
        );
        let stale = runtime.mcp_authorizer.authenticate("stale-token").unwrap();
        assert!(matches!(
            runtime.create_agent_from_creator(&stale, draft),
            Err(CoreError::CapabilityDenied)
        ));
        drop(plan);
        drop(runtime);
        let store = Store::open(root.join("state.json")).unwrap();
        assert_eq!(store.agent_library().agents.len(), 1);
        assert_eq!(
            store.agent_library().agents[0].instructions,
            "İncele; preserve literal {{prompt}}."
        );
        assert_eq!(
            store.sessions()[0]
                .improver_target
                .as_ref()
                .unwrap()
                .target_kind,
            ImproverSessionTargetKind::AgentCreator
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
