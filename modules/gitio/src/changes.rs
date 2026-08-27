use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use termloop_platform::{CommandOutcome, CommandTermination};

use crate::command::GitCommandScope;
use crate::error::command_failure;
use crate::{GitError, GitOperation, GitRunner};

pub const CHANGE_LIST_MAX_ENTRIES: usize = 512;
pub const CHANGE_DIFF_MAX_BYTES: usize = 256 * 1024;
pub const CHANGE_DIFF_MAX_LINES: usize = 20_000;
const CHANGE_LIST_MAX_OUTPUT_BYTES: usize = 3 * 1024 * 1024;
const CHANGE_OBSERVATION_DEADLINE: Duration = Duration::from_millis(2_500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeChangeSide {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
    Untracked,
}

#[derive(Clone, PartialEq, Eq)]
pub struct WorktreeChangeEntry {
    path: PathBuf,
    original_path: Option<PathBuf>,
    side: WorktreeChangeSide,
    kind: WorktreeChangeKind,
}

impl std::fmt::Debug for WorktreeChangeEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorktreeChangeEntry")
            .field("path", &"<redacted>")
            .field(
                "original_path",
                &self.original_path.as_ref().map(|_| "<redacted>"),
            )
            .field("side", &self.side)
            .field("kind", &self.kind)
            .finish()
    }
}

impl WorktreeChangeEntry {
    /// Construct an entry directly. Test-only: production entries come from
    /// parsing a real `status --porcelain=v2` observation, never from a caller.
    #[cfg(test)]
    pub(crate) fn for_test(
        path: &str,
        original_path: Option<&str>,
        side: WorktreeChangeSide,
        kind: WorktreeChangeKind,
    ) -> Self {
        Self {
            path: PathBuf::from(path),
            original_path: original_path.map(PathBuf::from),
            side,
            kind,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn original_path(&self) -> Option<&Path> {
        self.original_path.as_deref()
    }

    pub fn side(&self) -> WorktreeChangeSide {
        self.side
    }

    pub fn kind(&self) -> WorktreeChangeKind {
        self.kind
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeChangesObservation {
    pub entries: Vec<WorktreeChangeEntry>,
    pub truncated: bool,
    pub git_process_count: usize,
}

#[derive(Clone, PartialEq, Eq)]
pub enum WorktreeDiffContent {
    Patch(Vec<u8>),
    Binary,
    Truncated,
    NotShown,
}

impl std::fmt::Debug for WorktreeDiffContent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Patch(bytes) => formatter
                .debug_struct("Patch")
                .field("bytes", &bytes.len())
                .finish(),
            Self::Binary => formatter.write_str("Binary"),
            Self::Truncated => formatter.write_str("Truncated"),
            Self::NotShown => formatter.write_str("NotShown"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeDiffObservation {
    pub content: WorktreeDiffContent,
    pub git_process_count: usize,
}

impl GitRunner {
    pub fn list_worktree_changes(
        &self,
        worktree_root: &Path,
    ) -> Result<WorktreeChangesObservation, GitError> {
        let bounded = self
            .clone()
            .with_limits(CHANGE_OBSERVATION_DEADLINE, CHANGE_LIST_MAX_OUTPUT_BYTES)
            .with_absolute_timeout(CHANGE_OBSERVATION_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, CHANGE_OBSERVATION_DEADLINE)?;
        let output = scope.checked(
            GitOperation::ListChanges,
            worktree_root,
            [
                "status",
                "--porcelain=v2",
                "-z",
                "--no-show-stash",
                "--untracked-files=all",
                "--ignore-submodules=dirty",
            ],
        )?;
        let (entries, truncated) = parse_change_entries(&output.stdout)?;
        Ok(WorktreeChangesObservation {
            entries,
            truncated,
            git_process_count: scope.command_count(),
        })
    }

    pub fn diff_worktree_change(
        &self,
        worktree_root: &Path,
        entry: &WorktreeChangeEntry,
    ) -> Result<WorktreeDiffObservation, GitError> {
        if entry.kind == WorktreeChangeKind::Unmerged {
            return Ok(WorktreeDiffObservation {
                content: WorktreeDiffContent::NotShown,
                git_process_count: 0,
            });
        }
        let bounded = self
            .clone()
            .with_limits(CHANGE_OBSERVATION_DEADLINE, CHANGE_DIFF_MAX_BYTES + 1)
            .with_absolute_timeout(CHANGE_OBSERVATION_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, CHANGE_OBSERVATION_DEADLINE)?;
        if entry.side == WorktreeChangeSide::Untracked {
            return diff_untracked_worktree_change(&mut scope, worktree_root, entry);
        }
        let mut numstat = vec![
            OsString::from("diff"),
            OsString::from("--numstat"),
            OsString::from("-z"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
        ];
        if entry.side == WorktreeChangeSide::Staged {
            numstat.push(OsString::from("--cached"));
        }
        numstat.push(OsString::from("--"));
        append_literal_pathspecs(&mut numstat, entry)?;
        let stats = scope.checked(GitOperation::Diff, worktree_root, numstat)?;
        if numstat_is_binary(&stats.stdout)? {
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
            OsString::from("--unified=3"),
        ];
        if entry.side == WorktreeChangeSide::Staged {
            args.push(OsString::from("--cached"));
        }
        args.push(OsString::from("--"));
        append_literal_pathspecs(&mut args, entry)?;
        let output = match scope.checked(GitOperation::Diff, worktree_root, args) {
            Ok(output) => output,
            Err(GitError::OutputLimitExceeded {
                operation: GitOperation::Diff,
            }) => {
                return Ok(WorktreeDiffObservation {
                    content: WorktreeDiffContent::Truncated,
                    git_process_count: scope.command_count(),
                });
            }
            Err(error) => return Err(error),
        };
        let content = if exceeds_change_bounds(&output.stdout) {
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

/// Render an untracked file as a new-file patch without adding it to the index.
/// `git diff --no-index` returns exit 1 when it successfully finds a difference,
/// so this path accepts that documented outcome while preserving every other
/// timeout, output, signal, and command failure as a typed error.
fn diff_untracked_worktree_change(
    scope: &mut GitCommandScope<'_>,
    worktree_root: &Path,
    entry: &WorktreeChangeEntry,
) -> Result<WorktreeDiffObservation, GitError> {
    let null_device =
        termloop_platform::subprocess_path_argument(termloop_platform::null_device_path())
            .into_os_string();
    let path = termloop_platform::subprocess_path_argument(entry.path()).into_os_string();
    let numstat = execute_no_index_diff(
        scope,
        worktree_root,
        vec![
            OsString::from("diff"),
            OsString::from("--no-index"),
            OsString::from("--numstat"),
            OsString::from("-z"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--"),
            null_device.clone(),
            path.clone(),
        ],
    )?;
    if numstat_is_binary(&numstat.stdout)? {
        return Ok(WorktreeDiffObservation {
            content: WorktreeDiffContent::Binary,
            git_process_count: scope.command_count(),
        });
    }

    let output = match execute_no_index_diff(
        scope,
        worktree_root,
        vec![
            OsString::from("diff"),
            OsString::from("--no-index"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--no-color"),
            OsString::from("--unified=3"),
            OsString::from("--"),
            null_device,
            path,
        ],
    ) {
        Ok(output) => output,
        Err(GitError::OutputLimitExceeded {
            operation: GitOperation::Diff,
        }) => {
            return Ok(WorktreeDiffObservation {
                content: WorktreeDiffContent::Truncated,
                git_process_count: scope.command_count(),
            });
        }
        Err(error) => return Err(error),
    };
    let content = if exceeds_change_bounds(&output.stdout) {
        WorktreeDiffContent::Truncated
    } else {
        WorktreeDiffContent::Patch(output.stdout)
    };
    Ok(WorktreeDiffObservation {
        content,
        git_process_count: scope.command_count(),
    })
}

fn execute_no_index_diff(
    scope: &mut GitCommandScope<'_>,
    worktree_root: &Path,
    args: Vec<OsString>,
) -> Result<CommandOutcome, GitError> {
    let outcome = scope.execute(GitOperation::Diff, worktree_root, args)?;
    match outcome.termination {
        CommandTermination::Exited { code: 0 | 1 } if !outcome.stdout.is_empty() => Ok(outcome),
        termination => Err(command_failure(
            GitOperation::Diff,
            termination,
            &outcome.stderr,
        )),
    }
}

/// Whether content exceeds the accepted byte or line bound for one change.
/// Shared so every content-producing primitive refuses at the same threshold.
pub(crate) fn exceeds_change_bounds(bytes: &[u8]) -> bool {
    bytes.len() > CHANGE_DIFF_MAX_BYTES
        || bytes.iter().filter(|byte| **byte == b'\n').count() > CHANGE_DIFF_MAX_LINES
}

/// Git interprets a bare path argument as pathspec syntax even after `--`.
/// Prefix the exact platform bytes with pathspec literal magic so names such as
/// `a[1].txt` and `:colon.txt` cannot select a different file.
pub(crate) fn literal_pathspec(path: &Path) -> Result<OsString, GitError> {
    let mut bytes = b":(literal)".to_vec();
    bytes.extend(
        termloop_platform::process_bytes_from_os_str(path.as_os_str()).map_err(|_| {
            GitError::ParseFailed {
                operation: GitOperation::Diff,
            }
        })?,
    );
    termloop_platform::os_string_from_process_bytes(bytes).map_err(|_| GitError::ParseFailed {
        operation: GitOperation::Diff,
    })
}

fn append_literal_pathspecs(
    args: &mut Vec<OsString>,
    entry: &WorktreeChangeEntry,
) -> Result<(), GitError> {
    args.push(literal_pathspec(entry.path())?);
    if let Some(original_path) = entry.original_path() {
        args.push(literal_pathspec(original_path)?);
    }
    Ok(())
}

fn parse_change_entries(bytes: &[u8]) -> Result<(Vec<WorktreeChangeEntry>, bool), GitError> {
    let mut entries = Vec::new();
    let mut records = bytes.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        match record[0] {
            b'1' => {
                let fields = split_record(record, 9)?;
                add_xy_entries(
                    &mut entries,
                    fields[1],
                    safe_relative_path(fields[8])?,
                    None,
                )?;
            }
            b'2' => {
                let fields = split_record(record, 10)?;
                let original = records.next().filter(|path| !path.is_empty()).ok_or(
                    GitError::ParseFailed {
                        operation: GitOperation::ListChanges,
                    },
                )?;
                add_xy_entries(
                    &mut entries,
                    fields[1],
                    safe_relative_path(fields[9])?,
                    Some(safe_relative_path(original)?),
                )?;
            }
            b'u' => {
                let fields = split_record(record, 11)?;
                let path = safe_relative_path(fields[10])?;
                push_bounded(
                    &mut entries,
                    WorktreeChangeEntry {
                        path: path.clone(),
                        original_path: None,
                        side: WorktreeChangeSide::Staged,
                        kind: WorktreeChangeKind::Unmerged,
                    },
                );
                push_bounded(
                    &mut entries,
                    WorktreeChangeEntry {
                        path,
                        original_path: None,
                        side: WorktreeChangeSide::Unstaged,
                        kind: WorktreeChangeKind::Unmerged,
                    },
                );
            }
            b'?' => {
                let path = record
                    .strip_prefix(b"? ")
                    .filter(|path| !path.is_empty())
                    .ok_or(GitError::ParseFailed {
                        operation: GitOperation::ListChanges,
                    })?;
                push_bounded(
                    &mut entries,
                    WorktreeChangeEntry {
                        path: safe_relative_path(path)?,
                        original_path: None,
                        side: WorktreeChangeSide::Untracked,
                        kind: WorktreeChangeKind::Untracked,
                    },
                );
            }
            b'#' => {}
            _ => {
                return Err(GitError::ParseFailed {
                    operation: GitOperation::ListChanges,
                });
            }
        }
    }
    let truncated = entries.len() > CHANGE_LIST_MAX_ENTRIES;
    entries.truncate(CHANGE_LIST_MAX_ENTRIES);
    Ok((entries, truncated))
}

fn split_record(record: &[u8], count: usize) -> Result<Vec<&[u8]>, GitError> {
    let fields = record
        .splitn(count, |byte| *byte == b' ')
        .collect::<Vec<_>>();
    if fields.len() != count || fields.last().is_none_or(|path| path.is_empty()) {
        return Err(GitError::ParseFailed {
            operation: GitOperation::ListChanges,
        });
    }
    Ok(fields)
}

fn add_xy_entries(
    entries: &mut Vec<WorktreeChangeEntry>,
    xy: &[u8],
    path: PathBuf,
    original_path: Option<PathBuf>,
) -> Result<(), GitError> {
    if xy.len() != 2 {
        return Err(GitError::ParseFailed {
            operation: GitOperation::ListChanges,
        });
    }
    if xy[0] != b'.' {
        push_bounded(
            entries,
            WorktreeChangeEntry {
                path: path.clone(),
                original_path: original_path.clone(),
                side: WorktreeChangeSide::Staged,
                kind: change_kind(xy[0])?,
            },
        );
    }
    if xy[1] != b'.' {
        push_bounded(
            entries,
            WorktreeChangeEntry {
                path,
                original_path,
                side: WorktreeChangeSide::Unstaged,
                kind: change_kind(xy[1])?,
            },
        );
    }
    Ok(())
}

fn push_bounded(entries: &mut Vec<WorktreeChangeEntry>, entry: WorktreeChangeEntry) {
    if entries.len() <= CHANGE_LIST_MAX_ENTRIES {
        entries.push(entry);
    }
}

fn change_kind(value: u8) -> Result<WorktreeChangeKind, GitError> {
    match value {
        b'M' | b'T' => Ok(WorktreeChangeKind::Modified),
        b'A' => Ok(WorktreeChangeKind::Added),
        b'D' => Ok(WorktreeChangeKind::Deleted),
        b'R' => Ok(WorktreeChangeKind::Renamed),
        b'C' => Ok(WorktreeChangeKind::Copied),
        b'U' => Ok(WorktreeChangeKind::Unmerged),
        _ => Err(GitError::ParseFailed {
            operation: GitOperation::ListChanges,
        }),
    }
}

pub(crate) fn safe_relative_path(bytes: &[u8]) -> Result<PathBuf, GitError> {
    let path = termloop_platform::path_from_process_bytes(bytes.to_vec()).map_err(|_| {
        GitError::ParseFailed {
            operation: GitOperation::ListChanges,
        }
    })?;
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(GitError::ParseFailed {
            operation: GitOperation::ListChanges,
        });
    }
    Ok(path)
}

fn numstat_is_binary(bytes: &[u8]) -> Result<bool, GitError> {
    let first = bytes.split(|byte| *byte == 0).next().unwrap_or_default();
    if first.is_empty() {
        return Ok(false);
    }
    let mut fields = first.splitn(3, |byte| *byte == b'\t');
    let added = fields.next().unwrap_or_default();
    let deleted = fields.next().unwrap_or_default();
    if fields.next().is_none() {
        return Err(GitError::ParseFailed {
            operation: GitOperation::Diff,
        });
    }
    Ok(added == b"-" && deleted == b"-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_emits_two_entries_for_two_sided_change_and_preserves_rename_paths() {
        let bytes = b"1 MM N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 both.txt\x002 R. N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 R100 new.txt\0old.txt\0? untracked.txt\0";
        let (entries, truncated) = parse_change_entries(bytes).unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].side(), WorktreeChangeSide::Staged);
        assert_eq!(entries[1].side(), WorktreeChangeSide::Unstaged);
        assert_eq!(entries[2].kind(), WorktreeChangeKind::Renamed);
        assert_eq!(entries[2].path(), Path::new("new.txt"));
        assert_eq!(entries[2].original_path(), Some(Path::new("old.txt")));
        assert_eq!(entries[3].side(), WorktreeChangeSide::Untracked);
    }

    #[test]
    fn change_entry_debug_never_contains_path() {
        let entry = WorktreeChangeEntry {
            path: PathBuf::from("secret-name.txt"),
            original_path: Some(PathBuf::from("old-secret-name.txt")),
            side: WorktreeChangeSide::Staged,
            kind: WorktreeChangeKind::Renamed,
        };
        let debug = format!("{entry:?}");
        assert!(!debug.contains("secret-name"));
    }

    #[test]
    fn numstat_binary_detection_is_typed() {
        assert!(numstat_is_binary(b"-\t-\timage.png\0").unwrap());
        assert!(!numstat_is_binary(b"12\t3\tfile.rs\0").unwrap());
    }

    #[test]
    fn parser_caps_the_change_list_with_a_typed_truncated_flag() {
        let mut bytes = Vec::new();
        for index in 0..=CHANGE_LIST_MAX_ENTRIES {
            bytes.extend_from_slice(format!("? file-{index}\0").as_bytes());
        }
        let (entries, truncated) = parse_change_entries(&bytes).unwrap();
        assert_eq!(entries.len(), CHANGE_LIST_MAX_ENTRIES);
        assert!(truncated);
    }

    #[test]
    fn unmerged_diff_is_not_shown_without_running_git() {
        let runner = GitRunner::discover().unwrap();
        let entry = WorktreeChangeEntry {
            path: PathBuf::from("conflicted.txt"),
            original_path: None,
            side: WorktreeChangeSide::Unstaged,
            kind: WorktreeChangeKind::Unmerged,
        };
        let observed = runner
            .diff_worktree_change(Path::new("does-not-need-to-exist"), &entry)
            .unwrap();
        assert_eq!(observed.content, WorktreeDiffContent::NotShown);
        assert_eq!(observed.git_process_count, 0);
    }
}
