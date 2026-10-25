//! Who changed what: recent HEAD commits that touch one exact path or name
//! one exact word in their message, with author names. Read-only and
//! bounded; it never decides who owns anything.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use crate::changes::{literal_pathspec, safe_relative_path};
use crate::commit_changes::parse_log_records;
use crate::{GitError, GitOperation, GitRunner, ObjectId};

/// Commits one history read returns at most.
pub const PATH_HISTORY_MAX_ENTRIES: usize = 30;
const PATH_HISTORY_OUTPUT_LIMIT: usize = 256 * 1024;
const PATH_HISTORY_DEADLINE: Duration = Duration::from_millis(2_500);
const MESSAGE_WORD_MAX_BYTES: usize = 64;

#[derive(Clone, PartialEq, Eq)]
pub struct HistoryCommit {
    oid: ObjectId,
    author: Vec<u8>,
    subject: Vec<u8>,
    authored_at_epoch_ms: u64,
}

impl std::fmt::Debug for HistoryCommit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HistoryCommit")
            .field("oid", &"<redacted>")
            .field("author", &"<redacted>")
            .field("subject", &"<redacted>")
            .field("authored_at_epoch_ms", &self.authored_at_epoch_ms)
            .finish()
    }
}

impl HistoryCommit {
    pub fn oid(&self) -> &ObjectId {
        &self.oid
    }

    /// The author name as Git recorded it.
    pub fn author(&self) -> &[u8] {
        &self.author
    }

    pub fn subject(&self) -> &[u8] {
        &self.subject
    }

    pub fn authored_at_epoch_ms(&self) -> u64 {
        self.authored_at_epoch_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryObservation {
    /// Newest first.
    pub commits: Vec<HistoryCommit>,
    /// More commits matched than were returned.
    pub truncated: bool,
}

impl GitRunner {
    /// Recent non-merge commits of HEAD that touch one repository-relative
    /// path, taken literally. A path HEAD never had answers no commits.
    pub fn path_history(
        &self,
        repository_path: &Path,
        path: &[u8],
    ) -> Result<HistoryObservation, GitError> {
        let path = safe_relative_path(path).map_err(|_| parse_error())?;
        self.history(
            repository_path,
            [OsString::from("--"), literal_pathspec(&path)?],
        )
    }

    /// Recent non-merge commits of HEAD whose message contains one exact
    /// word, such as an issue key: letters, digits, `-` and `_` only.
    pub fn message_history(
        &self,
        repository_path: &Path,
        word: &str,
    ) -> Result<HistoryObservation, GitError> {
        if word.is_empty()
            || word.len() > MESSAGE_WORD_MAX_BYTES
            || word.starts_with('-')
            || !word
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(parse_error());
        }
        self.history(
            repository_path,
            [
                OsString::from("--fixed-strings"),
                OsString::from(format!("--grep={word}")),
                OsString::from("--"),
            ],
        )
    }

    fn history<const N: usize>(
        &self,
        repository_path: &Path,
        selection: [OsString; N],
    ) -> Result<HistoryObservation, GitError> {
        let bounded = self
            .clone()
            .with_limits(PATH_HISTORY_DEADLINE, PATH_HISTORY_OUTPUT_LIMIT);
        let mut args = vec![
            OsString::from("log"),
            OsString::from("-z"),
            OsString::from("--no-merges"),
            OsString::from("--no-show-signature"),
            OsString::from("--format=%H%x00%an%x00%at%x00%s"),
            OsString::from(format!("--max-count={}", PATH_HISTORY_MAX_ENTRIES + 1)),
            OsString::from("HEAD"),
        ];
        args.extend(selection);
        let outcome = bounded.checked(GitOperation::History, repository_path, args)?;
        let mut commits = parse_log_records(&outcome.stdout, GitOperation::History)?
            .into_iter()
            .map(|record| HistoryCommit {
                oid: record.oid,
                author: record.second.to_vec(),
                subject: record.subject.to_vec(),
                authored_at_epoch_ms: record.authored_at_epoch_ms,
            })
            .collect::<Vec<_>>();
        let truncated = commits.len() > PATH_HISTORY_MAX_ENTRIES;
        commits.truncate(PATH_HISTORY_MAX_ENTRIES);
        Ok(HistoryObservation { commits, truncated })
    }
}

fn parse_error() -> GitError {
    GitError::ParseFailed {
        operation: GitOperation::History,
    }
}
