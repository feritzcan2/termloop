//! Claude subscription usage, read with the account's own OAuth credential.
//!
//! The credential never leaves this adapter: it is read from the provider's
//! own store, sent only to the fixed usage endpoint, and zeroized afterwards.
//! An expired token is reported as unavailable rather than refreshed, so the
//! provider CLI stays the only writer of its credential store.

use std::path::Path;
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroize;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const SESSION_MINUTES: u32 = 300;
const WEEK_MINUTES: u32 = 10_080;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentUsageWindowKind {
    Session,
    Weekly,
    WeeklyModel,
    Other,
}

/// One normalized provider limit window, shared by every provider's usage read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageWindow {
    pub kind: AgentUsageWindowKind,
    pub label: String,
    pub used_percent: f64,
    pub window_minutes: Option<u32>,
    pub resets_at_epoch_ms: Option<u64>,
}

impl AgentUsageWindow {
    pub fn new(
        kind: AgentUsageWindowKind,
        label: impl Into<String>,
        used_percent: f64,
        window_minutes: Option<u32>,
        resets_at_epoch_ms: Option<u64>,
    ) -> Option<Self> {
        let label: String = label
            .into()
            .chars()
            .filter(|c| !c.is_control())
            .take(64)
            .collect();
        (used_percent.is_finite() && !label.trim().is_empty()).then(|| Self {
            kind,
            label,
            used_percent: used_percent.clamp(0.0, 100.0),
            window_minutes: window_minutes.filter(|minutes| *minutes > 0),
            resets_at_epoch_ms,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ClaudeUsageError {
    #[error("No Claude subscription sign-in was found for this account")]
    SignedOut,
    #[error("Claude rejected the stored sign-in; open Claude once to refresh it")]
    Rejected,
    #[error("Claude usage is unavailable right now")]
    Unavailable,
}

/// Reads usage for the account whose `CLAUDE_CONFIG_DIR` is `config_directory`
/// (`None` is the server user's own Claude login).
pub fn claude_oauth_usage(
    config_directory: Option<&Path>,
) -> Result<Vec<AgentUsageWindow>, ClaudeUsageError> {
    let mut token = claude_access_token(config_directory)?;
    let result = fetch_usage(&token);
    token.zeroize();
    result
}

/// Claude 2.1+ scopes a named config directory's macOS Keychain item by the
/// first eight hex digits of SHA-256 over the NFC-normalized directory path.
pub fn claude_keychain_service(config_directory: Option<&Path>) -> String {
    match config_directory {
        None => KEYCHAIN_SERVICE.to_owned(),
        Some(directory) => {
            let normalized: String = directory.to_string_lossy().nfc().collect();
            let digest = Sha256::digest(normalized.as_bytes());
            let suffix: String = digest[..4]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("{KEYCHAIN_SERVICE}-{suffix}")
        }
    }
}

fn claude_access_token(config_directory: Option<&Path>) -> Result<String, ClaudeUsageError> {
    let mut bytes = match termloop_platform::read_external_keychain_password(
        &claude_keychain_service(config_directory),
    ) {
        Ok(secret) => secret.expose().to_vec(),
        // Without a Keychain item (or off macOS) Claude keeps the file store.
        Err(_) => credentials_file(config_directory)?,
    };
    let token = access_token_from_credentials(&bytes);
    bytes.zeroize();
    token
}

fn credentials_file(config_directory: Option<&Path>) -> Result<Vec<u8>, ClaudeUsageError> {
    let directory = match config_directory {
        Some(directory) => directory.to_path_buf(),
        None => termloop_platform::user_home_directory()
            .ok_or(ClaudeUsageError::SignedOut)?
            .join(".claude"),
    };
    termloop_platform::read_bounded_file_if_present(
        &directory.join(".credentials.json"),
        MAX_CREDENTIAL_BYTES,
    )
    .map_err(|_| ClaudeUsageError::Unavailable)?
    .ok_or(ClaudeUsageError::SignedOut)
}

fn access_token_from_credentials(bytes: &[u8]) -> Result<String, ClaudeUsageError> {
    #[derive(Deserialize)]
    struct Stored {
        #[serde(rename = "claudeAiOauth")]
        oauth: Option<StoredOauth>,
    }
    #[derive(Deserialize)]
    struct StoredOauth {
        #[serde(rename = "accessToken")]
        access_token: Option<String>,
        #[serde(rename = "expiresAt")]
        expires_at: Option<u64>,
    }
    let stored: Stored =
        serde_json::from_slice(bytes).map_err(|_| ClaudeUsageError::Unavailable)?;
    let oauth = stored.oauth.ok_or(ClaudeUsageError::SignedOut)?;
    let mut token = oauth
        .access_token
        .filter(|token| !token.is_empty())
        .ok_or(ClaudeUsageError::SignedOut)?;
    if oauth
        .expires_at
        .is_some_and(|expires| expires <= termloop_platform::current_epoch_ms())
    {
        token.zeroize();
        return Err(ClaudeUsageError::Rejected);
    }
    Ok(token)
}

fn fetch_usage(token: &str) -> Result<Vec<AgentUsageWindow>, ClaudeUsageError> {
    let mut authorization = format!("Bearer {token}");
    let header = HeaderValue::from_str(&authorization);
    authorization.zeroize();
    let mut header = header.map_err(|_| ClaudeUsageError::Rejected)?;
    header.set_sensitive(true);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ClaudeUsageError::Unavailable)?;
    let response = client
        .get(USAGE_URL)
        .header(AUTHORIZATION, header)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header(USER_AGENT, "claude-code/2.1.0")
        .send()
        .map_err(|_| ClaudeUsageError::Unavailable)?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(ClaudeUsageError::Rejected),
        _ => return Err(ClaudeUsageError::Unavailable),
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ClaudeUsageError::Unavailable);
    }
    let body = response
        .bytes()
        .map_err(|_| ClaudeUsageError::Unavailable)?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(ClaudeUsageError::Unavailable);
    }
    parse_usage(&body).ok_or(ClaudeUsageError::Unavailable)
}

fn parse_usage(body: &[u8]) -> Option<Vec<AgentUsageWindow>> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let mut windows = Vec::new();
    let mut push = |kind, label: &str, raw: &serde_json::Value, minutes| {
        let percent = raw["utilization"]
            .as_f64()
            .or_else(|| raw["used_percentage"].as_f64())
            .or_else(|| raw["percent"].as_f64());
        if let Some(window) = percent.and_then(|percent| {
            AgentUsageWindow::new(
                kind,
                label,
                percent,
                minutes,
                reset_epoch_ms(&raw["resets_at"]),
            )
        }) {
            windows.push(window);
        }
    };
    push(
        AgentUsageWindowKind::Session,
        "Session",
        &value["five_hour"],
        Some(SESSION_MINUTES),
    );
    push(
        AgentUsageWindowKind::Weekly,
        "Weekly",
        &value["seven_day"],
        Some(WEEK_MINUTES),
    );
    for limit in value["limits"].as_array().into_iter().flatten().take(8) {
        let model = limit["scope"]["model"]["display_name"]
            .as_str()
            .map(str::trim);
        if limit["kind"] == "weekly_scoped"
            && let Some(model) = model.filter(|model| !model.is_empty())
        {
            push(
                AgentUsageWindowKind::WeeklyModel,
                &format!("Weekly {model}"),
                limit,
                Some(WEEK_MINUTES),
            );
        }
    }
    windows.truncate(8);
    Some(windows)
}

/// Values above 1e10 are already milliseconds; smaller ones are seconds.
fn reset_epoch_ms(value: &serde_json::Value) -> Option<u64> {
    let numeric = match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    if let Some(number) = numeric {
        let epoch_ms = if number > 10_000_000_000.0 {
            number
        } else {
            number * 1000.0
        };
        return (number.is_finite() && number > 0.0).then_some(epoch_ms as u64);
    }
    crate::parse_rfc3339_epoch_ms(value.as_str()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn named_config_directories_get_their_scoped_keychain_service() {
        assert_eq!(claude_keychain_service(None), "Claude Code-credentials");
        let digest = Sha256::digest("/tmp/accounts/claude/a".as_bytes());
        assert_eq!(
            claude_keychain_service(Some(Path::new("/tmp/accounts/claude/a"))),
            format!(
                "Claude Code-credentials-{:02x}{:02x}{:02x}{:02x}",
                digest[0], digest[1], digest[2], digest[3]
            )
        );
    }

    #[test]
    fn stored_credentials_yield_only_an_unexpired_access_token() {
        let future = termloop_platform::current_epoch_ms() + 60_000;
        assert_eq!(
            access_token_from_credentials(
                json!({"claudeAiOauth":{"accessToken":"t","expiresAt":future}})
                    .to_string()
                    .as_bytes()
            ),
            Ok("t".into())
        );
        assert_eq!(
            access_token_from_credentials(
                json!({"claudeAiOauth":{"accessToken":"t","expiresAt":1}})
                    .to_string()
                    .as_bytes()
            ),
            Err(ClaudeUsageError::Rejected)
        );
        assert_eq!(
            access_token_from_credentials(b"{}"),
            Err(ClaudeUsageError::SignedOut)
        );
    }

    #[test]
    fn usage_windows_normalize_percent_reset_units_and_model_limits() {
        let windows = parse_usage(
            json!({
                "five_hour": {"utilization": 42.5, "resets_at": 1_800_000_000},
                "seven_day": {"used_percentage": 140, "resets_at": "1800000000000"},
                "limits": [
                    {"kind": "weekly_scoped", "percent": 7, "scope": {"model": {"display_name": "Fable"}}},
                    {"kind": "weekly_scoped", "percent": 9, "scope": null}
                ]
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].kind, AgentUsageWindowKind::Session);
        assert_eq!(windows[0].resets_at_epoch_ms, Some(1_800_000_000_000));
        assert_eq!(windows[1].used_percent, 100.0);
        assert_eq!(windows[1].resets_at_epoch_ms, Some(1_800_000_000_000));
        assert_eq!(windows[2].label, "Weekly Fable");
    }
}
