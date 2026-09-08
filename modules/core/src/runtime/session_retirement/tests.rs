use std::collections::VecDeque;

use serde_json::json;
use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
use termloop_store::{Store, issue_core_write_authority_for_composition};
use termloop_terminal::TerminalService;

use crate::runtime::generated_input_delivery::GeneratedInputSettlement;
use crate::session_launch::AgentMcpRole;
use crate::{
    AssistantAvailability, CoreRuntime, PendingGeneratedInputQueue, StewardConfigurationUpdate,
    test_generated_terminal_submission,
};

struct Fixture {
    core: CoreRuntime,
    directory: std::path::PathBuf,
    project_id: String,
}

impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("termloop-retirement-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut core = CoreRuntime::new(
            Store::open(directory.join("state.json")).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        let project_id = core
            .handle(
                "project.create",
                json!({"name": "Retiring", "folderPath": directory}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        core.set_steward_configuration(StewardConfigurationUpdate {
            project_id: &project_id,
            agent_id: "codex",
            model: "default".into(),
            permission: "bypassPermissions".into(),
            reasoning: "default".into(),
            enabled: false,
            system_prompt: "Coordinate this Project.".into(),
            expected_revision: core.state_revision(),
            capability: AssistantAvailability::Unavailable,
            updated_at_epoch_ms: 1,
        })
        .unwrap();
        for (id, project) in [
            ("retiring", project_id.as_str()),
            ("survivor", "other-project"),
        ] {
            core.store
                .insert_session(
                    &core.write_authority,
                    SessionRecord {
                        id: id.into(),
                        project_id: project.into(),
                        name: None,
                        kind: SessionKind::Agent,
                        process: ProcessDescriptor {
                            program: "codex".into(),
                            args: vec![],
                            cwd: directory.to_string_lossy().into_owned(),
                            agent_id: Some("codex".into()),
                            template_ref: Some("builtin.builder.playbook".into()),
                            template_version: Some(1),
                        },
                        launch_selection: Default::default(),
                        lifecycle_state: "exited".into(),
                        runtime_epoch: 1,
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
            let submission = test_generated_terminal_submission("pending retirement fixture");
            assert!(core.generated_input_deliveries.begin(
                &core.terminal,
                id,
                1,
                0,
                submission.clone(),
                GeneratedInputSettlement::ComposerRender,
            ));
            core.pending_generated_input_queues.insert(
                id.into(),
                PendingGeneratedInputQueue {
                    runtime_epoch: 1,
                    submissions: VecDeque::from([submission]),
                },
            );
            core.mcp_authorizer.register(
                id.into(),
                1,
                AgentMcpRole::Interactive,
                format!("token-{id}"),
            );
            core.agent_conversation_activity.insert(id.into());
            core.resume_ready.insert(id.into());
            core.resume_failure_reaps.insert(id.into());
            core.pending_agent_forks.insert(id.into());
        }
        core.fork_source_session_ids
            .insert("retiring".into(), "survivor".into());
        core.fork_source_session_ids
            .insert("child".into(), "retiring".into());
        core.fork_source_session_ids
            .insert("unrelated-child".into(), "survivor".into());
        Self {
            core,
            directory,
            project_id,
        }
    }

    fn assert_runtime_present(&self, id: &str) {
        assert!(self.core.generated_input_deliveries.state(id, 1).is_some());
        assert!(self.core.pending_generated_input_queues.contains_key(id));
        assert!(
            self.core
                .mcp_authorizer
                .authenticate(&format!("token-{id}"))
                .is_ok()
        );
        assert!(self.core.agent_conversation_activity.contains(id));
    }

    fn assert_retired(&self) {
        assert!(
            !self
                .core
                .store
                .sessions()
                .iter()
                .any(|session| session.id == "retiring")
        );
        assert!(
            self.core
                .generated_input_deliveries
                .state("retiring", 1)
                .is_none()
        );
        assert!(
            !self
                .core
                .pending_generated_input_queues
                .contains_key("retiring")
        );
        assert!(
            self.core
                .mcp_authorizer
                .authenticate("token-retiring")
                .is_err()
        );
        assert!(!self.core.agent_conversation_activity.contains("retiring"));
        assert!(!self.core.resume_ready.contains("retiring"));
        assert!(!self.core.resume_failure_reaps.contains("retiring"));
        assert!(!self.core.pending_agent_forks.contains("retiring"));
        assert!(!self.core.fork_source_session_ids.contains_key("retiring"));
        assert!(!self.core.fork_source_session_ids.contains_key("child"));
        assert_eq!(
            self.core
                .fork_source_session_ids
                .get("unrelated-child")
                .map(String::as_str),
            Some("survivor")
        );
        self.assert_runtime_present("survivor");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn project_deletion_retires_only_its_committed_session_endpoints() {
    let mut fixture = Fixture::new();
    let plan = fixture
        .core
        .begin_project_delete(json!({"projectId": fixture.project_id}))
        .unwrap();
    let commit = fixture.core.complete_project_delete(plan).unwrap();
    assert_eq!(commit.session_ids, ["retiring"]);
    assert!(commit.retired_runtimes.is_empty());
    fixture.assert_retired();
}

#[test]
fn assistant_reset_retires_after_commit_and_preserves_its_teardown_reservation() {
    let mut fixture = Fixture::new();
    assert!(
        fixture
            .core
            .reset_project_assistant(&fixture.project_id, 0, 2)
            .is_err()
    );
    fixture.assert_runtime_present("retiring");
    let revision = fixture.core.state_revision();
    let commit = fixture
        .core
        .reset_project_assistant(&fixture.project_id, revision, 2)
        .unwrap();
    assert_eq!(commit.session_ids, ["retiring"]);
    fixture.assert_retired();
    assert!(!fixture.core.project_exists(&fixture.project_id));
    fixture
        .core
        .finish_project_assistant_reset(&fixture.project_id);
    assert!(fixture.core.project_exists(&fixture.project_id));
}

#[test]
fn close_retires_runtime_but_preserves_the_deleted_agent_descriptor() {
    let mut fixture = Fixture::new();
    fixture
        .core
        .close_session(json!({"sessionId": "retiring"}))
        .unwrap();
    fixture.assert_retired();
    assert!(
        fixture
            .core
            .store
            .deleted_sessions()
            .iter()
            .any(|deleted| deleted.session.id == "retiring")
    );
}

#[test]
fn rejected_close_does_not_retire_a_reserved_endpoint() {
    let mut fixture = Fixture::new();
    fixture.core.resume_reservations.insert("retiring".into());
    assert!(
        fixture
            .core
            .close_session(json!({"sessionId": "retiring"}))
            .is_err()
    );
    fixture.assert_runtime_present("retiring");
}

#[test]
fn failed_descriptor_commit_preserves_runtime_state_for_retry() {
    let mut fixture = Fixture::new();
    // Force atomic replacement to fail without relying on host permissions.
    let path = fixture.directory.join("state.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        fixture
            .core
            .close_session(json!({"sessionId": "retiring"}))
            .is_err()
    );
    assert!(
        fixture
            .core
            .store
            .sessions()
            .iter()
            .any(|session| session.id == "retiring")
    );
    fixture.assert_runtime_present("retiring");
}
