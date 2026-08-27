//! Bounded read of the old side (pre-image) of a worktree change.
//!
//! A unified patch only carries the lines inside its hunks, so a client that
//! wants to show the surrounding file needs the pre-image blob itself. This
//! primitive returns that blob under the same byte/line bounds the diff
//! primitive already applies, and refuses anything it cannot represent.
//!
//! Resolution is exact-OID plumbing, never a `rev:path` revision expression:
//! `ls-files -s` (index) or `ls-tree` (HEAD) yields a blob OID, and `cat-file`
//! reads that OID. A path is therefore never parsed as revision syntax, and a
//! path containing `:` cannot select a different object.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::changes::{
    CHANGE_DIFF_MAX_BYTES, WorktreeChangeEntry, WorktreeChangeKind, WorktreeChangeSide,
    exceeds_change_bounds, literal_pathspec,
};
use crate::command::GitCommandScope;
use crate::repository::ObjectId;
use crate::{GitError, GitOperation, GitRunner};

const PRE_IMAGE_DEADLINE: Duration = Duration::from_millis(2_500);
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

        // The runner is capped at one byte past the accepted maximum, so an
        // oversized blob is refused by the output limit instead of a separate
        // size probe.
        let bounded = self
            .clone()
            .with_limits(PRE_IMAGE_DEADLINE, CHANGE_DIFF_MAX_BYTES + 1)
            .with_absolute_timeout(PRE_IMAGE_DEADLINE)?;
        let mut scope = GitCommandScope::bounded(&bounded, PRE_IMAGE_DEADLINE)?;
        let path = pre_image_path(entry);
        let Some(oid) = resolve_pre_image_oid(&mut scope, worktree_root, revision, &path)? else {
            return Ok(observed(PreImageContent::Absent, scope.command_count()));
        };

        match read_blob(&mut scope, worktree_root, &oid) {
            Ok(bytes) => Ok(observed(classify_pre_image(bytes), scope.command_count())),
            Err(GitError::OutputLimitExceeded {
                operation: GitOperation::ReadPreImage,
            }) => Ok(observed(PreImageContent::Truncated, scope.command_count())),
            Err(error) => Err(error),
        }
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
    if exceeds_change_bounds(&bytes) {
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
    let pathspec = literal_pathspec(path)?;
    let args: Vec<OsString> = match revision {
        PreImageRevision::Index => vec![
            OsString::from("ls-files"),
            OsString::from("--stage"),
            OsString::from("-z"),
            OsString::from("--"),
            pathspec,
        ],
        PreImageRevision::Head => vec![
            OsString::from("ls-tree"),
            OsString::from("-z"),
            OsString::from("HEAD"),
            OsString::from("--"),
            pathspec,
        ],
    };
    let output = scope.checked(GitOperation::ReadPreImage, worktree_root, args)?;
    match revision {
        PreImageRevision::Index => parse_ls_files_stage_zero(&output.stdout),
        PreImageRevision::Head => parse_ls_tree_blob(&output.stdout),
    }
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
    use crate::changes::CHANGE_DIFF_MAX_LINES;

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
            classify_pre_image(vec![b'\n'; CHANGE_DIFF_MAX_LINES + 1]),
            PreImageContent::Truncated
        );
        assert_eq!(
            classify_pre_image(vec![b'a'; CHANGE_DIFF_MAX_BYTES + 1]),
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
