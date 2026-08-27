use serde_json::json;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use termloop_contract::current::{CONTRACT_IDENTITY, ControlRequest, ControlResponse, ErrorCode};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use uuid::Uuid;

const MAX_HOOK_INPUT_BYTES: usize = 1024 * 1024;
const MAX_HOOK_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_HOOK_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_HOOK_RESPONSE_HEADERS_BYTES: usize = 8 * 1024;
const MAX_HOOK_ENDPOINT_BYTES: usize = 128;
const MAX_HOOK_TOKEN_BYTES: usize = 256;
const HOOK_TOTAL_TIMEOUT: Duration = Duration::from_secs(2);
const HOOK_INPUT_TIMEOUT: Duration = Duration::from_millis(500);
const HOOK_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const HOOK_WRITE_TIMEOUT: Duration = Duration::from_millis(500);
const HOOK_RESPONSE_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug)]
struct HookClientConfig {
    address: SocketAddr,
    token: String,
    session_id: String,
    agent_id: String,
}

impl HookClientConfig {
    fn from_environment() -> Result<Self, Box<dyn std::error::Error>> {
        Self::new(
            std::env::var("TERMLOOP_HOOK_ENDPOINT")?,
            std::env::var("TERMLOOP_HOOK_TOKEN")?,
            std::env::var("TERMLOOP_SESSION_ID")?,
            std::env::var("TERMLOOP_AGENT_ID")?,
        )
    }

    fn new(
        endpoint: String,
        token: String,
        session_id: String,
        agent_id: String,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let address = validate_hook_endpoint(&endpoint)?;
        if token.is_empty()
            || token.len() > MAX_HOOK_TOKEN_BYTES
            || !token.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err("hook credential has an invalid shape".into());
        }
        let session_id = Uuid::parse_str(&session_id)
            .map_err(|_| "hook Session ID is invalid")?
            .to_string();
        if !termloop_core::supports_provider_hook_observation(&agent_id) {
            return Err("hook provider is unsupported".into());
        }
        Ok(Self {
            address,
            token,
            session_id,
            agent_id,
        })
    }
}

/// Provider hook failures must never delay or change the provider's own turn.
/// The runner is therefore silent and fail-open; the daemon remains the only
/// authority that decides whether a successfully received observation counts.
pub(crate) async fn run_hook_client() -> Result<(), Box<dyn std::error::Error>> {
    run_hook_best_effort(HOOK_TOTAL_TIMEOUT, async {
        let config = HookClientConfig::from_environment()?;
        forward_hook(tokio::io::stdin(), config).await
    })
    .await;
    Ok(())
}

async fn run_hook_best_effort<F>(deadline: Duration, operation: F)
where
    F: Future<Output = Result<(), Box<dyn std::error::Error>>>,
{
    let _ = tokio::time::timeout(deadline, operation).await;
}

async fn forward_hook<R>(
    input: R,
    config: HookClientConfig,
) -> Result<(), Box<dyn std::error::Error>>
where
    R: AsyncRead + Unpin,
{
    let input = read_bounded_hook_input(input, HOOK_INPUT_TIMEOUT).await?;
    let payload: serde_json::Value = serde_json::from_slice(&input)?;
    let signal = payload
        .get("hook_event_name")
        .or_else(|| payload.get("hookEventName"))
        .and_then(serde_json::Value::as_str)
        .ok_or("hook payload has no event name")?;
    // Claude routes every desktop notice through one Notification event, so the
    // type is the only thing separating "blocked on you" from "idle nudge".
    let notification_type = field_str(&payload, "notification_type", "notificationType")
        .filter(|value| !value.is_empty() && value.chars().count() <= 64);
    let native_session_id = field_str(&payload, "session_id", "sessionId")
        .and_then(|value| Uuid::parse_str(value).ok())
        .map(|value| value.to_string());
    let is_claude = config.agent_id == "claude";
    let plan = is_claude
        .then(|| termloop_core::normalize_claude_hook_plan(&payload))
        .flatten();
    // Every hook payload carries the mode the Session is on right now, so an
    // in-TUI `Shift+Tab` is observable without reading the transcript.
    let permission_mode = is_claude
        .then(|| field_str(&payload, "permission_mode", "permissionMode"))
        .flatten()
        .filter(|value| !value.is_empty() && value.chars().count() <= 64);
    // Tool and turn boundaries additionally report the effort level as
    // `effort: { level }`; a prompt-submission payload carries none.
    let effort_level = is_claude
        .then(|| {
            payload
                .get("effort")
                .and_then(|effort| field_str(effort, "level", "level"))
        })
        .flatten()
        .filter(|value| !value.is_empty() && value.chars().count() <= 64);
    let provider_model_id = is_claude
        .then(|| {
            native_session_id
                .as_deref()
                .and_then(|native_session_id| observed_model(signal, &payload, native_session_id))
        })
        .flatten();
    // Claude reports the user's `Esc` through no hook at all, so a starting turn
    // hands the daemon the exact transcript and prompt identity it will need to
    // ask that question later.
    let (transcript_path, prompt_id) = if is_claude && signal == "UserPromptSubmit" {
        (
            transcript_path(&payload).map(|path| path.display().to_string()),
            field_str(&payload, "prompt_id", "promptId")
                .filter(|value| !value.is_empty() && value.chars().count() <= 128)
                .map(str::to_owned),
        )
    } else {
        (None, None)
    };
    let mut params = json!({
        "sessionId": config.session_id,
        "observationProtocolVersion": 1,
        "transport": "launchScopedHook",
        "eventName": signal,
        "notificationType": notification_type,
        "nativeSessionId": native_session_id,
        "providerModelId": provider_model_id,
        "permissionMode": permission_mode,
        "effortLevel": effort_level,
        "transcriptPath": transcript_path,
        "promptId": prompt_id,
    });
    if let Some(plan) = plan {
        params["plan"] = match plan {
            termloop_core::AgentPlanUpdate::Replace(plan) => json!({
                "kind": "replace",
                "explanation": plan.explanation,
                "steps": plan.steps,
            }),
            termloop_core::AgentPlanUpdate::UpsertTask {
                task_id,
                text,
                status,
            } => json!({
                "kind": "upsertTask",
                "taskId": task_id,
                "text": text,
                "status": status,
            }),
            termloop_core::AgentPlanUpdate::SetTaskStatus { task_id, status } => json!({
                "kind": "setTaskStatus",
                "taskId": task_id,
                "status": status,
            }),
            termloop_core::AgentPlanUpdate::RemoveTask { task_id } => json!({
                "kind": "removeTask",
                "taskId": task_id,
            }),
        };
    }
    let request = ControlRequest {
        id: Uuid::new_v4().to_string(),
        protocol_version: CONTRACT_IDENTITY.to_owned(),
        token: config.token,
        method: "agent.observe".into(),
        params,
    };
    let response = post_hook_observation(config.address, &request).await?;
    accept_hook_response(&request.id, response)
}

async fn post_hook_observation(
    address: SocketAddr,
    request: &ControlRequest,
) -> Result<ControlResponse, Box<dyn std::error::Error>> {
    let body = serde_json::to_vec(request)?;
    if body.len() > MAX_HOOK_REQUEST_BYTES {
        return Err("hook observation request exceeded its fixed bound".into());
    }
    let headers = format!(
        "POST /agent-observation HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        address.port(),
        body.len()
    );
    let mut stream = tokio::time::timeout(HOOK_CONNECT_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| "hook endpoint connection timed out")?
        .map_err(|_| "hook endpoint connection failed")?;
    stream
        .set_nodelay(true)
        .map_err(|_| "hook endpoint socket configuration failed")?;
    tokio::time::timeout(HOOK_WRITE_TIMEOUT, async {
        stream.write_all(headers.as_bytes()).await?;
        stream.write_all(&body).await?;
        stream.flush().await
    })
    .await
    .map_err(|_| "hook observation write timed out")?
    .map_err(|_| "hook observation write failed")?;

    let mut response = Vec::new();
    let response_bound = MAX_HOOK_RESPONSE_HEADERS_BYTES + MAX_HOOK_RESPONSE_BYTES + 1;
    let mut bounded = (&mut stream).take(response_bound as u64);
    tokio::time::timeout(HOOK_RESPONSE_TIMEOUT, bounded.read_to_end(&mut response))
        .await
        .map_err(|_| "hook endpoint response timed out")?
        .map_err(|_| "hook endpoint response failed")?;
    if response.len() >= response_bound {
        return Err("hook endpoint response exceeded its fixed bound".into());
    }
    decode_hook_http_response(&response)
}

fn decode_hook_http_response(
    response: &[u8],
) -> Result<ControlResponse, Box<dyn std::error::Error>> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .ok_or("hook endpoint returned an invalid HTTP response")?;
    if header_end > MAX_HOOK_RESPONSE_HEADERS_BYTES {
        return Err("hook endpoint response headers exceeded their fixed bound".into());
    }
    let headers = std::str::from_utf8(&response[..header_end])?;
    let mut lines = headers.split("\r\n");
    let status = lines.next().unwrap_or_default();
    if !matches!(status, "HTTP/1.1 200 OK" | "HTTP/1.0 200 OK") {
        return Err("hook endpoint returned a non-success HTTP status".into());
    }
    let content_length = lines
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .ok_or("hook endpoint response omitted its content length")?;
    if content_length > MAX_HOOK_RESPONSE_BYTES {
        return Err("hook endpoint response exceeded its fixed bound".into());
    }
    let body = &response[header_end..];
    if body.len() != content_length {
        return Err("hook endpoint returned an incomplete HTTP response".into());
    }
    Ok(serde_json::from_slice(body)?)
}

async fn read_bounded_hook_input<R>(
    input: R,
    deadline: Duration,
) -> Result<Vec<u8>, Box<dyn std::error::Error>>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut bounded = input.take((MAX_HOOK_INPUT_BYTES + 1) as u64);
    tokio::time::timeout(deadline, bounded.read_to_end(&mut bytes))
        .await
        .map_err(|_| "hook input timed out")??;
    if bytes.len() > MAX_HOOK_INPUT_BYTES {
        return Err("hook input exceeded its fixed bound".into());
    }
    Ok(bytes)
}

fn validate_hook_endpoint(endpoint: &str) -> Result<SocketAddr, Box<dyn std::error::Error>> {
    if endpoint.len() > MAX_HOOK_ENDPOINT_BYTES {
        return Err("hook endpoint exceeded its fixed bound".into());
    }
    let uri: axum::http::Uri = endpoint.parse().map_err(|_| "hook endpoint is invalid")?;
    let port = uri.port_u16().ok_or("hook endpoint has no explicit port")?;
    let authority = uri.authority().ok_or("hook endpoint has no authority")?;
    if uri.scheme_str() != Some("http")
        || authority.as_str() != format!("127.0.0.1:{port}")
        || uri.path_and_query().map(|value| value.as_str()) != Some("/agent-observation")
    {
        return Err("hook endpoint is not the TermLoop loopback observation endpoint".into());
    }
    Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
}

/// A provider transcript grows without bound, so only its tail is ever read —
/// both here at a turn or Session boundary and later by the daemon's interrupt
/// poll, which is why the bound and the read live in one place.
const MAX_TRANSCRIPT_TAIL_BYTES: usize = 256 * 1024;

/// Reads the bounded tail of a Claude transcript as text. A missing,
/// unreadable, or empty transcript is simply no evidence.
pub(crate) fn claude_transcript_tail(path: &std::path::Path) -> Option<String> {
    let tail = termloop_platform::read_file_tail_if_present(path, MAX_TRANSCRIPT_TAIL_BYTES)
        .ok()
        .flatten()?;
    Some(String::from_utf8_lossy(&tail).into_owned())
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

fn observed_model(
    signal: &str,
    payload: &serde_json::Value,
    native_session_id: &str,
) -> Option<String> {
    if !matches!(signal, "Stop" | "StopFailure" | "SessionEnd") {
        return None;
    }
    let tail = claude_transcript_tail(transcript_path(payload)?)?;
    termloop_core::normalize_claude_transcript_model(&tail, native_session_id)
}

/// The provider names its own transcript. Only an absolute JSONL path is
/// accepted, and it never leaves the daemon.
fn transcript_path(payload: &serde_json::Value) -> Option<&std::path::Path> {
    field_str(payload, "transcript_path", "transcriptPath")
        .map(std::path::Path::new)
        .filter(|path| path.is_absolute() && path.extension().is_some_and(|value| value == "jsonl"))
}

/// Claude has emitted both snake_case and camelCase hook payloads, so every
/// field is read under both spellings.
fn field_str<'a>(payload: &'a serde_json::Value, snake: &str, camel: &str) -> Option<&'a str> {
    payload
        .get(snake)
        .or_else(|| payload.get(camel))
        .and_then(serde_json::Value::as_str)
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
