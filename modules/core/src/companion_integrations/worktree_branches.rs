use std::path::Path;

use termloop_gitio::{BranchRemoteFacts, GitError, GitOperation, GitRunner};

const MAX_BRANCH_NAMES: usize = 16;

#[derive(Clone)]
pub(super) struct ObservedBranchFacts {
    pub(super) branches: Vec<BranchRemoteFacts>,
    pub(super) candidate_truncated: bool,
}

pub(super) fn observe(
    runner: &GitRunner,
    repository_root: &Path,
    durable_branch: &str,
    worktree_path: Option<&Path>,
    deadline: termloop_platform::MonotonicDeadline,
) -> Result<ObservedBranchFacts, GitError> {
    let mut names = Vec::<Vec<u8>>::new();
    let mut candidate_truncated = false;
    let mut worktree_branches = Vec::new();
    let mut current_branch = None;

    if let Some(worktree_path) = worktree_path {
        let evidence = deadline
            .remaining()
            .ok_or(GitError::Timeout {
                operation: GitOperation::ReadReflog,
            })
            .and_then(|remaining| {
                runner.observe_worktree_branches_with_timeout(
                    repository_root,
                    worktree_path,
                    remaining,
                )
            });
        match evidence {
            Ok(evidence) => {
                candidate_truncated |= evidence.truncated;
                current_branch = evidence.current_branch;
                worktree_branches = evidence.branches;
            }
            Err(_) => candidate_truncated = true,
        }
    }

    let local_branches = if worktree_branches.is_empty() {
        Vec::new()
    } else {
        match runner.list_local_branches(repository_root) {
            Ok(local) => {
                candidate_truncated |= local.truncated;
                local.branches
            }
            Err(_) => {
                candidate_truncated = true;
                Vec::new()
            }
        }
    };
    if let Some(current) = current_branch.as_ref() {
        push_reference(&mut names, current.as_bytes());
        push_branch_family(&mut names, current.as_bytes(), &local_branches);
    }
    push_name(&mut names, durable_branch.as_bytes());
    for reference in worktree_branches {
        if current_branch.as_ref() == Some(&reference) {
            continue;
        }
        push_reference(&mut names, reference.as_bytes());
        push_branch_family(&mut names, reference.as_bytes(), &local_branches);
    }
    candidate_truncated |= names.len() > MAX_BRANCH_NAMES;
    names.truncate(MAX_BRANCH_NAMES);

    let remaining = deadline.remaining().ok_or(GitError::Timeout {
        operation: GitOperation::Remotes,
    })?;
    let branches = runner.observe_branch_remotes_including_missing_with_timeout(
        repository_root,
        &names,
        remaining,
    )?;
    Ok(ObservedBranchFacts {
        branches,
        candidate_truncated,
    })
}

fn push_reference(names: &mut Vec<Vec<u8>>, reference: &[u8]) {
    if let Some(branch) = reference.strip_prefix(b"refs/heads/") {
        push_name(names, branch);
    }
}

fn push_name(names: &mut Vec<Vec<u8>>, branch: &[u8]) {
    if !branch.is_empty() && !names.iter().any(|name| name == branch) {
        names.push(branch.to_vec());
    }
}

fn push_branch_family(
    names: &mut Vec<Vec<u8>>,
    reference: &[u8],
    local_branches: &[termloop_gitio::GitRefName],
) {
    let Some(seed) = reference.strip_prefix(b"refs/heads/") else {
        return;
    };
    for candidate in local_branches {
        let Some(candidate) = candidate.as_bytes().strip_prefix(b"refs/heads/") else {
            continue;
        };
        if branch_family_member(seed, candidate) {
            push_name(names, candidate);
        }
    }
}

fn branch_family_member(seed: &[u8], candidate: &[u8]) -> bool {
    if seed.contains(&b'/') || !seed.contains(&b'-') || !seed.iter().any(u8::is_ascii_digit) {
        return false;
    }
    let leaf = candidate
        .rsplit(|byte| *byte == b'/')
        .next()
        .unwrap_or(candidate);
    leaf.strip_prefix(seed)
        .and_then(|suffix| suffix.first())
        .is_some_and(|separator| matches!(separator, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_gitio::GitRefName;

    #[test]
    fn current_then_durable_then_history_order_is_deduplicated() {
        let mut names = Vec::new();
        push_reference(
            &mut names,
            GitRefName::from_bytes(b"refs/heads/UKIE-804".to_vec())
                .unwrap()
                .as_bytes(),
        );
        push_name(&mut names, b"termloop/generated");
        push_reference(&mut names, b"refs/heads/UKIE-804");
        push_reference(&mut names, b"refs/heads/UKIE-803");
        assert_eq!(
            names,
            vec![
                b"UKIE-804".to_vec(),
                b"termloop/generated".to_vec(),
                b"UKIE-803".to_vec(),
            ]
        );
    }

    #[test]
    fn branch_family_is_closed_to_a_proven_ticket_shaped_leaf() {
        assert!(branch_family_member(
            b"UKIE-804",
            b"feature/UKIE-804-MASTER"
        ));
        assert!(!branch_family_member(b"UKIE-804", b"feature/UKIE-8042"));
        assert!(!branch_family_member(b"main", b"feature/main-fix"));
        assert!(!branch_family_member(
            b"termloop/UKIE-804",
            b"feature/UKIE-804-MASTER"
        ));
    }
}
