use super::*;
use termloop_domain::{
    AskToContinuation, ProcessDescriptor, ResumeProvider, ResumeRef, SessionKind, SessionRecord,
};
use termloop_terminal::PtySpawnSpec;

fn prepare_relocation_fixture() -> (Fixture, String, String, PathBuf) {
    prepare_relocation_fixture_for("codex")
}

fn prepare_relocation_fixture_for(agent_id: &str) -> (Fixture, String, String, PathBuf) {
    let mut fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Relocation target", Value::Null);
    let task_id = task["id"].as_str().unwrap().to_owned();
    let target = fixture
        .project_directory
        .with_file_name(format!("relocation-worktree-{}", Uuid::new_v4()));
    fixture
        .runtime
        .provision_task_worktree(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": task_id,
            "repositoryPath": fixture.project_directory,
            "destinationPath": target,
            "branchName": "feature/relocation",
            "branchMode": "create",
            "baseRef": "refs/remotes/origin/main",
        }))
        .unwrap();
    let source = fixture.project_directory.join("loose-agent");
    std::fs::create_dir_all(&source).unwrap();
    let source = termloop_platform::canonical_existing_directory(source.to_str().unwrap())
        .unwrap()
        .display()
        .to_string();
    let target = termloop_platform::canonical_existing_directory(target.to_str().unwrap()).unwrap();
    let session_id = "relocating-agent".to_owned();
    let mut transport =
        crate::test_agent_observation_transport(fixture.project_directory.join("provider"));
    for capability in transport.agents.values_mut() {
        capability.mcp_http_supported = false;
    }
    fixture.runtime.configure_agent_observations(transport);
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            SessionRecord {
                id: session_id.clone(),
                project_id: fixture.project_id.clone(),
                name: Some(format!("Loose {agent_id}")),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: agent_id.into(),
                    args: vec![],
                    cwd: source.clone(),
                    agent_id: Some(agent_id.into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    if agent_id == "claude" {
                        ResumeProvider::Claude
                    } else {
                        ResumeProvider::Codex
                    },
                    "00000000-0000-4000-8000-000000000001".into(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
                launch_selection: termloop_domain::AgentLaunchSelection {
                    model: if agent_id == "claude" {
                        "default".into()
                    } else {
                        "gpt-5.6-sol".into()
                    },
                    permission: "acceptEdits".into(),
                    reasoning: "high".into(),
                },
            },
        )
        .unwrap();
    let (program, args) = termloop_platform::default_shell();
    fixture
        .runtime
        .terminal
        .spawn(PtySpawnSpec {
            session_id: session_id.clone(),
            runtime_epoch: 1,
            program,
            args,
            cwd: source,
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        })
        .unwrap();
    fixture.runtime.agent_observations.insert(
        session_id.clone(),
        crate::AgentObservationCapability {
            token: None,
            runtime_epoch: 1,
            last_signal: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
            observation: Some(termloop_agents::AgentObservation {
                state: termloop_agents::AgentState::Idle,
                source: termloop_agents::AgentSignalSource::DaemonBridge,
                sequence: 1,
                observed_at_epoch_ms: 10,
            }),
            pending_generated_input: None,
        },
    );
    (fixture, task_id, session_id, target)
}

fn relocation_preview(fixture: &mut Fixture, session_id: &str, task_id: &str) -> Value {
    let outcome = fixture
        .runtime
        .plan_session_relocation_preview(
            json!({ "sessionId": session_id, "taskId": task_id, "mode": "resume" }),
        )
        .unwrap();
    let crate::SessionRelocationPreviewOutcome::Observe(plan) = outcome else {
        panic!("healthy relocation should require a worktree observation")
    };
    fixture
        .runtime
        .complete_session_relocation_preview(plan.observe(Duration::from_secs(2)))
        .unwrap()
}

#[test]
fn relocation_ticket_is_exact_single_use_and_never_stores_task_parentage() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture();
    let source = fixture.runtime.session_cwd(&session_id).unwrap();
    let first = relocation_preview(&mut fixture, &session_id, &task_id);
    assert_eq!(first["can_relocate"], true);
    assert_eq!(first["source_cwd"], source);
    assert_eq!(first["target_cwd"], target.to_string_lossy().as_ref());
    assert_eq!(first["model"], "gpt-5.6-sol");
    assert_eq!(first["permission"], "acceptEdits");
    assert_eq!(first["reasoning"], "high");
    assert_eq!(
        first["manifest"]["target"]["cwd"],
        target.to_string_lossy().as_ref()
    );
    assert_eq!(
        first["manifest"]["provenance"]["template_ref"],
        "builtin.agent.worktree-relocation"
    );
    let stale_ticket = first["relocation_ticket"].as_str().unwrap().to_owned();
    fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();
    assert!(matches!(
        fixture.runtime.plan_ticketed_agent_relocation(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "mode": "resume",
            "operationId": Uuid::new_v4().to_string(),
            "relocationTicket": stale_ticket,
        })),
        Err(CoreError::InvalidParams(field)) if field == "relocationTicket"
    ));
    assert_eq!(
        fixture.runtime.session_cwd(&session_id).as_deref(),
        Some(source.as_str())
    );

    fixture
        .runtime
        .reopen_task(json!({ "taskId": task_id }))
        .unwrap();
    let preview = relocation_preview(&mut fixture, &session_id, &task_id);
    let relocation_ticket = preview["relocation_ticket"].as_str().unwrap();
    let operation_id = Uuid::new_v4().to_string();
    let plan = match fixture
        .runtime
        .plan_ticketed_agent_relocation(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "operationId": operation_id,
            "relocationTicket": relocation_ticket,
        }))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("relocation should prepare"),
    };
    assert_eq!(
        fixture.runtime.session_cwd(&session_id).as_deref(),
        Some(source.as_str())
    );
    assert_eq!(
        fixture.runtime.store.session_relocation_operations().len(),
        1
    );
    let current = fixture
        .runtime
        .plan_ticketed_agent_relocation(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "operationId": operation_id,
            "relocationTicket": "0".repeat(64),
        }))
        .unwrap();
    let crate::AgentResumePlanOutcome::Current(current) = current else {
        panic!("an in-flight relocation must return its current projection")
    };
    assert_eq!(current["lifecycle_state"], "resuming");
    assert_eq!(current["process"]["cwd"], target.to_string_lossy().as_ref());
    assert_eq!(
        fixture.runtime.session_cwd(&session_id).as_deref(),
        Some(source.as_str()),
        "durable ownership must remain at the source until commit"
    );
    drop(plan);
    let failed = fixture
        .runtime
        .fail_agent_resume(
            &session_id,
            termloop_domain::ResumeFailureReason::DaemonInterrupted,
        )
        .unwrap();
    assert_eq!(failed["process"]["cwd"], source);
    assert_eq!(failed["lifecycle_state"], "resumeFailed");
    assert!(
        fixture
            .runtime
            .store
            .session_relocation_operations()
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn completed_relocation_operation_is_idempotent_after_a_lost_response() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture();
    let source = fixture.runtime.session_cwd(&session_id).unwrap();
    let session = fixture
        .runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == session_id)
        .unwrap()
        .clone();
    let proof = fixture
        .runtime
        .store
        .managed_worktrees()
        .iter()
        .find(|proof| proof.task_id == task_id)
        .unwrap()
        .clone();
    let operation_id = Uuid::new_v4().to_string();
    fixture
        .runtime
        .store
        .begin_session_relocation(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRelocationOperation {
                operation_id: operation_id.clone(),
                session_id: session_id.clone(),
                project_id: fixture.project_id.clone(),
                source_runtime_epoch: session.runtime_epoch,
                source_cwd: source,
                target: termloop_domain::SessionRelocationTarget::TaskWorktree,
                target_task_id: task_id.clone(),
                target_cwd: target.to_string_lossy().into_owned(),
                target_worktree_generation: proof.worktree_generation,
                target_managed_worktree_operation_id: proof.operation_id,
                stage: termloop_domain::SessionRelocationStage::SourceRetiring,
                started_at_epoch_ms: 20,
                updated_at_epoch_ms: 20,
            },
        )
        .unwrap();
    fixture
        .runtime
        .store
        .mark_session_relocation_target_starting(
            &fixture.runtime.write_authority,
            &session_id,
            &operation_id,
            21,
        )
        .unwrap();
    fixture
        .runtime
        .store
        .commit_session_relocation(
            &fixture.runtime.write_authority,
            &session_id,
            &operation_id,
            2,
            session.resume_ref.as_ref().unwrap(),
        )
        .unwrap();

    let retried = fixture
        .runtime
        .plan_ticketed_agent_relocation(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "operationId": operation_id,
            "relocationTicket": "lost-response-does-not-need-the-consumed-ticket",
        }))
        .unwrap();
    let crate::AgentResumePlanOutcome::Current(current) = retried else {
        panic!("a completed operation retry must return its current result")
    };
    assert_eq!(current["process"]["cwd"], target.to_string_lossy().as_ref());
    assert_eq!(fixture.runtime.store.session_relocation_receipts().len(), 1);
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn active_interrupted_and_unobserved_agents_can_be_force_parked_for_relocation() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture();

    for (state, warns_about_interruption) in [
        (termloop_agents::AgentState::Working, true),
        (termloop_agents::AgentState::Interrupted, false),
    ] {
        fixture
            .runtime
            .agent_observations
            .get_mut(&session_id)
            .unwrap()
            .observation
            .as_mut()
            .unwrap()
            .state = state;
        let preview = relocation_preview(&mut fixture, &session_id, &task_id);
        assert_eq!(preview["can_relocate"], true, "state: {state:?}");
        assert_eq!(
            preview["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning == "sourceTurnWillBeInterrupted"),
            warns_about_interruption,
            "state: {state:?}"
        );
    }

    fixture.runtime.agent_observations.remove(&session_id);
    let preview = relocation_preview(&mut fixture, &session_id, &task_id);
    assert_eq!(preview["can_relocate"], true);
    assert!(preview["blockers"].as_array().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn retryable_agent_without_a_live_pty_can_be_relocated_again() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture();
    fixture.runtime.terminal.terminate(&session_id).unwrap();
    fixture
        .runtime
        .store
        .mark_session_resume_failed(
            &fixture.runtime.write_authority,
            &session_id,
            termloop_domain::ResumeFailureReason::StartupTimedOut,
        )
        .unwrap();

    let preview = relocation_preview(&mut fixture, &session_id, &task_id);

    assert_eq!(preview["can_relocate"], true);
    assert!(preview["blockers"].as_array().unwrap().is_empty());
    let plan = match fixture
        .runtime
        .plan_ticketed_agent_relocation(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "relocationTicket": preview["relocation_ticket"],
        }))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("relocation should prepare"),
    };
    assert!(
        !plan.retires_source_runtime_for_test(),
        "a retryable stopped session has no source PTY to retire"
    );
    drop(plan);
    fixture
        .runtime
        .fail_agent_resume(
            &session_id,
            termloop_domain::ResumeFailureReason::DaemonInterrupted,
        )
        .unwrap();
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn fresh_handoff_is_explicit_and_rejected_for_codex() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture();
    let outcome = fixture
        .runtime
        .plan_session_relocation_preview(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "mode": "fresh",
        }))
        .unwrap();
    let crate::SessionRelocationPreviewOutcome::Current(preview) = outcome else {
        panic!("Codex fresh handoff must be rejected before worktree observation")
    };

    assert_eq!(preview["mode"], "fresh");
    assert_eq!(preview["can_relocate"], false);
    assert!(
        preview["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|blocker| blocker == "freshHandoffUnsupported")
    );
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn fresh_claude_handoff_uses_a_new_private_resume_identity() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture_for("claude");
    let source_resume_ref = fixture
        .runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.resume_ref.clone())
        .unwrap();
    let outcome = fixture
        .runtime
        .plan_session_relocation_preview(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "mode": "fresh",
        }))
        .unwrap();
    let crate::SessionRelocationPreviewOutcome::Observe(preview_plan) = outcome else {
        panic!("fresh Claude relocation should observe the target worktree")
    };
    let preview = fixture
        .runtime
        .complete_session_relocation_preview(preview_plan.observe(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(preview["can_relocate"], true);
    assert_eq!(preview["mode"], "fresh");
    assert_eq!(preview["manifest"]["target"]["conversation"], "fresh");
    assert!(
        preview["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning == "freshConversationWillStart")
    );
    let relocation_ticket = preview["relocation_ticket"].as_str().unwrap();
    let plan = match fixture
        .runtime
        .plan_ticketed_agent_relocation(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "relocationTicket": relocation_ticket,
        }))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("fresh relocation should prepare"),
    };
    assert_ne!(plan.resume_ref_for_test(), &source_resume_ref);
    assert_eq!(
        fixture.runtime.pending_agent_resume_refs.get(&session_id),
        Some(plan.resume_ref_for_test())
    );
    let token = plan.observation_token_for_test().unwrap();
    assert!(
        !fixture
            .runtime
            .record_claude_resume_ref(
                token,
                &session_id,
                &plan.resume_ref_for_test().native_session_id,
            )
            .unwrap()
    );
    assert!(matches!(
        fixture.runtime.record_claude_resume_ref(
            token,
            &session_id,
            "00000000-0000-4000-8000-000000000099",
        ),
        Err(CoreError::ResumeRefReplacement)
    ));
    drop(plan);
    fixture
        .runtime
        .fail_agent_resume(
            &session_id,
            termloop_domain::ResumeFailureReason::DaemonInterrupted,
        )
        .unwrap();
    assert!(
        !fixture
            .runtime
            .pending_agent_resume_refs
            .contains_key(&session_id)
    );
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn relocation_is_blocked_while_ask_to_delivery_is_current() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture();
    let source = fixture
        .runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == session_id)
        .unwrap()
        .clone();
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            SessionRecord {
                id: "relocation-helper".into(),
                project_id: source.project_id,
                name: Some("Ask-To helper".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: source.process.cwd,
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.ask-to-helper".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: Some(session_id.clone()),
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: Some(AskToContinuation {
                    conversation_id: "relocation-conversation".into(),
                    current_request_id: Some("relocation-request".into()),
                }),
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    "00000000-0000-4000-8000-000000000002".into(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
                launch_selection: Default::default(),
            },
        )
        .unwrap();

    let crate::SessionRelocationPreviewOutcome::Current(preview) = fixture
        .runtime
        .plan_session_relocation_preview(json!({
            "sessionId": session_id,
            "taskId": task_id,
            "mode": "resume",
        }))
        .unwrap()
    else {
        panic!("an in-flight Ask-To delivery must block before worktree observation")
    };
    assert_eq!(preview["can_relocate"], false);
    assert!(
        preview["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|blocker| blocker == "askToInProgress")
    );
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn task_agent_can_plan_a_resume_back_to_the_project_checkout() {
    let (mut fixture, task_id, session_id, target) = prepare_relocation_fixture();
    let project_cwd = fixture
        .runtime
        .store
        .projects()
        .iter()
        .find(|project| project.id == fixture.project_id)
        .unwrap()
        .folder_path
        .clone();
    let source = fixture
        .runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == session_id)
        .unwrap()
        .clone();
    let proof = fixture
        .runtime
        .store
        .managed_worktrees()
        .iter()
        .find(|proof| proof.task_id == task_id)
        .unwrap()
        .clone();
    fixture
        .runtime
        .store
        .begin_session_relocation(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRelocationOperation {
                operation_id: "seed-task-attachment".into(),
                session_id: session_id.clone(),
                project_id: fixture.project_id.clone(),
                source_runtime_epoch: source.runtime_epoch,
                source_cwd: source.process.cwd,
                target: termloop_domain::SessionRelocationTarget::TaskWorktree,
                target_task_id: task_id.clone(),
                target_cwd: target.to_string_lossy().into_owned(),
                target_worktree_generation: proof.worktree_generation,
                target_managed_worktree_operation_id: proof.operation_id.clone(),
                stage: termloop_domain::SessionRelocationStage::SourceRetiring,
                started_at_epoch_ms: 20,
                updated_at_epoch_ms: 20,
            },
        )
        .unwrap();
    fixture
        .runtime
        .store
        .mark_session_relocation_target_starting(
            &fixture.runtime.write_authority,
            &session_id,
            "seed-task-attachment",
            21,
        )
        .unwrap();
    fixture
        .runtime
        .store
        .commit_session_relocation(
            &fixture.runtime.write_authority,
            &session_id,
            "seed-task-attachment",
            2,
            source.resume_ref.as_ref().unwrap(),
        )
        .unwrap();

    let preview = fixture
        .runtime
        .preview_session_relocation_to_project(json!({
            "sessionId": session_id,
            "projectId": fixture.project_id,
        }))
        .unwrap();
    assert_eq!(preview["can_relocate"], true);
    assert_eq!(preview["source_cwd"], target.to_string_lossy().as_ref());
    assert_eq!(preview["target_cwd"], project_cwd);
    assert_eq!(
        preview["manifest"]["provenance"]["template_ref"],
        "builtin.agent.project-relocation"
    );
    assert!(
        preview["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning == "taskLifecycleNoLongerApplies")
    );

    let operation_id = Uuid::new_v4().to_string();
    let plan = match fixture
        .runtime
        .plan_ticketed_agent_relocation(json!({
            "sessionId": session_id,
            "projectId": fixture.project_id,
            "operationId": operation_id,
            "relocationTicket": preview["relocation_ticket"],
        }))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("project relocation should prepare"),
    };
    assert!(plan.retires_source_runtime_for_test());
    assert_eq!(
        fixture.runtime.store.session_relocation_operations()[0].target,
        termloop_domain::SessionRelocationTarget::ProjectRoot
    );
    assert_eq!(
        fixture.runtime.store.session_relocation_operations()[0].target_cwd,
        project_cwd
    );
    drop(plan);
    fixture
        .runtime
        .fail_agent_resume(
            &session_id,
            termloop_domain::ResumeFailureReason::DaemonInterrupted,
        )
        .unwrap();
    assert_eq!(
        fixture.runtime.session_cwd(&session_id).as_deref(),
        Some(target.to_string_lossy().as_ref())
    );
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn ask_to_helper_can_relocate_to_project_without_gaining_interactive_mcp() {
    let (mut fixture, _task_id, source_session_id, target) = prepare_relocation_fixture();
    let transport = fixture.runtime.observation_transport.as_mut().unwrap();
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    transport
        .agents
        .get_mut("codex")
        .unwrap()
        .mcp_http_supported = true;
    let helper_id = "relocating-helper".to_owned();
    let helper_cwd = target.to_string_lossy().into_owned();
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            SessionRecord {
                id: helper_id.clone(),
                project_id: fixture.project_id.clone(),
                name: Some("Task helper".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: helper_cwd.clone(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.ask-to-helper".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 3,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: Some(source_session_id),
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: Some(AskToContinuation {
                    conversation_id: "helper-conversation".into(),
                    current_request_id: Some("helper-request".into()),
                }),
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    "00000000-0000-4000-8000-000000000003".into(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
                launch_selection: termloop_domain::AgentLaunchSelection {
                    model: "gpt-5.6-sol".into(),
                    permission: "acceptEdits".into(),
                    reasoning: "high".into(),
                },
            },
        )
        .unwrap();
    let (program, args) = termloop_platform::default_shell();
    fixture
        .runtime
        .terminal
        .spawn(PtySpawnSpec {
            session_id: helper_id.clone(),
            runtime_epoch: 3,
            program,
            args,
            cwd: helper_cwd,
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        })
        .unwrap();

    let preview = fixture
        .runtime
        .preview_session_relocation_to_project(json!({
            "sessionId": helper_id,
            "projectId": fixture.project_id,
        }))
        .unwrap();
    assert_eq!(preview["can_relocate"], true);
    assert_eq!(
        preview["manifest"]["provenance"]["template_ref"],
        "builtin.agent.ask-to-resume"
    );
    let plan = match fixture
        .runtime
        .plan_ticketed_agent_relocation(json!({
            "sessionId": helper_id,
            "projectId": fixture.project_id,
            "operationId": Uuid::new_v4().to_string(),
            "relocationTicket": preview["relocation_ticket"],
        }))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("helper relocation should prepare"),
    };
    assert!(matches!(
        plan.mcp_role_for_test(),
        Some(crate::session_launch::AgentMcpRole::Helper { request_id })
            if request_id.as_deref() == Some("helper-request")
    ));
    drop(plan);
    fixture
        .runtime
        .fail_agent_resume(
            &helper_id,
            termloop_domain::ResumeFailureReason::DaemonInterrupted,
        )
        .unwrap();
    let _ = std::fs::remove_dir_all(target);
}
