//! Store-free observation and generated-input coordination for one live epoch.
use crate::delivery::{
    GeneratedInputDeliveryRuntime, GeneratedInputDeliveryState, GeneratedInputRuntimeEvent,
};
use crate::readiness::{
    generated_input_composer_may_accept, generated_input_settlement, unavailable_composer_cause,
};
use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, channel};
use termloop_agents::{
    AgentObservation, AgentRuntimeEvent, AgentRuntimeSignal, AgentSignal, AgentSignalSource,
    ProviderHookObservationInput,
};
use termloop_launch::{GeneratedTerminalSubmission, LaunchPayload};
use termloop_terminal::TerminalService;

pub struct ObservedSession {
    id: String,
    epoch: u64,
    provider: String,
    token: String,
    terminal: TerminalService,
    observation: Option<AgentObservation>,
    last_signal: Option<AgentSignal>,
    native_identity: Option<String>,
    ingress: crate::observation_ingress::ProviderObservationIngress,
    deliveries: GeneratedInputDeliveryRuntime,
    delivery_events: Receiver<GeneratedInputRuntimeEvent>,
    pending: VecDeque<GeneratedTerminalSubmission>,
    hook_response_pending: bool,
    codex: Option<crate::CodexRuntime>,
    signals: Option<Receiver<AgentRuntimeSignal>>,
    reap_failed: bool,
}

impl ObservedSession {
    pub fn new(id: String, epoch: u64, provider: String, terminal: TerminalService) -> Self {
        let mut deliveries = GeneratedInputDeliveryRuntime::default();
        let delivery_events = deliveries.take_events().expect("new delivery receiver");
        Self {
            id,
            epoch,
            provider,
            token: termloop_platform::generate_capability_token(),
            terminal,
            observation: None,
            last_signal: None,
            native_identity: None,
            ingress: Default::default(),
            deliveries,
            delivery_events,
            pending: VecDeque::new(),
            hook_response_pending: false,
            codex: None,
            signals: None,
            reap_failed: false,
        }
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    /// Private persistence boundary. Never include this identity in public DTOs.
    pub fn native_identity(&self) -> Option<&str> {
        self.native_identity.as_deref()
    }
    pub fn observation(&self) -> Option<AgentObservation> {
        self.observation
    }
    pub fn delivery_state(&self) -> Option<GeneratedInputDeliveryState> {
        self.deliveries.state(&self.id, self.epoch)
    }

    pub fn start_codex(
        &mut self,
        cwd: &str,
        directory: &std::path::Path,
        mcp: Option<termloop_launch::McpConnection<'_>>,
        launch: &mut LaunchPayload,
        executable_directory: Option<&std::path::Path>,
    ) -> Result<(), crate::PreparationError> {
        let (sender, receiver) = channel();
        let mut runtime = crate::codex::start_codex_runtime_with_executable_directory(
            &self.id,
            self.epoch,
            cwd,
            false,
            None,
            directory,
            mcp,
            launch.codex_app_server_developer_instructions(),
            sender,
            executable_directory,
            launch.codex_runtime_policy(),
        )?;
        let preparation = (|| {
            if let Some(request) = launch.codex_resume_permissions() {
                runtime
                    .warm_thread_history(request.native_thread_id())
                    .map_err(|error| match error {
                        termloop_agents::CodexThreadHistoryProbeError::Damaged => {
                            crate::PreparationError::ProviderHistoryDamaged
                        }
                        termloop_agents::CodexThreadHistoryProbeError::Unavailable => {
                            crate::PreparationError::ProviderRejected
                        }
                    })?;
                runtime.prepare_resume_permissions(launch)?;
            }
            launch
                .bind_codex_app_server_endpoint(runtime.endpoint())
                .map_err(|_| crate::PreparationError::ProviderRejected)
        })();
        if let Err(error) = preparation {
            return Err(if runtime.reap().is_err() {
                crate::PreparationError::RuntimeOwnershipUncertain
            } else {
                error
            });
        }
        self.codex = Some(runtime);
        self.signals = Some(receiver);
        Ok(())
    }
    /// Bounded immutable requests; ambiguous deliveries are never automatically repeated.
    pub fn enqueue(&mut self, submission: GeneratedTerminalSubmission) -> bool {
        if self.pending.len() >= 16 {
            return false;
        }
        self.pending.push_back(submission);
        true
    }
    pub fn hook(&mut self, token: &str, input: ProviderHookObservationInput, at: u64) -> bool {
        if !crate::observation_token_matches(&self.token, token)
            || !self.ingress.admit(&self.id, at)
        {
            return false;
        }
        let Some(normalized) =
            termloop_agents::normalize_provider_hook_observation(&self.provider, input)
        else {
            return false;
        };
        if normalized.source != AgentSignalSource::Hook {
            return false;
        }
        if let Some(identity) = normalized.resume_ref {
            self.native_identity = Some(identity.native_session_id);
        }
        if normalized.signal == AgentSignal::SessionStarted {
            self.hook_response_pending = true;
        }
        self.observe(normalized.signal, AgentSignalSource::Hook, at);
        true
    }
    pub fn release_hook_response(&mut self, token: &str) {
        if crate::observation_token_matches(&self.token, token) {
            self.hook_response_pending = false;
        }
    }
    fn observe(&mut self, signal: AgentSignal, source: AgentSignalSource, at: u64) {
        let sequence = self
            .observation
            .map_or(1, |value| value.sequence.saturating_add(1));
        self.observation = Some(termloop_agents::reduce_observation(
            self.observation,
            signal,
            source,
            sequence,
            at,
        ));
        self.last_signal = Some(signal);
        if signal == AgentSignal::PromptSubmitted {
            self.deliveries.confirm_provider_submission(
                &self.id,
                self.epoch,
                sequence,
                self.terminal.user_input_activity(&self.id, self.epoch).ok(),
            );
        } else if matches!(
            signal,
            AgentSignal::ToolStarted
                | AgentSignal::ToolFinished
                | AgentSignal::Stopped
                | AgentSignal::PermissionRequested
        ) {
            self.deliveries
                .confirm_provider_progress(&self.id, self.epoch, sequence);
        }
    }
    pub fn poll(&mut self, at: u64) {
        let signals: Vec<_> = self
            .signals
            .as_ref()
            .map(|receiver| receiver.try_iter().take(256).collect())
            .unwrap_or_default();
        for signal in signals {
            if signal.session_id != self.id || signal.runtime_epoch != self.epoch {
                continue;
            }
            match signal.event {
                AgentRuntimeEvent::Observation(signal) => {
                    self.observe(signal, AgentSignalSource::DaemonBridge, at)
                }
                AgentRuntimeEvent::ResumeRefObserved(identity) => {
                    self.native_identity = Some(identity.native_session_id);
                }
                _ => {}
            }
        }
        for event in self.delivery_events.try_iter().take(256) {
            self.deliveries.apply_transport_event(event);
        }
        // A completed immutable request is removed only once, after the provider acknowledges it.
        if self.pending.front().is_some_and(|submission| {
            self.deliveries
                .contains_submission(&self.id, self.epoch, submission)
        }) && matches!(
            self.delivery_state(),
            Some(
                GeneratedInputDeliveryState::Confirmed
                    | GeneratedInputDeliveryState::ConfirmedUnattributed
                    | GeneratedInputDeliveryState::RequiresUserResubmit
            )
        ) {
            self.pending.pop_front();
            self.deliveries.remove_session(&self.id);
        }
        if self.hook_response_pending {
            return;
        }
        let Some(submission) = self.pending.front().cloned() else {
            return;
        };
        let state = self.observation.map(|value| value.state);
        let sequence = self.observation.map_or(0, |value| value.sequence);
        if !self
            .deliveries
            .can_begin_pending_submission(&self.id, self.epoch)
        {
            if state == Some(termloop_agents::AgentState::AwaitingInput)
                && self.delivery_state() == Some(GeneratedInputDeliveryState::WritingPaste)
            {
                self.deliveries.block_for_unavailable_composer(
                    &self.id,
                    self.epoch,
                    sequence,
                    submission,
                    unavailable_composer_cause(state, self.last_signal),
                    None,
                );
            }
            return;
        }
        if !generated_input_composer_may_accept(&self.provider, state) {
            if state.is_some() {
                self.deliveries.block_for_unavailable_composer(
                    &self.id,
                    self.epoch,
                    sequence,
                    submission,
                    unavailable_composer_cause(state, self.last_signal),
                    None,
                );
            }
            return;
        }
        if self
            .deliveries
            .can_begin_pending_submission(&self.id, self.epoch)
        {
            self.deliveries.begin(
                &self.terminal,
                &self.id,
                self.epoch,
                sequence,
                submission,
                generated_input_settlement(
                    &self.provider,
                    self.observation.map(|value| value.source),
                    false,
                ),
            );
        }
    }
    pub fn close(&mut self) -> Result<(), crate::ReapError> {
        self.deliveries.remove_session(&self.id);
        self.pending.clear();
        if self.reap_failed {
            return Err(crate::ReapError);
        }
        if let Some(runtime) = self.codex.take()
            && runtime.reap().is_err()
        {
            self.reap_failed = true;
            return Err(crate::ReapError);
        }
        Ok(())
    }
}
impl Drop for ObservedSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(identity: &str) -> ProviderHookObservationInput {
        ProviderHookObservationInput {
            event_name: "SessionStart".into(),
            native_session_id: Some(identity.into()),
            notification_type: None,
            provider_model_id: None,
            permission_mode: None,
            reasoning_level: None,
            transcript_path: None,
            prompt_id: None,
            plan: None,
        }
    }
    #[test]
    fn independent_tokens_bind_observation_to_one_live_session_and_current_identity() {
        let mut first =
            ObservedSession::new("one".into(), 1, "claude".into(), TerminalService::default());
        let second =
            ObservedSession::new("two".into(), 1, "claude".into(), TerminalService::default());
        let native = "11111111-1111-4111-8111-111111111111";
        assert!(!first.hook(second.token(), input(native), 10));
        assert!(first.native_identity().is_none());
        let token = first.token().to_string();
        assert!(first.hook(&token, input(native), 11));
        assert_eq!(first.native_identity(), Some(native));
        assert!(first.hook_response_pending);
        first.release_hook_response(second.token());
        assert!(first.hook_response_pending);
        first.release_hook_response(&token);
        assert!(!first.hook_response_pending);
        let changed = "22222222-2222-4222-8222-222222222222";
        assert!(first.hook(&token, input(changed), 12));
        assert_eq!(first.native_identity(), Some(changed));
    }
    #[test]
    fn a_daemon_bridge_provider_cannot_be_spoofed_by_a_hook() {
        let mut session =
            ObservedSession::new("one".into(), 1, "codex".into(), TerminalService::default());
        let token = session.token().to_string();
        assert!(!session.hook(&token, input("11111111-1111-4111-8111-111111111111"), 1));
        assert!(session.observation().is_none());
    }
}
