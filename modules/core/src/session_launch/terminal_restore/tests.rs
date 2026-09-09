use super::*;
use termloop_store::{Store, issue_core_write_authority_for_composition};

struct Fixture {
    root: PathBuf,
    core: CoreRuntime,
    history: ShellHistoryStore,
}

impl Fixture {
    fn new(mut sessions: Vec<SessionRecord>) -> Self {
        let root =
            std::env::temp_dir().join(format!("termloop-shell-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let mut store = Store::open(root.join("state.json")).unwrap();
        let authority = issue_core_write_authority_for_composition();
        for session in &mut sessions {
            session.process.cwd = root.display().to_string();
            store.insert_session(&authority, session.clone()).unwrap();
        }
        let core = CoreRuntime::new(store, authority, TerminalService::default(), 20).unwrap();
        let history = ShellHistoryStore::open(&root).unwrap();
        Self {
            root,
            core,
            history,
        }
    }

    fn save(&mut self, id: &str, text: &str) {
        self.history
            .write(
                Metadata {
                    session_id: id.into(),
                    project_id: "project".into(),
                    runtime_epoch: 10,
                    cwd: self.root.display().to_string(),
                },
                text,
                1,
            )
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.core.terminal.terminate_all();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn shell(id: &str, lifecycle: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        project_id: "project".into(),
        name: Some("Build logs".into()),
        kind: SessionKind::Terminal,
        process: ProcessDescriptor {
            program: "never-execute-persisted-program".into(),
            args: vec!["never-replay-this-command".into()],
            cwd: "/placeholder".into(),
            agent_id: None,
            template_ref: None,
            template_version: None,
        },
        lifecycle_state: lifecycle.into(),
        runtime_epoch: 10,
        archived_at_epoch_ms: None,
        launch_selection: Default::default(),
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: None,
        resume_launch_guard: None,
        resume_failure: None,
    }
}

#[tokio::test]
async fn restart_keeps_identity_name_and_history_but_launches_a_fresh_shell_only_once() {
    let mut fixture = Fixture::new(vec![shell("shell", "running")]);
    fixture.save("shell", "old output\n");
    assert!(
        fixture
            .core
            .restore_terminal_sessions(Some(&fixture.history), &[], false)
            .is_empty()
    );
    let session = &fixture.core.store.sessions()[0];
    assert_eq!(session.id, "shell");
    assert_eq!(session.name.as_deref(), Some("Build logs"));
    assert_eq!(session.lifecycle_state, "running");
    assert_eq!(session.runtime_epoch, 20);
    assert_eq!(
        session.process.program,
        termloop_platform::default_shell().0
    );
    assert!(
        !session
            .process
            .args
            .contains(&"never-replay-this-command".into())
    );
    let mut output = fixture.core.terminal.subscribe("shell", 20).unwrap();
    let event = output.recv().await.unwrap();
    let termloop_terminal::TerminalEvent::Output(bytes) = event else {
        panic!("missing history replay")
    };
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("old output\r\n"));
    assert!(text.contains("New shell after application restart"));
    let revision = fixture.core.state_revision();
    assert!(
        fixture
            .core
            .restore_terminal_sessions(Some(&fixture.history), &[], false)
            .is_empty()
    );
    assert_eq!(fixture.core.state_revision(), revision);
    assert!(fixture.core.terminal.contains_session("shell").unwrap());
}

#[test]
fn explicitly_exited_shells_and_uncertain_process_owners_are_not_restarted() {
    let mut fixture = Fixture::new(vec![
        shell("closed", "exited"),
        shell("uncertain", "running"),
    ]);
    let errors = fixture.core.restore_terminal_sessions(
        Some(&fixture.history),
        &["uncertain".into()],
        false,
    );
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, "uncertain");
    assert!(!fixture.core.terminal.contains_session("closed").unwrap());
    assert!(!fixture.core.terminal.contains_session("uncertain").unwrap());
    assert_eq!(fixture.core.store.sessions()[0].lifecycle_state, "exited");
    assert_eq!(
        fixture
            .core
            .restore_terminal_sessions(None, &[], true)
            .len(),
        1
    );
}

#[test]
fn unavailable_saved_directory_preserves_stale_session_and_its_history() {
    let mut fixture = Fixture::new(vec![shell("shell", "running")]);
    fixture
        .history
        .write(
            Metadata {
                session_id: "shell".into(),
                project_id: "project".into(),
                runtime_epoch: 10,
                cwd: fixture.root.join("removed-directory").display().to_string(),
            },
            "retained output",
            1,
        )
        .unwrap();
    assert_eq!(
        fixture
            .core
            .restore_terminal_sessions(Some(&fixture.history), &[], false)
            .len(),
        1
    );
    assert_eq!(fixture.core.store.sessions()[0].lifecycle_state, "stale");
    assert!(!fixture.core.terminal.contains_session("shell").unwrap());
    assert_eq!(
        fixture
            .history
            .read(&fixture.core.store.sessions()[0])
            .unwrap()
            .1,
        "retained output"
    );
}

#[test]
fn corrupt_oversize_and_wrong_project_history_cannot_change_the_launch() {
    let mut fixture = Fixture::new(vec![shell("shell", "running")]);
    std::fs::write(fixture.history.path(0), b"corrupt").unwrap();
    std::fs::write(fixture.history.path(1), vec![b'x'; FILE_LIMIT + 1]).unwrap();
    fixture.history = ShellHistoryStore::open(&fixture.root).unwrap();
    assert!(fixture.history.entries.is_empty());
    fixture
        .history
        .write(
            Metadata {
                session_id: "shell".into(),
                project_id: "another-project".into(),
                runtime_epoch: 10,
                cwd: fixture.root.join("wrong-directory").display().to_string(),
            },
            "wrong project output",
            1,
        )
        .unwrap();
    assert!(
        fixture
            .history
            .read(&fixture.core.store.sessions()[0])
            .is_none()
    );
    assert!(
        fixture
            .core
            .restore_terminal_sessions(Some(&fixture.history), &[], false)
            .is_empty()
    );
}

#[test]
fn checkpoints_prune_closed_sessions_and_never_exceed_fixed_slot_capacity() {
    let mut fixture = Fixture::new(vec![]);
    for slot in 0..SLOT_COUNT {
        fixture.save(&format!("s{slot}"), "retained output");
    }
    assert_eq!(fixture.history.entries.len(), SLOT_COUNT);
    assert!(
        fixture
            .history
            .write(
                Metadata {
                    session_id: "overflow".into(),
                    project_id: "project".into(),
                    runtime_epoch: 10,
                    cwd: fixture.root.display().to_string(),
                },
                "too many",
                1
            )
            .is_err()
    );
    fixture
        .core
        .plan_shell_history_checkpoint()
        .checkpoint(&mut fixture.history);
    assert!(fixture.history.entries.is_empty());
    assert_eq!(
        std::fs::read_dir(&fixture.history.directory)
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn descriptor_restore_and_directory_observation_reject_stale_generations() {
    let mut fixture = Fixture::new(vec![shell("shell", "running")]);
    let stale = fixture.core.store.sessions()[0].clone();
    let mut changed = stale.clone();
    changed.name = Some("outdated descriptor".into());
    let process = stale.process.clone();
    assert!(
        fixture
            .core
            .store
            .restore_terminal_session(&fixture.core.write_authority, &changed, process.clone(), 20)
            .is_err()
    );
    fixture
        .core
        .store
        .restore_terminal_session(&fixture.core.write_authority, &stale, process, 20)
        .unwrap();
    let revision = fixture.core.state_revision();
    fixture
        .core
        .store
        .observe_terminal_directory(
            &fixture.core.write_authority,
            "shell",
            10,
            &stale.process.cwd,
            "/wrong-epoch",
        )
        .unwrap();
    fixture
        .core
        .store
        .observe_terminal_directory(
            &fixture.core.write_authority,
            "shell",
            20,
            "/outdated-path",
            "/wrong-path",
        )
        .unwrap();
    assert_eq!(fixture.core.state_revision(), revision);
    fixture
        .core
        .store
        .observe_terminal_directory(
            &fixture.core.write_authority,
            "shell",
            20,
            &stale.process.cwd,
            "/current-path",
        )
        .unwrap();
    assert_eq!(
        fixture.core.store.sessions()[0].process.cwd,
        "/current-path"
    );
}

#[test]
fn a_failed_snapshot_write_keeps_the_previous_file_and_retries() {
    let mut fixture = Fixture::new(vec![shell("shell", "running")]);
    fixture.save("shell", "previous committed output");
    assert!(
        fixture
            .core
            .restore_terminal_sessions(Some(&fixture.history), &[], false)
            .is_empty()
    );
    let before = fixture.core.store.sessions()[0].clone();
    let blocked_temp = fixture
        .history
        .path(0)
        .with_extension(format!("tmp-{}", std::process::id()));
    std::fs::create_dir(&blocked_temp).unwrap();
    let checkpoint = fixture
        .core
        .plan_shell_history_checkpoint()
        .checkpoint(&mut fixture.history);
    assert!(!checkpoint.errors.is_empty());
    assert!(checkpoint.directories.is_empty());
    assert_eq!(
        fixture.history.read(&before).unwrap().1,
        "previous committed output"
    );
    fixture
        .core
        .apply_shell_directory_observations(checkpoint)
        .unwrap();
    assert_eq!(&fixture.core.store.sessions()[0], &before);
    std::fs::remove_dir(blocked_temp).unwrap();
    let checkpoint = fixture
        .core
        .plan_shell_history_checkpoint()
        .checkpoint(&mut fixture.history);
    assert!(checkpoint.errors.is_empty());
    assert!(
        fixture
            .history
            .read(&before)
            .unwrap()
            .1
            .contains("New shell after application restart")
    );
}

#[test]
fn a_failed_directory_commit_is_retried_without_new_terminal_output() {
    let mut fixture = Fixture::new(vec![shell("shell", "running")]);
    let stale = fixture.core.store.sessions()[0].clone();
    fixture
        .core
        .store
        .restore_terminal_session(
            &fixture.core.write_authority,
            &stale,
            stale.process.clone(),
            20,
        )
        .unwrap();
    let observed_directory = fixture.root.join("observed").display().to_string();
    fixture
        .history
        .write(
            Metadata {
                session_id: "shell".into(),
                project_id: "project".into(),
                runtime_epoch: 20,
                cwd: observed_directory.clone(),
            },
            "committed output",
            1,
        )
        .unwrap();
    let state = fixture.root.join("state.json");
    let backup = fixture.root.join("state.backup");
    std::fs::rename(&state, &backup).unwrap();
    std::fs::create_dir(&state).unwrap();
    let checkpoint = fixture
        .core
        .plan_shell_history_checkpoint()
        .checkpoint(&mut fixture.history);
    assert!(
        fixture
            .core
            .apply_shell_directory_observations(checkpoint)
            .is_err()
    );
    assert_eq!(
        fixture.core.store.sessions()[0].process.cwd,
        stale.process.cwd
    );
    std::fs::remove_dir(&state).unwrap();
    std::fs::rename(&backup, &state).unwrap();
    let checkpoint = fixture
        .core
        .plan_shell_history_checkpoint()
        .checkpoint(&mut fixture.history);
    fixture
        .core
        .apply_shell_directory_observations(checkpoint)
        .unwrap();
    assert_eq!(
        fixture.core.store.sessions()[0].process.cwd,
        observed_directory
    );
}

#[tokio::test]
async fn real_shell_output_and_changed_directory_survive_shutdown_and_a_second_restart() {
    let mut fixture = Fixture::new(vec![shell("shell", "running")]);
    let changed_directory = fixture.root.join("changed");
    std::fs::create_dir(&changed_directory).unwrap();
    assert!(
        fixture
            .core
            .restore_terminal_sessions(None, &[], false)
            .is_empty()
    );
    let mut output = fixture.core.terminal.subscribe("shell", 20).unwrap();
    let command = format!(
        "cd '{}'\recho TL_SHELL_HISTORY_EXECUTED\r",
        changed_directory.display()
    );
    fixture
        .core
        .terminal
        .input("shell", command.as_bytes())
        .unwrap();
    let mut bytes = Vec::new();
    let mut answered = 0;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            if let termloop_terminal::TerminalEvent::Output(chunk) = output.recv().await.unwrap() {
                bytes.extend(chunk);
                let queries = bytes
                    .windows(4)
                    .filter(|window| *window == b"\x1b[6n")
                    .count();
                while answered < queries {
                    fixture
                        .core
                        .terminal
                        .input_user("shell", 20, b"\x1b[1;1R")
                        .unwrap();
                    answered += 1;
                }
                if String::from_utf8_lossy(&bytes).contains("\r\nTL_SHELL_HISTORY_EXECUTED\r\n") {
                    break;
                }
            }
        }
    })
    .await
    .expect("the fresh shell did not execute new user input");
    // No periodic checkpoint happened yet. Graceful shutdown must capture the
    // final directory before killing the shell and retain its drained output.
    fixture.core.terminal.terminate_all().unwrap();
    let checkpoint = fixture
        .core
        .plan_shell_history_checkpoint()
        .checkpoint(&mut fixture.history);
    assert!(checkpoint.errors.is_empty(), "{:?}", checkpoint.errors);
    fixture
        .core
        .apply_shell_directory_observations(checkpoint)
        .unwrap();
    let descriptor = fixture.core.store.sessions()[0].clone();
    let (metadata, text) = fixture.history.read(&descriptor).unwrap();
    assert!(text.contains("TL_SHELL_HISTORY_EXECUTED"));
    assert!(!text.contains('\x1b'));
    assert_eq!(metadata.cwd, changed_directory.display().to_string());
    assert_eq!(descriptor.process.cwd, metadata.cwd);
    let store = Store::open(fixture.root.join("state.json")).unwrap();
    fixture.core = CoreRuntime::new(
        store,
        issue_core_write_authority_for_composition(),
        TerminalService::default(),
        30,
    )
    .unwrap();
    fixture.history = ShellHistoryStore::open(&fixture.root).unwrap();
    assert!(
        fixture
            .core
            .restore_terminal_sessions(Some(&fixture.history), &[], false)
            .is_empty()
    );
    let mut replay = fixture.core.terminal.subscribe("shell", 30).unwrap();
    let termloop_terminal::TerminalEvent::Output(bytes) = replay.recv().await.unwrap() else {
        panic!("missing restored output")
    };
    assert!(String::from_utf8_lossy(&bytes).contains("TL_SHELL_HISTORY_EXECUTED"));
    assert!(fixture.core.terminal.contains_session("shell").unwrap());
}
