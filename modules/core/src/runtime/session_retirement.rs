use crate::{CodexRuntime, CoreRuntime};

impl CoreRuntime {
    /// Retire an endpoint only after its removal from the live descriptor set
    /// commits. Resumable process exit keeps its own continuation policy.
    /// No process is reaped here: the caller carries the returned handle out
    /// of the serialized Core lock before disposing it.
    pub(crate) fn retire_closed_session_runtime(
        &mut self,
        session_id: &str,
    ) -> Option<CodexRuntime> {
        debug_assert!(
            !self
                .store
                .sessions()
                .iter()
                .any(|session| session.id == session_id)
        );

        self.generated_input_deliveries.remove_session(session_id);
        self.pending_generated_input_queues.remove(session_id);
        self.pending_assistant_wake_deliveries.remove(session_id);
        self.agent_observations.remove(session_id);
        self.daemon_restart_handoffs.remove(session_id);
        self.agent_terminal_holds.remove(session_id);
        self.resume_reservations.remove(session_id);
        self.provider_history_repair_reservations.remove(session_id);
        self.resume_ready.remove(session_id);
        self.resume_failure_reaps.remove(session_id);
        self.pending_agent_forks.remove(session_id);
        self.pending_agent_resume_refs.remove(session_id);
        self.agent_conversation_activity.remove(session_id);
        self.claude_turn_watches.remove(session_id);
        self.forget_ask_to_session(session_id);
        self.fork_source_session_ids
            .retain(|child, source| child != session_id && source != session_id);
        self.codex_runtimes.remove(session_id)
    }
}

#[cfg(test)]
mod tests;
