use super::*;
use termloop_terminal::ReapedTerminal;

struct Fixture {
    core: CoreRuntime,
    root: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("termloop-exit-commit-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(root.join("state.json")).unwrap();
        let core = CoreRuntime::new(
            store,
            termloop_store::issue_core_write_authority_for_composition(),
            TerminalService::default(),
            17,
        )
        .unwrap();
        Self { core, root }
    }

    fn insert(&mut self, id: &str, epoch: u64, lifecycle: &str) {
        self.core
            .store
            .insert_session(
                &self.core.write_authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: id.into(),
                    project_id: "project-1".into(),
                    name: None,
                    kind: SessionKind::Terminal,
                    process: ProcessDescriptor {
                        program: "fixture".into(),
                        args: vec![],
                        cwd: self.root.display().to_string(),
                        agent_id: None,
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: lifecycle.into(),
                    runtime_epoch: epoch,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
    }

    fn block_storage(&self) {
        std::fs::rename(self.root.join("state.json"), self.root.join("state.backup")).unwrap();
        std::fs::create_dir(self.root.join("state.json")).unwrap();
    }

    fn restore_storage(&self) {
        std::fs::remove_dir(self.root.join("state.json")).unwrap();
        std::fs::rename(self.root.join("state.backup"), self.root.join("state.json")).unwrap();
    }

    fn lifecycle(&self, id: &str) -> &str {
        &self
            .core
            .store
            .sessions()
            .iter()
            .find(|session| session.id == id)
            .unwrap()
            .lifecycle_state
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.core.terminal.terminate_all();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn exit(id: &str, runtime_epoch: u64) -> ReapedTerminal {
    ReapedTerminal {
        session_id: id.into(),
        runtime_epoch,
        exit_code: 0,
    }
}

#[test]
fn failed_exit_commits_retry_the_entire_batch_after_storage_recovers() {
    let mut fixture = Fixture::new();
    fixture.insert("a", 17, "running");
    fixture.insert("b", 17, "running");
    fixture.block_storage();
    let failed = fixture
        .core
        .reconcile_exited_sessions(vec![exit("a", 17), exit("b", 17)]);
    assert_eq!(failed.errors.len(), 2);
    assert!(failed.exited_session_ids.is_empty());
    assert!(failed.state_revision.is_none());
    assert_eq!(fixture.core.pending_session_exits.len(), 2);
    assert_eq!(fixture.lifecycle("a"), "running");
    assert_eq!(fixture.lifecycle("b"), "running");
    fixture.restore_storage();
    let retried = fixture.core.reconcile_exited_sessions(vec![]);
    assert!(retried.errors.is_empty());
    assert_eq!(retried.exited_session_ids, ["a", "b"]);
    assert!(retried.state_revision.is_some());
    assert_eq!(fixture.lifecycle("a"), "exited");
    assert_eq!(fixture.lifecycle("b"), "exited");
    assert!(fixture.core.pending_session_exits.is_empty());
    let revision = fixture.core.state_revision();
    assert!(
        fixture
            .core
            .reconcile_exited_sessions(vec![])
            .exited_session_ids
            .is_empty()
    );
    assert_eq!(fixture.core.state_revision(), revision);
}

#[test]
fn failed_peer_does_not_discard_a_successful_exit_notification() {
    let mut fixture = Fixture::new();
    fixture.insert("a", 17, "exited");
    fixture.insert("b", 17, "running");
    fixture.block_storage();
    let result = fixture
        .core
        .reconcile_exited_sessions(vec![exit("a", 17), exit("b", 17)]);
    assert_eq!(result.exited_session_ids, ["a"]);
    assert_eq!(result.errors.len(), 1);
    assert_eq!(fixture.core.pending_session_exits.len(), 1);
    assert!(fixture.core.pending_session_exits.contains_key("b"));
    fixture.restore_storage();
}

#[test]
fn delayed_exit_cannot_retire_a_replacement_generation() {
    let mut fixture = Fixture::new();
    fixture.insert("same-session", 17, "running");
    fixture.block_storage();
    assert_eq!(
        fixture
            .core
            .reconcile_exited_sessions(vec![exit("same-session", 17)])
            .errors
            .len(),
        1
    );
    fixture.restore_storage();
    fixture
        .core
        .store
        .mark_session_exited(&fixture.core.write_authority, "same-session")
        .unwrap();
    fixture
        .core
        .store
        .delete_session_descriptor(&fixture.core.write_authority, "same-session")
        .unwrap();
    fixture.insert("same-session", 18, "running");
    let result = fixture
        .core
        .reconcile_exited_sessions(vec![exit("same-session", 17)]);
    assert!(result.errors.is_empty());
    assert!(result.exited_session_ids.is_empty());
    assert_eq!(fixture.lifecycle("same-session"), "running");
    assert!(fixture.core.pending_session_exits.is_empty());
}

#[test]
fn provisional_resume_exit_retries_without_consuming_reservations_on_write_failure() {
    let mut fixture = Fixture::new();
    fixture.insert("resume", 17, "exited");
    let mut session = fixture
        .core
        .store
        .delete_session_descriptor(&fixture.core.write_authority, "resume")
        .unwrap();
    session.kind = SessionKind::Agent;
    session.process.agent_id = Some("claude".into());
    session.lifecycle_state = "resuming".into();
    session.resume_ref =
        ResumeRef::for_provider(ResumeProvider::Claude, Uuid::new_v4().to_string());
    fixture
        .core
        .store
        .insert_session(&fixture.core.write_authority, session)
        .unwrap();
    fixture.core.resume_reservations.insert("resume".into());
    fixture.core.resume_ready.insert("resume".into());
    fixture.core.agent_observations.insert(
        "resume".into(),
        crate::AgentObservationCapability {
            token: None,
            runtime_epoch: 18,
            observation: None,
            last_signal: None,
            pending_generated_input: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
        },
    );
    // The retired generation may report after the new resume was reserved.
    assert!(
        fixture
            .core
            .reconcile_exited_sessions(vec![exit("resume", 17)])
            .exited_session_ids
            .is_empty()
    );
    assert_eq!(fixture.lifecycle("resume"), "resuming");
    fixture.block_storage();
    let failed = fixture
        .core
        .reconcile_exited_sessions(vec![exit("resume", 18)]);
    assert_eq!(failed.errors.len(), 1);
    assert!(fixture.core.resume_reservations.contains("resume"));
    assert!(fixture.core.resume_ready.contains("resume"));
    assert!(fixture.core.agent_observations.contains_key("resume"));
    fixture.restore_storage();
    let retried = fixture.core.reconcile_exited_sessions(vec![]);
    assert!(retried.errors.is_empty());
    assert_eq!(retried.exited_session_ids, ["resume"]);
    assert_eq!(fixture.lifecycle("resume"), "resumeFailed");
    assert!(!fixture.core.resume_reservations.contains("resume"));
    assert!(!fixture.core.resume_ready.contains("resume"));
    assert!(fixture.core.pending_session_exits.is_empty());
}
