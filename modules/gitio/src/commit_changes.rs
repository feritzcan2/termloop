use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::changes::{literal_pathspec, safe_relative_path};
use crate::command::GitCommandScope;
use crate::{
    BranchCommitState, GitError, GitOperation, GitRunner, ObjectId, WorktreeChangeKind,
    WorktreeDiffContent, WorktreeDiffObservation,
};

pub const BRANCH_COMMIT_LIST_MAX_ENTRIES: usize = 50;
pub const COMMIT_CHANGE_LIST_MAX_ENTRIES: usize = 512;
const COMMIT_LIST_OUTPUT_LIMIT: usize = 512 * 1024;
const COMMIT_CHANGE_LIST_OUTPUT_LIMIT: usize = 3 * 1024 * 1024;
const COMMIT_CHANGE_DEADLINE: Duration = Duration::from_millis(2_500);

#[derive(Clone, PartialEq, Eq)]
pub struct BranchCommit {
    oid: ObjectId,
    subject: Vec<u8>,
    authored_at_epoch_ms: Option<u64>,
    parent_count: usize,
}

impl std::fmt::Debug for BranchCommit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BranchCommit")
            .field("oid", &"<redacted>")
            .field("subject", &"<redacted>")
            .field("authored_at_epoch_ms", &self.authored_at_epoch_ms)
            .field("parent_count", &self.parent_count)
            .finish()
    }
}

impl BranchCommit {
    pub fn oid(&self) -> &ObjectId {
        &self.oid
    }

    pub fn subject(&self) -> &[u8] {
        &self.subject
    }

    pub fn authored_at_epoch_ms(&self) -> Option<u64> {
        self.authored_at_epoch_ms
    }

    pub fn is_merge(&self) -> bool {
        self.parent_count > 1
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchCommitListObservation {
    pub repository_common_dir: PathBuf,
    pub branch_ref: crate::GitRefName,
    pub base_ref: crate::GitRefName,
    pub base_oid: ObjectId,
    pub branch_tip_oid: Option<ObjectId>,
    pub commits: Vec<BranchCommit>,
    pub truncated: bool,
    pub git_process_count: usize,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CommitChangeEntry {
    path: PathBuf,
    original_path: Option<PathBuf>,
    kind: WorktreeChangeKind,
}

impl std::fmt::Debug for CommitChangeEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CommitChangeEntry")
            .field("path", &"<redacted>")
            .field(
                "original_path",
                &self.original_path.as_ref().map(|_| "<redacted>"),
            )
            .field("kind", &self.kind)
            .finish()
    }
}

impl CommitChangeEntry {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn original_path(&self) -> Option<&Path> {
        self.original_path.as_deref()
    }

    pub fn kind(&self) -> WorktreeChangeKind {
        self.kind
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitChangesObservation {
    pub entries: Vec<CommitChangeEntry>,
    pub truncated: bool,
    pub renderable: bool,
    pub git_process_count: usize,
}

impl GitRunner {
    pub fn list_branch_commits(
        &self,
        repository_path: &Path,
        branch: &[u8],
    ) -> Result<BranchCommitListObservation, GitError> {
        self.list_branch_commits_with_local_base(repository_path, branch, None)
    }

    pub fn list_branch_commits_with_local_base(
        &self,
        repository_path: &Path,
        branch: &[u8],
        no_remote_base_ref: Option<&[u8]>,
    ) -> Result<BranchCommitListObservation, GitError> {
        self.list_branch_commits_with_base(repository_path, branch, no_remote_base_ref, None)
    }

    pub fn list_branch_commits_with_recorded_base(
        &self,
        repository_path: &Path,
        branch: &[u8],
        base_ref: &[u8],
        base_oid: &[u8],
    ) -> Result<BranchCommitListObservation, GitError> {
        self.list_branch_commits_with_base(repository_path, branch, Some(base_ref), Some(base_oid))
    }

    fn list_branch_commits_with_base(
        &self,
        repository_path: &Path,
        branch: &[u8],
        base_ref: Option<&[u8]>,
        recorded_base_oid: Option<&[u8]>,
    ) -> Result<BranchCommitListObservation, GitError> {
        // Reuse F2-11's exact-ref base resolution rather than accepting any
        // client-provided revision expression.
        let summary = match (base_ref, recorded_base_oid) {
            (Some(base_ref), Some(base_oid)) => self
                .observe_branch_commit_summary_with_recorded_base(
                    repository_path,
                    branch,
                    base_ref,
                    base_oid,
                )?,
            (_, None) => self.observe_branch_commit_summary_with_local_base(
                repository_path,
                branch,
                base_ref,
            )?,
            (None, Some(_)) => return Err(parse_error()),
        };
        let BranchCommitState::Available { base_ref, .. } = summary.state else {
            return Err(GitError::ParseFailed {
                operation: GitOperation::CommitChanges,
            });
        };
        let bounded = self
            .clone()
            .with_limits(COMMIT_CHANGE_DEADLINE, COMMIT_LIST_OUTPUT_LIMIT)
            .with_absolute_timeout(COMMIT_CHANGE_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, COMMIT_CHANGE_DEADLINE)?;
        let base_oid = if let Some(recorded) = recorded_base_oid {
            ObjectId::from_hex(recorded.to_vec()).map_err(|_| parse_error())?
        } else {
            let resolved_base = scope.checked(
                GitOperation::CommitChanges,
                repository_path,
                [
                    OsString::from("rev-parse"),
                    OsString::from("--verify"),
                    exact_bytes(base_ref.as_bytes())?,
                ],
            )?;
            parse_oid_line(&resolved_base.stdout)?
        };
        let resolved_branch = scope.checked(
            GitOperation::CommitChanges,
            repository_path,
            [
                OsString::from("rev-parse"),
                OsString::from("--verify"),
                exact_bytes(summary.branch_ref.as_bytes())?,
            ],
        )?;
        let branch_oid = parse_oid_line(&resolved_branch.stdout)?;
        let output = scope.checked(
            GitOperation::CommitChanges,
            repository_path,
            [
                OsString::from("log"),
                OsString::from("-z"),
                OsString::from("--format=%H%x00%P%x00%at%x00%s"),
                OsString::from(format!(
                    "--max-count={}",
                    BRANCH_COMMIT_LIST_MAX_ENTRIES + 1
                )),
                exact_bytes(branch_oid.as_bytes())?,
                OsString::from("--not"),
                exact_bytes(base_oid.as_bytes())?,
                OsString::from("--"),
            ],
        )?;
        let (commits, truncated) = parse_commits(&output.stdout)?;
        let branch_tip_oid = (!commits.is_empty()).then_some(branch_oid);
        Ok(BranchCommitListObservation {
            repository_common_dir: summary.repository_common_dir,
            branch_ref: summary.branch_ref,
            base_ref,
            base_oid,
            branch_tip_oid,
            commits,
            truncated,
            git_process_count: summary.git_process_count + scope.command_count(),
        })
    }

    pub fn list_commit_changes(
        &self,
        repository_path: &Path,
        commit: &BranchCommit,
    ) -> Result<CommitChangesObservation, GitError> {
        if commit.is_merge() {
            return Ok(CommitChangesObservation {
                entries: vec![],
                truncated: false,
                renderable: false,
                git_process_count: 0,
            });
        }
        let bounded = self
            .clone()
            .with_limits(COMMIT_CHANGE_DEADLINE, COMMIT_CHANGE_LIST_OUTPUT_LIMIT)
            .with_absolute_timeout(COMMIT_CHANGE_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, COMMIT_CHANGE_DEADLINE)?;
        let output = scope.checked(
            GitOperation::CommitChanges,
            repository_path,
            [
                OsString::from("show"),
                OsString::from("--format="),
                OsString::from("--name-status"),
                OsString::from("-z"),
                OsString::from("--find-renames"),
                OsString::from("--no-ext-diff"),
                OsString::from("--no-textconv"),
                exact_bytes(commit.oid().as_bytes())?,
                OsString::from("--"),
            ],
        )?;
        let (entries, truncated) = parse_commit_changes(&output.stdout)?;
        Ok(CommitChangesObservation {
            entries,
            truncated,
            renderable: true,
            git_process_count: scope.command_count(),
        })
    }

    pub fn list_branch_range_changes(
        &self,
        repository_path: &Path,
        base_oid: &ObjectId,
        branch_tip_oid: &ObjectId,
    ) -> Result<CommitChangesObservation, GitError> {
        let bounded = self
            .clone()
            .with_limits(COMMIT_CHANGE_DEADLINE, COMMIT_CHANGE_LIST_OUTPUT_LIMIT)
            .with_absolute_timeout(COMMIT_CHANGE_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, COMMIT_CHANGE_DEADLINE)?;
        let merge_base = observe_merge_base(&mut scope, repository_path, base_oid, branch_tip_oid)?;
        let output = scope.checked(
            GitOperation::CommitChanges,
            repository_path,
            [
                OsString::from("diff"),
                OsString::from("--name-status"),
                OsString::from("-z"),
                OsString::from("--find-renames"),
                OsString::from("--no-ext-diff"),
                OsString::from("--no-textconv"),
                exact_bytes(merge_base.as_bytes())?,
                exact_bytes(branch_tip_oid.as_bytes())?,
                OsString::from("--"),
            ],
        )?;
        let (entries, truncated) = parse_commit_changes(&output.stdout)?;
        Ok(CommitChangesObservation {
            entries,
            truncated,
            renderable: true,
            git_process_count: scope.command_count(),
        })
    }

    pub fn diff_commit_change(
        &self,
        repository_path: &Path,
        commit: &BranchCommit,
        entry: &CommitChangeEntry,
    ) -> Result<WorktreeDiffObservation, GitError> {
        if commit.is_merge() {
            return Ok(WorktreeDiffObservation {
                content: WorktreeDiffContent::NotShown,
                git_process_count: 0,
            });
        }
        let bounded = self
            .clone()
            .with_limits(COMMIT_CHANGE_DEADLINE, crate::CHANGE_DIFF_MAX_BYTES + 1)
            .with_absolute_timeout(COMMIT_CHANGE_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, COMMIT_CHANGE_DEADLINE)?;
        let mut numstat = vec![
            OsString::from("show"),
            OsString::from("--format="),
            OsString::from("--numstat"),
            OsString::from("-z"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            exact_bytes(commit.oid().as_bytes())?,
            OsString::from("--"),
        ];
        append_entry_pathspecs(&mut numstat, entry)?;
        let stats = scope.checked(GitOperation::CommitChanges, repository_path, numstat)?;
        if numstat_contains_binary(&stats.stdout)? {
            return Ok(WorktreeDiffObservation {
                content: WorktreeDiffContent::Binary,
                git_process_count: scope.command_count(),
            });
        }

        let mut args = vec![
            OsString::from("show"),
            OsString::from("--format="),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--no-color"),
            OsString::from("--find-renames"),
            OsString::from("--unified=3"),
            exact_bytes(commit.oid().as_bytes())?,
            OsString::from("--"),
        ];
        append_entry_pathspecs(&mut args, entry)?;
        let output = match scope.checked(GitOperation::CommitChanges, repository_path, args) {
            Ok(output) => output,
            Err(GitError::OutputLimitExceeded {
                operation: GitOperation::CommitChanges,
            }) => {
                return Ok(WorktreeDiffObservation {
                    content: WorktreeDiffContent::Truncated,
                    git_process_count: scope.command_count(),
                });
            }
            Err(error) => return Err(error),
        };
        let content = if crate::changes::exceeds_change_bounds(&output.stdout) {
            WorktreeDiffContent::Truncated
        } else {
            WorktreeDiffContent::Patch(output.stdout)
        };
        Ok(WorktreeDiffObservation {
            content,
            git_process_count: scope.command_count(),
        })
    }

    pub fn diff_branch_range_change(
        &self,
        repository_path: &Path,
        base_oid: &ObjectId,
        branch_tip_oid: &ObjectId,
        entry: &CommitChangeEntry,
    ) -> Result<WorktreeDiffObservation, GitError> {
        let bounded = self
            .clone()
            .with_limits(COMMIT_CHANGE_DEADLINE, crate::CHANGE_DIFF_MAX_BYTES + 1)
            .with_absolute_timeout(COMMIT_CHANGE_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, COMMIT_CHANGE_DEADLINE)?;
        let merge_base = observe_merge_base(&mut scope, repository_path, base_oid, branch_tip_oid)?;
        let mut numstat = vec![
            OsString::from("diff"),
            OsString::from("--numstat"),
            OsString::from("-z"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            exact_bytes(merge_base.as_bytes())?,
            exact_bytes(branch_tip_oid.as_bytes())?,
            OsString::from("--"),
        ];
        append_entry_pathspecs(&mut numstat, entry)?;
        let stats = scope.checked(GitOperation::CommitChanges, repository_path, numstat)?;
        if numstat_contains_binary(&stats.stdout)? {
            return Ok(WorktreeDiffObservation {
                content: WorktreeDiffContent::Binary,
                git_process_count: scope.command_count(),
            });
        }

        let mut args = vec![
            OsString::from("diff"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--no-color"),
            OsString::from("--find-renames"),
            OsString::from("--unified=3"),
            exact_bytes(merge_base.as_bytes())?,
            exact_bytes(branch_tip_oid.as_bytes())?,
            OsString::from("--"),
        ];
        append_entry_pathspecs(&mut args, entry)?;
        let output = match scope.checked(GitOperation::CommitChanges, repository_path, args) {
            Ok(output) => output,
            Err(GitError::OutputLimitExceeded {
                operation: GitOperation::CommitChanges,
            }) => {
                return Ok(WorktreeDiffObservation {
                    content: WorktreeDiffContent::Truncated,
                    git_process_count: scope.command_count(),
                });
            }
            Err(error) => return Err(error),
        };
        let content = if crate::changes::exceeds_change_bounds(&output.stdout) {
            WorktreeDiffContent::Truncated
        } else {
            WorktreeDiffContent::Patch(output.stdout)
        };
        Ok(WorktreeDiffObservation {
            content,
            git_process_count: scope.command_count(),
        })
    }
}

fn parse_commits(bytes: &[u8]) -> Result<(Vec<BranchCommit>, bool), GitError> {
    let mut fields = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if fields.len() % 4 != 0 {
        return Err(parse_error());
    }
    let mut commits = Vec::with_capacity(fields.len() / 4);
    for fields in fields.chunks_exact(4) {
        let oid = ObjectId::from_hex(fields[0].to_vec()).map_err(|_| parse_error())?;
        let parent_count = if fields[1].is_empty() {
            0
        } else {
            fields[1].split(|byte| *byte == b' ').count()
        };
        let authored_at_epoch_ms = std::str::from_utf8(fields[2])
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .and_then(|seconds| seconds.checked_mul(1_000));
        if authored_at_epoch_ms.is_none() {
            return Err(parse_error());
        }
        commits.push(BranchCommit {
            oid,
            subject: fields[3].to_vec(),
            authored_at_epoch_ms,
            parent_count,
        });
    }
    let truncated = commits.len() > BRANCH_COMMIT_LIST_MAX_ENTRIES;
    commits.truncate(BRANCH_COMMIT_LIST_MAX_ENTRIES);
    Ok((commits, truncated))
}

fn parse_commit_changes(bytes: &[u8]) -> Result<(Vec<CommitChangeEntry>, bool), GitError> {
    let records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let status = records[index];
        index += 1;
        let code = *status.first().ok_or_else(parse_error)?;
        let kind = match code {
            b'M' | b'T' => WorktreeChangeKind::Modified,
            b'A' => WorktreeChangeKind::Added,
            b'D' => WorktreeChangeKind::Deleted,
            b'R' => WorktreeChangeKind::Renamed,
            b'C' => WorktreeChangeKind::Copied,
            _ => return Err(parse_error()),
        };
        let (original_path, path) = if matches!(
            kind,
            WorktreeChangeKind::Renamed | WorktreeChangeKind::Copied
        ) {
            let original = records.get(index).ok_or_else(parse_error)?;
            let path = records.get(index + 1).ok_or_else(parse_error)?;
            index += 2;
            (
                Some(safe_relative_path(original)?),
                safe_relative_path(path)?,
            )
        } else {
            let path = records.get(index).ok_or_else(parse_error)?;
            index += 1;
            (None, safe_relative_path(path)?)
        };
        if entries.len() <= COMMIT_CHANGE_LIST_MAX_ENTRIES {
            entries.push(CommitChangeEntry {
                path,
                original_path,
                kind,
            });
        }
    }
    let truncated = entries.len() > COMMIT_CHANGE_LIST_MAX_ENTRIES;
    entries.truncate(COMMIT_CHANGE_LIST_MAX_ENTRIES);
    Ok((entries, truncated))
}

fn append_entry_pathspecs(
    args: &mut Vec<OsString>,
    entry: &CommitChangeEntry,
) -> Result<(), GitError> {
    args.push(literal_pathspec(entry.path())?);
    if let Some(original) = entry.original_path() {
        args.push(literal_pathspec(original)?);
    }
    Ok(())
}

fn numstat_contains_binary(bytes: &[u8]) -> Result<bool, GitError> {
    // The literal entry pathspecs select one logical change. Rename numstat
    // output appends its old/new paths as additional NUL records, so only the
    // leading numeric record is classification data.
    let record = bytes
        .split(|byte| *byte == 0)
        .find(|record| !record.is_empty())
        .unwrap_or_default();
    if record.is_empty() {
        return Ok(false);
    }
    let mut fields = record.splitn(3, |byte| *byte == b'\t');
    let added = fields.next().unwrap_or_default();
    let deleted = fields.next().unwrap_or_default();
    if fields.next().is_none() {
        return Err(parse_error());
    }
    Ok(added == b"-" && deleted == b"-")
}

fn observe_merge_base(
    scope: &mut GitCommandScope<'_>,
    repository_path: &Path,
    base_oid: &ObjectId,
    branch_tip_oid: &ObjectId,
) -> Result<ObjectId, GitError> {
    let output = scope.checked(
        GitOperation::CommitChanges,
        repository_path,
        [
            OsString::from("merge-base"),
            exact_bytes(base_oid.as_bytes())?,
            exact_bytes(branch_tip_oid.as_bytes())?,
        ],
    )?;
    parse_oid_line(&output.stdout)
}

fn parse_oid_line(bytes: &[u8]) -> Result<ObjectId, GitError> {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if bytes.contains(&b'\n') || bytes.contains(&b'\r') {
        return Err(parse_error());
    }
    ObjectId::from_hex(bytes.to_vec()).map_err(|_| parse_error())
}

fn exact_bytes(bytes: &[u8]) -> Result<OsString, GitError> {
    termloop_platform::os_string_from_process_bytes(bytes.to_vec()).map_err(|_| parse_error())
}

fn parse_error() -> GitError {
    GitError::ParseFailed {
        operation: GitOperation::CommitChanges,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rename_records_and_keeps_both_paths() {
        let (entries, truncated) =
            parse_commit_changes(b"R100\0old name.txt\0new[1].txt\0M\0 spaced.txt\0").unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].original_path(), Some(Path::new("old name.txt")));
        assert_eq!(entries[0].path(), Path::new("new[1].txt"));
        assert_eq!(entries[1].path(), Path::new(" spaced.txt"));
    }

    #[test]
    fn debug_redacts_commit_subject_and_change_paths() {
        let commit = BranchCommit {
            oid: ObjectId::from_hex(b"0123456789012345678901234567890123456789".to_vec()).unwrap(),
            subject: b"SECRET_SUBJECT".to_vec(),
            authored_at_epoch_ms: Some(1_000),
            parent_count: 1,
        };
        assert!(!format!("{commit:?}").contains("SECRET_SUBJECT"));
        let entry = CommitChangeEntry {
            path: PathBuf::from("SECRET_PATH"),
            original_path: None,
            kind: WorktreeChangeKind::Modified,
        };
        assert!(!format!("{entry:?}").contains("SECRET_PATH"));
    }
}
