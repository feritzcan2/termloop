use super::*;

fn deleted_agent() -> SessionRecord {
    SessionRecord {
        id: "deleted-agent".into(),
        project_id: "project-1".into(),
        name: Some("Recover me".into()),
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "codex".into(),
            args: vec![],
            cwd: "/tmp".into(),
            agent_id: Some("codex".into()),
            template_ref: Some("builtin.agent.interactive".into()),
            template_version: Some(1),
        },
        launch_selection: Default::default(),
        lifecycle_state: "exited".into(),
        runtime_epoch: 7,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: ResumeRef::for_provider(
            ResumeProvider::Codex,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        ),
        resume_launch_guard: None,
        resume_failure: None,
    }
}

#[test]
fn deleted_agent_retains_recovery_state_for_thirty_days_and_restores_atomically() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-deleted-agent-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_session(&authority, deleted_agent()).unwrap();
    store
        .mark_agent_conversation_resumable(&authority, "deleted-agent")
        .unwrap();

    let deleted = store
        .move_agent_session_to_deleted(&authority, "deleted-agent", 100)
        .unwrap();
    assert!(store.sessions().is_empty());
    assert_eq!(deleted.session.name.as_deref(), Some("Recover me"));
    assert_eq!(
        deleted.purge_at_epoch_ms(),
        100 + termloop_domain::DELETED_SESSION_RETENTION_MS
    );
    assert_eq!(
        deleted.conversation_readiness,
        termloop_domain::AgentConversationReadiness::Resumable
    );

    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.deleted_sessions(), std::slice::from_ref(&deleted));
    assert_eq!(
        reopened
            .purge_expired_deleted_sessions(
                &authority,
                deleted.purge_at_epoch_ms().saturating_sub(1),
            )
            .unwrap(),
        0
    );
    let restored = reopened
        .restore_deleted_session_descriptor(&authority, "deleted-agent")
        .unwrap();
    assert_eq!(restored.lifecycle_state, "exited");
    assert!(reopened.deleted_sessions().is_empty());
    assert_eq!(
        reopened.agent_conversation_readiness("deleted-agent"),
        Some(termloop_domain::AgentConversationReadiness::Resumable)
    );

    let deleted_again = reopened
        .move_agent_session_to_deleted(&authority, "deleted-agent", 200)
        .unwrap();
    assert_eq!(
        reopened
            .purge_expired_deleted_sessions(&authority, deleted_again.purge_at_epoch_ms())
            .unwrap(),
        1
    );
    assert!(reopened.deleted_sessions().is_empty());
    let _ = std::fs::remove_file(path);
}
