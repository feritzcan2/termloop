mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use termloop_gitio::{
    CLEANUP_GIT_MUTATION_DEADLINE, CLEANUP_GIT_SUBPROCESS_DEADLINE, GitError, GitRefName,
    GitReflogMessage, GitRunner, RegisteredPathState,
};

use support::TestDirectory;

struct Fixture {
    root: PathBuf,
    repository: PathBuf,
}

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

#[test]
fn explicit_cleanup_mutation_has_a_larger_bound_than_observation() {
    assert!(CLEANUP_GIT_MUTATION_DEADLINE > CLEANUP_GIT_SUBPROCESS_DEADLINE);
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "termloop-gitio-mutation-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let repository = root.join("repository");
        std::fs::create_dir_all(&root).unwrap();
        git(
            &root,
            [
                "init",
                "--initial-branch=main",
                repository.to_str().unwrap(),
            ],
        );
        git(&repository, ["config", "user.name", "TermLoop Fixture"]);
        git(
            &repository,
            ["config", "user.email", "fixture@termloop.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "fixture\n").unwrap();
        git(&repository, ["add", "--", "tracked.txt"]);
        git(&repository, ["commit", "-m", "fixture"]);
        Self { root, repository }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn ref_creation_forces_a_bounded_marker_and_conditional_delete() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/feature/recovery".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker = GitReflogMessage::from_bytes(b"termloop-provision:operation-1".to_vec()).unwrap();

    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let facts = runner
        .ref_recovery_facts(&fixture.repository, &target)
        .unwrap();
    assert_eq!(facts.current_oid.as_ref(), Some(&oid));
    assert_eq!(facts.entries.len(), 1);
    assert_eq!(facts.entries[0].new_oid, oid);
    assert_eq!(facts.entries[0].message, marker.as_bytes());
    assert!(matches!(
        runner.create_branch_ref(
            &fixture.repository,
            &target,
            &facts.entries[0].new_oid,
            &marker
        ),
        Err(GitError::BranchConflict)
    ));
    runner
        .delete_ref_if_matches(&fixture.repository, &target, &facts.entries[0].new_oid)
        .unwrap();
    assert!(
        runner
            .resolve_ref(&fixture.repository, &target)
            .unwrap()
            .is_none()
    );
}

#[test]
fn worktree_add_is_separate_and_reports_branch_and_path_conflicts() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/feature/worktree".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker = GitReflogMessage::from_bytes(b"termloop-provision:operation-2".to_vec()).unwrap();
    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let destination = fixture.root.join("feature worktree");
    runner
        .add_worktree(&fixture.repository, &destination, &target)
        .unwrap();
    let listed = runner.list_worktrees(&fixture.repository).unwrap();
    let canonical_destination =
        termloop_platform::canonical_existing_directory_path(&destination).unwrap();
    assert!(listed.iter().any(|worktree| {
        matches!(&worktree.path_state, RegisteredPathState::Present { canonical_path }
            if canonical_path == &canonical_destination)
    }));
    let second = fixture.root.join("second");
    assert!(matches!(
        runner.add_worktree(&fixture.repository, &second, &target),
        Err(GitError::BranchConflict)
    ));
}

#[test]
fn worktree_add_rejects_head_ref_before_creating_a_detached_checkout() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/HEAD".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker = GitReflogMessage::from_bytes(b"termloop-provision:invalid-head".to_vec()).unwrap();
    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let destination = fixture.root.join("must-not-be-detached");

    assert!(matches!(
        runner.add_worktree(&fixture.repository, &destination, &target),
        Err(GitError::ParseFailed { .. })
    ));
    assert!(!destination.exists());
    assert_eq!(runner.list_worktrees(&fixture.repository).unwrap().len(), 1);
}

#[test]
fn non_force_removal_refuses_dirty_content_and_preserves_the_branch() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/feature/remove".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker =
        GitReflogMessage::from_bytes(b"termloop-provision:operation-remove".to_vec()).unwrap();
    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let destination_component = termloop_platform::test_support::host_path_component(
        "remove 'quote' ünicode worktree",
        "remove\n'quote' ünicode worktree",
    );
    let destination = fixture.root.join(destination_component);
    runner
        .add_worktree(&fixture.repository, &destination, &target)
        .unwrap();

    std::fs::write(destination.join("tracked.txt"), "dirty\n").unwrap();
    assert!(matches!(
        runner.remove_worktree_non_force(&fixture.repository, &destination),
        Err(GitError::CheckoutContentChanged)
    ));
    assert!(destination.is_dir());
    assert!(
        runner
            .resolve_ref(&fixture.repository, &target)
            .unwrap()
            .is_some()
    );

    git(&destination, ["reset", "--hard", "HEAD"]);
    runner
        .remove_worktree_non_force(&fixture.repository, &destination)
        .unwrap();
    assert!(!destination.exists());
    assert!(
        runner
            .resolve_ref(&fixture.repository, &target)
            .unwrap()
            .is_some()
    );
    assert_eq!(runner.list_worktrees(&fixture.repository).unwrap().len(), 1);
}

#[test]
fn acknowledged_destructive_removal_discards_local_content_and_preserves_branch() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/feature/destructive-remove".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker =
        GitReflogMessage::from_bytes(b"termloop-provision:operation-destructive-remove".to_vec())
            .unwrap();
    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let destination = fixture.root.join("destructive worktree");
    runner
        .add_worktree(&fixture.repository, &destination, &target)
        .unwrap();
    std::fs::write(destination.join("tracked.txt"), "dirty\n").unwrap();
    std::fs::write(destination.join("staged.txt"), "staged\n").unwrap();
    git(&destination, ["add", "--", "staged.txt"]);
    std::fs::write(destination.join("untracked.txt"), "untracked\n").unwrap();
    std::fs::write(
        destination.join(".gitignore"),
        ".env\nnode_modules\ntarget\n",
    )
    .unwrap();
    std::fs::write(destination.join(".env"), "fixture secret\n").unwrap();
    std::fs::create_dir(destination.join("node_modules")).unwrap();
    std::fs::write(destination.join("node_modules/package"), "fixture\n").unwrap();
    std::fs::create_dir(destination.join("target")).unwrap();
    std::fs::write(destination.join("target/artifact"), "fixture\n").unwrap();

    runner
        .remove_worktree_exact_discarding_checkout_content(&fixture.repository, &destination)
        .unwrap();

    assert!(!destination.exists());
    assert!(
        runner
            .resolve_ref(&fixture.repository, &target)
            .unwrap()
            .is_some()
    );
    assert_eq!(runner.list_worktrees(&fixture.repository).unwrap().len(), 1);
}

#[test]
fn destructive_removal_accepts_a_symlink_aliased_destination_and_confirms_deregistration() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/feature/symlink-alias".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker =
        GitReflogMessage::from_bytes(b"termloop-provision:symlink-alias".to_vec()).unwrap();
    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let destination = fixture.root.join("aliased worktree");
    runner
        .add_worktree(&fixture.repository, &destination, &target)
        .unwrap();
    let link = fixture.root.join("root-link");
    if let Err(error) = termloop_platform::test_support::create_directory_symlink(
        &termloop_platform::canonical_existing_directory_path(&fixture.root).unwrap(),
        &link,
    ) {
        eprintln!("UNMEASURED: directory symlink unavailable: {error}");
        return;
    }

    runner
        .remove_worktree_exact_discarding_checkout_content(
            &fixture.repository,
            &link.join("aliased worktree"),
        )
        .unwrap();

    assert!(!destination.exists());
    assert_eq!(runner.list_worktrees(&fixture.repository).unwrap().len(), 1);
}

#[test]
fn destructive_removal_detects_a_still_registered_checkout_behind_a_symlinked_prefix() {
    let directory = TestDirectory::new("symlinked-registration");
    let repository = directory.path().join("repository");
    let checkout = directory.path().join("checkout");
    std::fs::create_dir_all(&repository).unwrap();
    std::fs::create_dir_all(&checkout).unwrap();
    let link = directory.path().join("root-link");
    if let Err(error) =
        termloop_platform::test_support::create_directory_symlink(directory.path(), &link)
    {
        eprintln!("UNMEASURED: directory symlink unavailable: {error}");
        return;
    }
    // Git records raw bytes that traverse the symlink; the caller's destination
    // is the canonicalized identity of the same directory.
    let registered_alias = link.join("checkout");
    let destination = termloop_platform::canonical_existing_directory_path(&checkout).unwrap();
    // This fake Git reports a successful removal while its registration list
    // still names the checkout through the symlinked prefix.
    let fake_git = directory.compile_fake_git(&format!(
        r#"
        fn main() {{
            use std::io::Write;
            let args: Vec<String> = std::env::args().skip(1).collect();
            if args.iter().any(|arg| arg == "--version") {{
                println!("git version 2.50.0");
                return;
            }}
            if args.iter().any(|arg| arg == "remove") {{
                return;
            }}
            let mut out: Vec<u8> = Vec::new();
            for (path, reference) in [
                ({repository:?}, "refs/heads/main"),
                ({alias:?}, "refs/heads/feature/symlinked"),
            ] {{
                out.extend_from_slice(b"worktree ");
                out.extend_from_slice(path.as_bytes());
                out.extend_from_slice(b"\0HEAD 0123456789012345678901234567890123456789\0branch ");
                out.extend_from_slice(reference.as_bytes());
                out.extend_from_slice(b"\0\0");
            }}
            std::io::stdout().write_all(&out).unwrap();
        }}
        "#,
        repository = repository,
        alias = registered_alias,
    ));
    let runner = GitRunner::discover_program(fake_git).unwrap();

    assert!(matches!(
        runner.remove_worktree_exact_discarding_checkout_content(&repository, &destination),
        Err(GitError::PathConflict)
    ));
}

#[test]
fn exact_link_repair_observes_bilateral_metadata_and_repairs_only_the_candidate() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/feature/repair".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker =
        GitReflogMessage::from_bytes(b"termloop-provision:operation-repair".to_vec()).unwrap();
    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let old = fixture.root.join("old-worktree");
    runner
        .add_worktree(&fixture.repository, &old, &target)
        .unwrap();
    let old = termloop_platform::canonical_existing_directory_path(&old).unwrap();
    let common = runner
        .inspect_repository(&fixture.repository)
        .unwrap()
        .common_dir;
    let candidate = fixture.root.join("moved-worktree");
    std::fs::rename(&old, &candidate).unwrap();

    let facts = runner
        .inspect_worktree_repair(&candidate, &common, &old)
        .unwrap();
    assert!(facts.bilateral_link_matches);
    assert!(facts.registration_matches_proof);
    assert!(facts.registration_missing_on_disk);
    assert!(!facts.candidate_is_current_path);
    assert!(facts.repair_class_supported);
    assert_eq!(facts.branch_ref, b"refs/heads/feature/repair");
    assert!(facts.head_matches_branch);

    runner.repair_worktree_link(&common, &candidate).unwrap();
    let health = runner.inspect_worktree_health(&candidate).unwrap();
    let candidate = termloop_platform::canonical_existing_directory_path(&candidate).unwrap();
    assert_eq!(
        health.repository.worktree_root.as_deref(),
        Some(candidate.as_path())
    );
    assert!(health.registration.is_some());
}

#[test]
fn exact_link_repair_supports_a_stale_backlink_at_the_current_path() {
    let fixture = Fixture::new();
    let runner = GitRunner::discover().unwrap();
    let base = GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap();
    let target = GitRefName::from_bytes(b"refs/heads/feature/current-repair".to_vec()).unwrap();
    let oid = runner
        .resolve_ref(&fixture.repository, &base)
        .unwrap()
        .unwrap();
    let marker =
        GitReflogMessage::from_bytes(b"termloop-provision:current-repair".to_vec()).unwrap();
    runner
        .create_branch_ref(&fixture.repository, &target, &oid, &marker)
        .unwrap();
    let candidate = fixture.root.join("current-worktree");
    runner
        .add_worktree(&fixture.repository, &candidate, &target)
        .unwrap();
    let candidate = termloop_platform::canonical_existing_directory_path(&candidate).unwrap();
    let common = runner
        .inspect_repository(&fixture.repository)
        .unwrap()
        .common_dir;
    let pointer = std::fs::read_to_string(candidate.join(".git")).unwrap();
    let administrative_dir = PathBuf::from(pointer.trim().strip_prefix("gitdir: ").unwrap());
    std::fs::write(
        administrative_dir.join("gitdir"),
        format!("{}\n", fixture.root.join("stale-location/.git").display()),
    )
    .unwrap();

    let facts = runner
        .inspect_worktree_repair(&candidate, &common, &candidate)
        .unwrap();
    assert!(facts.candidate_is_current_path);
    assert!(facts.repair_class_supported);
    assert!(!facts.bilateral_link_matches);
    assert!(facts.registration_missing_on_disk);

    runner.repair_worktree_link(&common, &candidate).unwrap();
    let repaired_backlink = std::fs::read_to_string(administrative_dir.join("gitdir")).unwrap();
    assert_eq!(
        Path::new(repaired_backlink.trim()).parent(),
        Some(candidate.as_path())
    );
}

fn git<const N: usize>(cwd: &Path, args: [&str; N]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            cwd.join(".termloop-empty-global.gitconfig"),
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .status()
        .unwrap();
    assert!(status.success());
}
