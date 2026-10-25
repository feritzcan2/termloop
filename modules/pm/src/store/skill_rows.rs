//! Reads of the skill tables. Manifests, drafts, and samples are JSON
//! columns validated on read; a value that no longer validates is a
//! storage error.

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::delivery_rows::{invalid_row, json_column};
use super::rows::parsed;
use crate::PmError;
use crate::skill::{
    BuiltinSkill, DryRunState, FeedbackOutcome, SkillDraft, SkillDraftOrigin, SkillFeedback,
    SkillManifest, SkillRun, SkillRunOutcome, SkillRunTrigger,
};

/// One `skills` row before its manifest and derived state are joined in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillRecord {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) builtin: Option<BuiltinSkill>,
    pub(crate) enabled: bool,
    pub(crate) version: u32,
    pub(crate) consecutive_failures: u32,
    pub(crate) paused_reason: Option<String>,
    pub(crate) event_pending_at_epoch_ms: Option<u64>,
    pub(crate) next_attempt_at_epoch_ms: Option<u64>,
    pub(crate) created_at_epoch_ms: u64,
}

const SKILL_COLUMNS: &str = "id, project_id, builtin, enabled, version, consecutive_failures, \
     paused_reason, event_pending_at_epoch_ms, next_attempt_at_epoch_ms, created_at_epoch_ms";

fn skill_row(row: &Row<'_>) -> rusqlite::Result<SkillRecord> {
    let builtin: Option<String> = row.get(2)?;
    Ok(SkillRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        builtin: match builtin {
            Some(name) => Some(BuiltinSkill::parse(&name).ok_or_else(|| invalid_row(2))?),
            None => None,
        },
        enabled: row.get(3)?,
        version: row.get(4)?,
        consecutive_failures: row.get(5)?,
        paused_reason: row.get(6)?,
        event_pending_at_epoch_ms: row.get(7)?,
        next_attempt_at_epoch_ms: row.get(8)?,
        created_at_epoch_ms: row.get(9)?,
    })
}

pub(crate) fn skill_record(
    connection: &Connection,
    skill_id: &str,
) -> Result<Option<SkillRecord>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {SKILL_COLUMNS} FROM skills WHERE id = ?1"),
            [skill_id],
            skill_row,
        )
        .optional()?)
}

/// A project's skills: the built-in ones first, then by install time.
pub(crate) fn project_skill_records(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<SkillRecord>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SKILL_COLUMNS} FROM skills WHERE project_id = ?1 \
         ORDER BY builtin IS NULL, created_at_epoch_ms, id"
    ))?;
    let records = statement
        .query_map([project_id], skill_row)?
        .collect::<Result<_, _>>()?;
    Ok(records)
}

pub(crate) fn builtin_skill_record(
    connection: &Connection,
    project_id: &str,
    builtin: BuiltinSkill,
) -> Result<Option<SkillRecord>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {SKILL_COLUMNS} FROM skills WHERE project_id = ?1 AND builtin = ?2"),
            params![project_id, builtin.as_str()],
            skill_row,
        )
        .optional()?)
}

/// One tool approval the PM ticked at an install.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ToolApproval {
    pub(crate) tool: String,
    pub(crate) approved_at_epoch_ms: u64,
}

pub(crate) fn skill_manifest(
    connection: &Connection,
    skill_id: &str,
    version: u32,
    builtin: bool,
) -> Result<SkillManifest, PmError> {
    let manifest = connection.query_row(
        "SELECT manifest_json FROM skill_versions WHERE skill_id = ?1 AND version = ?2",
        params![skill_id, version],
        |row| json_column::<SkillManifest>(row, 0),
    )?;
    if manifest.invalid_field_of(builtin).is_some() {
        return Err(PmError::Storage("invalid stored skill manifest".into()));
    }
    Ok(manifest)
}

/// Every tool any version of the skill had approved.
pub(crate) fn approved_tools_ever(
    connection: &Connection,
    skill_id: &str,
) -> Result<Vec<String>, PmError> {
    let mut statement =
        connection.prepare("SELECT approvals_json FROM skill_versions WHERE skill_id = ?1")?;
    let mut tools: Vec<String> = Vec::new();
    for approvals in
        statement.query_map([skill_id], |row| json_column::<Vec<ToolApproval>>(row, 0))?
    {
        for approval in approvals? {
            if !tools.contains(&approval.tool) {
                tools.push(approval.tool);
            }
        }
    }
    Ok(tools)
}

const DRAFT_COLUMNS: &str = "id, project_id, origin, base_skill_id, manifest_json, \
     what_it_will_do, needed_tools_json, changelog, dry_run_state, dry_run_at_epoch_ms, \
     samples_json, created_at_epoch_ms";

fn draft_row(row: &Row<'_>) -> rusqlite::Result<SkillDraft> {
    let manifest: SkillManifest = json_column(row, 4)?;
    if !manifest.is_valid() {
        return Err(invalid_row(4));
    }
    Ok(SkillDraft {
        id: row.get(0)?,
        project_id: row.get(1)?,
        origin: parsed(row, 2, SkillDraftOrigin::parse)?,
        base_skill_id: row.get(3)?,
        manifest,
        what_it_will_do: row.get(5)?,
        needed_tools: json_column(row, 6)?,
        first_use_tools: Vec::new(),
        changelog: row.get(7)?,
        dry_run_state: parsed(row, 8, DryRunState::parse)?,
        dry_run_at_epoch_ms: row.get(9)?,
        samples: json_column(row, 10)?,
        created_at_epoch_ms: row.get(11)?,
    })
}

/// A draft with the tools it uses for the first time: every tool, unless
/// it revises a skill whose earlier versions approved some of them.
fn with_first_use(connection: &Connection, mut draft: SkillDraft) -> Result<SkillDraft, PmError> {
    let approved = match &draft.base_skill_id {
        Some(skill_id) => approved_tools_ever(connection, skill_id)?,
        None => Vec::new(),
    };
    draft.first_use_tools = draft
        .manifest
        .all_tools()
        .filter(|tool| !approved.contains(tool))
        .cloned()
        .collect();
    Ok(draft)
}

pub(crate) fn draft_by_id(
    connection: &Connection,
    draft_id: &str,
) -> Result<Option<SkillDraft>, PmError> {
    connection
        .query_row(
            &format!("SELECT {DRAFT_COLUMNS} FROM skill_drafts WHERE id = ?1"),
            [draft_id],
            draft_row,
        )
        .optional()?
        .map(|draft| with_first_use(connection, draft))
        .transpose()
}

pub(crate) fn project_drafts(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<SkillDraft>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {DRAFT_COLUMNS} FROM skill_drafts WHERE project_id = ?1 \
         ORDER BY created_at_epoch_ms, id"
    ))?;
    let drafts: Vec<SkillDraft> = statement
        .query_map([project_id], draft_row)?
        .collect::<Result<_, _>>()?;
    drafts
        .into_iter()
        .map(|draft| with_first_use(connection, draft))
        .collect()
}

const RUN_COLUMNS: &str = "id, project_id, skill_id, draft_id, version, trigger, items, \
     started_at_epoch_ms, finished_at_epoch_ms, outcome, summary";

fn run_row(row: &Row<'_>) -> rusqlite::Result<SkillRun> {
    let outcome: Option<String> = row.get(9)?;
    Ok(SkillRun {
        id: row.get(0)?,
        project_id: row.get(1)?,
        skill_id: row.get(2)?,
        draft_id: row.get(3)?,
        version: row.get(4)?,
        trigger: parsed(row, 5, SkillRunTrigger::parse)?,
        items: row.get(6)?,
        started_at_epoch_ms: row.get(7)?,
        finished_at_epoch_ms: row.get(8)?,
        outcome: match outcome {
            Some(name) => Some(SkillRunOutcome::parse(&name).ok_or_else(|| invalid_row(9))?),
            None => None,
        },
        summary: row.get(10)?,
    })
}

pub(crate) fn run_by_id(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<SkillRun>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {RUN_COLUMNS} FROM skill_runs WHERE id = ?1"),
            [run_id],
            run_row,
        )
        .optional()?)
}

fn runs_where(
    connection: &Connection,
    filter: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<SkillRun>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM skill_runs WHERE {filter} \
         ORDER BY started_at_epoch_ms DESC, id"
    ))?;
    let runs = statement
        .query_map(values, run_row)?
        .collect::<Result<_, _>>()?;
    Ok(runs)
}

/// The newest run matching `filter`.
fn newest_run(
    connection: &Connection,
    filter: &str,
    values: impl rusqlite::Params,
) -> Result<Option<SkillRun>, PmError> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {RUN_COLUMNS} FROM skill_runs WHERE {filter} \
                 ORDER BY started_at_epoch_ms DESC, id LIMIT 1"
            ),
            values,
            run_row,
        )
        .optional()?)
}

/// Whether a run of the skill is still going.
pub(crate) fn skill_is_running(connection: &Connection, skill_id: &str) -> Result<bool, PmError> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM skill_runs \
             WHERE skill_id = ?1 AND finished_at_epoch_ms IS NULL)",
        [skill_id],
        |row| row.get(0),
    )?)
}

/// A skill's newest run.
pub(crate) fn last_skill_run(
    connection: &Connection,
    skill_id: &str,
) -> Result<Option<SkillRun>, PmError> {
    newest_run(connection, "skill_id = ?1", [skill_id])
}

/// A skill's newest run that reported or found nothing new.
pub(crate) fn last_completed_skill_run(
    connection: &Connection,
    skill_id: &str,
) -> Result<Option<SkillRun>, PmError> {
    newest_run(
        connection,
        "skill_id = ?1 AND outcome IN ('reported', 'skipped')",
        [skill_id],
    )
}

/// A skill's runs, newest first.
pub(crate) fn skill_runs(
    connection: &Connection,
    skill_id: &str,
) -> Result<Vec<SkillRun>, PmError> {
    runs_where(connection, "skill_id = ?1", [skill_id])
}

pub(crate) fn running_skill_runs(connection: &Connection) -> Result<Vec<SkillRun>, PmError> {
    runs_where(connection, "finished_at_epoch_ms IS NULL", [])
}

/// Agent launches of a skill since `since`: skipped runs launched nothing.
pub(crate) fn launched_runs_since(
    connection: &Connection,
    skill_id: &str,
    since: u64,
) -> Result<u32, PmError> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM skill_runs WHERE skill_id = ?1 AND started_at_epoch_ms >= ?2 \
             AND outcome IS NOT 'skipped'",
        params![skill_id, since],
        |row| row.get(0),
    )?)
}

fn feedback_row(row: &Row<'_>) -> rusqlite::Result<SkillFeedback> {
    Ok(SkillFeedback {
        skill_id: row.get(0)?,
        version: row.get(1)?,
        ticket_id: row.get(2)?,
        kind: row.get(3)?,
        outcome: parsed(row, 4, FeedbackOutcome::parse)?,
        sources: json_column(row, 5)?,
        reason: row.get(6)?,
        recorded_at_epoch_ms: row.get(7)?,
    })
}

/// A skill's feedback, newest first.
pub(crate) fn skill_feedback(
    connection: &Connection,
    skill_id: &str,
) -> Result<Vec<SkillFeedback>, PmError> {
    let mut statement = connection.prepare(
        "SELECT skill_id, version, ticket_id, kind, outcome, sources_json, reason, \
             recorded_at_epoch_ms \
         FROM skill_feedback WHERE skill_id = ?1 ORDER BY id DESC",
    )?;
    let entries = statement
        .query_map([skill_id], feedback_row)?
        .collect::<Result<_, _>>()?;
    Ok(entries)
}

/// The PM rejected a suggestion of the skill resting on this evidence.
pub(crate) fn evidence_rejected(
    connection: &Connection,
    skill_id: &str,
    evidence_key: &str,
) -> Result<bool, PmError> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM skill_feedback \
             WHERE skill_id = ?1 AND evidence_key = ?2 AND outcome = 'rejected' LIMIT 1",
            params![skill_id, evidence_key],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
