use serde_json::{Value, json};
use termloop_domain::{
    ManagedWorktreeProof, WorktreeCleanupBlocker, WorktreeCleanupFailureKind, WorktreeCleanupMode,
    WorktreeCleanupOperation, WorktreeCleanupOutcome, WorktreeCleanupStage,
    WorktreeStaleResolutionBlocker, WorktreeStaleResolutionFailureKind,
    WorktreeStaleResolutionMode, WorktreeStaleResolutionOperation, WorktreeStaleResolutionStage,
};
use termloop_gitio::{ChangeState, ContentState, LockState, SubmoduleState, UpstreamState};

use super::super::{
    CachedTaskWorktreeHealth, TaskWorktreePresence, WorktreeHeadProjectionState,
    WorktreeHealthSummary, WorktreePathProjectionState, WorktreeRegistrationProjectionState,
};
use super::CleanupWarning;
use super::policy::{
    cleanup_allows_stale_git_metadata, cleanup_allows_stale_resolution, is_destructive_eligible,
    stale_blocker_from_cleanup, stale_observation_error_blocker,
};
use super::stale::StaleResolutionTargetKind;
use crate::CoreError;

pub(super) fn stale_resolution_json(
    target_kind: Option<StaleResolutionTargetKind>,
    record_only_forget_available: bool,
    target_absent: bool,
    presence: &TaskWorktreePresence,
    target: &Result<termloop_platform::StaleDisposalTargetFacts, CoreError>,
    cleanup: Option<&WorktreeCleanupOperation>,
    current: Option<&WorktreeStaleResolutionOperation>,
) -> Value {
    let cleanup_blocks_resolution =
        cleanup.is_some_and(|operation| !cleanup_allows_stale_resolution(operation));
    if cleanup_blocks_resolution {
        return stale_resolution_unavailable_json(vec![
            WorktreeStaleResolutionBlocker::RecoveryAttention,
        ]);
    }
    let retrying_disposal = current.is_some_and(|operation| {
        operation.mode == WorktreeStaleResolutionMode::DiscardDirectory
            && matches!(
                operation.stage,
                WorktreeStaleResolutionStage::RemovalPrepared
                    | WorktreeStaleResolutionStage::RemovalInvoked
            )
            && operation.failure.as_ref().is_some_and(|failure| {
                failure.kind == WorktreeStaleResolutionFailureKind::RecoveryAttention
            })
    });
    if current.is_some() && !retrying_disposal {
        return stale_resolution_unavailable_json(vec![
            WorktreeStaleResolutionBlocker::StaleDisposalInProgress,
        ]);
    }
    if retrying_disposal && target_absent {
        return json!({
            "forget_status": "unavailable",
            "disposal_status": "available",
            "blockers": Vec::<&str>::new(),
        });
    }
    let forget_status = if retrying_disposal || !record_only_forget_available {
        "unavailable"
    } else {
        "available"
    };
    let Some(target_kind) = target_kind else {
        return json!({
            "forget_status": forget_status,
            "disposal_status": "unavailable",
            "blockers": [stale_resolution_blocker_name(&WorktreeStaleResolutionBlocker::ObservationFailed)],
        });
    };
    let mut blockers = Vec::new();
    match target {
        Ok(facts) => {
            if facts.has_git_metadata
                && target_kind == StaleResolutionTargetKind::OrphanedDirectory
                && !retrying_disposal
                && !cleanup.is_some_and(cleanup_allows_stale_git_metadata)
            {
                blockers.push(WorktreeStaleResolutionBlocker::GitMetadataPresent);
            }
            if facts.target_is_mount
                || facts.parent_is_filesystem_root
                || facts.protected_path_conflict
            {
                blockers.push(WorktreeStaleResolutionBlocker::ProtectedPath);
            }
        }
        Err(error) => blockers.push(stale_observation_error_blocker(error)),
    }
    if presence.total_count > 0 {
        blockers.push(WorktreeStaleResolutionBlocker::SessionAttached);
    }
    blockers.sort();
    blockers.dedup();
    let only_sessions = blockers
        .iter()
        .all(|blocker| *blocker == WorktreeStaleResolutionBlocker::SessionAttached);
    json!({
        "forget_status": forget_status,
        "disposal_status": if blockers.is_empty() {
            "available"
        } else if only_sessions {
            "sessionRetirementRequired"
        } else {
            "unavailable"
        },
        "blockers": blockers.iter().map(stale_resolution_blocker_name).collect::<Vec<_>>(),
    })
}

pub(super) fn stale_resolution_unavailable_json(
    blockers: Vec<WorktreeStaleResolutionBlocker>,
) -> Value {
    json!({
        "forget_status": "unavailable",
        "disposal_status": "unavailable",
        "blockers": blockers.iter().map(stale_resolution_blocker_name).collect::<Vec<_>>(),
    })
}

pub(super) fn cleanup_preview_without_observation(
    task: &termloop_domain::TaskRecord,
    blocker: WorktreeCleanupBlocker,
) -> Value {
    json!({
        "task_id": task.id,
        "managed_worktree_operation_id": Value::Null,
        "worktree_generation": task.worktree_generation,
        "target_path": task.worktree.as_ref().map(|binding| &binding.path),
        "decision": "refused",
        "blockers": [cleanup_blocker_name(&blocker)],
        "destructive_cleanup": { "status": "unavailable", "eligible_blockers": [] },
        "stale_resolution": stale_resolution_unavailable_json(vec![stale_blocker_from_cleanup(&blocker)]),
        "warnings": [],
        "health": Value::Null,
        "presence": Value::Null,
    })
}

pub(super) fn cleanup_unknown_preview(
    task: &termloop_domain::TaskRecord,
    proof: &ManagedWorktreeProof,
    blocker: WorktreeCleanupBlocker,
) -> Value {
    json!({
        "task_id": task.id,
        "managed_worktree_operation_id": proof.operation_id,
        "worktree_generation": task.worktree_generation,
        "target_path": task.worktree.as_ref().map(|binding| &binding.path),
        "decision": "unknown",
        "blockers": [cleanup_blocker_name(&blocker)],
        "destructive_cleanup": { "status": "unavailable", "eligible_blockers": [] },
        "stale_resolution": stale_resolution_unavailable_json(vec![stale_blocker_from_cleanup(&blocker)]),
        "warnings": [],
        "health": Value::Null,
        "presence": Value::Null,
    })
}

pub(in crate::task_worktree) fn cleanup_operation_json(
    operation: &WorktreeCleanupOperation,
) -> Value {
    json!({
        "operation_id": operation.operation_id,
        "managed_worktree_operation_id": operation.managed_worktree_operation_id,
        "worktree_generation": operation.worktree_generation,
        "cleanup_mode": cleanup_mode_name(operation.cleanup_mode),
        "acknowledged_content_blockers": operation.acknowledged_content_blockers.iter().map(cleanup_blocker_name).collect::<Vec<_>>(),
        "stage": stage_name(operation.stage),
        "status": if operation.failure.is_some() { "failed" } else { "running" },
        "failure": operation.failure.as_ref().map(|failure| json!({
            "kind": failure_kind_name(failure.kind),
            "blockers": failure.blockers.iter().map(cleanup_blocker_name).collect::<Vec<_>>(),
        })),
    })
}

pub(in crate::task_worktree) fn stale_resolution_operation_json(
    operation: &WorktreeStaleResolutionOperation,
) -> Value {
    json!({
        "operation_id": operation.operation_id,
        "managed_worktree_operation_id": operation.managed_worktree_operation_id,
        "worktree_generation": operation.worktree_generation,
        "target_path": operation.target_path,
        "mode": match operation.mode {
            WorktreeStaleResolutionMode::ForgetBinding => "forgetBinding",
            WorktreeStaleResolutionMode::DiscardDirectory => "discardDirectory",
        },
        "stage": match operation.stage {
            WorktreeStaleResolutionStage::Reserved => "reserved",
            WorktreeStaleResolutionStage::RemovalPrepared => "removalPrepared",
            WorktreeStaleResolutionStage::RemovalInvoked => "removalInvoked",
            WorktreeStaleResolutionStage::RemovalVerified => "removalVerified",
        },
        "status": if operation.failure.is_some() { "failed" } else { "running" },
        "failure": operation.failure.as_ref().map(|failure| json!({
            "kind": match failure.kind {
                WorktreeStaleResolutionFailureKind::Refused => "refused",
                WorktreeStaleResolutionFailureKind::ManagedProofChanged => "managedProofChanged",
                WorktreeStaleResolutionFailureKind::PermissionDenied => "permissionDenied",
                WorktreeStaleResolutionFailureKind::RemovalFailed => "removalFailed",
                WorktreeStaleResolutionFailureKind::VerificationFailed => "verificationFailed",
                WorktreeStaleResolutionFailureKind::RecoveryAttention => "recoveryAttention",
                WorktreeStaleResolutionFailureKind::OperationFailed => "operationFailed",
            },
            "blockers": failure.blockers.iter().map(stale_resolution_blocker_name).collect::<Vec<_>>(),
        })),
    })
}

pub(in crate::task_worktree) fn health_json(health: &CachedTaskWorktreeHealth) -> Value {
    let status = &health.status;
    json!({
        "observation_sequence": health.observation_sequence,
        "observed_at_epoch_ms": health.observed_at_epoch_ms,
        "path_state": path_projection_name(health.path_state),
        "registration_state": registration_projection_name(health.registration_state),
        "head_state": head_projection_name(health.head_state),
        "launch_ready": health.launch_ready,
        "checked_out_branch": health.checked_out_branch.as_deref(),
        "change_count": status.change_count,
        "tracked_state": change_name(status.tracked),
        "staged_state": change_name(status.staged),
        "untracked_state": content_name(status.untracked),
        "ignored_state": content_name(status.ignored),
        "submodule_state": submodule_name(status.submodules.state),
        "worktree_lock_state": lock_name(status.worktree_lock),
        "index_lock_state": lock_name(status.index_lock),
        "upstream_state": upstream_name(status.upstream),
        "summary": summary_name(health.summary),
    })
}

pub(in crate::task_worktree) fn presence_json(presence: &TaskWorktreePresence) -> Value {
    json!({
        "observation_sequence": presence.observation_sequence,
        "observed_at_epoch_ms": presence.observed_at_epoch_ms,
        "attached_sessions": presence.attached_sessions.iter().map(|session| json!({
            "session_id": session.session_id,
            "kind": match session.kind {
                termloop_domain::SessionKind::Terminal => "Terminal",
                termloop_domain::SessionKind::Agent => "Agent",
            },
        })).collect::<Vec<_>>(),
        "total_count": presence.total_count,
        "terminal_count": presence.terminal_count,
        "agent_count": presence.agent_count,
        "truncated": presence.truncated,
    })
}

pub(super) fn destructive_cleanup_json(blockers: &[WorktreeCleanupBlocker]) -> Value {
    let mut eligible = blockers
        .iter()
        .filter(|blocker| is_destructive_eligible(blocker))
        .cloned()
        .collect::<Vec<_>>();
    eligible.sort();
    eligible.dedup();
    let available = !eligible.is_empty() && eligible.len() == blockers.len();
    json!({
        "status": if available { "available" } else { "unavailable" },
        "eligible_blockers": if available {
            eligible.iter().map(cleanup_blocker_name).collect::<Vec<_>>()
        } else {
            Vec::<&str>::new()
        },
    })
}

pub(super) fn cleanup_mode_name(mode: WorktreeCleanupMode) -> &'static str {
    match mode {
        WorktreeCleanupMode::Safe => "safe",
        WorktreeCleanupMode::DiscardCheckoutContent => "discardCheckoutContent",
    }
}

pub fn cleanup_blocker_name(value: &WorktreeCleanupBlocker) -> &'static str {
    match value {
        WorktreeCleanupBlocker::NoBinding => "noBinding",
        WorktreeCleanupBlocker::ProvisioningInProgress => "provisioningInProgress",
        WorktreeCleanupBlocker::CleanupInProgress => "cleanupInProgress",
        WorktreeCleanupBlocker::ManagedProofMissing => "managedProofMissing",
        WorktreeCleanupBlocker::ManagedProofMismatch => "managedProofMismatch",
        WorktreeCleanupBlocker::PathReplaced => "pathReplaced",
        WorktreeCleanupBlocker::PathRegistrationInconsistent => "pathRegistrationInconsistent",
        WorktreeCleanupBlocker::OrphanedManagedDirectory => "orphanedManagedDirectory",
        WorktreeCleanupBlocker::RegistrationMismatch => "registrationMismatch",
        WorktreeCleanupBlocker::BranchMismatch => "branchMismatch",
        WorktreeCleanupBlocker::HeadMismatch => "headMismatch",
        WorktreeCleanupBlocker::SessionAttached => "sessionAttached",
        WorktreeCleanupBlocker::TrackedChanges => "trackedChanges",
        WorktreeCleanupBlocker::StagedChanges => "stagedChanges",
        WorktreeCleanupBlocker::UntrackedContent => "untrackedContent",
        WorktreeCleanupBlocker::IgnoredContent => "ignoredContent",
        WorktreeCleanupBlocker::SubmodulePresent => "submodulePresent",
        WorktreeCleanupBlocker::WorktreeLock => "worktreeLock",
        WorktreeCleanupBlocker::IndexLock => "indexLock",
        WorktreeCleanupBlocker::RepositoryUnavailable => "repositoryUnavailable",
        WorktreeCleanupBlocker::PermissionDenied => "permissionDenied",
        WorktreeCleanupBlocker::UnsupportedGit => "unsupportedGit",
        WorktreeCleanupBlocker::Timeout => "timeout",
        WorktreeCleanupBlocker::OutputLimit => "outputLimit",
        WorktreeCleanupBlocker::ObservationFailed => "observationFailed",
        WorktreeCleanupBlocker::RecoveryAttention => "recoveryAttention",
    }
}

pub fn stale_resolution_blocker_name(value: &WorktreeStaleResolutionBlocker) -> &'static str {
    match value {
        WorktreeStaleResolutionBlocker::NoBinding => "noBinding",
        WorktreeStaleResolutionBlocker::ManagedProofMissing => "managedProofMissing",
        WorktreeStaleResolutionBlocker::ManagedProofMismatch => "managedProofMismatch",
        WorktreeStaleResolutionBlocker::ProvisioningInProgress => "provisioningInProgress",
        WorktreeStaleResolutionBlocker::CleanupInProgress => "cleanupInProgress",
        WorktreeStaleResolutionBlocker::RepairInProgress => "repairInProgress",
        WorktreeStaleResolutionBlocker::StaleDisposalInProgress => "staleDisposalInProgress",
        WorktreeStaleResolutionBlocker::RepositoryUnavailable => "repositoryUnavailable",
        WorktreeStaleResolutionBlocker::CommonRepositoryChanged => "commonRepositoryChanged",
        WorktreeStaleResolutionBlocker::PathAbsent => "pathAbsent",
        WorktreeStaleResolutionBlocker::PathReplaced => "pathReplaced",
        WorktreeStaleResolutionBlocker::RegistrationPresent => "registrationPresent",
        WorktreeStaleResolutionBlocker::BranchMissing => "branchMissing",
        WorktreeStaleResolutionBlocker::GitMetadataPresent => "gitMetadataPresent",
        WorktreeStaleResolutionBlocker::SessionAttached => "sessionAttached",
        WorktreeStaleResolutionBlocker::ProtectedPath => "protectedPath",
        WorktreeStaleResolutionBlocker::PermissionDenied => "permissionDenied",
        WorktreeStaleResolutionBlocker::Timeout => "timeout",
        WorktreeStaleResolutionBlocker::ObservationFailed => "observationFailed",
        WorktreeStaleResolutionBlocker::RecoveryAttention => "recoveryAttention",
    }
}

pub(super) fn warning_name(value: &CleanupWarning) -> &'static str {
    match value {
        CleanupWarning::UpstreamBehind => "upstreamBehind",
        CleanupWarning::UpstreamAhead => "upstreamAhead",
        CleanupWarning::UpstreamDiverged => "upstreamDiverged",
        CleanupWarning::UpstreamNotConfigured => "upstreamNotConfigured",
        CleanupWarning::UpstreamMissing => "upstreamMissing",
        CleanupWarning::UpstreamUnknown => "upstreamUnknown",
    }
}

pub(super) fn stage_name(value: WorktreeCleanupStage) -> &'static str {
    match value {
        WorktreeCleanupStage::Reserved => "reserved",
        WorktreeCleanupStage::RemovePrepared => "removePrepared",
        WorktreeCleanupStage::RemovalVerified => "removalVerified",
        WorktreeCleanupStage::BindingCleared => "bindingCleared",
    }
}

pub(super) fn failure_kind_name(value: WorktreeCleanupFailureKind) -> &'static str {
    match value {
        WorktreeCleanupFailureKind::Refused => "refused",
        WorktreeCleanupFailureKind::ManagedProofChanged => "managedProofChanged",
        WorktreeCleanupFailureKind::RepositoryUnavailable => "repositoryUnavailable",
        WorktreeCleanupFailureKind::PermissionDenied => "permissionDenied",
        WorktreeCleanupFailureKind::UnsupportedGit => "unsupportedGit",
        WorktreeCleanupFailureKind::Timeout => "timeout",
        WorktreeCleanupFailureKind::OutputLimit => "outputLimit",
        WorktreeCleanupFailureKind::CheckoutContentAppeared => "removalFailed",
        WorktreeCleanupFailureKind::RemovalFailed => "removalFailed",
        WorktreeCleanupFailureKind::RecoveryAttention => "recoveryAttention",
        WorktreeCleanupFailureKind::OperationFailed => "operationFailed",
    }
}

pub(super) fn change_name(value: ChangeState) -> &'static str {
    match value {
        ChangeState::Clean => "clean",
        ChangeState::Changed => "changed",
        ChangeState::Unknown => "unknown",
    }
}

pub(super) fn content_name(value: ContentState) -> &'static str {
    match value {
        ContentState::Absent => "absent",
        ContentState::Present => "present",
        ContentState::Unknown => "unknown",
    }
}

pub(super) fn submodule_name(value: SubmoduleState) -> &'static str {
    match value {
        SubmoduleState::Absent => "absent",
        SubmoduleState::Uninitialized => "uninitialized",
        SubmoduleState::InitializedClean => "initializedClean",
        SubmoduleState::InitializedDirty => "initializedDirty",
        SubmoduleState::Unknown => "unknown",
    }
}

pub(super) fn lock_name(value: LockState) -> &'static str {
    match value {
        LockState::Absent => "absent",
        LockState::Present => "present",
        LockState::Unknown => "unknown",
    }
}

pub(super) fn upstream_name(value: UpstreamState) -> &'static str {
    match value {
        UpstreamState::InSync => "inSync",
        UpstreamState::Behind { .. } => "behind",
        UpstreamState::Ahead { .. } => "ahead",
        UpstreamState::Diverged { .. } => "diverged",
        UpstreamState::NotConfigured => "notConfigured",
        UpstreamState::Missing => "missing",
        UpstreamState::Unknown => "unknown",
    }
}

pub(super) fn summary_name(value: WorktreeHealthSummary) -> &'static str {
    match value {
        WorktreeHealthSummary::Healthy => "healthy",
        WorktreeHealthSummary::Attention => "attention",
        WorktreeHealthSummary::Unknown => "unknown",
    }
}

pub(super) fn path_projection_name(value: WorktreePathProjectionState) -> &'static str {
    match value {
        WorktreePathProjectionState::Present => "present",
        WorktreePathProjectionState::Absent => "absent",
        WorktreePathProjectionState::Replaced => "replaced",
        WorktreePathProjectionState::Unknown => "unknown",
    }
}

pub(super) fn registration_projection_name(
    value: WorktreeRegistrationProjectionState,
) -> &'static str {
    match value {
        WorktreeRegistrationProjectionState::Matching => "matching",
        WorktreeRegistrationProjectionState::Absent => "absent",
        WorktreeRegistrationProjectionState::Mismatch => "mismatch",
        WorktreeRegistrationProjectionState::Unknown => "unknown",
    }
}

pub(super) fn head_projection_name(value: WorktreeHeadProjectionState) -> &'static str {
    match value {
        WorktreeHeadProjectionState::Matching => "matching",
        WorktreeHeadProjectionState::Mismatch => "mismatch",
        WorktreeHeadProjectionState::Missing => "missing",
        WorktreeHeadProjectionState::Unknown => "unknown",
    }
}

pub(super) fn outcome_name(value: WorktreeCleanupOutcome) -> &'static str {
    match value {
        WorktreeCleanupOutcome::Removed => "removed",
        WorktreeCleanupOutcome::BindingCleared => "bindingCleared",
    }
}
