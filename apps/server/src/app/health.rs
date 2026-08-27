use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;
use termloop_contract::current::{
    ProjectionInvalidatedPayload, ProjectionTopic, TaskProjectionEntityScopeDto,
    TaskProjectionTopic,
};
use termloop_core::CoreError;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinSet;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use uuid::Uuid;

use super::control::git_host_pull_request_list_background;
use super::gates::{FairObservationGate, ObservationPriority};
use super::{AppState, current_epoch_ms};

const GLOBAL_HEALTH_WATCH_CAP: usize = 256;
const PROJECT_HEALTH_WATCH_CAP: usize = 64;

#[derive(Debug, Clone)]
pub(super) enum HealthTrigger {
    Target {
        target: termloop_core::task_worktree::TaskWorktreeWatchTarget,
        unknown: bool,
    },
    BranchTarget {
        target: termloop_core::task_worktree::TaskBranchCommitWatchTarget,
    },
    Watch {
        cache_key: termloop_core::task_worktree::WorktreeHealthCacheKey,
        registration_token: u64,
        git_host_change: bool,
        branch_commit_change: bool,
    },
}

#[derive(Default)]
pub(super) struct HealthDemandRegistry {
    owners: HashMap<Uuid, Vec<termloop_core::task_worktree::TaskWorktreeWatchTarget>>,
    branch_owners: HashMap<Uuid, Vec<termloop_core::task_worktree::TaskBranchCommitWatchTarget>>,
    owner_projects: HashMap<Uuid, Vec<String>>,
    watchers: HashMap<termloop_core::task_worktree::WorktreeHealthCacheKey, HealthWatchEntry>,
    refused_branch_keys: HashSet<termloop_core::task_worktree::WorktreeHealthCacheKey>,
    next_registration_token: u64,
}

struct HealthWatchEntry {
    _watcher: termloop_platform::DirectoryWatcher,
    registration_token: u64,
    owners: HashSet<Uuid>,
    targets: HashMap<(String, String), HashSet<Uuid>>,
    branch_targets: HashMap<(String, String), HashSet<Uuid>>,
}

struct WatchTargets {
    health: Vec<termloop_core::task_worktree::TaskWorktreeWatchTarget>,
    branch: Vec<termloop_core::task_worktree::TaskBranchCommitWatchTarget>,
}

#[derive(Default)]
struct RefusedWatchTargets {
    health: Vec<termloop_core::task_worktree::TaskWorktreeWatchTarget>,
    branch: Vec<termloop_core::task_worktree::TaskBranchCommitWatchTarget>,
}

impl HealthDemandRegistry {
    pub(super) fn remove(&mut self, owner: Uuid) {
        self.owner_projects.remove(&owner);
        let keys = self.owners.remove(&owner).unwrap_or_default();
        for target in keys {
            if let Some(entry) = self.watchers.get_mut(&target.cache_key) {
                entry.owners.remove(&owner);
                let identity = (target.project_id, target.task_id);
                if let Some(target_owners) = entry.targets.get_mut(&identity) {
                    target_owners.remove(&owner);
                    if target_owners.is_empty() {
                        entry.targets.remove(&identity);
                    }
                }
                if entry.owners.is_empty() {
                    self.watchers.remove(&target.cache_key);
                }
            }
        }
        let branch_keys = self.branch_owners.remove(&owner).unwrap_or_default();
        for target in branch_keys {
            if let Some(entry) = self.watchers.get_mut(&target.cache_key) {
                entry.owners.remove(&owner);
                let identity = (target.project_id, target.task_id);
                if let Some(target_owners) = entry.branch_targets.get_mut(&identity) {
                    target_owners.remove(&owner);
                    if target_owners.is_empty() {
                        entry.branch_targets.remove(&identity);
                    }
                }
                if entry.owners.is_empty() {
                    self.watchers.remove(&target.cache_key);
                }
            }
        }
    }

    fn projects(&self) -> Vec<String> {
        let mut projects = self
            .owner_projects
            .values()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        projects.sort();
        projects.dedup();
        projects
    }

    fn watch_targets(
        &self,
        key: &termloop_core::task_worktree::WorktreeHealthCacheKey,
        token: u64,
    ) -> Option<WatchTargets> {
        let entry = self.watchers.get(key)?;
        if entry.registration_token != token {
            return None;
        }
        let health = entry
            .targets
            .keys()
            .map(
                |(project_id, task_id)| termloop_core::task_worktree::TaskWorktreeWatchTarget {
                    project_id: project_id.clone(),
                    task_id: task_id.clone(),
                    cache_key: key.clone(),
                    worktree_root: key.worktree_root.clone(),
                    repository_common_dir: key.repository_common_dir.clone(),
                },
            )
            .collect();
        let branch = entry
            .branch_targets
            .keys()
            .map(|(project_id, task_id)| {
                termloop_core::task_worktree::TaskBranchCommitWatchTarget {
                    project_id: project_id.clone(),
                    task_id: task_id.clone(),
                    cache_key: key.clone(),
                }
            })
            .collect();
        Some(WatchTargets { health, branch })
    }

    fn health_registration_token(
        &self,
        target: &termloop_core::task_worktree::TaskWorktreeWatchTarget,
    ) -> Option<u64> {
        let entry = self.watchers.get(&target.cache_key)?;
        entry
            .targets
            .contains_key(&(target.project_id.clone(), target.task_id.clone()))
            .then_some(entry.registration_token)
    }

    fn replace_owner_targets(
        &mut self,
        owner: Uuid,
        projects: &[String],
        targets: Vec<termloop_core::task_worktree::TaskWorktreeWatchTarget>,
        branch_targets: Vec<termloop_core::task_worktree::TaskBranchCommitWatchTarget>,
    ) {
        self.owner_projects.insert(owner, projects.to_vec());
        self.owners.insert(owner, targets);
        self.branch_owners.insert(owner, branch_targets);
    }

    fn refused_branch_targets(
        &self,
        projects: &[String],
    ) -> Vec<termloop_core::task_worktree::TaskBranchCommitWatchTarget> {
        let mut seen = HashSet::new();
        self.branch_owners
            .values()
            .flatten()
            .filter(|target| {
                projects.contains(&target.project_id)
                    && self.refused_branch_keys.contains(&target.cache_key)
            })
            .filter(|target| {
                seen.insert((
                    target.project_id.clone(),
                    target.task_id.clone(),
                    target.cache_key.clone(),
                ))
            })
            .cloned()
            .collect()
    }

    fn reconcile_watchers(
        &mut self,
        admitted: &HashSet<termloop_core::task_worktree::WorktreeHealthCacheKey>,
        admitted_branch: &HashSet<termloop_core::task_worktree::WorktreeHealthCacheKey>,
        sender: &mpsc::Sender<HealthTrigger>,
    ) -> RefusedWatchTargets {
        type TargetOwners = HashMap<(String, String), HashSet<Uuid>>;
        let mut desired =
            HashMap::<termloop_core::task_worktree::WorktreeHealthCacheKey, TargetOwners>::new();
        let mut desired_branch =
            HashMap::<termloop_core::task_worktree::WorktreeHealthCacheKey, TargetOwners>::new();
        for (owner, targets) in &self.owners {
            for target in targets {
                if admitted.contains(&target.cache_key) {
                    desired
                        .entry(target.cache_key.clone())
                        .or_default()
                        .entry((target.project_id.clone(), target.task_id.clone()))
                        .or_default()
                        .insert(*owner);
                }
            }
        }
        for (owner, targets) in &self.branch_owners {
            for target in targets {
                if admitted_branch.contains(&target.cache_key) {
                    desired_branch
                        .entry(target.cache_key.clone())
                        .or_default()
                        .entry((target.project_id.clone(), target.task_id.clone()))
                        .or_default()
                        .insert(*owner);
                }
            }
        }

        // Caps apply to distinct canonical keys, not connections or Tasks.
        let mut keys = desired
            .keys()
            .chain(desired_branch.keys())
            .cloned()
            .collect::<Vec<_>>();
        keys.sort_by(|left, right| {
            (&left.repository_common_dir, &left.worktree_root)
                .cmp(&(&right.repository_common_dir, &right.worktree_root))
        });
        keys.dedup();
        let mut project_counts = HashMap::<String, usize>::new();
        let mut allowed = HashSet::new();
        let mut refused = RefusedWatchTargets::default();
        for key in keys {
            let health_targets = desired.get(&key);
            let branch_targets = desired_branch.get(&key);
            let projects = health_targets
                .into_iter()
                .chain(branch_targets)
                .flat_map(|targets| targets.keys())
                .map(|(project, _)| project.clone())
                .collect::<HashSet<_>>();
            let within_cap = allowed.len() < GLOBAL_HEALTH_WATCH_CAP
                && projects.iter().all(|project| {
                    project_counts.get(project).copied().unwrap_or(0) < PROJECT_HEALTH_WATCH_CAP
                });
            if within_cap {
                for project in projects {
                    *project_counts.entry(project).or_default() += 1;
                }
                allowed.insert(key);
            } else {
                refused.health.extend(
                    health_targets
                        .into_iter()
                        .flat_map(|targets| targets.keys())
                        .map(|(project_id, task_id)| {
                            termloop_core::task_worktree::TaskWorktreeWatchTarget {
                                project_id: project_id.clone(),
                                task_id: task_id.clone(),
                                cache_key: key.clone(),
                                worktree_root: key.worktree_root.clone(),
                                repository_common_dir: key.repository_common_dir.clone(),
                            }
                        }),
                );
                refused.branch.extend(
                    branch_targets
                        .into_iter()
                        .flat_map(|targets| targets.keys())
                        .map(|(project_id, task_id)| {
                            termloop_core::task_worktree::TaskBranchCommitWatchTarget {
                                project_id: project_id.clone(),
                                task_id: task_id.clone(),
                                cache_key: key.clone(),
                            }
                        }),
                );
            }
        }

        self.watchers.retain(|key, _| allowed.contains(key));
        for key in allowed {
            let targets = desired.remove(&key).unwrap_or_default();
            let branch_targets = desired_branch.remove(&key).unwrap_or_default();
            let owners = targets
                .values()
                .chain(branch_targets.values())
                .flatten()
                .copied()
                .collect::<HashSet<_>>();
            if let Some(entry) = self.watchers.get_mut(&key) {
                entry.owners = owners;
                entry.targets = targets;
                entry.branch_targets = branch_targets;
                continue;
            }
            self.next_registration_token = self.next_registration_token.wrapping_add(1).max(1);
            let registration_token = self.next_registration_token;
            let callback_sender = sender.clone();
            let callback_key = key.clone();
            match termloop_platform::watch_git_repository_directories(
                &PathBuf::from(&key.worktree_root),
                &PathBuf::from(&key.repository_common_dir),
                move |change| {
                    let _ = callback_sender.try_send(HealthTrigger::Watch {
                        cache_key: callback_key.clone(),
                        registration_token,
                        git_host_change: change.git_configuration_or_ref_changed,
                        branch_commit_change: change.branch_ref_or_config_changed,
                    });
                },
            ) {
                Ok(watcher) => {
                    self.watchers.insert(
                        key,
                        HealthWatchEntry {
                            _watcher: watcher,
                            registration_token,
                            owners,
                            targets,
                            branch_targets,
                        },
                    );
                }
                Err(_) => {
                    refused
                        .health
                        .extend(targets.keys().map(|(project_id, task_id)| {
                            termloop_core::task_worktree::TaskWorktreeWatchTarget {
                                project_id: project_id.clone(),
                                task_id: task_id.clone(),
                                cache_key: key.clone(),
                                worktree_root: key.worktree_root.clone(),
                                repository_common_dir: key.repository_common_dir.clone(),
                            }
                        }));
                    refused
                        .branch
                        .extend(branch_targets.keys().map(|(project_id, task_id)| {
                            termloop_core::task_worktree::TaskBranchCommitWatchTarget {
                                project_id: project_id.clone(),
                                task_id: task_id.clone(),
                                cache_key: key.clone(),
                            }
                        }));
                }
            }
        }
        self.refused_branch_keys = refused
            .branch
            .iter()
            .map(|target| target.cache_key.clone())
            .collect();
        refused
    }
}

pub(super) async fn trigger_health_for_projects(state: &AppState, projects: &[String]) {
    let demands = {
        let core = state.core.lock().await;
        core.task_worktree_health_cache_misses(projects)
    };
    send_health_triggers(state, demands).await;
}

pub(super) async fn run_git_host_scheduler(state: AppState) {
    let mut interval = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let projects = state.health_demands.lock().await.projects();
        let demands = {
            let mut core = state.core.lock().await;
            core.reconcile_git_host_demands(&projects, current_epoch_ms())
        };
        for (project_id, task_ids) in demands {
            let state = state.clone();
            tokio::spawn(async move {
                let _ = git_host_pull_request_list_background(
                    json!({ "projectId": project_id, "taskIds": task_ids }),
                    &state,
                )
                .await;
            });
        }
    }
}

async fn trigger_all_health_for_projects(state: &AppState, projects: &[String]) {
    let health_demands = {
        let core = state.core.lock().await;
        core.task_worktree_watch_targets(projects)
    };
    let branch_demands = state
        .health_demands
        .lock()
        .await
        .refused_branch_targets(projects);
    send_health_triggers(state, health_demands).await;
    for target in branch_demands {
        let _ = state
            .health_triggers
            .try_send(HealthTrigger::BranchTarget { target });
    }
}

async fn send_health_triggers(
    state: &AppState,
    demands: Vec<termloop_core::task_worktree::TaskWorktreeWatchTarget>,
) {
    let registered = {
        let registry = state.health_demands.lock().await;
        demands
            .into_iter()
            .map(|demand| {
                let registration_token = registry.health_registration_token(&demand);
                (demand, registration_token)
            })
            .collect::<Vec<_>>()
    };
    for (demand, registration_token) in registered {
        let trigger = registration_token
            .map(|registration_token| HealthTrigger::Watch {
                cache_key: demand.cache_key.clone(),
                registration_token,
                git_host_change: false,
                branch_commit_change: false,
            })
            .unwrap_or(HealthTrigger::Target {
                target: demand,
                unknown: false,
            });
        let _ = state.health_triggers.try_send(trigger);
    }
}

pub(super) async fn replace_health_demand(state: &AppState, owner: Uuid, projects: &[String]) {
    let (targets, branch_targets, admitted, admitted_branch) = {
        let core = state.core.lock().await;
        (
            core.task_worktree_watch_targets(projects),
            core.task_branch_commit_watch_targets(projects),
            core.admitted_task_worktree_health_keys(),
            core.admitted_branch_commit_watch_keys(),
        )
    };
    let projects = projects.to_vec();
    let sender = state.health_triggers.clone();
    let registry = state.health_demands.clone().lock_owned().await;
    let refused = match tokio::task::spawn_blocking(move || {
        let mut registry = registry;
        registry.replace_owner_targets(owner, &projects, targets, branch_targets);
        registry.reconcile_watchers(&admitted, &admitted_branch, &sender)
    })
    .await
    {
        Ok(refused) => refused,
        Err(error) => {
            tracing::error!(%error, "health demand replacement worker failed");
            return;
        }
    };
    for target in refused.health {
        let _ = state.health_triggers.try_send(HealthTrigger::Target {
            target,
            unknown: true,
        });
    }
}

pub(super) async fn refresh_all_health_demands(state: &AppState) {
    let demands = state
        .health_demands
        .lock()
        .await
        .owner_projects
        .iter()
        .map(|(owner, projects)| (*owner, projects.clone()))
        .collect::<Vec<_>>();
    let all_projects = demands
        .iter()
        .flat_map(|(_, projects)| projects.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let (replacements, admitted, admitted_branch) = {
        let core = state.core.lock().await;
        let replacements = demands
            .into_iter()
            .map(|(owner, projects)| {
                let targets = core.task_worktree_watch_targets(&projects);
                let branch_targets = core.task_branch_commit_watch_targets(&projects);
                (owner, projects, targets, branch_targets)
            })
            .collect::<Vec<_>>();
        (
            replacements,
            core.admitted_task_worktree_health_keys(),
            core.admitted_branch_commit_watch_keys(),
        )
    };
    let sender = state.health_triggers.clone();
    let registry = state.health_demands.clone().lock_owned().await;
    let refused = match tokio::task::spawn_blocking(move || {
        let mut registry = registry;
        for (owner, projects, targets, branch_targets) in replacements {
            registry.replace_owner_targets(owner, &projects, targets, branch_targets);
        }
        registry.reconcile_watchers(&admitted, &admitted_branch, &sender)
    })
    .await
    {
        Ok(refused) => refused,
        Err(error) => {
            tracing::error!(%error, "health demand refresh worker failed");
            return;
        }
    };
    for target in refused.health {
        let _ = state.health_triggers.try_send(HealthTrigger::Target {
            target,
            unknown: true,
        });
    }
    for target in refused.branch {
        let _ = state
            .health_triggers
            .try_send(HealthTrigger::BranchTarget { target });
    }
    if !all_projects.is_empty() {
        trigger_health_for_projects(state, &all_projects).await;
    }
}

pub(super) async fn run_health_integrity_fallback(state: AppState) {
    let jitter = state.runtime_epoch % 61;
    let mut interval = tokio::time::interval(Duration::from_secs(300 + jitter));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        interval.tick().await;
        let projects = state.health_demands.lock().await.projects();
        if !projects.is_empty() {
            trigger_all_health_for_projects(&state, &projects).await;
        }
    }
}

#[derive(Clone)]
struct ScheduledHealthJob {
    cache_key: termloop_core::task_worktree::WorktreeHealthCacheKey,
    project_id: String,
    targets: Vec<termloop_core::task_worktree::TaskWorktreeWatchTarget>,
    branch_targets: Vec<termloop_core::task_worktree::TaskBranchCommitWatchTarget>,
    unknown: bool,
    registration_token: Option<u64>,
    git_host_change: bool,
    branch_commit_change: bool,
    ready_at: Instant,
    ordinal: u64,
}

pub(super) async fn run_health_scheduler(
    mut receiver: mpsc::Receiver<HealthTrigger>,
    trigger_sender: mpsc::Sender<HealthTrigger>,
    core: super::core_lock::MonitoredMutex<termloop_core::CoreRuntime>,
    observation_sequence: Arc<AtomicU64>,
    invalidations: broadcast::Sender<ProjectionInvalidatedPayload>,
    demands: Arc<tokio::sync::Mutex<HealthDemandRegistry>>,
    git_observation_gate: FairObservationGate,
) {
    let mut pending =
        HashMap::<termloop_core::task_worktree::WorktreeHealthCacheKey, ScheduledHealthJob>::new();
    let mut rerun =
        HashMap::<termloop_core::task_worktree::WorktreeHealthCacheKey, ScheduledHealthJob>::new();
    let mut active = HashSet::new();
    let mut projects = VecDeque::new();
    let mut joins = JoinSet::new();
    let mut ordinal = 0_u64;
    let mut receiver_open = true;

    loop {
        while joins.len() < 2 {
            let Some(job) = take_ready_health_job(&mut pending, &mut projects, Instant::now())
            else {
                break;
            };
            active.insert(job.cache_key.clone());
            let core = core.clone();
            let observation_sequence = observation_sequence.clone();
            let invalidations = invalidations.clone();
            let demands = demands.clone();
            let trigger_sender = trigger_sender.clone();
            let git_observation_gate = git_observation_gate.clone();
            joins.spawn(async move {
                run_scheduled_health_job(
                    &job,
                    &core,
                    &observation_sequence,
                    &invalidations,
                    &demands,
                    &trigger_sender,
                    &git_observation_gate,
                )
                .await;
                job.cache_key
            });
        }

        if !receiver_open && pending.is_empty() && joins.is_empty() {
            break;
        }
        let ready_job_deadline = health_job_wake_deadline(&pending, joins.len());
        let deadline =
            ready_job_deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            trigger = receiver.recv(), if receiver_open => {
                let Some(trigger) = trigger else {
                    receiver_open = false;
                    continue;
                };
                ordinal = ordinal.saturating_add(1);
                let Some(job) = resolve_health_trigger(trigger, ordinal, &demands).await else {
                    continue;
                };
                if active.contains(&job.cache_key) {
                    merge_health_job(&mut rerun, job, &mut projects);
                } else {
                    merge_health_job(&mut pending, job, &mut projects);
                }
            }
            completed = joins.join_next(), if !joins.is_empty() => {
                if let Some(Ok(key)) = completed {
                    active.remove(&key);
                    if let Some(job) = rerun.remove(&key) {
                        merge_health_job(&mut pending, job, &mut projects);
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline), if ready_job_deadline.is_some() => {}
        }
    }
}

fn health_job_wake_deadline(
    pending: &HashMap<termloop_core::task_worktree::WorktreeHealthCacheKey, ScheduledHealthJob>,
    active_jobs: usize,
) -> Option<Instant> {
    // A ready pending job cannot start while both worker slots are occupied.
    // Arming an already-expired sleep in that state makes the scheduler spin
    // without yielding to the JoinSet, starving the daemon's control plane.
    (active_jobs < 2)
        .then(|| pending.values().map(|job| job.ready_at).min())
        .flatten()
}

async fn resolve_health_trigger(
    trigger: HealthTrigger,
    ordinal: u64,
    demands: &Arc<tokio::sync::Mutex<HealthDemandRegistry>>,
) -> Option<ScheduledHealthJob> {
    let (
        targets,
        branch_targets,
        unknown,
        registration_token,
        cache_key,
        git_host_change,
        branch_commit_change,
    ) = match trigger {
        HealthTrigger::Target { target, unknown } => {
            let key = target.cache_key.clone();
            (vec![target], Vec::new(), unknown, None, key, false, false)
        }
        HealthTrigger::BranchTarget { target } => {
            let key = target.cache_key.clone();
            (Vec::new(), vec![target], false, None, key, false, true)
        }
        HealthTrigger::Watch {
            cache_key,
            registration_token,
            git_host_change,
            branch_commit_change,
        } => {
            let targets = demands
                .lock()
                .await
                .watch_targets(&cache_key, registration_token)?;
            (
                targets.health,
                targets.branch,
                false,
                Some(registration_token),
                cache_key,
                git_host_change,
                branch_commit_change,
            )
        }
    };
    let project_id = targets
        .iter()
        .map(|target| target.project_id.as_str())
        .chain(
            branch_targets
                .iter()
                .map(|target| target.project_id.as_str()),
        )
        .min()?
        .to_owned();
    Some(ScheduledHealthJob {
        cache_key,
        project_id,
        targets,
        branch_targets,
        unknown,
        registration_token,
        git_host_change,
        branch_commit_change,
        ready_at: Instant::now() + Duration::from_millis(250),
        ordinal,
    })
}

fn merge_health_job(
    jobs: &mut HashMap<termloop_core::task_worktree::WorktreeHealthCacheKey, ScheduledHealthJob>,
    incoming: ScheduledHealthJob,
    projects: &mut VecDeque<String>,
) {
    if let Some(existing) = jobs.get_mut(&incoming.cache_key) {
        existing.unknown |= incoming.unknown;
        existing.ready_at = existing.ready_at.min(incoming.ready_at);
        existing.registration_token =
            match (existing.registration_token, incoming.registration_token) {
                (Some(existing), Some(incoming)) if existing == incoming => Some(existing),
                _ => None,
            };
        existing.git_host_change |= incoming.git_host_change;
        existing.branch_commit_change |= incoming.branch_commit_change;
        for target in incoming.targets {
            if !existing.targets.iter().any(|candidate| {
                candidate.project_id == target.project_id && candidate.task_id == target.task_id
            }) {
                existing.targets.push(target);
            }
        }
        for target in incoming.branch_targets {
            if !existing.branch_targets.iter().any(|candidate| {
                candidate.project_id == target.project_id && candidate.task_id == target.task_id
            }) {
                existing.branch_targets.push(target);
            }
        }
        return;
    }
    if !projects.contains(&incoming.project_id) {
        projects.push_back(incoming.project_id.clone());
    }
    jobs.insert(incoming.cache_key.clone(), incoming);
}

fn take_ready_health_job(
    jobs: &mut HashMap<termloop_core::task_worktree::WorktreeHealthCacheKey, ScheduledHealthJob>,
    projects: &mut VecDeque<String>,
    now: Instant,
) -> Option<ScheduledHealthJob> {
    let turns = projects.len();
    for _ in 0..turns {
        let project = projects.pop_front()?;
        let candidate = jobs
            .values()
            .filter(|job| job.project_id == project && job.ready_at <= now)
            .min_by_key(|job| job.ordinal)
            .map(|job| job.cache_key.clone());
        if jobs.values().any(|job| job.project_id == project) {
            projects.push_back(project);
        }
        if let Some(key) = candidate {
            return jobs.remove(&key);
        }
    }
    None
}

async fn run_scheduled_health_job(
    job: &ScheduledHealthJob,
    core: &super::core_lock::MonitoredMutex<termloop_core::CoreRuntime>,
    observation_sequence: &AtomicU64,
    invalidations: &broadcast::Sender<ProjectionInvalidatedPayload>,
    demands: &Arc<tokio::sync::Mutex<HealthDemandRegistry>>,
    trigger_sender: &mpsc::Sender<HealthTrigger>,
    git_observation_gate: &FairObservationGate,
) {
    if let Some(token) = job.registration_token
        && demands
            .lock()
            .await
            .watch_targets(&job.cache_key, token)
            .is_none()
    {
        return;
    }
    if job.unknown {
        for target in &job.targets {
            let mut core = core.lock().await;
            let result =
                core.apply_unknown_task_worktree_health(&target.task_id, current_epoch_ms());
            let applied = (result, core.state_revision());
            drop(core);
            publish_health_apply(
                applied,
                &target.task_id,
                observation_sequence,
                invalidations,
            );
        }
        reconcile_health_watcher_admission(core, demands, trigger_sender).await;
        return;
    }

    if !job.targets.is_empty() {
        // Keep the scheduler slot until the bounded Git operation has actually
        // returned. The runner carries the absolute deadline into discovery and
        // platform kills the process tree at expiry; dropping a JoinHandle would
        // not provide that guarantee.
        let Ok(_permit) = git_observation_gate
            .acquire(&job.project_id, ObservationPriority::Background)
            .await
        else {
            return;
        };
        let plans = {
            let core = core.lock().await;
            job.targets
                .iter()
                .filter_map(|target| {
                    core.plan_task_worktree_health(&target.task_id)
                        .ok()
                        .map(|plan| (target.clone(), plan))
                })
                .collect::<Vec<_>>()
        };
        if let Some((_, first)) = plans.first() {
            let first = first.clone();
            let shared = match tokio::task::spawn_blocking(move || first.observe_shared()).await {
                Ok(shared) => shared,
                Err(_) => return,
            };
            for (target, plan) in plans {
                let applied = {
                    let mut core = core.lock().await;
                    let result = match &shared {
                        Ok(observation) => core.apply_observed_task_worktree_health(
                            plan.with_observation(Ok(observation.clone())),
                            current_epoch_ms(),
                        ),
                        Err(_) => core.apply_unknown_task_worktree_health(
                            &target.task_id,
                            current_epoch_ms(),
                        ),
                    };
                    (result, core.state_revision())
                };
                publish_health_apply(
                    applied,
                    &target.task_id,
                    observation_sequence,
                    invalidations,
                );
            }
        }
    }
    if job.registration_token.is_some() && job.git_host_change {
        let (mut ids, state_revision, captured_sequence) = {
            let mut core = core.lock().await;
            core.invalidate_git_host_local_facts();
            let candidates = job
                .targets
                .iter()
                .map(|target| target.task_id.clone())
                .collect::<Vec<_>>();
            let ids = core.automatic_git_host_task_ids(&candidates);
            let sequence = if ids.is_empty() {
                core.observation_sequence()
            } else {
                match core.next_observation_sequence() {
                    Ok(sequence) => sequence,
                    Err(_) => return,
                }
            };
            (ids, core.state_revision(), sequence)
        };
        ids.sort();
        ids.dedup();
        ids.truncate(128);
        if !ids.is_empty() {
            observation_sequence.fetch_max(captured_sequence, Ordering::Relaxed);
            let _ = invalidations.send(ProjectionInvalidatedPayload {
                topics: vec![ProjectionTopic::GitHost],
                state_revision,
                observation_sequence: captured_sequence,
                entity_scopes: Some(vec![TaskProjectionEntityScopeDto {
                    topic: TaskProjectionTopic::GitHost,
                    ids,
                }]),
            });
        }
    }
    if job.branch_commit_change {
        let mut branch_ids = job
            .branch_targets
            .iter()
            .map(|target| target.task_id.clone())
            .collect::<Vec<_>>();
        branch_ids.sort();
        branch_ids.dedup();
        branch_ids.truncate(128);
        if !branch_ids.is_empty() {
            let (branch_revision, captured_sequence) = {
                let mut core = core.lock().await;
                let sequence = match core.invalidate_branch_commit_summaries_for_common_dir(
                    Path::new(&job.cache_key.repository_common_dir),
                ) {
                    Ok(sequence) => sequence,
                    Err(_) => return,
                };
                (core.state_revision(), sequence)
            };
            observation_sequence.fetch_max(captured_sequence, Ordering::Relaxed);
            let _ = invalidations.send(ProjectionInvalidatedPayload {
                topics: vec![ProjectionTopic::BranchCommit],
                state_revision: branch_revision,
                observation_sequence: captured_sequence,
                entity_scopes: Some(vec![TaskProjectionEntityScopeDto {
                    topic: TaskProjectionTopic::BranchCommit,
                    ids: branch_ids,
                }]),
            });
        }
    }
    reconcile_health_watcher_admission(core, demands, trigger_sender).await;
}

async fn reconcile_health_watcher_admission(
    core: &super::core_lock::MonitoredMutex<termloop_core::CoreRuntime>,
    demands: &Arc<tokio::sync::Mutex<HealthDemandRegistry>>,
    trigger_sender: &mpsc::Sender<HealthTrigger>,
) {
    let (admitted, admitted_branch) = {
        let core = core.lock().await;
        (
            core.admitted_task_worktree_health_keys(),
            core.admitted_branch_commit_watch_keys(),
        )
    };
    let sender = trigger_sender.clone();
    let registry = demands.clone().lock_owned().await;
    let refused = match tokio::task::spawn_blocking(move || {
        let mut registry = registry;
        registry.reconcile_watchers(&admitted, &admitted_branch, &sender)
    })
    .await
    {
        Ok(refused) => refused,
        Err(error) => {
            tracing::error!(%error, "health watcher reconciliation worker failed");
            return;
        }
    };
    for target in refused.health {
        let _ = trigger_sender.try_send(HealthTrigger::Target {
            target,
            unknown: true,
        });
    }
}

fn publish_health_apply(
    applied: (
        Result<termloop_core::task_worktree::ProjectionApply, CoreError>,
        u64,
    ),
    task_id: &str,
    observation_sequence: &AtomicU64,
    invalidations: &broadcast::Sender<ProjectionInvalidatedPayload>,
) {
    if let (Ok(result), state_revision) = applied
        && result.changed
    {
        observation_sequence.fetch_max(result.observation_sequence, Ordering::Relaxed);
        let _ = invalidations.send(ProjectionInvalidatedPayload {
            topics: vec![ProjectionTopic::Task],
            state_revision,
            observation_sequence: result.observation_sequence,
            entity_scopes: Some(vec![TaskProjectionEntityScopeDto {
                topic: TaskProjectionTopic::Task,
                ids: vec![task_id.to_owned()],
            }]),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_scheduler_selects_projects_round_robin_and_fifo() {
        let job = |project: &str, task: &str, ordinal: u64| {
            let key = termloop_core::task_worktree::WorktreeHealthCacheKey {
                repository_common_dir: format!("/common/{task}"),
                worktree_root: format!("/worktree/{task}"),
            };
            ScheduledHealthJob {
                cache_key: key.clone(),
                project_id: project.into(),
                targets: vec![termloop_core::task_worktree::TaskWorktreeWatchTarget {
                    project_id: project.into(),
                    task_id: task.into(),
                    cache_key: key,
                    worktree_root: format!("/worktree/{task}"),
                    repository_common_dir: format!("/common/{task}"),
                }],
                branch_targets: Vec::new(),
                unknown: false,
                registration_token: None,
                git_host_change: false,
                branch_commit_change: false,
                ready_at: Instant::now(),
                ordinal,
            }
        };
        let mut jobs = HashMap::new();
        let mut projects = VecDeque::new();
        merge_health_job(&mut jobs, job("project-a", "a-1", 1), &mut projects);
        merge_health_job(&mut jobs, job("project-a", "a-2", 2), &mut projects);
        merge_health_job(&mut jobs, job("project-b", "b-1", 3), &mut projects);
        let first = take_ready_health_job(&mut jobs, &mut projects, Instant::now()).unwrap();
        let second = take_ready_health_job(&mut jobs, &mut projects, Instant::now()).unwrap();
        let third = take_ready_health_job(&mut jobs, &mut projects, Instant::now()).unwrap();
        assert_eq!(first.targets[0].task_id, "a-1");
        assert_eq!(second.targets[0].task_id, "b-1");
        assert_eq!(third.targets[0].task_id, "a-2");
    }

    #[test]
    fn health_scheduler_does_not_arm_ready_timer_when_worker_slots_are_full() {
        let key = termloop_core::task_worktree::WorktreeHealthCacheKey {
            repository_common_dir: "/common/pending".into(),
            worktree_root: "/worktree/pending".into(),
        };
        let ready_at = Instant::now() - Duration::from_secs(1);
        let pending = HashMap::from([(
            key.clone(),
            ScheduledHealthJob {
                cache_key: key,
                project_id: "project".into(),
                targets: Vec::new(),
                branch_targets: Vec::new(),
                unknown: false,
                registration_token: None,
                git_host_change: false,
                branch_commit_change: false,
                ready_at,
                ordinal: 1,
            },
        )]);

        assert_eq!(health_job_wake_deadline(&pending, 1), Some(ready_at));
        assert_eq!(health_job_wake_deadline(&pending, 2), None);
    }

    #[test]
    fn watcher_registry_ref_counts_shared_demand_and_tears_down_at_last_owner() {
        let directory =
            std::env::temp_dir().join(format!("termloop-server-watch-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let key = termloop_core::task_worktree::WorktreeHealthCacheKey {
            repository_common_dir: directory.display().to_string(),
            worktree_root: directory.display().to_string(),
        };
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let target = |task_id: &str| termloop_core::task_worktree::TaskWorktreeWatchTarget {
            project_id: "project".into(),
            task_id: task_id.into(),
            cache_key: key.clone(),
            worktree_root: key.worktree_root.clone(),
            repository_common_dir: key.repository_common_dir.clone(),
        };
        let first_target = target("task-a");
        let second_target = target("task-b");
        let watcher = termloop_platform::watch_directory(&directory, || {}).unwrap();
        let mut registry = HealthDemandRegistry::default();
        registry.owners.insert(first, vec![first_target]);
        registry.owners.insert(second, vec![second_target]);
        registry
            .owner_projects
            .insert(first, vec!["project".into()]);
        registry
            .owner_projects
            .insert(second, vec!["project".into()]);
        registry.watchers.insert(
            key.clone(),
            HealthWatchEntry {
                _watcher: watcher,
                registration_token: 7,
                owners: HashSet::from([first, second]),
                targets: HashMap::from([
                    (("project".into(), "task-a".into()), HashSet::from([first])),
                    (("project".into(), "task-b".into()), HashSet::from([second])),
                ]),
                branch_targets: HashMap::new(),
            },
        );
        assert_eq!(registry.watch_targets(&key, 7).unwrap().health.len(), 2);
        assert!(registry.watch_targets(&key, 6).is_none());
        registry.remove(first);
        assert_eq!(registry.watchers.len(), 1);
        assert_eq!(registry.watchers[&key].owners, HashSet::from([second]));
        assert_eq!(
            registry.watch_targets(&key, 7).unwrap().health[0].task_id,
            "task-b"
        );
        registry.remove(second);
        assert!(registry.watchers.is_empty());
        assert!(registry.projects().is_empty());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn watcher_lifecycle_is_fenced_by_cache_admission_and_new_tokens() {
        let directory =
            std::env::temp_dir().join(format!("termloop-server-admission-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let key = termloop_core::task_worktree::WorktreeHealthCacheKey {
            repository_common_dir: directory.display().to_string(),
            worktree_root: directory.display().to_string(),
        };
        let owner = Uuid::new_v4();
        let target = termloop_core::task_worktree::TaskWorktreeWatchTarget {
            project_id: "project".into(),
            task_id: "task".into(),
            cache_key: key.clone(),
            worktree_root: key.worktree_root.clone(),
            repository_common_dir: key.repository_common_dir.clone(),
        };
        let (sender, _receiver) = mpsc::channel(8);
        let mut registry = HealthDemandRegistry::default();
        registry.replace_owner_targets(owner, &["project".into()], vec![target], Vec::new());

        registry.reconcile_watchers(&HashSet::new(), &HashSet::new(), &sender);
        assert!(registry.watchers.is_empty());

        registry.reconcile_watchers(&HashSet::from([key.clone()]), &HashSet::new(), &sender);
        let first_token = registry.watchers[&key].registration_token;
        assert!(registry.watch_targets(&key, first_token).is_some());

        // LRU eviction invalidates both the OS handle and delayed callbacks.
        registry.reconcile_watchers(&HashSet::new(), &HashSet::new(), &sender);
        assert!(registry.watchers.is_empty());
        assert!(registry.watch_targets(&key, first_token).is_none());

        // Demand after re-admission receives a fresh registration generation.
        registry.reconcile_watchers(&HashSet::from([key.clone()]), &HashSet::new(), &sender);
        let second_token = registry.watchers[&key].registration_token;
        assert!(second_token > first_token);
        assert!(registry.watch_targets(&key, first_token).is_none());
        assert!(registry.watch_targets(&key, second_token).is_some());

        registry.remove(owner);
        assert!(registry.watchers.is_empty());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn branch_only_demand_uses_the_canonical_watcher_without_health_work() {
        let directory =
            std::env::temp_dir().join(format!("termloop-server-branch-watch-{}", Uuid::new_v4()));
        std::fs::create_dir_all(directory.join(".git")).unwrap();
        let key = termloop_core::task_worktree::WorktreeHealthCacheKey {
            repository_common_dir: directory.join(".git").display().to_string(),
            worktree_root: directory.display().to_string(),
        };
        let owner = Uuid::new_v4();
        let branch_target = termloop_core::task_worktree::TaskBranchCommitWatchTarget {
            project_id: "project".into(),
            task_id: "task".into(),
            cache_key: key.clone(),
        };
        let health_target = termloop_core::task_worktree::TaskWorktreeWatchTarget {
            project_id: "project".into(),
            task_id: "task".into(),
            cache_key: key.clone(),
            worktree_root: key.worktree_root.clone(),
            repository_common_dir: key.repository_common_dir.clone(),
        };
        let (sender, _receiver) = mpsc::channel(8);
        let mut registry = HealthDemandRegistry::default();
        registry.replace_owner_targets(
            owner,
            &["project".into()],
            Vec::new(),
            vec![branch_target.clone()],
        );
        registry.reconcile_watchers(&HashSet::new(), &HashSet::from([key.clone()]), &sender);

        assert_eq!(registry.watchers.len(), 1);
        let token = registry.watchers[&key].registration_token;
        let targets = registry.watch_targets(&key, token).unwrap();
        assert!(targets.health.is_empty());
        assert_eq!(targets.branch.len(), 1);
        assert_eq!(targets.branch[0].task_id, "task");
        assert_eq!(registry.health_registration_token(&health_target), None);
        assert!(
            registry
                .refused_branch_targets(&["project".into()])
                .is_empty()
        );

        registry.replace_owner_targets(
            owner,
            &["project".into()],
            vec![health_target.clone()],
            vec![branch_target],
        );
        registry.reconcile_watchers(
            &HashSet::from([key.clone()]),
            &HashSet::from([key.clone()]),
            &sender,
        );
        assert_eq!(
            registry.health_registration_token(&health_target),
            Some(token)
        );

        registry.remove(owner);
        assert!(registry.watchers.is_empty());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn failed_watcher_registration_reports_branch_only_targets_for_fallback() {
        let directory =
            std::env::temp_dir().join(format!("termloop-server-missing-watch-{}", Uuid::new_v4()));
        let key = termloop_core::task_worktree::WorktreeHealthCacheKey {
            repository_common_dir: directory.join(".git").display().to_string(),
            worktree_root: directory.display().to_string(),
        };
        let owner = Uuid::new_v4();
        let target = termloop_core::task_worktree::TaskBranchCommitWatchTarget {
            project_id: "project".into(),
            task_id: "task".into(),
            cache_key: key.clone(),
        };
        let (sender, _receiver) = mpsc::channel(8);
        let mut registry = HealthDemandRegistry::default();
        registry.replace_owner_targets(owner, &["project".into()], Vec::new(), vec![target]);

        let refused = registry.reconcile_watchers(&HashSet::new(), &HashSet::from([key]), &sender);

        assert!(registry.watchers.is_empty());
        assert!(refused.health.is_empty());
        assert_eq!(refused.branch.len(), 1);
        assert_eq!(refused.branch[0].task_id, "task");
        assert_eq!(
            registry.refused_branch_targets(&["project".into()]).len(),
            1
        );
    }

    #[tokio::test]
    async fn branch_fallback_trigger_schedules_repository_invalidation_without_health_work() {
        let key = termloop_core::task_worktree::WorktreeHealthCacheKey {
            repository_common_dir: "/common/repository".into(),
            worktree_root: "/worktree/repository".into(),
        };
        let target = termloop_core::task_worktree::TaskBranchCommitWatchTarget {
            project_id: "project".into(),
            task_id: "task".into(),
            cache_key: key,
        };
        let demands = Arc::new(tokio::sync::Mutex::new(HealthDemandRegistry::default()));

        let job = resolve_health_trigger(HealthTrigger::BranchTarget { target }, 1, &demands)
            .await
            .expect("branch fallback should schedule");

        assert!(job.targets.is_empty());
        assert_eq!(job.branch_targets.len(), 1);
        assert!(job.branch_commit_change);
        assert!(!job.git_host_change);
        assert!(job.registration_token.is_none());
    }
}
