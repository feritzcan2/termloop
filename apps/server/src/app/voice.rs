use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use termloop_contract::current as protocol;
use termloop_core::{CoreError, VoiceProviderError};

use super::AppState;

pub(in crate::app) const MAX_TRANSCRIPTION_BODY_BYTES: usize = 2 * 1024 * 1024;
pub(in crate::app) const MAX_SPEECH_BODY_BYTES: usize = 16 * 1024;
const VOICE_SETTINGS_FILE: &str = "voice-settings.json";
const VOICE_SETTINGS_FILE_LIMIT: usize = 8 * 1024;
const VOICE_SETTINGS_VERSION: u8 = 1;

#[derive(Clone)]
pub(in crate::app) struct VoiceSettingsStore {
    path: Arc<PathBuf>,
    settings: Arc<StdMutex<VoiceSettingsFile>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceSettingsFile {
    version: u8,
    transcription_keywords: String,
}

impl Default for VoiceSettingsFile {
    fn default() -> Self {
        Self {
            version: VOICE_SETTINGS_VERSION,
            transcription_keywords: String::new(),
        }
    }
}

impl VoiceSettingsStore {
    pub(in crate::app) fn open(state_directory: &Path) -> Self {
        let path = state_directory.join(VOICE_SETTINGS_FILE);
        let settings =
            termloop_platform::read_bounded_file_if_present(&path, VOICE_SETTINGS_FILE_LIMIT)
                .ok()
                .flatten()
                .and_then(|bytes| serde_json::from_slice::<VoiceSettingsFile>(&bytes).ok())
                .filter(|settings| settings.version == VOICE_SETTINGS_VERSION)
                .and_then(|settings| {
                    termloop_core::VoiceService::normalized_transcription_keywords(
                        &settings.transcription_keywords,
                    )
                    .ok()
                    .map(|transcription_keywords| VoiceSettingsFile {
                        transcription_keywords,
                        ..settings
                    })
                })
                .unwrap_or_default();
        Self {
            path: Arc::new(path),
            settings: Arc::new(StdMutex::new(settings)),
        }
    }

    fn transcription_keywords(&self) -> Result<String, CoreError> {
        self.settings
            .lock()
            .map(|settings| settings.transcription_keywords.clone())
            .map_err(|_| CoreError::Store("voice settings are unavailable".into()))
    }

    fn set_transcription_keywords(&self, value: &str) -> Result<String, CoreError> {
        let transcription_keywords =
            termloop_core::VoiceService::normalized_transcription_keywords(value).map_err(
                |error| match error {
                    VoiceProviderError::InvalidInput => {
                        CoreError::InvalidParams("transcriptionKeywords".into())
                    }
                    other => voice_core_error(other),
                },
            )?;
        let next = VoiceSettingsFile {
            version: VOICE_SETTINGS_VERSION,
            transcription_keywords: transcription_keywords.clone(),
        };
        let encoded = serde_json::to_vec_pretty(&next)
            .map_err(|_| CoreError::Store("voice settings could not be encoded".into()))?;
        termloop_platform::atomic_replace_private_file(&self.path, &encoded)
            .map_err(|_| CoreError::Store("voice settings could not be saved".into()))?;
        *self
            .settings
            .lock()
            .map_err(|_| CoreError::Store("voice settings are unavailable".into()))? = next;
        Ok(transcription_keywords)
    }
}

pub(in crate::app) async fn settings_get(
    _params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let voice = state.voice.clone();
    let configured = tokio::task::spawn_blocking(move || voice.credentials_configured())
        .await
        .map_err(|_| CoreError::Store("voice credential worker failed".into()))?
        .map_err(voice_core_error)?;
    let transcription_keywords = state.voice_settings.transcription_keywords()?;
    Ok(json!({
        "configured": configured,
        "transcriptionKeywords": transcription_keywords,
    }))
}

pub(in crate::app) async fn credentials_set(
    params: Value,
    state: &AppState,
) -> Result<Value, CoreError> {
    let params = serde_json::from_value::<protocol::VoiceCredentialsSetParams>(params)
        .expect("validated voice credentials params");
    let settings = state.voice_settings.clone();
    let voice = state.voice.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(api_key) = params.api_key {
            voice.set_api_key(&api_key).map_err(voice_core_error)?;
        }
        settings.set_transcription_keywords(&params.transcription_keywords)?;
        Ok::<_, CoreError>(())
    })
    .await
    .map_err(|_| CoreError::Store("voice settings worker failed".into()))??;
    settings_get(json!({}), state).await
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
    let transcription_keywords = match state.voice_settings.transcription_keywords() {
        Ok(value) => value,
        Err(_) => {
            return voice_http_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "voice settings are unavailable",
            );
        }
    };
    match state
        .voice
        .transcribe(body.to_vec(), media_type, &transcription_keywords)
        .await
    {
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

    fn settings_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "termloop-voice-settings-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn provider_failures_have_stable_non_secret_http_messages() {
        let response = voice_provider_http_error(VoiceProviderError::CredentialsRejected);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = voice_provider_http_error(VoiceProviderError::ProviderUnavailable);
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn transcription_keywords_persist_as_plain_json() {
        let directory = settings_directory("persistence");
        std::fs::create_dir_all(&directory).unwrap();
        let store = VoiceSettingsStore::open(&directory);

        assert_eq!(store.transcription_keywords().unwrap(), "");
        assert_eq!(
            store
                .set_transcription_keywords(" Project Atlas, teammate\nproject atlas ")
                .unwrap(),
            "Project Atlas, teammate"
        );
        let json = std::fs::read_to_string(directory.join(VOICE_SETTINGS_FILE)).unwrap();
        assert!(json.contains("\"transcriptionKeywords\": \"Project Atlas, teammate\""));

        let reopened = VoiceSettingsStore::open(&directory);
        assert_eq!(
            reopened.transcription_keywords().unwrap(),
            "Project Atlas, teammate"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
