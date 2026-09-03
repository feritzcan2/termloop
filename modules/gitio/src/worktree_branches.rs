use std::path::Path;
use std::time::Duration;

use termloop_platform::CommandTermination;

use crate::command::{GitCommandScope, strip_git_line_cr};
use crate::{
    GitError, GitOperation, GitRefName, GitRunner, ObjectId, RegisteredPathState, WorktreeCheckout,
};

pub const WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT: usize = 256;
const BRANCH_CREATION_REFLOG_ENTRY_LIMIT: usize = 1024;
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
    pub observations: Vec<WorktreeBranchObservation>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeBranchObservationSource {
    CurrentBranch,
    HeadReflog,
    BranchCreationReflog,
}

/// One immutable point proving that an exact local branch was used by the
/// inspected worktree. The OID is the branch tip at creation, checkout, or the
/// first current-branch observation; it is not a claim that the branch still
/// points there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeBranchObservation {
    pub reference: GitRefName,
    pub first_observed_oid: ObjectId,
    pub parent_reference: Option<GitRefName>,
    pub source: WorktreeBranchObservationSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeadReflogEntry {
    oid: ObjectId,
    subject: Vec<u8>,
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

        let (current, current_oid) = match registration.checkout {
            WorktreeCheckout::Branch { reference, oid } => (Some(reference), oid),
            WorktreeCheckout::Detached { .. } | WorktreeCheckout::Bare => (None, None),
        };
        let mut evidence = WorktreeBranchEvidence {
            current_branch: current.clone(),
            branches: current.into_iter().collect(),
            observations: Vec::new(),
            truncated: false,
        };
        if let (Some(reference), Some(oid)) = (evidence.current_branch.clone(), current_oid) {
            evidence.observations.push(WorktreeBranchObservation {
                reference,
                first_observed_oid: oid,
                parent_reference: None,
                source: WorktreeBranchObservationSource::CurrentBranch,
            });
        }

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
                "--format=%H%x00%gs%x00",
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

        let (head_entries, truncated) = match parse_head_reflog(&outcome.stdout) {
            Ok(parsed) => parsed,
            Err(_) => {
                evidence.truncated = true;
                return Ok(evidence);
            }
        };
        evidence.truncated = truncated;
        apply_head_reflog(&mut evidence, &head_entries)?;

        let creation_outcome = scope.execute(
            GitOperation::ReadReflog,
            worktree_root,
            [
                "log",
                "-g",
                "--all",
                "--format=%gD%x00%H%x00%gs%x00",
                "--max-count=1025",
            ],
        );
        match creation_outcome {
            Ok(outcome)
                if matches!(outcome.termination, CommandTermination::Exited { code: 0 }) =>
            {
                let (creations, truncated) = parse_branch_creation_reflogs(&outcome.stdout)?;
                evidence.truncated |= truncated;
                apply_branch_creations(&mut evidence, creations);
            }
            _ => evidence.truncated = true,
        }
        Ok(evidence)
    }
}

fn parse_head_reflog(bytes: &[u8]) -> Result<(Vec<HeadReflogEntry>, bool), GitError> {
    if bytes.is_empty() {
        return Ok((Vec::new(), false));
    }
    if !bytes.ends_with(b"\n") {
        return parse_failure();
    }
    let mut entries = 0usize;
    let mut parsed = Vec::new();
    for line in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        let line = strip_git_line_cr(line);
        let fields = nul_fields(line, 2)?;
        entries += 1;
        if entries > WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT {
            continue;
        }
        parsed.push(HeadReflogEntry {
            oid: ObjectId::from_hex(fields[0].to_vec())?,
            subject: fields[1].to_vec(),
        });
    }
    Ok((parsed, entries > WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT))
}

fn apply_head_reflog(
    evidence: &mut WorktreeBranchEvidence,
    entries: &[HeadReflogEntry],
) -> Result<(), GitError> {
    for (index, entry) in entries.iter().enumerate() {
        let Some(transition) = entry.subject.strip_prefix(CHECKOUT_PREFIX) else {
            continue;
        };
        let Some(separator) = find_bytes(transition, CHECKOUT_SEPARATOR) else {
            return parse_failure();
        };
        let from = &transition[..separator];
        let to = &transition[separator + CHECKOUT_SEPARATOR.len()..];
        for candidate in [to, from] {
            if let Some(reference) = local_branch_reference(candidate)
                && !evidence.branches.contains(&reference)
            {
                evidence.branches.push(reference);
            }
        }
        let older = entries.get(index + 1);
        if let (Some(reference), Some(older)) = (local_branch_reference(from), older) {
            upsert_observation(
                &mut evidence.observations,
                WorktreeBranchObservation {
                    reference,
                    first_observed_oid: older.oid.clone(),
                    parent_reference: None,
                    source: WorktreeBranchObservationSource::HeadReflog,
                },
            );
        }
        let Some(reference) = local_branch_reference(to) else {
            continue;
        };
        let parent_reference = older
            .filter(|older| older.oid == entry.oid)
            .and_then(|_| local_branch_reference(from));
        upsert_observation(
            &mut evidence.observations,
            WorktreeBranchObservation {
                reference,
                first_observed_oid: entry.oid.clone(),
                parent_reference,
                source: WorktreeBranchObservationSource::HeadReflog,
            },
        );
    }
    Ok(())
}

fn parse_branch_creation_reflogs(
    bytes: &[u8],
) -> Result<(Vec<WorktreeBranchObservation>, bool), GitError> {
    if bytes.is_empty() {
        return Ok((Vec::new(), false));
    }
    if !bytes.ends_with(b"\n") {
        return parse_failure();
    }
    let mut entries = 0usize;
    let mut observations = Vec::new();
    for line in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        let fields = nul_fields(strip_git_line_cr(line), 3)?;
        entries += 1;
        if entries > BRANCH_CREATION_REFLOG_ENTRY_LIMIT {
            continue;
        }
        let Some(reference) = reflog_selector_reference(fields[0]) else {
            continue;
        };
        let Some(created_from) = fields[2].strip_prefix(b"branch: Created from ") else {
            continue;
        };
        let parent_reference = if created_from == b"HEAD" {
            None
        } else if created_from.starts_with(b"refs/") {
            GitRefName::from_bytes(created_from.to_vec()).ok()
        } else {
            local_branch_reference(created_from)
        };
        upsert_observation(
            &mut observations,
            WorktreeBranchObservation {
                reference,
                first_observed_oid: ObjectId::from_hex(fields[1].to_vec())?,
                parent_reference,
                source: WorktreeBranchObservationSource::BranchCreationReflog,
            },
        );
    }
    Ok((observations, entries > BRANCH_CREATION_REFLOG_ENTRY_LIMIT))
}

fn apply_branch_creations(
    evidence: &mut WorktreeBranchEvidence,
    creations: Vec<WorktreeBranchObservation>,
) {
    for mut creation in creations {
        if !evidence.branches.contains(&creation.reference) {
            continue;
        }
        if creation.parent_reference.is_none()
            && let Some(checkout) = evidence.observations.iter().find(|observation| {
                observation.reference == creation.reference
                    && observation.first_observed_oid == creation.first_observed_oid
            })
        {
            creation.parent_reference = checkout.parent_reference.clone();
        }
        upsert_observation(&mut evidence.observations, creation);
    }
}

fn upsert_observation(
    observations: &mut Vec<WorktreeBranchObservation>,
    observation: WorktreeBranchObservation,
) {
    if let Some(existing) = observations
        .iter_mut()
        .find(|existing| existing.reference == observation.reference)
    {
        *existing = observation;
    } else {
        observations.push(observation);
    }
}

fn reflog_selector_reference(selector: &[u8]) -> Option<GitRefName> {
    let marker = selector.windows(2).rposition(|window| window == b"@{")?;
    let reference = &selector[..marker];
    reference
        .starts_with(b"refs/heads/")
        .then(|| GitRefName::from_bytes(reference.to_vec()).ok())
        .flatten()
}

fn nul_fields(line: &[u8], count: usize) -> Result<Vec<&[u8]>, GitError> {
    let fields = line.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.len() != count + 1 || fields[count] != b"" {
        return parse_failure();
    }
    Ok(fields[..count].to_vec())
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

    fn oid(value: u8) -> Vec<u8> {
        vec![b'0' + value; 40]
    }

    fn head_record(oid: &[u8], subject: &[u8]) -> Vec<u8> {
        [oid, b"\0", subject, b"\0\n"].concat()
    }

    #[test]
    fn parses_checkout_branches_with_the_earliest_surviving_base() {
        let detached_oid = b"1234567890123456789012345678901234567890";
        let first = oid(1);
        let second = oid(2);
        let mut bytes = head_record(&second, b"commit: ignored");
        bytes.extend(head_record(
            &first,
            b"checkout: moving from feature/one to UKIE-804",
        ));
        let mut detached = b"checkout: moving from ".to_vec();
        detached.extend_from_slice(detached_oid);
        detached.extend_from_slice(b" to feature/one");
        bytes.extend(head_record(&first, &detached));
        let (entries, truncated) = parse_head_reflog(&bytes).unwrap();
        assert!(!truncated);
        let mut evidence = WorktreeBranchEvidence {
            current_branch: None,
            branches: vec![],
            observations: vec![],
            truncated: false,
        };
        apply_head_reflog(&mut evidence, &entries).unwrap();
        assert_eq!(
            evidence
                .branches
                .iter()
                .map(|branch| branch.as_bytes())
                .collect::<Vec<_>>(),
            vec![
                b"refs/heads/UKIE-804".as_slice(),
                b"refs/heads/feature/one".as_slice(),
            ]
        );
        assert_eq!(evidence.observations.len(), 2);
        assert_eq!(
            evidence.observations[0].first_observed_oid.as_bytes(),
            first
        );
    }

    #[test]
    fn malformed_checkout_transition_fails_closed() {
        let bytes = head_record(&oid(1), b"checkout: moving from feature");
        let (entries, _) = parse_head_reflog(&bytes).unwrap();
        let mut evidence = WorktreeBranchEvidence {
            current_branch: None,
            branches: vec![],
            observations: vec![],
            truncated: false,
        };
        assert!(apply_head_reflog(&mut evidence, &entries).is_err());
    }

    #[test]
    fn checkout_from_branch_keeps_the_pre_checkout_oid() {
        let before = oid(1);
        let after = oid(2);
        let mut bytes = head_record(&after, b"checkout: moving from feature/old to feature/new");
        bytes.extend(head_record(&before, b"commit: old branch tip"));
        let (entries, _) = parse_head_reflog(&bytes).unwrap();
        let mut evidence = WorktreeBranchEvidence {
            current_branch: None,
            branches: vec![],
            observations: vec![],
            truncated: false,
        };

        apply_head_reflog(&mut evidence, &entries).unwrap();

        let old = evidence
            .observations
            .iter()
            .find(|observation| observation.reference.as_bytes() == b"refs/heads/feature/old")
            .unwrap();
        assert_eq!(old.first_observed_oid.as_bytes(), before);
    }

    #[test]
    fn reflog_entry_limit_is_explicitly_truncated() {
        let mut bytes = Vec::new();
        for _ in 0..=WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT {
            bytes.extend(head_record(&oid(1), b"commit: fixture"));
        }
        let (entries, truncated) = parse_head_reflog(&bytes).unwrap();
        assert_eq!(entries.len(), WORKTREE_BRANCH_REFLOG_ENTRY_LIMIT);
        assert!(truncated);
    }

    #[test]
    fn branch_creation_reflog_proves_creation_oid_and_named_parent() {
        let bytes = [
            b"refs/heads/feature/api@{0}\0".as_slice(),
            oid(3).as_slice(),
            b"\0branch: Created from refs/heads/develop\0\n",
        ]
        .concat();
        let (observations, truncated) = parse_branch_creation_reflogs(&bytes).unwrap();
        assert!(!truncated);
        assert_eq!(observations.len(), 1);
        assert_eq!(
            observations[0]
                .parent_reference
                .as_ref()
                .unwrap()
                .as_bytes(),
            b"refs/heads/develop"
        );
        assert_eq!(
            observations[0].source,
            WorktreeBranchObservationSource::BranchCreationReflog
        );
    }
}
