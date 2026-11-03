use termloop_domain::AgentRestartPreference;

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    /// Replaces the single global restart-continuation preference in place.
    ///
    /// Writing the value already stored is a no-op so a repeated save cannot
    /// churn the revision.
    pub fn set_agent_restart_preference(
        &mut self,
        _authority: &CoreWriteAuthority,
        preference: AgentRestartPreference,
    ) -> Result<u64, StoreError> {
        if self.state.agent_restart_preference == preference {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.agent_restart_preference = preference;
        self.commit_or_restore(previous)
    }
}
