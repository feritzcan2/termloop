use std::path::{Path, PathBuf};

use crate::command::GitCommandScope;
use crate::error::map_platform_error;
use crate::repository::{GitRefName, ObjectId, parse_oid};
use crate::{GitError, GitOperation, GitRunner};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitText(Vec<u8>);

impl GitText {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeMarker {
    Absent,
    Present { reason: Option<GitText> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeCheckout {
    Bare,
    Branch {
        reference: GitRefName,
        oid: Option<ObjectId>,
    },
    Detached {
        oid: ObjectId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegisteredPathState {
    Present { canonical_path: PathBuf },
    Missing,
    NotDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeFacts {
    pub registered_path: PathBuf,
    pub path_state: RegisteredPathState,
    pub checkout: WorktreeCheckout,
    pub locked: WorktreeMarker,
    pub prunable: WorktreeMarker,
    pub is_main: bool,
}

impl GitRunner {
    pub fn list_worktrees(&self, repository_path: &Path) -> Result<Vec<WorktreeFacts>, GitError> {
        let mut scope = GitCommandScope::new(self);
        self.list_worktrees_in_scope(repository_path, &mut scope)
    }

    pub(crate) fn list_worktrees_in_scope(
        &self,
        repository_path: &Path,
        scope: &mut GitCommandScope<'_>,
    ) -> Result<Vec<WorktreeFacts>, GitError> {
        if !self.capabilities().worktree_porcelain_nul {
            return Err(GitError::UnsupportedVersion {
                version: self.version().to_string(),
                capability: "NUL-delimited worktree porcelain",
            });
        }
        let repository_path =
            match termloop_platform::canonical_existing_directory_path(repository_path) {
                Ok(path) => path,
                Err(termloop_platform::PlatformError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
                    ) =>
                {
                    return Err(GitError::NotRepository);
                }
                Err(error) => return Err(map_platform_error(error, GitOperation::ListWorktrees)),
            };
        let outcome = scope.checked(
            GitOperation::ListWorktrees,
            &repository_path,
            ["worktree", "list", "--porcelain", "-z"],
        )?;
        parse_worktrees(&outcome.stdout)
    }
}

fn parse_worktrees(bytes: &[u8]) -> Result<Vec<WorktreeFacts>, GitError> {
    let mut records = Vec::new();
    let mut fields = Vec::new();
    for field in bytes.split(|byte| *byte == 0) {
        if field.is_empty() {
            if !fields.is_empty() {
                records.push(parse_record(&fields, records.is_empty())?);
                fields.clear();
            }
        } else {
            fields.push(field);
        }
    }
    if !fields.is_empty() {
        return Err(GitError::ParseFailed {
            operation: GitOperation::ListWorktrees,
        });
    }
    if records.is_empty() {
        return Err(GitError::ParseFailed {
            operation: GitOperation::ListWorktrees,
        });
    }
    Ok(records)
}

fn parse_record(fields: &[&[u8]], is_main: bool) -> Result<WorktreeFacts, GitError> {
    let path_bytes = fields
        .first()
        .and_then(|field| field.strip_prefix(b"worktree "))
        .ok_or(GitError::ParseFailed {
            operation: GitOperation::ListWorktrees,
        })?;
    let registered_path = termloop_platform::path_from_process_bytes(path_bytes.to_vec())
        .map_err(|error| map_platform_error(error, GitOperation::ListWorktrees))?;
    let mut head = None;
    let mut branch = None;
    let mut bare = false;
    let mut bare_seen = false;
    let mut detached = false;
    let mut detached_seen = false;
    let mut locked = WorktreeMarker::Absent;
    let mut locked_seen = false;
    let mut prunable = WorktreeMarker::Absent;
    let mut prunable_seen = false;
    for field in &fields[1..] {
        if let Some(value) = field.strip_prefix(b"HEAD ") {
            if head.is_some() {
                return parse_failure();
            }
            if matches!(value.len(), 40 | 64) && value.iter().all(|byte| *byte == b'0') {
                head = Some(None);
            } else {
                head = Some(Some(parse_oid(value, GitOperation::ListWorktrees)?));
            }
        } else if let Some(value) = field.strip_prefix(b"branch ") {
            if branch.is_some() {
                return parse_failure();
            }
            branch = Some(GitRefName::from_bytes(value.to_vec())?);
        } else if *field == b"bare" {
            if bare_seen {
                return parse_failure();
            }
            bare_seen = true;
            bare = true;
        } else if *field == b"detached" {
            if detached_seen {
                return parse_failure();
            }
            detached_seen = true;
            detached = true;
        } else if let Some(marker) = parse_marker(field, b"locked") {
            if locked_seen {
                return parse_failure();
            }
            locked_seen = true;
            locked = marker;
        } else if let Some(marker) = parse_marker(field, b"prunable") {
            if prunable_seen {
                return parse_failure();
            }
            prunable_seen = true;
            prunable = marker;
        } else {
            return parse_failure();
        }
    }
    let checkout = if bare {
        if branch.is_some() || detached || head.is_some() {
            return parse_failure();
        }
        WorktreeCheckout::Bare
    } else if let Some(reference) = branch {
        if detached {
            return parse_failure();
        }
        WorktreeCheckout::Branch {
            reference,
            oid: head.ok_or(GitError::ParseFailed {
                operation: GitOperation::ListWorktrees,
            })?,
        }
    } else if detached {
        WorktreeCheckout::Detached {
            oid: head.flatten().ok_or(GitError::ParseFailed {
                operation: GitOperation::ListWorktrees,
            })?,
        }
    } else {
        return parse_failure();
    };
    let path_state = match termloop_platform::canonical_directory_if_exists(&registered_path) {
        Ok(Some(canonical_path)) => RegisteredPathState::Present { canonical_path },
        Ok(None) => RegisteredPathState::Missing,
        Err(termloop_platform::PlatformError::Io(error))
            if error.kind() == std::io::ErrorKind::InvalidInput =>
        {
            RegisteredPathState::NotDirectory
        }
        Err(error) => return Err(map_platform_error(error, GitOperation::ListWorktrees)),
    };
    Ok(WorktreeFacts {
        registered_path,
        path_state,
        checkout,
        locked,
        prunable,
        is_main,
    })
}

fn parse_marker(field: &[u8], label: &[u8]) -> Option<WorktreeMarker> {
    if field == label {
        return Some(WorktreeMarker::Present { reason: None });
    }
    field
        .strip_prefix(label)
        .and_then(|value| value.strip_prefix(b" "))
        .map(|reason| WorktreeMarker::Present {
            reason: Some(GitText(reason.to_vec())),
        })
}

fn parse_failure<T>() -> Result<T, GitError> {
    Err(GitError::ParseFailed {
        operation: GitOperation::ListWorktrees,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_preserves_nul_delimited_newline_paths_and_reasons() {
        let root = std::env::current_dir().unwrap();
        let component =
            termloop_platform::test_support::host_path_component("line-break", "line\nbreak");
        let path = root.join(component);
        let mut bytes = b"worktree ".to_vec();
        bytes.extend(termloop_platform::process_bytes_from_os_str(path.as_os_str()).unwrap());
        bytes.extend_from_slice(
            b"\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/main\0locked reason\nline\0prunable missing gitdir\0\0",
        );
        let facts = parse_worktrees(&bytes).unwrap();
        assert_eq!(facts[0].registered_path, path);
        assert!(matches!(
            facts[0].checkout,
            WorktreeCheckout::Branch { oid: None, .. }
        ));
        assert_eq!(
            match &facts[0].locked {
                WorktreeMarker::Present {
                    reason: Some(reason),
                } => reason.as_bytes(),
                marker => panic!("unexpected marker: {marker:?}"),
            },
            b"reason\nline"
        );
        assert_eq!(
            match &facts[0].prunable {
                WorktreeMarker::Present {
                    reason: Some(reason),
                } => reason.as_bytes(),
                marker => panic!("unexpected prunable marker: {marker:?}"),
            },
            b"missing gitdir"
        );
    }

    #[test]
    fn parser_rejects_truncated_records() {
        assert!(parse_worktrees(b"worktree /tmp/repo\0HEAD deadbeef").is_err());
    }

    #[test]
    fn parser_rejects_unknown_duplicate_missing_and_contradictory_fields() {
        let oid = b"0123456789012345678901234567890123456789";
        let mut cases = vec![
            b"worktree /tmp/repo\0branch refs/heads/main\0\0".to_vec(),
            b"worktree /tmp/repo\0bare\0mystery value\0\0".to_vec(),
            b"worktree /tmp/repo\0bare\0bare\0\0".to_vec(),
            b"worktree /tmp/repo\0bare\0locked\0locked again\0\0".to_vec(),
        ];
        let mut contradictory = b"worktree /tmp/repo\0HEAD ".to_vec();
        contradictory.extend_from_slice(oid);
        contradictory.extend_from_slice(b"\0branch refs/heads/main\0detached\0\0");
        cases.push(contradictory);
        for case in cases {
            assert!(parse_worktrees(&case).is_err(), "accepted {case:?}");
        }
    }
}
