mod support;

use std::ffi::OsStr;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use termloop_gitio::{
    ChangeState, ContentState, GitError, GitRunner, LockState, SubmoduleState, UpstreamState,
    WorktreeHealthObservation,
};

use support::{TestDirectory, TestRepository, hermetic_git};

fn observe_without_index_change(
    runner: &GitRunner,
    repository: &TestRepository,
    cwd: &std::path::Path,
) -> WorktreeHealthObservation {
    let before = repository.index_snapshot(cwd);
    let observation = runner.inspect_worktree_health(cwd).unwrap();
    assert_eq!(before, repository.index_snapshot(cwd));
    observation
}

#[test]
fn clean_and_checkout_local_status_facts_remain_independent() {
    let repository = TestRepository::init("health-status");
    repository.create_commit("initial");
    fs::write(
        repository.root().join(".gitignore"),
        ".env\nnode_modules/\ntarget/\n",
    )
    .unwrap();
    repository.git(["add", "--", ".gitignore"]);
    repository.git(["commit", "-m", "ignore fixture outputs"]);
    let runner = GitRunner::discover().unwrap();

    let clean = observe_without_index_change(&runner, &repository, repository.root());
    assert_eq!(clean.status.tracked, ChangeState::Clean);
    assert_eq!(clean.status.staged, ChangeState::Clean);
    assert_eq!(clean.status.untracked, ContentState::Absent);
    assert_eq!(clean.status.ignored, ContentState::Absent);
    assert_eq!(clean.status.submodules.state, SubmoduleState::Absent);
    assert_eq!(clean.status.worktree_lock, LockState::Absent);
    assert_eq!(clean.status.index_lock, LockState::Absent);
    assert_eq!(clean.status.upstream, UpstreamState::NotConfigured);
    assert!(clean.registration.is_some());
    assert_eq!(clean.git_process_count, 7);

    fs::write(repository.root().join("staged.txt"), "staged\n").unwrap();
    repository.git(["add", "--", "staged.txt"]);
    fs::write(repository.root().join("tracked.txt"), "working tree\n").unwrap();
    fs::write(repository.root().join("untracked.txt"), "untracked\n").unwrap();
    fs::write(repository.root().join(".env"), "secret fixture value\n").unwrap();
    fs::create_dir_all(repository.root().join("node_modules/package")).unwrap();
    fs::write(
        repository.root().join("node_modules/package/index.js"),
        "fixture\n",
    )
    .unwrap();
    fs::create_dir_all(repository.root().join("target/debug")).unwrap();
    fs::write(repository.root().join("target/debug/output"), "fixture\n").unwrap();

    let changed = observe_without_index_change(&runner, &repository, repository.root());
    assert_eq!(changed.status.tracked, ChangeState::Changed);
    assert_eq!(changed.status.staged, ChangeState::Changed);
    assert_eq!(changed.status.untracked, ContentState::Present);
    assert_eq!(changed.status.ignored, ContentState::Present);
    assert_eq!(changed.status.submodules.state, SubmoduleState::Absent);
    assert!(changed.git_process_count <= 8);
}

#[test]
fn conflicted_merge_remains_an_observable_registered_worktree() {
    let repository = TestRepository::init("health-merge-conflict");
    repository.create_commit("base");
    repository.git(["checkout", "-b", "feature"]);
    fs::write(repository.root().join("tracked.txt"), "feature\n").unwrap();
    repository.git(["commit", "-am", "feature"]);
    repository.git(["checkout", "main"]);
    fs::write(repository.root().join("tracked.txt"), "main\n").unwrap();
    repository.git(["commit", "-am", "main"]);

    let mut merge = Command::new("git");
    merge.current_dir(repository.root());
    hermetic_git(&mut merge, repository.fixture_root());
    let merge = merge.args(["merge", "feature"]).output().unwrap();
    assert!(
        !merge.status.success(),
        "fixture merge unexpectedly succeeded"
    );

    let observation = observe_without_index_change(
        &GitRunner::discover().unwrap(),
        &repository,
        repository.root(),
    );
    assert!(observation.registration.is_some());
    assert_eq!(observation.status.tracked, ChangeState::Changed);
    assert_eq!(observation.status.staged, ChangeState::Changed);
    assert_eq!(observation.status.change_count, Some(1));
    assert_eq!(observation.status.submodules.state, SubmoduleState::Absent);
}

#[test]
fn worktree_and_index_locks_are_reported_separately() {
    let repository = TestRepository::init("health-locks");
    repository.create_commit("initial");
    let linked = repository.fixture_root().join("linked");
    repository.git([
        "worktree".as_ref(),
        "add".as_ref(),
        "-b".as_ref(),
        "locked".as_ref(),
        linked.as_os_str(),
    ]);
    repository.git([
        "worktree".as_ref(),
        "lock".as_ref(),
        "--reason".as_ref(),
        "health fixture".as_ref(),
        linked.as_os_str(),
    ]);
    let runner = GitRunner::discover().unwrap();
    let identity = runner.inspect_repository(&linked).unwrap();
    fs::write(identity.git_dir.join("index.lock"), b"").unwrap();

    let observation = observe_without_index_change(&runner, &repository, &linked);
    assert_eq!(observation.status.worktree_lock, LockState::Present);
    assert_eq!(observation.status.index_lock, LockState::Present);
    assert!(observation.git_process_count <= 8);
}

#[test]
fn initialized_submodules_are_not_folded_into_tracked_changes() {
    let child = TestRepository::init("health-submodule-child");
    child.create_commit("child");
    let repository = TestRepository::init("health-submodule-parent");
    repository.create_commit("parent");
    repository.git([
        OsStr::new("-c"),
        OsStr::new("protocol.file.allow=always"),
        OsStr::new("submodule"),
        OsStr::new("add"),
        child.root().as_os_str(),
        OsStr::new("deps/child"),
    ]);
    repository.git(["commit", "-am", "add submodule"]);
    let runner = GitRunner::discover().unwrap();

    let clean = observe_without_index_change(&runner, &repository, repository.root());
    assert_eq!(
        clean.status.submodules.state,
        SubmoduleState::InitializedClean
    );
    assert_eq!(clean.status.submodules.tracked_gitlinks, 1);
    assert_eq!(clean.status.submodules.initialized_gitlinks, 1);
    assert_eq!(clean.status.tracked, ChangeState::Clean);
    assert_eq!(clean.status.staged, ChangeState::Clean);

    fs::write(
        repository.root().join("deps/child/tracked.txt"),
        "dirty submodule\n",
    )
    .unwrap();
    let dirty = observe_without_index_change(&runner, &repository, repository.root());
    assert_eq!(
        dirty.status.submodules.state,
        SubmoduleState::InitializedDirty
    );
    assert_eq!(dirty.status.tracked, ChangeState::Clean);
    assert_eq!(dirty.status.staged, ChangeState::Clean);

    repository.git(["submodule", "deinit", "-f", "--", "deps/child"]);
    let uninitialized = observe_without_index_change(&runner, &repository, repository.root());
    assert_eq!(
        uninitialized.status.submodules.state,
        SubmoduleState::Uninitialized
    );
    assert_eq!(uninitialized.status.submodules.initialized_gitlinks, 0);
}

#[test]
fn multiple_initialized_submodules_degrade_to_unknown_without_exceeding_the_process_bound() {
    let child_a = TestRepository::init("health-multi-submodule-a");
    child_a.create_commit("child a");
    let child_b = TestRepository::init("health-multi-submodule-b");
    child_b.create_commit("child b");
    let repository = TestRepository::init("health-multi-submodule-parent");
    repository.create_commit("parent");
    for (child, path) in [(&child_a, "deps/a"), (&child_b, "deps/b")] {
        repository.git([
            OsStr::new("-c"),
            OsStr::new("protocol.file.allow=always"),
            OsStr::new("submodule"),
            OsStr::new("add"),
            child.root().as_os_str(),
            OsStr::new(path),
        ]);
    }
    repository.git(["commit", "-am", "add submodules"]);

    let observation = observe_without_index_change(
        &GitRunner::discover().unwrap(),
        &repository,
        repository.root(),
    );
    assert_eq!(observation.status.submodules.state, SubmoduleState::Unknown);
    assert_eq!(observation.status.submodules.tracked_gitlinks, 2);
    assert_eq!(observation.status.submodules.initialized_gitlinks, 2);
    assert_eq!(observation.git_process_count, 7);
}

#[test]
fn upstream_facts_cover_sync_ahead_diverged_behind_and_missing() {
    let repository = TestRepository::init("health-upstream");
    repository.create_commit("base");
    let base = oid(&repository, "HEAD");
    repository.git(["update-ref", "refs/remotes/origin/main", base.as_str()]);
    repository.git([
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ]);
    repository.git(["config", "branch.main.remote", "origin"]);
    repository.git(["config", "branch.main.merge", "refs/heads/main"]);
    let runner = GitRunner::discover().unwrap();

    assert_eq!(
        observe_without_index_change(&runner, &repository, repository.root())
            .status
            .upstream,
        UpstreamState::InSync
    );

    repository.create_commit("local");
    assert_eq!(
        observe_without_index_change(&runner, &repository, repository.root())
            .status
            .upstream,
        UpstreamState::Ahead { commits: 1 }
    );

    repository.git(["checkout", "-b", "remote-tip", base.as_str()]);
    repository.create_commit("remote");
    let remote = oid(&repository, "HEAD");
    repository.git(["update-ref", "refs/remotes/origin/main", remote.as_str()]);
    repository.git(["checkout", "main"]);
    assert_eq!(
        observe_without_index_change(&runner, &repository, repository.root())
            .status
            .upstream,
        UpstreamState::Diverged {
            ahead: 1,
            behind: 1
        }
    );

    repository.git(["reset", "--hard", base.as_str()]);
    assert_eq!(
        observe_without_index_change(&runner, &repository, repository.root())
            .status
            .upstream,
        UpstreamState::Behind { commits: 1 }
    );

    repository.git(["update-ref", "-d", "refs/remotes/origin/main"]);
    let missing = observe_without_index_change(&runner, &repository, repository.root());
    assert_eq!(missing.status.upstream, UpstreamState::Missing);
    assert!(missing.git_process_count <= 8);
}

#[test]
fn health_observation_has_typed_short_timeout_and_output_bounds() {
    let directory = TestDirectory::new("health-bounds");
    fs::create_dir_all(directory.path().join(".git")).unwrap();
    let fake_git = directory.compile_fake_git(
        r##"
        fn main() {
            let args = std::env::args().skip(1).collect::<Vec<_>>();
            if args.first().map(String::as_str) == Some("--version") {
                println!("git version 2.50.0");
                return;
            }
            let cwd = std::env::current_dir().unwrap();
            if args == ["rev-parse", "--is-bare-repository", "--absolute-git-dir"] {
                println!("false");
                println!("{}", cwd.join(".git").display());
            } else if args == ["rev-parse", "--git-common-dir"] {
                println!("{}", cwd.join(".git").display());
            } else if args == ["rev-parse", "--show-toplevel"] {
                println!("{}", cwd.display());
            } else if args.first().map(String::as_str) == Some("status")
                && args.iter().any(|arg| arg == "--untracked-files=no")
            {
                print!("# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\0");
            } else if args.starts_with(&["worktree".to_owned(), "list".to_owned()]) {
                print!("worktree {}\0HEAD 0123456789012345678901234567890123456789\0branch refs/heads/main\0\0", cwd.display());
            } else if args == ["ls-files", "--stage", "-z"] {
            } else if args.first().map(String::as_str) == Some("status") {
                match std::fs::read_to_string(cwd.join("mode")).unwrap().trim() {
                    "timeout" => std::thread::sleep(std::time::Duration::from_secs(30)),
                    "output" => println!("{}", "x".repeat(8192)),
                    mode => panic!("unexpected mode: {}", mode),
                }
            } else {
                panic!("unexpected args: {:?}", args);
            }
        }
        "##,
    );

    fs::write(directory.path().join("mode"), "timeout").unwrap();
    let timeout_runner = GitRunner::discover_program(&fake_git)
        .unwrap()
        .with_limits(Duration::from_millis(100), 1024);
    assert!(matches!(
        timeout_runner.inspect_worktree_health(directory.path()),
        Err(GitError::Timeout { .. })
    ));

    fs::write(directory.path().join("mode"), "output").unwrap();
    let bounded_runner = GitRunner::discover_program(fake_git)
        .unwrap()
        .with_limits(Duration::from_secs(1), 256);
    assert!(matches!(
        bounded_runner.inspect_worktree_health(directory.path()),
        Err(GitError::OutputLimitExceeded { .. })
    ));
}

#[test]
fn absolute_health_deadline_starts_before_git_discovery() {
    let directory = TestDirectory::new("health-discovery-deadline");
    let fake_git = directory.compile_fake_git(
        r#"
        fn main() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        "#,
    );
    let started = std::time::Instant::now();
    assert!(matches!(
        GitRunner::discover_program_with_timeout(&fake_git, Duration::from_millis(150)),
        Err(GitError::Timeout { .. })
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn health_observation_preserves_quote_newline_unicode_and_supported_raw_paths() {
    let runner = GitRunner::discover().unwrap();
    let component = termloop_platform::test_support::host_path_component(
        "repo 'quote' line ünicode",
        "repo 'quote' \" line\nünicode",
    );
    let repository = TestRepository::init_with_component("health-paths", OsStr::new(component));
    repository.create_commit("path fixture");
    let observation = observe_without_index_change(&runner, &repository, repository.root());
    let canonical =
        termloop_platform::canonical_existing_directory_path(repository.root()).unwrap();
    assert_eq!(
        observation.repository.worktree_root.as_deref(),
        Some(canonical.as_path())
    );

    if let Ok(component) = termloop_platform::os_string_from_process_bytes(b"health-\xff".to_vec())
        && let Ok(repository) =
            TestRepository::try_init_with_component("health-non-utf", &component)
    {
        repository.create_commit("raw path fixture");
        let observation = observe_without_index_change(&runner, &repository, repository.root());
        assert_eq!(observation.status.tracked, ChangeState::Clean);
    } else {
        eprintln!("UNMEASURED: this host cannot create the non-UTF health path fixture");
    }
}

#[test]
fn health_observation_disables_fsmonitor_and_ambient_trace_sinks() {
    const CHILD_FLAG: &str = "TERMLOOP_GITIO_SIDE_EFFECT_CHILD";
    if std::env::var_os(CHILD_FLAG).is_some() {
        let trace = PathBuf::from(std::env::var_os("TERMLOOP_GITIO_TRACE_MARKER").unwrap());
        let trace2 = PathBuf::from(std::env::var_os("TERMLOOP_GITIO_TRACE2_MARKER").unwrap());
        let repository = TestRepository::init("health-side-effects-child");
        repository.create_commit("side effects");
        let hook_marker = repository.fixture_root().join("fsmonitor-called");
        let hook_source = format!(
            "fn main() {{ std::fs::write({:?}, b\"called\").unwrap(); println!(\"token\"); }}",
            hook_marker
        );
        let hook_directory = TestDirectory::new("health-fsmonitor-hook");
        let hook = hook_directory.compile_fake_git(&hook_source);
        repository.git([
            OsStr::new("config"),
            OsStr::new("core.fsmonitor"),
            hook.as_os_str(),
        ]);
        for marker in [&trace, &trace2, &hook_marker] {
            let _ = fs::remove_file(marker);
        }

        GitRunner::discover()
            .unwrap()
            .inspect_worktree_health(repository.root())
            .unwrap();
        assert!(
            !hook_marker.exists(),
            "health observation invoked core.fsmonitor"
        );
        assert!(
            !trace.exists(),
            "health observation honored ambient GIT_TRACE"
        );
        assert!(
            !trace2.exists(),
            "health observation honored ambient GIT_TRACE2_EVENT"
        );
        return;
    }

    let directory = TestDirectory::new("health-side-effects-parent");
    let trace = directory.path().join("ambient-trace");
    let trace2 = directory.path().join("ambient-trace2");
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "health_observation_disables_fsmonitor_and_ambient_trace_sinks",
            "--nocapture",
        ])
        .env(CHILD_FLAG, "1")
        .env("TERMLOOP_GITIO_TRACE_MARKER", &trace)
        .env("TERMLOOP_GITIO_TRACE2_MARKER", &trace2)
        .env("GIT_TRACE", &trace)
        .env("GIT_TRACE2_EVENT", &trace2)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "side-effect child failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn complete_health_process_bound_counts_descendant_git_invocations() {
    const CHILD_FLAG: &str = "TERMLOOP_GITIO_PROCESS_COUNT_CHILD";
    if std::env::var_os(CHILD_FLAG).is_some() {
        let trace2 = PathBuf::from(std::env::var_os("TERMLOOP_GITIO_PROCESS_TRACE2").unwrap());
        let child = TestRepository::init("health-count-child-repository");
        child.create_commit("child");
        let repository = TestRepository::init("health-count-parent-repository");
        repository.create_commit("parent");
        repository.git([
            OsStr::new("-c"),
            OsStr::new("protocol.file.allow=always"),
            OsStr::new("submodule"),
            OsStr::new("add"),
            child.root().as_os_str(),
            OsStr::new("deps/child"),
        ]);
        repository.git(["commit", "-am", "add submodule"]);
        let runner = GitRunner::discover().unwrap();
        fs::write(&trace2, b"").unwrap();

        let observation = runner.inspect_worktree_health(repository.root()).unwrap();
        let actual_invocations = fs::read_to_string(&trace2)
            .unwrap()
            .lines()
            .filter(|line| line.contains(r#""event":"start""#))
            .count();
        assert_eq!(observation.git_process_count, 8);
        assert_eq!(actual_invocations, 8);
        return;
    }

    let directory = TestDirectory::new("health-descendant-process-count");
    let real_git = find_program_on_path("git").expect("Git executable must be discoverable");
    let trace2 = directory.path().join("git-trace2-events.json");
    let wrapper_source = format!(
        r#"
        fn main() {{
            let status = std::process::Command::new({real_git:?})
                .args(std::env::args_os().skip(1))
                .env("GIT_TRACE2_EVENT", {trace2:?})
                .status()
                .unwrap();
            std::process::exit(status.code().unwrap_or(1));
        }}
        "#,
        real_git = real_git,
        trace2 = trace2,
    );
    let compiled = directory.compile_fake_git(&wrapper_source);
    let bin = directory.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let wrapper = bin.join(format!("git{}", std::env::consts::EXE_SUFFIX));
    fs::copy(compiled, &wrapper).unwrap();
    let path = std::env::join_paths(
        std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "complete_health_process_bound_counts_descendant_git_invocations",
            "--nocapture",
        ])
        .env(CHILD_FLAG, "1")
        .env("TERMLOOP_GITIO_PROCESS_TRACE2", &trace2)
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "process-count child failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn find_program_on_path(program: &str) -> Option<PathBuf> {
    let names = if std::env::consts::EXE_SUFFIX.is_empty() {
        vec![program.to_owned()]
    } else {
        vec![
            format!("{program}{}", std::env::consts::EXE_SUFFIX),
            program.to_owned(),
        ]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|directory| {
        names
            .iter()
            .map(|name| directory.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn oid(repository: &TestRepository, reference: &str) -> String {
    let output = repository.git(["rev-parse", reference]);
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
