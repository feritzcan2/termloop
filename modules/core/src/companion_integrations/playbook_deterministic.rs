//! Deterministic Playbook step checks.
//!
//! A step whose completion is purely the Task branch's own pull request state
//! (open, checks passing, merged) is answered by TermLoop itself before the
//! step's Routine is asked. The read is fresh: it never consults the
//! display-only Git-host Task projection or the provider row cache, because a
//! cached display affordance must never satisfy a delivery gate.
//!
//! The read follows the usual plan/observe/apply boundary. Core plans under its
//! lock, the Git and provider CLI work runs without it, and the outcome is
//! revalidated against the current claim before anything is recorded. A
//! decided answer is recorded through the same verdict path Routine reports
//! use; anything the read cannot decide falls back to the Routine.

use super::tracker_runtime::TrackerCheckCapability;
use super::{
    GitHostProjectionReason, LocalObservation, ProviderQuery, TaskSnapshot, map_git_error,
    normalize_candidate_sets, snapshot, worktree_branches,
};
use crate::companion_integrations::playbook_runtime::StewardStepVerdict;
use crate::{CoreError, CoreRuntime};
use serde_json::Value;
use std::time::Duration;
use termloop_domain::{
    PLAYBOOK_EVIDENCE_MAX_BYTES, PlaybookDeterministicCheck, PlaybookDeterministicCheckKind,
    PlaybookDeterministicFallback as Fallback, PlaybookGateKind, PlaybookStepEvaluator,
    PlaybookStepVerdict, RoutineActionHandling,
};
use termloop_gitio::GitRunner;
use termloop_providers::{
    AzureDevOpsClient, CheckState, GitHostProvider, GitHubClient, ProviderFailure,
    PullRequestState, PullRequestSummary,
};

/// One read covers local Git facts and every provider query it needs.
const READ_DEADLINE: Duration = Duration::from_secs(10);

/// A claimed step check TermLoop will try to answer itself.
#[derive(Clone)]
pub struct DeterministicStepPlan {
    capability: TrackerCheckCapability,
    milestone_id: String,
    check: PlaybookDeterministicCheck,
    snapshot: TaskSnapshot,
    github: Option<GitHubClient>,
    azure: Option<AzureDevOpsClient>,
}

/// What the fresh read observed, waiting to be revalidated and applied.
pub struct DeterministicStepObservation {
    capability: TrackerCheckCapability,
    milestone_id: String,
    check: PlaybookDeterministicCheck,
    snapshot: TaskSnapshot,
    read: PullRequestRead,
}

/// The pull requests one fresh read found for the Task branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PullRequestRead {
    /// The read could not establish the Task branch's pull requests.
    Unavailable(Fallback),
    Read {
        /// A secret-free repository label for evidence, such as
        /// `github.com/owner/repo`.
        repository: String,
        branch: String,
        pull_requests: Vec<PullRequestSummary>,
        /// The provider reported more, or incomplete, results than it returned.
        truncated: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeterministicDecision {
    Passed(String),
    Waiting(String),
    Fallback(Fallback),
}

/// What happens to a claim after its deterministic read was applied.
#[derive(Debug)]
pub enum DeterministicStepOutcome {
    /// The verdict was recorded; the claim is finished.
    Recorded { project_id: String, result: Value },
    /// Route the claim to its Routine evaluator exactly as without a
    /// deterministic check. Any fallback reason is already on the claim.
    Routine,
}

impl CoreRuntime {
    /// The deterministic read for this fresh step claim, or `None` when its
    /// step has no deterministic check or the claim already has an evaluator.
    pub fn plan_deterministic_step_check(
        &self,
        capability: &TrackerCheckCapability,
    ) -> Option<DeterministicStepPlan> {
        if self
            .playbook_evaluation
            .evaluations
            .contains_key(&capability.check_id)
        {
            return None;
        }
        let milestone = self.claimed_step_milestone(capability)?;
        // Domain validation already keeps a check off human gates; a named
        // person's approval is never inferred from a pull request.
        if milestone.gate != PlaybookGateKind::Automatic {
            return None;
        }
        let check = milestone.deterministic_check.clone()?;
        let milestone_id = milestone.id.clone();
        let task_id = self.claimed_step_task_id(capability)?;
        let task = self.store.tasks().iter().find(|task| task.id == task_id)?;
        Some(DeterministicStepPlan {
            capability: capability.clone(),
            milestone_id,
            check,
            snapshot: snapshot(task),
            github: self.github_client.clone(),
            azure: self.azure_devops_client.clone(),
        })
    }

    /// Revalidates a fresh read against the current claim and records its
    /// answer through the Routine verdict path, or hands the claim back to
    /// the Routine.
    pub fn apply_deterministic_step_check(
        &mut self,
        observation: DeterministicStepObservation,
        now_epoch_ms: u64,
    ) -> Result<DeterministicStepOutcome, CoreError> {
        let capability = observation.capability;
        let configuration = self.validate_current_check(&capability, now_epoch_ms)?;
        let current_step = self.claimed_step_milestone(&capability).cloned();
        let task_id = self.claimed_step_task_id(&capability);
        let still_asked = current_step.as_ref().is_some_and(|milestone| {
            milestone.id == observation.milestone_id
                && milestone.deterministic_check.as_ref() == Some(&observation.check)
        });
        let same_binding = task_id.as_deref() == Some(observation.snapshot.task_id.as_str())
            && self.store.tasks().iter().any(|task| {
                let current = snapshot(task);
                current.task_id == observation.snapshot.task_id
                    && current.branch_name == observation.snapshot.branch_name
                    && current.repository_root == observation.snapshot.repository_root
            });
        // The board or the Task's branch moved while the read ran. The read
        // proves nothing about the current question; the Routine asks it.
        if !still_asked || !same_binding {
            return Ok(DeterministicStepOutcome::Routine);
        }
        let task_id = observation.snapshot.task_id;
        let (verdict, evidence) = match decide(&observation.check, &observation.read) {
            DeterministicDecision::Fallback(reason) => {
                self.mark_step_evaluation(
                    &capability,
                    PlaybookStepEvaluator::Routine,
                    Some(reason),
                );
                return Ok(DeterministicStepOutcome::Routine);
            }
            // Waiting actions belong to the Routine's run; let it observe
            // and propose them exactly as it does without this check.
            DeterministicDecision::Waiting(_)
                if configuration.action_handling != RoutineActionHandling::Off =>
            {
                return Ok(DeterministicStepOutcome::Routine);
            }
            DeterministicDecision::Waiting(evidence) => (PlaybookStepVerdict::Waiting, evidence),
            DeterministicDecision::Passed(evidence) => (PlaybookStepVerdict::Passed, evidence),
        };
        self.mark_step_evaluation(&capability, PlaybookStepEvaluator::Deterministic, None);
        let recorded = self.apply_playbook_step_verdicts(
            &capability,
            vec![StewardStepVerdict {
                task_id,
                verdict,
                evidence,
            }],
            termloop_platform::generate_opaque_id(),
            now_epoch_ms,
        );
        match recorded {
            Ok(result) => Ok(DeterministicStepOutcome::Recorded {
                project_id: capability.project_id,
                result,
            }),
            Err(error) => {
                // A claim that survives must not carry a deterministic mark
                // into a later Routine answer.
                self.mark_step_evaluation(&capability, PlaybookStepEvaluator::Routine, None);
                Err(error)
            }
        }
    }
}

impl DeterministicStepPlan {
    /// The bounded read the claim would make if it ran now.
    pub fn timeout(&self) -> Duration {
        READ_DEADLINE
    }

    /// Runs the fresh Git and provider read. Blocking; call without the core
    /// lock.
    pub fn observe(self) -> DeterministicStepObservation {
        let read = read_task_branch_pull_requests(
            &self.snapshot,
            &self.github,
            &self.azure,
            self.check.kind == PlaybookDeterministicCheckKind::PullRequestChecksPassing,
        );
        self.observed(read)
    }

    /// The observation for a read that could not complete in time.
    pub fn timed_out(self) -> DeterministicStepObservation {
        self.observed(PullRequestRead::Unavailable(Fallback::Timeout))
    }

    /// The observation for a read whose worker failed before answering.
    pub fn failed(self) -> DeterministicStepObservation {
        self.observed(PullRequestRead::Unavailable(Fallback::ProviderFailure))
    }

    fn observed(self, read: PullRequestRead) -> DeterministicStepObservation {
        DeterministicStepObservation {
            capability: self.capability,
            milestone_id: self.milestone_id,
            check: self.check,
            snapshot: self.snapshot,
            read,
        }
    }
}

fn read_task_branch_pull_requests(
    task: &TaskSnapshot,
    github: &Option<GitHubClient>,
    azure: &Option<AzureDevOpsClient>,
    include_checks: bool,
) -> PullRequestRead {
    let (Some(branch), Some(repository_root)) = (&task.branch_name, &task.repository_root) else {
        return PullRequestRead::Unavailable(Fallback::NoTaskBranch);
    };
    let Ok(deadline) = termloop_platform::MonotonicDeadline::after(READ_DEADLINE) else {
        return PullRequestRead::Unavailable(Fallback::Timeout);
    };
    let remaining = || deadline.remaining().ok_or(Fallback::Timeout);
    let local = remaining()
        .and_then(|remaining| {
            GitRunner::discover_with_timeout(remaining.min(Duration::from_millis(2_500)))
                .map_err(|error| local_fallback(map_git_error(&error)))
        })
        .and_then(|runner| {
            // Only the durable Task branch counts. Other branches seen in the
            // worktree are display aliases, not the branch this gate is about.
            let remaining = remaining()?;
            runner
                .observe_branch_remotes_including_missing_with_timeout(
                    repository_root,
                    &[branch.as_bytes().to_vec()],
                    remaining,
                )
                .map_err(|error| local_fallback(map_git_error(&error)))
        })
        .map(|branches| {
            normalize_candidate_sets(
                task,
                &worktree_branches::ObservedBranchFacts {
                    branches,
                    candidate_truncated: false,
                },
            )
        });
    let local: LocalObservation = match local {
        Ok(local) => local,
        Err(reason) => return PullRequestRead::Unavailable(reason),
    };
    if let Some(reason) = local.local_reason.filter(|_| local.candidates.is_empty()) {
        return PullRequestRead::Unavailable(local_fallback(reason));
    }
    // Remotes the read could not fully resolve might hold another pull
    // request, so "exactly one" could not be proven.
    if local.candidates.is_empty() || local.candidate_truncated {
        return PullRequestRead::Unavailable(Fallback::UnsupportedRepository);
    }
    let repository = repository_label(&local.candidates[0]);
    let mut pull_requests = Vec::new();
    let mut truncated = false;
    let github_queries = local
        .candidates
        .iter()
        .filter_map(|candidate| match candidate {
            ProviderQuery::Github(query) => Some(query.clone()),
            ProviderQuery::Azure(_) => None,
        })
        .collect::<Vec<_>>();
    if !github_queries.is_empty() {
        let Some(client) = github else {
            return PullRequestRead::Unavailable(Fallback::ProviderUnavailable);
        };
        let results = match remaining().and_then(|remaining| {
            client
                .query_with_timeout(&github_queries, remaining)
                .map_err(provider_fallback)
        }) {
            Ok(results) => results,
            Err(reason) => return PullRequestRead::Unavailable(reason),
        };
        for result in results {
            if let Some(failure) = result.failure {
                return PullRequestRead::Unavailable(provider_fallback(failure));
            }
            truncated |= result.truncated || !result.parent_resolved;
            pull_requests.extend(result.matches);
        }
    }
    for candidate in &local.candidates {
        let ProviderQuery::Azure(query) = candidate else {
            continue;
        };
        let Some(client) = azure else {
            return PullRequestRead::Unavailable(Fallback::ProviderUnavailable);
        };
        let scan = match remaining().and_then(|remaining| {
            client
                .query_pull_requests_with_timeout(query, None, include_checks, remaining)
                .map_err(provider_fallback)
        }) {
            Ok(scan) => scan,
            Err(reason) => return PullRequestRead::Unavailable(reason),
        };
        truncated |= scan.truncated || scan.incomplete || !scan.parent_resolved;
        pull_requests.extend(scan.pull_requests);
    }
    pull_requests.sort_by_cached_key(identity);
    pull_requests.dedup_by(|left, right| identity(left) == identity(right));
    PullRequestRead::Read {
        repository,
        branch: branch.clone(),
        pull_requests,
        truncated,
    }
}

fn identity(summary: &PullRequestSummary) -> (String, String, String, Option<String>, String, u64) {
    (
        match summary.provider {
            GitHostProvider::Github => "github".into(),
            GitHostProvider::AzureDevOps => "azureDevOps".into(),
        },
        summary.host.to_ascii_lowercase(),
        summary.repository_owner.to_ascii_lowercase(),
        summary
            .repository_project
            .as_ref()
            .map(|project| project.to_ascii_lowercase()),
        summary.repository_name.to_ascii_lowercase(),
        summary.number,
    )
}

fn local_fallback(reason: GitHostProjectionReason) -> Fallback {
    match reason {
        GitHostProjectionReason::NoBranch => Fallback::NoTaskBranch,
        GitHostProjectionReason::Timeout => Fallback::Timeout,
        _ => Fallback::UnsupportedRepository,
    }
}

fn provider_fallback(failure: ProviderFailure) -> Fallback {
    match failure {
        ProviderFailure::ProviderUnavailable => Fallback::ProviderUnavailable,
        ProviderFailure::Unauthorized => Fallback::Unauthorized,
        ProviderFailure::Offline => Fallback::Offline,
        ProviderFailure::RateLimited => Fallback::RateLimited,
        ProviderFailure::Timeout => Fallback::Timeout,
        ProviderFailure::OutputLimit
        | ProviderFailure::MalformedResponse
        | ProviderFailure::ProviderFailure => Fallback::ProviderFailure,
    }
}

fn repository_label(candidate: &ProviderQuery) -> String {
    match candidate {
        ProviderQuery::Github(query) => format!(
            "github.com/{}/{}",
            query.repository.owner, query.repository.name
        ),
        ProviderQuery::Azure(query) => format!(
            "dev.azure.com/{}/{}/{}",
            query.repository.organization, query.repository.project, query.repository.name
        ),
    }
}

fn summary_repository(summary: &PullRequestSummary) -> String {
    match &summary.repository_project {
        Some(project) => format!(
            "{}/{}/{}/{}",
            summary.host, summary.repository_owner, project, summary.repository_name
        ),
        None => format!(
            "{}/{}/{}",
            summary.host, summary.repository_owner, summary.repository_name
        ),
    }
}

/// Decides one deterministic check from one fresh read. Pure, so the whole
/// decision table is testable without a Git host.
///
/// "Exactly one" is literal: more than one pull request that could satisfy the
/// check is never narrowed to one without explicit policy.
pub(crate) fn decide(
    check: &PlaybookDeterministicCheck,
    read: &PullRequestRead,
) -> DeterministicDecision {
    let (repository, branch, pull_requests, truncated) = match read {
        PullRequestRead::Unavailable(reason) => return DeterministicDecision::Fallback(*reason),
        PullRequestRead::Read {
            repository,
            branch,
            pull_requests,
            truncated,
        } => (repository, branch, pull_requests, *truncated),
    };
    let targeted = pull_requests
        .iter()
        .filter(|summary| {
            check
                .base_branch
                .as_deref()
                .is_none_or(|base| summary.base_branch == base)
        })
        .collect::<Vec<_>>();
    let in_state = |state: PullRequestState| {
        targeted
            .iter()
            .copied()
            .filter(|summary| summary.state == state)
            .collect::<Vec<_>>()
    };
    let wanted = match check.kind {
        PlaybookDeterministicCheckKind::PullRequestOpen
        | PlaybookDeterministicCheckKind::PullRequestChecksPassing => PullRequestState::Open,
        PlaybookDeterministicCheckKind::PullRequestMerged => PullRequestState::Merged,
    };
    let matching = in_state(wanted);
    if matching.len() > 1 {
        return DeterministicDecision::Fallback(Fallback::MultipleMatches);
    }
    // A partial read cannot prove that this is the only match, or that there
    // is none.
    if truncated {
        return DeterministicDecision::Fallback(Fallback::ProviderFailure);
    }
    let target = check
        .base_branch
        .as_deref()
        .map(|base| format!(" targeting {base}"))
        .unwrap_or_default();
    let Some(found) = matching.first() else {
        // A merged pull request was opened first. Its CI is no longer read,
        // so a checks step leaves that question to the Routine.
        if wanted == PullRequestState::Open
            && let [merged] = in_state(PullRequestState::Merged)[..]
        {
            return match check.kind {
                PlaybookDeterministicCheckKind::PullRequestOpen => {
                    DeterministicDecision::Passed(bounded_evidence(format!(
                        "PR #{} from {branch} on {} was opened and has merged into {}.",
                        merged.number,
                        summary_repository(merged),
                        merged.base_branch
                    )))
                }
                _ => DeterministicDecision::Fallback(Fallback::ChecksUnsupported),
            };
        }
        let drafts = in_state(PullRequestState::Draft);
        let open = in_state(PullRequestState::Open);
        let merged_check = check.kind == PlaybookDeterministicCheckKind::PullRequestMerged;
        let evidence = if merged_check && open.len() == 1 {
            format!(
                "PR #{} from {branch} on {} is open{target} and not merged yet.",
                open[0].number,
                summary_repository(open[0])
            )
        } else if drafts.len() == 1 {
            format!(
                "PR #{} from {branch} on {} is still a draft{target}.",
                drafts[0].number,
                summary_repository(drafts[0])
            )
        } else if merged_check {
            format!("No merged pull request from {branch}{target} on {repository}.")
        } else {
            format!("No open pull request from {branch}{target} on {repository}.")
        };
        return DeterministicDecision::Waiting(bounded_evidence(evidence));
    };
    let described = format!(
        "PR #{} {} on {} targeting {}",
        found.number,
        match wanted {
            PullRequestState::Merged => "merged",
            _ => "open",
        },
        summary_repository(found),
        found.base_branch
    );
    match check.kind {
        PlaybookDeterministicCheckKind::PullRequestOpen
        | PlaybookDeterministicCheckKind::PullRequestMerged => {
            DeterministicDecision::Passed(bounded_evidence(format!("{described}.")))
        }
        PlaybookDeterministicCheckKind::PullRequestChecksPassing => match found.checks {
            CheckState::Passing => DeterministicDecision::Passed(bounded_evidence(format!(
                "{described}, checks passing."
            ))),
            CheckState::Failing => DeterministicDecision::Waiting(bounded_evidence(format!(
                "{described}, checks failing."
            ))),
            CheckState::Pending => DeterministicDecision::Waiting(bounded_evidence(format!(
                "{described}, checks pending."
            ))),
            CheckState::NotReported | CheckState::Unsupported | CheckState::Unknown => {
                DeterministicDecision::Fallback(Fallback::ChecksUnsupported)
            }
        },
    }
}

/// Evidence is one short factual sentence within the stored bound. Branch and
/// repository names are the only variable parts, so truncation stays on a
/// character boundary and never splits a multi-byte name.
fn bounded_evidence(mut evidence: String) -> String {
    if evidence.len() > PLAYBOOK_EVIDENCE_MAX_BYTES {
        let mut end = PLAYBOOK_EVIDENCE_MAX_BYTES - '…'.len_utf8();
        while !evidence.is_char_boundary(end) {
            end -= 1;
        }
        evidence.truncate(end);
        evidence.push('…');
    }
    evidence
}

#[cfg(test)]
mod tests;
