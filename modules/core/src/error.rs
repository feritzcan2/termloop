use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectDeleteBlocker {
    Worktrees,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskWorktreeUnavailableReason {
    ManagedProofMissing,
    ManagedProofMismatch,
    PathAbsent,
    PathReplaced,
    RegistrationAbsent,
    RegistrationMismatch,
    HeadMismatch,
    ObservationUnknown,
    RepositoryUnavailable,
    PermissionDenied,
    UnsupportedGit,
    Timeout,
    OutputLimit,
    RepairRecoveryAttention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentForkUnavailableReason {
    SourceNotRunning,
    ResumeRefMissing,
    CapabilityUnavailable,
    CwdUnavailable,
    LaunchReserved,
    ProviderRejected,
    ProviderHistoryDamaged,
    ConversationUnconfirmed,
    StartupExited,
    StartupTimedOut,
    RuntimeConflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHistoryRepairUnavailableReason {
    SessionRunning,
    ProviderUnsupported,
    ResumeRefMissing,
    HistoryUnavailable,
    DamageUnrecognized,
    MutationFailed,
    VerificationFailed,
    RecoveryAttention,
    RuntimeConflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAgentStartStage {
    Planning,
    WorktreeProvision,
    AgentLaunch,
    AssignmentDelivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAgentStartSuggestedAction {
    ChooseBaseBranch,
    ConfigureAgent,
    Retry,
    InspectTask,
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("method not found")]
    MethodNotFound,
    #[error("invalid params: {0}")]
    InvalidParams(String),
    #[error("record not found")]
    NotFound,
    #[error("state revision changed")]
    RevisionConflict,
    #[error("Companion proposal {proposal_message_id} is still awaiting a user decision")]
    CompanionProposalPending { proposal_message_id: String },
    #[error("project deletion blocked by {0:?}")]
    ProjectDeleteBlocked(ProjectDeleteBlocker),
    #[error("agent is not supported")]
    AgentUnsupported,
    #[error("Task Agent start failed during {stage:?}")]
    TaskAgentStartFailed {
        stage: TaskAgentStartStage,
        retryable: bool,
        suggested_action: TaskAgentStartSuggestedAction,
        observed_branches: Vec<String>,
    },
    #[error("Task {task_id} already has Jira URL {jira_url}")]
    TaskJiraUrlAlreadySet { task_id: String, jira_url: String },
    #[error("agent conversation fork is unavailable: {reason:?}")]
    AgentForkUnavailable { reason: AgentForkUnavailableReason },
    #[error("provider history repair is unavailable for Session {session_id}: {reason:?}")]
    ProviderHistoryRepairUnavailable {
        session_id: String,
        reason: ProviderHistoryRepairUnavailableReason,
    },
    #[error("capability denied")]
    CapabilityDenied,
    #[error("Companion transcript quota exceeded")]
    CompanionTranscriptQuotaExceeded,
    #[error("selected assistant CLI is unavailable")]
    AgentCapabilityUnproven,
    #[error("Routine must be disabled and stopped before deletion")]
    TrackerRuntimeActive,
    #[error(
        "this Routine evaluates the \"{step}\" step on the {pipeline} pipeline; remove that step from the Playbook first"
    )]
    PlaybookStepRoutineHeld { step: String, pipeline: String },
    #[error("turn this Worker off and close its Session before deleting it")]
    WorkerRuntimeActive,
    #[error(
        "this Worker still runs {routines} Routine(s); remove them from the Playbook or delete them first"
    )]
    WorkerHasRoutines { routines: usize },
    #[error("Routine check or report is stale")]
    TrackerReportStale,
    #[error("Routine report is invalid")]
    TrackerReportInvalid,
    #[error("no Task is waiting at this pipeline step right now")]
    PlaybookStepIdle,
    #[error("agent provider identity replacement was rejected")]
    ResumeRefReplacement,
    #[error("an Ask-To request is already current for this Session")]
    AskToInProgress { request_id: String, status: String },
    #[error("the live Ask-To helper capacity is exhausted")]
    HelperCapacityExhausted,
    #[error("the Ask-To conversation is unavailable")]
    ConversationUnavailable,
    #[error("the Ask-To conversation helper is busy")]
    ConversationBusy,
    #[error("Ask-To request is unavailable")]
    AskToRequestUnavailable,
    #[error("Ask-To request was already answered")]
    AskToAlreadyReplied,
    #[error("the asker Session no longer exists")]
    AskToRequestGone,
    #[error("branch is held by Task {task_id}")]
    BranchHeldByTask { task_id: String },
    #[error("Task {task_id} already has a different branch binding")]
    TaskBranchAlreadyBound { task_id: String },
    #[error("worktree path is held by Task {task_id}")]
    WorktreePathHeldByTask { task_id: String },
    #[error("provisioning operation {operation_id} is already in progress")]
    ProvisioningAlreadyInProgress { operation_id: String },
    #[error("operation ID {operation_id} was reused with another specification")]
    OperationIdReused { operation_id: String },
    #[error("branch is already checked out at {worktree_path}")]
    BranchCheckedOutElsewhere { worktree_path: String },
    #[error("worktree recovery needs attention for operation {operation_id}")]
    WorktreeRecoveryAttention { operation_id: String },
    #[error("worktree path conflicts with an existing filesystem or Git registration")]
    WorktreePathConflict,
    #[error("branch changed or became unavailable during provisioning")]
    BranchMutationConflict,
    #[error("worktree is locked")]
    WorktreeLocked,
    #[error("Task {task_id} requires explicit worktree cleanup")]
    TaskWorktreeCleanupRequired { task_id: String },
    #[error("Task {task_id} is archived")]
    TaskArchived { task_id: String },
    #[error("Task {task_id} is not archived")]
    TaskNotArchived { task_id: String },
    #[error("Task archive preview is stale")]
    ArchivePreviewStale { task_id: String },
    #[error("Task archive was refused")]
    ArchiveRefused {
        task_id: String,
        blockers: Vec<String>,
        session_ids: Vec<String>,
    },
    #[error("archive operation {operation_id} is in progress for Task {task_id}")]
    ArchiveInProgress {
        task_id: String,
        operation_id: String,
    },
    #[error("archive recovery needs attention for operation {operation_id}")]
    ArchiveRecoveryAttention {
        task_id: String,
        operation_id: String,
    },
    #[error("Session {session_id} is suspended by Task archive")]
    SessionSuspendedByTaskArchive { session_id: String },
    #[error("cleanup operation {operation_id} is already in progress for Task {task_id}")]
    CleanupInProgress {
        task_id: String,
        operation_id: String,
    },
    #[error("Task worktree cleanup was refused")]
    WorktreeCleanupRefused {
        task_id: String,
        expected_managed_worktree_operation_id: String,
        expected_worktree_generation: u64,
        blockers: Vec<termloop_domain::WorktreeCleanupBlocker>,
    },
    #[error("managed worktree proof changed for Task {task_id}")]
    ManagedWorktreeProofChanged {
        task_id: String,
        current_managed_worktree_operation_id: Option<String>,
        current_worktree_generation: u64,
    },
    #[error("cleanup recovery needs attention for operation {operation_id}")]
    WorktreeCleanupRecoveryAttention { operation_id: String },
    #[error("stale disposal operation {operation_id} is already in progress for Task {task_id}")]
    StaleDisposalInProgress {
        task_id: String,
        operation_id: String,
    },
    #[error("Task worktree stale resolution was refused")]
    WorktreeStaleResolutionRefused {
        task_id: String,
        expected_managed_worktree_operation_id: Option<String>,
        expected_worktree_generation: u64,
        blockers: Vec<termloop_domain::WorktreeStaleResolutionBlocker>,
    },
    #[error("stale disposal recovery needs attention for operation {operation_id}")]
    WorktreeStaleDisposalRecoveryAttention {
        task_id: String,
        operation_id: String,
    },
    #[error("repair operation {operation_id} is already in progress for Task {task_id}")]
    RepairInProgress {
        task_id: String,
        operation_id: String,
    },
    #[error("Task worktree repair was refused")]
    WorktreeRepairRefused {
        task_id: String,
        expected_managed_worktree_operation_id: String,
        expected_worktree_generation: u64,
        blockers: Vec<termloop_domain::WorktreeRepairBlocker>,
    },
    #[error("repair recovery needs attention for operation {operation_id}")]
    WorktreeRepairRecoveryAttention {
        task_id: String,
        operation_id: String,
    },
    #[error("Task has no worktree")]
    WorktreeRequired,
    #[error("Task {task_id} requires a worktree")]
    TaskWorktreeRequired { task_id: String },
    #[error("Task {task_id} worktree is unavailable: {reason:?}")]
    TaskWorktreeUnavailable {
        task_id: String,
        reason: TaskWorktreeUnavailableReason,
    },
    #[error("branch was not found")]
    BranchNotFound,
    #[error("repository is unavailable")]
    RepositoryUnavailable,
    #[error("Git is unavailable")]
    GitUnavailable,
    #[error("Git version is unsupported")]
    GitUnsupportedVersion,
    #[error("repository permission was denied")]
    RepositoryPermissionDenied,
    #[error("Git observation timed out")]
    GitObservationTimedOut,
    #[error("Git observation exceeded its output bound")]
    GitObservationOutputBound,
    #[error("repository metadata is corrupt")]
    CorruptRepository,
    #[error("repository format is unsupported")]
    UnsupportedRepository,
    #[error("store failed: {0}")]
    Store(String),
    #[error("terminal failed: {0}")]
    Terminal(String),
}

pub(crate) fn required_string(params: &Value, key: &str) -> Result<String, CoreError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| CoreError::InvalidParams(key.to_owned()))
}

pub(crate) fn store_error(error: termloop_store::StoreError) -> CoreError {
    match error {
        termloop_store::StoreError::NotFound => CoreError::NotFound,
        termloop_store::StoreError::RevisionConflict => CoreError::RevisionConflict,
        termloop_store::StoreError::ProjectHasWorktrees => {
            CoreError::ProjectDeleteBlocked(ProjectDeleteBlocker::Worktrees)
        }
        termloop_store::StoreError::CompanionTranscriptQuotaExceeded => {
            CoreError::CompanionTranscriptQuotaExceeded
        }
        termloop_store::StoreError::OperationIdReused { operation_id } => {
            CoreError::OperationIdReused { operation_id }
        }
        termloop_store::StoreError::JournalConflict { operation_id } => {
            CoreError::ProvisioningAlreadyInProgress { operation_id }
        }
        termloop_store::StoreError::ManagedWorktreeProofChanged { task_id } => {
            CoreError::ManagedWorktreeProofChanged {
                task_id,
                current_managed_worktree_operation_id: None,
                current_worktree_generation: 0,
            }
        }
        termloop_store::StoreError::WorktreePathHeld { task_id } => {
            CoreError::WorktreePathHeldByTask { task_id }
        }
        termloop_store::StoreError::BranchHeld { task_id } => {
            CoreError::BranchHeldByTask { task_id }
        }
        other => CoreError::Store(other.to_string()),
    }
}
pub(crate) fn terminal_error(error: termloop_terminal::TerminalError) -> CoreError {
    match error {
        termloop_terminal::TerminalError::SessionNotFound => CoreError::NotFound,
        other => CoreError::Terminal(other.to_string()),
    }
}
pub(crate) fn json_error(error: serde_json::Error) -> CoreError {
    CoreError::Store(error.to_string())
}
