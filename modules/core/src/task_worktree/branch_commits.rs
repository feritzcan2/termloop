use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::PathBuf;

use serde_json::{Value, json};
use termloop_domain::{TaskBranchBinding, TaskRecord};
use termloop_gitio::{
    BranchCommitState, BranchCommitSummaryObservation, BranchCommitSummaryRequest,
    BranchCommitUnavailable, GitRefName, GitRunner,
};

use crate::{CoreError, CoreRuntime, required_string};

const BRANCH_COMMIT_CACHE_CAP: usize = 256;
const BRANCH_COMMIT_CACHE_TTL_MS: u64 = 5 * 60_000;
const BRANCH_COMMIT_REQUEST_LIMIT: usize = 40;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
struct BranchCommitSummary {
    count: Option<u64>,
    base_ref: Option<String>,
    not_in_base: BranchNotInBaseSummary,
    freshness: &'static str,
    reason: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BranchNotInBaseSummary {
    count: Option<u64>,
    base_ref: Option<String>,
    freshness: &'static str,
    reason: Option<&'static str>,
}

#[derive(Clone)]
struct BranchCommitTarget {
    task_id: String,
    binding: TaskBranchBinding,
    recorded_base: Option<(String, String)>,
}

struct CachedBranchCommitSummary {
    binding: TaskBranchBinding,
    recorded_base: Option<(Vec<u8>, Vec<u8>)>,
    common_dir: PathBuf,
    branch_ref: Vec<u8>,
    base_ref: Option<Vec<u8>>,
    summary: BranchCommitSummary,
    expires_at_epoch_ms: u64,
}

#[derive(Default)]
pub(crate) struct BranchCommitSummaryCache {
    entries: VecDeque<CachedBranchCommitSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskBranchCommitWatchTarget {
    pub project_id: String,
    pub task_id: String,
    pub cache_key: super::WorktreeHealthCacheKey,
}

impl BranchCommitSummaryCache {
    fn retain_fresh(&mut self, now: u64) {
        self.entries.retain(|entry| entry.expires_at_epoch_ms > now);
    }

    fn get(
        &mut self,
        binding: &TaskBranchBinding,
        recorded_base: Option<(&str, &str)>,
        now: u64,
    ) -> Option<BranchCommitSummary> {
        self.retain_fresh(now);
        let index = self.entries.iter().position(|entry| {
            &entry.binding == binding
                && entry
                    .recorded_base
                    .as_ref()
                    .map(|(reference, oid)| (reference.as_slice(), oid.as_slice()))
                    == recorded_base.map(|(reference, oid)| (reference.as_bytes(), oid.as_bytes()))
        })?;
        let entry = self.entries.remove(index)?;
        let summary = entry.summary.clone();
        self.entries.push_back(entry);
        Some(summary)
    }

    fn insert(&mut self, entry: CachedBranchCommitSummary, now: u64) {
        self.retain_fresh(now);
        self.entries.retain(|candidate| {
            candidate.binding != entry.binding
                && !(candidate.common_dir == entry.common_dir
                    && candidate.branch_ref == entry.branch_ref
                    && candidate.base_ref == entry.base_ref)
        });
        self.entries.push_back(entry);
        while self.entries.len() > BRANCH_COMMIT_CACHE_CAP {
            self.entries.pop_front();
        }
    }

    fn invalidate_common_dir(&mut self, common_dir: &std::path::Path) {
        self.entries.retain(|entry| entry.common_dir != common_dir);
    }
}

pub struct TaskBranchCommitSummaryListPlan {
    project_id: String,
    cached: Vec<(String, BranchCommitSummary)>,
    targets: Vec<BranchCommitTarget>,
}

pub struct ObservedTaskBranchCommitSummaries {
    plan: TaskBranchCommitSummaryListPlan,
    rows: Vec<ObservedBranchCommitSummary>,
}

struct ObservedBranchCommitSummary {
    target: BranchCommitTarget,
    observation: Result<BranchCommitSummaryObservation, CoreError>,
}

impl TaskBranchCommitSummaryListPlan {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn requires_observation(&self) -> bool {
        !self.targets.is_empty()
    }

    pub fn observe(self) -> ObservedTaskBranchCommitSummaries {
        if self.targets.is_empty() {
            return ObservedTaskBranchCommitSummaries {
                plan: self,
                rows: Vec::new(),
            };
        }
        let runner =
            GitRunner::discover_with_timeout(termloop_gitio::BRANCH_COMMIT_OBSERVATION_DEADLINE)
                .map_err(super::git_mapping::map_git_observation_error);
        self.observe_with_discovered_runner(runner)
    }

    pub fn observation_unavailable(self, error: CoreError) -> ObservedTaskBranchCommitSummaries {
        let rows = self
            .targets
            .iter()
            .cloned()
            .map(|target| ObservedBranchCommitSummary {
                target,
                observation: Err(clone_observation_error(&error)),
            })
            .collect();
        ObservedTaskBranchCommitSummaries { plan: self, rows }
    }

    #[cfg(test)]
    pub(crate) fn observe_with_runner(
        self,
        runner: &GitRunner,
    ) -> ObservedTaskBranchCommitSummaries {
        self.observe_with_discovered_runner(
            runner
                .clone()
                .with_absolute_timeout(termloop_gitio::BRANCH_COMMIT_OBSERVATION_DEADLINE)
                .map_err(super::git_mapping::map_git_observation_error),
        )
    }

    fn observe_with_discovered_runner(
        self,
        runner: Result<GitRunner, CoreError>,
    ) -> ObservedTaskBranchCommitSummaries {
        let mut by_repository = BTreeMap::<String, Vec<BranchCommitTarget>>::new();
        for target in self.targets.iter().cloned() {
            by_repository
                .entry(target.binding.repository_root.clone())
                .or_default()
                .push(target);
        }
        let mut rows = Vec::with_capacity(self.targets.len());
        for (repository_root, targets) in by_repository {
            let observations = match &runner {
                Ok(runner) => runner
                    .observe_branch_commit_summary_requests(
                        std::path::Path::new(&repository_root),
                        &targets
                            .iter()
                            .map(|target| {
                                BranchCommitSummaryRequest::new(
                                    target.binding.name.as_bytes().to_vec(),
                                    target
                                        .recorded_base
                                        .as_ref()
                                        .map(|(base_ref, _)| base_ref.as_bytes().to_vec()),
                                )
                            })
                            .collect::<Vec<_>>(),
                    )
                    .map(|batch| batch.observations)
                    .map_err(super::git_mapping::map_git_observation_error),
                Err(error) => Err(clone_observation_error(error)),
            };
            match observations {
                Ok(observations) if observations.len() == targets.len() => {
                    rows.extend(targets.into_iter().zip(observations).map(
                        |(target, observation)| ObservedBranchCommitSummary {
                            target,
                            observation:
                                observation.map_err(super::git_mapping::map_git_observation_error),
                        },
                    ));
                }
                Ok(_) => {
                    rows.extend(
                        targets
                            .into_iter()
                            .map(|target| ObservedBranchCommitSummary {
                                target,
                                observation: Err(CoreError::RepositoryUnavailable),
                            }),
                    )
                }
                Err(error) => {
                    rows.extend(
                        targets
                            .into_iter()
                            .map(|target| ObservedBranchCommitSummary {
                                target,
                                observation: Err(clone_observation_error(&error)),
                            }),
                    )
                }
            }
        }
        ObservedTaskBranchCommitSummaries { plan: self, rows }
    }
}

impl CoreRuntime {
    pub fn plan_task_branch_commit_summary_list(
        &mut self,
        params: Value,
    ) -> Result<TaskBranchCommitSummaryListPlan, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let task_ids = parse_task_ids(&params)?;
        let now = termloop_platform::current_epoch_ms();
        let mut cached = Vec::new();
        let mut targets = Vec::new();

        for task_id in task_ids {
            let Some(task) = self
                .store
                .tasks()
                .iter()
                .find(|task| task.id == task_id && task.project_id == project_id)
            else {
                continue;
            };
            let Some(binding) = task.branch.clone() else {
                cached.push((task_id, unavailable("noBranch")));
                continue;
            };
            let recorded_base = self.task_recorded_branch_base(&task_id, &binding);
            if let Some(summary) = self.branch_commit_summaries.get(
                &binding,
                recorded_base
                    .as_ref()
                    .map(|(reference, oid)| (reference.as_str(), oid.as_str())),
                now,
            ) {
                cached.push((task_id, summary));
                continue;
            }
            targets.push(BranchCommitTarget {
                task_id,
                binding,
                recorded_base,
            });
        }
        Ok(TaskBranchCommitSummaryListPlan {
            project_id,
            cached,
            targets,
        })
    }

    pub fn complete_task_branch_commit_summary_list(
        &mut self,
        observed: ObservedTaskBranchCommitSummaries,
    ) -> Result<Value, CoreError> {
        let now = termloop_platform::current_epoch_ms();
        let mut projected = observed.plan.cached;
        for row in observed.rows {
            let binding_is_current = self.store.tasks().iter().any(|task| {
                task.id == row.target.task_id
                    && task.project_id == observed.plan.project_id
                    && task.branch.as_ref() == Some(&row.target.binding)
            }) && self
                .task_recorded_branch_base(&row.target.task_id, &row.target.binding)
                == row.target.recorded_base;
            if !binding_is_current {
                continue;
            }
            match row.observation {
                Ok(observation) => {
                    let (summary, base_ref) = project_observation(&observation);
                    self.branch_commit_summaries.insert(
                        CachedBranchCommitSummary {
                            binding: row.target.binding.clone(),
                            recorded_base: row.target.recorded_base.as_ref().map(
                                |(reference, oid)| {
                                    (reference.as_bytes().to_vec(), oid.as_bytes().to_vec())
                                },
                            ),
                            common_dir: observation.repository_common_dir,
                            branch_ref: observation.branch_ref.as_bytes().to_vec(),
                            base_ref,
                            summary: summary.clone(),
                            expires_at_epoch_ms: now.saturating_add(BRANCH_COMMIT_CACHE_TTL_MS),
                        },
                        now,
                    );
                    projected.push((row.target.task_id, summary));
                }
                Err(error) => projected.push((row.target.task_id, project_error(error))),
            }
        }
        Ok(Value::Array(
            projected
                .into_iter()
                .map(|(task_id, summary)| project_summary(task_id, summary))
                .collect(),
        ))
    }

    pub fn invalidate_branch_commit_summaries_for_common_dir(
        &mut self,
        common_dir: &std::path::Path,
    ) -> Result<u64, CoreError> {
        self.branch_commit_summaries
            .invalidate_common_dir(common_dir);
        self.next_observation_sequence()
    }

    pub fn task_branch_commit_watch_targets(
        &self,
        project_ids: &[String],
    ) -> Vec<TaskBranchCommitWatchTarget> {
        self.store
            .tasks()
            .iter()
            .filter(|task| project_ids.contains(&task.project_id))
            .filter_map(|task| {
                let binding = task.branch.as_ref()?;
                let cached = self
                    .branch_commit_summaries
                    .entries
                    .iter()
                    .find(|entry| &entry.binding == binding)?;
                Some(TaskBranchCommitWatchTarget {
                    project_id: task.project_id.clone(),
                    task_id: task.id.clone(),
                    cache_key: self.branch_commit_watch_key(task, binding, cached),
                })
            })
            .collect()
    }

    pub fn admitted_branch_commit_watch_keys(&self) -> HashSet<super::WorktreeHealthCacheKey> {
        self.store
            .tasks()
            .iter()
            .filter_map(|task| {
                let binding = task.branch.as_ref()?;
                let entry = self
                    .branch_commit_summaries
                    .entries
                    .iter()
                    .find(|entry| &entry.binding == binding)?;
                Some(self.branch_commit_watch_key(task, binding, entry))
            })
            .collect()
    }

    fn branch_commit_watch_key(
        &self,
        task: &TaskRecord,
        binding: &TaskBranchBinding,
        cached: &CachedBranchCommitSummary,
    ) -> super::WorktreeHealthCacheKey {
        let common_dir = cached.common_dir.display().to_string();
        let worktree_root = task
            .worktree
            .as_ref()
            .map(|value| value.path.clone())
            .or_else(|| {
                self.store
                    .managed_worktrees()
                    .iter()
                    .find(|proof| proof.repository_common_dir == common_dir)
                    .map(|proof| proof.registered_worktree_path.clone())
            })
            .unwrap_or_else(|| binding.repository_root.clone());
        super::WorktreeHealthCacheKey {
            repository_common_dir: common_dir,
            worktree_root,
        }
    }
}

fn parse_task_ids(params: &Value) -> Result<Vec<String>, CoreError> {
    let values = params
        .get("taskIds")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidParams("taskIds".into()))?;
    if values.is_empty() || values.len() > BRANCH_COMMIT_REQUEST_LIMIT {
        return Err(CoreError::InvalidParams("taskIds".into()));
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| {
            let task_id = value
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| CoreError::InvalidParams("taskIds".into()))?
                .to_owned();
            if !seen.insert(task_id.clone()) {
                return Err(CoreError::InvalidParams("taskIds".into()));
            }
            Ok(task_id)
        })
        .collect()
}

fn project_observation(
    observation: &BranchCommitSummaryObservation,
) -> (BranchCommitSummary, Option<Vec<u8>>) {
    let not_in_base = project_not_in_base(&observation.not_in_base);
    match &observation.state {
        BranchCommitState::Available { base_ref, count } => {
            if *count > MAX_SAFE_JSON_INTEGER {
                let mut summary = unavailable("outputLimit");
                summary.not_in_base = not_in_base;
                return (summary, Some(base_ref.as_bytes().to_vec()));
            }
            let Some(display) = display_ref(base_ref) else {
                let mut summary = unavailable("baseRefUnavailable");
                summary.not_in_base = not_in_base;
                return (summary, Some(base_ref.as_bytes().to_vec()));
            };
            (
                BranchCommitSummary {
                    count: Some(*count),
                    base_ref: Some(display),
                    not_in_base,
                    freshness: "fresh",
                    reason: None,
                },
                Some(base_ref.as_bytes().to_vec()),
            )
        }
        BranchCommitState::Unavailable { base_ref, reason } => {
            let mut summary = unavailable(match reason {
                BranchCommitUnavailable::AmbiguousRemote => "ambiguousRemote",
                BranchCommitUnavailable::BaseRefUnavailable => "baseRefUnavailable",
                BranchCommitUnavailable::BranchMissing => "branchMissing",
            });
            summary.not_in_base = not_in_base;
            (
                summary,
                base_ref.as_ref().map(|value| value.as_bytes().to_vec()),
            )
        }
    }
}

fn project_not_in_base(state: &BranchCommitState) -> BranchNotInBaseSummary {
    match state {
        BranchCommitState::Available { base_ref, count } if *count <= MAX_SAFE_JSON_INTEGER => {
            match display_ref(base_ref) {
                Some(base_ref) => BranchNotInBaseSummary {
                    count: Some(*count),
                    base_ref: Some(base_ref),
                    freshness: "fresh",
                    reason: None,
                },
                None => unavailable_not_in_base("baseRefUnavailable"),
            }
        }
        BranchCommitState::Available { .. } => unavailable_not_in_base("outputLimit"),
        BranchCommitState::Unavailable { reason, .. } => unavailable_not_in_base(match reason {
            BranchCommitUnavailable::AmbiguousRemote => "ambiguousRemote",
            BranchCommitUnavailable::BaseRefUnavailable => "baseRefUnavailable",
            BranchCommitUnavailable::BranchMissing => "branchMissing",
        }),
    }
}

fn display_ref(reference: &GitRefName) -> Option<String> {
    std::str::from_utf8(reference.as_bytes())
        .ok()
        .map(str::to_owned)
}

fn project_error(error: CoreError) -> BranchCommitSummary {
    unavailable(match error {
        CoreError::GitObservationTimedOut => "timeout",
        CoreError::GitObservationOutputBound => "outputLimit",
        _ => "repositoryUnavailable",
    })
}

fn clone_observation_error(error: &CoreError) -> CoreError {
    match error {
        CoreError::GitUnavailable => CoreError::GitUnavailable,
        CoreError::GitUnsupportedVersion => CoreError::GitUnsupportedVersion,
        CoreError::RepositoryPermissionDenied => CoreError::RepositoryPermissionDenied,
        CoreError::GitObservationTimedOut => CoreError::GitObservationTimedOut,
        CoreError::GitObservationOutputBound => CoreError::GitObservationOutputBound,
        CoreError::CorruptRepository => CoreError::CorruptRepository,
        CoreError::UnsupportedRepository => CoreError::UnsupportedRepository,
        _ => CoreError::RepositoryUnavailable,
    }
}

fn unavailable(reason: &'static str) -> BranchCommitSummary {
    BranchCommitSummary {
        count: None,
        base_ref: None,
        not_in_base: unavailable_not_in_base(reason),
        freshness: "unavailable",
        reason: Some(reason),
    }
}

fn unavailable_not_in_base(reason: &'static str) -> BranchNotInBaseSummary {
    BranchNotInBaseSummary {
        count: None,
        base_ref: None,
        freshness: "unavailable",
        reason: Some(reason),
    }
}

fn project_summary(task_id: String, summary: BranchCommitSummary) -> Value {
    json!({
        "task_id": task_id,
        "count": summary.count,
        "base_ref": summary.base_ref,
        "not_in_base": {
            "count": summary.not_in_base.count,
            "base_ref": summary.not_in_base.base_ref,
            "freshness": summary.not_in_base.freshness,
            "reason": summary.not_in_base.reason,
        },
        "freshness": summary.freshness,
        "reason": summary.reason,
    })
}
