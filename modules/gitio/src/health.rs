use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use termloop_platform::{CommandTermination, PathEntryState};

use crate::command::GitCommandScope;
use crate::error::{command_failure, map_platform_error};
use crate::{
    GitError, GitOperation, GitRefName, GitRunner, HeadState, RepositoryFacts, WorktreeFacts,
    WorktreeMarker,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeState {
    Clean,
    Changed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentState {
    Absent,
    Present,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmoduleState {
    Absent,
    Uninitialized,
    InitializedClean,
    InitializedDirty,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockState {
    Absent,
    Present,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamState {
    InSync,
    Behind { commits: u64 },
    Ahead { commits: u64 },
    Diverged { ahead: u64, behind: u64 },
    NotConfigured,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmoduleFacts {
    pub state: SubmoduleState,
    pub tracked_gitlinks: usize,
    pub initialized_gitlinks: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeStatusFacts {
    pub change_count: Option<usize>,
    pub tracked: ChangeState,
    pub staged: ChangeState,
    pub untracked: ContentState,
    pub ignored: ContentState,
    pub submodules: SubmoduleFacts,
    pub worktree_lock: LockState,
    pub index_lock: LockState,
    pub upstream: UpstreamState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeHealthObservation {
    pub repository: RepositoryFacts,
    pub registration: Option<WorktreeFacts>,
    pub status: WorktreeStatusFacts,
    pub git_process_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeObservationBudget {
    Background,
    Cleanup,
}

impl WorktreeObservationBudget {
    fn git_subprocess_deadline(self) -> std::time::Duration {
        match self {
            Self::Background => crate::HEALTH_GIT_SUBPROCESS_DEADLINE,
            Self::Cleanup => crate::CLEANUP_GIT_SUBPROCESS_DEADLINE,
        }
    }
}

#[derive(Debug)]
struct ParsedStatus {
    change_count: usize,
    tracked: ChangeState,
    staged: ChangeState,
    untracked: ContentState,
    ignored: ContentState,
    dirty_submodule: bool,
    upstream: Option<UpstreamState>,
}

#[derive(Debug)]
struct SubmoduleInventory {
    facts: SubmoduleFacts,
    single_initialized_path: Option<PathBuf>,
}

impl GitRunner {
    pub fn inspect_worktree_health(
        &self,
        requested_path: &Path,
    ) -> Result<WorktreeHealthObservation, GitError> {
        self.inspect_worktree_health_with_budget(
            requested_path,
            WorktreeObservationBudget::Background,
        )
    }

    pub fn inspect_worktree_health_with_budget(
        &self,
        requested_path: &Path,
        budget: WorktreeObservationBudget,
    ) -> Result<WorktreeHealthObservation, GitError> {
        let mut scope = GitCommandScope::bounded(self, budget.git_subprocess_deadline())?;
        let repository_identity =
            self.inspect_repository_identity_in_scope(requested_path, &mut scope)?;
        let worktree_root = repository_identity
            .worktree_root()
            .ok_or(GitError::CommandFailed {
                operation: GitOperation::Health,
                kind: crate::GitFailureKind::UnsupportedRepository,
                termination: None,
            })?;
        let worktrees = self.list_worktrees_in_scope(worktree_root, &mut scope)?;
        let registration = worktrees.into_iter().find(|worktree| {
            matches!(
                &worktree.path_state,
                crate::RegisteredPathState::Present { canonical_path }
                    if canonical_path == worktree_root
            )
        });

        let gitlinks_output = scope.checked(
            GitOperation::Submodules,
            worktree_root,
            ["ls-files", "--stage", "-z"],
        )?;
        let submodule_inventory =
            observe_submodule_inventory(worktree_root, &gitlinks_output.stdout)?;

        let status_output = scope.checked(
            GitOperation::Status,
            worktree_root,
            [
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--ahead-behind",
                "--no-show-stash",
                "--untracked-files=all",
                "--ignored=matching",
                "--ignore-submodules=dirty",
            ],
        )?;
        let parsed_status = parse_status(&status_output.stdout)?;
        let head = crate::repository::parse_status_head(&status_output.stdout)?;
        let submodules = observe_submodule_state(
            &mut scope,
            submodule_inventory,
            parsed_status.dirty_submodule,
        )?;

        let upstream = match parsed_status.upstream {
            Some(state) => state,
            None => match &head {
                HeadState::Attached { branch, .. } => {
                    observe_missing_or_unconfigured_upstream(&mut scope, worktree_root, branch)?
                }
                HeadState::Unborn { .. } | HeadState::Detached { .. } => {
                    UpstreamState::NotConfigured
                }
            },
        };
        let worktree_lock = registration
            .as_ref()
            .map_or(LockState::Unknown, |worktree| match worktree.locked {
                WorktreeMarker::Absent => LockState::Absent,
                WorktreeMarker::Present { .. } => LockState::Present,
            });
        let index_lock = match termloop_platform::path_entry_state(
            &repository_identity.git_dir().join("index.lock"),
        )
        .map_err(|error| map_platform_error(error, GitOperation::Status))?
        {
            PathEntryState::Absent => LockState::Absent,
            PathEntryState::Present => LockState::Present,
        };
        let repository = repository_identity.into_repository(head);
        Ok(WorktreeHealthObservation {
            repository,
            registration,
            status: WorktreeStatusFacts {
                change_count: Some(parsed_status.change_count),
                tracked: parsed_status.tracked,
                staged: parsed_status.staged,
                untracked: parsed_status.untracked,
                ignored: parsed_status.ignored,
                submodules,
                worktree_lock,
                index_lock,
                upstream,
            },
            git_process_count: scope.command_count(),
        })
    }
}

fn parse_status(bytes: &[u8]) -> Result<ParsedStatus, GitError> {
    let mut status = ParsedStatus {
        change_count: 0,
        tracked: ChangeState::Clean,
        staged: ChangeState::Clean,
        untracked: ContentState::Absent,
        ignored: ContentState::Absent,
        dirty_submodule: false,
        upstream: None,
    };
    let mut upstream_name_seen = false;
    let mut upstream_counts = None;
    let mut records = bytes.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.starts_with(b"# branch.oid ") || record.starts_with(b"# branch.head ") {
            continue;
        }
        if let Some(name) = record.strip_prefix(b"# branch.upstream ") {
            if upstream_name_seen || name.is_empty() {
                return parse_failure(GitOperation::Status);
            }
            upstream_name_seen = true;
            continue;
        }
        if let Some(counts) = record.strip_prefix(b"# branch.ab ") {
            if upstream_counts.is_some() {
                return parse_failure(GitOperation::Status);
            }
            upstream_counts = Some(parse_ahead_behind(counts)?);
            continue;
        }
        match record[0] {
            b'1' => {
                parse_changed_record(record, 9, &mut status)?;
                status.change_count = status.change_count.saturating_add(1);
            }
            b'2' => {
                parse_changed_record(record, 10, &mut status)?;
                let original_path = records.next().filter(|path| !path.is_empty());
                if original_path.is_none() {
                    return parse_failure(GitOperation::Status);
                }
                status.change_count = status.change_count.saturating_add(1);
            }
            b'u' => {
                if !record.starts_with(b"u ") {
                    return parse_failure(GitOperation::Status);
                }
                status.tracked = ChangeState::Changed;
                status.staged = ChangeState::Changed;
                let sub = record
                    .split(|byte| *byte == b' ')
                    .nth(2)
                    .ok_or_else(|| parse_error(GitOperation::Status))?;
                status.dirty_submodule |= parse_submodule_field(sub)?;
                status.change_count = status.change_count.saturating_add(1);
            }
            b'?' => {
                if !record.starts_with(b"? ") || record.len() == 2 {
                    return parse_failure(GitOperation::Status);
                }
                status.untracked = ContentState::Present;
                status.change_count = status.change_count.saturating_add(1);
            }
            b'!' => {
                if !record.starts_with(b"! ") || record.len() == 2 {
                    return parse_failure(GitOperation::Status);
                }
                status.ignored = ContentState::Present;
            }
            _ => return parse_failure(GitOperation::Status),
        }
    }
    status.upstream = match (upstream_name_seen, upstream_counts) {
        (true, Some((ahead, behind))) => Some(match (ahead, behind) {
            (0, 0) => UpstreamState::InSync,
            (0, behind) => UpstreamState::Behind { commits: behind },
            (ahead, 0) => UpstreamState::Ahead { commits: ahead },
            (ahead, behind) => UpstreamState::Diverged { ahead, behind },
        }),
        (true, None) => Some(UpstreamState::Missing),
        (false, Some(_)) => return parse_failure(GitOperation::Status),
        (false, None) => None,
    };
    Ok(status)
}

fn parse_changed_record(
    record: &[u8],
    field_count: usize,
    status: &mut ParsedStatus,
) -> Result<(), GitError> {
    let fields = record
        .splitn(field_count, |byte| *byte == b' ')
        .collect::<Vec<_>>();
    if fields.len() != field_count || fields.last().is_none_or(|path| path.is_empty()) {
        return parse_failure(GitOperation::Status);
    }
    let xy = fields[1];
    if xy.len() != 2 {
        return parse_failure(GitOperation::Status);
    }
    let submodule_dirty = parse_submodule_field(fields[2])?;
    if fields[2] == b"N..." {
        if xy[0] != b'.' {
            status.staged = ChangeState::Changed;
        }
        if xy[1] != b'.' {
            status.tracked = ChangeState::Changed;
        }
    }
    status.dirty_submodule |= submodule_dirty;
    Ok(())
}

fn parse_submodule_field(value: &[u8]) -> Result<bool, GitError> {
    if value == b"N..." {
        return Ok(false);
    }
    if value.len() == 4 && value[0] == b'S' {
        return Ok(value[1..].iter().any(|byte| *byte != b'.'));
    }
    parse_failure(GitOperation::Status)
}

fn parse_ahead_behind(value: &[u8]) -> Result<(u64, u64), GitError> {
    let mut fields = value.split(|byte| *byte == b' ');
    let ahead = parse_count(fields.next(), b'+')?;
    let behind = parse_count(fields.next(), b'-')?;
    if fields.next().is_some() {
        return parse_failure(GitOperation::Status);
    }
    Ok((ahead, behind))
}

fn parse_count(value: Option<&[u8]>, prefix: u8) -> Result<u64, GitError> {
    let digits = value
        .and_then(|value| value.strip_prefix(&[prefix]))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| parse_error(GitOperation::Status))?;
    std::str::from_utf8(digits)
        .ok()
        .and_then(|digits| digits.parse().ok())
        .ok_or_else(|| parse_error(GitOperation::Status))
}

fn observe_submodule_inventory(
    worktree_root: &Path,
    bytes: &[u8],
) -> Result<SubmoduleInventory, GitError> {
    let mut tracked_gitlinks = 0;
    let mut initialized_gitlinks = 0;
    let mut single_initialized_path = None;
    let mut tracked_gitlink_paths = HashSet::new();
    let mut conflicted_gitlink = false;
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(metadata_end) = record.iter().position(|byte| *byte == b'\t') else {
            return parse_failure(GitOperation::Submodules);
        };
        let metadata = &record[..metadata_end];
        let path = &record[metadata_end + 1..];
        if path.is_empty() {
            return parse_failure(GitOperation::Submodules);
        }
        let mut metadata_fields = metadata.split(|byte| *byte == b' ');
        let mode = metadata_fields
            .next()
            .ok_or_else(|| parse_error(GitOperation::Submodules))?;
        let oid = metadata_fields
            .next()
            .ok_or_else(|| parse_error(GitOperation::Submodules))?;
        let stage = metadata_fields
            .next()
            .ok_or_else(|| parse_error(GitOperation::Submodules))?;
        if metadata_fields.next().is_some()
            || !matches!(oid.len(), 40 | 64)
            || !oid.iter().all(u8::is_ascii_hexdigit)
            || !matches!(stage, b"0" | b"1" | b"2" | b"3")
        {
            return parse_failure(GitOperation::Submodules);
        }
        if mode != b"160000" {
            continue;
        }
        conflicted_gitlink |= stage != b"0";
        let path = safe_repository_relative_path(path)?;
        if !tracked_gitlink_paths.insert(path.clone()) {
            continue;
        }
        tracked_gitlinks += 1;
        let marker = worktree_root.join(path).join(".git");
        match termloop_platform::path_entry_state(&marker)
            .map_err(|error| map_platform_error(error, GitOperation::Submodules))?
        {
            PathEntryState::Absent => {}
            PathEntryState::Present => {
                initialized_gitlinks += 1;
                if initialized_gitlinks == 1 {
                    single_initialized_path = marker.parent().map(Path::to_path_buf);
                } else {
                    single_initialized_path = None;
                }
            }
        }
    }
    let state = match (tracked_gitlinks, initialized_gitlinks, conflicted_gitlink) {
        (0, 0, false) => SubmoduleState::Absent,
        (_, _, true) => SubmoduleState::Unknown,
        (_, 0, false) => SubmoduleState::Uninitialized,
        (_, 1, false) => SubmoduleState::InitializedClean,
        _ => SubmoduleState::Unknown,
    };
    Ok(SubmoduleInventory {
        facts: SubmoduleFacts {
            state,
            tracked_gitlinks,
            initialized_gitlinks,
        },
        single_initialized_path,
    })
}

fn observe_submodule_state(
    scope: &mut GitCommandScope<'_>,
    mut inventory: SubmoduleInventory,
    root_reported_dirty: bool,
) -> Result<SubmoduleFacts, GitError> {
    if root_reported_dirty && inventory.facts.tracked_gitlinks == 0 {
        return parse_failure(GitOperation::Submodules);
    }
    let Some(path) = inventory.single_initialized_path else {
        if root_reported_dirty {
            inventory.facts.state = SubmoduleState::InitializedDirty;
        }
        return Ok(inventory.facts);
    };
    let output = scope.checked(
        GitOperation::Submodules,
        &path,
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=all",
        ],
    )?;
    let status = parse_status(&output.stdout)?;
    let dirty = root_reported_dirty
        || status.tracked == ChangeState::Changed
        || status.staged == ChangeState::Changed
        || status.untracked == ContentState::Present
        || status.ignored == ContentState::Present
        || status.dirty_submodule;
    inventory.facts.state = if dirty {
        SubmoduleState::InitializedDirty
    } else {
        SubmoduleState::InitializedClean
    };
    Ok(inventory.facts)
}

fn safe_repository_relative_path(bytes: &[u8]) -> Result<PathBuf, GitError> {
    let path = termloop_platform::path_from_process_bytes(bytes.to_vec())
        .map_err(|error| map_platform_error(error, GitOperation::Submodules))?;
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return parse_failure(GitOperation::Submodules);
    }
    Ok(path)
}

fn observe_missing_or_unconfigured_upstream(
    scope: &mut GitCommandScope<'_>,
    worktree_root: &Path,
    branch: &GitRefName,
) -> Result<UpstreamState, GitError> {
    let short = branch
        .as_bytes()
        .strip_prefix(b"refs/heads/")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| parse_error(GitOperation::Upstream))?;
    let pattern = branch_config_pattern(short);
    let pattern = termloop_platform::os_string_from_process_bytes(pattern)
        .map_err(|error| map_platform_error(error, GitOperation::Upstream))?;
    let outcome = scope.execute(
        GitOperation::Upstream,
        worktree_root,
        [
            OsString::from("config"),
            OsString::from("--null"),
            OsString::from("--get-regexp"),
            pattern,
        ],
    )?;
    match outcome.termination {
        CommandTermination::Exited { code: 1 } => Ok(UpstreamState::NotConfigured),
        CommandTermination::Exited { code: 0 } => parse_upstream_config(&outcome.stdout, short),
        termination => Err(command_failure(
            GitOperation::Upstream,
            termination,
            &outcome.stderr,
        )),
    }
}

fn parse_upstream_config(bytes: &[u8], branch: &[u8]) -> Result<UpstreamState, GitError> {
    let mut prefix = b"branch.".to_vec();
    prefix.extend_from_slice(branch);
    prefix.push(b'.');
    let remote_key = [prefix.as_slice(), b"remote"].concat();
    let merge_key = [prefix.as_slice(), b"merge"].concat();
    let mut remote_seen = false;
    let mut merge_seen = false;
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let separator = record
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| parse_error(GitOperation::Upstream))?;
        if record[separator + 1..].is_empty() {
            return parse_failure(GitOperation::Upstream);
        }
        let key = &record[..separator];
        if key == remote_key {
            if remote_seen {
                return parse_failure(GitOperation::Upstream);
            }
            remote_seen = true;
        } else if key == merge_key {
            if merge_seen {
                return parse_failure(GitOperation::Upstream);
            }
            merge_seen = true;
        } else {
            return parse_failure(GitOperation::Upstream);
        }
    }
    Ok(if remote_seen && merge_seen {
        UpstreamState::Missing
    } else {
        UpstreamState::NotConfigured
    })
}

fn branch_config_pattern(branch: &[u8]) -> Vec<u8> {
    let mut pattern = b"^branch\\.".to_vec();
    for byte in branch {
        if b"\\.^$|()[]*+?{}".contains(byte) {
            pattern.push(b'\\');
        }
        pattern.push(*byte);
    }
    pattern.extend_from_slice(b"\\.(remote|merge)$");
    pattern
}

fn parse_error(operation: GitOperation) -> GitError {
    GitError::ParseFailed { operation }
}

fn parse_failure<T>(operation: GitOperation) -> Result<T, GitError> {
    Err(parse_error(operation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_parser_keeps_checkout_local_states_independent() {
        let input = b"# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\x001 M. N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 staged.txt\x001 .M N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 tracked.txt\0? untracked.txt\0! ignored.txt\0";
        let facts = parse_status(input).unwrap();
        assert_eq!(facts.tracked, ChangeState::Changed);
        assert_eq!(facts.staged, ChangeState::Changed);
        assert_eq!(facts.untracked, ContentState::Present);
        assert_eq!(facts.ignored, ContentState::Present);
        assert_eq!(facts.change_count, 3);
        assert_eq!(
            facts.upstream,
            Some(UpstreamState::Diverged {
                ahead: 2,
                behind: 3
            })
        );
    }

    #[test]
    fn status_parser_rejects_truncated_or_contradictory_records() {
        for input in [
            b"? \0".as_slice(),
            b"# branch.upstream origin/main\0# branch.upstream origin/other\0".as_slice(),
            b"# branch.ab +1 -0\0".as_slice(),
            b"1 M. bad\0".as_slice(),
            b"2 R. N... 100644 100644 100644 0123456789012345678901234567890123456789 0123456789012345678901234567890123456789 R100 renamed\0"
                .as_slice(),
        ] {
            assert!(parse_status(input).is_err(), "accepted {input:?}");
        }
    }
}
