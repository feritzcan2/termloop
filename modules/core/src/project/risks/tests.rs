use termloop_domain::{
    CheckNotes, EnvironmentDeployState, EnvironmentFact, FactReadFailure, FactSource, JiraFact,
    PullRequestFact, PullRequestFactChecks, PullRequestFactState, PullRequestsFact,
    TaskDeliveryFacts, TaskTrackingRecord,
};

use super::{DAY_MS, DeliveryRiskKind, delivery_risks};

const NOW: u64 = 100 * DAY_MS;

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
        base_branch: "main".into(),
        head_branch: "feature/PAY-42".into(),
        merge_commit: None,
        updated_at_epoch_ms: updated,
    }
}

fn environment(name: &str, state: EnvironmentDeployState, changed: u64) -> EnvironmentFact {
    EnvironmentFact {
        name: name.into(),
        state,
        detail: None,
        source: FactSource::Check,
        observed_at_epoch_ms: NOW,
        changed_at_epoch_ms: changed,
    }
}

fn jira(status: &str) -> JiraFact {
    JiraFact {
        status: status.into(),
        status_category: None,
        assignee: None,
        observed_at_epoch_ms: NOW,
        changed_at_epoch_ms: NOW - DAY_MS,
    }
}

fn facts(
    pull_requests: Vec<PullRequestFact>,
    environments: Vec<EnvironmentFact>,
    status: Option<&str>,
) -> TaskDeliveryFacts {
    TaskDeliveryFacts {
        task_id: "task-1".into(),
        jira: status.map(jira),
        pull_requests: Some(PullRequestsFact {
            repository: "github.com/acme/pay".into(),
            items: pull_requests,
            truncated: false,
            observed_at_epoch_ms: NOW,
            changed_at_epoch_ms: NOW,
        }),
        environments,
        ..TaskDeliveryFacts::default()
    }
}

fn kinds(facts: &TaskDeliveryFacts) -> Vec<DeliveryRiskKind> {
    delivery_risks(None, Some(facts), &[], NOW)
        .into_iter()
        .map(|risk| risk.kind)
        .collect()
}

#[test]
fn a_task_on_track_has_no_risk() {
    let on_track = facts(
        vec![pull_request(
            9,
            PullRequestFactState::Open,
            PullRequestFactChecks::Passing,
            NOW - DAY_MS,
        )],
        vec![],
        Some("In Review"),
    );
    assert!(kinds(&on_track).is_empty());
    assert!(delivery_risks(None, None, &[], NOW).is_empty());
}

#[test]
fn review_stalls_and_failing_checks_are_risks() {
    let risks = delivery_risks(
        None,
        Some(&facts(
            vec![
                pull_request(
                    9,
                    PullRequestFactState::Open,
                    PullRequestFactChecks::Passing,
                    NOW - 4 * DAY_MS,
                ),
                pull_request(
                    10,
                    PullRequestFactState::Draft,
                    PullRequestFactChecks::Failing,
                    NOW,
                ),
            ],
            vec![],
            None,
        )),
        &[],
        NOW,
    );
    assert_eq!(
        risks
            .iter()
            .map(|risk| (risk.kind, risk.detail.as_str()))
            .collect::<Vec<_>>(),
        [
            (
                DeliveryRiskKind::ReviewStalled,
                "#9 has not moved for 4 days"
            ),
            (DeliveryRiskKind::ChecksFailing, "Checks fail on #10"),
        ]
    );
}

#[test]
fn a_merge_that_never_reaches_production_is_a_risk() {
    let merged = |environments| {
        facts(
            vec![pull_request(
                9,
                PullRequestFactState::Merged,
                PullRequestFactChecks::Passing,
                NOW - 3 * DAY_MS,
            )],
            environments,
            Some("In Progress"),
        )
    };
    assert_eq!(
        kinds(&merged(vec![])),
        [DeliveryRiskKind::MergedNotDeployed]
    );
    let staging_only = merged(vec![
        environment(
            "Staging",
            EnvironmentDeployState::Deployed,
            NOW - 4 * DAY_MS,
        ),
        environment(
            "Production",
            EnvironmentDeployState::NotDeployed,
            NOW - 4 * DAY_MS,
        ),
    ]);
    let risks = delivery_risks(None, Some(&staging_only), &[], NOW);
    assert_eq!(risks.len(), 1);
    assert_eq!(risks[0].kind, DeliveryRiskKind::NotInProduction);
    assert_eq!(
        risks[0].detail,
        "On Staging for 4 days but not on Production"
    );
    // Recently deployed to staging is not a risk yet.
    let recent = merged(vec![
        environment("Staging", EnvironmentDeployState::Deployed, NOW - DAY_MS),
        environment("Production", EnvironmentDeployState::Unknown, NOW),
    ]);
    assert!(kinds(&recent).is_empty());
}

#[test]
fn jira_out_of_step_with_production_is_a_risk() {
    let shipped = facts(
        vec![],
        vec![environment(
            "prod",
            EnvironmentDeployState::Deployed,
            NOW - DAY_MS,
        )],
        Some("In Review"),
    );
    assert_eq!(kinds(&shipped), [DeliveryRiskKind::JiraBehind]);
    let closed_early = facts(
        vec![],
        vec![environment(
            "Production",
            EnvironmentDeployState::NotDeployed,
            NOW,
        )],
        Some("Done"),
    );
    assert_eq!(kinds(&closed_early), [DeliveryRiskKind::JiraAhead]);
    let delivered = facts(
        vec![],
        vec![environment(
            "Production",
            EnvironmentDeployState::Deployed,
            NOW,
        )],
        Some("Resolved"),
    );
    assert!(kinds(&delivered).is_empty());
}

#[test]
fn blockers_and_failed_reads_are_risks() {
    let tracking = TaskTrackingRecord {
        task_id: "task-1".into(),
        blockers: Some("Waiting for the vendor\nmore".into()),
        ..TaskTrackingRecord::default()
    };
    let mut observed = facts(vec![], vec![], None);
    observed.read_failures.push(FactReadFailure {
        source: FactSource::Jira,
        reason: "credentialsInvalid".into(),
        at_epoch_ms: NOW,
    });
    observed.check_notes = Some(CheckNotes {
        blockers: Some("QA sign-off".into()),
        markdown: String::new(),
        recorded_at_epoch_ms: NOW,
    });
    let risks = delivery_risks(Some(&tracking), Some(&observed), &[], NOW);
    assert_eq!(risks[0].kind, DeliveryRiskKind::Blocked);
    assert_eq!(
        risks[0].detail, "Waiting for the vendor",
        "the Project Manager's own blockers win"
    );
    assert_eq!(
        risks[1].detail,
        "Jira could not be read: credentialsInvalid"
    );
    // Without the Project Manager's own, a check's blockers count.
    assert_eq!(
        delivery_risks(None, Some(&observed), &[], NOW)[0].detail,
        "QA sign-off"
    );
}

#[test]
fn the_project_environment_list_decides_production_and_jira_category_decides_done() {
    use termloop_domain::{JiraStatusCategory, ProjectEnvironment};
    let live = [ProjectEnvironment {
        name: "Live".into(),
        production: true,
    }];
    let merged = |environments| {
        facts(
            vec![pull_request(
                9,
                PullRequestFactState::Merged,
                PullRequestFactChecks::Passing,
                NOW - 5 * DAY_MS,
            )],
            environments,
            None,
        )
    };
    // Without a fact for the configured production environment, a Task long
    // deployed to staging is still not in production.
    let staging_only = merged(vec![environment(
        "Staging",
        EnvironmentDeployState::Deployed,
        NOW - 4 * DAY_MS,
    )]);
    let risks = delivery_risks(None, Some(&staging_only), &live, NOW);
    assert_eq!(risks[0].kind, DeliveryRiskKind::NotInProduction);
    assert_eq!(risks[0].detail, "On Staging for 4 days but not on Live");
    // Jira's done category counts whatever the status is called.
    let mut on_live = merged(vec![environment(
        "Live",
        EnvironmentDeployState::Deployed,
        NOW - DAY_MS,
    )]);
    on_live.jira = Some(JiraFact {
        status_category: Some(JiraStatusCategory::Done),
        ..jira("Shipped to customers")
    });
    assert!(delivery_risks(None, Some(&on_live), &live, NOW).is_empty());
    on_live.jira = Some(JiraFact {
        status_category: Some(JiraStatusCategory::Indeterminate),
        ..jira("Done-ish")
    });
    let risks = delivery_risks(None, Some(&on_live), &live, NOW);
    assert_eq!(risks[0].kind, DeliveryRiskKind::JiraBehind);
}
