#[derive(Debug, thiserror::Error)]
pub enum PmError {
    #[error("not found")]
    NotFound,
    /// A parameter failed validation; names the parameter.
    #[error("invalid {0}")]
    Invalid(&'static str),
    /// A valid request the current state does not allow.
    #[error("{0}")]
    Constraint(&'static str),
    /// An optimistic version check failed.
    #[error("conflict with a newer change")]
    Conflict,
    #[error("the PM database is at schema {found}, newer than this build's {supported}")]
    NewerSchema { found: u32, supported: u32 },
    #[error("PM storage: {0}")]
    Storage(String),
}

impl From<rusqlite::Error> for PmError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<termloop_platform::PlatformError> for PmError {
    fn from(error: termloop_platform::PlatformError) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<std::io::Error> for PmError {
    fn from(error: std::io::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
