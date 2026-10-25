//! Jira API tokens in the platform credential store. A client hands the
//! secret over once and gets back an opaque handle; the secret is read back
//! only for one provider call and never leaves the daemon, never reaches the
//! PM store, and never appears in a log, event, or result.

use termloop_platform::{
    SecureCredentialError, SecureCredentialKey, SecureCredentialStore, SecureSecret,
};
use termloop_pm_contract::pm::{ErrorCode, PmJiraFailure};

use crate::app::control::errors::ControlError;
use crate::app::control::errors::{error, invalid_parameter};

const JIRA_CREDENTIAL_SERVICE: &str = "dev.termloop.pm.jira";
const JIRA_HANDLE_PREFIX: &str = "pm-jira-";

/// A Jira API token read for one provider call. Its Debug output never shows
/// the secret.
pub(crate) struct JiraToken(String);

impl JiraToken {
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for JiraToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JiraToken(<redacted>)")
    }
}

impl Drop for JiraToken {
    fn drop(&mut self) {
        // Overwrite the bytes before the allocation is released.
        let mut bytes = std::mem::take(&mut self.0).into_bytes();
        bytes.fill(0);
        std::hint::black_box(&bytes);
    }
}

fn valid_handle(handle: &str) -> bool {
    handle.strip_prefix(JIRA_HANDLE_PREFIX).is_some_and(|rest| {
        rest.len() == 36
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    })
}

fn key(handle: &str) -> Option<SecureCredentialKey> {
    valid_handle(handle)
        .then(|| SecureCredentialKey::new(JIRA_CREDENTIAL_SERVICE, handle))
        .flatten()
}

/// Stores a Jira API token under a new handle and returns only the handle.
pub(crate) fn store_jira_token(
    store: &dyn SecureCredentialStore,
    secret: &str,
) -> Result<String, ControlError> {
    let trimmed = secret.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err(invalid_parameter("secret"));
    }
    let secret = SecureSecret::new(trimmed.as_bytes().to_vec())
        .ok_or_else(|| invalid_parameter("secret"))?;
    let handle = format!(
        "{JIRA_HANDLE_PREFIX}{}",
        termloop_platform::generate_uuid_v4()
    );
    let key = key(&handle).ok_or_else(|| error(ErrorCode::Internal, "internal error"))?;
    store.set(&key, &secret).map_err(|failure| {
        tracing::warn!(?failure, "the credential store refused a Jira token");
        error(
            ErrorCode::OperationFailed,
            "the credential store is unavailable",
        )
    })?;
    Ok(handle)
}

/// Removes a stored token; `false` when nothing was stored under the handle.
pub(crate) fn clear(store: &dyn SecureCredentialStore, handle: &str) -> Result<bool, ControlError> {
    let key = key(handle).ok_or_else(|| invalid_parameter("credentialHandle"))?;
    match store.delete(&key) {
        Ok(()) => Ok(true),
        Err(SecureCredentialError::NotFound) => Ok(false),
        Err(failure) => {
            tracing::warn!(?failure, "the credential store refused a delete");
            Err(error(
                ErrorCode::OperationFailed,
                "the credential store is unavailable",
            ))
        }
    }
}

/// Reads the token stored under a handle, for one provider call.
pub(crate) fn resolve(
    store: &dyn SecureCredentialStore,
    handle: &str,
) -> Result<JiraToken, PmJiraFailure> {
    let key = key(handle).ok_or(PmJiraFailure::CredentialMissing)?;
    let secret = store.get(&key).map_err(|failure| match failure {
        SecureCredentialError::NotFound => PmJiraFailure::CredentialMissing,
        _ => PmJiraFailure::Unavailable,
    })?;
    String::from_utf8(secret.expose().to_vec())
        .map(JiraToken)
        .map_err(|_| PmJiraFailure::CredentialMissing)
}
