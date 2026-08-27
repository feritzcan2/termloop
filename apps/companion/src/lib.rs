#![forbid(unsafe_code)]

use std::fmt;
use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use termloop_contract::current::{
    CONTRACT_IDENTITY, CompanionStewardWakeResult, CompanionWakeNextResult, ControlRequest,
    ControlResponse, SystemVersionResult, validate_method_result,
};
use tokio_tungstenite::tungstenite::Message;

const CONTROL_PATH: &str = "/control";
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const WAKE_WAIT_MILLISECONDS: u64 = 30_000;
const RESPONSE_GRACE: Duration = Duration::from_secs(5);
const WAKE_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(250);
const WAKE_RETRY_MAX_DELAY: Duration = Duration::from_secs(4);

#[derive(Clone)]
struct CompanionConfig {
    control_url: String,
    token: String,
}

impl fmt::Debug for CompanionConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CompanionConfig")
            .field("control_url", &self.control_url)
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Debug)]
pub struct CompanionError(&'static str);

impl fmt::Display for CompanionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for CompanionError {}

impl CompanionError {
    fn is_request_refused(&self) -> bool {
        self.0 == "Companion request was refused"
    }
}

impl CompanionConfig {
    fn from_environment() -> Result<Self, CompanionError> {
        let control_url = std::env::var("TERMLOOP_COMPANION_CONTROL_URL")
            .map_err(|_| CompanionError("Companion endpoint is unavailable"))?;
        let token = std::env::var("TERMLOOP_COMPANION_TOKEN")
            .map_err(|_| CompanionError("Companion credential is unavailable"))?;
        Self::new(control_url, token)
    }

    fn new(control_url: String, token: String) -> Result<Self, CompanionError> {
        validate_control_url(&control_url)?;
        if !(32..=256).contains(&token.len()) {
            return Err(CompanionError("Companion credential is invalid"));
        }
        Ok(Self { control_url, token })
    }
}

pub async fn run_from_environment() -> Result<(), CompanionError> {
    run(CompanionConfig::from_environment()?).await
}

async fn run(config: CompanionConfig) -> Result<(), CompanionError> {
    let websocket = tokio_tungstenite::connect_async_with_config(
        config.control_url.as_str(),
        Some(
            tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                .max_message_size(Some(MAX_MESSAGE_BYTES))
                .max_frame_size(Some(MAX_MESSAGE_BYTES)),
        ),
        false,
    )
    .await
    .map_err(|_| CompanionError("Companion transport is unavailable"))?
    .0;
    let (mut sink, mut stream) = websocket.split();
    let mut next_request_id = 1_u64;

    let version: SystemVersionResult = call(
        &mut sink,
        &mut stream,
        &config,
        &mut next_request_id,
        "system.version",
        json!({}),
        RESPONSE_GRACE,
    )
    .await?;
    if version.protocol_version != CONTRACT_IDENTITY {
        return Err(CompanionError("Companion contract identity is unsupported"));
    }
    let mut wake_retry_attempt = 0_u32;

    loop {
        let wake: CompanionWakeNextResult = call(
            &mut sink,
            &mut stream,
            &config,
            &mut next_request_id,
            "companion.wakeNext",
            json!({"waitMilliseconds":WAKE_WAIT_MILLISECONDS}),
            Duration::from_millis(WAKE_WAIT_MILLISECONDS) + RESPONSE_GRACE,
        )
        .await?;
        match (wake.project_id, wake.reason, wake.generation) {
            (None, None, 0) => {
                wake_retry_attempt = 0;
            }
            (Some(project_id), Some(_), generation) if generation > 0 => {
                let delivery: Result<CompanionStewardWakeResult, CompanionError> = call(
                    &mut sink,
                    &mut stream,
                    &config,
                    &mut next_request_id,
                    "companion.stewardWake",
                    json!({"projectId":project_id,"generation":generation}),
                    RESPONSE_GRACE,
                )
                .await;
                match delivery {
                    Ok(result) if result.admitted => wake_retry_attempt = 0,
                    Ok(result) if result.coalesced => {
                        tokio::time::sleep(wake_retry_delay(wake_retry_attempt)).await;
                        wake_retry_attempt = wake_retry_attempt.saturating_add(1);
                    }
                    Ok(_) => {
                        return Err(CompanionError(
                            "Companion wake admission response is inconsistent",
                        ));
                    }
                    Err(error) if error.is_request_refused() => {
                        // A live Steward can temporarily reject generated input
                        // while its previous turn or wake is still settling.
                        // The server deliberately keeps that exact wake in
                        // flight, so stay connected and retry it instead of
                        // crashing the Companion child into a restart loop.
                        tokio::time::sleep(wake_retry_delay(wake_retry_attempt)).await;
                        wake_retry_attempt = wake_retry_attempt.saturating_add(1);
                    }
                    Err(error) => return Err(error),
                }
            }
            _ => return Err(CompanionError("Companion wake response is inconsistent")),
        }
    }
}

fn wake_retry_delay(attempt: u32) -> Duration {
    let multiplier = 1_u32.checked_shl(attempt.min(4)).unwrap_or(16);
    WAKE_RETRY_INITIAL_DELAY
        .saturating_mul(multiplier)
        .min(WAKE_RETRY_MAX_DELAY)
}

async fn call<S, R>(
    sink: &mut S,
    stream: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    config: &CompanionConfig,
    next_request_id: &mut u64,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<R, CompanionError>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    R: serde::de::DeserializeOwned,
{
    let request_id = format!("companion-{}", *next_request_id);
    *next_request_id = next_request_id
        .checked_add(1)
        .ok_or(CompanionError("Companion request sequence exhausted"))?;
    let request = ControlRequest {
        id: request_id.clone(),
        protocol_version: CONTRACT_IDENTITY.to_owned(),
        token: config.token.clone(),
        method: method.to_owned(),
        params,
    };
    let encoded = serde_json::to_string(&request)
        .map_err(|_| CompanionError("Companion request is invalid"))?;
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err(CompanionError("Companion request is too large"));
    }
    sink.send(Message::Text(encoded.into()))
        .await
        .map_err(|_| CompanionError("Companion transport is unavailable"))?;

    let incoming = tokio::time::timeout(timeout, stream.next())
        .await
        .map_err(|_| CompanionError("Companion response timed out"))?
        .ok_or(CompanionError("Companion transport closed"))?
        .map_err(|_| CompanionError("Companion transport is unavailable"))?;
    let Message::Text(text) = incoming else {
        return Err(CompanionError("Companion response is not JSON text"));
    };
    decode_response(&request_id, method, text.as_bytes())
}

fn decode_response<R: serde::de::DeserializeOwned>(
    expected_id: &str,
    method: &str,
    bytes: &[u8],
) -> Result<R, CompanionError> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(CompanionError("Companion response is too large"));
    }
    let response: ControlResponse = serde_json::from_slice(bytes)
        .map_err(|_| CompanionError("Companion response is malformed"))?;
    if response.id != expected_id {
        return Err(CompanionError("Companion response id does not match"));
    }
    match (response.ok, response.result, response.error) {
        (true, Some(result), None) if validate_method_result(method, &result) => {
            serde_json::from_value(result)
                .map_err(|_| CompanionError("Companion response is malformed"))
        }
        (false, None, Some(_)) => Err(CompanionError("Companion request was refused")),
        _ => Err(CompanionError("Companion response is inconsistent")),
    }
}

fn validate_control_url(value: &str) -> Result<(), CompanionError> {
    let authority_and_path = value.strip_prefix("ws://").ok_or(CompanionError(
        "Companion endpoint must use loopback WebSocket",
    ))?;
    if authority_and_path.contains(['?', '#', '@']) {
        return Err(CompanionError("Companion endpoint is invalid"));
    }
    let authority = authority_and_path
        .strip_suffix(CONTROL_PATH)
        .ok_or(CompanionError("Companion endpoint path is invalid"))?;
    let address: SocketAddr = authority
        .parse()
        .map_err(|_| CompanionError("Companion endpoint address is invalid"))?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err(CompanionError("Companion endpoint is not loopback"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn endpoint_and_secret_validation_fail_closed() {
        assert!(CompanionConfig::new("ws://127.0.0.1:1234/control".into(), "x".repeat(32)).is_ok());
        for endpoint in [
            "wss://127.0.0.1:1234/control",
            "ws://10.0.0.1:1234/control",
            "ws://127.0.0.1:1234/other",
            "ws://user@127.0.0.1:1234/control",
            "ws://127.0.0.1:1234/control?token=secret",
        ] {
            assert!(CompanionConfig::new(endpoint.into(), "x".repeat(32)).is_err());
        }
        let config =
            CompanionConfig::new("ws://[::1]:1234/control".into(), "secret".repeat(8)).unwrap();
        assert!(!format!("{config:?}").contains("secret"));
    }

    #[test]
    fn response_requires_exact_id_shape_and_generated_result() {
        let valid = json!({
            "id":"companion-1","ok":true,
            "result":{"projectId":null,"reason":null,"generation":0}
        });
        assert!(
            decode_response::<CompanionWakeNextResult>(
                "companion-1",
                "companion.wakeNext",
                serde_json::to_string(&valid).unwrap().as_bytes(),
            )
            .is_ok()
        );
        for invalid in [
            json!({"id":"other","ok":true,"result":{"projectId":null,"reason":null,"generation":0}}),
            json!({"id":"companion-1","ok":true,"result":{"projectId":null,"reason":null,"generation":0},"error":{"code":"invalidMessage","message":"x"}}),
            json!({"id":"companion-1","ok":true,"result":{"projectId":null,"reason":"unknown","generation":0}}),
            json!({"id":"companion-1","ok":true,"result":{"projectId":null,"reason":null,"generation":0},"extra":true}),
        ] {
            assert!(
                decode_response::<CompanionWakeNextResult>(
                    "companion-1",
                    "companion.wakeNext",
                    serde_json::to_string(&invalid).unwrap().as_bytes(),
                )
                .is_err()
            );
        }
    }

    #[test]
    fn wake_retry_delay_is_exponential_and_bounded() {
        assert_eq!(wake_retry_delay(0), Duration::from_millis(250));
        assert_eq!(wake_retry_delay(1), Duration::from_millis(500));
        assert_eq!(wake_retry_delay(4), Duration::from_secs(4));
        assert_eq!(wake_retry_delay(u32::MAX), Duration::from_secs(4));
    }

    #[tokio::test]
    async fn loopback_client_uses_only_the_closed_wake_sequence() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let token = "t".repeat(32);
        let expected_token = token.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut websocket = tokio_tungstenite::accept_async(stream).await.unwrap();
            for (method, result) in [
                (
                    "system.version",
                    json!({
                        "product":"TermLoop",
                        "version":"0.1.0",
                        "protocolVersion":CONTRACT_IDENTITY
                    }),
                ),
                (
                    "companion.wakeNext",
                    json!({
                        "projectId":"project-1",
                        "reason":"userMessage",
                        "generation":2
                    }),
                ),
                (
                    "companion.stewardWake",
                    json!({"admitted":true,"coalesced":false}),
                ),
            ] {
                let Message::Text(text) = websocket.next().await.unwrap().unwrap() else {
                    panic!("expected JSON request");
                };
                let request: ControlRequest = serde_json::from_str(&text).unwrap();
                assert_eq!(request.protocol_version, CONTRACT_IDENTITY);
                assert_eq!(request.token, expected_token);
                assert_eq!(request.method, method);
                websocket
                    .send(Message::Text(
                        serde_json::to_string(&json!({
                            "id":request.id,
                            "ok":true,
                            "result":result
                        }))
                        .unwrap()
                        .into(),
                    ))
                    .await
                    .unwrap();
            }
            websocket.close(None).await.unwrap();
        });
        let result =
            run(CompanionConfig::new(format!("ws://{address}/control"), token).unwrap()).await;
        assert!(
            result.is_err(),
            "server close should stop the bounded client"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn refused_and_coalesced_steward_wakes_retry_without_reconnecting() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let token = "t".repeat(32);
        let expected_token = token.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut websocket = tokio_tungstenite::accept_async(stream).await.unwrap();
            for (method, response) in [
                (
                    "system.version",
                    json!({
                        "ok":true,
                        "result":{
                            "product":"TermLoop",
                            "version":"0.1.0",
                            "protocolVersion":CONTRACT_IDENTITY
                        }
                    }),
                ),
                (
                    "companion.wakeNext",
                    json!({
                        "ok":true,
                        "result":{
                            "projectId":"project-1",
                            "reason":"routineFinding",
                            "generation":2
                        }
                    }),
                ),
                (
                    "companion.stewardWake",
                    json!({
                        "ok":false,
                        "error":{"code":"serviceBusy","message":"busy"}
                    }),
                ),
                (
                    "companion.wakeNext",
                    json!({
                        "ok":true,
                        "result":{
                            "projectId":"project-1",
                            "reason":"routineFinding",
                            "generation":2
                        }
                    }),
                ),
                (
                    "companion.stewardWake",
                    json!({
                        "ok":true,
                        "result":{"admitted":false,"coalesced":true}
                    }),
                ),
                (
                    "companion.wakeNext",
                    json!({
                        "ok":true,
                        "result":{
                            "projectId":"project-1",
                            "reason":"routineFinding",
                            "generation":2
                        }
                    }),
                ),
                (
                    "companion.stewardWake",
                    json!({
                        "ok":true,
                        "result":{"admitted":true,"coalesced":false}
                    }),
                ),
            ] {
                let Message::Text(text) = websocket.next().await.unwrap().unwrap() else {
                    panic!("expected JSON request");
                };
                let request: ControlRequest = serde_json::from_str(&text).unwrap();
                assert_eq!(request.protocol_version, CONTRACT_IDENTITY);
                assert_eq!(request.token, expected_token);
                assert_eq!(request.method, method);
                let mut response = response;
                response["id"] = json!(request.id);
                websocket
                    .send(Message::Text(
                        serde_json::to_string(&response).unwrap().into(),
                    ))
                    .await
                    .unwrap();
            }
            websocket.close(None).await.unwrap();
        });
        let result =
            run(CompanionConfig::new(format!("ws://{address}/control"), token).unwrap()).await;
        assert!(
            result.is_err(),
            "server close should stop the bounded client"
        );
        server.await.unwrap();
    }
}
