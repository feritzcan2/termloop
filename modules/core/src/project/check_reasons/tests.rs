use termloop_domain::{
    CheckNotes, DeliveryProbe, EnvironmentDeployState, EnvironmentFact, FactSource, ProbeAuthor,
    ProbeMatcher, ProbeStatus, ProjectEnvironment, TaskDeliveryFacts,
};

use super::check_reason;
use crate::project::stage::{DeliveryStage, DeliveryStageKind};

fn stage(kind: DeliveryStageKind, environment: Option<&str>) -> DeliveryStage {
    DeliveryStage {
        kind,
        environment: environment.map(str::to_owned),
        since_epoch_ms: Some(100),
    }
}

fn probe(environment: &str, matcher: ProbeMatcher, status: ProbeStatus) -> DeliveryProbe {
    DeliveryProbe {
        id: format!("probe-{environment}"),
        project_id: "project-1".into(),
        environment: environment.into(),
        argv: vec!["deployed-commit".into()],
        matcher,
        status,
        author: ProbeAuthor::ProjectManager,
        reason: None,
        created_at_epoch_ms: 1,
        last_run: None,
    }
}

fn list(names: &[(&str, bool)]) -> Vec<ProjectEnvironment> {
    names
        .iter()
        .map(|(name, production)| ProjectEnvironment {
            name: (*name).into(),
            production: *production,
        })
        .collect()
}

fn deployed_on(name: &str) -> TaskDeliveryFacts {
    TaskDeliveryFacts {
        task_id: "task-1".into(),
        environments: vec![EnvironmentFact {
            name: name.into(),
            state: EnvironmentDeployState::Deployed,
            detail: None,
            source: FactSource::Probe,
            observed_at_epoch_ms: 100,
            changed_at_epoch_ms: 100,
        }],
        ..TaskDeliveryFacts::default()
    }
}

#[test]
fn only_a_merged_or_deployed_task_with_an_unprobed_environment_ahead_needs_a_check() {
    let environments = list(&[("dev", false), ("uat", false), ("live", true)]);
    let staging = deployed_on("dev");
    let dev = probe("dev", ProbeMatcher::CommitAncestry, ProbeStatus::Approved);
    assert_eq!(
        check_reason(
            &stage(DeliveryStageKind::Deployed, Some("dev")),
            Some(&staging),
            &[&dev],
            &environments
        )
        .as_deref(),
        Some("No probe tells whether it reached uat, live")
    );
    // Proposed probes do not count; approved ones of either matcher do.
    let uat = probe("uat", ProbeMatcher::Agent, ProbeStatus::Approved);
    let live = probe("live", ProbeMatcher::CommitAncestry, ProbeStatus::Proposed);
    assert_eq!(
        check_reason(
            &stage(DeliveryStageKind::Deployed, Some("dev")),
            Some(&staging),
            &[&dev, &uat, &live],
            &environments
        )
        .as_deref(),
        Some("No probe tells whether it reached live")
    );
    let live = probe("live", ProbeMatcher::CommitAncestry, ProbeStatus::Approved);
    assert_eq!(
        check_reason(
            &stage(DeliveryStageKind::Merged, None),
            None,
            &[&dev, &uat, &live],
            &environments
        ),
        None
    );
    for kind in [
        DeliveryStageKind::ToDo,
        DeliveryStageKind::InReview,
        DeliveryStageKind::Live,
        DeliveryStageKind::Done,
    ] {
        assert_eq!(
            check_reason(&stage(kind, None), None, &[], &environments),
            None
        );
    }
}

#[test]
fn without_a_list_production_decides_and_a_later_check_answers_it() {
    let merged = stage(DeliveryStageKind::Merged, None);
    assert_eq!(
        check_reason(&merged, None, &[], &[]).as_deref(),
        Some("No probe tells whether it reached production")
    );
    let staging = probe(
        "staging",
        ProbeMatcher::CommitAncestry,
        ProbeStatus::Approved,
    );
    assert!(check_reason(&merged, None, &[&staging], &[]).is_some());
    let production = probe(
        "prod-eu",
        ProbeMatcher::CommitAncestry,
        ProbeStatus::Approved,
    );
    assert_eq!(check_reason(&merged, None, &[&production], &[]), None);

    let checked = |recorded_at_epoch_ms| TaskDeliveryFacts {
        task_id: "task-1".into(),
        check_notes: Some(CheckNotes {
            blockers: None,
            markdown: "Not on production yet".into(),
            recorded_at_epoch_ms,
        }),
        ..TaskDeliveryFacts::default()
    };
    assert_eq!(check_reason(&merged, Some(&checked(100)), &[], &[]), None);
    assert!(check_reason(&merged, Some(&checked(99)), &[], &[]).is_some());
}
