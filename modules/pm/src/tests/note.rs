use std::sync::atomic::{AtomicU64, Ordering};

use super::{store, ticket};
use crate::{
    NewTicketNote, PmError, ProposalChange, TICKET_NOTE_SOURCES_MAX, TicketAuthor, TicketNoteKind,
};

const THREAD: &str = "https://acme.slack.com/archives/C1/p100";

fn fact(ticket_id: &str, text: &str) -> NewTicketNote {
    NewTicketNote {
        ticket_id: ticket_id.into(),
        kind: TicketNoteKind::Fact,
        text: text.into(),
        url: None,
        source_key: None,
        author: TicketAuthor::Pm,
    }
}

fn source(ticket_id: &str, url: &str) -> NewTicketNote {
    NewTicketNote {
        kind: TicketNoteKind::Source,
        url: Some(url.into()),
        ..fact(ticket_id, "Slack thread")
    }
}

#[test]
fn notes_are_pending_until_a_newer_description_version() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let work = ticket(&mut store, "p1", "Export", None);
    store
        .save_ticket_description(&work.id, "## Goal\nExport orders", TicketAuthor::Pm, None)
        .unwrap();

    NOW.store(2_000, Ordering::SeqCst);
    let note = store
        .add_ticket_note(fact(&work.id, "The client also wants CSV"))
        .unwrap();
    assert!(note.pending);
    assert_eq!(note.author, TicketAuthor::Pm);
    // A note never changes the ticket.
    assert_eq!(
        store.ticket(&work.id).unwrap().unwrap().description,
        "## Goal\nExport orders"
    );

    // An accepted description proposal is the newer version that takes it in.
    NOW.store(3_000, Ordering::SeqCst);
    let proposal = store
        .propose_ticket_change(
            &work.id,
            ProposalChange::Description {
                description: "## Goal\nExport orders as XLSX and CSV".into(),
            },
            "Add CSV from the PM's note",
        )
        .unwrap();
    assert!(store.ticket_notes(&work.id).unwrap()[0].pending);
    NOW.store(4_000, Ordering::SeqCst);
    store.accept_ticket_proposal(&proposal.id).unwrap();
    let notes = store.ticket_notes(&work.id).unwrap();
    assert_eq!(notes.len(), 1);
    assert!(!notes[0].pending);

    NOW.store(5_000, Ordering::SeqCst);
    store
        .add_ticket_note(fact(&work.id, "Deadline moved to Friday"))
        .unwrap();
    let pending: Vec<_> = store
        .ticket_notes(&work.id)
        .unwrap()
        .into_iter()
        .map(|note| note.pending)
        .collect();
    assert_eq!(pending, [false, true]);
}

#[test]
fn a_ticket_without_versions_has_every_note_pending() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Export", None);
    let note = store.add_ticket_note(source(&work.id, THREAD)).unwrap();
    assert!(note.pending);
    assert_eq!(note.kind, TicketNoteKind::Source);
    assert_eq!(note.url.as_deref(), Some(THREAD));
}

#[test]
fn the_same_message_or_source_is_recorded_once() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Export", None);
    let read = NewTicketNote {
        source_key: Some("slack:C1:100.1".into()),
        author: TicketAuthor::Agent,
        url: Some(THREAD.into()),
        ..fact(&work.id, "CSV is needed too")
    };
    store.add_ticket_note(read.clone()).unwrap();
    assert!(matches!(
        store.add_ticket_note(NewTicketNote {
            text: "Reworded".into(),
            ..read
        }),
        Err(PmError::Constraint(_))
    ));
    store.add_ticket_note(source(&work.id, THREAD)).unwrap();
    assert!(matches!(
        store.add_ticket_note(source(&work.id, THREAD)),
        Err(PmError::Constraint(_))
    ));
    // A fact may cite the same link as a source the ticket follows.
    store
        .add_ticket_note(NewTicketNote {
            url: Some(THREAD.into()),
            ..fact(&work.id, "Second fact from the thread")
        })
        .unwrap();
}

#[test]
fn notes_are_validated_bounded_and_removable() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Export", None);
    assert!(matches!(
        store.add_ticket_note(fact(&work.id, "  ")),
        Err(PmError::Invalid("text"))
    ));
    assert!(matches!(
        store.add_ticket_note(NewTicketNote {
            url: None,
            ..source(&work.id, THREAD)
        }),
        Err(PmError::Invalid("url"))
    ));
    assert!(matches!(
        store.add_ticket_note(fact("missing", "Fact")),
        Err(PmError::NotFound)
    ));
    for index in 0..TICKET_NOTE_SOURCES_MAX {
        store
            .add_ticket_note(source(&work.id, &format!("{THREAD}{index}")))
            .unwrap();
    }
    assert!(matches!(
        store.add_ticket_note(source(&work.id, "https://acme.slack.com/archives/C2/p1")),
        Err(PmError::Constraint("too many sources"))
    ));

    let note = store.add_ticket_note(fact(&work.id, "Keep me")).unwrap();
    assert_eq!(store.ticket_note(&note.id).unwrap(), note);
    store.remove_ticket_note(&note.id).unwrap();
    assert!(matches!(
        store.remove_ticket_note(&note.id),
        Err(PmError::NotFound)
    ));
    assert_eq!(
        store.ticket_notes(&work.id).unwrap().len(),
        TICKET_NOTE_SOURCES_MAX
    );
}

#[test]
fn a_newer_assistant_description_draft_replaces_the_older_one() {
    let mut store = store();
    let work = ticket(&mut store, "p1", "Export", None);
    let draft = |text: &str| ProposalChange::Description {
        description: text.into(),
    };
    store
        .propose_ticket_change(&work.id, draft("## Goal\nXLSX"), "First draft")
        .unwrap();
    store
        .propose_ticket_change(
            &work.id,
            ProposalChange::AcceptanceCriteria {
                criteria: vec!["Exports XLSX".into()],
            },
            "Criteria",
        )
        .unwrap();
    let newer = store
        .propose_ticket_change(
            &work.id,
            draft("## Goal\nXLSX and CSV"),
            "With the CSV note",
        )
        .unwrap();
    let pending = store.ticket_proposals(&work.id).unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().any(|proposal| proposal.id == newer.id));
    assert!(
        pending
            .iter()
            .all(|proposal| proposal.summary != "First draft")
    );
}
