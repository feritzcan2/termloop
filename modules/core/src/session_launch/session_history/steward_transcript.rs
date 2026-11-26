//! Read-only diagnostics an authenticated Improve Agent uses to debug the
//! Steward and Routines it is improving. Every read is scoped to the exact
//! Project of the improver's own Session; nothing here mutates state.

use serde_json::{Value, json};
use termloop_domain::ImproverSessionTarget;

use crate::{CoreError, CoreRuntime};

impl CoreRuntime {
    /// The Project whose Steward diagnostics this Improve Agent Session may
    /// read. The Session must still carry the exact target its MCP principal
    /// was issued for; a role is never inferred from caller input.
    pub fn improver_diagnostics_project(
        &self,
        session_id: &str,
        target: &ImproverSessionTarget,
    ) -> Result<String, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::CapabilityDenied)?;
        if session.improver_target.as_ref() != Some(target) {
            return Err(CoreError::CapabilityDenied);
        }
        Ok(session.project_id.clone())
    }

    /// Bounded normalized user/assistant tail of the Project's current Steward
    /// conversation, from the same history cache that backs Task Agent tails.
    /// Provider identities, transcript paths, and tool payloads stay private.
    pub fn steward_transcript_tail_projection_for_improver(
        &self,
        project_id: &str,
    ) -> Result<Value, CoreError> {
        let Some(configuration) = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
        else {
            return Ok(steward_tail_unavailable(None, "stewardNotConfigured"));
        };
        let Some(session_id) = configuration.executor_session_id.as_deref() else {
            return Ok(steward_tail_unavailable(
                None,
                if configuration.enabled {
                    "stewardNotRunning"
                } else {
                    "stewardDisabled"
                },
            ));
        };
        let Some(session) = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id && session.project_id == project_id)
        else {
            return Ok(steward_tail_unavailable(None, "stewardNotRunning"));
        };
        let Some(resume_ref) = session.resume_ref.as_ref().filter(|value| value.validate()) else {
            return Ok(steward_tail_unavailable(
                Some(session_id),
                "conversationNotStarted",
            ));
        };
        let Some(cached) = self.session_history.projects.get(project_id) else {
            return Ok(steward_tail_unavailable(
                Some(session_id),
                "historyNotScanned",
            ));
        };
        let Some(entry) = cached.managed_entries.iter().find(|entry| {
            entry.session_id == session_id && &entry.conversation.resume_ref == resume_ref
        }) else {
            return Ok(steward_tail_unavailable(
                Some(session_id),
                "transcriptUnavailable",
            ));
        };
        Ok(json!({
            "status": "available",
            "reason": null,
            "sessionId": session_id,
            "provider": entry.conversation.agent_id,
            "updatedAtEpochMs": entry.conversation.updated_at_epoch_ms,
            "messages": super::history_messages_json(&entry.conversation.tail_messages),
        }))
    }
}

fn steward_tail_unavailable(session_id: Option<&str>, reason: &str) -> Value {
    json!({
        "status": "unavailable",
        "reason": reason,
        "sessionId": session_id,
        "provider": null,
        "updatedAtEpochMs": null,
        "messages": [],
    })
}
