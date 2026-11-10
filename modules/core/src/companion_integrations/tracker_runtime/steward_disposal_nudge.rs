//! Steward disposal nudges: when the Steward acts on a step-waiting finding
//! and disposes it, that Task's step is asked again soon instead of after the
//! rest of its delay. The Steward never decides a step; the evaluation still
//! reads live provider state itself.
//!
//! A Task's step takes at most one such nudge. A disposal that changed
//! nothing would otherwise loop evaluation, finding, and disposal every
//! debounce window.

use super::*;

const STEWARD_DISPOSAL_NUDGES_MAX: usize = 256;

impl CoreRuntime {
    /// The Tasks of the current step-waiting findings among these IDs. Read it
    /// before the findings are removed.
    pub(crate) fn step_waiting_finding_task_ids(
        &self,
        project_id: &str,
        finding_ids: &[String],
    ) -> Vec<String> {
        let mut task_ids = Vec::new();
        for finding_id in finding_ids {
            let Some((configuration, finding)) =
                self.current_routine_finding(project_id, finding_id)
            else {
                continue;
            };
            if configuration.trigger_mode.is_scheduled() {
                continue;
            }
            if let [task_id] = finding.related_task_ids.as_slice()
                && !task_ids.contains(task_id)
            {
                task_ids.push(task_id.clone());
            }
        }
        task_ids
    }

    /// Brings each Task's current automatic step forward once after the
    /// Steward disposed its finding. Returns whether any step became due
    /// earlier, so the caller wakes the step scheduler.
    pub(crate) fn nudge_steps_after_steward_disposal(
        &mut self,
        task_ids: &[String],
        now_epoch_ms: u64,
    ) -> bool {
        let mut nudged = false;
        for task_id in task_ids {
            let Some((routine_id, _)) = self.playbook_automatic_step_for_task(task_id) else {
                continue;
            };
            let key = (routine_id, task_id.clone());
            if self
                .tracker_runtime
                .steward_disposal_nudged
                .contains_key(&key)
                || !self.nudge_playbook_steps(std::slice::from_ref(task_id), now_epoch_ms)
            {
                continue;
            }
            self.tracker_runtime
                .steward_disposal_nudged
                .insert(key, now_epoch_ms);
            nudged = true;
        }
        let remembered = &mut self.tracker_runtime.steward_disposal_nudged;
        while remembered.len() > STEWARD_DISPOSAL_NUDGES_MAX {
            let Some(oldest) = remembered
                .iter()
                .min_by_key(|(key, at)| (**at, (*key).clone()))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            remembered.remove(&oldest);
        }
        nudged
    }
}
