use super::*;
use serde_json::json;
use termloop_domain::{ProcessDescriptor, ResumeProvider, SessionRecord};
use termloop_store::{Store, issue_core_write_authority_for_composition};
use termloop_terminal::{PtySpawnSpec, TerminalService};

struct Fixture {
    core: CoreRuntime,
    root: std::path::PathBuf,
    project: String,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("termloop-resume-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = termloop_platform::canonical_existing_directory_path(&root).unwrap();
        let mut core = CoreRuntime::new(
            Store::open(root.join("state.json")).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            2,
        )
        .unwrap();
        let project = core
            .handle(
                "project.create",
                json!({"name": "Resume failure", "folderPath": root}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        core.store
            .insert_session(
                &core.write_authority,
                SessionRecord {
                    id: "resume".into(),
                    project_id: project.clone(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd: root.to_string_lossy().into_owned(),
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.interactive".into()),
                        template_version: Some(4),
                    },
                    launch_selection: Default::default(),
                    lifecycle_state: "resumeFailed".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Claude,
                        uuid::Uuid::new_v4().to_string(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: Some(ResumeFailureReason::StartupTimedOut),
                },
            )
            .unwrap();
        core.store
            .mark_agent_conversation_resumable(&core.write_authority, "resume")
            .unwrap();
        core.configure_agent_observations(crate::test_agent_observation_transport(
            root.join("provider"),
        ));
        Self {
            core,
            root,
            project,
        }
    }

    fn plan(&mut self) -> AgentResumePlan {
        match self
            .core
            .plan_agent_resume(json!({"sessionId": "resume"}))
            .unwrap()
        {
            crate::AgentResumePlanOutcome::Prepare(plan) => *plan,
            crate::AgentResumePlanOutcome::Current(_) => panic!("expected a reserved resume"),
        }
    }

    fn spawn(&self, plan: &mut AgentResumePlan) {
        self.spawn_epoch(plan.runtime_epoch());
        plan.pty_spawned = true;
    }

    fn spawn_epoch(&self, runtime_epoch: u64) {
        self.core
            .terminal
            .spawn(PtySpawnSpec {
                session_id: "resume".into(),
                runtime_epoch,
                program: std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                args: vec![
                    "--exact".into(),
                    "session_launch::tests::pending_generated_input_fixture".into(),
                    "--nocapture".into(),
                ],
                cwd: self.root.to_string_lossy().into_owned(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: true,
            })
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.core.terminal.terminate("resume");
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn rejected_commit_keeps_retry_reserved_until_the_exact_process_is_reaped() {
    let mut fixture = Fixture::new();
    let mut plan = fixture.plan();
    fixture.spawn(&mut plan);
    fixture
        .core
        .project_delete_reservations
        .insert(fixture.project.clone());
    assert!(matches!(
        fixture.core.complete_agent_resume(&mut plan).unwrap(),
        AgentResumeCompletion::Rejected(ResumeFailureReason::LaunchReserved)
    ));
    assert!(fixture.core.terminal.contains_session("resume").unwrap());
    assert_eq!(
        fixture.core.current_agent_resume("resume").unwrap()["lifecycle_state"],
        "resuming"
    );
    let failure = fixture
        .core
        .begin_resume_failure(
            &plan,
            AgentResumeFailureOutcome::Failed(ResumeFailureReason::LaunchReserved),
        )
        .unwrap();
    assert!(matches!(
        fixture
            .core
            .plan_agent_resume(json!({"sessionId": "resume"}))
            .unwrap(),
        crate::AgentResumePlanOutcome::Current(_)
    ));
    let observed = failure.reap(plan);
    assert!(!fixture.core.terminal.contains_session("resume").unwrap());
    assert!(
        fixture
            .core
            .reconcile_exited_sessions(fixture.core.terminal.reap_exited().unwrap())
            .errors
            .is_empty()
    );
    assert!(fixture.core.resume_reservations.contains("resume"));
    assert_eq!(
        fixture.core.current_agent_resume("resume").unwrap()["lifecycle_state"],
        "resuming"
    );
    let result = fixture.core.complete_resume_failure(observed).unwrap();
    assert_eq!(result["resume_failure_reason"], "launchReserved");
    assert!(!fixture.core.resume_reservations.contains("resume"));
}

#[test]
fn failed_persistence_preserves_reservation_and_observation_for_recovery() {
    let mut fixture = Fixture::new();
    let mut plan = fixture.plan();
    fixture.core.resume_ready.insert("resume".into());
    let path = fixture.root.join("state.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(fixture.core.complete_agent_resume(&mut plan).is_err());
    assert!(fixture.core.resume_reservations.contains("resume"));
    assert!(fixture.core.agent_observations.contains_key("resume"));
    let failure = fixture
        .core
        .begin_resume_failure(
            &plan,
            AgentResumeFailureOutcome::Failed(ResumeFailureReason::DaemonInterrupted),
        )
        .unwrap();
    let observed = failure.reap(plan);
    assert!(fixture.core.complete_resume_failure(observed).is_err());
    assert!(fixture.core.resume_reservations.contains("resume"));
    assert!(fixture.core.resume_failure_reaps.contains("resume"));
    assert!(fixture.core.agent_observations.contains_key("resume"));
    assert_eq!(
        fixture.core.current_agent_resume("resume").unwrap()["lifecycle_state"],
        "resuming"
    );
}

#[test]
fn a_late_failure_cannot_clear_a_new_runtime_epoch() {
    let mut fixture = Fixture::new();
    let mut plan = fixture.plan();
    fixture.spawn(&mut plan);
    let failure = fixture
        .core
        .begin_resume_failure(
            &plan,
            AgentResumeFailureOutcome::Failed(ResumeFailureReason::StartupTimedOut),
        )
        .unwrap();
    fixture
        .core
        .terminate_session(json!({"sessionId": "resume"}))
        .unwrap();
    let preview = fixture
        .core
        .preview_agent_resume(json!({"sessionId": "resume"}))
        .unwrap();
    let crate::AgentResumePlanOutcome::Prepare(mut successor) = fixture
        .core
        .plan_ticketed_agent_resume(json!({
            "sessionId": "resume", "launchTicket": preview["launch_ticket"],
        }))
        .unwrap()
    else {
        panic!("expected explicit resume")
    };
    assert_ne!(successor.runtime_epoch(), plan.runtime_epoch());
    fixture.spawn(&mut successor);
    let successor_epoch = successor.runtime_epoch();
    assert!(matches!(
        fixture.core.complete_agent_resume(&mut plan),
        Err(CoreError::RevisionConflict)
    ));
    let observed = failure.reap(plan);
    assert!(
        fixture
            .core
            .terminal
            .session_is_running("resume", successor_epoch)
            .unwrap()
    );
    assert!(matches!(
        fixture.core.complete_resume_failure(observed),
        Err(CoreError::RevisionConflict)
    ));
    assert!(fixture.core.resume_reservations.contains("resume"));
    assert_eq!(
        fixture.core.agent_observations["resume"].runtime_epoch,
        successor_epoch
    );
}

#[test]
fn an_abandoned_restart_reaps_only_its_retired_pty_epoch() {
    let mut fixture = Fixture::new();
    let mut plan = fixture.plan();
    plan.preparation_kind = crate::session_launch::resume::AgentResumePreparationKind::Restart {
        retired_runtime_epoch: 1,
        retired_codex_runtime: None,
    };
    fixture.spawn_epoch(99);
    plan.reap_uncommitted_runtime().unwrap();
    drop(plan);
    assert!(
        fixture
            .core
            .terminal
            .session_is_running("resume", 99)
            .unwrap()
    );
}

#[test]
fn shutdown_reaps_before_releasing_but_keeps_restart_eligible_state() {
    let mut fixture = Fixture::new();
    let mut plan = fixture.plan();
    fixture.spawn(&mut plan);
    let failure = fixture
        .core
        .begin_resume_failure(&plan, AgentResumeFailureOutcome::Shutdown)
        .unwrap();
    let observed = failure.reap(plan);
    assert!(fixture.core.resume_reservations.contains("resume"));
    assert!(!fixture.core.terminal.contains_session("resume").unwrap());
    let result = fixture.core.complete_resume_failure(observed).unwrap();
    assert_eq!(result["lifecycle_state"], "resuming");
    assert!(!fixture.core.resume_reservations.contains("resume"));
    assert!(!fixture.core.terminal.contains_session("resume").unwrap());
}

#[test]
fn uncertain_cleanup_overrides_the_requested_reason_and_never_spawns_a_hold() {
    let mut fixture = Fixture::new();
    let plan = fixture.plan();
    let failure = fixture
        .core
        .begin_resume_failure(
            &plan,
            AgentResumeFailureOutcome::Failed(ResumeFailureReason::StartupTimedOut),
        )
        .unwrap();
    drop(plan);
    let result = fixture
        .core
        .complete_resume_failure(failure.cleanup_failed())
        .unwrap();
    assert_eq!(result["resume_failure_reason"], "runtimeOwnershipUncertain");
    assert!(!fixture.core.terminal.contains_session("resume").unwrap());
    assert!(!fixture.core.resume_failure_reaps.contains("resume"));
}
