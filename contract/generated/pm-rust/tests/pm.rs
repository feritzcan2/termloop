use serde_json::json;
use termloop_pm_contract::pm::{
    CAPABILITY_SCOPE, CONTRACT_IDENTITY, ControlRequest, EVENTS, METHODS, PmJiraApplyResult,
    validate_event_payload, validate_method_params, validate_method_result,
};

fn ticket() -> serde_json::Value {
    json!({
        "id": "t1", "projectId": "p1", "title": "Add login", "description": "",
        "status": "todo", "priority": "medium", "assignee": null, "sprintId": null,
        "rank": -3, "jiraUrl": "https://acme.atlassian.net/browse/PAY-42",
        "jiraSprintId": null, "jiraPulledAtEpochMs": null, "carryOverCount": 0,
        "blockers": [], "acceptanceCriteria": [{"id": "c1", "text": "Logs in", "done": false}],
        "versions": null, "createdAtEpochMs": 1, "updatedAtEpochMs": 2
    })
}

#[test]
fn surface_is_one_full_scope_over_every_method() {
    assert_eq!(CAPABILITY_SCOPE, "pm.full");
    assert!(CONTRACT_IDENTITY.starts_with("sha256:") && CONTRACT_IDENTITY.len() == 71);
    assert_eq!(METHODS.len(), 43);
    assert!(METHODS.iter().all(|method| method.starts_with("pm_")));
    assert_eq!(
        EVENTS,
        [
            "pmBoardChanged",
            "pmAgentChanged",
            "pmCheckChanged",
            "pmJiraPulled"
        ]
    );
}

#[test]
fn envelope_rejects_unknown_fields_and_methods_reject_unknown_names() {
    let request = json!({
        "id": "1", "protocolVersion": CONTRACT_IDENTITY, "token": "x".repeat(64),
        "method": "pm_board_read", "params": {"projectId": "p1"}, "unexpected": true
    });
    assert!(serde_json::from_value::<ControlRequest>(request).is_err());
    assert!(!validate_method_params("project.list", &json!({})));
    assert!(validate_method_params("pm_project_list", &json!({})));
    assert!(!validate_method_params(
        "pm_project_list",
        &json!({"extra": 1})
    ));
}

#[test]
fn jira_links_are_only_secret_free_browse_urls() {
    assert!(validate_method_result("pm_ticket_create", &ticket()));
    for url in [
        "http://acme.atlassian.net/browse/PAY-42",
        "https://user:token@acme.atlassian.net/browse/PAY-42",
        "https://acme.atlassian.net/browse/PAY-42?token=secret",
        "https://acme.atlassian.net/browse/PAY-42#x",
    ] {
        let mut copy = ticket();
        copy["jiraUrl"] = json!(url);
        assert!(!validate_method_result("pm_ticket_create", &copy), "{url}");
    }
    let source = |site: &str| {
        json!({"projectId": "p1", "github": null, "jira": {
            "siteUrl": site, "boardId": 84, "accountEmail": "ada@acme.example",
            "credentialHandle": "jira-acme"
        }})
    };
    assert!(validate_method_params(
        "pm_sources_set",
        &source("https://acme.atlassian.net")
    ));
    assert!(!validate_method_params(
        "pm_sources_set",
        &source("https://acme.atlassian.net/")
    ));
    assert!(!validate_method_params(
        "pm_sources_set",
        &source("https://u:t@acme.atlassian.net")
    ));
}

#[test]
fn credentials_are_write_only_and_return_a_handle() {
    assert!(validate_method_params(
        "pm_credential_store",
        &json!({"kind": "jiraApiToken", "secret": "s3cret"})
    ));
    assert!(!validate_method_params(
        "pm_credential_store",
        &json!({"kind": "jiraApiToken", "secret": ""})
    ));
    assert!(validate_method_result(
        "pm_credential_store",
        &json!({"credentialHandle": "jira-acme"})
    ));
    assert!(!validate_method_result(
        "pm_credential_store",
        &json!({"credentialHandle": "jira-acme", "secret": "s3cret"})
    ));
}

#[test]
fn jira_apply_is_applied_stale_or_failed() {
    let applied = json!({"kind": "applied", "changes": [{"field": "summary", "jira": "Old", "ticket": "New"}]});
    assert!(validate_method_result("pm_jira_apply", &applied));
    assert!(matches!(
        serde_json::from_value::<PmJiraApplyResult>(applied).unwrap(),
        PmJiraApplyResult::Applied { .. }
    ));
    assert!(validate_method_result(
        "pm_jira_apply",
        &json!({"kind": "failed", "applied": [], "reason": "unauthorized"})
    ));
    assert!(!validate_method_result(
        "pm_jira_apply",
        &json!({"kind": "failed", "applied": [], "reason": "token expired"})
    ));
    assert!(!validate_method_params(
        "pm_jira_apply",
        &json!({"ticketId": "t1", "token": "short"})
    ));
}

#[test]
fn events_carry_bounded_payloads() {
    assert!(validate_event_payload(
        "pmBoardChanged",
        &json!({"projectId": "p1"})
    ));
    assert!(!validate_event_payload("pmBoardChanged", &json!({})));
    assert!(validate_event_payload(
        "pmJiraPulled",
        &json!({"projectId": "p1", "outcome": "stale"})
    ));
    assert!(!validate_event_payload(
        "projection.invalidated",
        &json!({})
    ));
}
