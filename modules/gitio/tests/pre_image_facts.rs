mod support;

use std::fs;

use termloop_gitio::{
    CHANGE_DIFF_MAX_BYTES, GitRunner, PreImageContent, PreImageRevision, WorktreeChangeKind,
    WorktreeChangeSide,
};

use support::TestRepository;

fn content(observed: &PreImageContent) -> &[u8] {
    match observed {
        PreImageContent::Content(bytes) => bytes,
        other => panic!("expected content, got {other:?}"),
    }
}

/// The decisive test for this primitive: HEAD, index, and working tree hold three
/// different versions of one file at the same time, and each change side must
/// resolve to the correct one. Reading the working tree would be the new side.
#[test]
fn staged_reads_head_and_unstaged_reads_the_index_not_the_working_tree() {
    let repository = TestRepository::init("pre-image-sides");
    repository.create_commit_at("sample.txt", "head version\n");
    fs::write(repository.root().join("sample.txt"), "index version\n").unwrap();
    repository.git(["add", "--", "sample.txt"]);
    fs::write(repository.root().join("sample.txt"), "working version\n").unwrap();

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let staged = observation
        .entries
        .iter()
        .find(|entry| {
            entry.path().to_str() == Some("sample.txt")
                && entry.side() == WorktreeChangeSide::Staged
        })
        .unwrap();
    let unstaged = observation
        .entries
        .iter()
        .find(|entry| {
            entry.path().to_str() == Some("sample.txt")
                && entry.side() == WorktreeChangeSide::Unstaged
        })
        .unwrap();

    let staged_pre_image = runner
        .read_worktree_change_pre_image(repository.root(), staged)
        .unwrap();
    assert_eq!(staged_pre_image.revision, PreImageRevision::Head);
    assert_eq!(content(&staged_pre_image.content), b"head version\n");

    let unstaged_pre_image = runner
        .read_worktree_change_pre_image(repository.root(), unstaged)
        .unwrap();
    assert_eq!(unstaged_pre_image.revision, PreImageRevision::Index);
    assert_eq!(content(&unstaged_pre_image.content), b"index version\n");

    // Neither read may be the working-tree file, and neither may touch the index.
    assert_ne!(content(&staged_pre_image.content), b"working version\n");
    assert_ne!(content(&unstaged_pre_image.content), b"working version\n");
    assert_eq!(before, repository.index_snapshot(repository.root()));
    assert!(!repository.root().join(".git/index.lock").exists());
}

#[test]
fn a_deleted_file_still_has_its_pre_image() {
    let repository = TestRepository::init("pre-image-deleted");
    repository.create_commit_at("sample.txt", "still readable\n");
    fs::remove_file(repository.root().join("sample.txt")).unwrap();

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let deleted = observation
        .entries
        .iter()
        .find(|entry| entry.kind() == WorktreeChangeKind::Deleted)
        .unwrap();
    let observed = runner
        .read_worktree_change_pre_image(repository.root(), deleted)
        .unwrap();
    assert_eq!(content(&observed.content), b"still readable\n");
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn a_rename_reads_the_original_path_content() {
    let repository = TestRepository::init("pre-image-rename");
    repository.create_commit_at("old.txt", "original content\n");
    fs::rename(
        repository.root().join("old.txt"),
        repository.root().join("new.txt"),
    )
    .unwrap();
    repository.git(["add", "--all", "--", "."]);

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let renamed = observation
        .entries
        .iter()
        .find(|entry| entry.kind() == WorktreeChangeKind::Renamed)
        .expect("rename detected");
    let observed = runner
        .read_worktree_change_pre_image(repository.root(), renamed)
        .unwrap();
    assert_eq!(content(&observed.content), b"original content\n");
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn an_added_file_has_no_pre_image_and_runs_no_git() {
    let repository = TestRepository::init("pre-image-added");
    repository.create_commit("base");
    fs::write(repository.root().join("fresh.txt"), "brand new\n").unwrap();
    repository.git(["add", "--", "fresh.txt"]);

    let runner = GitRunner::discover().unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let added = observation
        .entries
        .iter()
        .find(|entry| entry.kind() == WorktreeChangeKind::Added)
        .unwrap();
    let observed = runner
        .read_worktree_change_pre_image(repository.root(), added)
        .unwrap();
    assert_eq!(observed.content, PreImageContent::Absent);
    assert_eq!(observed.git_process_count, 0);
}

#[test]
fn an_untracked_file_has_no_pre_image_and_runs_no_git() {
    let repository = TestRepository::init("pre-image-untracked");
    repository.create_commit("base");
    fs::write(repository.root().join("untracked.txt"), "not shown\n").unwrap();

    let runner = GitRunner::discover().unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let untracked = observation
        .entries
        .iter()
        .find(|entry| entry.side() == WorktreeChangeSide::Untracked)
        .unwrap();
    let observed = runner
        .read_worktree_change_pre_image(repository.root(), untracked)
        .unwrap();
    assert_eq!(observed.content, PreImageContent::Absent);
    assert_eq!(observed.git_process_count, 0);
}

#[test]
fn a_binary_pre_image_is_refused_as_binary() {
    let repository = TestRepository::init("pre-image-binary");
    fs::write(repository.root().join("blob.bin"), [0u8, 1, 2, 0, 4]).unwrap();
    repository.git(["add", "--", "blob.bin"]);
    repository.git(["commit", "-m", "fixture"]);
    fs::write(repository.root().join("blob.bin"), [9u8, 8, 0, 7]).unwrap();

    let runner = GitRunner::discover().unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let entry = observation
        .entries
        .iter()
        .find(|entry| entry.path().to_str() == Some("blob.bin"))
        .unwrap();
    let observed = runner
        .read_worktree_change_pre_image(repository.root(), entry)
        .unwrap();
    assert_eq!(observed.content, PreImageContent::Binary);
}

#[test]
fn an_oversized_pre_image_is_truncated_rather_than_returned() {
    let repository = TestRepository::init("pre-image-oversized");
    let oversized = "x".repeat(CHANGE_DIFF_MAX_BYTES + 1_024);
    fs::write(repository.root().join("large.txt"), &oversized).unwrap();
    repository.git(["add", "--", "large.txt"]);
    repository.git(["commit", "-m", "fixture"]);
    fs::write(repository.root().join("large.txt"), "small now\n").unwrap();

    let runner = GitRunner::discover().unwrap();
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    let entry = observation
        .entries
        .iter()
        .find(|entry| entry.path().to_str() == Some("large.txt"))
        .unwrap();
    let observed = runner
        .read_worktree_change_pre_image(repository.root(), entry)
        .unwrap();
    assert_eq!(observed.content, PreImageContent::Truncated);
}

/// A path that looks like pathspec magic or revision syntax must still select
/// exactly that file. Resolution goes through `:(literal)` and then an exact
/// OID, so no part of the path is ever parsed as a revision.
#[test]
fn paths_that_look_like_revision_or_pathspec_syntax_resolve_exactly() {
    let repository = TestRepository::init("pre-image-odd-paths");
    let colon_name =
        termloop_platform::test_support::host_path_component("colon-name.txt", "colon:name.txt");
    for (name, body) in [
        (colon_name, "colon body\n"),
        ("bracket[1].txt", "bracket body\n"),
        ("caret^name.txt", "caret body\n"),
    ] {
        fs::write(repository.root().join(name), body).unwrap();
        repository.git(["add", "--", name]);
    }
    repository.git(["commit", "-m", "fixture"]);
    for name in [colon_name, "bracket[1].txt", "caret^name.txt"] {
        fs::write(repository.root().join(name), "edited\n").unwrap();
    }

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let observation = runner.list_worktree_changes(repository.root()).unwrap();
    for (name, expected) in [
        (colon_name, b"colon body\n".as_slice()),
        ("bracket[1].txt", b"bracket body\n".as_slice()),
        ("caret^name.txt", b"caret body\n".as_slice()),
    ] {
        let entry = observation
            .entries
            .iter()
            .find(|entry| entry.path().to_str() == Some(name))
            .unwrap_or_else(|| panic!("entry for {name}"));
        let observed = runner
            .read_worktree_change_pre_image(repository.root(), entry)
            .unwrap();
        assert_eq!(content(&observed.content), expected, "content for {name}");
    }
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

// Symlink and gitlink modes are refused by `is_regular_blob_mode`, covered by the
// unit tests in `src/pre_image.rs`. There is no integration test here because
// creating a file symlink needs an OS conditional, and those belong to `platform`.
