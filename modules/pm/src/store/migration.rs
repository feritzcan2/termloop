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

/// Delivery: sprint end dates, per-ticket delivery facts (one current JSON
/// record each), delivery probes, and each project's non-secret sources.
const V2: &str = r#"
ALTER TABLE sprints ADD COLUMN ends_at_epoch_ms INTEGER CHECK (ends_at_epoch_ms >= 0);

CREATE TABLE ticket_delivery_facts (
    ticket_id TEXT PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
    facts_json TEXT NOT NULL,
    recorded_at_epoch_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE delivery_probes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    argv_json TEXT NOT NULL,
    matcher TEXT NOT NULL CHECK (matcher IN ('commitAncestry', 'agent')),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'approved')),
    author TEXT NOT NULL CHECK (author IN ('projectManager', 'agent')),
    reason TEXT,
    created_at_epoch_ms INTEGER NOT NULL,
    last_run_json TEXT
) STRICT;
CREATE INDEX delivery_probes_by_project ON delivery_probes (project_id, created_at_epoch_ms);

CREATE TABLE project_sources (
    project_id TEXT PRIMARY KEY,
    jira_site_url TEXT,
    jira_board_id INTEGER CHECK (jira_board_id > 0),
    jira_account_email TEXT,
    jira_credential_handle TEXT,
    github_owner TEXT,
    github_name TEXT,
    CHECK ((jira_site_url IS NULL) = (jira_account_email IS NULL)
        AND (jira_site_url IS NULL) = (jira_credential_handle IS NULL)
        AND (jira_site_url IS NOT NULL OR jira_board_id IS NULL)),
    CHECK ((github_owner IS NULL) = (github_name IS NULL))
) STRICT;
"#;

/// The Jira sprint mirror: which Jira sprint a sprint mirrors, and which
/// Jira sprint a linked ticket's issue was last seen in.
const V3: &str = r#"
ALTER TABLE sprints ADD COLUMN jira_sprint_id INTEGER CHECK (jira_sprint_id > 0);
ALTER TABLE sprints ADD COLUMN jira_board_id INTEGER CHECK (jira_board_id > 0);
ALTER TABLE sprints ADD COLUMN jira_pulled_at_epoch_ms INTEGER;
CREATE UNIQUE INDEX sprints_one_per_jira_sprint ON sprints (project_id, jira_sprint_id)
    WHERE jira_sprint_id IS NOT NULL;

ALTER TABLE tickets ADD COLUMN jira_sprint_id INTEGER CHECK (jira_sprint_id > 0);
ALTER TABLE tickets ADD COLUMN jira_pulled_at_epoch_ms INTEGER;
"#;

/// Agent proposals: a ticket change an agent suggested, waiting for the PM
/// to accept (it then becomes an agent-authored version) or reject.
const V4: &str = r#"
CREATE TABLE ticket_proposals (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('description', 'acceptanceCriteria')),
    description TEXT,
    criteria_json TEXT,
    summary TEXT NOT NULL,
    base_version INTEGER NOT NULL CHECK (base_version >= 0),
    created_at_epoch_ms INTEGER NOT NULL,
    CHECK ((kind = 'description') = (description IS NOT NULL)),
    CHECK ((kind = 'acceptanceCriteria') = (criteria_json IS NOT NULL))
) STRICT;
CREATE INDEX ticket_proposals_by_ticket ON ticket_proposals (ticket_id, created_at_epoch_ms);
"#;

/// Delivery checks the daemon runs: at most one running per ticket.
const V5: &str = r#"
CREATE TABLE delivery_checks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('checkReasons', 'probeChanged', 'requested')),
    environments_json TEXT NOT NULL,
    probe_id TEXT,
    started_at_epoch_ms INTEGER NOT NULL,
    finished_at_epoch_ms INTEGER,
    outcome TEXT CHECK (outcome IN ('reported', 'failed', 'abandoned')),
    CHECK ((finished_at_epoch_ms IS NULL) = (outcome IS NULL))
) STRICT;
CREATE UNIQUE INDEX delivery_checks_running ON delivery_checks (ticket_id)
    WHERE finished_at_epoch_ms IS NULL;
CREATE INDEX delivery_checks_by_project ON delivery_checks (project_id, started_at_epoch_ms);
CREATE INDEX delivery_checks_by_ticket ON delivery_checks (ticket_id, started_at_epoch_ms);
"#;

/// The projects registry and the app's one settings row.
const V6: &str = r#"
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT,
    created_at_epoch_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE pm_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    updated_at_epoch_ms INTEGER NOT NULL
) STRICT;
"#;

/// Every migration in order; a version is never edited once released.
const MIGRATIONS: &[(u32, &str)] = &[(1, V1), (2, V2), (3, V3), (4, V4), (5, V5), (6, V6)];

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
