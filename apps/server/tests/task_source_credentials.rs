#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{connect_async, tungstenite::Message};

struct Fixture {
    directory: PathBuf,
    child: Option<Child>,
}

impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("termloop-jira-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("project")).unwrap();
        Self {
            directory,
            child: None,
        }
    }

    async fn start(&mut self) -> Value {
        if let Some(mut child) = self.child.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        let child = Command::new(env!("CARGO_BIN_EXE_termloop-server"))
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

async fn call(record: &Value, method: &str, params: Value) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (mut socket, _) = connect_async(record["controlUrl"].as_str().unwrap())
            .await
            .unwrap();
        socket
            .send(Message::text(
                json!({
                    "id": "fixture",
                    "protocolVersion": record["protocolVersion"],
                    "token": record["token"],
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
        assert_eq!(
            response["ok"], true,
            "{method} failed: {:?}",
            response["error"]
        );
        response["result"].clone()
    })
    .await
    .expect("fixture control request timed out")
}

fn secret_records(directory: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "secret")
        })
        .collect()
}

#[tokio::test]
async fn jira_credentials_can_be_added_replaced_and_removed_on_a_headless_server() {
    let mut fixture = Fixture::new();
    let record = fixture.start().await;
    let project = call(
        &record,
        "project.create",
        json!({"name": "Credential fixture", "folderPath": fixture.directory.join("project")}),
    )
    .await;
    let listing = call(
        &record,
        "taskSource.list",
        json!({"projectId": project["id"]}),
    )
    .await;
    let configuration = json!({
        "name": "Jira fixture",
        "siteBaseUrl": "https://termloop-credential-fixture.atlassian.net",
        "scopeKind": "assignedToMe", "boards": [], "statuses": [], "jql": null,
        "importPolicy": "review", "autoImportActiveTaskLimit": 5, "refreshIntervalSeconds": 900,
    });
    let mut create = configuration.clone();
    create["projectId"] = project["id"].clone();
    create["expectedRevision"] = listing["stateRevision"].clone();
    let created = call(&record, "taskSource.create", create).await;
    assert_eq!(created["source"]["credentialState"], "none");
    // Disable polling so this storage regression never contacts Jira.
    let mut update = configuration;
    update["sourceId"] = created["source"]["id"].clone();
    update["enabled"] = json!(false);
    update["expectedGeneration"] = created["source"]["generation"].clone();
    update["expectedRevision"] = created["stateRevision"].clone();
    let updated = call(&record, "taskSource.update", update).await;
    let source = &updated["source"];
    let credentials_directory = fixture.directory.join("state/credentials");
    for token in ["fixture-api-token", "replacement-api-token"] {
        let stored = call(
            &record,
            "taskSource.credentialsSet",
            json!({
                "sourceId": source["id"], "expectedGeneration": source["generation"],
                "email": "test@example.invalid", "apiToken": token,
            }),
        )
        .await;
        assert_eq!(stored["credentialState"], "present");
        let listing = call(
            &record,
            "taskSource.list",
            json!({"projectId": project["id"]}),
        )
        .await;
        assert_eq!(listing["sources"][0]["credentialState"], "present");
        let records = secret_records(&credentials_directory);
        assert_eq!(records.len(), 1);
        let bytes = std::fs::read(&records[0]).unwrap();
        assert!(
            !bytes
                .windows(token.len())
                .any(|window| window == token.as_bytes())
        );
        let state = std::fs::read(fixture.directory.join("state/state.v1.json")).unwrap();
        assert!(
            !state
                .windows(token.len())
                .any(|window| window == token.as_bytes())
        );
    }
    let record = fixture.start().await;
    let listing = call(
        &record,
        "taskSource.list",
        json!({"projectId": project["id"]}),
    )
    .await;
    let deleted = call(
        &record,
        "taskSource.delete",
        json!({
            "sourceId": source["id"], "expectedGeneration": source["generation"],
            "expectedRevision": listing["stateRevision"],
        }),
    )
    .await;
    assert_eq!(deleted["deleted"], true);
    assert!(secret_records(&credentials_directory).is_empty());
}
