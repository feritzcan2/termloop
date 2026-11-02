use termloop_domain::AgentForkPreference;

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    /// Replaces the single global native-fork preference in place.
    ///
    /// Writing the value already stored is a no-op so a repeated save cannot
    /// churn the revision.
    pub fn set_agent_fork_preference(
        &mut self,
        _authority: &CoreWriteAuthority,
        preference: AgentForkPreference,
    ) -> Result<u64, StoreError> {
        if self.state.agent_fork_preference == preference {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.agent_fork_preference = preference;
        self.commit_or_restore(previous)
    }
}
