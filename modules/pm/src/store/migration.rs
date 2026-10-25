//! Forward-only schema migrations, recorded one row per applied version in
//! `schema_migrations`. A database newer than this build is refused rather
//! than opened.

use rusqlite::{Connection, params};

use crate::PmError;

const V1: &str = r#"
CREATE TABLE sprints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    goal TEXT,
    state TEXT NOT NULL CHECK (state IN ('backlog', 'planned', 'active', 'closed')),
    created_at_epoch_ms INTEGER NOT NULL,
    activated_at_epoch_ms INTEGER,
    closed_at_epoch_ms INTEGER,
    CHECK ((state = 'closed') = (closed_at_epoch_ms IS NOT NULL))
) STRICT;
CREATE INDEX sprints_by_project ON sprints (project_id, created_at_epoch_ms);
CREATE UNIQUE INDEX sprints_one_active_per_project ON sprints (project_id)
    WHERE state = 'active';

CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('todo', 'inProgress', 'inReview', 'done')),
    priority TEXT NOT NULL
        CHECK (priority IN ('lowest', 'low', 'medium', 'high', 'highest')),
    assignee TEXT,
    sprint_id TEXT REFERENCES sprints (id) ON DELETE RESTRICT,
    rank INTEGER NOT NULL,
    jira_url TEXT,
    carry_over_count INTEGER NOT NULL DEFAULT 0 CHECK (carry_over_count >= 0),
    created_at_epoch_ms INTEGER NOT NULL,
    updated_at_epoch_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX tickets_by_lane ON tickets (project_id, sprint_id, rank);
CREATE UNIQUE INDEX tickets_one_per_jira_issue ON tickets (project_id, jira_url)
    WHERE jira_url IS NOT NULL;

CREATE TABLE ticket_versions (
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    number INTEGER NOT NULL CHECK (number > 0),
    description TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('pm', 'agent', 'jira')),
    recorded_at_epoch_ms INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, number)
) STRICT;
CREATE TRIGGER ticket_versions_are_immutable BEFORE UPDATE ON ticket_versions
BEGIN
    SELECT RAISE(ABORT, 'ticket versions are immutable');
END;

CREATE TABLE ticket_blockers (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL
) STRICT;
CREATE INDEX ticket_blockers_by_ticket ON ticket_blockers (ticket_id, position);

CREATE TABLE ticket_criteria (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL CHECK (done IN (0, 1))
) STRICT;
CREATE INDEX ticket_criteria_by_ticket ON ticket_criteria (ticket_id, position);

CREATE TABLE project_environments (
    project_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    production INTEGER NOT NULL CHECK (production IN (0, 1)),
    PRIMARY KEY (project_id, position)
) STRICT;
CREATE UNIQUE INDEX project_environments_unique_name
    ON project_environments (project_id, name COLLATE NOCASE);
"#;

/// Every migration in order; a version is never edited once released.
const MIGRATIONS: &[(u32, &str)] = &[(1, V1)];

pub const SCHEMA_VERSION: u32 = MIGRATIONS[MIGRATIONS.len() - 1].0;

/// Applies every migration the database has not recorded, in one transaction.
/// Running it again on a current database changes nothing.
pub(super) fn migrate(connection: &mut Connection, now_epoch_ms: u64) -> Result<(), PmError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at_epoch_ms INTEGER NOT NULL
        ) STRICT;",
    )?;
    let current = applied_version(&transaction)?;
    if current > SCHEMA_VERSION {
        return Err(PmError::NewerSchema {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version > current) {
        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (?1, ?2)",
            params![version, now_epoch_ms],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn applied_version(connection: &Connection) -> Result<u32, PmError> {
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?)
}
