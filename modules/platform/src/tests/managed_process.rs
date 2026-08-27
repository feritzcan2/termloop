use super::*;

#[test]
fn daemon_lease_refuses_a_second_live_owner_and_releases_cleanly() {
    let root = std::env::temp_dir().join(format!(
        "termloop-daemon-lease-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let lease = acquire_daemon_instance_lease(&root).unwrap();
    assert!(acquire_daemon_instance_lease(&root).is_err());
    drop(lease);
    assert!(acquire_daemon_instance_lease(&root).is_ok());
    let _ = std_fs::remove_dir_all(root);
}

#[test]
fn tracked_process_records_are_create_new_and_corruption_is_fail_closed() {
    let root = std::env::temp_dir().join(format!(
        "termloop-process-record-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let record = register_existing_tracked_process(&root, "session", std::process::id()).unwrap();
    assert!(register_existing_tracked_process(&root, "session", std::process::id()).is_err());
    drop(record);
    std_fs::create_dir_all(&root).unwrap();
    std_fs::write(root.join("corrupt.process"), b"truncated").unwrap();
    let report = reap_tracked_managed_processes(&root).unwrap();
    assert_eq!(report.failures, 1);
    assert_eq!(report.uncertain_record_ids, vec!["corrupt"]);
    assert_eq!(report.terminated, 0);
    assert!(root.join("corrupt.process").exists());
    let targeted = recover_tracked_managed_process(&root, "corrupt").unwrap();
    assert_eq!(targeted.failures, 1);
    assert_eq!(targeted.uncertain_record_ids, vec!["corrupt"]);
    assert!(root.join("corrupt.process").exists());
    let _ = std_fs::remove_dir_all(root);
}

fn selected_environment_report() -> String {
    let tool_resolves = Command::new("rustc")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success());
    format!(
        "CLAUDE_MARKER={}\nSECRET_NONCE={}\nPATH_PRESENT={}\nHOME_PRESENT={}\nTERM={}\nCOLORTERM={}\nLINES_PRESENT={}\nCOLUMNS_PRESENT={}\nTOOL_RESOLVES={}\n",
        std::env::var_os("CLAUDE_CODE_CHILD_SESSION").is_some(),
        std::env::var_os("TERMLOOP_TEST_SECRET_NONCE").is_some(),
        std::env::var_os("PATH").is_some(),
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .is_some(),
        std::env::var("TERM").unwrap_or_default(),
        std::env::var("COLORTERM").unwrap_or_default(),
        std::env::var_os("LINES").is_some(),
        std::env::var_os("COLUMNS").is_some(),
        tool_resolves,
    )
}

fn assert_reconstructed_environment(report: &str) {
    assert!(report.contains("CLAUDE_MARKER=false"));
    assert!(report.contains("SECRET_NONCE=false"));
    assert!(report.contains("PATH_PRESENT=true"));
    assert!(report.contains("HOME_PRESENT=true"));
    assert!(report.contains("TERM=xterm-256color"));
    assert!(report.contains("COLORTERM=truecolor"));
    assert!(report.contains("LINES_PRESENT=false"));
    assert!(report.contains("COLUMNS_PRESENT=false"));
    assert!(report.contains("TOOL_RESOLVES=true"));
}

#[test]
fn managed_process_environment_fixture() {
    let Some(path) = std::env::var_os("TERMLOOP_TEST_OUTPUT_FILE") else {
        return;
    };
    std_fs::write(path, selected_environment_report()).unwrap();
}

#[test]
fn managed_and_probe_environments_are_reconstructed() {
    if std::env::var_os("TERMLOOP_TEST_ENV_REEXEC").is_none() {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::managed_process::managed_and_probe_environments_are_reconstructed",
                "--nocapture",
            ])
            .env("TERMLOOP_TEST_ENV_REEXEC", "1")
            .env("CLAUDE_CODE_CHILD_SESSION", "poisoned-parent")
            .env("TERMLOOP_TEST_SECRET_NONCE", "must-not-cross")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }

    let executable = std::env::current_exe().unwrap();
    let executable = executable.to_str().unwrap();
    let probe = probe_command(
        executable,
        &[
            "--exact",
            "tests::managed_process::selected_environment_probe_fixture",
            "--nocapture",
        ],
    )
    .unwrap();
    assert!(probe.success, "probe failed: {}", probe.stderr);
    assert_reconstructed_environment(&probe.stdout);

    let output_path = std::env::temp_dir().join(format!(
        "termloop-managed-env-{}-{}.txt",
        std::process::id(),
        current_epoch_ms()
    ));
    let environment = LaunchEnvironment::os_baseline()
        .with_explicit("TERMLOOP_TEST_OUTPUT_FILE", output_path.as_os_str());
    let mut process = spawn_managed_process_inner(
        executable,
        &[
            "--exact".into(),
            "tests::managed_process::managed_process_environment_fixture".into(),
            "--nocapture".into(),
        ],
        &std::env::current_dir().unwrap(),
        None,
        &environment,
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while process.try_wait().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "managed fixture timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let report = std_fs::read_to_string(&output_path).unwrap();
    assert_reconstructed_environment(&report);
    let _ = std_fs::remove_file(output_path);
}

#[test]
fn selected_environment_probe_fixture() {
    std::thread::sleep(std::time::Duration::from_millis(25));
    print!("{}", selected_environment_report());
}

#[cfg(unix)]
#[test]
#[allow(unsafe_code)]
fn unix_process_group_termination_reaches_descendants() {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let pid_file = std::env::temp_dir().join(format!(
        "termloop-process-tree-{}-{}.pid",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let script = format!("sleep 30 & echo $! > '{}' ; wait", pid_file.display());
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", &script])
        .process_group(0)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut parent = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let child_id = loop {
        if let Ok(value) = std_fs::read_to_string(&pid_file)
            && let Ok(pid) = value.trim().parse::<i32>()
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "child pid was not published");
        std::thread::sleep(Duration::from_millis(10));
    };

    signal_process_tree(parent.id(), ProcessTreeSignal::Terminate).unwrap();
    parent.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let alive = unsafe { libc::kill(child_id, 0) } == 0;
        if !alive || Instant::now() >= deadline {
            assert!(!alive, "descendant survived process-group termination");
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = std_fs::remove_file(pid_file);
}

#[cfg(unix)]
#[test]
fn tracked_processes_are_reaped_after_owner_disappears() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-managed-processes-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::managed_process::tracked_process_owner_fixture",
            "--nocapture",
        ])
        .env("TERMLOOP_TEST_PROCESS_DIRECTORY", &directory)
        .status()
        .unwrap();
    assert!(status.success(), "tracked process owner fixture failed");
    let process_id = std_fs::read_to_string(directory.join("session-test.process"))
        .unwrap()
        .lines()
        .nth(1)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert!(directory.join("session-test.process").exists());

    // The fixture owner has exited without Drop, matching a daemon SIGKILL;
    // only the private ownership record remains for the next daemon epoch.
    let report = reap_tracked_managed_processes(&directory).unwrap();
    assert_eq!(report.terminated, 1);
    assert_eq!(report.failures, 0);
    assert_eq!(process_identity(process_id).unwrap(), None);
    assert!(!directory.join("session-test.process").exists());
    let _ = std_fs::remove_dir_all(directory);
}

#[cfg(unix)]
#[test]
fn tracked_process_owner_fixture() {
    use std::path::Path;

    let Some(directory) = std::env::var_os("TERMLOOP_TEST_PROCESS_DIRECTORY") else {
        return;
    };
    let process = spawn_tracked_managed_process(
        "/bin/sh",
        &["-c".to_owned(), "sleep 30".to_owned()],
        Path::new("/tmp"),
        Path::new(&directory),
        "session-test",
    )
    .unwrap();
    std::mem::forget(process);
}

#[cfg(unix)]
#[test]
fn tracked_recovery_waits_for_the_entire_process_group() {
    use std::time::{Duration, Instant};

    let nonce = format!("{}-{}", std::process::id(), current_epoch_ms());
    let directory = std::env::temp_dir().join(format!("termloop-tree-recovery-{nonce}"));
    let child_pid_path = std::env::temp_dir().join(format!("termloop-tree-child-{nonce}.pid"));
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::managed_process::tracked_process_group_owner_fixture",
            "--nocapture",
        ])
        .env("TERMLOOP_TEST_TREE_DIRECTORY", &directory)
        .env("TERMLOOP_TEST_TREE_CHILD_PID_PATH", &child_pid_path)
        .status()
        .unwrap();
    assert!(status.success(), "process group owner fixture failed");
    let group_id = std_fs::read_to_string(directory.join("session-tree.process"))
        .unwrap()
        .lines()
        .nth(1)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let child_id = {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(value) = std_fs::read_to_string(&child_pid_path)
                && let Ok(process_id) = value.trim().parse::<u32>()
            {
                break process_id;
            }
            assert!(Instant::now() < deadline, "child pid was not published");
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    assert_eq!(
        process_identity(group_id).unwrap(),
        None,
        "fixture group leader must exit before startup recovery"
    );
    assert!(
        process_tree_is_running(group_id).unwrap(),
        "fixture descendant must keep the recorded process group alive"
    );

    // Simulate daemon death after the group leader has exited while a provider
    // descendant ignores graceful termination. Recovery must retain ownership
    // until the whole group is killed.
    let report = reap_tracked_managed_processes(&directory).unwrap();
    assert_eq!(report.terminated, 1);
    assert_eq!(report.failures, 0);
    assert_eq!(process_identity(child_id).unwrap(), None);
    assert!(!directory.join("session-tree.process").exists());

    let _ = std_fs::remove_file(child_pid_path);
    let _ = std_fs::remove_dir_all(directory);
}

#[cfg(unix)]
#[test]
fn tracked_process_group_owner_fixture() {
    use std::path::Path;

    let (Some(directory), Some(child_pid_path)) = (
        std::env::var_os("TERMLOOP_TEST_TREE_DIRECTORY"),
        std::env::var_os("TERMLOOP_TEST_TREE_CHILD_PID_PATH"),
    ) else {
        return;
    };
    let child_pid_path = std::path::PathBuf::from(child_pid_path);
    let leader_release_path = child_pid_path.with_extension("release");
    let script = format!(
        "/bin/sh -c 'trap \"\" HUP TERM; echo $$ > \"{}\"; while :; do sleep 1; done' & while [ ! -e \"{}\" ]; do sleep 0.01; done",
        child_pid_path.display(),
        leader_release_path.display()
    );
    let mut process = spawn_tracked_managed_process(
        "/bin/sh",
        &["-c".to_owned(), script],
        Path::new("/tmp"),
        Path::new(&directory),
        "session-tree",
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !child_pid_path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixture child pid was not published"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    std_fs::write(&leader_release_path, b"release").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while process.try_wait().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "fixture group leader did not exit"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let _ = std_fs::remove_file(leader_release_path);
    std::mem::forget(process);
}

#[test]
fn stale_identity_record_is_removed_without_signaling_the_reused_pid() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-stale-processes-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let path = directory.join("stale.process");
    write_private_file(
        &path,
        format!("v1\n{}\ndefinitely-not-this-process\n", std::process::id()).as_bytes(),
    )
    .unwrap();

    let report = reap_tracked_managed_processes(&directory).unwrap();
    assert_eq!(report.stale_records, 1);
    assert_eq!(report.terminated, 0);
    assert_eq!(report.failures, 0);
    assert!(!path.exists());
    let _ = std_fs::remove_dir_all(directory);
}

#[test]
fn corrupt_tracked_record_is_reported_without_blocking_registry_scan() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-corrupt-processes-{}-{}",
        std::process::id(),
        current_epoch_ms()
    ));
    std_fs::create_dir_all(&directory).unwrap();
    std_fs::write(directory.join("corrupt.process"), b"truncated\nsecret").unwrap();
    std_fs::write(directory.join("ignored.txt"), b"not a process record").unwrap();

    let report = reap_tracked_managed_processes(&directory).unwrap();
    assert_eq!(report.stale_records, 0);
    assert_eq!(report.terminated, 0);
    assert_eq!(report.failures, 1);
    assert_eq!(report.uncertain_record_ids, vec!["corrupt"]);
    assert!(directory.join("corrupt.process").exists());
    let _ = std_fs::remove_dir_all(directory);
}

#[test]
fn failed_post_create_record_write_removes_only_its_owned_partial_file() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-partial-process-record-{}-{}",
        std::process::id(),
        current_epoch_ms()
    ));
    let path = directory.join("partial.process");
    let result = create_tracked_process_record_with(
        &path,
        std::process::id(),
        "fixture-identity",
        |file, record| {
            io::Write::write_all(file, &record[..record.len().min(4)])?;
            Err(io::Error::other("injected post-create write failure"))
        },
    );
    assert!(matches!(result, Err(PlatformError::Io(_))));
    assert!(!path.exists());

    std_fs::create_dir_all(&directory).unwrap();
    std_fs::write(&path, b"pre-existing").unwrap();
    let result = create_tracked_process_record_with(
        &path,
        std::process::id(),
        "fixture-identity",
        |_, _| panic!("create_new must fail before writing"),
    );
    assert!(matches!(
        result,
        Err(PlatformError::Io(error)) if error.kind() == io::ErrorKind::AlreadyExists
    ));
    assert_eq!(std_fs::read(&path).unwrap(), b"pre-existing");
    let _ = std_fs::remove_dir_all(directory);
}

#[test]
fn bounded_tracked_command_removes_ownership_record() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-bounded-processes-{}-{}",
        std::process::id(),
        current_epoch_ms()
    ));
    let outcome =
        run_command(fixture_request("success").tracked(&directory, "provider-1")).unwrap();
    assert!(outcome.success());
    assert!(!directory.join("provider-1.process").exists());
    let _ = std_fs::remove_dir_all(directory);
}

#[cfg(windows)]
const WINDOWS_JOB_FIXTURE_MODE: &str = "TERMLOOP_WINDOWS_JOB_DESCENDANT_FIXTURE";
#[cfg(windows)]
const WINDOWS_JOB_GO_PATH: &str = "TERMLOOP_WINDOWS_JOB_GO_PATH";
#[cfg(windows)]
const WINDOWS_JOB_PID_PATH: &str = "TERMLOOP_WINDOWS_JOB_PID_PATH";

#[cfg(windows)]
#[test]
fn windows_job_descendant_fixture() {
    if std::env::var_os(WINDOWS_JOB_FIXTURE_MODE).is_none() {
        return;
    }
    let go_file = PathBuf::from(std::env::var_os(WINDOWS_JOB_GO_PATH).unwrap());
    let pid_file = PathBuf::from(std::env::var_os(WINDOWS_JOB_PID_PATH).unwrap());
    while !go_file.exists() {
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut child = Command::new("ping.exe")
        .args(["-t", "127.0.0.1"])
        .spawn()
        .unwrap();
    std_fs::write(pid_file, child.id().to_string()).unwrap();
    child.wait().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_job_contained_kill_reaches_descendants_spawned_after_attachment() {
    let unique = format!("{}-{}", std::process::id(), current_epoch_ms());
    let go_file = std::env::temp_dir().join(format!("termloop-job-go-{unique}.ready"));
    let pid_file = std::env::temp_dir().join(format!("termloop-job-pid-{unique}.pid"));
    // The grandchild is gated on the go file, which is created only after
    // spawn_managed_process returned; job assignment happens inside spawn, so
    // the descendant is provably spawned after containment.
    let executable = std::env::current_exe().unwrap();
    let environment = LaunchEnvironment::os_baseline()
        .with_explicit(WINDOWS_JOB_FIXTURE_MODE, "1")
        .with_explicit(WINDOWS_JOB_GO_PATH, go_file.as_os_str())
        .with_explicit(WINDOWS_JOB_PID_PATH, pid_file.as_os_str());
    let mut process = spawn_managed_process_inner(
        executable.to_str().unwrap(),
        &[
            "--exact".to_owned(),
            "tests::managed_process::windows_job_descendant_fixture".to_owned(),
            "--nocapture".to_owned(),
        ],
        &std::env::temp_dir(),
        None,
        &environment,
    )
    .unwrap();
    std_fs::write(&go_file, b"go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let child_id = loop {
        if let Ok(value) = std_fs::read_to_string(&pid_file)
            && let Ok(pid) = value.trim().parse::<u32>()
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "grandchild pid was not published"
        );
        std::thread::sleep(Duration::from_millis(20));
    };

    assert!(matches!(
        signal_process_tree(process.id(), ProcessTreeSignal::Kill),
        Ok(SignalDelivery::Delivered)
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    while process.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "job kill did not reap the parent"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let check = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            &format!("if (Get-Process -Id {child_id} -ErrorAction SilentlyContinue) {{ exit 1 }}"),
        ])
        .status()
        .unwrap();
    assert!(check.success(), "descendant survived job termination");
    let _ = std_fs::remove_file(go_file);
    let _ = std_fs::remove_file(pid_file);
}

#[cfg(windows)]
#[test]
fn windows_terminate_of_an_exited_managed_process_is_not_an_error() {
    let mut process = spawn_managed_process(
        "cmd.exe",
        &["/C".to_owned(), "exit 0".to_owned()],
        &std::env::temp_dir(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while process.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "fixture child did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(process_identity(process.id()).unwrap(), None);
    process.terminate().unwrap();
}
