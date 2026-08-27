use super::resume::AgentResumePreparationKind;
use super::*;
use termloop_domain::{IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, ResumeFailureReason};
use termloop_store::Store;
use termloop_terminal::TerminalService;

fn append_headless_output_and_answer_cursor_queries(
    terminal: &TerminalService,
    session_id: &str,
    runtime_epoch: u64,
    bytes: &mut Vec<u8>,
    answered_queries: &mut usize,
    chunk: Vec<u8>,
) {
    bytes.extend(chunk);
    let observed_queries = bytes
        .windows(b"\x1b[6n".len())
        .filter(|window| *window == b"\x1b[6n")
        .count();
    while *answered_queries < observed_queries {
        terminal
            .input_user(session_id, runtime_epoch, b"\x1b[1;1R")
            .expect("headless fixture must accept its cursor-position response");
        *answered_queries += 1;
    }
}

fn read_headless_fixture_input(input: &mut impl std::io::Read, expected: &[u8]) {
    if !cfg!(windows) {
        let mut observed = vec![0_u8; expected.len()];
        input
            .read_exact(&mut observed)
            .expect("headless fixture input closed before the expected sequence");
        assert_eq!(observed, expected);
        return;
    }

    let mut observed = Vec::with_capacity(expected.len());
    while observed.len() < expected.len() {
        let mut byte = [0_u8; 1];
        input
            .read_exact(&mut byte)
            .expect("headless fixture input closed before the expected sequence");
        if byte[0] != 0x1b {
            observed.push(byte[0]);
            continue;
        }

        let mut control = vec![byte[0]];
        while control.len() < 32 {
            input
                .read_exact(&mut byte)
                .expect("headless fixture input closed inside a control sequence");
            control.push(byte[0]);
            if control.len() >= 3 && (0x40..=0x7e).contains(&byte[0]) {
                break;
            }
        }
        if is_cursor_position_response(&control) {
            continue;
        }
        observed.extend(control);
    }
    assert_eq!(observed, expected);
}

fn is_cursor_position_response(bytes: &[u8]) -> bool {
    let Some(body) = bytes
        .strip_prefix(b"\x1b[")
        .and_then(|bytes| bytes.strip_suffix(b"R"))
    else {
        return false;
    };
    let mut fields = body.split(|byte| *byte == b';');
    let row = fields.next();
    let column = fields.next();
    fields.next().is_none()
        && [row, column].into_iter().all(|field| {
            field.is_some_and(|field| {
                !field.is_empty() && field.iter().all(|byte| byte.is_ascii_digit())
            })
        })
}

fn bounded_headless_fixture_output(bytes: &[u8]) -> String {
    const MAX_DIAGNOSTIC_BYTES: usize = 4 * 1024;
    let start = bytes.len().saturating_sub(MAX_DIAGNOSTIC_BYTES);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

#[test]
fn running_persistent_assistant_restart_preserves_closed_mcp_role() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-assistant-resume-role-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory(&root.display().to_string())
        .unwrap()
        .display()
        .to_string();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 7).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":cwd}))
        .unwrap();
    let project_id = project["id"].as_str().unwrap().to_owned();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(
        root.join("provider"),
    ));

    let revision = runtime.store.revision();
    runtime
        .store
        .set_steward_configuration(
            &runtime.write_authority,
            termloop_domain::StewardConfiguration {
                project_id: project_id.clone(),
                agent_id: termloop_domain::StewardAgentId::Claude,
                model: "default".into(),
                permission: "default".into(),
                reasoning: "default".into(),
                enabled: true,
                system_prompt: "Preserve this Steward project instruction on resume.".into(),
                executor_session_id: None,
                generation: 1,
                updated_at_epoch_ms: 1,
            },
            revision,
        )
        .unwrap();
    runtime
        .store
        .attach_steward_executor_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "steward-resume".into(),
                project_id: project_id.clone(),
                name: Some("Project Steward".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.assistant.activation".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
            &project_id,
            1,
            2,
        )
        .unwrap();

    let steward = match runtime
        .plan_running_agent_restart(json!({"sessionId":"steward-resume"}), 3)
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("Steward restart was not prepared"),
    };
    assert_eq!(
        steward.mcp_role,
        Some(AgentMcpRole::Steward {
            project_id: project_id.clone()
        })
    );
    assert!(steward.mcp_token.is_some());
    assert_eq!(steward.resume_lane(), AgentResumeLane::Steward);
    assert_eq!(
        steward.steward_system_prompt.as_deref(),
        Some("Preserve this Steward project instruction on resume.")
    );
    let steward_launch = steward.compose_resume_launch(None).unwrap();
    assert_eq!(
        steward_launch.provenance().template_ref,
        "builtin.assistant.activation"
    );
    assert!(
        steward_launch
            .args()
            .windows(2)
            .any(|arguments| arguments == ["--mcp-config", "/tmp/mcp.json"])
    );
    assert!(
        steward_launch
            .args()
            .iter()
            .any(|argument| argument
                .contains("Preserve this Steward project instruction on resume."))
    );
    drop(steward);
    runtime
        .store
        .mark_session_resume_failed(
            &runtime.write_authority,
            "steward-resume",
            ResumeFailureReason::StartupTimedOut,
        )
        .unwrap();
    runtime.spawn_agent_terminal_hold("steward-resume").unwrap();
    assert!(
        !runtime.agent_terminal_holds.contains("steward-resume"),
        "a failed persistent-assistant resume must not become an ordinary shell"
    );
    assert_eq!(
        runtime.store.steward_configurations()[0]
            .executor_session_id
            .as_deref(),
        Some("steward-resume")
    );
    runtime
        .store
        .mark_session_resuming(&runtime.write_authority, "steward-resume")
        .unwrap();

    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "stale-assistant".into(),
                project_id,
                name: Some("Stale Steward".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd,
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.steward.executor".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let stale = match runtime
        .plan_running_agent_restart(json!({"sessionId":"stale-assistant"}), 4)
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => {
            panic!("stale assistant restart was not prepared")
        }
    };
    assert_eq!(stale.mcp_role, None);
    assert_eq!(stale.mcp_token, None);
    assert_eq!(stale.resume_lane(), AgentResumeLane::Ordinary);
    drop(stale);

    let ordinary_project_id = runtime.store.steward_configurations()[0].project_id.clone();
    let ordinary_cwd = runtime.store.sessions()[0].process.cwd.clone();
    for index in 0..68 {
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: format!("ordinary-resume-{index:02}"),
                    project_id: ordinary_project_id.clone(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd: ordinary_cwd.clone(),
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.interactive".into()),
                        template_version: Some(1),
                    },
                    lifecycle_state: "resuming".into(),
                    runtime_epoch: 7,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Claude,
                        Uuid::new_v4().to_string(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
    }
    let startup = runtime.startup_resume_session_ids().unwrap();
    assert_eq!(startup.len(), 69);
    assert!(startup.iter().any(|candidate| {
        candidate.session_id() == "steward-resume" && candidate.lane() == AgentResumeLane::Steward
    }));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn fresh_codex_launch_stages_transport_only_mcp_and_revokes_when_abandoned() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-fresh-codex-mcp-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 7).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(
        root.join("provider"),
    ));

    let plan = runtime
        .plan_agent_launch(json!({
            "projectId": project["id"],
            "cwd": root,
            "agentId": "codex"
        }))
        .unwrap();
    let token = plan.mcp_token.clone().unwrap();
    let session_id = plan.session_id.clone();
    plan.register_provisional_mcp();

    let principal = runtime
        .mcp_authorizer
        .authenticate_transport(&token)
        .unwrap();
    assert_eq!(principal.session_id(), session_id);
    assert_eq!(principal.role(), &AgentMcpRole::Interactive);
    assert!(matches!(
        runtime.mcp_authorizer.authenticate(&token),
        Err(CoreError::CapabilityDenied)
    ));

    drop(plan);
    assert!(matches!(
        runtime.mcp_authorizer.authenticate_transport(&token),
        Err(CoreError::CapabilityDenied)
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn pending_generated_input_fixture() {
    if std::env::var_os("TERMLOOP_TEST_PENDING_INITIAL_INPUT").is_none() {
        return;
    }
    use std::io::Write;

    let expected = std::env::var("TERMLOOP_TEST_EXPECTED_INITIAL_INPUT")
        .expect("pending input fixture requires exact expected content");
    let periodic_composer_redraw =
        std::env::var_os("TERMLOOP_TEST_PERIODIC_COMPOSER_REDRAW").is_some();
    let codex_composer_gate = std::env::var_os("TERMLOOP_TEST_CODEX_COMPOSER_READY").is_some();

    let _terminal_input_mode = termloop_platform::configure_headless_terminal_input_fixture()
        .expect("fixture must configure its PTY input mode");

    // Real agent TUIs opt into bracketed-paste mode before TermLoop delivers
    // their initial input. The synthetic Unix fixture mirrors that negotiation;
    // Windows uses platform-selected unframed ConPTY input instead.
    let client_protocol_replies = termloop_platform::host_uses_bracketed_paste_framing()
        && std::env::var_os("TERMLOOP_TEST_CLIENT_FOCUS_REPORT").is_some();
    let protocol_queries = if client_protocol_replies {
        "\x1b[c\x1b[c\x1b[c\x1b[?2026$p\x1b[>0q\x1b[?u\x1b[>7u\x1b]11;?\x1b\\\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?2031h"
    } else {
        ""
    };
    let idle_composer_frame = if periodic_composer_redraw {
        "\x1b[?2026h\x1b[?25h\x1b[20;3H\x1b[?2026l"
    } else {
        ""
    };
    let alternate_screen = if codex_composer_gate {
        "\x1b[?1049h"
    } else {
        ""
    };
    let stale_codex_transcript_frame = if codex_composer_gate {
        "\x1b[?2026h\x1b[8;1H\x1b[K\x1b[1m›\x1b[0m prior prompt\x1b[?25h\x1b[20;3H\x1b[?2026l"
    } else {
        ""
    };
    if termloop_platform::host_uses_bracketed_paste_framing() {
        println!(
            "{alternate_screen}\x1b[?2004h{protocol_queries}TERMLOOP_INITIAL_INPUT_READY{idle_composer_frame}{stale_codex_transcript_frame}"
        );
    } else {
        println!(
            "{alternate_screen}{protocol_queries}TERMLOOP_INITIAL_INPUT_READY{idle_composer_frame}{stale_codex_transcript_frame}"
        );
    }
    std::io::stdout().flush().unwrap();
    if codex_composer_gate {
        std::thread::sleep(std::time::Duration::from_millis(750));
        println!(
            "\x1b[?2026h\x1b[20;1H\x1b[K\x1b[1m›\x1b[0m Ask Codex to do anything \
             TERMLOOP_CODEX_COMPOSER_READY\x1b[?25h\x1b[20;3H\x1b[?2026l"
        );
        std::io::stdout().flush().unwrap();
    }
    let expected_paste = termloop_platform::terminal_paste_input(expected.as_bytes());
    let mut input = std::io::stdin().lock();
    read_headless_fixture_input(&mut input, &expected_paste);
    let submitted = expected;
    // Claude and Codex show the text cursor after rendering pasted composer
    // content. The periodic branch mirrors a multiline Codex composer that
    // grows upward while its final cursor stays fixed; the ordinary branch
    // exercises marker-plus-global-quiescence.
    if periodic_composer_redraw {
        println!(
            "TERMLOOP_INITIAL_INPUT_VISIBLE:{submitted}\x1b[?2026h\x1b[18;1H\x1b[Kcomposer top\x1b[19;1H\x1b[Kcomposer body\x1b[20;1H\x1b[K>\x1b[?25h\x1b[20;3H\x1b[?2026l"
        );
        std::io::stdout().flush().unwrap();
        std::thread::spawn(|| {
            for _ in 0..600 {
                std::thread::sleep(std::time::Duration::from_millis(20));
                print!(
                    "\x1b[?2026h\x1b[7;1H\x1b[Kanimation\x1b[20;1H\x1b[K>\x1b[?25h\x1b[20;3H\x1b[?2026l"
                );
                let _ = std::io::stdout().flush();
            }
        });
    } else if std::env::var_os("TERMLOOP_TEST_DELAY_COMPOSER_RENDER").is_some() {
        println!("TERMLOOP_INITIAL_INPUT_VISIBLE:{submitted}\x1b[?2026l");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(250));
        println!("\x1b[?25h");
        std::io::stdout().flush().unwrap();
    } else {
        println!("TERMLOOP_INITIAL_INPUT_VISIBLE:{submitted}\x1b[?25h");
        std::io::stdout().flush().unwrap();
    }
    if client_protocol_replies {
        for _ in 0..2 {
            for expected_reply in [
                b"\x1b[?62;22;52c".as_slice(),
                b"\x1b[?62;22;52c".as_slice(),
                b"\x1b[?62;22;52c".as_slice(),
                b"\x1b[?2026;1$y".as_slice(),
                b"\x1bP>|ghostty 1.2.3\x1b\\".as_slice(),
                b"\x1b[?5u".as_slice(),
                b"\x1b[13;1:3u".as_slice(),
                b"\x1b]11;rgb:2828/2c2c/3434\x1b\\".as_slice(),
                b"\x1b[?997;1n".as_slice(),
                b"\x1b[<35;12;8M".as_slice(),
                b"\x1b[<64;12;8M".as_slice(),
                b"\x1b[<0;12;8m".as_slice(),
                b"\x1b[I".as_slice(),
            ] {
                read_headless_fixture_input(&mut input, expected_reply);
            }
        }
    }
    if std::env::var_os("TERMLOOP_TEST_INTERLEAVED_USER_INPUT").is_some() {
        read_headless_fixture_input(&mut input, b"\x1b[D");
    }
    read_headless_fixture_input(&mut input, b"\r");
    if std::env::var_os("TERMLOOP_TEST_RETAIN_FIRST_SUBMIT").is_some() {
        println!(
            "\x1b[?2026h\x1b[20;1H\x1b[K\x1b[1m›\x1b[0m retained prompt\x1b[?25h\x1b[20;3H\x1b[?2026lTERMLOOP_PROMPT_RETAINED"
        );
        std::io::stdout().flush().unwrap();
        read_headless_fixture_input(&mut input, b"\r");
    } else if std::env::var_os("TERMLOOP_TEST_RETAIN_WITHOUT_REPAINT").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(6));
    }
    if termloop_platform::host_uses_bracketed_paste_framing() {
        println!("\x1b[?2004lTERMLOOP_INITIAL_INPUT_RECEIVED:{submitted}");
    } else {
        println!("TERMLOOP_INITIAL_INPUT_RECEIVED:{submitted}");
    }
    std::io::stdout().flush().unwrap();
}

#[tokio::test]
async fn late_terminal_exit_preserves_the_visible_resume_failure() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-late-resume-exit-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(root.join("state.json")).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "timed-out-resume".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: root.display().to_string(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(4),
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::StartupTimedOut),
            },
        )
        .unwrap();
    let terminal = TerminalService::default();
    terminal
        .spawn(PtySpawnSpec {
            session_id: "timed-out-resume".into(),
            runtime_epoch: 9,
            program: std::env::current_exe()
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap(),
            args: vec![
                "--exact".into(),
                "session_launch::tests::pending_generated_input_fixture".into(),
                "--nocapture".into(),
            ],
            cwd: root.display().to_string(),
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: true,
        })
        .unwrap();
    let mut output = terminal.subscribe("timed-out-resume", 9).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 10).unwrap();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let mut bytes = Vec::new();
    let mut answered_cursor_position_queries = 0;
    while terminal.session_is_running("timed-out-resume", 9).unwrap() {
        assert!(
            std::time::Instant::now() < deadline,
            "exit fixture did not finish"
        );
        if let Ok(Ok(termloop_terminal::TerminalEvent::Output(chunk))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), output.recv()).await
        {
            append_headless_output_and_answer_cursor_queries(
                &terminal,
                "timed-out-resume",
                9,
                &mut bytes,
                &mut answered_cursor_position_queries,
                chunk,
            );
        }
    }

    let reconciled = runtime.reconcile_exited_sessions().unwrap();

    assert_eq!(reconciled.exited_session_ids, ["timed-out-resume"]);
    let session = runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == "timed-out-resume")
        .unwrap();
    assert_eq!(session.lifecycle_state, "resumeFailed");
    assert_eq!(
        session.resume_failure,
        Some(ResumeFailureReason::StartupTimedOut)
    );
    let projection = runtime.project_session(session);
    assert_eq!(projection["lifecycle_state"], "resumeFailed");
    assert_eq!(projection["resume_failure_reason"], "startupTimedOut");
    assert_eq!(projection["retryable"], true);
    assert!(terminal.contains_session("timed-out-resume").unwrap());
    let mut hold_output = terminal.subscribe("timed-out-resume", 9).unwrap();
    let windows_host = termloop_platform::host_requires_long_path_opt_in();
    if !windows_host {
        terminal
            .input("timed-out-resume", b"echo TERMLOOP_AGENT_TERMINAL_HELD\n")
            .unwrap();
    }
    let hold_deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let mut held_bytes = Vec::new();
    let mut windows_command_sent = false;
    let mut answered_hold_cursor_position_queries = 0;
    while !held_bytes
        .windows(b"TERMLOOP_AGENT_TERMINAL_HELD".len())
        .any(|window| window == b"TERMLOOP_AGENT_TERMINAL_HELD")
    {
        assert!(
            std::time::Instant::now() < hold_deadline,
            "continuation shell did not accept terminal input"
        );
        if let Ok(Ok(termloop_terminal::TerminalEvent::Output(chunk))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), hold_output.recv()).await
        {
            append_headless_output_and_answer_cursor_queries(
                &terminal,
                "timed-out-resume",
                9,
                &mut held_bytes,
                &mut answered_hold_cursor_position_queries,
                chunk,
            );
            if windows_host && !windows_command_sent && answered_hold_cursor_position_queries > 0 {
                // PowerShell asks ConPTY for the cursor position before it
                // accepts the first command. Wait for that query so the
                // renderer response cannot arrive too early and be discarded.
                terminal
                    .input(
                        "timed-out-resume",
                        b"Write-Output TERMLOOP_AGENT_TERMINAL_HELD\r",
                    )
                    .unwrap();
                windows_command_sent = true;
            }
        }
    }
    runtime
        .close_session(json!({ "sessionId": "timed-out-resume" }))
        .unwrap();
    assert!(!terminal.contains_session("timed-out-resume").unwrap());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn intentional_resume_failure_reap_keeps_the_exact_typed_reason() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-intentional-resume-reap-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(root.join("state.json")).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "intentional-resume-reap".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: root.display().to_string(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(4),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    store
        .mark_agent_conversation_resumable(&authority, "intentional-resume-reap")
        .unwrap();
    let terminal = TerminalService::default();
    terminal
        .spawn(PtySpawnSpec {
            session_id: "intentional-resume-reap".into(),
            runtime_epoch: 10,
            program: std::env::current_exe()
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap(),
            args: vec![
                "--exact".into(),
                "session_launch::tests::pending_generated_input_fixture".into(),
                "--nocapture".into(),
            ],
            cwd: root.display().to_string(),
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: true,
        })
        .unwrap();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 10).unwrap();
    runtime
        .resume_reservations
        .insert("intentional-resume-reap".into());
    runtime
        .begin_agent_resume_failure_reap("intentional-resume-reap")
        .unwrap();
    terminal
        .terminate_and_retain_output("intentional-resume-reap")
        .unwrap();

    let reconciled = runtime.reconcile_exited_sessions().unwrap();
    assert!(reconciled.exited_session_ids.is_empty());
    assert!(
        runtime
            .resume_reservations
            .contains("intentional-resume-reap")
    );
    assert!(
        runtime
            .resume_failure_reaps
            .contains("intentional-resume-reap")
    );

    let failed = runtime
        .fail_agent_resume(
            "intentional-resume-reap",
            ResumeFailureReason::StartupTimedOut,
        )
        .unwrap();
    assert_eq!(failed["lifecycle_state"], "resumeFailed");
    assert_eq!(failed["resume_failure_reason"], "startupTimedOut");
    assert_eq!(failed["retryable"], true);
    assert!(
        !runtime
            .resume_reservations
            .contains("intentional-resume-reap")
    );
    assert!(
        !runtime
            .resume_failure_reaps
            .contains("intentional-resume-reap")
    );

    runtime
        .close_session(json!({ "sessionId": "intentional-resume-reap" }))
        .unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn daemon_restart_restores_stopped_agent_as_an_interactive_terminal() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-terminal-hold-restore-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(root.join("state.json")).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "restored-terminal-hold".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd,
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(4),
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 10).unwrap();

    assert_eq!(runtime.restore_agent_terminal_holds(), 1);
    assert!(terminal.contains_session("restored-terminal-hold").unwrap());
    runtime
        .close_session(json!({ "sessionId": "restored-terminal-hold" }))
        .unwrap();
    assert!(!terminal.contains_session("restored-terminal-hold").unwrap());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn archive_retirement_does_not_recreate_an_exited_agent_terminal() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-archive-terminal-hold-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 10).unwrap();
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "archive-terminal-hold".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd,
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(4),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    runtime
        .store
        .begin_session_archive(
            &runtime.write_authority,
            termloop_domain::SessionArchiveOperation {
                operation_id: Uuid::new_v4().to_string(),
                session_id: "archive-terminal-hold".into(),
                project_id: "project-1".into(),
                runtime_epoch: 9,
                state: termloop_domain::SessionArchiveOperationState::Prepared,
                requested_at_epoch_ms: 1,
            },
        )
        .unwrap();
    runtime
        .store
        .mark_session_exited(&runtime.write_authority, "archive-terminal-hold")
        .unwrap();

    runtime
        .spawn_agent_terminal_hold("archive-terminal-hold")
        .unwrap();

    assert!(!terminal.contains_session("archive-terminal-hold").unwrap());
    assert!(
        !runtime
            .agent_terminal_holds
            .contains("archive-terminal-hold")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn task_archive_retirement_does_not_recreate_an_exited_agent_terminal() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-task-archive-terminal-hold-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 10).unwrap();
    runtime
        .store
        .insert_project(
            &runtime.write_authority,
            termloop_domain::ProjectRecord {
                id: "project-1".into(),
                name: "Project".into(),
                folder_path: cwd.clone(),
            },
        )
        .unwrap();
    runtime
        .store
        .insert_task(
            &runtime.write_authority,
            termloop_domain::TaskRecord {
                id: "task-1".into(),
                project_id: "project-1".into(),
                title: "Task".into(),
                brief: None,
                status: termloop_domain::TaskStatus::Open,
                archived_at_epoch_ms: None,
                branch: None,
                worktree: None,
                worktree_generation: 0,
                steward_brief_markdown: String::new(),
                steward_brief_revision: 1,
                rank: 1,
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "task-archive-terminal-hold".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd,
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(4),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    runtime
        .store
        .begin_task_archive(
            &runtime.write_authority,
            termloop_domain::TaskArchiveOperation {
                operation_id: Uuid::new_v4().to_string(),
                task_id: "task-1".into(),
                project_id: "project-1".into(),
                worktree_path: None,
                worktree_generation: 0,
                targets: vec![termloop_domain::TaskArchiveTarget {
                    session_id: "task-archive-terminal-hold".into(),
                    runtime_epoch: 9,
                    prior_lifecycle_state: "running".into(),
                    prior_resume_failure: None,
                    was_live_agent: true,
                }],
                state: termloop_domain::TaskArchiveOperationState::Prepared,
            },
        )
        .unwrap();
    runtime
        .store
        .mark_session_exited(&runtime.write_authority, "task-archive-terminal-hold")
        .unwrap();

    runtime
        .spawn_agent_terminal_hold("task-archive-terminal-hold")
        .unwrap();

    assert!(
        !terminal
            .contains_session("task-archive-terminal-hold")
            .unwrap()
    );
    assert!(
        !runtime
            .agent_terminal_holds
            .contains("task-archive-terminal-hold")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn close_moves_an_agent_to_deleted_and_restore_recreates_its_terminal_hold() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-stale-terminal-hold-close-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(root.join("state.json")).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "stale-terminal-hold".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: root.display().to_string(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(4),
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::ResumeRejected),
            },
        )
        .unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 10).unwrap();
    runtime
        .agent_terminal_holds
        .insert("stale-terminal-hold".into());

    let closed = runtime
        .close_session(json!({ "sessionId": "stale-terminal-hold" }))
        .unwrap();

    assert_eq!(closed["closed"], true);
    assert!(!runtime.agent_terminal_holds.contains("stale-terminal-hold"));
    assert!(runtime.store.sessions().is_empty());
    assert_eq!(runtime.store.deleted_sessions().len(), 1);
    assert!(!terminal.contains_session("stale-terminal-hold").unwrap());

    let restore = runtime
        .plan_deleted_session_restore(json!({ "sessionId": "stale-terminal-hold" }))
        .unwrap()
        .observe(terminal.clone())
        .unwrap();
    let restored = runtime.apply_deleted_session_restore(restore).unwrap();
    assert_eq!(restored["id"], "stale-terminal-hold");
    assert_eq!(runtime.store.sessions().len(), 1);
    assert!(runtime.store.deleted_sessions().is_empty());
    assert!(terminal.contains_session("stale-terminal-hold").unwrap());
    assert!(runtime.agent_terminal_holds.contains("stale-terminal-hold"));
    runtime
        .release_agent_terminal_hold_for_resume("stale-terminal-hold")
        .unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn deleted_agent_restore_stays_blocked_after_its_source_directory_is_removed() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-deleted-source-missing-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let source = root.join("source");
    std::fs::create_dir_all(&source).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(root.join("state.json")).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "missing-source-agent".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: source.display().to_string(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 3,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 4).unwrap();
    runtime
        .close_session(json!({ "sessionId": "missing-source-agent" }))
        .unwrap();
    std::fs::remove_dir_all(&source).unwrap();

    let error = runtime
        .plan_deleted_session_restore(json!({ "sessionId": "missing-source-agent" }))
        .unwrap()
        .observe(terminal.clone())
        .unwrap_err();
    assert!(matches!(
        error,
        CoreError::InvalidParams(field) if field == "sourceUnavailable"
    ));
    assert!(runtime.store.sessions().is_empty());
    assert_eq!(runtime.store.deleted_sessions().len(), 1);
    assert!(!terminal.contains_session("missing-source-agent").unwrap());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn quick_action_initial_input_waits_for_codex_idle_and_survives_periodic_redraw() {
    assert_quick_action_initial_input_delivery("codex", false, false, false).await;
}

#[tokio::test]
async fn quick_action_submits_after_an_interrupted_codex_turn_returns_to_the_composer() {
    assert_quick_action_initial_input_delivery("codex", false, false, true).await;
}

#[tokio::test]
async fn quick_action_initial_input_submits_after_claude_hook_readiness() {
    assert_quick_action_initial_input_delivery("claude", false, false, false).await;
}

#[tokio::test]
async fn quick_action_initial_input_submits_after_gemini_prompt_boundary() {
    assert_quick_action_initial_input_delivery("gemini", false, false, false).await;
}

#[tokio::test]
async fn quick_action_retries_enter_once_when_codex_ack_is_late() {
    assert_quick_action_initial_input_delivery("codex", true, false, false).await;
}

#[tokio::test]
async fn quick_action_does_not_retry_enter_without_a_new_codex_composer_frame() {
    assert_quick_action_initial_input_delivery("codex", false, true, false).await;
}

#[test]
fn quick_action_permission_modal_blocks_before_terminal_submission() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-quick-action-modal-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 9).unwrap();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(
        root.join("provider"),
    ));
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "quick-action-modal".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: root.display().to_string(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.quick-action.free-prompt".into()),
                    template_version: Some(2),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    runtime.agent_observations.insert(
        "quick-action-modal".into(),
        crate::AgentObservationCapability {
            token: Some("modal-token".into()),
            runtime_epoch: 9,
            last_signal: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
            observation: None,
            pending_generated_input: Some(crate::test_generated_terminal_submission(
                "Do not accept this modal",
            )),
        },
    );

    runtime
        .record_agent_observation(
            "modal-token",
            "quick-action-modal",
            "PermissionRequest",
            None,
            None,
            1,
            1,
        )
        .unwrap();

    assert_eq!(
        runtime.generated_input_delivery_state("quick-action-modal", 9),
        Some(crate::GeneratedInputDeliveryState::Blocked)
    );
    assert_eq!(
        runtime.generated_input_delivery_failure("quick-action-modal", 9),
        Some(crate::GeneratedInputDeliveryFailure::ComposerUnavailable)
    );
    assert!(
        runtime.agent_observations["quick-action-modal"]
            .pending_generated_input
            .is_some()
    );
    let projection = runtime.agent_status_list().unwrap();
    assert_eq!(
        projection[0]["generatedInputDelivery"]["failure"],
        "composerUnavailable"
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["originalFailure"],
        "composerUnavailable"
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["cancelCause"],
        "permissionRequested"
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["cancelNotificationType"],
        serde_json::Value::Null
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["pasteReceipted"],
        false
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["submitReceipted"],
        false
    );

    // The provider returning to idle makes the same still-unwritten payload
    // eligible for its first transport attempt. This unit seam intentionally
    // has no PTY, so TerminalUnavailable proves Core attempted that path while
    // retaining the original modal cause.
    runtime
        .record_agent_observation(
            "modal-token",
            "quick-action-modal",
            "Stop",
            None,
            None,
            2,
            2,
        )
        .unwrap();
    assert_eq!(
        runtime.generated_input_delivery_state("quick-action-modal", 9),
        Some(crate::GeneratedInputDeliveryState::Failed)
    );
    assert_eq!(
        runtime.generated_input_delivery_failure("quick-action-modal", 9),
        Some(crate::GeneratedInputDeliveryFailure::TerminalUnavailable)
    );
    let projection = runtime.agent_status_list().unwrap();
    assert_eq!(
        projection[0]["generatedInputDelivery"]["originalFailure"],
        "composerUnavailable"
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["cancelCause"],
        "permissionRequested"
    );

    // Once the user resolves the modal, PromptSubmitted releases the runtime
    // payload but remains temporarily unattributed because this fixture has no
    // terminal activity snapshot. A later lifecycle signal from that same
    // provider turn must heal the warning without waiting for a daemon restart.
    runtime
        .record_agent_observation(
            "modal-token",
            "quick-action-modal",
            "UserPromptSubmit",
            None,
            None,
            3,
            3,
        )
        .unwrap();
    assert_eq!(
        runtime.generated_input_delivery_state("quick-action-modal", 9),
        Some(crate::GeneratedInputDeliveryState::ConfirmedUnattributed)
    );
    let projection = runtime.agent_status_list().unwrap();
    assert_eq!(
        projection[0]["generatedInputDelivery"]["failure"],
        serde_json::Value::Null
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["originalFailure"], "composerUnavailable",
        "manual recovery must not erase the first failed delivery gate"
    );
    assert!(
        runtime.agent_observations["quick-action-modal"]
            .pending_generated_input
            .is_none()
    );
    runtime
        .record_agent_observation(
            "modal-token",
            "quick-action-modal",
            "PreToolUse",
            None,
            None,
            4,
            4,
        )
        .unwrap();
    assert_eq!(
        runtime.generated_input_delivery_state("quick-action-modal", 9),
        Some(crate::GeneratedInputDeliveryState::Confirmed)
    );
    let projection = runtime.agent_status_list().unwrap();
    assert_eq!(
        projection[0]["generatedInputDelivery"]["state"],
        "confirmed"
    );
    assert_eq!(
        projection[0]["generatedInputDelivery"]["originalFailure"], "composerUnavailable",
        "live-state healing must preserve the first failed delivery gate"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn worker_activation_waits_for_post_hook_and_confirms_once() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-worker-activation-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 9).unwrap();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(
        root.join("provider"),
    ));
    let generated_input_events = runtime
        .take_generated_input_runtime_events()
        .expect("generated input events are taken once by the composition root");
    let project_id = runtime
        .handle(
            "project.create",
            json!({"name":"Worker activation","folderPath":root}),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    runtime
        .store
        .set_worker_configuration(
            &runtime.write_authority,
            termloop_domain::WorkerConfiguration {
                id: "worker-1".into(),
                project_id: project_id.clone(),
                name: "Activation Worker".into(),
                agent_id: termloop_domain::StewardAgentId::Claude,
                model: "default".into(),
                permission: "default".into(),
                reasoning: "default".into(),
                enabled: true,
                ping_interval_seconds: 60,
                worker_prompt: String::new(),
                system_prompt: String::new(),
                executor_session_id: None,
                generation: 1,
                updated_at_epoch_ms: 1,
            },
            runtime.store.revision(),
        )
        .unwrap();
    runtime
        .store
        .attach_worker_executor_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "worker-activation".into(),
                project_id,
                name: Some("Activation Worker".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: root.display().to_string(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.assistant.activation".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
            "worker-1",
            1,
            1,
        )
        .unwrap();
    runtime.agent_observations.insert(
        "worker-activation".into(),
        crate::AgentObservationCapability {
            token: Some("worker-token".into()),
            runtime_epoch: 9,
            last_signal: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
            observation: None,
            pending_generated_input: Some(crate::test_generated_terminal_submission(
                "Activate this Worker",
            )),
        },
    );
    terminal
        .spawn(PtySpawnSpec {
            session_id: "worker-activation".into(),
            runtime_epoch: 9,
            program: std::env::current_exe()
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap(),
            args: vec![
                "--exact".into(),
                "session_launch::tests::pending_generated_input_fixture".into(),
                "--nocapture".into(),
            ],
            cwd: root.display().to_string(),
            environment: termloop_platform::LaunchEnvironment::os_baseline()
                .with_explicit("TERMLOOP_TEST_PENDING_INITIAL_INPUT", "1")
                .with_explicit(
                    "TERMLOOP_TEST_EXPECTED_INITIAL_INPUT",
                    "Activate this Worker",
                )
                .with_explicit("TERMLOOP_TEST_DELAY_COMPOSER_RENDER", "1"),
            recent_output_replay: false,
        })
        .unwrap();
    let mut output = terminal.subscribe("worker-activation", 9).unwrap();
    let mut bytes = Vec::new();
    let mut answered_cursor_position_queries = 0;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while !String::from_utf8_lossy(&bytes).contains("TERMLOOP_INITIAL_INPUT_READY") {
            if let termloop_terminal::TerminalEvent::Output(chunk) = output.recv().await.unwrap() {
                append_headless_output_and_answer_cursor_queries(
                    &terminal,
                    "worker-activation",
                    9,
                    &mut bytes,
                    &mut answered_cursor_position_queries,
                    chunk,
                );
            }
        }
    })
    .await
    .unwrap();

    runtime
        .record_agent_observation(
            "worker-token",
            "worker-activation",
            "SessionStart",
            None,
            None,
            1,
            1,
        )
        .unwrap();
    assert!(runtime.pending_generated_input_after_hook_response("worker-activation"));
    assert!(
        runtime
            .deliver_pending_generated_input_after_hook_response("worker-activation")
            .unwrap()
    );
    assert!(!runtime.pending_generated_input_after_hook_response("worker-activation"));

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&bytes)
            .contains("TERMLOOP_INITIAL_INPUT_VISIBLE:Activate this Worker")
        {
            if let termloop_terminal::TerminalEvent::Output(chunk) = output.recv().await.unwrap() {
                append_headless_output_and_answer_cursor_queries(
                    &terminal,
                    "worker-activation",
                    9,
                    &mut bytes,
                    &mut answered_cursor_position_queries,
                    chunk,
                );
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "worker fixture did not render paste; state={:?} failure={:?} output={}",
            runtime.generated_input_delivery_state("worker-activation", 9),
            runtime.generated_input_delivery_failure("worker-activation", 9),
            bounded_headless_fixture_output(&bytes),
        )
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(
        runtime.generated_input_delivery_state("worker-activation", 9),
        Some(crate::GeneratedInputDeliveryState::WritingPaste),
        "a synchronized frame must not release submit before the composer render marker"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&bytes)
            .contains("TERMLOOP_INITIAL_INPUT_RECEIVED:Activate this Worker")
        {
            if let termloop_terminal::TerminalEvent::Output(chunk) = output.recv().await.unwrap() {
                append_headless_output_and_answer_cursor_queries(
                    &terminal,
                    "worker-activation",
                    9,
                    &mut bytes,
                    &mut answered_cursor_position_queries,
                    chunk,
                );
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "worker fixture did not receive submit; state={:?} failure={:?} output={}",
            runtime.generated_input_delivery_state("worker-activation", 9),
            runtime.generated_input_delivery_failure("worker-activation", 9),
            bounded_headless_fixture_output(&bytes),
        )
    });

    let event = generated_input_events
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    assert!(runtime.record_generated_input_runtime_event(event).unwrap());
    assert_eq!(
        runtime.generated_input_delivery_state("worker-activation", 9),
        Some(crate::GeneratedInputDeliveryState::AwaitingProviderAck)
    );
    assert!(!runtime.pending_generated_input_after_hook_response("worker-activation"));

    runtime
        .record_agent_observation(
            "worker-token",
            "worker-activation",
            "UserPromptSubmit",
            None,
            None,
            2,
            2,
        )
        .unwrap();
    assert_eq!(
        runtime.generated_input_delivery_state("worker-activation", 9),
        Some(crate::GeneratedInputDeliveryState::Confirmed)
    );
    assert!(!runtime.pending_generated_input_after_hook_response("worker-activation"));
    let _ = terminal.terminate("worker-activation");
    let _ = std::fs::remove_dir_all(root);
}

async fn assert_quick_action_initial_input_delivery(
    agent_id: &str,
    retry_submit: bool,
    retain_without_repaint: bool,
    submit_after_interrupted_turn: bool,
) {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-initial-input-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 9).unwrap();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(
        root.join("provider"),
    ));
    let generated_input_events = runtime
        .take_generated_input_runtime_events()
        .expect("generated input events are taken once by the composition root");
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "quick-action-ready".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: agent_id.into(),
                    args: vec![],
                    cwd: root.display().to_string(),
                    agent_id: Some(agent_id.into()),
                    template_ref: Some("builtin.quick-action.free-prompt".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 9,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    runtime.agent_observations.insert(
        "quick-action-ready".into(),
        crate::AgentObservationCapability {
            token: (agent_id != "codex").then(|| "ready-token".into()),
            runtime_epoch: 9,
            last_signal: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
            observation: None,
            pending_generated_input: (!submit_after_interrupted_turn)
                .then(|| crate::test_generated_terminal_submission("Review this diff")),
        },
    );
    let mut environment = termloop_platform::LaunchEnvironment::os_baseline()
        .with_explicit("TERMLOOP_TEST_PENDING_INITIAL_INPUT", "1")
        .with_explicit("TERMLOOP_TEST_EXPECTED_INITIAL_INPUT", "Review this diff")
        .with_explicit("TERMLOOP_TEST_INTERLEAVED_USER_INPUT", "1");
    let client_protocol_replies =
        termloop_platform::host_uses_bracketed_paste_framing() && agent_id != "codex";
    if client_protocol_replies {
        environment = environment.with_explicit("TERMLOOP_TEST_CLIENT_FOCUS_REPORT", "1");
    }
    if matches!(agent_id, "claude" | "codex") {
        environment = environment.with_explicit("TERMLOOP_TEST_PERIODIC_COMPOSER_REDRAW", "1");
    }
    if agent_id == "codex" {
        environment = environment.with_explicit("TERMLOOP_TEST_CODEX_COMPOSER_READY", "1");
    }
    if retry_submit {
        environment = environment.with_explicit("TERMLOOP_TEST_RETAIN_FIRST_SUBMIT", "1");
    } else if retain_without_repaint {
        environment = environment.with_explicit("TERMLOOP_TEST_RETAIN_WITHOUT_REPAINT", "1");
    }
    terminal
        .spawn(PtySpawnSpec {
            session_id: "quick-action-ready".into(),
            runtime_epoch: 9,
            program: std::env::current_exe()
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap(),
            args: vec![
                "--exact".into(),
                "session_launch::tests::pending_generated_input_fixture".into(),
                "--nocapture".into(),
            ],
            cwd: root.display().to_string(),
            environment,
            recent_output_replay: false,
        })
        .unwrap();
    let mut output = terminal.subscribe("quick-action-ready", 9).unwrap();
    let mut bytes = Vec::new();
    let mut answered_cursor_position_queries = 0;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while !String::from_utf8_lossy(&bytes).contains("TERMLOOP_INITIAL_INPUT_READY") {
            match output.recv().await.unwrap() {
                termloop_terminal::TerminalEvent::Output(chunk) => {
                    append_headless_output_and_answer_cursor_queries(
                        &terminal,
                        "quick-action-ready",
                        9,
                        &mut bytes,
                        &mut answered_cursor_position_queries,
                        chunk,
                    );
                }
                termloop_terminal::TerminalEvent::Gap(_) => {
                    panic!("fixture output unexpectedly reported a gap")
                }
                termloop_terminal::TerminalEvent::Eof => panic!("fixture exited before ready"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        runtime
            .agent_observations
            .get("quick-action-ready")
            .and_then(|capability| capability.pending_generated_input.as_ref())
            .is_some(),
        !submit_after_interrupted_turn
    );

    if agent_id == "codex" {
        runtime
            .record_agent_resume_ref(
                "quick-action-ready",
                9,
                termloop_domain::ResumeRef::for_provider(
                    termloop_domain::ResumeProvider::Codex,
                    "codex-thread-ready".into(),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            runtime.generated_input_delivery_state("quick-action-ready", 9),
            None,
            "thread identity alone must not release generated input"
        );
        runtime
            .record_app_server_observation(
                "quick-action-ready",
                9,
                if submit_after_interrupted_turn {
                    termloop_agents::AgentSignal::Interrupted
                } else {
                    termloop_agents::AgentSignal::Stopped
                },
                1,
                1,
            )
            .unwrap();
        if submit_after_interrupted_turn {
            assert_eq!(
                runtime.agent_observations["quick-action-ready"]
                    .observation
                    .unwrap()
                    .state,
                termloop_agents::AgentState::Interrupted
            );
            runtime
                .submit_generated_terminal_input(
                    "quick-action-ready",
                    crate::test_generated_terminal_submission("Review this diff"),
                )
                .unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        let diagnostics = runtime
            .generated_input_deliveries
            .diagnostics("quick-action-ready", 9)
            .unwrap();
        assert!(
            !diagnostics.paste_receipted,
            "Codex startup output must not receive the paste before its composer glyph renders"
        );
    } else {
        runtime
            .record_agent_observation(
                "ready-token",
                "quick-action-ready",
                "SessionStart",
                None,
                None,
                1,
                1,
            )
            .unwrap();
        assert!(
            runtime.pending_generated_input_after_hook_response("quick-action-ready"),
            "hook-observed initial input must wait until the SessionStart response leaves the daemon"
        );
        assert_eq!(
            runtime.generated_input_delivery_state("quick-action-ready", 9),
            None
        );
        assert!(
            runtime
                .deliver_pending_generated_input_after_hook_response("quick-action-ready")
                .unwrap()
        );
    }
    if client_protocol_replies {
        for _ in 0..2 {
            for client_protocol_reply in [
                b"\x1b[?62;22;52c".as_slice(),
                b"\x1b[?62;22;52c".as_slice(),
                b"\x1b[?62;22;52c".as_slice(),
                b"\x1b[?2026;1$y".as_slice(),
                b"\x1bP>|ghostty 1.2.3\x1b\\".as_slice(),
                b"\x1b[?5u".as_slice(),
                b"\x1b[13;1:3u".as_slice(),
                b"\x1b]11;rgb:2828/2c2c/3434\x1b\\".as_slice(),
                b"\x1b[?997;1n".as_slice(),
                b"\x1b[<35;12;8M".as_slice(),
                b"\x1b[<64;12;8M".as_slice(),
                b"\x1b[<0;12;8m".as_slice(),
                b"\x1b[I".as_slice(),
            ] {
                for fragment in client_protocol_reply.chunks(2) {
                    terminal
                        .input_user("quick-action-ready", 9, fragment)
                        .unwrap();
                }
            }
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&bytes)
            .contains("TERMLOOP_INITIAL_INPUT_VISIBLE:Review this diff")
        {
            match output.recv().await.unwrap() {
                termloop_terminal::TerminalEvent::Output(chunk) => {
                    append_headless_output_and_answer_cursor_queries(
                        &terminal,
                        "quick-action-ready",
                        9,
                        &mut bytes,
                        &mut answered_cursor_position_queries,
                        chunk,
                    );
                }
                termloop_terminal::TerminalEvent::Gap(_) => {
                    panic!("fixture output unexpectedly reported a gap")
                }
                termloop_terminal::TerminalEvent::Eof => {
                    panic!("fixture exited before rendering initial input")
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "quick-action fixture did not render paste; state={:?} failure={:?} readiness={:?} queued_event={:?} output={}",
            runtime.generated_input_delivery_state("quick-action-ready", 9),
            runtime.generated_input_delivery_failure("quick-action-ready", 9),
            terminal
                .input_readiness_snapshot("quick-action-ready", 9)
                .map(|snapshot| snapshot.facts()),
            generated_input_events.try_recv().ok(),
            bounded_headless_fixture_output(&bytes),
        )
    });
    terminal
        .input_user("quick-action-ready", 9, b"\x1b[D")
        .unwrap();
    assert_eq!(
        terminal
            .user_input_activity("quick-action-ready", 9)
            .unwrap(),
        termloop_terminal::UserInputActivitySnapshot {
            sequence: 1,
            mutation_sequence: 1,
        }
    );
    assert_eq!(
        runtime.generated_input_delivery_state("quick-action-ready", 9),
        Some(crate::GeneratedInputDeliveryState::WritingPaste)
    );
    let status_projection = runtime.agent_status_list().unwrap();
    let projected_delivery = &status_projection
        .as_array()
        .unwrap()
        .iter()
        .find(|status| status["sessionId"] == "quick-action-ready")
        .unwrap()["generatedInputDelivery"];
    assert_eq!(projected_delivery["state"], "writingPaste");
    assert_eq!(projected_delivery["failure"], serde_json::Value::Null);
    assert_eq!(projected_delivery["submitAttempts"], 0);
    assert_eq!(
        projected_delivery["templateRef"],
        "builtin.quick-action.free-prompt"
    );
    assert_eq!(projected_delivery["templateVersion"], 2);
    assert!(!status_projection.to_string().contains("Review this diff"));
    assert!(
        runtime.agent_observations["quick-action-ready"]
            .pending_generated_input
            .is_some()
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(if retry_submit || retain_without_repaint {
            10
        } else {
            5
        }),
        async {
            while !String::from_utf8_lossy(&bytes)
                .contains("TERMLOOP_INITIAL_INPUT_RECEIVED:Review this diff")
            {
                match output.recv().await.unwrap() {
                    termloop_terminal::TerminalEvent::Output(chunk) => {
                        append_headless_output_and_answer_cursor_queries(
                            &terminal,
                            "quick-action-ready",
                            9,
                            &mut bytes,
                            &mut answered_cursor_position_queries,
                            chunk,
                        );
                    }
                    termloop_terminal::TerminalEvent::Gap(_) => {
                        panic!("fixture output unexpectedly reported a gap")
                    }
                    termloop_terminal::TerminalEvent::Eof => {
                        panic!(
                            "fixture exited before receiving initial input: {}",
                            String::from_utf8_lossy(&bytes)
                        )
                    }
                }
            }
        },
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "quick-action fixture did not receive submit; state={:?} failure={:?} readiness={:?} queued_event={:?} output={}",
            runtime.generated_input_delivery_state("quick-action-ready", 9),
            runtime.generated_input_delivery_failure("quick-action-ready", 9),
            terminal
                .input_readiness_snapshot("quick-action-ready", 9)
                .map(|snapshot| snapshot.facts()),
            generated_input_events.try_recv().ok(),
            bounded_headless_fixture_output(&bytes),
        )
    });

    let event = generated_input_events
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    assert!(runtime.record_generated_input_runtime_event(event).unwrap());
    assert_eq!(
        runtime.generated_input_delivery_state("quick-action-ready", 9),
        Some(crate::GeneratedInputDeliveryState::AwaitingProviderAck)
    );
    let status_projection = runtime.agent_status_list().unwrap();
    let projected_delivery = &status_projection
        .as_array()
        .unwrap()
        .iter()
        .find(|status| status["sessionId"] == "quick-action-ready")
        .unwrap()["generatedInputDelivery"];
    assert_eq!(projected_delivery["state"], "awaitingProviderAck");
    assert_eq!(projected_delivery["submitAttempts"], 1);
    assert!(
        runtime.agent_observations["quick-action-ready"]
            .pending_generated_input
            .is_some()
    );

    if retry_submit {
        let event = generated_input_events
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(runtime.record_generated_input_runtime_event(event).unwrap());
        assert_eq!(
            runtime.generated_input_delivery_state("quick-action-ready", 9),
            Some(crate::GeneratedInputDeliveryState::AwaitingProviderAck)
        );
        let diagnostics = runtime
            .generated_input_deliveries
            .diagnostics("quick-action-ready", 9)
            .unwrap();
        assert_eq!(diagnostics.submit_attempts, 2);
        assert!(diagnostics.submit_receipted);
    } else if retain_without_repaint {
        let event = generated_input_events
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(runtime.record_generated_input_runtime_event(event).unwrap());
        assert_eq!(
            runtime.generated_input_delivery_state("quick-action-ready", 9),
            Some(crate::GeneratedInputDeliveryState::Stalled)
        );
        let diagnostics = runtime
            .generated_input_deliveries
            .diagnostics("quick-action-ready", 9)
            .unwrap();
        assert_eq!(diagnostics.submit_attempts, 1);
        assert!(diagnostics.submit_receipted);
    }

    if agent_id == "codex" {
        runtime
            .record_app_server_observation(
                "quick-action-ready",
                9,
                termloop_agents::AgentSignal::PromptSubmitted,
                2,
                2,
            )
            .unwrap();
    } else {
        runtime
            .record_agent_observation(
                "ready-token",
                "quick-action-ready",
                if agent_id == "gemini" {
                    "BeforeAgent"
                } else {
                    "UserPromptSubmit"
                },
                None,
                None,
                2,
                2,
            )
            .unwrap();
    }
    assert_eq!(
        runtime.generated_input_delivery_state("quick-action-ready", 9),
        Some(crate::GeneratedInputDeliveryState::Confirmed)
    );
    assert!(
        runtime.agent_observations["quick-action-ready"]
            .pending_generated_input
            .is_none()
    );

    let _ = terminal.terminate("quick-action-ready");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn task_launch_requires_a_managed_worktree_without_spawning() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-task-launch-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let state = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&state).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let task = runtime
        .handle(
            "task.create",
            json!({
                "projectId":project["id"],"title":"Task","brief":null,"worktreeIntent":"none"
            }),
        )
        .unwrap();
    let error = runtime
        .plan_task_worktree_launch(json!({"taskId":task["id"]}), false)
        .unwrap_err();
    assert!(matches!(error, CoreError::TaskWorktreeRequired { .. }));
    assert!(runtime.store.sessions().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn steward_task_assignment_derives_jira_context_from_the_sidecar() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-steward-jira-assignment-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let task = runtime
        .handle(
            "task.create",
            json!({
                "projectId":project["id"],"title":"Linked Task","brief":"Current brief","worktreeIntent":"none"
            }),
        )
        .unwrap();
    let task_id = task["id"].as_str().unwrap();
    runtime
        .store
        .insert_task_jira_issue_link(
            &runtime.write_authority,
            IssueLink {
                task_id: task_id.into(),
                provider: IssueLinkProvider::Jira,
                external_ref: "TERM-42".into(),
                source_id: None,
                external_id: None,
                external_updated_at: None,
                url: Some("https://example.atlassian.net/browse/TERM-42".into()),
                sync_authority: IssueLinkSyncAuthority::None,
            },
        )
        .unwrap();
    let mut plan = runtime
        .plan_agent_launch(json!({
            "projectId": project["id"],
            "cwd": root,
            "agentId": "codex"
        }))
        .unwrap();
    plan.task_guard = Some(TaskLaunchGuard {
        task_id: task_id.into(),
        managed_worktree_operation_id: task_id.into(),
        worktree_generation: 1,
        cwd: root.display().to_string(),
        repository_common_dir: root.display().to_string(),
        branch_ref: "refs/heads/termloop/linked-task".into(),
    });

    let plan = runtime
        .attach_steward_task_assignment(plan, task_id, "Implement and verify.")
        .unwrap();
    let launch = resolve_interactive_agent_launch(&plan).unwrap();
    assert!(launch.initial_input().is_some_and(|input| {
        input.contains("Jira issue: https://example.atlassian.net/browse/TERM-42")
    }));
    drop(plan);

    let mut kickoff_plan = runtime
        .plan_agent_launch(json!({
            "projectId": project["id"],
            "cwd": root,
            "agentId": "codex",
            "model": "gpt-5.6-sol",
            "permission": "default",
            "reasoning": "high"
        }))
        .unwrap();
    kickoff_plan.task_guard = Some(TaskLaunchGuard {
        task_id: task_id.into(),
        managed_worktree_operation_id: task_id.into(),
        worktree_generation: 1,
        cwd: root.display().to_string(),
        repository_common_dir: root.display().to_string(),
        branch_ref: "refs/heads/termloop/linked-task".into(),
    });
    let kickoff_plan = runtime
        .attach_task_kickoff(
            kickoff_plan,
            task_id,
            "Implement this Task and run focused tests.",
        )
        .unwrap();
    let kickoff_launch = resolve_interactive_agent_launch(&kickoff_plan).unwrap();
    assert_eq!(
        kickoff_launch.provenance().template_ref,
        "builtin.agent.task-kickoff"
    );
    assert!(kickoff_launch.initial_input().is_some_and(|input| {
        input.contains("Jira: https://example.atlassian.net/browse/TERM-42")
            && input.contains("Implement this Task and run focused tests.")
            && !input.contains("Kickoff ID")
            && !input.contains("builtin.agent.task-kickoff")
    }));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn codex_trust_requires_an_observed_managed_worktree_guard() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-codex-managed-trust-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":cwd}))
        .unwrap();
    let mut plan = runtime
        .plan_agent_launch(json!({
            "projectId": project["id"],
            "cwd": cwd,
            "agentId": "codex"
        }))
        .unwrap();
    plan.task_guard = Some(TaskLaunchGuard {
        task_id: "task-managed".into(),
        managed_worktree_operation_id: "operation-managed".into(),
        worktree_generation: 1,
        cwd: cwd.clone(),
        repository_common_dir: root.display().to_string(),
        branch_ref: "refs/heads/termloop/task-managed".into(),
    });

    let guard_only = resolve_interactive_agent_launch(&plan).unwrap();
    assert!(
        guard_only
            .args()
            .iter()
            .all(|argument| !argument.contains("trust_level="))
    );

    plan.fork_worktree_observed = true;
    let observed = resolve_interactive_agent_launch(&plan).unwrap();
    assert!(
        observed
            .args()
            .iter()
            .any(|argument| argument.contains("={trust_level=\"trusted\"}"))
    );

    plan.task_guard_requires_observation = true;
    let awaiting_observation = resolve_interactive_agent_launch(&plan).unwrap();
    assert!(
        awaiting_observation
            .args()
            .iter()
            .all(|argument| !argument.contains("trust_level="))
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn agent_launch_refuses_a_replacement_at_the_same_cwd_path() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-cwd-identity-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let state = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&state).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let mut plan = runtime
        .plan_agent_launch(json!({
            "projectId": project["id"],
            "cwd": root,
            "agentId": "claude"
        }))
        .unwrap();

    let original = root.with_extension("original");
    std::fs::rename(&root, &original).unwrap();
    std::fs::create_dir_all(&root).unwrap();

    assert!(matches!(
        runtime.complete_agent_launch(&mut plan),
        Err(CoreError::InvalidParams(field)) if field == "cwd"
    ));
    assert!(runtime.store.sessions().is_empty());

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(original);
}

fn runtime_with_session() -> (CoreRuntime, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-rename-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "session-1".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Terminal,
                process: ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: None,
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    (
        CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap(),
        path,
    )
}

#[test]
fn startup_ownership_uncertainty_does_not_revive_explicitly_exited_agents() {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-ownership-scope-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    for (id, lifecycle_state) in [("recovering", "resuming"), ("stopped", "exited")] {
        store
            .insert_session(
                &authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: id.into(),
                    project_id: "project-1".into(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd: "/tmp".into(),
                        agent_id: Some("claude".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: lifecycle_state.into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Claude,
                        Uuid::new_v4().to_string(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
    }
    store
        .mark_agent_conversation_resumable(&authority, "recovering")
        .unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap();
    runtime
        .mark_startup_runtime_ownership_uncertain(&[], true)
        .unwrap();
    let sessions = runtime.list_sessions().unwrap();
    let recovering = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == "recovering")
        .unwrap();
    let stopped = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] == "stopped")
        .unwrap();
    assert_eq!(
        recovering["resume_failure_reason"],
        "runtimeOwnershipUncertain"
    );
    assert_eq!(stopped["lifecycle_state"], "exited");
    assert!(stopped["resume_failure_reason"].is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn rename_trims_and_blank_clears_current_session_name() {
    let (mut runtime, path) = runtime_with_session();
    let renamed = runtime
        .rename_session(json!({ "sessionId": "session-1", "name": "  Build API  " }))
        .unwrap();
    assert_eq!(renamed["name"], "Build API");
    let cleared = runtime
        .rename_session(json!({ "sessionId": "session-1", "name": "   " }))
        .unwrap();
    assert!(cleared["name"].is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn rename_rejects_overlong_names_and_reports_missing_sessions() {
    let (mut runtime, path) = runtime_with_session();
    assert!(matches!(
        runtime.rename_session(json!({ "sessionId": "session-1", "name": "x".repeat(81) })),
        Err(CoreError::InvalidParams(_))
    ));
    assert!(matches!(
        runtime.rename_session(json!({ "sessionId": "missing", "name": "Build" })),
        Err(CoreError::NotFound)
    ));
    let _ = std::fs::remove_file(path);
}

#[test]
fn listing_sessions_is_a_pure_read() {
    let (runtime, path) = runtime_with_session();
    let revision = runtime.state_revision();
    let first = runtime.list_sessions().unwrap();
    let second = runtime.list_sessions().unwrap();
    assert_eq!(first, second);
    assert_eq!(runtime.state_revision(), revision);
    let _ = std::fs::remove_file(path);
}

#[test]
fn launch_directory_rejects_silent_fallback_and_returns_the_canonical_path() {
    assert!(matches!(
        launch_directory(&json!({ "cwd": "relative" })),
        Err(CoreError::InvalidParams(field)) if field == "cwd"
    ));
    let directory = std::env::temp_dir();
    assert_eq!(
        launch_directory(&json!({ "cwd": directory })).unwrap(),
        termloop_platform::canonical_existing_directory_path(&directory)
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap()
    );
}

#[test]
fn quick_action_session_name_uses_the_bounded_first_remaining_line() {
    assert_eq!(
        super::quick_action_session_name("  Review this diff  \nThen run tests  ").as_deref(),
        Some("Review this diff")
    );
    assert_eq!(
        super::quick_action_session_name("\n\t  Review Unicode: ü  \r\nIgnore this").as_deref(),
        Some("Review Unicode: ü")
    );
    assert!(super::quick_action_session_name(" \n\t ").is_none());

    let long_name = "ü".repeat(81);
    let bounded = super::quick_action_session_name(&long_name).unwrap();
    assert_eq!(bounded.chars().count(), 80);
    assert_eq!(bounded, "ü".repeat(80));
}

#[test]
fn quick_action_preview_is_project_scoped_and_matches_versioned_delivery() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-quick-action-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let state = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&state).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let revision = runtime.state_revision();
    let params = json!({
        "projectId": project["id"], "cwd": root, "agentId": "codex", "model": "gpt-5.6-sol",
        "permission": "plan", "reasoning": "high",
        "templateRef": "builtin.quick-action.free-prompt", "bindings": { "prompt": "Review this diff" }, "attachments": []
    });
    let preview = runtime.preview_quick_action(params.clone()).unwrap();
    assert_eq!(preview["delivered_preview"], "Review this diff");
    assert_eq!(preview["template_ref"], "builtin.quick-action.free-prompt");
    assert_eq!(preview["delivery"], "terminalInput");
    assert_eq!(preview["permission"], "plan");
    assert_eq!(preview["reasoning"], "high");
    assert_eq!(preview["manifest"]["target"]["agent_id"], "codex");
    assert_eq!(
        preview["manifest"]["transport"]["delivered_content"],
        "Review this diff\r"
    );
    assert!(preview["manifest"]["limitations"].as_array().unwrap().len() >= 2);
    let launch_ticket = preview["launch_ticket"].as_str().unwrap();
    assert_eq!(launch_ticket.len(), 64);
    let mut launch_params = params.clone();
    launch_params["launchTicket"] = Value::String(launch_ticket.to_owned());
    let plan = runtime
        .take_quick_action_launch(launch_params.clone())
        .unwrap();
    assert_eq!(
        super::launch_session_name(&plan).as_deref(),
        Some("Review this diff")
    );
    assert_eq!(
        effective_launch_selection(&plan),
        termloop_domain::AgentLaunchSelection::new("gpt-5.6-sol", "plan", "high")
    );
    assert!(runtime.take_quick_action_launch(launch_params).is_err());
    let mut bounded_tickets = Vec::new();
    for _ in 0..65 {
        let preview = runtime.preview_quick_action(params.clone()).unwrap();
        bounded_tickets.push(preview["launch_ticket"].as_str().unwrap().to_owned());
    }
    assert_eq!(runtime.quick_action_previews.len(), 64);
    assert!(
        !runtime
            .quick_action_previews
            .iter()
            .any(|(ticket, _)| ticket == &bounded_tickets[0])
    );
    assert_eq!(
        runtime.quick_action_previews.back().unwrap().0,
        *bounded_tickets.last().unwrap()
    );
    let discard_ticket = runtime.quick_action_previews.front().unwrap().0.clone();
    runtime.discard_quick_action_preview(&discard_ticket);
    assert_eq!(runtime.quick_action_previews.len(), 63);
    assert_eq!(runtime.state_revision(), revision);
    assert!(runtime.store.sessions().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn quick_action_preview_ticket_binds_the_exact_image_attachment() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-quick-action-image-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let attachment_id = "123e4567-e89b-42d3-a456-426614174000";
    let file_path = std::env::temp_dir()
        .join("termloop-quick-action-images")
        .join(attachment_id)
        .join("image.png");
    let params = json!({
        "projectId": project["id"], "cwd": root, "agentId": "codex", "model": "default",
        "permission": "default", "reasoning": "default",
        "templateRef": "builtin.quick-action.free-prompt", "bindings": { "prompt": "Inspect this image" },
        "attachments": [{
            "attachmentId": attachment_id, "filePath": file_path, "mediaType": "image/png",
            "byteLength": 4096, "sha256": format!("sha256:{}", "a".repeat(64)),
            "width": 800, "height": 600
        }]
    });
    let preview = runtime.preview_quick_action(params.clone()).unwrap();
    assert_eq!(
        preview["manifest"]["content_parts"][1]["delivery"],
        "providerImageArgument"
    );
    assert!(
        preview["manifest"]["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|argument| {
                argument["classification"] == "sensitivePath"
                    && argument["display"] == "<redacted Quick Action image path>"
            })
    );

    let mut changed = params.clone();
    changed["attachments"][0]["sha256"] = Value::String(format!("sha256:{}", "b".repeat(64)));
    changed["launchTicket"] = preview["launch_ticket"].clone();
    assert!(runtime.take_quick_action_launch(changed).is_err());

    let preview = runtime.preview_quick_action(params.clone()).unwrap();
    let mut launch_params = params;
    launch_params["launchTicket"] = preview["launch_ticket"].clone();
    let plan = runtime.take_quick_action_launch(launch_params).unwrap();
    assert!(
        plan.prepared_launch
            .as_ref()
            .unwrap()
            .args()
            .windows(2)
            .any(|arguments| {
                arguments[0] == "--image" && arguments[1] == file_path.to_string_lossy()
            })
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn quick_action_ticket_keeps_the_exact_once_resolved_private_payload() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-quick-action-private-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let mut transport = crate::test_agent_observation_transport_with_claude_settings(
        root.join("provider"),
        "{\"hooks\":{\"exact\":\"first-private-value\"}}",
        "{\"hooks\":{\"exact\":\"<redacted runtime executable>\"}}",
    );
    transport.endpoint = "ws://preview-authority".into();
    transport.agents.remove("codex");
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);
    runtime.agent_observations.insert(
        "live-agent".into(),
        crate::AgentObservationCapability {
            token: Some("existing-hook-token".into()),
            runtime_epoch: 1,
            last_signal: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
            observation: Some(termloop_agents::AgentObservation {
                state: termloop_agents::AgentState::Working,
                source: termloop_agents::AgentSignalSource::Hook,
                sequence: 1,
                observed_at_epoch_ms: 50,
            }),
            pending_generated_input: None,
        },
    );
    let params = json!({
        "projectId": project["id"], "cwd": root, "agentId": "claude", "model": "fable",
        "permission": "plan", "reasoning": "high",
        "templateRef": "builtin.quick-action.free-prompt", "bindings": { "prompt": "Inspect this" }, "attachments": []
    });
    let preview = runtime.preview_quick_action(params.clone()).unwrap();
    let ticket = preview["launch_ticket"].as_str().unwrap().to_owned();
    runtime
        .observation_transport
        .as_mut()
        .unwrap()
        .replace_test_inline_settings(
            "claude",
            "{\"hooks\":{\"exact\":\"second-private-value\"}}",
            "{\"hooks\":{\"exact\":\"<redacted runtime executable>\"}}",
        );
    let mut launch_params = params;
    launch_params["launchTicket"] = Value::String(ticket);
    let plan = runtime.take_quick_action_launch(launch_params).unwrap();
    let args = plan.prepared_launch.as_ref().unwrap().args().join(" ");
    assert!(args.contains("first-private-value"));
    assert!(!args.contains("second-private-value"));
    assert!(!preview.to_string().contains("first-private-value"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_unconfigured_claude_agent_records_the_auto_permission_it_launches_with() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-project-agent-auto-permission-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let params = json!({"projectId":project["id"],"cwd":root,"agentId":"claude"});
    let preview = runtime.preview_agent_launch(params.clone()).unwrap();
    let mut launch_params = params;
    launch_params["launchTicket"] = preview["launch_ticket"].clone();
    let plan = runtime.take_agent_launch(launch_params).unwrap();
    // The recorded selection is exactly what invocation launched, so the
    // resume after an app restart reapplies auto instead of dropping the
    // Session back to Claude's ask-every-time mode.
    assert_eq!(
        effective_launch_selection(&plan),
        termloop_domain::AgentLaunchSelection::new("default", "acceptEdits", "default")
    );
    let args = plan.prepared_launch.as_ref().unwrap().args().join(" ");
    assert!(args.contains("--permission-mode auto"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn project_agent_ticket_keeps_the_exact_once_resolved_private_payload() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-project-agent-private-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let mut transport = crate::test_agent_observation_transport_with_claude_settings(
        root.join("provider"),
        "{\"exact\":\"first-private-value\"}",
        "{\"exact\":\"<redacted>\"}",
    );
    transport.endpoint = "ws://preview-authority".into();
    transport.agents.remove("codex");
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);
    let params = json!({"projectId":project["id"],"cwd":root,"agentId":"claude"});
    let preview = runtime.preview_agent_launch(params.clone()).unwrap();
    runtime
        .observation_transport
        .as_mut()
        .unwrap()
        .replace_test_inline_settings(
            "claude",
            "{\"exact\":\"second-private-value\"}",
            "{\"exact\":\"<redacted>\"}",
        );
    let mut launch_params = params;
    launch_params["launchTicket"] = preview["launch_ticket"].clone();
    let plan = runtime.take_agent_launch(launch_params).unwrap();
    let args = plan.prepared_launch.as_ref().unwrap().args().join(" ");
    assert!(args.contains("first-private-value"));
    assert!(!args.contains("second-private-value"));
    assert!(!preview.to_string().contains("first-private-value"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn project_agent_preview_resolves_saved_quick_action_options_without_a_message() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-project-agent-options-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
    let project = runtime
        .handle("project.create", json!({"name":"Demo","folderPath":root}))
        .unwrap();
    let params = json!({
        "projectId":project["id"], "cwd":root, "agentId":"codex",
        "model":"gpt-5.6-sol", "permission":"plan", "reasoning":"high"
    });
    let preview = runtime.preview_agent_launch(params.clone()).unwrap();
    assert_eq!(preview["manifest"]["target"]["model"], "gpt-5.6-sol");
    assert_eq!(preview["manifest"]["target"]["permission"], "plan");
    assert_eq!(preview["manifest"]["target"]["reasoning"], "high");
    assert_eq!(preview["manifest"]["transport"]["kind"], "none");
    assert!(
        preview["manifest"]["content_parts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let mut launch_params = params;
    launch_params["launchTicket"] = preview["launch_ticket"].clone();
    let plan = runtime.take_agent_launch(launch_params).unwrap();
    assert_eq!(
        effective_launch_selection(&plan),
        termloop_domain::AgentLaunchSelection::new("gpt-5.6-sol", "plan", "high")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn task_agent_options_use_the_same_validated_preset_shape_as_project_launches() {
    let options = interactive_agent_options(
        &json!({
            "model":"gpt-5.6-sol", "permission":"plan", "reasoning":"high"
        }),
        "codex",
    )
    .unwrap()
    .unwrap();
    assert_eq!(options.model, "gpt-5.6-sol");
    assert_eq!(options.permission, "plan");
    assert_eq!(options.reasoning, "high");
    assert!(matches!(
        interactive_agent_options(
            &json!({"model":"gpt-5.6-sol", "permission":"plan"}),
            "codex"
        ),
        Err(CoreError::InvalidParams(field)) if field == "agent launch options"
    ));
}

#[test]
fn agent_environment_never_enters_the_durable_session_descriptor() {
    let launch = termloop_invocation::interactive_agent_with_observation(
        "claude",
        "/tmp/project",
        Some(termloop_invocation::AgentObservationLaunch {
            session_id: "session-secret-test",
            endpoint: "http://127.0.0.1:1234/agent-observation",
            token: "durable-secret-nonce",
            transport: termloop_invocation::AgentObservationLaunchTransport::InlineSettings {
                content: "{\"hooks\":{}}",
                inspectable_content: "{\"hooks\":{}}",
            },
        }),
    )
    .unwrap();
    let private_id = "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035";
    let session = SessionRecord {
        launch_selection: Default::default(),
        id: "session-secret-test".into(),
        project_id: "project-1".into(),
        name: None,
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: launch.program().into(),
            args: vec!["--resume".into(), private_id.into()],
            cwd: "/tmp".into(),
            agent_id: Some("claude".into()),
            template_ref: Some(launch.provenance().template_ref.clone()),
            template_version: Some(launch.provenance().template_version),
        },
        lifecycle_state: "running".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: ResumeRef::for_provider(ResumeProvider::Claude, private_id.into()),
        resume_launch_guard: None,
        resume_failure: None,
    };
    let durable_json = serde_json::to_string(&session).unwrap();
    assert!(durable_json.contains(private_id));
    assert!(!durable_json.contains("durable-secret-nonce"));
    assert!(!durable_json.contains("TERMLOOP_HOOK_TOKEN"));
    assert!(!durable_json.contains("environment"));
    let public = super::lifecycle::session_projection(&session, false, None, None);
    assert!(!public.to_string().contains(private_id));
    assert_eq!(public.pointer("/process/args"), Some(&json!([])));

    let mut improver = session;
    improver.process.template_ref = Some("builtin.improver.routine-instructions".into());
    improver.improver_target = Some(termloop_domain::ImproverSessionTarget {
        target_kind: termloop_domain::ImproverSessionTargetKind::RoutineInstructions,
        target_id: Some("routine-1".into()),
    });
    let public = super::lifecycle::session_projection(&improver, false, None, None);
    assert_eq!(
        public.pointer("/improver_target/targetKind"),
        Some(&json!("routineInstructions"))
    );
    assert_eq!(
        public.pointer("/improver_target/targetId"),
        Some(&json!("routine-1"))
    );
}

#[test]
fn agent_fork_plan_derives_private_source_context_without_persisting_a_parent() {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-agent-fork-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&path).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 7).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&std::env::temp_dir())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let project = runtime
        .create_project(json!({ "name": "Fork", "folderPath": cwd }))
        .unwrap();
    let project_id = project["id"].as_str().unwrap().to_owned();
    let private_source_id = Uuid::new_v4().to_string();
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "fable",
                    "bypassPermissions",
                    "high",
                ),
                id: "source-agent".into(),
                project_id,
                name: Some("Source".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    private_source_id.clone(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let projected_without_provider_capability = runtime.list_sessions().unwrap();
    assert_eq!(projected_without_provider_capability[0]["forkable"], true);
    let mut transport = crate::test_agent_observation_transport(std::env::temp_dir());
    transport.agents.remove("codex");
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    let plan = runtime
        .plan_agent_fork(json!({ "sessionId": "source-agent" }))
        .unwrap();
    assert_eq!(plan.project_id, runtime.store.sessions()[0].project_id);
    assert_eq!(plan.cwd, cwd);
    assert_eq!(
        effective_launch_selection(&plan),
        runtime.store.sessions()[0].launch_selection
    );
    assert_eq!(plan.agent_id, "claude");
    assert_eq!(plan.fork_source_session_id.as_deref(), Some("source-agent"));
    assert_eq!(
        plan.fork_source_ref.as_ref().unwrap().native_session_id,
        private_source_id
    );
    assert!(plan.resume_ref.is_none());
    assert_eq!(plan.fork_name.as_deref(), Some("Source fork-1"));
    let mut long_named_source = runtime.store.sessions()[0].clone();
    long_named_source.name = Some("ü".repeat(80));
    let bounded_name = super::fork_session_name(&long_named_source, "claude");
    assert_eq!(bounded_name.chars().count(), 80);
    assert!(bounded_name.ends_with(" fork-1"));
    assert_eq!(runtime.store.sessions().len(), 1);
    let projected = runtime.list_sessions().unwrap();
    assert_eq!(projected[0]["forkable"], true);
    assert!(!projected.to_string().contains(&private_source_id));

    let mut fork_child = runtime.store.sessions()[0].clone();
    fork_child.id = "fork-child".into();
    fork_child.name = Some("Source fork-1".into());
    runtime
        .fork_source_session_ids
        .insert(fork_child.id.clone(), "source-agent".into());
    let fork_projection = runtime.project_session(&fork_child);
    assert_eq!(fork_projection["fork_source_session_id"], "source-agent");

    runtime
        .store
        .mark_session_exited(&runtime.write_authority, "source-agent")
        .unwrap();
    let mut transport = crate::test_agent_observation_transport(std::env::temp_dir());
    transport.agents.remove("codex");
    let claude = transport.agents.get_mut("claude").unwrap();
    claude.native_fork_supported = false;
    claude.mcp_http_supported = false;
    runtime.configure_agent_observations(transport);
    let projected_exited = runtime.list_sessions().unwrap();
    assert_eq!(projected_exited[0]["forkable"], true);
    assert!(
        runtime
            .plan_agent_fork(json!({ "sessionId": "source-agent" }))
            .is_ok()
    );
}

#[test]
fn agent_fork_runtime_requires_the_fresh_codex_bridge_only_for_codex() {
    assert!(super::fork_runtime_is_ready("claude", true, false));
    assert!(!super::fork_runtime_is_ready("codex", true, false));
    assert!(super::fork_runtime_is_ready("codex", true, true));
    assert!(!super::fork_runtime_is_ready("codex", false, true));
}

#[test]
fn provider_history_repair_reserves_the_exact_stopped_codex_session_and_clears_damage() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-provider-history-repair-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 7).unwrap();
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "damaged-codex".into(),
                project_id: "project-1".into(),
                name: Some("Damaged Codex".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd,
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 6,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(ResumeProvider::Codex, "native-thread".into()),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::ProviderHistoryDamaged),
            },
        )
        .unwrap();
    let mut transport = crate::test_agent_observation_transport(root.join("provider"));
    transport.agents.remove("claude");
    transport
        .agents
        .get_mut("codex")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    assert!(matches!(
        runtime.plan_provider_history_repair(json!({
            "sessionId": "damaged-codex",
            "acknowledgeHistoryRewrite": false,
        })),
        Err(CoreError::InvalidParams(_))
    ));
    let plan = runtime
        .plan_provider_history_repair(json!({
            "sessionId": "damaged-codex",
            "acknowledgeHistoryRewrite": true,
        }))
        .unwrap();
    assert_eq!(plan.session_id(), "damaged-codex");
    assert!(
        runtime
            .provider_history_repair_reservations
            .contains("damaged-codex")
    );
    assert!(matches!(
        runtime.plan_agent_resume(json!({ "sessionId": "damaged-codex" })),
        Err(CoreError::ProviderHistoryRepairUnavailable {
            reason: crate::ProviderHistoryRepairUnavailableReason::RuntimeConflict,
            ..
        })
    ));
    assert!(matches!(
        runtime.plan_agent_fork(json!({ "sessionId": "damaged-codex" })),
        Err(CoreError::AgentForkUnavailable {
            reason: crate::AgentForkUnavailableReason::RuntimeConflict,
        })
    ));

    let result = runtime
        .complete_provider_history_repair(
            plan,
            ObservedProviderHistoryRepair {
                outcome: ProviderHistoryRepairOutcome::Repaired,
                repaired_records: 12,
                duplicate_boundaries: 2,
                backup_created: true,
            },
        )
        .unwrap();
    assert_eq!(result["outcome"], "repaired");
    assert_eq!(result["repairedRecords"], 12);
    assert_eq!(result["duplicateBoundaries"], 2);
    assert_eq!(result["backupCreated"], true);
    let session = runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == "damaged-codex")
        .unwrap();
    assert_eq!(session.lifecycle_state, "exited");
    assert_eq!(session.resume_failure, None);
    assert!(
        !runtime
            .provider_history_repair_reservations
            .contains("damaged-codex")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn provider_history_damage_is_not_presented_as_a_blind_retry() {
    let session = SessionRecord {
        launch_selection: Default::default(),
        id: "damaged".into(),
        project_id: "project".into(),
        name: None,
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: "codex".into(),
            args: vec![],
            cwd: "/tmp".into(),
            agent_id: Some("codex".into()),
            template_ref: None,
            template_version: None,
        },
        lifecycle_state: "resumeFailed".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: ResumeRef::for_provider(ResumeProvider::Codex, "thread".into()),
        resume_launch_guard: None,
        resume_failure: Some(ResumeFailureReason::ProviderHistoryDamaged),
    };
    assert!(!super::lifecycle::manual_agent_resume_available(&session));
    assert!(!ResumeFailureReason::ProviderHistoryDamaged.is_retryable());
}

#[test]
fn failed_agent_fork_is_visible_and_retained_until_explicit_release_and_delete() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-agent-fork-rollback-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 7).unwrap();
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "fork-child".into(),
                project_id: "project-1".into(),
                name: Some("Source fork-1".into()),
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: root.display().to_string(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 7,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let (program, args) = termloop_platform::default_shell();
    terminal
        .spawn(PtySpawnSpec {
            session_id: "fork-child".into(),
            runtime_epoch: 7,
            program,
            args,
            cwd: root.display().to_string(),
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        })
        .unwrap();

    assert_eq!(runtime.agent_fork_readiness("fork-child", 7), Ok(false));
    assert_eq!(
        runtime.agent_fork_readiness("fork-child", 8),
        Err(crate::AgentForkUnavailableReason::RuntimeConflict)
    );
    runtime
        .store
        .establish_session_resume_ref(
            &runtime.write_authority,
            "fork-child",
            ResumeRef::for_provider(ResumeProvider::Claude, Uuid::new_v4().to_string()).unwrap(),
        )
        .unwrap();
    assert_eq!(runtime.agent_fork_readiness("fork-child", 7), Ok(true));
    runtime.pending_agent_forks.insert("fork-child".into());
    assert_eq!(runtime.list_sessions().unwrap(), serde_json::json!([]));
    runtime
        .confirm_agent_fork_conversation("fork-child", 7)
        .unwrap();
    assert_eq!(
        runtime.list_sessions().unwrap().as_array().unwrap().len(),
        1
    );
    assert_eq!(
        runtime.store.agent_conversation_readiness("fork-child"),
        Some(termloop_domain::AgentConversationReadiness::Resumable)
    );

    assert!(
        runtime
            .retain_failed_agent_fork("fork-child", 7)
            .unwrap()
            .is_none()
    );
    assert_eq!(runtime.store.sessions()[0].lifecycle_state, "exited");
    assert_eq!(
        runtime.list_sessions().unwrap().as_array().unwrap().len(),
        1
    );
    assert_eq!(
        runtime.agent_fork_readiness("fork-child", 7),
        Err(crate::AgentForkUnavailableReason::StartupExited)
    );
    assert!(terminal.contains_session("fork-child").unwrap());
    assert!(runtime.agent_terminal_holds.contains("fork-child"));
    runtime
        .release_agent_terminal_hold_for_resume("fork-child")
        .unwrap();
    runtime
        .delete_failed_agent_fork_descriptor("fork-child", 7)
        .unwrap();
    assert!(runtime.store.sessions().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn terminate_cancels_resume_preparation_and_late_failure_cannot_revive_it() {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-resume-cancel-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "opus[1m]",
                    "bypassPermissions",
                    "high",
                ),
                id: "agent-1".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd:
                        termloop_platform::canonical_existing_directory_path(&std::env::temp_dir())
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::ResumeRejected),
            },
        )
        .unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap();
    let mut transport = crate::test_agent_observation_transport(std::env::temp_dir());
    transport.agents.remove("codex");
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    let plan = match runtime
        .plan_agent_resume(json!({"sessionId":"agent-1"}))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("retry was not prepared"),
    };
    assert_ne!(plan.runtime_epoch, 2);
    assert_eq!(plan.launch_selection.permission, "bypassPermissions");
    drop(plan);
    let uncertain = runtime
        .mark_agent_resume_ownership_uncertain("agent-1")
        .unwrap();
    assert_eq!(
        uncertain["resume_failure_reason"],
        "runtimeOwnershipUncertain"
    );
    assert!(!runtime.resume_reservations.contains("agent-1"));
    let retry = runtime
        .plan_agent_resume(json!({"sessionId":"agent-1"}))
        .unwrap();
    assert!(matches!(retry, crate::AgentResumePlanOutcome::Prepare(_)));
    drop(retry);
    runtime
        .terminate_session(json!({"sessionId":"agent-1"}))
        .unwrap();
    let late = runtime
        .fail_agent_resume("agent-1", ResumeFailureReason::DaemonInterrupted)
        .unwrap();
    assert_eq!(late["lifecycle_state"], "exited");
    assert!(late["resume_failure_reason"].is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn retryable_ownership_failure_can_be_reserved_then_terminated_after_recovery() {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-close-ownership-recovery-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "agent-close".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: "/tmp".into(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::RuntimeOwnershipUncertain),
            },
        )
        .unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap();

    assert!(
        runtime
            .reserve_retryable_session_termination("agent-close")
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        runtime.reserve_retryable_session_termination("agent-close"),
        Err(CoreError::InvalidParams(field)) if field == "sessionId"
    ));
    runtime.cancel_retryable_session_termination("agent-close");
    runtime
        .reserve_retryable_session_termination("agent-close")
        .unwrap();

    let (terminated, runtime_process) = runtime
        .terminate_session(json!({"sessionId":"agent-close"}))
        .unwrap();
    assert!(runtime_process.is_none());
    assert_eq!(terminated["lifecycleState"], "exited");
    let current = runtime.list_sessions().unwrap();
    assert_eq!(current[0]["lifecycle_state"], "exited");
    assert_eq!(current[0]["closable"], true);
    assert!(current[0]["resume_failure_reason"].is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn valid_resume_ref_attempts_even_when_startup_capability_probe_was_inconclusive() {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-resume-capability-hint-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "agent-capability-hint".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd:
                        termloop_platform::canonical_existing_directory_path(&std::env::temp_dir())
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::ResumeCapabilityUnavailable),
            },
        )
        .unwrap();
    store
        .mark_agent_conversation_resumable(&authority, "agent-capability-hint")
        .unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 3).unwrap();
    let mut transport = crate::test_agent_observation_transport(std::env::temp_dir());
    transport.agents.remove("codex");
    let claude = transport.agents.get_mut("claude").unwrap();
    claude.resume_supported = false;
    claude.native_fork_supported = false;
    claude.mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    let plan = match runtime
        .plan_agent_resume(json!({"sessionId":"agent-capability-hint"}))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("valid reference was not attempted"),
    };
    assert!(plan.observation_token.is_some());
    assert_eq!(runtime.store.sessions()[0].lifecycle_state, "resuming");
    drop(plan);
    let _ = std::fs::remove_file(path);
}

#[test]
fn ticketed_manual_resume_reopens_exited_and_retries_a_prior_terminal_failure() {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-explicit-resume-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "stopped-agent".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd:
                        termloop_platform::canonical_existing_directory_path(&std::env::temp_dir())
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "previously-unavailable-agent".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd:
                        termloop_platform::canonical_existing_directory_path(&std::env::temp_dir())
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: Some(ResumeFailureReason::ProviderSessionUnavailable),
            },
        )
        .unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 3).unwrap();
    let mut transport = crate::test_agent_observation_transport(std::env::temp_dir());
    transport.agents.remove("codex");
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    let automatic = runtime
        .plan_agent_resume(json!({"sessionId": "stopped-agent"}))
        .unwrap();
    assert!(matches!(
        automatic,
        crate::AgentResumePlanOutcome::Current(_)
    ));
    assert_eq!(runtime.store.sessions()[0].lifecycle_state, "exited");
    assert_eq!(runtime.list_sessions().unwrap()[0]["retryable"], true);

    let preview = runtime
        .preview_agent_resume(json!({"sessionId": "stopped-agent"}))
        .unwrap();
    let plan = match runtime
        .plan_ticketed_agent_resume(json!({
            "sessionId": "stopped-agent",
            "launchTicket": preview["launch_ticket"],
        }))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => {
            panic!("explicit ticketed resume did not prepare the stopped Agent")
        }
    };
    assert_ne!(plan.runtime_epoch, 2);
    assert_eq!(runtime.store.sessions()[0].lifecycle_state, "resuming");
    assert_eq!(
        runtime.project_session(&runtime.store.sessions()[0])["runtime_epoch"],
        plan.runtime_epoch
    );
    assert_eq!(runtime.list_sessions().unwrap()[1]["retryable"], true);

    let retry_preview = runtime
        .preview_agent_resume(json!({"sessionId": "previously-unavailable-agent"}))
        .unwrap();
    let retry_plan = match runtime
        .plan_ticketed_agent_resume(json!({
            "sessionId": "previously-unavailable-agent",
            "launchTicket": retry_preview["launch_ticket"],
        }))
        .unwrap()
    {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => {
            panic!("explicit ticketed resume did not retry the provider conversation")
        }
    };
    assert_eq!(runtime.store.sessions()[1].lifecycle_state, "resuming");
    drop(retry_plan);
    drop(plan);
    let _ = std::fs::remove_file(path);
}

#[test]
fn guarded_resume_trusts_launch_provenance_over_current_task_state() {
    // A Session that provably launched in its exact still-present directory
    // resumes even when its Task binding, worktree generation, or
    // managed proof no longer match the stored ResumeLaunchGuard, and it
    // resumes with its exact recorded launch selection.
    let root = std::env::temp_dir().join(format!(
        "termloop-core-resume-provenance-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&worktree)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(root.join("state.json")).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "opus",
                    "bypassPermissions",
                    "high",
                ),
                id: "agent-guarded".into(),
                project_id: "project-1".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("claude".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "resumeFailed".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                // No Task with this ID, generation, or managed proof exists in
                // the store: every retired guard revalidation input is absent
                // while the exact launch directory is present.
                resume_launch_guard: Some(termloop_domain::ResumeLaunchGuard {
                    task_id: "task-retired".into(),
                    managed_worktree_operation_id: "op-retired".into(),
                    worktree_generation: 7,
                    path: cwd.clone(),
                }),
                resume_failure: Some(ResumeFailureReason::CwdUnavailable),
            },
        )
        .unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 3).unwrap();
    let mut transport = crate::test_agent_observation_transport(root.join("provider"));
    transport.agents.remove("codex");
    let claude = transport.agents.get_mut("claude").unwrap();
    claude.native_fork_supported = false;
    claude.mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    let outcome = runtime
        .plan_agent_resume(json!({"sessionId":"agent-guarded"}))
        .unwrap();
    let crate::AgentResumePlanOutcome::Prepare(plan) = outcome else {
        panic!("provenance-guarded resume was refused despite the exact directory being present");
    };
    assert_eq!(plan.session_id, "agent-guarded");
    assert_eq!(plan.cwd, cwd);
    assert_eq!(plan.launch_selection.model, "opus");
    assert_eq!(plan.launch_selection.permission, "bypassPermissions");
    assert_eq!(plan.launch_selection.reasoning, "high");
    assert!(!plan.managed_worktree_trust_for_test());
    assert!(plan.target_validation().validate().is_ok());
    assert_eq!(
        runtime
            .store
            .sessions()
            .iter()
            .find(|session| session.id == "agent-guarded")
            .unwrap()
            .lifecycle_state,
        "resuming"
    );
    drop(plan);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resume_enables_codex_trust_for_a_current_managed_worktree_proof() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-managed-resume-trust-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let worktree = root.join("managed-worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let repository_root = termloop_platform::canonical_existing_directory_path(&root)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let cwd = termloop_platform::canonical_existing_directory_path(&worktree)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap();
    let project = runtime
        .handle(
            "project.create",
            json!({"name":"Demo","folderPath":repository_root}),
        )
        .unwrap();
    let project_id = project["id"].as_str().unwrap().to_owned();
    let task = runtime
        .handle(
            "task.create",
            json!({
                "projectId": project_id,
                "title": "Managed task",
                "brief": null,
                "worktreeIntent": "none"
            }),
        )
        .unwrap();
    let task_id = task["id"].as_str().unwrap().to_owned();
    let operation_id = Uuid::new_v4().to_string();
    let branch_name = "termloop/managed-resume";
    let spec = termloop_domain::NormalizedWorktreeSpec {
        version: 1,
        repository_root: repository_root.clone(),
        repository_common_dir: root.join(".git").display().to_string(),
        destination_path: cwd.clone(),
        branch_name: branch_name.into(),
        branch_mode: termloop_domain::ProvisioningBranchMode::Create,
        base_ref: Some("refs/heads/main".into()),
        base_oid: Some("a".repeat(40)),
    };
    runtime
        .store
        .begin_task_worktree_provisioning(
            &runtime.write_authority,
            termloop_domain::WorktreeProvisioningOperation {
                operation_id: operation_id.clone(),
                task_id: task_id.clone(),
                project_id: project_id.clone(),
                spec: spec.clone(),
                stage: termloop_domain::ProvisioningStage::Reserved,
                created_branch_ref: false,
                failure: None,
                started_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    runtime
        .store
        .advance_task_worktree_provisioning(
            &runtime.write_authority,
            &task_id,
            &operation_id,
            termloop_domain::ProvisioningStage::WorktreeAdded,
            true,
            2,
        )
        .unwrap();
    runtime
        .store
        .commit_task_worktree_provisioning(
            &runtime.write_authority,
            &task_id,
            &operation_id,
            termloop_store::ProvisioningCommit {
                branch: termloop_domain::TaskBranchBinding {
                    repository_root,
                    name: branch_name.into(),
                },
                worktree: termloop_domain::TaskWorktreeBinding { path: cwd.clone() },
                proof: termloop_domain::ManagedWorktreeProof {
                    task_id: task_id.clone(),
                    operation_id: operation_id.clone(),
                    worktree_generation: 0,
                    normalized_spec_version: 1,
                    normalized_spec: spec,
                    repository_common_dir: root.join(".git").display().to_string(),
                    registered_worktree_path: cwd.clone(),
                    branch_ref: format!("refs/heads/{branch_name}"),
                },
                updated_at_epoch_ms: 3,
            },
        )
        .unwrap();
    runtime
        .store
        .clear_task_worktree_provisioning(&runtime.write_authority, &task_id, &operation_id)
        .unwrap();
    let proof = runtime
        .store
        .managed_worktrees()
        .iter()
        .find(|proof| proof.task_id == task_id)
        .unwrap()
        .clone();
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "managed-resume".into(),
                project_id,
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(4),
                },
                lifecycle_state: "stopped".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Codex,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: Some(termloop_domain::ResumeLaunchGuard {
                    task_id,
                    managed_worktree_operation_id: proof.operation_id,
                    worktree_generation: proof.worktree_generation,
                    path: cwd,
                }),
                resume_failure: None,
            },
        )
        .unwrap();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(
        root.join("provider"),
    ));

    let outcome = runtime
        .plan_agent_resume(json!({"sessionId":"managed-resume"}))
        .unwrap();
    let crate::AgentResumePlanOutcome::Prepare(plan) = outcome else {
        panic!("managed Codex resume was not prepared");
    };
    assert!(plan.managed_worktree_trust_for_test());
    let launch = plan.compose_resume_launch(None).unwrap();
    assert!(
        launch
            .args()
            .iter()
            .any(|argument| argument.contains("={trust_level=\"trusted\"}"))
    );
    drop(plan);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn cwd_unavailable_retry_revalidates_the_exact_path_before_preparing() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-resume-restored-cwd-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let restored = root.join("restored");
    let missing = root.join("missing");
    std::fs::create_dir_all(&restored).unwrap();
    let restored_cwd = termloop_platform::canonical_existing_directory_path(&restored)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let missing = missing.to_string_lossy().into_owned();
    let state = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&state).unwrap();
    for (session_id, cwd) in [
        ("agent-restored-cwd", restored_cwd.clone()),
        ("agent-missing-cwd", missing),
    ] {
        store
            .insert_session(
                &authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: session_id.into(),
                    project_id: "project-1".into(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd,
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.interactive".into()),
                        template_version: Some(1),
                    },
                    lifecycle_state: "resumeFailed".into(),
                    runtime_epoch: 2,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Claude,
                        Uuid::new_v4().to_string(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: Some(ResumeFailureReason::CwdUnavailable),
                },
            )
            .unwrap();
    }
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 3).unwrap();
    let mut transport = crate::test_agent_observation_transport(root.join("provider"));
    transport.agents.remove("codex");
    let claude = transport.agents.get_mut("claude").unwrap();
    claude.native_fork_supported = false;
    claude.mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    let missing = runtime
        .plan_agent_resume(json!({"sessionId":"agent-missing-cwd"}))
        .unwrap();
    let crate::AgentResumePlanOutcome::Current(missing) = missing else {
        panic!("missing cwd unexpectedly prepared a process");
    };
    assert_eq!(missing["resume_failure_reason"], "cwdUnavailable");
    assert_eq!(missing["retryable"], true);
    assert_eq!(missing["lifecycle_state"], "resumeFailed");

    let restored = runtime
        .plan_agent_resume(json!({"sessionId":"agent-restored-cwd"}))
        .unwrap();
    let crate::AgentResumePlanOutcome::Prepare(plan) = restored else {
        panic!("restored exact cwd did not prepare the existing conversation");
    };
    assert_eq!(plan.session_id, "agent-restored-cwd");
    assert_eq!(plan.cwd, restored_cwd);
    assert_eq!(
        runtime
            .store
            .sessions()
            .iter()
            .find(|session| session.id == "agent-restored-cwd")
            .unwrap()
            .lifecycle_state,
        "resuming"
    );
    drop(plan);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn startup_resume_admission_is_bounded_fair_and_batches_overflow() {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-resume-admission-{}-{}.json",
        std::process::id(),
        Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    for (project_id, count) in [("project-a", 70_usize), ("project-b", 1), ("project-c", 1)] {
        for index in 0..count {
            let session_id = format!("{project_id}-{index:03}");
            store
                .insert_session(
                    &authority,
                    SessionRecord {
                        launch_selection: Default::default(),
                        id: session_id.clone(),
                        project_id: project_id.into(),
                        name: None,
                        kind: SessionKind::Agent,
                        process: ProcessDescriptor {
                            program: "claude".into(),
                            args: vec![],
                            cwd: "/tmp".into(),
                            agent_id: Some("claude".into()),
                            template_ref: None,
                            template_version: None,
                        },
                        lifecycle_state: "resuming".into(),
                        runtime_epoch: 1,
                        archived_at_epoch_ms: None,
                        ask_to_source_session_id: None,
                        run_configuration_id: None,
                        improver_target: None,
                        ask_to_continuation: None,
                        resume_ref: ResumeRef::for_provider(
                            ResumeProvider::Claude,
                            Uuid::new_v4().to_string(),
                        ),
                        resume_launch_guard: None,
                        resume_failure: None,
                    },
                )
                .unwrap();
            store
                .mark_agent_conversation_resumable(&authority, &session_id)
                .unwrap();
        }
    }
    let mut runtime = CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap();
    let revision = runtime.state_revision();

    let admitted = runtime.startup_resume_session_ids().unwrap();

    assert_eq!(admitted.len(), 68);
    assert_eq!(admitted[0].session_id(), "project-a-000");
    assert_eq!(admitted[1].session_id(), "project-b-000");
    assert_eq!(admitted[2].session_id(), "project-c-000");
    assert!(
        admitted
            .iter()
            .all(|candidate| candidate.lane() == AgentResumeLane::Ordinary)
    );
    assert_eq!(runtime.state_revision(), revision + 1);
    assert_eq!(
        runtime
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.resume_failure == Some(ResumeFailureReason::ResumeQueueFull)
            })
            .count(),
        4
    );
    assert_eq!(
        runtime
            .store
            .sessions()
            .iter()
            .filter(|session| session.lifecycle_state == "resuming")
            .count(),
        68
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn prepared_resume_target_is_revalidated_before_final_commit() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-resume-revalidate-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd = termloop_platform::canonical_existing_directory_path(&cwd)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let state = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&state).unwrap();
    let resume_ref =
        ResumeRef::for_provider(ResumeProvider::Claude, Uuid::new_v4().to_string()).unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "agent-revalidate".into(),
                project_id: "project-a".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "resuming".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: Some(resume_ref.clone()),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    store
        .mark_agent_conversation_resumable(&authority, "agent-revalidate")
        .unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 2).unwrap();
    runtime
        .resume_reservations
        .insert("agent-revalidate".into());
    runtime.resume_ready.insert("agent-revalidate".into());
    runtime
        .agent_conversation_activity
        .insert("agent-revalidate".into());
    let cwd_identity =
        termloop_platform::existing_directory_comparison_input(std::path::Path::new(&cwd)).unwrap();
    let plan = crate::AgentResumePlan {
        session_id: "agent-revalidate".into(),
        project_id: "project-a".into(),
        cwd: cwd.clone(),
        cwd_identity,
        agent_id: "claude".into(),
        launch_selection: Default::default(),
        resume_ref,
        launch_guard: None,
        managed_worktree_trust: false,
        observation_token: None,
        mcp_token: None,
        mcp_role: None,
        worker_prompt: None,
        worker_system_prompt: None,
        steward_system_prompt: None,
        mcp_authorizer: runtime.mcp_authorizer.clone(),
        observation_transport: {
            let mut transport = crate::test_agent_observation_transport(root.join("provider"));
            transport.agents.remove("codex");
            transport
                .agents
                .get_mut("claude")
                .unwrap()
                .mcp_http_supported = false;
            transport
        },
        preparation_kind: AgentResumePreparationKind::Resume,
        prepared_launch: None,
        pending_generated_input: None,
        runtime_signal_sender: None,
        codex_runtime: None,
        terminal: terminal.clone(),
        runtime_epoch: 2,
        pty_spawned: false,
        committed: false,
        shutdown: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        cancellation: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        relocation: None,
    };
    std::fs::remove_dir_all(&cwd).unwrap();

    assert_eq!(
        plan.target_validation().validate(),
        Err(crate::AgentResumePreparationError::TargetUnavailable)
    );
    let current = runtime
        .fail_agent_resume("agent-revalidate", ResumeFailureReason::CwdUnavailable)
        .unwrap();

    assert_eq!(current["lifecycle_state"], "resumeFailed");
    assert_eq!(current["resume_failure_reason"], "cwdUnavailable");
    assert_eq!(current["runtime_epoch"], 1);
    assert!(
        runtime
            .agent_conversation_activity
            .contains("agent-revalidate")
    );
    assert!(!terminal.contains_session("agent-revalidate").unwrap());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn client_launch_restart_reserves_then_reaps_the_exact_live_runtime() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-client-launch-restart-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory(&root.display().to_string())
        .unwrap()
        .display()
        .to_string();
    let state = root.join("state.json");
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&state).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 2).unwrap();
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: termloop_domain::AgentLaunchSelection::new(
                    "opus[1m]",
                    "bypassPermissions",
                    "high",
                ),
                id: "live-agent".into(),
                project_id: "project-a".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let (program, args) = termloop_platform::default_shell();
    terminal
        .spawn(PtySpawnSpec {
            session_id: "live-agent".into(),
            runtime_epoch: 2,
            program,
            args,
            cwd,
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        })
        .unwrap();
    let mut transport = crate::test_agent_observation_transport(root.join("provider"));
    transport.agents.remove("codex");
    transport
        .agents
        .get_mut("claude")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    let preview = runtime
        .preview_agent_resume(json!({ "sessionId": "live-agent" }))
        .unwrap();
    assert_eq!(preview["manifest"]["target"]["model"], "opus[1m]");
    assert_eq!(
        preview["manifest"]["target"]["permission"],
        "bypassPermissions"
    );
    assert_eq!(preview["manifest"]["target"]["reasoning"], "high");

    let outcome = runtime
        .plan_running_agent_restart(json!({ "sessionId": "live-agent" }), 100)
        .unwrap();
    let plan = match outcome {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan,
        crate::AgentResumePlanOutcome::Current(_) => panic!("live agent was not reserved"),
    };
    assert_ne!(plan.runtime_epoch, 2);
    assert_eq!(plan.launch_selection.permission, "bypassPermissions");
    assert_eq!(runtime.store.sessions()[0].lifecycle_state, "resuming");
    assert!(
        runtime.agent_observations["live-agent"]
            .observation
            .is_none()
    );
    assert!(terminal.contains_session("live-agent").unwrap());
    drop(plan);
    assert!(!terminal.contains_session("live-agent").unwrap());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn client_launch_restart_marks_only_a_working_codex_interrupted() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-client-launch-interrupted-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory(&root.display().to_string())
        .unwrap()
        .display()
        .to_string();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 2).unwrap();
    let mut transport = crate::test_agent_observation_transport(root.join("provider"));
    transport.agents.remove("claude");
    transport
        .agents
        .get_mut("codex")
        .unwrap()
        .mcp_http_supported = false;
    runtime.configure_agent_observations(transport);

    for (session_id, initial_signal) in [
        ("working-codex", termloop_agents::AgentSignal::ToolStarted),
        ("idle-codex", termloop_agents::AgentSignal::Stopped),
    ] {
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: session_id.into(),
                    project_id: "project-a".into(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: cwd.clone(),
                        agent_id: Some("codex".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 2,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Codex,
                        format!("thread-{session_id}"),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        let (program, args) = termloop_platform::default_shell();
        terminal
            .spawn(PtySpawnSpec {
                session_id: session_id.into(),
                runtime_epoch: 2,
                program,
                args,
                cwd: cwd.clone(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: false,
            })
            .unwrap();
        runtime.agent_observations.insert(
            session_id.into(),
            crate::AgentObservationCapability {
                token: None,
                runtime_epoch: 2,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: None,
                pending_generated_input: None,
            },
        );
        let sequence = runtime.next_observation_sequence().unwrap();
        runtime
            .record_app_server_observation(session_id, 2, initial_signal, sequence, 50)
            .unwrap();
    }

    let working_plan = runtime
        .plan_running_agent_restart(json!({ "sessionId": "working-codex" }), 100)
        .unwrap();
    let interrupted = runtime.agent_observations["working-codex"]
        .observation
        .unwrap();
    assert_eq!(interrupted.state, termloop_agents::AgentState::Interrupted);
    assert_eq!(
        interrupted.source,
        termloop_agents::AgentSignalSource::Process
    );
    assert_eq!(interrupted.observed_at_epoch_ms, 100);

    let idle_plan = runtime
        .plan_running_agent_restart(json!({ "sessionId": "idle-codex" }), 101)
        .unwrap();
    assert!(
        runtime.agent_observations["idle-codex"]
            .observation
            .is_none()
    );

    drop(working_plan);
    drop(idle_plan);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn daemon_restart_handoff_interrupts_working_claude_and_codex() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-daemon-restart-handoff-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let state_path = root.join("state.json");
    let cwd = termloop_platform::canonical_existing_directory(&root.display().to_string())
        .unwrap()
        .display()
        .to_string();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&state_path).unwrap();
    let terminal = TerminalService::default();
    let mut previous = CoreRuntime::new(store, authority, terminal.clone(), 41).unwrap();
    let mut observation_transport = crate::test_agent_observation_transport(root.join("provider"));
    for capability in observation_transport.agents.values_mut() {
        capability.mcp_http_supported = false;
    }
    previous.configure_agent_observations(observation_transport.clone());

    for (session_id, agent_id, provider) in [
        ("working-claude", "claude", ResumeProvider::Claude),
        ("working-codex-daemon", "codex", ResumeProvider::Codex),
        ("stale-codex-daemon", "codex", ResumeProvider::Codex),
    ] {
        previous
            .store
            .insert_session(
                &previous.write_authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: session_id.into(),
                    project_id: "project-a".into(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: agent_id.into(),
                        args: vec![],
                        cwd: cwd.clone(),
                        agent_id: Some(agent_id.into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 41,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        provider,
                        if provider == ResumeProvider::Claude {
                            Uuid::new_v4().to_string()
                        } else {
                            format!("native-{session_id}")
                        },
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        previous
            .store
            .mark_agent_conversation_resumable(&previous.write_authority, session_id)
            .unwrap();
        previous.agent_observations.insert(
            session_id.into(),
            crate::AgentObservationCapability {
                token: None,
                runtime_epoch: 41,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: Some(termloop_agents::AgentObservation {
                    state: termloop_agents::AgentState::Working,
                    source: if agent_id == "claude" {
                        termloop_agents::AgentSignalSource::Hook
                    } else {
                        termloop_agents::AgentSignalSource::DaemonBridge
                    },
                    sequence: 1,
                    observed_at_epoch_ms: 100,
                }),
                pending_generated_input: None,
            },
        );
        let (program, args) = termloop_platform::default_shell();
        terminal
            .spawn(PtySpawnSpec {
                session_id: session_id.into(),
                runtime_epoch: 41,
                program,
                args,
                cwd: cwd.clone(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: false,
            })
            .unwrap();
    }
    let mut handoffs = previous.capture_daemon_restart_handoff();
    assert_eq!(handoffs.len(), 3);
    handoffs
        .iter_mut()
        .find(|handoff| handoff.session_id == "stale-codex-daemon")
        .unwrap()
        .runtime_epoch = 40;
    terminal.terminate_all().unwrap();
    drop(previous);

    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(&state_path).unwrap();
    let mut restarted = CoreRuntime::new(store, authority, TerminalService::default(), 42).unwrap();
    // The previous daemon already proved resume and exported the handoff. A
    // transient CLI probe failure during the new daemon's discovery must not
    // discard the status seed for providers with global resume identity.
    for capability in observation_transport.agents.values_mut() {
        capability.resume_supported = false;
    }
    restarted.configure_agent_observations(observation_transport);
    restarted.install_daemon_restart_handoff(handoffs);

    let claude_plan = restarted
        .plan_daemon_restart_agent_resume(json!({"sessionId": "working-claude"}), 200)
        .unwrap();
    let claude = restarted.agent_observations["working-claude"]
        .observation
        .unwrap();
    assert_eq!(claude.state, termloop_agents::AgentState::Interrupted);
    assert_eq!(claude.source, termloop_agents::AgentSignalSource::Process);
    let claude_token = match &claude_plan {
        crate::AgentResumePlanOutcome::Prepare(plan) => plan.observation_token.clone().unwrap(),
        crate::AgentResumePlanOutcome::Current(_) => panic!("Claude resume was not prepared"),
    };
    let claude_native_session_id = restarted
        .store
        .sessions()
        .iter()
        .find(|session| session.id == "working-claude")
        .unwrap()
        .resume_ref
        .as_ref()
        .unwrap()
        .native_session_id
        .clone();
    assert!(
        !restarted
            .record_claude_resume_ref(&claude_token, "working-claude", &claude_native_session_id,)
            .unwrap()
    );

    let codex_plan = restarted
        .plan_daemon_restart_agent_resume(json!({"sessionId": "working-codex-daemon"}), 201)
        .unwrap();
    let codex = restarted.agent_observations["working-codex-daemon"]
        .observation
        .unwrap();
    assert_eq!(codex.state, termloop_agents::AgentState::Interrupted);
    assert_eq!(codex.source, termloop_agents::AgentSignalSource::Process);

    let stale_plan = restarted
        .plan_daemon_restart_agent_resume(json!({"sessionId": "stale-codex-daemon"}), 202)
        .unwrap();
    assert!(
        restarted.agent_observations["stale-codex-daemon"]
            .observation
            .is_none()
    );

    drop(claude_plan);
    drop(codex_plan);
    drop(stale_plan);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn client_launch_restart_snapshot_is_exact_fair_and_larger_than_one_wave() {
    let root = std::env::temp_dir().join(format!(
        "termloop-core-client-launch-waves-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = termloop_platform::canonical_existing_directory(&root.display().to_string())
        .unwrap()
        .display()
        .to_string();
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let store = Store::open(root.join("state.json")).unwrap();
    let terminal = TerminalService::default();
    let mut runtime = CoreRuntime::new(store, authority, terminal.clone(), 2).unwrap();
    for index in 0..69 {
        let session_id = format!("live-agent-{index:02}");
        runtime
            .agent_conversation_activity
            .insert(session_id.clone());
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: session_id.clone(),
                    project_id: format!("project-{}", index % 3),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd: cwd.clone(),
                        agent_id: Some("claude".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 2,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Claude,
                        Uuid::new_v4().to_string(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        runtime
            .store
            .mark_agent_conversation_resumable(&runtime.write_authority, &session_id)
            .unwrap();
        let (program, args) = termloop_platform::default_shell();
        terminal
            .spawn(PtySpawnSpec {
                session_id,
                runtime_epoch: 2,
                program,
                args,
                cwd: cwd.clone(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: false,
            })
            .unwrap();
    }
    runtime
        .store
        .insert_session(
            &runtime.write_authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "inactive-agent".into(),
                project_id: "project-0".into(),
                name: None,
                kind: SessionKind::Agent,
                process: ProcessDescriptor {
                    program: "claude".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("claude".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 2,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: ResumeRef::for_provider(
                    ResumeProvider::Claude,
                    Uuid::new_v4().to_string(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let (program, args) = termloop_platform::default_shell();
    terminal
        .spawn(PtySpawnSpec {
            session_id: "inactive-agent".into(),
            runtime_epoch: 2,
            program,
            args,
            cwd: cwd.clone(),
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        })
        .unwrap();

    let snapshot = runtime.client_launch_restart_snapshot().unwrap();
    assert_eq!(snapshot.len(), 69);
    assert!(
        snapshot
            .iter()
            .all(|candidate| candidate.session_id() != "inactive-agent")
    );
    assert_eq!(snapshot[0].project_id(), "project-0");
    assert_eq!(snapshot[1].project_id(), "project-1");
    assert_eq!(snapshot[2].project_id(), "project-2");
    assert_eq!(
        snapshot
            .iter()
            .map(AgentResumeCandidate::session_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        69
    );

    terminal.terminate_all().unwrap();
    let _ = std::fs::remove_dir_all(root);
}
