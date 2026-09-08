fn account(id: &str) -> termloop_agents::AgentAccountContext {
    termloop_agents::AgentAccountContext {
        agent_id: "claude".into(),
        account_id: id.into(),
        name: id.into(),
        config_directory: None,
    }
}
use super::*;

fn fixture() -> (AgentConnections, mpsc::Receiver<Vec<u8>>) {
    let manager = AgentConnections::new(PathBuf::new());
    let (input, receiver) = mpsc::sync_channel(8);
    manager.jobs.lock().unwrap().insert(
        (Provider::Claude, "default".into()),
        Job {
            owner: owner("first-device"),
            input,
            control: SetupControl::default(),
            operation: Arc::new(Mutex::new(Operation {
                agent_id: Provider::Claude,
                account_id: "default".into(),
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
fn account_auth_changes_do_not_repeat_discovery_but_cli_installation_changes_do() {
    let capability = crate::DiscoveredAgentCapabilities {
        agent_id: "claude".into(),
        label: "Claude".into(),
        available: true,
        version: Some("1.0".into()),
        integration_level: "".into(),
        degraded_reason: None,
        models: vec![],
        permissions: vec![],
        reasoning: vec![],
        observation_supported: false,
        quick_action_supported: false,
        tracked_helpers_supported: false,
        observation: crate::ObservationCapability::None,
        fresh_session_id_supported: false,
        resume_supported: false,
        native_fork_supported: false,
        mcp_http_supported: false,
    };
    let mut status = Status {
        agent_id: Provider::Claude,
        account_id: "work".into(),
        label: "Claude",
        installed: true,
        version: Some("1.0".into()),
        auth_state: "signedOut",
        install_supported: true,
        busy: false,
        operation: None,
    };
    let capabilities = [capability];
    assert!(!status.installation_changed(&capabilities));
    status.auth_state = "signedIn";
    status.account_id = "personal".into();
    assert!(!status.installation_changed(&capabilities));
    status.version = None; // A timed-out version probe does not imply an update.
    assert!(!status.installation_changed(&capabilities));
    status.version = Some("2.0".into());
    assert!(status.installation_changed(&capabilities));
    status.installed = false;
    assert!(status.installation_changed(&capabilities));
    assert!(status.installation_changed(&[]));
}

#[test]
fn another_device_cannot_read_cancel_submit_or_replace_login() {
    let (manager, _) = fixture();
    assert!(
        manager
            .operation(Provider::Claude, "default", "attempt", "second-device")
            .is_err()
    );
    assert!(
        manager
            .cancel(Provider::Claude, "default", "attempt", "second-device")
            .is_err()
    );
    assert!(
        manager
            .submit_code(
                Provider::Claude,
                "default",
                "attempt",
                "second-device",
                "code"
            )
            .is_err()
    );
    assert!(
        manager
            .start(account("default"), Action::SignIn, "second-device")
            .is_err()
    );
    assert!(
        manager
            .start(account("default"), Action::SignOut, "first-device")
            .is_err()
    );
    assert_eq!(
        manager
            .start(account("default"), Action::SignIn, "first-device")
            .unwrap()
            .operation_id,
        "attempt"
    );
}

#[test]
fn cancellation_hides_challenge_and_reserves_until_process_cleanup() {
    let (manager, _) = fixture();
    let operation = manager
        .cancel(Provider::Claude, "default", "attempt", "first-device")
        .unwrap();
    assert!(operation.active());
    assert!(operation.verification_url.is_none());
    assert!(operation.user_code.is_none());
    assert!(!operation.accepts_code);
    assert!(
        manager
            .start(account("default"), Action::Install, "first-device")
            .is_err()
    );
    assert!(
        manager
            .submit_code(
                Provider::Claude,
                "default",
                "attempt",
                "first-device",
                "code"
            )
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
        let job = jobs.get(&(Provider::Claude, "default".into())).unwrap();
        *job.control.unreaped.lock().unwrap() = Some(process);
        job.operation
            .lock()
            .unwrap()
            .finish(Phase::Failed, "Cleanup failed");
    }
    for device in ["first-device", "second-device"] {
        for action in [Action::SignIn, Action::SignOut, Action::Install] {
            assert!(manager.start(account("default"), action, device).is_err());
        }
    }
    assert_eq!(
        manager
            .operation(Provider::Claude, "default", "attempt", "first-device")
            .unwrap()
            .phase,
        Phase::Failed,
    );
    let jobs = manager.jobs.lock().unwrap();
    assert_eq!(jobs.len(), 1);
    jobs.get(&(Provider::Claude, "default".into()))
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
                .submit_code(
                    Provider::Claude,
                    "default",
                    "attempt",
                    "first-device",
                    invalid
                )
                .is_err()
        );
    }
    let operation = manager
        .submit_code(
            Provider::Claude,
            "default",
            "attempt",
            "first-device",
            "code#state",
        )
        .unwrap();
    assert_eq!(receiver.try_recv().unwrap(), b"code#state\n");
    assert!(
        !serde_json::to_string(&operation)
            .unwrap()
            .contains("code#state")
    );
    assert!(
        manager
            .submit_code(
                Provider::Claude,
                "default",
                "attempt",
                "first-device",
                "again"
            )
            .is_err()
    );
}

#[test]
fn stale_attempt_and_wrong_provider_are_denied() {
    let (manager, _) = fixture();
    assert!(
        manager
            .operation(Provider::Claude, "default", "old-attempt", "first-device")
            .is_err()
    );
    assert!(
        manager
            .operation(Provider::Codex, "default", "attempt", "first-device")
            .is_err()
    );
    assert!(Provider::parse("shell").is_err());
    let mut operation = manager
        .operation(Provider::Claude, "default", "attempt", "first-device")
        .unwrap();
    operation.finish(Phase::Succeeded, "Done");
    assert!(!operation.active());
    assert!(operation.verification_url.is_none());
    assert!(operation.user_code.is_none());
}

#[test]
fn a_setup_identity_cannot_be_reused_for_another_account_and_install_is_provider_wide() {
    let (manager, _) = fixture();
    assert!(
        manager
            .operation(Provider::Claude, "other-account", "attempt", "first-device")
            .is_err()
    );
    assert!(
        manager
            .cancel(Provider::Claude, "other-account", "attempt", "first-device")
            .is_err()
    );
    assert!(
        manager
            .submit_code(
                Provider::Claude,
                "other-account",
                "attempt",
                "first-device",
                "code"
            )
            .is_err()
    );
    assert!(
        manager
            .start(account("other-account"), Action::Install, "first-device")
            .is_err()
    );
    let (input, receiver) = mpsc::sync_channel(8);
    let mut second = manager
        .operation(Provider::Claude, "default", "attempt", "first-device")
        .unwrap();
    second.account_id = "other-account".into();
    second.operation_id = "second-attempt".into();
    manager.jobs.lock().unwrap().insert(
        (Provider::Claude, "other-account".into()),
        Job {
            owner: owner("first-device"),
            operation: Arc::new(Mutex::new(second)),
            control: SetupControl::default(),
            input,
        },
    );
    manager
        .submit_code(
            Provider::Claude,
            "other-account",
            "second-attempt",
            "first-device",
            "second-code",
        )
        .unwrap();
    assert_eq!(receiver.try_recv().unwrap(), b"second-code\n");
    assert!(
        manager
            .operation(Provider::Claude, "default", "attempt", "first-device")
            .unwrap()
            .accepts_code
    );
}
