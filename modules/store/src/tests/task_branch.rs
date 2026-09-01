use super::*;
use termloop_domain::{TaskBranchMembership, TaskBranchMembershipEvidence};

fn membership(id: &str, reference: &str) -> TaskBranchMembership {
    TaskBranchMembership {
        id: id.into(),
        repository_root: "/repo".into(),
        repository_common_dir: "/repo/.git".into(),
        ref_name: reference.into(),
        first_observed_worktree_generation: 1,
        first_observed_oid: "b".repeat(40),
        parent_ref_name: Some("refs/heads/main".into()),
        evidence: TaskBranchMembershipEvidence::BranchCreationReflog,
    }
}

#[test]
fn branch_membership_is_durable_monotonic_bounded_and_deleted_with_task() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-branches-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-branches");
    provision_cleanup_task(
        &mut store,
        &authority,
        "task-branches",
        "operation-branches",
        10,
    );

    let set = store
        .reconcile_task_branch_set(
            &authority,
            "task-branches",
            1,
            "/repo/.git",
            vec![membership("branch-1", "refs/heads/feature/secondary")],
            false,
        )
        .unwrap();
    assert_eq!(set.memberships.len(), 1);
    let revision = store.revision();
    let retried = store
        .reconcile_task_branch_set(
            &authority,
            "task-branches",
            1,
            "/repo/.git",
            vec![membership("retry-id", "refs/heads/feature/secondary")],
            false,
        )
        .unwrap();
    assert_eq!(retried.memberships[0].id, "branch-1");
    assert_eq!(store.revision(), revision);

    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.task_branch_sets()[0].memberships.len(), 1);
    reopened.delete_task(&authority, "task-branches").unwrap();
    assert!(reopened.task_branch_sets().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn primary_branch_cannot_be_duplicated_as_associated_membership() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-primary-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    insert_cleanup_task(&mut store, &authority, "task-primary");
    provision_cleanup_task(
        &mut store,
        &authority,
        "task-primary",
        "operation-primary",
        10,
    );
    assert!(matches!(
        store.reconcile_task_branch_set(
            &authority,
            "task-primary",
            1,
            "/repo/.git",
            vec![membership(
                "branch-primary",
                "refs/heads/feature/task-primary"
            )],
            false,
        ),
        Err(StoreError::ConstraintViolation)
    ));
    let _ = std::fs::remove_file(path);
}
