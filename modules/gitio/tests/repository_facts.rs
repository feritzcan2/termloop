mod support;

use std::fs;
use std::sync::{Arc, Barrier};
use std::time::Duration;

use termloop_gitio::{GitError, GitFailureKind, GitRefName, GitRunner, HeadState};

use support::{TestDirectory, TestRepository};

#[test]
fn repository_facts_cover_unborn_attached_detached_bare_and_subdirectories() {
    let runner = GitRunner::discover().unwrap();
    let repository = TestRepository::init("repository-states");
    let before = repository.index_snapshot(repository.root());

    let unborn = runner.inspect_repository(repository.root()).unwrap();
    assert!(!unborn.bare);
    assert!(matches!(unborn.head, HeadState::Unborn { .. }));
    assert_eq!(
        unborn.worktree_root,
        Some(termloop_platform::canonical_existing_directory_path(repository.root()).unwrap())
    );

    repository.create_commit("initial");
    let subdirectory = repository.root().join("nested");
    fs::create_dir_all(&subdirectory).unwrap();
    let attached = runner.inspect_repository(&subdirectory).unwrap();
    let (branch, oid) = match attached.head {
        HeadState::Attached { branch, oid } => (branch, oid),
        state => panic!("unexpected HEAD state: {state:?}"),
    };
    assert_eq!(branch.as_bytes(), b"refs/heads/main");
    assert_eq!(oid.as_bytes().len(), 40);
    let stable = repository.index_snapshot(repository.root());
    assert!(runner.branch_exists(repository.root(), b"main").unwrap());
    assert_eq!(stable, repository.index_snapshot(repository.root()));
    assert!(
        !runner
            .branch_exists(repository.root(), b"does-not-exist")
            .unwrap()
    );
    assert_eq!(stable, repository.index_snapshot(repository.root()));
    for expression in [b"main~1".as_slice(), b"main..other", b"main@{1}"] {
        assert!(matches!(
            runner.branch_exists(repository.root(), expression),
            Err(GitError::ParseFailed { .. })
        ));
    }
    assert_eq!(
        runner
            .resolve_ref(
                repository.root(),
                &GitRefName::from_bytes(b"refs/heads/main".to_vec()).unwrap()
            )
            .unwrap()
            .unwrap(),
        oid
    );
    assert_eq!(stable, repository.index_snapshot(repository.root()));

    repository.git(["checkout", "--detach"]);
    assert!(matches!(
        runner.inspect_repository(repository.root()).unwrap().head,
        HeadState::Detached { .. }
    ));
    assert_ne!(before, repository.index_snapshot(repository.root()));
    let stable = repository.index_snapshot(repository.root());
    let _ = runner.inspect_repository(repository.root()).unwrap();
    assert_eq!(stable, repository.index_snapshot(repository.root()));

    let bare = TestRepository::init_bare("bare");
    let facts = runner.inspect_repository(bare.root()).unwrap();
    assert!(facts.bare);
    assert!(facts.worktree_root.is_none());
    assert!(matches!(facts.head, HeadState::Unborn { .. }));
}

#[test]
fn local_branches_are_sorted_exact_and_do_not_touch_the_index() {
    let runner = GitRunner::discover().unwrap();
    let repository = TestRepository::init("local-branches");
    repository.create_commit("initial");
    repository.git(["branch", "feature/zeta"]);
    repository.git(["branch", "feature/alpha"]);
    repository.git(["branch", "ünicode"]);
    let before = repository.index_snapshot(repository.root());

    let branches = runner.list_local_branches(repository.root()).unwrap();
    let names = branches
        .branches
        .iter()
        .map(|reference| std::str::from_utf8(reference.as_bytes()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "refs/heads/feature/alpha",
            "refs/heads/feature/zeta",
            "refs/heads/main",
            "refs/heads/ünicode",
        ]
    );
    assert!(!branches.truncated);
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn path_facts_preserve_newlines_and_runtime_supported_non_utf_bytes() {
    let runner = GitRunner::discover().unwrap();
    let newline_component =
        termloop_platform::test_support::host_path_component("repo-line", "repo\nline");
    let newline = TestRepository::init_with_component("newline", newline_component.as_ref());
    let before = newline.index_snapshot(newline.root());
    let facts = runner.inspect_repository(newline.root()).unwrap();
    assert_eq!(
        facts.worktree_root,
        Some(termloop_platform::canonical_existing_directory_path(newline.root()).unwrap())
    );
    assert_eq!(before, newline.index_snapshot(newline.root()));

    let quoted_component = termloop_platform::test_support::host_path_component(
        "repo 'quote' ünicode",
        "repo 'quote' \" ünicode",
    );
    let quoted = TestRepository::init_with_component("quoted", quoted_component.as_ref());
    let before = quoted.index_snapshot(quoted.root());
    let facts = runner.inspect_repository(quoted.root()).unwrap();
    assert_eq!(
        facts.worktree_root,
        Some(termloop_platform::canonical_existing_directory_path(quoted.root()).unwrap())
    );
    assert_eq!(before, quoted.index_snapshot(quoted.root()));

    if let Ok(component) = termloop_platform::os_string_from_process_bytes(b"repo-\xff".to_vec())
        && let Ok(repository) = TestRepository::try_init_with_component("non-utf", &component)
    {
        let before = repository.index_snapshot(repository.root());
        let facts = runner.inspect_repository(repository.root()).unwrap();
        assert_eq!(
            facts.worktree_root,
            Some(termloop_platform::canonical_existing_directory_path(repository.root()).unwrap())
        );
        assert_eq!(before, repository.index_snapshot(repository.root()));
    } else {
        eprintln!("UNMEASURED: this host cannot create the non-UTF repository path fixture");
    }
}

#[test]
fn broken_linked_worktree_registration_is_not_reported_as_not_repository() {
    let repository = TestRepository::init("broken-registration");
    repository.create_commit("initial");
    let linked = repository.fixture_root().join("linked");
    repository.git([
        "worktree".as_ref(),
        "add".as_ref(),
        "-b".as_ref(),
        "linked".as_ref(),
        linked.as_os_str(),
    ]);
    let git_file = fs::read(linked.join(".git")).unwrap();
    let git_dir = git_file
        .strip_prefix(b"gitdir: ")
        .and_then(|value| value.strip_suffix(b"\n"))
        .unwrap();
    let git_dir = termloop_platform::path_from_process_bytes(git_dir.to_vec()).unwrap();
    fs::remove_dir_all(git_dir).unwrap();
    let before = repository.index_snapshot(repository.root());
    assert!(matches!(
        GitRunner::discover().unwrap().inspect_repository(&linked),
        Err(GitError::MissingRegistration)
    ));
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn requested_symlink_is_preserved_while_repository_identity_is_canonical() {
    let runner = GitRunner::discover().unwrap();
    let repository = TestRepository::init("symlink");
    let link = repository.fixture_root().join("repository-link");
    match termloop_platform::test_support::create_directory_symlink(repository.root(), &link) {
        Ok(()) => {
            let before = repository.index_snapshot(repository.root());
            let facts = runner.inspect_repository(&link).unwrap();
            assert_eq!(facts.requested_path, link);
            assert_eq!(
                facts.resolved_path,
                termloop_platform::canonical_existing_directory_path(repository.root()).unwrap()
            );
            assert_eq!(before, repository.index_snapshot(repository.root()));
        }
        Err(error) => {
            eprintln!("UNMEASURED: this host could not create the symlink fixture: {error}");
        }
    }
}

#[test]
fn non_repository_and_missing_git_are_typed() {
    let runner = GitRunner::discover().unwrap();
    let directory = TestDirectory::new("not-repository");
    assert!(matches!(
        runner.inspect_repository(directory.path()),
        Err(GitError::NotRepository)
    ));
    assert!(matches!(
        runner.inspect_repository(&directory.path().join("missing")),
        Err(GitError::NotRepository)
    ));
    assert!(matches!(
        GitRunner::discover_program(directory.path().join("missing-git")),
        Err(GitError::GitUnavailable)
    ));
}

#[test]
fn fake_git_covers_unsupported_version_xcrun_timeout_and_output_bounds() {
    let unsupported_dir = TestDirectory::new("unsupported-git");
    let unsupported =
        unsupported_dir.compile_fake_git(r#"fn main() { println!("git version 2.35.9"); }"#);
    assert!(matches!(
        GitRunner::discover_program(unsupported),
        Err(GitError::UnsupportedVersion { .. })
    ));

    let xcrun_dir = TestDirectory::new("xcrun-git");
    let xcrun = xcrun_dir.compile_fake_git(
        r#"fn main() { eprintln!("xcrun: error: developer tools unavailable"); std::process::exit(69); }"#,
    );
    assert!(matches!(
        GitRunner::discover_program(xcrun),
        Err(GitError::GitUnavailable)
    ));

    let timeout_dir = TestDirectory::new("timeout-git");
    let timeout = timeout_dir.compile_fake_git(
        r#"
        fn main() {
            if std::env::args().nth(1).as_deref() == Some("--version") {
                println!("git version 2.50.0");
            } else {
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
        }
        "#,
    );
    let runner = GitRunner::discover_program(timeout)
        .unwrap()
        .with_limits(Duration::from_millis(100), 1024);
    assert!(matches!(
        runner.inspect_repository(timeout_dir.path()),
        Err(GitError::Timeout { .. })
    ));

    let output_dir = TestDirectory::new("large-output-git");
    let output = output_dir.compile_fake_git(
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
    let runner = GitRunner::discover_program(output)
        .unwrap()
        .with_limits(Duration::from_secs(5), 256);
    assert!(matches!(
        runner.inspect_repository(output_dir.path()),
        Err(GitError::OutputLimitExceeded { .. })
    ));
}

#[test]
fn every_invocation_injects_deterministic_config_with_platform_gated_long_paths() {
    let directory = TestDirectory::new("config-env-git");
    let marker = directory.path().join("git-config-env");
    let fake_git = directory.compile_fake_git(&format!(
        r#"
        fn main() {{
            let count: usize = std::env::var("GIT_CONFIG_COUNT").unwrap().parse().unwrap();
            let mut dump = String::new();
            for index in 0..count {{
                let key = std::env::var(format!("GIT_CONFIG_KEY_{{index}}")).unwrap();
                let value = std::env::var(format!("GIT_CONFIG_VALUE_{{index}}")).unwrap();
                dump.push_str(&format!("{{key}}={{value}}\n"));
            }}
            std::fs::write({marker:?}, dump).unwrap();
            println!("git version 2.50.0");
        }}
        "#,
    ));
    GitRunner::discover_program(fake_git).unwrap();
    let mut expected = String::from("core.fsmonitor=false\n");
    if termloop_platform::host_requires_long_path_opt_in() {
        expected.push_str("core.longpaths=true\n");
    }
    assert_eq!(fs::read_to_string(&marker).unwrap(), expected);
}

#[test]
fn fake_git_repository_failures_are_classified_without_retaining_raw_stderr() {
    let directory = TestDirectory::new("classified-git");
    let fake_git = directory.compile_fake_git(
        r#"
        fn main() {
            if std::env::args().nth(1).as_deref() == Some("--version") {
                println!("git version 2.50.0");
                return;
            }
            let mode = std::fs::read_to_string(".fake-git-mode").unwrap();
            match mode.trim() {
                "not-repository" => eprintln!("fatal: not a git repository (or any of the parent directories): .git"),
                "missing-registration" => eprintln!("fatal: not a git repository: /repo/.git/worktrees/missing"),
                "dubious" => eprintln!("fatal: detected dubious ownership in repository at '/repo'"),
                "bad-config" => eprintln!("fatal: bad config line 1 in file .git/config"),
                mode => panic!("unexpected mode: {}", mode),
            }
            std::process::exit(128);
        }
        "#,
    );
    let runner = GitRunner::discover_program(fake_git).unwrap();
    let mode_path = directory.path().join(".fake-git-mode");

    fs::write(&mode_path, "not-repository").unwrap();
    assert!(matches!(
        runner.inspect_repository(directory.path()),
        Err(GitError::NotRepository)
    ));
    fs::write(&mode_path, "missing-registration").unwrap();
    assert!(matches!(
        runner.inspect_repository(directory.path()),
        Err(GitError::MissingRegistration)
    ));
    fs::write(&mode_path, "dubious").unwrap();
    assert!(matches!(
        runner.inspect_repository(directory.path()),
        Err(GitError::PermissionDenied { .. })
    ));
    fs::write(&mode_path, "bad-config").unwrap();
    assert!(matches!(
        runner.inspect_repository(directory.path()),
        Err(GitError::CommandFailed {
            kind: GitFailureKind::InvalidConfiguration,
            ..
        })
    ));
}

#[test]
fn repository_observations_are_not_globally_serialized() {
    let repository = TestRepository::init("parallel");
    repository.create_commit("parallel");
    let runner = Arc::new(GitRunner::discover().unwrap());
    let root = Arc::new(repository.root().to_path_buf());
    let barrier = Arc::new(Barrier::new(9));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let runner = Arc::clone(&runner);
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                runner.inspect_repository(&root).unwrap()
            })
        })
        .collect();
    barrier.wait();
    for thread in threads {
        assert!(matches!(
            thread.join().unwrap().head,
            HeadState::Attached { .. }
        ));
    }
}

#[test]
fn repository_identity_stays_within_non_bare_and_bare_process_bounds() {
    let directory = TestDirectory::new("repository-process-count");
    let fake_git = directory.compile_fake_git(
        r##"
        use std::io::Write;

        fn main() {
            let args = std::env::args().skip(1).collect::<Vec<_>>();
            if args.first().map(String::as_str) == Some("--version") {
                println!("git version 2.50.0");
                return;
            }
            let executable = std::env::current_exe().unwrap();
            let count = executable.parent().unwrap().join("spawn-count");
            writeln!(
                std::fs::OpenOptions::new().create(true).append(true).open(count).unwrap(),
                "spawn"
            ).unwrap();
            let cwd = std::env::current_dir().unwrap();
            let bare = cwd.join("bare-marker").exists();
            if args == ["rev-parse", "--is-bare-repository", "--absolute-git-dir"] {
                println!("{}", bare);
                let git_dir = if bare { cwd.clone() } else { cwd.join(".git") };
                println!("{}", git_dir.display());
            } else if args == ["rev-parse", "--git-common-dir"] {
                println!("{}", cwd.join(".git").display());
            } else if args == ["rev-parse", "--show-toplevel"] {
                println!("{}", cwd.display());
            } else if args.first().map(String::as_str) == Some("status") {
                print!("# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\0");
            } else if args == ["symbolic-ref", "--quiet", "HEAD"] {
                println!("refs/heads/main");
            } else if args == ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"] {
                println!("0123456789012345678901234567890123456789");
            } else {
                panic!("unexpected args: {:?}", args);
            }
        }
        "##,
    );
    let count = directory.path().join("spawn-count");
    let non_bare = directory.path().join("non-bare");
    fs::create_dir_all(non_bare.join(".git")).unwrap();
    let runner = GitRunner::discover_program(&fake_git).unwrap();
    assert!(!runner.inspect_repository(&non_bare).unwrap().bare);
    assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 4);

    fs::write(&count, b"").unwrap();
    let bare = directory.path().join("bare");
    fs::create_dir_all(&bare).unwrap();
    fs::write(bare.join("bare-marker"), b"").unwrap();
    assert!(runner.inspect_repository(&bare).unwrap().bare);
    assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 3);
}
