use super::*;
use std::net::TcpListener;
use tokio_tungstenite::tungstenite::{Message, accept};

const THREAD: &str = "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036";

fn exchange(
    permission: CodexPermissionMode,
    expected: (&str, &str, &str),
    response: Value,
) -> Result<(), CodexResumePermissionsError> {
    exchange_request(
        CodexResumePermissions::new(THREAD, "/workspace", permission).unwrap(),
        expected,
        response,
    )
}

fn exchange_request(
    request: CodexResumePermissions,
    expected: (&str, &str, &str),
    response: Value,
) -> Result<(), CodexResumePermissionsError> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let method = if request.is_fork() {
        "thread/fork"
    } else {
        "thread/resume"
    };
    let expected_id = response
        .pointer("/result/thread/id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let success = response
        .get("result")
        .is_some_and(|result| request.matches(result));
    let (alive_tx, alive_rx) = std::sync::mpsc::channel();
    let expected = (
        expected.0.to_owned(),
        expected.1.to_owned(),
        expected.2.to_owned(),
    );
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let init: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(init["method"], "initialize");
        socket
            .send(Message::Text(
                json!({ "id": init["id"], "result": {} }).to_string().into(),
            ))
            .unwrap();
        let initialized: Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(initialized["method"], "initialized");
        let resume: Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(resume["method"], method);
        assert_eq!(
            resume["params"],
            json!({
                "threadId": THREAD,
                "cwd": "/workspace",
                "approvalPolicy": expected.0,
                "approvalsReviewer": expected.1,
                "sandbox": expected.2,
                "excludeTurns": true,
            })
        );
        // An unrelated notification cannot be mistaken for an acknowledgement.
        socket
            .send(Message::Text(
                json!({ "method": "thread/status/changed", "params": {} })
                    .to_string()
                    .into(),
            ))
            .unwrap();
        let mut response = response;
        response["id"] = resume["id"].clone();
        socket
            .send(Message::Text(response.to_string().into()))
            .unwrap();
        if success {
            socket.send(Message::Ping(vec![7].into())).unwrap();
            assert_eq!(socket.read().unwrap(), Message::Pong(vec![7].into()));
            alive_tx.send(()).unwrap();
        }
        let _ = socket.read();
    });
    let result = prepare_codex_resume_permissions(&endpoint, &request);
    // The successful lease owns the connection until explicitly released.
    if let Ok(lease) = &result {
        assert_eq!(Some(lease.native_thread_id()), expected_id.as_deref());
        assert_eq!(lease.fork_source(), request.is_fork().then_some(THREAD));
        alive_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    let result = result.map(drop);
    server.join().unwrap();
    result
}

#[test]
fn replays_each_saved_mode_and_requires_the_exact_effective_permissions() {
    for (mode, approval, reviewer, sandbox, kind) in [
        (
            CodexPermissionMode::Default,
            "on-request",
            "user",
            "workspace-write",
            "workspaceWrite",
        ),
        (
            CodexPermissionMode::AcceptEdits,
            "on-request",
            "auto_review",
            "workspace-write",
            "workspaceWrite",
        ),
        (
            CodexPermissionMode::Plan,
            "on-request",
            "user",
            "read-only",
            "readOnly",
        ),
        (
            CodexPermissionMode::BypassPermissions,
            "never",
            "user",
            "danger-full-access",
            "dangerFullAccess",
        ),
    ] {
        exchange(
            mode,
            (approval, reviewer, sandbox),
            json!({ "result": {
                "thread": { "id": THREAD },
                "approvalPolicy": approval,
                "approvalsReviewer": reviewer,
                "sandbox": { "type": kind },
            }}),
        )
        .unwrap();
        exchange_request(
            CodexResumePermissions::new(THREAD, "/workspace", mode)
                .unwrap()
                .for_fork(),
            (approval, reviewer, sandbox),
            json!({ "result": {
                "thread": { "id": "019f1dae-3bf3-73d1-b3c7-08ddbbd1f037", "forkedFromId": THREAD },
                "approvalPolicy": approval,
                "approvalsReviewer": reviewer,
                "sandbox": { "type": kind },
            }}),
        )
        .unwrap();
    }
}

#[test]
fn fork_rejects_source_reuse_wrong_parent_and_permission_mismatch() {
    let success = json!({ "result": {
        "thread": { "id": "019f1dae-3bf3-73d1-b3c7-08ddbbd1f037", "forkedFromId": THREAD },
        "approvalPolicy": "never", "approvalsReviewer": "user",
        "sandbox": { "type": "dangerFullAccess" },
    }});
    for (pointer, wrong) in [
        ("/result/thread/id", json!(THREAD)),
        ("/result/thread/id", json!("")),
        ("/result/thread/forkedFromId", json!("another-thread")),
        ("/result/thread/forkedFromId", Value::Null),
        ("/result/approvalPolicy", json!("on-request")),
        ("/result/sandbox/type", json!("workspaceWrite")),
    ] {
        let mut response = success.clone();
        *response.pointer_mut(pointer).unwrap() = wrong;
        assert!(
            exchange_request(
                CodexResumePermissions::new(
                    THREAD,
                    "/workspace",
                    CodexPermissionMode::BypassPermissions
                )
                .unwrap()
                .for_fork(),
                ("never", "user", "danger-full-access"),
                response,
            )
            .is_err()
        );
    }
}

#[test]
fn a_wrong_thread_downgraded_permissions_or_missing_proof_is_not_success() {
    let success = json!({ "result": {
        "thread": { "id": THREAD }, "approvalPolicy": "never",
        "approvalsReviewer": "user", "sandbox": { "type": "dangerFullAccess" },
    }});
    for (pointer, wrong) in [
        ("/result/thread/id", json!("another-thread")),
        ("/result/approvalPolicy", json!("on-request")),
        ("/result/approvalsReviewer", json!("auto_review")),
        ("/result/sandbox/type", json!("workspaceWrite")),
        ("/result/sandbox/type", Value::Null),
    ] {
        let mut response = success.clone();
        *response.pointer_mut(pointer).unwrap() = wrong;
        assert!(
            exchange(
                CodexPermissionMode::BypassPermissions,
                ("never", "user", "danger-full-access"),
                response
            )
            .is_err()
        );
    }
    for response in [
        json!({ "error": { "code": -32600, "message": "rejected" } }),
        json!({}),
    ] {
        assert!(
            exchange(
                CodexPermissionMode::BypassPermissions,
                ("never", "user", "danger-full-access"),
                response
            )
            .is_err()
        );
    }
}

#[test]
fn invalid_identity_and_directory_are_rejected_before_network_work() {
    for (id, cwd) in [("", "/workspace"), (THREAD, ""), (THREAD, "bad\0path")] {
        assert!(CodexResumePermissions::new(id, cwd, CodexPermissionMode::Plan).is_none());
    }
}

#[test]
fn resume_applies_and_verifies_explicit_model_and_effort() {
    let request = CodexResumePermissions::new(THREAD, "/workspace", CodexPermissionMode::Plan)
        .unwrap()
        .with_configuration("gpt-5.6-terra", "low");
    assert_eq!(request.params()["model"], "gpt-5.6-terra");
    assert_eq!(request.params()["config"]["model_reasoning_effort"], "low");
    let mut result = json!({
        "thread": { "id": THREAD }, "approvalPolicy": "on-request",
        "approvalsReviewer": "user", "sandbox": { "type": "readOnly" },
        "model": "gpt-5.6-terra", "reasoningEffort": "low",
    });
    assert!(request.matches(&result));
    result["model"] = json!("gpt-5.6-sol");
    assert!(!request.matches(&result));
    result["model"] = json!("gpt-5.6-terra");
    result["reasoningEffort"] = json!("high");
    assert!(!request.matches(&result));
    let defaults = CodexResumePermissions::new(THREAD, "/workspace", CodexPermissionMode::Plan)
        .unwrap()
        .with_configuration("default", "default");
    assert!(defaults.params().get("model").is_none());
    assert!(defaults.params().get("config").is_none());
    assert!(defaults.matches(&result));
}

#[test]
fn resume_network_override_preserves_model_config_and_verifies_workspace_policy() {
    for enabled in [true, false] {
        let request =
            CodexResumePermissions::new(THREAD, "/workspace", CodexPermissionMode::Default)
                .unwrap()
                .with_configuration("gpt-5.6-terra", "low")
                .with_workspace_network(Some(enabled));
        assert_eq!(
            request.params()["config"]["sandbox_workspace_write.network_access"],
            enabled
        );
        assert_eq!(request.params()["config"]["model_reasoning_effort"], "low");
        let mut result = json!({"thread":{"id":THREAD},"approvalPolicy":"on-request","approvalsReviewer":"user", "sandbox":{"type":"workspaceWrite","networkAccess":enabled},"model":"gpt-5.6-terra","reasoningEffort":"low"});
        assert!(request.matches(&result));
        result["sandbox"]["networkAccess"] = json!(!enabled);
        assert!(!request.matches(&result));
    }
}
