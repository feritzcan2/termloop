use super::*;
use serde_json::json;
use termloop_domain::{ProcessDescriptor, ResumeRef, SessionRecord};
use termloop_store::{Store, issue_core_write_authority_for_composition};
use termloop_terminal::TerminalService;

struct Fixture {
    core: CoreRuntime,
    path: std::path::PathBuf,
}

impl Fixture {
    fn new(modify: impl FnOnce(&mut SessionRecord)) -> Self {
        let path = std::env::temp_dir().join(format!(
            "termloop-codex-thread-name-{}.json",
            uuid::Uuid::new_v4()
        ));
        let mut core = CoreRuntime::new(
            Store::open(&path).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            7,
        )
        .unwrap();
        let mut session = SessionRecord {
            id: "codex-live".into(),
            project_id: "project-1".into(),
            name: Some("Previous name".into()),
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: "codex".into(),
                args: vec![],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                agent_id: Some("codex".into()),
                template_ref: None,
                template_version: None,
            },
            lifecycle_state: "running".into(),
            runtime_epoch: 7,
            launch_selection: Default::default(),
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: None,
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: Some(
                ResumeRef::for_provider(ResumeProvider::Codex, "thread-a".into()).unwrap(),
            ),
            resume_launch_guard: None,
            resume_failure: None,
        };
        modify(&mut session);
        core.store
            .insert_session(&core.write_authority, session)
            .unwrap();
        Self { core, path }
    }

    fn observe(&mut self, name: Option<&str>) -> Result<bool, CoreError> {
        self.core
            .record_codex_thread_name("codex-live", 7, observation(name))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn observation(name: Option<&str>) -> CodexThreadNameObservation {
    CodexThreadNameObservation {
        native_thread_id: "thread-a".into(),
        name: name.map(str::to_owned),
    }
}

#[test]
fn rename_is_persisted_projected_and_duplicate_events_do_not_write() {
    let mut fixture = Fixture::new(|_| {});
    assert!(fixture.observe(Some("steward için 🦀")).unwrap());
    let revision = fixture.core.state_revision();
    let stored_bytes = std::fs::read(&fixture.path).unwrap();
    let session = &fixture.core.store.sessions()[0];
    assert_eq!(
        fixture.core.project_session(session)["name"],
        "steward için 🦀"
    );
    assert_eq!(
        Store::open(&fixture.path).unwrap().sessions()[0]
            .name
            .as_deref(),
        Some("steward için 🦀")
    );
    for _ in 0..100 {
        assert!(!fixture.observe(Some("steward için 🦀")).unwrap());
    }
    assert_eq!(fixture.core.state_revision(), revision);
    assert_eq!(std::fs::read(&fixture.path).unwrap(), stored_bytes);
    assert!(fixture.core.agent_observations.is_empty());

    // Either rename surface remains usable; the next provider rename updates
    // the same current name, without introducing a second name or history.
    fixture
        .core
        .handle(
            "session.rename",
            json!({
                "sessionId": "codex-live", "name": "Sidebar name"
            }),
        )
        .unwrap();
    assert!(fixture.observe(Some("Next Codex name")).unwrap());
    assert!(fixture.observe(None).unwrap());
    assert!(!fixture.observe(None).unwrap());
    assert!(
        fixture
            .core
            .project_session(&fixture.core.store.sessions()[0])["name"]
            .is_null()
    );
}

#[test]
fn wrong_session_epoch_or_native_thread_cannot_rename() {
    let mut fixture = Fixture::new(|_| {});
    let revision = fixture.core.state_revision();
    for (session_id, epoch, thread) in [
        ("missing", 7, "thread-a"),
        ("codex-live", 6, "thread-a"),
        ("codex-live", 7, "thread-other"),
    ] {
        let mut name = observation(Some("Rejected"));
        name.native_thread_id = thread.into();
        assert!(matches!(
            fixture
                .core
                .record_codex_thread_name(session_id, epoch, name),
            Err(CoreError::CapabilityDenied)
        ));
    }
    assert_eq!(fixture.core.state_revision(), revision);
    assert_eq!(
        fixture.core.store.sessions()[0].name.as_deref(),
        Some("Previous name")
    );
}

#[test]
fn only_a_running_unarchived_codex_agent_with_matching_identity_is_eligible() {
    for case in [
        "shell",
        "claude",
        "exited",
        "resuming",
        "archived",
        "no-identity",
        "wrong-provider",
    ] {
        let mut fixture = Fixture::new(|session| match case {
            "shell" => session.kind = SessionKind::Terminal,
            "claude" => session.process.agent_id = Some("claude".into()),
            "exited" | "resuming" => session.lifecycle_state = case.into(),
            "archived" => session.archived_at_epoch_ms = Some(1),
            "no-identity" => session.resume_ref = None,
            "wrong-provider" => {
                session.resume_ref.as_mut().unwrap().provider = ResumeProvider::Claude
            }
            _ => unreachable!(),
        });
        let revision = fixture.core.state_revision();
        assert!(
            matches!(
                fixture.observe(Some("Rejected")),
                Err(CoreError::CapabilityDenied)
            ),
            "{case}"
        );
        assert_eq!(fixture.core.state_revision(), revision, "{case}");
    }
}

#[test]
fn invalid_adapter_names_cannot_bypass_the_session_name_invariant() {
    let mut fixture = Fixture::new(|_| {});
    let revision = fixture.core.state_revision();
    for name in [
        "".into(),
        " trailing ".into(),
        "bad\nname".into(),
        "x".repeat(81),
    ] {
        assert!(matches!(
            fixture.observe(Some(&name)),
            Err(CoreError::InvalidParams(_))
        ));
    }
    assert_eq!(fixture.core.state_revision(), revision);
}
