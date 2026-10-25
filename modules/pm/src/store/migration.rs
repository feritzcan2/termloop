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

/// Ticket changes the digest names that leave no other trace: status,
/// assignee, sprint moves, and blockers. Bounded per ticket on write.
const V7: &str = r#"
CREATE TABLE ticket_activity (
    id INTEGER PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL
        CHECK (kind IN ('status', 'assignee', 'moved', 'blockerAdded', 'blockerRemoved')),
    detail TEXT,
    recorded_at_epoch_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX ticket_activity_by_ticket ON ticket_activity (ticket_id, id);
CREATE INDEX ticket_activity_by_time ON ticket_activity (recorded_at_epoch_ms);
"#;

/// Skills: installed manifests and their immutable versions, drafts from
/// the skill creator, runs, the PM's feedback per suggestion, and the
/// creator's discovery cache. Proposals widen to every suggestion kind and
/// name the skill and evidence they come from; an accepted Jira comment
/// waits for the PM's confirmed Jira write.
const V8: &str = r#"
CREATE TABLE ticket_proposals_next (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('description', 'acceptanceCriteria', 'blockers',
        'status', 'assignee', 'sprint', 'jiraComment')),
    change_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    base_version INTEGER NOT NULL CHECK (base_version >= 0),
    skill_id TEXT,
    skill_version INTEGER CHECK (skill_version > 0),
    evidence_json TEXT NOT NULL,
    evidence_key TEXT,
    created_at_epoch_ms INTEGER NOT NULL,
    CHECK ((skill_id IS NULL) = (skill_version IS NULL))
) STRICT;
INSERT INTO ticket_proposals_next (id, ticket_id, kind, change_json, summary, base_version,
        evidence_json, created_at_epoch_ms)
    SELECT id, ticket_id, kind,
        CASE kind
            WHEN 'description' THEN json_object('kind', 'description', 'description', description)
            ELSE json_object('kind', 'acceptanceCriteria', 'criteria', json(criteria_json))
        END,
        summary, base_version, '[]', created_at_epoch_ms
    FROM ticket_proposals;
DROP TABLE ticket_proposals;
ALTER TABLE ticket_proposals_next RENAME TO ticket_proposals;
CREATE INDEX ticket_proposals_by_ticket ON ticket_proposals (ticket_id, created_at_epoch_ms);
CREATE INDEX ticket_proposals_by_skill ON ticket_proposals (skill_id)
    WHERE skill_id IS NOT NULL;

CREATE TABLE ticket_jira_comments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    queued_at_epoch_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX ticket_jira_comments_by_ticket ON ticket_jira_comments (ticket_id, queued_at_epoch_ms);

CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    builtin TEXT CHECK (builtin IN ('deploymentControl')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL CHECK (version > 0),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    paused_reason TEXT,
    event_pending_at_epoch_ms INTEGER,
    next_attempt_at_epoch_ms INTEGER,
    created_at_epoch_ms INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX skills_one_builtin ON skills (project_id, builtin)
    WHERE builtin IS NOT NULL;
CREATE INDEX skills_by_project ON skills (project_id, created_at_epoch_ms);

CREATE TABLE skill_versions (
    skill_id TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    manifest_json TEXT NOT NULL,
    approvals_json TEXT NOT NULL,
    changelog TEXT,
    recorded_at_epoch_ms INTEGER NOT NULL,
    PRIMARY KEY (skill_id, version)
) STRICT;
CREATE TRIGGER skill_versions_are_immutable BEFORE UPDATE ON skill_versions
BEGIN
    SELECT RAISE(ABORT, 'skill versions are immutable');
END;

CREATE TABLE skill_drafts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('creator', 'import', 'revision')),
    base_skill_id TEXT REFERENCES skills (id) ON DELETE CASCADE,
    manifest_json TEXT NOT NULL,
    what_it_will_do TEXT NOT NULL,
    needed_tools_json TEXT NOT NULL,
    changelog TEXT,
    dry_run_state TEXT NOT NULL
        CHECK (dry_run_state IN ('none', 'running', 'completed', 'failed')),
    dry_run_at_epoch_ms INTEGER,
    samples_json TEXT NOT NULL,
    created_at_epoch_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX skill_drafts_by_project ON skill_drafts (project_id, created_at_epoch_ms);

CREATE TABLE skill_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    skill_id TEXT REFERENCES skills (id) ON DELETE CASCADE,
    draft_id TEXT REFERENCES skill_drafts (id) ON DELETE CASCADE,
    version INTEGER CHECK (version > 0),
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'event', 'dryRun')),
    items INTEGER NOT NULL CHECK (items >= 0),
    started_at_epoch_ms INTEGER NOT NULL,
    finished_at_epoch_ms INTEGER,
    outcome TEXT CHECK (outcome IN ('reported', 'failed', 'abandoned', 'skipped')),
    summary TEXT,
    CHECK ((skill_id IS NULL) != (draft_id IS NULL)),
    CHECK ((trigger = 'dryRun') = (draft_id IS NOT NULL)),
    CHECK ((finished_at_epoch_ms IS NULL) = (outcome IS NULL))
) STRICT;
CREATE UNIQUE INDEX skill_runs_running_skill ON skill_runs (skill_id)
    WHERE finished_at_epoch_ms IS NULL AND skill_id IS NOT NULL;
CREATE UNIQUE INDEX skill_runs_running_draft ON skill_runs (draft_id)
    WHERE finished_at_epoch_ms IS NULL AND draft_id IS NOT NULL;
CREATE INDEX skill_runs_by_skill ON skill_runs (skill_id, started_at_epoch_ms);
CREATE INDEX skill_runs_by_project ON skill_runs (project_id, started_at_epoch_ms);

CREATE TABLE skill_feedback (
    id INTEGER PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    ticket_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
    evidence_key TEXT,
    sources_json TEXT NOT NULL,
    reason TEXT,
    recorded_at_epoch_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX skill_feedback_by_skill ON skill_feedback (skill_id, id);
CREATE INDEX skill_feedback_rejected_evidence ON skill_feedback (skill_id, evidence_key)
    WHERE outcome = 'rejected' AND evidence_key IS NOT NULL;

CREATE TABLE skill_discovery_cache (
    project_id TEXT PRIMARY KEY,
    discovery_json TEXT NOT NULL,
    sources_key TEXT NOT NULL,
    refreshed_at_epoch_ms INTEGER NOT NULL
) STRICT;
"#;

/// Ticket notes: facts learned about a ticket and links to read again,
/// the raw input a description draft merges in. Whether a note is pending
/// is derived from the newest description version on read.
const V9: &str = r#"
CREATE TABLE ticket_notes (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'source')),
    text TEXT NOT NULL,
    url TEXT,
    source_key TEXT,
    author TEXT NOT NULL CHECK (author IN ('pm', 'agent', 'jira')),
    created_at_epoch_ms INTEGER NOT NULL,
    CHECK (kind = 'fact' OR url IS NOT NULL)
) STRICT;
CREATE INDEX ticket_notes_by_ticket ON ticket_notes (ticket_id, created_at_epoch_ms);
CREATE UNIQUE INDEX ticket_notes_one_per_source_key ON ticket_notes (ticket_id, source_key)
    WHERE source_key IS NOT NULL;
"#;

/// Slack read positions: per skill and channel, the newest message
/// timestamp a reported run read up to. Bounded by the manifest's channels
/// and dropped after 30 days without a run.
const V10: &str = r#"
CREATE TABLE skill_channel_watermarks (
    skill_id TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    updated_at_epoch_ms INTEGER NOT NULL,
    PRIMARY KEY (skill_id, channel_id)
) STRICT;
"#;

/// What a Deployment control setup found, waiting for the PM: at most one
/// per project, replaced by the next setup.
const V11: &str = r#"
CREATE TABLE environment_proposals (
    project_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    environments_json TEXT NOT NULL,
    probe_ids_json TEXT NOT NULL,
    created_at_epoch_ms INTEGER NOT NULL
) STRICT;
"#;

/// Every migration in order; a version is never edited once released.
const MIGRATIONS: &[(u32, &str)] = &[
    (1, V1),
    (2, V2),
    (3, V3),
    (4, V4),
    (5, V5),
    (6, V6),
    (7, V7),
    (8, V8),
    (9, V9),
    (10, V10),
    (11, V11),
];

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

/// Applies the migrations up to `version` only: a database as an older
/// build left it.
#[cfg(test)]
pub(super) fn migrate_to(connection: &Connection, version: u32) -> Result<(), PmError> {
    connection.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, \
             applied_at_epoch_ms INTEGER NOT NULL) STRICT;",
    )?;
    for (number, sql) in MIGRATIONS.iter().filter(|(number, _)| *number <= version) {
        connection.execute_batch(sql)?;
        connection.execute(
            "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (?1, 0)",
            [number],
        )?;
    }
    Ok(())
}

pub(super) fn applied_version(connection: &Connection) -> Result<u32, PmError> {
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?)
}
