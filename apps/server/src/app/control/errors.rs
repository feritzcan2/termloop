use termloop_contract::current::{ControlResponse, ErrorCode, ProtocolError, ProtocolErrorDetails};
use termloop_core::CoreError;

pub(in crate::app::control) fn response_error(
    id: String,
    code: ErrorCode,
    message: &str,
) -> ControlResponse {
    ControlResponse {
        id,
        ok: false,
        result: None,
        error: Some(ProtocolError {
            code,
            message: message.to_owned(),
            details: None,
        }),
    }
}

pub(in crate::app::control) fn response_conflict(
    id: String,
    details: ProtocolErrorDetails,
    message: &str,
) -> ControlResponse {
    ControlResponse {
        id,
        ok: false,
        result: None,
        error: Some(ProtocolError {
            code: ErrorCode::Conflict,
            message: message.to_owned(),
            details: Some(details),
        }),
    }
}

pub(in crate::app::control) fn git_observation_error_response(
    id: String,
    error: CoreError,
) -> ControlResponse {
    let (code, message) = match error {
        CoreError::GitUnsupportedVersion => {
            (ErrorCode::UnsupportedVersion, "Git version is unsupported")
        }
        CoreError::GitUnavailable => (ErrorCode::OperationFailed, "Git is unavailable"),
        CoreError::RepositoryPermissionDenied => (
            ErrorCode::OperationFailed,
            "repository permission was denied",
        ),
        CoreError::GitObservationTimedOut => {
            (ErrorCode::OperationFailed, "Git observation timed out")
        }
        CoreError::GitObservationOutputBound => (
            ErrorCode::OperationFailed,
            "Git observation exceeded its output bound",
        ),
        CoreError::CorruptRepository => {
            (ErrorCode::OperationFailed, "repository metadata is corrupt")
        }
        CoreError::UnsupportedRepository => (
            ErrorCode::OperationFailed,
            "repository format is unsupported",
        ),
        CoreError::RepositoryUnavailable => {
            (ErrorCode::OperationFailed, "repository is unavailable")
        }
        _ => unreachable!("non-Git error passed to Git response mapper"),
    };
    response_error(id, code, message)
}

pub(in crate::app::control) fn error_response(id: &str, code: ErrorCode, message: &str) -> String {
    serde_json::to_string(&response_error(id.to_owned(), code, message))
        .expect("error response is serializable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_conflicts_preserve_typed_holder_details() {
        let response = response_conflict(
            "request".into(),
            ProtocolErrorDetails::BranchHeldByTask {
                task_id: "holder-task".into(),
            },
            "branch held",
        );
        let error = response.error.unwrap();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(
            error.details,
            Some(ProtocolErrorDetails::BranchHeldByTask {
                task_id: "holder-task".into(),
            })
        );
    }

    #[test]
    fn git_observation_errors_use_stable_secret_free_wire_results() {
        let cases = [
            (
                CoreError::GitUnavailable,
                ErrorCode::OperationFailed,
                "Git is unavailable",
            ),
            (
                CoreError::GitUnsupportedVersion,
                ErrorCode::UnsupportedVersion,
                "Git version is unsupported",
            ),
            (
                CoreError::RepositoryPermissionDenied,
                ErrorCode::OperationFailed,
                "repository permission was denied",
            ),
            (
                CoreError::GitObservationTimedOut,
                ErrorCode::OperationFailed,
                "Git observation timed out",
            ),
            (
                CoreError::GitObservationOutputBound,
                ErrorCode::OperationFailed,
                "Git observation exceeded its output bound",
            ),
            (
                CoreError::CorruptRepository,
                ErrorCode::OperationFailed,
                "repository metadata is corrupt",
            ),
            (
                CoreError::UnsupportedRepository,
                ErrorCode::OperationFailed,
                "repository format is unsupported",
            ),
        ];
        for (error, code, message) in cases {
            let response = git_observation_error_response("request".into(), error);
            let error = response.error.unwrap();
            assert_eq!(error.code, code);
            assert_eq!(error.message, message);
            assert!(error.details.is_none());
        }
    }
}
