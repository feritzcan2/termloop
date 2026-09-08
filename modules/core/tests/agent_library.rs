use serde_json::{Value, json};
use termloop_core::{CoreError, CoreRuntime};
use termloop_domain::{
    AgentLaunchSelection, PersonalAgent, ProcessDescriptor, ResumeProvider, ResumeRef, SessionKind,
    SessionRecord,
};
use termloop_store::Store;
use termloop_terminal::TerminalService;
use uuid::Uuid;

fn draft(revision: u64) -> Value {
    json!({"name":"Release reviewer", "description":"Review release changes", "category":"Quality",
        "instructions":"İncele; preserve literal {{prompt}} text.", "agentId":"claude", "model":"default",
        "permission":"plan", "reasoning":"high", "expectedRevision":revision})
}

#[test]
fn personal_agent_library_is_durable_versioned_and_preview_pins_instructions() {
    let root = std::env::temp_dir().join(format!("termloop-agent-library-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&path).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo", "folderPath":root}))
        .unwrap();
    let initial = runtime.handle("agent.libraryGet", json!({})).unwrap();
    assert_eq!(initial["profiles"].as_array().unwrap().len(), 4);
    let created = runtime.handle("agent.profileCreate", draft(0)).unwrap();
    let id = created["profiles"][4]["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("custom.agent-profile."));
    assert!(matches!(
        runtime.handle("agent.profileCreate", draft(0)),
        Err(CoreError::RevisionConflict)
    ));
    let mut invalid = draft(1);
    invalid["instructions"] = json!(" ");
    assert!(runtime.handle("agent.profileCreate", invalid).is_err());
    let mut builtin_edit = draft(1);
    builtin_edit["id"] = json!("builtin.agent-profile.unknown");
    assert!(runtime.handle("agent.profileUpdate", builtin_edit).is_err());
    runtime
        .handle(
            "agent.profileFavorite",
            json!({"id":id, "favorite":true, "expectedRevision":1}),
        )
        .unwrap();
    let params = json!({"projectId":project["id"], "cwd":root, "agentId":"claude", "model":"default",
        "permission":"plan", "reasoning":"high", "templateRef":id, "bindings":{"prompt":"Inspect changes"}, "attachments":[]});
    let preview = runtime.preview_quick_action(params.clone()).unwrap();
    let mut edit = draft(2);
    edit["id"] = json!(id);
    edit["instructions"] = json!("Changed instructions for new sessions.");
    let updated = runtime.handle("agent.profileUpdate", edit).unwrap();
    assert_eq!(updated["profiles"][4]["version"], 2);
    assert_eq!(updated["profiles"][4]["favorite"], true);
    let mut launch_params = params.clone();
    launch_params["launchTicket"] = preview["launch_ticket"].clone();
    let plan = runtime.take_quick_action_launch(launch_params).unwrap();
    let pinned = PersonalAgent {
        id: id.clone(),
        version: 1,
        name: "Release reviewer".into(),
        description: "Review release changes".into(),
        category: "Quality".into(),
        instructions: draft(0)["instructions"].as_str().unwrap().into(),
        agent_id: "claude".into(),
        selection: AgentLaunchSelection::new("default", "plan", "high"),
    };
    assert_eq!(pinned.version, 1);
    let instructions = preview["manifest"]["content_parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| part["kind"] == "providerInstructions")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(instructions.contains(&pinned.instructions));
    assert!(instructions.contains(&id));
    assert!(!instructions.contains("Changed instructions"));
    let session = SessionRecord {
        launch_selection: pinned.selection.clone(),
        id: "personal-session".into(),
        project_id: project["id"].as_str().unwrap().into(),
        name: Some(pinned.name.clone()),
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: root.to_string_lossy().into_owned(),
            agent_id: Some("claude".into()),
            template_ref: Some("builtin.agent.personal".into()),
            template_version: Some(1),
        },
        lifecycle_state: "exited".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: ResumeRef::for_provider(ResumeProvider::Claude, Uuid::new_v4().to_string()),
        resume_launch_guard: None,
        resume_failure: None,
    };

    runtime
        .handle(
            "agent.profileDelete",
            json!({"id":id, "expectedRevision":3}),
        )
        .unwrap();
    assert!(runtime.plan_quick_action_launch(params).is_err());
    drop(plan);
    drop(runtime);
    let mut store = Store::open(&path).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    store
        .insert_personal_agent_session(&authority, session, pinned.clone(), true)
        .unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.agent_library().agents.len(), 0);
    assert!(store.agent_library().favorites.is_empty());
    assert_eq!(
        store.session_agent_profile("personal-session"),
        Some(&pinned)
    );
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap();
    runtime.configure_agent_observations(termloop_core::AgentObservationTransport {
        endpoint: "http://127.0.0.1:4567/hooks".into(),
        provider_process_directory: root.clone(),
        agents: std::collections::HashMap::from([(
            "claude".into(),
            termloop_core::AgentRuntimeCapabilities {
                observation: termloop_core::AgentObservationRuntimeTransport::None,
                fresh_session_id_supported: true,
                resume_supported: true,
                native_fork_supported: false,
                mcp_http_supported: false,
            },
        )]),
        mcp_endpoint: "http://127.0.0.1:4567/mcp".into(),
        claude_mcp_config_path: root.join("claude.json").to_string_lossy().into_owned(),
    });
    let resumed = runtime
        .preview_agent_resume(json!({"sessionId":"personal-session"}))
        .unwrap();
    let parts = resumed["manifest"]["content_parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["kind"], "providerInstructions");
    assert!(
        parts[0]["content"]
            .as_str()
            .unwrap()
            .contains(&pinned.instructions)
    );
    assert_eq!(resumed["manifest"]["target"]["permission"], "plan");
    drop(runtime);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn built_in_agent_edits_keep_identity_and_persist_effective_launch_settings() {
    let root = std::env::temp_dir().join(format!("termloop-builtin-agent-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut runtime = CoreRuntime::new(
        Store::open(&path).unwrap(),
        authority,
        TerminalService::default(),
        1,
    )
    .unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo", "folderPath":root}))
        .unwrap();
    let initial = runtime.handle("agent.libraryGet", json!({})).unwrap();
    let id = initial["profiles"][0]["id"].as_str().unwrap().to_owned();
    runtime
        .handle(
            "agent.profileFavorite",
            json!({"id":id, "favorite":true, "expectedRevision":0}),
        )
        .unwrap();
    let mut edit = draft(1);
    edit["id"] = json!(id);
    edit["model"] = json!("sonnet");
    edit["permission"] = json!("acceptEdits");
    let result = runtime.handle("agent.profileUpdate", edit.clone()).unwrap();
    assert_eq!(result["profiles"].as_array().unwrap().len(), 4);
    let saved = &result["profiles"][0];
    assert_eq!(saved["id"], id);
    assert_eq!(saved["source"], "builtIn");
    assert_eq!(
        saved["version"],
        initial["profiles"][0]["version"].as_u64().unwrap() + 1
    );
    assert_eq!(saved["name"], edit["name"]);
    assert_eq!(saved["description"], edit["description"]);
    assert_eq!(saved["category"], edit["category"]);
    assert_eq!(saved["instructions"], edit["instructions"]);
    assert_eq!(saved["default_agent_id"], "claude");
    assert_eq!(saved["default_model"], "sonnet");
    assert_eq!(saved["default_reasoning"], "high");
    assert_eq!(saved["permission"], "acceptEdits");
    assert_eq!(saved["read_only"], false);
    assert_eq!(saved["favorite"], true);
    assert!(matches!(
        runtime.handle("agent.profileUpdate", edit.clone()),
        Err(CoreError::RevisionConflict)
    ));
    let mut invalid = edit.clone();
    invalid["expectedRevision"] = json!(2);
    invalid["model"] = json!("unsupported-model");
    assert!(runtime.handle("agent.profileUpdate", invalid).is_err());
    assert!(
        runtime
            .handle(
                "agent.profileDelete",
                json!({"id":id, "expectedRevision":2})
            )
            .is_err()
    );
    drop(runtime);
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut runtime = CoreRuntime::new(
        Store::open(&path).unwrap(),
        authority,
        TerminalService::default(),
        2,
    )
    .unwrap();
    assert_eq!(
        runtime.handle("agent.libraryGet", json!({})).unwrap(),
        result
    );
    assert_eq!(runtime.agent_profile_list()[0]["name"], edit["name"]);
    let preview = runtime.preview_quick_action(json!({"projectId":project["id"], "cwd":root, "agentId":"claude", "model":"sonnet", "permission":"acceptEdits", "reasoning":"high", "templateRef":id, "bindings":{"prompt":"Inspect changes"}, "attachments":[]})).unwrap();
    assert_eq!(preview["manifest"]["target"]["permission"], "acceptEdits");
    assert_eq!(preview["manifest"]["target"]["model"], "sonnet");
    let instructions = preview["manifest"]["content_parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| part["kind"] == "providerInstructions")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(instructions.contains(edit["instructions"].as_str().unwrap()));
    assert!(instructions.contains(&id));
    edit["expectedRevision"] = json!(2);
    edit["instructions"] = json!("A second revision");
    assert_eq!(
        runtime.handle("agent.profileUpdate", edit).unwrap()["profiles"][0]["version"],
        initial["profiles"][0]["version"].as_u64().unwrap() + 2
    );
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}
