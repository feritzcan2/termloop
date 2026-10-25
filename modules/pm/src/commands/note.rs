//! Ticket notes: the PM or an agent records what it learned about a ticket,
//! or a link to follow, and the PM removes a note it no longer wants. A
//! note never changes the ticket; the description changes only through a
//! version the PM saves or a proposal the PM accepts.

use rusqlite::params;

use super::{check_id, require_ticket};
use crate::note::{TICKET_NOTE_SOURCES_MAX, TICKET_NOTES_MAX};
use crate::store::{note_by_id, ticket_notes};
use crate::{NewTicketNote, PmError, PmStore, TicketNote, TicketNoteKind};

impl PmStore {
    /// Records a note. A source key or a source link the ticket already
    /// holds is refused, so reading the same message or thread again adds
    /// nothing.
    pub fn add_ticket_note(&mut self, note: NewTicketNote) -> Result<TicketNote, PmError> {
        if let Some(parameter) = note.invalid_parameter() {
            return Err(PmError::Invalid(parameter));
        }
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            require_ticket(transaction, &note.ticket_id)?;
            let existing = ticket_notes(transaction, &note.ticket_id)?;
            if existing.len() >= TICKET_NOTES_MAX {
                return Err(PmError::Constraint("too many notes"));
            }
            if note.kind == TicketNoteKind::Source
                && existing
                    .iter()
                    .filter(|other| other.kind == TicketNoteKind::Source)
                    .count()
                    >= TICKET_NOTE_SOURCES_MAX
            {
                return Err(PmError::Constraint("too many sources"));
            }
            let duplicate = existing.iter().any(|other| {
                (note.source_key.is_some() && other.source_key == note.source_key)
                    || (note.kind == TicketNoteKind::Source
                        && other.kind == TicketNoteKind::Source
                        && other.url == note.url)
            });
            if duplicate {
                return Err(PmError::Constraint("the note is already recorded"));
            }
            transaction.execute(
                "INSERT INTO ticket_notes (id, ticket_id, kind, text, url, source_key, author, \
                     created_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    note.ticket_id,
                    note.kind.as_str(),
                    note.text,
                    note.url,
                    note.source_key,
                    note.author.as_str(),
                    now
                ],
            )?;
            note_by_id(transaction, &id)?.ok_or(PmError::NotFound)
        })
    }

    /// The PM removes a note; the ticket is left alone.
    pub fn remove_ticket_note(&mut self, note_id: &str) -> Result<(), PmError> {
        check_id(note_id, "noteId")?;
        self.write(|transaction| {
            let removed =
                transaction.execute("DELETE FROM ticket_notes WHERE id = ?1", [note_id])?;
            if removed == 0 {
                return Err(PmError::NotFound);
            }
            Ok(())
        })
    }

    /// A ticket's notes, oldest first, each marked pending while the
    /// newest description version is older than it.
    pub fn ticket_notes(&self, ticket_id: &str) -> Result<Vec<TicketNote>, PmError> {
        require_ticket(self.connection(), ticket_id)?;
        ticket_notes(self.connection(), ticket_id)
    }

    /// The note with this id, for a caller that checks its ticket first.
    pub fn ticket_note(&self, note_id: &str) -> Result<TicketNote, PmError> {
        check_id(note_id, "noteId")?;
        note_by_id(self.connection(), note_id)?.ok_or(PmError::NotFound)
    }
}
