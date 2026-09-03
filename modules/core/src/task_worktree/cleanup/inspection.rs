use std::path::{Path, PathBuf};

use serde_json::Value;
use termloop_domain::{ManagedWorktreeProof, WorktreeCleanupBlocker, WorktreeCleanupMode};
use termloop_gitio::GitRunner;

use super::super::git_mapping::map_git_observation_error;
use super::super::{
    TaskWorktreeHealthFacts, WorktreeHeadProjectionState, WorktreePathProjectionState,
    WorktreeRegistrationProjectionState,
};
use super::policy::{cleanup_allows_stale_resolution, observation_blocker};
use super::projection::{cleanup_preview_without_observation, cleanup_unknown_preview};
use super::stale::{
    is_generation_zero_legacy_binding, map_stale_platform_error, observe_stale_resolution_facts,
};
use super::{
    CleanupPathState, ObservedTaskWorktreeCleanup, TaskWorktreeCleanupFacts,
    health_facts_from_cleanup,
};
use crate::{CoreError, CoreRuntime, required_string};

pub struct TaskWorktreeCleanupInspectionPlan {
    task: termloop_domain::TaskRecord,
    expected_task_archived_at_epoch_ms: Option<u64>,
    proof: Option<ManagedWorktreeProof>,
    protected_descendants: Vec<PathBuf>,
    protected_overlaps: Vec<PathBuf>,
}

pub enum TaskWorktreeCleanupInspectionPlanning {
    Return(Value),
    Observe(Box<TaskWorktreeCleanupInspectionPlan>),
}

pub struct ObservedTaskWorktreeCleanupInspection {
    task: termloop_domain::TaskRecord,
    expected_task_archived_at_epoch_ms: Option<u64>,
    proof: Option<ManagedWorktreeProof>,
    observation: Result<(TaskWorktreeCleanupFacts, GitRunner), CoreError>,
    stale_target: Result<termloop_platform::StaleDisposalTargetFacts, CoreError>,
}

impl TaskWorktreeCleanupInspectionPlan {
    pub fn project_id(&self) -> &str {
        &self.task.project_id
    }

    pub fn observe(self) -> ObservedTaskWorktreeCleanupInspection {
        let observation =
            GitRunner::discover_with_timeout(termloop_gitio::CLEANUP_GIT_SUBPROCESS_DEADLINE)
                .map_err(map_git_observation_error)
                .and_then(|runner| {
                    observe_stale_resolution_facts(&runner, &self.task, self.proof.as_ref())
                        .map(|facts| (facts, runner.without_absolute_deadline()))
                });
        let target_path = self
            .task
            .worktree
            .as_ref()
            .map(|binding| binding.path.as_str())
            .unwrap_or_default();
        let stale_target = termloop_platform::inspect_stale_disposal_target(
            Path::new(target_path),
            &self.protected_descendants,
            &self.protected_overlaps,
        )
        .map_err(map_stale_platform_error);
        ObservedTaskWorktreeCleanupInspection {
            task: self.task,
            expected_task_archived_at_epoch_ms: self.expected_task_archived_at_epoch_ms,
            proof: self.proof,
            observation,
            stale_target,
        }
    }
}

impl CoreRuntime {
    /// Repository loss cannot authorize recursive disposal, but it need not
    /// strand an exact managed binding: ForgetBinding mutates only durable
    /// Task/proof records and revalidates that tuple again before commit.
    fn cleanup_allows_record_only_forget_after_unknown_observation(
        &self,
        task_id: &str,
        error: &CoreError,
    ) -> bool {
        matches!(error, CoreError::RepositoryUnavailable)
            && self
                .store
                .cleanup_operations()
                .iter()
                .find(|operation| operation.task_id == task_id)
                .is_none_or(cleanup_allows_stale_resolution)
            && !self
                .store
                .provisioning_operations()
                .iter()
                .any(|operation| operation.task_id == task_id)
            && !self
                .store
                .repair_operations()
                .iter()
                .any(|operation| operation.task_id == task_id)
            && !self
                .store
                .stale_resolution_operations()
                .iter()
                .any(|operation| operation.task_id == task_id)
    }

    pub fn plan_task_worktree_cleanup_inspection(
        &self,
        params: Value,
    ) -> Result<TaskWorktreeCleanupInspectionPlanning, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let expected_task_archived_at_epoch_ms = self.ensure_task_cleanup_allowed(&task_id)?;
        if let Some(repair) = self
            .store
            .repair_operations()
            .iter()
            .find(|repair| repair.task_id == task_id)
        {
            return Err(CoreError::RepairInProgress {
                task_id,
                operation_id: repair.operation_id.clone(),
            });
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .cloned();
        if task.worktree.is_none() {
            return Ok(TaskWorktreeCleanupInspectionPlanning::Return(
                cleanup_preview_without_observation(&task, WorktreeCleanupBlocker::NoBinding),
            ));
        }
        if proof.is_none() && !is_generation_zero_legacy_binding(&task, None) {
            return Ok(TaskWorktreeCleanupInspectionPlanning::Return(
                cleanup_preview_without_observation(
                    &task,
                    WorktreeCleanupBlocker::ManagedProofMissing,
                ),
            ));
        }
        let (protected_descendants, protected_overlaps) =
            self.stale_disposal_protected_paths(&task_id)?;
        Ok(TaskWorktreeCleanupInspectionPlanning::Observe(Box::new(
            TaskWorktreeCleanupInspectionPlan {
                task,
                expected_task_archived_at_epoch_ms,
                proof,
                protected_descendants,
                protected_overlaps,
            },
        )))
    }

    pub fn apply_task_worktree_cleanup_inspection(
        &mut self,
        observed: ObservedTaskWorktreeCleanupInspection,
    ) -> Result<Value, CoreError> {
        let current_archived_at = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == observed.task.id)
            .ok_or(CoreError::NotFound)?
            .archived_at_epoch_ms;
        if current_archived_at != observed.expected_task_archived_at_epoch_ms {
            return Err(CoreError::InvalidParams("taskArchiveStateChanged".into()));
        }
        self.ensure_task_cleanup_allowed(&observed.task.id)?;
        let stale_target = observed.stale_target;
        if let Some(proof) = &observed.proof {
            self.ensure_current_cleanup_proof(&observed.task.id, proof)?;
        } else {
            self.ensure_current_unverified_binding(&observed.task)?;
        }
        let (facts, runner) = match observed.observation {
            Ok(value) => value,
            Err(error) => {
                if observed.proof.is_some() {
                    self.apply_task_worktree_health_facts(
                        &observed.task.id,
                        TaskWorktreeHealthFacts::unknown(
                            WorktreePathProjectionState::Unknown,
                            WorktreeRegistrationProjectionState::Unknown,
                            WorktreeHeadProjectionState::Unknown,
                        ),
                        termloop_platform::current_epoch_ms(),
                    )?;
                }
                return Ok(match &observed.proof {
                    Some(proof) => cleanup_unknown_preview(
                        &observed.task,
                        proof,
                        observation_blocker(&error),
                        self.cleanup_allows_record_only_forget_after_unknown_observation(
                            &observed.task.id,
                            &error,
                        ),
                    ),
                    None => cleanup_preview_without_observation(
                        &observed.task,
                        observation_blocker(&error),
                    ),
                });
            }
        };
        if observed.proof.is_none() {
            let presence = match self.refresh_cleanup_presence(&observed.task.id, false) {
                Ok(presence) => presence,
                Err(_) => {
                    return Ok(cleanup_preview_without_observation(
                        &observed.task,
                        WorktreeCleanupBlocker::ObservationFailed,
                    ));
                }
            };
            return Ok(self.unverified_binding_cleanup_preview(
                &observed.task,
                &facts,
                &presence,
                &stale_target,
            ));
        }
        if let Some(health) = facts.health.clone() {
            self.apply_task_worktree_health(
                &observed.task.id,
                health,
                termloop_platform::current_epoch_ms(),
            )?;
        } else {
            self.apply_task_worktree_health_facts(
                &observed.task.id,
                health_facts_from_cleanup(&facts),
                termloop_platform::current_epoch_ms(),
            )?;
        }
        let proof = observed
            .proof
            .expect("managed inspection path checked above");
        let cleanup_observation = ObservedTaskWorktreeCleanup {
            expected_task_archived_at_epoch_ms: observed.expected_task_archived_at_epoch_ms,
            operation_id: String::new(),
            task_id: observed.task.id.clone(),
            expected_managed_worktree_operation_id: proof.operation_id.clone(),
            expected_worktree_generation: proof.worktree_generation,
            cleanup_mode: WorktreeCleanupMode::Safe,
            acknowledged_content_blockers: vec![],
            supersedes_operation_id: None,
            proof,
            facts,
            runner,
        };
        let presence = match self.refresh_cleanup_presence(
            &observed.task.id,
            cleanup_observation.facts.path_state == CleanupPathState::Absent,
        ) {
            Ok(presence) => presence,
            Err(_) => {
                return Ok(cleanup_unknown_preview(
                    &observed.task,
                    &cleanup_observation.proof,
                    WorktreeCleanupBlocker::ObservationFailed,
                    false,
                ));
            }
        };
        let (blockers, warnings) = self.cleanup_policy(&cleanup_observation, &presence, None);
        Ok(self.cleanup_preview(
            &observed.task,
            &cleanup_observation,
            &presence,
            blockers,
            warnings,
            &stale_target,
        ))
    }

    #[cfg(test)]
    pub fn inspect_task_worktree_cleanup(&mut self, params: Value) -> Result<Value, CoreError> {
        match self.plan_task_worktree_cleanup_inspection(params)? {
            TaskWorktreeCleanupInspectionPlanning::Return(value) => Ok(value),
            TaskWorktreeCleanupInspectionPlanning::Observe(plan) => {
                self.apply_task_worktree_cleanup_inspection(plan.observe())
            }
        }
    }
}
