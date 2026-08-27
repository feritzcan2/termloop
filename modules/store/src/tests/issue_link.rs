use super::*;
use termloop_domain::{IssueLink, IssueLinkProvider, IssueLinkSyncAuthority};

fn task(id: &str) -> TaskRecord {
    TaskRecord {
        id: id.into(),
        project_id: "project-1".into(),
        title: "Task".into(),
        brief: None,
        status: TaskStatus::Open,
        archived_at_epoch_ms: None,
        branch: None,
        worktree: None,
        worktree_generation: 0,
        steward_brief_markdown: String::new(),
        steward_brief_revision: 1,
        rank: 0,
        created_at_epoch_ms: 1,
        updated_at_epoch_ms: 1,
    }
}

fn jira_link(task_id: &str, key: &str) -> IssueLink {
    IssueLink {
        task_id: task_id.into(),
        provider: IssueLinkProvider::Jira,
        external_ref: key.into(),
        source_id: None,
        external_id: None,
        external_updated_at: None,
        url: Some(format!("https://example.atlassian.net/browse/{key}")),
        sync_authority: IssueLinkSyncAuthority::None,
    }
}

#[test]
fn jira_issue_link_is_durable_append_once_and_deleted_with_task() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-jira-link-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_task(&authority, task("task-1")).unwrap();
    store
        .insert_task_jira_issue_link(&authority, jira_link("task-1", "TERM-42"))
        .unwrap();
    assert!(matches!(
        store.insert_task_jira_issue_link(&authority, jira_link("task-1", "TERM-43")),
        Err(StoreError::ConstraintViolation)
    ));
    drop(store);

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.issue_links(), [jira_link("task-1", "TERM-42")]);
    reopened.delete_task(&authority, "task-1").unwrap();
    assert!(reopened.issue_links().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn jira_issue_link_requires_an_existing_task() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-jira-link-missing-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    assert!(matches!(
        store.insert_task_jira_issue_link(&authority, jira_link("missing", "TERM-42")),
        Err(StoreError::ConstraintViolation)
    ));
    store.insert_task(&authority, task("task-1")).unwrap();
    let mut malformed = jira_link("task-1", "TERM-42");
    malformed.url = Some("https://example.atlassian.net/browse/TERM-42?token=secret".into());
    assert!(matches!(
        store.insert_task_jira_issue_link(&authority, malformed),
        Err(StoreError::ConstraintViolation)
    ));
    let _ = std::fs::remove_file(path);
}
