mod support;

use std::fs;

use termloop_gitio::{
    CHANGE_DIFF_MAX_BYTES, GitRunner, WorktreeChangeKind, WorktreeChangeSide, WorktreeDiffContent,
};

use support::TestRepository;

#[test]
fn list_and_diff_keep_staged_unstaged_untracked_and_binary_independent() {
    let repository = TestRepository::init("changes");
    repository.create_commit("base");
    fs::write(repository.root().join("tracked.txt"), "staged version\n").unwrap();
    repository.git(["add", "--", "tracked.txt"]);
    fs::write(repository.root().join("tracked.txt"), "working version\n").unwrap();
    fs::write(
        repository.root().join("untracked.txt"),
        "new local content\n",
    )
    .unwrap();
    fs::write(repository.root().join("binary.bin"), [0, 1, 2, 0, 4]).unwrap();
    repository.git(["add", "--", "binary.bin"]);

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    assert_eq!(before, repository.index_snapshot(repository.root()));
    assert!(!observation.truncated);
    assert_eq!(observation.git_process_count, 1);

    let staged = observation
        .entries
        .iter()
        .find(|entry| {
            entry.path().to_str() == Some("tracked.txt")
                && entry.side() == WorktreeChangeSide::Staged
        })
        .unwrap();
    let unstaged = observation
        .entries
        .iter()
        .find(|entry| {
            entry.path().to_str() == Some("tracked.txt")
                && entry.side() == WorktreeChangeSide::Unstaged
        })
        .unwrap();
    let untracked = observation
        .entries
        .iter()
        .find(|entry| entry.side() == WorktreeChangeSide::Untracked)
        .unwrap();
    let binary = observation
        .entries
        .iter()
        .find(|entry| entry.path().to_str() == Some("binary.bin"))
        .unwrap();

    for entry in [staged, unstaged] {
        let diff = runner
            .diff_worktree_change(repository.root(), entry)
            .unwrap();
        assert!(matches!(diff.content, WorktreeDiffContent::Patch(_)));
        assert_eq!(diff.git_process_count, 2);
    }
    let untracked_diff = runner
        .diff_worktree_change(repository.root(), untracked)
        .unwrap();
    let WorktreeDiffContent::Patch(untracked_patch) = untracked_diff.content else {
        panic!("untracked text must render as a bounded new-file patch");
    };
    let untracked_patch = String::from_utf8(untracked_patch).unwrap();
    assert!(untracked_patch.contains("new file mode"));
    assert!(untracked_patch.contains("+++ b/untracked.txt"));
    assert!(untracked_patch.contains("+new local content"));
    assert_eq!(untracked_diff.git_process_count, 2);
    assert!(matches!(
        runner
            .diff_worktree_change(repository.root(), binary)
            .unwrap()
            .content,
        WorktreeDiffContent::Binary
    ));
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn untracked_diff_treats_special_paths_as_exact_files() {
    let repository = TestRepository::init("changes-untracked-literal-path");
    repository.create_commit("base");
    for (path, marker) in [
        ("plain.txt", "PLAIN_ONLY"),
        ("a[1].txt", "BRACKET_ONLY"),
        (" space name.txt", "SPACE_ONLY"),
    ] {
        fs::write(repository.root().join(path), format!("{marker}\n")).unwrap();
    }

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    for (path, expected_marker) in [
        ("plain.txt", "PLAIN_ONLY"),
        ("a[1].txt", "BRACKET_ONLY"),
        (" space name.txt", "SPACE_ONLY"),
    ] {
        let entry = observation
            .entries
            .iter()
            .find(|entry| entry.path().to_str() == Some(path))
            .unwrap_or_else(|| panic!("missing untracked entry for {path:?}"));
        let diff = runner
            .diff_worktree_change(repository.root(), entry)
            .unwrap();
        let WorktreeDiffContent::Patch(patch) = diff.content else {
            panic!("expected an untracked patch for {path:?}");
        };
        let patch = String::from_utf8(patch).unwrap();
        assert!(patch.contains(expected_marker), "wrong patch for {path:?}");
        for unrelated_marker in ["PLAIN_ONLY", "BRACKET_ONLY", "SPACE_ONLY"] {
            if unrelated_marker != expected_marker {
                assert!(
                    !patch.contains(unrelated_marker),
                    "patch for {path:?} included an unrelated file"
                );
            }
        }
    }
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn untracked_binary_is_classified_without_patch_bytes() {
    let repository = TestRepository::init("changes-untracked-binary");
    repository.create_commit("base");
    fs::write(repository.root().join("new.bin"), [0, 1, 2, 0, 4]).unwrap();

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let entry = observation.entries.first().unwrap();
    let diff = runner
        .diff_worktree_change(repository.root(), entry)
        .unwrap();
    assert_eq!(diff.content, WorktreeDiffContent::Binary);
    assert_eq!(diff.git_process_count, 1);
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn staged_rename_keeps_both_nul_delimited_paths_and_renders() {
    let repository = TestRepository::init("changes-rename");
    repository.create_commit("base");
    repository.git(["mv", "tracked.txt", "renamed.txt"]);
    let runner = GitRunner::discover().unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let renamed = observation
        .entries
        .iter()
        .find(|entry| entry.kind() == WorktreeChangeKind::Renamed)
        .unwrap();
    assert_eq!(renamed.path().to_str(), Some("renamed.txt"));
    assert_eq!(
        renamed.original_path().unwrap().to_str(),
        Some("tracked.txt")
    );
    let diff = runner
        .diff_worktree_change(repository.root(), renamed)
        .unwrap();
    let WorktreeDiffContent::Patch(patch) = diff.content else {
        panic!("staged rename must render as a bounded patch");
    };
    let patch = String::from_utf8(patch).unwrap();
    assert!(patch.contains("rename from tracked.txt"));
    assert!(patch.contains("rename to renamed.txt"));
    assert!(!patch.contains("new file mode"));
}

#[test]
fn diff_treats_glob_magic_colon_and_space_paths_as_exact_literals() {
    let repository = TestRepository::init("changes-literal-pathspec");
    let colon_path =
        termloop_platform::test_support::host_path_component("colon.txt", ":colon.txt");
    repository.create_commit("base");
    for path in ["a1.txt", "a[1].txt", colon_path, " space name.txt"] {
        fs::write(repository.root().join(path), "initial\n").unwrap();
    }
    repository.git(["add", "-A"]);
    repository.git(["commit", "-m", "literal path fixtures"]);

    let cases = [
        ("a1.txt", "A1_ONLY"),
        ("a[1].txt", "BRACKET_ONLY"),
        (colon_path, "COLON_ONLY"),
        (" space name.txt", "SPACE_ONLY"),
    ];
    for (path, marker) in cases {
        fs::write(repository.root().join(path), format!("{marker}\n")).unwrap();
    }

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    for (path, expected_marker) in cases {
        let entry = observation
            .entries
            .iter()
            .find(|entry| entry.path().to_str() == Some(path))
            .unwrap_or_else(|| panic!("missing change entry for {path:?}"));
        let diff = runner
            .diff_worktree_change(repository.root(), entry)
            .unwrap();
        let WorktreeDiffContent::Patch(patch) = diff.content else {
            panic!("expected a patch for {path:?}");
        };
        let patch = String::from_utf8(patch).unwrap();
        assert!(patch.contains(expected_marker), "wrong patch for {path:?}");
        for (_, unrelated_marker) in cases {
            if unrelated_marker != expected_marker {
                assert!(
                    !patch.contains(unrelated_marker),
                    "patch for {path:?} included an unrelated file"
                );
            }
        }
    }
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn oversized_patch_returns_no_patch_bytes() {
    let repository = TestRepository::init("changes-limit");
    repository.create_commit("base");
    fs::write(
        repository.root().join("tracked.txt"),
        "changed line with enough payload to exceed the bound\n".repeat(CHANGE_DIFF_MAX_BYTES / 20),
    )
    .unwrap();
    let runner = GitRunner::discover().unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let entry = observation.entries.first().unwrap();
    assert!(matches!(
        runner
            .diff_worktree_change(repository.root(), entry)
            .unwrap()
            .content,
        WorktreeDiffContent::Truncated
    ));
}

#[test]
fn oversized_untracked_file_returns_no_patch_bytes() {
    let repository = TestRepository::init("changes-untracked-limit");
    repository.create_commit("base");
    fs::write(
        repository.root().join("large-new.txt"),
        "new line with enough payload to exceed the bound\n".repeat(CHANGE_DIFF_MAX_BYTES / 20),
    )
    .unwrap();
    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let entry = observation.entries.first().unwrap();
    assert!(matches!(
        runner
            .diff_worktree_change(repository.root(), entry)
            .unwrap()
            .content,
        WorktreeDiffContent::Truncated
    ));
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn overlong_patch_returns_no_patch_bytes_below_the_byte_limit() {
    let repository = TestRepository::init("changes-line-limit");
    repository.create_commit("base");
    fs::write(
        repository.root().join("tracked.txt"),
        "\n".repeat(termloop_gitio::CHANGE_DIFF_MAX_LINES + 1),
    )
    .unwrap();
    let runner = GitRunner::discover().unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let entry = observation.entries.first().unwrap();
    assert!(matches!(
        runner
            .diff_worktree_change(repository.root(), entry)
            .unwrap()
            .content,
        WorktreeDiffContent::Truncated
    ));
}

#[test]
fn clean_and_deleted_worktrees_are_reported_without_index_mutation() {
    let repository = TestRepository::init("changes-clean-delete");
    repository.create_commit("base");
    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    assert!(
        runner
            .list_worktree_changes(repository.root())
            .unwrap()
            .entries
            .is_empty()
    );
    fs::remove_file(repository.root().join("tracked.txt")).unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    assert!(observation.entries.iter().any(|entry| {
        entry.kind() == WorktreeChangeKind::Deleted && entry.side() == WorktreeChangeSide::Unstaged
    }));
    assert_eq!(before, repository.index_snapshot(repository.root()));
}
