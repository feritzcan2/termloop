//! The global keep-awake preference and the projection deciding whether a
//! hold is currently called for.
//!
//! Core owns the durable preference and the Session facts it depends on. It
//! does not own the OS assertion: whether a hold can actually be taken, and
//! whether one is held right now, are runtime facts of the daemon.

use termloop_domain::{KeepAwakeMode, KeepAwakePreference, SessionKind};

use crate::{CoreError, CoreRuntime, store_error};

impl CoreRuntime {
    pub fn keep_awake_preference(&self) -> KeepAwakePreference {
        self.store.keep_awake_preference()
    }

    /// Replaces the single global keep-awake preference.
    pub fn set_keep_awake_preference(
        &mut self,
        preference: KeepAwakePreference,
    ) -> Result<(), CoreError> {
        self.store
            .set_keep_awake_preference(&self.write_authority, preference)
            .map_err(store_error)?;
        Ok(())
    }

    /// Turns an elapsed temporary preference into the durable Off state.
    ///
    /// The deadline check and write happen under core's serialized lock at the
    /// caller, so a reconcile for an old timer cannot turn off a newer timer
    /// that was selected in the meantime. The display choice is retained just
    /// as it is when the user selects Off explicitly.
    pub fn expire_keep_awake_timer(&mut self, now_epoch_ms: u64) -> Result<bool, CoreError> {
        let preference = self.keep_awake_preference();
        if preference
            .expires_at_epoch_ms
            .is_none_or(|expires_at| expires_at > now_epoch_ms)
        {
            return Ok(false);
        }
        self.store
            .set_keep_awake_preference(
                &self.write_authority,
                KeepAwakePreference {
                    mode: KeepAwakeMode::Off,
                    keep_display_awake: preference.keep_display_awake,
                    expires_at_epoch_ms: None,
                },
            )
            .map_err(store_error)?;
        Ok(true)
    }

    /// How many Agent Sessions currently own a live process.
    ///
    /// This is a projection over current Session state, never a stored count.
    /// `resuming` counts alongside `running`: a resume is an active operation,
    /// and letting the host sleep in that window is exactly the interruption
    /// the feature exists to prevent.
    pub fn running_agent_session_count(&self) -> usize {
        self.store
            .sessions()
            .iter()
            .filter(|session| {
                session.kind == SessionKind::Agent
                    && session.archived_at_epoch_ms.is_none()
                    && matches!(session.lifecycle_state.as_str(), "running" | "resuming")
            })
            .count()
    }

    /// Whether the preference and current Sessions together call for a hold.
    ///
    /// Deliberately not "is a hold active": the OS may refuse, and that
    /// difference is what lets the daemon report an honest failed state
    /// instead of a silent one.
    pub fn keep_awake_hold_is_wanted(&self, now_epoch_ms: u64) -> bool {
        let preference = self.keep_awake_preference();
        if preference
            .expires_at_epoch_ms
            .is_some_and(|expires_at| expires_at <= now_epoch_ms)
        {
            return false;
        }
        match preference.mode {
            KeepAwakeMode::Off => false,
            KeepAwakeMode::Always => true,
            KeepAwakeMode::WhileAgentsRun => self.running_agent_session_count() > 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_terminal::TerminalService;

    fn runtime(label: &str) -> (CoreRuntime, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-keep-awake-{label}-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        (
            CoreRuntime::open(&path, TerminalService::default(), 1).unwrap(),
            path,
        )
    }

    #[test]
    fn elapsed_timer_becomes_durable_off_exactly_once() {
        let (mut runtime, path) = runtime("expiry");
        runtime
            .set_keep_awake_preference(KeepAwakePreference {
                mode: KeepAwakeMode::Always,
                keep_display_awake: true,
                expires_at_epoch_ms: Some(100),
            })
            .unwrap();
        let timer_revision = runtime.state_revision();

        assert!(!runtime.expire_keep_awake_timer(99).unwrap());
        assert_eq!(runtime.state_revision(), timer_revision);
        assert!(runtime.expire_keep_awake_timer(100).unwrap());
        assert_eq!(
            runtime.keep_awake_preference(),
            KeepAwakePreference {
                mode: KeepAwakeMode::Off,
                keep_display_awake: true,
                expires_at_epoch_ms: None,
            }
        );
        let expired_revision = runtime.state_revision();
        assert!(!runtime.expire_keep_awake_timer(101).unwrap());
        assert_eq!(runtime.state_revision(), expired_revision);

        drop(runtime);
        let reopened = CoreRuntime::open(&path, TerminalService::default(), 2).unwrap();
        assert_eq!(reopened.keep_awake_preference().mode, KeepAwakeMode::Off);
        assert_eq!(reopened.keep_awake_preference().expires_at_epoch_ms, None);
        let _ = std::fs::remove_file(path);
    }
}
