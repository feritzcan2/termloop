use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::{Client, StatusCode, multipart};
use serde::{Deserialize, Serialize};
use termloop_platform::{
    SecureCredentialError, SecureCredentialKey, SecureCredentialStore, SecureSecret,
};
use zeroize::Zeroize;

const OPENAI_API_BASE: &str = "https://api.openai.com/v1";
const OPENAI_CREDENTIAL_SERVICE: &str = "ai.termloop.openai";
const OPENAI_CREDENTIAL_ACCOUNT: &str = "voice";
const MAX_AUDIO_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 64 * 1024;
const MAX_SPEECH_INPUT_BYTES: usize = 8 * 1024;
const MAX_SPEECH_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VoiceProviderError {
    #[error("OpenAI voice credentials are missing")]
    CredentialsMissing,
    #[error("OpenAI voice credentials are unavailable")]
    CredentialsUnavailable,
    #[error("OpenAI rejected the configured voice credentials")]
    CredentialsRejected,
    #[error("voice input is invalid")]
    InvalidInput,
    #[error("OpenAI voice service is unavailable")]
    ProviderUnavailable,
}

/// The fixed OpenAI voice adapter. It owns both the secure credential lookup
/// and the provider HTTP boundary, so neither secret material nor arbitrary
/// endpoints can enter Core, the protocol, or a client.
#[derive(Clone)]
pub struct OpenAiVoiceService {
    credentials: Arc<dyn SecureCredentialStore>,
    client: Client,
    api_base: Arc<str>,
}

impl OpenAiVoiceService {
    pub fn new(credentials: Arc<dyn SecureCredentialStore>) -> Self {
        Self::with_api_base(credentials, OPENAI_API_BASE)
    }

    fn with_api_base(credentials: Arc<dyn SecureCredentialStore>, api_base: &str) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("fixed OpenAI HTTP client configuration is valid");
        Self {
            credentials,
            client,
            api_base: Arc::from(api_base.trim_end_matches('/')),
        }
    }

    pub fn credentials_configured(&self) -> Result<bool, VoiceProviderError> {
        match self.credentials.get(&credential_key()) {
            Ok(_) => Ok(true),
            Err(SecureCredentialError::NotFound) => Ok(false),
            Err(SecureCredentialError::Unavailable) => {
                Err(VoiceProviderError::CredentialsUnavailable)
            }
        }
    }

    pub fn set_api_key(&self, api_key: &str) -> Result<(), VoiceProviderError> {
        if !valid_api_key(api_key) {
            return Err(VoiceProviderError::InvalidInput);
        }
        let secret = SecureSecret::new(api_key.as_bytes().to_vec())
            .ok_or(VoiceProviderError::InvalidInput)?;
        self.credentials
            .set(&credential_key(), &secret)
            .map_err(credential_store_error)
    }

    pub async fn transcribe(
        &self,
        audio: Vec<u8>,
        media_type: &str,
    ) -> Result<String, VoiceProviderError> {
        let (file_name, upload_media_type) = match media_type {
            "audio/m4a" | "audio/mp4" => ("voice-turn.m4a", "audio/mp4"),
            "audio/wav" => ("voice-turn.wav", "audio/wav"),
            _ => return Err(VoiceProviderError::InvalidInput),
        };
        if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES {
            return Err(VoiceProviderError::InvalidInput);
        }
        let authorization = self.authorization().await?;
        let part = multipart::Part::bytes(audio)
            .file_name(file_name)
            .mime_str(upload_media_type)
            .map_err(|_| VoiceProviderError::InvalidInput)?;
        let form = multipart::Form::new()
            .text("model", "gpt-transcribe")
            // Steward voice is a Turkish-first surface. Pinning the ISO-639-1
            // language prevents short or noisy turns from being decoded as a
            // phonetically similar language before the user can correct them.
            .text("language", "tr")
            .part("file", part);
        let response = self
            .client
            .post(format!("{}/audio/transcriptions", self.api_base))
            .header(AUTHORIZATION, authorization)
            .multipart(form)
            .send()
            .await
            .map_err(|_| VoiceProviderError::ProviderUnavailable)?;
        let response = accepted_response(response)?;
        let bytes = response
            .bytes()
            .await
            .map_err(|_| VoiceProviderError::ProviderUnavailable)?;
        if bytes.len() > MAX_TRANSCRIPT_BYTES {
            return Err(VoiceProviderError::ProviderUnavailable);
        }
        let transcript: TranscriptionResponse =
            serde_json::from_slice(&bytes).map_err(|_| VoiceProviderError::ProviderUnavailable)?;
        let text = transcript.text.trim().to_owned();
        if text.is_empty() || text.len() > MAX_TRANSCRIPT_BYTES {
            return Err(VoiceProviderError::InvalidInput);
        }
        Ok(text)
    }

    pub async fn synthesize(&self, text: &str) -> Result<Vec<u8>, VoiceProviderError> {
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_SPEECH_INPUT_BYTES {
            return Err(VoiceProviderError::InvalidInput);
        }
        let authorization = self.authorization().await?;
        let response = self
            .client
            .post(format!("{}/audio/speech", self.api_base))
            .header(AUTHORIZATION, authorization)
            .header(CONTENT_TYPE, "application/json")
            .json(&SpeechRequest {
                model: "gpt-4o-mini-tts",
                voice: "marin",
                input: text,
                instructions: "Türkçe konuş. Sıcak, sakin ve doğal bir tonda; kısa duraklamalarla, net telaffuzla ve telefon ya da Apple Watch hoparlöründe kolay anlaşılacak şekilde seslendir.",
                response_format: "mp3",
            })
            .send()
            .await
            .map_err(|_| VoiceProviderError::ProviderUnavailable)?;
        let response = accepted_response(response)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_SPEECH_BYTES as u64)
        {
            return Err(VoiceProviderError::ProviderUnavailable);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| VoiceProviderError::ProviderUnavailable)?;
        if bytes.is_empty() || bytes.len() > MAX_SPEECH_BYTES {
            return Err(VoiceProviderError::ProviderUnavailable);
        }
        Ok(bytes.to_vec())
    }

    async fn authorization(&self) -> Result<HeaderValue, VoiceProviderError> {
        let credentials = self.credentials.clone();
        let secret = tokio::task::spawn_blocking(move || credentials.get(&credential_key()))
            .await
            .map_err(|_| VoiceProviderError::CredentialsUnavailable)?
            .map_err(credential_store_error)?;
        if !valid_api_key_bytes(secret.expose()) {
            return Err(VoiceProviderError::CredentialsRejected);
        }
        let mut value = Vec::with_capacity(7 + secret.expose().len());
        value.extend_from_slice(b"Bearer ");
        value.extend_from_slice(secret.expose());
        let header =
            HeaderValue::from_bytes(&value).map_err(|_| VoiceProviderError::CredentialsRejected);
        value.zeroize();
        header
    }
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
}

#[derive(Serialize)]
struct SpeechRequest<'a> {
    model: &'a str,
    voice: &'a str,
    input: &'a str,
    instructions: &'a str,
    response_format: &'a str,
}

fn credential_key() -> SecureCredentialKey {
    SecureCredentialKey::new(OPENAI_CREDENTIAL_SERVICE, OPENAI_CREDENTIAL_ACCOUNT)
        .expect("fixed OpenAI credential key is valid")
}

fn credential_store_error(error: SecureCredentialError) -> VoiceProviderError {
    match error {
        SecureCredentialError::NotFound => VoiceProviderError::CredentialsMissing,
        SecureCredentialError::Unavailable => VoiceProviderError::CredentialsUnavailable,
    }
}

fn accepted_response(response: reqwest::Response) -> Result<reqwest::Response, VoiceProviderError> {
    match response.status() {
        status if status.is_success() => Ok(response),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            Err(VoiceProviderError::CredentialsRejected)
        }
        _ => Err(VoiceProviderError::ProviderUnavailable),
    }
}

fn valid_api_key(value: &str) -> bool {
    valid_api_key_bytes(value.as_bytes())
}

fn valid_api_key_bytes(value: &[u8]) -> bool {
    value.len() >= 20
        && value.len() <= 512
        && value.starts_with(b"sk-")
        && value
            .iter()
            .all(|byte| !byte.is_ascii_whitespace() && !byte.is_ascii_control())
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_platform::test_support::MemorySecureCredentialStore;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn api_keys_are_bounded_and_never_accept_whitespace() {
        assert!(valid_api_key("sk-12345678901234567"));
        assert!(!valid_api_key("sk-short"));
        assert!(!valid_api_key("sk-1234567890123456\n"));
        assert!(!valid_api_key(&format!("sk-{}", "x".repeat(510))));
    }

    #[test]
    fn credentials_are_written_only_to_the_injected_secure_store() {
        let service = OpenAiVoiceService::new(Arc::new(MemorySecureCredentialStore::default()));

        assert_eq!(service.credentials_configured(), Ok(false));
        service.set_api_key("sk-12345678901234567").unwrap();
        assert_eq!(service.credentials_configured(), Ok(true));
    }

    #[tokio::test]
    async fn transcription_request_pins_turkish_language() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (body_start, content_length) = loop {
                let count = stream.read(&mut buffer).await.unwrap();
                assert_ne!(count, 0, "HTTP request ended before its multipart body");
                request.extend_from_slice(&buffer[..count]);
                let Some(headers_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..headers_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .expect("multipart request has a content length");
                break (headers_end + 4, content_length);
            };
            while request.len() < body_start + content_length {
                let count = stream.read(&mut buffer).await.unwrap();
                assert_ne!(count, 0, "HTTP request ended before its multipart body");
                request.extend_from_slice(&buffer[..count]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 18\r\nconnection: close\r\n\r\n{\"text\":\"merhaba\"}")
                .await
                .unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });

        let credentials = Arc::new(MemorySecureCredentialStore::default());
        let service = OpenAiVoiceService::with_api_base(credentials, &format!("http://{address}"));
        service.set_api_key("sk-12345678901234567").unwrap();

        assert_eq!(
            service
                .transcribe(b"RIFF-recording".to_vec(), "audio/wav")
                .await,
            Ok("merhaba".into())
        );
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /audio/transcriptions HTTP/1.1\r\n"));
        assert!(request.contains("name=\"model\"\r\n\r\ngpt-transcribe\r\n"));
        assert!(request.contains("name=\"language\"\r\n\r\ntr\r\n"));
        assert!(request.contains("name=\"file\"; filename=\"voice-turn.wav\""));
    }

    #[test]
    fn speech_request_pins_the_model_voice_and_audio_format() {
        let request = SpeechRequest {
            model: "gpt-4o-mini-tts",
            voice: "marin",
            input: "Merhaba",
            instructions: "Net konuş.",
            response_format: "mp3",
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "model": "gpt-4o-mini-tts",
                "voice": "marin",
                "input": "Merhaba",
                "instructions": "Net konuş.",
                "response_format": "mp3",
            })
        );
    }
}
