use super::*;

#[tokio::test]
async fn standalone_hook_round_trip_has_no_product_contract_dependency() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/agent-observation",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let body = loop {
            let mut buffer = [0u8; 4096];
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
            let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                continue;
            };
            let headers = std::str::from_utf8(&bytes[..end]).unwrap();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            if bytes.len() >= end + 4 + length {
                break bytes[end + 4..].to_vec();
            }
        };
        let request: HookObservationEnvelope = serde_json::from_slice(&body).unwrap();
        assert_eq!(request.protocol_version, 1);
        assert_eq!(
            request.observation["sessionId"],
            "80a68d16-5029-4a05-850c-e10ee1a683be"
        );
        assert_eq!(request.observation["eventName"], "SessionStart");
        assert_eq!(request.observation["transport"], "launchScopedHook");
        let body = serde_json::to_vec(&HookObservationReceipt {
            id: request.id,
            protocol_version: 1,
            accepted: true,
        })
        .unwrap();
        socket
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes(),
            )
            .await
            .unwrap();
        socket.write_all(&body).await.unwrap();
    });
    let config = HookClientConfig::new(
        endpoint,
        "a".repeat(64),
        "80a68d16-5029-4a05-850c-e10ee1a683be".into(),
        "claude".into(),
    )
    .unwrap();
    forward_hook(br#"{"hook_event_name":"SessionStart","session_id":"11111111-1111-4111-8111-111111111111"}"#.as_slice(),
        config, &EngineHookProtocol).await.unwrap();
    server.await.unwrap();
}

#[test]
fn hook_receipts_cannot_be_reused_for_another_request_or_protocol() {
    for (id, version, accepted) in [
        ("other", 1, true),
        ("request", 2, true),
        ("request", 1, false),
    ] {
        let value = serde_json::to_value(HookObservationReceipt {
            id: id.into(),
            protocol_version: version,
            accepted,
        })
        .unwrap();
        assert!(EngineHookProtocol.accept("request", value).is_err());
    }
}

#[test]
fn opencode_hook_identity_accepts_only_provider_session_ids() {
    assert_eq!(
        hook_native_session_id("opencode", &json!({"session_id":"ses_abc123"})),
        Some("ses_abc123".into())
    );
    assert_eq!(
        hook_native_session_id("claude", &json!({"session_id":"ses_abc123"})),
        None
    );
    assert_eq!(
        hook_native_session_id("opencode", &json!({"session_id":"ses_bad/id"})),
        None
    );
}

#[test]
fn subagent_observations_carry_an_opaque_key_instead_of_the_provider_id() {
    let started = termloop_agents::normalize_claude_subagent_update(&serde_json::json!({
        "hook_event_name": "SubagentStart",
        "agent_id": "a89b41394dcd804b3",
        "agent_type": "general-purpose",
    }))
    .unwrap();
    let wire = subagent_observation_json(started);
    assert_eq!(wire["kind"], "started");
    assert_eq!(wire["agentType"], "general-purpose");
    assert_eq!(wire["key"].as_str().unwrap().len(), 16);
    assert!(!wire.to_string().contains("a89b41394dcd804b3"));

    let inventory = termloop_agents::normalize_claude_subagent_update(&serde_json::json!({
        "hook_event_name": "Stop",
        "background_tasks": [{ "id": "a89b41394dcd804b3", "type": "subagent", "status": "running", "description": "Sleep" }],
    }))
    .unwrap();
    let wire = subagent_observation_json(inventory);
    assert_eq!(wire["kind"], "inventory");
    assert_eq!(wire["children"][0]["description"], "Sleep");
    assert!(wire["children"][0]["agentType"].is_null());
    assert!(!wire.to_string().contains("a89b41394dcd804b3"));
}

#[test]
fn live_statuses_are_read_beside_the_named_transcript_for_one_conversation() {
    let root = std::env::temp_dir().join(format!(
        "termloop-claude-live-status-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let transcript = root
        .join("projects")
        .join("-work")
        .join("conversation.jsonl");
    let sessions = root.join("sessions");
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    assert!(claude_live_statuses(&transcript, "conversation").is_empty());
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(
        sessions.join("101.json"),
        r#"{"pid":101,"sessionId":"conversation","status":"idle","statusUpdatedAt":20}"#,
    )
    .unwrap();
    std::fs::write(
        sessions.join("102.json"),
        r#"{"pid":102,"sessionId":"other","status":"idle","statusUpdatedAt":30}"#,
    )
    .unwrap();
    std::fs::write(sessions.join("101.secret.key"), "not a record").unwrap();

    let statuses = claude_live_statuses(&transcript, "conversation");
    assert_eq!(statuses.len(), 1);
    assert!(termloop_agents::claude_turn_withdrawn(
        statuses,
        20,
        20 + termloop_agents::CLAUDE_TURN_WITHDRAWAL_SETTLE_MS
    ));
    // A transcript outside `<config>/projects/<project>/` names no record.
    assert!(claude_live_statuses(&root.join("conversation.jsonl"), "conversation").is_empty());
    let _ = std::fs::remove_dir_all(root);
}
