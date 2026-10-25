//! Daemon-level tests: control authentication and dispatch, absent-vs-null
//! updates, event fan-out, credential handles, MCP tool denial, the
//! one-check-per-ticket rule, and skills.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use termloop_platform::test_support::MemorySecureCredentialStore;
use termloop_pm::agent::PmAgentMode;
use termloop_pm::{DeliveryCheck, DeliveryCheckReason, NewCheck, PmStore};
use termloop_pm_contract::pm::{
    CONTRACT_IDENTITY, ControlRequest, ErrorCode, EventName, PmJiraFailure, PmJiraSearchParams,
    ProtocolError, ProtocolErrorDetails, validate_method_result,
};
use termloop_providers::{JiraIssueDetails, JiraIssueSnapshot, JiraListedIssue};
use termloop_terminal::TerminalService;
use tokio::sync::{Notify, broadcast};

use super::agents::{AgentRecord, AgentRegistry};
use super::control::errors::ControlError;
use super::control::{decode_request, run_request};
use super::scheduler::{self, Refusal};
use super::{AppState, Store, mcp, owners, skills};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct Fixture {
    state: AppState,
    credentials: Arc<MemorySecureCredentialStore>,
    directory: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn fixture() -> Fixture {
    let directory =
        std::env::temp_dir().join(format!("termloop-pm-daemon-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let store_path = directory.join("pm.sqlite");
    let store = PmStore::open(&store_path).unwrap();
    let credentials = Arc::new(MemorySecureCredentialStore::default());
    let (events, _) = broadcast::channel(64);
    let state = AppState {
        store: Store::new(store, Some(store_path)),
        token: Arc::from(TOKEN),
        events,
        credentials: credentials.clone(),
        terminal: TerminalService::with_process_registry(directory.join("pty")),
        runtime_epoch: 7,
        agents: AgentRegistry::default(),
        mcp_endpoint: Arc::from("http://127.0.0.1:1/mcp"),
        daemon_directory: Arc::new(directory.clone()),
        provider_directory: Arc::new(directory.join("provider")),
        fact_refresh: Arc::new(Notify::new()),
    };
    Fixture {
        state,
        credentials,
        directory,
    }
}

fn request_text(method: &str, params: Value, token: &str) -> String {
    json!({
        "id": "r1",
        "protocolVersion": CONTRACT_IDENTITY,
        "token": token,
        "method": method,
        "params": params,
    })
    .to_string()
}

async fn call(state: &AppState, method: &str, params: Value) -> Result<Value, ErrorCode> {
    let request: ControlRequest = decode_request(&request_text(method, params, TOKEN), TOKEN)
        .unwrap_or_else(|reply| panic!("{method} was rejected: {reply:?}"));
    let reply = run_request(state, &request).await;
    match reply.error {
        Some(error) => Err(error.code),
        None => Ok(reply.result.unwrap()),
    }
}

async fn project(state: &AppState) -> String {
    let project = call(state, "pm_project_create", json!({ "name": "Shop" }))
        .await
        .unwrap();
    project["id"].as_str().unwrap().to_owned()
}

async fn ticket(state: &AppState, project_id: &str, extra: Value) -> Value {
    let mut params = json!({ "projectId": project_id, "title": "Checkout" });
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    call(state, "pm_ticket_create", params).await.unwrap()
}

fn rejected_code(text: &str) -> ErrorCode {
    let reply = decode_request(text, TOKEN).expect_err("the request must be rejected");
    reply.error.unwrap().code
}

#[test]
fn a_request_without_the_bearer_never_reaches_dispatch() {
    let wrong = "f".repeat(64);
    assert_eq!(
        rejected_code(&request_text("pm_system_version", json!({}), &wrong)),
        ErrorCode::Unauthenticated
    );
    assert_eq!(
        rejected_code(&request_text("pm_system_version", json!({}), "")),
        ErrorCode::Unauthenticated
    );
    // The bearer is checked before the method, so an unauthenticated
    // caller cannot probe which methods exist.
    assert_eq!(
        rejected_code(&request_text("pm_no_such_method", json!({}), &wrong)),
        ErrorCode::Unauthenticated
    );
    assert!(decode_request(&request_text("pm_system_version", json!({}), TOKEN), TOKEN).is_ok());
}

#[test]
fn an_unknown_method_and_bad_params_are_typed_errors() {
    assert_eq!(
        rejected_code(&request_text("pm_no_such_method", json!({}), TOKEN)),
        ErrorCode::MethodNotFound
    );
    assert_eq!(
        rejected_code(&request_text(
            "pm_board_read",
            json!({ "projectId": 3 }),
            TOKEN
        )),
        ErrorCode::InvalidParams
    );
    assert_eq!(rejected_code("not json"), ErrorCode::InvalidMessage);
}

#[tokio::test]
async fn a_project_code_folder_must_exist_and_can_be_cleared() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let folder = fixture.directory.join("code");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.to_str().unwrap();
    let set = call(
        state,
        "pm_project_update",
        json!({ "projectId": project_id, "folder": folder }),
    )
    .await
    .unwrap();
    assert_eq!(set["folder"], folder);
    let missing = fixture.directory.join("missing");
    assert_eq!(
        call(
            state,
            "pm_project_update",
            json!({ "projectId": project_id, "folder": missing.to_str().unwrap() }),
        )
        .await,
        Err(ErrorCode::InvalidParams)
    );
    assert_eq!(
        call(
            state,
            "pm_project_update",
            json!({ "projectId": "missing", "folder": null }),
        )
        .await,
        Err(ErrorCode::NotFound)
    );
    let cleared = call(
        state,
        "pm_project_update",
        json!({ "projectId": project_id, "folder": null }),
    )
    .await
    .unwrap();
    assert_eq!(cleared["folder"], Value::Null);
}

#[tokio::test]
async fn an_absent_field_keeps_its_value_and_null_clears_it() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let url = "https://acme.atlassian.net/browse/PM-12";
    let created = ticket(
        state,
        &project_id,
        json!({ "jiraUrl": url, "assignee": "ada" }),
    )
    .await;
    let ticket_id = created["id"].as_str().unwrap();

    let renamed = call(
        state,
        "pm_ticket_update",
        json!({ "ticketId": ticket_id, "title": "Pay" }),
    )
    .await
    .unwrap();
    assert_eq!(renamed["title"], "Pay");
    assert_eq!(renamed["jiraUrl"], url);
    assert_eq!(renamed["assignee"], "ada");

    let cleared = call(
        state,
        "pm_ticket_update",
        json!({ "ticketId": ticket_id, "jiraUrl": null, "assignee": null }),
    )
    .await
    .unwrap();
    assert_eq!(cleared["title"], "Pay");
    assert!(cleared.get("jiraUrl").is_none_or(Value::is_null));
    assert!(cleared.get("assignee").is_none_or(Value::is_null));
}

#[tokio::test]
async fn a_mutation_fans_out_a_board_event() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let mut first = state.events.subscribe();
    let mut second = state.events.subscribe();
    ticket(state, &project_id, json!({})).await;
    for receiver in [&mut first, &mut second] {
        let event = receiver
            .try_recv()
            .expect("each subscriber receives the event");
        assert_eq!(event.event, EventName::PmBoardChanged);
        assert_eq!(event.payload, json!({ "projectId": project_id }));
    }
    // A read publishes nothing.
    call(state, "pm_board_read", json!({ "projectId": project_id }))
        .await
        .unwrap();
    assert!(first.try_recv().is_err());
}

#[tokio::test]
async fn the_pm_records_and_removes_ticket_notes() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let work = ticket(state, &project_id, json!({})).await;
    let ticket_id = work["id"].as_str().unwrap();
    let mut events = state.events.subscribe();
    let note = call(
        state,
        "pm_ticket_note_add",
        json!({ "ticketId": ticket_id, "kind": "fact", "text": "  CSV export too  " }),
    )
    .await
    .unwrap();
    assert_eq!(note["text"], "CSV export too");
    assert_eq!(note["author"], "pm");
    assert_eq!(note["pending"], true);
    assert_eq!(events.try_recv().unwrap().event, EventName::PmBoardChanged);
    assert_eq!(
        call(
            state,
            "pm_ticket_note_add",
            json!({ "ticketId": ticket_id, "kind": "source", "text": "Slack thread" }),
        )
        .await,
        Err(ErrorCode::InvalidParams)
    );
    call(
        state,
        "pm_ticket_note_add",
        json!({
            "ticketId": ticket_id,
            "kind": "source",
            "text": "Slack thread",
            "url": "https://acme.slack.com/archives/C1/p100",
        }),
    )
    .await
    .unwrap();
    let read = call(
        state,
        "pm_ticket_notes_read",
        json!({ "ticketId": ticket_id }),
    )
    .await
    .unwrap();
    assert_eq!(read["notes"].as_array().unwrap().len(), 2);

    let removed = call(
        state,
        "pm_ticket_note_remove",
        json!({ "noteId": note["id"] }),
    )
    .await
    .unwrap();
    assert_eq!(removed, json!({ "deleted": true }));
    assert_eq!(
        call(
            state,
            "pm_ticket_note_remove",
            json!({ "noteId": note["id"] })
        )
        .await,
        Err(ErrorCode::NotFound)
    );
    assert_eq!(
        call(
            state,
            "pm_ticket_notes_read",
            json!({ "ticketId": "missing" })
        )
        .await,
        Err(ErrorCode::NotFound)
    );
}

#[tokio::test]
async fn a_description_update_needs_the_ticket_in_focus() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    assert_eq!(
        call(
            state,
            "pm_agent_launch",
            json!({ "projectId": project_id, "task": "updateDescription" }),
        )
        .await,
        Err(ErrorCode::InvalidParams)
    );
}

fn file_contains(path: &Path, needle: &[u8]) -> bool {
    std::fs::read(path)
        .map(|bytes| bytes.windows(needle.len()).any(|window| window == needle))
        .unwrap_or(false)
}

#[tokio::test]
async fn a_stored_credential_returns_only_a_handle_and_stays_out_of_the_pm_store() {
    let fixture = fixture();
    let state = &fixture.state;
    let secret = "ATATT3xFfGF0-very-secret-jira-token";
    let result = call(
        state,
        "pm_credential_store",
        json!({ "kind": "jiraApiToken", "secret": secret }),
    )
    .await
    .unwrap();
    let object = result.as_object().unwrap();
    assert_eq!(object.keys().collect::<Vec<_>>(), ["credentialHandle"]);
    let handle = object["credentialHandle"].as_str().unwrap();
    assert!(!result.to_string().contains(secret));
    assert_eq!(
        super::credentials::resolve(&*fixture.credentials, handle)
            .unwrap()
            .expose(),
        secret
    );
    drop(state.store.lock());
    for name in ["pm.sqlite", "pm.sqlite-wal"] {
        assert!(!file_contains(
            &fixture.directory.join(name),
            secret.as_bytes()
        ));
    }

    let cleared = call(
        state,
        "pm_credential_clear",
        json!({ "credentialHandle": handle }),
    )
    .await
    .unwrap();
    assert_eq!(cleared, json!({ "cleared": true }));
    assert!(super::credentials::resolve(&*fixture.credentials, handle).is_err());
}

fn register_agent(state: &AppState, project_id: &str, mode: PmAgentMode, bearer: &str) {
    state.agents.insert(AgentRecord::new(
        "session-1".to_owned(),
        project_id.to_owned(),
        mode,
        "claude".to_owned(),
        None,
        None,
        bearer.to_owned(),
    ));
}

async fn mcp_call(state: &AppState, bearer: &str, name: &str) -> Value {
    let message = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": {} },
    });
    mcp::handle_message(state, bearer, &message, true)
        .await
        .expect("the bearer is known")
        .expect("a request gets a reply")
}

#[tokio::test]
async fn mcp_denies_a_tool_outside_the_agents_mode() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let bearer = "a".repeat(64);
    register_agent(state, &project_id, PmAgentMode::Assistant, &bearer);

    let denied = mcp_call(state, &bearer, termloop_pm::agent::PM_CHECK_REPORT).await;
    assert_eq!(denied["result"]["isError"], true);
    assert_eq!(denied["result"]["structuredContent"]["code"], "denied");

    let listed = mcp::handle_message(
        state,
        &bearer,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        true,
    )
    .await
    .unwrap()
    .unwrap();
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&termloop_pm::agent::PM_CHECK_REPORT));

    let read = mcp_call(state, &bearer, termloop_pm::agent::PM_BOARD_READ).await;
    assert_eq!(read["result"]["isError"], false);

    // Another bearer is not an agent at all.
    assert!(
        mcp::handle_message(state, &"b".repeat(64), &json!({}), true)
            .await
            .is_err()
    );
}

fn launched(_: &AppState, _: &DeliveryCheck) -> Result<String, ControlError> {
    Ok("session-check".to_owned())
}

#[tokio::test]
async fn the_check_scheduler_starts_at_most_one_check_per_ticket() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    call(
        state,
        "pm_environments_set",
        json!({ "projectId": project_id, "environments": [{ "name": "prod", "production": true }] }),
    )
    .await
    .unwrap();
    let ticket_id = ticket(state, &project_id, json!({})).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let new = || NewCheck {
        ticket_id: ticket_id.clone(),
        reason: DeliveryCheckReason::Requested,
        environments: vec!["prod".to_owned()],
        probe_id: None,
    };

    let first = scheduler::start_check(state, &project_id, new(), launched).unwrap();
    assert!(first.is_running());
    assert_eq!(
        scheduler::start_check(state, &project_id, new(), launched).unwrap_err(),
        Refusal::AlreadyRunning
    );
    scheduler::check_tick(state, launched).await;
    let running = state
        .store
        .lock()
        .delivery_checks(&project_id)
        .unwrap()
        .into_iter()
        .filter(|check| check.ticket_id == ticket_id && check.is_running())
        .count();
    assert_eq!(running, 1);

    // A ticket of another project is refused as not found.
    let other = call(state, "pm_project_create", json!({ "name": "Other" }))
        .await
        .unwrap();
    assert_eq!(
        scheduler::start_check(state, other["id"].as_str().unwrap(), new(), launched).unwrap_err(),
        Refusal::NotFound
    );
}

#[tokio::test]
async fn settings_are_checked_against_the_agent_catalog() {
    let fixture = fixture();
    let state = &fixture.state;
    let defaults = call(state, "pm_settings_read", json!({})).await.unwrap();
    assert_eq!(defaults["checkPermission"], "bypassPermissions");
    assert_eq!(
        call(
            state,
            "pm_settings_update",
            json!({ "checkPermission": "default" })
        )
        .await,
        Err(ErrorCode::InvalidParams)
    );
    assert_eq!(
        call(
            state,
            "pm_settings_update",
            json!({ "agentModel": "no-such-model" })
        )
        .await,
        Err(ErrorCode::InvalidParams)
    );
    let updated = call(
        state,
        "pm_settings_update",
        json!({ "assistantPermission": "plan" }),
    )
    .await
    .unwrap();
    assert_eq!(updated["assistantPermission"], "plan");
    assert_eq!(
        call(state, "pm_settings_read", json!({})).await.unwrap(),
        updated
    );
}

#[tokio::test]
async fn every_catalog_value_is_accepted_by_settings_update() {
    let fixture = fixture();
    let state = &fixture.state;
    let catalog = call(state, "pm_agent_catalog_read", json!({}))
        .await
        .unwrap();
    let providers = catalog["providers"].as_array().unwrap();
    assert!(providers.iter().any(|provider| provider["id"] == "claude"));
    for provider in providers {
        let check = provider["permissions"]["check"].as_array().unwrap();
        assert_eq!(check, &vec![json!("bypassPermissions")]);
        for model in provider["models"].as_array().unwrap() {
            for permission in provider["permissions"]["assistant"].as_array().unwrap() {
                let updated = call(
                    state,
                    "pm_settings_update",
                    json!({
                        "agentProvider": provider["id"],
                        "agentModel": model,
                        "assistantPermission": permission,
                        "checkPermission": check[0],
                    }),
                )
                .await
                .unwrap();
                assert_eq!(updated["agentModel"], *model);
            }
        }
    }
}

async fn call_error(state: &AppState, method: &str, params: Value) -> ProtocolError {
    let request: ControlRequest = decode_request(&request_text(method, params, TOKEN), TOKEN)
        .unwrap_or_else(|reply| panic!("{method} was rejected: {reply:?}"));
    run_request(state, &request)
        .await
        .error
        .expect("the request must fail")
}

fn jira_reason(error: &ProtocolError) -> PmJiraFailure {
    assert_eq!(error.code, ErrorCode::OperationFailed);
    match &error.details {
        Some(ProtocolErrorDetails::JiraFailed { reason }) => reason.clone(),
        other => panic!("not a Jira failure: {other:?}"),
    }
}

type ParamsFor = fn(&str) -> Value;

const JIRA_BROWSE_READS: [(&str, ParamsFor); 4] = [
    (
        "pm_jira_projects_read",
        |project| json!({ "projectId": project }),
    ),
    (
        "pm_jira_statuses_read",
        |project| json!({ "projectId": project, "jiraProjectKey": "PAY" }),
    ),
    (
        "pm_jira_favourite_filters_read",
        |project| json!({ "projectId": project }),
    ),
    (
        "pm_jira_search",
        |project| json!({ "projectId": project, "preset": "assigned", "jiraProjectKey": null }),
    ),
];

#[tokio::test]
async fn jira_browse_reads_need_a_source_and_a_stored_token() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    for (method, params) in JIRA_BROWSE_READS {
        assert_eq!(
            call(state, method, params("no-such-project")).await,
            Err(ErrorCode::NotFound),
            "{method}"
        );
        let error = call_error(state, method, params(&project_id)).await;
        assert_eq!(
            jira_reason(&error),
            PmJiraFailure::NotConfigured,
            "{method}"
        );
    }

    let handle = format!("pm-jira-{}", uuid::Uuid::new_v4());
    call(
        state,
        "pm_sources_set",
        json!({ "projectId": project_id, "github": null, "jira": {
            "siteUrl": "https://acme.atlassian.net", "boardId": 84,
            "accountEmail": "ada@acme.example", "credentialHandle": handle,
        }}),
    )
    .await
    .unwrap();
    for (method, params) in JIRA_BROWSE_READS {
        let error = call_error(state, method, params(&project_id)).await;
        assert_eq!(
            jira_reason(&error),
            PmJiraFailure::CredentialMissing,
            "{method}"
        );
        assert!(!error.message.contains(&handle));
    }
}

#[tokio::test]
async fn jira_search_rejects_unsafe_input_before_calling_jira() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let search = |extra: Value| {
        let mut params = json!({ "projectId": project_id, "preset": "allOpen" });
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        params
    };
    for (extra, parameter) in [
        (json!({ "preset": "custom" }), "jql"),
        (
            json!({ "preset": "custom", "jql": "status = Open) OR (x = y" }),
            "jql",
        ),
        (json!({ "statuses": ["In\nProgress"] }), "statuses"),
        (json!({ "text": "login\u{0}" }), "text"),
    ] {
        let error = call_error(state, "pm_jira_search", search(extra.clone())).await;
        assert_eq!(error.code, ErrorCode::InvalidParams, "{extra}");
        assert_eq!(
            error.details,
            Some(ProtocolErrorDetails::InvalidParameter {
                parameter: parameter.to_owned()
            })
        );
    }
    for extra in [
        json!({ "jql": "x".repeat(8193) }),
        json!({ "jiraProjectKey": "pay" }),
        json!({ "statuses": vec!["A"; 21] }),
        json!({ "text": "x".repeat(201) }),
        json!({ "orderBy": "rank" }),
    ] {
        assert_eq!(
            rejected_code(&request_text("pm_jira_search", search(extra), TOKEN)),
            ErrorCode::InvalidParams
        );
    }
    let error = call_error(
        state,
        "pm_jira_statuses_read",
        json!({ "projectId": project_id, "jiraProjectKey": null }),
    )
    .await;
    assert_eq!(jira_reason(&error), PmJiraFailure::NotConfigured);
}

#[test]
fn only_a_custom_search_reads_its_jql() {
    let params = |preset: &str| -> PmJiraSearchParams {
        serde_json::from_value(json!({
            "projectId": "p1", "preset": preset, "jql": "project = OPS",
            "jiraProjectKey": "PAY", "currentSprint": true,
        }))
        .unwrap()
    };
    let assigned = super::jira_browse::issue_query(&params("assigned"));
    assert_eq!(assigned.custom_jql, None);
    assert_eq!(assigned.project_keys, ["PAY"]);
    assert!(assigned.current_sprint);
    let custom = super::jira_browse::issue_query(&params("custom"));
    assert_eq!(custom.custom_jql.as_deref(), Some("project = OPS"));
}

fn listed_issue(key: &str) -> JiraListedIssue {
    JiraListedIssue {
        snapshot: JiraIssueSnapshot {
            external_id: "10042".to_owned(),
            key: key.to_owned(),
            url: format!("https://acme.atlassian.net/browse/{key}"),
            summary: "Checkout fails".to_owned(),
            description: None,
            status_name: "In Progress".to_owned(),
            status_category: Some("indeterminate".to_owned()),
            assignee_display: Some("Ada".to_owned()),
            updated_at: "2026-10-25T09:30:00.000+0000".to_owned(),
        },
        details: JiraIssueDetails {
            issue_type: Some("Bug".to_owned()),
            priority: Some("High".to_owned()),
            reporter_display: Some("Grace".to_owned()),
            assignee_avatar_url: Some("https://avatars.example/ada.png?s=48".to_owned()),
            labels: vec!["payments".to_owned()],
            sprint: Some("Sprint 8".to_owned()),
            created_at_epoch_ms: None,
            updated_at_epoch_ms: 1_792_920_600_000,
        },
    }
}

#[tokio::test]
async fn searched_issues_name_the_ticket_that_links_them() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let linked = ticket(
        state,
        &project_id,
        json!({ "jiraUrl": "https://acme.atlassian.net/browse/PAY-42" }),
    )
    .await;
    ticket(state, &project_id, json!({})).await;
    let links = super::jira_browse::linked_tickets(&state.store.lock(), &project_id).unwrap();
    assert_eq!(links.len(), 1);

    let issue = super::jira_browse::issue_value(listed_issue("PAY-42"), &links).unwrap();
    assert_eq!(issue.pm_ticket_id.as_deref(), linked["id"].as_str());
    assert_eq!(issue.created_at_epoch_ms, issue.updated_at_epoch_ms);
    let other = super::jira_browse::issue_value(listed_issue("PAY-43"), &links).unwrap();
    assert_eq!(other.pm_ticket_id, None);
    assert!(super::jira_browse::issue_value(listed_issue("pay-44"), &links).is_none());

    let result = json!({
        "projectId": project_id,
        "issues": [issue, other],
        "truncated": false,
        "jql": "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    });
    assert!(validate_method_result("pm_jira_search", &result));
    assert_eq!(result["issues"][0]["status"]["category"], "indeterminate");
    assert_eq!(
        result["issues"][0]["assignee"],
        json!({ "displayName": "Ada", "avatarUrl": "https://avatars.example/ada.png?s=48" })
    );
}

#[tokio::test]
async fn deployment_control_gates_automatic_checks_and_can_be_turned_off() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let read = call(state, "pm_skills_read", json!({ "projectId": project_id }))
        .await
        .unwrap();
    assert_eq!(read["skills"].as_array().unwrap().len(), 0);

    call(
        state,
        "pm_environments_set",
        json!({ "projectId": project_id, "environments": [{ "name": "prod", "production": true }] }),
    )
    .await
    .unwrap();
    let read = call(state, "pm_skills_read", json!({ "projectId": project_id }))
        .await
        .unwrap();
    let skill = &read["skills"][0];
    assert_eq!(skill["builtin"], "deploymentControl");
    let skill_id = skill["id"].as_str().unwrap().to_owned();
    let enabled = state
        .store
        .lock()
        .deployment_control_enabled(&project_id)
        .unwrap();
    assert_eq!(skill["enabled"], enabled);

    let turned_off = call(
        state,
        "pm_skill_set_enabled",
        json!({ "skillId": skill_id, "enabled": false }),
    )
    .await
    .unwrap();
    assert_eq!(turned_off["enabled"], false);
    assert!(
        !state
            .store
            .lock()
            .deployment_control_enabled(&project_id)
            .unwrap()
    );
    // Turned off, the tick starts no check, and new environments do not
    // turn it back on.
    let ticket_id = ticket(state, &project_id, json!({})).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    scheduler::check_tick(state, launched).await;
    assert!(
        state
            .store
            .lock()
            .delivery_checks(&project_id)
            .unwrap()
            .iter()
            .all(|check| check.ticket_id != ticket_id || !check.is_running())
    );
    let read = call(state, "pm_skills_read", json!({ "projectId": project_id }))
        .await
        .unwrap();
    assert_eq!(read["skills"][0]["enabled"], false);
}

#[tokio::test]
async fn the_skill_creator_verifies_only_through_the_daemon() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let bearer = "c".repeat(64);
    register_agent(state, &project_id, PmAgentMode::SkillCreator, &bearer);

    let listed = mcp::handle_message(
        state,
        &bearer,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        true,
    )
    .await
    .unwrap()
    .unwrap();
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&termloop_pm::agent::PM_SKILL_TOOL_VERIFY));
    assert!(!names.contains(&termloop_pm::agent::PM_CHECK_REPORT));

    let verify = |arguments: Value| {
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": termloop_pm::agent::PM_SKILL_TOOL_VERIFY, "arguments": arguments },
        })
    };
    let refused = mcp::handle_message(
        state,
        &bearer,
        &verify(json!({ "kind": "cli", "name": "rm" })),
        true,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(refused["result"]["isError"], true);
    assert_eq!(refused["result"]["structuredContent"]["code"], "denied");

    let board = mcp::handle_message(
        state,
        &bearer,
        &verify(json!({ "kind": "source", "name": "deployments" })),
        true,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(board["result"]["structuredContent"]["works"], false);

    // An assistant cannot reach a host tool at all.
    let assistant = "d".repeat(64);
    state.agents.insert(AgentRecord::new(
        "session-2".to_owned(),
        project_id.clone(),
        PmAgentMode::Assistant,
        "claude".to_owned(),
        None,
        None,
        assistant.clone(),
    ));
    let denied = mcp::handle_message(
        state,
        &assistant,
        &verify(json!({ "kind": "source", "name": "board" })),
        true,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(denied["result"]["structuredContent"]["code"], "denied");
}

#[tokio::test]
async fn a_skill_with_nothing_new_records_a_skipped_run_without_an_agent() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let manifest = termloop_pm::skill::SkillManifest {
        name: "Bug watch".to_owned(),
        description: "Watches bugs.".to_owned(),
        trigger: termloop_pm::skill::SkillTrigger::Manual,
        sources: vec![termloop_pm::skill::SkillSource::Board],
        prefilter: termloop_pm::skill::SkillPrefilter::BugTickets,
        approved_tools: vec![termloop_pm::agent::PM_BOARD_READ.to_owned()],
        instructions: "Suggest an owner.".to_owned(),
        channels: Vec::new(),
        agent_tools: Vec::new(),
    };
    let skill_id = {
        let mut store = state.store.lock();
        let draft = store
            .submit_skill_draft(termloop_pm::skill::NewSkillDraft {
                project_id: project_id.clone(),
                origin: termloop_pm::skill::SkillDraftOrigin::Creator,
                base_skill_id: None,
                manifest,
                what_it_will_do: "Suggests owners for bugs.".to_owned(),
                needed_tools: Vec::new(),
                changelog: None,
            })
            .unwrap();
        let run = store.start_dry_run(&draft.id, 0).unwrap();
        store
            .finish_skill_run(&run.id, termloop_pm::skill::SkillRunOutcome::Reported, None)
            .unwrap();
        store
            .install_skill_draft(&draft.id, &draft.first_use_tools, None)
            .unwrap()
            .id
    };
    // A ticket that is not a bug: the prefilter keeps nothing.
    ticket(state, &project_id, json!({ "title": "Polish the footer" })).await;
    let ran = call(state, "pm_skill_run", json!({ "skillId": skill_id }))
        .await
        .unwrap();
    assert_eq!(ran["run"]["outcome"], "skipped");
    assert!(state.agents.project_sessions(&project_id).is_empty());
    // Runs per day count launched agents; a skipped run cost nothing.
    assert_eq!(ran["skill"]["runsToday"], 0);
    assert_eq!(ran["skill"]["lastOutcome"], "skipped");
}

#[test]
fn a_slack_skill_targets_the_active_sprint_and_reads_after_its_positions() {
    use termloop_pm::skill::{
        SkillChannel, SkillManifest, SkillPrefilter, SkillRun, SkillRunTrigger, SkillSource,
        SkillTrigger,
    };
    let mut store = termloop_pm::PmStore::open_in_memory().unwrap();
    let manifest = SkillManifest {
        name: "Slack tracker".to_owned(),
        description: "Follows Slack.".to_owned(),
        trigger: SkillTrigger::Schedule { every_minutes: 30 },
        sources: vec![SkillSource::Slack],
        prefilter: SkillPrefilter::SlackMentions,
        approved_tools: Vec::new(),
        instructions: "Suggest updates.".to_owned(),
        channels: vec![
            SkillChannel {
                id: "C0SHOP".to_owned(),
                name: "shop".to_owned(),
            },
            SkillChannel {
                id: "C0OPS".to_owned(),
                name: "ops".to_owned(),
            },
        ],
        agent_tools: vec!["mcp__slack__read_channel".to_owned()],
    };
    // Without an active sprint there is nothing a message could name.
    let planned = store
        .create_sprint("p1", "Next", None, termloop_pm::SprintState::Planned)
        .unwrap();
    store
        .create_ticket(termloop_pm::NewTicket {
            sprint_id: Some(planned.id.clone()),
            ..termloop_pm::NewTicket::new("p1", "Checkout")
        })
        .unwrap();
    let kept = skills::prefilter(&store, "p1", &manifest, 0).unwrap();
    assert!(kept.ticket_ids.is_empty());
    store.activate_sprint(&planned.id).unwrap();
    let kept = skills::prefilter(&store, "p1", &manifest, u64::MAX).unwrap();
    assert_eq!(kept.ticket_ids.len(), 1);

    let run = |skill_id: Option<&str>, draft_id: Option<&str>| SkillRun {
        id: "r1".to_owned(),
        project_id: "p1".to_owned(),
        skill_id: skill_id.map(str::to_owned),
        draft_id: draft_id.map(str::to_owned),
        version: skill_id.map(|_| 1),
        trigger: SkillRunTrigger::Schedule,
        items: 1,
        started_at_epoch_ms: 4 * 86_400_000,
        finished_at_epoch_ms: None,
        outcome: None,
        summary: None,
    };
    let dry = skills::slack_channel_briefs(&store, &manifest, &run(None, Some("d1"))).unwrap();
    assert_eq!(dry[0].after_ts, "86400.000000");
    let first = skills::slack_channel_briefs(&store, &manifest, &run(Some("s1"), None)).unwrap();
    assert_eq!(first[1].after_ts, "259200.000000");
    assert_eq!(
        (first[0].id.as_str(), first[0].name.as_str()),
        ("C0SHOP", "shop")
    );
}

#[tokio::test]
async fn the_owner_finder_reads_ticket_history_alone_and_then_git_history() {
    let fixture = fixture();
    let state = &fixture.state;
    let project_id = project(state).await;
    let bug = ticket(
        state,
        &project_id,
        json!({ "title": "Refund webhook times out", "description": "Fails in src/refund.rs" }),
    )
    .await;
    ticket(
        state,
        &project_id,
        json!({ "title": "Refund webhook retries", "assignee": "Ada" }),
    )
    .await;
    let bug_id = bug["id"].as_str().unwrap();

    let history = owners::owner_evidence(state, &project_id, bug_id)
        .await
        .unwrap();
    assert_eq!(history["candidates"][0]["name"], "Ada");
    assert_eq!(history["candidates"].as_array().unwrap().len(), 1);
    assert!(
        history["limitation"]
            .as_str()
            .unwrap()
            .contains("ticket history only")
    );
    assert_eq!(history["namedPaths"], json!(["src/refund.rs"]));

    let repository = fixture.directory.join("code");
    std::fs::create_dir_all(repository.join("src")).unwrap();
    std::fs::write(repository.join("src/refund.rs"), "fn refund() {}\n").unwrap();
    let git = termloop_gitio::GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&git, &repository).unwrap();
    termloop_gitio::test_support::commit_all(&git, &repository, "Add refunds").unwrap();
    state
        .store
        .lock()
        .set_project_folder(&project_id, repository.to_str())
        .unwrap();

    let read = owners::owner_evidence(state, &project_id, bug_id)
        .await
        .unwrap();
    let names: Vec<&str> = read["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|candidate| candidate["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["TermLoop Fixture", "Ada"]);
    assert_eq!(read["candidates"][0]["reason"], "1 related commit");
    assert!(
        read["limitation"]
            .as_str()
            .unwrap()
            .contains("GitHub is not connected")
    );

    assert!(
        owners::owner_evidence(state, "other", bug_id)
            .await
            .is_err()
    );
}
