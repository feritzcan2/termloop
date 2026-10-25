use super::{sprint, store, ticket};
use crate::{
    NewTicket, PmError, TICKET_VERSIONS_MAX, TicketAuthor, TicketEdit, TicketPriority, TicketStatus,
};

const JIRA: &str = "https://acme.atlassian.net/browse/PM-12";

#[test]
fn a_jira_link_is_only_the_exact_secret_free_browse_url() {
    let mut store = store();
    for rejected in [
        "https://user:token@acme.atlassian.net/browse/PM-12",
        "https://acme.atlassian.net/browse/PM-12?jwt=secret",
        "http://acme.atlassian.net/browse/PM-12",
        "https://Acme.atlassian.net/browse/PM-12",
    ] {
        assert!(matches!(
            store.create_ticket(NewTicket {
                jira_url: Some(rejected.into()),
                ..NewTicket::new("p1", "Linked")
            }),
            Err(PmError::Invalid("jiraUrl"))
        ));
    }
    let linked = store
        .create_ticket(NewTicket {
            jira_url: Some(JIRA.into()),
            ..NewTicket::new("p1", "Linked")
        })
        .unwrap();
    assert_eq!(linked.jira_url.as_deref(), Some(JIRA));
    let other = ticket(&mut store, "p1", "Other", None);
    assert!(matches!(
        store.update_ticket(
            &other.id,
            TicketEdit {
                jira_url: Some(Some(format!("{JIRA}#c1"))),
                ..TicketEdit::default()
            }
        ),
        Err(PmError::Invalid("jiraUrl"))
    ));
    // One ticket per Jira issue in a project; another project may track it.
    assert!(matches!(
        store.update_ticket(
            &other.id,
            TicketEdit {
                jira_url: Some(Some(JIRA.into())),
                ..TicketEdit::default()
            }
        ),
        Err(PmError::Constraint(_))
    ));
    assert!(
        store
            .create_ticket(NewTicket {
                jira_url: Some(JIRA.into()),
                ..NewTicket::new("p2", "Mirror")
            })
            .is_ok()
    );
    let unlinked = store
        .update_ticket(
            &linked.id,
            TicketEdit {
                title: Some("Renamed".into()),
                jira_url: Some(None),
            },
        )
        .unwrap();
    assert_eq!(
        (unlinked.title.as_str(), unlinked.jira_url),
        ("Renamed", None)
    );
}

#[test]
fn description_versions_are_appended_never_rewritten() {
    let mut store = store();
    let created = store
        .create_ticket(NewTicket {
            description: "First draft".into(),
            ..NewTicket::new("p1", "Login")
        })
        .unwrap();
    assert_eq!(created.description, "First draft");
    let head = created.versions.clone().unwrap();
    assert_eq!((head.count, head.head_number), (1, 1));
    assert_eq!(head.head_author, TicketAuthor::Pm);

    // Saving the head's text again records nothing.
    assert_eq!(
        store
            .save_ticket_description(&created.id, "First draft", TicketAuthor::Pm, Some(1))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .save_ticket_description(&created.id, "Agent update", TicketAuthor::Agent, Some(1))
            .unwrap(),
        2
    );
    assert!(matches!(
        store.save_ticket_description(&created.id, "Stale edit", TicketAuthor::Pm, Some(1)),
        Err(PmError::Conflict)
    ));
    assert_eq!(
        store
            .save_ticket_description(&created.id, "From Jira", TicketAuthor::Jira, None)
            .unwrap(),
        3
    );
    let versions = store.ticket_versions(&created.id).unwrap();
    assert_eq!(
        versions
            .iter()
            .map(|version| (version.number, version.description.as_str(), version.author))
            .collect::<Vec<_>>(),
        vec![
            (3, "From Jira", TicketAuthor::Jira),
            (2, "Agent update", TicketAuthor::Agent),
            (1, "First draft", TicketAuthor::Pm),
        ]
    );
    assert!(versions.iter().all(|version| version.is_valid()));
    let ticket = store.ticket(&created.id).unwrap().unwrap();
    assert_eq!(ticket.description, "From Jira");
    assert!(ticket.updated_at_epoch_ms >= created.updated_at_epoch_ms);
    assert!(matches!(
        store.save_ticket_description(&created.id, "bell\u{7}", TicketAuthor::Pm, None),
        Err(PmError::Invalid("description"))
    ));
}

#[test]
fn a_ticket_without_description_has_no_version_and_old_versions_are_dropped_whole() {
    let mut store = store();
    let ticket = ticket(&mut store, "p1", "Empty", None);
    assert_eq!((ticket.description.as_str(), ticket.versions), ("", None));
    assert_eq!(
        store
            .save_ticket_description(&ticket.id, "", TicketAuthor::Pm, Some(0))
            .unwrap(),
        0
    );
    for number in 1..=TICKET_VERSIONS_MAX + 2 {
        store
            .save_ticket_description(&ticket.id, &format!("v{number}"), TicketAuthor::Pm, None)
            .unwrap();
    }
    let versions = store.ticket_versions(&ticket.id).unwrap();
    assert_eq!(versions.len(), TICKET_VERSIONS_MAX);
    assert_eq!(versions.last().unwrap().number, 3);
    assert_eq!(versions.last().unwrap().description, "v3");
    let summary = store.ticket(&ticket.id).unwrap().unwrap().versions.unwrap();
    assert_eq!(summary.count, TICKET_VERSIONS_MAX as u64);
    assert_eq!(summary.head_number, TICKET_VERSIONS_MAX as u64 + 2);
}

#[test]
fn status_assignee_and_priority_are_set_by_their_own_commands() {
    let mut store = store();
    let ticket = ticket(&mut store, "p1", "Work", None);
    assert_eq!(
        (ticket.status, ticket.priority, ticket.assignee.clone()),
        (TicketStatus::Todo, TicketPriority::Medium, None)
    );
    let ticket_id = ticket.id.as_str();
    store
        .set_ticket_status(ticket_id, TicketStatus::InReview)
        .unwrap();
    store
        .set_ticket_priority(ticket_id, TicketPriority::Highest)
        .unwrap();
    let assigned = store.set_ticket_assignee(ticket_id, Some("Ada")).unwrap();
    assert_eq!(
        (
            assigned.status,
            assigned.priority,
            assigned.assignee.as_deref()
        ),
        (TicketStatus::InReview, TicketPriority::Highest, Some("Ada"))
    );
    assert!(matches!(
        store.set_ticket_assignee(ticket_id, Some(" Ada")),
        Err(PmError::Invalid("assignee"))
    ));
    assert_eq!(
        store.set_ticket_assignee(ticket_id, None).unwrap().assignee,
        None
    );
    assert!(matches!(
        store.set_ticket_status("missing", TicketStatus::Done),
        Err(PmError::NotFound)
    ));
}

#[test]
fn tickets_join_only_open_sprints_of_their_project() {
    let mut store = store();
    let foreign = sprint(&mut store, "p2", "Other");
    assert!(matches!(
        store.create_ticket(NewTicket {
            sprint_id: Some(foreign.id.clone()),
            ..NewTicket::new("p1", "Misplaced")
        }),
        Err(PmError::Invalid("sprintId"))
    ));
    let local = ticket(&mut store, "p1", "Local", None);
    assert!(matches!(
        store.move_ticket_to_sprint(&local.id, Some(&foreign.id)),
        Err(PmError::Invalid("sprintId"))
    ));
}

#[test]
fn reordering_names_exactly_the_lane() {
    let mut store = store();
    let sprint = sprint(&mut store, "p1", "Sprint 1");
    let a = ticket(&mut store, "p1", "A", Some(&sprint.id));
    let b = ticket(&mut store, "p1", "B", Some(&sprint.id));
    let c = ticket(&mut store, "p1", "C", Some(&sprint.id));
    let backlog = ticket(&mut store, "p1", "Backlog", None);
    assert_eq!(backlog.rank, 0);
    for wrong in [
        vec![a.id.clone(), b.id.clone()],
        vec![a.id.clone(), b.id.clone(), c.id.clone(), backlog.id.clone()],
        vec![a.id.clone(), a.id.clone(), b.id.clone()],
    ] {
        assert!(matches!(
            store.reorder_tickets("p1", Some(&sprint.id), &wrong),
            Err(PmError::Invalid("orderedTicketIds"))
        ));
    }
    store
        .reorder_tickets(
            "p1",
            Some(&sprint.id),
            &[c.id.clone(), a.id.clone(), b.id.clone()],
        )
        .unwrap();
    let titles = store
        .board("p1")
        .unwrap()
        .tickets
        .into_iter()
        .map(|ticket| ticket.title)
        .collect::<Vec<_>>();
    assert_eq!(titles, ["C", "A", "B", "Backlog"]);
}

#[test]
fn blockers_and_acceptance_criteria_are_ordered_items_of_one_ticket() {
    let mut store = store();
    let ticket = ticket(&mut store, "p1", "Work", None);
    let other = super::ticket(&mut store, "p1", "Other", None);
    let api = store
        .add_ticket_blocker(&ticket.id, "Waiting on API keys")
        .unwrap();
    store
        .add_ticket_blocker(&ticket.id, "Design review")
        .unwrap();
    assert!(matches!(
        store.add_ticket_blocker(&ticket.id, ""),
        Err(PmError::Invalid("text"))
    ));
    assert!(matches!(
        store.remove_ticket_blocker(&other.id, &api.id),
        Err(PmError::NotFound)
    ));
    let after = store.remove_ticket_blocker(&ticket.id, &api.id).unwrap();
    assert_eq!(
        after
            .blockers
            .iter()
            .map(|blocker| blocker.text.as_str())
            .collect::<Vec<_>>(),
        ["Design review"]
    );

    let login = store
        .add_acceptance_criterion(&ticket.id, "User can log in")
        .unwrap();
    let logout = store
        .add_acceptance_criterion(&ticket.id, "User can log out")
        .unwrap();
    assert!(!login.done);
    let checked = store
        .set_acceptance_criterion_done(&ticket.id, &login.id, true)
        .unwrap();
    assert_eq!(
        checked
            .acceptance_criteria
            .iter()
            .map(|criterion| (criterion.text.as_str(), criterion.done))
            .collect::<Vec<_>>(),
        [("User can log in", true), ("User can log out", false)]
    );
    // Setting the state it already has is a no-op.
    assert_eq!(
        store
            .set_acceptance_criterion_done(&ticket.id, &login.id, true)
            .unwrap(),
        checked
    );
    assert!(matches!(
        store.set_acceptance_criterion_done(&other.id, &login.id, false),
        Err(PmError::NotFound)
    ));
    let removed = store
        .remove_acceptance_criterion(&ticket.id, &logout.id)
        .unwrap();
    assert_eq!(removed.acceptance_criteria.len(), 1);
}

#[test]
fn the_board_serializes_with_camel_case_fields() {
    let mut store = store();
    let sprint = sprint(&mut store, "p1", "Sprint 1");
    store
        .create_ticket(NewTicket {
            description: "Text".into(),
            sprint_id: Some(sprint.id),
            ..NewTicket::new("p1", "Work")
        })
        .unwrap();
    let board = serde_json::to_value(store.board("p1").unwrap()).unwrap();
    assert_eq!(board["projectId"], "p1");
    assert_eq!(board["sprints"][0]["state"], "planned");
    let ticket = &board["tickets"][0];
    assert_eq!(ticket["status"], "todo");
    assert_eq!(ticket["carryOverCount"], 0);
    assert_eq!(ticket["versions"]["headAuthor"], "pm");
    assert!(board["tickets"].as_array().unwrap().len() == 1);
    assert!(store.board("p2").unwrap().tickets.is_empty());
}
