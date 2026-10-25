//! Daemon-level tests: control authentication and dispatch, absent-vs-null
//! updates, event fan-out, credential handles, MCP tool denial, and the
//! one-check-per-ticket rule.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use termloop_platform::test_support::MemorySecureCredentialStore;
use termloop_pm::agent::PmAgentMode;
use termloop_pm::{DeliveryCheck, DeliveryCheckReason, NewCheck, PmStore};
use termloop_pm_contract::pm::{CONTRACT_IDENTITY, ControlRequest, ErrorCode, EventName};
use termloop_terminal::TerminalService;
use tokio::sync::{Notify, broadcast};

use super::agents::{AgentRecord, AgentRegistry};
use super::control::errors::ControlError;
use super::control::{decode_request, run_request};
use super::scheduler::{self, Refusal};
use super::{AppState, Store, mcp};

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

fn mcp_call(state: &AppState, bearer: &str, name: &str) -> Value {
    let message = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": {} },
    });
    mcp::handle_message(state, bearer, &message, true)
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

    let denied = mcp_call(state, &bearer, termloop_pm::agent::PM_CHECK_REPORT);
    assert_eq!(denied["result"]["isError"], true);
    assert_eq!(denied["result"]["structuredContent"]["code"], "denied");

    let listed = mcp::handle_message(
        state,
        &bearer,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        true,
    )
    .unwrap()
    .unwrap();
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&termloop_pm::agent::PM_CHECK_REPORT));

    let read = mcp_call(state, &bearer, termloop_pm::agent::PM_BOARD_READ);
    assert_eq!(read["result"]["isError"], false);

    // Another bearer is not an agent at all.
    assert!(mcp::handle_message(state, &"b".repeat(64), &json!({}), true).is_err());
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
