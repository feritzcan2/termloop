mod support;

use std::fs;
use std::path::Path;

use termloop_gitio::{
    GitError, GitRunner, HeadState, SourceControlRejection, WorktreeChangeKind, WorktreeChangeSide,
};

use support::TestRepository;

/// The runner under test reads ambient configuration, so each fixture pins
/// identity, signing, and hooks in repository-local config, which wins.
fn hermetic_local_config(repository: &TestRepository, root: &Path) {
    let hooks = repository.fixture_root().join("empty-hooks");
    for (key, value) in [
        ("user.name", "TermLoop Fixture".to_owned()),
        ("user.email", "fixture@termloop.invalid".to_owned()),
        ("commit.gpgsign", "false".to_owned()),
        ("core.hooksPath", hooks.display().to_string()),
        ("push.default", "simple".to_owned()),
        // Windows runners default to autocrlf; fixtures compare exact bytes.
        ("core.autocrlf", "false".to_owned()),
    ] {
        repository.git(["-C", root.to_str().unwrap(), "config", key, value.as_str()]);
    }
}

fn sides(runner: &GitRunner, root: &Path) -> Vec<(String, WorktreeChangeSide)> {
    let mut entries = runner
        .observe_source_control_status(root)
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| (entry.path().to_str().unwrap().to_owned(), entry.side()))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

/// A glob that matches `new file.txt`. Windows rejects `*` and `?` in file
/// names, so a bracket class keeps the fixture portable.
const GLOB_PATH: &str = "[n]ew file.txt";

#[test]
fn stage_unstage_and_discard_touch_exactly_the_requested_literal_paths() {
    let repository = TestRepository::init("source-control-index");
    hermetic_local_config(&repository, repository.root());
    repository.create_commit_at("tracked.txt", "base\n");
    repository.create_commit_at(GLOB_PATH, "glob base\n");
    let root = repository.root();
    fs::write(root.join("tracked.txt"), "edited\n").unwrap();
    fs::write(root.join(GLOB_PATH), "glob edited\n").unwrap();
    fs::write(root.join("new file.txt"), "new\n").unwrap();
    fs::create_dir_all(root.join("dir")).unwrap();
    fs::write(root.join("dir/keep.txt"), "keep\n").unwrap();
    fs::write(root.join("dir/remove.txt"), "remove\n").unwrap();
    let runner = GitRunner::discover().unwrap();

    // A file whose name is a glob must not also select the change it matches.
    runner.stage_paths(root, &[Path::new(GLOB_PATH)]).unwrap();
    assert_eq!(
        sides(&runner, root),
        vec![
            (GLOB_PATH.to_owned(), WorktreeChangeSide::Staged),
            ("dir/keep.txt".to_owned(), WorktreeChangeSide::Untracked),
            ("dir/remove.txt".to_owned(), WorktreeChangeSide::Untracked),
            ("new file.txt".to_owned(), WorktreeChangeSide::Untracked),
            ("tracked.txt".to_owned(), WorktreeChangeSide::Unstaged),
        ]
    );
    runner
        .stage_paths(root, &[Path::new("new file.txt"), Path::new("tracked.txt")])
        .unwrap();
    runner.unstage_paths(root, &[Path::new(GLOB_PATH)]).unwrap();
    assert_eq!(
        sides(&runner, root),
        vec![
            (GLOB_PATH.to_owned(), WorktreeChangeSide::Unstaged),
            ("dir/keep.txt".to_owned(), WorktreeChangeSide::Untracked),
            ("dir/remove.txt".to_owned(), WorktreeChangeSide::Untracked),
            ("new file.txt".to_owned(), WorktreeChangeSide::Staged),
            ("tracked.txt".to_owned(), WorktreeChangeSide::Staged),
        ]
    );

    runner
        .restore_worktree_paths(root, &[Path::new(GLOB_PATH)])
        .unwrap();
    assert_eq!(
        fs::read_to_string(root.join(GLOB_PATH)).unwrap(),
        "glob base\n"
    );
    runner
        .remove_untracked_files(root, &[Path::new("dir/remove.txt")])
        .unwrap();
    assert!(!root.join("dir/remove.txt").exists());
    assert!(root.join("dir/keep.txt").exists());
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt")).unwrap(),
        "edited\n"
    );
}

#[test]
fn unstaging_on_an_unborn_branch_keeps_the_file() {
    let repository = TestRepository::init("source-control-unborn");
    hermetic_local_config(&repository, repository.root());
    let root = repository.root();
    fs::write(root.join("first.txt"), "first\n").unwrap();
    let runner = GitRunner::discover().unwrap();
    runner.stage_paths(root, &[Path::new("first.txt")]).unwrap();
    let status = runner.observe_source_control_status(root).unwrap();
    assert!(matches!(status.head, HeadState::Unborn { .. }));
    assert_eq!(status.entries[0].kind(), WorktreeChangeKind::Added);
    runner
        .unstage_paths(root, &[Path::new("first.txt")])
        .unwrap();
    assert_eq!(
        sides(&runner, root),
        vec![("first.txt".to_owned(), WorktreeChangeSide::Untracked)]
    );
}

#[test]
fn commit_uses_the_exact_message_and_types_an_empty_index() {
    let repository = TestRepository::init("source-control-commit");
    hermetic_local_config(&repository, repository.root());
    repository.create_commit("base");
    let root = repository.root();
    let runner = GitRunner::discover().unwrap();
    assert!(matches!(
        runner.commit_index(root, b"nothing staged"),
        Err(GitError::SourceControlRejected(
            SourceControlRejection::NothingToCommit
        ))
    ));
    fs::write(root.join("tracked.txt"), "changed\n").unwrap();
    runner
        .stage_paths(root, &[Path::new("tracked.txt")])
        .unwrap();
    assert!(matches!(
        runner.commit_index(root, b"  \n# only a comment\n"),
        Err(GitError::SourceControlRejected(
            SourceControlRejection::EmptyMessage
        ))
    ));
    let oid = runner
        .commit_index(root, b"Subject with $(touch pwned) `quotes`\n\nBody line")
        .unwrap();
    let log = repository.git(["log", "-1", "--format=%H%n%B"]);
    let log = String::from_utf8(log.stdout).unwrap();
    assert!(log.starts_with(std::str::from_utf8(oid.as_bytes()).unwrap()));
    assert!(log.contains("Subject with $(touch pwned) `quotes`\n\nBody line"));
    assert!(!root.join("pwned").exists());
    assert!(
        runner
            .observe_source_control_status(root)
            .unwrap()
            .entries
            .is_empty()
    );
}

#[test]
fn publish_push_fetch_and_fast_forward_pull_track_the_upstream() {
    let remote = TestRepository::init_bare("source-control-remote");
    let repository = TestRepository::init("source-control-local");
    let root = repository.root();
    hermetic_local_config(&repository, root);
    repository.create_commit("base");
    repository.git(["remote", "add", "origin", remote.root().to_str().unwrap()]);
    let runner = GitRunner::discover().unwrap();

    let unpublished = runner.observe_source_control_status(root).unwrap();
    assert!(unpublished.upstream.is_none());
    assert!(matches!(
        runner.push_current_branch(root),
        Err(GitError::SourceControlRejected(
            SourceControlRejection::NoUpstream
        ))
    ));
    runner.publish_current_branch(root, b"origin").unwrap();
    let published = runner.observe_source_control_status(root).unwrap();
    let upstream = published.upstream.unwrap();
    assert_eq!(upstream.name, b"origin/main");
    assert_eq!(upstream.ahead_behind, Some((0, 0)));

    repository.create_commit_at("next.txt", "next\n");
    assert_eq!(
        runner
            .observe_source_control_status(root)
            .unwrap()
            .upstream
            .unwrap()
            .ahead_behind,
        Some((1, 0))
    );
    runner.push_current_branch(root).unwrap();

    // A second clone advances the remote; this checkout fetches, then
    // fast-forwards.
    let other = repository.fixture_root().join("other");
    repository.git([
        "clone",
        "--quiet",
        remote.root().to_str().unwrap(),
        other.to_str().unwrap(),
    ]);
    hermetic_local_config(&repository, &other);
    fs::write(other.join("remote.txt"), "remote\n").unwrap();
    let other_path = other.to_str().unwrap();
    repository.git(["-C", other_path, "add", "--", "remote.txt"]);
    repository.git(["-C", other_path, "commit", "-m", "remote"]);
    repository.git(["-C", other_path, "push", "--quiet"]);

    runner.fetch_and_prune(root).unwrap();
    assert_eq!(
        runner
            .observe_source_control_status(root)
            .unwrap()
            .upstream
            .unwrap()
            .ahead_behind,
        Some((0, 1))
    );
    repository.create_commit_at("local.txt", "local\n");
    assert!(matches!(
        runner.push_current_branch(root),
        Err(GitError::SourceControlRejected(
            SourceControlRejection::PushRejected
        ))
    ));
    assert!(matches!(
        runner.pull_fast_forward(root),
        Err(GitError::SourceControlRejected(
            SourceControlRejection::PullNotFastForward
        ))
    ));
    repository.git(["reset", "--hard", "--quiet", "HEAD~1"]);
    runner.pull_fast_forward(root).unwrap();
    assert!(root.join("remote.txt").exists());
    assert_eq!(
        runner
            .observe_source_control_status(root)
            .unwrap()
            .upstream
            .unwrap()
            .ahead_behind,
        Some((0, 0))
    );
}

#[test]
fn publish_refuses_an_option_shaped_remote_name() {
    let repository = TestRepository::init("source-control-remote-name");
    repository.create_commit("base");
    let runner = GitRunner::discover().unwrap();
    assert!(matches!(
        runner.publish_current_branch(repository.root(), b"--receive-pack=evil"),
        Err(GitError::ParseFailed { .. })
    ));
}
