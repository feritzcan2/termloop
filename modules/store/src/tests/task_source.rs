use super::*;
use termloop_domain::{
    IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, ProjectRecord, TaskSourceBoardSelection,
    TaskSourceConfiguration, TaskSourceImportPolicy, TaskSourceProvider, TaskSourceScope,
};

fn source(id: &str) -> TaskSourceConfiguration {
    TaskSourceConfiguration {
        id: id.into(),
        project_id: "project-1".into(),
        provider: TaskSourceProvider::Jira,
        name: "Jira work".into(),
        enabled: true,
        generation: 1,
        site_base_url: "https://example.atlassian.net".into(),
        scope: TaskSourceScope::AssignedToMe,
        boards: vec![],
        statuses: vec![],
        import_policy: TaskSourceImportPolicy::Review,
        auto_import_active_task_limit:
            termloop_domain::TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT,
        refresh_interval_seconds: 900,
        ignored_external_ids: vec![],
        created_at_epoch_ms: 1,
        updated_at_epoch_ms: 1,
    }
}

fn task(id: &str) -> TaskRecord {
    TaskRecord {
        id: id.into(),
        project_id: "project-1".into(),
        title: "Imported".into(),
        brief: Some("Remote description".into()),
        status: TaskStatus::Open,
        archived_at_epoch_ms: None,
        branch: None,
        worktree: None,
        worktree_generation: 0,
        steward_brief_markdown: String::new(),
        steward_brief_revision: 1,
        rank: 0,
        created_at_epoch_ms: 2,
        updated_at_epoch_ms: 2,
    }
}

fn link(task_id: &str, source_id: &str) -> IssueLink {
    IssueLink {
        task_id: task_id.into(),
        provider: IssueLinkProvider::Jira,
        external_ref: "TERM-42".into(),
        source_id: Some(source_id.into()),
        external_id: Some("10042".into()),
        external_updated_at: Some("2026-08-26T10:00:00.000+0000".into()),
        url: Some("https://example.atlassian.net/browse/TERM-42".into()),
        sync_authority: IssueLinkSyncAuthority::None,
    }
}

#[test]
fn source_import_is_atomic_durable_and_dedupes_stable_issue_identity() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-source-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: "/project".into(),
            },
        )
        .unwrap();
    let mut board_source = source("source-1");
    board_source.boards = vec![
        TaskSourceBoardSelection {
            id: "84".into(),
            name: "Payments".into(),
        },
        TaskSourceBoardSelection {
            id: "17".into(),
            name: "Platform".into(),
        },
    ];
    store
        .insert_task_source_configuration(&authority, board_source)
        .unwrap();
    store
        .insert_task_from_source(&authority, task("task-1"), link("task-1", "source-1"))
        .unwrap();
    store
        .insert_task_source_configuration(&authority, source("source-2"))
        .unwrap();
    assert!(matches!(
        store.insert_task_from_source(
            &authority,
            task("task-duplicate"),
            link("task-duplicate", "source-2")
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(!store.tasks().iter().any(|task| task.id == "task-duplicate"));
    drop(store);

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.task_source_configurations().len(), 2);
    assert_eq!(
        reopened.task_source_configurations()[0].boards,
        vec![
            TaskSourceBoardSelection {
                id: "84".into(),
                name: "Payments".into()
            },
            TaskSourceBoardSelection {
                id: "17".into(),
                name: "Platform".into()
            },
        ]
    );
    assert_eq!(
        reopened.issue_links()[0].external_id.as_deref(),
        Some("10042")
    );
    reopened
        .delete_task_source_configuration(&authority, "source-1")
        .unwrap();
    assert_eq!(reopened.issue_links().len(), 1);
    drop(reopened);
    assert!(
        Store::open(&path).is_ok(),
        "dangling source provenance stays readable"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn source_import_rejects_a_case_insensitive_legacy_site_and_key_duplicate() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-source-legacy-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: "/project".into(),
            },
        )
        .unwrap();
    store
        .insert_task_source_configuration(&authority, source("source-1"))
        .unwrap();
    store.insert_task(&authority, task("legacy-task")).unwrap();
    let mut legacy_link = link("legacy-task", "source-1");
    legacy_link.source_id = None;
    legacy_link.external_id = None;
    legacy_link.external_updated_at = None;
    legacy_link.external_ref = "term-42".into();
    legacy_link.url = Some("https://EXAMPLE.atlassian.net/browse/term-42".into());
    store
        .insert_task_jira_issue_link(&authority, legacy_link)
        .unwrap();

    assert!(matches!(
        store.insert_task_from_source(
            &authority,
            task("duplicate-task"),
            link("duplicate-task", "source-1")
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(!store.tasks().iter().any(|task| task.id == "duplicate-task"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn single_board_preview_state_remains_readable() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-source-board-preview-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: "/project".into(),
            },
        )
        .unwrap();
    let mut legacy = source("legacy-board-source");
    legacy.scope = TaskSourceScope::Board {
        board_id: "84".into(),
        board_name: "Payments".into(),
    };
    store
        .insert_task_source_configuration(&authority, legacy)
        .unwrap();
    drop(store);

    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.task_source_configurations()[0].scope,
        TaskSourceScope::Board {
            board_id: "84".into(),
            board_name: "Payments".into(),
        }
    );
    assert!(reopened.task_source_configurations()[0].boards.is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_delete_cascades_task_source_configuration() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-source-project-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: "/project".into(),
            },
        )
        .unwrap();
    store
        .insert_task_source_configuration(&authority, source("source-1"))
        .unwrap();
    store
        .delete_project_and_related_records(&authority, "project-1")
        .unwrap();
    assert!(store.task_source_configurations().is_empty());
    let _ = std::fs::remove_file(path);
}
