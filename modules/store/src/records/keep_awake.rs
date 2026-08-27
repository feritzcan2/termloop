use termloop_domain::KeepAwakePreference;

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    /// Replaces the single global keep-awake preference in place.
    ///
    /// The preference is current state: there is exactly one value and no
    /// history of previous choices. Writing the value already stored is a
    /// no-op so an idle UI refresh cannot churn the revision.
    pub fn set_keep_awake_preference(
        &mut self,
        _authority: &CoreWriteAuthority,
        preference: KeepAwakePreference,
    ) -> Result<u64, StoreError> {
        if self.state.keep_awake_preference == preference {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.keep_awake_preference = preference;
        self.commit_or_restore(previous)
    }
}
