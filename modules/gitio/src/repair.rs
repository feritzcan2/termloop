use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{command_failure, is_permission_denied, map_platform_error};
use crate::{GitError, GitOperation, GitRunner, RegisteredPathState, WorktreeCheckout};

const LINK_FILE_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRepairFacts {
    pub candidate_path: PathBuf,
    pub administrative_dir: PathBuf,
    pub common_dir: PathBuf,
    pub registered_path: PathBuf,
    pub branch_ref: Vec<u8>,
    pub head_matches_branch: bool,
    pub bilateral_link_matches: bool,
    pub registration_matches_proof: bool,
    pub registration_missing_on_disk: bool,
    pub candidate_is_current_path: bool,
    pub repair_class_supported: bool,
    pub worktree_locked: bool,
    pub index_locked: bool,
}

impl GitRunner {
    /// Observes exact linked-worktree metadata without attempting repair.
    pub fn inspect_worktree_repair(
        &self,
        candidate: &Path,
        expected_common_dir: &Path,
        expected_registered_path: &Path,
    ) -> Result<WorktreeRepairFacts, GitError> {
        let candidate_path = termloop_platform::canonical_existing_directory_path(candidate)
            .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
        let git_pointer = read_link_file(&candidate_path.join(".git"))?;
        let admin_bytes = git_pointer
            .strip_prefix(b"gitdir: ")
            .ok_or(GitError::ParseFailed {
                operation: GitOperation::RepairWorktree,
            })?;
        let administrative_dir =
            termloop_platform::path_from_process_bytes(admin_bytes.to_vec())
                .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
        let administrative_dir =
            termloop_platform::canonical_existing_directory_path(&administrative_dir)
                .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
        let common_relative = termloop_platform::path_from_process_bytes(read_link_file(
            &administrative_dir.join("commondir"),
        )?)
        .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
        let common_dir = termloop_platform::canonical_existing_directory_path(
            &administrative_dir.join(common_relative),
        )
        .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
        let expected_common_dir =
            termloop_platform::canonical_existing_directory_path(expected_common_dir)
                .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
        if common_dir != expected_common_dir {
            return Err(GitError::CommandFailed {
                operation: GitOperation::RepairWorktree,
                kind: crate::GitFailureKind::UnsupportedRepository,
                termination: None,
            });
        }
        let registered_git_file = termloop_platform::path_from_process_bytes(read_link_file(
            &administrative_dir.join("gitdir"),
        )?)
        .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
        let registered_path = registered_git_file
            .parent()
            .ok_or(GitError::ParseFailed {
                operation: GitOperation::RepairWorktree,
            })?
            .to_path_buf();
        let branch_ref = read_link_file(&administrative_dir.join("HEAD"))?
            .strip_prefix(b"ref: ")
            .ok_or(GitError::ParseFailed {
                operation: GitOperation::RepairWorktree,
            })?
            .to_vec();
        let registrations = self.list_worktrees(&common_dir)?;
        let mut matching_registrations = registrations.iter().filter(|facts| {
            facts.registered_path == expected_registered_path
                || matches!(&facts.checkout, WorktreeCheckout::Branch { reference, .. } if reference.as_bytes() == branch_ref)
        });
        let registration = matching_registrations
            .next()
            .ok_or(GitError::MissingRegistration)?;
        if matching_registrations.next().is_some() {
            return Err(GitError::ParseFailed {
                operation: GitOperation::RepairWorktree,
            });
        }
        let registration_matches_proof = matches!(&registration.checkout, WorktreeCheckout::Branch { reference, .. } if reference.as_bytes() == branch_ref);
        let branch_name = crate::GitRefName::from_bytes(branch_ref.clone())?;
        let resolved_oid = self.resolve_ref(&common_dir, &branch_name)?;
        let registered_oid = match &registration.checkout {
            WorktreeCheckout::Branch { oid, .. } => oid.as_ref(),
            _ => None,
        };
        let head_matches_branch = resolved_oid.as_ref() == registered_oid && resolved_oid.is_some();
        let registration_missing_on_disk =
            matches!(registration.path_state, RegisteredPathState::Missing);
        let bilateral_link_matches = registered_path == expected_registered_path
            && administrative_dir.starts_with(common_dir.join("worktrees"));
        let candidate_is_current_path = candidate_path == expected_registered_path;
        let moved_link =
            !candidate_is_current_path && bilateral_link_matches && registration_missing_on_disk;
        let stale_current_backlink = candidate_is_current_path
            && registered_path != expected_registered_path
            && registration_missing_on_disk
            && administrative_dir.starts_with(common_dir.join("worktrees"));
        let repair_class_supported = moved_link || stale_current_backlink;
        let worktree_locked = !matches!(registration.locked, crate::WorktreeMarker::Absent);
        let index_locked = matches!(
            termloop_platform::path_entry_state(&administrative_dir.join("index.lock")),
            Ok(termloop_platform::PathEntryState::Present)
        );
        Ok(WorktreeRepairFacts {
            candidate_path,
            administrative_dir,
            common_dir,
            registered_path,
            branch_ref,
            head_matches_branch,
            bilateral_link_matches,
            registration_matches_proof,
            registration_missing_on_disk,
            candidate_is_current_path,
            repair_class_supported,
            worktree_locked,
            index_locked,
        })
    }

    /// Invokes only Git's non-force link-repair primitive.
    pub fn repair_worktree_link(
        &self,
        repository_common_dir: &Path,
        candidate: &Path,
    ) -> Result<(), GitError> {
        let outcome = self.execute(
            GitOperation::RepairWorktree,
            repository_common_dir,
            [
                OsString::from("worktree"),
                OsString::from("repair"),
                OsString::from("--"),
                termloop_platform::subprocess_path_argument(candidate).into_os_string(),
            ],
        )?;
        if outcome.success() {
            return Ok(());
        }
        if is_permission_denied(&outcome.stderr) {
            return Err(GitError::PermissionDenied {
                operation: GitOperation::RepairWorktree,
            });
        }
        Err(command_failure(
            GitOperation::RepairWorktree,
            outcome.termination,
            &outcome.stderr,
        ))
    }
}

fn read_link_file(path: &Path) -> Result<Vec<u8>, GitError> {
    let bytes = termloop_platform::read_bounded_file(path, LINK_FILE_LIMIT)
        .map_err(|error| map_platform_error(error, GitOperation::RepairWorktree))?;
    let trimmed = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    if trimmed.is_empty() || trimmed.contains(&0) {
        return Err(GitError::ParseFailed {
            operation: GitOperation::RepairWorktree,
        });
    }
    Ok(trimmed.to_vec())
}
