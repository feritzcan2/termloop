use serde_json::{Value, json};
use termloop_domain::SessionKind;

use crate::{CoreError, CoreRuntime, terminal_error};

impl CoreRuntime {
    pub fn request_agent_ask_to(
        &mut self,
        source_session_id: &str,
        target_agent_id: &str,
    ) -> Result<Value, CoreError> {
        let source_epoch = self.menu_coordination_source_epoch(source_session_id)?;
        if !termloop_agents::supports_tracked_helpers(target_agent_id) {
            return Err(CoreError::InvalidParams("targetAgentId".into()));
        }
        let prompt = termloop_invocation::agent_menu_ask_to_prompt(target_agent_id)
            .map_err(|_| CoreError::InvalidParams("targetAgentId".into()))?;
        self.deliver_menu_coordination_prompt(source_session_id, source_epoch, &prompt)?;
        Ok(json!({ "sessionId": source_session_id, "status": "submitting" }))
    }

    pub fn request_agent_handover_to(
        &mut self,
        source_session_id: &str,
        target_session_id: &str,
    ) -> Result<Value, CoreError> {
        let source_epoch = self.menu_coordination_source_epoch(source_session_id)?;
        if source_session_id == target_session_id
            || uuid::Uuid::parse_str(target_session_id).is_err()
        {
            return Err(CoreError::InvalidParams("targetSessionId".into()));
        }
        let target = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == target_session_id)
            .filter(|session| {
                session.kind == SessionKind::Agent
                    && session.lifecycle_state == "running"
                    && session
                        .process
                        .agent_id
                        .as_deref()
                        .is_some_and(termloop_agents::supports_generated_input_coordination)
            })
            .ok_or(CoreError::NotFound)?;
        if !self
            .terminal
            .session_is_running(target_session_id, target.runtime_epoch)
            .map_err(terminal_error)?
        {
            return Err(CoreError::NotFound);
        }
        let prompt = termloop_invocation::agent_menu_handover_to_prompt(target_session_id)
            .map_err(|_| CoreError::InvalidParams("targetSessionId".into()))?;
        self.deliver_menu_coordination_prompt(source_session_id, source_epoch, &prompt)?;
        Ok(json!({ "sessionId": source_session_id, "status": "submitting" }))
    }

    fn menu_coordination_source_epoch(&self, source_session_id: &str) -> Result<u64, CoreError> {
        let source = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == source_session_id)
            .filter(|session| {
                session.kind == SessionKind::Agent
                    && session.lifecycle_state == "running"
                    && session
                        .process
                        .agent_id
                        .as_deref()
                        .is_some_and(termloop_agents::supports_generated_input_coordination)
            })
            .ok_or(CoreError::NotFound)?;
        let role = self
            .mcp_authorizer
            .role_for_session(source_session_id, source.runtime_epoch)?;
        if !matches!(
            role,
            super::AgentMcpRole::Interactive
                | super::AgentMcpRole::Improver { .. }
                | super::AgentMcpRole::Helper { .. }
        ) {
            return Err(CoreError::CapabilityDenied);
        }
        Ok(source.runtime_epoch)
    }

    fn deliver_menu_coordination_prompt(
        &mut self,
        source_session_id: &str,
        _source_epoch: u64,
        prompt: &termloop_invocation::AskToTerminalPrompt,
    ) -> Result<(), CoreError> {
        self.submit_generated_terminal_input(source_session_id, prompt.terminal_submission())
    }

    pub fn send_to_agent(
        &mut self,
        token: &str,
        target_session_id: &str,
        message: &str,
    ) -> Result<Value, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        let source = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == principal.session_id()
                    && session.kind == SessionKind::Agent
                    && session.lifecycle_state == "running"
                    && session.runtime_epoch == principal.runtime_epoch()
            })
            .ok_or(CoreError::CapabilityDenied)?;
        if source.id == target_session_id {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        if uuid::Uuid::parse_str(target_session_id).is_err() {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        let target = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == target_session_id)
            .ok_or(CoreError::NotFound)?;
        if target.kind != SessionKind::Agent
            || target.lifecycle_state != "running"
            || !target
                .process
                .agent_id
                .as_deref()
                .is_some_and(termloop_agents::supports_generated_input_coordination)
        {
            return Err(CoreError::NotFound);
        }
        if self
            .agent_observations
            .get(target_session_id)
            .and_then(|capability| capability.observation)
            .is_some_and(|observation| observation.state == termloop_agents::AgentState::Failed)
        {
            return Ok(json!({
                "sessionId": target_session_id,
                "status": "failed",
                "reason": "targetAgentTurnFailed",
                "suggestedAction": "waitForUser",
                "message": "The target Agent's previous turn failed. No message was delivered. Do not retry or take further action; wait for the user to respond."
            }));
        }
        let prompt = termloop_invocation::agent_handoff_prompt(principal.session_id(), message)
            .map_err(|_| CoreError::InvalidParams("message".into()))?;
        self.submit_generated_terminal_input(target_session_id, prompt.terminal_submission())?;
        Ok(json!({ "sessionId": target_session_id, "status": "submitting" }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AgentObservationCapability;
    use crate::GeneratedInputDeliveryState;
    use crate::session_launch::AgentMcpRole;
    use std::io::{Read, Write};
    use std::sync::mpsc::Receiver;
    use std::time::Duration;
    use termloop_domain::{ProcessDescriptor, SessionRecord};
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::{PtySpawnSpec, TerminalEvent, TerminalService, TerminalSubscription};
    use uuid::Uuid;

    const SOURCE_ID: &str = "123e4567-e89b-42d3-a456-426614174000";
    const TARGET_ID: &str = "123e4567-e89b-42d3-a456-426614174001";

    async fn await_handoff_fixture_ready(
        terminal: &TerminalService,
        session_id: &str,
        output: &mut TerminalSubscription,
    ) {
        let mut bytes = Vec::new();
        let mut answered_cursor_position_queries = 0;
        let mut response_show_cursor_baseline = None;
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let TerminalEvent::Output(chunk) = output.recv().await.unwrap() {
                    bytes.extend(chunk);
                    let observed_queries = bytes
                        .windows(b"\x1b[6n".len())
                        .filter(|window| *window == b"\x1b[6n")
                        .count();
                    let show_cursor_count = bytes
                        .windows(b"\x1b[?25h".len())
                        .filter(|window| *window == b"\x1b[?25h")
                        .count();
                    while answered_cursor_position_queries < observed_queries {
                        response_show_cursor_baseline.get_or_insert(show_cursor_count);
                        terminal.input_user(session_id, 17, b"\x1b[1;1R").unwrap();
                        answered_cursor_position_queries += 1;
                    }
                    let fixture_ready = bytes
                        .windows(b"\x1b[?2026l".len())
                        .any(|window| window == b"\x1b[?2026l");
                    let response_consumed = response_show_cursor_baseline.is_none_or(|baseline| {
                        bytes
                            .windows(b"\x1b[?25h".len())
                            .filter(|window| *window == b"\x1b[?25h")
                            .count()
                            > baseline
                    });
                    if fixture_ready && response_consumed {
                        break;
                    }
                }
            }
        })
        .await
        .expect("handoff fixture did not become terminal-input ready");
    }

    #[test]
    fn handoff_target_fixture() {
        if std::env::var_os("TERMLOOP_TEST_AGENT_HANDOFF_TARGET").is_none() {
            return;
        }
        let _terminal_input_mode = termloop_platform::configure_headless_terminal_input_fixture()
            .expect("handoff fixture must configure its PTY input mode");
        println!(
            "\x1b[?1049h\x1b[?2004h\x1b[?2026h\x1b[20;1H\x1b[K›\
             \x1b[?25h\x1b[20;3H\x1b[?2026l"
        );
        std::io::stdout().flush().unwrap();
        let mut input = std::io::stdin().lock();
        let mut buffer = [0_u8; 1024];
        while input.read(&mut buffer).unwrap() != 0 {
            println!("\x1b[?25h");
            std::io::stdout().flush().unwrap();
        }
    }

    fn agent_session(id: &str, project_id: &str, cwd: &str) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            project_id: project_id.into(),
            name: None,
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: "codex".into(),
                args: vec![],
                cwd: cwd.into(),
                agent_id: Some("codex".into()),
                template_ref: Some("builtin.agent.interactive".into()),
                template_version: Some(4),
            },
            lifecycle_state: "running".into(),
            runtime_epoch: 17,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: None,
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: None,
            resume_launch_guard: None,
            resume_failure: None,
            launch_selection: Default::default(),
        }
    }

    fn idle_observation() -> termloop_agents::AgentObservation {
        termloop_agents::AgentObservation {
            state: termloop_agents::AgentState::Idle,
            source: termloop_agents::AgentSignalSource::DaemonBridge,
            sequence: 1,
            observed_at_epoch_ms: 1,
        }
    }

    fn confirm_delivery(
        runtime: &mut CoreRuntime,
        events: &Receiver<crate::GeneratedInputRuntimeEvent>,
        session_id: &str,
        provider_sequence: u64,
    ) {
        confirm_delivery_state(
            runtime,
            events,
            session_id,
            provider_sequence,
            GeneratedInputDeliveryState::Confirmed,
        );
    }

    fn confirm_delivery_and_start_next(
        runtime: &mut CoreRuntime,
        events: &Receiver<crate::GeneratedInputRuntimeEvent>,
        session_id: &str,
        provider_sequence: u64,
    ) {
        confirm_delivery_state(
            runtime,
            events,
            session_id,
            provider_sequence,
            GeneratedInputDeliveryState::WritingPaste,
        );
    }

    fn confirm_delivery_state(
        runtime: &mut CoreRuntime,
        events: &Receiver<crate::GeneratedInputRuntimeEvent>,
        session_id: &str,
        provider_sequence: u64,
        expected_state: GeneratedInputDeliveryState,
    ) {
        assert!(
            !runtime
                .confirm_generated_input_submission(session_id, 17, provider_sequence,)
                .unwrap()
        );
        let event = events
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| {
                panic!(
                    "handoff delivery did not emit a transport event; state={:?} failure={:?} readiness={:?} readiness_diagnostics={:?}",
                    runtime.generated_input_delivery_state(session_id, 17),
                    runtime.generated_input_delivery_failure(session_id, 17),
                    runtime
                        .terminal
                        .input_readiness_snapshot(session_id, 17)
                        .map(|snapshot| snapshot.facts()),
                    runtime
                        .terminal
                        .input_readiness_snapshot(session_id, 17)
                        .map(|snapshot| snapshot.diagnostics()),
                )
            });
        assert!(runtime.record_generated_input_runtime_event(event).unwrap());
        assert_eq!(
            runtime.generated_input_delivery_state(session_id, 17),
            Some(expected_state)
        );
    }

    #[tokio::test]
    async fn exact_running_agent_can_receive_cross_project_handoff() {
        let root = std::env::temp_dir().join(format!(
            "termloop-core-agent-handoff-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let source_folder = root.join("source");
        let target_folder = root.join("target-worktree");
        std::fs::create_dir_all(&source_folder).unwrap();
        std::fs::create_dir_all(&target_folder).unwrap();
        let state_path = root.join("state.json");
        let terminal = TerminalService::default();
        let mut runtime = CoreRuntime::new(
            Store::open(&state_path).unwrap(),
            issue_core_write_authority_for_composition(),
            terminal.clone(),
            // A same-daemon Session restart owns its own fresh PTY epoch; it
            // must not be rejected merely because it differs from the daemon
            // generation.
            9,
        )
        .unwrap();
        let source_project = runtime
            .handle(
                "project.create",
                json!({"name":"Source","folderPath":source_folder}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let target_project = runtime
            .handle(
                "project.create",
                json!({"name":"Target","folderPath":target_folder}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                agent_session(SOURCE_ID, &source_project, &source_folder.to_string_lossy()),
            )
            .unwrap();
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                agent_session(TARGET_ID, &target_project, &target_folder.to_string_lossy()),
            )
            .unwrap();
        runtime.mcp_authorizer.register(
            SOURCE_ID.into(),
            17,
            AgentMcpRole::Interactive,
            "source-token".into(),
        );
        runtime.agent_observations.insert(
            SOURCE_ID.into(),
            AgentObservationCapability {
                token: None,
                runtime_epoch: 17,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: Some(idle_observation()),
                pending_generated_input: None,
            },
        );
        runtime.agent_observations.insert(
            TARGET_ID.into(),
            AgentObservationCapability {
                token: None,
                runtime_epoch: 17,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: Some(termloop_agents::AgentObservation {
                    state: termloop_agents::AgentState::Failed,
                    source: termloop_agents::AgentSignalSource::Hook,
                    sequence: 1,
                    observed_at_epoch_ms: 1,
                }),
                pending_generated_input: None,
            },
        );
        assert_eq!(
            runtime
                .send_to_agent("source-token", TARGET_ID, "Do not deliver this message.")
                .unwrap(),
            json!({
                "sessionId": TARGET_ID,
                "status": "failed",
                "reason": "targetAgentTurnFailed",
                "suggestedAction": "waitForUser",
                "message": "The target Agent's previous turn failed. No message was delivered. Do not retry or take further action; wait for the user to respond."
            })
        );
        runtime
            .agent_observations
            .get_mut(TARGET_ID)
            .unwrap()
            .observation = Some(idle_observation());
        terminal
            .spawn(PtySpawnSpec {
                session_id: TARGET_ID.into(),
                runtime_epoch: 17,
                program: std::env::current_exe()
                    .unwrap()
                    .into_os_string()
                    .into_string()
                    .unwrap(),
                args: vec![
                    "--exact".into(),
                    "session_launch::agent_message::tests::handoff_target_fixture".into(),
                    "--nocapture".into(),
                ],
                cwd: target_folder.to_string_lossy().into_owned(),
                environment: termloop_platform::LaunchEnvironment::os_baseline()
                    .with_explicit("TERMLOOP_TEST_AGENT_HANDOFF_TARGET", "1"),
                recent_output_replay: true,
            })
            .unwrap();
        terminal
            .spawn(PtySpawnSpec {
                session_id: SOURCE_ID.into(),
                runtime_epoch: 17,
                program: std::env::current_exe()
                    .unwrap()
                    .into_os_string()
                    .into_string()
                    .unwrap(),
                args: vec![
                    "--exact".into(),
                    "session_launch::agent_message::tests::handoff_target_fixture".into(),
                    "--nocapture".into(),
                ],
                cwd: source_folder.to_string_lossy().into_owned(),
                environment: termloop_platform::LaunchEnvironment::os_baseline()
                    .with_explicit("TERMLOOP_TEST_AGENT_HANDOFF_TARGET", "1"),
                recent_output_replay: true,
            })
            .unwrap();
        let mut source_output = terminal.subscribe(SOURCE_ID, 17).unwrap();
        let mut target_output = terminal.subscribe(TARGET_ID, 17).unwrap();
        await_handoff_fixture_ready(&terminal, SOURCE_ID, &mut source_output).await;
        await_handoff_fixture_ready(&terminal, TARGET_ID, &mut target_output).await;
        let generated_input_events = runtime.take_generated_input_runtime_events().unwrap();

        assert_eq!(
            runtime.request_agent_ask_to(SOURCE_ID, "claude").unwrap(),
            json!({"sessionId":SOURCE_ID,"status":"submitting"})
        );
        assert_eq!(
            runtime
                .request_agent_handover_to(SOURCE_ID, TARGET_ID)
                .unwrap(),
            json!({"sessionId":SOURCE_ID,"status":"submitting"})
        );
        assert_eq!(
            runtime.pending_generated_input_queues[SOURCE_ID]
                .submissions
                .len(),
            1
        );
        confirm_delivery_and_start_next(&mut runtime, &generated_input_events, SOURCE_ID, 2);
        confirm_delivery(&mut runtime, &generated_input_events, SOURCE_ID, 3);
        assert_eq!(
            runtime
                .request_agent_handover_to(SOURCE_ID, TARGET_ID)
                .unwrap(),
            json!({"sessionId":SOURCE_ID,"status":"submitting"})
        );
        confirm_delivery(&mut runtime, &generated_input_events, SOURCE_ID, 4);
        assert!(matches!(
            runtime.request_agent_ask_to(SOURCE_ID, "other"),
            Err(CoreError::InvalidParams(field)) if field == "targetAgentId"
        ));
        assert!(matches!(
            runtime.request_agent_handover_to(SOURCE_ID, SOURCE_ID),
            Err(CoreError::InvalidParams(field)) if field == "targetSessionId"
        ));

        runtime
            .agent_observations
            .get_mut(TARGET_ID)
            .unwrap()
            .observation
            .as_mut()
            .unwrap()
            .state = termloop_agents::AgentState::Working;
        assert_eq!(
            runtime
                .send_to_agent("source-token", TARGET_ID, "Review the current diff.")
                .unwrap(),
            json!({"sessionId":TARGET_ID,"status":"submitting"})
        );
        assert_eq!(
            runtime.generated_input_delivery_state(TARGET_ID, 17),
            Some(GeneratedInputDeliveryState::WritingPaste)
        );
        assert_eq!(
            runtime
                .send_to_agent(
                    "source-token",
                    TARGET_ID,
                    "Queue this after the first message.",
                )
                .unwrap(),
            json!({"sessionId":TARGET_ID,"status":"submitting"})
        );
        assert_eq!(
            runtime.pending_generated_input_queues[TARGET_ID]
                .submissions
                .len(),
            1
        );
        confirm_delivery_and_start_next(&mut runtime, &generated_input_events, TARGET_ID, 2);
        assert!(
            !runtime
                .pending_generated_input_queues
                .contains_key(TARGET_ID)
        );
        assert!(
            runtime.agent_observations[TARGET_ID]
                .pending_generated_input
                .is_some()
        );
        confirm_delivery(&mut runtime, &generated_input_events, TARGET_ID, 3);
        assert!(matches!(
            runtime.send_to_agent("source-token", SOURCE_ID, "Loop"),
            Err(CoreError::InvalidParams(field)) if field == "sessionId"
        ));
        assert!(matches!(
            runtime.send_to_agent("wrong-token", TARGET_ID, "Review"),
            Err(CoreError::CapabilityDenied)
        ));

        for (index, role) in [
            AgentMcpRole::Helper { request_id: None },
            AgentMcpRole::Steward {
                project_id: source_project.clone(),
            },
            AgentMcpRole::Worker {
                project_id: source_project.clone(),
                worker_id: "worker-1".into(),
            },
        ]
        .into_iter()
        .enumerate()
        {
            let token = format!("source-role-token-{index}");
            runtime
                .mcp_authorizer
                .register(SOURCE_ID.into(), 17, role, token.clone());
            assert_eq!(
                runtime
                    .send_to_agent(&token, TARGET_ID, "User-requested consultation")
                    .unwrap(),
                json!({"sessionId":TARGET_ID,"status":"submitting"})
            );
            confirm_delivery(
                &mut runtime,
                &generated_input_events,
                TARGET_ID,
                4 + index as u64,
            );
        }

        let _ = terminal.terminate(SOURCE_ID);
        let _ = terminal.terminate(TARGET_ID);
        let _ = std::fs::remove_dir_all(root);
    }
}
