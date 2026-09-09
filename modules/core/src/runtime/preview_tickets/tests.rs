use super::*;
use crate::{AssistantAvailability, CoreRuntime, StewardConfigurationUpdate};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use termloop_domain::{ProcessDescriptor, ResumeProvider, ResumeRef, SessionKind, SessionRecord};
use termloop_store::{Store, issue_core_write_authority_for_composition};
use termloop_terminal::TerminalService;

#[test]
fn consumption_moves_the_exact_payload_once() {
    let mut pool = PreviewTicketPool::<Box<String>>::default();
    let payload = Box::new("inspected payload".to_owned());
    let identity = &*payload as *const String;
    let ticket = pool.issue(payload).unwrap();
    assert_eq!(ticket.len(), 64);
    assert!(pool.consume_once("unknown").is_none());
    let consumed = pool.consume_once(&ticket).unwrap();
    assert_eq!(&*consumed as *const String, identity);
    assert!(pool.consume_once(&ticket).is_none());
}

#[test]
fn full_pool_evicts_only_the_oldest_live_ticket() {
    let mut pool = PreviewTicketPool::<usize, 2>::default();
    let first = pool.issue(1).unwrap();
    let second = pool.issue(2).unwrap();
    let third = pool.issue(3).unwrap();
    assert!(pool.consume_once(&first).is_none());
    assert_eq!(pool.consume_once(&second), Some(2));
    assert_eq!(pool.consume_once(&third), Some(3));
}

#[test]
fn expired_ticket_frees_capacity_before_a_live_ticket_is_evicted() {
    let mut pool = PreviewTicketPool::<usize, 2>::default();
    let live = pool.issue(1).unwrap();
    let expired = pool.issue(2).unwrap();
    pool.entries.back_mut().unwrap().deadline = MonotonicDeadline::after(Duration::ZERO).unwrap();
    let replacement = pool.issue(3).unwrap();
    assert_eq!(pool.consume_once(&live), Some(1));
    assert!(pool.consume_once(&expired).is_none());
    assert_eq!(pool.consume_once(&replacement), Some(3));
}

#[test]
fn expiration_rejects_and_drops_the_payload_without_a_new_issue() {
    let mut pool = PreviewTicketPool::<std::sync::Arc<()>>::default();
    let payload = std::sync::Arc::new(());
    let weak = std::sync::Arc::downgrade(&payload);
    let ticket = pool.issue(payload).unwrap();
    assert!(pool.entries.front().unwrap().deadline.remaining().unwrap() <= Duration::from_secs(30));
    pool.entries.front_mut().unwrap().deadline = MonotonicDeadline::after(Duration::ZERO).unwrap();
    assert!(pool.consume_once(&ticket).is_none());
    assert!(weak.upgrade().is_none());
}

#[test]
fn discard_is_idempotent_and_does_not_consume_a_peer() {
    let mut pool = PreviewTicketPool::<usize>::default();
    let discarded = pool.issue(1).unwrap();
    let peer = pool.issue(2).unwrap();
    pool.discard(&discarded);
    pool.discard(&discarded);
    pool.discard("unknown");
    assert!(pool.consume_once(&discarded).is_none());
    assert_eq!(pool.consume_once(&peer), Some(2));
}

#[test]
fn a_ticket_cannot_be_redeemed_through_another_pool() {
    let mut first = PreviewTicketPool::<usize>::default();
    let mut second = PreviewTicketPool::<usize>::default();
    let ticket = first.issue(1).unwrap();
    assert!(second.consume_once(&ticket).is_none());
    assert_eq!(first.consume_once(&ticket), Some(1));
}

struct Fixture {
    runtime: CoreRuntime,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("termloop-preview-tickets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = CoreRuntime::new(
            Store::open(root.join("state.json")).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        runtime.configure_agent_observations(crate::test_agent_observation_transport(
            root.join("providers"),
        ));
        Self { runtime, root }
    }

    fn project(&mut self, name: &str) -> ProjectPreviews {
        ProjectPreviews::issue(&mut self.runtime, &self.root, name)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct ProjectPreviews {
    project_id: String,
    session_id: String,
    task_id: String,
    quick_action: String,
    improver: String,
    launch: String,
    resume: String,
    session_archive: String,
    task_archive: String,
}

impl ProjectPreviews {
    fn issue(runtime: &mut CoreRuntime, root: &Path, name: &str) -> Self {
        let folder = root.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({"name": name, "folderPath": folder}),
            )
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        runtime
            .set_steward_configuration(StewardConfigurationUpdate {
                project_id: &project_id,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled: false,
                system_prompt: "Coordinate the Project.".into(),
                expected_revision: runtime.state_revision(),
                capability: AssistantAvailability::Unavailable,
                updated_at_epoch_ms: 1,
            })
            .unwrap();
        let task = runtime
            .create_task(json!({
                "projectId": project_id, "title": "Unbound task", "worktreeIntent": "none"
            }))
            .unwrap();
        let task_id = task["id"].as_str().unwrap().to_owned();
        let session_id = uuid::Uuid::new_v4().to_string();
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: session_id.clone(),
                    project_id: project_id.clone(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: folder.to_string_lossy().into_owned(),
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
                    resume_ref: Some(ResumeRef {
                        provider: ResumeProvider::Codex,
                        native_session_id: uuid::Uuid::new_v4().to_string(),
                    }),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        let launch = runtime
            .preview_agent_launch(
                json!({"projectId": project_id, "cwd": folder, "agentId": "codex"}),
            )
            .unwrap();
        let quick_action = runtime.preview_quick_action(json!({
            "projectId": project_id, "cwd": folder, "agentId": "codex",
            "model": "default", "permission": "plan", "reasoning": "default",
            "templateRef": "builtin.quick-action.free-prompt", "bindings": {"prompt": "Inspect"}, "attachments": []
        })).unwrap();
        let improver = runtime.preview_assistant_prompt_improver(json!({
            "projectId": project_id, "agentId": "codex", "model": "default", "permission": "plan", "reasoning": "default",
            "templateRef": "builtin.improver.steward-instructions", "bindings": {"surface": "stewardInstructions"}
        })).unwrap();
        let resume = runtime
            .preview_agent_resume(json!({"sessionId": session_id}))
            .unwrap();
        let session_archive = runtime
            .handle("session.inspectArchive", json!({"sessionId": session_id}))
            .unwrap();
        let task_archive = runtime
            .handle("task.inspectArchive", json!({"taskId": task_id}))
            .unwrap();
        let token = |value: &Value, key: &str| value[key].as_str().unwrap().to_owned();
        assert_eq!(session_archive["expires_in_ms"], 30_000);
        assert_eq!(task_archive["expires_in_ms"], 30_000);
        Self {
            project_id,
            session_id,
            task_id,
            quick_action: token(&quick_action, "launch_ticket"),
            improver: token(&improver, "launch_ticket"),
            launch: token(&launch, "launch_ticket"),
            resume: token(&resume, "launch_ticket"),
            session_archive: token(&session_archive, "archive_ticket"),
            task_archive: token(&task_archive, "archive_ticket"),
        }
    }

    fn assert_consumable(
        &self,
        tickets: &mut PreviewTicketRuntime,
        ordinary: bool,
        assistant: bool,
    ) {
        assert_eq!(
            tickets
                .quick_action
                .consume_once(&self.quick_action)
                .is_some(),
            ordinary
        );
        assert_eq!(
            tickets.agent_launch.consume_once(&self.launch).is_some(),
            ordinary
        );
        assert_eq!(
            tickets
                .task_archive
                .consume_once(&self.task_archive)
                .is_some(),
            ordinary
        );
        assert_eq!(
            tickets.quick_action.consume_once(&self.improver).is_some(),
            assistant
        );
        assert_eq!(
            tickets.agent_resume.consume_once(&self.resume).is_some(),
            assistant
        );
        assert_eq!(
            tickets
                .session_archive
                .consume_once(&self.session_archive)
                .is_some(),
            assistant
        );
    }
}

#[test]
fn project_delete_invalidates_its_tickets_and_preserves_the_other_project() {
    let mut fixture = Fixture::new();
    let deleted = fixture.project("deleted");
    let peer = fixture.project("peer");
    let plan = fixture
        .runtime
        .begin_project_delete(json!({"projectId": deleted.project_id}))
        .unwrap();
    fixture.runtime.complete_project_delete(plan).unwrap();
    deleted.assert_consumable(&mut fixture.runtime.preview_tickets, false, false);
    peer.assert_consumable(&mut fixture.runtime.preview_tickets, true, true);
}

#[test]
fn assistant_reset_invalidates_only_its_assistant_tickets_after_commit() {
    let mut fixture = Fixture::new();
    let reset = fixture.project("reset");
    let peer = fixture.project("peer");
    assert!(matches!(
        fixture
            .runtime
            .reset_project_assistant(&reset.project_id, 0, 2),
        Err(CoreError::RevisionConflict)
    ));
    assert_eq!(
        fixture.runtime.preview_tickets.quick_action.entries.len(),
        4
    );
    let commit = fixture
        .runtime
        .reset_project_assistant(&reset.project_id, fixture.runtime.state_revision(), 2)
        .unwrap();
    assert_eq!(commit.session_ids, vec![reset.session_id.clone()]);
    fixture
        .runtime
        .finish_project_assistant_reset(&reset.project_id);
    reset.assert_consumable(&mut fixture.runtime.preview_tickets, true, false);
    peer.assert_consumable(&mut fixture.runtime.preview_tickets, true, true);
}

#[test]
fn task_archive_retains_its_32_ticket_limit_independently_of_launches() {
    let mut fixture = Fixture::new();
    let project = fixture.project("bounded");
    let mut tickets = vec![project.task_archive];
    let revision = fixture.runtime.state_revision();
    for _ in 0..32 {
        let preview = fixture
            .runtime
            .handle("task.inspectArchive", json!({"taskId": project.task_id}))
            .unwrap();
        tickets.push(preview["archive_ticket"].as_str().unwrap().to_owned());
    }
    assert!(
        fixture
            .runtime
            .preview_tickets
            .task_archive
            .consume_once(&tickets[0])
            .is_none()
    );
    for ticket in &tickets[1..] {
        assert!(
            fixture
                .runtime
                .preview_tickets
                .task_archive
                .consume_once(ticket)
                .is_some()
        );
    }
    assert!(
        fixture
            .runtime
            .preview_tickets
            .agent_launch
            .consume_once(&project.launch)
            .is_some()
    );
    assert_eq!(fixture.runtime.state_revision(), revision);
}
