//! Bounded read of the old side (pre-image) of a worktree or branch change.
//!
//! A unified patch only carries the lines inside its hunks, so a client that
//! wants to show the surrounding file needs the pre-image blob itself. This
//! primitive returns that blob under its own byte/line bounds, wider than the
//! patch bounds because a whole file is larger than its change, and refuses
//! anything it cannot represent.
//!
//! Resolution is exact-OID plumbing, never a `rev:path` revision expression:
//! `ls-files -s` (index) or `ls-tree` (HEAD, a commit's first parent, or a
//! branch's merge base) yields a blob OID, and `cat-file`
//! reads that OID. A path is therefore never parsed as revision syntax, and a
//! path containing `:` cannot select a different object.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::changes::{
    WorktreeChangeEntry, WorktreeChangeKind, WorktreeChangeSide, literal_pathspec,
};
use crate::command::GitCommandScope;
use crate::commit_changes::observe_merge_base;
use crate::repository::ObjectId;
use crate::{BranchCommit, CommitChangeEntry, GitError, GitOperation, GitRunner};

const PRE_IMAGE_DEADLINE: Duration = Duration::from_millis(2_500);
/// Largest pre-image returned, matching the workspace file editor's bound so a
/// file that can be edited can also be compared against its old side.
pub const PRE_IMAGE_MAX_BYTES: usize = 1024 * 1024;
pub const PRE_IMAGE_MAX_LINES: usize = 50_000;
/// Git's own binary heuristic window: a NUL byte near the start means binary.
const BINARY_SNIFF_BYTES: usize = 8_000;

/// Which stored object holds the old side of a change.
///
/// This mirrors what the diff primitive compares. `git diff` compares index to
/// worktree, so an unstaged change's old side is the **index**. `git diff
/// --cached` compares HEAD to index, so a staged change's old side is **HEAD**.
/// Reading the working-tree file would be the new side and is never correct here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreImageRevision {
    Index,
    Head,
}

#[derive(Clone, PartialEq, Eq)]
pub enum PreImageContent {
    /// Exact pre-image bytes, within bounds.
    Content(Vec<u8>),
    /// The old side does not exist: an added file has no previous content.
    Absent,
    /// Binary content; not rendered as text.
    Binary,
    /// Larger than the accepted byte/line bounds.
    Truncated,
    /// Outside the read-only viewer, matching the diff primitive's refusal.
    NotShown,
}

impl std::fmt::Debug for PreImageContent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Content(bytes) => formatter
                .debug_struct("Content")
                .field("bytes", &bytes.len())
                .finish(),
            Self::Absent => formatter.write_str("Absent"),
            Self::Binary => formatter.write_str("Binary"),
            Self::Truncated => formatter.write_str("Truncated"),
            Self::NotShown => formatter.write_str("NotShown"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreImageObservation {
    pub content: PreImageContent,
    pub revision: PreImageRevision,
    pub git_process_count: usize,
}

/// The old side of one branch commit or branch-range change. Its revision is
/// implied by the target: a commit's first parent, or the range's merge base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPreImageObservation {
    pub content: PreImageContent,
    pub git_process_count: usize,
}

impl GitRunner {
    /// Read the old side of one worktree change entry.
    ///
    /// The entry must come from a live `list_worktree_changes` observation; this
    /// primitive takes no caller-supplied path and makes no safety decision of
    /// its own beyond the bounds and refusals documented above.
    pub fn read_worktree_change_pre_image(
        &self,
        worktree_root: &Path,
        entry: &WorktreeChangeEntry,
    ) -> Result<PreImageObservation, GitError> {
        let revision = pre_image_revision(entry.side());
        let observed = |content, git_process_count| PreImageObservation {
            content,
            revision,
            git_process_count,
        };

        // Added and untracked files have no old side at all: their patch already
        // carries every line. Unmerged entries remain outside this viewer.
        match (entry.side(), entry.kind()) {
            (_, WorktreeChangeKind::Unmerged) => {
                return Ok(observed(PreImageContent::NotShown, 0));
            }
            (WorktreeChangeSide::Untracked, _) | (_, WorktreeChangeKind::Added) => {
                return Ok(observed(PreImageContent::Absent, 0));
            }
            _ => {}
        }

        let bounded = self.pre_image_runner()?;
        let mut scope = GitCommandScope::bounded(&bounded, PRE_IMAGE_DEADLINE)?;
        let path = pre_image_path(entry);
        let oid = resolve_pre_image_oid(&mut scope, worktree_root, revision, &path)?;
        let content = read_pre_image_content(&mut scope, worktree_root, oid)?;
        Ok(observed(content, scope.command_count()))
    }

    /// Read the old side of one change in a branch commit: the blob at the
    /// commit's first parent. A merge commit stays outside the viewer, as its
    /// diff does, and a root commit's files have no old side.
    pub fn read_commit_change_pre_image(
        &self,
        repository_path: &Path,
        commit: &BranchCommit,
        entry: &CommitChangeEntry,
    ) -> Result<CommitPreImageObservation, GitError> {
        if commit.is_merge() {
            return Ok(commit_observed(PreImageContent::NotShown, 0));
        }
        let Some(parent) = commit.first_parent().filter(|_| has_old_side(entry)) else {
            return Ok(commit_observed(PreImageContent::Absent, 0));
        };
        let bounded = self.pre_image_runner()?;
        let mut scope = GitCommandScope::bounded(&bounded, PRE_IMAGE_DEADLINE)?;
        let content = read_tree_pre_image(&mut scope, repository_path, parent, entry)?;
        Ok(commit_observed(content, scope.command_count()))
    }

    /// Read the old side of one change across a whole branch: the blob at the
    /// merge base the range's diff compares against.
    pub fn read_branch_range_change_pre_image(
        &self,
        repository_path: &Path,
        base_oid: &ObjectId,
        branch_tip_oid: &ObjectId,
        entry: &CommitChangeEntry,
    ) -> Result<CommitPreImageObservation, GitError> {
        if !has_old_side(entry) {
            return Ok(commit_observed(PreImageContent::Absent, 0));
        }
        let bounded = self.pre_image_runner()?;
        let mut scope = GitCommandScope::bounded(&bounded, PRE_IMAGE_DEADLINE)?;
        let merge_base = observe_merge_base(&mut scope, repository_path, base_oid, branch_tip_oid)?;
        let content = read_tree_pre_image(&mut scope, repository_path, &merge_base, entry)?;
        Ok(commit_observed(content, scope.command_count()))
    }

    /// The runner is capped at one byte past the accepted maximum, so an
    /// oversized blob is refused by the output limit instead of a separate
    /// size probe.
    fn pre_image_runner(&self) -> Result<GitRunner, GitError> {
        self.clone()
            .with_limits(PRE_IMAGE_DEADLINE, PRE_IMAGE_MAX_BYTES + 1)
            .with_absolute_timeout(PRE_IMAGE_DEADLINE)
    }
}

fn commit_observed(
    content: PreImageContent,
    git_process_count: usize,
) -> CommitPreImageObservation {
    CommitPreImageObservation {
        content,
        git_process_count,
    }
}

/// An added file's patch already carries every line.
fn has_old_side(entry: &CommitChangeEntry) -> bool {
    entry.kind() != WorktreeChangeKind::Added
}

fn read_tree_pre_image(
    scope: &mut GitCommandScope<'_>,
    repository_path: &Path,
    tree: &ObjectId,
    entry: &CommitChangeEntry,
) -> Result<PreImageContent, GitError> {
    // A rename's old side lives at the original path.
    let path = entry.original_path().unwrap_or_else(|| entry.path());
    let oid = resolve_tree_blob(scope, repository_path, object_argument(tree)?, path)?;
    read_pre_image_content(scope, repository_path, oid)
}

fn read_pre_image_content(
    scope: &mut GitCommandScope<'_>,
    root: &Path,
    oid: Option<ObjectId>,
) -> Result<PreImageContent, GitError> {
    let Some(oid) = oid else {
        return Ok(PreImageContent::Absent);
    };
    match read_blob(scope, root, &oid) {
        Ok(bytes) => Ok(classify_pre_image(bytes)),
        Err(GitError::OutputLimitExceeded {
            operation: GitOperation::ReadPreImage,
        }) => Ok(PreImageContent::Truncated),
        Err(error) => Err(error),
    }
}

fn pre_image_revision(side: WorktreeChangeSide) -> PreImageRevision {
    match side {
        WorktreeChangeSide::Staged => PreImageRevision::Head,
        WorktreeChangeSide::Unstaged | WorktreeChangeSide::Untracked => PreImageRevision::Index,
    }
}

/// A rename's old side lives at the original path.
fn pre_image_path(entry: &WorktreeChangeEntry) -> PathBuf {
    entry
        .original_path()
        .unwrap_or_else(|| entry.path())
        .to_path_buf()
}

fn classify_pre_image(bytes: Vec<u8>) -> PreImageContent {
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0) {
        return PreImageContent::Binary;
    }
    if bytes.len() > PRE_IMAGE_MAX_BYTES
        || bytes.iter().filter(|byte| **byte == b'\n').count() > PRE_IMAGE_MAX_LINES
    {
        return PreImageContent::Truncated;
    }
    PreImageContent::Content(bytes)
}

fn resolve_pre_image_oid(
    scope: &mut GitCommandScope<'_>,
    worktree_root: &Path,
    revision: PreImageRevision,
    path: &Path,
) -> Result<Option<ObjectId>, GitError> {
    match revision {
        PreImageRevision::Index => {
            let output = scope.checked(
                GitOperation::ReadPreImage,
                worktree_root,
                [
                    OsString::from("ls-files"),
                    OsString::from("--stage"),
                    OsString::from("-z"),
                    OsString::from("--"),
                    literal_pathspec(path)?,
                ],
            )?;
            parse_ls_files_stage_zero(&output.stdout)
        }
        PreImageRevision::Head => {
            resolve_tree_blob(scope, worktree_root, OsString::from("HEAD"), path)
        }
    }
}

/// `tree` is `HEAD` or an exact commit OID, never a composed revision.
fn resolve_tree_blob(
    scope: &mut GitCommandScope<'_>,
    root: &Path,
    tree: OsString,
    path: &Path,
) -> Result<Option<ObjectId>, GitError> {
    let output = scope.checked(
        GitOperation::ReadPreImage,
        root,
        [
            OsString::from("ls-tree"),
            OsString::from("-z"),
            tree,
            OsString::from("--"),
            literal_pathspec(path)?,
        ],
    )?;
    parse_ls_tree_blob(&output.stdout)
}

/// Both listings frame a record the same way: NUL-delimited, with three
/// space-separated metadata fields before the first TAB, then the exact path
/// bytes. Splitting on the first TAB keeps a TAB inside a path from shifting the
/// fields. A fourth metadata field is contradictory, so it fails closed.
fn metadata_fields(record: &[u8]) -> Result<[&[u8]; 3], GitError> {
    let metadata = record
        .split(|byte| *byte == b'\t')
        .next()
        .ok_or(parse_failed())?;
    let mut fields = metadata.split(|byte| *byte == b' ');
    let first = fields.next().ok_or(parse_failed())?;
    let second = fields.next().ok_or(parse_failed())?;
    let third = fields.next().ok_or(parse_failed())?;
    if fields.next().is_some() {
        return Err(parse_failed());
    }
    Ok([first, second, third])
}

fn records(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
}

/// `ls-files --stage -z` records are `<mode> SP <oid> SP <stage> TAB <path>`.
/// Only stage 0 is a resolved entry; a conflicted path has stages 1-3 and is
/// already refused as unmerged before we get here, so a non-zero stage is
/// skipped rather than refused.
fn parse_ls_files_stage_zero(bytes: &[u8]) -> Result<Option<ObjectId>, GitError> {
    for record in records(bytes) {
        let [mode, oid, stage] = metadata_fields(record)?;
        if stage != b"0" {
            continue;
        }
        if !is_regular_blob_mode(mode) {
            return Ok(None);
        }
        return ObjectId::from_hex(oid.to_vec()).map(Some);
    }
    Ok(None)
}

/// `ls-tree -z` records are `<mode> SP <type> SP <oid> TAB <path>`. One literal
/// pathspec names at most one entry, and a non-blob type is that entry's real
/// answer, so only the first record is consulted.
fn parse_ls_tree_blob(bytes: &[u8]) -> Result<Option<ObjectId>, GitError> {
    let Some(record) = records(bytes).next() else {
        return Ok(None);
    };
    let [mode, object_type, oid] = metadata_fields(record)?;
    if object_type != b"blob" || !is_regular_blob_mode(mode) {
        return Ok(None);
    }
    ObjectId::from_hex(oid.to_vec()).map(Some)
}

/// Regular files only. A symlink (`120000`), gitlink/submodule (`160000`), or
/// tree is not file content this viewer may render.
fn is_regular_blob_mode(mode: &[u8]) -> bool {
    mode == b"100644" || mode == b"100755"
}

fn read_blob(
    scope: &mut GitCommandScope<'_>,
    worktree_root: &Path,
    oid: &ObjectId,
) -> Result<Vec<u8>, GitError> {
    let output = scope.checked(
        GitOperation::ReadPreImage,
        worktree_root,
        [
            OsString::from("cat-file"),
            OsString::from("blob"),
            object_argument(oid)?,
        ],
    )?;
    Ok(output.stdout)
}

/// An OID is hex, so this composes no revision expression. `^{blob}` is
/// deliberately not appended: the mode check already proved the object is a
/// regular blob, and peeling syntax is exactly what the charter forbids.
fn object_argument(oid: &ObjectId) -> Result<OsString, GitError> {
    termloop_platform::os_string_from_process_bytes(oid.as_bytes().to_vec())
        .map_err(|_| parse_failed())
}

fn parse_failed() -> GitError {
    GitError::ParseFailed {
        operation: GitOperation::ReadPreImage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn unstaged_reads_the_index_and_staged_reads_head() {
        assert_eq!(
            pre_image_revision(WorktreeChangeSide::Unstaged),
            PreImageRevision::Index
        );
        assert_eq!(
            pre_image_revision(WorktreeChangeSide::Staged),
            PreImageRevision::Head
        );
    }

    #[test]
    fn stage_zero_index_entry_is_selected() {
        let record = format!("100644 {OID} 0\tsample.ts\0");
        assert_eq!(
            parse_ls_files_stage_zero(record.as_bytes())
                .unwrap()
                .unwrap()
                .as_bytes(),
            OID.as_bytes()
        );
    }

    #[test]
    fn conflicted_stages_yield_no_index_blob() {
        let record = format!("100644 {OID} 1\tsample.ts\0100644 {OID} 2\tsample.ts\0");
        assert!(
            parse_ls_files_stage_zero(record.as_bytes())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn symlink_and_submodule_modes_are_refused() {
        let symlink = format!("120000 {OID} 0\tlink\0");
        assert!(
            parse_ls_files_stage_zero(symlink.as_bytes())
                .unwrap()
                .is_none()
        );
        let gitlink = format!("160000 commit {OID}\tmodule\0");
        assert!(parse_ls_tree_blob(gitlink.as_bytes()).unwrap().is_none());
    }

    #[test]
    fn tree_entries_are_not_read_as_content() {
        let tree = format!("040000 tree {OID}\tdirectory\0");
        assert!(parse_ls_tree_blob(tree.as_bytes()).unwrap().is_none());
    }

    #[test]
    fn head_blob_entry_is_selected() {
        let record = format!("100755 blob {OID}\tscript.sh\0");
        assert_eq!(
            parse_ls_tree_blob(record.as_bytes())
                .unwrap()
                .unwrap()
                .as_bytes(),
            OID.as_bytes()
        );
    }

    #[test]
    fn a_path_containing_a_tab_does_not_shift_the_metadata_fields() {
        // The metadata is delimited by the first TAB, so a TAB inside the path
        // cannot be mistaken for a field separator.
        let record = format!("100644 {OID} 0\todd\tname.ts\0");
        assert_eq!(
            parse_ls_files_stage_zero(record.as_bytes())
                .unwrap()
                .unwrap()
                .as_bytes(),
            OID.as_bytes()
        );
    }

    #[test]
    fn malformed_metadata_fails_closed() {
        let record = format!("100644 {OID} 0 extra\tsample.ts\0");
        assert!(matches!(
            parse_ls_files_stage_zero(record.as_bytes()),
            Err(GitError::ParseFailed { .. })
        ));
    }

    #[test]
    fn empty_output_is_absent_not_an_error() {
        assert!(parse_ls_files_stage_zero(b"").unwrap().is_none());
        assert!(parse_ls_tree_blob(b"").unwrap().is_none());
    }

    #[test]
    fn nul_bytes_classify_as_binary() {
        assert_eq!(
            classify_pre_image(vec![b'a', 0, b'b']),
            PreImageContent::Binary
        );
    }

    #[test]
    fn a_nul_past_the_sniff_window_is_not_treated_as_binary() {
        let mut bytes = vec![b'a'; BINARY_SNIFF_BYTES];
        bytes.push(0);
        assert!(matches!(
            classify_pre_image(bytes),
            PreImageContent::Content(_)
        ));
    }

    #[test]
    fn oversized_line_and_byte_counts_are_truncated() {
        assert_eq!(
            classify_pre_image(vec![b'\n'; PRE_IMAGE_MAX_LINES + 1]),
            PreImageContent::Truncated
        );
        assert_eq!(
            classify_pre_image(vec![b'a'; PRE_IMAGE_MAX_BYTES + 1]),
            PreImageContent::Truncated
        );
    }

    #[test]
    fn content_within_bounds_is_returned_exactly() {
        let bytes = b"const a = 1;\nconst b = 2;\n".to_vec();
        assert_eq!(
            classify_pre_image(bytes.clone()),
            PreImageContent::Content(bytes)
        );
    }

    #[test]
    fn a_rename_reads_its_original_path() {
        let entry = WorktreeChangeEntry::for_test(
            "new.ts",
            Some("old.ts"),
            WorktreeChangeSide::Staged,
            WorktreeChangeKind::Renamed,
        );
        assert_eq!(pre_image_path(&entry), PathBuf::from("old.ts"));
    }
}
