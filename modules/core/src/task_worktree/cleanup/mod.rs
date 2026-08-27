use super::TaskWorktreePresence;
use super::git_mapping::{map_git_observation_error, worktree_registered_at};
use crate::{CoreError, CoreRuntime, store_error};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use termloop_domain::{
    ManagedWorktreeProof, WorktreeCleanupBlocker, WorktreeCleanupFailure,
    WorktreeCleanupFailureKind, WorktreeCleanupOperation,
};
use termloop_gitio::{
    GitRefName, GitRunner, HeadState, WorktreeCheckout, WorktreeHealthObservation,
    WorktreeObservationBudget,
};

mod inspection;
mod policy;
mod projection;
mod reconcile;
mod saga;
mod stale;

pub use reconcile::TaskWorktreeCleanupRecoveryPlan;

pub use saga::{
    ExecutedTaskWorktreeCleanupRemoval, ObservedTaskWorktreeCleanup,
    TaskWorktreeCleanupFinalization, TaskWorktreeCleanupObservationStep, TaskWorktreeCleanupPlan,
    TaskWorktreeCleanupPlanning, TaskWorktreeCleanupProgress, TaskWorktreeCleanupRemovalStep,
};

pub use stale::{
    ExecutedTaskWorktreeStaleDisposal, ObservedTaskWorktreeStaleForget,
    ObservedTaskWorktreeStaleResolution, TaskWorktreeStaleDisposalStep,
    TaskWorktreeStaleForgetStep, TaskWorktreeStaleResolutionPlan,
    TaskWorktreeStaleResolutionPlanning, TaskWorktreeStaleResolutionProgress,
};

pub use inspection::{
    ObservedTaskWorktreeCleanupInspection, TaskWorktreeCleanupInspectionPlan,
    TaskWorktreeCleanupInspectionPlanning,
};

use policy::{
    both_absent, cleanup_allows_record_only_forget, health_facts_from_cleanup, proof_changed,
};
use stale::stale_resolution_target_kind;

pub use projection::{cleanup_blocker_name, stale_resolution_blocker_name};
pub(super) use projection::{
    cleanup_operation_json, health_json, presence_json, stale_resolution_operation_json,
};
use projection::{destructive_cleanup_json, stale_resolution_json, warning_name};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupPathState {
    Present,
    Absent,
    Replaced,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupRegistrationState {
    Matching,
    Absent,
    Mismatch,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupWarning {
    UpstreamBehind,
    UpstreamAhead,
    UpstreamDiverged,
    UpstreamNotConfigured,
    UpstreamMissing,
    UpstreamUnknown,
}

#[derive(Debug, Clone)]
pub struct TaskWorktreeCleanupFacts {
    pub path_state: CleanupPathState,
    pub registration_state: CleanupRegistrationState,
    pub branch_matches: Option<bool>,
    pub head_matches: Option<bool>,
    pub alternate_checkout_matches: bool,
    pub head_oid: Option<String>,
    pub health: Option<WorktreeHealthObservation>,
}

impl CoreRuntime {
    fn refresh_cleanup_presence(
        &mut self,
        task_id: &str,
        path_is_proven_absent: bool,
    ) -> Result<TaskWorktreePresence, CoreError> {
        if path_is_proven_absent {
            return Ok(TaskWorktreePresence {
                observation_sequence: 0,
                observed_at_epoch_ms: termloop_platform::current_epoch_ms(),
                attached_sessions: vec![],
                total_count: 0,
                terminal_count: 0,
                agent_count: 0,
                truncated: false,
            });
        }
        self.observe_task_worktree_presence(task_id, termloop_platform::current_epoch_ms())?;
        self.cached_task_worktree_presence(task_id)
            .cloned()
            .ok_or_else(|| CoreError::Store("presence projection was not captured".into()))
    }

    fn cache_cleanup_health(
        &mut self,
        observed: &ObservedTaskWorktreeCleanup,
    ) -> Result<(), CoreError> {
        if let Some(health) = observed.facts.health.clone() {
            self.apply_task_worktree_health(
                &observed.task_id,
                health,
                termloop_platform::current_epoch_ms(),
            )?;
        } else {
            self.apply_task_worktree_health_facts(
                &observed.task_id,
                health_facts_from_cleanup(&observed.facts),
                termloop_platform::current_epoch_ms(),
            )?;
        }
        Ok(())
    }

    fn ensure_observed_cleanup_tuple(
        &self,
        observed: &ObservedTaskWorktreeCleanup,
    ) -> Result<(), CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == observed.task_id)
            .ok_or(CoreError::NotFound)?;
        if task.archived_at_epoch_ms != observed.expected_task_archived_at_epoch_ms {
            return Err(CoreError::InvalidParams("taskArchiveStateChanged".into()));
        }
        self.ensure_task_cleanup_allowed(&observed.task_id)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == observed.task_id);
        if task.worktree_generation == observed.expected_worktree_generation
            && proof.is_some_and(|proof| {
                proof.worktree_generation == observed.expected_worktree_generation
                    && proof.operation_id == observed.expected_managed_worktree_operation_id
                    && proof == &observed.proof
            })
        {
            Ok(())
        } else {
            Err(proof_changed(self, &observed.task_id))
        }
    }

    fn ensure_current_cleanup_proof(
        &self,
        task_id: &str,
        expected: &ManagedWorktreeProof,
    ) -> Result<(), CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if task.worktree_generation == expected.worktree_generation
            && self
                .store
                .managed_worktrees()
                .iter()
                .find(|proof| proof.task_id == task_id)
                == Some(expected)
        {
            Ok(())
        } else {
            Err(proof_changed(self, task_id))
        }
    }

    fn ensure_current_unverified_binding(
        &self,
        expected: &termloop_domain::TaskRecord,
    ) -> Result<(), CoreError> {
        let current = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == expected.id)
            .ok_or(CoreError::NotFound)?;
        let proof_missing = self
            .store
            .managed_worktrees()
            .iter()
            .all(|proof| proof.task_id != expected.id);
        if proof_missing
            && current.worktree_generation == 0
            && expected.worktree_generation == 0
            && current.worktree_generation == expected.worktree_generation
            && current.worktree == expected.worktree
            && current.branch == expected.branch
            && current.worktree.is_some()
            && current.branch.is_some()
        {
            Ok(())
        } else {
            Err(proof_changed(self, &expected.id))
        }
    }

    fn complete_cleanup_binding_clear(
        &mut self,
        operation: &WorktreeCleanupOperation,
        outcome: &str,
    ) -> Result<Value, CoreError> {
        let completed = self
            .store
            .complete_task_worktree_cleanup(
                &self.write_authority,
                &operation.task_id,
                &operation.operation_id,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.store
            .clear_task_worktree_cleanup(
                &self.write_authority,
                &operation.task_id,
                &operation.operation_id,
            )
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&operation.task_id);
        self.cleanup_result(&operation.task_id, &completed.receipt, outcome, None)
    }

    fn mark_cleanup_attention(
        &mut self,
        operation: &WorktreeCleanupOperation,
    ) -> Result<(), CoreError> {
        self.store
            .fail_task_worktree_cleanup(
                &self.write_authority,
                &operation.task_id,
                &operation.operation_id,
                WorktreeCleanupFailure {
                    kind: WorktreeCleanupFailureKind::RecoveryAttention,
                    blockers: vec![WorktreeCleanupBlocker::RecoveryAttention],
                },
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        Ok(())
    }

    fn map_cleanup_store_error(
        &self,
        error: termloop_store::StoreError,
        task_id: &str,
    ) -> CoreError {
        match error {
            termloop_store::StoreError::ManagedWorktreeProofChanged { .. } => {
                proof_changed(self, task_id)
            }
            termloop_store::StoreError::JournalConflict { operation_id } => {
                CoreError::CleanupInProgress {
                    task_id: task_id.to_owned(),
                    operation_id,
                }
            }
            other => store_error(other),
        }
    }

    fn cleanup_running_result(
        &self,
        operation: &WorktreeCleanupOperation,
    ) -> Result<Value, CoreError> {
        let task = self.task_current_projection(&operation.task_id)?;
        Ok(json!({
            "task": task,
            "managed_worktree_operation_id": operation.managed_worktree_operation_id,
            "worktree_generation": operation.worktree_generation,
            "outcome": "running",
            "cleanup": cleanup_operation_json(operation),
        }))
    }

    fn cleanup_result(
        &self,
        task_id: &str,
        receipt: &termloop_domain::WorktreeCleanupReceipt,
        outcome: &str,
        cleanup: Option<Value>,
    ) -> Result<Value, CoreError> {
        let task = self.task_current_projection(task_id)?;
        Ok(json!({
            "task": task,
            "managed_worktree_operation_id": receipt.managed_worktree_operation_id,
            "worktree_generation": receipt.worktree_generation,
            "outcome": outcome,
            "cleanup": cleanup,
        }))
    }

    fn cleanup_preview(
        &self,
        task: &termloop_domain::TaskRecord,
        observed: &ObservedTaskWorktreeCleanup,
        presence: &TaskWorktreePresence,
        blockers: Vec<WorktreeCleanupBlocker>,
        warnings: Vec<CleanupWarning>,
        stale_target: &Result<termloop_platform::StaleDisposalTargetFacts, CoreError>,
    ) -> Value {
        json!({
            "task_id": task.id,
            "managed_worktree_operation_id": observed.proof.operation_id,
            "worktree_generation": task.worktree_generation,
            "target_path": task.worktree.as_ref().map(|binding| &binding.path),
            "decision": if blockers.is_empty() { "allowed" } else { "refused" },
            "blockers": blockers.iter().map(cleanup_blocker_name).collect::<Vec<_>>(),
            "destructive_cleanup": destructive_cleanup_json(&blockers),
            "stale_resolution": stale_resolution_json(
                stale_resolution_target_kind(&observed.facts, false),
                both_absent(&observed.facts) || cleanup_allows_record_only_forget(&blockers),
                both_absent(&observed.facts),
                presence,
                stale_target,
                self.store.cleanup_operations().iter().find(|operation| operation.task_id == task.id),
                self.store.stale_resolution_operations().iter().find(|operation| operation.task_id == task.id),
            ),
            "warnings": warnings.iter().map(warning_name).collect::<Vec<_>>(),
            "health": self.cached_task_worktree_health(&task.id).map(health_json),
            "presence": presence_json(presence),
        })
    }

    fn unverified_binding_cleanup_preview(
        &self,
        task: &termloop_domain::TaskRecord,
        facts: &TaskWorktreeCleanupFacts,
        presence: &TaskWorktreePresence,
        stale_target: &Result<termloop_platform::StaleDisposalTargetFacts, CoreError>,
    ) -> Value {
        json!({
            "task_id": task.id,
            "managed_worktree_operation_id": Value::Null,
            "worktree_generation": task.worktree_generation,
            "target_path": task.worktree.as_ref().map(|binding| &binding.path),
            "decision": "refused",
            "blockers": [cleanup_blocker_name(&WorktreeCleanupBlocker::ManagedProofMissing)],
            "destructive_cleanup": { "status": "unavailable", "eligible_blockers": [] },
            "stale_resolution": stale_resolution_json(
                stale_resolution_target_kind(facts, true),
                true,
                both_absent(facts),
                presence,
                stale_target,
                self.store.cleanup_operations().iter().find(|operation| operation.task_id == task.id),
                self.store.stale_resolution_operations().iter().find(|operation| operation.task_id == task.id),
            ),
            "warnings": [],
            "health": Value::Null,
            "presence": presence_json(presence),
        })
    }
}

pub(super) fn observe_cleanup_facts(
    runner: &GitRunner,
    proof: &ManagedWorktreeProof,
) -> Result<TaskWorktreeCleanupFacts, CoreError> {
    let repository_root = Path::new(&proof.normalized_spec.repository_root);
    let destination = Path::new(&proof.registered_worktree_path);
    let repository = runner
        .inspect_repository(repository_root)
        .map_err(map_git_observation_error)?;
    if repository.common_dir != PathBuf::from(&proof.repository_common_dir) {
        return Ok(TaskWorktreeCleanupFacts {
            path_state: CleanupPathState::Unknown,
            registration_state: CleanupRegistrationState::Mismatch,
            branch_matches: None,
            head_matches: None,
            alternate_checkout_matches: false,
            head_oid: None,
            health: None,
        });
    }
    let path_state = match termloop_platform::canonical_directory_if_exists(destination)
        .map_err(|_| CoreError::RepositoryUnavailable)?
    {
        None => CleanupPathState::Absent,
        Some(path) if path == destination => CleanupPathState::Present,
        Some(_) => CleanupPathState::Replaced,
    };
    let worktrees = runner
        .list_worktrees(repository_root)
        .map_err(map_git_observation_error)?;
    let registration = worktrees
        .into_iter()
        .find(|worktree| worktree_registered_at(worktree, destination));
    let registration_state = if registration.is_some() {
        CleanupRegistrationState::Matching
    } else {
        CleanupRegistrationState::Absent
    };
    let reference = GitRefName::from_bytes(proof.branch_ref.as_bytes().to_vec())
        .map_err(map_git_observation_error)?;
    let branch_oid = runner
        .resolve_ref(repository_root, &reference)
        .map_err(map_git_observation_error)?;
    let head_oid = branch_oid
        .as_ref()
        .map(|oid| String::from_utf8_lossy(oid.as_bytes()).into_owned());
    let mut branch_matches = registration.as_ref().map(|registration| {
        matches!(
            &registration.checkout,
            WorktreeCheckout::Branch { reference, .. }
                if reference.as_bytes() == proof.branch_ref.as_bytes()
        )
    });
    let mut head_matches = registration
        .as_ref()
        .map(|registration| match &registration.checkout {
            WorktreeCheckout::Branch { oid, .. } => oid.as_ref() == branch_oid.as_ref(),
            WorktreeCheckout::Bare | WorktreeCheckout::Detached { .. } => false,
        });
    let mut alternate_checkout_matches = false;
    let health = if path_state == CleanupPathState::Present
        && registration_state == CleanupRegistrationState::Matching
    {
        let health = runner
            .inspect_worktree_health_with_budget(destination, WorktreeObservationBudget::Cleanup)
            .map_err(map_git_observation_error)?;
        alternate_checkout_matches =
            exact_alternate_attached_checkout(proof, destination, registration.as_ref(), &health);
        branch_matches = Some(matches!(
            &health.repository.head,
            HeadState::Attached { branch, .. }
                if branch.as_bytes() == proof.branch_ref.as_bytes()
        ));
        head_matches = Some(match &health.repository.head {
            HeadState::Attached { oid, .. } => Some(oid) == branch_oid.as_ref(),
            HeadState::Unborn { .. } | HeadState::Detached { .. } => false,
        });
        Some(health)
    } else {
        None
    };
    Ok(TaskWorktreeCleanupFacts {
        path_state,
        registration_state,
        branch_matches,
        head_matches,
        alternate_checkout_matches,
        head_oid,
        health,
    })
}

fn exact_alternate_attached_checkout(
    proof: &ManagedWorktreeProof,
    destination: &Path,
    listed_registration: Option<&termloop_gitio::WorktreeFacts>,
    health: &WorktreeHealthObservation,
) -> bool {
    let Some(listed_registration) = listed_registration else {
        return false;
    };
    let Some(health_registration) = health.registration.as_ref() else {
        return false;
    };
    if listed_registration != health_registration
        || listed_registration.registered_path != destination
        || !matches!(
            &listed_registration.path_state,
            termloop_gitio::RegisteredPathState::Present { canonical_path }
                if canonical_path == destination
        )
        || health.repository.common_dir != PathBuf::from(&proof.repository_common_dir)
        || health.repository.worktree_root.as_deref() != Some(destination)
    {
        return false;
    }
    matches!(
        (&listed_registration.checkout, &health.repository.head),
        (
            WorktreeCheckout::Branch {
                reference: registered_branch,
                oid: Some(registered_oid),
            },
            HeadState::Attached {
                branch: checked_out_branch,
                oid: checked_out_oid,
            },
        ) if registered_branch.as_bytes() == checked_out_branch.as_bytes()
            && registered_oid == checked_out_oid
            && checked_out_branch.as_bytes() != proof.branch_ref.as_bytes()
    )
}
