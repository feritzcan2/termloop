use super::{sprint, store, ticket};
use crate::{
    AssistantConversation, BreakdownTask, EpicDraft, EpicEdit, PROJECT_BREAKDOWNS_MAX, PmError,
    TicketAuthor,
};

fn task(title: &str, criteria: &[&str]) -> BreakdownTask {
    BreakdownTask {
        title: title.to_owned(),
        description: format!("Build the {title}."),
        acceptance_criteria: criteria.iter().map(|text| (*text).to_owned()).collect(),
    }
}

fn draft(title: &str) -> Option<EpicDraft> {
    Some(EpicDraft {
        title: title.to_owned(),
        description: "Customers pay in one step.".to_owned(),
    })
}

#[test]
fn an_epic_is_edited_and_its_deletion_keeps_its_tickets() {
    let mut store = store();
    let epic = store.create_epic("p1", "Checkout", "").unwrap();
    let work = ticket(&mut store, "p1", "Cart", None);
    let tagged = store.set_ticket_epic(&work.id, Some(&epic.id)).unwrap();
    assert_eq!(tagged.epic_id.as_deref(), Some(epic.id.as_str()));
    let renamed = store
        .update_epic(
            &epic.id,
            EpicEdit {
                title: Some("One-step checkout".into()),
                description: None,
            },
        )
        .unwrap();
    assert_eq!(renamed.title, "One-step checkout");
    assert_eq!(store.board("p1").unwrap().epics, vec![renamed]);
    assert!(matches!(
        store.create_epic("p1", " padded", ""),
        Err(PmError::Invalid("title"))
    ));

    store.delete_epic(&epic.id).unwrap();
    assert!(store.epics("p1").unwrap().is_empty());
    assert_eq!(store.ticket(&work.id).unwrap().unwrap().epic_id, None);
}

#[test]
fn a_ticket_joins_only_an_epic_of_its_project() {
    let mut store = store();
    let other = store.create_epic("p2", "Search", "").unwrap();
    let work = ticket(&mut store, "p1", "Cart", None);
    assert!(matches!(
        store.set_ticket_epic(&work.id, Some(&other.id)),
        Err(PmError::Invalid("epicId"))
    ));
    assert!(matches!(
        store.set_ticket_epic(&work.id, Some("missing")),
        Err(PmError::NotFound)
    ));
}

#[test]
fn accepting_a_breakdown_creates_its_epic_and_the_kept_tickets() {
    let mut store = store();
    let lane = sprint(&mut store, "p1", "Sprint 1");
    let breakdown = store
        .propose_epic_breakdown(
            "p1",
            None,
            draft("Checkout"),
            vec![
                task("API", &["Returns 201"]),
                task("UI", &["Shows total", "Disables twice-click"]),
                task("Docs", &[]),
            ],
            "Split by layer.".into(),
        )
        .unwrap();
    assert_eq!(
        store.board("p1").unwrap().epic_breakdowns,
        vec![breakdown.clone()]
    );
    // Nothing changed before the PM accepts.
    assert!(store.epics("p1").unwrap().is_empty());

    let accepted = store
        .accept_epic_breakdown(&breakdown.id, &[1, 0], Some(&lane.id))
        .unwrap();
    assert_eq!(accepted.epic.title, "Checkout");
    let titles: Vec<_> = accepted.tickets.iter().map(|t| t.title.as_str()).collect();
    assert_eq!(titles, ["UI", "API"]);
    let ui = &accepted.tickets[0];
    assert_eq!(ui.epic_id.as_deref(), Some(accepted.epic.id.as_str()));
    assert_eq!(ui.sprint_id.as_deref(), Some(lane.id.as_str()));
    assert_eq!(ui.description, "Build the UI.");
    assert_eq!(
        ui.versions.as_ref().unwrap().head_author,
        TicketAuthor::Agent
    );
    let criteria: Vec<_> = ui
        .acceptance_criteria
        .iter()
        .map(|c| c.text.as_str())
        .collect();
    assert_eq!(criteria, ["Shows total", "Disables twice-click"]);
    let board = store.board("p1").unwrap();
    assert!(board.epic_breakdowns.is_empty());
    assert_eq!(board.epics, vec![accepted.epic]);
    assert!(matches!(
        store.accept_epic_breakdown(&breakdown.id, &[0], None),
        Err(PmError::NotFound)
    ));
}

#[test]
fn a_breakdown_for_an_existing_epic_adds_to_it() {
    let mut store = store();
    let epic = store.create_epic("p1", "Checkout", "").unwrap();
    let breakdown = store
        .propose_epic_breakdown(
            "p1",
            Some(&epic.id),
            None,
            vec![task("API", &[])],
            "One.".into(),
        )
        .unwrap();
    for bad in [&[][..], &[0, 0], &[3]] {
        assert!(matches!(
            store.accept_epic_breakdown(&breakdown.id, bad, None),
            Err(PmError::Invalid("taskIndices"))
        ));
    }
    let accepted = store
        .accept_epic_breakdown(&breakdown.id, &[0], None)
        .unwrap();
    assert_eq!(accepted.epic, epic);
    assert_eq!(accepted.tickets[0].sprint_id, None);
    assert_eq!(store.epics("p1").unwrap().len(), 1);
}

#[test]
fn breakdowns_are_checked_and_bounded_and_can_be_rejected() {
    let mut store = store();
    let other = store.create_epic("p2", "Search", "").unwrap();
    assert!(matches!(
        store.propose_epic_breakdown(
            "p1",
            Some(&other.id),
            None,
            vec![task("A", &[])],
            "S".into()
        ),
        Err(PmError::Invalid("epicId"))
    ));
    assert!(matches!(
        store.propose_epic_breakdown("p1", None, None, vec![task("A", &[])], "S".into()),
        Err(PmError::Invalid("epic"))
    ));
    assert!(matches!(
        store.propose_epic_breakdown("p1", None, draft("E"), Vec::new(), "S".into()),
        Err(PmError::Invalid("tasks"))
    ));
    let mut ids = Vec::new();
    for index in 0..PROJECT_BREAKDOWNS_MAX {
        let breakdown = store
            .propose_epic_breakdown(
                "p1",
                None,
                draft(&format!("Epic {index}")),
                vec![task("A", &[])],
                "S".into(),
            )
            .unwrap();
        ids.push(breakdown.id);
    }
    assert!(matches!(
        store.propose_epic_breakdown(
            "p1",
            None,
            draft("One more"),
            vec![task("A", &[])],
            "S".into()
        ),
        Err(PmError::Constraint(_))
    ));
    store.reject_epic_breakdown(&ids[0]).unwrap();
    assert_eq!(
        store.epic_breakdowns("p1").unwrap().len(),
        PROJECT_BREAKDOWNS_MAX - 1
    );
    assert!(store.epics("p1").unwrap().is_empty());
    assert!(matches!(
        store.reject_epic_breakdown(&ids[0]),
        Err(PmError::NotFound)
    ));
}

#[test]
fn the_assistant_conversation_is_remembered_replaced_and_forgotten() {
    let mut store = store();
    assert_eq!(store.assistant_conversation("p1").unwrap(), None);
    let mut conversation = AssistantConversation {
        project_id: "p1".into(),
        provider: "claude".into(),
        conversation_id: "11111111-1111-4111-8111-111111111111".into(),
        cwd: "/work".into(),
        started_at_epoch_ms: 5,
    };
    store
        .remember_assistant_conversation(&conversation)
        .unwrap();
    conversation.conversation_id = "22222222-2222-4222-8222-222222222222".into();
    store
        .remember_assistant_conversation(&conversation)
        .unwrap();
    assert_eq!(
        store.assistant_conversation("p1").unwrap(),
        Some(conversation.clone())
    );
    conversation.cwd = String::new();
    assert!(matches!(
        store.remember_assistant_conversation(&conversation),
        Err(PmError::Invalid("conversation"))
    ));
    store.forget_assistant_conversation("p1").unwrap();
    assert_eq!(store.assistant_conversation("p1").unwrap(), None);
}
