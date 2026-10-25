use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use termloop_providers::{
    JiraCredential, JiraIssueSnapshot, JiraIssueText, JiraIssueWriter, JiraSearchError,
    JiraSearchResult, JiraSprint, JiraSprintListResult, JiraSprintSource, JiraSprintState,
    JiraTransition, JiraWriteError,
};

use super::{sprint, store, ticket};
use crate::{
    JiraChange, JiraPullOutcome, JiraSource, JiraSprintRead, JiraWriteOutcome, NewTicket, PmError,
    PmStore, ProjectSources, SprintState, TicketStatus, apply_jira_write, read_jira_issue_state,
    read_jira_sprints,
};

const SITE: &str = "https://acme.atlassian.net";
const CREDENTIAL: JiraCredential<'static> = JiraCredential {
    email: "ada@acme.example",
    api_token: "token",
};

fn connect(store: &mut PmStore, board_id: Option<u64>) {
    store
        .set_project_sources(
            "p1",
            &ProjectSources {
                jira: Some(JiraSource {
                    site_url: SITE.into(),
                    board_id,
                    account_email: "ada@acme.example".into(),
                    credential_handle: "jira-acme".into(),
                }),
                github: None,
            },
        )
        .unwrap();
}

fn jira_sprint(id: u64, name: &str, state: JiraSprintState) -> JiraSprint {
    JiraSprint {
        id,
        board_id: 7,
        name: name.into(),
        state,
        start_epoch_ms: None,
        end_epoch_ms: Some(9_000),
    }
}

fn issue(key: &str, summary: &str) -> JiraIssueSnapshot {
    JiraIssueSnapshot {
        external_id: "10001".into(),
        key: key.into(),
        url: format!("{SITE}/browse/{key}"),
        summary: summary.into(),
        description: Some("h2. Goal".into()),
        status_name: "In Progress".into(),
        status_category: Some("indeterminate".into()),
        assignee_display: Some("Ada".into()),
        updated_at: "2026-10-20T10:00:00.000+0000".into(),
    }
}

fn read(sprints: Vec<JiraSprint>, issues: Option<Vec<JiraIssueSnapshot>>) -> JiraSprintRead {
    JiraSprintRead {
        sprints: JiraSprintListResult::Sprints {
            sprints,
            truncated: false,
        },
        active_issues: issues.map(|issues| JiraSearchResult {
            issues,
            truncated: false,
        }),
    }
}

fn pull(store: &mut PmStore, read: JiraSprintRead) -> JiraPullOutcome {
    let plan = store.plan_jira_sprint_pull("p1").unwrap().unwrap();
    store.apply_jira_sprint_pull(&plan, Ok(read)).unwrap()
}

#[test]
fn a_board_pull_mirrors_sprints_and_the_active_sprints_issues() {
    let mut store = store();
    assert_eq!(store.plan_jira_sprint_pull("p1").unwrap(), None);
    connect(&mut store, None);
    assert_eq!(store.plan_jira_sprint_pull("p1").unwrap(), None);
    connect(&mut store, Some(7));
    let local = sprint(&mut store, "p1", "Local");
    store.activate_sprint(&local.id).unwrap();
    let linked = store
        .create_ticket(NewTicket {
            jira_url: Some(format!("{SITE}/browse/PAY-1")),
            ..NewTicket::new("p1", "Linked")
        })
        .unwrap();
    let mine = ticket(&mut store, "p1", "Mine", Some(&local.id));

    let JiraPullOutcome::Applied(changes) = pull(
        &mut store,
        read(
            vec![
                jira_sprint(11, "Sprint 11", JiraSprintState::Active),
                jira_sprint(12, " ", JiraSprintState::Future),
            ],
            Some(vec![issue("PAY-1", "Linked"), issue("PAY-2", "New issue")]),
        ),
    ) else {
        panic!("applied");
    };
    assert_eq!(changes.sprints_created.len(), 2);
    assert_eq!(changes.tickets_created.len(), 1);
    assert_eq!(changes.tickets_moved, vec![linked.id.clone()]);
    let board = store.board("p1").unwrap();
    let mirrored = board
        .sprints
        .iter()
        .find(|sprint| sprint.jira_sprint_id == Some(11))
        .unwrap();
    assert_eq!(mirrored.state, SprintState::Active);
    assert_eq!(mirrored.ends_at_epoch_ms, Some(9_000));
    let future = board
        .sprints
        .iter()
        .find(|sprint| sprint.jira_sprint_id == Some(12))
        .unwrap();
    assert_eq!(
        (future.name.as_str(), future.state),
        ("Sprint 12", SprintState::Planned)
    );
    // Jira's active sprint is the only active one; local work stays put.
    let local_now = board
        .sprints
        .iter()
        .find(|sprint| sprint.id == local.id)
        .unwrap();
    assert_eq!(local_now.state, SprintState::Planned);
    let mine_now = board
        .tickets
        .iter()
        .find(|ticket| ticket.id == mine.id)
        .unwrap();
    assert_eq!(mine_now.sprint_id.as_deref(), Some(local.id.as_str()));
    let created = board
        .tickets
        .iter()
        .find(|ticket| ticket.id == changes.tickets_created[0])
        .unwrap();
    assert_eq!(created.title, "New issue");
    assert_eq!(created.description, "h2. Goal");
    assert_eq!(created.status, TicketStatus::InProgress);
    assert_eq!(created.assignee.as_deref(), Some("Ada"));
    assert_eq!(created.jira_issue_key().as_deref(), Some("PAY-2"));
    assert_eq!(created.jira_sprint_id, Some(11));
    assert_eq!(created.sprint_id.as_deref(), Some(mirrored.id.as_str()));

    // The same read again changes nothing but the pull times.
    let JiraPullOutcome::Applied(again) = pull(
        &mut store,
        read(
            vec![
                jira_sprint(11, "Sprint 11", JiraSprintState::Active),
                jira_sprint(12, " ", JiraSprintState::Future),
            ],
            Some(vec![issue("PAY-1", "Linked"), issue("PAY-2", "New issue")]),
        ),
    ) else {
        panic!("applied");
    };
    assert_eq!(again, Default::default());

    // PAY-1 left the sprint, and sprint 11 closed: PAY-2 is carried over.
    let JiraPullOutcome::Applied(changes) = pull(
        &mut store,
        read(
            vec![jira_sprint(12, "Sprint 12", JiraSprintState::Active)],
            Some(vec![issue("PAY-2", "New issue")]),
        ),
    ) else {
        panic!("applied");
    };
    assert_eq!(changes.sprints_closed, vec![mirrored.id.clone()]);
    let board = store.board("p1").unwrap();
    let pay_2 = board
        .tickets
        .iter()
        .find(|ticket| ticket.jira_issue_key().as_deref() == Some("PAY-2"))
        .unwrap();
    assert_eq!(pay_2.sprint_id.as_deref(), Some(future.id.as_str()));
    assert_eq!(pay_2.carry_over_count, 1);
    assert_eq!(pay_2.jira_sprint_id, Some(12));
    let pay_1 = board
        .tickets
        .iter()
        .find(|ticket| ticket.id == linked.id)
        .unwrap();
    assert_eq!(
        (pay_1.sprint_id.as_deref(), pay_1.carry_over_count),
        (None, 1)
    );
}

#[test]
fn a_failed_stale_or_unsupported_pull_changes_nothing() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    connect(&mut store, Some(7));
    let old_plan = store.plan_jira_sprint_pull("p1").unwrap().unwrap();
    let before = store.board("p1").unwrap();
    assert_eq!(
        store
            .apply_jira_sprint_pull(&old_plan, Err(JiraSearchError::Unauthorized))
            .unwrap(),
        JiraPullOutcome::Failed(JiraSearchError::Unauthorized)
    );
    assert_eq!(
        store
            .apply_jira_sprint_pull(
                &old_plan,
                Ok(JiraSprintRead {
                    sprints: JiraSprintListResult::SprintsUnsupported,
                    active_issues: None,
                })
            )
            .unwrap(),
        JiraPullOutcome::SprintsUnsupported
    );
    assert_eq!(store.board("p1").unwrap(), before);

    NOW.store(2_000, Ordering::SeqCst);
    assert!(matches!(
        pull(
            &mut store,
            read(vec![jira_sprint(11, "S", JiraSprintState::Active)], None)
        ),
        JiraPullOutcome::Applied(_)
    ));
    let after = store.board("p1").unwrap();
    // A read planned before the applied one is older than what is shown.
    assert_eq!(
        store
            .apply_jira_sprint_pull(
                &old_plan,
                Ok(read(
                    vec![jira_sprint(13, "S", JiraSprintState::Active)],
                    None
                ))
            )
            .unwrap(),
        JiraPullOutcome::Stale
    );
    // So is one planned against another board.
    let plan = store.plan_jira_sprint_pull("p1").unwrap().unwrap();
    connect(&mut store, Some(8));
    assert_eq!(
        store
            .apply_jira_sprint_pull(
                &plan,
                Ok(read(
                    vec![jira_sprint(13, "S", JiraSprintState::Active)],
                    None
                ))
            )
            .unwrap(),
        JiraPullOutcome::Stale
    );
    assert_eq!(store.board("p1").unwrap().sprints, after.sprints);
}

/// A Jira double that records every call.
struct FakeJira {
    sprints: Vec<JiraSprint>,
    issue: Mutex<JiraIssueText>,
    transitions: Vec<JiraTransition>,
    calls: Mutex<Vec<String>>,
    fail_writes: bool,
}

impl FakeJira {
    fn new() -> Self {
        Self {
            sprints: vec![jira_sprint(11, "Sprint 11", JiraSprintState::Active)],
            issue: Mutex::new(JiraIssueText {
                key: "PAY-1".into(),
                summary: "Old title".into(),
                description: Some("Old".into()),
                status_name: Some("To Do".into()),
                status_category: Some("new".into()),
                updated: "u1".into(),
            }),
            transitions: vec![JiraTransition {
                id: "31".into(),
                name: "Start".into(),
                to_status: "In Progress".into(),
                to_status_category: Some("indeterminate".into()),
            }],
            calls: Mutex::new(Vec::new()),
            fail_writes: false,
        }
    }

    fn call(&self, site: &str, call: String) {
        assert_eq!(site, SITE);
        self.calls.lock().unwrap().push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn write_result(&self) -> Result<(), JiraWriteError> {
        if self.fail_writes {
            Err(JiraWriteError::Forbidden)
        } else {
            Ok(())
        }
    }
}

impl JiraSprintSource for FakeJira {
    fn list_sprints(
        &self,
        site: &str,
        _: JiraCredential<'_>,
        board_id: u64,
    ) -> Result<JiraSprintListResult, JiraSearchError> {
        self.call(site, format!("sprints {board_id}"));
        Ok(JiraSprintListResult::Sprints {
            sprints: self.sprints.clone(),
            truncated: false,
        })
    }

    fn sprint_issues(
        &self,
        site: &str,
        _: JiraCredential<'_>,
        sprint_id: u64,
    ) -> Result<JiraSearchResult, JiraSearchError> {
        self.call(site, format!("issues {sprint_id}"));
        Ok(JiraSearchResult {
            issues: vec![issue("PAY-1", "Old title")],
            truncated: false,
        })
    }
}

impl JiraIssueWriter for FakeJira {
    fn read_issue(
        &self,
        site: &str,
        _: JiraCredential<'_>,
        key: &str,
    ) -> Result<JiraIssueText, JiraWriteError> {
        self.call(site, format!("read {key}"));
        Ok(self.issue.lock().unwrap().clone())
    }

    fn update_issue(
        &self,
        site: &str,
        _: JiraCredential<'_>,
        key: &str,
        summary: &str,
        description: &str,
    ) -> Result<(), JiraWriteError> {
        self.call(site, format!("update {key} {summary} | {description}"));
        self.write_result()
    }

    fn move_issue(
        &self,
        site: &str,
        _: JiraCredential<'_>,
        key: &str,
        sprint_id: Option<u64>,
    ) -> Result<(), JiraWriteError> {
        self.call(site, format!("move {key} {sprint_id:?}"));
        self.write_result()
    }

    fn transitions(
        &self,
        site: &str,
        _: JiraCredential<'_>,
        key: &str,
    ) -> Result<Vec<JiraTransition>, JiraWriteError> {
        self.call(site, format!("transitions {key}"));
        Ok(self.transitions.clone())
    }

    fn transition_issue(
        &self,
        site: &str,
        _: JiraCredential<'_>,
        key: &str,
        transition_id: &str,
    ) -> Result<(), JiraWriteError> {
        self.call(site, format!("transition {key} {transition_id}"));
        self.write_result()
    }
}

/// A store whose linked PAY-1 ticket a pull put in mirrored sprint 11.
fn pulled_store(jira: &FakeJira) -> (PmStore, String) {
    let mut store = store();
    connect(&mut store, Some(7));
    let plan = store.plan_jira_sprint_pull("p1").unwrap().unwrap();
    let read = read_jira_sprints(jira, &plan, CREDENTIAL);
    store.apply_jira_sprint_pull(&plan, read).unwrap();
    let ticket_id = store.board("p1").unwrap().tickets[0].id.clone();
    (store, ticket_id)
}

#[test]
fn a_reviewed_diff_is_written_and_nothing_else() {
    let jira = FakeJira::new();
    let (mut store, ticket_id) = pulled_store(&jira);
    assert_eq!(jira.calls(), vec!["sprints 7", "issues 11"]);
    store
        .update_ticket(
            &ticket_id,
            crate::TicketEdit {
                title: Some("New title".into()),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .save_ticket_description(&ticket_id, "## Goal", crate::TicketAuthor::Pm, None)
        .unwrap();
    store
        .set_ticket_status(&ticket_id, TicketStatus::InReview)
        .unwrap();
    store.move_ticket_to_sprint(&ticket_id, None).unwrap();

    let target = store.jira_write_target(&ticket_id).unwrap();
    assert_eq!(target.issue_key, "PAY-1");
    assert_eq!(target.credential_handle, "jira-acme");
    let state = read_jira_issue_state(&jira, &target, CREDENTIAL).unwrap();
    let diff = store.jira_write_diff(&ticket_id, &state).unwrap();
    assert_eq!(
        diff.changes,
        vec![
            JiraChange::Summary {
                jira: "Old title".into(),
                ticket: "New title".into()
            },
            JiraChange::Description {
                jira: Some("Old".into()),
                ticket: "h2. Goal".into()
            },
            JiraChange::Status {
                jira: Some("To Do".into()),
                to_status: "In Progress".into(),
                transition_id: "31".into(),
                transition_name: "Start".into()
            },
            JiraChange::Sprint {
                jira_sprint_id: Some(11),
                ticket_sprint_id: None
            },
        ]
    );
    assert_eq!(diff.token.len(), 64);
    assert_eq!(store.jira_write_diff(&ticket_id, &state).unwrap(), diff);

    // A wrong token writes nothing.
    jira.calls.lock().unwrap().clear();
    let outcome =
        apply_jira_write(&mut store, &jira, CREDENTIAL, &ticket_id, &"0".repeat(64)).unwrap();
    assert_eq!(outcome, JiraWriteOutcome::Stale(diff.clone()));
    assert_eq!(jira.calls(), vec!["read PAY-1", "transitions PAY-1"]);

    // Jira changed after the review: refused.
    jira.issue.lock().unwrap().updated = "u2".into();
    jira.calls.lock().unwrap().clear();
    let JiraWriteOutcome::Stale(current) =
        apply_jira_write(&mut store, &jira, CREDENTIAL, &ticket_id, &diff.token).unwrap()
    else {
        panic!("stale");
    };
    assert_ne!(current.token, diff.token);
    assert_eq!(jira.calls(), vec!["read PAY-1", "transitions PAY-1"]);

    jira.calls.lock().unwrap().clear();
    let outcome =
        apply_jira_write(&mut store, &jira, CREDENTIAL, &ticket_id, &current.token).unwrap();
    assert_eq!(outcome, JiraWriteOutcome::Applied(current.changes.clone()));
    assert_eq!(
        jira.calls(),
        vec![
            "read PAY-1",
            "transitions PAY-1",
            "update PAY-1 New title | h2. Goal",
            "transition PAY-1 31",
            "move PAY-1 None",
        ]
    );
    let ticket = store.board("p1").unwrap().tickets[0].clone();
    assert_eq!(ticket.jira_sprint_id, None);
}

#[test]
fn a_failed_write_reports_what_jira_accepted_first() {
    let mut jira = FakeJira::new();
    let (mut store, ticket_id) = pulled_store(&jira);
    store
        .set_ticket_status(&ticket_id, TicketStatus::Done)
        .unwrap();
    let target = store.jira_write_target(&ticket_id).unwrap();
    let state = read_jira_issue_state(&jira, &target, CREDENTIAL).unwrap();
    let diff = store.jira_write_diff(&ticket_id, &state).unwrap();
    // No transition reaches done; the status is reported, not written.
    assert!(diff.status_unreachable);
    assert!(matches!(diff.changes[..], [JiraChange::Description { .. }]));
    jira.fail_writes = true;
    let outcome = apply_jira_write(&mut store, &jira, CREDENTIAL, &ticket_id, &diff.token).unwrap();
    assert_eq!(
        outcome,
        JiraWriteOutcome::Failed {
            applied: vec![],
            error: JiraWriteError::Forbidden
        }
    );
}

#[test]
fn the_credential_goes_only_to_the_issues_own_site() {
    let mut store = store();
    connect(&mut store, None);
    let local = ticket(&mut store, "p1", "Local", None);
    assert!(matches!(
        store.jira_write_target(&local.id),
        Err(PmError::Constraint(_))
    ));
    let elsewhere = store
        .create_ticket(NewTicket {
            jira_url: Some("https://other.atlassian.net/browse/PAY-9".into()),
            ..NewTicket::new("p1", "Elsewhere")
        })
        .unwrap();
    assert!(matches!(
        store.jira_write_target(&elsewhere.id),
        Err(PmError::Constraint(_))
    ));
    let on_site = store
        .create_ticket(NewTicket {
            jira_url: Some(format!("{SITE}/browse/PAY-9")),
            ..NewTicket::new("p1", "On site")
        })
        .unwrap();
    assert_eq!(store.jira_write_target(&on_site.id).unwrap().site_url, SITE);
    store
        .set_project_sources("p1", &ProjectSources::default())
        .unwrap();
    assert!(matches!(
        store.jira_write_target(&on_site.id),
        Err(PmError::Constraint(_))
    ));
}
