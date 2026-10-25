use std::sync::atomic::{AtomicU64, Ordering};

use super::{sprint, store, ticket};
use crate::{
    DIGEST_ENTRIES_MAX, DigestKind, DigestSource, PmError, PmSettings, SettingsEdit, Ticket,
    TicketAuthor, TicketStatus, digest,
};

#[test]
fn projects_are_registered_and_listed_oldest_first() {
    let mut store = store();
    assert!(store.projects().unwrap().is_empty());
    let first = store
        .create_project("Payments", Some("/work/payments"))
        .unwrap();
    let second = store.create_project("Search", None).unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(store.projects().unwrap(), vec![first.clone(), second]);
    assert_eq!(store.project(&first.id).unwrap(), Some(first));
    assert_eq!(store.project("missing").unwrap(), None);
}

#[test]
fn a_project_needs_a_trimmed_name_and_an_absolute_folder() {
    let mut store = store();
    assert!(matches!(
        store.create_project(" Payments", None),
        Err(PmError::Invalid("name"))
    ));
    assert!(matches!(
        store.create_project("Payments", Some("relative/path")),
        Err(PmError::Invalid("folder"))
    ));
    assert!(store.projects().unwrap().is_empty());
}

#[test]
fn settings_default_until_updated_and_keep_absent_fields() {
    let mut store = store();
    assert_eq!(store.settings().unwrap(), PmSettings::default());
    let updated = store
        .update_settings(SettingsEdit {
            agent_provider: Some("codex".to_owned()),
            agent_account_id: Some(Some("work".to_owned())),
            ..SettingsEdit::default()
        })
        .unwrap();
    assert_eq!(updated.agent_provider, "codex");
    assert_eq!(updated.agent_account_id.as_deref(), Some("work"));
    assert_eq!(updated.agent_model, "default");
    assert_eq!(store.settings().unwrap(), updated);

    let cleared = store
        .update_settings(SettingsEdit {
            agent_account_id: Some(None),
            ..SettingsEdit::default()
        })
        .unwrap();
    assert_eq!(cleared.agent_account_id, None);
    assert_eq!(cleared.agent_provider, "codex");
}

#[test]
fn invalid_settings_change_nothing() {
    let mut store = store();
    let error = store
        .update_settings(SettingsEdit {
            agent_provider: Some("gemini".to_owned()),
            ..SettingsEdit::default()
        })
        .unwrap_err();
    assert!(matches!(error, PmError::Invalid("agentProvider")));
    let error = store
        .update_settings(SettingsEdit {
            check_permission: Some("bad value".to_owned()),
            ..SettingsEdit::default()
        })
        .unwrap_err();
    assert!(matches!(error, PmError::Invalid("checkPermission")));
    assert_eq!(store.settings().unwrap(), PmSettings::default());
}

static NOW: AtomicU64 = AtomicU64::new(1_000);

#[test]
fn the_digest_reads_what_changed_after_a_moment() {
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    NOW.store(1_000, Ordering::SeqCst);
    let old = ticket(&mut store, "p1", "Old work", None);
    NOW.store(2_000, Ordering::SeqCst);
    let planned = sprint(&mut store, "p1", "Sprint 1");
    let fresh = ticket(&mut store, "p1", "New work", Some(&planned.id));
    NOW.store(3_000, Ordering::SeqCst);
    store
        .save_ticket_description(&old.id, "Do it", TicketAuthor::Pm, None)
        .unwrap();
    store.activate_sprint(&planned.id).unwrap();

    let digest = store.digest("p1", 1_500).unwrap();
    assert_eq!(digest.until_epoch_ms, 3_000);
    assert!(!digest.truncated);
    let kinds: Vec<_> = digest
        .entries
        .iter()
        .map(|entry| (entry.kind, entry.at_epoch_ms))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (DigestKind::TicketCreated, 2_000),
            (DigestKind::DescriptionVersioned, 3_000),
            (DigestKind::SprintActivated, 3_000),
        ]
    );
    assert_eq!(
        digest.entries[0].ticket_id.as_deref(),
        Some(fresh.id.as_str())
    );
    assert_eq!(
        digest.entries[1].summary,
        "Description of Old work saved as version 1 by the project manager"
    );
    assert!(store.digest("p1", 3_000).unwrap().entries.is_empty());
}

static ACTIVITY_NOW: AtomicU64 = AtomicU64::new(1_000);

#[test]
fn the_digest_names_status_assignee_moves_and_blockers() {
    let mut store = store();
    store.set_clock(|| ACTIVITY_NOW.load(Ordering::SeqCst));
    let at = |moment: u64| ACTIVITY_NOW.store(moment, Ordering::SeqCst);
    at(1_000);
    let planned = sprint(&mut store, "p1", "Sprint 1");
    let work = ticket(&mut store, "p1", "Checkout", None);
    at(2_000);
    store
        .set_ticket_status(&work.id, TicketStatus::InProgress)
        .unwrap();
    at(2_100);
    store.set_ticket_assignee(&work.id, Some("ada")).unwrap();
    at(2_200);
    store
        .move_ticket_to_sprint(&work.id, Some(&planned.id))
        .unwrap();
    at(2_300);
    let blocker = store
        .add_ticket_blocker(&work.id, "Waiting on API")
        .unwrap();
    at(2_400);
    store.remove_ticket_blocker(&work.id, &blocker.id).unwrap();
    at(2_500);
    // Setting the value a ticket already has records nothing.
    store
        .set_ticket_status(&work.id, TicketStatus::InProgress)
        .unwrap();
    store.set_ticket_assignee(&work.id, None).unwrap();

    let digest = store.digest("p1", 1_500).unwrap();
    let entries: Vec<_> = digest
        .entries
        .iter()
        .map(|entry| (entry.kind, entry.summary.as_str()))
        .collect();
    assert_eq!(
        entries,
        vec![
            (DigestKind::StatusChanged, "Checkout moved to In progress"),
            (DigestKind::AssigneeChanged, "Checkout assigned to ada"),
            (DigestKind::TicketMoved, "Checkout moved to Sprint 1"),
            (DigestKind::BlockerAdded, "Checkout blocked: Waiting on API"),
            (
                DigestKind::BlockerRemoved,
                "Checkout unblocked: Waiting on API"
            ),
            (DigestKind::AssigneeChanged, "Checkout unassigned"),
        ]
    );
    assert_eq!(
        digest.entries[2].sprint_id.as_deref(),
        Some(planned.id.as_str())
    );
}

#[test]
fn the_digest_keeps_the_newest_entries_within_its_bound() {
    let template = {
        let mut store = store();
        ticket(&mut store, "p1", "Work", None)
    };
    let tickets: Vec<Ticket> = (0..DIGEST_ENTRIES_MAX as u64 + 5)
        .map(|index| Ticket {
            id: format!("t{index}"),
            created_at_epoch_ms: 10 + index,
            updated_at_epoch_ms: 10 + index,
            ..template.clone()
        })
        .collect();
    let digest = digest(
        "p1",
        DigestSource {
            tickets: &tickets,
            sprints: &[],
            versions: &[],
            proposals: &[],
            checks: &[],
            activity: &[],
        },
        0,
        u64::MAX,
    );
    assert!(digest.truncated);
    assert_eq!(digest.entries.len(), DIGEST_ENTRIES_MAX);
    assert_eq!(digest.entries[0].at_epoch_ms, 15);
}
