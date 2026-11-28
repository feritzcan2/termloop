//! Remembering that the Steward dismissed a step-waiting finding.
//!
//! A waiting answer's evidence is re-worded on nearly every check, so a
//! finding keyed by evidence would come back after each dismissal and the
//! Steward would dismiss it again, filling the transcript with identical
//! receipts. A dismissal therefore records one marker in the Routine's
//! bounded deduplication checkpoint for the Task's current stay at the step:
//! the same step, the same kind of verdict, and the same send-back count.
//! New evidence within that stay is not a new decision. Passing the step
//! clears the marker, and a send-back or a change from waiting to blocked
//! yields a different marker, so the Steward hears about those again.

use termloop_domain::{
    PendingRoutineFinding, PlaybookStepProgress, PlaybookStepVerdict,
    ROUTINE_RECENT_SOURCE_KEYS_MAX, TrackerConfiguration,
};

use crate::CoreRuntime;

const STEP_DISMISSED_PREFIX: &str = "step-dismissed:";

fn task_prefix(milestone_id: &str, task_id: &str) -> String {
    format!("{STEP_DISMISSED_PREFIX}{milestone_id}:{task_id}:")
}

/// The checkpoint key for one Task's current stay at one step.
pub(super) fn step_dismissal_marker(answer: &PlaybookStepProgress) -> String {
    let verdict = match answer.verdict {
        PlaybookStepVerdict::Passed => "passed",
        PlaybookStepVerdict::Waiting => "waiting",
        PlaybookStepVerdict::Blocked => "blocked",
    };
    format!(
        "{}{verdict}:{}",
        task_prefix(&answer.milestone_id, &answer.task_id),
        answer.rewind_count
    )
}

/// Forgets every dismissal of this Task at this step once it has left it.
pub(super) fn clear_step_dismissals(
    configuration: &mut TrackerConfiguration,
    milestone_id: &str,
    task_id: &str,
) {
    let prefix = task_prefix(milestone_id, task_id);
    configuration
        .recent_source_keys
        .retain(|key| !key.starts_with(&prefix));
}

impl CoreRuntime {
    /// Keeps a dismissed step-waiting finding's Task quiet for its current
    /// stay at the step. Scheduled findings and Routine problems carry no
    /// recorded waiting answer and are left alone.
    pub(crate) fn remember_step_dismissal(
        &self,
        configuration: &mut TrackerConfiguration,
        finding: &PendingRoutineFinding,
    ) {
        if configuration.trigger_mode.is_scheduled() {
            return;
        }
        let [task_id] = finding.related_task_ids.as_slice() else {
            return;
        };
        let Some(marker) = self
            .store
            .playbook_step_progress()
            .iter()
            .find(|answer| {
                answer.task_id == *task_id
                    && answer.routine_id == configuration.id
                    && answer.verdict != PlaybookStepVerdict::Passed
                    && super::step_waiting_source_key(
                        &answer.milestone_id,
                        &answer.task_id,
                        &answer.evidence,
                    ) == finding.source_key
            })
            .map(step_dismissal_marker)
        else {
            return;
        };
        let keys = &mut configuration.recent_source_keys;
        if !keys.contains(&marker) {
            keys.push(marker);
            let excess = keys.len().saturating_sub(ROUTINE_RECENT_SOURCE_KEYS_MAX);
            keys.drain(..excess);
        }
    }
}
