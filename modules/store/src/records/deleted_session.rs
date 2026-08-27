use termloop_domain::{
    AgentConversationReadinessRecord, DeletedSessionRecord, ResumeFailureReason, SessionKind,
    SessionRecord,
};

use super::super::{CoreWriteAuthority, Store, StoreError};
use super::session::{clear_ask_to_continuations_for_session, clear_executor_session_references};

impl Store {
    pub fn move_agent_session_to_deleted(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        deleted_at_epoch_ms: u64,
    ) -> Result<DeletedSessionRecord, StoreError> {
        if deleted_at_epoch_ms == 0
            || self
                .state
                .deleted_sessions
                .iter()
                .any(|deleted| deleted.session.id == session_id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let session_index = self
            .state
            .sessions
            .iter()
            .position(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let session = &self.state.sessions[session_index];
        let uncertain = matches!(
            session.resume_failure,
            Some(
                ResumeFailureReason::RuntimeOwnershipUncertain
                    | ResumeFailureReason::RuntimeConflict
            )
        );
        if session.kind != SessionKind::Agent
            || session.archived_at_epoch_ms.is_some()
            || !matches!(
                session.lifecycle_state.as_str(),
                "exited" | "stale" | "resumeFailed"
            )
            || uncertain
        {
            return Err(StoreError::SessionNotClosable);
        }
        let readiness_index = self
            .state
            .agent_conversation_readiness
            .iter()
            .position(|record| record.session_id == session_id)
            .ok_or(StoreError::ConstraintViolation)?;

        let previous = self.state.clone();
        clear_executor_session_references(&mut self.state, [session_id]);
        let _ = clear_ask_to_continuations_for_session(&mut self.state.sessions, session_id);
        self.state
            .session_relocation_receipts
            .retain(|receipt| receipt.session_id != session_id);
        self.state
            .session_relocation_operations
            .retain(|operation| operation.session_id != session_id);
        super::agent_plan::remove_agent_plans_for_sessions(&mut self.state, [session_id]);
        let mut session = self.state.sessions.remove(session_index);
        session.ask_to_continuation = None;
        let conversation_readiness = self
            .state
            .agent_conversation_readiness
            .remove(readiness_index)
            .readiness;
        let deleted = DeletedSessionRecord {
            session,
            deleted_at_epoch_ms,
            conversation_readiness,
        };
        self.state.deleted_sessions.push(deleted.clone());
        self.commit_or_restore(previous)?;
        Ok(deleted)
    }

    pub fn restore_deleted_session_descriptor(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<SessionRecord, StoreError> {
        if self
            .state
            .sessions
            .iter()
            .any(|session| session.id == session_id)
        {
            return Err(StoreError::AlreadyExists);
        }
        let deleted_index = self
            .state
            .deleted_sessions
            .iter()
            .position(|deleted| deleted.session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let previous = self.state.clone();
        let deleted = self.state.deleted_sessions.remove(deleted_index);
        let mut session = deleted.session;
        session.lifecycle_state = "exited".into();
        session.resume_failure = None;
        session.ask_to_continuation = None;
        self.state
            .agent_conversation_readiness
            .push(AgentConversationReadinessRecord {
                session_id: session.id.clone(),
                readiness: deleted.conversation_readiness,
            });
        self.state.sessions.push(session.clone());
        self.commit_or_restore(previous)?;
        Ok(session)
    }

    pub fn purge_expired_deleted_sessions(
        &mut self,
        _authority: &CoreWriteAuthority,
        now_epoch_ms: u64,
    ) -> Result<usize, StoreError> {
        let previous = self.state.clone();
        let before = self.state.deleted_sessions.len();
        self.state
            .deleted_sessions
            .retain(|deleted| deleted.purge_at_epoch_ms() > now_epoch_ms);
        let purged = before.saturating_sub(self.state.deleted_sessions.len());
        if purged > 0 {
            self.commit_or_restore(previous)?;
        }
        Ok(purged)
    }
}
