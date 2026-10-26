use super::{sprint, store, ticket};
use crate::{PmError, PmStore, SCHEMA_VERSION, TicketAuthor};

fn migration_rows(store: &PmStore) -> u32 {
    store
        .connection()
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn migrations_run_once_and_rerunning_them_changes_nothing() {
    let mut store = store();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let rows = migration_rows(&store);
    let sprint = sprint(&mut store, "p1", "Sprint 1");
    store.migrate_again().unwrap();
    store.migrate_again().unwrap();
    assert_eq!(migration_rows(&store), rows);
    assert_eq!(store.sprint(&sprint.id).unwrap(), Some(sprint));
}

fn temporary_directory() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "termloop-pm-test-{}",
        termloop_platform::generate_uuid_v4()
    ))
}

#[test]
fn a_file_database_reopens_with_its_rows_in_a_private_directory() {
    let root = temporary_directory();
    let path = root.join("pm").join("pm.sqlite");
    let sprint_id = {
        let mut store = PmStore::open(&path).unwrap();
        sprint(&mut store, "p1", "Sprint 1").id
    };
    let store = PmStore::open(&path).unwrap();
    assert_eq!(store.sprint(&sprint_id).unwrap().unwrap().name, "Sprint 1");
    assert_eq!(migration_rows(&store), SCHEMA_VERSION);
    assert!(root.join("pm").is_dir());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_database_from_a_newer_build_is_refused() {
    let root = temporary_directory();
    let path = root.join("pm").join("pm.sqlite");
    let store = PmStore::open(&path).unwrap();
    store
        .connection()
        .execute(
            "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (?1, 0)",
            [SCHEMA_VERSION + 1],
        )
        .unwrap();
    drop(store);
    assert!(matches!(
        PmStore::open(&path),
        Err(PmError::NewerSchema { found, supported })
            if found == SCHEMA_VERSION + 1 && supported == SCHEMA_VERSION
    ));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_default_path_is_a_pm_specific_file_under_the_state_directory() {
    let path = PmStore::default_path().unwrap();
    assert!(path.ends_with("pm/pm.sqlite"));
    assert_eq!(
        path.parent().unwrap().parent().unwrap(),
        termloop_platform::state_directory().unwrap()
    );
}

#[test]
fn stored_description_versions_cannot_be_rewritten() {
    let mut store = store();
    let ticket = ticket(&mut store, "p1", "Login", None);
    store
        .save_ticket_description(&ticket.id, "first", TicketAuthor::Pm, None)
        .unwrap();
    let rewrite = store.connection().execute(
        "UPDATE ticket_versions SET description = 'forged' WHERE ticket_id = ?1",
        [&ticket.id],
    );
    assert!(rewrite.is_err());
    assert_eq!(
        store.ticket_versions(&ticket.id).unwrap()[0].description,
        "first"
    );
}

#[test]
fn stored_enums_are_checked_by_the_schema() {
    let store = store();
    let insert = store.connection().execute(
        "INSERT INTO tickets (id, project_id, title, status, priority, rank, \
             created_at_epoch_ms, updated_at_epoch_ms) \
         VALUES ('t', 'p', 'T', 'blocked', 'medium', 0, 0, 0)",
        [],
    );
    assert!(insert.is_err());
}
