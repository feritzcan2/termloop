use std::path::{Path, PathBuf};

use termloop_domain::ProvisioningFailureKind;
use termloop_gitio::{GitError, GitFailureKind, GitRefName, RegisteredPathState, WorktreeFacts};

use crate::CoreError;

pub(super) fn local_branch_ref(branch_name: &str) -> Result<GitRefName, CoreError> {
    // Git accepts `refs/heads/HEAD` as a ref name, but porcelain commands
    // interpret the short `HEAD` token as the symbolic ref and create a
    // detached worktree. Leading dashes are likewise not branch shorthands.
    if branch_name == "HEAD" || branch_name.starts_with('-') {
        return Err(CoreError::InvalidParams("branchName".into()));
    }
    let mut reference = b"refs/heads/".to_vec();
    reference.extend_from_slice(branch_name.as_bytes());
    GitRefName::from_bytes(reference).map_err(|_| CoreError::InvalidParams("branchName".into()))
}

pub(super) fn path_string(path: PathBuf, field: &str) -> Result<String, CoreError> {
    path.into_os_string()
        .into_string()
        .map_err(|_| CoreError::InvalidParams(field.into()))
}

pub(super) fn path_entry_is_absent(path: &Path) -> bool {
    matches!(
        termloop_platform::path_entry_state(path),
        Ok(termloop_platform::PathEntryState::Absent)
    )
}

/// Whether a registered worktree names the exact core-held destination. Git
/// records the drive/plain path form it was handed while core stores the
/// canonical destination (verbatim `\\?\` on Windows), so an existing
/// checkout is matched by canonical filesystem identity; only a registration
/// whose checkout no longer exists falls back to the recorded raw bytes.
pub(super) fn worktree_registered_at(worktree: &WorktreeFacts, destination: &Path) -> bool {
    match &worktree.path_state {
        RegisteredPathState::Present { canonical_path } => canonical_path == destination,
        RegisteredPathState::Missing | RegisteredPathState::NotDirectory => {
            worktree.registered_path == destination
        }
    }
}

pub(super) fn map_git_mutation_error(error: GitError) -> CoreError {
    match error {
        GitError::BranchConflict => CoreError::BranchMutationConflict,
        GitError::PathConflict => CoreError::WorktreePathConflict,
        GitError::WorktreeLocked => CoreError::WorktreeLocked,
        error => map_git_observation_error(error),
    }
}

pub(super) fn provisioning_failure_kind(error: &CoreError) -> ProvisioningFailureKind {
    match error {
        CoreError::GitUnavailable => ProvisioningFailureKind::GitUnavailable,
        CoreError::GitUnsupportedVersion => ProvisioningFailureKind::UnsupportedGit,
        CoreError::RepositoryPermissionDenied => ProvisioningFailureKind::PermissionDenied,
        CoreError::RepositoryUnavailable
        | CoreError::CorruptRepository
        | CoreError::UnsupportedRepository => ProvisioningFailureKind::RepositoryUnavailable,
        CoreError::BranchHeldByTask { .. }
        | CoreError::TaskBranchAlreadyBound { .. }
        | CoreError::BranchCheckedOutElsewhere { .. }
        | CoreError::BranchMutationConflict
        | CoreError::BranchNotFound => ProvisioningFailureKind::BranchConflict,
        CoreError::WorktreePathHeldByTask { .. } | CoreError::WorktreePathConflict => {
            ProvisioningFailureKind::PathConflict
        }
        CoreError::WorktreeLocked => ProvisioningFailureKind::WorktreeLocked,
        CoreError::GitObservationTimedOut => ProvisioningFailureKind::Timeout,
        CoreError::GitObservationOutputBound => ProvisioningFailureKind::OutputLimit,
        CoreError::WorktreeRecoveryAttention { .. } => ProvisioningFailureKind::RecoveryAttention,
        _ => ProvisioningFailureKind::OperationFailed,
    }
}

pub(super) fn map_repository_input_error(error: GitError) -> CoreError {
    match error {
        GitError::NotRepository => CoreError::InvalidParams("repositoryPath".into()),
        GitError::MissingRegistration => CoreError::RepositoryUnavailable,
        error => map_git_observation_error(error),
    }
}

pub(super) fn map_git_observation_error(error: GitError) -> CoreError {
    match error {
        GitError::GitUnavailable => CoreError::GitUnavailable,
        GitError::UnsupportedVersion { .. } => CoreError::GitUnsupportedVersion,
        GitError::PermissionDenied { .. } => CoreError::RepositoryPermissionDenied,
        GitError::Timeout { .. } => CoreError::GitObservationTimedOut,
        GitError::OutputLimitExceeded { .. } => CoreError::GitObservationOutputBound,
        GitError::CommandFailed {
            kind: GitFailureKind::CorruptRepository | GitFailureKind::InvalidConfiguration,
            ..
        } => CoreError::CorruptRepository,
        GitError::CommandFailed {
            kind: GitFailureKind::UnsupportedRepository,
            ..
        } => CoreError::UnsupportedRepository,
        GitError::CommandFailed {
            kind: GitFailureKind::DubiousOwnership,
            ..
        } => CoreError::RepositoryPermissionDenied,
        _ => CoreError::RepositoryUnavailable,
    }
}
