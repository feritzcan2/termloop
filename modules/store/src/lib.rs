#![forbid(unsafe_code)]

mod journal;
mod migration;
mod provider_cache;
mod records;

pub use records::{PlaybookApply, ProjectAssistantReset};
mod validation;

pub use provider_cache::{
    CachedPullRequest, ProviderCacheFailure, ProviderCacheHandle, ProviderCacheRow,
};

use migration::decode_and_migrate_state;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use termloop_domain::{
    AgentConversationReadiness, AgentConversationReadinessRecord, CompanionMessage,
    ConfigurationVersion, ConfigurationVersionSelection, DeletedSessionRecord, DurableAgentPlan,
    IssueLink, KeepAwakePreference, ManagedWorktreeProof, McpToolDescriptionOverride,
    PlaybookConfiguration, PlaybookStepProgress, ProjectRecord, ProjectTaskAutomationConfiguration,
    RunConfiguration, RunSetupMark, SavedAgentLaunchSelection, SessionArchiveOperation,
    SessionRecord, SessionRelocationOperation, SessionRelocationReceipt, StewardConfiguration,
    StewardConversationRef, TaskArchiveOperation, TaskArchiveSuspension, TaskBranchBinding,
    TaskRecord, TaskSourceConfiguration, TaskWorktreeBinding, TrackerConfiguration,
    WorkerConfiguration, WorktreeCleanupOperation, WorktreeCleanupReceipt,
    WorktreeProvisioningOperation, WorktreeRepairOperation, WorktreeRepairReceipt,
    WorktreeStaleResolutionOperation, WorktreeStaleResolutionReceipt,
};

// Schema 20 was independently assigned to Ask-To continuation and IssueLink
// sidecars before the branches met; 21 was already written by the Ask-To
// no-expiry migration. Version 22 is the first integrated current schema.
// Version 32 was then independently assigned twice in the same way — once to
// run configurations and setup marks, once to the per-Project delivery
// Playbook — so 33 is the version that means both, and a state file written
// as 32 by either branch migrates into it. Version 34 retires Playbook rules
// and adds per-Task step verdicts. Version 35 adds the explicit persistent
// assistant permission selection. Version 36 repairs orphaned assistant
// conversation-readiness sidecars left by early descriptor cleanup. Version
// 37 added bounded Routine action candidates. Version 38 restores the Worker
// boundary: factual findings are pending Steward review, and each Routine has
// separate Worker-check and Steward-response instructions. Version 39 adds the
// 30-day current Deleted Agent recycle bin. Version 40 adds bounded immutable
// user-configuration versions; it does not retain execution or Task history.
// Version 41 separates the active snapshot pointer from immutable versions so
// moving between existing versions does not append synthetic history. Version
// 42 adds Jira Task Sources. Version 43 moves provider-neutral Task automation
// from each source to one Project sidecar. Version 44 adds the source-owned
// active-Task WIP limit for automatic import.
const CURRENT_SCHEMA_VERSION: u32 = 45;

pub struct CoreWriteAuthority {
    _private: (),
}

#[doc(hidden)]
pub fn issue_core_write_authority_for_composition() -> CoreWriteAuthority {
    CoreWriteAuthority { _private: () }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CurrentState {
    schema_version: u32,
    revision: u64,
    #[serde(default)]
    mcp_tool_description_overrides: Vec<McpToolDescriptionOverride>,
    projects: Vec<ProjectRecord>,
    #[serde(default)]
    tasks: Vec<TaskRecord>,
    #[serde(default)]
    task_archive_operations: Vec<TaskArchiveOperation>,
    #[serde(default)]
    task_archive_suspensions: Vec<TaskArchiveSuspension>,
    #[serde(default)]
    session_archive_operations: Vec<SessionArchiveOperation>,
    #[serde(default)]
    session_relocation_operations: Vec<SessionRelocationOperation>,
    #[serde(default)]
    session_relocation_receipts: Vec<SessionRelocationReceipt>,
    #[serde(default)]
    issue_links: Vec<IssueLink>,
    #[serde(default)]
    task_source_configurations: Vec<TaskSourceConfiguration>,
    #[serde(default)]
    project_task_automation_configurations: Vec<ProjectTaskAutomationConfiguration>,
    #[serde(default)]
    provisioning_operations: Vec<WorktreeProvisioningOperation>,
    #[serde(default)]
    managed_worktrees: Vec<ManagedWorktreeProof>,
    #[serde(default)]
    cleanup_operations: Vec<WorktreeCleanupOperation>,
    #[serde(default)]
    cleanup_receipts: Vec<WorktreeCleanupReceipt>,
    #[serde(default)]
    repair_operations: Vec<WorktreeRepairOperation>,
    #[serde(default)]
    repair_receipts: Vec<WorktreeRepairReceipt>,
    #[serde(default)]
    stale_resolution_operations: Vec<WorktreeStaleResolutionOperation>,
    #[serde(default)]
    stale_resolution_receipts: Vec<WorktreeStaleResolutionReceipt>,
    #[serde(default)]
    companion_messages: Vec<CompanionMessage>,
    #[serde(default)]
    steward_configurations: Vec<StewardConfiguration>,
    #[serde(default)]
    steward_conversation_refs: Vec<StewardConversationRef>,
    #[serde(default)]
    tracker_configurations: Vec<TrackerConfiguration>,
    #[serde(default)]
    playbook_configurations: Vec<PlaybookConfiguration>,
    #[serde(default)]
    playbook_step_progress: Vec<PlaybookStepProgress>,
    #[serde(default)]
    worker_configurations: Vec<WorkerConfiguration>,
    #[serde(default)]
    run_configurations: Vec<RunConfiguration>,
    #[serde(default)]
    configuration_versions: Vec<ConfigurationVersion>,
    #[serde(default)]
    configuration_version_selections: Vec<ConfigurationVersionSelection>,
    #[serde(default)]
    run_setup_marks: Vec<RunSetupMark>,
    #[serde(default)]
    last_agent_launch_selection: Option<SavedAgentLaunchSelection>,
    #[serde(default)]
    keep_awake_preference: KeepAwakePreference,
    #[serde(default)]
    agent_plans: Vec<DurableAgentPlan>,
    #[serde(default)]
    agent_conversation_readiness: Vec<AgentConversationReadinessRecord>,
    sessions: Vec<SessionRecord>,
    #[serde(default)]
    deleted_sessions: Vec<DeletedSessionRecord>,
}

impl Default for CurrentState {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            revision: 0,
            mcp_tool_description_overrides: vec![],
            projects: vec![],
            tasks: vec![],
            task_archive_operations: vec![],
            task_archive_suspensions: vec![],
            session_archive_operations: vec![],
            session_relocation_operations: vec![],
            session_relocation_receipts: vec![],
            issue_links: vec![],
            task_source_configurations: vec![],
            project_task_automation_configurations: vec![],
            provisioning_operations: vec![],
            managed_worktrees: vec![],
            cleanup_operations: vec![],
            cleanup_receipts: vec![],
            repair_operations: vec![],
            repair_receipts: vec![],
            stale_resolution_operations: vec![],
            stale_resolution_receipts: vec![],
            companion_messages: vec![],
            steward_configurations: vec![],
            steward_conversation_refs: vec![],
            tracker_configurations: vec![],
            playbook_configurations: vec![],
            playbook_step_progress: vec![],
            worker_configurations: vec![],
            run_configurations: vec![],
            configuration_versions: vec![],
            configuration_version_selections: vec![],
            run_setup_marks: vec![],
            last_agent_launch_selection: None,
            keep_awake_preference: KeepAwakePreference::default(),
            agent_plans: vec![],
            agent_conversation_readiness: vec![],
            sessions: vec![],
            deleted_sessions: vec![],
        }
    }
}

pub struct Store {
    path: PathBuf,
    state: CurrentState,
    persisted_bytes: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("unsupported state schema {0}")]
    UnsupportedSchema(u32),
    #[error("record already exists")]
    AlreadyExists,
    #[error("record not found")]
    NotFound,
    #[error("project has Task worktrees")]
    ProjectHasWorktrees,
    #[error("constraint violation")]
    ConstraintViolation,
    #[error("revision conflict")]
    RevisionConflict,
    #[error("resume reference is invalid")]
    InvalidResumeRef,
    #[error("resume provider does not match the Session provider")]
    ResumeProviderMismatch,
    #[error("a different resume reference is already established")]
    ResumeRefReplacement,
    #[error("session cannot be closed while a runtime may exist")]
    SessionNotClosable,
    #[error("Companion transcript quota exceeded")]
    CompanionTranscriptQuotaExceeded,
    #[error("operation ID {operation_id} was reused with a different specification")]
    OperationIdReused { operation_id: String },
    #[error("provisioning operation {operation_id} is already in progress")]
    JournalConflict { operation_id: String },
    #[error("worktree path is held by Task {task_id}")]
    WorktreePathHeld { task_id: String },
    #[error("branch is held by Task {task_id}")]
    BranchHeld { task_id: String },
    #[error("managed worktree proof changed for Task {task_id}")]
    ManagedWorktreeProofChanged { task_id: String },
    #[error("corrupt current-state record")]
    CorruptRecord,
    #[error("storage error: {0}")]
    Io(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginProvisioningOutcome {
    Started(WorktreeProvisioningOperation),
    Current(WorktreeProvisioningOperation),
    Completed(ManagedWorktreeProof),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginStaleResolutionOutcome {
    Started(WorktreeStaleResolutionOperation),
    Current(WorktreeStaleResolutionOperation),
    Completed(WorktreeStaleResolutionReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginCleanupOutcome {
    Started(WorktreeCleanupOperation),
    Current(WorktreeCleanupOperation),
    Completed(WorktreeCleanupReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginRepairOutcome {
    Started(WorktreeRepairOperation),
    Current(WorktreeRepairOperation),
    Completed(WorktreeRepairReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupCommit {
    pub task: TaskRecord,
    pub receipt: WorktreeCleanupReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleResolutionCommit {
    pub task: TaskRecord,
    pub receipt: WorktreeStaleResolutionReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepairCommit {
    pub task: TaskRecord,
    pub proof: ManagedWorktreeProof,
    pub receipt: WorktreeRepairReceipt,
}

pub struct ProvisioningCommit {
    pub branch: TaskBranchBinding,
    pub worktree: TaskWorktreeBinding,
    pub proof: ManagedWorktreeProof,
    pub updated_at_epoch_ms: u64,
}

impl Store {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let path = path.into();
        let (state, migrated) = if path.exists() {
            decode_and_migrate_state(&fs::read(&path).map_err(io_error)?)?
        } else {
            (CurrentState::default(), false)
        };
        let persisted_bytes = fs::metadata(&path)
            .ok()
            .and_then(|metadata| usize::try_from(metadata.len()).ok())
            .unwrap_or(0);
        let mut store = Self {
            path,
            state,
            persisted_bytes,
        };
        if migrated {
            store.persisted_bytes =
                persist_state(&store.path, &store.state, store.persisted_bytes)?;
        }
        Ok(store)
    }

    pub fn open_provider_cache(&self) -> Result<ProviderCacheHandle, StoreError> {
        let directory = self.path.parent().unwrap_or_else(|| Path::new("."));
        ProviderCacheHandle::open(directory.join("provider-cache.v1.json"))
    }

    pub fn revision(&self) -> u64 {
        self.state.revision
    }
    pub fn projects(&self) -> &[ProjectRecord] {
        &self.state.projects
    }
    pub fn mcp_tool_description_overrides(&self) -> &[McpToolDescriptionOverride] {
        &self.state.mcp_tool_description_overrides
    }
    pub fn keep_awake_preference(&self) -> KeepAwakePreference {
        self.state.keep_awake_preference
    }
    pub fn tasks(&self) -> &[TaskRecord] {
        &self.state.tasks
    }
    pub fn task_archive_operations(&self) -> &[TaskArchiveOperation] {
        &self.state.task_archive_operations
    }
    pub fn task_archive_suspensions(&self) -> &[TaskArchiveSuspension] {
        &self.state.task_archive_suspensions
    }
    pub fn session_archive_operations(&self) -> &[SessionArchiveOperation] {
        &self.state.session_archive_operations
    }
    pub fn session_relocation_operations(&self) -> &[SessionRelocationOperation] {
        &self.state.session_relocation_operations
    }
    pub fn session_relocation_receipts(&self) -> &[SessionRelocationReceipt] {
        &self.state.session_relocation_receipts
    }
    pub fn issue_links(&self) -> &[IssueLink] {
        &self.state.issue_links
    }
    pub fn task_source_configurations(&self) -> &[TaskSourceConfiguration] {
        &self.state.task_source_configurations
    }
    pub fn project_task_automation_configurations(&self) -> &[ProjectTaskAutomationConfiguration] {
        &self.state.project_task_automation_configurations
    }
    pub fn sessions(&self) -> &[SessionRecord] {
        &self.state.sessions
    }
    pub fn deleted_sessions(&self) -> &[DeletedSessionRecord] {
        &self.state.deleted_sessions
    }
    pub fn agent_plans(&self) -> &[DurableAgentPlan] {
        &self.state.agent_plans
    }
    pub fn agent_conversation_readiness(
        &self,
        session_id: &str,
    ) -> Option<AgentConversationReadiness> {
        self.state
            .agent_conversation_readiness
            .iter()
            .find(|record| record.session_id == session_id)
            .map(|record| record.readiness)
    }
    pub fn last_agent_launch_selection(&self) -> Option<&SavedAgentLaunchSelection> {
        self.state.last_agent_launch_selection.as_ref()
    }
    pub fn provisioning_operations(&self) -> &[WorktreeProvisioningOperation] {
        &self.state.provisioning_operations
    }
    pub fn managed_worktrees(&self) -> &[ManagedWorktreeProof] {
        &self.state.managed_worktrees
    }
    pub fn cleanup_operations(&self) -> &[WorktreeCleanupOperation] {
        &self.state.cleanup_operations
    }
    pub fn cleanup_receipts(&self) -> &[WorktreeCleanupReceipt] {
        &self.state.cleanup_receipts
    }
    pub fn repair_operations(&self) -> &[WorktreeRepairOperation] {
        &self.state.repair_operations
    }

    pub fn stale_resolution_operations(&self) -> &[WorktreeStaleResolutionOperation] {
        &self.state.stale_resolution_operations
    }

    pub fn stale_resolution_receipts(&self) -> &[WorktreeStaleResolutionReceipt] {
        &self.state.stale_resolution_receipts
    }
    pub fn repair_receipts(&self) -> &[WorktreeRepairReceipt] {
        &self.state.repair_receipts
    }

    fn commit_or_restore(&mut self, previous: CurrentState) -> Result<u64, StoreError> {
        match self.commit() {
            Ok(revision) => Ok(revision),
            Err(error) => {
                self.state = previous;
                Err(error)
            }
        }
    }

    fn commit(&mut self) -> Result<u64, StoreError> {
        self.state.revision += 1;
        self.persisted_bytes = persist_state(&self.path, &self.state, self.persisted_bytes)?;
        Ok(self.state.revision)
    }
}

fn persist_state(
    path: &Path,
    state: &CurrentState,
    previous_size: usize,
) -> Result<usize, StoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    // Current state is rewritten atomically, but it does not need presentation
    // whitespace. Compact JSON materially shortens the serialized core-lock
    // hold, and reusing the prior file size avoids repeated large allocations.
    let mut bytes = Vec::with_capacity(previous_size.max(4 * 1024));
    serde_json::to_writer(&mut bytes, state).map_err(|error| StoreError::Io(error.to_string()))?;
    termloop_platform::atomic_replace_private_file(path, &bytes)
        .map_err(|error| StoreError::Io(error.to_string()))?;
    Ok(bytes.len())
}

fn operation_id_owned_by_provisioning(state: &CurrentState, operation_id: &str) -> bool {
    state
        .provisioning_operations
        .iter()
        .any(|operation| operation.operation_id == operation_id)
        || state
            .managed_worktrees
            .iter()
            .any(|proof| proof.operation_id == operation_id)
}

fn operation_id_owned_by_cleanup(state: &CurrentState, operation_id: &str) -> bool {
    state.cleanup_operations.iter().any(|operation| {
        operation.operation_id == operation_id
            || operation.managed_worktree_operation_id == operation_id
    }) || state.cleanup_receipts.iter().any(|receipt| {
        receipt.operation_id == operation_id
            || receipt.managed_worktree_operation_id == operation_id
    })
}

fn operation_id_owned_anywhere(state: &CurrentState, operation_id: &str) -> bool {
    state
        .task_archive_operations
        .iter()
        .any(|operation| operation.operation_id == operation_id)
        || state
            .session_archive_operations
            .iter()
            .any(|operation| operation.operation_id == operation_id)
        || state
            .session_relocation_operations
            .iter()
            .any(|operation| operation.operation_id == operation_id)
        || state
            .session_relocation_receipts
            .iter()
            .any(|receipt| receipt.operation_id == operation_id)
        || operation_id_owned_by_provisioning(state, operation_id)
        || operation_id_owned_by_cleanup(state, operation_id)
        || state.repair_operations.iter().any(|operation| {
            operation.operation_id == operation_id
                || operation.managed_worktree_operation_id == operation_id
        })
        || state.repair_receipts.iter().any(|receipt| {
            receipt.operation_id == operation_id
                || receipt.managed_worktree_operation_id == operation_id
        })
        || state.stale_resolution_operations.iter().any(|operation| {
            operation.operation_id == operation_id
                || operation.managed_worktree_operation_id.as_deref() == Some(operation_id)
        })
        || state.stale_resolution_receipts.iter().any(|receipt| {
            receipt.operation_id == operation_id
                || receipt.managed_worktree_operation_id.as_deref() == Some(operation_id)
        })
}

fn ensure_stale_resolution_tuple(
    state: &CurrentState,
    operation: &WorktreeStaleResolutionOperation,
) -> Result<(), StoreError> {
    let task = state
        .tasks
        .iter()
        .find(|task| task.id == operation.task_id)
        .ok_or(StoreError::NotFound)?;
    let proof = state
        .managed_worktrees
        .iter()
        .find(|proof| proof.task_id == operation.task_id);
    let matches = task.worktree_generation == operation.worktree_generation
        && task
            .worktree
            .as_ref()
            .is_some_and(|binding| binding.path == operation.target_path)
        && match (&operation.managed_worktree_operation_id, proof) {
            (Some(expected), Some(proof)) => {
                operation.worktree_generation > 0
                    && proof.worktree_generation == operation.worktree_generation
                    && proof.operation_id == *expected
                    && proof.registered_worktree_path == operation.target_path
            }
            (None, None) => operation.worktree_generation == 0 && task.branch.is_some(),
            _ => false,
        };
    matches
        .then_some(())
        .ok_or_else(|| StoreError::ManagedWorktreeProofChanged {
            task_id: operation.task_id.clone(),
        })
}

fn ensure_repair_tuple(
    state: &CurrentState,
    operation: &WorktreeRepairOperation,
) -> Result<(), StoreError> {
    let task = state
        .tasks
        .iter()
        .find(|task| task.id == operation.task_id)
        .ok_or(StoreError::NotFound)?;
    let proof = state
        .managed_worktrees
        .iter()
        .find(|proof| proof.task_id == operation.task_id)
        .ok_or(StoreError::ManagedWorktreeProofChanged {
            task_id: operation.task_id.clone(),
        })?;
    let binding = task
        .worktree
        .as_ref()
        .ok_or(StoreError::ManagedWorktreeProofChanged {
            task_id: operation.task_id.clone(),
        })?;
    if task.worktree_generation != operation.expected_worktree_generation
        || proof.worktree_generation != operation.expected_worktree_generation
        || proof.operation_id != operation.managed_worktree_operation_id
        || binding.path != proof.registered_worktree_path
    {
        return Err(StoreError::ManagedWorktreeProofChanged {
            task_id: operation.task_id.clone(),
        });
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::Io(error.to_string())
}

pub fn default_state_path(state_directory: &Path) -> PathBuf {
    state_directory.join("state.v1.json")
}

#[cfg(test)]
mod tests;
