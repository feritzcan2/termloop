use termloop_domain::{
    COMPANION_TRANSCRIPT_HARD_BYTES, COMPANION_TRANSCRIPT_HARD_MESSAGES, CompanionMessage,
};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn companion_messages(&self) -> &[CompanionMessage] {
        &self.state.companion_messages
    }

    pub fn companion_transcript_storage_bytes(&self, project_id: &str) -> usize {
        encoded_transcript_bytes(
            self.state
                .companion_messages
                .iter()
                .filter(|message| message.project_id == project_id),
        )
        .unwrap_or(usize::MAX)
    }

    pub fn companion_transcript_message_count(&self, project_id: &str) -> usize {
        self.state
            .companion_messages
            .iter()
            .filter(|message| message.project_id == project_id)
            .count()
    }

    pub fn append_companion_message(
        &mut self,
        _authority: &CoreWriteAuthority,
        message: CompanionMessage,
    ) -> Result<CompanionMessage, StoreError> {
        if !message.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == message.project_id)
            || self
                .state
                .companion_messages
                .iter()
                .any(|current| current.id == message.id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let expected_sequence = self
            .state
            .companion_messages
            .iter()
            .filter(|current| current.project_id == message.project_id)
            .map(|current| current.sequence)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(StoreError::ConstraintViolation)?;
        if message.sequence != expected_sequence {
            return Err(StoreError::RevisionConflict);
        }
        let current = self
            .state
            .companion_messages
            .iter()
            .filter(|candidate| candidate.project_id == message.project_id);
        let message_count = current.clone().count().saturating_add(1);
        let storage_bytes = encoded_transcript_bytes(current.chain(std::iter::once(&message)))
            .ok_or(StoreError::ConstraintViolation)?;
        if message_count > COMPANION_TRANSCRIPT_HARD_MESSAGES
            || storage_bytes > COMPANION_TRANSCRIPT_HARD_BYTES
        {
            return Err(StoreError::CompanionTranscriptQuotaExceeded);
        }
        let previous = self.state.clone();
        self.state.companion_messages.push(message.clone());
        self.commit_or_restore(previous)?;
        Ok(message)
    }

    pub fn clear_companion_transcript(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        expected_revision: u64,
    ) -> Result<usize, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(StoreError::NotFound);
        }
        let previous = self.state.clone();
        let before = self.state.companion_messages.len();
        self.state
            .companion_messages
            .retain(|message| message.project_id != project_id);
        let deleted = before - self.state.companion_messages.len();
        if deleted > 0 {
            self.commit_or_restore(previous)?;
        }
        Ok(deleted)
    }
}

fn encoded_transcript_bytes<'a>(
    messages: impl IntoIterator<Item = &'a CompanionMessage>,
) -> Option<usize> {
    serde_json::to_vec(&messages.into_iter().collect::<Vec<_>>())
        .ok()
        .map(|bytes| bytes.len())
}
