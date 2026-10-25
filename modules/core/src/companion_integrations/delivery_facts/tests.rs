use super::*;
use serde_json::json;
use termloop_providers::{GitHostProvider, JiraIssueSnapshot, Mergeability, ReviewState};

fn summary(number: u64, state: PullRequestState, merge_commit: Option<&str>) -> PullRequestSummary {
    PullRequestSummary {
        provider: GitHostProvider::Github,
        host: "github.com".into(),
        repository_owner: "acme".into(),
        repository_project: None,
        repository_name: "pay".into(),
        number,
        title: format!("PAY-42 change {number}"),
        url: format!("https://github.com/acme/pay/pull/{number}"),
        state,
        merge_commit_oid: merge_commit.map(str::to_owned),
        base_branch: "main".into(),
        head_branch: "feature/PAY-42-cors".into(),
        head_repository_owner: "acme".into(),
        head_repository_project: None,
        head_repository_name: "pay".into(),
        checks: CheckState::Passing,
        review: ReviewState::Approved,
        mergeability: Mergeability::Mergeable,
        updated_at_epoch_ms: number,
    }
}

fn issue(key: &str, status: &str) -> JiraIssueSnapshot {
    JiraIssueSnapshot {
        external_id: "10042".into(),
        key: key.into(),
        url: format!("https://example.atlassian.net/browse/{key}"),
        summary: "Restrict CORS origins".into(),
        description: None,
        status_name: status.into(),
        status_category: None,
        assignee_display: Some("Ada Lovelace".into()),
        updated_at: "2026-10-24T09:00:00.000+0000".into(),
    }
}

/// A Project Manager Project whose active sprint holds one Task copied from
/// PAY-42, and one Task without a Jira link.
fn tracked_project() -> (CoreRuntime, std::path::PathBuf, String, String) {
    let (mut runtime, root, project_id) =
        crate::runtime::delivery_check::tests::project_manager_runtime();
    let sprint_id = runtime.project_manager_board(&project_id)["sprints"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let created = runtime
        .handle(
            "projectManager.taskCreate",
            json!({
                "projectId": project_id,
                "title": "Restrict CORS origins",
                "jiraUrl": "https://example.atlassian.net/browse/PAY-42",
                "sprintId": sprint_id,
            }),
        )
        .unwrap();
    let task_id = created["task"]["id"].as_str().unwrap().to_owned();
    (runtime, root, project_id, task_id)
}

#[test]
fn a_read_records_jira_and_pull_request_facts_and_keeps_them_through_a_failure() {
    let (mut runtime, root, project_id, task_id) = tracked_project();
    assert_eq!(
        runtime.delivery_facts_projects(),
        std::slice::from_ref(&project_id)
    );
    let plan = runtime.plan_delivery_facts_read(&project_id).unwrap();
    // Only the Task with a Jira key is read; no Task Source means no Jira read.
    assert_eq!(plan.tasks, [(task_id.clone(), "PAY-42".to_owned())]);
    assert!(plan.jira.is_none());
    let changed = runtime
        .apply_delivery_facts_read(
            plan,
            Some(Ok(JiraSearchResult {
                issues: vec![issue("PAY-42", "In Review")],
                truncated: false,
            })),
            PullRequestFactsRead {
                result: Ok((
                    "github.com/acme/pay".into(),
                    vec![(
                        task_id.clone(),
                        Ok(IssueKeyPullRequests {
                            pull_requests: vec![
                                summary(7, PullRequestState::Merged, Some("abc1234def")),
                                summary(9, PullRequestState::Open, None),
                            ],
                            truncated: false,
                        }),
                    )],
                )),
            },
            100,
        )
        .unwrap();
    assert!(changed);
    let facts = runtime
        .store
        .task_delivery_facts_for(&task_id)
        .unwrap()
        .clone();
    let jira = facts.jira.as_ref().unwrap();
    assert_eq!(jira.status, "In Review");
    assert_eq!(jira.assignee.as_deref(), Some("Ada Lovelace"));
    let pull_requests = facts.pull_requests.as_ref().unwrap();
    assert_eq!(pull_requests.repository, "github.com/acme/pay");
    assert_eq!(pull_requests.items.len(), 2);
    assert_eq!(facts.merged_commit(), Some("abc1234def"));

    // A failed read keeps the last good facts and says why it failed.
    let plan = runtime.plan_delivery_facts_read(&project_id).unwrap();
    runtime
        .apply_delivery_facts_read(
            plan,
            Some(Err(TaskSourceFailure::CredentialsInvalid)),
            PullRequestFactsRead {
                result: Err(GitHostProjectionReason::NoRemote),
            },
            200,
        )
        .unwrap();
    let facts = runtime.store.task_delivery_facts_for(&task_id).unwrap();
    assert_eq!(facts.jira.as_ref().unwrap().status, "In Review");
    assert_eq!(facts.pull_requests.as_ref().unwrap().items.len(), 2);
    let reasons = facts
        .read_failures
        .iter()
        .map(|failure| (failure.source, failure.reason.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        reasons,
        [
            (FactSource::Jira, "credentialsInvalid"),
            (FactSource::GitHost, "noRemote")
        ]
    );
    let board = runtime.project_manager_board(&project_id);
    let task_facts = board["facts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|facts| facts["taskId"] == task_id.as_str())
        .unwrap();
    assert_eq!(task_facts["jira"]["status"], "In Review");
    assert_eq!(task_facts["readFailures"].as_array().unwrap().len(), 2);
    // The board derives the Task's risks from those facts as of now: both
    // reads failed, and the epoch-old pull requests stalled and never shipped.
    let risks = board["risks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|risk| risk["taskId"] == task_id.as_str())
        .map(|risk| risk["kind"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        risks,
        [
            "readFailed",
            "readFailed",
            "reviewStalled",
            "mergedNotDeployed"
        ]
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_read_never_writes_a_task_that_left_the_sprint_while_it_ran() {
    let (mut runtime, root, project_id, task_id) = tracked_project();
    let plan = runtime.plan_delivery_facts_read(&project_id).unwrap();
    runtime
        .handle(
            "projectManager.taskTrackingSet",
            json!({"taskId": task_id, "sprintId": null}),
        )
        .unwrap();
    let changed = runtime
        .apply_delivery_facts_read(
            plan,
            Some(Ok(JiraSearchResult {
                issues: vec![issue("PAY-42", "Done")],
                truncated: false,
            })),
            PullRequestFactsRead {
                result: Ok(("github.com/acme/pay".into(), Vec::new())),
            },
            100,
        )
        .unwrap();
    assert!(!changed);
    assert!(runtime.store.task_delivery_facts_for(&task_id).is_none());
    // A Developer Project is never read.
    runtime
        .handle("projectManager.modeSet", json!({"enabled": false}))
        .unwrap();
    assert!(runtime.plan_delivery_facts_read(&project_id).is_none());
    assert!(runtime.delivery_facts_projects().is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn jira_keys_are_read_in_one_query() {
    assert_eq!(
        jira_keys_jql(["PAY-1", "PAY-22"].into_iter()),
        "key in (PAY-1, PAY-22)"
    );
}
