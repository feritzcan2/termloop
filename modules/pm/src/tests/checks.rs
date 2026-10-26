use std::sync::atomic::{AtomicU64, Ordering};

use super::{sprint, store, ticket};
use crate::playbook::{AgentCheck, PlaybookStep, StepEvaluator, StepVerdict, default_steps};
use crate::{
    CHECK_DEADLINE_MS, CHECK_RETRY_AFTER_MS, CheckReport, DeliveryCheckOutcome,
    DeliveryCheckReason, DeliveryRiskKind, DueCheck, FactRead, FactsObservation, PmError, PmStore,
    PullRequestFact, PullRequestFactChecks, PullRequestFactReview, PullRequestFactState,
    PullRequestsObservation, TICKET_FINISHED_CHECKS_MAX,
};

const MINUTE_MS: u64 = 60 * 1_000;

/// The default steps with an agent-checked "On INT" after Merged.
fn save_int_playbook(store: &mut PmStore) {
    let mut steps = default_steps();
    steps.insert(
        3,
        PlaybookStep {
            id: "int".into(),
            title: "On INT".into(),
            checks: vec![],
            agent: Some(AgentCheck {
                instructions: "Read what INT runs with az pipelines runs list.".into(),
                retry_minutes: 30,
            }),
        },
    );
    store.save_playbook("p1", 0, steps).unwrap();
}

/// An active sprint with one merged ticket; the INT step only when asked.
fn merged_ticket(store: &mut PmStore, int_step: bool) -> String {
    let active = sprint(store, "p1", "Sprint 1");
    store.activate_sprint(&active.id).unwrap();
    let work = ticket(store, "p1", "Login", Some(&active.id));
    store
        .record_facts(
            &work.id,
            FactsObservation {
                pull_requests: FactRead::Read(PullRequestsObservation {
                    repository: "github.com/acme/pay".into(),
                    items: vec![PullRequestFact {
                        number: 7,
                        title: "Login".into(),
                        url: "https://github.com/acme/pay/pull/7".into(),
                        state: PullRequestFactState::Merged,
                        checks: PullRequestFactChecks::Passing,
                        review: PullRequestFactReview::Approved,
                        base_branch: "main".into(),
                        head_branch: "login".into(),
                        merge_commit: Some("abc1234".into()),
                        updated_at_epoch_ms: 1,
                        awaiting_review_since_epoch_ms: None,
                    }],
                    truncated: false,
                }),
                ..FactsObservation::default()
            },
        )
        .unwrap();
    if int_step {
        save_int_playbook(store);
    }
    work.id
}

fn requested(ticket_id: &str) -> DueCheck {
    DueCheck {
        ticket_id: ticket_id.into(),
        step_id: "int".into(),
        reason: DeliveryCheckReason::Requested,
    }
}

fn report(ticket_id: &str, verdict: StepVerdict) -> CheckReport {
    CheckReport {
        ticket_id: ticket_id.into(),
        step_id: "int".into(),
        verdict,
        evidence: "The last INT run (#812) deployed main at a1b2c3d.".into(),
    }
}

#[test]
fn one_check_runs_per_ticket_and_only_for_an_agent_step() {
    let mut store = store();
    let work = merged_ticket(&mut store, false);
    assert!(matches!(
        store.start_check(requested(&work)),
        Err(PmError::Constraint(_))
    ));
    assert!(store.checks_due("p1").unwrap().is_empty());
    assert_eq!(store.requested_check(&work).unwrap(), None);

    let mut store = super::store();
    let work = merged_ticket(&mut store, true);
    assert_eq!(
        store.requested_check(&work).unwrap(),
        Some(requested(&work))
    );
    let check = store.start_check(requested(&work)).unwrap();
    assert!(check.is_running());
    assert!(matches!(
        store.start_check(requested(&work)),
        Err(PmError::Constraint(_))
    ));
    assert!(store.board("p1").unwrap().deliveries[0].checking);
    assert!(store.checks_due("p1").unwrap().is_empty());

    // The report closes the running check and moves the ticket on.
    let recorded = store
        .record_check_report("p1", report(&work, StepVerdict::Passed))
        .unwrap();
    let finished = recorded.finished_check.unwrap();
    assert_eq!(finished.id, check.id);
    assert_eq!(finished.outcome, Some(DeliveryCheckOutcome::Reported));
    assert_eq!(recorded.verdict.next_attempt_at_epoch_ms, None);
    let board = store.board("p1").unwrap();
    assert!(!board.deliveries[0].checking);
    assert_eq!(board.deliveries[0].playbook.position, Some(3));
    assert!(matches!(
        store.finish_check(&check.id, DeliveryCheckOutcome::Failed),
        Err(PmError::Constraint(_))
    ));
    assert!(store.checks_due("p1").unwrap().is_empty());

    // A report for a step without an agent is refused.
    assert!(matches!(
        store.record_check_report(
            "p1",
            CheckReport {
                step_id: "merged".into(),
                ..report(&work, StepVerdict::Passed)
            }
        ),
        Err(PmError::Constraint(_))
    ));
}

#[test]
fn a_step_not_passed_is_looked_at_again_after_its_retry_time() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let work = merged_ticket(&mut store, true);
    let due = store.checks_due("p1").unwrap();
    assert_eq!(
        due,
        [DueCheck {
            reason: DeliveryCheckReason::Due,
            ..requested(&work)
        }]
    );
    store.start_check(due[0].clone()).unwrap();
    let recorded = store
        .record_check_report("p1", report(&work, StepVerdict::Waiting))
        .unwrap();
    assert_eq!(recorded.verdict.evaluator, StepEvaluator::Agent);
    assert_eq!(
        recorded.verdict.next_attempt_at_epoch_ms,
        Some(NOW.load(Ordering::SeqCst) + 30 * MINUTE_MS)
    );
    assert!(store.checks_due("p1").unwrap().is_empty());
    NOW.fetch_add(30 * MINUTE_MS, Ordering::SeqCst);
    assert_eq!(store.checks_due("p1").unwrap().len(), 1);

    // Blocked by the agent is a risk until the step passes.
    store
        .record_check_report("p1", report(&work, StepVerdict::Blocked))
        .unwrap();
    let delivery = &store.board("p1").unwrap().deliveries[0];
    assert!(
        delivery
            .risks
            .iter()
            .any(|risk| risk.kind == DeliveryRiskKind::StepBlocked)
    );
    store.mark_step(&work, "int", true).unwrap();
    let delivery = &store.board("p1").unwrap().deliveries[0];
    assert!(
        delivery
            .risks
            .iter()
            .all(|risk| risk.kind != DeliveryRiskKind::StepBlocked)
    );
    assert_eq!(
        delivery.playbook.steps[3].evaluator,
        Some(StepEvaluator::ProjectManager)
    );
}

#[test]
fn a_failed_check_is_retried_later_and_a_silent_one_abandoned() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let work = merged_ticket(&mut store, true);
    let check = store
        .start_check(store.checks_due("p1").unwrap()[0].clone())
        .unwrap();
    store
        .finish_check(&check.id, DeliveryCheckOutcome::Failed)
        .unwrap();
    assert!(store.checks_due("p1").unwrap().is_empty());
    NOW.fetch_add(CHECK_RETRY_AFTER_MS, Ordering::SeqCst);
    assert_eq!(store.checks_due("p1").unwrap().len(), 1);

    let check = store.start_check(requested(&work)).unwrap();
    let now = NOW.load(Ordering::SeqCst);
    assert!(
        store
            .abandon_stale_checks(now + CHECK_DEADLINE_MS - 1)
            .unwrap()
            .is_empty()
    );
    let abandoned = store.abandon_stale_checks(now + CHECK_DEADLINE_MS).unwrap();
    assert_eq!(abandoned.len(), 1);
    assert_eq!(abandoned[0].id, check.id);
    assert_eq!(abandoned[0].outcome, Some(DeliveryCheckOutcome::Abandoned));
    assert!(
        store
            .board("p1")
            .unwrap()
            .deliveries
            .iter()
            .all(|d| !d.checking)
    );
}

#[test]
fn finished_checks_are_bounded_per_ticket() {
    let mut store = store();
    let work = merged_ticket(&mut store, true);
    for _ in 0..TICKET_FINISHED_CHECKS_MAX + 3 {
        let check = store.start_check(requested(&work)).unwrap();
        store
            .finish_check(&check.id, DeliveryCheckOutcome::Failed)
            .unwrap();
    }
    assert_eq!(
        store.delivery_checks("p1").unwrap().len(),
        TICKET_FINISHED_CHECKS_MAX
    );
}
