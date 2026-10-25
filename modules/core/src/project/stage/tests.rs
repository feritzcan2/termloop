use termloop_domain::{
    EnvironmentDeployState, EnvironmentFact, FactSource, JiraFact, JiraStatusCategory,
    ProjectEnvironment, PullRequestFact, PullRequestFactChecks, PullRequestFactState,
    PullRequestsFact, TaskDeliveryFacts,
};

use super::{DeliveryStageKind, delivery_stage};

fn jira(category: JiraStatusCategory) -> JiraFact {
    JiraFact {
        status: "Whatever the team calls it".into(),
        status_category: Some(category),
        assignee: None,
        observed_at_epoch_ms: 9,
        changed_at_epoch_ms: 8,
    }
}

fn pull_request(number: u64, state: PullRequestFactState, updated: u64) -> PullRequestFact {
    PullRequestFact {
        number,
        title: format!("PAY-42 change {number}"),
        url: format!("https://github.com/acme/pay/pull/{number}"),
        state,
        checks: PullRequestFactChecks::Passing,
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
        source: FactSource::Probe,
        observed_at_epoch_ms: changed,
        changed_at_epoch_ms: changed,
    }
}

fn facts(
    jira: Option<JiraFact>,
    pull_requests: Vec<PullRequestFact>,
    environments: Vec<EnvironmentFact>,
) -> TaskDeliveryFacts {
    TaskDeliveryFacts {
        task_id: "task-1".into(),
        jira,
        pull_requests: Some(PullRequestsFact {
            repository: "github.com/acme/pay".into(),
            items: pull_requests,
            truncated: false,
            observed_at_epoch_ms: 1,
            changed_at_epoch_ms: 1,
        }),
        environments,
        ..TaskDeliveryFacts::default()
    }
}

fn kind(facts: &TaskDeliveryFacts, environments: &[ProjectEnvironment]) -> DeliveryStageKind {
    delivery_stage(true, Some(facts), environments).kind
}

#[test]
fn work_moves_from_to_do_through_review_to_merged() {
    use DeliveryStageKind::*;
    assert_eq!(delivery_stage(true, None, &[]).kind, ToDo);
    assert_eq!(delivery_stage(false, None, &[]).kind, Done);
    assert_eq!(
        kind(
            &facts(Some(jira(JiraStatusCategory::New)), vec![], vec![]),
            &[]
        ),
        ToDo
    );
    assert_eq!(
        kind(
            &facts(
                Some(jira(JiraStatusCategory::Indeterminate)),
                vec![],
                vec![]
            ),
            &[]
        ),
        InProgress
    );
    let draft = pull_request(1, PullRequestFactState::Draft, 3);
    let open = pull_request(2, PullRequestFactState::Open, 4);
    let merged = pull_request(3, PullRequestFactState::Merged, 5);
    assert_eq!(
        kind(&facts(None, vec![draft.clone()], vec![]), &[]),
        InProgress
    );
    assert_eq!(
        kind(&facts(None, vec![draft.clone(), open.clone()], vec![]), &[]),
        InReview
    );
    let stage = delivery_stage(true, Some(&facts(None, vec![open, merged], vec![])), &[]);
    assert_eq!((stage.kind, stage.since_epoch_ms), (Merged, Some(5)));
}

#[test]
fn deployments_follow_the_project_order_and_production_is_live() {
    use DeliveryStageKind::*;
    let order = [
        ProjectEnvironment {
            name: "dev".into(),
            production: false,
        },
        ProjectEnvironment {
            name: "uat".into(),
            production: false,
        },
        ProjectEnvironment {
            name: "live".into(),
            production: true,
        },
    ];
    let merged = vec![pull_request(3, PullRequestFactState::Merged, 5)];
    // uat comes after dev, even though dev was deployed later.
    let on_uat = facts(
        None,
        merged.clone(),
        vec![
            environment("uat", EnvironmentDeployState::Deployed, 6),
            environment("dev", EnvironmentDeployState::Deployed, 7),
            environment("live", EnvironmentDeployState::NotDeployed, 7),
        ],
    );
    let stage = delivery_stage(true, Some(&on_uat), &order);
    assert_eq!(
        (stage.kind, stage.environment.as_deref()),
        (Deployed, Some("uat"))
    );
    let mut on_live = facts(
        Some(jira(JiraStatusCategory::Indeterminate)),
        merged.clone(),
        vec![environment("live", EnvironmentDeployState::Deployed, 9)],
    );
    let stage = delivery_stage(true, Some(&on_live), &order);
    assert_eq!(
        (
            stage.kind,
            stage.environment.as_deref(),
            stage.since_epoch_ms
        ),
        (Live, Some("live"), Some(9))
    );
    on_live.jira = Some(jira(JiraStatusCategory::Done));
    assert_eq!(kind(&on_live, &order), Done);
    // Without a list, the name tells production apart.
    let on_production = facts(
        None,
        merged,
        vec![environment(
            "Production",
            EnvironmentDeployState::Deployed,
            9,
        )],
    );
    assert_eq!(kind(&on_production, &[]), Live);
}

#[test]
fn jira_done_alone_is_done_only_when_nothing_tracks_environments() {
    use DeliveryStageKind::*;
    let done = facts(Some(jira(JiraStatusCategory::Done)), vec![], vec![]);
    assert_eq!(kind(&done, &[]), Done);
    let live = [ProjectEnvironment {
        name: "live".into(),
        production: true,
    }];
    // Once environments are tracked, Jira done waits for production; the
    // board shows that gap as a risk.
    assert_eq!(kind(&done, &live), InProgress);
}

#[test]
fn the_project_manager_sets_the_environment_order_on_the_board() {
    let (mut runtime, root, project_id) =
        crate::runtime::delivery_check::tests::project_manager_runtime();
    let board = runtime
        .handle(
            "projectManager.environmentsSet",
            serde_json::json!({
                "projectId": project_id,
                "environments": [
                    {"name": "staging", "production": false},
                    {"name": "live", "production": true}
                ]
            }),
        )
        .unwrap();
    assert_eq!(board["environments"][1]["name"], "live");
    assert_eq!(board["environments"][1]["production"], true);
    assert!(
        board["stages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|stage| stage["taskId"] == "task-1" && stage["stage"] == "toDo")
    );
    assert!(matches!(
        runtime.handle(
            "projectManager.environmentsSet",
            serde_json::json!({
                "projectId": project_id,
                "environments": [{"name": "live", "production": true}, {"name": "LIVE", "production": false}]
            }),
        ),
        Err(crate::CoreError::InvalidParams(field)) if field == "environments"
    ));
    let board = runtime
        .handle(
            "projectManager.environmentsSet",
            serde_json::json!({"projectId": project_id, "environments": []}),
        )
        .unwrap();
    assert_eq!(board["environments"], serde_json::json!([]));
    std::fs::remove_dir_all(root).unwrap();
}
