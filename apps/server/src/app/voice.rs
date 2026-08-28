use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use termloop_contract::current as protocol;
use termloop_core::{CoreError, VoiceProviderError};

use super::AppState;

pub(in crate::app) const MAX_TRANSCRIPTION_BODY_BYTES: usize = 2 * 1024 * 1024;
pub(in crate::app) const MAX_SPEECH_BODY_BYTES: usize = 16 * 1024;

pub(in crate::app) async fn settings_get(
    _params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let voice = state.voice.clone();
    let configured = tokio::task::spawn_blocking(move || voice.credentials_configured())
        .await
        .map_err(|_| CoreError::Store("voice credential worker failed".into()))?
        .map_err(voice_core_error)?;
    Ok(json!({ "configured": configured }))
}

pub(in crate::app) async fn credentials_set(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::VoiceCredentialsSetParams>(params)
        .expect("validated voice credentials params");
    let voice = state.voice.clone();
    tokio::task::spawn_blocking(move || voice.set_api_key(&params.api_key))
        .await
        .map_err(|_| CoreError::Store("voice credential worker failed".into()))?
        .map_err(voice_core_error)?;
    Ok(json!({ "configured": true }))
}

pub(in crate::app) async fn transcription_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !full_control_authorized(&headers, &state) {
        return voice_http_error(StatusCode::UNAUTHORIZED, "voice authorization is required");
    }
    let media_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default();
    match state.voice.transcribe(body.to_vec(), media_type).await {
        Ok(text) => (StatusCode::OK, Json(json!({ "text": text }))).into_response(),
        Err(error) => voice_provider_http_error(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::app) struct SpeechRequest {
    text: String,
}

pub(in crate::app) async fn speech_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SpeechRequest>,
) -> Response {
    if !full_control_authorized(&headers, &state) {
        return voice_http_error(StatusCode::UNAUTHORIZED, "voice authorization is required");
    }
    match state.voice.synthesize(&request.text).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "audio/mpeg"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => voice_provider_http_error(error),
    }
}

fn full_control_authorized(headers: &HeaderMap, state: &AppState) -> bool {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    super::control::constant_time_equal(token.as_bytes(), state.control_token.as_bytes())
}

fn voice_core_error(error: VoiceProviderError) -> CoreError {
    match error {
        VoiceProviderError::InvalidInput => CoreError::InvalidParams("apiKey".into()),
        VoiceProviderError::CredentialsMissing
        | VoiceProviderError::CredentialsUnavailable
        | VoiceProviderError::CredentialsRejected
        | VoiceProviderError::ProviderUnavailable => {
            CoreError::Store("OpenAI voice credentials are unavailable".into())
        }
    }
}

fn voice_provider_http_error(error: VoiceProviderError) -> Response {
    let (status, message) = match error {
        VoiceProviderError::CredentialsMissing => (
            StatusCode::PRECONDITION_REQUIRED,
            "OpenAI voice is not configured",
        ),
        VoiceProviderError::CredentialsUnavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "voice credential storage is unavailable",
        ),
        VoiceProviderError::CredentialsRejected => (
            StatusCode::UNAUTHORIZED,
            "OpenAI rejected the configured voice credential",
        ),
        VoiceProviderError::InvalidInput => (StatusCode::BAD_REQUEST, "voice input is invalid"),
        VoiceProviderError::ProviderUnavailable => {
            (StatusCode::BAD_GATEWAY, "OpenAI voice is unavailable")
        }
    };
    voice_http_error(status, message)
}

fn voice_http_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_failures_have_stable_non_secret_http_messages() {
        let response = voice_provider_http_error(VoiceProviderError::CredentialsRejected);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = voice_provider_http_error(VoiceProviderError::ProviderUnavailable);
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }
}
