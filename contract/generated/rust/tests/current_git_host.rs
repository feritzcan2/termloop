use serde_json::json;
use termloop_contract::current::{
    READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn git_host_projection_is_read_only_strict_and_provider_discriminated() {
    assert!(READ_ONLY_METHODS.contains(&"gitHost.pullRequestList"));
    assert!(validate_method_params(
        "gitHost.pullRequestList",
        &json!({"projectId":"project","taskIds":["task"]}),
    ));
    assert!(!validate_method_params(
        "gitHost.pullRequestList",
        &json!({"projectId":"project","taskIds":[]}),
    ));
    let projection = json!([{
        "usage":"displayOnly",
        "task_id":"task",
        "branch_name":"feature",
        "repository_provider":"github",
        "repository_host":"github.com",
        "repository_owner":"acme",
        "repository_project":null,
        "repository_name":"widget",
        "quality":"matches",
        "freshness":"fresh",
        "reason":null,
        "matches":[{
            "provider":"github",
            "host":"github.com",
            "repository_owner":"acme",
            "repository_project":null,
            "repository_name":"widget",
            "number":42,
            "title":"Safe title",
            "url":"https://github.com/acme/widget/pull/42",
            "state":"open",
            "merge_commit_oid":null,
            "base_branch":"main",
            "head_branch":"feature",
            "head_repository_owner":"acme",
            "head_repository_project":null,
            "head_repository_name":"widget",
            "check_rollup":"passing",
            "check_rollup_source":"githubStatusCheckRollup",
            "review_signal":"approved",
            "review_signal_source":"githubReviewDecision",
            "merge_conflict":"noneDetected",
            "merge_conflict_source":"githubMergeable",
            "activity_at_epoch_ms":1,
            "activity_at_source":"githubUpdatedAt"
        }],
        "truncated":false,
        "candidate_truncated":false,
        "freshness_generation":1,
        "last_success_observed_at_epoch_ms":1,
        "last_attempt_observed_at_epoch_ms":1
    }]);
    assert!(validate_method_result(
        "gitHost.pullRequestList",
        &projection
    ));
    let mut missing_usage = projection.clone();
    missing_usage[0].as_object_mut().unwrap().remove("usage");
    assert!(!validate_method_result(
        "gitHost.pullRequestList",
        &missing_usage
    ));
    let mut azure = projection.clone();
    azure[0]["repository_provider"] = json!("azureDevOps");
    azure[0]["repository_host"] = json!("dev.azure.com");
    azure[0]["repository_project"] = json!("Fiber Tests");
    let azure_match = json!({
        "provider":"azureDevOps", "host":"dev.azure.com",
        "repository_owner":"fiber-teams", "repository_project":"Fiber Tests", "repository_name":"widget",
        "number":42, "title":"Safe title",
        "url":"https://dev.azure.com/fiber-teams/Fiber%20Tests/_git/widget/pullrequest/42",
        "state":"open", "merge_commit_oid":null, "base_branch":"main", "head_branch":"feature",
        "head_repository_owner":"fiber-teams", "head_repository_project":"Forks", "head_repository_name":"widget-fork",
        "check_rollup":"unsupported", "check_rollup_source":"unsupported",
        "review_signal":"reviewRequired", "review_signal_source":"azureRequiredReviewerVotes",
        "merge_conflict":"unknown", "merge_conflict_source":"azureMergeStatus",
        "activity_at_epoch_ms":1, "activity_at_source":"azureLifecycleApproximation"
    });
    azure[0]["matches"]
        .as_array_mut()
        .unwrap()
        .push(azure_match);
    assert_eq!(azure[0]["matches"].as_array().unwrap().len(), 2);
    assert!(validate_method_result("gitHost.pullRequestList", &azure));

    let mut wrong_host = azure.clone();
    wrong_host[0]["matches"][1]["host"] = json!("github.com");
    assert!(!validate_method_result(
        "gitHost.pullRequestList",
        &wrong_host
    ));
    let mut missing_project = azure.clone();
    missing_project[0]["matches"][1]["repository_project"] = json!(null);
    assert!(!validate_method_result(
        "gitHost.pullRequestList",
        &missing_project
    ));
    let mut wrong_url = azure.clone();
    wrong_url[0]["matches"][1]["url"] = json!("https://github.com/acme/widget/pull/42");
    assert!(!validate_method_result(
        "gitHost.pullRequestList",
        &wrong_url
    ));
    let mut invented_azure_checks = azure.clone();
    invented_azure_checks[0]["matches"][1]["check_rollup"] = json!("passing");
    invented_azure_checks[0]["matches"][1]["check_rollup_source"] =
        json!("githubStatusCheckRollup");
    assert!(!validate_method_result(
        "gitHost.pullRequestList",
        &invented_azure_checks
    ));
    let mut wrong_task_identity = azure.clone();
    wrong_task_identity[0]["repository_host"] = json!("github.com");
    assert!(!validate_method_result(
        "gitHost.pullRequestList",
        &wrong_task_identity
    ));

    let mut gitlab = projection;
    gitlab[0]["matches"][0]["provider"] = json!("gitlab");
    assert!(!validate_method_result("gitHost.pullRequestList", &gitlab));
}

#[test]
fn git_host_change_content_is_full_control_only_and_provider_discriminated() {
    assert!(!READ_ONLY_METHODS.contains(&"gitHost.pullRequestChangeList"));
    assert!(!READ_ONLY_METHODS.contains(&"gitHost.pullRequestDiff"));
    let github = json!({
        "taskId":"task", "expectedFreshnessGeneration":7,
        "pullRequest": {"provider":"github", "repository_owner":"acme", "repository_project":null, "repository_name":"widget", "number":42}
    });
    assert!(validate_method_params(
        "gitHost.pullRequestChangeList",
        &github
    ));
    let mut wrong_github = github.clone();
    wrong_github["pullRequest"]["repository_project"] = json!("project");
    assert!(!validate_method_params(
        "gitHost.pullRequestChangeList",
        &wrong_github
    ));
    let azure = json!({
        "taskId":"task", "expectedFreshnessGeneration":7,
        "pullRequest": {"provider":"azureDevOps", "repository_owner":"valuespaces", "repository_project":"Nucleus", "repository_name":"Nucleus", "number":13632}
    });
    assert!(validate_method_params(
        "gitHost.pullRequestChangeList",
        &azure
    ));
    let mut wrong_azure = azure;
    wrong_azure["pullRequest"]["repository_project"] = json!(null);
    assert!(!validate_method_params(
        "gitHost.pullRequestChangeList",
        &wrong_azure
    ));
    assert!(validate_method_result(
        "gitHost.pullRequestDiff",
        &json!({"task_id":"task", "observation_id":"prc-1-1", "entry_id":"e-0", "state":"unavailable", "reason":"changed", "patch":null}),
    ));
}
