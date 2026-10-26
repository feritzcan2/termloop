use super::super::facts::{
    FactReadFailure, JiraFact, PullRequestFact, PullRequestFactReview, PullRequestsFact,
};
use super::*;
use crate::playbook::{AgentCheck, PlaybookStep, StepVerdictRecord, ticket_playbook};
use crate::{AcceptanceCriterion, Blocker, TicketPriority};

const NOW: u64 = 100 * DAY_MS;

fn ticket() -> Ticket {
    Ticket {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "Fix CORS".into(),
        description: String::new(),
        status: TicketStatus::InProgress,
        priority: TicketPriority::Medium,
        assignee: Some("Ada".into()),
        sprint_id: Some("s1".into()),
        rank: 0,
        jira_url: None,
        jira_sprint_id: None,
        jira_pulled_at_epoch_ms: None,
        carry_over_count: 0,
        blockers: vec![],
        acceptance_criteria: vec![AcceptanceCriterion {
            id: "c1".into(),
            text: "Portal loads".into(),
            done: false,
        }],
        versions: None,
        created_at_epoch_ms: 0,
        updated_at_epoch_ms: 0,
    }
}

fn sprint(state: SprintState, ends_at: Option<u64>) -> Sprint {
    Sprint {
        id: "s1".into(),
        project_id: "p1".into(),
        name: "Sprint 1".into(),
        goal: None,
        state,
        created_at_epoch_ms: 0,
        activated_at_epoch_ms: None,
        closed_at_epoch_ms: (state == SprintState::Closed).then_some(1),
        ends_at_epoch_ms: ends_at,
        jira_sprint_id: None,
        jira_board_id: None,
        jira_pulled_at_epoch_ms: None,
    }
}

fn pull_request(
    number: u64,
    state: PullRequestFactState,
    checks: PullRequestFactChecks,
    updated: u64,
) -> PullRequestFact {
    PullRequestFact {
        number,
        title: format!("PAY-42 change {number}"),
        url: format!("https://github.com/acme/pay/pull/{number}"),
        state,
        checks,
        review: PullRequestFactReview::ReviewRequired,
        base_branch: "main".into(),
        head_branch: "feature/PAY-42".into(),
        merge_commit: None,
        updated_at_epoch_ms: updated,
        awaiting_review_since_epoch_ms: Some(updated),
    }
}

fn jira(status: &str) -> JiraFact {
    JiraFact {
        status: status.into(),
        status_category: None,
        assignee: None,
        updated_at_epoch_ms: None,
        observed_at_epoch_ms: NOW,
        changed_at_epoch_ms: NOW - DAY_MS,
    }
}

fn facts(pull_requests: Vec<PullRequestFact>, status: Option<&str>) -> TicketDeliveryFacts {
    TicketDeliveryFacts {
        jira: status.map(jira),
        pull_requests: Some(PullRequestsFact {
            repository: "github.com/acme/pay".into(),
            items: pull_requests,
            truncated: false,
            observed_at_epoch_ms: NOW,
            changed_at_epoch_ms: NOW,
        }),
        ..TicketDeliveryFacts::new("t1")
    }
}

fn risks_of(
    ticket: &Ticket,
    sprint: Option<&Sprint>,
    facts: Option<&TicketDeliveryFacts>,
    verdicts: &[StepVerdictRecord],
) -> Vec<DeliveryRisk> {
    let playbook = deployed_playbook();
    let progress = ticket_playbook(&playbook, ticket.status, facts, verdicts);
    delivery_risks(RiskInputs {
        ticket,
        sprint,
        facts,
        playbook: &playbook,
        progress: &progress,
        now_epoch_ms: NOW,
    })
}

/// The default steps with an agent-checked "Deployed" after Merged.
fn deployed_playbook() -> Playbook {
    let mut playbook = Playbook::default_for("p1");
    playbook.steps.insert(
        3,
        PlaybookStep {
            id: "deployed".into(),
            title: "Deployed".into(),
            checks: vec![],
            agent: Some(AgentCheck {
                instructions: "Read the release pipeline.".into(),
                retry_minutes: 30,
            }),
        },
    );
    playbook
}

fn kinds(facts: &TicketDeliveryFacts) -> Vec<DeliveryRiskKind> {
    risks_of(&ticket(), None, Some(facts), &[])
        .into_iter()
        .map(|risk| risk.kind)
        .collect()
}

#[test]
fn a_ticket_on_track_has_no_risk() {
    let on_track = facts(
        vec![pull_request(
            1,
            PullRequestFactState::Open,
            PullRequestFactChecks::Passing,
            NOW - DAY_MS,
        )],
        Some("In Progress"),
    );
    assert_eq!(kinds(&on_track), vec![]);
    let active = sprint(SprintState::Active, Some(NOW + 10 * DAY_MS));
    assert_eq!(risks_of(&ticket(), Some(&active), None, &[]), vec![]);
}

#[test]
fn blockers_failed_reads_failing_checks_and_review_waits_are_risks() {
    let mut blocked = ticket();
    blocked.blockers = vec![Blocker {
        id: "b1".into(),
        text: "Waiting on API keys\nmore".into(),
    }];
    let risks = risks_of(&blocked, None, None, &[]);
    assert_eq!(risks[0].kind, DeliveryRiskKind::Blocked);
    assert_eq!(risks[0].detail, "Waiting on API keys");

    let mut failed = facts(vec![], None);
    failed.read_failures.push(FactReadFailure {
        source: FactSource::Jira,
        reason: "unauthorized".into(),
        at_epoch_ms: NOW,
    });
    assert_eq!(kinds(&failed), vec![DeliveryRiskKind::ReadFailed]);

    let waiting = facts(
        vec![
            pull_request(
                1,
                PullRequestFactState::Open,
                PullRequestFactChecks::Failing,
                NOW - 5 * DAY_MS,
            ),
            pull_request(
                2,
                PullRequestFactState::Open,
                PullRequestFactChecks::Passing,
                NOW - 3 * DAY_MS,
            ),
        ],
        None,
    );
    let risks = risks_of(&ticket(), None, Some(&waiting), &[]);
    assert_eq!(
        risks.iter().map(|risk| risk.kind).collect::<Vec<_>>(),
        vec![
            DeliveryRiskKind::ChecksFailing,
            DeliveryRiskKind::ReviewWaiting
        ]
    );
    assert_eq!(risks[1].detail, "#2 has waited 3 days for review");

    // An approved pull request no longer waits for review.
    let mut approved = waiting.clone();
    for item in &mut approved.pull_requests.as_mut().unwrap().items {
        item.review = PullRequestFactReview::Approved;
        item.checks = PullRequestFactChecks::Passing;
    }
    assert_eq!(kinds(&approved), vec![]);
}

#[test]
fn a_status_unchanged_too_long_is_stuck() {
    let mut stuck = facts(vec![], Some("In Progress"));
    stuck.jira.as_mut().unwrap().changed_at_epoch_ms = NOW - STUCK_IN_STATUS_MS;
    assert_eq!(kinds(&stuck), vec![DeliveryRiskKind::StuckInStatus]);
    // Work not started yet is not stuck.
    stuck.jira.as_mut().unwrap().status_category = Some(JiraStatusCategory::New);
    assert_eq!(kinds(&stuck), vec![]);
}

#[test]
fn a_step_the_agent_could_not_check_is_a_risk_until_it_passes() {
    let merged = facts(
        vec![pull_request(
            1,
            PullRequestFactState::Merged,
            PullRequestFactChecks::Passing,
            NOW - 3 * DAY_MS,
        )],
        None,
    );
    let answer = |verdict| StepVerdictRecord {
        ticket_id: "t1".into(),
        step_id: "deployed".into(),
        verdict,
        evidence: "The pipeline needs a login.\nmore".into(),
        evaluator: crate::playbook::StepEvaluator::Agent,
        decided_at_epoch_ms: NOW - DAY_MS,
        next_attempt_at_epoch_ms: None,
    };
    let blocked = risks_of(
        &ticket(),
        None,
        Some(&merged),
        &[answer(StepVerdict::Blocked)],
    );
    assert_eq!(blocked[0].kind, DeliveryRiskKind::StepBlocked);
    assert_eq!(
        blocked[0].detail,
        "Can't check Deployed: The pipeline needs a login."
    );
    assert_eq!(blocked[0].since_epoch_ms, Some(NOW - DAY_MS));
    assert_eq!(
        risks_of(
            &ticket(),
            None,
            Some(&merged),
            &[answer(StepVerdict::Waiting)]
        ),
        vec![]
    );
    // Past the step, its old answer no longer matters.
    let done = facts(vec![], Some("Done"));
    assert_eq!(kinds(&done), vec![]);
}

#[test]
fn sprint_tickets_need_an_owner_criteria_and_a_start_before_the_end() {
    let active = sprint(SprintState::Active, Some(NOW + DAY_MS));
    let mut unplanned = ticket();
    unplanned.status = TicketStatus::Todo;
    unplanned.assignee = None;
    unplanned.acceptance_criteria.clear();
    unplanned.carry_over_count = 2;
    let risks = risks_of(&unplanned, Some(&active), None, &[]);
    assert_eq!(
        risks.iter().map(|risk| risk.kind).collect::<Vec<_>>(),
        vec![
            DeliveryRiskKind::NotStartedNearSprintEnd,
            DeliveryRiskKind::CarriedOver,
            DeliveryRiskKind::Unassigned,
            DeliveryRiskKind::NoAcceptanceCriteria,
        ]
    );
    assert_eq!(risks[0].detail, "Not started; the sprint ends in a day");
    assert_eq!(risks[1].detail, "Carried over 2 times");

    // A Jira assignee counts as an owner.
    let assigned = facts(vec![], None);
    let mut assigned = TicketDeliveryFacts {
        jira: Some(JiraFact {
            assignee: Some("Ada".into()),
            status_category: Some(JiraStatusCategory::New),
            ..jira("To Do")
        }),
        ..assigned
    };
    assigned.pull_requests = None;
    assert!(
        !risks_of(&unplanned, Some(&active), Some(&assigned), &[])
            .iter()
            .any(|risk| risk.kind == DeliveryRiskKind::Unassigned)
    );

    // Far from the end, or in the backlog, nothing is asked of the ticket
    // but to stop slipping.
    let early = sprint(SprintState::Active, Some(NOW + 10 * DAY_MS));
    assert_eq!(risks_of(&unplanned, Some(&early), None, &[]).len(), 3);
    assert_eq!(
        risks_of(&unplanned, None, None, &[])
            .iter()
            .map(|risk| risk.kind)
            .collect::<Vec<_>>(),
        vec![DeliveryRiskKind::CarriedOver]
    );
    let ended = sprint(SprintState::Active, Some(NOW - DAY_MS));
    assert_eq!(
        risks_of(&unplanned, Some(&ended), None, &[])[0].detail,
        "Not started and the sprint has ended"
    );
    // Started work is not "not started".
    let mut started = unplanned.clone();
    started.status = TicketStatus::InProgress;
    assert!(
        !risks_of(&started, Some(&active), None, &[])
            .iter()
            .any(|risk| risk.kind == DeliveryRiskKind::NotStartedNearSprintEnd)
    );
}

#[test]
fn a_done_ticket_has_no_risk() {
    let mut done = ticket();
    done.status = TicketStatus::Done;
    done.assignee = None;
    done.carry_over_count = 4;
    let active = sprint(SprintState::Active, Some(NOW));
    assert_eq!(risks_of(&done, Some(&active), None, &[]), vec![]);
}
