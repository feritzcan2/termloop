use super::*;

#[test]
fn session_archive_journal_commits_marker_and_process_retirement_atomically() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-session-archive-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-session-archive".into(),
                name: "Project".into(),
                folder_path: "/repo".into(),
            },
        )
        .unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                id: "agent-archive".into(),
                project_id: "project-session-archive".into(),
                name: Some("Agent".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: "/repo".into(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(ResumeProvider::Codex, "thread-7".into()),
                resume_launch_guard: None,
                resume_failure: None,
                launch_selection: Default::default(),
            },
        )
        .unwrap();
    store
        .begin_session_archive(
            &authority,
            termloop_domain::SessionArchiveOperation {
                operation_id: "session-archive-operation".into(),
                session_id: "agent-archive".into(),
                project_id: "project-session-archive".into(),
                runtime_epoch: 7,
                state: termloop_domain::SessionArchiveOperationState::Prepared,
                requested_at_epoch_ms: 10,
            },
        )
        .unwrap();
    assert_eq!(store.sessions()[0].lifecycle_state, "running");
    assert_eq!(store.sessions()[0].archived_at_epoch_ms, None);
    assert_eq!(store.session_archive_operations().len(), 1);

    let archived = store
        .commit_session_archive(&authority, "agent-archive", "session-archive-operation", 20)
        .unwrap();
    assert_eq!(archived.lifecycle_state, "exited");
    assert_eq!(archived.archived_at_epoch_ms, Some(20));
    assert!(store.session_archive_operations().is_empty());

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.sessions()[0].archived_at_epoch_ms, Some(20));
    assert!(reopened.session_archive_operations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn archive_commit_and_restore_replace_one_bounded_current_state_atomically() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-archive-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-cleanup".into(),
                name: "Project".into(),
                folder_path: "/repo".into(),
            },
        )
        .unwrap();
    insert_cleanup_task(&mut store, &authority, "task-archive");
    let proof = provision_cleanup_task(
        &mut store,
        &authority,
        "task-archive",
        "provision-archive",
        1,
    );
    for id in ["agent-a", "agent-b"] {
        store
            .insert_session(
                &authority,
                SessionRecord {
                    id: id.into(),
                    project_id: "project-cleanup".into(),
                    name: Some(id.into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: proof.registered_worktree_path.clone(),
                        agent_id: Some("codex".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Codex,
                        format!(
                            "00000000-0000-4000-8000-00000000000{}",
                            if id == "agent-a" { "1" } else { "2" }
                        ),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                    launch_selection: Default::default(),
                },
            )
            .unwrap();
    }
    let operation = termloop_domain::TaskArchiveOperation {
        operation_id: "archive-operation".into(),
        task_id: "task-archive".into(),
        project_id: "project-cleanup".into(),
        worktree_path: Some(proof.registered_worktree_path),
        worktree_generation: proof.worktree_generation,
        targets: ["agent-a", "agent-b"]
            .into_iter()
            .map(|id| termloop_domain::TaskArchiveTarget {
                session_id: id.into(),
                runtime_epoch: 1,
                prior_lifecycle_state: "running".into(),
                prior_resume_failure: None,
                was_live_agent: true,
            })
            .collect(),
        state: termloop_domain::TaskArchiveOperationState::Prepared,
    };
    store.begin_task_archive(&authority, operation).unwrap();
    store
        .commit_task_archive(&authority, "task-archive", "archive-operation", 100)
        .unwrap();
    assert_eq!(store.tasks()[0].archived_at_epoch_ms, Some(100));
    assert!(store.task_archive_operations().is_empty());
    assert_eq!(store.task_archive_suspensions().len(), 2);
    assert!(
        store
            .sessions()
            .iter()
            .all(|session| session.lifecycle_state == "exited")
    );

    let resumable = store
        .restore_task_archive(
            &authority,
            "task-archive",
            &["agent-a".into(), "agent-b".into()],
            200,
        )
        .unwrap();
    assert_eq!(resumable, vec!["agent-a", "agent-b"]);
    assert_eq!(store.tasks()[0].archived_at_epoch_ms, None);
    assert!(store.task_archive_suspensions().is_empty());
    assert!(store.sessions().iter().all(|session| {
        session.lifecycle_state == "resumeFailed"
            && session.resume_failure == Some(ResumeFailureReason::DaemonInterrupted)
    }));
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.tasks()[0].archived_at_epoch_ms, None);
    let _ = std::fs::remove_file(path);
}
