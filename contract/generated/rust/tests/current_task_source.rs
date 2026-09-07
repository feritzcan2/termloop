use serde_json::json;
use termloop_contract::current::{
    METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

fn source() -> serde_json::Value {
    json!({
        "id": "source-1",
        "projectId": "project-1",
        "provider": "jira",
        "name": "Assigned Jira work",
        "enabled": true,
        "generation": 1,
        "siteBaseUrl": "https://example.atlassian.net",
        "scopeKind": "assignedToMe",
        "boards": [],
        "statuses": [],
        "jql": null,
        "importPolicy": "review",
        "autoImportActiveTaskLimit": 5,
        "refreshIntervalSeconds": 900,
        "credentialState": "present",
        "runtimeState": "idle",
        "failureReason": null,
        "lastAttemptAtEpochMs": null,
        "lastSuccessfulAtEpochMs": null,
        "retryAfterEpochMs": null,
        "candidateCount": 0,
        "truncated": false,
        "createdAtEpochMs": 1,
        "updatedAtEpochMs": 1
    })
}

#[test]
fn task_source_methods_are_strict_and_only_reads_join_read_only_scope() {
    for method in [
        "taskSource.list",
        "taskSource.boardList",
        "taskSource.boardListStored",
        "taskSource.statusList",
        "taskSource.statusListStored",
        "taskSource.create",
        "taskSource.update",
        "taskSource.credentialsSet",
        "taskSource.delete",
        "taskSource.refresh",
        "taskSource.candidateList",
        "taskSource.candidateImport",
        "taskSource.candidateIgnore",
        "taskSource.candidateUnignore",
    ] {
        assert!(METHODS.contains(&method));
    }
    assert!(READ_ONLY_METHODS.contains(&"taskSource.list"));
    assert!(READ_ONLY_METHODS.contains(&"taskSource.candidateList"));
    assert!(!READ_ONLY_METHODS.contains(&"taskSource.boardList"));
    assert!(!READ_ONLY_METHODS.contains(&"taskSource.boardListStored"));
    assert!(!READ_ONLY_METHODS.contains(&"taskSource.statusList"));
    assert!(!READ_ONLY_METHODS.contains(&"taskSource.statusListStored"));
    assert!(!READ_ONLY_METHODS.contains(&"taskSource.create"));
    assert!(!READ_ONLY_METHODS.contains(&"taskSource.credentialsSet"));

    let assigned = json!({
        "projectId": "project-1",
        "name": "Assigned Jira work",
        "siteBaseUrl": "https://example.atlassian.net",
        "scopeKind": "assignedToMe",
        "boards": [],
        "statuses": [],
        "jql": null,
        "importPolicy": "review",
        "autoImportActiveTaskLimit": 5,
        "refreshIntervalSeconds": 900,
        "expectedRevision": 0
    });
    assert!(validate_method_params("taskSource.create", &assigned));
    let mut assigned_with_jql = assigned.clone();
    assigned_with_jql["jql"] = json!("project = TERM");
    assert!(!validate_method_params(
        "taskSource.create",
        &assigned_with_jql
    ));
    let mut insecure_site = assigned.clone();
    insecure_site["siteBaseUrl"] = json!("http://example.atlassian.net");
    assert!(!validate_method_params("taskSource.create", &insecure_site));
    assert!(validate_method_params(
        "taskSource.create",
        &json!({
            "projectId":"project-1", "name":"JQL", "siteBaseUrl":"https://example.atlassian.net",
            "scopeKind":"jql", "boards":[{"id":"84","name":"Payments"},{"id":"17","name":"Platform"}],
            "statuses":[],
            "jql":"project = TERM ORDER BY updated DESC",
            "importPolicy":"review",
            "autoImportActiveTaskLimit":5,
            "refreshIntervalSeconds":900, "expectedRevision":0
        })
    ));
    assert!(validate_method_params(
        "taskSource.create",
        &json!({
            "projectId":"project-1", "name":"Payments", "siteBaseUrl":"https://example.atlassian.net",
            "scopeKind":"assignedToMe", "boards":[{"id":"84","name":"Payments"}], "jql":null,
            "statuses":[{"id":"1","name":"Open"},{"id":"3","name":"In Progress"}],
            "importPolicy":"autoAdd",
            "autoImportActiveTaskLimit":5,
            "refreshIntervalSeconds":900, "expectedRevision":0
        })
    ));
    assert!(validate_method_params(
        "taskSource.create",
        &json!({
            "projectId":"project-1", "name":"All board issues", "siteBaseUrl":"https://example.atlassian.net",
            "scopeKind":"all", "boards":[{"id":"84","name":"Payments"}], "jql":null,
            "statuses":[],
            "importPolicy":"review",
            "autoImportActiveTaskLimit":5,
            "refreshIntervalSeconds":900, "expectedRevision":0
        })
    ));
    assert!(!validate_method_params(
        "taskSource.create",
        &json!({
            "projectId":"project-1", "name":"Legacy", "siteBaseUrl":"https://example.atlassian.net",
            "scopeKind":"board", "boards":[{"id":"84","name":"Payments"}], "jql":null,
            "statuses":[],
            "importPolicy":"review",
            "autoImportActiveTaskLimit":5,
            "refreshIntervalSeconds":900, "expectedRevision":0
        })
    ));
    assert!(validate_method_params(
        "taskSource.boardList",
        &json!({
            "siteBaseUrl":"https://example.atlassian.net",
            "email":"ada@example.com", "apiToken":"secret", "boardId":null
        })
    ));
    assert!(validate_method_params(
        "taskSource.boardList",
        &json!({
            "siteBaseUrl":"https://example.atlassian.net",
            "email":"ada@example.com", "apiToken":"secret", "boardId":"310"
        })
    ));
    assert!(validate_method_result(
        "taskSource.boardList",
        &json!({
            "boards":[{"id":"84","name":"Payments","kind":"scrum","locationName":"Money"}],
            "truncated":false,"failureReason":null
        })
    ));
    assert!(validate_method_params(
        "taskSource.boardListStored",
        &json!({
            "sourceId":"source-1", "siteBaseUrl":"https://example.atlassian.net",
            "expectedGeneration":1, "boardId":null
        })
    ));
    assert!(validate_method_result(
        "taskSource.boardListStored",
        &json!({
            "boards":[{"id":"84","name":"Payments","kind":"scrum","locationName":"Money"}],
            "truncated":false,"failureReason":null
        })
    ));
    assert!(validate_method_params(
        "taskSource.statusList",
        &json!({
            "siteBaseUrl":"https://example.atlassian.net",
            "email":"ada@example.com", "apiToken":"secret", "boardIds":["84","310"]
        })
    ));
    assert!(validate_method_params(
        "taskSource.statusListStored",
        &json!({
            "sourceId":"source-1", "siteBaseUrl":"https://example.atlassian.net",
            "expectedGeneration":1, "boardIds":["84"]
        })
    ));
    assert!(validate_method_result(
        "taskSource.statusList",
        &json!({
            "statuses":[{"id":"1","name":"Open"},{"id":"3","name":"In Progress"}],
            "failureReason":null
        })
    ));
    let mut statuses_without_board = assigned.clone();
    statuses_without_board["statuses"] = json!([{"id":"1","name":"Open"}]);
    assert!(!validate_method_params(
        "taskSource.create",
        &statuses_without_board
    ));
    let mut invalid_active_task_limit = assigned.clone();
    invalid_active_task_limit["autoImportActiveTaskLimit"] = json!(0);
    assert!(!validate_method_params(
        "taskSource.create",
        &invalid_active_task_limit
    ));
    invalid_active_task_limit["autoImportActiveTaskLimit"] = json!(51);
    assert!(!validate_method_params(
        "taskSource.create",
        &invalid_active_task_limit
    ));
    assert!(validate_method_params(
        "taskSource.candidateImport",
        &json!({
            "sourceId":"source-1", "externalId":"10042",
            "expectedGeneration":1, "expectedObservationSequence":1,
            "expectedRevision":1, "worktreeIntent":"provision",
            "worktreePrefix":"termloop", "baseRef":"refs/remotes/origin/development",
            "agentId":"codex",
            "model":"gpt-5.6-sol", "permission":"bypassPermissions",
            "reasoning":"high", "kickoffMessage":"Implement and verify."
        })
    ));
    assert!(validate_method_params(
        "taskSource.candidateImport",
        &json!({
            "sourceId":"source-1", "externalId":"10042",
            "expectedGeneration":1, "expectedObservationSequence":1,
            "expectedRevision":1, "worktreeIntent":"none",
            "worktreePrefix":null, "baseRef":null, "agentId":null,
            "model":null, "permission":null, "reasoning":null, "kickoffMessage":null
        })
    ));
    assert!(!validate_method_params(
        "taskSource.candidateImport",
        &json!({
            "sourceId":"source-1", "externalId":"10042",
            "expectedGeneration":1, "expectedObservationSequence":1,
            "expectedRevision":1, "worktreeIntent":"none",
            "worktreePrefix":null, "baseRef":null, "agentId":"codex",
            "model":"gpt-5.6-sol", "permission":"bypassPermissions",
            "reasoning":"high", "kickoffMessage":null
        })
    ));
}

#[test]
fn task_source_results_reject_invalid_scope_and_candidate_identity() {
    assert!(validate_method_result(
        "taskSource.list",
        &json!({"sources":[source()], "stateRevision":1, "observationSequence":0})
    ));
    let mut invalid_source = source();
    invalid_source["jql"] = json!("project = TERM");
    assert!(!validate_method_result(
        "taskSource.list",
        &json!({"sources":[invalid_source], "stateRevision":1, "observationSequence":0})
    ));

    let candidate = json!({
        "sourceId":"source-1", "externalId":"10042", "key":"TERM-42",
        "url":"https://example.atlassian.net/browse/TERM-42", "summary":"Ship Task Sources",
        "description":"Inbound Jira work", "statusName":"Open", "assigneeDisplay":"Ada",
        "updatedAt":"2026-08-26T10:00:00.000+0000", "state":"new", "taskId":null,
        "observedGeneration":1, "observationSequence":1
    });
    assert!(validate_method_result(
        "taskSource.candidateList",
        &json!({
            "sourceId":"source-1", "candidates":[candidate.clone()],
            "lastSuccessfulAtEpochMs":1, "stateRevision":1, "observationSequence":1
        })
    ));
    let mut configurable_key = candidate.clone();
    configurable_key["key"] = json!("team_2-42");
    configurable_key["url"] = json!("https://example.atlassian.net/browse/team_2-42");
    assert!(validate_method_result(
        "taskSource.candidateList",
        &json!({
            "sourceId":"source-1", "candidates":[configurable_key],
            "lastSuccessfulAtEpochMs":1, "stateRevision":1, "observationSequence":1
        })
    ));
    assert!(validate_method_result(
        "taskSource.refresh",
        &json!({
            "sourceId":"source-1", "refreshed":false,
            "failureReason":"rateLimited", "candidateCount":0,
            "truncated":false, "observationSequence":1
        })
    ));
    let mut possible_duplicate = candidate.clone();
    possible_duplicate["state"] = json!("possibleDuplicate");
    possible_duplicate["taskId"] = json!("task-legacy");
    assert!(validate_method_result(
        "taskSource.candidateList",
        &json!({
            "sourceId":"source-1", "candidates":[possible_duplicate],
            "lastSuccessfulAtEpochMs":1, "stateRevision":1, "observationSequence":1
        })
    ));
    let mut invalid_candidate = candidate;
    invalid_candidate["externalId"] = json!("not-numeric");
    assert!(!validate_method_result(
        "taskSource.candidateList",
        &json!({
            "sourceId":"source-1", "candidates":[invalid_candidate],
            "lastSuccessfulAtEpochMs":1, "stateRevision":1, "observationSequence":1
        })
    ));
}
