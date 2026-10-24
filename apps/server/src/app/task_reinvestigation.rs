//! Periodic re-investigation for Projects opened as Project Manager: each open
//! Task's one running Agent is asked, through Core's visible re-investigation
//! template, to check its Task again about once an hour. The schedule is
//! runtime-only; a daemon restart starts every Task's interval afresh.

use std::collections::HashMap;
use std::time::Duration;

use termloop_core::companion_integrations::tracker_runtime::TaskReinvestigationReason;

use super::AppState;

const TICK: Duration = Duration::from_secs(5 * 60);
const INTERVAL_MS: u64 = 60 * 60 * 1000;

pub(super) async fn run_task_reinvestigations(state: AppState) {
    let mut last_asked = HashMap::<String, u64>::new();
    loop {
        tokio::time::sleep(TICK).await;
        let now = super::current_epoch_ms();
        let mut core = state.core.lock().await;
        let due = due_tasks(
            &mut last_asked,
            core.project_manager_reinvestigation_task_ids(),
            now,
        );
        for task_id in due {
            if let Err(error) =
                core.request_task_reinvestigation(&task_id, TaskReinvestigationReason::Scheduled)
            {
                tracing::debug!(%task_id, ?error, "Scheduled Task re-investigation was not delivered");
            }
        }
    }
}

/// A Task first seen is scheduled one interval later, so a Task Agent that just
/// opened with its investigation is not asked again right away. Tasks that
/// left the eligible set are forgotten.
fn due_tasks(
    last_asked: &mut HashMap<String, u64>,
    eligible: Vec<String>,
    now: u64,
) -> Vec<String> {
    last_asked.retain(|task_id, _| eligible.contains(task_id));
    let mut due = Vec::new();
    for task_id in eligible {
        let asked = last_asked.entry(task_id.clone()).or_insert(now);
        if now.saturating_sub(*asked) >= INTERVAL_MS {
            *asked = now;
            due.push(task_id);
        }
    }
    due
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_are_asked_once_per_interval_starting_one_interval_after_first_sight() {
        let mut last = HashMap::new();
        assert!(due_tasks(&mut last, vec!["a".into()], 0).is_empty());
        assert!(due_tasks(&mut last, vec!["a".into()], INTERVAL_MS - 1).is_empty());
        assert_eq!(due_tasks(&mut last, vec!["a".into()], INTERVAL_MS), ["a"]);
        assert!(due_tasks(&mut last, vec!["a".into()], INTERVAL_MS + 1).is_empty());
        // A Task that leaves and returns starts its interval again.
        assert!(due_tasks(&mut last, vec![], INTERVAL_MS * 3).is_empty());
        assert!(due_tasks(&mut last, vec!["a".into()], INTERVAL_MS * 3).is_empty());
    }
}
