use super::*;
use termloop_domain::{
    AgentLaunchSelection, AskToContinuation, PersonalAgent, ProcessDescriptor, ProjectRecord,
    SessionKind, SessionRecord,
};

#[test]
fn profiled_helper_session_pins_the_agent_library_snapshot() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-profiled-helper-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: "/tmp/project-1".into(),
            },
        )
        .unwrap();
    store
        .insert_session(&authority, session("source", "builtin.agent.interactive"))
        .unwrap();

    let selection = AgentLaunchSelection::new("default", "plan", "high");
    let mut helper = session("helper", "builtin.agent.ask-to-helper");
    helper.launch_selection = selection.clone();
    helper.ask_to_source_session_id = Some("source".into());
    helper.ask_to_continuation = Some(AskToContinuation {
        conversation_id: "conversation-1".into(),
        current_request_id: Some("request-1".into()),
    });
    let profile = PersonalAgent {
        id: "builtin.agent-profile.edge-case-hunter".into(),
        version: 2,
        name: "Edge Case Hunter".into(),
        description: "Probe boundary conditions and failure paths.".into(),
        category: "Quality".into(),
        instructions: "Inspect the change for edge cases.".into(),
        agent_id: "codex".into(),
        selection,
    };
    store
        .insert_personal_agent_session(&authority, helper, profile.clone(), false)
        .unwrap();
    drop(store);

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.session_agent_profile("helper"), Some(&profile));
    let _ = std::fs::remove_file(path);
}

fn session(id: &str, template_ref: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        project_id: "project-1".into(),
        name: None,
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "codex".into(),
            args: vec![],
            cwd: "/tmp/project-1".into(),
            agent_id: Some("codex".into()),
            template_ref: Some(template_ref.into()),
            template_version: Some(2),
        },
        launch_selection: AgentLaunchSelection::default(),
        lifecycle_state: "running".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: None,
        resume_launch_guard: None,
        resume_failure: None,
    }
}
