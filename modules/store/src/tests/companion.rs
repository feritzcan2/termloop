use super::*;
use termloop_domain::{
    CompanionMessage, CompanionMessageAuthor, CompanionMessageInputMode, CompanionMessageKind,
    PlaybookConfiguration, PlaybookGateKind, PlaybookMilestone, PlaybookStepProgress,
    PlaybookStepVerdict, ProcessDescriptor, ResumeFailureReason, ResumeProvider, ResumeRef,
    RoutineActionHandling, RoutineTriggerMode, SessionKind, SessionRecord, StewardAgentId,
    StewardConfiguration, TaskStatus, TrackerConfiguration, TrackerKind, WorkerConfiguration,
};

#[test]
fn legacy_assistant_configuration_launch_options_default_during_deserialization() {
    let steward: StewardConfiguration = serde_json::from_value(serde_json::json!({
        "projectId": "project-1",
        "agentId": "codex",
        "enabled": false,
        "systemPrompt": "",
        "executorSessionId": null,
        "generation": 1,
        "updatedAtEpochMs": 1
    }))
    .unwrap();
    assert_eq!(steward.model, "default");
    assert_eq!(steward.reasoning, "default");
}

fn project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        name: id.into(),
        folder_path: format!("/tmp/{id}"),
    }
}

fn message(project_id: &str, sequence: u64, content: &str) -> CompanionMessage {
    CompanionMessage {
        id: format!("{project_id}:{sequence}"),
        project_id: project_id.into(),
        sequence,
        author: CompanionMessageAuthor::User,
        kind: CompanionMessageKind::Reply,
        input_mode: CompanionMessageInputMode::Text,
        refs: None,
        content: content.into(),
        created_at_epoch_ms: sequence,
    }
}

#[test]
fn transcript_append_is_ordered_bounded_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-companion-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let mut persisted = message("project-a", 1, "approval needed");
    persisted.author = CompanionMessageAuthor::Steward;
    persisted.kind = CompanionMessageKind::Attention;
    store
        .append_companion_message(&authority, persisted.clone())
        .unwrap();
    assert!(matches!(
        store.append_companion_message(&authority, message("project-a", 3, "gap")),
        Err(StoreError::RevisionConflict)
    ));
    drop(store);

    let store = Store::open(&path).unwrap();
    assert_eq!(store.companion_messages(), &[persisted]);
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_delete_removes_its_transcript_without_touching_another_project() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-companion-delete-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    for id in ["project-a", "project-b"] {
        store.insert_project(&authority, project(id)).unwrap();
        store
            .append_companion_message(&authority, message(id, 1, id))
            .unwrap();
    }
    store
        .delete_project_and_related_records(&authority, "project-a")
        .unwrap();
    assert_eq!(store.companion_messages().len(), 1);
    assert_eq!(store.companion_messages()[0].project_id, "project-b");
    let _ = std::fs::remove_file(path);
}

#[test]
fn append_refuses_the_hard_quota_without_writing() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-companion-quota-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.state.projects.push(project("project-a"));
    for index in 0..termloop_domain::COMPANION_TRANSCRIPT_HARD_MESSAGES {
        store.state.companion_messages.push(message(
            "project-a",
            u64::try_from(index + 1).unwrap(),
            "x",
        ));
    }
    let revision = store.revision();
    assert!(matches!(
        store.append_companion_message(
            &authority,
            message(
                "project-a",
                u64::try_from(termloop_domain::COMPANION_TRANSCRIPT_HARD_MESSAGES + 1).unwrap(),
                "x"
            )
        ),
        Err(StoreError::CompanionTranscriptQuotaExceeded)
    ));
    assert_eq!(store.revision(), revision);
    store.state.companion_messages.push(message(
        "project-a",
        u64::try_from(termloop_domain::COMPANION_TRANSCRIPT_HARD_MESSAGES + 1).unwrap(),
        "x",
    ));
    assert!(crate::validation::validate_current_state(&store.state).is_err());
}

#[test]
fn steward_configuration_is_one_current_revision_checked_row() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-steward-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    let first = StewardConfiguration {
        project_id: "project-a".into(),
        agent_id: StewardAgentId::Codex,
        model: "default".into(),
        permission: "bypassPermissions".into(),
        reasoning: "default".into(),
        enabled: false,
        system_prompt: "PM".into(),
        executor_session_id: None,
        generation: 1,
        updated_at_epoch_ms: 1,
    };
    store
        .set_steward_configuration(&authority, first, revision)
        .unwrap();
    assert!(matches!(
        store.set_steward_configuration(
            &authority,
            StewardConfiguration {
                project_id: "project-a".into(),
                agent_id: StewardAgentId::Claude,
                model: "default".into(),
                permission: "default".into(),
                reasoning: "default".into(),
                enabled: true,
                system_prompt: "PM".into(),
                executor_session_id: None,
                generation: 2,
                updated_at_epoch_ms: 2,
            },
            revision,
        ),
        Err(StoreError::RevisionConflict)
    ));
    assert_eq!(store.steward_configurations().len(), 1);
    assert_eq!(store.steward_configurations()[0].generation, 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn steward_session_attach_is_one_atomic_generation_checked_write() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-steward-attach-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let configuration = StewardConfiguration {
        project_id: "project-a".into(),
        agent_id: StewardAgentId::Claude,
        model: "default".into(),
        permission: "default".into(),
        reasoning: "default".into(),
        enabled: true,
        system_prompt: "PM".into(),
        executor_session_id: None,
        generation: 1,
        updated_at_epoch_ms: 1,
    };
    let revision = store.revision();
    store
        .set_steward_configuration(&authority, configuration, revision)
        .unwrap();
    let session = SessionRecord {
        launch_selection: Default::default(),
        id: "session-1".into(),
        project_id: "project-a".into(),
        name: Some("Project Steward".into()),
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: "/tmp/restricted".into(),
            agent_id: Some("claude".into()),
            template_ref: Some("builtin.steward.executor".into()),
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
            ResumeProvider::Claude,
            "123e4567-e89b-42d3-a456-426614174000".into(),
        ),
        resume_launch_guard: None,
        resume_failure: None,
    };
    let before_attach = store.revision();
    let attached = store
        .attach_steward_executor_session(&authority, session.clone(), "project-a", 1, 2)
        .unwrap();
    assert_eq!(store.revision(), before_attach + 1);
    assert_eq!(attached.executor_session_id.as_deref(), Some("session-1"));
    assert_eq!(store.sessions(), std::slice::from_ref(&session));
    assert!(store.steward_conversation_ref("project-a").is_none());
    assert!(matches!(
        store.attach_steward_executor_session(&authority, session, "project-a", 1, 3,),
        Err(StoreError::ConstraintViolation)
    ));
    store.mark_session_exited(&authority, "session-1").unwrap();
    assert!(
        store.sessions().is_empty(),
        "an exited assistant executor descriptor is current-state debris and is removed with its pointer"
    );
    assert!(matches!(
        store.delete_session_descriptor(&authority, "session-1"),
        Err(StoreError::NotFound)
    ));
    assert_eq!(store.steward_configurations()[0].executor_session_id, None);
    assert!(store.steward_conversation_ref("project-a").is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn worker_owns_session_and_tracker_only_references_worker() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-worker-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .set_worker_configuration(
            &authority,
            WorkerConfiguration {
                id: "worker-1".into(),
                project_id: "project-a".into(),
                name: "Worker 1".into(),
                agent_id: StewardAgentId::Claude,
                model: "default".into(),
                permission: "default".into(),
                reasoning: "default".into(),
                enabled: true,
                ping_interval_seconds: 60,
                worker_prompt: String::new(),
                system_prompt: String::new(),
                executor_session_id: None,
                generation: 1,
                updated_at_epoch_ms: 1,
            },
            store.revision(),
        )
        .unwrap();
    store
        .set_tracker_configuration(
            &authority,
            TrackerConfiguration {
                id: "tracker-1".into(),
                project_id: "project-a".into(),
                kind: TrackerKind::Slack,
                trigger_mode: RoutineTriggerMode::Schedule,
                name: "Slack actions".into(),
                prompt: "Use the Slack connector to inspect #product.".into(),
                steward_instructions: String::new(),
                worker_id: "worker-1".into(),
                enabled: false,
                schedule_interval_seconds: 300,
                generation: 1,
                context_markdown: String::new(),
                context_revision: 1,
                recent_source_keys: vec![],
                related_task_ids: vec![],
                action_handling: RoutineActionHandling::Off,
                pending_routine_findings: vec![],
                last_check_started_at_epoch_ms: None,
                last_attempt_at_epoch_ms: None,
                last_successful_report_at_epoch_ms: None,
                updated_at_epoch_ms: 1,
            },
            store.revision(),
        )
        .unwrap();
    let session = SessionRecord {
        launch_selection: Default::default(),
        id: "worker-session".into(),
        project_id: "project-a".into(),
        name: Some("Worker 1".into()),
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: "/tmp".into(),
            agent_id: Some("claude".into()),
            template_ref: Some("builtin.worker.executor".into()),
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
            ResumeProvider::Claude,
            "123e4567-e89b-42d3-a456-426614174000".into(),
        ),
        resume_launch_guard: None,
        resume_failure: None,
    };
    let attached = store
        .attach_worker_executor_session(&authority, session, "worker-1", 1, 2)
        .unwrap();
    assert_eq!(
        attached.executor_session_id.as_deref(),
        Some("worker-session")
    );
    assert_eq!(store.tracker_configurations()[0].worker_id, "worker-1");

    // One confirmed Worker deletion removes its live executor descriptor and
    // owned Routine in the same commit; callers never dismantle ownership by
    // hand or stop the Worker first.
    let revision = store.revision();
    store
        .delete_worker_configuration(&authority, "worker-1", revision, 3)
        .unwrap();
    assert!(store.worker_configurations().is_empty());
    assert!(store.tracker_configurations().is_empty());
    assert!(
        store
            .sessions()
            .iter()
            .all(|session| session.id != "worker-session")
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_accepts_more_than_the_legacy_sixteen_routines() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-unbounded-routines-{}-{}.json",
        std::process::id(),
        termloop_platform::generate_uuid_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .set_worker_configuration(
            &authority,
            WorkerConfiguration {
                id: "worker-1".into(),
                project_id: "project-a".into(),
                name: "Worker 1".into(),
                agent_id: StewardAgentId::Codex,
                model: "default".into(),
                permission: "default".into(),
                reasoning: "default".into(),
                enabled: false,
                ping_interval_seconds: 60,
                worker_prompt: String::new(),
                system_prompt: String::new(),
                executor_session_id: None,
                generation: 1,
                updated_at_epoch_ms: 1,
            },
            store.revision(),
        )
        .unwrap();

    for index in 0..20 {
        store
            .set_tracker_configuration(
                &authority,
                TrackerConfiguration {
                    id: format!("routine-{index}"),
                    project_id: "project-a".into(),
                    kind: TrackerKind::Custom,
                    trigger_mode: RoutineTriggerMode::Schedule,
                    name: format!("Routine {index}"),
                    prompt: "Inspect one configured source and report factual evidence.".into(),
                    steward_instructions: String::new(),
                    worker_id: "worker-1".into(),
                    enabled: false,
                    schedule_interval_seconds: 60,
                    generation: 1,
                    context_markdown: String::new(),
                    context_revision: 1,
                    recent_source_keys: vec![],
                    related_task_ids: vec![],
                    action_handling: RoutineActionHandling::Off,
                    pending_routine_findings: vec![],
                    last_check_started_at_epoch_ms: None,
                    last_attempt_at_epoch_ms: None,
                    last_successful_report_at_epoch_ms: None,
                    updated_at_epoch_ms: 1,
                },
                store.revision(),
            )
            .unwrap();
    }
    assert_eq!(store.tracker_configurations().len(), 20);

    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.tracker_configurations().len(), 20);
    let _ = std::fs::remove_file(path);
}

#[test]
fn tracker_rejects_missing_or_cross_project_worker() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-tracker-worker-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let result = store.set_tracker_configuration(
        &authority,
        TrackerConfiguration {
            id: "tracker-1".into(),
            project_id: "project-a".into(),
            kind: TrackerKind::Runtime,
            trigger_mode: RoutineTriggerMode::Schedule,
            name: "Runtime".into(),
            prompt: "Inspect the configured log connector and report failures.".into(),
            steward_instructions: String::new(),
            worker_id: "missing".into(),
            enabled: false,
            schedule_interval_seconds: 60,
            generation: 1,
            context_markdown: String::new(),
            context_revision: 1,
            recent_source_keys: vec![],
            related_task_ids: vec![],
            action_handling: RoutineActionHandling::Off,
            pending_routine_findings: vec![],
            last_check_started_at_epoch_ms: None,
            last_attempt_at_epoch_ms: None,
            last_successful_report_at_epoch_ms: None,
            updated_at_epoch_ms: 1,
        },
        store.revision(),
    );
    assert!(matches!(result, Err(StoreError::ConstraintViolation)));
    let _ = std::fs::remove_file(path);
}

fn assistant_session(id: &str, project_id: &str, template_ref: &str, name: &str) -> SessionRecord {
    SessionRecord {
        launch_selection: Default::default(),
        id: id.into(),
        project_id: project_id.into(),
        name: Some(name.into()),
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: format!("/tmp/{project_id}"),
            agent_id: Some("claude".into()),
            template_ref: Some(template_ref.into()),
            template_version: Some(1),
        },
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

fn ordinary_agent_session(id: &str, project_id: &str) -> SessionRecord {
    let mut session = assistant_session(id, project_id, "builtin.agent.interactive", id);
    session.resume_ref = ResumeRef::for_provider(
        ResumeProvider::Claude,
        "123e4567-e89b-42d3-a456-426614174099".into(),
    );
    session
}

fn steward_configuration(project_id: &str, generation: u64, enabled: bool) -> StewardConfiguration {
    StewardConfiguration {
        project_id: project_id.into(),
        agent_id: StewardAgentId::Claude,
        model: "default".into(),
        permission: "default".into(),
        reasoning: "default".into(),
        enabled,
        system_prompt: "PM".into(),
        executor_session_id: None,
        generation,
        updated_at_epoch_ms: generation,
    }
}

fn worker_configuration(
    id: &str,
    project_id: &str,
    generation: u64,
    enabled: bool,
) -> WorkerConfiguration {
    WorkerConfiguration {
        id: id.into(),
        project_id: project_id.into(),
        name: "Worker 1".into(),
        agent_id: StewardAgentId::Claude,
        model: "default".into(),
        permission: "default".into(),
        reasoning: "default".into(),
        enabled,
        ping_interval_seconds: 60,
        worker_prompt: String::new(),
        system_prompt: String::new(),
        executor_session_id: None,
        generation,
        updated_at_epoch_ms: generation,
    }
}

#[test]
fn steward_delete_resets_only_the_project_assistant_tree_in_one_commit() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-assistant-reset-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.state.projects = vec![project("project-a"), project("project-b")];
    store.state.tasks = vec![
        TaskRecord {
            id: "task-a".into(),
            project_id: "project-a".into(),
            title: "A".into(),
            brief: None,
            status: TaskStatus::Open,
            archived_at_epoch_ms: None,
            branch: None,
            worktree: None,
            worktree_generation: 0,
            steward_brief_markdown: "Current Steward summary".into(),
            steward_brief_revision: 4,
            rank: 0,
            created_at_epoch_ms: 1,
            updated_at_epoch_ms: 1,
        },
        TaskRecord {
            id: "task-b".into(),
            project_id: "project-b".into(),
            title: "B".into(),
            brief: None,
            status: TaskStatus::Open,
            archived_at_epoch_ms: None,
            branch: None,
            worktree: None,
            worktree_generation: 0,
            steward_brief_markdown: "Keep this summary".into(),
            steward_brief_revision: 2,
            rank: 0,
            created_at_epoch_ms: 1,
            updated_at_epoch_ms: 1,
        },
    ];
    let mut steward = steward_configuration("project-a", 1, true);
    steward.executor_session_id = Some("steward-a".into());
    store.state.steward_configurations =
        vec![steward, steward_configuration("project-b", 1, false)];
    let mut worker = worker_configuration("worker-a", "project-a", 1, true);
    worker.executor_session_id = Some("worker-a-session".into());
    store.state.worker_configurations.push(worker);
    store
        .state
        .tracker_configurations
        .push(TrackerConfiguration {
            id: "routine-a".into(),
            project_id: "project-a".into(),
            kind: TrackerKind::CiPr,
            trigger_mode: RoutineTriggerMode::OnDemand,
            name: "CI is green".into(),
            prompt: "Check CI for the focused Task.".into(),
            steward_instructions: String::new(),
            worker_id: "worker-a".into(),
            enabled: true,
            schedule_interval_seconds: 60,
            generation: 1,
            context_markdown: String::new(),
            context_revision: 1,
            recent_source_keys: vec![],
            related_task_ids: vec![],
            action_handling: RoutineActionHandling::Off,
            pending_routine_findings: vec![],
            last_check_started_at_epoch_ms: None,
            last_attempt_at_epoch_ms: None,
            last_successful_report_at_epoch_ms: None,
            updated_at_epoch_ms: 1,
        });
    let milestone = PlaybookMilestone {
        id: "ci".into(),
        title: "CI is green".into(),
        gate: PlaybookGateKind::Automatic,
        routine_id: "routine-a".into(),
        retry_delay_seconds: 60,
        condition: String::new(),
        approver: None,
    };
    store
        .state
        .playbook_configurations
        .push(PlaybookConfiguration {
            project_id: "project-a".into(),
            revision: 1,
            active_pipeline_name: "Ship".into(),
            milestones: vec![milestone],
            saved_pipelines: vec![],
            updated_at_epoch_ms: 1,
        });
    store
        .state
        .playbook_step_progress
        .push(PlaybookStepProgress {
            task_id: "task-a".into(),
            milestone_id: "ci".into(),
            routine_id: "routine-a".into(),
            verdict: PlaybookStepVerdict::Passed,
            evidence: "CI passed".into(),
            decided_at_epoch_ms: 2,
            next_attempt_at_epoch_ms: None,
        });
    store.state.companion_messages = vec![
        message("project-a", 1, "reset me"),
        message("project-b", 1, "keep me"),
    ];
    store.state.sessions = vec![
        assistant_session(
            "steward-a",
            "project-a",
            "builtin.steward.executor",
            "Steward",
        ),
        assistant_session(
            "worker-a-session",
            "project-a",
            "builtin.worker.executor",
            "Worker",
        ),
        assistant_session(
            "builder-a",
            "project-a",
            "builtin.builder.playbook",
            "Builder",
        ),
        ordinary_agent_session("ordinary-a", "project-a"),
        assistant_session(
            "settings-improver-a",
            "project-a",
            "builtin.improver.skill-definition",
            "Skill improver",
        ),
    ];
    store.state.agent_conversation_readiness = store
        .state
        .sessions
        .iter()
        .map(|session| AgentConversationReadinessRecord {
            session_id: session.id.clone(),
            readiness: AgentConversationReadiness::Unconfirmed,
        })
        .collect();
    assert!(crate::validation::validate_current_state(&store.state).is_ok());

    let reset = store
        .reset_project_assistant(&authority, "project-a", store.revision(), 10)
        .unwrap();

    assert_eq!(reset.deleted_workers, 1);
    assert_eq!(reset.deleted_routines, 1);
    assert_eq!(reset.deleted_messages, 1);
    assert!(reset.playbook_deleted);
    assert_eq!(reset.session_ids.len(), 3);
    assert!(
        store
            .steward_configurations()
            .iter()
            .all(|value| value.project_id != "project-a")
    );
    assert_eq!(store.steward_configurations()[0].project_id, "project-b");
    assert!(store.worker_configurations().is_empty());
    assert!(store.tracker_configurations().is_empty());
    assert!(store.playbook_configurations().is_empty());
    assert!(store.playbook_step_progress().is_empty());
    assert_eq!(
        store.companion_messages(),
        &[message("project-b", 1, "keep me")]
    );
    assert_eq!(store.tasks()[0].steward_brief_markdown, "");
    assert_eq!(store.tasks()[0].steward_brief_revision, 5);
    assert_eq!(store.tasks()[1].steward_brief_markdown, "Keep this summary");
    assert_eq!(
        store
            .sessions()
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        ["ordinary-a", "settings-improver-a"]
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn steward_replacement_cycles_leave_only_the_current_descriptor() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-steward-cycles-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .insert_session(&authority, ordinary_agent_session("ordinary", "project-a"))
        .unwrap();
    store.mark_session_exited(&authority, "ordinary").unwrap();
    let revision = store.revision();
    store
        .set_steward_configuration(
            &authority,
            steward_configuration("project-a", 1, true),
            revision,
        )
        .unwrap();

    // Terminal exit and same-generation relaunch: the exited descriptor is
    // removed with its pointer instead of accumulating per relaunch.
    store
        .attach_steward_executor_session(
            &authority,
            assistant_session(
                "steward-1",
                "project-a",
                "builtin.steward.executor",
                "Project Steward",
            ),
            "project-a",
            1,
            2,
        )
        .unwrap();
    store.mark_session_exited(&authority, "steward-1").unwrap();
    assert!(
        !store
            .sessions()
            .iter()
            .any(|session| session.id == "steward-1")
    );
    store
        .attach_steward_executor_session(
            &authority,
            assistant_session(
                "steward-2",
                "project-a",
                "builtin.steward.executor",
                "Project Steward",
            ),
            "project-a",
            1,
            3,
        )
        .unwrap();

    // Configuration replacement: the pointer moves off the old executor first;
    // its late terminal exit still removes the obsolete descriptor.
    let revision = store.revision();
    store
        .set_steward_configuration(
            &authority,
            steward_configuration("project-a", 2, true),
            revision,
        )
        .unwrap();
    store.mark_session_exited(&authority, "steward-2").unwrap();
    store
        .attach_steward_executor_session(
            &authority,
            assistant_session(
                "steward-3",
                "project-a",
                "builtin.steward.executor",
                "Project Steward",
            ),
            "project-a",
            2,
            4,
        )
        .unwrap();
    let steward_descriptors = store
        .sessions()
        .iter()
        .filter(|session| {
            session.process.template_ref.as_deref() == Some("builtin.steward.executor")
        })
        .map(|session| session.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(steward_descriptors, ["steward-3"]);

    // Disable removes the last executor descriptor once it exits.
    let revision = store.revision();
    store
        .set_steward_configuration(
            &authority,
            steward_configuration("project-a", 3, false),
            revision,
        )
        .unwrap();
    store.mark_session_exited(&authority, "steward-3").unwrap();
    assert!(
        !store
            .sessions()
            .iter()
            .any(|session| session.process.template_ref.as_deref()
                == Some("builtin.steward.executor"))
    );

    // Ordinary exited Agent Sessions keep their explicit resume/close semantics.
    let ordinary = store
        .sessions()
        .iter()
        .find(|session| session.id == "ordinary")
        .expect("ordinary exited Agent descriptor is preserved");
    assert_eq!(ordinary.lifecycle_state, "exited");
    let _ = std::fs::remove_file(path);
}

#[test]
fn worker_replacement_disable_and_delete_leave_no_stale_descriptors() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-worker-cycles-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .insert_session(&authority, ordinary_agent_session("ordinary", "project-a"))
        .unwrap();
    store.mark_session_exited(&authority, "ordinary").unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(
            &authority,
            worker_configuration("worker-1", "project-a", 1, true),
            revision,
        )
        .unwrap();

    for (cycle, session_id) in ["worker-session-1", "worker-session-2", "worker-session-3"]
        .iter()
        .enumerate()
    {
        store
            .attach_worker_executor_session(
                &authority,
                assistant_session(
                    session_id,
                    "project-a",
                    "builtin.worker.executor",
                    "Worker 1",
                ),
                "worker-1",
                1,
                u64::try_from(cycle).unwrap() + 2,
            )
            .unwrap();
        let worker_descriptors = store
            .sessions()
            .iter()
            .filter(|session| {
                session.process.template_ref.as_deref() == Some("builtin.worker.executor")
            })
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        assert_eq!(worker_descriptors, [session_id.to_owned()]);
        store.mark_session_exited(&authority, session_id).unwrap();
        assert!(
            !store
                .sessions()
                .iter()
                .any(|session| session.process.template_ref.as_deref()
                    == Some("builtin.worker.executor")),
            "repeated Worker relaunch cycles must not accumulate exited descriptors"
        );
    }

    // Disable then delete: no assistant descriptor survives removal.
    let revision = store.revision();
    store
        .set_worker_configuration(
            &authority,
            worker_configuration("worker-1", "project-a", 2, false),
            revision,
        )
        .unwrap();
    let revision = store.revision();
    store
        .delete_worker_configuration(&authority, "worker-1", revision, 3)
        .unwrap();
    assert!(store.worker_configurations().is_empty());
    assert!(
        !store
            .sessions()
            .iter()
            .any(|session| session.process.template_ref.as_deref()
                == Some("builtin.worker.executor"))
    );
    let ordinary = store
        .sessions()
        .iter()
        .find(|session| session.id == "ordinary")
        .expect("ordinary exited Agent descriptor is preserved");
    assert_eq!(ordinary.lifecycle_state, "exited");
    let _ = std::fs::remove_file(path);
}

#[test]
fn restart_reconcile_resumes_current_assistants_and_sweeps_only_obsolete_debris() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-assistant-debris-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.state.projects.push(project("project-a"));
    // Accumulated legacy debris from earlier replacement/restart cycles.
    for debris_id in ["steward-old-1", "steward-old-2", "worker-old-1"] {
        let template = if debris_id.starts_with("steward") {
            "builtin.steward.executor"
        } else {
            "builtin.worker.executor"
        };
        let mut debris = assistant_session(debris_id, "project-a", template, debris_id);
        debris.lifecycle_state = "exited".into();
        store.state.sessions.push(debris);
    }
    // Live assistants retain their exact logical Session and provider-native
    // conversation identities across the daemon epoch.
    let mut live = assistant_session(
        "steward-live",
        "project-a",
        "builtin.assistant.activation",
        "Project Steward",
    );
    let steward_resume_ref = ResumeRef::for_provider(
        ResumeProvider::Claude,
        "123e4567-e89b-42d3-a456-426614174010".into(),
    )
    .unwrap();
    live.resume_ref = Some(steward_resume_ref.clone());
    store.state.sessions.push(live);
    let mut configuration = steward_configuration("project-a", 1, true);
    configuration.executor_session_id = Some("steward-live".into());
    store.state.steward_configurations.push(configuration);
    let mut worker_live = assistant_session(
        "worker-live",
        "project-a",
        "builtin.assistant.activation",
        "Worker 1",
    );
    let worker_resume_ref = ResumeRef::for_provider(
        ResumeProvider::Claude,
        "123e4567-e89b-42d3-a456-426614174011".into(),
    )
    .unwrap();
    worker_live.resume_ref = Some(worker_resume_ref.clone());
    store.state.sessions.push(worker_live);
    let mut worker = worker_configuration("worker-1", "project-a", 1, true);
    worker.executor_session_id = Some("worker-live".into());
    store.state.worker_configurations.push(worker);
    // Ownership-uncertain failures keep their descriptor so the daemon-owned
    // recovery and reap path stays reachable.
    let mut uncertain = assistant_session(
        "worker-uncertain",
        "project-a",
        "builtin.worker.executor",
        "Worker 1",
    );
    uncertain.lifecycle_state = "resumeFailed".into();
    uncertain.resume_failure = Some(ResumeFailureReason::RuntimeOwnershipUncertain);
    store.state.sessions.push(uncertain);
    let mut running_ordinary = ordinary_agent_session("ordinary-running", "project-a");
    running_ordinary.lifecycle_state = "running".into();
    store.state.sessions.push(running_ordinary);
    let mut exited_ordinary = ordinary_agent_session("ordinary-exited", "project-a");
    exited_ordinary.lifecycle_state = "exited".into();
    store.state.sessions.push(exited_ordinary);

    store.reconcile_restart(&authority).unwrap();

    let mut remaining = store
        .sessions()
        .iter()
        .map(|session| session.id.as_str())
        .collect::<Vec<_>>();
    remaining.sort_unstable();
    assert_eq!(
        remaining,
        [
            "ordinary-exited",
            "ordinary-running",
            "steward-live",
            "worker-live",
            "worker-uncertain"
        ]
    );
    for session_id in ["ordinary-running", "steward-live", "worker-live"] {
        assert_eq!(
            store
                .sessions()
                .iter()
                .find(|session| session.id == session_id)
                .unwrap()
                .lifecycle_state,
            "resuming"
        );
    }
    assert_eq!(
        store
            .sessions()
            .iter()
            .find(|session| session.id == "steward-live")
            .and_then(|session| session.resume_ref.as_ref()),
        Some(&steward_resume_ref)
    );
    assert_eq!(
        store
            .sessions()
            .iter()
            .find(|session| session.id == "worker-live")
            .and_then(|session| session.resume_ref.as_ref()),
        Some(&worker_resume_ref)
    );
    assert_eq!(
        store.steward_configurations()[0]
            .executor_session_id
            .as_deref(),
        Some("steward-live")
    );
    assert_eq!(
        store.worker_configurations()[0]
            .executor_session_id
            .as_deref(),
        Some("worker-live")
    );

    store
        .mark_session_resume_failed(
            &authority,
            "steward-live",
            ResumeFailureReason::StartupTimedOut,
        )
        .unwrap();
    assert_eq!(
        store.steward_configurations()[0]
            .executor_session_id
            .as_deref(),
        Some("steward-live"),
        "a failed resume must not authorize a fresh Steward conversation"
    );
    store.reconcile_restart(&authority).unwrap();
    assert_eq!(
        store
            .sessions()
            .iter()
            .find(|session| session.id == "steward-live")
            .unwrap()
            .lifecycle_state,
        "resumeFailed",
        "a failed resume stays available for explicit same-conversation Retry"
    );
    assert_eq!(
        store.steward_configurations()[0]
            .executor_session_id
            .as_deref(),
        Some("steward-live")
    );
    let _ = std::fs::remove_file(path);
}
