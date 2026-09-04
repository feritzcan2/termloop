use termloop_platform::{CommandTermination, PlatformError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitOperation {
    Discover,
    RepositoryIdentity,
    Head,
    ResolveRef,
    ListLocalBranches,
    ListRemoteBranches,
    ListWorktrees,
    Health,
    Status,
    Submodules,
    Upstream,
    Remotes,
    CreateRef,
    ReadReflog,
    DeleteRef,
    AddWorktree,
    RemoveWorktree,
    RepairWorktree,
    ListChanges,
    Diff,
    BranchCommitSummary,
    CommitChanges,
    ReadPreImage,
}

impl std::fmt::Display for GitOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Discover => "discover",
            Self::RepositoryIdentity => "repositoryIdentity",
            Self::Head => "head",
            Self::ResolveRef => "resolveRef",
            Self::ListLocalBranches => "listLocalBranches",
            Self::ListRemoteBranches => "listRemoteBranches",
            Self::ListWorktrees => "listWorktrees",
            Self::Health => "health",
            Self::Status => "status",
            Self::Submodules => "submodules",
            Self::Upstream => "upstream",
            Self::Remotes => "remotes",
            Self::CreateRef => "createRef",
            Self::ReadReflog => "readReflog",
            Self::DeleteRef => "deleteRef",
            Self::AddWorktree => "addWorktree",
            Self::RemoveWorktree => "removeWorktree",
            Self::RepairWorktree => "repairWorktree",
            Self::ListChanges => "listChanges",
            Self::Diff => "diff",
            Self::ReadPreImage => "readPreImage",
            Self::BranchCommitSummary => "branchCommitSummary",
            Self::CommitChanges => "commitChanges",
        };
        formatter.write_str(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitFailureKind {
    Exit,
    Signal,
    Io,
    MalformedOutput,
    LockContention,
    InvalidConfiguration,
    UnsupportedRepository,
    CorruptRepository,
    DubiousOwnership,
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum GitError {
    NotRepository,
    GitUnavailable,
    CommandFailed {
        operation: GitOperation,
        kind: GitFailureKind,
        termination: Option<CommandTermination>,
    },
    BranchConflict,
    CheckoutContentChanged,
    PathConflict,
    WorktreeLocked,
    MissingRegistration,
    PermissionDenied {
        operation: GitOperation,
    },
    Timeout {
        operation: GitOperation,
    },
    OutputLimitExceeded {
        operation: GitOperation,
    },
    UnsupportedVersion {
        version: String,
        capability: &'static str,
    },
    ParseFailed {
        operation: GitOperation,
    },
}

impl std::fmt::Display for GitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRepository => {
                formatter.write_str("the requested path is not inside a Git repository")
            }
            Self::GitUnavailable => formatter.write_str("Git is unavailable"),
            Self::CommandFailed {
                operation, kind, ..
            } => write!(formatter, "Git operation {operation} failed ({kind:?})"),
            Self::BranchConflict => {
                formatter.write_str("the requested branch conflicts with an existing binding")
            }
            Self::CheckoutContentChanged => {
                formatter.write_str("checkout content changed before worktree removal")
            }
            Self::PathConflict => {
                formatter.write_str("the requested path conflicts with an existing checkout")
            }
            Self::WorktreeLocked => formatter.write_str("the worktree is locked"),
            Self::MissingRegistration => {
                formatter.write_str("the worktree registration is missing")
            }
            Self::PermissionDenied { operation } => {
                write!(
                    formatter,
                    "permission was denied during Git operation {operation}"
                )
            }
            Self::Timeout { operation } => write!(formatter, "Git operation {operation} timed out"),
            Self::OutputLimitExceeded { operation } => {
                write!(
                    formatter,
                    "Git operation {operation} exceeded its output bound"
                )
            }
            Self::UnsupportedVersion {
                version,
                capability,
            } => write!(formatter, "Git {version} does not support {capability}"),
            Self::ParseFailed { operation } => {
                write!(formatter, "Git output for {operation} was unsupported")
            }
        }
    }
}

impl std::error::Error for GitError {}

pub(crate) fn map_platform_error(error: PlatformError, operation: GitOperation) -> GitError {
    match error {
        PlatformError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            GitError::GitUnavailable
        }
        PlatformError::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            GitError::PermissionDenied { operation }
        }
        _ => GitError::CommandFailed {
            operation,
            kind: GitFailureKind::Io,
            termination: None,
        },
    }
}

pub(crate) fn command_failure(
    operation: GitOperation,
    termination: CommandTermination,
    stderr: &[u8],
) -> GitError {
    if is_permission_denied(stderr) {
        return GitError::PermissionDenied { operation };
    }
    let kind = match termination {
        CommandTermination::Signaled { .. } => GitFailureKind::Signal,
        _ => classify_stderr(stderr),
    };
    GitError::CommandFailed {
        operation,
        kind,
        termination: Some(termination),
    }
}

pub(crate) fn is_permission_denied(stderr: &[u8]) -> bool {
    contains(stderr, b"Permission denied")
        || contains(stderr, b"Operation not permitted")
        || contains(stderr, b"Access is denied")
}

pub(crate) fn repository_failure(
    operation: GitOperation,
    termination: CommandTermination,
    stderr: &[u8],
) -> GitError {
    if contains(
        stderr,
        b"not a git repository (or any of the parent directories)",
    ) {
        GitError::NotRepository
    } else if contains(stderr, b"not a git repository:") {
        GitError::MissingRegistration
    } else if contains(stderr, b"detected dubious ownership")
        || contains(stderr, b"unsafe repository")
    {
        GitError::PermissionDenied { operation }
    } else {
        command_failure(operation, termination, stderr)
    }
}

fn classify_stderr(stderr: &[u8]) -> GitFailureKind {
    if contains(stderr, b"index.lock") {
        GitFailureKind::LockContention
    } else if contains(stderr, b"bad config line") {
        GitFailureKind::InvalidConfiguration
    } else if contains(stderr, b"unsupported repository extension")
        || contains(stderr, b"unknown repository extension")
    {
        GitFailureKind::UnsupportedRepository
    } else if contains(stderr, b"bad object") || contains(stderr, b"corrupt") {
        GitFailureKind::CorruptRepository
    } else if contains(stderr, b"detected dubious ownership") {
        GitFailureKind::DubiousOwnership
    } else {
        GitFailureKind::Exit
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_errors_never_retain_raw_stderr() {
        let error = command_failure(
            GitOperation::Discover,
            CommandTermination::Exited { code: 1 },
            b"fatal: https://user:password@example.test/repository?token=query-secret#fragment-secret failed; user:password@example.test:scp-secret remains",
        );
        let display = format!("{error}");
        let debug = format!("{error:?}");
        for raw_fragment in [
            "user",
            "password",
            "example.test",
            "query-secret",
            "fragment-secret",
            "scp-secret",
        ] {
            assert!(!display.contains(raw_fragment));
            assert!(!debug.contains(raw_fragment));
        }
        assert!(matches!(
            error,
            GitError::CommandFailed {
                kind: GitFailureKind::Exit,
                ..
            }
        ));
    }

    #[test]
    fn repository_failures_have_stable_typed_classification() {
        let exit = CommandTermination::Exited { code: 128 };
        assert!(matches!(
            repository_failure(
                GitOperation::RepositoryIdentity,
                exit,
                b"fatal: not a git repository (or any of the parent directories): .git"
            ),
            GitError::NotRepository
        ));
        assert!(matches!(
            repository_failure(
                GitOperation::RepositoryIdentity,
                exit,
                b"fatal: not a git repository: /repo/.git/worktrees/missing"
            ),
            GitError::MissingRegistration
        ));
        assert!(matches!(
            repository_failure(
                GitOperation::RepositoryIdentity,
                exit,
                b"fatal: detected dubious ownership in repository at '/repo'"
            ),
            GitError::PermissionDenied { .. }
        ));
        assert!(matches!(
            command_failure(
                GitOperation::RepositoryIdentity,
                exit,
                b"fatal: bad config line 1 in file .git/config"
            ),
            GitError::CommandFailed {
                kind: GitFailureKind::InvalidConfiguration,
                ..
            }
        ));
    }

    #[test]
    fn command_permission_failures_are_typed_without_retaining_diagnostics() {
        let error = command_failure(
            GitOperation::CreateRef,
            CommandTermination::Exited { code: 128 },
            b"fatal: cannot lock ref 'refs/heads/private': Permission denied secret-path",
        );
        assert!(matches!(error, GitError::PermissionDenied { .. }));
        assert!(!format!("{error:?}").contains("secret-path"));
    }
}
