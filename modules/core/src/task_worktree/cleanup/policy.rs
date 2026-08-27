use serde_json::Value;
use termloop_domain::{
    WorktreeCleanupBlocker, WorktreeCleanupFailureKind, WorktreeCleanupMode,
    WorktreeCleanupOperation, WorktreeStaleResolutionBlocker, WorktreeStaleResolutionMode,
};
use termloop_gitio::{ChangeState, ContentState, LockState, SubmoduleState, UpstreamState};

use super::super::{
    TaskWorktreeHealthFacts, TaskWorktreePresence, WorktreeHeadProjectionState,
    WorktreePathProjectionState, WorktreeRegistrationProjectionState,
};
use super::stale::{StaleResolutionTargetKind, stale_resolution_target_kind};
use super::{
    CleanupPathState, CleanupRegistrationState, CleanupWarning, ObservedTaskWorktreeCleanup,
    ObservedTaskWorktreeStaleResolution, TaskWorktreeCleanupFacts,
};
use crate::{CoreError, CoreRuntime};

impl CoreRuntime {
    pub(super) fn cleanup_policy(
        &self,
        observed: &ObservedTaskWorktreeCleanup,
        presence: &TaskWorktreePresence,
        own_operation_id: Option<&str>,
    ) -> (Vec<WorktreeCleanupBlocker>, Vec<CleanupWarning>) {
        let mut blockers = Vec::new();
        if self
            .store
            .provisioning_operations()
            .iter()
            .any(|operation| operation.task_id == observed.task_id)
        {
            push_unique(
                &mut blockers,
                WorktreeCleanupBlocker::ProvisioningInProgress,
            );
        }
        if self.store.cleanup_operations().iter().any(|operation| {
            operation.task_id == observed.task_id
                && operation.failure.is_none()
                && Some(operation.operation_id.as_str()) != own_operation_id
        }) {
            push_unique(&mut blockers, WorktreeCleanupBlocker::CleanupInProgress);
        }
        if self
            .store
            .stale_resolution_operations()
            .iter()
            .any(|operation| operation.task_id == observed.task_id)
        {
            push_unique(&mut blockers, WorktreeCleanupBlocker::CleanupInProgress);
        }
        if presence.total_count > 0
            || self
                .store
                .session_relocation_operations()
                .iter()
                .any(|operation| operation.target_task_id == observed.task_id)
        {
            push_unique(&mut blockers, WorktreeCleanupBlocker::SessionAttached);
        }
        match observed.facts.path_state {
            CleanupPathState::Present | CleanupPathState::Absent => {}
            CleanupPathState::Replaced => {
                push_unique(&mut blockers, WorktreeCleanupBlocker::PathReplaced)
            }
            CleanupPathState::Unknown => {
                push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed)
            }
        }
        match observed.facts.registration_state {
            CleanupRegistrationState::Matching | CleanupRegistrationState::Absent => {}
            CleanupRegistrationState::Mismatch => {
                push_unique(&mut blockers, WorktreeCleanupBlocker::RegistrationMismatch)
            }
            CleanupRegistrationState::Unknown => {
                push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed)
            }
        }
        if matches!(
            (observed.facts.path_state, observed.facts.registration_state),
            (CleanupPathState::Absent, CleanupRegistrationState::Matching)
                | (CleanupPathState::Present, CleanupRegistrationState::Absent)
        ) {
            push_unique(
                &mut blockers,
                WorktreeCleanupBlocker::PathRegistrationInconsistent,
            );
        }
        if orphaned_managed_directory(&observed.facts) {
            push_unique(
                &mut blockers,
                WorktreeCleanupBlocker::OrphanedManagedDirectory,
            );
        }
        match observed.facts.branch_matches {
            Some(true) | None
                if both_absent(&observed.facts) || orphaned_managed_directory(&observed.facts) => {}
            Some(true) => {}
            Some(false) if observed.facts.alternate_checkout_matches => {}
            Some(false) => push_unique(&mut blockers, WorktreeCleanupBlocker::BranchMismatch),
            None => push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed),
        }
        match observed.facts.head_matches {
            Some(true) | None
                if both_absent(&observed.facts) || orphaned_managed_directory(&observed.facts) => {}
            Some(true) => {}
            Some(false) if observed.facts.alternate_checkout_matches => {}
            Some(false) => push_unique(&mut blockers, WorktreeCleanupBlocker::HeadMismatch),
            None => push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed),
        }
        if let Some(health) = &observed.facts.health {
            let (status_blockers, warnings) = cleanup_status_policy(&health.status);
            for blocker in status_blockers {
                push_unique(&mut blockers, blocker);
            }
            return (blockers, warnings);
        } else if !both_absent(&observed.facts) && !orphaned_managed_directory(&observed.facts) {
            push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed);
        }
        (blockers, Vec::new())
    }
}

pub(super) fn both_absent(facts: &TaskWorktreeCleanupFacts) -> bool {
    facts.path_state == CleanupPathState::Absent
        && facts.registration_state == CleanupRegistrationState::Absent
}

pub(super) fn orphaned_managed_directory(facts: &TaskWorktreeCleanupFacts) -> bool {
    facts.path_state == CleanupPathState::Present
        && facts.registration_state == CleanupRegistrationState::Absent
        && facts.branch_matches.is_none()
        && facts.head_matches.is_none()
        && facts.head_oid.is_some()
        && facts.health.is_none()
}

pub(super) fn stale_observation_blockers(
    facts: &TaskWorktreeCleanupFacts,
    unverified_binding: bool,
    mode: WorktreeStaleResolutionMode,
) -> Vec<WorktreeStaleResolutionBlocker> {
    // ForgetBinding is a record-only operation. Its plan and store commit
    // revalidate the exact Task/proof/generation/path tuple, and it never
    // mutates the checkout or Git registration. Filesystem observations gate
    // destructive disposal, not this safe escape hatch.
    if mode == WorktreeStaleResolutionMode::ForgetBinding {
        return Vec::new();
    }
    if stale_resolution_target_kind(facts, unverified_binding).is_some_and(|kind| {
        mode == WorktreeStaleResolutionMode::DiscardDirectory
            || (!unverified_binding && kind == StaleResolutionTargetKind::OrphanedDirectory)
    }) {
        return Vec::new();
    }
    let mut blockers = Vec::new();
    match facts.path_state {
        CleanupPathState::Present => {}
        CleanupPathState::Absent => blockers.push(WorktreeStaleResolutionBlocker::PathAbsent),
        CleanupPathState::Replaced => blockers.push(WorktreeStaleResolutionBlocker::PathReplaced),
        CleanupPathState::Unknown => {
            blockers.push(WorktreeStaleResolutionBlocker::ObservationFailed)
        }
    }
    match facts.registration_state {
        CleanupRegistrationState::Absent => {}
        CleanupRegistrationState::Matching | CleanupRegistrationState::Mismatch => {
            blockers.push(WorktreeStaleResolutionBlocker::RegistrationPresent)
        }
        CleanupRegistrationState::Unknown => {
            blockers.push(WorktreeStaleResolutionBlocker::ObservationFailed)
        }
    }
    if facts.head_oid.is_none() {
        blockers.push(WorktreeStaleResolutionBlocker::BranchMissing);
    }
    if blockers.is_empty() && !orphaned_managed_directory(facts) {
        blockers.push(WorktreeStaleResolutionBlocker::ObservationFailed);
    }
    blockers.sort();
    blockers.dedup();
    blockers
}

pub(super) fn cleanup_allows_record_only_forget(blockers: &[WorktreeCleanupBlocker]) -> bool {
    blockers.iter().any(|blocker| {
        matches!(
            blocker,
            WorktreeCleanupBlocker::PathReplaced
                | WorktreeCleanupBlocker::PathRegistrationInconsistent
                | WorktreeCleanupBlocker::OrphanedManagedDirectory
                | WorktreeCleanupBlocker::RegistrationMismatch
                | WorktreeCleanupBlocker::BranchMismatch
                | WorktreeCleanupBlocker::HeadMismatch
        )
    })
}

pub(super) fn stale_blocker_from_cleanup(
    blocker: &WorktreeCleanupBlocker,
) -> WorktreeStaleResolutionBlocker {
    match blocker {
        WorktreeCleanupBlocker::NoBinding => WorktreeStaleResolutionBlocker::NoBinding,
        WorktreeCleanupBlocker::ManagedProofMissing => {
            WorktreeStaleResolutionBlocker::ManagedProofMissing
        }
        WorktreeCleanupBlocker::ManagedProofMismatch => {
            WorktreeStaleResolutionBlocker::ManagedProofMismatch
        }
        WorktreeCleanupBlocker::ProvisioningInProgress => {
            WorktreeStaleResolutionBlocker::ProvisioningInProgress
        }
        WorktreeCleanupBlocker::CleanupInProgress => {
            WorktreeStaleResolutionBlocker::CleanupInProgress
        }
        WorktreeCleanupBlocker::RepositoryUnavailable => {
            WorktreeStaleResolutionBlocker::RepositoryUnavailable
        }
        WorktreeCleanupBlocker::PermissionDenied => {
            WorktreeStaleResolutionBlocker::PermissionDenied
        }
        WorktreeCleanupBlocker::Timeout => WorktreeStaleResolutionBlocker::Timeout,
        WorktreeCleanupBlocker::RecoveryAttention => {
            WorktreeStaleResolutionBlocker::RecoveryAttention
        }
        _ => WorktreeStaleResolutionBlocker::ObservationFailed,
    }
}

pub(super) fn stale_observation_error_blocker(error: &CoreError) -> WorktreeStaleResolutionBlocker {
    match error {
        CoreError::RepositoryPermissionDenied => WorktreeStaleResolutionBlocker::PermissionDenied,
        CoreError::GitObservationTimedOut => WorktreeStaleResolutionBlocker::Timeout,
        CoreError::GitUnavailable | CoreError::RepositoryUnavailable => {
            WorktreeStaleResolutionBlocker::RepositoryUnavailable
        }
        _ => WorktreeStaleResolutionBlocker::ObservationFailed,
    }
}

pub(super) fn health_facts_from_cleanup(
    facts: &TaskWorktreeCleanupFacts,
) -> TaskWorktreeHealthFacts {
    TaskWorktreeHealthFacts::unknown(
        match facts.path_state {
            CleanupPathState::Present => WorktreePathProjectionState::Present,
            CleanupPathState::Absent => WorktreePathProjectionState::Absent,
            CleanupPathState::Replaced => WorktreePathProjectionState::Replaced,
            CleanupPathState::Unknown => WorktreePathProjectionState::Unknown,
        },
        match facts.registration_state {
            CleanupRegistrationState::Matching => WorktreeRegistrationProjectionState::Matching,
            CleanupRegistrationState::Absent => WorktreeRegistrationProjectionState::Absent,
            CleanupRegistrationState::Mismatch => WorktreeRegistrationProjectionState::Mismatch,
            CleanupRegistrationState::Unknown => WorktreeRegistrationProjectionState::Unknown,
        },
        match (facts.head_matches, facts.head_oid.as_ref()) {
            (Some(true), _) => WorktreeHeadProjectionState::Matching,
            (Some(false), _) => WorktreeHeadProjectionState::Mismatch,
            (None, None) if both_absent(facts) => WorktreeHeadProjectionState::Missing,
            _ => WorktreeHeadProjectionState::Unknown,
        },
    )
}

pub(super) fn post_removal_matches(
    facts: &TaskWorktreeCleanupFacts,
    operation: &WorktreeCleanupOperation,
) -> bool {
    both_absent(facts) && facts.head_oid.as_deref() == Some(operation.baseline.head_oid.as_str())
}

pub(super) fn cleanup_refused(
    observed: &ObservedTaskWorktreeCleanup,
    blockers: Vec<WorktreeCleanupBlocker>,
) -> CoreError {
    CoreError::WorktreeCleanupRefused {
        task_id: observed.task_id.clone(),
        expected_managed_worktree_operation_id: observed
            .expected_managed_worktree_operation_id
            .clone(),
        expected_worktree_generation: observed.expected_worktree_generation,
        blockers,
    }
}

pub(super) fn stale_resolution_refused(
    observed: &ObservedTaskWorktreeStaleResolution,
    blockers: Vec<WorktreeStaleResolutionBlocker>,
) -> CoreError {
    CoreError::WorktreeStaleResolutionRefused {
        task_id: observed.task.id.clone(),
        expected_managed_worktree_operation_id: observed
            .proof
            .as_ref()
            .map(|proof| proof.operation_id.clone()),
        expected_worktree_generation: observed.task.worktree_generation,
        blockers,
    }
}

pub(super) fn proof_changed(runtime: &CoreRuntime, task_id: &str) -> CoreError {
    let task = runtime.store.tasks().iter().find(|task| task.id == task_id);
    let proof = runtime
        .store
        .managed_worktrees()
        .iter()
        .find(|proof| proof.task_id == task_id);
    CoreError::ManagedWorktreeProofChanged {
        task_id: task_id.to_owned(),
        current_managed_worktree_operation_id: proof.map(|proof| proof.operation_id.clone()),
        current_worktree_generation: task.map_or(0, |task| task.worktree_generation),
    }
}

pub(super) fn cleanup_operation_id_is_owned(
    store: &termloop_store::Store,
    operation_id: &str,
    allowed_cleanup: Option<(&str, &str)>,
) -> bool {
    store
        .provisioning_operations()
        .iter()
        .any(|operation| operation.operation_id == operation_id)
        || store
            .managed_worktrees()
            .iter()
            .any(|proof| proof.operation_id == operation_id)
        || store.cleanup_operations().iter().any(|operation| {
            (operation.operation_id == operation_id
                && allowed_cleanup
                    != Some((operation.task_id.as_str(), operation.operation_id.as_str())))
                || operation.managed_worktree_operation_id == operation_id
        })
        || store.cleanup_receipts().iter().any(|receipt| {
            receipt.operation_id == operation_id
                || receipt.managed_worktree_operation_id == operation_id
        })
}

pub(super) fn cleanup_failure_kind(error: &CoreError) -> WorktreeCleanupFailureKind {
    match error {
        CoreError::GitUnavailable => WorktreeCleanupFailureKind::RepositoryUnavailable,
        // A repository-level failure returned after the removal boundary may
        // mean Git deregistered the worktree before failing to remove all
        // checkout content. Fresh stale-disposal observation must decide what
        // remains; treating this as an ordinary retry strands that directory.
        CoreError::RepositoryUnavailable => WorktreeCleanupFailureKind::RecoveryAttention,
        CoreError::GitUnsupportedVersion | CoreError::UnsupportedRepository => {
            WorktreeCleanupFailureKind::UnsupportedGit
        }
        CoreError::RepositoryPermissionDenied => WorktreeCleanupFailureKind::PermissionDenied,
        CoreError::GitObservationTimedOut => WorktreeCleanupFailureKind::Timeout,
        CoreError::GitObservationOutputBound => WorktreeCleanupFailureKind::OutputLimit,
        CoreError::WorktreeLocked | CoreError::WorktreePathConflict => {
            WorktreeCleanupFailureKind::RemovalFailed
        }
        _ => WorktreeCleanupFailureKind::OperationFailed,
    }
}

pub(super) fn cleanup_allows_stale_resolution(operation: &WorktreeCleanupOperation) -> bool {
    operation.failure.as_ref().is_some_and(|failure| {
        failure.kind == WorktreeCleanupFailureKind::RecoveryAttention
            || operation.stage == termloop_domain::WorktreeCleanupStage::RemovePrepared
    }) && matches!(
        operation.stage,
        termloop_domain::WorktreeCleanupStage::Reserved
            | termloop_domain::WorktreeCleanupStage::RemovePrepared
    )
}

pub(super) fn cleanup_allows_stale_git_metadata(operation: &WorktreeCleanupOperation) -> bool {
    operation.stage == termloop_domain::WorktreeCleanupStage::RemovePrepared
        && operation.failure.is_some()
}

pub(super) fn observation_blocker(error: &CoreError) -> WorktreeCleanupBlocker {
    match error {
        CoreError::GitUnavailable | CoreError::RepositoryUnavailable => {
            WorktreeCleanupBlocker::RepositoryUnavailable
        }
        CoreError::GitUnsupportedVersion | CoreError::UnsupportedRepository => {
            WorktreeCleanupBlocker::UnsupportedGit
        }
        CoreError::RepositoryPermissionDenied => WorktreeCleanupBlocker::PermissionDenied,
        CoreError::GitObservationTimedOut => WorktreeCleanupBlocker::Timeout,
        CoreError::GitObservationOutputBound => WorktreeCleanupBlocker::OutputLimit,
        _ => WorktreeCleanupBlocker::ObservationFailed,
    }
}

pub(super) fn push_unique(values: &mut Vec<WorktreeCleanupBlocker>, value: WorktreeCleanupBlocker) {
    if !values.contains(&value) {
        values.push(value);
    }
}

pub(super) fn cleanup_intent(
    params: &Value,
) -> Result<(WorktreeCleanupMode, Vec<WorktreeCleanupBlocker>), CoreError> {
    let mode = match params.get("cleanupMode").and_then(Value::as_str) {
        Some("safe") => WorktreeCleanupMode::Safe,
        Some("discardCheckoutContent") => WorktreeCleanupMode::DiscardCheckoutContent,
        _ => return Err(CoreError::InvalidParams("cleanupMode".into())),
    };
    let values = params
        .get("acknowledgedContentBlockers")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidParams("acknowledgedContentBlockers".into()))?;
    let mut blockers = Vec::with_capacity(values.len());
    for value in values {
        let blocker = match value.as_str() {
            Some("trackedChanges") => WorktreeCleanupBlocker::TrackedChanges,
            Some("stagedChanges") => WorktreeCleanupBlocker::StagedChanges,
            Some("untrackedContent") => WorktreeCleanupBlocker::UntrackedContent,
            Some("ignoredContent") => WorktreeCleanupBlocker::IgnoredContent,
            Some("submodulePresent") => WorktreeCleanupBlocker::SubmodulePresent,
            _ => {
                return Err(CoreError::InvalidParams(
                    "acknowledgedContentBlockers".into(),
                ));
            }
        };
        if blockers.contains(&blocker) {
            return Err(CoreError::InvalidParams(
                "acknowledgedContentBlockers".into(),
            ));
        }
        blockers.push(blocker);
    }
    blockers.sort();
    if (mode == WorktreeCleanupMode::Safe && !blockers.is_empty())
        || (mode == WorktreeCleanupMode::DiscardCheckoutContent && blockers.is_empty())
    {
        return Err(CoreError::InvalidParams(
            "acknowledgedContentBlockers".into(),
        ));
    }
    Ok((mode, blockers))
}

pub(super) fn is_destructive_eligible(blocker: &WorktreeCleanupBlocker) -> bool {
    matches!(
        blocker,
        WorktreeCleanupBlocker::TrackedChanges
            | WorktreeCleanupBlocker::StagedChanges
            | WorktreeCleanupBlocker::UntrackedContent
            | WorktreeCleanupBlocker::IgnoredContent
            | WorktreeCleanupBlocker::SubmodulePresent
    )
}

pub(super) fn unauthorized_cleanup_blockers(
    mode: WorktreeCleanupMode,
    acknowledged: &[WorktreeCleanupBlocker],
    blockers: Vec<WorktreeCleanupBlocker>,
) -> Vec<WorktreeCleanupBlocker> {
    if mode == WorktreeCleanupMode::Safe {
        return blockers;
    }
    blockers
        .into_iter()
        .filter(|blocker| !is_destructive_eligible(blocker) || !acknowledged.contains(blocker))
        .collect()
}

pub(super) fn cleanup_status_policy(
    status: &termloop_gitio::WorktreeStatusFacts,
) -> (Vec<WorktreeCleanupBlocker>, Vec<CleanupWarning>) {
    let mut blockers = Vec::new();
    match status.tracked {
        ChangeState::Clean => {}
        ChangeState::Changed => blockers.push(WorktreeCleanupBlocker::TrackedChanges),
        ChangeState::Unknown => blockers.push(WorktreeCleanupBlocker::ObservationFailed),
    }
    match status.staged {
        ChangeState::Clean => {}
        ChangeState::Changed => blockers.push(WorktreeCleanupBlocker::StagedChanges),
        ChangeState::Unknown => {
            push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed)
        }
    }
    match status.untracked {
        ContentState::Absent => {}
        ContentState::Present => blockers.push(WorktreeCleanupBlocker::UntrackedContent),
        ContentState::Unknown => {
            push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed)
        }
    }
    match status.ignored {
        ContentState::Absent => {}
        ContentState::Present => blockers.push(WorktreeCleanupBlocker::IgnoredContent),
        ContentState::Unknown => {
            push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed)
        }
    }
    match status.submodules.state {
        SubmoduleState::Absent | SubmoduleState::Uninitialized => {}
        SubmoduleState::InitializedClean | SubmoduleState::InitializedDirty => {
            blockers.push(WorktreeCleanupBlocker::SubmodulePresent)
        }
        SubmoduleState::Unknown => {
            push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed)
        }
    }
    match status.worktree_lock {
        LockState::Absent => {}
        LockState::Present => blockers.push(WorktreeCleanupBlocker::WorktreeLock),
        LockState::Unknown => push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed),
    }
    match status.index_lock {
        LockState::Absent => {}
        LockState::Present => blockers.push(WorktreeCleanupBlocker::IndexLock),
        LockState::Unknown => push_unique(&mut blockers, WorktreeCleanupBlocker::ObservationFailed),
    }
    let warnings = match status.upstream {
        UpstreamState::InSync => vec![],
        UpstreamState::Behind { .. } => vec![CleanupWarning::UpstreamBehind],
        UpstreamState::Ahead { .. } => vec![CleanupWarning::UpstreamAhead],
        UpstreamState::Diverged { .. } => vec![CleanupWarning::UpstreamDiverged],
        UpstreamState::NotConfigured => vec![CleanupWarning::UpstreamNotConfigured],
        UpstreamState::Missing => vec![CleanupWarning::UpstreamMissing],
        UpstreamState::Unknown => vec![CleanupWarning::UpstreamUnknown],
    };
    (blockers, warnings)
}

pub(super) fn requires_recovery_attention(blockers: &[WorktreeCleanupBlocker]) -> bool {
    blockers.iter().any(|blocker| {
        matches!(
            blocker,
            WorktreeCleanupBlocker::PathReplaced
                | WorktreeCleanupBlocker::PathRegistrationInconsistent
                | WorktreeCleanupBlocker::RegistrationMismatch
                | WorktreeCleanupBlocker::BranchMismatch
                | WorktreeCleanupBlocker::HeadMismatch
                | WorktreeCleanupBlocker::RecoveryAttention
        )
    })
}

#[cfg(test)]
mod policy_tests {
    use super::super::projection::destructive_cleanup_json;
    use super::*;
    use termloop_gitio::{SubmoduleFacts, WorktreeStatusFacts};

    #[test]
    fn removal_boundary_repository_failure_requires_recovery_attention() {
        assert_eq!(
            cleanup_failure_kind(&CoreError::RepositoryUnavailable),
            WorktreeCleanupFailureKind::RecoveryAttention,
        );
    }

    fn clean_status() -> WorktreeStatusFacts {
        WorktreeStatusFacts {
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
        }
    }

    #[test]
    fn checkout_local_loss_risks_are_independent_blockers() {
        let mut status = clean_status();
        status.tracked = ChangeState::Changed;
        status.staged = ChangeState::Changed;
        status.untracked = ContentState::Present;
        status.ignored = ContentState::Present;
        status.submodules.state = SubmoduleState::InitializedClean;
        status.worktree_lock = LockState::Present;
        status.index_lock = LockState::Present;
        let (blockers, warnings) = cleanup_status_policy(&status);
        assert_eq!(
            blockers,
            vec![
                WorktreeCleanupBlocker::TrackedChanges,
                WorktreeCleanupBlocker::StagedChanges,
                WorktreeCleanupBlocker::UntrackedContent,
                WorktreeCleanupBlocker::IgnoredContent,
                WorktreeCleanupBlocker::SubmodulePresent,
                WorktreeCleanupBlocker::WorktreeLock,
                WorktreeCleanupBlocker::IndexLock,
            ]
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn upstream_states_warn_without_authorizing_or_blocking_cleanup() {
        for (upstream, warning) in [
            (
                UpstreamState::Behind { commits: 1 },
                CleanupWarning::UpstreamBehind,
            ),
            (
                UpstreamState::Ahead { commits: 1 },
                CleanupWarning::UpstreamAhead,
            ),
            (
                UpstreamState::Diverged {
                    ahead: 1,
                    behind: 1,
                },
                CleanupWarning::UpstreamDiverged,
            ),
            (
                UpstreamState::NotConfigured,
                CleanupWarning::UpstreamNotConfigured,
            ),
            (UpstreamState::Missing, CleanupWarning::UpstreamMissing),
            (UpstreamState::Unknown, CleanupWarning::UpstreamUnknown),
        ] {
            let mut status = clean_status();
            status.upstream = upstream;
            let (blockers, warnings) = cleanup_status_policy(&status);
            assert!(blockers.is_empty());
            assert_eq!(warnings, vec![warning]);
        }
    }

    #[test]
    fn unknown_checkout_local_facts_fail_closed() {
        let mut status = clean_status();
        status.tracked = ChangeState::Unknown;
        status.staged = ChangeState::Unknown;
        status.untracked = ContentState::Unknown;
        status.ignored = ContentState::Unknown;
        status.submodules.state = SubmoduleState::Unknown;
        status.worktree_lock = LockState::Unknown;
        status.index_lock = LockState::Unknown;
        let (blockers, _) = cleanup_status_policy(&status);
        assert_eq!(blockers, vec![WorktreeCleanupBlocker::ObservationFailed]);
    }

    #[test]
    fn destructive_acknowledgement_overrides_only_exact_checkout_content_categories() {
        let content = vec![
            WorktreeCleanupBlocker::TrackedChanges,
            WorktreeCleanupBlocker::IgnoredContent,
            WorktreeCleanupBlocker::SubmodulePresent,
        ];
        assert!(
            unauthorized_cleanup_blockers(
                WorktreeCleanupMode::DiscardCheckoutContent,
                &content,
                content.clone(),
            )
            .is_empty()
        );
        assert_eq!(
            unauthorized_cleanup_blockers(
                WorktreeCleanupMode::DiscardCheckoutContent,
                &[WorktreeCleanupBlocker::TrackedChanges],
                content,
            ),
            vec![
                WorktreeCleanupBlocker::IgnoredContent,
                WorktreeCleanupBlocker::SubmodulePresent,
            ]
        );
        assert_eq!(
            unauthorized_cleanup_blockers(
                WorktreeCleanupMode::DiscardCheckoutContent,
                &[WorktreeCleanupBlocker::IgnoredContent],
                vec![
                    WorktreeCleanupBlocker::IgnoredContent,
                    WorktreeCleanupBlocker::SessionAttached,
                ],
            ),
            vec![WorktreeCleanupBlocker::SessionAttached]
        );
        assert_eq!(
            destructive_cleanup_json(&[WorktreeCleanupBlocker::IgnoredContent])["status"],
            "available"
        );
        assert_eq!(
            destructive_cleanup_json(&[WorktreeCleanupBlocker::SubmodulePresent])["status"],
            "available"
        );
        assert_eq!(
            destructive_cleanup_json(&[
                WorktreeCleanupBlocker::IgnoredContent,
                WorktreeCleanupBlocker::WorktreeLock,
            ])["status"],
            "unavailable"
        );
    }
}
