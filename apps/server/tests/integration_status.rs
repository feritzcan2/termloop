//! Daemon-level dispatch for `integration.statusList` and
//! `integration.azureDevOpsTokenSet` with fake `gh`/`az` CLIs on PATH.
//! The token path is Linux-only so the test never touches a desktop keychain;
//! the daemon then uses its private encrypted credential file store.
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const FIXTURE_PAT: &str = "fixture-pat-value-0123456789";

struct Fixture {
    directory: PathBuf,
    child: Option<Child>,
}

impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("termloop-integration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("bin")).unwrap();
        write_fake_clis(&directory);
        Self {
            directory,
            child: None,
        }
    }

    fn marker(&self) -> PathBuf {
        self.directory.join("az-saw-pat")
    }

    async fn start(&mut self) -> Value {
        if let Some(mut child) = self.child.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        let path = format!(
            "{}:{}",
            self.directory.join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let child = Command::new(env!("CARGO_BIN_EXE_termloop-server"))
            .env("PATH", path)
            .env_remove("AZURE_DEVOPS_EXT_PAT")
            .env("TERMLOOP_STATE_DIR", self.directory.join("state"))
            .env("TERMLOOP_RUNTIME_DIR", self.directory.join("runtime"))
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/no-session-bus", self.directory.display()),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        self.child = Some(child);
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Ok(bytes) = std::fs::read(self.directory.join("runtime/runtime.json"))
                    && let Ok(record) = serde_json::from_slice::<Value>(&bytes)
                    && record["pid"] == pid
                {
                    return record;
                }
                assert!(
                    self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                    "fixture daemon exited before discovery"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("fixture daemon discovery timed out")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn write_fake_clis(directory: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let marker = directory.join("az-saw-pat");
    let scripts = [
        (
            "gh",
            "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'gh version 2.0.0' ;;\n  auth) echo 'Logged in to github.com account fixture-user' >&2 ;;\n  api) echo 'fixture-user' ;;\n  *) exit 1 ;;\nesac\n".to_owned(),
        ),
        (
            "az",
            format!(
                "#!/bin/sh\nif [ \"$AZURE_DEVOPS_EXT_PAT\" = '{FIXTURE_PAT}' ]; then touch '{}'; fi\ncase \"$1\" in\n  version) echo '{{}}' ;;\n  extension) echo '{{\"name\":\"azure-devops\"}}' ;;\n  account) echo 'ada@example.invalid' ;;\n  *) exit 1 ;;\nesac\n",
                marker.display()
            ),
        ),
    ];
    for (name, body) in scripts {
        let path = directory.join("bin").join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

async fn request(record: &Value, token_field: &str, method: &str, params: Value) -> Value {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut socket, _) = connect_async(record["controlUrl"].as_str().unwrap())
            .await
            .unwrap();
        socket
            .send(Message::text(
                json!({
                    "id": "fixture",
                    "protocolVersion": record["protocolVersion"],
                    "token": record[token_field],
                    "method": method,
                    "params": params,
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let response = socket.next().await.unwrap().unwrap();
        let response: Value = serde_json::from_str(response.to_text().unwrap()).unwrap();
        socket.close(None).await.unwrap();
        response
    })
    .await
    .expect("fixture control request timed out")
}

async fn call(record: &Value, method: &str, params: Value) -> Value {
    let response = request(record, "token", method, params).await;
    assert_eq!(
        response["ok"], true,
        "{method} failed: {:?}",
        response["error"]
    );
    assert!(
        !response.to_string().contains(FIXTURE_PAT),
        "{method} leaked the PAT"
    );
    response["result"].clone()
}

fn provider<'a>(integrations: &'a Value, provider: &str) -> &'a Value {
    integrations["integrations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider"] == provider)
        .unwrap_or_else(|| panic!("{provider} entry missing: {integrations}"))
}

#[tokio::test]
async fn integration_status_and_azure_token_round_trip_on_a_headless_server() {
    let mut fixture = Fixture::new();
    let record = fixture.start().await;

    let denied = request(
        &record,
        "readOnlyToken",
        "integration.statusList",
        json!({"refresh": false}),
    )
    .await;
    assert_eq!(denied["ok"], false);
    assert_eq!(denied["error"]["code"], "capabilityDenied");

    let listed = call(&record, "integration.statusList", json!({"refresh": true})).await;
    let github = provider(&listed, "github");
    assert_eq!(github["target"], "github.com");
    assert_eq!(github["state"], "connected");
    assert_eq!(github["account"], "fixture-user");
    assert_eq!(github["credentialSource"], "cli");
    let azure = provider(&listed, "azureDevOps");
    assert_eq!(azure["target"], "dev.azure.com");
    assert_eq!(azure["state"], "connected");
    assert_eq!(azure["credentialSource"], "cli");
    assert_eq!(azure["account"], "ada@example.invalid");
    assert!(
        listed["integrations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["provider"] != "jira"),
        "no Jira entries without Task Sources"
    );
    assert!(!fixture.marker().exists());

    let stored = call(
        &record,
        "integration.azureDevOpsTokenSet",
        json!({"token": FIXTURE_PAT}),
    )
    .await;
    assert_eq!(stored["status"]["state"], "connected");
    assert_eq!(stored["status"]["credentialSource"], "personalAccessToken");
    assert_eq!(stored["status"]["account"], Value::Null);
    assert!(fixture.marker().exists(), "az must receive the stored PAT");
    let state = std::fs::read(fixture.directory.join("state/state.v1.json")).unwrap_or_default();
    assert!(
        !state
            .windows(FIXTURE_PAT.len())
            .any(|window| window == FIXTURE_PAT.as_bytes())
    );

    // The stored token survives a daemon restart and is used again.
    std::fs::remove_file(fixture.marker()).unwrap();
    let record = fixture.start().await;
    let mut restarted = Value::Null;
    for _ in 0..50 {
        restarted = call(&record, "integration.statusList", json!({"refresh": true})).await;
        if provider(&restarted, "azureDevOps")["credentialSource"] == "personalAccessToken" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        provider(&restarted, "azureDevOps")["credentialSource"],
        "personalAccessToken"
    );
    assert!(fixture.marker().exists());

    let removed = call(
        &record,
        "integration.azureDevOpsTokenSet",
        json!({"token": null}),
    )
    .await;
    assert_eq!(removed["status"]["credentialSource"], "cli");

    let invalid = request(
        &record,
        "token",
        "integration.azureDevOpsTokenSet",
        json!({"token": "has whitespace"}),
    )
    .await;
    assert_eq!(invalid["ok"], false);
}
