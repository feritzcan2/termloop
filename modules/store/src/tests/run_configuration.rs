use super::*;
use termloop_domain::{
    ProjectRecord, RUN_CONFIGURATIONS_PER_PROJECT_MAX, RunConfiguration, RunConfigurationKind,
    RunSetupMark, RunSetupPolicy,
};

fn project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        name: id.into(),
        folder_path: format!("/tmp/{id}"),
    }
}

fn configuration(id: &str, project_id: &str) -> RunConfiguration {
    RunConfiguration {
        id: id.into(),
        project_id: project_id.into(),
        name: format!("Run {id}"),
        kind: RunConfigurationKind::DevServer,
        command: "pnpm dev".into(),
        working_directory: ".".into(),
        env: vec![],
        setup_command: Some("pnpm install".into()),
        setup_policy: RunSetupPolicy::OncePerWorktree,
        url_auto_detect: true,
        fallback_urls: vec![],
        auto_open_first_url: false,
        generation: 1,
        updated_at_epoch_ms: 1,
    }
}

fn open_store(label: &str) -> (std::path::PathBuf, CoreWriteAuthority, Store) {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-run-{label}-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let authority = issue_core_write_authority_for_composition();
    let store = Store::open(&path).unwrap();
    (path, authority, store)
}

#[test]
fn schema_31_migrates_to_empty_run_current_state() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-run-migration-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 31,
            "revision": 4,
            "projects": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.run_configurations().is_empty());
    assert!(store.run_setup_marks().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["run_configurations"], serde_json::json!([]));
    assert_eq!(persisted["run_setup_marks"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn run_configuration_crud_requires_project_revision_and_bounds() {
    let (path, authority, mut store) = open_store("crud");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();

    assert!(matches!(
        store.set_run_configuration(
            &authority,
            configuration("run-1", "missing-project"),
            store.revision(),
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(matches!(
        store.set_run_configuration(&authority, configuration("run-1", "project-a"), 999),
        Err(StoreError::RevisionConflict)
    ));

    let created = store
        .set_run_configuration(
            &authority,
            configuration("run-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    assert_eq!(created.id, "run-1");
    assert_eq!(store.run_configurations().len(), 1);

    // Idempotent same-value writes do not advance the revision.
    let revision = store.revision();
    store
        .set_run_configuration(&authority, created.clone(), revision)
        .unwrap();
    assert_eq!(store.revision(), revision);

    // The project association is immutable on update.
    store
        .insert_project(&authority, project("project-b"))
        .unwrap();
    assert!(matches!(
        store.set_run_configuration(
            &authority,
            configuration("run-1", "project-b"),
            store.revision(),
        ),
        Err(StoreError::ConstraintViolation)
    ));

    for index in 1..RUN_CONFIGURATIONS_PER_PROJECT_MAX {
        store
            .set_run_configuration(
                &authority,
                configuration(&format!("run-{}", index + 1), "project-a"),
                store.revision(),
            )
            .unwrap();
    }
    assert!(matches!(
        store.set_run_configuration(
            &authority,
            configuration("run-overflow", "project-a"),
            store.revision(),
        ),
        Err(StoreError::ConstraintViolation)
    ));

    let deleted = store
        .delete_run_configuration(&authority, "run-1", store.revision())
        .unwrap();
    assert_eq!(deleted.id, "run-1");
    assert!(matches!(
        store.delete_run_configuration(&authority, "run-1", store.revision()),
        Err(StoreError::NotFound)
    ));
    let _ = std::fs::remove_file(path);
}

#[test]
fn setup_marks_replace_in_place_and_follow_configuration_lifecycle() {
    let (path, authority, mut store) = open_store("marks");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .set_run_configuration(
            &authority,
            configuration("run-1", "project-a"),
            store.revision(),
        )
        .unwrap();

    let mark = RunSetupMark {
        project_id: "project-a".into(),
        configuration_id: "run-1".into(),
        worktree_path: "/worktrees/task-1".into(),
        configuration_generation: 1,
        completed_at_epoch_ms: 10,
    };
    assert!(matches!(
        store.record_run_setup_mark(
            &authority,
            RunSetupMark {
                configuration_id: "unknown".into(),
                ..mark.clone()
            },
        ),
        Err(StoreError::ConstraintViolation)
    ));
    store
        .record_run_setup_mark(&authority, mark.clone())
        .unwrap();
    store
        .record_run_setup_mark(
            &authority,
            RunSetupMark {
                configuration_generation: 2,
                completed_at_epoch_ms: 20,
                ..mark.clone()
            },
        )
        .unwrap();
    assert_eq!(store.run_setup_marks().len(), 1);
    assert_eq!(store.run_setup_marks()[0].configuration_generation, 2);

    store
        .delete_run_configuration(&authority, "run-1", store.revision())
        .unwrap();
    assert!(store.run_setup_marks().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_delete_cascades_run_configurations_and_marks() {
    let (path, authority, mut store) = open_store("cascade");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .set_run_configuration(
            &authority,
            configuration("run-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    store
        .record_run_setup_mark(
            &authority,
            RunSetupMark {
                project_id: "project-a".into(),
                configuration_id: "run-1".into(),
                worktree_path: "/worktrees/task-1".into(),
                configuration_generation: 1,
                completed_at_epoch_ms: 10,
            },
        )
        .unwrap();
    store
        .delete_project_and_related_records(&authority, "project-a")
        .unwrap();
    assert!(store.run_configurations().is_empty());
    assert!(store.run_setup_marks().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn deleting_a_run_configuration_clears_session_markers() {
    let (path, authority, mut store) = open_store("session-marker");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .set_run_configuration(
            &authority,
            configuration("run-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                id: "session-1".into(),
                project_id: "project-a".into(),
                name: None,
                kind: SessionKind::Terminal,
                process: ProcessDescriptor {
                    program: "/bin/sh".into(),
                    args: vec!["-lc".into(), "pnpm dev".into()],
                    cwd: "/worktrees/task-1".into(),
                    agent_id: None,
                    template_ref: None,
                    template_version: None,
                },
                launch_selection: Default::default(),
                lifecycle_state: "exited".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: Some("run-1".into()),
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    store
        .delete_run_configuration(&authority, "run-1", store.revision())
        .unwrap();
    assert_eq!(store.sessions()[0].run_configuration_id, None);
    let _ = std::fs::remove_file(path);
}

#[test]
fn daemon_restart_retires_run_sessions_but_keeps_an_ordinary_terminal() {
    let (path, authority, mut store) = open_store("restart");
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    store
        .set_run_configuration(
            &authority,
            configuration("run-1", "project-a"),
            store.revision(),
        )
        .unwrap();
    let terminal = |id: &str, run: Option<&str>| SessionRecord {
        id: id.into(),
        project_id: "project-a".into(),
        name: None,
        kind: SessionKind::Terminal,
        process: ProcessDescriptor {
            program: "/bin/sh".into(),
            args: vec!["-lc".into(), "pnpm dev".into()],
            cwd: "/worktrees/task-1".into(),
            agent_id: None,
            template_ref: None,
            template_version: None,
        },
        launch_selection: Default::default(),
        lifecycle_state: "running".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: run.map(str::to_owned),
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: None,
        resume_launch_guard: None,
        resume_failure: None,
    };
    store
        .insert_session(&authority, terminal("run-session", Some("run-1")))
        .unwrap();
    store
        .insert_session(&authority, terminal("shell-session", None))
        .unwrap();

    store.reconcile_restart(&authority).unwrap();

    // The run's process, PTY buffer, and runtime observation all ended with the
    // daemon, and its launcher can start a fresh one — so no dead row survives.
    // A shell the user opened keeps its stale row.
    let remaining = store
        .sessions()
        .iter()
        .map(|session| session.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(remaining, ["shell-session"]);
    assert_eq!(store.sessions()[0].lifecycle_state, "stale");
    let _ = std::fs::remove_file(path);
}
