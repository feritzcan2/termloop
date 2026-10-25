use super::{sprint, store, ticket};
use crate::{PmError, SprintState, TicketStatus};

#[test]
fn a_project_has_at_most_one_active_sprint() {
    let mut store = store();
    let first = sprint(&mut store, "p1", "Sprint 1");
    let second = sprint(&mut store, "p1", "Sprint 2");
    let elsewhere = sprint(&mut store, "p2", "Other");
    let active = store.activate_sprint(&first.id).unwrap();
    assert_eq!(active.state, SprintState::Active);
    assert!(active.activated_at_epoch_ms.is_some());
    assert!(matches!(
        store.activate_sprint(&second.id),
        Err(PmError::Constraint("another sprint is already active"))
    ));
    assert_eq!(store.activate_sprint(&first.id).unwrap(), active);
    store.activate_sprint(&elsewhere.id).unwrap();
    // The schema itself refuses a second active sprint.
    assert!(
        store
            .connection()
            .execute(
                "UPDATE sprints SET state = 'active' WHERE id = ?1",
                [&second.id]
            )
            .is_err()
    );
    store.close_sprint(&first.id, None).unwrap();
    assert_eq!(
        store.activate_sprint(&second.id).unwrap().state,
        SprintState::Active
    );
}

#[test]
fn sprints_start_in_the_backlog_or_planned_and_only_move_forward() {
    let mut store = store();
    for state in [SprintState::Active, SprintState::Closed] {
        assert!(matches!(
            store.create_sprint("p1", "Sprint", None, state),
            Err(PmError::Invalid("state"))
        ));
    }
    let idea = store
        .create_sprint("p1", "Later", Some("Polish"), SprintState::Backlog)
        .unwrap();
    assert_eq!(idea.goal.as_deref(), Some("Polish"));
    assert_eq!(
        store.plan_sprint(&idea.id).unwrap().state,
        SprintState::Planned
    );
    store.activate_sprint(&idea.id).unwrap();
    assert!(matches!(
        store.plan_sprint(&idea.id),
        Err(PmError::Constraint(_))
    ));
}

#[test]
fn sprints_are_renamed_and_given_goals_until_they_close() {
    let mut store = store();
    let sprint = sprint(&mut store, "p1", "Sprint 1");
    assert_eq!(
        store.rename_sprint(&sprint.id, "Sprint One").unwrap().name,
        "Sprint One"
    );
    assert!(matches!(
        store.rename_sprint(&sprint.id, " padded"),
        Err(PmError::Invalid("name"))
    ));
    let goal = "Ship login\nand signup";
    assert_eq!(
        store
            .set_sprint_goal(&sprint.id, Some(goal))
            .unwrap()
            .goal
            .as_deref(),
        Some(goal)
    );
    assert_eq!(store.set_sprint_goal(&sprint.id, None).unwrap().goal, None);
    assert!(matches!(
        store.set_sprint_goal(&sprint.id, Some("  ")),
        Err(PmError::Invalid("goal"))
    ));
    let closed = store.close_sprint(&sprint.id, None).unwrap().sprint;
    assert_eq!(closed.state, SprintState::Closed);
    assert!(closed.closed_at_epoch_ms.is_some());
    assert!(matches!(
        store.rename_sprint(&sprint.id, "Again"),
        Err(PmError::Constraint("the sprint is closed"))
    ));
    assert!(matches!(
        store.close_sprint(&sprint.id, None),
        Err(PmError::Constraint("the sprint is closed"))
    ));
}

#[test]
fn closing_a_sprint_carries_unfinished_tickets_over_and_counts_it() {
    let mut store = store();
    let current = sprint(&mut store, "p1", "Sprint 1");
    let next = sprint(&mut store, "p1", "Sprint 2");
    store.activate_sprint(&current.id).unwrap();
    let todo = ticket(&mut store, "p1", "Todo", Some(&current.id));
    let done = ticket(&mut store, "p1", "Done", Some(&current.id));
    let doing = ticket(&mut store, "p1", "Doing", Some(&current.id));
    let queued = ticket(&mut store, "p1", "Queued", Some(&next.id));
    store
        .set_ticket_status(&done.id, TicketStatus::Done)
        .unwrap();
    store
        .set_ticket_status(&doing.id, TicketStatus::InProgress)
        .unwrap();

    let closed = store.close_sprint(&current.id, Some(&next.id)).unwrap();
    assert_eq!(
        closed.carried_over_ticket_ids,
        vec![todo.id.clone(), doing.id.clone()]
    );
    let board = store.board("p1").unwrap();
    let lane = |sprint_id: &str| {
        board
            .tickets
            .iter()
            .filter(|ticket| ticket.sprint_id.as_deref() == Some(sprint_id))
            .map(|ticket| (ticket.title.as_str(), ticket.rank, ticket.carry_over_count))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        lane(&next.id),
        vec![("Queued", 0, 0), ("Todo", 1, 1), ("Doing", 2, 1)]
    );
    assert_eq!(lane(&current.id), vec![("Done", 1, 0)]);

    store.activate_sprint(&next.id).unwrap();
    let closed = store.close_sprint(&next.id, None).unwrap();
    assert_eq!(closed.carried_over_ticket_ids.len(), 3);
    let todo = store.ticket(&todo.id).unwrap().unwrap();
    assert_eq!((todo.sprint_id, todo.carry_over_count), (None, 2));
    assert_eq!(
        store.ticket(&queued.id).unwrap().unwrap().carry_over_count,
        1
    );
}

#[test]
fn carry_over_needs_another_open_sprint_of_the_same_project() {
    let mut store = store();
    let current = sprint(&mut store, "p1", "Sprint 1");
    let closed = sprint(&mut store, "p1", "Old");
    let foreign = sprint(&mut store, "p2", "Other");
    store.close_sprint(&closed.id, None).unwrap();
    let todo = ticket(&mut store, "p1", "Todo", Some(&current.id));
    assert!(matches!(
        store.close_sprint(&current.id, Some(&current.id)),
        Err(PmError::Invalid("carryOverTo"))
    ));
    assert!(matches!(
        store.close_sprint(&current.id, Some(&foreign.id)),
        Err(PmError::Invalid("carryOverTo"))
    ));
    assert!(matches!(
        store.close_sprint(&current.id, Some(&closed.id)),
        Err(PmError::Constraint("the sprint is closed"))
    ));
    assert!(matches!(
        store.close_sprint(&current.id, Some("missing")),
        Err(PmError::NotFound)
    ));
    // A refused close leaves everything as it was.
    let unchanged = store.ticket(&todo.id).unwrap().unwrap();
    assert_eq!(unchanged.sprint_id.as_deref(), Some(current.id.as_str()));
    assert_eq!(unchanged.carry_over_count, 0);
    assert_eq!(
        store.sprint(&current.id).unwrap().unwrap().state,
        SprintState::Planned
    );
}

#[test]
fn moving_a_ticket_out_of_a_closed_sprint_counts_a_carry_over() {
    let mut store = store();
    let closing = sprint(&mut store, "p1", "Sprint 1");
    let next = sprint(&mut store, "p1", "Sprint 2");
    let reopened = ticket(&mut store, "p1", "Reopened", Some(&closing.id));
    let moved = ticket(&mut store, "p1", "Moved", Some(&next.id));
    store
        .set_ticket_status(&reopened.id, TicketStatus::Done)
        .unwrap();
    store.close_sprint(&closing.id, None).unwrap();
    store
        .set_ticket_status(&reopened.id, TicketStatus::Todo)
        .unwrap();
    let carried = store
        .move_ticket_to_sprint(&reopened.id, Some(&next.id))
        .unwrap();
    assert_eq!(carried.carry_over_count, 1);
    assert_eq!(carried.rank, 1);
    assert!(matches!(
        store.move_ticket_to_sprint(&moved.id, Some(&closing.id)),
        Err(PmError::Constraint("the sprint is closed"))
    ));
    // Leaving an open sprint is rescoping, not a carry-over.
    let backlog = store.move_ticket_to_sprint(&moved.id, None).unwrap();
    assert_eq!((backlog.sprint_id, backlog.carry_over_count), (None, 0));
}

#[test]
fn invalid_ids_are_rejected_before_any_lookup() {
    let mut store = store();
    assert!(matches!(
        store.create_sprint("", "Sprint", None, SprintState::Planned),
        Err(PmError::Invalid("projectId"))
    ));
    assert!(matches!(
        store.activate_sprint("bad id"),
        Err(PmError::Invalid("sprintId"))
    ));
    assert!(matches!(
        store.activate_sprint("missing"),
        Err(PmError::NotFound)
    ));
    assert!(matches!(
        store.sprint("\n"),
        Err(PmError::Invalid("sprintId"))
    ));
}
