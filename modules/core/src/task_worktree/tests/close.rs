use super::*;
use termloop_domain::{SessionKind, TaskSuspensionReason};

fn canonical(path: &Path) -> String {
    termloop_platform::canonical_existing_directory_path(path)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn insert_live_session(fixture: &mut Fixture, id: &str, kind: SessionKind, cwd: &str) {
    let agent = kind == SessionKind::Agent;
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                launch_selection: Default::default(),
                id: id.into(),
                project_id: fixture.project_id.clone(),
                name: Some(id.into()),
                kind,
                process: termloop_domain::ProcessDescriptor {
                    program: if agent { "codex" } else { "zsh" }.into(),
                    args: vec![],
                    cwd: cwd.into(),
                    agent_id: agent.then(|| "codex".into()),
                    template_ref: agent.then(|| "builtin.agent.interactive".into()),
                    template_version: agent.then_some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: if agent {
                    termloop_domain::ResumeRef::for_provider(
                        termloop_domain::ResumeProvider::Codex,
                        format!("00000000-0000-4000-8000-{:012}", id.len()),
                    )
                } else {
                    None
                },
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let (program, args) = termloop_platform::default_shell();
    fixture
        .runtime
        .terminal
        .spawn(termloop_terminal::PtySpawnSpec {
            session_id: id.into(),
            runtime_epoch: 1,
            program,
            args,
            cwd: cwd.into(),
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        })
        .unwrap();
}

fn live(fixture: &Fixture, session_id: &str) -> bool {
    fixture
        .runtime
        .terminal
        .contains_session(session_id)
        .unwrap()
}

fn session<'a>(fixture: &'a Fixture, session_id: &str) -> &'a termloop_domain::SessionRecord {
    fixture
        .runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == session_id)
        .unwrap()
}

#[test]
fn close_parks_task_agents_and_reopen_resumes_them_in_the_retained_checkout() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let worktree_cwd = canonical(&destination);
    let project_cwd = canonical(&fixture.project_directory);
    insert_live_session(
        &mut fixture,
        "task-agent",
        SessionKind::Agent,
        &worktree_cwd,
    );
    insert_live_session(
        &mut fixture,
        "task-shell",
        SessionKind::Terminal,
        &worktree_cwd,
    );
    insert_live_session(
        &mut fixture,
        "project-agent",
        SessionKind::Agent,
        &project_cwd,
    );

    let closed = fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();

    assert_eq!(closed["status"], "closed");
    assert!(destination.exists(), "close has no filesystem effect");
    assert!(!live(&fixture, "task-agent"));
    assert!(
        live(&fixture, "task-shell"),
        "generic terminals keep running"
    );
    assert!(
        live(&fixture, "project-agent"),
        "only the Task's Agents stop"
    );
    assert_eq!(session(&fixture, "task-agent").lifecycle_state, "exited");
    let suspensions = fixture.runtime.store.task_archive_suspensions();
    assert_eq!(suspensions.len(), 1);
    assert_eq!(suspensions[0].session_id, "task-agent");
    assert_eq!(suspensions[0].reason, TaskSuspensionReason::Closed);
    assert!(
        !fixture
            .runtime
            .list_sessions()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["id"] == "task-agent")
    );
    assert!(!fixture.runtime.pending_task_closes.contains_key(&task_id));

    let (reopened, resume_session_ids) = fixture
        .runtime
        .reopen_task_with_resume_plan(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(reopened["status"], "open");
    assert_eq!(resume_session_ids, vec!["task-agent".to_owned()]);
    assert!(fixture.runtime.store.task_archive_suspensions().is_empty());
    let agent = session(&fixture, "task-agent");
    assert_eq!(agent.process.cwd, worktree_cwd);
    assert_eq!(
        agent.resume_failure,
        Some(termloop_domain::ResumeFailureReason::DaemonInterrupted),
    );
}

#[test]
fn close_without_live_task_agents_only_changes_status() {
    let mut fixture = Fixture::new();
    let task = fixture.create_task("No agents", Value::Null);
    let task_id = task["id"].as_str().unwrap().to_owned();

    let closed = fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(closed["status"], "closed");
    assert!(fixture.runtime.store.task_archive_suspensions().is_empty());
    let repeated = fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(repeated["status"], "closed");
}

#[test]
fn reopen_after_checkout_cleanup_resumes_close_parked_agent_from_project_root() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let worktree_cwd = canonical(&destination);
    let project_cwd = canonical(&fixture.project_directory);
    insert_live_session(
        &mut fixture,
        "task-agent",
        SessionKind::Agent,
        &worktree_cwd,
    );
    fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();

    let cleanup = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(cleanup["decision"], "allowed");
    fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    assert!(!destination.exists());

    let (_, resume_session_ids) = fixture
        .runtime
        .reopen_task_with_resume_plan(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(resume_session_ids, vec!["task-agent".to_owned()]);
    assert_eq!(session(&fixture, "task-agent").process.cwd, project_cwd);
}

#[test]
fn closed_task_archives_restores_and_deletes_with_its_parked_agents() {
    let mut fixture = Fixture::new();
    let (task_id, _, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let worktree_cwd = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .and_then(|task| task.worktree.as_ref())
        .map(|binding| canonical(Path::new(&binding.path)))
        .unwrap();
    insert_live_session(
        &mut fixture,
        "task-agent",
        SessionKind::Agent,
        &worktree_cwd,
    );
    fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();

    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["can_archive"], true);
    assert!(preview["sessions"].as_array().unwrap().is_empty());
    fixture
        .runtime
        .archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    let restored = fixture
        .runtime
        .restore_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(restored["restored_session_count"], 0);
    assert_eq!(restored["task"]["status"], "closed");
    assert_eq!(
        fixture.runtime.store.task_archive_suspensions()[0].reason,
        TaskSuspensionReason::Closed,
        "restore leaves close-parked Agents for reopen",
    );

    fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    fixture
        .runtime
        .delete_task(json!({ "taskId": task_id }))
        .unwrap();
    assert!(fixture.runtime.store.tasks().is_empty());
    assert!(fixture.runtime.store.sessions().is_empty());
    assert!(fixture.runtime.store.task_archive_suspensions().is_empty());
}

#[test]
fn exit_reconciled_mid_close_does_not_open_a_continuation_shell() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let worktree_cwd = canonical(&destination);
    insert_live_session(
        &mut fixture,
        "task-agent",
        SessionKind::Agent,
        &worktree_cwd,
    );

    let TaskClosePreparation::Retire(plan) = fixture
        .runtime
        .prepare_task_close(json!({ "taskId": task_id }))
        .unwrap()
    else {
        panic!("a live Task Agent must be retired");
    };
    assert_eq!(plan.session_ids(), vec!["task-agent".to_owned()]);
    assert!(matches!(
        fixture.runtime.prepare_task_close(json!({ "taskId": task_id })),
        Err(CoreError::InvalidParams(reason)) if reason == "taskCloseInProgress"
    ));
    drop(fixture.runtime.detach_task_close_runtimes(&plan));
    fixture.runtime.terminal.terminate("task-agent").unwrap();
    let reconciled =
        fixture
            .runtime
            .reconcile_exited_sessions(vec![termloop_terminal::ReapedTerminal {
                session_id: "task-agent".into(),
                runtime_epoch: 1,
                exit_code: 0,
            }]);
    assert!(reconciled.errors.is_empty());
    assert!(!live(&fixture, "task-agent"));

    let closed = fixture.runtime.complete_task_close(plan).unwrap();
    assert_eq!(closed["status"], "closed");
    assert!(!live(&fixture, "task-agent"));
    assert_eq!(
        fixture.runtime.store.task_archive_suspensions()[0].prior_lifecycle_state,
        "running",
    );
}
