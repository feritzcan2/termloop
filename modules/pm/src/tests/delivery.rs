use std::sync::atomic::{AtomicU64, Ordering};

use super::{sprint, store, ticket};
use crate::{
    CommitAncestryFact, DataTier, DeliveryRiskKind, DeliveryStageKind, EnvironmentDeployState,
    EnvironmentObservation, FACTS_STALE_AFTER_MS, FactRead, FactSource, FactsObservation,
    GitHubSource, JiraObservation, JiraSource, NewProbe, PmError, ProbeMatcher, ProbeOutcome,
    ProbeStatus, ProjectEnvironment, ProjectSources, PullRequestFact, PullRequestFactChecks,
    PullRequestFactReview, PullRequestFactState, PullRequestsObservation, TicketStatus,
};

fn merged_pull_request(commit: &str) -> PullRequestFact {
    PullRequestFact {
        number: 7,
        title: "PAY-42 Fix CORS".into(),
        url: "https://github.com/acme/pay/pull/7".into(),
        state: PullRequestFactState::Merged,
        checks: PullRequestFactChecks::Passing,
        review: PullRequestFactReview::Approved,
        base_branch: "main".into(),
        head_branch: "feature/PAY-42".into(),
        merge_commit: Some(commit.into()),
        updated_at_epoch_ms: 1,
        awaiting_review_since_epoch_ms: None,
    }
}

fn new_probe(project_id: &str, environment: &str, matcher: ProbeMatcher) -> NewProbe {
    NewProbe {
        project_id: project_id.into(),
        environment: environment.into(),
        argv: vec![
            "curl".into(),
            format!("https://{environment}.example/version"),
        ],
        matcher,
        reason: Some("Prints the deployed commit".into()),
    }
}

#[test]
fn facts_record_reads_keep_the_last_good_value_and_turn_stale() {
    static NOW: AtomicU64 = AtomicU64::new(1_000);
    let mut store = store();
    store.set_clock(|| NOW.load(Ordering::SeqCst));
    let ticket = ticket(&mut store, "p1", "Fix CORS", None);
    let facts = store
        .record_facts(
            &ticket.id,
            FactsObservation {
                jira: FactRead::Read(JiraObservation {
                    status: "In Progress".into(),
                    status_category: None,
                    assignee: Some("Ada".into()),
                    updated_at_epoch_ms: Some(900),
                }),
                pull_requests: FactRead::Read(PullRequestsObservation {
                    repository: "github.com/acme/pay".into(),
                    items: vec![merged_pull_request("abc1234def")],
                    truncated: false,
                }),
                ..FactsObservation::default()
            },
        )
        .unwrap();
    assert_eq!(facts.recorded_at_epoch_ms, 1_000);
    NOW.store(2_000, Ordering::SeqCst);
    let facts = store
        .record_facts(
            &ticket.id,
            FactsObservation {
                jira: FactRead::Failed("unauthorized".into()),
                ..FactsObservation::default()
            },
        )
        .unwrap();
    assert_eq!(facts.jira.as_ref().unwrap().status, "In Progress");
    assert_eq!(facts.read_failures[0].source, FactSource::Jira);
    assert_eq!(facts.pull_request_items().len(), 1);
    assert_eq!(store.ticket_facts(&ticket.id).unwrap(), Some(facts));

    let board = store.board("p1").unwrap();
    let delivery = &board.deliveries[0];
    assert_eq!(delivery.stage.kind, DeliveryStageKind::Merged);
    assert!(!delivery.facts.as_ref().unwrap().stale);
    assert!(
        delivery
            .risks
            .iter()
            .any(|risk| risk.kind == DeliveryRiskKind::ReadFailed)
    );
    NOW.store(2_001 + FACTS_STALE_AFTER_MS, Ordering::SeqCst);
    assert!(
        store.board("p1").unwrap().deliveries[0]
            .facts
            .as_ref()
            .unwrap()
            .stale
    );

    // An invalid observation changes nothing.
    let before = store.ticket_facts(&ticket.id).unwrap();
    let invalid = store.record_facts(
        &ticket.id,
        FactsObservation {
            jira: FactRead::Failed(String::new()),
            ..FactsObservation::default()
        },
    );
    assert!(matches!(invalid, Err(PmError::Invalid("facts"))));
    assert_eq!(store.ticket_facts(&ticket.id).unwrap(), before);
    assert!(matches!(
        store.record_facts("missing", FactsObservation::default()),
        Err(PmError::NotFound)
    ));
}

#[test]
fn probes_are_proposed_approved_rejected_and_deleted() {
    let mut store = store();
    let proposed = store
        .propose_probe(new_probe("p1", "staging", ProbeMatcher::Agent))
        .unwrap();
    assert_eq!(proposed.status, ProbeStatus::Proposed);
    assert!(!store.deploy_tracking_enabled("p1").unwrap());
    assert!(matches!(
        store.propose_probe(NewProbe {
            environment: "STAGING".into(),
            ..new_probe("p1", "staging", ProbeMatcher::Agent)
        }),
        Err(PmError::Constraint(_))
    ));
    assert!(matches!(
        store.record_probe_run(
            &proposed.id,
            &proposed.argv,
            &ProbeOutcome::Failed("timedOut".into()),
            &[]
        ),
        Err(PmError::Conflict)
    ));
    let approved = store.approve_probe(&proposed.id).unwrap();
    assert_eq!(approved.status, ProbeStatus::Approved);
    assert!(store.deploy_tracking_enabled("p1").unwrap());
    assert!(matches!(
        store.reject_probe(&proposed.id),
        Err(PmError::Constraint(_))
    ));
    let written = store
        .create_probe(new_probe("p1", "live", ProbeMatcher::CommitAncestry))
        .unwrap();
    assert_eq!(written.status, ProbeStatus::Approved);
    let other = store
        .propose_probe(new_probe("p1", "uat", ProbeMatcher::Agent))
        .unwrap();
    store.reject_probe(&other.id).unwrap();
    store.delete_probe(&approved.id).unwrap();
    assert_eq!(store.project_probes("p1").unwrap(), vec![written]);
    assert!(matches!(
        store.create_probe(NewProbe {
            argv: vec!["-c".into()],
            ..new_probe("p1", "dev", ProbeMatcher::Agent)
        }),
        Err(PmError::Invalid("argv"))
    ));
    assert!(matches!(
        store.delete_probe(&other.id),
        Err(PmError::NotFound)
    ));
}

#[test]
fn a_commit_ancestry_run_sets_environment_facts_from_git_answers() {
    let mut store = store();
    let shipped = ticket(&mut store, "p1", "Shipped", None);
    let pending = ticket(&mut store, "p1", "Pending", None);
    let elsewhere = ticket(&mut store, "p2", "Elsewhere", None);
    for (ticket, commit) in [
        (&shipped, "aaa1111"),
        (&pending, "bbb2222"),
        (&elsewhere, "ccc3333"),
    ] {
        store
            .record_facts(
                &ticket.id,
                FactsObservation {
                    pull_requests: FactRead::Read(PullRequestsObservation {
                        repository: "github.com/acme/pay".into(),
                        items: vec![merged_pull_request(commit)],
                        truncated: false,
                    }),
                    ..FactsObservation::default()
                },
            )
            .unwrap();
    }
    let probe = store
        .create_probe(new_probe("p1", "live", ProbeMatcher::CommitAncestry))
        .unwrap();
    let mut targets = store.commit_ancestry_targets("p1").unwrap();
    targets.sort();
    let mut expected = vec![
        (shipped.id.clone(), "aaa1111".to_owned()),
        (pending.id.clone(), "bbb2222".to_owned()),
    ];
    expected.sort();
    assert_eq!(targets, expected);

    let answer = |ticket_id: &str, contained| CommitAncestryFact {
        ticket_id: ticket_id.into(),
        contained,
    };
    let recorded = store
        .record_probe_run(
            &probe.id,
            &probe.argv,
            &ProbeOutcome::Output {
                output_hash: "a".repeat(64),
                deployed_commit: Some("0123456789abcdef".into()),
            },
            &[
                answer(&shipped.id, Some(true)),
                answer(&pending.id, None),
                answer(&elsewhere.id, Some(true)),
            ],
        )
        .unwrap();
    assert_eq!(recorded.ticket_ids, vec![shipped.id.clone()]);
    assert!(!recorded.output_changed);
    let facts = store.ticket_facts(&shipped.id).unwrap().unwrap();
    let live = facts.environment("live").unwrap();
    assert_eq!(live.state, EnvironmentDeployState::Deployed);
    assert_eq!(live.source, FactSource::Probe);
    assert_eq!(live.detail.as_deref(), Some("Runs 0123456789ab"));
    assert!(
        store
            .ticket_facts(&pending.id)
            .unwrap()
            .unwrap()
            .environments
            .is_empty()
    );
    assert!(
        store
            .ticket_facts(&elsewhere.id)
            .unwrap()
            .unwrap()
            .environments
            .is_empty()
    );
    // Without an environment list, "live" is not named production.
    let stage = &store.board("p1").unwrap().deliveries[0].stage;
    assert_eq!(stage.kind, DeliveryStageKind::Deployed);
    assert_eq!(stage.environment.as_deref(), Some("live"));

    let again = store
        .record_probe_run(
            &probe.id,
            &probe.argv,
            &ProbeOutcome::Output {
                output_hash: "b".repeat(64),
                deployed_commit: None,
            },
            &[answer(&pending.id, Some(true))],
        )
        .unwrap();
    assert!(again.output_changed);
    assert_eq!(again.run.failure.as_deref(), Some("noCommit"));
    assert!(again.ticket_ids.is_empty());
    assert!(matches!(
        store.record_probe_run(
            &probe.id,
            &["other".to_owned()],
            &ProbeOutcome::Failed("failed".into()),
            &[]
        ),
        Err(PmError::Conflict)
    ));
}

#[test]
fn the_board_derives_stages_check_reasons_and_the_tier() {
    let mut store = store();
    let active = sprint(&mut store, "p1", "Sprint 1");
    store.activate_sprint(&active.id).unwrap();
    let merged = ticket(&mut store, "p1", "Merged", Some(&active.id));
    store
        .record_facts(
            &merged.id,
            FactsObservation {
                pull_requests: FactRead::Read(PullRequestsObservation {
                    repository: "github.com/acme/pay".into(),
                    items: vec![merged_pull_request("abc1234")],
                    truncated: false,
                }),
                ..FactsObservation::default()
            },
        )
        .unwrap();
    let board = store.board("p1").unwrap();
    assert_eq!(board.tracking.tier, DataTier::Tickets);
    assert_eq!(board.deliveries[0].stage.kind, DeliveryStageKind::Merged);
    // Without deploy tracking, nothing asks whether it reached production.
    assert!(board.deliveries[0].check_reasons.is_empty());

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
    store
        .set_project_sources(
            "p1",
            &ProjectSources {
                github: Some(GitHubSource {
                    owner: "acme".into(),
                    name: "pay".into(),
                }),
                ..ProjectSources::default()
            },
        )
        .unwrap();
    let board = store.board("p1").unwrap();
    assert_eq!(board.tracking.tier, DataTier::Deploy);
    assert!(board.tracking.code && board.tracking.deploy && !board.tracking.jira);
    assert_eq!(
        board.deliveries[0].check_reasons,
        vec![
            "No probe tells whether it reached staging",
            "No probe tells whether it reached live"
        ]
    );
    store
        .record_facts(
            &merged.id,
            FactsObservation {
                environments: vec![EnvironmentObservation {
                    name: "staging".into(),
                    state: EnvironmentDeployState::Deployed,
                    detail: None,
                    source: FactSource::ProjectManager,
                }],
                ..FactsObservation::default()
            },
        )
        .unwrap();
    let delivery = &store.board("p1").unwrap().deliveries[0];
    assert_eq!(delivery.stage.kind, DeliveryStageKind::Deployed);
    assert_eq!(
        delivery.check_reasons,
        vec!["No probe tells whether it reached live"]
    );
    store
        .set_ticket_status(&merged.id, TicketStatus::Done)
        .unwrap();
    let delivery = &store.board("p1").unwrap().deliveries[0];
    assert_eq!(delivery.stage.kind, DeliveryStageKind::Done);
    assert!(delivery.check_reasons.is_empty() && delivery.risks.is_empty());
}

#[test]
fn sources_hold_only_valid_non_secret_identifiers() {
    let mut store = store();
    assert_eq!(
        store.project_sources("p1").unwrap(),
        ProjectSources::default()
    );
    let sources = ProjectSources {
        jira: Some(JiraSource {
            site_url: "https://acme.atlassian.net".into(),
            board_id: Some(84),
            account_email: "ada@acme.example".into(),
            credential_handle: "jira-acme".into(),
        }),
        github: None,
    };
    assert_eq!(store.set_project_sources("p1", &sources).unwrap(), sources);
    assert_eq!(store.project_sources("p1").unwrap(), sources);
    assert!(store.tracking("p1").unwrap().jira);
    let mut invalid = sources.clone();
    invalid.jira.as_mut().unwrap().site_url = "https://ada:token@acme.atlassian.net".into();
    assert!(matches!(
        store.set_project_sources("p1", &invalid),
        Err(PmError::Invalid("sources"))
    ));
    assert_eq!(store.project_sources("p1").unwrap(), sources);
    store
        .set_project_sources("p1", &ProjectSources::default())
        .unwrap();
    assert_eq!(
        store.project_sources("p1").unwrap(),
        ProjectSources::default()
    );
}

#[test]
fn an_open_sprint_gets_an_end_date_and_a_closed_one_does_not() {
    let mut store = store();
    let planned = sprint(&mut store, "p1", "Sprint 1");
    let updated = store.set_sprint_end(&planned.id, Some(5_000)).unwrap();
    assert_eq!(updated.ends_at_epoch_ms, Some(5_000));
    assert_eq!(
        store
            .set_sprint_end(&planned.id, None)
            .unwrap()
            .ends_at_epoch_ms,
        None
    );
    assert!(matches!(
        store.set_sprint_end(&planned.id, Some(u64::MAX)),
        Err(PmError::Invalid("endsAtEpochMs"))
    ));
    store.close_sprint(&planned.id, None).unwrap();
    assert!(matches!(
        store.set_sprint_end(&planned.id, Some(1)),
        Err(PmError::Constraint(_))
    ));
}
