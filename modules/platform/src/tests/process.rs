use super::*;

#[test]
fn command_fixture_entrypoint() {
    let Ok(mode) = std::env::var(COMMAND_FIXTURE_MODE) else {
        return;
    };
    match mode.as_str() {
        "success" => {
            print!("fixture-stdout");
            eprint!("fixture-stderr");
        }
        "environment" => {
            print!(
                "{}:{}",
                std::env::var("TERMLOOP_PLATFORM_OVERRIDE").unwrap_or_default(),
                std::env::var("TERMLOOP_PLATFORM_REMOVED").unwrap_or_else(|_| "absent".into())
            );
        }
        "cwd" => print!("{}", std::env::current_dir().unwrap().display()),
        "nonzero" => std::process::exit(7),
        "timeout" => {
            print!("started");
            io::Write::flush(&mut io::stdout()).unwrap();
            std::thread::sleep(Duration::from_secs(30));
        }
        "timeout-tree" => {
            let pid_file = std::env::var_os("TERMLOOP_PLATFORM_DESCENDANT_PID")
                .map(PathBuf::from)
                .unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::process::command_fixture_entrypoint",
                    "--nocapture",
                ])
                .env(COMMAND_FIXTURE_MODE, "descendant")
                .spawn()
                .unwrap();
            std_fs::write(pid_file, child.id().to_string()).unwrap();
            child.wait().unwrap();
        }
        "orphan-pipes" => spawn_pipe_holding_descendant(),
        "descendant" => std::thread::sleep(Duration::from_secs(30)),
        "large" => {
            print!("{}", "x".repeat(16 * 1024));
            eprint!("{}", "y".repeat(16 * 1024));
        }
        "stdin-echo" => {
            let mut value = Vec::new();
            io::stdin().read_to_end(&mut value).unwrap();
            print!("{}", value.len());
        }
        "stdin-block" => std::thread::sleep(Duration::from_secs(30)),
        unexpected => panic!("unexpected command fixture mode: {unexpected}"),
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_pipe_holding_descendant() {
    let pid_file = std::env::var_os("TERMLOOP_PLATFORM_DESCENDANT_PID")
        .map(PathBuf::from)
        .unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::process::command_fixture_entrypoint",
            "--nocapture",
        ])
        .env(COMMAND_FIXTURE_MODE, "descendant")
        .spawn()
        .unwrap();
    std_fs::write(pid_file, child.id().to_string()).unwrap();
    std::mem::forget(child);
}

#[test]
fn bounded_command_runner_captures_raw_output_and_exit_metadata() {
    let outcome = run_command(fixture_request("success")).unwrap();
    assert!(outcome.success());
    assert!(
        outcome
            .stdout
            .windows(b"fixture-stdout".len())
            .any(|value| value == b"fixture-stdout")
    );
    assert!(
        outcome
            .stderr
            .windows(b"fixture-stderr".len())
            .any(|value| value == b"fixture-stderr")
    );
    assert!(!outcome.stdout_truncated);
    assert!(!outcome.stderr_truncated);

    let nonzero = run_command(fixture_request("nonzero")).unwrap();
    assert_eq!(nonzero.termination, CommandTermination::Exited { code: 7 });
}

#[test]
fn command_runner_applies_environment_delta_and_cwd() {
    let outcome = run_command(
        fixture_request("environment")
            .environment("TERMLOOP_PLATFORM_OVERRIDE", "replacement")
            .environment("TERMLOOP_PLATFORM_REMOVED", "must-not-survive")
            .remove_environment("TERMLOOP_PLATFORM_REMOVED"),
    )
    .unwrap();
    let stdout = String::from_utf8_lossy(&outcome.stdout);
    assert!(stdout.contains("replacement:absent"), "{stdout}");

    let cwd = std::env::current_dir().unwrap();
    let outcome = run_command(fixture_request("cwd").cwd(&cwd)).unwrap();
    let stdout = String::from_utf8_lossy(&outcome.stdout);
    assert!(stdout.contains(cwd.to_string_lossy().as_ref()), "{stdout}");
}

#[test]
fn command_runner_bounds_output_without_deadlocking() {
    let outcome = run_command(fixture_request("large").output_limit(512)).unwrap();
    assert!(outcome.success());
    assert_eq!(outcome.stdout.len(), 512);
    assert_eq!(outcome.stderr.len(), 512);
    assert!(outcome.stdout_truncated);
    assert!(outcome.stderr_truncated);
}

#[test]
fn command_runner_writes_bounded_stdin_without_deadlocking() {
    let input = vec![b'x'; 96 * 1024];
    let outcome = run_command(fixture_request("stdin-echo").stdin(input)).unwrap();
    assert!(outcome.success());
    assert!(String::from_utf8_lossy(&outcome.stdout).contains("98304"));

    let outcome = run_command(
        fixture_request("stdin-block")
            .stdin(vec![b'x'; 96 * 1024])
            .timeout(Duration::from_millis(100)),
    )
    .unwrap();
    assert_eq!(outcome.termination, CommandTermination::TimedOut);
    assert!(run_command(fixture_request("stdin-echo").stdin(vec![0; 128 * 1024 + 1])).is_err());
}

#[test]
fn command_runner_times_out_and_reaps_the_child() {
    let started = Instant::now();
    let outcome = run_command(
        fixture_request("timeout")
            .timeout(Duration::from_millis(100))
            .output_limit(1024),
    )
    .unwrap();
    assert_eq!(outcome.termination, CommandTermination::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn command_timeout_terminates_descendants() {
    let pid_file = std::env::temp_dir().join(format!(
        "termloop-command-descendant-{}-{}.pid",
        std::process::id(),
        current_epoch_ms()
    ));
    let outcome = run_command(
        fixture_request("timeout-tree")
            .environment("TERMLOOP_PLATFORM_DESCENDANT_PID", pid_file.as_os_str())
            .timeout(Duration::from_millis(500)),
    )
    .unwrap();
    assert_eq!(outcome.termination, CommandTermination::TimedOut);
    let descendant_id = std_fs::read_to_string(&pid_file)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_identity(descendant_id).unwrap().is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(process_identity(descendant_id).unwrap(), None);
    let _ = std_fs::remove_file(pid_file);
}

#[test]
fn output_drain_timeout_survives_an_exited_parent_with_open_descendant_pipes() {
    let pid_file = std::env::temp_dir().join(format!(
        "termloop-command-orphan-{}-{}.pid",
        std::process::id(),
        current_epoch_ms()
    ));
    let started = Instant::now();
    let outcome = run_command(
        fixture_request("orphan-pipes")
            .environment("TERMLOOP_PLATFORM_DESCENDANT_PID", pid_file.as_os_str())
            .timeout(Duration::from_millis(500)),
    )
    .unwrap();
    assert_eq!(outcome.termination, CommandTermination::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));
    let descendant_id = std_fs::read_to_string(&pid_file)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_identity(descendant_id).unwrap().is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(process_identity(descendant_id).unwrap(), None);
    let _ = std_fs::remove_file(pid_file);
}

#[test]
fn command_debug_output_redacts_authority_bearing_values() {
    let request = CommandRequest::new("secret-program")
        .args(["secret-argument"])
        .cwd("secret-cwd")
        .environment("secret-key", "secret-value");
    let debug = format!("{request:?}");
    for secret in [
        "secret-program",
        "secret-argument",
        "secret-cwd",
        "secret-key",
        "secret-value",
    ] {
        assert!(!debug.contains(secret), "debug leaked {secret}: {debug}");
    }

    let outcome = CommandOutcome {
        termination: CommandTermination::Exited { code: 0 },
        stdout: b"secret-stdout".to_vec(),
        stderr: b"secret-stderr".to_vec(),
        stdout_truncated: false,
        stderr_truncated: false,
    };
    let debug = format!("{outcome:?}");
    assert!(!debug.contains("secret-stdout"));
    assert!(!debug.contains("secret-stderr"));
}

#[test]
fn process_path_bytes_round_trip_when_supported_by_the_host() {
    let bytes = vec![b'p', b'a', b't', b'h', 0xff];
    if let Ok(path) = path_from_process_bytes(bytes.clone()) {
        assert_eq!(process_bytes_from_os_str(path.as_os_str()).unwrap(), bytes);
    }
    assert!(path_from_process_bytes(vec![b'a', 0, b'b']).is_err());
}

#[cfg(unix)]
#[test]
fn resolved_executable_revalidation_hashes_same_identity_content() {
    use std::io::{Read as _, Seek as _, Write as _};
    use std::os::unix::fs::PermissionsExt;

    let directory = std::env::temp_dir().join(format!(
        "termloop-executable-identity-{}",
        std::process::id()
    ));
    std_fs::create_dir_all(&directory).unwrap();
    let path = directory.join("fixture");
    std_fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
    std_fs::set_permissions(&path, std_fs::Permissions::from_mode(0o700)).unwrap();
    let original_modified = std_fs::metadata(&path).unwrap().modified().unwrap();
    let executable = crate::process::resolved_executable_from_path(&path).unwrap();

    let mut file = std_fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    file.seek(std::io::SeekFrom::Start(4096)).unwrap();
    let mut byte = [0_u8; 1];
    file.read_exact(&mut byte).unwrap();
    byte[0] ^= 1;
    file.seek(std::io::SeekFrom::Start(4096)).unwrap();
    file.write_all(&byte).unwrap();
    file.sync_all().unwrap();
    std_fs::File::open(&path)
        .unwrap()
        .set_times(std_fs::FileTimes::new().set_modified(original_modified))
        .unwrap();
    assert!(executable.revalidate().is_err());
    let _ = std_fs::remove_dir_all(directory);
}

#[cfg(unix)]
#[test]
fn restricted_executable_identity_rejects_script_wrappers() {
    use std::os::unix::fs::PermissionsExt;

    let path = std::env::temp_dir().join(format!("termloop-script-wrapper-{}", std::process::id()));
    std_fs::write(&path, b"#!/usr/bin/env node\n").unwrap();
    std_fs::set_permissions(&path, std_fs::Permissions::from_mode(0o700)).unwrap();
    assert!(crate::process::resolved_executable_from_path(&path).is_err());
    let _ = std_fs::remove_file(path);
}
