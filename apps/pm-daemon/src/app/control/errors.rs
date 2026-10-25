//! Typed protocol errors: every failure a client sees carries one schema
//! error code, and store or provider failures map onto them exactly.

use termloop_pm::PmError;
use termloop_pm_contract::pm::{ErrorCode, PmJiraFailure, ProtocolError, ProtocolErrorDetails};
use termloop_providers::{JiraSearchError, JiraWriteError};

/// A method failure: one schema-typed protocol error. A local type, so
/// store errors convert with `?`.
#[derive(Debug, Clone)]
pub(crate) struct ControlError(pub(crate) ProtocolError);

impl From<ProtocolError> for ControlError {
    fn from(error: ProtocolError) -> Self {
        Self(error)
    }
}

impl From<PmError> for ControlError {
    fn from(error: PmError) -> Self {
        from_pm(error)
    }
}

pub(crate) fn error(code: ErrorCode, message: impl Into<String>) -> ControlError {
    ControlError(ProtocolError {
        code,
        message: message.into(),
        details: None,
    })
}

pub(crate) fn invalid_parameter(parameter: &str) -> ControlError {
    ControlError(ProtocolError {
        code: ErrorCode::InvalidParams,
        message: format!("invalid {parameter}"),
        details: Some(ProtocolErrorDetails::InvalidParameter {
            parameter: parameter.to_owned(),
        }),
    })
}

pub(crate) fn not_found() -> ControlError {
    error(ErrorCode::NotFound, "not found")
}

pub(crate) fn constraint(reason: &str) -> ControlError {
    ControlError(ProtocolError {
        code: ErrorCode::Constraint,
        message: reason.to_owned(),
        details: Some(ProtocolErrorDetails::Constraint {
            reason: reason.to_owned(),
        }),
    })
}

pub(crate) fn internal() -> ControlError {
    error(ErrorCode::Internal, "internal error")
}

pub(crate) fn jira_failed(reason: PmJiraFailure) -> ControlError {
    ControlError(ProtocolError {
        code: ErrorCode::OperationFailed,
        message: "the Jira request failed".to_owned(),
        details: Some(ProtocolErrorDetails::JiraFailed { reason }),
    })
}

/// A store failure as a protocol error. Storage detail stays in the daemon
/// log; the client sees only the code.
pub(crate) fn from_pm(error: PmError) -> ControlError {
    match error {
        PmError::NotFound => not_found(),
        PmError::Invalid(parameter) => invalid_parameter(parameter),
        PmError::Constraint(reason) => constraint(reason),
        PmError::Conflict => self::error(ErrorCode::Conflict, "conflict with a newer change"),
        PmError::NewerSchema { .. } | PmError::Storage(_) => {
            tracing::warn!(error = %error, "PM store operation failed");
            internal()
        }
    }
}

pub(crate) fn search_failure(error: &JiraSearchError) -> PmJiraFailure {
    match error {
        JiraSearchError::InvalidSite => PmJiraFailure::InvalidSite,
        JiraSearchError::Unauthorized => PmJiraFailure::Unauthorized,
        JiraSearchError::ScopeInvalid => PmJiraFailure::InvalidRequest,
        JiraSearchError::RateLimited { .. } => PmJiraFailure::RateLimited,
        JiraSearchError::Unavailable => PmJiraFailure::Unavailable,
        JiraSearchError::ResponseTooLarge => PmJiraFailure::ResponseTooLarge,
        JiraSearchError::MalformedResponse => PmJiraFailure::MalformedResponse,
    }
}

pub(crate) fn write_failure(error: &JiraWriteError) -> PmJiraFailure {
    match error {
        JiraWriteError::InvalidRequest => PmJiraFailure::InvalidRequest,
        JiraWriteError::Unauthorized => PmJiraFailure::Unauthorized,
        JiraWriteError::Forbidden => PmJiraFailure::Forbidden,
        JiraWriteError::NotFound => PmJiraFailure::NotFound,
        JiraWriteError::Rejected => PmJiraFailure::Rejected,
        JiraWriteError::RateLimited => PmJiraFailure::RateLimited,
        JiraWriteError::Unavailable => PmJiraFailure::Unavailable,
        JiraWriteError::MalformedResponse => PmJiraFailure::MalformedResponse,
    }
}

/// The wire name of a Jira failure, for results that carry it as a value.
pub(crate) fn failure_name(failure: &PmJiraFailure) -> serde_json::Value {
    serde_json::to_value(failure).unwrap_or(serde_json::Value::Null)
}
