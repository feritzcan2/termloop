use crate::{CoreError, CoreRuntime};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use termloop_domain::{PathComparisonKey, SessionKind};
use termloop_gitio::{
    ChangeState, ContentState, GitRunner, HeadState, LockState, RegisteredPathState,
    SubmoduleFacts, SubmoduleState, UpstreamState, WorktreeHealthObservation, WorktreeStatusFacts,
};

const GLOBAL_HEALTH_CAP: usize = 256;
const PROJECT_HEALTH_CAP: usize = 64;
const ATTACHED_SESSION_CAP: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorktreeHealthCacheKey {
    pub repository_common_dir: String,
    pub worktree_root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeHealthSummary {
    Healthy,
    Attention,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreePathProjectionState {
    Present,
    Absent,
    Replaced,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeRegistrationProjectionState {
    Matching,
    Absent,
    Mismatch,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeHeadProjectionState {
    Matching,
    Mismatch,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskWorktreeHealthFacts {
    pub path_state: WorktreePathProjectionState,
    pub registration_state: WorktreeRegistrationProjectionState,
    pub head_state: WorktreeHeadProjectionState,
    pub launch_ready: bool,
    pub checked_out_branch: Option<String>,
    pub status: WorktreeStatusFacts,
}

impl TaskWorktreeHealthFacts {
    pub fn unknown(
        path_state: WorktreePathProjectionState,
        registration_state: WorktreeRegistrationProjectionState,
        head_state: WorktreeHeadProjectionState,
    ) -> Self {
        Self {
            path_state,
            registration_state,
            head_state,
            launch_ready: false,
            checked_out_branch: None,
            status: WorktreeStatusFacts {
                change_count: None,
                tracked: ChangeState::Unknown,
                staged: ChangeState::Unknown,
                untracked: ContentState::Unknown,
                ignored: ContentState::Unknown,
                submodules: SubmoduleFacts {
                    state: SubmoduleState::Unknown,
                    tracked_gitlinks: 0,
                    initialized_gitlinks: 0,
                },
                worktree_lock: LockState::Unknown,
                index_lock: LockState::Unknown,
                upstream: UpstreamState::Unknown,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedTaskWorktreeHealth {
    pub task_id: String,
    pub project_id: String,
    pub worktree_generation: u64,
    pub managed_worktree_operation_id: String,
    pub observation_sequence: u64,
    pub observed_at_epoch_ms: u64,
    pub path_state: WorktreePathProjectionState,
    pub registration_state: WorktreeRegistrationProjectionState,
    pub head_state: WorktreeHeadProjectionState,
    pub launch_ready: bool,
    pub checked_out_branch: Option<String>,
    pub summary: WorktreeHealthSummary,
    pub status: WorktreeStatusFacts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachedTaskSession {
    pub session_id: String,
    pub kind: SessionKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskWorktreePresence {
    pub observation_sequence: u64,
    pub observed_at_epoch_ms: u64,
    pub attached_sessions: Vec<AttachedTaskSession>,
    pub total_count: u32,
    pub terminal_count: u32,
    pub agent_count: u32,
    pub truncated: bool,
}

struct TaskWorktreePresenceFacts {
    attached_sessions: Vec<AttachedTaskSession>,
    total_count: u32,
    terminal_count: u32,
    agent_count: u32,
    truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectionApply {
    pub changed: bool,
    pub observation_sequence: u64,
}

#[derive(Clone)]
pub struct TaskWorktreeHealthPlan {
    task_id: String,
    proof: termloop_domain::ManagedWorktreeProof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskWorktreeWatchTarget {
    pub project_id: String,
    pub task_id: String,
    pub cache_key: WorktreeHealthCacheKey,
    pub worktree_root: String,
    pub repository_common_dir: String,
}

pub struct ObservedTaskWorktreeHealth {
    task_id: String,
    proof: termloop_domain::ManagedWorktreeProof,
    observation: Result<WorktreeHealthObservation, CoreError>,
}

impl TaskWorktreeHealthPlan {
    pub fn observe(self) -> ObservedTaskWorktreeHealth {
        let observation = self.observe_shared();
        self.with_observation(observation)
    }

    /// Observes the canonical checkout once. The resulting Git facts are not
    /// Task-specific and may be applied to every Task that still owns the same
    /// proof tuple.
    pub fn observe_shared(&self) -> Result<WorktreeHealthObservation, CoreError> {
        GitRunner::discover_with_timeout(termloop_gitio::HEALTH_GIT_SUBPROCESS_DEADLINE)
            .map_err(super::git_mapping::map_git_observation_error)
            .and_then(|runner| {
                runner
                    .inspect_worktree_health(Path::new(&self.proof.registered_worktree_path))
                    .map_err(super::git_mapping::map_git_observation_error)
            })
    }

    pub fn with_observation(
        self,
        observation: Result<WorktreeHealthObservation, CoreError>,
    ) -> ObservedTaskWorktreeHealth {
        ObservedTaskWorktreeHealth {
            task_id: self.task_id,
            proof: self.proof,
            observation,
        }
    }
}

#[derive(Default)]
pub(crate) struct WorktreeProjectionCache {
    // Git observations are scheduled once per canonical key, but their
    // expected branch/proof interpretation is Task-specific. Never let one
    // Task overwrite another Task that points at the same checkout.
    entries: HashMap<String, CachedTaskWorktreeHealth>,
    task_keys: HashMap<String, WorktreeHealthCacheKey>,
    health_lru: VecDeque<String>,
    presence: HashMap<String, TaskWorktreePresence>,
    presence_projects: HashMap<String, String>,
    presence_lru: VecDeque<String>,
    next_sequence: u64,
}

impl WorktreeProjectionCache {
    fn next_sequence(&mut self) -> Result<u64, CoreError> {
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| CoreError::Store("observation sequence overflow".into()))?;
        Ok(self.next_sequence)
    }

    fn touch(&mut self, task_id: &str) {
        self.health_lru.retain(|candidate| candidate != task_id);
        self.health_lru.push_back(task_id.to_owned());
    }

    fn remove_task(&mut self, task_id: &str) {
        self.entries.remove(task_id);
        self.task_keys.remove(task_id);
        self.health_lru.retain(|candidate| candidate != task_id);
    }

    fn enforce_bounds(&mut self, project_id: &str) {
        while self
            .entries
            .values()
            .filter(|entry| entry.project_id == project_id)
            .count()
            > PROJECT_HEALTH_CAP
        {
            let victim = self.health_lru.iter().find_map(|task_id| {
                self.entries
                    .get(task_id)
                    .is_some_and(|entry| entry.project_id == project_id)
                    .then(|| task_id.clone())
            });
            if let Some(victim) = victim {
                self.remove_task(&victim);
            } else {
                break;
            }
        }
        while self.entries.len() > GLOBAL_HEALTH_CAP {
            if let Some(victim) = self.health_lru.front().cloned() {
                self.remove_task(&victim);
            } else {
                break;
            }
        }
    }

    fn touch_presence(&mut self, task_id: &str) {
        self.presence_lru.retain(|candidate| candidate != task_id);
        self.presence_lru.push_back(task_id.to_owned());
    }

    fn remove_presence(&mut self, task_id: &str) {
        self.presence.remove(task_id);
        self.presence_projects.remove(task_id);
        self.presence_lru.retain(|candidate| candidate != task_id);
    }

    fn enforce_presence_bounds(&mut self, project_id: &str) {
        while self
            .presence_projects
            .values()
            .filter(|project| project.as_str() == project_id)
            .count()
            > PROJECT_HEALTH_CAP
        {
            let victim = self.presence_lru.iter().find(|task_id| {
                self.presence_projects
                    .get(*task_id)
                    .is_some_and(|project| project == project_id)
            });
            if let Some(victim) = victim.cloned() {
                self.remove_presence(&victim);
            } else {
                break;
            }
        }
        while self.presence.len() > GLOBAL_HEALTH_CAP {
            if let Some(victim) = self.presence_lru.front().cloned() {
                self.remove_presence(&victim);
            } else {
                break;
            }
        }
    }
}

impl CoreRuntime {
    pub fn next_observation_sequence(&mut self) -> Result<u64, CoreError> {
        self.worktree_projections.next_sequence()
    }

    pub fn observation_sequence(&self) -> u64 {
        self.worktree_projections.next_sequence
    }

    pub fn refresh_task_worktree_presence_for_cwd(
        &mut self,
        cwd: &Path,
        observed_at_epoch_ms: u64,
    ) -> Result<Vec<(String, ProjectionApply)>, CoreError> {
        let cwd_key = comparison_key(cwd)?;
        let task_ids = self
            .store
            .tasks()
            .iter()
            .filter_map(|task| {
                let worktree = task.worktree.as_ref()?;
                comparison_key(Path::new(&worktree.path))
                    .is_ok_and(|target| target.contains_or_equals(&cwd_key))
                    .then(|| task.id.clone())
            })
            .collect::<Vec<_>>();
        task_ids
            .into_iter()
            .map(|task_id| {
                self.observe_task_worktree_presence(&task_id, observed_at_epoch_ms)
                    .map(|applied| (task_id, applied))
            })
            .collect()
    }

    pub fn task_worktree_watch_targets(
        &self,
        project_ids: &[String],
    ) -> Vec<TaskWorktreeWatchTarget> {
        self.store
            .managed_worktrees()
            .iter()
            .filter_map(|proof| {
                let task = self
                    .store
                    .tasks()
                    .iter()
                    .find(|task| task.id == proof.task_id)?;
                project_ids
                    .iter()
                    .any(|project| project == &task.project_id)
                    .then(|| TaskWorktreeWatchTarget {
                        project_id: task.project_id.clone(),
                        task_id: task.id.clone(),
                        cache_key: WorktreeHealthCacheKey {
                            repository_common_dir: proof.repository_common_dir.clone(),
                            worktree_root: proof.registered_worktree_path.clone(),
                        },
                        worktree_root: proof.registered_worktree_path.clone(),
                        repository_common_dir: proof.repository_common_dir.clone(),
                    })
            })
            .collect()
    }

    pub fn task_worktree_health_cache_misses(
        &self,
        project_ids: &[String],
    ) -> Vec<TaskWorktreeWatchTarget> {
        self.task_worktree_watch_targets(project_ids)
            .into_iter()
            .filter(|target| self.cached_task_worktree_health(&target.task_id).is_none())
            .collect()
    }

    /// Canonical keys with at least one admitted Task-specific projection.
    /// Server watcher ownership is reconciled against this bounded set.
    pub fn admitted_task_worktree_health_keys(&self) -> HashSet<WorktreeHealthCacheKey> {
        self.worktree_projections
            .task_keys
            .values()
            .cloned()
            .collect()
    }

    pub fn filter_task_ids_for_projects(
        &self,
        task_ids: &[String],
        project_ids: &[String],
    ) -> Vec<String> {
        task_ids
            .iter()
            .filter(|task_id| {
                self.store
                    .tasks()
                    .iter()
                    .any(|task| task.id == **task_id && project_ids.contains(&task.project_id))
            })
            .cloned()
            .collect()
    }

    pub fn apply_unknown_task_worktree_health(
        &mut self,
        task_id: &str,
        observed_at_epoch_ms: u64,
    ) -> Result<ProjectionApply, CoreError> {
        self.apply_task_worktree_health_facts(
            task_id,
            TaskWorktreeHealthFacts::unknown(
                WorktreePathProjectionState::Unknown,
                WorktreeRegistrationProjectionState::Unknown,
                WorktreeHeadProjectionState::Unknown,
            ),
            observed_at_epoch_ms,
        )
    }

    pub fn plan_task_worktree_health(
        &self,
        task_id: &str,
    ) -> Result<TaskWorktreeHealthPlan, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .cloned()
            .ok_or(CoreError::WorktreeRequired)?;
        if task.worktree_generation != proof.worktree_generation {
            return Err(CoreError::ManagedWorktreeProofChanged {
                task_id: task_id.to_owned(),
                current_managed_worktree_operation_id: Some(proof.operation_id),
                current_worktree_generation: task.worktree_generation,
            });
        }
        Ok(TaskWorktreeHealthPlan {
            task_id: task_id.to_owned(),
            proof,
        })
    }

    pub fn apply_observed_task_worktree_health(
        &mut self,
        observed: ObservedTaskWorktreeHealth,
        observed_at_epoch_ms: u64,
    ) -> Result<ProjectionApply, CoreError> {
        let current = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == observed.task_id);
        if current != Some(&observed.proof) {
            let current_worktree_generation = self
                .store
                .tasks()
                .iter()
                .find(|task| task.id == observed.task_id)
                .map_or(0, |task| task.worktree_generation);
            return Err(CoreError::ManagedWorktreeProofChanged {
                task_id: observed.task_id,
                current_managed_worktree_operation_id: current
                    .map(|proof| proof.operation_id.clone()),
                current_worktree_generation,
            });
        }
        match observed.observation {
            Ok(observation) => self.apply_task_worktree_health(
                &observed.task_id,
                observation,
                observed_at_epoch_ms,
            ),
            Err(_) => self.apply_task_worktree_health_facts(
                &observed.task_id,
                TaskWorktreeHealthFacts::unknown(
                    WorktreePathProjectionState::Unknown,
                    WorktreeRegistrationProjectionState::Unknown,
                    WorktreeHeadProjectionState::Unknown,
                ),
                observed_at_epoch_ms,
            ),
        }
    }

    pub fn apply_task_worktree_health(
        &mut self,
        task_id: &str,
        observation: WorktreeHealthObservation,
        observed_at_epoch_ms: u64,
    ) -> Result<ProjectionApply, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .ok_or_else(|| CoreError::ManagedWorktreeProofChanged {
                task_id: task_id.to_owned(),
                current_managed_worktree_operation_id: None,
                current_worktree_generation: task.worktree_generation,
            })?;
        let root = observation
            .repository
            .worktree_root
            .as_ref()
            .and_then(|path| path.to_str())
            .ok_or(CoreError::RepositoryUnavailable)?;
        let common_dir = observation
            .repository
            .common_dir
            .to_str()
            .ok_or(CoreError::RepositoryUnavailable)?;
        if task.worktree.as_ref().map(|binding| binding.path.as_str()) != Some(root)
            || proof.registered_worktree_path != root
            || proof.repository_common_dir != common_dir
            || proof.worktree_generation != task.worktree_generation
        {
            return Err(CoreError::ManagedWorktreeProofChanged {
                task_id: task_id.to_owned(),
                current_managed_worktree_operation_id: Some(proof.operation_id.clone()),
                current_worktree_generation: task.worktree_generation,
            });
        }
        let path_state = WorktreePathProjectionState::Present;
        let registration_state = match &observation.registration {
            None => WorktreeRegistrationProjectionState::Absent,
            Some(registration)
                if registration.registered_path == Path::new(&proof.registered_worktree_path)
                    && matches!(
                        &registration.path_state,
                        RegisteredPathState::Present { canonical_path }
                            if canonical_path == Path::new(root)
                    ) =>
            {
                WorktreeRegistrationProjectionState::Matching
            }
            Some(_) => WorktreeRegistrationProjectionState::Mismatch,
        };
        let head_state = match &observation.repository.head {
            HeadState::Attached { branch, .. }
                if branch.as_bytes() == proof.branch_ref.as_bytes() =>
            {
                WorktreeHeadProjectionState::Matching
            }
            HeadState::Attached { .. } | HeadState::Detached { .. } => {
                WorktreeHeadProjectionState::Mismatch
            }
            HeadState::Unborn { .. } => WorktreeHeadProjectionState::Missing,
        };
        // Launch readiness is registration identity only. HEAD attachment,
        // the checked-out branch, and registration/HEAD agreement
        // are live Git projections that never gate Task-scoped launch;
        // cleanup, stale disposal, and repair keep their own branch/HEAD
        // proofs.
        let launch_ready = registration_state == WorktreeRegistrationProjectionState::Matching;
        let checked_out_branch = match &observation.repository.head {
            HeadState::Attached { branch, .. } => local_branch_display_name(branch.as_bytes()),
            _ => None,
        };
        self.apply_task_worktree_health_facts(
            task_id,
            TaskWorktreeHealthFacts {
                path_state,
                registration_state,
                head_state,
                launch_ready,
                checked_out_branch,
                status: observation.status,
            },
            observed_at_epoch_ms,
        )
    }

    /// Applies a normalized identity/status result. Unlike a successful Git
    /// observation this surface can explicitly replace a stale healthy entry
    /// with absent, replaced, or unknown facts.
    pub fn apply_task_worktree_health_facts(
        &mut self,
        task_id: &str,
        facts: TaskWorktreeHealthFacts,
        observed_at_epoch_ms: u64,
    ) -> Result<ProjectionApply, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .ok_or_else(|| CoreError::ManagedWorktreeProofChanged {
                task_id: task_id.to_owned(),
                current_managed_worktree_operation_id: None,
                current_worktree_generation: task.worktree_generation,
            })?;
        if task.worktree.as_ref().map(|binding| binding.path.as_str())
            != Some(proof.registered_worktree_path.as_str())
            || proof.worktree_generation != task.worktree_generation
        {
            return Err(CoreError::ManagedWorktreeProofChanged {
                task_id: task_id.to_owned(),
                current_managed_worktree_operation_id: Some(proof.operation_id.clone()),
                current_worktree_generation: task.worktree_generation,
            });
        }
        let key = WorktreeHealthCacheKey {
            repository_common_dir: proof.repository_common_dir.clone(),
            worktree_root: proof.registered_worktree_path.clone(),
        };
        let summary = health_summary(&facts);
        if let Some(existing) = self.worktree_projections.entries.get_mut(task_id)
            && existing.worktree_generation == task.worktree_generation
            && existing.managed_worktree_operation_id == proof.operation_id
            && existing.status == facts.status
            && existing.path_state == facts.path_state
            && existing.registration_state == facts.registration_state
            && existing.head_state == facts.head_state
            && existing.launch_ready == facts.launch_ready
            && existing.checked_out_branch == facts.checked_out_branch
            && existing.summary == summary
        {
            existing.observed_at_epoch_ms = observed_at_epoch_ms;
            let sequence = existing.observation_sequence;
            self.worktree_projections.touch(task_id);
            return Ok(ProjectionApply {
                changed: false,
                observation_sequence: sequence,
            });
        }
        self.worktree_projections.remove_task(task_id);
        let sequence = self.worktree_projections.next_sequence()?;
        self.worktree_projections.entries.insert(
            task_id.to_owned(),
            CachedTaskWorktreeHealth {
                task_id: task_id.to_owned(),
                project_id: task.project_id.clone(),
                worktree_generation: task.worktree_generation,
                managed_worktree_operation_id: proof.operation_id.clone(),
                observation_sequence: sequence,
                observed_at_epoch_ms,
                path_state: facts.path_state,
                registration_state: facts.registration_state,
                head_state: facts.head_state,
                launch_ready: facts.launch_ready,
                checked_out_branch: facts.checked_out_branch,
                summary,
                status: facts.status,
            },
        );
        self.worktree_projections
            .task_keys
            .insert(task_id.to_owned(), key.clone());
        self.worktree_projections.touch(task_id);
        self.worktree_projections.enforce_bounds(&task.project_id);
        Ok(ProjectionApply {
            changed: true,
            observation_sequence: sequence,
        })
    }

    pub fn cached_task_worktree_health(&self, task_id: &str) -> Option<&CachedTaskWorktreeHealth> {
        self.worktree_projections.entries.get(task_id)
    }

    pub fn observe_task_worktree_presence(
        &mut self,
        task_id: &str,
        observed_at_epoch_ms: u64,
    ) -> Result<ProjectionApply, CoreError> {
        let (target, project_id) = {
            let task = self
                .store
                .tasks()
                .iter()
                .find(|task| task.id == task_id)
                .ok_or(CoreError::NotFound)?;
            (
                task.worktree
                    .as_ref()
                    .ok_or(CoreError::WorktreeRequired)?
                    .path
                    .clone(),
                task.project_id.clone(),
            )
        };
        let facts = self.task_worktree_presence_facts(Path::new(&target))?;
        let attached = facts.attached_sessions;
        let total_count = facts.total_count;
        let terminal_count = facts.terminal_count;
        let agent_count = facts.agent_count;
        let truncated = facts.truncated;
        let semantic = (total_count, terminal_count, agent_count, truncated);
        if let Some(existing) = self.worktree_projections.presence.get_mut(task_id)
            && existing.attached_sessions == attached
            && (
                existing.total_count,
                existing.terminal_count,
                existing.agent_count,
                existing.truncated,
            ) == semantic
        {
            existing.observed_at_epoch_ms = observed_at_epoch_ms;
            let sequence = existing.observation_sequence;
            self.worktree_projections.touch_presence(task_id);
            return Ok(ProjectionApply {
                changed: false,
                observation_sequence: sequence,
            });
        }
        let sequence = self.worktree_projections.next_sequence()?;
        self.worktree_projections.presence.insert(
            task_id.to_owned(),
            TaskWorktreePresence {
                observation_sequence: sequence,
                observed_at_epoch_ms,
                attached_sessions: attached,
                total_count,
                terminal_count,
                agent_count,
                truncated,
            },
        );
        self.worktree_projections
            .presence_projects
            .insert(task_id.to_owned(), project_id.clone());
        self.worktree_projections.touch_presence(task_id);
        self.worktree_projections
            .enforce_presence_bounds(&project_id);
        Ok(ProjectionApply {
            changed: true,
            observation_sequence: sequence,
        })
    }

    fn task_worktree_presence_facts(
        &self,
        target: &Path,
    ) -> Result<TaskWorktreePresenceFacts, CoreError> {
        let target_key = comparison_key(target)?;
        let mut attached = Vec::new();
        let mut terminal_count = 0_u32;
        let mut agent_count = 0_u32;
        for session in self.store.sessions().iter().filter(|session| {
            session.lifecycle_state == "running"
                || (session.lifecycle_state == "resuming"
                    && self.resume_reservations.contains(&session.id))
                || self
                    .provider_history_repair_reservations
                    .contains(&session.id)
        }) {
            let contained = comparison_key(Path::new(&session.process.cwd))
                .is_ok_and(|cwd| target_key.contains_or_equals(&cwd));
            if !contained {
                continue;
            }
            match session.kind {
                SessionKind::Terminal => terminal_count = terminal_count.saturating_add(1),
                SessionKind::Agent => agent_count = agent_count.saturating_add(1),
            }
            attached.push(AttachedTaskSession {
                session_id: session.id.clone(),
                kind: session.kind.clone(),
            });
        }
        attached.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        let total_count = terminal_count.saturating_add(agent_count);
        let truncated = attached.len() > ATTACHED_SESSION_CAP;
        attached.truncate(ATTACHED_SESSION_CAP);
        Ok(TaskWorktreePresenceFacts {
            attached_sessions: attached,
            total_count,
            terminal_count,
            agent_count,
            truncated,
        })
    }

    pub fn cached_task_worktree_presence(&self, task_id: &str) -> Option<&TaskWorktreePresence> {
        self.worktree_projections.presence.get(task_id)
    }

    pub(crate) fn clear_task_worktree_projections(&mut self, task_id: &str) {
        self.worktree_projections.remove_task(task_id);
        self.worktree_projections.remove_presence(task_id);
    }
}

pub(crate) fn comparison_key(path: &Path) -> Result<PathComparisonKey, CoreError> {
    let input = termloop_platform::existing_directory_comparison_input(path)
        .map_err(|_| CoreError::RepositoryUnavailable)?;
    PathComparisonKey::from_normalized_parts(input.root().to_vec(), input.segments().to_vec())
        .map_err(|_| CoreError::RepositoryUnavailable)
}

fn health_summary(facts: &TaskWorktreeHealthFacts) -> WorktreeHealthSummary {
    let status = &facts.status;
    if status.tracked == ChangeState::Unknown
        || status.staged == ChangeState::Unknown
        || status.untracked == ContentState::Unknown
        || status.ignored == ContentState::Unknown
        || status.submodules.state == SubmoduleState::Unknown
        || status.worktree_lock == LockState::Unknown
        || status.index_lock == LockState::Unknown
        || matches!(status.upstream, UpstreamState::Unknown)
        || facts.path_state == WorktreePathProjectionState::Unknown
        || facts.registration_state == WorktreeRegistrationProjectionState::Unknown
        || facts.head_state == WorktreeHeadProjectionState::Unknown
    {
        WorktreeHealthSummary::Unknown
    } else if status.tracked == ChangeState::Changed
        || status.staged == ChangeState::Changed
        || status.untracked == ContentState::Present
        || status.ignored == ContentState::Present
        || matches!(
            status.submodules.state,
            SubmoduleState::InitializedClean | SubmoduleState::InitializedDirty
        )
        || status.worktree_lock == LockState::Present
        || status.index_lock == LockState::Present
        || facts.path_state != WorktreePathProjectionState::Present
        || facts.registration_state != WorktreeRegistrationProjectionState::Matching
        || facts.head_state != WorktreeHeadProjectionState::Matching
    {
        WorktreeHealthSummary::Attention
    } else {
        WorktreeHealthSummary::Healthy
    }
}

fn local_branch_display_name(reference: &[u8]) -> Option<String> {
    let short = reference.strip_prefix(b"refs/heads/")?;
    (!short.is_empty())
        .then(|| String::from_utf8(short.to_vec()).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use termloop_gitio::{
        GitRefName, HeadState, ObjectId, RepositoryFacts, SubmoduleFacts, WorktreeStatusFacts,
    };

    fn observation(index: usize) -> WorktreeHealthObservation {
        WorktreeHealthObservation {
            repository: RepositoryFacts {
                requested_path: PathBuf::from(format!("/worktree/{index}")),
                resolved_path: PathBuf::from(format!("/worktree/{index}")),
                git_dir: PathBuf::from(format!("/git/{index}")),
                common_dir: PathBuf::from(format!("/common/{index}")),
                worktree_root: Some(PathBuf::from(format!("/worktree/{index}"))),
                bare: false,
                head: HeadState::Attached {
                    branch: GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap(),
                    oid: ObjectId::from_hex(b"0123456789012345678901234567890123456789".to_vec())
                        .unwrap(),
                },
            },
            registration: None,
            status: WorktreeStatusFacts {
                change_count: Some(0),
                tracked: ChangeState::Clean,
                staged: ChangeState::Clean,
                untracked: ContentState::Absent,
                ignored: ContentState::Absent,
                submodules: SubmoduleFacts {
                    state: SubmoduleState::Absent,
                    tracked_gitlinks: 0,
                    initialized_gitlinks: 0,
                },
                worktree_lock: LockState::Absent,
                index_lock: LockState::Absent,
                upstream: UpstreamState::InSync,
            },
            git_process_count: 0,
        }
    }

    #[test]
    fn current_branch_display_requires_a_local_lossless_ref() {
        assert_eq!(
            local_branch_display_name(b"refs/heads/agent/current"),
            Some("agent/current".into())
        );
        assert_eq!(local_branch_display_name(b"refs/tags/current"), None);
        assert_eq!(local_branch_display_name(b"refs/heads/\xff"), None);
    }

    fn insert(cache: &mut WorktreeProjectionCache, project: &str, index: usize) {
        let key = WorktreeHealthCacheKey {
            repository_common_dir: format!("/common/{index}"),
            worktree_root: format!("/worktree/{index}"),
        };
        let task_id = format!("task-{index}");
        cache.entries.insert(
            task_id.clone(),
            CachedTaskWorktreeHealth {
                task_id: task_id.clone(),
                project_id: project.into(),
                worktree_generation: 1,
                managed_worktree_operation_id: format!("proof-{index}"),
                observation_sequence: index as u64,
                observed_at_epoch_ms: index as u64,
                path_state: WorktreePathProjectionState::Present,
                registration_state: WorktreeRegistrationProjectionState::Matching,
                head_state: WorktreeHeadProjectionState::Matching,
                launch_ready: true,
                checked_out_branch: Some("main".into()),
                summary: WorktreeHealthSummary::Healthy,
                status: observation(index).status,
            },
        );
        cache.task_keys.insert(task_id.clone(), key);
        cache.touch(&task_id);
    }

    fn insert_presence(cache: &mut WorktreeProjectionCache, project: &str, index: usize) {
        let task_id = format!("presence-task-{index}");
        cache.presence.insert(
            task_id.clone(),
            TaskWorktreePresence {
                observation_sequence: index as u64,
                observed_at_epoch_ms: index as u64,
                attached_sessions: vec![],
                total_count: 0,
                terminal_count: 0,
                agent_count: 0,
                truncated: false,
            },
        );
        cache
            .presence_projects
            .insert(task_id.clone(), project.into());
        cache.touch_presence(&task_id);
    }

    #[test]
    fn health_cache_enforces_project_and_global_lru_bounds() {
        let mut cache = WorktreeProjectionCache::default();
        for index in 0..65 {
            insert(&mut cache, "project-a", index);
        }
        cache.enforce_bounds("project-a");
        assert_eq!(cache.entries.len(), PROJECT_HEALTH_CAP);
        assert!(
            !cache
                .task_keys
                .values()
                .any(|key| key.worktree_root == "/worktree/0")
        );

        for index in 65..=GLOBAL_HEALTH_CAP + 1 {
            insert(&mut cache, &format!("project-{index}"), index);
        }
        cache.enforce_bounds("unused");
        assert_eq!(cache.entries.len(), GLOBAL_HEALTH_CAP);
        assert_eq!(cache.entries.len(), cache.task_keys.len());
        assert_eq!(cache.entries.len(), cache.health_lru.len());

        for index in 0..65 {
            insert_presence(&mut cache, "project-a", index);
        }
        cache.enforce_presence_bounds("project-a");
        assert_eq!(cache.presence.len(), PROJECT_HEALTH_CAP);
        assert_eq!(cache.presence.len(), cache.presence_projects.len());
        assert_eq!(cache.presence.len(), cache.presence_lru.len());
    }

    #[test]
    fn shared_canonical_key_keeps_task_specific_projections_independent() {
        let mut cache = WorktreeProjectionCache::default();
        let key = WorktreeHealthCacheKey {
            repository_common_dir: "/common/shared".into(),
            worktree_root: "/worktree/shared".into(),
        };
        for (task_id, summary, head_state) in [
            (
                "task-matching",
                WorktreeHealthSummary::Healthy,
                WorktreeHeadProjectionState::Matching,
            ),
            (
                "task-mismatch",
                WorktreeHealthSummary::Attention,
                WorktreeHeadProjectionState::Mismatch,
            ),
        ] {
            cache.entries.insert(
                task_id.into(),
                CachedTaskWorktreeHealth {
                    task_id: task_id.into(),
                    project_id: "project".into(),
                    worktree_generation: 1,
                    managed_worktree_operation_id: format!("proof-{task_id}"),
                    observation_sequence: 1,
                    observed_at_epoch_ms: 1,
                    path_state: WorktreePathProjectionState::Present,
                    registration_state: WorktreeRegistrationProjectionState::Matching,
                    head_state,
                    launch_ready: head_state == WorktreeHeadProjectionState::Matching,
                    checked_out_branch: (head_state == WorktreeHeadProjectionState::Matching)
                        .then(|| "main".into()),
                    summary,
                    status: observation(0).status,
                },
            );
            cache.task_keys.insert(task_id.into(), key.clone());
            cache.touch(task_id);
        }

        assert_eq!(cache.entries.len(), 2);
        assert_eq!(cache.task_keys.values().collect::<HashSet<_>>().len(), 1);
        assert_eq!(
            cache.entries["task-matching"].summary,
            WorktreeHealthSummary::Healthy
        );
        assert_eq!(
            cache.entries["task-mismatch"].summary,
            WorktreeHealthSummary::Attention
        );
        cache.remove_task("task-matching");
        assert!(cache.entries.contains_key("task-mismatch"));
        assert_eq!(cache.task_keys["task-mismatch"], key);
    }
}
