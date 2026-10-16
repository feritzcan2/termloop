use crate::delivery::GeneratedInputDeliveryCancelCause;
use termloop_agents::{AgentSignalSource, AgentState};

pub fn generated_input_composer_may_accept(
    agent_id: &str,
    provider_state: Option<AgentState>,
    provider_source: Option<AgentSignalSource>,
) -> bool {
    provider_state == Some(AgentState::Idle)
        // A Claude Session interrupted by a graceful restart resumes at an
        // empty composer and emits no idle signal until another turn ends.
        // Its resumed process's `SessionStart` hook replaces the process
        // seed's source, so only a confirmed live composer qualifies. A user
        // interrupt read from the transcript stays excluded because Claude
        // may restore the interrupted prompt into the composer.
        || (agent_id == "claude"
            && provider_state == Some(AgentState::Interrupted)
            && provider_source == Some(AgentSignalSource::Hook))
        // `turn/completed: interrupted` ends the Codex turn and returns the
        // TUI to its composer, but App Server does not follow it with a second
        // `thread/status: idle` notification. Keep the interruption visible as
        // the turn outcome while allowing the Codex-only structural readiness
        // gate to prove that a new prompt can actually be pasted.
        || (agent_id == "codex" && provider_state == Some(AgentState::Interrupted))
}

/// A failed turn stays `Failed` until new work starts, so ordinary generated
/// input waits for the user. Callers may admit a specific prompt kind after a
/// failure only when the provider is known to be back at its composer: Claude's
/// `StopFailure` hook and Codex's `turn/completed: failed` both end the turn
/// there, and the same settlement gates as an idle composer still apply.
pub fn generated_input_composer_may_accept_after_failed_turn(
    agent_id: &str,
    provider_state: Option<AgentState>,
    provider_source: Option<AgentSignalSource>,
) -> bool {
    provider_state == Some(AgentState::Failed)
        && match agent_id {
            "claude" => provider_source == Some(AgentSignalSource::Hook),
            "codex" => true,
            _ => false,
        }
}

pub fn generated_input_settlement(
    agent_id: &str,
    provider_source: Option<AgentSignalSource>,
    provider_queue_ready: bool,
) -> crate::delivery::GeneratedInputSettlement {
    use crate::delivery::GeneratedInputSettlement;

    if provider_queue_ready {
        GeneratedInputSettlement::ProviderQueue
    } else if agent_id == "codex" && provider_source != Some(AgentSignalSource::DaemonBridge) {
        // Without App Server's structured idle observation, the terminal must
        // prove that Codex's current composer prompt is on screen.
        GeneratedInputSettlement::CodexComposerRender
    } else if matches!(agent_id, "codex" | "claude") {
        // App Server idle already proves Codex is accepting a new turn. Keep
        // the terminal's bracketed-paste handshake as the transport gate, but
        // do not depend on a TUI glyph that may have rendered before tracking
        // began or may change independently of the structured protocol.
        GeneratedInputSettlement::ComposerRender
    } else {
        GeneratedInputSettlement::OutputActivity
    }
}

pub fn unavailable_composer_cause(
    provider_state: Option<AgentState>,
    provider_signal: Option<termloop_agents::AgentSignal>,
) -> GeneratedInputDeliveryCancelCause {
    match provider_signal {
        Some(termloop_agents::AgentSignal::PermissionRequested) => {
            GeneratedInputDeliveryCancelCause::PermissionRequested
        }
        Some(termloop_agents::AgentSignal::Notification) => {
            GeneratedInputDeliveryCancelCause::Notification
        }
        _ if provider_state == Some(AgentState::AwaitingInput) => {
            GeneratedInputDeliveryCancelCause::ProviderAwaitingInput
        }
        _ if provider_state == Some(AgentState::Failed) => {
            GeneratedInputDeliveryCancelCause::ProviderTurnFailed
        }
        _ => GeneratedInputDeliveryCancelCause::ProviderBusy,
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct QueueAdmission {
    pub while_working: bool,
}
impl QueueAdmission {
    pub fn permits(self, state: Option<AgentState>) -> bool {
        self.while_working && matches!(state, Some(AgentState::Working | AgentState::Compacting))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_claude_accepts_input_only_after_its_resumed_process_confirms() {
        let interrupted = Some(AgentState::Interrupted);
        assert!(generated_input_composer_may_accept(
            "claude",
            interrupted,
            Some(AgentSignalSource::Hook)
        ));
        for source in [
            AgentSignalSource::Process,
            AgentSignalSource::Transcript,
            AgentSignalSource::DaemonBridge,
        ] {
            assert!(!generated_input_composer_may_accept(
                "claude",
                interrupted,
                Some(source)
            ));
        }
        assert!(!generated_input_composer_may_accept(
            "claude",
            Some(AgentState::Working),
            Some(AgentSignalSource::Hook)
        ));
        assert!(!generated_input_composer_may_accept(
            "gemini",
            interrupted,
            Some(AgentSignalSource::Hook)
        ));
        assert!(generated_input_composer_may_accept(
            "codex",
            interrupted,
            Some(AgentSignalSource::Process)
        ));
    }

    #[test]
    fn a_failed_turn_is_reported_as_failed_and_only_admits_known_composer_returns() {
        let failed = Some(AgentState::Failed);
        assert_eq!(
            unavailable_composer_cause(failed, Some(termloop_agents::AgentSignal::Failed)),
            GeneratedInputDeliveryCancelCause::ProviderTurnFailed
        );
        assert_eq!(
            unavailable_composer_cause(Some(AgentState::Working), None),
            GeneratedInputDeliveryCancelCause::ProviderBusy
        );
        for source in [
            AgentSignalSource::Hook,
            AgentSignalSource::Process,
            AgentSignalSource::Transcript,
            AgentSignalSource::DaemonBridge,
        ] {
            assert!(!generated_input_composer_may_accept(
                "claude",
                failed,
                Some(source)
            ));
        }
        assert!(generated_input_composer_may_accept_after_failed_turn(
            "claude",
            failed,
            Some(AgentSignalSource::Hook)
        ));
        assert!(!generated_input_composer_may_accept_after_failed_turn(
            "claude",
            failed,
            Some(AgentSignalSource::Transcript)
        ));
        assert!(generated_input_composer_may_accept_after_failed_turn(
            "codex",
            failed,
            Some(AgentSignalSource::DaemonBridge)
        ));
        assert!(!generated_input_composer_may_accept_after_failed_turn(
            "opencode",
            failed,
            Some(AgentSignalSource::Hook)
        ));
        assert!(!generated_input_composer_may_accept_after_failed_turn(
            "claude",
            Some(AgentState::Working),
            Some(AgentSignalSource::Hook)
        ));
    }
}
