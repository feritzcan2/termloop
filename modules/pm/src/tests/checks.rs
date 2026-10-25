use std::sync::atomic::{AtomicU64, Ordering};

use super::{sprint, store, ticket};
use crate::{
    CHECK_DEADLINE_MS, CHECK_RETRY_AFTER_MS, CheckReport, DeliveryCheckOutcome,
    DeliveryCheckReason, FactRead, FactsObservation, NewCheck, NewProbe, PmError, PmStore,
    ProbeMatcher, ProbeOutcome, ProjectEnvironment, PullRequestFact, PullRequestFactChecks,
    PullRequestFactReview, PullRequestFactState, PullRequestsObservation,
    TICKET_FINISHED_CHECKS_MAX,
};

/// An active sprint with one merged ticket; environments only when asked.
fn merged_ticket(store: &mut PmStore, environments: bool) -> String {
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
    if environments {
        store
            .set_project_environments(
                "p1",
                &[
                    ProjectEnvironment {
                        name: "staging".into(),
                        production: false,
                    },
                    ProjectEnvironment {
                        name: "live".into(),
                        production: true,
                    },
                ],
            )
            .unwrap();
    }
    work.id
}

fn requested(ticket_id: &str) -> NewCheck {
    NewCheck {
        ticket_id: ticket_id.into(),
        reason: DeliveryCheckReason::Requested,
        environments: vec!["live".into()],
        probe_id: None,
    }
}

fn report(ticket_id: &str) -> CheckReport {
    CheckReport {
        ticket_id: ticket_id.into(),
        environments: Vec::new(),
        blockers: None,
        notes_markdown: "## Unknown\nNo evidence of either environment".into(),
        agent_probe: None,
        probe_proposals: Vec::new(),
    }
}

#[test]
fn one_check_runs_per_ticket_and_only_with_deploy_tracking() {
    let mut store = store();
    let work = merged_ticket(&mut store, false);
    assert!(matches!(
        store.start_check(requested(&work)),
        Err(PmError::Constraint(_))
    ));
    assert!(store.checks_due("p1").unwrap().is_empty());

    let mut store = super::store();
    let work = merged_ticket(&mut store, true);
    let check = store.start_check(requested(&work)).unwrap();
    assert!(check.is_running());
    assert!(matches!(
        store.start_check(requested(&work)),
        Err(PmError::Constraint(_))
    ));
    assert!(store.board("p1").unwrap().deliveries[0].checking);
    assert!(store.checks_due("p1").unwrap().is_empty());

    // The report closes the running check.
    let recorded = store.record_check_report("p1", report(&work)).unwrap();
    let finished = recorded.finished_check.unwrap();
    assert_eq!(finished.id, check.id);
    assert_eq!(finished.outcome, Some(DeliveryCheckOutcome::Reported));
    assert!(!store.board("p1").unwrap().deliveries[0].checking);
    assert!(matches!(
        store.finish_check(&check.id, DeliveryCheckOutcome::Failed),
        Err(PmError::Constraint(_))
    ));
    // The notes answered the check reasons; nothing is due.
    assert!(store.checks_due("p1").unwrap().is_empty());

    // A probe-changed check names an approved agent probe.
    assert!(matches!(
        store.start_check(NewCheck {
            reason: DeliveryCheckReason::ProbeChanged,
            ..requested(&work)
        }),
        Err(PmError::Invalid("probeId"))
    ));
}

#[test]
fn check_reasons_are_due_and_retried_after_a_failed_check() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let work = merged_ticket(&mut store, true);
    let due = store.checks_due("p1").unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].reason, DeliveryCheckReason::CheckReasons);
    assert_eq!(due[0].environments, ["staging", "live"]);
    assert_eq!(due[0].details.len(), 2);

    let check = store.start_check(due[0].clone().into()).unwrap();
    store
        .finish_check(&check.id, DeliveryCheckOutcome::Failed)
        .unwrap();
    assert!(store.checks_due("p1").unwrap().is_empty());
    NOW.fetch_add(CHECK_RETRY_AFTER_MS, Ordering::SeqCst);
    assert_eq!(store.checks_due("p1").unwrap().len(), 1);

    // A check that never reports is abandoned at its deadline.
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
fn a_changed_agent_probe_output_makes_a_check_due() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let work = merged_ticket(&mut store, true);
    // The check reasons are answered by a first report.
    store.record_check_report("p1", report(&work)).unwrap();
    assert!(store.checks_due("p1").unwrap().is_empty());

    let probe = store
        .create_probe(NewProbe {
            project_id: "p1".into(),
            environment: "live".into(),
            argv: vec!["kubectl".into(), "get".into(), "deploy".into()],
            matcher: ProbeMatcher::Agent,
            reason: None,
        })
        .unwrap();
    let run = |store: &mut PmStore, hash: char| {
        NOW.fetch_add(1_000, Ordering::SeqCst);
        store
            .record_probe_run(
                &probe.id,
                &probe.argv,
                &ProbeOutcome::Output {
                    output_hash: hash.to_string().repeat(64),
                    deployed_commit: None,
                },
                &[],
            )
            .unwrap();
    };
    run(&mut store, 'a');
    let due = store.checks_due("p1").unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].reason, DeliveryCheckReason::ProbeChanged);
    assert_eq!(due[0].probe_id.as_deref(), Some(probe.id.as_str()));
    assert_eq!(due[0].environments, ["live"]);

    let check = store.start_check(due[0].clone().into()).unwrap();
    store
        .finish_check(&check.id, DeliveryCheckOutcome::Failed)
        .unwrap();
    // The same output was already in front of that check.
    run(&mut store, 'a');
    assert!(store.checks_due("p1").unwrap().is_empty());
    run(&mut store, 'b');
    assert_eq!(
        store.checks_due("p1").unwrap()[0].reason,
        DeliveryCheckReason::ProbeChanged
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
