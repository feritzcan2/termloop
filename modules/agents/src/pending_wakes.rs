/// What a resting Claude turn is still waiting on. Claude's `Stop` hook reports
/// the background shells and subagents it started and the session crons it
/// scheduled; each one ends in a new turn without the user typing anything, so
/// a resting Session with any of them is not finished, only waiting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentPendingWakes {
    pub background_tasks: u32,
    pub scheduled_wakes: u32,
}

impl AgentPendingWakes {
    pub fn is_empty(self) -> bool {
        self.background_tasks == 0 && self.scheduled_wakes == 0
    }
}

/// Matches the contract bound on each count.
const MAX_PENDING_WAKES: usize = 1024;

/// Only a turn boundary reports the complete current snapshot, so any other
/// event carries no pending-wake fact at all.
pub fn normalize_claude_pending_wakes(payload: &serde_json::Value) -> Option<AgentPendingWakes> {
    let event = payload
        .get("hook_event_name")
        .or_else(|| payload.get("hookEventName"))?
        .as_str()?;
    if event != "Stop" {
        return None;
    }
    let background_tasks = payload
        .get("background_tasks")
        .and_then(serde_json::Value::as_array)
        .map_or(0, |tasks| {
            tasks
                .iter()
                .filter(|task| {
                    task.get("status").and_then(serde_json::Value::as_str) == Some("running")
                })
                .take(MAX_PENDING_WAKES)
                .count()
        });
    let scheduled_wakes = payload
        .get("session_crons")
        .and_then(serde_json::Value::as_array)
        .map_or(0, |crons| crons.len().min(MAX_PENDING_WAKES));
    Some(AgentPendingWakes {
        background_tasks: background_tasks as u32,
        scheduled_wakes: scheduled_wakes as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_stop_counts_running_background_tasks_and_session_crons() {
        let payload = json!({
            "hook_event_name": "Stop",
            "background_tasks": [
                { "id": "b1", "type": "shell", "status": "running" },
                { "id": "a1", "type": "subagent", "status": "running" },
                { "id": "b2", "type": "shell", "status": "completed" },
            ],
            "session_crons": [{ "id": "c1", "recurring": false }],
        });
        assert_eq!(
            normalize_claude_pending_wakes(&payload),
            Some(AgentPendingWakes {
                background_tasks: 2,
                scheduled_wakes: 1,
            })
        );
    }

    #[test]
    fn a_stop_without_either_list_reports_nothing_pending() {
        let pending = normalize_claude_pending_wakes(&json!({ "hook_event_name": "Stop" }));
        assert_eq!(pending, Some(AgentPendingWakes::default()));
        assert!(pending.unwrap().is_empty());
    }

    #[test]
    fn only_a_turn_boundary_carries_the_snapshot() {
        for event in ["SubagentStop", "PostToolUse", "UserPromptSubmit"] {
            let payload = json!({
                "hook_event_name": event,
                "background_tasks": [{ "status": "running" }],
            });
            assert_eq!(normalize_claude_pending_wakes(&payload), None, "{event}");
        }
    }

    #[test]
    fn counts_are_bounded() {
        let payload = json!({
            "hook_event_name": "Stop",
            "background_tasks": vec![json!({ "status": "running" }); 2000],
            "session_crons": vec![json!({}); 2000],
        });
        let pending = normalize_claude_pending_wakes(&payload).unwrap();
        assert_eq!(pending.background_tasks, 1024);
        assert_eq!(pending.scheduled_wakes, 1024);
    }
}
