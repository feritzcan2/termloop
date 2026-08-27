mod support;

use std::fs;
use std::time::Duration;

use termloop_gitio::{GitError, GitRunner, RegisteredPathState, WorktreeCheckout, WorktreeMarker};

use support::{TestDirectory, TestRepository};

#[test]
fn worktree_facts_cover_main_linked_detached_locked_and_missing_paths() {
    let repository = TestRepository::init("worktrees");
    repository.create_commit("initial");
    let linked_component =
        termloop_platform::test_support::host_path_component("linked-feature", "linked\nfeature");
    let detached_component = termloop_platform::test_support::host_path_component(
        "detached 'quote' ünicode",
        "detached 'quote' \" ünicode",
    );
    let linked = repository.fixture_root().join(linked_component);
    let detached = repository.fixture_root().join(detached_component);
    repository.git([
        "worktree".as_ref(),
        "add".as_ref(),
        "-b".as_ref(),
        "feature".as_ref(),
        linked.as_os_str(),
    ]);
    repository.git([
        "worktree".as_ref(),
        "add".as_ref(),
        "--detach".as_ref(),
        detached.as_os_str(),
    ]);
    repository.git([
        "worktree".as_ref(),
        "lock".as_ref(),
        "--reason".as_ref(),
        "portable\nvolume".as_ref(),
        linked.as_os_str(),
    ]);

    let main_before = repository.index_snapshot(repository.root());
    let linked_before = repository.index_snapshot(&linked);
    let detached_before = repository.index_snapshot(&detached);
    let registered_linked = termloop_platform::canonical_existing_directory_path(&linked).unwrap();
    let registered_detached =
        termloop_platform::canonical_existing_directory_path(&detached).unwrap();
    let runner = GitRunner::discover().unwrap();
    let facts = runner.list_worktrees(repository.root()).unwrap();
    assert_eq!(facts.len(), 3);
    assert!(facts[0].is_main);
    assert!(matches!(facts[0].checkout, WorktreeCheckout::Branch { .. }));
    let linked_facts = facts
        .iter()
        .find(|facts| facts.registered_path == registered_linked)
        .unwrap();
    assert!(matches!(
        linked_facts.locked,
        WorktreeMarker::Present { .. }
    ));
    assert_eq!(
        match &linked_facts.locked {
            WorktreeMarker::Present {
                reason: Some(reason),
            } => reason.as_bytes(),
            marker => panic!("unexpected lock marker: {marker:?}"),
        },
        b"portable\nvolume"
    );
    assert!(matches!(
        facts
            .iter()
            .find(|facts| facts.registered_path == registered_detached)
            .unwrap()
            .checkout,
        WorktreeCheckout::Detached { .. }
    ));
    assert_eq!(main_before, repository.index_snapshot(repository.root()));
    assert_eq!(linked_before, repository.index_snapshot(&linked));
    assert_eq!(detached_before, repository.index_snapshot(&detached));

    fs::remove_dir_all(&detached).unwrap();
    let main_before = repository.index_snapshot(repository.root());
    let linked_before = repository.index_snapshot(&linked);
    let facts = runner.list_worktrees(repository.root()).unwrap();
    let missing = facts
        .iter()
        .find(|facts| facts.registered_path == registered_detached)
        .unwrap();
    assert_eq!(missing.path_state, RegisteredPathState::Missing);
    assert_eq!(main_before, repository.index_snapshot(repository.root()));
    assert_eq!(linked_before, repository.index_snapshot(&linked));
}

#[test]
fn truncated_worktree_porcelain_is_a_typed_failure() {
    let directory = TestDirectory::new("truncated-worktree");
    let fake_git = directory.compile_fake_git(
        r#"
        fn main() {
            if std::env::args().nth(1).as_deref() == Some("--version") {
                println!("git version 2.50.0");
            } else {
                println!("{}", "x".repeat(8192));
            }
        }
        "#,
    );
    let runner = GitRunner::discover_program(fake_git)
        .unwrap()
        .with_limits(Duration::from_secs(5), 256);
    assert!(matches!(
        runner.list_worktrees(directory.path()),
        Err(GitError::OutputLimitExceeded { .. })
    ));
}

#[test]
fn bare_repository_is_reported_without_inventing_a_worktree_head() {
    let repository = TestRepository::init_bare("bare-worktree");
    let before = repository.index_snapshot(repository.root());
    let facts = GitRunner::discover()
        .unwrap()
        .list_worktrees(repository.root())
        .unwrap();
    assert_eq!(facts.len(), 1);
    assert!(facts[0].is_main);
    assert!(matches!(facts[0].checkout, WorktreeCheckout::Bare));
    assert_eq!(before, repository.index_snapshot(repository.root()));
}
