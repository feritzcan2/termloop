//! Ticket notes: what the PM, the assistant, or a skill learned about a
//! ticket since its description was last written, and the links (a Slack
//! thread, a document) worth reading again for more. Notes are the raw
//! input; the description stays the PM-accepted synthesis of them. A note
//! is never edited; it is added or removed.

use crate::TicketAuthor;
use crate::validation::{valid_id, valid_label, valid_non_blank_text};

/// Notes one ticket may hold, facts and sources together.
pub const TICKET_NOTES_MAX: usize = 100;
/// Sources one ticket may follow.
pub const TICKET_NOTE_SOURCES_MAX: usize = 10;
pub const TICKET_NOTE_MAX_CHARS: usize = 2_000;
/// A source's label is one line.
pub const TICKET_NOTE_LABEL_MAX_CHARS: usize = 120;
pub const TICKET_NOTE_URL_MAX_BYTES: usize = 2_048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TicketNoteKind {
    /// Something learned about the ticket: a decision, a constraint, a
    /// changed scope, an answer to an open question.
    Fact,
    /// A link to read again for new facts: its `text` is a one-line label
    /// and its `url` is required.
    Source,
}

crate::ticket::stored_names!(TicketNoteKind {
    Fact => "fact",
    Source => "source",
});

/// One note of a ticket. `pending` is derived on read: the note is newer
/// than the ticket's newest description version, so the description does
/// not reflect it yet.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicketNote {
    pub id: String,
    pub ticket_id: String,
    pub kind: TicketNoteKind,
    pub text: String,
    /// Where the fact was read (e.g. a Slack permalink), or the source's
    /// link.
    #[serde(default)]
    pub url: Option<String>,
    /// An identifier of what the note was read from (e.g. a Slack channel
    /// and message timestamp); a ticket records each one once.
    #[serde(default)]
    pub source_key: Option<String>,
    pub author: TicketAuthor,
    pub created_at_epoch_ms: u64,
    pub pending: bool,
}

/// A note to record; the store assigns its id, time, and `pending`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTicketNote {
    pub ticket_id: String,
    pub kind: TicketNoteKind,
    pub text: String,
    pub url: Option<String>,
    pub source_key: Option<String>,
    pub author: TicketAuthor,
}

impl NewTicketNote {
    /// The parameter an invalid note names, or `None` when it is valid.
    pub(crate) fn invalid_parameter(&self) -> Option<&'static str> {
        if !valid_id(&self.ticket_id) {
            return Some("ticketId");
        }
        let text_ok = match self.kind {
            TicketNoteKind::Fact => valid_ticket_note_text(&self.text),
            TicketNoteKind::Source => valid_label(&self.text, TICKET_NOTE_LABEL_MAX_CHARS),
        };
        if !text_ok {
            return Some("text");
        }
        let url_ok = match (&self.url, self.kind) {
            (None, TicketNoteKind::Source) => false,
            (None, TicketNoteKind::Fact) => true,
            (Some(url), _) => valid_ticket_note_url(url),
        };
        if !url_ok {
            return Some("url");
        }
        if self.source_key.as_deref().is_some_and(|key| !valid_id(key)) {
            return Some("sourceKey");
        }
        None
    }
}

/// A fact: multi-line, non-blank, bounded, already trimmed.
pub fn valid_ticket_note_text(text: &str) -> bool {
    valid_non_blank_text(text, TICKET_NOTE_MAX_CHARS) && text.trim() == text
}

/// Only an HTTPS link without userinfo is kept.
pub fn valid_ticket_note_url(url: &str) -> bool {
    url.len() <= TICKET_NOTE_URL_MAX_BYTES
        && url.strip_prefix("https://").is_some_and(|rest| {
            !rest.is_empty() && !rest.split('/').next().unwrap_or("").contains('@')
        })
        && url.bytes().all(|byte| byte.is_ascii_graphic())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(kind: TicketNoteKind, text: &str, url: Option<&str>) -> NewTicketNote {
        NewTicketNote {
            ticket_id: "t1".into(),
            kind,
            text: text.into(),
            url: url.map(str::to_owned),
            source_key: None,
            author: TicketAuthor::Pm,
        }
    }

    #[test]
    fn facts_are_trimmed_text_and_sources_are_labelled_links() {
        assert_eq!(
            note(
                TicketNoteKind::Fact,
                "Client wants CSV too\n- by Friday",
                None
            )
            .invalid_parameter(),
            None
        );
        assert_eq!(
            note(TicketNoteKind::Fact, " padded", None).invalid_parameter(),
            Some("text")
        );
        assert_eq!(
            note(TicketNoteKind::Source, "Slack #shop thread", None).invalid_parameter(),
            Some("url")
        );
        assert_eq!(
            note(
                TicketNoteKind::Source,
                "two\nlines",
                Some("https://acme.slack.com/archives/C1/p1")
            )
            .invalid_parameter(),
            Some("text")
        );
        assert_eq!(
            note(
                TicketNoteKind::Source,
                "Slack #shop thread",
                Some("https://acme.slack.com/archives/C1/p1")
            )
            .invalid_parameter(),
            None
        );
        assert!(!valid_ticket_note_url("http://acme.slack.com/x"));
        assert!(!valid_ticket_note_url(
            "https://user:secret@acme.slack.com/x"
        ));
        assert!(!valid_ticket_note_url("https://acme.slack.com/a b"));
        assert!(valid_ticket_note_url(
            "https://acme.atlassian.net/wiki/x?focusedCommentId=1@2"
        ));
    }

    #[test]
    fn stored_names_round_trip() {
        for kind in [TicketNoteKind::Fact, TicketNoteKind::Source] {
            assert_eq!(TicketNoteKind::parse(kind.as_str()), Some(kind));
        }
    }
}
