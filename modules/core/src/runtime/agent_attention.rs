//! Cross-client acknowledgement of an Agent's review or interruption attention.
//!
//! The acknowledgement is runtime presentation state, not durable Session
//! state: it names the exact status observation a user has already seen so
//! every client attached to this daemon stops presenting it as attention. A
//! newer observation carries a different timestamp and therefore surfaces
//! again on its own.

use serde_json::Value;

use crate::error::required_string;
use crate::{CoreError, CoreRuntime};

impl CoreRuntime {
    pub(crate) fn acknowledge_agent_attention(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        let observed_at_epoch_ms = params
            .get("observedAtEpochMs")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("observedAtEpochMs".into()))?;
        let sessions = self.store.sessions();
        if !sessions.iter().any(|session| {
            session.id == session_id && session.kind == termloop_domain::SessionKind::Agent
        }) {
            return Err(CoreError::NotFound);
        }
        self.agent_attention_acknowledgements
            .retain(|candidate, _| sessions.iter().any(|session| session.id == *candidate));
        let previous = self
            .agent_attention_acknowledgements
            .get(&session_id)
            .copied();
        let acknowledged = previous.is_none_or(|previous| previous < observed_at_epoch_ms);
        if acknowledged {
            self.agent_attention_acknowledgements
                .insert(session_id, observed_at_epoch_ms);
        }
        Ok(serde_json::json!({ "acknowledged": acknowledged }))
    }

    pub(crate) fn agent_attention_acknowledged_at(&self, session_id: &str) -> Option<u64> {
        self.agent_attention_acknowledgements
            .get(session_id)
            .copied()
    }
}

#[cfg(test)]
mod tests;
