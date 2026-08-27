use std::path::Path;
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

#[test]
fn observes_remote_head_refs_separately_from_local_branch() {
    let root = std::env::temp_dir().join(format!(
        "termloop-remote-facts-{}-{}",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(&root, &["commit", "--allow-empty", "-m", "fixture"]);
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/widget.git",
        ],
    );
    git(
        &root,
        &["remote", "add", "fork", "git@github.com:ferit/widget.git"],
    );
    git(
        &root,
        &[
            "remote",
            "set-url",
            "--add",
            "--push",
            "fork",
            "ssh://git@github.com/ferit/widget.git",
        ],
    );
    git(&root, &["config", "branch.main.remote", "origin"]);
    git(
        &root,
        &["config", "branch.main.merge", "refs/heads/review/42"],
    );
    git(&root, &["config", "branch.main.pushRemote", "fork"]);
    git(&root, &["config", "remote.pushDefault", "fork"]);
    git(&root, &["config", "push.default", "current"]);

    let runner = GitRunner::discover_with_timeout(Duration::from_millis(2_500)).unwrap();
    let facts = runner.observe_branch_remotes(&root, b"main").unwrap();
    assert_eq!(
        facts.upstream.unwrap().reference,
        b"refs/remotes/origin/review/42"
    );
    assert_eq!(facts.push_default.as_deref(), Some(b"fork".as_slice()));
    assert_eq!(facts.remotes.len(), 2);
    assert_eq!(facts.remotes[0].name, b"fork");
    assert_eq!(facts.remotes[1].name, b"origin");
    assert_eq!(facts.remotes[0].push_urls.len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn requested_deleted_branch_keeps_remote_fallback_facts() {
    let root = std::env::temp_dir().join(format!(
        "termloop-remote-missing-{}-{}",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(&root, &["commit", "--allow-empty", "-m", "fixture"]);
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/widget.git",
        ],
    );

    let runner = GitRunner::discover_with_timeout(Duration::from_millis(2_500)).unwrap();
    let facts = runner
        .observe_branch_remotes_including_missing_with_timeout(
            &root,
            &[b"main".to_vec(), b"deleted/review".to_vec()],
            Duration::from_millis(2_500),
        )
        .unwrap();
    assert_eq!(facts.len(), 2);
    assert_eq!(
        facts[1].local_branch.as_bytes(),
        b"refs/heads/deleted/review"
    );
    assert!(facts[1].upstream.is_none());
    assert_eq!(facts[1].remotes[0].name, b"origin");

    let _ = std::fs::remove_dir_all(root);
}
