use super::ResumeFailureReason;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionArchiveOperationState {
    Prepared,
    RecoveryAttention,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArchiveOperation {
    pub operation_id: String,
    pub session_id: String,
    pub project_id: String,
    pub runtime_epoch: u64,
    pub state: SessionArchiveOperationState,
    pub requested_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArchiveSuspension {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub session_id: String,
    pub archived_at_epoch_ms: u64,
    pub prior_lifecycle_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_resume_failure: Option<ResumeFailureReason>,
    #[serde(default)]
    pub reason: TaskSuspensionReason,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskSuspensionReason {
    #[default]
    Archived,
    ClosedWorktreeRemoved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskArchiveOperationState {
    Prepared,
    RecoveryAttention,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArchiveTarget {
    pub session_id: String,
    pub runtime_epoch: u64,
    pub prior_lifecycle_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_resume_failure: Option<ResumeFailureReason>,
    pub was_live_agent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArchiveOperation {
    pub operation_id: String,
    pub task_id: String,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub worktree_generation: u64,
    pub targets: Vec<TaskArchiveTarget>,
    pub state: TaskArchiveOperationState,
}
