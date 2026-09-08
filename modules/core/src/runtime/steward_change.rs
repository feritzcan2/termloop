use serde_json::Value;
use termloop_domain::StewardConfiguration;

use crate::CoreRuntime;

/// Post-commit facts, captured while the configuration write still owns Core.
#[derive(Debug)]
pub struct CommittedStewardChange {
    project_id: String,
    state_revision: u64,
    generation: u64,
    changed: bool,
    retired_session_id: Option<String>,
    needs_wake: bool,
}

pub struct StewardConfigurationCommit {
    pub result: Value,
    pub change: CommittedStewardChange,
}

#[cfg(test)]
mod tests;

impl CommittedStewardChange {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }
    pub fn state_revision(&self) -> u64 {
        self.state_revision
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn changed(&self) -> bool {
        self.changed
    }
    pub fn retired_session_id(&self) -> Option<&str> {
        self.retired_session_id.as_deref()
    }
    pub fn needs_wake(&self) -> bool {
        self.needs_wake
    }
}

pub(crate) struct StewardChangeSnapshot {
    project_id: String,
    configuration: Option<StewardConfiguration>,
}

impl CoreRuntime {
    pub fn is_current_steward_change(&self, change: &CommittedStewardChange) -> bool {
        self.store
            .steward_configurations()
            .iter()
            .any(|configuration| {
                configuration.project_id == change.project_id
                    && configuration.generation == change.generation
            })
    }

    pub(crate) fn capture_steward_change(&self, project_id: &str) -> StewardChangeSnapshot {
        StewardChangeSnapshot {
            project_id: project_id.to_owned(),
            configuration: self
                .store
                .steward_configurations()
                .iter()
                .find(|configuration| configuration.project_id == project_id)
                .cloned(),
        }
    }

    pub(crate) fn committed_steward_change(
        &self,
        before: StewardChangeSnapshot,
    ) -> CommittedStewardChange {
        let current = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == before.project_id);
        CommittedStewardChange {
            changed: before.configuration.as_ref() != current,
            retired_session_id: before
                .configuration
                .as_ref()
                .and_then(|configuration| configuration.executor_session_id.clone())
                .filter(|id| {
                    current.and_then(|configuration| configuration.executor_session_id.as_ref())
                        != Some(id)
                }),
            generation: current.map_or(0, |configuration| configuration.generation),
            needs_wake: current.is_some_and(|configuration| {
                configuration.enabled && configuration.executor_session_id.is_none()
            }),
            project_id: before.project_id,
            state_revision: self.store.revision(),
        }
    }
}
