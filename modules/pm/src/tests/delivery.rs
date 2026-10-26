use std::sync::atomic::{AtomicU64, Ordering};

use termloop_providers::AzureRepository;

use super::{sprint, store, ticket};
use crate::playbook::{AgentCheck, PlaybookStep, StepEvaluator, default_steps};
use crate::{
    DataTier, DeliveryRiskKind, FACTS_STALE_AFTER_MS, FactRead, FactSource, FactsObservation,
    GitHubSource, JiraObservation, JiraSource, MARKED_PASSED_EVIDENCE, PmError, ProjectSources,
    PullRequestFact, PullRequestFactChecks, PullRequestFactReview, PullRequestFactState,
    PullRequestsObservation, TicketStatus,
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
    assert_eq!(delivery.playbook.position, Some(2));
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
fn the_board_walks_the_playbook_and_derives_the_tier() {
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
    assert_eq!(board.playbook.revision, 0);
    assert_eq!(board.deliveries[0].playbook.position, Some(2));

    // An agent-checked step turns deploy tracking on.
    let mut steps = default_steps();
    steps.insert(
        3,
        PlaybookStep {
            id: "live".into(),
            title: "In production".into(),
            checks: vec![],
            agent: Some(AgentCheck {
                instructions: "Read the production release with az pipelines.".into(),
                retry_minutes: 60,
            }),
        },
    );
    let saved = store.save_playbook("p1", 0, steps.clone()).unwrap();
    assert_eq!(saved.revision, 1);
    assert!(matches!(
        store.save_playbook("p1", 0, steps.clone()),
        Err(PmError::Constraint(_))
    ));
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

    // The project manager answers a step by hand; a changed step forgets it.
    store.mark_step(&merged.id, "live", true).unwrap();
    let delivery = &store.board("p1").unwrap().deliveries[0];
    assert_eq!(delivery.playbook.position, Some(3));
    assert_eq!(
        delivery.playbook.steps[3].evidence.as_deref(),
        Some(MARKED_PASSED_EVIDENCE)
    );
    assert_eq!(
        delivery.playbook.steps[3].evaluator,
        Some(StepEvaluator::ProjectManager)
    );
    steps[3].agent.as_mut().unwrap().retry_minutes = 30;
    store.save_playbook("p1", 1, steps).unwrap();
    assert_eq!(
        store.board("p1").unwrap().deliveries[0].playbook.position,
        Some(2)
    );
    assert!(matches!(
        store.mark_step(&merged.id, "missing", true),
        Err(PmError::NotFound)
    ));

    store
        .set_ticket_status(&merged.id, TicketStatus::Done)
        .unwrap();
    let delivery = &store.board("p1").unwrap().deliveries[0];
    assert_eq!(delivery.playbook.position, Some(4));
    assert!(delivery.playbook.next_index().is_none() && delivery.risks.is_empty());
}

#[test]
fn a_setup_proposal_waits_for_the_project_manager() {
    let mut store = store();
    assert_eq!(store.playbook_proposal("p1").unwrap(), None);
    let proposal = store
        .propose_playbook(
            "p1",
            "Read .github/workflows/deploy.yml.".into(),
            default_steps(),
        )
        .unwrap();
    assert_eq!(store.playbook_proposal("p1").unwrap(), Some(proposal));
    assert_eq!(store.playbook("p1").unwrap().revision, 0);
    assert!(matches!(
        store.propose_playbook("p1", " ".into(), default_steps()),
        Err(PmError::Invalid("summary"))
    ));
    assert!(matches!(
        store.propose_playbook("p1", "Nothing".into(), Vec::new()),
        Err(PmError::Invalid("steps"))
    ));

    let mut kept = default_steps();
    kept.truncate(3);
    let applied = store.apply_playbook_proposal("p1", kept).unwrap();
    assert_eq!((applied.revision, applied.steps.len()), (1, 3));
    assert_eq!(store.playbook_proposal("p1").unwrap(), None);
    assert!(matches!(
        store.apply_playbook_proposal("p1", default_steps()),
        Err(PmError::NotFound)
    ));
    store
        .propose_playbook("p1", "Again".into(), default_steps())
        .unwrap();
    store.discard_playbook_proposal("p1").unwrap();
    assert!(matches!(
        store.discard_playbook_proposal("p1"),
        Err(PmError::NotFound)
    ));
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
        ..ProjectSources::default()
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
fn an_azure_devops_repository_is_stored_normalized_and_tracks_code() {
    let mut store = store();
    let stored = store
        .set_project_sources(
            "p1",
            &ProjectSources {
                azure_devops: Some(AzureRepository {
                    organization: "Contoso".into(),
                    project: "Parking".into(),
                    name: "Nucleus".into(),
                }),
                ..ProjectSources::default()
            },
        )
        .unwrap();
    let azure = stored.azure_devops.clone().unwrap();
    assert_eq!(azure.organization, "contoso");
    assert_eq!(store.project_sources("p1").unwrap(), stored);
    assert!(store.tracking("p1").unwrap().code);
    let both = ProjectSources {
        github: Some(GitHubSource {
            owner: "acme".into(),
            name: "pay".into(),
        }),
        ..stored.clone()
    };
    assert!(matches!(
        store.set_project_sources("p1", &both),
        Err(PmError::Invalid("sources"))
    ));
    let invalid = ProjectSources {
        azure_devops: Some(AzureRepository {
            name: "a/b".into(),
            ..azure
        }),
        ..ProjectSources::default()
    };
    assert!(matches!(
        store.set_project_sources("p1", &invalid),
        Err(PmError::Invalid("sources"))
    ));
    assert_eq!(store.project_sources("p1").unwrap(), stored);
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
