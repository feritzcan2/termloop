use serde_json::json;
use termloop_providers::{JiraIssueText, JiraSprintState};

use super::super::jira_sprints::tests::{observation, sprint, synced_project, task_for};
use crate::TaskSourceFailure;
use crate::{CoreError, CoreRuntime, JiraIssueWrite, JiraIssueWriteOutcome, JiraWriteFailure};

/// The synced Project with PAY-42 copied from Jira's active sprint, and the
/// Task it became.
fn linked_task() -> (CoreRuntime, std::path::PathBuf, String, String) {
    let (mut runtime, root, project_id) = synced_project();
    let plan = runtime.plan_jira_sprint_sync(&project_id).unwrap();
    runtime
        .apply_jira_sprint_sync(
            plan,
            Ok(observation(
                vec![
                    sprint(31, "Sprint 31", JiraSprintState::Active),
                    sprint(32, "Sprint 32", JiraSprintState::Future),
                ],
                &["PAY-42"],
            )),
            10,
        )
        .unwrap();
    let task_id = task_for(&runtime, "PAY-42").unwrap();
    (runtime, root, project_id, task_id)
}

fn local_sprint(runtime: &CoreRuntime, name: &str) -> String {
    runtime
        .store
        .project_sprints()
        .iter()
        .find(|sprint| sprint.name == name)
        .unwrap()
        .id
        .clone()
}

#[test]
fn a_reviewed_ticket_version_is_planned_as_wiki_for_its_issue() {
    let (mut runtime, root, project_id, task_id) = linked_task();
    let read = runtime
        .plan_jira_issue_write(
            "projectManager.jiraIssueRead",
            &json!({"projectId": project_id, "taskId": task_id}),
        )
        .unwrap();
    assert_eq!(read.issue_key, "PAY-42");
    assert_eq!(read.source_id, "source-1");
    assert_eq!(read.write, JiraIssueWrite::Read);

    let push = |runtime: &CoreRuntime, version: u64| {
        runtime.plan_jira_issue_write(
            "projectManager.jiraIssuePush",
            &json!({"projectId": project_id, "taskId": task_id, "expectedTicketVersion": version, "expectedJiraUpdated": "u1"}),
        )
    };
    // A ticket never saved in TermLoop has nothing of the Project Manager's
    // to push.
    assert!(matches!(
        push(&runtime, 1),
        Err(CoreError::InvalidParams(_))
    ));
    let saved = runtime
        .handle(
            "projectManager.ticketSave",
            json!({"taskId": task_id, "title": "Retry checkout", "brief": "## Goal\n- Retry **once**", "expectedVersion": 0}),
        )
        .unwrap();
    let version = saved["version"].as_u64().unwrap();
    assert!(matches!(
        push(&runtime, version - 1),
        Err(CoreError::RevisionConflict)
    ));
    assert_eq!(
        push(&runtime, version).unwrap().write,
        JiraIssueWrite::Update {
            summary: "Retry checkout".into(),
            description: "h2. Goal\n* Retry *once*".into(),
            expected_updated: "u1".into(),
        }
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_sprint_move_names_a_mirrored_sprint_or_the_backlog() {
    let (runtime, root, project_id, task_id) = linked_task();
    let move_to = |sprint_id: serde_json::Value| {
        runtime.plan_jira_issue_write(
            "projectManager.jiraSprintMove",
            &json!({"projectId": project_id, "taskId": task_id, "sprintId": sprint_id}),
        )
    };
    let next = local_sprint(&runtime, "Sprint 32");
    assert_eq!(
        move_to(json!(next)).unwrap().write,
        JiraIssueWrite::Move {
            sprint_id: Some(32)
        }
    );
    assert_eq!(
        move_to(json!(null)).unwrap().write,
        JiraIssueWrite::Move { sprint_id: None }
    );
    // The local sprint of the fixture is no Jira sprint.
    let local = local_sprint(&runtime, "Sprint 1");
    assert!(matches!(
        move_to(json!(local)),
        Err(CoreError::InvalidParams(_))
    ));
    assert!(matches!(
        move_to(json!(7)),
        Err(CoreError::InvalidParams(_))
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_task_without_jira_or_outside_the_project_is_refused() {
    let (runtime, root, project_id, _) = linked_task();
    assert!(matches!(
        runtime.plan_jira_issue_write(
            "projectManager.jiraIssueRead",
            &json!({"projectId": project_id, "taskId": "task-1"}),
        ),
        Err(CoreError::InvalidParams(_))
    ));
    assert!(matches!(
        runtime.plan_jira_issue_write(
            "projectManager.jiraIssueRead",
            &json!({"projectId": project_id, "taskId": "missing"}),
        ),
        Err(CoreError::NotFound)
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn results_carry_the_issue_or_the_failure_and_the_board() {
    let (runtime, root, project_id, task_id) = linked_task();
    let plan = runtime
        .plan_jira_issue_write(
            "projectManager.jiraIssueRead",
            &json!({"projectId": project_id, "taskId": task_id}),
        )
        .unwrap();
    let issue = JiraIssueText {
        key: "PAY-42".into(),
        summary: "Checkout".into(),
        description: Some("h2. Goal".into()),
        updated: "u2".into(),
    };
    let changed =
        runtime.jira_issue_write_result(&plan, &JiraIssueWriteOutcome::JiraChanged(issue));
    assert_eq!(changed["outcome"], "jiraChanged");
    assert_eq!(changed["issue"]["updated"], "u2");
    assert_eq!(changed["board"]["projectId"], project_id.as_str());
    let failed = runtime.jira_issue_write_result(
        &plan,
        &JiraIssueWriteOutcome::Failed(JiraWriteFailure::Forbidden),
    );
    assert_eq!(failed["failureReason"], "forbidden");
    assert_eq!(failed["issue"], serde_json::Value::Null);
    let missing = runtime.jira_issue_write_result(
        &plan,
        &JiraIssueWriteOutcome::Failed(JiraWriteFailure::Source(
            TaskSourceFailure::CredentialsMissing,
        )),
    );
    assert_eq!(missing["failureReason"], "credentialsMissing");
    let _ = std::fs::remove_dir_all(root);
}
