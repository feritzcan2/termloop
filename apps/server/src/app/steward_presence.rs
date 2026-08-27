use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use termloop_contract::current::ProjectionTopic;
use tokio::sync::mpsc;

use super::invalidation::InvalidationRequest;

const MAX_ACTIVITY_SESSIONS: usize = 512;
const MAX_ACTIVE_COMMANDS: usize = 256;
const MAX_ACTIVE_COMMANDS_PER_PROJECT: usize = 16;

#[derive(Clone, Default)]
pub(super) struct StewardPresenceState {
    inner: Arc<Mutex<PresenceInner>>,
    next_command_token: Arc<AtomicU64>,
}

#[derive(Default)]
struct PresenceInner {
    activities: HashMap<(String, u64), ActivityEntry>,
    activity_sequence: u64,
    active_commands: HashMap<String, Vec<ActiveCommand>>,
    active_command_count: usize,
}

struct ActivityEntry {
    observed_at_epoch_ms: u64,
    sequence: u64,
}

struct ActiveCommand {
    token: u64,
    label: String,
}

pub(super) struct ActiveCommandGuard {
    presence: StewardPresenceState,
    project_id: String,
    token: u64,
    invalidations: mpsc::Sender<InvalidationRequest>,
    observation_sequence: Arc<AtomicU64>,
    state_revision: u64,
}

impl StewardPresenceState {
    /// Records only the occurrence of output. PTY bytes never enter this map.
    pub(super) fn record_activity(
        &self,
        session_id: String,
        runtime_epoch: u64,
        observed_at_epoch_ms: u64,
    ) {
        let mut inner = self.inner.lock().expect("Steward presence mutex poisoned");
        inner.activity_sequence = inner.activity_sequence.wrapping_add(1);
        let sequence = inner.activity_sequence;
        let key = (session_id, runtime_epoch);
        inner.activities.insert(
            key,
            ActivityEntry {
                observed_at_epoch_ms,
                sequence,
            },
        );
        while inner.activities.len() > MAX_ACTIVITY_SESSIONS {
            let oldest = inner
                .activities
                .iter()
                .min_by_key(|(_, entry)| entry.sequence)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                inner.activities.remove(&oldest);
            }
        }
    }

    pub(super) fn last_activity(&self, session_id: &str, runtime_epoch: u64) -> Option<u64> {
        self.inner
            .lock()
            .expect("Steward presence mutex poisoned")
            .activities
            .get(&(session_id.to_owned(), runtime_epoch))
            .map(|entry| entry.observed_at_epoch_ms)
    }

    pub(super) fn active_command(&self, project_id: &str) -> Option<String> {
        self.inner
            .lock()
            .expect("Steward presence mutex poisoned")
            .active_commands
            .get(project_id)
            .and_then(|commands| commands.last())
            .map(|command| command.label.clone())
    }

    pub(super) fn try_begin_command(
        &self,
        project_id: &str,
        label: &str,
        invalidations: mpsc::Sender<InvalidationRequest>,
        observation_sequence: Arc<AtomicU64>,
        state_revision: u64,
    ) -> Option<ActiveCommandGuard> {
        let token = self
            .next_command_token
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        let mut inner = self.inner.lock().expect("Steward presence mutex poisoned");
        let project_count = inner.active_commands.get(project_id).map_or(0, Vec::len);
        if inner.active_command_count >= MAX_ACTIVE_COMMANDS
            || project_count >= MAX_ACTIVE_COMMANDS_PER_PROJECT
        {
            return None;
        }
        inner
            .active_commands
            .entry(project_id.to_owned())
            .or_default()
            .push(ActiveCommand {
                token,
                label: label.to_owned(),
            });
        inner.active_command_count += 1;
        drop(inner);
        queue_invalidation(&invalidations, &observation_sequence, state_revision);
        Some(ActiveCommandGuard {
            presence: self.clone(),
            project_id: project_id.to_owned(),
            token,
            invalidations,
            observation_sequence,
            state_revision,
        })
    }

    fn finish_command(&self, project_id: &str, token: u64) -> bool {
        let mut inner = self.inner.lock().expect("Steward presence mutex poisoned");
        let Some(commands) = inner.active_commands.get_mut(project_id) else {
            return false;
        };
        let before = commands.len();
        commands.retain(|command| command.token != token);
        let removed = commands.len() != before;
        let empty = commands.is_empty();
        if removed {
            inner.active_command_count = inner.active_command_count.saturating_sub(1);
        }
        if empty {
            inner.active_commands.remove(project_id);
        }
        removed
    }
}

impl Drop for ActiveCommandGuard {
    fn drop(&mut self) {
        if self.presence.finish_command(&self.project_id, self.token) {
            queue_invalidation(
                &self.invalidations,
                &self.observation_sequence,
                self.state_revision,
            );
        }
    }
}

fn queue_invalidation(
    invalidations: &mpsc::Sender<InvalidationRequest>,
    observation_sequence: &AtomicU64,
    state_revision: u64,
) {
    let _ = invalidations.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Steward],
        state_revision,
        observation_sequence: observation_sequence.load(Ordering::Relaxed),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_is_bounded_and_command_nesting_restores_the_previous_label() {
        let state = StewardPresenceState::default();
        for index in 0..600 {
            state.record_activity(format!("session-{index}"), 1, index);
        }
        assert!(state.inner.lock().expect("presence").activities.len() <= MAX_ACTIVITY_SESSIONS);

        let (sender, _receiver) = mpsc::channel(8);
        let sequence = Arc::new(AtomicU64::new(0));
        let first = state
            .try_begin_command("project", "task_read", sender.clone(), sequence.clone(), 1)
            .unwrap();
        let second = state
            .try_begin_command("project", "task_create", sender, sequence, 1)
            .unwrap();
        assert_eq!(
            state.active_command("project").as_deref(),
            Some("task_create")
        );
        drop(second);
        assert_eq!(
            state.active_command("project").as_deref(),
            Some("task_read")
        );
        drop(first);
        assert!(state.active_command("project").is_none());
    }
}
