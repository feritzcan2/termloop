use serde_json::json;
use termloop_domain::{SprintState, TaskSourceBoardSelection};
use termloop_providers::{JiraIssueSnapshot, JiraSearchResult, JiraSprint, JiraSprintState};

use crate::{CoreError, CoreRuntime, JiraBoardSprints, JiraSprintObservation, TaskSourceFailure};

pub(crate) fn issue(key: &str) -> JiraIssueSnapshot {
    JiraIssueSnapshot {
        external_id: key.trim_start_matches("PAY-").into(),
        key: key.into(),
        url: format!("https://example.atlassian.net/browse/{key}"),
        summary: format!("{key} summary"),
        description: Some("h2. Goal".into()),
        status_name: "In Progress".into(),
        status_category: None,
        assignee_display: None,
        updated_at: "2026-10-24T09:00:00.000+0000".into(),
    }
}

pub(crate) fn sprint(id: u64, name: &str, state: JiraSprintState) -> JiraSprint {
    JiraSprint {
        id,
        board_id: 7,
        name: name.into(),
        state,
        start_epoch_ms: Some(1),
        end_epoch_ms: Some(2),
    }
}

pub(crate) fn observation(
    sprints: Vec<JiraSprint>,
    active_issues: &[&str],
) -> JiraSprintObservation {
    let active = sprints
        .iter()
        .find(|sprint| sprint.state == JiraSprintState::Active)
        .cloned()
        .map(|sprint| {
            (
                sprint,
                JiraSearchResult {
                    issues: active_issues.iter().map(|key| issue(key)).collect(),
                    truncated: false,
                },
            )
        });
    JiraSprintObservation {
        boards: vec![JiraBoardSprints {
            board_id: 7,
            sprints: Some(sprints),
            truncated: false,
        }],
        active,
    }
}

/// The Project Manager Project of the delivery check tests, with a Jira Task
/// Source that selects board 7.
pub(crate) fn synced_project() -> (CoreRuntime, std::path::PathBuf, String) {
    let (mut runtime, root, project_id) =
        crate::runtime::delivery_check::tests::project_manager_runtime();
    let revision = runtime.state_revision();
    runtime
        .create_task_source(
            "source-1".into(),
            &project_id,
            "Pay Jira".into(),
            "https://example.atlassian.net".into(),
            "all",
            vec![TaskSourceBoardSelection {
                id: "7".into(),
                name: "Pay board".into(),
            }],
            vec![],
            None,
            "review",
            5,
            900,
            None,
            revision,
            10,
        )
        .unwrap();
    (runtime, root, project_id)
}

fn sprint_states(runtime: &CoreRuntime, project_id: &str) -> Vec<(String, SprintState, bool)> {
    runtime
        .store
        .project_sprints()
        .iter()
        .filter(|sprint| sprint.project_id == project_id)
        .map(|sprint| (sprint.name.clone(), sprint.state, sprint.jira.is_some()))
        .collect()
}

fn sprint_of(runtime: &CoreRuntime, task_id: &str) -> Option<String> {
    let sprint_id = runtime.store.task_tracking(task_id)?.sprint_id.clone()?;
    runtime
        .store
        .project_sprints()
        .iter()
        .find(|sprint| sprint.id == sprint_id)
        .map(|sprint| sprint.name.clone())
}

pub(crate) fn task_for(runtime: &CoreRuntime, key: &str) -> Option<String> {
    runtime
        .store
        .issue_links()
        .iter()
        .find(|link| link.external_ref == key)
        .map(|link| link.task_id.clone())
}

#[test]
fn jira_sprints_are_mirrored_and_their_active_issues_become_tracked_tasks() {
    let (mut runtime, root, project_id) = synced_project();
    let plan = runtime.plan_jira_sprint_sync(&project_id).unwrap();
    assert_eq!(plan.board_ids, [7]);
    assert!(runtime.delivery_facts_projects().contains(&project_id));
    let changed = runtime
        .apply_jira_sprint_sync(
            plan,
            Ok(observation(
                vec![
                    sprint(41, "Pay 41", JiraSprintState::Active),
                    sprint(42, "Pay 42", JiraSprintState::Future),
                ],
                &["PAY-1", "PAY-2"],
            )),
            100,
        )
        .unwrap();
    assert!(changed);
    // The local sprint stays but is no longer active beside Jira's.
    assert_eq!(
        sprint_states(&runtime, &project_id),
        [
            ("Sprint 1".into(), SprintState::Planned, false),
            ("Pay 41".into(), SprintState::Active, true),
            ("Pay 42".into(), SprintState::Planned, true),
        ]
    );
    let pay_1 = task_for(&runtime, "PAY-1").expect("a Task is copied from the issue");
    assert_eq!(sprint_of(&runtime, &pay_1).as_deref(), Some("Pay 41"));
    assert_eq!(runtime.task_record(&pay_1).unwrap().title, "PAY-1 summary");
    // A Task without a Jira link keeps the sprint the Project Manager gave it.
    assert_eq!(sprint_of(&runtime, "task-1").as_deref(), Some("Sprint 1"));
    let tracked = runtime
        .project_manager_tracked_tasks(&project_id)
        .into_iter()
        .map(|task| task.id)
        .collect::<Vec<_>>();
    assert_eq!(tracked.len(), 2);
    assert!(tracked.contains(&pay_1));

    let board = runtime.project_manager_board(&project_id);
    assert_eq!(board["sprintSync"]["sourceName"], "Pay Jira");
    assert_eq!(board["sprintSync"]["syncedAtEpochMs"], 100);
    assert_eq!(board["sprints"][1]["jira"]["sprintId"], 41);

    // Jira owns its sprints and the sprint list.
    let mirrored = board["sprints"][1]["id"].as_str().unwrap().to_owned();
    assert!(matches!(
        runtime.handle(
            "projectManager.sprintUpdate",
            json!({"sprintId": mirrored, "name": "Renamed", "state": "closed"}),
        ),
        Err(CoreError::CapabilityDenied)
    ));
    assert!(matches!(
        runtime.handle("projectManager.sprintDelete", json!({"sprintId": mirrored})),
        Err(CoreError::CapabilityDenied)
    ));
    assert!(matches!(
        runtime.handle(
            "projectManager.sprintCreate",
            json!({"projectId": project_id, "name": "Local"}),
        ),
        Err(CoreError::CapabilityDenied)
    ));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_later_read_follows_jira_and_an_unchanged_one_writes_nothing() {
    let (mut runtime, root, project_id) = synced_project();
    let sync = |runtime: &mut CoreRuntime, sprints, issues: &[&str], now| {
        let plan = runtime.plan_jira_sprint_sync(&project_id).unwrap();
        runtime
            .apply_jira_sprint_sync(plan, Ok(observation(sprints, issues)), now)
            .unwrap()
    };
    sync(
        &mut runtime,
        vec![
            sprint(41, "Pay 41", JiraSprintState::Active),
            sprint(42, "Pay 42", JiraSprintState::Future),
        ],
        &["PAY-1", "PAY-2"],
        100,
    );
    let pay_2 = task_for(&runtime, "PAY-2").unwrap();
    let revision = runtime.state_revision();
    assert!(!sync(
        &mut runtime,
        vec![
            sprint(41, "Pay 41", JiraSprintState::Active),
            sprint(42, "Pay 42", JiraSprintState::Future),
        ],
        &["PAY-1", "PAY-2"],
        200,
    ));
    assert_eq!(runtime.state_revision(), revision);

    // Sprint 41 completes in Jira; PAY-2 carries over into sprint 42 and
    // PAY-1 stays in the closed sprint.
    assert!(sync(
        &mut runtime,
        vec![sprint(42, "Pay 42", JiraSprintState::Active)],
        &["PAY-2", "PAY-3"],
        300,
    ));
    assert_eq!(
        sprint_states(&runtime, &project_id)
            .into_iter()
            .filter(|(_, _, mirrored)| *mirrored)
            .collect::<Vec<_>>(),
        [
            ("Pay 41".into(), SprintState::Closed, true),
            ("Pay 42".into(), SprintState::Active, true),
        ]
    );
    assert_eq!(sprint_of(&runtime, &pay_2).as_deref(), Some("Pay 42"));
    let pay_1 = task_for(&runtime, "PAY-1").unwrap();
    assert_eq!(sprint_of(&runtime, &pay_1).as_deref(), Some("Pay 41"));

    // An issue removed from the active sprint returns to the backlog.
    sync(
        &mut runtime,
        vec![sprint(42, "Pay 42", JiraSprintState::Active)],
        &["PAY-3"],
        400,
    );
    assert_eq!(sprint_of(&runtime, &pay_2), None);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_failed_or_stale_read_changes_nothing() {
    let (mut runtime, root, project_id) = synced_project();
    let plan = runtime.plan_jira_sprint_sync(&project_id).unwrap();
    assert!(
        !runtime
            .apply_jira_sprint_sync(plan, Err(TaskSourceFailure::CredentialsInvalid), 100)
            .unwrap()
    );
    let board = runtime.project_manager_board(&project_id);
    assert_eq!(board["sprintSync"]["failureReason"], "credentialsInvalid");
    assert_eq!(board["sprintSync"]["failedAtEpochMs"], 100);

    // A read planned before the source changed is dropped.
    let plan = runtime.plan_jira_sprint_sync(&project_id).unwrap();
    runtime
        .handle("projectManager.modeSet", json!({"enabled": false}))
        .unwrap();
    assert!(
        !runtime
            .apply_jira_sprint_sync(
                plan,
                Ok(observation(
                    vec![sprint(41, "Pay 41", JiraSprintState::Active)],
                    &["PAY-1"]
                )),
                200,
            )
            .unwrap()
    );
    assert!(task_for(&runtime, "PAY-1").is_none());
    assert!(runtime.plan_jira_sprint_sync(&project_id).is_none());
    std::fs::remove_dir_all(root).unwrap();
}
