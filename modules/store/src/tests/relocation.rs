use super::*;
use termloop_domain::{SessionRelocationOperation, SessionRelocationStage};

fn relocation_fixture(
    suffix: &str,
) -> (
    std::path::PathBuf,
    CoreWriteAuthority,
    Store,
    ManagedWorktreeProof,
) {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-relocation-{suffix}-{}-{}.json",
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
    insert_cleanup_task(&mut store, &authority, "task-relocation");
    let proof = provision_cleanup_task(
        &mut store,
        &authority,
        "task-relocation",
        "provision-relocation",
        10,
    );
    store
        .insert_session(
            &authority,
            SessionRecord {
                id: "agent-relocation".into(),
                project_id: "project-cleanup".into(),
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
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    "00000000-0000-4000-8000-000000000007".into(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
                launch_selection: Default::default(),
            },
        )
        .unwrap();
    (path, authority, store, proof)
}

fn operation(proof: &ManagedWorktreeProof, operation_id: &str) -> SessionRelocationOperation {
    SessionRelocationOperation {
        operation_id: operation_id.into(),
        session_id: "agent-relocation".into(),
        project_id: "project-cleanup".into(),
        source_runtime_epoch: 7,
        source_cwd: "/repo".into(),
        target: termloop_domain::SessionRelocationTarget::TaskWorktree,
        target_task_id: "task-relocation".into(),
        target_cwd: proof.registered_worktree_path.clone(),
        target_worktree_generation: proof.worktree_generation,
        target_managed_worktree_operation_id: proof.operation_id.clone(),
        stage: SessionRelocationStage::SourceRetiring,
        started_at_epoch_ms: 20,
        updated_at_epoch_ms: 20,
    }
}

#[test]
fn relocation_commits_cwd_only_after_target_starting() {
    let (path, authority, mut store, proof) = relocation_fixture("commit");
    let resume_ref = store.sessions()[0].resume_ref.clone().unwrap();
    let replacement_resume_ref = ResumeRef::for_provider(
        ResumeProvider::Codex,
        "00000000-0000-4000-8000-000000000099".into(),
    )
    .unwrap();
    let requested = operation(&proof, "relocation-operation");
    store
        .begin_session_relocation(&authority, requested.clone())
        .unwrap();
    assert_eq!(store.sessions()[0].process.cwd, "/repo");
    assert_eq!(store.sessions()[0].lifecycle_state, "resuming");
    assert!(matches!(
        store.commit_session_relocation(
            &authority,
            "agent-relocation",
            "relocation-operation",
            8,
            &resume_ref
        ),
        Err(StoreError::ConstraintViolation)
    ));

    store
        .mark_session_relocation_target_starting(
            &authority,
            "agent-relocation",
            "relocation-operation",
            21,
        )
        .unwrap();
    assert!(matches!(
        store.commit_session_relocation(
            &authority,
            "agent-relocation",
            "relocation-operation",
            7,
            &resume_ref
        ),
        Err(StoreError::ConstraintViolation)
    ));
    let relocated = store
        .commit_session_relocation(
            &authority,
            "agent-relocation",
            "relocation-operation",
            8,
            &replacement_resume_ref,
        )
        .unwrap();
    assert_eq!(relocated.process.cwd, proof.registered_worktree_path);
    assert_eq!(relocated.lifecycle_state, "running");
    assert_eq!(relocated.runtime_epoch, 8);
    assert_eq!(relocated.resume_ref.as_ref(), Some(&replacement_resume_ref));
    assert!(store.session_relocation_operations().is_empty());
    assert_eq!(store.session_relocation_receipts().len(), 1);
    assert_eq!(
        store.session_relocation_receipts()[0].operation_id,
        "relocation-operation"
    );

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.sessions()[0].process.cwd, relocated.process.cwd);
    assert!(reopened.session_relocation_operations().is_empty());
    assert_eq!(reopened.session_relocation_receipts().len(), 1);
    reopened
        .mark_session_resuming(&authority, "agent-relocation")
        .unwrap();
    reopened
        .complete_session_resume(&authority, "agent-relocation", &replacement_resume_ref, 9)
        .unwrap();
    assert!(
        reopened.session_relocation_receipts().is_empty(),
        "a later runtime generation supersedes the current relocation result"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn retryable_failed_session_can_begin_another_relocation_attempt() {
    let (path, authority, mut store, proof) = relocation_fixture("retryable");
    store
        .mark_session_resume_failed(
            &authority,
            "agent-relocation",
            ResumeFailureReason::StartupTimedOut,
        )
        .unwrap();

    store
        .begin_session_relocation(&authority, operation(&proof, "relocation-retry"))
        .unwrap();

    assert_eq!(store.sessions()[0].lifecycle_state, "resuming");
    assert_eq!(store.session_relocation_operations().len(), 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn relocation_failure_and_restart_reconciliation_retain_source_cwd() {
    let (path, authority, mut store, proof) = relocation_fixture("reconcile");
    store
        .begin_session_relocation(&authority, operation(&proof, "relocation-crash"))
        .unwrap();
    drop(store);

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.sessions()[0].process.cwd, "/repo");
    assert_eq!(reopened.session_relocation_operations().len(), 1);
    reopened.reconcile_session_relocations(&authority).unwrap();
    assert_eq!(reopened.sessions()[0].process.cwd, "/repo");
    assert_eq!(reopened.sessions()[0].lifecycle_state, "resumeFailed");
    assert_eq!(
        reopened.sessions()[0].resume_failure,
        Some(ResumeFailureReason::DaemonInterrupted),
    );
    assert!(reopened.session_relocation_operations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_relocation_commits_project_cwd_and_clears_task_launch_guard() {
    let (path, authority, mut store, proof) = relocation_fixture("project-target");
    let resume_ref = store.sessions()[0].resume_ref.clone().unwrap();
    store
        .begin_session_relocation(&authority, operation(&proof, "into-task"))
        .unwrap();
    store
        .mark_session_relocation_target_starting(&authority, "agent-relocation", "into-task", 21)
        .unwrap();
    store
        .commit_session_relocation(&authority, "agent-relocation", "into-task", 8, &resume_ref)
        .unwrap();

    let requested = SessionRelocationOperation {
        operation_id: "into-project".into(),
        session_id: "agent-relocation".into(),
        project_id: "project-cleanup".into(),
        source_runtime_epoch: 8,
        source_cwd: proof.registered_worktree_path.clone(),
        target: termloop_domain::SessionRelocationTarget::ProjectRoot,
        target_task_id: "task-relocation".into(),
        target_cwd: "/repo".into(),
        target_worktree_generation: proof.worktree_generation,
        target_managed_worktree_operation_id: proof.operation_id.clone(),
        stage: SessionRelocationStage::SourceRetiring,
        started_at_epoch_ms: 30,
        updated_at_epoch_ms: 30,
    };
    store
        .begin_session_relocation(&authority, requested)
        .unwrap();
    assert_eq!(
        store.sessions()[0].process.cwd,
        proof.registered_worktree_path
    );
    assert!(matches!(
        store.update_project_details(
            &authority,
            "project-cleanup",
            "Project".into(),
            "/moved-project".into(),
        ),
        Err(StoreError::JournalConflict { operation_id }) if operation_id == "into-project"
    ));
    store
        .mark_session_relocation_target_starting(&authority, "agent-relocation", "into-project", 31)
        .unwrap();
    let relocated = store
        .commit_session_relocation(
            &authority,
            "agent-relocation",
            "into-project",
            9,
            &resume_ref,
        )
        .unwrap();

    assert_eq!(relocated.process.cwd, "/repo");
    assert!(relocated.resume_launch_guard.is_none());
    assert_eq!(
        store.session_relocation_receipts()[0].target,
        termloop_domain::SessionRelocationTarget::ProjectRoot
    );
    store
        .update_project_details(
            &authority,
            "project-cleanup",
            "Project".into(),
            "/moved-project".into(),
        )
        .unwrap();
    assert!(
        store.session_relocation_receipts().is_empty(),
        "changing the Project checkout supersedes the relocation result"
    );
    drop(store);
    assert!(Store::open(&path).is_ok());
    let _ = std::fs::remove_file(path);
}

#[test]
fn terminal_session_mutations_clear_relocation_before_persisting() {
    for (suffix, exited) in [("terminal-failure", false), ("terminal-exit", true)] {
        let (path, authority, mut store, proof) = relocation_fixture(suffix);
        store
            .begin_session_relocation(&authority, operation(&proof, suffix))
            .unwrap();
        if exited {
            store
                .mark_session_exited(&authority, "agent-relocation")
                .unwrap();
        } else {
            store
                .mark_session_resume_failed(
                    &authority,
                    "agent-relocation",
                    ResumeFailureReason::RuntimeOwnershipUncertain,
                )
                .unwrap();
        }
        assert!(store.session_relocation_operations().is_empty());
        drop(store);
        assert!(Store::open(&path).is_ok());
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn target_task_status_and_delete_are_guarded_during_relocation() {
    let (path, authority, mut store, proof) = relocation_fixture("task-guard");
    store
        .begin_session_relocation(&authority, operation(&proof, "task-guard-operation"))
        .unwrap();

    for result in [
        store
            .set_task_status(&authority, "task-relocation", TaskStatus::Closed, 30)
            .map(|_| ()),
        store.delete_task(&authority, "task-relocation").map(|_| ()),
    ] {
        assert!(matches!(
            result,
            Err(StoreError::JournalConflict { operation_id })
                if operation_id == "task-guard-operation"
        ));
    }
    drop(store);
    assert_eq!(
        Store::open(&path)
            .unwrap()
            .session_relocation_operations()
            .len(),
        1
    );
    let _ = std::fs::remove_file(path);
}
