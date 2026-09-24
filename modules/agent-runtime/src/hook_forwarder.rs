use serde::{Deserialize, Serialize};
use serde_json::json;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use uuid::Uuid;

pub const MAX_HOOK_INPUT_BYTES: usize = 1024 * 1024;
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

pub struct HookClientConfig {
    pub address: SocketAddr,
    token: String,
    pub session_id: String,
    agent_id: String,
}

impl HookClientConfig {
    pub fn from_environment() -> Result<Self, Box<dyn std::error::Error>> {
        Self::new(
            std::env::var("TERMLOOP_HOOK_ENDPOINT")?,
            std::env::var("TERMLOOP_HOOK_TOKEN")?,
            std::env::var("TERMLOOP_SESSION_ID")?,
            std::env::var("TERMLOOP_AGENT_ID")?,
        )
    }

    pub fn new(
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
        if !termloop_agents::supports_provider_hook_observation(&agent_id) {
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
pub async fn run_hook_client<P: HookProtocol>(
    protocol: P,
) -> Result<(), Box<dyn std::error::Error>> {
    run_hook_best_effort(HOOK_TOTAL_TIMEOUT, async {
        let config = HookClientConfig::from_environment()?;
        forward_hook(tokio::io::stdin(), config, &protocol).await
    })
    .await;
    Ok(())
}

pub async fn run_hook_best_effort<F>(deadline: Duration, operation: F)
where
    F: Future<Output = Result<(), Box<dyn std::error::Error>>>,
{
    let _ = tokio::time::timeout(deadline, operation).await;
}

pub async fn forward_hook<R, P: HookProtocol>(
    input: R,
    config: HookClientConfig,
    protocol: &P,
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
        .then(|| termloop_agents::normalize_claude_plan_update(&payload))
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
            termloop_agents::AgentPlanUpdate::Replace(plan) => json!({
                "kind": "replace",
                "explanation": plan.explanation,
                "steps": plan.steps,
            }),
            termloop_agents::AgentPlanUpdate::UpsertTask {
                task_id,
                text,
                status,
            } => json!({
                "kind": "upsertTask",
                "taskId": task_id,
                "text": text,
                "status": status,
            }),
            termloop_agents::AgentPlanUpdate::SetTaskStatus { task_id, status } => json!({
                "kind": "setTaskStatus",
                "taskId": task_id,
                "status": status,
            }),
            termloop_agents::AgentPlanUpdate::RemoveTask { task_id } => json!({
                "kind": "removeTask",
                "taskId": task_id,
            }),
        };
    }
    let request_id = Uuid::new_v4().to_string();
    let request = protocol.encode(&request_id, &config.token, params)?;
    let response = post_hook_observation(config.address, &request).await?;
    protocol.accept(&request_id, response)
}

pub async fn post_hook_observation(
    address: SocketAddr,
    request: &serde_json::Value,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    if address.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) || address.port() == 0 {
        return Err("hook endpoint must be loopback".into());
    }
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
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
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

pub async fn read_bounded_hook_input<R>(
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
    let port = endpoint
        .strip_prefix("http://127.0.0.1:")
        .and_then(|text| text.strip_suffix("/agent-observation"))
        .and_then(|text| text.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or("hook endpoint is not a loopback observation endpoint")?;
    if endpoint != format!("http://127.0.0.1:{port}/agent-observation") {
        return Err("hook endpoint is not a canonical loopback observation endpoint".into());
    }
    Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
}

/// A provider transcript grows without bound, so only its tail is ever read —
/// both here at a turn or Session boundary and later by the daemon's interrupt
/// poll, which is why the bound and the read live in one place.
const MAX_TRANSCRIPT_TAIL_BYTES: usize = 256 * 1024;

/// Reads the bounded tail of a Claude transcript as text. A missing,
/// unreadable, or empty transcript is simply no evidence.
pub fn claude_transcript_tail(path: &std::path::Path) -> Option<String> {
    let tail = termloop_platform::read_file_tail_if_present(path, MAX_TRANSCRIPT_TAIL_BYTES)
        .ok()
        .flatten()?;
    Some(String::from_utf8_lossy(&tail).into_owned())
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
    termloop_agents::normalize_claude_transcript_model(&tail, native_session_id)
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

/// Product protocols can wrap the same normalized observation without making
/// the engine depend on their generated control contract.
pub trait HookProtocol {
    fn encode(
        &self,
        id: &str,
        token: &str,
        observation: serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>>;
    fn accept(
        &self,
        id: &str,
        response: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookObservationEnvelope {
    pub id: String,
    pub protocol_version: u32,
    pub token: String,
    pub observation: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookObservationReceipt {
    pub id: String,
    pub protocol_version: u32,
    pub accepted: bool,
}

pub struct EngineHookProtocol;
impl HookProtocol for EngineHookProtocol {
    fn encode(
        &self,
        id: &str,
        token: &str,
        observation: serde_json::Value,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(serde_json::to_value(HookObservationEnvelope {
            id: id.into(),
            protocol_version: 1,
            token: token.into(),
            observation,
        })?)
    }
    fn accept(
        &self,
        id: &str,
        response: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let receipt: HookObservationReceipt = serde_json::from_value(response)?;
        if receipt.id != id || receipt.protocol_version != 1 || !receipt.accepted {
            return Err("hook observation was rejected".into());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "hook_tests.rs"]
mod tests;
