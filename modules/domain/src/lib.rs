#![forbid(unsafe_code)]

mod archive;
pub use archive::{
    SessionArchiveOperation, SessionArchiveOperationState, TaskArchiveOperation,
    TaskArchiveOperationState, TaskArchiveSuspension, TaskArchiveTarget, TaskSuspensionReason,
};

mod configuration_version;
pub use configuration_version::{
    CONFIGURATION_VERSION_CONTENT_MAX_BYTES, CONFIGURATION_VERSION_SUMMARY_MAX_BYTES,
    CONFIGURATION_VERSIONS_PER_TARGET_MAX, ConfigurationVersion, ConfigurationVersionSelection,
};

mod relocation;
pub use relocation::{
    SessionRelocationOperation, SessionRelocationReceipt, SessionRelocationStage,
    SessionRelocationTarget,
};

mod run_configuration;
pub use run_configuration::{
    RUN_CONFIGURATION_COMMAND_MAX_BYTES, RUN_CONFIGURATION_ENV_MAX_ENTRIES,
    RUN_CONFIGURATION_ENV_NAME_MAX_BYTES, RUN_CONFIGURATION_ENV_VALUE_MAX_BYTES,
    RUN_CONFIGURATION_FALLBACK_URL_MAX_BYTES, RUN_CONFIGURATION_FALLBACK_URLS_MAX,
    RUN_CONFIGURATION_ID_MAX_BYTES, RUN_CONFIGURATION_NAME_MAX_BYTES,
    RUN_CONFIGURATION_WORKING_DIRECTORY_MAX_BYTES, RUN_CONFIGURATIONS_PER_PROJECT_MAX,
    RUN_SETUP_MARKS_PER_PROJECT_MAX, RunConfiguration, RunConfigurationEnvVar,
    RunConfigurationKind, RunSetupMark, RunSetupPolicy,
};

mod companion;

mod project_task_automation;
pub use project_task_automation::{
    PROJECT_TASK_AUTOMATION_KICKOFF_MESSAGE_MAX_BYTES,
    PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT, ProjectTaskAutomationConfiguration,
};

mod playbook;
mod task_source;
pub use playbook::{
    PLAYBOOK_APPROVER_MAX_BYTES, PLAYBOOK_ENTRY_ID_MAX_BYTES, PLAYBOOK_EVIDENCE_MAX_BYTES,
    PLAYBOOK_MILESTONES_MAX, PLAYBOOK_PIPELINE_NAME_MAX_BYTES, PLAYBOOK_RETRY_DELAY_MAX_SECONDS,
    PLAYBOOK_RETRY_DELAY_MIN_SECONDS, PLAYBOOK_ROUTINE_ID_MAX_BYTES, PLAYBOOK_SAVED_PIPELINES_MAX,
    PLAYBOOK_TITLE_MAX_BYTES, PlaybookConfiguration, PlaybookGateKind, PlaybookMilestone,
    PlaybookPipeline, PlaybookPosition, PlaybookStepProgress, PlaybookStepVerdict,
    pipeline_position,
};
pub use task_source::{
    TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT,
    TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX, TASK_SOURCE_BOARDS_MAX,
    TASK_SOURCE_EXTERNAL_ID_MAX_BYTES, TASK_SOURCE_IGNORED_MAX, TASK_SOURCE_JQL_MAX_BYTES,
    TASK_SOURCE_NAME_MAX_BYTES, TASK_SOURCE_REFRESH_MAX_SECONDS, TASK_SOURCE_REFRESH_MIN_SECONDS,
    TASK_SOURCE_SITE_MAX_BYTES, TASK_SOURCE_STATUSES_MAX, TASK_SOURCES_PER_PROJECT_MAX,
    TaskSourceBoardSelection, TaskSourceConfiguration, TaskSourceImportPolicy, TaskSourceProvider,
    TaskSourceScope, TaskSourceStatusSelection,
};

pub use companion::{
    COMPANION_MESSAGE_MAX_BYTES, COMPANION_TRANSCRIPT_HARD_BYTES,
    COMPANION_TRANSCRIPT_HARD_MESSAGES, COMPANION_TRANSCRIPT_SOFT_BYTES,
    COMPANION_TRANSCRIPT_SOFT_MESSAGES, CompanionMessage, CompanionMessageAuthor,
    CompanionMessageInputMode, CompanionMessageKind, CompanionMessageRefs, PendingRoutineFinding,
    ROUTINE_CONTEXT_MAX_BYTES, ROUTINE_FINDING_EVIDENCE_MAX_BYTES,
    ROUTINE_FINDING_SUMMARY_MAX_BYTES, ROUTINE_PENDING_FINDINGS_MAX,
    ROUTINE_RECENT_SOURCE_KEYS_MAX, ROUTINE_RELATED_TASKS_MAX, ROUTINE_SOURCE_KEY_MAX_BYTES,
    RoutineActionHandling, RoutineTriggerMode, STEWARD_SYSTEM_PROMPT_MAX_BYTES, StewardAgentId,
    StewardConfiguration, StewardConversationRef, TRACKER_NAME_MAX_BYTES, TRACKER_PROMPT_MAX_BYTES,
    TRACKER_REPORT_MAX_BYTES, TRACKER_REPORT_SOURCE_REF_MAX_BYTES, TRACKER_REPORT_SOURCE_REFS_MAX,
    TRACKER_REPORTS_PER_PROJECT_MAX, TRACKER_SCHEDULE_MAX_SECONDS, TRACKER_SCHEDULE_MIN_SECONDS,
    TrackerConfiguration, TrackerReport, TrackerReportKind, WORKER_NAME_MAX_BYTES,
    WORKER_PROMPT_MAX_BYTES, WORKER_SYSTEM_PROMPT_MAX_BYTES, WORKERS_PER_PROJECT_MAX,
    WorkerConfiguration, companion_transcript_bytes,
};

/// Stable logical identity. Runtime PTY generations must not replace it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeEpoch(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum McpToolName {
    #[serde(rename = "ask_to")]
    AskTo,
    #[serde(rename = "send_to_agent")]
    SendToAgent,
    #[serde(rename = "reply_to_request")]
    ReplyToRequest,
    #[serde(rename = "project_read")]
    ProjectRead,
    #[serde(rename = "task_read")]
    TaskRead,
    #[serde(rename = "agent_status_read")]
    AgentStatusRead,
    #[serde(rename = "task_agent_transcript_tail_read")]
    TaskAgentTranscriptTailRead,
    #[serde(rename = "task_agent_request")]
    TaskAgentRequest,
    #[serde(rename = "routine_report_read", alias = "tracker_report_read")]
    RoutineReportRead,
    #[serde(rename = "companion_transcript_read")]
    CompanionTranscriptRead,
    #[serde(rename = "steward_system_prompt_read")]
    StewardSystemPromptRead,
    #[serde(rename = "steward_system_prompt_update")]
    StewardSystemPromptUpdate,
    #[serde(rename = "task_agent_start")]
    TaskAgentStart,
    #[serde(rename = "task_create")]
    TaskCreate,
    #[serde(rename = "task_rename")]
    TaskRename,
    #[serde(rename = "task_update_brief")]
    TaskUpdateBrief,
    #[serde(rename = "task_set_jira_url")]
    TaskSetJiraUrl,
    #[serde(rename = "task_close")]
    TaskClose,
    #[serde(rename = "task_reopen")]
    TaskReopen,
    #[serde(rename = "task_delete")]
    TaskDelete,
    #[serde(rename = "agent_message_send")]
    AgentMessageSend,
    #[serde(rename = "steward_suggest")]
    StewardSuggest,
    #[serde(rename = "routine_finding_read", alias = "action_candidate_read")]
    RoutineFindingRead,
    #[serde(rename = "routine_finding_resolve", alias = "action_candidate_resolve")]
    RoutineFindingResolve,
    #[serde(
        rename = "worker_get_next_routine",
        alias = "worker_task_board",
        alias = "worker_ready"
    )]
    WorkerGetNextRoutine,
    #[serde(rename = "worker_complete_assignment")]
    WorkerCompleteAssignment,
    #[serde(rename = "playbook_read")]
    PlaybookRead,
    #[serde(rename = "task_set_steward_brief")]
    TaskSetStewardBrief,
    #[serde(rename = "configuration_version_read")]
    ConfigurationVersionRead,
    #[serde(rename = "configuration_version_write")]
    ConfigurationVersionWrite,
}

impl McpToolName {
    pub const ALL: [Self; 30] = [
        Self::AskTo,
        Self::SendToAgent,
        Self::ReplyToRequest,
        Self::ProjectRead,
        Self::TaskRead,
        Self::AgentStatusRead,
        Self::TaskAgentTranscriptTailRead,
        Self::TaskAgentRequest,
        Self::RoutineReportRead,
        Self::CompanionTranscriptRead,
        Self::StewardSystemPromptRead,
        Self::StewardSystemPromptUpdate,
        Self::TaskAgentStart,
        Self::TaskCreate,
        Self::TaskRename,
        Self::TaskUpdateBrief,
        Self::TaskSetJiraUrl,
        Self::TaskClose,
        Self::TaskReopen,
        Self::TaskDelete,
        Self::AgentMessageSend,
        Self::StewardSuggest,
        Self::RoutineFindingRead,
        Self::RoutineFindingResolve,
        Self::WorkerGetNextRoutine,
        Self::WorkerCompleteAssignment,
        Self::PlaybookRead,
        Self::TaskSetStewardBrief,
        Self::ConfigurationVersionRead,
        Self::ConfigurationVersionWrite,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AskTo => "ask_to",
            Self::SendToAgent => "send_to_agent",
            Self::ReplyToRequest => "reply_to_request",
            Self::ProjectRead => "project_read",
            Self::TaskRead => "task_read",
            Self::AgentStatusRead => "agent_status_read",
            Self::TaskAgentTranscriptTailRead => "task_agent_transcript_tail_read",
            Self::TaskAgentRequest => "task_agent_request",
            Self::RoutineReportRead => "routine_report_read",
            Self::CompanionTranscriptRead => "companion_transcript_read",
            Self::StewardSystemPromptRead => "steward_system_prompt_read",
            Self::StewardSystemPromptUpdate => "steward_system_prompt_update",
            Self::TaskAgentStart => "task_agent_start",
            Self::TaskCreate => "task_create",
            Self::TaskRename => "task_rename",
            Self::TaskUpdateBrief => "task_update_brief",
            Self::TaskSetJiraUrl => "task_set_jira_url",
            Self::TaskClose => "task_close",
            Self::TaskReopen => "task_reopen",
            Self::TaskDelete => "task_delete",
            Self::AgentMessageSend => "agent_message_send",
            Self::StewardSuggest => "steward_suggest",
            Self::RoutineFindingRead => "routine_finding_read",
            Self::RoutineFindingResolve => "routine_finding_resolve",
            Self::WorkerGetNextRoutine => "worker_get_next_routine",
            Self::WorkerCompleteAssignment => "worker_complete_assignment",
            Self::PlaybookRead => "playbook_read",
            Self::TaskSetStewardBrief => "task_set_steward_brief",
            Self::ConfigurationVersionRead => "configuration_version_read",
            Self::ConfigurationVersionWrite => "configuration_version_write",
        }
    }
}

impl std::str::FromStr for McpToolName {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "ask_to" => Ok(Self::AskTo),
            "send_to_agent" => Ok(Self::SendToAgent),
            "reply_to_request" => Ok(Self::ReplyToRequest),
            "project_read" => Ok(Self::ProjectRead),
            "task_read" => Ok(Self::TaskRead),
            "agent_status_read" => Ok(Self::AgentStatusRead),
            "task_agent_transcript_tail_read" => Ok(Self::TaskAgentTranscriptTailRead),
            "task_agent_request" => Ok(Self::TaskAgentRequest),
            "routine_report_read" | "tracker_report_read" => Ok(Self::RoutineReportRead),
            "companion_transcript_read" => Ok(Self::CompanionTranscriptRead),
            "steward_system_prompt_read" => Ok(Self::StewardSystemPromptRead),
            "steward_system_prompt_update" => Ok(Self::StewardSystemPromptUpdate),
            "task_agent_start" => Ok(Self::TaskAgentStart),
            "task_create" => Ok(Self::TaskCreate),
            "task_rename" => Ok(Self::TaskRename),
            "task_update_brief" => Ok(Self::TaskUpdateBrief),
            "task_set_jira_url" => Ok(Self::TaskSetJiraUrl),
            "task_close" => Ok(Self::TaskClose),
            "task_reopen" => Ok(Self::TaskReopen),
            "task_delete" => Ok(Self::TaskDelete),
            "agent_message_send" => Ok(Self::AgentMessageSend),
            "steward_suggest" => Ok(Self::StewardSuggest),
            "routine_finding_read" | "action_candidate_read" => Ok(Self::RoutineFindingRead),
            "routine_finding_resolve" | "action_candidate_resolve" => {
                Ok(Self::RoutineFindingResolve)
            }
            "worker_get_next_routine" | "worker_task_board" | "worker_ready" => {
                Ok(Self::WorkerGetNextRoutine)
            }
            "worker_complete_assignment" => Ok(Self::WorkerCompleteAssignment),
            "playbook_read" => Ok(Self::PlaybookRead),
            "task_set_steward_brief" => Ok(Self::TaskSetStewardBrief),
            "configuration_version_read" => Ok(Self::ConfigurationVersionRead),
            "configuration_version_write" => Ok(Self::ConfigurationVersionWrite),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct McpToolDescription(String);

impl McpToolDescription {
    pub const MAX_CHARACTERS: usize = 4_096;

    pub fn new(value: String) -> Option<Self> {
        let characters = value.chars().count();
        (characters > 0
            && characters <= Self::MAX_CHARACTERS
            && value.trim() == value
            && !value.trim().is_empty())
        .then_some(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn validate(&self) -> bool {
        Self::new(self.0.clone()).is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct McpToolDescriptionOverride {
    pub tool: McpToolName,
    pub description: McpToolDescription,
}

/// Opaque, platform-derived identity used only for pure path equality and containment.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PathComparisonKey {
    root: Vec<u8>,
    segments: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathComparisonKeyError {
    MissingRoot,
    EmptySegment,
}

impl PathComparisonKey {
    pub fn from_normalized_parts(
        root: Vec<u8>,
        segments: Vec<Vec<u8>>,
    ) -> Result<Self, PathComparisonKeyError> {
        if root.is_empty() {
            return Err(PathComparisonKeyError::MissingRoot);
        }
        if segments.iter().any(Vec::is_empty) {
            return Err(PathComparisonKeyError::EmptySegment);
        }
        Ok(Self { root, segments })
    }

    pub fn contains_or_equals(&self, candidate: &Self) -> bool {
        self.root == candidate.root && candidate.segments.starts_with(&self.segments)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub folder_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Open,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct TaskBranchBinding {
    pub repository_root: String,
    pub name: String,
}

/// Hard bound for the durable current set of local branches proven in one
/// Task's managed worktree. This is membership, not a checkout timeline.
pub const TASK_BRANCH_MEMBERSHIPS_MAX: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskBranchMembershipEvidence {
    CurrentBranch,
    WorktreeReflog,
    BranchCreationReflog,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TaskBranchMembership {
    pub id: String,
    pub repository_root: String,
    pub repository_common_dir: String,
    pub ref_name: String,
    pub first_observed_worktree_generation: u64,
    pub first_observed_oid: String,
    pub parent_ref_name: Option<String>,
    pub evidence: TaskBranchMembershipEvidence,
}

/// One bounded, monotonic set of branches observed in a Task worktree. Live
/// ref existence, tips, checkout state, and commit counts are projections.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TaskBranchSet {
    pub task_id: String,
    pub evidence_truncated: bool,
    pub memberships: Vec<TaskBranchMembership>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TaskWorktreeBinding {
    pub path: String,
}

/// Byte bound for the one current Steward-authored Task brief.
pub const TASK_STEWARD_BRIEF_MAX_BYTES: usize = 8 * 1024;
pub const TASK_DEVELOPER_NOTES_MAX: usize = 50;
pub const TASK_DEVELOPER_NOTE_ID_MAX_CHARS: usize = 120;
pub const TASK_DEVELOPER_NOTE_TEXT_MAX_CHARS: usize = 280;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskDeveloperNote {
    pub id: String,
    pub text: String,
    pub completed: bool,
}

impl TaskDeveloperNote {
    pub fn is_valid(&self) -> bool {
        !self.id.is_empty()
            && self.id.chars().count() <= TASK_DEVELOPER_NOTE_ID_MAX_CHARS
            && !self.text.trim().is_empty()
            && self.text.chars().count() <= TASK_DEVELOPER_NOTE_TEXT_MAX_CHARS
    }
}

const fn initial_steward_brief_revision() -> u64 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TaskRecord {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub brief: Option<String>,
    #[serde(default)]
    pub developer_notes: Vec<TaskDeveloperNote>,
    pub status: TaskStatus,
    #[serde(default)]
    pub archived_at_epoch_ms: Option<u64>,
    pub branch: Option<TaskBranchBinding>,
    pub worktree: Option<TaskWorktreeBinding>,
    pub worktree_generation: u64,
    /// One current Steward status brief. Replaced whole, never appended as a
    /// diary; empty means no brief.
    #[serde(default)]
    pub steward_brief_markdown: String,
    #[serde(default = "initial_steward_brief_revision")]
    pub steward_brief_revision: u64,
    pub rank: u64,
    pub created_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueLinkProvider {
    Jira,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueLinkSyncAuthority {
    None,
    LocalWins,
    RemoteWins,
}

/// Durable provider-neutral context attached to a Task without becoming part
/// of the core Task record or remote Task authority.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IssueLink {
    pub task_id: String,
    pub provider: IssueLinkProvider,
    pub external_ref: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub external_updated_at: Option<String>,
    pub url: Option<String>,
    pub sync_authority: IssueLinkSyncAuthority,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProvisioningBranchMode {
    Existing,
    Create,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NormalizedWorktreeSpec {
    pub version: u32,
    pub repository_root: String,
    pub repository_common_dir: String,
    pub destination_path: String,
    pub branch_name: String,
    pub branch_mode: ProvisioningBranchMode,
    pub base_ref: Option<String>,
    pub base_oid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProvisioningStage {
    Reserved,
    BranchCreated,
    WorktreeAdded,
    BindingCommitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProvisioningFailureKind {
    GitUnavailable,
    UnsupportedGit,
    PermissionDenied,
    RepositoryUnavailable,
    BranchConflict,
    PathConflict,
    WorktreeLocked,
    Timeout,
    OutputLimit,
    RecoveryAttention,
    OperationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeProvisioningOperation {
    pub operation_id: String,
    pub task_id: String,
    pub project_id: String,
    pub spec: NormalizedWorktreeSpec,
    pub stage: ProvisioningStage,
    pub created_branch_ref: bool,
    pub failure: Option<ProvisioningFailureKind>,
    pub started_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ManagedWorktreeProof {
    pub task_id: String,
    pub operation_id: String,
    pub worktree_generation: u64,
    pub normalized_spec_version: u32,
    pub normalized_spec: NormalizedWorktreeSpec,
    pub repository_common_dir: String,
    pub registered_worktree_path: String,
    pub branch_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeCleanupStage {
    Reserved,
    RemovePrepared,
    RemovalVerified,
    BindingCleared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeCleanupFailureKind {
    Refused,
    ManagedProofChanged,
    RepositoryUnavailable,
    PermissionDenied,
    UnsupportedGit,
    Timeout,
    OutputLimit,
    CheckoutContentAppeared,
    RemovalFailed,
    RecoveryAttention,
    OperationFailed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeCleanupMode {
    #[default]
    Safe,
    DiscardCheckoutContent,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeCleanupBlocker {
    NoBinding,
    ProvisioningInProgress,
    CleanupInProgress,
    ManagedProofMissing,
    ManagedProofMismatch,
    PathReplaced,
    PathRegistrationInconsistent,
    OrphanedManagedDirectory,
    RegistrationMismatch,
    BranchMismatch,
    HeadMismatch,
    SessionAttached,
    TrackedChanges,
    StagedChanges,
    UntrackedContent,
    IgnoredContent,
    SubmodulePresent,
    WorktreeLock,
    IndexLock,
    RepositoryUnavailable,
    PermissionDenied,
    UnsupportedGit,
    Timeout,
    OutputLimit,
    ObservationFailed,
    RecoveryAttention,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeCleanupFailure {
    pub kind: WorktreeCleanupFailureKind,
    pub blockers: Vec<WorktreeCleanupBlocker>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeCleanupOutcome {
    Removed,
    BindingCleared,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeCleanupBaseline {
    pub repository_root: String,
    pub repository_common_dir: String,
    pub worktree_path: String,
    pub registered_worktree_path: String,
    pub branch_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout_branch_ref: Option<String>,
    pub head_oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeCleanupOperation {
    pub operation_id: String,
    pub task_id: String,
    pub worktree_generation: u64,
    pub managed_worktree_operation_id: String,
    #[serde(default)]
    pub cleanup_mode: WorktreeCleanupMode,
    #[serde(default)]
    pub acknowledged_content_blockers: Vec<WorktreeCleanupBlocker>,
    pub baseline: WorktreeCleanupBaseline,
    pub stage: WorktreeCleanupStage,
    pub failure: Option<WorktreeCleanupFailure>,
    pub started_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeCleanupReceipt {
    pub operation_id: String,
    pub task_id: String,
    pub worktree_generation: u64,
    pub managed_worktree_operation_id: String,
    #[serde(default)]
    pub cleanup_mode: WorktreeCleanupMode,
    #[serde(default)]
    pub acknowledged_content_blockers: Vec<WorktreeCleanupBlocker>,
    pub outcome: WorktreeCleanupOutcome,
    pub completed_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeStaleResolutionMode {
    ForgetBinding,
    DiscardDirectory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeStaleResolutionStage {
    Reserved,
    RemovalPrepared,
    RemovalInvoked,
    RemovalVerified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeStaleResolutionFailureKind {
    Refused,
    ManagedProofChanged,
    PermissionDenied,
    RemovalFailed,
    VerificationFailed,
    RecoveryAttention,
    OperationFailed,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeStaleResolutionBlocker {
    NoBinding,
    ManagedProofMissing,
    ManagedProofMismatch,
    ProvisioningInProgress,
    CleanupInProgress,
    RepairInProgress,
    StaleDisposalInProgress,
    RepositoryUnavailable,
    CommonRepositoryChanged,
    PathAbsent,
    PathReplaced,
    RegistrationPresent,
    BranchMissing,
    GitMetadataPresent,
    SessionAttached,
    ProtectedPath,
    PermissionDenied,
    Timeout,
    ObservationFailed,
    RecoveryAttention,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeStaleResolutionFailure {
    pub kind: WorktreeStaleResolutionFailureKind,
    pub blockers: Vec<WorktreeStaleResolutionBlocker>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeStaleResolutionOperation {
    pub operation_id: String,
    pub task_id: String,
    pub managed_worktree_operation_id: Option<String>,
    pub worktree_generation: u64,
    pub target_path: String,
    pub mode: WorktreeStaleResolutionMode,
    pub stage: WorktreeStaleResolutionStage,
    pub failure: Option<WorktreeStaleResolutionFailure>,
    pub started_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeStaleResolutionReceipt {
    pub operation_id: String,
    pub task_id: String,
    pub managed_worktree_operation_id: Option<String>,
    pub worktree_generation: u64,
    pub target_path: String,
    pub mode: WorktreeStaleResolutionMode,
    pub completed_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeRepairStage {
    Reserved,
    RepairPrepared,
    RepairInvoked,
    Verified,
    ProofCommitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeRepairFailureKind {
    Refused,
    ManagedProofChanged,
    PermissionDenied,
    UnsupportedGit,
    Timeout,
    OutputLimit,
    RepairFailed,
    VerificationFailed,
    RecoveryAttention,
    OperationFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeRepairBlocker {
    NoBinding,
    ManagedProofMissing,
    ManagedProofMismatch,
    ProvisioningInProgress,
    CleanupInProgress,
    RepairInProgress,
    CommonRepositoryUnavailable,
    CommonRepositoryChanged,
    CandidateMissing,
    CandidateReplaced,
    OldPathStillPresent,
    CandidatePathConflict,
    RegistrationAlreadyMatching,
    RegistrationEvidenceMissing,
    RegistrationEvidenceAmbiguous,
    BranchMismatch,
    HeadMismatch,
    SessionAttached,
    WorktreeLock,
    IndexLock,
    PermissionDenied,
    UnsupportedGit,
    Timeout,
    OutputLimit,
    ObservationFailed,
    RecoveryAttention,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeRepairFailure {
    pub kind: WorktreeRepairFailureKind,
    pub blockers: Vec<WorktreeRepairBlocker>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeRepairOperation {
    pub operation_id: String,
    pub task_id: String,
    pub managed_worktree_operation_id: String,
    pub expected_worktree_generation: u64,
    pub candidate_path: String,
    pub stage: WorktreeRepairStage,
    pub failure: Option<WorktreeRepairFailure>,
    pub started_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeRepairReceipt {
    pub operation_id: String,
    pub task_id: String,
    pub managed_worktree_operation_id: String,
    pub previous_worktree_generation: u64,
    pub worktree_generation: u64,
    pub candidate_path: String,
    pub completed_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SessionKind {
    Terminal,
    Agent,
}

/// TermLoop's durable knowledge about whether an Agent Session has reached a
/// provider conversation that can be resumed. `Unconfirmed` deliberately does
/// not mean that no provider conversation exists: observation delivery can be
/// interrupted, so explicit Retry and Fork commands must still attempt the
/// provider operation when an exact ResumeRef is available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentConversationReadiness {
    Unconfirmed,
    LegacyUnknown,
    Resumable,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationReadinessRecord {
    pub session_id: String,
    pub readiness: AgentConversationReadiness,
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeProvider {
    Claude,
    Codex,
    Gemini,
    #[serde(other)]
    Unknown,
}

impl std::fmt::Debug for ResumeProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Gemini => "Gemini",
            Self::Unknown => "Unknown",
        })
    }
}

#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRef {
    pub provider: ResumeProvider,
    pub native_session_id: String,
}

impl ResumeRef {
    pub const MAX_NATIVE_ID_BYTES: usize = 256;

    pub fn validate(&self) -> bool {
        !self.native_session_id.is_empty()
            && self.native_session_id.len() <= Self::MAX_NATIVE_ID_BYTES
            && !self.native_session_id.chars().any(char::is_control)
            && match self.provider {
                ResumeProvider::Claude | ResumeProvider::Gemini => {
                    uuid::Uuid::parse_str(&self.native_session_id)
                        .is_ok_and(|value| value.hyphenated().to_string() == self.native_session_id)
                }
                ResumeProvider::Codex => true,
                ResumeProvider::Unknown => false,
            }
    }

    pub fn for_provider(provider: ResumeProvider, native_session_id: String) -> Option<Self> {
        let value = Self {
            provider,
            native_session_id,
        };
        value.validate().then_some(value)
    }
}

impl std::fmt::Debug for ResumeRef {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResumeRef")
            .field("provider", &self.provider)
            .field("native_session_id", &"<private>")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeLaunchGuard {
    pub task_id: String,
    pub managed_worktree_operation_id: String,
    pub worktree_generation: u64,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResumeFailureReason {
    ResumeRefMissing,
    InvalidResumeRef,
    ResumeCapabilityUnavailable,
    RuntimeOwnershipUncertain,
    ProviderSessionUnavailable,
    ProviderHistoryDamaged,
    ResumeRejected,
    ProviderMismatch,
    StartupTimedOut,
    DaemonInterrupted,
    ResumeQueueFull,
    PtySpawnFailed,
    CwdUnavailable,
    LaunchReserved,
    RuntimeConflict,
}

impl ResumeFailureReason {
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::ResumeCapabilityUnavailable
                | Self::RuntimeOwnershipUncertain
                | Self::ResumeRejected
                | Self::StartupTimedOut
                | Self::DaemonInterrupted
                | Self::ResumeQueueFull
                | Self::PtySpawnFailed
                | Self::CwdUnavailable
                | Self::LaunchReserved
                | Self::RuntimeConflict
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcessDescriptor {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub agent_id: Option<String>,
    pub template_ref: Option<String>,
    pub template_version: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentLaunchSelection {
    pub model: String,
    pub permission: String,
    pub reasoning: String,
}

/// Exact current provenance for one Improve-with-agent Session. This is a
/// target identity used to reopen the same provider conversation, not Session
/// parentage, history, or launch authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImproverSessionTargetKind {
    StewardInstructions,
    WorkerInstructions,
    RoutineInstructions,
    RoutineBuilder,
    Playbook,
    RunConfiguration,
    NewRunConfiguration,
    SettingsSkill,
    SettingsPrompt,
    SettingsMcpTool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ImproverSessionTarget {
    pub target_kind: ImproverSessionTargetKind,
    pub target_id: Option<String>,
}

impl ImproverSessionTarget {
    pub fn is_well_formed(&self) -> bool {
        match (&self.target_kind, self.target_id.as_deref()) {
            (
                ImproverSessionTargetKind::StewardInstructions
                | ImproverSessionTargetKind::Playbook,
                None,
            ) => true,
            (
                ImproverSessionTargetKind::StewardInstructions
                | ImproverSessionTargetKind::Playbook,
                Some(_),
            ) => false,
            (_, Some(target_id)) => {
                !target_id.is_empty()
                    && target_id.len() <= 4096
                    && !target_id.chars().any(char::is_control)
            }
            (_, None) => false,
        }
    }
}

impl Default for AgentLaunchSelection {
    fn default() -> Self {
        Self {
            model: "default".into(),
            permission: "default".into(),
            reasoning: "default".into(),
        }
    }
}

impl AgentLaunchSelection {
    pub fn new(model: &str, permission: &str, reasoning: &str) -> Self {
        Self {
            model: model.to_owned(),
            permission: permission.to_owned(),
            reasoning: reasoning.to_owned(),
        }
    }

    pub fn is_well_formed(&self) -> bool {
        [&self.model, &self.permission, &self.reasoning]
            .into_iter()
            .all(|value| {
                !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
            })
    }

    pub fn is_default(&self) -> bool {
        self.model == "default" && self.permission == "default" && self.reasoning == "default"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AskToContinuation {
    pub conversation_id: String,
    pub current_request_id: Option<String>,
}

impl AskToContinuation {
    pub fn is_well_formed(&self) -> bool {
        fn valid_id(value: &str) -> bool {
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        }

        valid_id(&self.conversation_id) && self.current_request_id.as_deref().is_none_or(valid_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAgentLaunchSelection {
    pub agent_id: String,
    pub selection: AgentLaunchSelection,
}

/// How hard TermLoop should try to keep the host awake.
///
/// This is a preference, not an observation. Whether a hold is actually in
/// effect additionally depends on the OS supporting one and, for
/// `WhileAgentsRun`, on an agent actually running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepAwakeMode {
    /// Never hold the host awake. The default: a machine that sleeps is the
    /// behavior a user already agreed to with their OS settings.
    #[default]
    Off,
    /// Hold only while at least one TermLoop-managed agent process is alive.
    WhileAgentsRun,
    /// Hold for as long as TermLoop is running, agents or not.
    Always,
}

/// The durable keep-awake preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakePreference {
    pub mode: KeepAwakeMode,
    /// Whether the screen should stay lit too. Separate from the mode because
    /// keeping a machine computing and keeping a panel on are different costs.
    #[serde(default)]
    pub keep_display_awake: bool,
    /// Absolute wall-clock expiry for a temporary hold. The daemon supplies
    /// the clock value; domain only carries the durable fact.
    #[serde(default)]
    pub expires_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DurableAgentPlanSource {
    ClaudeHook,
    CodexAppServer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DurableAgentPlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableAgentPlanStep {
    pub text: String,
    pub status: DurableAgentPlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableAgentPlan {
    pub session_id: String,
    pub source: DurableAgentPlanSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    pub steps: Vec<DurableAgentPlanStep>,
    pub updated_at_epoch_ms: u64,
}

impl DurableAgentPlan {
    pub fn is_well_formed(&self) -> bool {
        !self.session_id.is_empty()
            && self.session_id.len() <= 128
            && self
                .explanation
                .as_ref()
                .is_none_or(|value| value.len() <= 1_024)
            && self.steps.len() <= 32
            && self.steps.iter().all(|step| {
                !step.text.trim().is_empty()
                    && step.text.len() <= 512
                    && step
                        .provider_task_id
                        .as_ref()
                        .is_none_or(|task_id| !task_id.trim().is_empty() && task_id.len() <= 128)
            })
            && self.steps.iter().enumerate().all(|(index, step)| {
                step.provider_task_id.as_ref().is_none_or(|task_id| {
                    !self.steps[index + 1..]
                        .iter()
                        .any(|candidate| candidate.provider_task_id.as_ref() == Some(task_id))
                })
            })
    }
}

impl SavedAgentLaunchSelection {
    pub fn new(agent_id: &str, selection: AgentLaunchSelection) -> Self {
        Self {
            agent_id: agent_id.to_owned(),
            selection,
        }
    }

    pub fn is_valid(&self) -> bool {
        agent_id_is_well_formed(&self.agent_id) && self.selection.is_well_formed()
    }
}

pub const MAX_AGENT_ID_BYTES: usize = 64;

/// Closed Agent Sessions remain recoverable for one fixed recycle-bin window.
/// The timestamp lives beside the retained current Session descriptor rather
/// than turning lifecycle state into stored history.
pub const DELETED_SESSION_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

/// Durable and wire agent identities are provider-neutral slugs. Whether this
/// build can launch a well-formed identity is a catalog decision owned by the
/// agents module, not a domain invariant.
pub fn agent_id_is_well_formed(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((first, rest)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= MAX_AGENT_ID_BYTES
        && first.is_ascii_lowercase()
        && rest
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !bytes.windows(2).any(|pair| pair == b"--")
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub kind: SessionKind,
    pub process: ProcessDescriptor,
    #[serde(default)]
    pub launch_selection: AgentLaunchSelection,
    pub lifecycle_state: String,
    pub runtime_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at_epoch_ms: Option<u64>,
    #[serde(default)]
    pub ask_to_source_session_id: Option<String>,
    /// Run configuration this Terminal Session was started from. Current
    /// provenance for projection grouping, never parentage or run history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_configuration_id: Option<String>,
    /// Exact current target for an Improve-with-agent Session. Older state has
    /// no value and remains readable; new improvers always set it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub improver_target: Option<ImproverSessionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_to_continuation: Option<AskToContinuation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_ref: Option<ResumeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_launch_guard: Option<ResumeLaunchGuard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_failure: Option<ResumeFailureReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeletedSessionRecord {
    pub session: SessionRecord,
    pub deleted_at_epoch_ms: u64,
    pub conversation_readiness: AgentConversationReadiness,
}

impl DeletedSessionRecord {
    pub fn purge_at_epoch_ms(&self) -> u64 {
        self.deleted_at_epoch_ms
            .saturating_add(DELETED_SESSION_RETENTION_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_launch_selection_requires_bounded_plain_values() {
        assert!(AgentLaunchSelection::default().is_well_formed());
        assert!(AgentLaunchSelection::default().is_default());
        assert!(
            AgentLaunchSelection::new("gpt-5.6-sol", "bypassPermissions", "high").is_well_formed()
        );
        assert!(!AgentLaunchSelection::new("", "default", "default").is_well_formed());
        assert!(!AgentLaunchSelection::new("default", "plan\n", "default").is_well_formed());
        assert!(
            !AgentLaunchSelection::new(&"x".repeat(129), "default", "default").is_well_formed()
        );
        assert!(!AgentLaunchSelection::new("default", "plan", "default").is_default());
        assert!(
            SavedAgentLaunchSelection::new(
                "codex",
                AgentLaunchSelection::new("gpt-5.6-sol", "bypassPermissions", "high"),
            )
            .is_valid()
        );
        assert!(
            SavedAgentLaunchSelection::new("gemini", AgentLaunchSelection::default()).is_valid()
        );
        for invalid in [
            "",
            "Gemini",
            "gemini_cli",
            "-gemini",
            "gemini-",
            "gemini--cli",
        ] {
            assert!(
                !SavedAgentLaunchSelection::new(invalid, AgentLaunchSelection::default())
                    .is_valid(),
                "accepted invalid agent id {invalid}"
            );
        }
    }

    #[test]
    fn improver_target_requires_the_identity_appropriate_to_its_kind() {
        assert!(
            ImproverSessionTarget {
                target_kind: ImproverSessionTargetKind::StewardInstructions,
                target_id: None,
            }
            .is_well_formed()
        );
        assert!(
            ImproverSessionTarget {
                target_kind: ImproverSessionTargetKind::RoutineInstructions,
                target_id: Some("routine-1".into()),
            }
            .is_well_formed()
        );
        assert!(
            !ImproverSessionTarget {
                target_kind: ImproverSessionTargetKind::RoutineInstructions,
                target_id: None,
            }
            .is_well_formed()
        );
    }

    fn key(root: &[u8], segments: &[&[u8]]) -> PathComparisonKey {
        PathComparisonKey::from_normalized_parts(
            root.to_vec(),
            segments.iter().map(|segment| segment.to_vec()).collect(),
        )
        .unwrap()
    }

    #[test]
    fn path_comparison_is_component_based_and_root_scoped() {
        let project = key(b"volume-a", &[b"projects", b"termloop"]);
        let nested = key(b"volume-a", &[b"projects", b"termloop", b"src"]);
        let textual_sibling = key(b"volume-a", &[b"projects", b"termloop-next"]);
        let other_root = key(b"volume-b", &[b"projects", b"termloop", b"src"]);

        assert!(project.contains_or_equals(&project));
        assert!(project.contains_or_equals(&nested));
        assert!(!nested.contains_or_equals(&project));
        assert!(!project.contains_or_equals(&textual_sibling));
        assert!(!project.contains_or_equals(&other_root));
    }

    #[test]
    fn path_comparison_rejects_malformed_platform_inputs() {
        assert_eq!(
            PathComparisonKey::from_normalized_parts(vec![], vec![]),
            Err(PathComparisonKeyError::MissingRoot)
        );
        assert_eq!(
            PathComparisonKey::from_normalized_parts(vec![1], vec![vec![]]),
            Err(PathComparisonKeyError::EmptySegment)
        );
    }

    #[test]
    fn resume_reference_is_bounded_provider_identity_and_debug_is_private() {
        let claude = ResumeRef::for_provider(
            ResumeProvider::Claude,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        assert!(!format!("{claude:?}").contains(&claude.native_session_id));
        assert!(ResumeRef::for_provider(ResumeProvider::Claude, "not-a-uuid".into()).is_none());
        assert!(
            ResumeRef::for_provider(ResumeProvider::Codex, "thread\nidentity".into()).is_none()
        );
        assert!(
            ResumeRef::for_provider(
                ResumeProvider::Codex,
                "x".repeat(ResumeRef::MAX_NATIVE_ID_BYTES + 1),
            )
            .is_none()
        );
    }

    #[test]
    fn mcp_tool_descriptions_are_closed_bounded_and_not_silently_trimmed() {
        assert_eq!(
            McpToolName::ALL.map(McpToolName::as_str),
            [
                "ask_to",
                "send_to_agent",
                "reply_to_request",
                "project_read",
                "task_read",
                "agent_status_read",
                "task_agent_transcript_tail_read",
                "task_agent_request",
                "routine_report_read",
                "companion_transcript_read",
                "steward_system_prompt_read",
                "steward_system_prompt_update",
                "task_agent_start",
                "task_create",
                "task_rename",
                "task_update_brief",
                "task_set_jira_url",
                "task_close",
                "task_reopen",
                "task_delete",
                "agent_message_send",
                "steward_suggest",
                "routine_finding_read",
                "routine_finding_resolve",
                "worker_get_next_routine",
                "worker_complete_assignment",
                "playbook_read",
                "task_set_steward_brief",
                "configuration_version_read",
                "configuration_version_write",
            ]
        );
        assert!("unknown".parse::<McpToolName>().is_err());
        assert!(McpToolDescription::new("Visible instruction".into()).is_some());
        assert!(McpToolDescription::new("".into()).is_none());
        assert!(McpToolDescription::new(" instruction ".into()).is_none());
        assert!(McpToolDescription::new("x".repeat(McpToolDescription::MAX_CHARACTERS)).is_some());
        assert!(
            McpToolDescription::new("x".repeat(McpToolDescription::MAX_CHARACTERS + 1)).is_none()
        );
    }

    #[test]
    fn ask_to_continuation_is_bounded() {
        let valid = AskToContinuation {
            conversation_id: "conversation".into(),
            current_request_id: Some("request".into()),
        };
        assert!(valid.is_well_formed());
        assert!(
            AskToContinuation {
                current_request_id: None,
                ..valid.clone()
            }
            .is_well_formed()
        );
        assert!(
            !AskToContinuation {
                conversation_id: "x".repeat(129),
                ..valid
            }
            .is_well_formed()
        );
    }
}
