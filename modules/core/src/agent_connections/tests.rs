use super::*;

fn fixture() -> (AgentConnections, mpsc::Receiver<Vec<u8>>) {
    let manager = AgentConnections::new(PathBuf::new());
    let (input, receiver) = mpsc::sync_channel(8);
    manager.jobs.lock().unwrap().insert(
        Provider::Claude,
        Job {
            owner: owner("first-device"),
            input,
            control: SetupControl::default(),
            operation: Arc::new(Mutex::new(Operation {
                agent_id: Provider::Claude,
                operation_id: "attempt".into(),
                action: Action::SignIn,
                phase: Phase::AwaitingCode,
                verification_url: Some("private-url".into()),
                user_code: Some("private-code".into()),
                accepts_code: true,
                message: "Awaiting sign-in".into(),
                expires_at_epoch_ms: 1234,
            })),
        },
    );
    (manager, receiver)
}

#[test]
fn another_device_cannot_read_cancel_submit_or_replace_login() {
    let (manager, _) = fixture();
    assert!(
        manager
            .operation(Provider::Claude, "attempt", "second-device")
            .is_err()
    );
    assert!(
        manager
            .cancel(Provider::Claude, "attempt", "second-device")
            .is_err()
    );
    assert!(
        manager
            .submit_code(Provider::Claude, "attempt", "second-device", "code")
            .is_err()
    );
    assert!(
        manager
            .start(Provider::Claude, Action::SignIn, "second-device")
            .is_err()
    );
    assert!(
        manager
            .start(Provider::Claude, Action::SignOut, "first-device")
            .is_err()
    );
    assert_eq!(
        manager
            .start(Provider::Claude, Action::SignIn, "first-device")
            .unwrap()
            .operation_id,
        "attempt"
    );
}

#[test]
fn cancellation_hides_challenge_and_reserves_until_process_cleanup() {
    let (manager, _) = fixture();
    let operation = manager
        .cancel(Provider::Claude, "attempt", "first-device")
        .unwrap();
    assert!(operation.active());
    assert!(operation.verification_url.is_none());
    assert!(operation.user_code.is_none());
    assert!(!operation.accepts_code);
    assert!(
        manager
            .start(Provider::Claude, Action::Install, "first-device")
            .is_err()
    );
    assert!(
        manager
            .submit_code(Provider::Claude, "attempt", "first-device", "code")
            .is_err()
    );
}

#[test]
fn failed_cleanup_keeps_provider_reserved_for_every_device() {
    let (manager, _) = fixture();
    let process = termloop_platform::spawn_managed_process(
        std::env::current_exe().unwrap().to_str().unwrap(),
        &["--list".into()],
        &std::env::temp_dir(),
    )
    .unwrap();
    {
        let jobs = manager.jobs.lock().unwrap();
        let job = jobs.get(&Provider::Claude).unwrap();
        *job.control.unreaped.lock().unwrap() = Some(process);
        job.operation
            .lock()
            .unwrap()
            .finish(Phase::Failed, "Cleanup failed");
    }
    for device in ["first-device", "second-device"] {
        for action in [Action::SignIn, Action::SignOut, Action::Install] {
            assert!(manager.start(Provider::Claude, action, device).is_err());
        }
    }
    assert_eq!(
        manager
            .operation(Provider::Claude, "attempt", "first-device")
            .unwrap()
            .phase,
        Phase::Failed,
    );
    let jobs = manager.jobs.lock().unwrap();
    assert_eq!(jobs.len(), 1);
    jobs.get(&Provider::Claude)
        .unwrap()
        .control
        .unreaped
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .terminate()
        .unwrap();
}

#[test]
fn submitted_code_is_single_use_private_stdin_and_rejects_terminal_controls() {
    let (manager, receiver) = fixture();
    for invalid in ["", "one\ntwo", "\u{1b}[A", "code space"] {
        assert!(
            manager
                .submit_code(Provider::Claude, "attempt", "first-device", invalid)
                .is_err()
        );
    }
    let operation = manager
        .submit_code(Provider::Claude, "attempt", "first-device", "code#state")
        .unwrap();
    assert_eq!(receiver.try_recv().unwrap(), b"code#state\n");
    assert!(
        !serde_json::to_string(&operation)
            .unwrap()
            .contains("code#state")
    );
    assert!(
        manager
            .submit_code(Provider::Claude, "attempt", "first-device", "again")
            .is_err()
    );
}

#[test]
fn stale_attempt_and_wrong_provider_are_denied() {
    let (manager, _) = fixture();
    assert!(
        manager
            .operation(Provider::Claude, "old-attempt", "first-device")
            .is_err()
    );
    assert!(
        manager
            .operation(Provider::Codex, "attempt", "first-device")
            .is_err()
    );
    assert!(Provider::parse("shell").is_err());
    let mut operation = manager
        .operation(Provider::Claude, "attempt", "first-device")
        .unwrap();
    operation.finish(Phase::Succeeded, "Done");
    assert!(!operation.active());
    assert!(operation.verification_url.is_none());
    assert!(operation.user_code.is_none());
}
