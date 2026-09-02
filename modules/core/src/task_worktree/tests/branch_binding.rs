use super::*;

#[test]
fn executor_task_reads_are_exact_project_scoped_and_include_current_task_state() {
    let mut fixture = Fixture::new();
    let task = fixture.create_task("Exact Task", Value::Null);
    let task_id = task["id"].as_str().unwrap();

    let projected = fixture
        .runtime
        .task_projection_for_executor(&fixture.project_id, task_id)
        .unwrap();
    assert_eq!(projected["id"], task_id);
    assert_eq!(projected["title"], "Exact Task");
    assert!(projected["branch"].is_null());
    assert!(projected["worktree"].is_null());
    assert!(projected["jira_url"].is_null());
    assert_eq!(
        fixture
            .runtime
            .task_agent_status_projection_for_executor(&fixture.project_id, task_id)
            .unwrap(),
        json!([])
    );
    assert!(matches!(
        fixture
            .runtime
            .task_projection_for_executor("other-project", task_id),
        Err(CoreError::NotFound)
    ));
}

#[test]
fn worktree_less_task_lifecycle_is_current_state_only() {
    let mut fixture = Fixture::new();
    let first = fixture.create_task("  Build API  ", json!("  Keep it small  "));
    let second = fixture.create_task("Write tests", Value::Null);
    assert_eq!(first["title"], "Build API");
    assert_eq!(first["brief"], "Keep it small");
    assert_eq!(first["status"], "open");
    assert!(first["branch"].is_null());
    assert!(first["worktree"].is_null());
    assert_eq!(first["worktree_generation"], 0);
    assert_eq!(first["rank"], 0);
    assert_eq!(second["rank"], 1);

    let listed = fixture
        .runtime
        .list_tasks(json!({ "projectId": fixture.project_id }))
        .unwrap();
    assert_eq!(listed["items"][0]["id"], first["id"]);
    assert_eq!(listed["items"][1]["id"], second["id"]);
    assert_eq!(listed["items"][0]["worktree_generation"], 0);

    let filtered = fixture
        .runtime
        .list_tasks_current(json!({
            "projectId": fixture.project_id,
            "taskIds": [second["id"].as_str().unwrap(), "deleted-or-unknown"],
        }))
        .unwrap();
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["items"][0]["id"], second["id"]);
    assert_eq!(filtered["items"][0]["worktree_generation"], 0);

    let task_id = first["id"].as_str().unwrap();
    let renamed = fixture
        .runtime
        .rename_task(json!({ "taskId": task_id, "title": "  Build v2  " }))
        .unwrap();
    assert_eq!(renamed["title"], "Build v2");
    let cleared = fixture
        .runtime
        .update_task_brief(json!({ "taskId": task_id, "brief": "   " }))
        .unwrap();
    assert!(cleared["brief"].is_null());

    let closed = fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(closed["status"], "closed");
    let revision = fixture.runtime.state_revision();
    fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(fixture.runtime.state_revision(), revision);
    let reopened = fixture
        .runtime
        .reopen_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(reopened["status"], "open");

    let deleted = fixture
        .runtime
        .delete_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(deleted, json!({ "taskId": task_id, "deleted": true }));
    let listed = fixture
        .runtime
        .list_tasks(json!({ "projectId": fixture.project_id }))
        .unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
}

#[test]
fn developer_notes_are_durable_and_compare_and_swap_the_current_list() {
    let mut fixture = Fixture::new();
    let task = fixture.create_task("Track follow-up", Value::Null);
    let task_id = task["id"].as_str().unwrap();
    assert_eq!(task["developer_notes"], json!([]));

    let first =
        json!([{ "id": "note-1", "text": "Review the narrow sidebar", "completed": false }]);
    let updated = fixture
        .runtime
        .update_task_developer_notes(json!({
            "taskId": task_id,
            "expectedDeveloperNotes": [],
            "developerNotes": first,
        }))
        .unwrap();
    assert_eq!(updated["developer_notes"], first);

    assert!(matches!(
        fixture.runtime.update_task_developer_notes(json!({
            "taskId": task_id,
            "expectedDeveloperNotes": [],
            "developerNotes": [{ "id": "note-2", "text": "Stale write", "completed": false }],
        })),
        Err(CoreError::RevisionConflict)
    ));

    let completed = fixture
        .runtime
        .update_task_developer_notes(json!({
            "taskId": task_id,
            "expectedDeveloperNotes": first,
            "developerNotes": [{ "id": "note-1", "text": "Review the narrow sidebar", "completed": true }],
        }))
        .unwrap();
    assert_eq!(completed["developer_notes"][0]["completed"], true);
}

#[test]
fn task_list_cursor_is_opaque_filter_scoped_and_revision_fenced() {
    let mut fixture = Fixture::new();
    let first = fixture.create_task("First", Value::Null);
    let second = fixture.create_task("Second", Value::Null);
    let page = fixture
        .runtime
        .list_tasks_current(json!({
            "projectId": fixture.project_id,
            "archiveScope": "active",
            "limit": 1,
        }))
        .unwrap();
    assert_eq!(page["items"][0]["id"], first["id"]);
    let cursor = page["next_cursor"].as_str().unwrap();
    assert_ne!(cursor, "1");

    let next = fixture
        .runtime
        .list_tasks_current(json!({
            "projectId": fixture.project_id,
            "archiveScope": "active",
            "limit": 1,
            "cursor": cursor,
        }))
        .unwrap();
    assert_eq!(next["items"][0]["id"], second["id"]);

    assert!(matches!(
        fixture.runtime.list_tasks_current(json!({
            "projectId": fixture.project_id,
            "archiveScope": "archived",
            "limit": 1,
            "cursor": cursor,
        })),
        Err(CoreError::InvalidParams(field)) if field == "cursor"
    ));

    fixture.create_task("Third", Value::Null);
    assert!(matches!(
        fixture.runtime.list_tasks_current(json!({
            "projectId": fixture.project_id,
            "archiveScope": "active",
            "limit": 1,
            "cursor": cursor,
        })),
        Err(CoreError::InvalidParams(field)) if field == "cursor"
    ));
}

#[test]
fn task_policy_rejects_invalid_automation_intent_and_text() {
    let mut fixture = Fixture::new();
    for params in [
        json!({ "projectId": fixture.project_id, "title": "Task", "worktreeIntent": "invalid" }),
        json!({ "projectId": fixture.project_id, "title": "Task", "worktreeIntent": "none", "agentId": "codex" }),
        json!({ "projectId": fixture.project_id, "title": "   ", "worktreeIntent": "none" }),
        json!({ "projectId": fixture.project_id, "title": "x".repeat(161), "worktreeIntent": "none" }),
        json!({ "projectId": fixture.project_id, "title": "Task", "brief": "x".repeat(8_001), "worktreeIntent": "none" }),
    ] {
        assert!(matches!(
            fixture.runtime.create_task(params),
            Err(CoreError::InvalidParams(_))
        ));
    }
    assert!(fixture.runtime.store.tasks().is_empty());
}

#[test]
fn branch_binding_is_idempotent_immutable_unique_and_released_by_delete() {
    let mut fixture = Fixture::new();
    let first = fixture.create_task("First", Value::Null);
    let second = fixture.create_task("Second", Value::Null);
    let first_id = first["id"].as_str().unwrap().to_owned();
    let second_id = second["id"].as_str().unwrap().to_owned();
    let binding = TaskBranchBinding {
        repository_root: "/canonical/repository".into(),
        name: "feature".into(),
    };
    let observed = |task_id: &str, binding: TaskBranchBinding| ObservedTaskBranchBinding {
        task_id: task_id.to_owned(),
        project_id: fixture.project_id.clone(),
        binding,
    };

    let bound = fixture
        .runtime
        .complete_task_branch_binding(observed(&first_id, binding.clone()))
        .unwrap();
    let timestamp = bound["updated_at_epoch_ms"].as_u64().unwrap();
    let revision = fixture.runtime.state_revision();
    let retried = fixture
        .runtime
        .complete_task_branch_binding(observed(&first_id, binding.clone()))
        .unwrap();
    assert_eq!(retried["updated_at_epoch_ms"], timestamp);
    assert_eq!(fixture.runtime.state_revision(), revision);

    assert!(matches!(
        fixture.runtime.complete_task_branch_binding(observed(
            &first_id,
            TaskBranchBinding {
                repository_root: "/canonical/repository".into(),
                name: "other".into(),
            },
        )),
        Err(CoreError::TaskBranchAlreadyBound { task_id }) if task_id == first_id
    ));
    fixture
        .runtime
        .close_task(json!({ "taskId": first_id }))
        .unwrap();
    assert!(matches!(
        fixture
            .runtime
            .complete_task_branch_binding(observed(&second_id, binding.clone())),
        Err(CoreError::BranchHeldByTask { task_id }) if task_id == first_id
    ));
    fixture
        .runtime
        .delete_task(json!({ "taskId": first_id }))
        .unwrap();
    let rebound = fixture
        .runtime
        .complete_task_branch_binding(observed(&second_id, binding))
        .unwrap();
    assert_eq!(rebound["branch"]["name"], "feature");
}

#[test]
fn branch_observation_preserves_stable_git_failures_without_writing_task_state() {
    let mut fixture = Fixture::new();
    let task = fixture.create_task("Failure target", Value::Null);
    let task_id = task["id"].as_str().unwrap();

    let unavailable = FakeGit::compile(
        "unavailable",
        r#"fn main() { eprintln!("xcrun: error: developer tools unavailable secret-token"); std::process::exit(69); }"#,
    );
    assert!(matches!(
        failed_observation(&fixture, task_id, || GitRunner::discover_program(
            &unavailable.program
        )),
        CoreError::GitUnavailable
    ));

    let unsupported = FakeGit::compile(
        "unsupported",
        r#"fn main() { println!("git version 2.35.9 secret-vendor"); }"#,
    );
    assert!(matches!(
        failed_observation(&fixture, task_id, || GitRunner::discover_program(
            &unsupported.program
        )),
        CoreError::GitUnsupportedVersion
    ));

    let classified = FakeGit::compile(
        "classified",
        r#"
            fn main() {
                if std::env::args().nth(1).as_deref() == Some("--version") {
                    println!("git version 2.50.0");
                    return;
                }
                let mode = std::fs::read_to_string(".fake-git-mode").unwrap();
                match mode.trim() {
                    "permission" => eprintln!("fatal: detected dubious ownership in repository at 'https://user:secret@example.invalid/repo'"),
                    "corrupt" => eprintln!("fatal: bad object secret-object"),
                    "unsupported" => eprintln!("fatal: unsupported repository extension secret-extension"),
                    "timeout" => std::thread::sleep(std::time::Duration::from_secs(5)),
                    "output" => {
                        use std::io::Write;
                        let mut stdout = std::io::stdout().lock();
                        stdout.write_all("x".repeat(4096).as_bytes()).unwrap();
                        stdout.flush().unwrap();
                    }
                    _ => unreachable!(),
                }
                std::process::exit(128);
            }
            "#,
    );
    for (mode, expected) in [
        ("permission", CoreError::RepositoryPermissionDenied),
        ("corrupt", CoreError::CorruptRepository),
        ("unsupported", CoreError::UnsupportedRepository),
    ] {
        std::fs::write(fixture.project_directory.join(".fake-git-mode"), mode).unwrap();
        let error = failed_observation(&fixture, task_id, || {
            GitRunner::discover_program(&classified.program)
        });
        assert_eq!(
            std::mem::discriminant(&error),
            std::mem::discriminant(&expected)
        );
    }

    std::fs::write(fixture.project_directory.join(".fake-git-mode"), "timeout").unwrap();
    assert!(matches!(
        failed_observation(&fixture, task_id, || {
            GitRunner::discover_program(&classified.program)
                .map(|runner| runner.with_limits(Duration::from_millis(100), 1024))
        }),
        CoreError::GitObservationTimedOut
    ));
    std::fs::write(fixture.project_directory.join(".fake-git-mode"), "output").unwrap();
    assert!(matches!(
        failed_observation(&fixture, task_id, || {
            GitRunner::discover_program(&classified.program)
                .map(|runner| runner.with_limits(Duration::from_secs(5), 256))
        }),
        CoreError::GitObservationOutputBound
    ));
}
