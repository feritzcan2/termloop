use super::*;
use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
use termloop_store::Store;
use termloop_terminal::TerminalService;

struct Fixture { runtime: CoreRuntime, project: String, root: std::path::PathBuf }

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("termloop-workflow-creator-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = CoreRuntime::new(Store::open(root.join("state.json")).unwrap(),
            termloop_store::issue_core_write_authority_for_composition(), TerminalService::default(), 7).unwrap();
        let project = runtime.handle("project.create", json!({ "name": "Creator project", "folderPath": root })).unwrap()["id"].as_str().unwrap().to_owned();
        runtime.configure_agent_observations(crate::test_agent_observation_transport(root.join("provider")));
        Self { runtime, project, root }
    }
    fn params(&self) -> Value {
        json!({ "projectId": self.project, "agentId": "claude", "model": "default", "permission": "default", "reasoning": "default",
            "templateRef": TEMPLATE, "workflowId": null, "taskId": null, "draft": null })
    }
    fn session(&mut self, workflow_id: Option<String>) -> ImproverSessionTarget {
        let target = ImproverSessionTarget { target_kind: ImproverSessionTargetKind::WorkflowDraft, target_id: workflow_id };
        self.runtime.store.insert_session(&self.runtime.write_authority, SessionRecord {
            id: "creator".into(), project_id: self.project.clone(), name: Some("Workflow Creator".into()), kind: SessionKind::Agent,
            process: ProcessDescriptor { program: "claude".into(), args: vec![], cwd: self.root.to_string_lossy().into(), agent_id: Some("claude".into()), template_ref: Some(TEMPLATE.into()), template_version: Some(1) },
            launch_selection: Default::default(), lifecycle_state: "running".into(), runtime_epoch: 7, archived_at_epoch_ms: None,
            ask_to_source_session_id: None, run_configuration_id: None, improver_target: Some(target.clone()), ask_to_continuation: None,
            resume_ref: None, resume_launch_guard: None, resume_failure: None,
        }).unwrap();
        target
    }
}

fn draft() -> Value {
    json!({ "name": "Implement safely", "coordinatorAgentId": "codex", "model": "default", "permission": "default", "reasoning": "default", "maxReviewCycles": 2,
        "steps": [{ "id": "implement", "kind": "implement", "title": "Implement", "instructions": "İsteği uygula. Preserve {{context}}.", "agentId": null, "reuseStepId": null, "profileRef": null, "model": null, "permission": null, "reasoning": null }] })
}

#[test]
fn preview_is_read_only_pins_context_and_consumes_exact_ticket_once() {
    let mut f = Fixture::new();
    let mut params = f.params(); params["draft"] = draft();
    let before = f.runtime.store.revision();
    let preview = f.runtime.preview_workflow_creator(params.clone()).unwrap();
    assert_eq!(f.runtime.store.revision(), before);
    assert!(f.runtime.store.sessions().is_empty());
    assert!(f.runtime.store.workflow_configurations().is_empty());
    assert!(preview["delivered_preview"].as_str().unwrap().contains("İsteği uygula. Preserve {{context}}."));
    let mut launch = params.clone(); launch["launchTicket"] = preview["launch_ticket"].clone();
    let plan = f.runtime.take_workflow_creator_launch(launch.clone()).unwrap();
    assert_eq!(plan.improver_session_name.as_deref(), Some("Workflow Creator"));
    assert_eq!(super::super::improver_session_target(&plan).unwrap().target_kind, ImproverSessionTargetKind::WorkflowDraft);
    assert_eq!(serde_json::to_value(plan.prepared_launch.as_ref().unwrap().inspectable_manifest()).unwrap(), preview["manifest"]);
    assert!(f.runtime.take_workflow_creator_launch(launch).is_err());
    for field in ["workflowId", "taskId", "projectId", "model", "permission", "templateRef", "draft"] {
        let preview = f.runtime.preview_workflow_creator(params.clone()).unwrap();
        let mut changed = params.clone(); changed["launchTicket"] = preview["launch_ticket"].clone(); changed[field] = json!("other");
        assert!(f.runtime.take_workflow_creator_launch(changed).is_err(), "{field}");
    }
    let mut invalid = params; invalid.as_object_mut().unwrap().remove("workflowId");
    assert!(f.runtime.preview_workflow_creator(invalid).is_err());
}

#[test]
fn draft_write_is_separate_durable_cas_state_never_a_template_or_execution() {
    let mut f = Fixture::new();
    let target = f.session(None);
    let content = json!({ "sourceGeneration": null, "workflow": draft() }).to_string();
    let plan = f.runtime.prepare_improver_configuration_write("creator", &target, None, content.clone(), "Initial proposal".into()).unwrap();
    let result = f.runtime.apply_owned_configuration_application(plan, crate::AssistantAvailability::Proven, 1).unwrap().result.unwrap();
    let id = result["activeVersion"]["id"].as_str().unwrap().to_owned();
    assert!(f.runtime.store.workflow_configurations().is_empty());
    assert!(f.runtime.store.workflow_executions().is_empty());
    assert!(matches!(f.runtime.prepare_improver_configuration_write("creator", &target, None, content.clone(), "stale".into()), Err(CoreError::RevisionConflict)));
    let mut next: Value = serde_json::from_str(&content).unwrap(); next["workflow"]["name"] = json!("Revised proposal");
    let plan = f.runtime.prepare_improver_configuration_write("creator", &target, Some(id), next.to_string(), "Revised".into()).unwrap();
    f.runtime.apply_owned_configuration_application(plan, crate::AssistantAvailability::Proven, 2).unwrap().result.unwrap();
    let read = f.runtime.get_workflow_creator_draft(json!({ "projectId": f.project, "workflowId": null })).unwrap();
    assert_eq!(read["proposal"]["workflow"]["name"], "Revised proposal");
    assert_eq!(read["summary"], "Revised");
    let saved = Store::open(f.root.join("state.json")).unwrap();
    assert_eq!(saved.configuration_versions().len(), 2);
    assert!(saved.workflow_configurations().is_empty());
    assert_eq!(saved.sessions()[0].improver_target.as_ref(), Some(&target));
    assert!(f.runtime.prepare_improver_configuration_write("missing", &target, None, content.clone(), "".into()).is_err());
    let stopped = f.runtime.store.mark_session_exited(&f.runtime.write_authority, "creator"); stopped.unwrap();
    assert!(matches!(f.runtime.read_improver_configuration_version("creator", &target), Err(CoreError::CapabilityDenied)));
}

#[test]
fn proposal_rejects_bad_graphs_settings_fields_and_stale_source_without_changing_template() {
    let mut f = Fixture::new();
    let mut create = draft(); create["projectId"] = json!(f.project); create["expectedRevision"] = json!(f.runtime.store.revision());
    let saved = f.runtime.create_workflow_configuration(create).unwrap()["configuration"].clone();
    let id = saved["id"].as_str().unwrap().to_owned();
    let target = f.session(Some(id.clone()));
    let content = json!({ "sourceGeneration": 1, "workflow": draft() });
    for (pointer, value) in [("/sourceGeneration", json!(2)), ("/workflow/model", json!("made-up")), ("/workflow/maxReviewCycles", json!(4)), ("/workflow/steps", json!([])), ("/workflow/steps/0/agentId", json!("claude")), ("/workflow/steps/0/instructions", json!("x".repeat(4097)))] {
        let mut bad = content.clone(); *bad.pointer_mut(pointer).unwrap() = value;
        assert!(f.runtime.prepare_improver_configuration_write("creator", &target, None, bad.to_string(), "".into()).is_err(), "{pointer}");
    }
    let mut bad = content.clone(); bad["workflow"]["steps"][0].as_object_mut().unwrap().remove("permission");
    assert!(f.runtime.prepare_improver_configuration_write("creator", &target, None, bad.to_string(), "".into()).is_err());
    let plan = f.runtime.prepare_improver_configuration_write("creator", &target, None, content.to_string(), "Proposal".into()).unwrap();
    f.runtime.apply_owned_configuration_application(plan, crate::AssistantAvailability::Proven, 1).unwrap().result.unwrap();
    assert_eq!(crate::workflow::workflow_configuration_json(&f.runtime.workflow_configuration(&id).unwrap()), saved);
    let mut update = draft(); update["name"] = json!("Changed elsewhere"); update["workflowId"] = json!(id); update["expectedRevision"] = json!(f.runtime.store.revision());
    f.runtime.update_workflow_configuration(update).unwrap();
    let read = f.runtime.get_workflow_creator_draft(json!({ "projectId": f.project, "workflowId": id })).unwrap();
    assert_eq!(read["proposal"]["sourceGeneration"], 1);
    assert!(matches!(f.runtime.prepare_improver_configuration_write("creator", &target, Some(read["versionId"].as_str().unwrap().into()), content.to_string(), "".into()), Err(CoreError::RevisionConflict)));
    f.runtime.delete_workflow_configuration(json!({ "workflowId": id, "expectedRevision": f.runtime.store.revision() })).unwrap();
    assert!(f.runtime.store.configuration_versions().is_empty());
}

#[test]
fn cross_project_context_and_changed_preview_fail_closed() {
    let mut f = Fixture::new();
    let mut params = f.params();
    let preview = f.runtime.preview_workflow_creator(params.clone()).unwrap();
    f.runtime.handle("project.rename", json!({ "projectId": f.project, "name": "Renamed", "expectedRevision": f.runtime.store.revision() })).unwrap();
    params["launchTicket"] = preview["launch_ticket"].clone();
    assert!(f.runtime.take_workflow_creator_launch(params).is_err());
    let other = f.runtime.handle("project.create", json!({ "name": "Other", "folderPath": f.root.join("other") })).unwrap();
    let mut create = draft(); create["projectId"] = other["id"].clone(); create["expectedRevision"] = json!(f.runtime.store.revision());
    let saved = f.runtime.create_workflow_configuration(create).unwrap();
    let mut params = f.params(); params["workflowId"] = saved["configuration"]["id"].clone();
    assert!(f.runtime.preview_workflow_creator(params.clone()).is_err());
    assert!(f.runtime.get_workflow_creator_draft(params).is_err());
}
