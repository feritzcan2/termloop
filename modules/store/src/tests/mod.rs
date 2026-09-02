use super::*;
use serde_json::json;
use termloop_domain::{
    AskToContinuation, NormalizedWorktreeSpec, ProcessDescriptor, ProvisioningBranchMode,
    ProvisioningFailureKind, ProvisioningStage, ResumeFailureReason, ResumeProvider, ResumeRef,
    SessionKind, TaskStatus, WorktreeCleanupBlocker, WorktreeCleanupFailure,
    WorktreeCleanupFailureKind, WorktreeCleanupMode, WorktreeCleanupOutcome, WorktreeCleanupStage,
    WorktreeRepairBlocker, WorktreeRepairFailure, WorktreeRepairFailureKind,
    WorktreeRepairOperation, WorktreeRepairStage, WorktreeStaleResolutionMode,
    WorktreeStaleResolutionOperation, WorktreeStaleResolutionStage,
};

fn insert_cleanup_task(store: &mut Store, authority: &CoreWriteAuthority, task_id: &str) {
    store
        .insert_task(
            authority,
            TaskRecord {
                id: task_id.into(),
                project_id: "project-cleanup".into(),
                title: task_id.into(),
                brief: None,
                developer_notes: vec![],
                status: TaskStatus::Open,
                archived_at_epoch_ms: None,
                branch: None,
                worktree: None,
                worktree_generation: 0,
                steward_brief_markdown: String::new(),
                steward_brief_revision: 1,
                rank: 0,
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
}

fn provision_cleanup_task(
    store: &mut Store,
    authority: &CoreWriteAuthority,
    task_id: &str,
    operation_id: &str,
    timestamp: u64,
) -> ManagedWorktreeProof {
    let destination = format!("/worktrees/{task_id}");
    let spec = NormalizedWorktreeSpec {
        version: 1,
        repository_root: "/repo".into(),
        repository_common_dir: "/repo/.git".into(),
        destination_path: destination.clone(),
        branch_name: format!("feature/{task_id}"),
        branch_mode: ProvisioningBranchMode::Create,
        base_ref: Some("refs/heads/main".into()),
        base_oid: Some("a".repeat(40)),
    };
    let operation = WorktreeProvisioningOperation {
        operation_id: operation_id.into(),
        task_id: task_id.into(),
        project_id: "project-cleanup".into(),
        spec: spec.clone(),
        stage: ProvisioningStage::Reserved,
        created_branch_ref: false,
        failure: None,
        started_at_epoch_ms: timestamp,
        updated_at_epoch_ms: timestamp,
    };
    assert!(matches!(
        store
            .begin_task_worktree_provisioning(authority, operation)
            .unwrap(),
        BeginProvisioningOutcome::Started(_)
    ));
    store
        .advance_task_worktree_provisioning(
            authority,
            task_id,
            operation_id,
            ProvisioningStage::WorktreeAdded,
            true,
            timestamp + 1,
        )
        .unwrap();
    store
        .commit_task_worktree_provisioning(
            authority,
            task_id,
            operation_id,
            ProvisioningCommit {
                branch: TaskBranchBinding {
                    repository_root: "/repo".into(),
                    name: format!("feature/{task_id}"),
                },
                worktree: TaskWorktreeBinding {
                    path: destination.clone(),
                },
                proof: ManagedWorktreeProof {
                    task_id: task_id.into(),
                    operation_id: operation_id.into(),
                    worktree_generation: 0,
                    normalized_spec_version: 1,
                    normalized_spec: spec,
                    repository_common_dir: "/repo/.git".into(),
                    registered_worktree_path: destination,
                    branch_ref: format!("refs/heads/feature/{task_id}"),
                },
                updated_at_epoch_ms: timestamp + 2,
            },
        )
        .unwrap();
    store
        .clear_task_worktree_provisioning(authority, task_id, operation_id)
        .unwrap();
    store
        .managed_worktrees()
        .iter()
        .find(|proof| proof.task_id == task_id)
        .unwrap()
        .clone()
}

#[test]
fn same_millisecond_task_mutations_still_advance_updated_at() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-monotonic-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-monotonic");
    // The fixture stamps updated_at 1; a mutation carrying the same wall-clock
    // millisecond must still be observable to timestamp-equality staleness
    // gates such as the archive preview ticket.
    let renamed = store
        .rename_task(&authority, "task-monotonic", "Changed".into(), 1)
        .unwrap();
    assert_eq!(renamed.updated_at_epoch_ms, 2);
    let renamed = store
        .rename_task(&authority, "task-monotonic", "Changed again".into(), 1)
        .unwrap();
    assert_eq!(renamed.updated_at_epoch_ms, 3);
    let _ = std::fs::remove_file(&path);
}

mod agent_plan;
mod archive;
mod branch_binding;
mod cleanup;
mod companion;
mod configuration_version;
mod deleted_session;
mod issue_link;
mod keep_awake;
mod mcp_settings;
mod migration;
mod playbook;
mod project;
mod provisioning;
mod relocation;
mod repair;
mod run_configuration;
mod session;
mod task_branch;
mod task_source;
