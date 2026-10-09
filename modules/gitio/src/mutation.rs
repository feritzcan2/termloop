use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use termloop_platform::CommandTermination;

use crate::command::strip_git_line_cr;
use crate::error::{command_failure, is_permission_denied};
use crate::repository::{GitRefName, ObjectId, parse_oid};
use crate::{GitError, GitOperation, GitRunner};

/// Network-bound fetch of one exact remote branch gets its own bound: it is a
/// mutation stage that talks to a remote, so the interactive observation
/// budget would be far too small, while an unbounded transfer would stall
/// provisioning indefinitely.
pub const FETCH_GIT_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitReflogMessage(Vec<u8>);

impl GitReflogMessage {
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, GitError> {
        if bytes.is_empty()
            || bytes.len() > 128
            || bytes
                .iter()
                .any(|byte| byte.is_ascii_control() || *byte == 0x7f)
        {
            return Err(GitError::ParseFailed {
                operation: GitOperation::CreateRef,
            });
        }
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReflogEntry {
    pub new_oid: ObjectId,
    pub message: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefRecoveryFacts {
    pub current_oid: Option<ObjectId>,
    pub entries: Vec<ReflogEntry>,
}

impl GitRunner {
    pub fn create_branch_ref(
        &self,
        repository_path: &Path,
        reference: &GitRefName,
        target: &ObjectId,
        message: &GitReflogMessage,
    ) -> Result<(), GitError> {
        let reference = process_value(reference.as_bytes(), GitOperation::CreateRef)?;
        let target_value = process_value(target.as_bytes(), GitOperation::CreateRef)?;
        let zero = OsString::from("0".repeat(target.as_bytes().len()));
        let message = process_value(message.as_bytes(), GitOperation::CreateRef)?;
        let outcome = self.execute(
            GitOperation::CreateRef,
            repository_path,
            [
                OsString::from("update-ref"),
                OsString::from("--create-reflog"),
                OsString::from("-m"),
                message,
                reference,
                target_value,
                zero,
            ],
        )?;
        if outcome.success() {
            return Ok(());
        }
        if is_permission_denied(&outcome.stderr) {
            return Err(GitError::PermissionDenied {
                operation: GitOperation::CreateRef,
            });
        }
        if contains(&outcome.stderr, b"reference already exists")
            || contains(&outcome.stderr, b"cannot lock ref")
        {
            return Err(GitError::BranchConflict);
        }
        Err(command_failure(
            GitOperation::CreateRef,
            outcome.termination,
            &outcome.stderr,
        ))
    }

    pub fn add_worktree(
        &self,
        repository_path: &Path,
        destination: &Path,
        reference: &GitRefName,
    ) -> Result<(), GitError> {
        let branch = reference
            .as_bytes()
            .strip_prefix(b"refs/heads/")
            .filter(|value| !value.is_empty())
            .ok_or(GitError::ParseFailed {
                operation: GitOperation::AddWorktree,
            })?;
        // `git worktree add` needs a branch shorthand in order to attach the
        // checkout. Some byte-valid refs are not valid branch shorthands:
        // notably `refs/heads/HEAD` is interpreted as the symbolic HEAD and
        // silently creates a detached checkout. Fail before any mutation.
        if branch == b"HEAD" || branch.starts_with(b"-") {
            return Err(GitError::ParseFailed {
                operation: GitOperation::AddWorktree,
            });
        }
        let branch = process_value(branch, GitOperation::AddWorktree)?;
        let outcome = self.execute(
            GitOperation::AddWorktree,
            repository_path,
            [
                OsString::from("worktree"),
                OsString::from("add"),
                OsString::from("--no-guess-remote"),
                termloop_platform::subprocess_path_argument(destination).into_os_string(),
                branch,
            ],
        )?;
        if outcome.success() {
            return Ok(());
        }
        if is_permission_denied(&outcome.stderr) {
            return Err(GitError::PermissionDenied {
                operation: GitOperation::AddWorktree,
            });
        }
        if contains(&outcome.stderr, b"already checked out at")
            || contains(&outcome.stderr, b"is already used by worktree at")
        {
            return Err(GitError::BranchConflict);
        }
        if contains(&outcome.stderr, b"already exists")
            || contains(&outcome.stderr, b"already registered")
        {
            return Err(GitError::PathConflict);
        }
        if contains(&outcome.stderr, b"locked") {
            return Err(GitError::WorktreeLocked);
        }
        Err(command_failure(
            GitOperation::AddWorktree,
            outcome.termination,
            &outcome.stderr,
        ))
    }

    /// Refreshes exactly one remote-tracking ref from its remote before a
    /// caller resolves it as a base.
    ///
    /// `reference` must be the exact `refs/remotes/<remote>/<branch>` ref the
    /// caller is about to resolve. Only that single refspec is fetched: no
    /// tags, no submodules, no pruning, no `FETCH_HEAD` write, no automatic
    /// maintenance, and no configured-refspec side effects. The remote-tracking
    /// ref is force-updated so a rewritten upstream branch still lands exactly
    /// where the remote currently points.
    pub fn fetch_remote_branch(
        &self,
        repository_path: &Path,
        reference: &GitRefName,
    ) -> Result<(), GitError> {
        let (remote, branch) = split_remote_tracking_ref(reference.as_bytes())?;
        let mut refspec = b"+refs/heads/".to_vec();
        refspec.extend_from_slice(branch);
        refspec.push(b':');
        refspec.extend_from_slice(reference.as_bytes());
        let remote = process_value(remote, GitOperation::FetchRemoteBranch)?;
        let refspec = process_value(&refspec, GitOperation::FetchRemoteBranch)?;
        let outcome = self.execute_with_limits(
            GitOperation::FetchRemoteBranch,
            repository_path,
            [
                OsString::from("fetch"),
                OsString::from("--quiet"),
                OsString::from("--no-tags"),
                OsString::from("--no-recurse-submodules"),
                OsString::from("--no-write-fetch-head"),
                OsString::from("--no-auto-maintenance"),
                remote,
                refspec,
            ],
            FETCH_GIT_DEADLINE,
            self.output_limit(),
        )?;
        if outcome.success() {
            return Ok(());
        }
        if contains(&outcome.stderr, b"couldn't find remote ref")
            || contains(&outcome.stderr, b"no such ref was fetched")
        {
            return Err(GitError::RemoteRefMissing);
        }
        if is_remote_unavailable(&outcome.stderr) {
            return Err(GitError::RemoteUnavailable);
        }
        if is_permission_denied(&outcome.stderr) {
            return Err(GitError::PermissionDenied {
                operation: GitOperation::FetchRemoteBranch,
            });
        }
        Err(command_failure(
            GitOperation::FetchRemoteBranch,
            outcome.termination,
            &outcome.stderr,
        ))
    }

    /// Requests Git's exact non-force worktree removal primitive.
    ///
    /// This method performs no recursive filesystem deletion, pruning, repair,
    /// adoption, branch deletion, or safety decision. The caller must prove the
    /// checkout is the intended managed target immediately before invocation.
    pub fn remove_worktree_non_force(
        &self,
        repository_path: &Path,
        destination: &Path,
    ) -> Result<(), GitError> {
        let outcome = self.execute(
            GitOperation::RemoveWorktree,
            repository_path,
            [
                OsString::from("worktree"),
                OsString::from("remove"),
                OsString::from("--"),
                termloop_platform::subprocess_path_argument(destination).into_os_string(),
            ],
        )?;
        if outcome.success() {
            return Ok(());
        }
        if is_permission_denied(&outcome.stderr) {
            return Err(GitError::PermissionDenied {
                operation: GitOperation::RemoveWorktree,
            });
        }
        if contains(&outcome.stderr, b"locked") {
            return Err(GitError::WorktreeLocked);
        }
        if contains(&outcome.stderr, b"contains modified or untracked files")
            || contains(&outcome.stderr, b"is dirty")
        {
            return Err(GitError::CheckoutContentChanged);
        }
        if contains(&outcome.stderr, b"is not a working tree")
            || contains(&outcome.stderr, b"is not a worktree")
        {
            return Err(GitError::MissingRegistration);
        }
        Err(command_failure(
            GitOperation::RemoveWorktree,
            outcome.termination,
            &outcome.stderr,
        ))
    }

    /// Removes the exact registered worktree while explicitly allowing Git to
    /// discard checkout-local content. This never deletes the branch, prunes,
    /// repairs, adopts, or falls back to recursive filesystem removal.
    pub fn remove_worktree_exact_discarding_checkout_content(
        &self,
        repository_path: &Path,
        destination: &Path,
    ) -> Result<(), GitError> {
        let outcome = self.execute(
            GitOperation::RemoveWorktree,
            repository_path,
            [
                OsString::from("worktree"),
                OsString::from("remove"),
                OsString::from("--force"),
                OsString::from("--"),
                termloop_platform::subprocess_path_argument(destination).into_os_string(),
            ],
        )?;
        if !outcome.success() {
            if is_permission_denied(&outcome.stderr) {
                return Err(GitError::PermissionDenied {
                    operation: GitOperation::RemoveWorktree,
                });
            }
            if contains(&outcome.stderr, b"locked") {
                return Err(GitError::WorktreeLocked);
            }
            if contains(&outcome.stderr, b"is not a working tree")
                || contains(&outcome.stderr, b"is not a worktree")
            {
                return Err(GitError::MissingRegistration);
            }
            return Err(command_failure(
                GitOperation::RemoveWorktree,
                outcome.termination,
                &outcome.stderr,
            ));
        }
        // Successful removal normally deletes the checkout, so the destination
        // has no canonical identity afterwards; canonicalization failure is the
        // expected case and deliberately falls back to the raw comparison.
        let destination_identity = termloop_platform::canonical_directory_if_exists(destination)
            .ok()
            .flatten();
        let still_registered = self
            .list_worktrees(repository_path)?
            .iter()
            .any(|worktree| {
                // Raw recorded bytes cover registrations whose checkout no
                // longer exists on disk and therefore has no canonical path.
                if worktree.registered_path == destination {
                    return true;
                }
                // Git's recorded bytes and a canonicalized destination diverge
                // textually under symlinked prefixes (macOS /tmp ->
                // /private/tmp) and Windows junctions; compare filesystem
                // identities when both sides still exist.
                match (&worktree.path_state, &destination_identity) {
                    (
                        crate::worktree::RegisteredPathState::Present { canonical_path },
                        Some(destination_identity),
                    ) => canonical_path == destination_identity,
                    _ => false,
                }
            });
        if still_registered {
            return Err(GitError::PathConflict);
        }
        Ok(())
    }

    pub fn ref_recovery_facts(
        &self,
        repository_path: &Path,
        reference: &GitRefName,
    ) -> Result<RefRecoveryFacts, GitError> {
        let current_oid = self.resolve_ref(repository_path, reference)?;
        let reference_value = process_value(reference.as_bytes(), GitOperation::ReadReflog)?;
        let exists = self.execute(
            GitOperation::ReadReflog,
            repository_path,
            [
                OsString::from("reflog"),
                OsString::from("exists"),
                reference_value.clone(),
            ],
        )?;
        match exists.termination {
            CommandTermination::Exited { code: 1 } => {
                return Ok(RefRecoveryFacts {
                    current_oid,
                    entries: Vec::new(),
                });
            }
            CommandTermination::Exited { code: 0 } => {}
            termination => {
                return Err(command_failure(
                    GitOperation::ReadReflog,
                    termination,
                    &exists.stderr,
                ));
            }
        }
        let outcome = self.checked(
            GitOperation::ReadReflog,
            repository_path,
            [
                OsString::from("reflog"),
                OsString::from("show"),
                OsString::from("--format=%H%x00%gs%x00"),
                reference_value,
            ],
        )?;
        Ok(RefRecoveryFacts {
            current_oid,
            entries: parse_reflog(&outcome.stdout)?,
        })
    }

    pub fn delete_ref_if_matches(
        &self,
        repository_path: &Path,
        reference: &GitRefName,
        expected: &ObjectId,
    ) -> Result<(), GitError> {
        let reference = process_value(reference.as_bytes(), GitOperation::DeleteRef)?;
        let expected = process_value(expected.as_bytes(), GitOperation::DeleteRef)?;
        let outcome = self.execute(
            GitOperation::DeleteRef,
            repository_path,
            [
                OsString::from("update-ref"),
                OsString::from("-d"),
                reference,
                expected,
            ],
        )?;
        if outcome.success() {
            Ok(())
        } else if matches!(
            outcome.termination,
            CommandTermination::Exited { code: 1 | 128 }
        ) {
            Err(GitError::BranchConflict)
        } else {
            Err(command_failure(
                GitOperation::DeleteRef,
                outcome.termination,
                &outcome.stderr,
            ))
        }
    }
}

/// Splits an exact `refs/remotes/<remote>/<branch>` ref into its remote name
/// and branch name. The branch may itself contain `/`. `HEAD` is refused
/// because `refs/remotes/<remote>/HEAD` is a symbolic pointer, not a branch,
/// and leading `-` components are refused so neither value can be read as an
/// option by `git fetch`.
pub(crate) fn split_remote_tracking_ref(reference: &[u8]) -> Result<(&[u8], &[u8]), GitError> {
    let error = || GitError::ParseFailed {
        operation: GitOperation::FetchRemoteBranch,
    };
    let rest = reference.strip_prefix(b"refs/remotes/").ok_or_else(error)?;
    let separator = rest
        .iter()
        .position(|byte| *byte == b'/')
        .ok_or_else(error)?;
    let (remote, branch) = (&rest[..separator], &rest[separator + 1..]);
    if remote.is_empty()
        || branch.is_empty()
        || branch == b"HEAD"
        || remote.starts_with(b"-")
        || branch.starts_with(b"-")
    {
        return Err(error());
    }
    Ok((remote, branch))
}

/// Transport, resolution, authentication, and missing-remote failures all mean
/// the same thing to a caller: the remote's current state could not be read.
/// They stay one typed classification so no URL, host, or credential detail
/// leaks past this boundary.
fn is_remote_unavailable(stderr: &[u8]) -> bool {
    [
        &b"Could not read from remote repository"[..],
        b"does not appear to be a git repository",
        b"Could not resolve host",
        b"unable to access",
        b"Connection refused",
        b"Connection timed out",
        b"Connection reset",
        b"Network is unreachable",
        b"Authentication failed",
        b"Permission denied (publickey",
        b"Host key verification failed",
        b"could not read Username",
        b"could not read Password",
        b"terminal prompts disabled",
        b"remote error:",
        b"The remote end hung up unexpectedly",
        b"early EOF",
    ]
    .iter()
    .any(|needle| contains(stderr, needle))
}

fn process_value(bytes: &[u8], operation: GitOperation) -> Result<OsString, GitError> {
    termloop_platform::os_string_from_process_bytes(bytes.to_vec())
        .map_err(|error| crate::error::map_platform_error(error, operation))
}

fn parse_reflog(bytes: &[u8]) -> Result<Vec<ReflogEntry>, GitError> {
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            let line = strip_git_line_cr(line);
            let line = line.strip_suffix(&[0]).ok_or(GitError::ParseFailed {
                operation: GitOperation::ReadReflog,
            })?;
            let separator =
                line.iter()
                    .position(|byte| *byte == 0)
                    .ok_or(GitError::ParseFailed {
                        operation: GitOperation::ReadReflog,
                    })?;
            Ok(ReflogEntry {
                new_oid: parse_oid(&line[..separator], GitOperation::ReadReflog)?,
                message: line[separator + 1..].to_vec(),
            })
        })
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
