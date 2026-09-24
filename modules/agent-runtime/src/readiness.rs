use crate::delivery::GeneratedInputDeliveryCancelCause;
use termloop_agents::{AgentSignalSource, AgentState};

pub fn generated_input_composer_may_accept(
    agent_id: &str,
    provider_state: Option<AgentState>,
) -> bool {
    provider_state == Some(AgentState::Idle)
        // `turn/completed: interrupted` ends the Codex turn and returns the
        // TUI to its composer, but App Server does not follow it with a second
        // `thread/status: idle` notification. Keep the interruption visible as
        // the turn outcome while allowing the Codex-only structural readiness
        // gate to prove that a new prompt can actually be pasted.
        || (agent_id == "codex" && provider_state == Some(AgentState::Interrupted))
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
