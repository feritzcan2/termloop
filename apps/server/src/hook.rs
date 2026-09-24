pub(crate) use hook_forwarder::claude_transcript_tail;
use termloop_agent_runtime::hook_forwarder::{self, HookProtocol};
use termloop_contract::current::{CONTRACT_IDENTITY, ControlRequest, ControlResponse, ErrorCode};

struct TermLoopHookProtocol;
impl HookProtocol for TermLoopHookProtocol {
    fn encode(
        &self,
        id: &str,
        token: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(serde_json::to_value(ControlRequest {
            id: id.into(),
            token: token.into(),
            protocol_version: CONTRACT_IDENTITY.into(),
            method: "agent.observe".into(),
            params,
        })?)
    }
    fn accept(
        &self,
        id: &str,
        response: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        accept_hook_response(id, serde_json::from_value(response)?)
    }
}

pub(crate) async fn run_hook_client() -> Result<(), Box<dyn std::error::Error>> {
    hook_forwarder::run_hook_client(TermLoopHookProtocol).await
}

/// Answers one planned interrupt check. This lives beside the hook client
/// rather than in the daemon's composition root because reading a Claude
/// transcript means holding the private provider conversation identity, which
/// only this Claude-facing adapter is allowed to see.
///
/// Blocking: the caller runs it off the async workers and never under the core
/// lock.
pub(crate) fn claude_turn_was_interrupted(check: &termloop_core::ClaudeInterruptCheck) -> bool {
    claude_transcript_tail(&check.transcript_path).is_some_and(|tail| {
        termloop_core::claude_turn_interrupted(&tail, &check.native_session_id, &check.prompt_id)
    })
}

fn accept_hook_response(
    request_id: &str,
    response: ControlResponse,
) -> Result<(), Box<dyn std::error::Error>> {
    if response.id != request_id {
        return Err("hook endpoint returned a mismatched response".into());
    }
    if response.ok
        || response
            .error
            .as_ref()
            .is_some_and(|error| error.code == ErrorCode::UnsupportedVersion)
    {
        return Ok(());
    }
    Err(response
        .error
        .map(|error| error.message)
        .unwrap_or_else(|| "hook observation was rejected".into())
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hook_forwarder::{
        HookClientConfig, MAX_HOOK_INPUT_BYTES, read_bounded_hook_input, run_hook_best_effort,
    };
    use serde_json::json;
    use std::net::SocketAddr;
    use std::time::Duration;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
    use uuid::Uuid;

    async fn forward_hook<R: AsyncRead + Unpin>(
        input: R,
        config: HookClientConfig,
    ) -> Result<(), Box<dyn std::error::Error>> {
        hook_forwarder::forward_hook(input, config, &TermLoopHookProtocol).await
    }
    async fn post_hook_observation(
        address: SocketAddr,
        request: &ControlRequest,
    ) -> Result<ControlResponse, Box<dyn std::error::Error>> {
        Ok(serde_json::from_value(
            hook_forwarder::post_hook_observation(address, &serde_json::to_value(request)?).await?,
        )?)
    }

    use termloop_contract::current::ProtocolError;

    fn valid_config() -> HookClientConfig {
        HookClientConfig::new(
            "http://127.0.0.1:43123/agent-observation".into(),
            "a".repeat(64),
            "80a68d16-5029-4a05-850c-e10ee1a683be".into(),
            "claude".into(),
        )
        .unwrap()
    }

    fn response(id: &str, ok: bool, error: Option<ProtocolError>) -> ControlResponse {
        ControlResponse {
            id: id.to_owned(),
            ok,
            result: None,
            error,
        }
    }

    #[test]
    fn unsupported_contract_identity_is_a_best_effort_observation_miss() {
        let result = accept_hook_response(
            "request",
            response(
                "request",
                false,
                Some(ProtocolError {
                    code: ErrorCode::UnsupportedVersion,
                    message: "unsupported contract identity".into(),
                    details: None,
                }),
            ),
        );

        assert!(result.is_ok());
    }

    #[test]
    fn other_rejections_and_mismatched_responses_still_fail() {
        let rejected = accept_hook_response(
            "request",
            response(
                "request",
                false,
                Some(ProtocolError {
                    code: ErrorCode::Unauthenticated,
                    message: "invalid hook credential".into(),
                    details: None,
                }),
            ),
        )
        .unwrap_err();
        assert_eq!(rejected.to_string(), "invalid hook credential");

        let mismatched =
            accept_hook_response("request", response("other", true, None)).unwrap_err();
        assert_eq!(
            mismatched.to_string(),
            "hook endpoint returned a mismatched response"
        );
    }

    #[test]
    fn hook_config_accepts_only_the_exact_loopback_observation_endpoint_and_typed_identity() {
        let config = valid_config();
        assert_eq!(config.address, "127.0.0.1:43123".parse().unwrap());
        assert_eq!(config.session_id, "80a68d16-5029-4a05-850c-e10ee1a683be");

        for endpoint in [
            "https://127.0.0.1:43123/agent-observation",
            "http://localhost:43123/agent-observation",
            "http://127.0.0.1:43123/other",
            "http://127.0.0.1:43123/agent-observation?token=private",
            "http://127.0.0.1/agent-observation",
        ] {
            assert!(
                HookClientConfig::new(
                    endpoint.into(),
                    "a".repeat(64),
                    Uuid::nil().to_string(),
                    "claude".into(),
                )
                .is_err(),
                "accepted endpoint {endpoint}"
            );
        }
        assert!(
            HookClientConfig::new(
                "http://127.0.0.1:43123/agent-observation".into(),
                "contains whitespace".into(),
                Uuid::nil().to_string(),
                "claude".into(),
            )
            .is_err()
        );
        assert!(
            HookClientConfig::new(
                "http://127.0.0.1:43123/agent-observation".into(),
                "a".repeat(64),
                "not-a-session".into(),
                "claude".into(),
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn hook_input_has_a_fixed_byte_bound() {
        let at_limit = vec![b'a'; MAX_HOOK_INPUT_BYTES];
        assert_eq!(
            read_bounded_hook_input(at_limit.as_slice(), Duration::from_secs(1))
                .await
                .unwrap()
                .len(),
            MAX_HOOK_INPUT_BYTES
        );

        let over_limit = vec![b'a'; MAX_HOOK_INPUT_BYTES + 1];
        assert_eq!(
            read_bounded_hook_input(over_limit.as_slice(), Duration::from_secs(1))
                .await
                .unwrap_err()
                .to_string(),
            "hook input exceeded its fixed bound"
        );
    }

    #[tokio::test]
    async fn hook_input_and_whole_operation_are_deadline_limited_and_fail_open() {
        let (_open_writer, stalled_reader) = tokio::io::duplex(1);
        assert_eq!(
            read_bounded_hook_input(stalled_reader, Duration::from_millis(10))
                .await
                .unwrap_err()
                .to_string(),
            "hook input timed out"
        );

        tokio::time::timeout(
            Duration::from_secs(1),
            run_hook_best_effort(
                Duration::from_millis(10),
                std::future::pending::<Result<(), Box<dyn std::error::Error>>>(),
            ),
        )
        .await
        .expect("the fail-open wrapper must enforce its total deadline");

        run_hook_best_effort(Duration::from_secs(1), async {
            Err("an observation-only failure".into())
        })
        .await;
    }

    #[tokio::test]
    async fn provider_hook_forwards_the_versioned_generic_envelope() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/agent-observation",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let (header_end, content_length) = loop {
                let mut chunk = [0_u8; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0, "hook request closed before its body arrived");
                received.extend_from_slice(&chunk[..read]);
                if let Some(header_end) = received
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|position| position + 4)
                {
                    let headers = std::str::from_utf8(&received[..header_end]).unwrap();
                    assert!(headers.starts_with("POST /agent-observation HTTP/1.1\r\n"));
                    let content_length = headers
                        .split("\r\n")
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (header_end, content_length);
                }
            };
            while received.len() < header_end + content_length {
                let mut chunk = [0_u8; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0, "hook request body was truncated");
                received.extend_from_slice(&chunk[..read]);
            }
            let request: ControlRequest =
                serde_json::from_slice(&received[header_end..header_end + content_length]).unwrap();
            let body = serde_json::to_vec(&response(&request.id, true, None)).unwrap();
            let response_headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response_headers.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            stream.flush().await.unwrap();
            request
        });
        let config = HookClientConfig::new(
            endpoint,
            "a".repeat(64),
            "80a68d16-5029-4a05-850c-e10ee1a683be".into(),
            "gemini".into(),
        )
        .unwrap();
        forward_hook(
            serde_json::to_vec(&json!({
                "hook_event_name": "Notification",
                "notification_type": "ToolPermission",
                "session_id": "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035",
                "cwd": "/tmp/project"
            }))
            .unwrap()
            .as_slice(),
            config,
        )
        .await
        .unwrap();
        let request = server.await.unwrap();
        assert_eq!(request.method, "agent.observe");
        assert_eq!(request.params["observationProtocolVersion"], 1);
        assert_eq!(request.params["transport"], "launchScopedHook");
        assert_eq!(request.params["eventName"], "Notification");
        assert_eq!(request.params["notificationType"], "ToolPermission");
        assert!(request.params.get("signal").is_none());
        assert!(termloop_contract::current::validate_method_params(
            "agent.observe",
            &request.params
        ));
    }

    #[tokio::test]
    async fn hook_http_client_round_trips_against_axum_response_framing() {
        async fn observation(body: axum::body::Bytes) -> impl axum::response::IntoResponse {
            let request: ControlRequest = serde_json::from_slice(&body).unwrap();
            let body = serde_json::to_string(&response(&request.id, true, None)).unwrap();
            (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                body,
            )
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router =
            axum::Router::new().route("/agent-observation", axum::routing::post(observation));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let request = ControlRequest {
            id: Uuid::new_v4().to_string(),
            protocol_version: CONTRACT_IDENTITY.into(),
            token: "a".repeat(64),
            method: "agent.observe".into(),
            params: json!({}),
        };

        let received = post_hook_observation(address, &request).await.unwrap();
        assert_eq!(received.id, request.id);
        assert!(received.ok);
        server.abort();
    }
}
