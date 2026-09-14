use crate::{CoreError, CoreRuntime, store_error};
use termloop_agents::CodexThreadNameObservation;
use termloop_domain::{ResumeProvider, SessionKind};

impl CoreRuntime {
    pub fn record_codex_thread_name(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        observation: CodexThreadNameObservation,
    ) -> Result<bool, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.runtime_epoch == runtime_epoch
                    && session.kind == SessionKind::Agent
                    && session.process.agent_id.as_deref() == Some("codex")
                    && session.lifecycle_state == "running"
                    && session.archived_at_epoch_ms.is_none()
                    && session.resume_ref.as_ref().is_some_and(|resume_ref| {
                        resume_ref.provider == ResumeProvider::Codex
                            && resume_ref.native_session_id == observation.native_thread_id
                    })
            })
            .ok_or(CoreError::CapabilityDenied)?;
        if observation.name.as_ref().is_some_and(|name| {
            name.is_empty()
                || name.trim() != name
                || name.chars().count() > 80
                || name.chars().any(char::is_control)
        }) {
            return Err(CoreError::InvalidParams("name".into()));
        }
        if session.name == observation.name {
            return Ok(false);
        }
        self.store
            .rename_session(&self.write_authority, session_id, observation.name)
            .map_err(store_error)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests;
