use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use termloop_platform::CommandTermination;

use crate::command::GitCommandScope;
use crate::error::command_failure;
use crate::repository::parse_single_line;
use crate::{BranchRemoteFacts, GitError, GitOperation, GitRefName, GitRunner, ObjectId};

pub const BRANCH_COMMIT_OBSERVATION_DEADLINE: Duration = Duration::from_millis(2_500);
const BRANCH_COMMIT_OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchCommitUnavailable {
    AmbiguousRemote,
    BaseRefUnavailable,
    BranchMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchCommitState {
    Available {
        base_ref: GitRefName,
        count: u64,
    },
    Unavailable {
        base_ref: Option<GitRefName>,
        reason: BranchCommitUnavailable,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchCommitSummaryObservation {
    pub repository_common_dir: PathBuf,
    pub branch_ref: GitRefName,
    pub state: BranchCommitState,
    pub not_in_base: BranchCommitState,
    pub git_process_count: usize,
}

/// Exact branch plus an optional caller-proven base. A recorded base OID is an
/// immutable managed-branch creation point and takes precedence over remote
/// resolution. A base ref without an OID is only a no-remote fallback;
/// configured-but-ambiguous or incomplete remote facts continue to fail closed.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct BranchCommitSummaryRequest {
    branch: Vec<u8>,
    base_ref: Option<Vec<u8>>,
    recorded_base_oid: Option<Vec<u8>>,
}

impl std::fmt::Debug for BranchCommitSummaryRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BranchCommitSummaryRequest")
            .field("branch_bytes", &self.branch.len())
            .field("has_base_ref", &self.base_ref.is_some())
            .field("has_recorded_base_oid", &self.recorded_base_oid.is_some())
            .finish()
    }
}

impl BranchCommitSummaryRequest {
    pub fn new(branch: Vec<u8>, no_remote_base_ref: Option<Vec<u8>>) -> Self {
        Self {
            branch,
            base_ref: no_remote_base_ref,
            recorded_base_oid: None,
        }
    }

    pub fn with_recorded_base(branch: Vec<u8>, base_ref: Vec<u8>, base_oid: Vec<u8>) -> Self {
        Self {
            branch,
            base_ref: Some(base_ref),
            recorded_base_oid: Some(base_oid),
        }
    }

    fn branch(&self) -> &[u8] {
        &self.branch
    }
}

#[derive(Debug)]
pub struct BranchCommitSummaryBatchObservation {
    pub observations: Vec<Result<BranchCommitSummaryObservation, GitError>>,
    pub git_process_count: usize,
}

impl GitRunner {
    pub fn observe_branch_commit_summary(
        &self,
        repository_path: &Path,
        branch: &[u8],
    ) -> Result<BranchCommitSummaryObservation, GitError> {
        self.observe_branch_commit_summary_with_local_base(repository_path, branch, None)
    }

    pub fn observe_branch_commit_summary_with_local_base(
        &self,
        repository_path: &Path,
        branch: &[u8],
        no_remote_base_ref: Option<&[u8]>,
    ) -> Result<BranchCommitSummaryObservation, GitError> {
        let mut batch = self.observe_branch_commit_summary_requests(
            repository_path,
            &[BranchCommitSummaryRequest::new(
                branch.to_vec(),
                no_remote_base_ref.map(<[u8]>::to_vec),
            )],
        )?;
        batch.observations.pop().ok_or(GitError::ParseFailed {
            operation: GitOperation::BranchCommitSummary,
        })?
    }

    pub fn observe_branch_commit_summary_with_recorded_base(
        &self,
        repository_path: &Path,
        branch: &[u8],
        base_ref: &[u8],
        base_oid: &[u8],
    ) -> Result<BranchCommitSummaryObservation, GitError> {
        let mut batch = self.observe_branch_commit_summary_requests(
            repository_path,
            &[BranchCommitSummaryRequest::with_recorded_base(
                branch.to_vec(),
                base_ref.to_vec(),
                base_oid.to_vec(),
            )],
        )?;
        batch.observations.pop().ok_or(GitError::ParseFailed {
            operation: GitOperation::BranchCommitSummary,
        })?
    }

    pub fn observe_branch_commit_summaries(
        &self,
        repository_path: &Path,
        branches: &[Vec<u8>],
    ) -> Result<BranchCommitSummaryBatchObservation, GitError> {
        let requests = branches
            .iter()
            .cloned()
            .map(|branch| BranchCommitSummaryRequest::new(branch, None))
            .collect::<Vec<_>>();
        self.observe_branch_commit_summary_requests(repository_path, &requests)
    }

    pub fn observe_branch_commit_summary_requests(
        &self,
        repository_path: &Path,
        requests: &[BranchCommitSummaryRequest],
    ) -> Result<BranchCommitSummaryBatchObservation, GitError> {
        if requests.is_empty() {
            return Ok(BranchCommitSummaryBatchObservation {
                observations: Vec::new(),
                git_process_count: 0,
            });
        }
        let runner = self.clone().with_shared_observation_budget(
            BRANCH_COMMIT_OBSERVATION_DEADLINE,
            BRANCH_COMMIT_OUTPUT_LIMIT,
        )?;
        let mut unique_requests = Vec::with_capacity(requests.len());
        for request in requests {
            if !unique_requests.contains(request) {
                unique_requests.push(request.clone());
            }
        }
        let mut unique_branches = Vec::with_capacity(unique_requests.len());
        for request in &unique_requests {
            let branch = &request.branch;
            if !unique_branches.contains(branch) {
                unique_branches.push(branch.clone());
            }
        }
        let mut scope = GitCommandScope::bounded(&runner, BRANCH_COMMIT_OBSERVATION_DEADLINE)?;
        let identity = runner.inspect_repository_identity_in_scope(repository_path, &mut scope)?;
        let common_dir = identity.common_dir().to_path_buf();
        let remote_facts = runner.observe_branch_remotes_batch_in_scope(
            repository_path,
            &unique_branches,
            &mut scope,
        )?;
        let mut remote_heads = HashMap::<Vec<u8>, Result<Option<GitRefName>, GitError>>::new();
        let mut base_exists = HashMap::<Vec<u8>, Result<bool, GitError>>::new();
        let mut observations = Vec::with_capacity(unique_requests.len());

        for request in &unique_requests {
            let branch_ref = local_branch_ref(request.branch())?;
            let Some(remotes) = remote_facts
                .iter()
                .find(|facts| facts.local_branch == branch_ref)
            else {
                observations.push(Ok(unavailable_observation(
                    &common_dir,
                    branch_ref,
                    None,
                    BranchCommitUnavailable::BranchMissing,
                )));
                continue;
            };
            let not_in_base = if remotes.remotes.is_empty() {
                if request.recorded_base_oid.is_some() {
                    match request.base_ref.clone() {
                        Some(base_ref) => observe_count_against_base(
                            repository_path,
                            &common_dir,
                            branch_ref.clone(),
                            GitRefName::from_bytes(base_ref)?,
                            &mut base_exists,
                            &mut scope,
                        ),
                        None => Err(GitError::ParseFailed {
                            operation: GitOperation::BranchCommitSummary,
                        }),
                    }
                } else {
                    Ok(unavailable_observation(
                        &common_dir,
                        branch_ref.clone(),
                        None,
                        BranchCommitUnavailable::BaseRefUnavailable,
                    ))
                }
            } else {
                match select_remote(remotes) {
                    Err(reason) => Ok(unavailable_observation(
                        &common_dir,
                        branch_ref.clone(),
                        None,
                        reason,
                    )),
                    Ok(remote) => {
                        let remote = remote.to_vec();
                        let base_ref = if let Some(cached) = remote_heads.get(&remote) {
                            cached.clone()
                        } else {
                            let resolved =
                                resolve_remote_head(repository_path, &remote, &mut scope);
                            remote_heads.insert(remote.clone(), resolved.clone());
                            resolved
                        };
                        match base_ref {
                            Ok(Some(base_ref)) => observe_count_against_base(
                                repository_path,
                                &common_dir,
                                branch_ref.clone(),
                                base_ref,
                                &mut base_exists,
                                &mut scope,
                            ),
                            Ok(None) => Ok(unavailable_observation(
                                &common_dir,
                                branch_ref.clone(),
                                None,
                                BranchCommitUnavailable::BaseRefUnavailable,
                            )),
                            Err(error) => Err(error),
                        }
                    }
                }
            };
            let not_in_base = match not_in_base {
                Ok(observation) => observation,
                Err(error) => {
                    observations.push(Err(error));
                    continue;
                }
            };

            if let Some(base_oid) = request.recorded_base_oid.clone() {
                let Some(base_ref) = request.base_ref.clone() else {
                    observations.push(Err(GitError::ParseFailed {
                        operation: GitOperation::BranchCommitSummary,
                    }));
                    continue;
                };
                let base_ref = GitRefName::from_bytes(base_ref)?;
                let base_oid = ObjectId::from_hex(base_oid)?;
                observations.push(
                    observe_count_against_oid(
                        repository_path,
                        &common_dir,
                        branch_ref,
                        base_ref,
                        &base_oid,
                        &mut scope,
                    )
                    .map(|mut observation| {
                        observation.not_in_base = not_in_base.state;
                        observation
                    }),
                );
            } else if remotes.remotes.is_empty() {
                let Some(base_ref) = request.base_ref.clone() else {
                    observations.push(Ok(not_in_base));
                    continue;
                };
                let base_ref = GitRefName::from_bytes(base_ref)?;
                observations.push(
                    observe_count_against_base(
                        repository_path,
                        &common_dir,
                        branch_ref,
                        base_ref,
                        &mut base_exists,
                        &mut scope,
                    )
                    .map(|mut observation| {
                        observation.not_in_base = not_in_base.state;
                        observation
                    }),
                );
            } else {
                let mut observation = not_in_base;
                observation.not_in_base = observation.state.clone();
                observations.push(Ok(observation));
            }
        }
        let git_process_count = scope.command_count();
        for observation in observations
            .iter_mut()
            .filter_map(|result| result.as_mut().ok())
        {
            observation.git_process_count = git_process_count;
        }
        let by_request = unique_requests
            .into_iter()
            .zip(observations)
            .collect::<HashMap<_, _>>();
        Ok(BranchCommitSummaryBatchObservation {
            observations: requests
                .iter()
                .map(|request| {
                    by_request
                        .get(request)
                        .cloned()
                        .unwrap_or(Err(GitError::ParseFailed {
                            operation: GitOperation::BranchCommitSummary,
                        }))
                })
                .collect(),
            git_process_count,
        })
    }
}

fn observe_count_against_oid(
    repository_path: &Path,
    common_dir: &Path,
    branch_ref: GitRefName,
    base_ref: GitRefName,
    base_oid: &ObjectId,
    scope: &mut GitCommandScope<'_>,
) -> Result<BranchCommitSummaryObservation, GitError> {
    scope
        .checked(
            GitOperation::BranchCommitSummary,
            repository_path,
            [
                OsString::from("rev-list"),
                OsString::from("--count"),
                exact_ref_argument(&branch_ref)?,
                OsString::from("--not"),
                termloop_platform::os_string_from_process_bytes(base_oid.as_bytes().to_vec())
                    .map_err(|_| GitError::ParseFailed {
                        operation: GitOperation::BranchCommitSummary,
                    })?,
                OsString::from("--"),
            ],
        )
        .and_then(|output| parse_count(&output.stdout))
        .map(|count| BranchCommitSummaryObservation {
            repository_common_dir: common_dir.to_path_buf(),
            branch_ref,
            state: BranchCommitState::Available { base_ref, count },
            not_in_base: BranchCommitState::Unavailable {
                base_ref: None,
                reason: BranchCommitUnavailable::BaseRefUnavailable,
            },
            git_process_count: 0,
        })
}

fn observe_count_against_base(
    repository_path: &Path,
    common_dir: &Path,
    branch_ref: GitRefName,
    base_ref: GitRefName,
    base_exists: &mut HashMap<Vec<u8>, Result<bool, GitError>>,
    scope: &mut GitCommandScope<'_>,
) -> Result<BranchCommitSummaryObservation, GitError> {
    let exists = if let Some(exists) = base_exists.get(base_ref.as_bytes()) {
        exists.clone()
    } else {
        let exists = exact_ref_exists(repository_path, &base_ref, scope);
        base_exists.insert(base_ref.as_bytes().to_vec(), exists.clone());
        exists
    }?;
    if !exists {
        return Ok(unavailable_observation(
            common_dir,
            branch_ref,
            Some(base_ref),
            BranchCommitUnavailable::BaseRefUnavailable,
        ));
    }
    scope
        .checked(
            GitOperation::BranchCommitSummary,
            repository_path,
            [
                OsString::from("rev-list"),
                OsString::from("--count"),
                exact_ref_argument(&branch_ref)?,
                OsString::from("--not"),
                exact_ref_argument(&base_ref)?,
                OsString::from("--"),
            ],
        )
        .and_then(|output| parse_count(&output.stdout))
        .map(|count| BranchCommitSummaryObservation {
            repository_common_dir: common_dir.to_path_buf(),
            branch_ref,
            state: BranchCommitState::Available { base_ref, count },
            not_in_base: BranchCommitState::Unavailable {
                base_ref: None,
                reason: BranchCommitUnavailable::BaseRefUnavailable,
            },
            git_process_count: 0,
        })
}

fn unavailable_observation(
    common_dir: &Path,
    branch_ref: GitRefName,
    base_ref: Option<GitRefName>,
    reason: BranchCommitUnavailable,
) -> BranchCommitSummaryObservation {
    BranchCommitSummaryObservation {
        repository_common_dir: common_dir.to_path_buf(),
        branch_ref,
        state: BranchCommitState::Unavailable { base_ref, reason },
        not_in_base: BranchCommitState::Unavailable {
            base_ref: None,
            reason,
        },
        git_process_count: 0,
    }
}

fn parse_count(bytes: &[u8]) -> Result<u64, GitError> {
    std::str::from_utf8(parse_single_line(bytes, GitOperation::BranchCommitSummary)?)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(GitError::ParseFailed {
            operation: GitOperation::BranchCommitSummary,
        })
}

fn local_branch_ref(branch: &[u8]) -> Result<GitRefName, GitError> {
    let mut full_ref = b"refs/heads/".to_vec();
    full_ref.extend_from_slice(branch);
    GitRefName::from_bytes(full_ref)
}

fn select_remote(facts: &BranchRemoteFacts) -> Result<&[u8], BranchCommitUnavailable> {
    let candidate = facts
        .upstream
        .as_ref()
        .map(|fact| fact.remote.as_slice())
        .or_else(|| facts.push.as_ref().map(|fact| fact.remote.as_slice()))
        .or(facts.push_default.as_deref())
        .or_else(|| (facts.remotes.len() == 1).then(|| facts.remotes[0].name.as_slice()));
    let Some(remote) = candidate else {
        return Err(if facts.remotes.len() > 1 {
            BranchCommitUnavailable::AmbiguousRemote
        } else {
            BranchCommitUnavailable::BaseRefUnavailable
        });
    };
    if remote == b"." || !facts.remotes.iter().any(|fact| fact.name == remote) {
        return Err(BranchCommitUnavailable::BaseRefUnavailable);
    }
    Ok(remote)
}

fn resolve_remote_head(
    repository_path: &Path,
    remote: &[u8],
    scope: &mut GitCommandScope<'_>,
) -> Result<Option<GitRefName>, GitError> {
    let mut symbolic = b"refs/remotes/".to_vec();
    symbolic.extend_from_slice(remote);
    symbolic.extend_from_slice(b"/HEAD");
    let symbolic = GitRefName::from_bytes(symbolic)?;
    let outcome = scope.execute(
        GitOperation::BranchCommitSummary,
        repository_path,
        [
            OsString::from("symbolic-ref"),
            OsString::from("--quiet"),
            exact_ref_argument(&symbolic)?,
        ],
    )?;
    match outcome.termination {
        CommandTermination::Exited { code: 0 } => {
            let resolved = GitRefName::from_bytes(
                parse_single_line(&outcome.stdout, GitOperation::BranchCommitSummary)?.to_vec(),
            )?;
            let mut expected_prefix = b"refs/remotes/".to_vec();
            expected_prefix.extend_from_slice(remote);
            expected_prefix.push(b'/');
            if !resolved.as_bytes().starts_with(&expected_prefix)
                || resolved.as_bytes() == symbolic.as_bytes()
            {
                return Ok(None);
            }
            Ok(Some(resolved))
        }
        CommandTermination::Exited { code: 1 } => Ok(None),
        termination => Err(command_failure(
            GitOperation::BranchCommitSummary,
            termination,
            &outcome.stderr,
        )),
    }
}

fn exact_ref_exists(
    repository_path: &Path,
    reference: &GitRefName,
    scope: &mut GitCommandScope<'_>,
) -> Result<bool, GitError> {
    let outcome = scope.execute(
        GitOperation::BranchCommitSummary,
        repository_path,
        [
            OsString::from("show-ref"),
            OsString::from("--verify"),
            OsString::from("--quiet"),
            exact_ref_argument(reference)?,
        ],
    )?;
    match outcome.termination {
        CommandTermination::Exited { code: 0 } => Ok(true),
        CommandTermination::Exited { code: 1 } => Ok(false),
        termination => Err(command_failure(
            GitOperation::BranchCommitSummary,
            termination,
            &outcome.stderr,
        )),
    }
}

fn exact_ref_argument(reference: &GitRefName) -> Result<OsString, GitError> {
    termloop_platform::os_string_from_process_bytes(reference.as_bytes().to_vec()).map_err(|_| {
        GitError::ParseFailed {
            operation: GitOperation::BranchCommitSummary,
        }
    })
}
