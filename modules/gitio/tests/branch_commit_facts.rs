mod support;

use std::fs;

use termloop_gitio::{
    BranchCommitState, BranchCommitUnavailable, GitRunner, WorktreeChangeKind, WorktreeDiffContent,
};

use support::TestRepository;

#[test]
fn counts_commits_not_reachable_from_the_local_remote_default_ref() {
    let repository = TestRepository::init("branch-commit-count");
    repository.create_commit("base");
    let base_oid = repository.git(["rev-parse", "HEAD"]).stdout;
    let base_oid = base_oid.strip_suffix(b"\n").unwrap();
    repository.git([
        "remote",
        "add",
        "origin",
        "https://example.invalid/repository.git",
    ]);
    repository.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repository.git([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    repository.git(["update-ref", "refs/remotes/origin/development", "HEAD"]);
    repository.git(["checkout", "-b", "feature/count"]);
    for index in 1..=3 {
        fs::write(
            repository.root().join("tracked.txt"),
            format!("feature {index}\n"),
        )
        .unwrap();
        repository.git(["add", "--", "tracked.txt"]);
        repository.git(["commit", "-m", &format!("feature {index}")]);
    }

    let before = repository.index_snapshot(repository.root());
    let observed = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary_with_local_base(
            repository.root(),
            b"feature/count",
            Some(b"refs/heads/feature/count"),
        )
        .unwrap();
    assert!(matches!(
        observed.state,
        BranchCommitState::Available { count: 3, .. }
    ));
    assert!(
        observed.git_process_count <= 10,
        "branch summary exceeded its process bound: {}",
        observed.git_process_count
    );
    assert_eq!(before, repository.index_snapshot(repository.root()));

    // Publishing the Task branch does not move the selected remote-default
    // base, so this is a branch-work count rather than an upstream-ahead count.
    repository.git(["update-ref", "refs/remotes/origin/feature/count", "HEAD"]);
    repository.git(["config", "branch.feature/count.remote", "origin"]);
    repository.git([
        "config",
        "branch.feature/count.merge",
        "refs/heads/feature/count",
    ]);
    let pushed = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary(repository.root(), b"feature/count")
        .unwrap();
    assert!(matches!(
        pushed.state,
        BranchCommitState::Available { count: 3, .. }
    ));

    repository.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let merged = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary(repository.root(), b"feature/count")
        .unwrap();
    assert!(matches!(
        merged.state,
        BranchCommitState::Available { count: 0, .. }
    ));

    let current_base = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary_requests(
            repository.root(),
            &[
                termloop_gitio::BranchCommitSummaryRequest::with_current_base(
                    b"feature/count".to_vec(),
                    b"refs/heads/development".to_vec(),
                ),
            ],
        )
        .unwrap()
        .observations
        .pop()
        .unwrap()
        .unwrap();
    assert!(matches!(
        current_base.state,
        BranchCommitState::Available { count: 3, ref base_ref }
            if base_ref.as_bytes() == b"refs/remotes/origin/development"
    ));
    let current_base_commits = GitRunner::discover()
        .unwrap()
        .list_branch_commits_with_current_base(
            repository.root(),
            b"feature/count",
            b"refs/heads/development",
        )
        .unwrap();
    assert_eq!(current_base_commits.commits.len(), 3);
    assert_eq!(
        current_base_commits.base_ref.as_bytes(),
        b"refs/remotes/origin/development"
    );

    let recorded = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary_with_recorded_base(
            repository.root(),
            b"feature/count",
            b"refs/heads/main",
            base_oid,
        )
        .unwrap();
    assert!(matches!(
        recorded.state,
        BranchCommitState::Available { count: 3, .. }
    ));
    assert!(matches!(
        recorded.not_in_base,
        BranchCommitState::Available { count: 0, ref base_ref }
            if base_ref.as_bytes() == b"refs/remotes/origin/main"
    ));
    let commits = GitRunner::discover()
        .unwrap()
        .list_branch_commits_with_recorded_base(
            repository.root(),
            b"feature/count",
            b"refs/heads/main",
            base_oid,
        )
        .unwrap();
    assert_eq!(commits.commits.len(), 3);
}

#[test]
fn no_remote_uses_only_the_caller_proven_exact_local_base() {
    let repository = TestRepository::init("branch-commit-local-base");
    repository.create_commit("base");
    let base_oid = repository.git(["rev-parse", "HEAD"]).stdout;
    let base_oid = base_oid.strip_suffix(b"\n").unwrap();
    repository.git(["checkout", "-b", "feature/local"]);
    for index in 1..=2 {
        fs::write(
            repository.root().join("tracked.txt"),
            format!("feature {index}\n"),
        )
        .unwrap();
        repository.git(["add", "--", "tracked.txt"]);
        repository.git(["commit", "-m", &format!("feature {index}")]);
    }

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let unavailable = runner
        .observe_branch_commit_summary(repository.root(), b"feature/local")
        .unwrap();
    assert!(matches!(
        unavailable.state,
        BranchCommitState::Unavailable {
            reason: BranchCommitUnavailable::BaseRefUnavailable,
            ..
        }
    ));

    let observed = runner
        .observe_branch_commit_summary_with_local_base(
            repository.root(),
            b"feature/local",
            Some(b"refs/heads/main"),
        )
        .unwrap();
    assert!(matches!(
        observed.state,
        BranchCommitState::Available { count: 2, ref base_ref }
            if base_ref.as_bytes() == b"refs/heads/main"
    ));
    assert!(matches!(
        observed.not_in_base,
        BranchCommitState::Available { count: 2, ref base_ref }
            if base_ref.as_bytes() == b"refs/heads/main"
    ));
    let managed = runner
        .observe_branch_commit_summary_with_recorded_base(
            repository.root(),
            b"feature/local",
            b"refs/heads/main",
            base_oid,
        )
        .unwrap();
    assert!(matches!(
        managed.not_in_base,
        BranchCommitState::Available { count: 2, ref base_ref }
            if base_ref.as_bytes() == b"refs/heads/main"
    ));
    let commits = runner
        .list_branch_commits_with_local_base(
            repository.root(),
            b"feature/local",
            Some(b"refs/heads/main"),
        )
        .unwrap();
    assert_eq!(commits.commits.len(), 2);
    assert_eq!(commits.base_ref.as_bytes(), b"refs/heads/main");
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn current_base_count_fails_closed_when_the_managed_branch_lost_its_recorded_base() {
    let repository = TestRepository::init("branch-commit-diverged");
    repository.create_commit("managed base");
    let recorded_base_oid = repository.git(["rev-parse", "HEAD"]).stdout;
    let recorded_base_oid = recorded_base_oid.strip_suffix(b"\n").unwrap();
    repository.git([
        "remote",
        "add",
        "origin",
        "https://example.invalid/repository.git",
    ]);
    repository.git(["update-ref", "refs/remotes/origin/development", "HEAD"]);
    repository.git(["checkout", "--orphan", "unrelated"]);
    fs::write(repository.root().join("unrelated.txt"), "unrelated\n").unwrap();
    repository.git(["add", "--", "unrelated.txt"]);
    repository.git(["commit", "-m", "unrelated history"]);
    repository.git(["branch", "feature/diverged"]);

    let observed = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary_requests(
            repository.root(),
            &[
                termloop_gitio::BranchCommitSummaryRequest::with_current_base_and_recorded_base(
                    b"feature/diverged".to_vec(),
                    b"refs/heads/development".to_vec(),
                    recorded_base_oid.to_vec(),
                ),
            ],
        )
        .unwrap()
        .observations
        .pop()
        .unwrap()
        .unwrap();

    assert!(matches!(
        observed.state,
        BranchCommitState::Unavailable {
            reason: BranchCommitUnavailable::BranchDiverged,
            ..
        }
    ));
}

#[test]
fn ambiguous_remote_and_missing_remote_head_fail_closed() {
    let ambiguous = TestRepository::init("branch-commit-ambiguous");
    ambiguous.create_commit("base");
    ambiguous.git(["branch", "feature"]);
    ambiguous.git(["remote", "add", "one", "https://one.invalid/repository.git"]);
    ambiguous.git(["remote", "add", "two", "https://two.invalid/repository.git"]);
    let observed = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary_with_local_base(
            ambiguous.root(),
            b"feature",
            Some(b"refs/heads/main"),
        )
        .unwrap();
    assert!(matches!(
        observed.state,
        BranchCommitState::Unavailable {
            reason: BranchCommitUnavailable::AmbiguousRemote,
            ..
        }
    ));

    let missing_head = TestRepository::init("branch-commit-missing-head");
    missing_head.create_commit("base");
    missing_head.git(["branch", "feature"]);
    missing_head.git([
        "remote",
        "add",
        "origin",
        "https://example.invalid/repository.git",
    ]);
    let observed = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary_with_local_base(
            missing_head.root(),
            b"feature",
            Some(b"refs/heads/main"),
        )
        .unwrap();
    assert!(matches!(
        observed.state,
        BranchCommitState::Unavailable {
            reason: BranchCommitUnavailable::BaseRefUnavailable,
            ..
        }
    ));
}

#[test]
fn missing_task_branch_is_typed_before_remote_resolution() {
    let repository = TestRepository::init("branch-commit-missing-branch");
    repository.create_commit("base");
    let observed = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summary(repository.root(), b"missing")
        .unwrap();
    assert!(matches!(
        observed.state,
        BranchCommitState::Unavailable {
            reason: BranchCommitUnavailable::BranchMissing,
            ..
        }
    ));
}

#[test]
fn repository_batch_shares_identity_config_remote_head_and_deadline() {
    let repository = TestRepository::init("branch-commit-batch");
    repository.create_commit("base");
    repository.git([
        "remote",
        "add",
        "origin",
        "https://example.invalid/repository.git",
    ]);
    repository.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repository.git([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    for branch in ["feature/one", "feature/two"] {
        repository.git(["checkout", "-b", branch, "main"]);
        fs::write(repository.root().join("tracked.txt"), format!("{branch}\n")).unwrap();
        repository.git(["add", "--", "tracked.txt"]);
        repository.git(["commit", "-m", branch]);
    }

    let before = repository.index_snapshot(repository.root());
    let batch = GitRunner::discover()
        .unwrap()
        .observe_branch_commit_summaries(
            repository.root(),
            &[
                b"feature/one".to_vec(),
                b"feature/two".to_vec(),
                b"feature/one".to_vec(),
            ],
        )
        .unwrap();
    assert_eq!(batch.observations.len(), 3);
    assert!(batch.observations.iter().all(|observation| matches!(
        observation,
        Ok(termloop_gitio::BranchCommitSummaryObservation {
            state: BranchCommitState::Available { count: 1, .. },
            ..
        })
    )));
    assert!(
        batch.git_process_count <= 10,
        "two branches should share repository facts: {} processes",
        batch.git_process_count
    );
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn lists_branch_commits_and_renders_exact_literal_and_rename_paths_without_index_mutation() {
    let repository = TestRepository::init("branch-commit-viewer");
    let renamed_path =
        termloop_platform::test_support::host_path_component("renamed[1].txt", ":renamed[1].txt");
    repository.create_commit("base");
    repository.git([
        "remote",
        "add",
        "origin",
        "https://example.invalid/repository.git",
    ]);
    repository.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    repository.git([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    repository.git(["checkout", "-b", "feature/viewer"]);
    fs::write(repository.root().join("a1.txt"), "initial\n").unwrap();
    fs::write(repository.root().join("a[1].txt"), "initial\n").unwrap();
    repository.git(["add", "-A"]);
    repository.git(["commit", "-m", "literal files"]);
    fs::write(repository.root().join("a1.txt"), "A1_ONLY\n").unwrap();
    fs::write(repository.root().join("a[1].txt"), "BRACKET_ONLY\n").unwrap();
    repository.git(["add", "-A"]);
    repository.git(["commit", "-m", "literal update"]);
    repository.git(["mv", "a[1].txt", renamed_path]);
    repository.git(["commit", "-m", "rename literal"]);

    let runner = GitRunner::discover().unwrap();
    let before = repository.index_snapshot(repository.root());
    let commits = runner
        .list_branch_commits(repository.root(), b"feature/viewer")
        .unwrap();
    assert_eq!(commits.commits.len(), 3);
    assert_eq!(commits.commits[0].subject(), b"rename literal");

    let all_files = runner
        .list_branch_range_changes(
            repository.root(),
            &commits.base_oid,
            commits.branch_tip_oid.as_ref().unwrap(),
        )
        .unwrap();
    assert_eq!(all_files.entries.len(), 2);
    let all_bracket = all_files
        .entries
        .iter()
        .find(|entry| entry.path().to_str() == Some(renamed_path))
        .unwrap();
    let WorktreeDiffContent::Patch(all_patch) = runner
        .diff_branch_range_change(
            repository.root(),
            &commits.base_oid,
            commits.branch_tip_oid.as_ref().unwrap(),
            all_bracket,
        )
        .unwrap()
        .content
    else {
        panic!("combined branch change must render");
    };
    let all_patch = String::from_utf8(all_patch).unwrap();
    assert!(all_patch.contains("BRACKET_ONLY"));
    assert!(!all_patch.contains("A1_ONLY"));

    let rename_files = runner
        .list_commit_changes(repository.root(), &commits.commits[0])
        .unwrap();
    let rename = rename_files
        .entries
        .iter()
        .find(|entry| entry.kind() == WorktreeChangeKind::Renamed)
        .unwrap();
    let WorktreeDiffContent::Patch(rename_patch) = runner
        .diff_commit_change(repository.root(), &commits.commits[0], rename)
        .unwrap()
        .content
    else {
        panic!("rename commit must render");
    };
    let rename_patch = String::from_utf8(rename_patch).unwrap();
    assert!(rename_patch.contains("rename from a[1].txt"));
    assert!(rename_patch.contains(&format!("rename to {renamed_path}")));

    let literal_files = runner
        .list_commit_changes(repository.root(), &commits.commits[1])
        .unwrap();
    let bracket = literal_files
        .entries
        .iter()
        .find(|entry| entry.path().to_str() == Some("a[1].txt"))
        .unwrap();
    let WorktreeDiffContent::Patch(patch) = runner
        .diff_commit_change(repository.root(), &commits.commits[1], bracket)
        .unwrap()
        .content
    else {
        panic!("literal path commit must render");
    };
    let patch = String::from_utf8(patch).unwrap();
    assert!(patch.contains("BRACKET_ONLY"));
    assert!(!patch.contains("A1_ONLY"));
    assert_eq!(before, repository.index_snapshot(repository.root()));
}
