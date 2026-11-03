use serde_json::json;
use termloop_domain::{ProcessDescriptor, ResumeProvider, ResumeRef, SessionKind, SessionRecord};
use termloop_store::Store;
use termloop_terminal::TerminalService;
use uuid::Uuid;

use crate::{CoreError, CoreRuntime};

struct Fixture {
    root: std::path::PathBuf,
    source: std::path::PathBuf,
    chosen: std::path::PathBuf,
    terminal: TerminalService,
    runtime: CoreRuntime,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.terminal.terminate("agent");
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fixture(archived: bool) -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-restore-folder-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let root = {
        std::fs::create_dir_all(&root).unwrap();
        std::fs::canonicalize(root).unwrap()
    };
    let project = root.join("repo");
    let source = root.join("elsewhere");
    let chosen = root.join("chosen");
    for folder in [&project, &source, &chosen] {
        std::fs::create_dir_all(folder).unwrap();
    }
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(root.join("state.json")).unwrap();
    store
        .insert_project(
            &authority,
            termloop_domain::ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: project.display().to_string(),
            },
        )
        .unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "agent".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: source.display().to_string(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 3,
                archived_at_epoch_ms: archived.then_some(1),
                ask_to_source_session_id: None,
                fork_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 4).unwrap();
    if !archived {
        runtime
            .close_session(json!({ "sessionId": "agent" }))
            .unwrap();
    }
    Fixture {
        root,
        source,
        chosen,
        terminal,
        runtime,
    }
}

#[test]
fn deleted_agent_restores_in_a_user_chosen_folder() {
    let mut fixture = fixture(false);
    let chosen = fixture.chosen.display().to_string();
    let observed = fixture
        .runtime
        .plan_deleted_session_restore(json!({ "sessionId": "agent", "cwd": chosen }))
        .unwrap()
        .observe(fixture.terminal.clone())
        .unwrap();
    let restored = fixture
        .runtime
        .apply_deleted_session_restore(observed)
        .unwrap();
    assert_eq!(restored["process"]["cwd"], chosen);
    assert_eq!(fixture.runtime.store.sessions()[0].process.cwd, chosen);
    assert!(fixture.runtime.store.deleted_sessions().is_empty());
}

#[test]
fn deleted_agent_refuses_a_missing_or_relative_folder_without_restoring() {
    let mut fixture = fixture(false);
    let missing = fixture.root.join("missing").display().to_string();
    let error = fixture
        .runtime
        .plan_deleted_session_restore(json!({ "sessionId": "agent", "cwd": missing }))
        .unwrap()
        .observe(fixture.terminal.clone())
        .unwrap_err();
    assert!(matches!(error, CoreError::InvalidParams(field) if field == "cwd"));
    let error = fixture
        .runtime
        .plan_deleted_session_restore(json!({ "sessionId": "agent", "cwd": "relative/folder" }))
        .unwrap_err();
    assert!(matches!(error, CoreError::InvalidParams(field) if field == "cwd"));
    assert!(!fixture.terminal.contains_session("agent").unwrap());
    assert_eq!(fixture.runtime.store.deleted_sessions().len(), 1);
}

#[test]
fn archived_agent_restores_in_a_user_chosen_folder() {
    let mut fixture = fixture(true);
    let chosen = fixture.chosen.display().to_string();
    let restored = fixture
        .runtime
        .handle(
            "session.restoreArchived",
            json!({ "sessionId": "agent", "cwd": chosen }),
        )
        .unwrap();
    assert_eq!(restored["process"]["cwd"], chosen);
    let session = &fixture.runtime.store.sessions()[0];
    assert_eq!(session.process.cwd, chosen);
    assert!(session.archived_at_epoch_ms.is_none());
}

#[test]
fn archived_agent_keeps_its_folder_and_archive_when_the_chosen_folder_is_missing() {
    let mut fixture = fixture(true);
    let missing = fixture.root.join("missing").display().to_string();
    let error = fixture
        .runtime
        .handle(
            "session.restoreArchived",
            json!({ "sessionId": "agent", "cwd": missing }),
        )
        .unwrap_err();
    assert!(matches!(error, CoreError::InvalidParams(field) if field == "cwd"));
    let session = &fixture.runtime.store.sessions()[0];
    assert_eq!(session.process.cwd, fixture.source.display().to_string());
    assert!(session.archived_at_epoch_ms.is_some());
}
