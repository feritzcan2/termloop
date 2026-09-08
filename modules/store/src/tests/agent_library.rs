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
    helper.launch_selection.account_id = Some(uuid::Uuid::new_v4().to_string());
    let resume_ref = termloop_domain::ResumeRef::for_provider(
        termloop_domain::ResumeProvider::Codex,
        "profiled-helper-thread".into(),
    )
    .unwrap();
    helper.resume_ref = Some(resume_ref.clone());
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
    let mut invalid = helper.clone();
    invalid.ask_to_continuation = None;
    assert!(matches!(
        store.insert_personal_agent_session(&authority, invalid, profile.clone(), false),
        Err(StoreError::ConstraintViolation)
    ));
    let mut invalid = helper.clone();
    invalid.launch_selection.permission = "default".into();
    assert!(matches!(
        store.insert_personal_agent_session(&authority, invalid, profile.clone(), false),
        Err(StoreError::ConstraintViolation)
    ));
    store
        .insert_personal_agent_session(&authority, helper, profile.clone(), false)
        .unwrap();
    drop(store);

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.session_agent_profile("helper"), Some(&profile));
    let mut live_selection = reopened
        .sessions()
        .iter()
        .find(|session| session.id == "helper")
        .unwrap()
        .launch_selection
        .clone();
    live_selection.permission = "default".into();
    reopened
        .update_running_agent_session_launch_selection(
            &authority,
            "helper",
            1,
            &resume_ref,
            &live_selection,
        )
        .unwrap();
    drop(reopened);

    let mut reopened =
        Store::open(&path).expect("live settings must not invalidate the pinned profile");
    assert_eq!(reopened.session_agent_profile("helper"), Some(&profile));
    assert_eq!(
        reopened
            .sessions()
            .iter()
            .find(|session| session.id == "helper")
            .unwrap()
            .launch_selection,
        live_selection
    );
    reopened.mark_session_exited(&authority, "source").unwrap();
    reopened
        .delete_session_descriptor(&authority, "source")
        .unwrap();
    drop(reopened);

    let mut reopened =
        Store::open(&path).expect("source retirement must not invalidate the helper profile");
    assert_eq!(reopened.session_agent_profile("helper"), Some(&profile));
    assert!(
        reopened
            .sessions()
            .iter()
            .find(|session| session.id == "helper")
            .unwrap()
            .ask_to_continuation
            .is_none()
    );
    reopened.mark_session_exited(&authority, "helper").unwrap();
    drop(reopened);
    let reopened =
        Store::open(&path).expect("helper retirement must preserve the profile snapshot");
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
