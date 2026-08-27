use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use termloop_gitio::GitRunner;

fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "TermLoop Test")
        .env("GIT_AUTHOR_EMAIL", "test@termloop.invalid")
        .env("GIT_COMMITTER_NAME", "TermLoop Test")
        .env("GIT_COMMITTER_EMAIL", "test@termloop.invalid")
        .status()
        .unwrap();
    assert!(status.success(), "git {:?} failed", args);
}

fn output(cwd: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {:?} failed", args);
    output.stdout
}

fn fixture(name: &str) -> (PathBuf, PathBuf) {
    let parent = std::env::temp_dir().join(format!(
        "termloop-worktree-branches-{name}-{}-{}",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let repository = parent.join("repository");
    let worktree = parent.join("worktree");
    std::fs::create_dir_all(&repository).unwrap();
    git(&repository, &["init", "--initial-branch=main"]);
    git(&repository, &["commit", "--allow-empty", "-m", "fixture"]);
    git(&repository, &["branch", "generated"]);
    let worktree_text = worktree.to_str().unwrap();
    git(
        &repository,
        &["worktree", "add", worktree_text, "generated"],
    );
    (repository, worktree)
}

#[test]
fn exact_linked_worktree_reports_current_and_historical_checkout_branches() {
    let (repository, worktree) = fixture("history");
    git(&worktree, &["switch", "-c", "UKIE-803"]);
    git(&worktree, &["switch", "-c", "UKIE-804"]);
    let index_path =
        String::from_utf8(output(&worktree, &["rev-parse", "--git-path", "index"])).unwrap();
    let index_path = PathBuf::from(index_path.trim());
    let index_before = std::fs::read(&index_path).unwrap();

    let runner = GitRunner::discover_with_timeout(Duration::from_millis(2_500)).unwrap();
    let facts = runner
        .observe_worktree_branches_with_timeout(
            &repository,
            &worktree,
            Duration::from_millis(2_500),
        )
        .unwrap();
    let names = facts
        .branches
        .iter()
        .map(|branch| branch.as_bytes())
        .collect::<Vec<_>>();
    assert_eq!(names[0], b"refs/heads/UKIE-804");
    assert!(names.contains(&b"refs/heads/UKIE-803".as_slice()));
    assert!(names.contains(&b"refs/heads/generated".as_slice()));
    assert!(!facts.truncated);
    assert_eq!(std::fs::read(&index_path).unwrap(), index_before);
    assert!(!index_path.with_file_name("index.lock").exists());

    let _ = std::fs::remove_dir_all(repository.parent().unwrap());
}

#[test]
fn another_repository_cannot_contribute_worktree_history() {
    let (repository, worktree) = fixture("mismatch-a");
    let (other_repository, _) = fixture("mismatch-b");
    let runner = GitRunner::discover_with_timeout(Duration::from_millis(2_500)).unwrap();
    assert!(
        runner
            .observe_worktree_branches_with_timeout(
                &other_repository,
                &worktree,
                Duration::from_millis(2_500),
            )
            .is_err()
    );

    let _ = std::fs::remove_dir_all(repository.parent().unwrap());
    let _ = std::fs::remove_dir_all(other_repository.parent().unwrap());
}

#[test]
fn missing_reflog_keeps_the_separately_proven_current_branch() {
    let (repository, worktree) = fixture("missing-reflog");
    git(&worktree, &["switch", "-c", "UKIE-804"]);
    let reflog_path =
        String::from_utf8(output(&worktree, &["rev-parse", "--git-path", "logs/HEAD"])).unwrap();
    std::fs::remove_file(reflog_path.trim()).unwrap();

    let runner = GitRunner::discover_with_timeout(Duration::from_millis(2_500)).unwrap();
    let facts = runner
        .observe_worktree_branches_with_timeout(
            &repository,
            &worktree,
            Duration::from_millis(2_500),
        )
        .unwrap();
    assert_eq!(
        facts
            .current_branch
            .as_ref()
            .map(|branch| branch.as_bytes()),
        Some(b"refs/heads/UKIE-804".as_slice())
    );
    assert_eq!(
        facts.branches,
        facts.current_branch.into_iter().collect::<Vec<_>>()
    );
    assert!(facts.truncated);

    let _ = std::fs::remove_dir_all(repository.parent().unwrap());
}
