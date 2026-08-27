#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionRelocationStage {
    SourceRetiring,
    TargetStarting,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionRelocationTarget {
    #[default]
    TaskWorktree,
    ProjectRoot,
}

/// One bounded current operation for replacing an ordinary Agent PTY with a
/// resume in another managed worktree. This is recovery authority, not Task
/// parentage or durable Session history.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionRelocationOperation {
    pub operation_id: String,
    pub session_id: String,
    pub project_id: String,
    pub source_runtime_epoch: u64,
    pub source_cwd: String,
    #[serde(default)]
    pub target: SessionRelocationTarget,
    /// Target Task for `taskWorktree`; the proven source Task for `projectRoot`.
    pub target_task_id: String,
    pub target_cwd: String,
    pub target_worktree_generation: u64,
    pub target_managed_worktree_operation_id: String,
    pub stage: SessionRelocationStage,
    pub started_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

/// The one current successful relocation result for a Session. It exists only
/// to make a lost command response safely retryable; a newer relocation or
/// runtime generation supersedes it, so this is not durable Session history or
/// Task parentage.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionRelocationReceipt {
    pub operation_id: String,
    pub session_id: String,
    pub project_id: String,
    #[serde(default)]
    pub target: SessionRelocationTarget,
    /// Target Task for `taskWorktree`; the proven source Task for `projectRoot`.
    pub target_task_id: String,
    pub target_cwd: String,
    pub target_worktree_generation: u64,
    pub target_managed_worktree_operation_id: String,
    pub runtime_epoch: u64,
}
