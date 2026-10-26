use crate::playbook::{
    AgentCheck, Playbook, PlaybookStep, StatusCategory, StepCheck, StepEvaluator, StepVerdict,
    StepVerdictRecord, agent_step_due, default_steps, ticket_playbook, valid_playbook_steps,
};
use crate::{
    JiraFact, JiraStatusCategory, PullRequestFact, PullRequestFactChecks, PullRequestFactReview,
    PullRequestFactState, PullRequestsFact, TicketDeliveryFacts, TicketStatus,
};

fn jira(status: &str, category: JiraStatusCategory) -> JiraFact {
    JiraFact {
        status: status.into(),
        status_category: Some(category),
        assignee: None,
        updated_at_epoch_ms: None,
        observed_at_epoch_ms: 1,
        changed_at_epoch_ms: 1,
    }
}

fn pull_request(number: u64, state: PullRequestFactState, base: &str) -> PullRequestFact {
    PullRequestFact {
        number,
        title: "PAY-42".into(),
        url: format!("https://github.com/acme/pay/pull/{number}"),
        state,
        checks: PullRequestFactChecks::Passing,
        review: PullRequestFactReview::Unknown,
        base_branch: base.into(),
        head_branch: "feature/PAY-42".into(),
        merge_commit: None,
        updated_at_epoch_ms: 2,
        awaiting_review_since_epoch_ms: None,
    }
}

fn facts(jira: Option<JiraFact>, pull_requests: Vec<PullRequestFact>) -> TicketDeliveryFacts {
    TicketDeliveryFacts {
        jira,
        pull_requests: Some(PullRequestsFact {
            repository: "github.com/acme/pay".into(),
            items: pull_requests,
            truncated: false,
            observed_at_epoch_ms: 2,
            changed_at_epoch_ms: 2,
        }),
        ..TicketDeliveryFacts::new("t1")
    }
}

/// The default steps with an agent-checked "On INT" after Merged.
fn with_int() -> Playbook {
    let mut playbook = Playbook::default_for("p1");
    playbook.steps.insert(
        3,
        PlaybookStep {
            id: "int".into(),
            title: "On INT".into(),
            checks: vec![],
            agent: Some(AgentCheck {
                instructions: "Read the INT pipeline's last successful run.".into(),
                retry_minutes: 30,
            }),
        },
    );
    playbook
}

fn verdict(step: &str, verdict: StepVerdict, next: Option<u64>) -> StepVerdictRecord {
    StepVerdictRecord {
        ticket_id: "t1".into(),
        step_id: step.into(),
        verdict,
        evidence: "INT runs build 812 from main.".into(),
        evaluator: StepEvaluator::Agent,
        decided_at_epoch_ms: 5,
        next_attempt_at_epoch_ms: next,
    }
}

#[test]
fn a_ticket_stands_at_the_furthest_step_its_facts_pass() {
    let playbook = Playbook::default_for("p1");
    let fresh = ticket_playbook(&playbook, TicketStatus::Todo, None, &[]);
    assert_eq!((fresh.position, fresh.next_index()), (None, Some(0)));

    // Without Jira, the PM's own status decides.
    let started = ticket_playbook(&playbook, TicketStatus::InReview, None, &[]);
    assert_eq!(started.position, Some(0));
    assert_eq!(
        started.steps[0].evidence.as_deref(),
        Some("The ticket status is In review.")
    );

    // A merged pull request implies the steps before it.
    let merged = facts(
        Some(jira("To Do", JiraStatusCategory::New)),
        vec![pull_request(7, PullRequestFactState::Merged, "main")],
    );
    let stands = ticket_playbook(&playbook, TicketStatus::Todo, Some(&merged), &[]);
    assert_eq!(stands.position, Some(2));
    assert!(stands.steps[0].implied && stands.steps[1].implied && !stands.steps[2].implied);
    assert_eq!(stands.steps[1].verdict, Some(StepVerdict::Passed));
    assert_eq!(
        stands.steps[2].evidence.as_deref(),
        Some("Pull request #7 is merged into main.")
    );

    // Jira's status wins over the PM's when the ticket has one.
    let done = facts(Some(jira("Closed", JiraStatusCategory::Done)), vec![]);
    let finished = ticket_playbook(&playbook, TicketStatus::InProgress, Some(&done), &[]);
    assert_eq!((finished.position, finished.next_index()), (Some(3), None));
    assert_eq!(
        finished.steps[3].evidence.as_deref(),
        Some("Jira status is Closed.")
    );

    // Marked done by the project manager: every step passed.
    let marked = ticket_playbook(&playbook, TicketStatus::Done, None, &[]);
    assert_eq!(marked.position, Some(3));
}

#[test]
fn a_status_check_matches_listed_names_ignoring_case_and_a_branch_filter_narrows_pull_requests() {
    let playbook = Playbook {
        steps: vec![
            PlaybookStep {
                id: "ready".into(),
                title: "Ready for deployment".into(),
                checks: vec![StepCheck::Status {
                    names: vec!["Ready for Deployment".into()],
                    category: None,
                }],
                agent: None,
            },
            PlaybookStep {
                id: "release".into(),
                title: "On the release branch".into(),
                checks: vec![StepCheck::PullRequest {
                    state: crate::playbook::PullRequestStepState::Merged,
                    base_branch: Some("release".into()),
                }],
                agent: None,
            },
        ],
        ..Playbook::default_for("p1")
    };
    let ready = facts(
        Some(jira(
            "ready for deployment",
            JiraStatusCategory::Indeterminate,
        )),
        vec![pull_request(3, PullRequestFactState::Merged, "main")],
    );
    let stands = ticket_playbook(&playbook, TicketStatus::Todo, Some(&ready), &[]);
    assert_eq!(stands.position, Some(0));
    let released = facts(
        None,
        vec![pull_request(4, PullRequestFactState::Merged, "release")],
    );
    assert_eq!(
        ticket_playbook(&playbook, TicketStatus::Todo, Some(&released), &[]).position,
        Some(1)
    );
}

#[test]
fn an_agent_looks_only_at_the_next_step_and_only_when_its_answer_is_due() {
    let playbook = with_int();
    let merged = facts(
        None,
        vec![pull_request(7, PullRequestFactState::Merged, "main")],
    );
    let at_merged = ticket_playbook(&playbook, TicketStatus::Todo, Some(&merged), &[]);
    assert_eq!(at_merged.next_index(), Some(3));
    assert_eq!(
        agent_step_due(&playbook, &at_merged, 10).map(|step| step.id.as_str()),
        Some("int")
    );

    // Waiting: due again only once its retry time came.
    let waiting = [verdict("int", StepVerdict::Waiting, Some(100))];
    let stands = ticket_playbook(&playbook, TicketStatus::Todo, Some(&merged), &waiting);
    assert_eq!(stands.steps[3].verdict, Some(StepVerdict::Waiting));
    assert!(agent_step_due(&playbook, &stands, 99).is_none());
    assert!(agent_step_due(&playbook, &stands, 100).is_some());

    // Passed: the ticket moves on and the agent is done with it.
    let passed = [verdict("int", StepVerdict::Passed, None)];
    let stands = ticket_playbook(&playbook, TicketStatus::Todo, Some(&merged), &passed);
    assert_eq!(stands.position, Some(3));
    assert!(agent_step_due(&playbook, &stands, 10).is_none());

    // Not merged yet: the next step has no agent, so nothing is due.
    let open = facts(
        None,
        vec![pull_request(7, PullRequestFactState::Open, "main")],
    );
    let stands = ticket_playbook(&playbook, TicketStatus::Todo, Some(&open), &[]);
    assert!(agent_step_due(&playbook, &stands, 10).is_none());
}

#[test]
fn steps_need_unique_ids_titles_and_bounded_checks() {
    assert!(valid_playbook_steps(&default_steps()));
    assert!(valid_playbook_steps(&with_int().steps));
    assert!(!valid_playbook_steps(&[]));
    let mut duplicate = default_steps();
    duplicate[1].id = "started".into();
    assert!(!valid_playbook_steps(&duplicate));
    let mut empty_status = default_steps();
    empty_status[0].checks = vec![StepCheck::Status {
        names: vec![],
        category: None,
    }];
    assert!(!valid_playbook_steps(&empty_status));
    let mut too_fast = with_int().steps;
    too_fast[3].agent.as_mut().unwrap().retry_minutes = 1;
    assert!(!valid_playbook_steps(&too_fast));
    // A step with no checks and no agent passes only by hand.
    let mut by_hand = default_steps();
    by_hand[0].checks.clear();
    assert!(valid_playbook_steps(&by_hand));
    let _ = StatusCategory::Started;
}
