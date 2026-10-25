//! Reads of `ticket_notes`. `pending` is derived from the ticket's newest
//! description version at read time and never stored.

use rusqlite::{Connection, OptionalExtension, Row};

use super::rows::parsed;
use crate::{PmError, TicketAuthor, TicketNote, TicketNoteKind};

const NOTE_COLUMNS: &str = "n.id, n.ticket_id, n.kind, n.text, n.url, n.source_key, n.author, \
     n.created_at_epoch_ms, \
     n.created_at_epoch_ms >= COALESCE((SELECT MAX(v.recorded_at_epoch_ms) FROM ticket_versions v \
         WHERE v.ticket_id = n.ticket_id), -1)";

fn note_row(row: &Row<'_>) -> rusqlite::Result<TicketNote> {
    Ok(TicketNote {
        id: row.get(0)?,
        ticket_id: row.get(1)?,
        kind: parsed(row, 2, TicketNoteKind::parse)?,
        text: row.get(3)?,
        url: row.get(4)?,
        source_key: row.get(5)?,
        author: parsed(row, 6, TicketAuthor::parse)?,
        created_at_epoch_ms: row.get(7)?,
        pending: row.get(8)?,
    })
}

pub(crate) fn note_by_id(
    connection: &Connection,
    note_id: &str,
) -> Result<Option<TicketNote>, PmError> {
    Ok(connection
        .query_row(
            &format!("SELECT {NOTE_COLUMNS} FROM ticket_notes n WHERE n.id = ?1"),
            [note_id],
            note_row,
        )
        .optional()?)
}

/// A ticket's notes, oldest first.
pub(crate) fn ticket_notes(
    connection: &Connection,
    ticket_id: &str,
) -> Result<Vec<TicketNote>, PmError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {NOTE_COLUMNS} FROM ticket_notes n WHERE n.ticket_id = ?1 \
         ORDER BY n.created_at_epoch_ms, n.rowid"
    ))?;
    let notes = statement
        .query_map([ticket_id], note_row)?
        .collect::<Result<_, _>>()?;
    Ok(notes)
}
