use std::path::Path;
use std::time::Duration;

use termloop_platform::CommandTermination;

use crate::command::{GitCommandScope, strip_git_line_cr};
use crate::{GitError, GitOperation, GitRefName, GitRunner, RegisteredPathState, WorktreeCheckout};

pub const WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT: usize = 256;
const WORKTREE_BRANCH_OUTPUT_LIMIT: usize = 128 * 1024;
const WORKTREE_BRANCH_OBSERVATION_DEADLINE: Duration = Duration::from_millis(2_500);
const CHECKOUT_PREFIX: &[u8] = b"checkout: moving from ";
const CHECKOUT_SEPARATOR: &[u8] = b" to ";

/// Branch names proven by the exact attached worktree. `branches` is ordered
/// current branch first, then checkout-reflog evidence newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeBranchEvidence {
    pub current_branch: Option<GitRefName>,
    pub branches: Vec<GitRefName>,
    pub truncated: bool,
}

impl GitRunner {
    pub fn observe_worktree_branches_with_timeout(
        &self,
        repository_path: &Path,
        worktree_path: &Path,
        timeout: Duration,
    ) -> Result<WorktreeBranchEvidence, GitError> {
        let timeout = timeout.min(WORKTREE_BRANCH_OBSERVATION_DEADLINE);
        let runner = self
            .clone()
            .with_shared_observation_budget(timeout, WORKTREE_BRANCH_OUTPUT_LIMIT)?;
        let mut scope = GitCommandScope::bounded(&runner, timeout)?;

        let repository =
            runner.inspect_repository_identity_in_scope(repository_path, &mut scope)?;
        let worktree = runner.inspect_repository_identity_in_scope(worktree_path, &mut scope)?;
        let requested_worktree =
            termloop_platform::canonical_existing_directory_path(worktree_path).map_err(
                |error| crate::error::map_platform_error(error, GitOperation::RepositoryIdentity),
            )?;
        let worktree_root = worktree
            .worktree_root()
            .ok_or(GitError::MissingRegistration)?;
        if repository.common_dir() != worktree.common_dir() || worktree_root != requested_worktree {
            return Err(GitError::MissingRegistration);
        }

        let registration = runner
            .list_worktrees_in_scope(repository_path, &mut scope)?
            .into_iter()
            .find(|registration| {
                matches!(
                    &registration.path_state,
                    RegisteredPathState::Present { canonical_path }
                        if canonical_path == worktree_root
                )
            })
            .ok_or(GitError::MissingRegistration)?;

        let current = match registration.checkout {
            WorktreeCheckout::Branch { reference, .. } => Some(reference),
            WorktreeCheckout::Detached { .. } | WorktreeCheckout::Bare => None,
        };
        let mut evidence = WorktreeBranchEvidence {
            current_branch: current.clone(),
            branches: current.into_iter().collect(),
            truncated: false,
        };

        let reflog_exists = match scope.execute(
            GitOperation::ReadReflog,
            worktree_root,
            ["reflog", "exists", "HEAD"],
        ) {
            Ok(outcome) => outcome,
            Err(_) => {
                evidence.truncated = true;
                return Ok(evidence);
            }
        };
        if !matches!(
            reflog_exists.termination,
            CommandTermination::Exited { code: 0 }
        ) {
            evidence.truncated = true;
            return Ok(evidence);
        }

        let outcome = match scope.execute(
            GitOperation::ReadReflog,
            worktree_root,
            [
                "reflog",
                "show",
                "--format=%gs%x00",
                "--max-count=257",
                "HEAD",
            ],
        ) {
            Ok(outcome) => outcome,
            Err(_) => {
                evidence.truncated = true;
                return Ok(evidence);
            }
        };
        if !matches!(outcome.termination, CommandTermination::Exited { code: 0 }) {
            evidence.truncated = true;
            return Ok(evidence);
        }

        let (historical, truncated) = match parse_checkout_reflog(&outcome.stdout) {
            Ok(parsed) => parsed,
            Err(_) => {
                evidence.truncated = true;
                return Ok(evidence);
            }
        };
        evidence.truncated = truncated;
        for reference in historical {
            if !evidence.branches.contains(&reference) {
                evidence.branches.push(reference);
            }
        }
        Ok(evidence)
    }
}

fn parse_checkout_reflog(bytes: &[u8]) -> Result<(Vec<GitRefName>, bool), GitError> {
    if bytes.is_empty() {
        return Ok((Vec::new(), false));
    }
    if !bytes.ends_with(b"\n") {
        return parse_failure();
    }
    let mut entries = 0usize;
    let mut branches = Vec::new();
    for line in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        let line = strip_git_line_cr(line);
        let subject = line.strip_suffix(&[0]).ok_or(GitError::ParseFailed {
            operation: GitOperation::ReadReflog,
        })?;
        entries += 1;
        if entries > WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT {
            continue;
        }
        let Some(transition) = subject.strip_prefix(CHECKOUT_PREFIX) else {
            continue;
        };
        let Some(separator) = find_bytes(transition, CHECKOUT_SEPARATOR) else {
            return parse_failure();
        };
        let from = &transition[..separator];
        let to = &transition[separator + CHECKOUT_SEPARATOR.len()..];
        for candidate in [to, from] {
            if let Some(reference) = local_branch_reference(candidate)
                && !branches.contains(&reference)
            {
                branches.push(reference);
            }
        }
    }
    Ok((branches, entries > WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT))
}

fn local_branch_reference(candidate: &[u8]) -> Option<GitRefName> {
    if candidate.is_empty()
        || candidate == b"HEAD"
        || matches!(candidate.len(), 40 | 64) && candidate.iter().all(u8::is_ascii_hexdigit)
    {
        return None;
    }
    let mut reference = b"refs/heads/".to_vec();
    reference.extend_from_slice(candidate);
    GitRefName::from_bytes(reference).ok()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_failure<T>() -> Result<T, GitError> {
    Err(GitError::ParseFailed {
        operation: GitOperation::ReadReflog,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_checkout_branches_newest_first_and_rejects_detached_oids() {
        let oid = b"1234567890123456789012345678901234567890";
        let mut bytes = b"commit: ignored\0\ncheckout: moving from feature/one to UKIE-804\0\ncheckout: moving from ".to_vec();
        bytes.extend_from_slice(oid);
        bytes.extend_from_slice(b" to feature/one\0\n");
        let (branches, truncated) = parse_checkout_reflog(&bytes).unwrap();
        assert!(!truncated);
        assert_eq!(
            branches
                .iter()
                .map(|branch| branch.as_bytes())
                .collect::<Vec<_>>(),
            vec![
                b"refs/heads/UKIE-804".as_slice(),
                b"refs/heads/feature/one".as_slice(),
            ]
        );
    }

    #[test]
    fn malformed_checkout_transition_fails_closed() {
        assert!(parse_checkout_reflog(b"checkout: moving from feature\0\n").is_err());
    }

    #[test]
    fn reflog_entry_limit_is_explicitly_truncated() {
        let mut bytes = Vec::new();
        for _ in 0..=WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT {
            bytes.extend_from_slice(b"commit: fixture\0\n");
        }
        let (branches, truncated) = parse_checkout_reflog(&bytes).unwrap();
        assert!(branches.is_empty());
        assert!(truncated);
    }
}
