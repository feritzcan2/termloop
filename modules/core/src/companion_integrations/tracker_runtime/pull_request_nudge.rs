//! Pull-request nudges: a Task whose pull request opened, merged, or changed
//! its checks is asked at its current automatic step soon, rather than after
//! the rest of that step's delay. The nudge only moves the next attempt
//! earlier; the evaluation still reads live provider state itself.

use super::*;

/// Coalesces a burst of observations (checks starting, then finishing) into
/// one evaluation.
pub(super) const NUDGE_DEBOUNCE_MS: u64 = 15_000;
const NUDGES_MAX: usize = 256;

impl CoreRuntime {
    /// When this Task's step was nudged to run, or `u64::MAX` when it was not.
    pub(crate) fn step_nudge_epoch_ms(&self, routine_id: &str, task_id: &str) -> u64 {
        self.tracker_runtime
            .step_task_nudge
            .get(&(routine_id.to_owned(), task_id.to_owned()))
            .copied()
            .unwrap_or(u64::MAX)
    }

    /// Brings each Task's current automatic step forward. Returns whether any
    /// step became due earlier, so the caller wakes the step scheduler.
    pub(crate) fn nudge_playbook_steps(&mut self, task_ids: &[String], now_epoch_ms: u64) -> bool {
        let wake_at = now_epoch_ms.saturating_add(NUDGE_DEBOUNCE_MS);
        let mut nudged = false;
        for task_id in task_ids {
            let Some((routine_id, due_at)) = self.playbook_automatic_step_for_task(task_id) else {
                continue;
            };
            let active = self.store.tracker_configurations().iter().any(|routine| {
                routine.id == routine_id
                    && routine.enabled
                    && !routine.trigger_mode.is_scheduled()
                    && self.playbook_automation_enabled(&routine.project_id)
            });
            // A step that is already due, or being checked, needs no nudge.
            if !active
                || due_at <= wake_at
                || self
                    .tracker_runtime
                    .step_task_is_checked(&routine_id, task_id)
            {
                continue;
            }
            let entry = self
                .tracker_runtime
                .step_task_nudge
                .entry((routine_id, task_id.clone()))
                .or_insert(wake_at);
            *entry = (*entry).min(wake_at);
            nudged = true;
        }
        while self.tracker_runtime.step_task_nudge.len() > NUDGES_MAX {
            let Some(latest) = self
                .tracker_runtime
                .step_task_nudge
                .iter()
                .max_by_key(|(key, at)| (**at, (*key).clone()))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.tracker_runtime.step_task_nudge.remove(&latest);
        }
        if nudged {
            self.initialize_routine_schedules();
        }
        nudged
    }
}
