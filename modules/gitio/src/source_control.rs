use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use termloop_platform::{CommandOutcome, CommandTermination};

use crate::changes::parse_change_entries;
use crate::command::GitCommandScope;
use crate::error::{command_failure, contains, is_permission_denied};
use crate::mutation::{FETCH_GIT_DEADLINE, is_remote_unavailable, process_value};
use crate::{
    GitError, GitOperation, GitRunner, HeadState, ObjectId, SourceControlRejection,
    WorktreeChangeEntry,
};

pub const SOURCE_CONTROL_STATUS_DEADLINE: Duration = Duration::from_millis(2_500);
/// Index and worktree writes for one explicit request. Large checkouts can
/// refresh a big index, so this is wider than the interactive status read.
pub const SOURCE_CONTROL_INDEX_DEADLINE: Duration = Duration::from_secs(30);
/// Commit runs the user's own hooks and signing, which may be slow.
pub const SOURCE_CONTROL_COMMIT_DEADLINE: Duration = Duration::from_secs(120);
pub const SOURCE_CONTROL_NETWORK_DEADLINE: Duration = FETCH_GIT_DEADLINE;
const STATUS_OUTPUT_LIMIT: usize = 3 * 1024 * 1024;
/// `git clean` takes paths as arguments; chunking keeps argv bounded.
const CLEAN_PATH_CHUNK: usize = 128;

#[derive(Clone, PartialEq, Eq)]
pub struct SourceControlUpstream {
    /// Git's short upstream name, such as `origin/main`.
    pub name: Vec<u8>,
    /// `None` when the configured upstream ref no longer exists.
    pub ahead_behind: Option<(u64, u64)>,
}

impl std::fmt::Debug for SourceControlUpstream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SourceControlUpstream")
            .field("name_bytes", &self.name.len())
            .field("ahead_behind", &self.ahead_behind)
            .finish()
    }
}

/// One status read carrying both the change list and the branch sync facts,
/// so the panel's counts and its file list come from the same instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceControlStatusObservation {
    pub head: HeadState,
    pub upstream: Option<SourceControlUpstream>,
    pub entries: Vec<WorktreeChangeEntry>,
    pub truncated: bool,
    pub git_process_count: usize,
}

impl GitRunner {
    pub fn observe_source_control_status(
        &self,
        worktree_root: &Path,
    ) -> Result<SourceControlStatusObservation, GitError> {
        let bounded = self
            .clone()
            .with_limits(SOURCE_CONTROL_STATUS_DEADLINE, STATUS_OUTPUT_LIMIT)
            .with_absolute_timeout(SOURCE_CONTROL_STATUS_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, SOURCE_CONTROL_STATUS_DEADLINE)?;
        let output = scope.checked(
            GitOperation::SourceControlStatus,
            worktree_root,
            [
                "status",
                "--porcelain=v2",
                "--branch",
                "--ahead-behind",
                "-z",
                "--no-show-stash",
                "--untracked-files=all",
                "--ignore-submodules=dirty",
            ],
        )?;
        let (entries, truncated) = parse_change_entries(&output.stdout)?;
        let head = crate::repository::parse_status_head(&output.stdout)?;
        let upstream = parse_upstream(&output.stdout)?;
        Ok(SourceControlStatusObservation {
            head,
            upstream,
            entries,
            truncated,
            git_process_count: scope.command_count(),
        })
    }

    /// Stages exactly these paths, including deletions and conflict
    /// resolutions. The caller owns which entries qualify.
    pub fn stage_paths(&self, worktree_root: &Path, paths: &[&Path]) -> Result<(), GitError> {
        self.pathspec_mutation(
            GitOperation::StagePaths,
            worktree_root,
            &["add", "--all"],
            paths,
        )
    }

    /// Returns exactly these index paths to HEAD (or removes them from an
    /// unborn index); the working tree is untouched.
    pub fn unstage_paths(&self, worktree_root: &Path, paths: &[&Path]) -> Result<(), GitError> {
        self.pathspec_mutation(
            GitOperation::UnstagePaths,
            worktree_root,
            &["reset", "--quiet"],
            paths,
        )
    }

    /// Restores the working tree copy of exactly these tracked paths from the
    /// index. Staged content is kept.
    pub fn restore_worktree_paths(
        &self,
        worktree_root: &Path,
        paths: &[&Path],
    ) -> Result<(), GitError> {
        self.pathspec_mutation(
            GitOperation::DiscardPaths,
            worktree_root,
            &["restore", "--worktree"],
            paths,
        )
    }

    /// Deletes exactly these untracked files. Without `-d` or `-x`, Git never
    /// removes a directory, an ignored file, or a nested repository.
    pub fn remove_untracked_files(
        &self,
        worktree_root: &Path,
        paths: &[&Path],
    ) -> Result<(), GitError> {
        for chunk in paths.chunks(CLEAN_PATH_CHUNK) {
            let mut args = vec![
                OsString::from("clean"),
                OsString::from("--force"),
                OsString::from("--quiet"),
                OsString::from("--"),
            ];
            args.extend(chunk.iter().map(|path| path.as_os_str().to_owned()));
            let outcome = self.execute_mutation(
                GitOperation::RemoveUntracked,
                worktree_root,
                args,
                None,
                SOURCE_CONTROL_INDEX_DEADLINE,
            )?;
            ensure_success(GitOperation::RemoveUntracked, &outcome)?;
        }
        Ok(())
    }

    /// Commits the index with this exact message, running the repository's own
    /// hooks and signing configuration. Returns the new HEAD.
    pub fn commit_index(&self, worktree_root: &Path, message: &[u8]) -> Result<ObjectId, GitError> {
        let outcome = self.execute_mutation(
            GitOperation::Commit,
            worktree_root,
            ["commit", "--quiet", "--cleanup=strip", "--file=-"],
            Some(message.to_vec()),
            SOURCE_CONTROL_COMMIT_DEADLINE,
        )?;
        if !outcome.success() {
            return Err(classify_commit_failure(&outcome));
        }
        let head = self.checked(
            GitOperation::Commit,
            worktree_root,
            ["rev-parse", "--verify", "--end-of-options", "HEAD"],
        )?;
        let oid = crate::command::strip_git_line_cr(
            head.stdout.strip_suffix(b"\n").unwrap_or(&head.stdout),
        );
        ObjectId::from_hex(oid.to_vec())
    }

    /// Pushes the current branch to its configured upstream.
    pub fn push_current_branch(&self, worktree_root: &Path) -> Result<(), GitError> {
        let outcome = self.execute_mutation(
            GitOperation::Push,
            worktree_root,
            ["push", "--quiet"],
            None,
            SOURCE_CONTROL_NETWORK_DEADLINE,
        )?;
        network_result(GitOperation::Push, &outcome)
    }

    /// Publishes the current branch to the same name on `remote` and records
    /// it as the branch's upstream.
    pub fn publish_current_branch(
        &self,
        worktree_root: &Path,
        remote: &[u8],
    ) -> Result<(), GitError> {
        if remote.is_empty() || remote.starts_with(b"-") || remote.contains(&0) {
            return Err(GitError::ParseFailed {
                operation: GitOperation::Push,
            });
        }
        let outcome = self.execute_mutation(
            GitOperation::Push,
            worktree_root,
            [
                OsString::from("push"),
                OsString::from("--quiet"),
                OsString::from("--set-upstream"),
                process_value(remote, GitOperation::Push)?,
                OsString::from("HEAD"),
            ],
            None,
            SOURCE_CONTROL_NETWORK_DEADLINE,
        )?;
        network_result(GitOperation::Push, &outcome)
    }

    /// Fast-forwards the current branch to its upstream; never merges or
    /// rebases.
    pub fn pull_fast_forward(&self, worktree_root: &Path) -> Result<(), GitError> {
        let outcome = self.execute_mutation(
            GitOperation::Pull,
            worktree_root,
            ["pull", "--quiet", "--ff-only", "--no-rebase"],
            None,
            SOURCE_CONTROL_NETWORK_DEADLINE,
        )?;
        network_result(GitOperation::Pull, &outcome)
    }

    pub fn fetch_and_prune(&self, worktree_root: &Path) -> Result<(), GitError> {
        let outcome = self.execute_mutation(
            GitOperation::Fetch,
            worktree_root,
            ["fetch", "--quiet", "--prune", "--no-auto-maintenance"],
            None,
            SOURCE_CONTROL_NETWORK_DEADLINE,
        )?;
        network_result(GitOperation::Fetch, &outcome)
    }

    fn pathspec_mutation(
        &self,
        operation: GitOperation,
        worktree_root: &Path,
        command: &[&str],
        paths: &[&Path],
    ) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut pathspecs = Vec::new();
        for path in paths {
            let bytes = termloop_platform::process_bytes_from_os_str(path.as_os_str())
                .map_err(|error| crate::error::map_platform_error(error, operation))?;
            pathspecs.extend_from_slice(&bytes);
            pathspecs.push(0);
        }
        let mut args = command.iter().map(OsString::from).collect::<Vec<_>>();
        args.push(OsString::from("--pathspec-from-file=-"));
        args.push(OsString::from("--pathspec-file-nul"));
        let outcome = self.execute_mutation(
            operation,
            worktree_root,
            args,
            Some(pathspecs),
            SOURCE_CONTROL_INDEX_DEADLINE,
        )?;
        ensure_success(operation, &outcome)
    }
}

fn ensure_success(operation: GitOperation, outcome: &CommandOutcome) -> Result<(), GitError> {
    if outcome.success() {
        Ok(())
    } else {
        Err(command_failure(
            operation,
            outcome.termination,
            &outcome.stderr,
        ))
    }
}

fn classify_commit_failure(outcome: &CommandOutcome) -> GitError {
    // Git prints "nothing to commit" through its status summary on stdout.
    let output = [outcome.stdout.as_slice(), outcome.stderr.as_slice()].concat();
    let rejection = if contains(&output, b"nothing to commit")
        || contains(&output, b"no changes added to commit")
        || contains(&output, b"nothing added to commit")
    {
        SourceControlRejection::NothingToCommit
    } else if contains(&output, b"empty commit message") {
        SourceControlRejection::EmptyMessage
    } else if contains(&output, b"Please tell me who you are")
        || contains(&output, b"unable to auto-detect email address")
        || contains(&output, b"empty ident name")
    {
        SourceControlRejection::IdentityMissing
    } else if contains(&output, b"failed to sign")
        || contains(&output, b"gpg failed")
        || contains(&output, b"cannot run gpg")
    {
        SourceControlRejection::SigningFailed
    } else if contains(&output, b"unmerged files") || contains(&output, b"unresolved conflict") {
        SourceControlRejection::UnmergedPaths
    } else if contains(&output, b"index.lock")
        || !matches!(outcome.termination, CommandTermination::Exited { .. })
    {
        return command_failure(GitOperation::Commit, outcome.termination, &outcome.stderr);
    } else {
        SourceControlRejection::CommitRejected
    };
    GitError::SourceControlRejected(rejection)
}

fn network_result(operation: GitOperation, outcome: &CommandOutcome) -> Result<(), GitError> {
    if outcome.success() {
        return Ok(());
    }
    let stderr = outcome.stderr.as_slice();
    let rejection = if contains(stderr, b"has no upstream branch")
        || contains(stderr, b"There is no tracking information")
        || contains(stderr, b"no such ref was fetched")
    {
        Some(SourceControlRejection::NoUpstream)
    } else if contains(stderr, b"No configured push destination")
        || contains(stderr, b"No remote repository specified")
    {
        Some(SourceControlRejection::NoRemote)
    } else if contains(stderr, b"would be overwritten by merge")
        || contains(stderr, b"commit your changes or stash them")
    {
        Some(SourceControlRejection::LocalChangesWouldBeOverwritten)
    } else if contains(stderr, b"unmerged files") || contains(stderr, b"not concluded your merge") {
        Some(SourceControlRejection::UnmergedPaths)
    } else if contains(stderr, b"Not possible to fast-forward")
        || contains(stderr, b"Diverging branches")
    {
        Some(SourceControlRejection::PullNotFastForward)
    } else if contains(stderr, b"[rejected]")
        || contains(stderr, b"Updates were rejected")
        || contains(stderr, b"[remote rejected]")
    {
        Some(SourceControlRejection::PushRejected)
    } else {
        None
    };
    if let Some(rejection) = rejection {
        return Err(GitError::SourceControlRejected(rejection));
    }
    if contains(stderr, b"couldn't find remote ref") {
        return Err(GitError::RemoteRefMissing);
    }
    if is_remote_unavailable(stderr) {
        return Err(GitError::RemoteUnavailable);
    }
    if is_permission_denied(stderr) {
        return Err(GitError::PermissionDenied { operation });
    }
    if operation == GitOperation::Push && contains(stderr, b"failed to push some refs") {
        // A pre-push hook or a server policy refused without a known marker.
        return Err(GitError::SourceControlRejected(
            SourceControlRejection::PushRejected,
        ));
    }
    Err(command_failure(operation, outcome.termination, stderr))
}

fn parse_upstream(bytes: &[u8]) -> Result<Option<SourceControlUpstream>, GitError> {
    let failure = || GitError::ParseFailed {
        operation: GitOperation::SourceControlStatus,
    };
    let mut name = None;
    let mut counts = None;
    for record in bytes.split(|byte| *byte == 0) {
        if let Some(value) = record.strip_prefix(b"# branch.upstream ") {
            if name.is_some() || value.is_empty() {
                return Err(failure());
            }
            name = Some(value.to_vec());
        } else if let Some(value) = record.strip_prefix(b"# branch.ab ") {
            if counts.is_some() {
                return Err(failure());
            }
            let mut fields = value.split(|byte| *byte == b' ');
            let mut count = |prefix: u8| {
                fields
                    .next()
                    .and_then(|field| field.strip_prefix(&[prefix]))
                    .and_then(|digits| std::str::from_utf8(digits).ok())
                    .and_then(|digits| digits.parse::<u64>().ok())
                    .ok_or_else(failure)
            };
            let ahead = count(b'+')?;
            let behind = count(b'-')?;
            if fields.next().is_some() {
                return Err(failure());
            }
            counts = Some((ahead, behind));
        }
    }
    match (name, counts) {
        (Some(name), ahead_behind) => Ok(Some(SourceControlUpstream { name, ahead_behind })),
        (None, Some(_)) => Err(failure()),
        (None, None) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exited(code: i32, stdout: &[u8], stderr: &[u8]) -> CommandOutcome {
        CommandOutcome {
            termination: CommandTermination::Exited { code },
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    #[test]
    fn upstream_parser_reads_counts_and_a_gone_upstream() {
        let present = b"# branch.oid 0123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0";
        assert_eq!(
            parse_upstream(present).unwrap(),
            Some(SourceControlUpstream {
                name: b"origin/main".to_vec(),
                ahead_behind: Some((2, 1)),
            })
        );
        let gone = b"# branch.head main\0# branch.upstream origin/gone\0";
        assert_eq!(parse_upstream(gone).unwrap().unwrap().ahead_behind, None);
        assert_eq!(parse_upstream(b"# branch.head main\0").unwrap(), None);
        assert!(parse_upstream(b"# branch.ab +1 -0\0").is_err());
        assert!(parse_upstream(b"# branch.upstream o/m\0# branch.ab +x -0\0").is_err());
    }

    #[test]
    fn rejections_are_typed_and_never_carry_git_output() {
        let secret = b"! [rejected] main -> main (fetch first)\nerror: failed to push some refs to 'https://token@example.test/repo'";
        let error = network_result(GitOperation::Push, &exited(1, b"", secret)).unwrap_err();
        assert!(matches!(
            error,
            GitError::SourceControlRejected(SourceControlRejection::PushRejected)
        ));
        assert!(!format!("{error} {error:?}").contains("example.test"));
        for (stderr, expected) in [
            (
                &b"fatal: The current branch topic has no upstream branch."[..],
                SourceControlRejection::NoUpstream,
            ),
            (
                b"fatal: Not possible to fast-forward, aborting.",
                SourceControlRejection::PullNotFastForward,
            ),
            (
                b"error: Your local changes to the following files would be overwritten by merge:",
                SourceControlRejection::LocalChangesWouldBeOverwritten,
            ),
            (
                b"fatal: No configured push destination.",
                SourceControlRejection::NoRemote,
            ),
        ] {
            assert!(matches!(
                network_result(GitOperation::Pull, &exited(1, b"", stderr)),
                Err(GitError::SourceControlRejected(rejection)) if rejection == expected
            ));
        }
        assert!(matches!(
            network_result(
                GitOperation::Fetch,
                &exited(
                    128,
                    b"",
                    b"fatal: unable to access 'https://example.test/': Could not resolve host"
                )
            ),
            Err(GitError::RemoteUnavailable)
        ));
    }

    #[test]
    fn commit_failures_distinguish_nothing_identity_signing_and_hooks() {
        for (stdout, stderr, expected) in [
            (
                &b"On branch main\nnothing to commit, working tree clean\n"[..],
                &b""[..],
                SourceControlRejection::NothingToCommit,
            ),
            (
                b"",
                b"Aborting commit due to empty commit message.",
                SourceControlRejection::EmptyMessage,
            ),
            (
                b"",
                b"Author identity unknown\n*** Please tell me who you are.",
                SourceControlRejection::IdentityMissing,
            ),
            (
                b"",
                b"error: gpg failed to sign the data\nfatal: failed to write commit object",
                SourceControlRejection::SigningFailed,
            ),
            (
                b"",
                b"lint failed: secret-token",
                SourceControlRejection::CommitRejected,
            ),
        ] {
            let error = classify_commit_failure(&exited(1, stdout, stderr));
            assert!(
                matches!(error, GitError::SourceControlRejected(rejection) if rejection == expected),
                "{expected:?}"
            );
            assert!(!format!("{error:?}").contains("secret-token"));
        }
    }
}
