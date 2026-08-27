use super::*;

#[test]
fn change_observation_round_trips_opaque_entries_without_persisting_patch_content() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let path = destination.join("both.txt");
    std::fs::write(&path, "PATCH_SECRET_MARKER staged\n").unwrap();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, OsStr::new("both.txt"))
        .unwrap();
    std::fs::write(&path, "PATCH_SECRET_MARKER working\n").unwrap();
    std::fs::write(destination.join("untracked.txt"), "not shown\n").unwrap();

    let observed = fixture
        .runtime
        .plan_task_worktree_change_list(json!({ "taskId": task_id }))
        .unwrap()
        .observe();
    let list = fixture
        .runtime
        .complete_task_worktree_change_list(observed)
        .unwrap();
    assert_eq!(
        list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["display_path"] == "both.txt")
            .count(),
        2
    );
    let staged = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["display_path"] == "both.txt" && entry["side"] == "staged")
        .unwrap();
    let observed_diff = fixture
        .runtime
        .plan_task_worktree_diff(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": staged["entry_id"],
        }))
        .unwrap()
        .observe();
    let diff = fixture
        .runtime
        .complete_task_worktree_diff(observed_diff)
        .unwrap();
    assert_eq!(diff["state"], "patch");
    assert!(
        diff["patch"]
            .as_str()
            .unwrap()
            .contains("PATCH_SECRET_MARKER")
    );
    assert!(
        !std::fs::read_to_string(&fixture.state_path)
            .unwrap()
            .contains("PATCH_SECRET_MARKER")
    );

    termloop_gitio::test_support::reset_hard(&runner, &destination).unwrap();
    termloop_gitio::test_support::clean_untracked(&runner, &destination).unwrap();
    fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    assert!(matches!(
        fixture.runtime.plan_task_worktree_diff(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": staged["entry_id"],
        })),
        Err(CoreError::ManagedWorktreeProofChanged { .. })
    ));
}

#[test]
fn non_utf_change_path_uses_lossy_display_and_opaque_exact_diff_identity() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let non_utf_fs_required = std::env::var("TERMLOOP_NON_UTF_FS").as_deref() == Ok("1");
    let raw_name = match termloop_platform::os_string_from_process_bytes(b"raw-\xff.txt".to_vec()) {
        Ok(raw_name) => raw_name,
        Err(error) if non_utf_fs_required => {
            panic!("TERMLOOP_NON_UTF_FS requires non-UTF path support: {error}")
        }
        Err(_) => {
            eprintln!(
                "SKIP non_utf_change_path_uses_lossy_display_and_opaque_exact_diff_identity: platform cannot represent the fixture path; set TERMLOOP_NON_UTF_FS=1 in Linux CI to require coverage"
            );
            return;
        }
    };
    // Some Unix filesystems (notably the default macOS filesystem) reject this
    // byte sequence before Git can observe it. Exercise the round trip wherever
    // the runtime filesystem can actually create the path.
    if let Err(error) = std::fs::write(destination.join(&raw_name), "exact raw path\n") {
        if non_utf_fs_required {
            panic!("TERMLOOP_NON_UTF_FS requires fixture path creation: {error}");
        }
        eprintln!(
            "SKIP non_utf_change_path_uses_lossy_display_and_opaque_exact_diff_identity: filesystem rejected the fixture path ({error}); set TERMLOOP_NON_UTF_FS=1 in Linux CI to require coverage"
        );
        return;
    }
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, &raw_name).unwrap();
    let observed = fixture
        .runtime
        .plan_task_worktree_change_list(json!({ "taskId": task_id }))
        .unwrap()
        .observe();
    let list = fixture
        .runtime
        .complete_task_worktree_change_list(observed)
        .unwrap();
    let entry = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path_encoding"] == "lossy")
        .expect("raw path must remain addressable through an opaque id");
    let diff = fixture
        .runtime
        .plan_task_worktree_diff(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": entry["entry_id"],
        }))
        .unwrap()
        .observe();
    let result = fixture.runtime.complete_task_worktree_diff(diff).unwrap();
    assert_eq!(result["state"], "patch");
    assert!(result["patch"].as_str().unwrap().contains("exact raw path"));
}

#[test]
fn non_utf_patch_bytes_are_refused_instead_of_lossily_rendered() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    std::fs::write(destination.join("non-utf.txt"), b"invalid: \xff\n").unwrap();
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, OsStr::new("non-utf.txt"))
        .unwrap();
    let observed = fixture
        .runtime
        .plan_task_worktree_change_list(json!({ "taskId": task_id }))
        .unwrap()
        .observe();
    let list = fixture
        .runtime
        .complete_task_worktree_change_list(observed)
        .unwrap();
    let entry = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["display_path"] == "non-utf.txt")
        .unwrap();
    let observed_diff = fixture
        .runtime
        .plan_task_worktree_diff(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": entry["entry_id"],
        }))
        .unwrap()
        .observe();
    let result = fixture
        .runtime
        .complete_task_worktree_diff(observed_diff)
        .unwrap();
    assert_eq!(result["state"], "nonUtf8");
    assert!(result["patch"].is_null());
}

/// Set up one file that differs across HEAD, the index, and the working tree, and
/// return the change list. This is the shape a full-file view must resolve
/// correctly: the staged entry's old side is HEAD, the unstaged entry's is the
/// index, and neither is the working-tree file.
fn three_way_fixture(fixture: &mut Fixture) -> (String, PathBuf, Value) {
    let (task_id, destination, _, _) = provision_cleanup_fixture(fixture);
    let runner = GitRunner::discover().unwrap();
    let path = destination.join("sample.txt");
    std::fs::write(&path, "HEAD_MARKER line\n").unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, OsStr::new("sample.txt"))
        .unwrap();
    termloop_gitio::test_support::commit_all(&runner, &destination, "baseline").unwrap();
    std::fs::write(&path, "INDEX_MARKER line\n").unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, OsStr::new("sample.txt"))
        .unwrap();
    std::fs::write(&path, "WORKING_MARKER line\n").unwrap();

    let observed = fixture
        .runtime
        .plan_task_worktree_change_list(json!({ "taskId": task_id }))
        .unwrap()
        .observe();
    let list = fixture
        .runtime
        .complete_task_worktree_change_list(observed)
        .unwrap();
    (task_id, destination, list)
}

fn read_pre_image(fixture: &mut Fixture, task_id: &str, list: &Value, side: &str) -> Value {
    let entry = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["display_path"] == "sample.txt" && entry["side"] == side)
        .unwrap_or_else(|| panic!("{side} entry"));
    let observed = fixture
        .runtime
        .plan_task_worktree_pre_image(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": entry["entry_id"],
        }))
        .unwrap()
        .observe();
    fixture
        .runtime
        .complete_task_worktree_pre_image(observed)
        .unwrap()
}

#[test]
fn pre_image_returns_head_for_staged_and_index_for_unstaged_never_the_working_tree() {
    let mut fixture = Fixture::new();
    let (task_id, _, list) = three_way_fixture(&mut fixture);

    let staged = read_pre_image(&mut fixture, &task_id, &list, "staged");
    assert_eq!(staged["state"], "content");
    assert_eq!(staged["revision"], "head");
    assert_eq!(staged["content"], "HEAD_MARKER line\n");

    let unstaged = read_pre_image(&mut fixture, &task_id, &list, "unstaged");
    assert_eq!(unstaged["state"], "content");
    assert_eq!(unstaged["revision"], "index");
    assert_eq!(unstaged["content"], "INDEX_MARKER line\n");

    for result in [&staged, &unstaged] {
        assert_ne!(result["content"], "WORKING_MARKER line\n");
        assert_eq!(result["observation_id"], list["observation_id"]);
    }
}

#[test]
fn pre_image_content_never_reaches_durable_state() {
    let mut fixture = Fixture::new();
    let (task_id, _, list) = three_way_fixture(&mut fixture);
    let staged = read_pre_image(&mut fixture, &task_id, &list, "staged");
    assert_eq!(staged["content"], "HEAD_MARKER line\n");
    assert!(
        !std::fs::read_to_string(&fixture.state_path)
            .unwrap()
            .contains("HEAD_MARKER")
    );
}

#[test]
fn pre_image_is_refused_once_the_worktree_proof_changes() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    let path = destination.join("sample.txt");
    std::fs::write(&path, "committed\n").unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, OsStr::new("sample.txt"))
        .unwrap();
    termloop_gitio::test_support::commit_all(&runner, &destination, "baseline").unwrap();
    std::fs::write(&path, "edited\n").unwrap();
    let observed = fixture
        .runtime
        .plan_task_worktree_change_list(json!({ "taskId": task_id }))
        .unwrap()
        .observe();
    let list = fixture
        .runtime
        .complete_task_worktree_change_list(observed)
        .unwrap();
    let entry = list["entries"].as_array().unwrap()[0].clone();

    let proof = fixture.runtime.store.managed_worktrees()[0].clone();
    termloop_gitio::test_support::reset_hard(&runner, &destination).unwrap();
    termloop_gitio::test_support::clean_untracked(&runner, &destination).unwrap();
    fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof.operation_id,
            proof.worktree_generation,
        ))
        .unwrap();

    assert!(matches!(
        fixture.runtime.plan_task_worktree_pre_image(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": entry["entry_id"],
        })),
        Err(CoreError::ManagedWorktreeProofChanged { .. })
    ));
}

#[test]
fn pre_image_rejects_an_unknown_observation_or_entry() {
    let mut fixture = Fixture::new();
    let (task_id, _, list) = three_way_fixture(&mut fixture);
    for params in [
        json!({
            "taskId": task_id,
            "observationId": "changes-does-not-exist",
            "entryId": "entry-0",
        }),
        json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": "entry-99999",
        }),
    ] {
        assert!(matches!(
            fixture.runtime.plan_task_worktree_pre_image(params),
            Err(CoreError::ManagedWorktreeProofChanged { .. })
        ));
    }
}

#[test]
fn untracked_and_added_entries_report_explicit_pre_image_states() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    std::fs::write(destination.join("untracked.txt"), "new local content\n").unwrap();
    std::fs::write(destination.join("added.txt"), "brand new\n").unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, OsStr::new("added.txt"))
        .unwrap();
    let observed = fixture
        .runtime
        .plan_task_worktree_change_list(json!({ "taskId": task_id }))
        .unwrap()
        .observe();
    let list = fixture
        .runtime
        .complete_task_worktree_change_list(observed)
        .unwrap();

    let untracked = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["display_path"] == "untracked.txt")
        .unwrap();
    assert_eq!(untracked["render_state"], "available");
    let observed = fixture
        .runtime
        .plan_task_worktree_diff(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": untracked["entry_id"],
        }))
        .unwrap()
        .observe();
    let diff = fixture
        .runtime
        .complete_task_worktree_diff(observed)
        .unwrap();
    assert_eq!(diff["state"], "patch");
    assert!(
        diff["patch"]
            .as_str()
            .unwrap()
            .contains("+new local content")
    );

    for display_path in ["untracked.txt", "added.txt"] {
        let entry = list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["display_path"] == display_path)
            .unwrap_or_else(|| panic!("entry for {display_path}"));
        let observed = fixture
            .runtime
            .plan_task_worktree_pre_image(json!({
                "taskId": task_id,
                "observationId": list["observation_id"],
                "entryId": entry["entry_id"],
            }))
            .unwrap()
            .observe();
        let result = fixture
            .runtime
            .complete_task_worktree_pre_image(observed)
            .unwrap();
        assert_eq!(result["state"], "absent", "state for {display_path}");
        assert!(result["content"].is_null());
    }
}

#[test]
fn non_utf_pre_image_bytes_are_refused_instead_of_lossily_rendered() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    let path = destination.join("non-utf.txt");
    std::fs::write(&path, b"invalid: \xff\n").unwrap();
    termloop_gitio::test_support::stage_path(&runner, &destination, OsStr::new("non-utf.txt"))
        .unwrap();
    termloop_gitio::test_support::commit_all(&runner, &destination, "baseline").unwrap();
    std::fs::write(&path, "now valid\n").unwrap();
    let observed = fixture
        .runtime
        .plan_task_worktree_change_list(json!({ "taskId": task_id }))
        .unwrap()
        .observe();
    let list = fixture
        .runtime
        .complete_task_worktree_change_list(observed)
        .unwrap();
    let entry = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["display_path"] == "non-utf.txt")
        .unwrap();
    let observed = fixture
        .runtime
        .plan_task_worktree_pre_image(json!({
            "taskId": task_id,
            "observationId": list["observation_id"],
            "entryId": entry["entry_id"],
        }))
        .unwrap()
        .observe();
    let result = fixture
        .runtime
        .complete_task_worktree_pre_image(observed)
        .unwrap();
    assert_eq!(result["state"], "nonUtf8");
    assert!(result["content"].is_null());
}
