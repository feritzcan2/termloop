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
