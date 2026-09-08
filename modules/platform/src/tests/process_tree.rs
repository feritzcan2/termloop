use super::*;

#[test]
fn process_tree_guard_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<ProcessTreeGuard>();
}

#[cfg(unix)]
#[test]
// The unix guard is intentionally field-less; the explicit drop mirrors the
// Windows lifetime contract this test documents.
#[allow(clippy::drop_non_drop)]
fn unix_tree_guard_is_a_noop_and_drop_never_signals() {
    use std::process::Stdio;

    let mut child = Command::new("/bin/sh")
        .args(["-c", "sleep 30"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let guard = attach_process_tree_guard(child.id()).unwrap();
    drop(guard);
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        child.try_wait().unwrap().is_none(),
        "no-op guard drop signalled the child"
    );
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
#[test]
fn unix_signals_report_delivered_including_for_an_already_dead_group() {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let mut child = Command::new("/bin/sh")
        .args(["-c", "sleep 30"])
        .process_group(0)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert!(matches!(
        signal_process_tree(child.id(), ProcessTreeSignal::Terminate),
        Ok(SignalDelivery::Delivered)
    ));
    child.wait().unwrap();
    // ESRCH for the reaped group is tolerated as success.
    assert!(matches!(
        signal_process_tree(child.id(), ProcessTreeSignal::Kill),
        Ok(SignalDelivery::Delivered)
    ));
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::managed_process::process_tree_is_running;
    use std::process::Stdio;

    fn wait_until_exit(child: &mut std::process::Child, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn long_lived_child() -> std::process::Child {
        Command::new("ping.exe")
            .args(["-t", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn graceful_signals_report_unsupported_without_touching_the_target() {
        let mut child = long_lived_child();
        assert!(matches!(
            signal_process_tree(child.id(), ProcessTreeSignal::Hangup),
            Ok(SignalDelivery::GracefulUnsupported)
        ));
        assert!(matches!(
            signal_process_tree(child.id(), ProcessTreeSignal::Terminate),
            Ok(SignalDelivery::GracefulUnsupported)
        ));
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            child.try_wait().unwrap().is_none(),
            "a graceful-unsupported outcome must not signal the target"
        );
        assert!(matches!(
            signal_process_tree(child.id(), ProcessTreeSignal::Kill),
            Ok(SignalDelivery::Delivered)
        ));
        assert!(wait_until_exit(&mut child, Duration::from_secs(5)));
    }

    #[test]
    fn kill_of_an_exited_process_is_success() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        // The open Child handle keeps the PID reserved, so this exercises the
        // exited-process tolerance rather than a recycled PID.
        assert!(matches!(
            signal_process_tree(child.id(), ProcessTreeSignal::Kill),
            Ok(SignalDelivery::Delivered)
        ));
    }

    #[test]
    fn attach_to_an_exited_process_yields_an_inert_guard() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        let _guard = attach_process_tree_guard(child.id()).unwrap();
    }

    #[test]
    fn guard_drop_with_a_live_tree_is_the_fail_closed_backstop() {
        let mut child = long_lived_child();
        let guard = attach_process_tree_guard(child.id()).unwrap();
        drop(guard);
        assert!(
            wait_until_exit(&mut child, Duration::from_secs(5)),
            "KILL_ON_JOB_CLOSE did not terminate the contained child"
        );
    }

    #[test]
    fn job_leader_fixture() {
        let Some(directory) = std::env::var_os("TERMLOOP_TEST_JOB_LEADER_DIRECTORY") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !directory.join("go").exists() {
            assert!(
                Instant::now() < deadline,
                "parent did not contain the job leader"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        // The parent attached the job before allowing this descendant spawn.
        let child = long_lived_child();
        std::fs::write(directory.join("child.pid"), child.id().to_string()).unwrap();
    }

    #[test]
    fn exited_job_leader_does_not_hide_its_live_descendant() {
        let directory =
            std::env::temp_dir().join(format!("termloop-job-exit-{}", generate_opaque_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut leader = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::process_tree::windows::job_leader_fixture",
                "--nocapture",
            ])
            .env("TERMLOOP_TEST_JOB_LEADER_DIRECTORY", &directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let guard = attach_process_tree_guard(leader.id()).unwrap();
        std::fs::write(directory.join("go"), "go").unwrap();
        assert!(wait_until_exit(&mut leader, Duration::from_secs(5)));
        assert!(directory.join("child.pid").exists());
        let descendant_running = process_tree_is_running(leader.id()).unwrap();
        signal_process_tree(leader.id(), ProcessTreeSignal::Kill).unwrap();
        let tree_exited = wait_for_process_tree_exit(leader.id(), Duration::from_secs(5)).unwrap();
        drop(guard);
        std::fs::remove_dir_all(directory).unwrap();
        assert!(
            descendant_running,
            "job membership must outlive the leader's process identity"
        );
        assert!(tree_exited);
    }
}
