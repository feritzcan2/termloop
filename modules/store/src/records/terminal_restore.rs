use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};

use crate::{CoreWriteAuthority, Store, StoreError};

impl Store {
    /// Replace only the exact stale ordinary shell whose new PTY Core prepared.
    pub fn restore_terminal_session(
        &mut self,
        _authority: &CoreWriteAuthority,
        expected: &SessionRecord,
        process: ProcessDescriptor,
        runtime_epoch: u64,
    ) -> Result<u64, StoreError> {
        let index = self
            .state
            .sessions
            .iter()
            .position(|session| session.id == expected.id)
            .ok_or(StoreError::NotFound)?;
        let current = &self.state.sessions[index];
        if current != expected
            || current.kind != SessionKind::Terminal
            || current.lifecycle_state != "stale"
            || current.run_configuration_id.is_some()
            || current.archived_at_epoch_ms.is_some()
            || process.agent_id.is_some()
            || process.template_ref.is_some()
            || process.cwd.is_empty()
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let session = &mut self.state.sessions[index];
        session.process = process;
        session.runtime_epoch = runtime_epoch;
        session.lifecycle_state = "running".into();
        session.resume_failure = None;
        self.commit_or_restore(previous)
    }

    /// A directory observation can update only the same live shell generation.
    /// A stale observation never overwrites a later move or a replacement PTY.
    pub fn observe_terminal_directory(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        runtime_epoch: u64,
        expected_cwd: &str,
        observed_cwd: &str,
    ) -> Result<u64, StoreError> {
        if observed_cwd.is_empty() {
            return Err(StoreError::ConstraintViolation);
        }
        let Some(index) = self.state.sessions.iter().position(|session| {
            session.id == session_id
                && session.runtime_epoch == runtime_epoch
                && session.kind == SessionKind::Terminal
                && session.run_configuration_id.is_none()
                && session.lifecycle_state == "running"
                && session.process.cwd == expected_cwd
        }) else {
            return Ok(self.state.revision);
        };
        if expected_cwd == observed_cwd {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.sessions[index].process.cwd = observed_cwd.to_owned();
        self.commit_or_restore(previous)
    }
}
