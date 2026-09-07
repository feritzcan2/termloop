use std::ffi::OsString;
use std::path::{Path, PathBuf};

use termloop_platform::CommandTermination;

use crate::command::{GitCommandScope, strip_git_line_cr};
use crate::error::{command_failure, repository_failure};
use crate::{GitError, GitOperation, GitRunner};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObjectId(Vec<u8>);

impl ObjectId {
    pub fn from_hex(bytes: Vec<u8>) -> Result<Self, GitError> {
        parse_oid(&bytes, GitOperation::ResolveRef)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GitRefName(Vec<u8>);

impl GitRefName {
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, GitError> {
        if !valid_full_ref_name(&bytes) {
            return Err(GitError::ParseFailed {
                operation: GitOperation::ResolveRef,
            });
        }
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadState {
    Unborn { branch: GitRefName },
    Attached { branch: GitRefName, oid: ObjectId },
    Detached { oid: ObjectId },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryFacts {
    pub requested_path: PathBuf,
    pub resolved_path: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    pub worktree_root: Option<PathBuf>,
    pub bare: bool,
    pub head: HeadState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBranchList {
    pub branches: Vec<GitRefName>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBranchList {
    pub branches: Vec<GitRefName>,
    pub truncated: bool,
}

const MAX_LOCAL_BRANCHES: usize = 512;
const MAX_REMOTE_BRANCHES: usize = 512;
const MAX_REMOTE_BRANCH_RECORDS: usize = 1025;

pub(crate) struct RepositoryIdentityFacts {
    requested_path: PathBuf,
    resolved_path: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    worktree_root: Option<PathBuf>,
    bare: bool,
}

impl RepositoryIdentityFacts {
    pub(crate) fn common_dir(&self) -> &Path {
        &self.common_dir
    }

    pub(crate) fn worktree_root(&self) -> Option<&Path> {
        self.worktree_root.as_deref()
    }

    pub(crate) fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    pub(crate) fn into_repository(self, head: HeadState) -> RepositoryFacts {
        RepositoryFacts {
            requested_path: self.requested_path,
            resolved_path: self.resolved_path,
            git_dir: self.git_dir,
            common_dir: self.common_dir,
            worktree_root: self.worktree_root,
            bare: self.bare,
            head,
        }
    }
}

impl GitRunner {
    pub fn inspect_repository(&self, requested_path: &Path) -> Result<RepositoryFacts, GitError> {
        let mut scope = GitCommandScope::new(self);
        self.inspect_repository_in_scope(requested_path, &mut scope)
    }

    pub(crate) fn inspect_repository_in_scope(
        &self,
        requested_path: &Path,
        scope: &mut GitCommandScope<'_>,
    ) -> Result<RepositoryFacts, GitError> {
        let identity = self.inspect_repository_identity_in_scope(requested_path, scope)?;
        let head = if identity.bare {
            self.bare_head_state_in_scope(&identity.resolved_path, scope)?
        } else {
            self.worktree_head_state_in_scope(&identity.resolved_path, scope)?
        };
        Ok(identity.into_repository(head))
    }

    pub(crate) fn inspect_repository_identity_in_scope(
        &self,
        requested_path: &Path,
        scope: &mut GitCommandScope<'_>,
    ) -> Result<RepositoryIdentityFacts, GitError> {
        let resolved_path =
            match termloop_platform::canonical_existing_directory_path(requested_path) {
                Ok(path) => path,
                Err(termloop_platform::PlatformError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
                    ) =>
                {
                    return Err(GitError::NotRepository);
                }
                Err(error) => {
                    return Err(crate::error::map_platform_error(
                        error,
                        GitOperation::RepositoryIdentity,
                    ));
                }
            };
        let identity = scope.execute(
            GitOperation::RepositoryIdentity,
            &resolved_path,
            ["rev-parse", "--is-bare-repository", "--absolute-git-dir"],
        )?;
        if !identity.success() {
            return Err(repository_failure(
                GitOperation::RepositoryIdentity,
                identity.termination,
                &identity.stderr,
            ));
        }
        let (bare, git_dir) = parse_bare_and_path(&identity.stdout)?;
        let git_dir = resolve_existing_path(&resolved_path, git_dir)?;
        let common_dir = if bare {
            git_dir.clone()
        } else {
            let common_dir = self.path_fact_in_scope(&resolved_path, "--git-common-dir", scope)?;
            resolve_existing_path(&resolved_path, common_dir)?
        };
        let worktree_root = if bare {
            None
        } else {
            let path = self.path_fact_in_scope(&resolved_path, "--show-toplevel", scope)?;
            Some(resolve_existing_path(&resolved_path, path)?)
        };
        Ok(RepositoryIdentityFacts {
            requested_path: requested_path.to_path_buf(),
            resolved_path,
            git_dir,
            common_dir,
            worktree_root,
            bare,
        })
    }

    pub fn resolve_ref(
        &self,
        repository_path: &Path,
        reference: &GitRefName,
    ) -> Result<Option<ObjectId>, GitError> {
        if !self.ref_exists(repository_path, reference)? {
            return Ok(None);
        }
        let reference =
            termloop_platform::os_string_from_process_bytes(reference.as_bytes().to_vec())
                .map_err(|error| {
                    crate::error::map_platform_error(error, GitOperation::ResolveRef)
                })?;
        let outcome = self.execute(
            GitOperation::ResolveRef,
            repository_path,
            [
                OsString::from("show-ref"),
                OsString::from("--verify"),
                OsString::from("--hash"),
                OsString::from("--"),
                reference,
            ],
        )?;
        match outcome.termination {
            CommandTermination::Exited { code: 0 } => {
                parse_oid_line(&outcome.stdout, GitOperation::ResolveRef).map(Some)
            }
            termination => Err(command_failure(
                GitOperation::ResolveRef,
                termination,
                &outcome.stderr,
            )),
        }
    }

    pub fn branch_exists(&self, repository_path: &Path, branch: &[u8]) -> Result<bool, GitError> {
        let mut reference = b"refs/heads/".to_vec();
        reference.extend_from_slice(branch);
        self.ref_exists(repository_path, &GitRefName::from_bytes(reference)?)
    }

    pub fn list_local_branches(&self, repository_path: &Path) -> Result<LocalBranchList, GitError> {
        let outcome = self.checked(
            GitOperation::ListLocalBranches,
            repository_path,
            [
                "for-each-ref",
                "--sort=refname",
                "--count=513",
                "--format=%(refname)",
                "refs/heads/",
            ],
        )?;
        parse_local_branches(&outcome.stdout)
    }

    pub fn list_remote_branches(
        &self,
        repository_path: &Path,
    ) -> Result<RemoteBranchList, GitError> {
        let outcome = self.checked(
            GitOperation::ListRemoteBranches,
            repository_path,
            [
                "for-each-ref",
                "--sort=refname",
                "--count=1025",
                "--format=%(refname)",
                "refs/remotes/",
            ],
        )?;
        parse_remote_branches(&outcome.stdout)
    }

    fn ref_exists(&self, repository_path: &Path, reference: &GitRefName) -> Result<bool, GitError> {
        let reference =
            termloop_platform::os_string_from_process_bytes(reference.as_bytes().to_vec())
                .map_err(|error| {
                    crate::error::map_platform_error(error, GitOperation::ResolveRef)
                })?;
        let outcome = self.execute(
            GitOperation::ResolveRef,
            repository_path,
            [
                OsString::from("show-ref"),
                OsString::from("--verify"),
                OsString::from("--quiet"),
                OsString::from("--"),
                reference,
            ],
        )?;
        match outcome.termination {
            CommandTermination::Exited { code: 0 } => Ok(true),
            CommandTermination::Exited { code: 1 } => Ok(false),
            termination => Err(command_failure(
                GitOperation::ResolveRef,
                termination,
                &outcome.stderr,
            )),
        }
    }

    fn path_fact_in_scope(
        &self,
        cwd: &Path,
        argument: &str,
        scope: &mut GitCommandScope<'_>,
    ) -> Result<PathBuf, GitError> {
        let output = scope.checked(
            GitOperation::RepositoryIdentity,
            cwd,
            ["rev-parse", argument],
        )?;
        let bytes = parse_single_line(&output.stdout, GitOperation::RepositoryIdentity)?;
        termloop_platform::path_from_process_bytes(bytes.to_vec()).map_err(|error| {
            crate::error::map_platform_error(error, GitOperation::RepositoryIdentity)
        })
    }

    fn bare_head_state_in_scope(
        &self,
        cwd: &Path,
        scope: &mut GitCommandScope<'_>,
    ) -> Result<HeadState, GitError> {
        let symbolic =
            scope.execute(GitOperation::Head, cwd, ["symbolic-ref", "--quiet", "HEAD"])?;
        let branch = match symbolic.termination {
            CommandTermination::Exited { code: 0 } => Some(GitRefName::from_bytes(
                parse_single_line(&symbolic.stdout, GitOperation::Head)?.to_vec(),
            )?),
            CommandTermination::Exited { code: 1 } => None,
            termination => {
                return Err(command_failure(
                    GitOperation::Head,
                    termination,
                    &symbolic.stderr,
                ));
            }
        };
        let resolved = scope.execute(
            GitOperation::Head,
            cwd,
            ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        )?;
        if resolved.success() {
            let oid = parse_oid_line(&resolved.stdout, GitOperation::Head)?;
            return Ok(match branch {
                Some(branch) => HeadState::Attached { branch, oid },
                None => HeadState::Detached { oid },
            });
        }
        if let Some(branch) = branch {
            return Ok(HeadState::Unborn { branch });
        }
        Err(command_failure(
            GitOperation::Head,
            resolved.termination,
            &resolved.stderr,
        ))
    }

    fn worktree_head_state_in_scope(
        &self,
        cwd: &Path,
        scope: &mut GitCommandScope<'_>,
    ) -> Result<HeadState, GitError> {
        let outcome = scope.checked(
            GitOperation::Head,
            cwd,
            [
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--ahead-behind",
                "--no-show-stash",
                "--untracked-files=no",
                "--ignore-submodules=all",
            ],
        )?;
        parse_status_head(&outcome.stdout)
    }
}

fn parse_local_branches(bytes: &[u8]) -> Result<LocalBranchList, GitError> {
    if bytes.is_empty() {
        return Ok(LocalBranchList {
            branches: Vec::new(),
            truncated: false,
        });
    }
    if !bytes.ends_with(b"\n") {
        return Err(GitError::ParseFailed {
            operation: GitOperation::ListLocalBranches,
        });
    }

    let mut branches = Vec::new();
    for record in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        let record = strip_git_line_cr(record);
        let reference =
            GitRefName::from_bytes(record.to_vec()).map_err(|_| GitError::ParseFailed {
                operation: GitOperation::ListLocalBranches,
            })?;
        if !reference.as_bytes().starts_with(b"refs/heads/") {
            return Err(GitError::ParseFailed {
                operation: GitOperation::ListLocalBranches,
            });
        }
        branches.push(reference);
    }
    branches.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    branches.dedup();
    let truncated = branches.len() > MAX_LOCAL_BRANCHES;
    branches.truncate(MAX_LOCAL_BRANCHES);
    Ok(LocalBranchList {
        branches,
        truncated,
    })
}

fn parse_remote_branches(bytes: &[u8]) -> Result<RemoteBranchList, GitError> {
    if bytes.is_empty() {
        return Ok(RemoteBranchList {
            branches: Vec::new(),
            truncated: false,
        });
    }
    if !bytes.ends_with(b"\n") {
        return Err(GitError::ParseFailed {
            operation: GitOperation::ListRemoteBranches,
        });
    }

    let records = bytes[..bytes.len() - 1]
        .split(|byte| *byte == b'\n')
        .collect::<Vec<_>>();
    let output_truncated = records.len() == MAX_REMOTE_BRANCH_RECORDS;
    let mut branches = Vec::new();
    for record in records {
        let record = strip_git_line_cr(record);
        let reference =
            GitRefName::from_bytes(record.to_vec()).map_err(|_| GitError::ParseFailed {
                operation: GitOperation::ListRemoteBranches,
            })?;
        let suffix =
            reference
                .as_bytes()
                .strip_prefix(b"refs/remotes/")
                .ok_or(GitError::ParseFailed {
                    operation: GitOperation::ListRemoteBranches,
                })?;
        let Some(separator) = suffix.iter().position(|byte| *byte == b'/') else {
            return Err(GitError::ParseFailed {
                operation: GitOperation::ListRemoteBranches,
            });
        };
        let branch = &suffix[separator + 1..];
        if branch.is_empty() {
            return Err(GitError::ParseFailed {
                operation: GitOperation::ListRemoteBranches,
            });
        }
        // Remote HEAD is a symbolic convenience ref, not a selectable branch.
        if branch == b"HEAD" {
            continue;
        }
        branches.push(reference);
    }
    branches.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    branches.dedup();
    let truncated = output_truncated || branches.len() > MAX_REMOTE_BRANCHES;
    branches.truncate(MAX_REMOTE_BRANCHES);
    Ok(RemoteBranchList {
        branches,
        truncated,
    })
}

fn parse_bare_and_path(bytes: &[u8]) -> Result<(bool, PathBuf), GitError> {
    let separator = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or(GitError::ParseFailed {
            operation: GitOperation::RepositoryIdentity,
        })?;
    let bare = match strip_git_line_cr(&bytes[..separator]) {
        b"true" => true,
        b"false" => false,
        _ => {
            return Err(GitError::ParseFailed {
                operation: GitOperation::RepositoryIdentity,
            });
        }
    };
    let path = parse_single_line(&bytes[separator + 1..], GitOperation::RepositoryIdentity)?;
    let path = termloop_platform::path_from_process_bytes(path.to_vec()).map_err(|error| {
        crate::error::map_platform_error(error, GitOperation::RepositoryIdentity)
    })?;
    Ok((bare, path))
}

pub(crate) fn parse_status_head(bytes: &[u8]) -> Result<HeadState, GitError> {
    let mut oid = None;
    let mut branch = None;
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if let Some(value) = record.strip_prefix(b"# branch.oid ") {
            if oid.is_some() {
                return Err(GitError::ParseFailed {
                    operation: GitOperation::Head,
                });
            }
            oid = Some(if value == b"(initial)" {
                None
            } else {
                Some(parse_oid(value, GitOperation::Head)?)
            });
        } else if let Some(value) = record.strip_prefix(b"# branch.head ") {
            if branch.is_some() {
                return Err(GitError::ParseFailed {
                    operation: GitOperation::Head,
                });
            }
            branch = Some(if value == b"(detached)" {
                None
            } else {
                let mut reference = b"refs/heads/".to_vec();
                reference.extend_from_slice(value);
                Some(GitRefName::from_bytes(reference)?)
            });
        }
    }
    match (branch, oid) {
        (Some(Some(branch)), Some(Some(oid))) => Ok(HeadState::Attached { branch, oid }),
        (Some(Some(branch)), Some(None)) => Ok(HeadState::Unborn { branch }),
        (Some(None), Some(Some(oid))) => Ok(HeadState::Detached { oid }),
        _ => Err(GitError::ParseFailed {
            operation: GitOperation::Head,
        }),
    }
}

fn valid_full_ref_name(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"refs/")
        || bytes.len() <= b"refs/".len()
        || bytes == b"@"
        || bytes.starts_with(b"/")
        || bytes.ends_with(b"/")
        || bytes.ends_with(b".")
        || bytes
            .windows(2)
            .any(|value| matches!(value, b".." | b"@{" | b"//"))
        || bytes.iter().any(|byte| {
            byte.is_ascii_control()
                || *byte == 0x7f
                || matches!(
                    *byte,
                    b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\'
                )
        })
    {
        return false;
    }
    bytes.split(|byte| *byte == b'/').all(|component| {
        !component.is_empty() && !component.starts_with(b".") && !component.ends_with(b".lock")
    })
}

fn resolve_existing_path(cwd: &Path, path: PathBuf) -> Result<PathBuf, GitError> {
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    termloop_platform::canonical_existing_directory_path(&path)
        .map_err(|error| crate::error::map_platform_error(error, GitOperation::RepositoryIdentity))
}

pub(crate) fn parse_single_line(bytes: &[u8], operation: GitOperation) -> Result<&[u8], GitError> {
    let Some(value) = bytes.strip_suffix(b"\n") else {
        return Err(GitError::ParseFailed { operation });
    };
    let value = strip_git_line_cr(value);
    if value.is_empty() {
        return Err(GitError::ParseFailed { operation });
    }
    Ok(value)
}

pub(crate) fn parse_oid_line(bytes: &[u8], operation: GitOperation) -> Result<ObjectId, GitError> {
    parse_oid(parse_single_line(bytes, operation)?, operation)
}

pub(crate) fn parse_oid(bytes: &[u8], operation: GitOperation) -> Result<ObjectId, GitError> {
    if !matches!(bytes.len(), 40 | 64) || !bytes.iter().all(u8::is_ascii_hexdigit) {
        return Err(GitError::ParseFailed { operation });
    }
    Ok(ObjectId(bytes.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_oriented_repository_output_accepts_windows_crlf() {
        let (bare, path) = parse_bare_and_path(b"false\r\nC:/fixture/.git\r\n").unwrap();
        assert!(!bare);
        assert_eq!(path, PathBuf::from("C:/fixture/.git"));
        assert_eq!(
            parse_single_line(b"refs/heads/main\r\n", GitOperation::Head).unwrap(),
            b"refs/heads/main",
        );

        let branches = parse_local_branches(b"refs/heads/feature\r\nrefs/heads/main\r\n").unwrap();
        assert_eq!(branches.branches.len(), 2);
    }

    #[test]
    fn local_branch_parser_is_exact_bounded_and_deduplicated() {
        let mut output =
            b"refs/heads/feature/api\nrefs/heads/feature/api\nrefs/heads/main\n".to_vec();
        let parsed = parse_local_branches(&output).unwrap();
        assert_eq!(parsed.branches.len(), 2);
        assert_eq!(parsed.branches[0].as_bytes(), b"refs/heads/feature/api");
        assert!(!parsed.truncated);

        output.clear();
        for index in 0..=MAX_LOCAL_BRANCHES {
            output.extend_from_slice(format!("refs/heads/branch-{index:03}\n").as_bytes());
        }
        let parsed = parse_local_branches(&output).unwrap();
        assert_eq!(parsed.branches.len(), MAX_LOCAL_BRANCHES);
        assert!(parsed.truncated);
    }

    #[test]
    fn local_branch_parser_rejects_partial_or_non_local_refs() {
        for output in [
            b"refs/heads/main".as_slice(),
            b"refs/remotes/origin/main\n",
            b"refs/heads/main~1\n",
            b"\n",
        ] {
            assert!(matches!(
                parse_local_branches(output),
                Err(GitError::ParseFailed {
                    operation: GitOperation::ListLocalBranches
                })
            ));
        }
    }

    #[test]
    fn remote_branch_parser_is_exact_bounded_and_omits_symbolic_head() {
        let mut output = b"refs/remotes/origin/HEAD\nrefs/remotes/origin/development\nrefs/remotes/upstream/main\n".to_vec();
        let parsed = parse_remote_branches(&output).unwrap();
        assert_eq!(parsed.branches.len(), 2);
        assert_eq!(
            parsed.branches[0].as_bytes(),
            b"refs/remotes/origin/development"
        );
        assert_eq!(parsed.branches[1].as_bytes(), b"refs/remotes/upstream/main");
        assert!(!parsed.truncated);

        output.clear();
        for index in 0..=MAX_REMOTE_BRANCHES {
            output.extend_from_slice(format!("refs/remotes/origin/branch-{index:03}\n").as_bytes());
        }
        let parsed = parse_remote_branches(&output).unwrap();
        assert_eq!(parsed.branches.len(), MAX_REMOTE_BRANCHES);
        assert!(parsed.truncated);
    }

    #[test]
    fn remote_branch_parser_rejects_partial_or_non_remote_refs() {
        for output in [
            b"refs/remotes/origin/main".as_slice(),
            b"refs/heads/main\n",
            b"refs/remotes/origin\n",
            b"refs/remotes/origin/main~1\n",
            b"\n",
        ] {
            assert!(matches!(
                parse_remote_branches(output),
                Err(GitError::ParseFailed {
                    operation: GitOperation::ListRemoteBranches
                })
            ));
        }
    }
}
