//! Task/worktree command and saga ownership boundary.

use std::path::Path;

use termloop_domain::{ProvisioningBranchMode, TaskBranchBinding};

use crate::CoreRuntime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedTaskCheckoutNames {
    pub branch_name: String,
    pub worktree_leaf: String,
}

/// Deterministic names shared by every TermLoop-owned Task worktree flow.
/// Keeping the Task ID suffix makes concurrent imports collision-resistant;
/// ASCII-only bounded leaves stay portable across all release platforms.
pub fn managed_task_checkout_names(title: &str, task_id: &str) -> ManagedTaskCheckoutNames {
    let slug = managed_task_slug(title);
    let suffix = task_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>();
    let suffix = if suffix.is_empty() { "task" } else { &suffix };
    ManagedTaskCheckoutNames {
        branch_name: format!("termloop/{slug}-{suffix}"),
        worktree_leaf: format!("termloop-{slug}-{suffix}_worktree"),
    }
}

fn managed_task_slug(title: &str) -> String {
    let mut slug = String::with_capacity(title.len().min(48));
    let mut separator_pending = false;
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            if separator_pending && !slug.is_empty() && slug.len() < 40 {
                slug.push('-');
            }
            separator_pending = false;
            if slug.len() < 40 {
                slug.push(character.to_ascii_lowercase());
            }
        } else if !slug.is_empty() {
            separator_pending = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }
    if slug.is_empty() { "task".into() } else { slug }
}

pub(crate) mod archive;
mod branch_binding;
mod branch_commits;
mod changes;
mod cleanup;
mod commit_changes;
mod git_mapping;
mod health;
pub(crate) use health::comparison_key;
mod provisioning;
mod repair;
mod task_records;
pub(crate) use task_records::{BRIEF_LIMIT, TITLE_LIMIT};

pub use branch_binding::{ObservedTaskBranchBinding, TaskBranchBindingPlan};
pub(crate) use branch_commits::BranchCommitSummaryCache;
pub use branch_commits::{
    ObservedTaskBranchCommitSummaries, TaskBranchCommitSummaryListPlan, TaskBranchCommitWatchTarget,
};
pub(crate) use changes::WorktreeChangeObservationCache;
pub use changes::{
    ObservedTaskWorktreeChanges, ObservedTaskWorktreeDiff, ObservedTaskWorktreePreImage,
    TaskWorktreeChangeListPlan, TaskWorktreeDiffPlan, TaskWorktreePreImagePlan,
};
pub use cleanup::{
    CleanupPathState, CleanupRegistrationState, CleanupWarning, ExecutedTaskWorktreeCleanupRemoval,
    ExecutedTaskWorktreeStaleDisposal, ObservedTaskWorktreeCleanup,
    ObservedTaskWorktreeCleanupInspection, ObservedTaskWorktreeStaleForget,
    ObservedTaskWorktreeStaleResolution, TaskWorktreeCleanupFacts, TaskWorktreeCleanupFinalization,
    TaskWorktreeCleanupInspectionPlan, TaskWorktreeCleanupInspectionPlanning,
    TaskWorktreeCleanupObservationStep, TaskWorktreeCleanupPlan, TaskWorktreeCleanupPlanning,
    TaskWorktreeCleanupProgress, TaskWorktreeCleanupRecoveryPlan, TaskWorktreeCleanupRemovalStep,
    TaskWorktreeStaleDisposalStep, TaskWorktreeStaleForgetStep, TaskWorktreeStaleResolutionPlan,
    TaskWorktreeStaleResolutionPlanning, TaskWorktreeStaleResolutionProgress, cleanup_blocker_name,
    stale_resolution_blocker_name,
};
pub(crate) use commit_changes::BranchCommitObservationCache;
pub use commit_changes::{
    ObservedTaskBranchCommitChanges, ObservedTaskBranchCommitDiff, ObservedTaskBranchCommitList,
    TaskBranchCommitChangeListPlan, TaskBranchCommitDiffPlan, TaskBranchCommitListPlan,
};
pub(crate) use health::WorktreeProjectionCache;
pub use health::{
    AttachedTaskSession, CachedTaskWorktreeHealth, ObservedTaskWorktreeHealth, ProjectionApply,
    TaskWorktreeHealthFacts, TaskWorktreeHealthPlan, TaskWorktreePresence, TaskWorktreeWatchTarget,
    WorktreeHeadProjectionState, WorktreeHealthCacheKey, WorktreeHealthSummary,
    WorktreePathProjectionState, WorktreeRegistrationProjectionState,
};
pub use provisioning::{
    ExecutedTaskWorktreeProvisioningStep, ObservedTaskWorktreeProvisioning,
    ObservedTaskWorktreeProvisioningDismissal, TaskWorktreeProvisioningDismissPlan,
    TaskWorktreeProvisioningPlan, TaskWorktreeProvisioningProgress, TaskWorktreeProvisioningStep,
};
pub use repair::{
    ExecutedTaskWorktreeRepair, ObservedTaskWorktreeRepair, TaskWorktreeRepairExecution,
    TaskWorktreeRepairPlan, TaskWorktreeRepairProgress, TaskWorktreeRepairVerification,
    VerifiedTaskWorktreeRepair, repair_blocker_name,
};

impl CoreRuntime {
    /// Returns only the exact creation ref and OID captured by the currently
    /// managed Task worktree proof. This is intentionally absent for manually
    /// bound/existing branches and for any stale or inconsistent proof tuple.
    fn task_recorded_branch_base(
        &self,
        task_id: &str,
        binding: &TaskBranchBinding,
    ) -> Option<(String, String)> {
        let task = self.store.tasks().iter().find(|task| task.id == task_id)?;
        let worktree = task.worktree.as_ref()?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)?;
        let spec = &proof.normalized_spec;
        if proof.worktree_generation != task.worktree_generation
            || proof.normalized_spec_version != spec.version
            || proof.repository_common_dir != spec.repository_common_dir
            || proof.registered_worktree_path != worktree.path
            || Path::new(&spec.destination_path) != Path::new(&worktree.path)
            || spec.branch_mode != ProvisioningBranchMode::Create
            || spec.repository_root != binding.repository_root
            || spec.branch_name != binding.name
            || proof.branch_ref != format!("refs/heads/{}", binding.name)
        {
            return None;
        }
        Some((spec.base_ref.clone()?, spec.base_oid.clone()?))
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod naming_tests {
    use super::*;

    #[test]
    fn managed_names_are_bounded_portable_deterministic_and_have_a_fallback() {
        let names = managed_task_checkout_names("  OAuth Callback — Fix!  ", "12345678-abcd");
        assert_eq!(names.branch_name, "termloop/oauth-callback-fix-12345678");
        assert_eq!(
            names.worktree_leaf,
            "termloop-oauth-callback-fix-12345678_worktree"
        );
        assert!(
            managed_task_checkout_names(&"A".repeat(100), "id")
                .branch_name
                .len()
                <= 52
        );
        assert_eq!(
            managed_task_checkout_names("🔒", "---").branch_name,
            "termloop/task-task"
        );
    }
}
