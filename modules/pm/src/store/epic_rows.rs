//! Reads of the epic tables: a project's epics, its waiting breakdowns, and
//! the assistant conversation it resumes.

use rusqlite::{Connection, OptionalExtension, Row};

use super::delivery_rows::{invalid_row, json_column};
use crate::PmError;
use crate::epic::{AssistantConversation, Epic, EpicBreakdown, EpicDraft};

const EPIC_COLUMNS: &str =
    "id, project_id, title, description, created_at_epoch_ms, updated_at_epoch_ms";

fn epic_row(row: &Row<'_>) -> rusqlite::Result<Epic> {
    Ok(Epic {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        created_at_epoch_ms: row.get(4)?,
        updated_at_epoch_ms: row.get(5)?,
    })
}

pub(crate) fn epic_by_id(connection: &Connection, id: &str) -> Result<Option<Epic>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {EPIC_COLUMNS} FROM epics WHERE id = ?1"),
            [id],
            epic_row,
        )
        .optional()?)
}

/// A project's epics in creation order.
pub(crate) fn project_epics(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<Epic>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {EPIC_COLUMNS} FROM epics WHERE project_id = ?1 \
         ORDER BY created_at_epoch_ms, id"
    ))?;
    let epics = statement
        .query_map([project_id], epic_row)?
        .collect::<Result<_, _>>()?;
    Ok(epics)
}

const BREAKDOWN_COLUMNS: &str =
    "id, project_id, epic_id, epic_json, tasks_json, summary, created_at_epoch_ms";

fn breakdown_row(row: &Row<'_>) -> rusqlite::Result<EpicBreakdown> {
    let epic_json: Option<String> = row.get(3)?;
    let epic = epic_json
        .map(|text| serde_json::from_str::<EpicDraft>(&text).map_err(|_| invalid_row(3)))
        .transpose()?;
    let breakdown = EpicBreakdown {
        id: row.get(0)?,
        project_id: row.get(1)?,
        epic_id: row.get(2)?,
        epic,
        tasks: json_column(row, 4)?,
        summary: row.get(5)?,
        created_at_epoch_ms: row.get(6)?,
    };
    if breakdown.is_valid() {
        Ok(breakdown)
    } else {
        Err(invalid_row(4))
    }
}

pub(crate) fn breakdown_by_id(
    connection: &Connection,
    id: &str,
) -> Result<Option<EpicBreakdown>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {BREAKDOWN_COLUMNS} FROM epic_breakdowns WHERE id = ?1"),
            [id],
            breakdown_row,
        )
        .optional()?)
}

/// A project's breakdowns waiting for the PM, oldest first.
pub(crate) fn project_breakdowns(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<EpicBreakdown>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {BREAKDOWN_COLUMNS} FROM epic_breakdowns WHERE project_id = ?1 \
         ORDER BY created_at_epoch_ms, id"
    ))?;
    let breakdowns = statement
        .query_map([project_id], breakdown_row)?
        .collect::<Result<_, _>>()?;
    Ok(breakdowns)
}

pub(crate) fn assistant_conversation(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<AssistantConversation>, PmError> {
    Ok(connection
        .query_row(
            "SELECT project_id, provider, conversation_id, cwd, started_at_epoch_ms \
             FROM assistant_conversations WHERE project_id = ?1",
            [project_id],
            |row| {
                Ok(AssistantConversation {
                    project_id: row.get(0)?,
                    provider: row.get(1)?,
                    conversation_id: row.get(2)?,
                    cwd: row.get(3)?,
                    started_at_epoch_ms: row.get(4)?,
                })
            },
        )
        .optional()?)
}
