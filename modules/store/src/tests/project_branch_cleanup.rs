use super::*;
use termloop_domain::{TaskBranchMembership, TaskBranchMembershipEvidence, TaskBranchSet};

fn fixture() -> (Store, CoreWriteAuthority) {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-project-branches-{}.json",
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut state = CurrentState {
        revision: 7,
        ..CurrentState::default()
    };
    // Branch evidence remains valid after a managed worktree is cleaned up.
    for id in ["deleted", "survivor"] {
        state.projects.push(ProjectRecord {
            id: id.into(),
            name: id.into(),
            folder_path: format!("/repo/{id}"),
        });
        state.tasks.push(TaskRecord {
            id: id.into(),
            project_id: id.into(),
            title: id.into(),
            brief: None,
            developer_notes: vec![],
            status: TaskStatus::Open,
            archived_at_epoch_ms: None,
            branch: Some(TaskBranchBinding {
                repository_root: format!("/repo/{id}"),
                name: "primary".into(),
            }),
            worktree: None,
            worktree_generation: 1,
            steward_brief_markdown: String::new(),
            steward_brief_revision: 1,
            rank: 0,
            created_at_epoch_ms: 1,
            updated_at_epoch_ms: 1,
        });
        state.task_branch_sets.push(TaskBranchSet {
            task_id: id.into(),
            evidence_truncated: true,
            memberships: vec![TaskBranchMembership {
                id: id.into(),
                repository_root: format!("/repo/{id}"),
                repository_common_dir: format!("/repo/{id}/.git"),
                ref_name: "refs/heads/secondary".into(),
                first_observed_worktree_generation: 1,
                first_observed_oid: "a".repeat(40),
                parent_ref_name: Some("refs/heads/primary".into()),
                evidence: TaskBranchMembershipEvidence::BranchCreationReflog,
            }],
        });
    }
    std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    (Store::open(path).unwrap(), authority)
}

#[test]
fn project_deletion_removes_only_its_branch_sets_and_reopens() {
    let (mut store, authority) = fixture();
    let survivor = store.task_branch_sets()[1].clone();
    store
        .delete_project_and_related_records(&authority, "deleted")
        .unwrap();
    assert_eq!(store.task_branch_sets(), &[survivor]);
    let reopened = Store::open(&store.path).unwrap();
    assert_eq!(reopened.task_branch_sets(), store.task_branch_sets());
    assert_eq!(reopened.projects().len(), 1);
    assert_eq!(reopened.tasks().len(), 1);
    assert_eq!(reopened.revision(), 8);
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn project_deletion_restores_branch_sets_on_failed_commit() {
    let (mut store, authority) = fixture();
    let path = store.path.clone();
    let before = serde_json::to_value(&store.state).unwrap();
    store.path = path.join("cannot-write.json");
    assert!(matches!(
        store.delete_project_and_related_records(&authority, "deleted"),
        Err(StoreError::Io(_))
    ));
    assert_eq!(serde_json::to_value(&store.state).unwrap(), before);
    assert_eq!(
        serde_json::to_value(Store::open(&path).unwrap().state).unwrap(),
        before
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn schema_62_repairs_only_branch_sets_for_deleted_tasks() {
    let (store, _) = fixture();
    let mut legacy = serde_json::to_value(&store.state).unwrap();
    legacy["schema_version"] = json!(62);
    legacy["projects"].as_array_mut().unwrap().remove(0);
    legacy["tasks"].as_array_mut().unwrap().remove(0);
    std::fs::write(&store.path, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let mut expected = legacy;
    expected["schema_version"] = json!(CURRENT_SCHEMA_VERSION);
    expected["task_branch_sets"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    let reopened = Store::open(&store.path).unwrap();
    assert_eq!(serde_json::to_value(&reopened.state).unwrap(), expected);
    let bytes = std::fs::read(&store.path).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        expected
    );
    assert!(Store::open(&store.path).is_ok());
    assert_eq!(std::fs::read(&store.path).unwrap(), bytes);
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn branch_set_migration_rejects_invalid_surviving_records_without_writing() {
    let (store, _) = fixture();
    for invalid in [
        "duplicate",
        "missing-binding",
        "malformed",
        "missing-task-id",
    ] {
        let mut legacy = serde_json::to_value(&store.state).unwrap();
        legacy["schema_version"] = json!(62);
        legacy["projects"].as_array_mut().unwrap().remove(0);
        legacy["tasks"].as_array_mut().unwrap().remove(0);
        match invalid {
            "duplicate" => {
                let duplicate = legacy["task_branch_sets"][1].clone();
                legacy["task_branch_sets"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "missing-binding" => legacy["tasks"][0]["branch"] = serde_json::Value::Null,
            "malformed" => {
                legacy["task_branch_sets"][1]["memberships"][0]["first_observed_oid"] =
                    json!("bad");
            }
            "missing-task-id" => {
                legacy["task_branch_sets"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("task_id");
            }
            _ => unreachable!(),
        }
        let bytes = serde_json::to_vec(&legacy).unwrap();
        std::fs::write(&store.path, &bytes).unwrap();
        assert!(Store::open(&store.path).is_err(), "{invalid}");
        assert_eq!(std::fs::read(&store.path).unwrap(), bytes);
    }
    std::fs::remove_file(&store.path).unwrap();
}

#[test]
fn current_schema_still_rejects_orphan_branch_sets() {
    let (store, _) = fixture();
    let mut state = serde_json::to_value(&store.state).unwrap();
    state["tasks"].as_array_mut().unwrap().remove(0);
    let bytes = serde_json::to_vec(&state).unwrap();
    std::fs::write(&store.path, &bytes).unwrap();
    assert!(matches!(
        Store::open(&store.path),
        Err(StoreError::CorruptRecord)
    ));
    assert_eq!(std::fs::read(&store.path).unwrap(), bytes);
    std::fs::remove_file(&store.path).unwrap();
}
