/// What a resting Claude turn is still waiting on. Claude's `Stop` hook reports
/// the background shells and subagents it started and the session crons it
/// scheduled; each one ends in a new turn without the user typing anything, so
/// a resting Session with any of them is not finished, only waiting.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentPendingWakes {
    pub background_tasks: u32,
    pub scheduled_wakes: u32,
    /// The first few of those, named the way the agent described them, so a
    /// waiting row can say what it waits on instead of only how many.
    pub waiting_on: Vec<AgentPendingWake>,
}

impl AgentPendingWakes {
    pub fn is_empty(&self) -> bool {
        self.background_tasks == 0 && self.scheduled_wakes == 0
    }
}

/// One named piece of work a resting turn waits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPendingWake {
    pub kind: AgentPendingWakeKind,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPendingWakeKind {
    Shell,
    Subagent,
    Monitor,
    Workflow,
    /// Any other background work, reported under a label not named here.
    Task,
    Scheduled,
}

impl AgentPendingWakeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Subagent => "subagent",
            Self::Monitor => "monitor",
            Self::Workflow => "workflow",
            Self::Task => "task",
            Self::Scheduled => "scheduled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "shell" => Self::Shell,
            "subagent" => Self::Subagent,
            "monitor" => Self::Monitor,
            "workflow" => Self::Workflow,
            "task" => Self::Task,
            "scheduled" => Self::Scheduled,
            _ => return None,
        })
    }

    fn from_claude_task_type(value: Option<&str>) -> Self {
        match value {
            Some("shell") => Self::Shell,
            Some("subagent") => Self::Subagent,
            Some("monitor") => Self::Monitor,
            Some("workflow") => Self::Workflow,
            _ => Self::Task,
        }
    }
}

/// Matches the contract bound on each count.
const MAX_PENDING_WAKES: usize = 1024;
/// Matches the contract bounds on the named list and on each label.
const MAX_PENDING_WAKES_NAMED: usize = 3;
const MAX_PENDING_WAKE_LABEL_CHARS: usize = 120;

/// Collapses whitespace, including a multi-line command, onto one line and
/// clips it to the contract bound. Text with nothing in it names nothing.
fn pending_wake_label(text: &str) -> Option<String> {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.is_empty() {
        return None;
    }
    if joined.chars().count() <= MAX_PENDING_WAKE_LABEL_CHARS {
        return Some(joined);
    }
    let mut clipped: String = joined
        .chars()
        .take(MAX_PENDING_WAKE_LABEL_CHARS - 1)
        .collect::<String>()
        .trim_end()
        .to_owned();
    clipped.push('\u{2026}');
    Some(clipped)
}

fn field_text<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(serde_json::Value::as_str)
}

/// Publishing an Artifact makes Claude watch it for comments with a monitor
/// that stays running for the rest of the Session. A comment would wake the
/// turn, but that watch is ambient and never finishes, so counting it would
/// leave every Session that published an Artifact waiting forever. Claude
/// describes that task as `live updates for artifact <slug> (...)`.
fn is_artifact_comment_watch(task: &serde_json::Value) -> bool {
    field_text(task, "type") == Some("monitor")
        && field_text(task, "description")
            .is_some_and(|description| description.starts_with("live updates for artifact "))
}

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
    let running: Vec<&serde_json::Value> = payload
        .get("background_tasks")
        .and_then(serde_json::Value::as_array)
        .map(|tasks| {
            tasks
                .iter()
                .filter(|task| {
                    field_text(task, "status") == Some("running")
                        && !is_artifact_comment_watch(task)
                })
                .take(MAX_PENDING_WAKES)
                .collect()
        })
        .unwrap_or_default();
    let crons: &[serde_json::Value] = payload
        .get("session_crons")
        .and_then(serde_json::Value::as_array)
        .map_or(&[], Vec::as_slice);
    // The agent's own description reads best; a shell started without one is
    // still recognizable by its command.
    let named_tasks = running.iter().filter_map(|task| {
        let label = field_text(task, "description")
            .and_then(pending_wake_label)
            .or_else(|| field_text(task, "command").and_then(pending_wake_label))?;
        Some(AgentPendingWake {
            kind: AgentPendingWakeKind::from_claude_task_type(field_text(task, "type")),
            label,
        })
    });
    let named_crons = crons.iter().filter_map(|cron| {
        Some(AgentPendingWake {
            kind: AgentPendingWakeKind::Scheduled,
            label: field_text(cron, "prompt").and_then(pending_wake_label)?,
        })
    });
    Some(AgentPendingWakes {
        background_tasks: running.len() as u32,
        scheduled_wakes: crons.len().min(MAX_PENDING_WAKES) as u32,
        waiting_on: named_tasks
            .chain(named_crons)
            .take(MAX_PENDING_WAKES_NAMED)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wake(kind: AgentPendingWakeKind, label: &str) -> AgentPendingWake {
        AgentPendingWake {
            kind,
            label: label.into(),
        }
    }

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
                waiting_on: Vec::new(),
            })
        );
    }

    #[test]
    fn an_artifact_comment_watch_is_not_pending_work() {
        let payload = json!({
            "hook_event_name": "Stop",
            "background_tasks": [
                {
                    "id": "w1",
                    "type": "monitor",
                    "status": "running",
                    "description": "live updates for artifact c3522e28 (comments)",
                },
                {
                    "id": "m1",
                    "type": "monitor",
                    "status": "running",
                    "description": "tail deploy log",
                },
            ],
        });
        assert_eq!(
            normalize_claude_pending_wakes(&payload),
            Some(AgentPendingWakes {
                background_tasks: 1,
                scheduled_wakes: 0,
                waiting_on: vec![wake(AgentPendingWakeKind::Monitor, "tail deploy log")],
            })
        );
    }

    #[test]
    fn a_stop_names_the_first_few_pending_wakes() {
        let payload = json!({
            "hook_event_name": "Stop",
            "background_tasks": [
                { "type": "shell", "status": "running", "description": "Run desktop tests", "command": "pnpm test" },
                { "type": "shell", "status": "running", "description": " ", "command": "cargo test \\\n  -p termloop-agents" },
                { "type": "teammate", "status": "running", "description": "Pair on review" },
                { "type": "subagent", "status": "running", "description": "Past the named bound" },
            ],
            "session_crons": [{ "id": "c1", "prompt": "check the deploy" }],
        });
        let pending = normalize_claude_pending_wakes(&payload).unwrap();
        assert_eq!(pending.background_tasks, 4);
        assert_eq!(pending.scheduled_wakes, 1);
        assert_eq!(
            pending.waiting_on,
            vec![
                wake(AgentPendingWakeKind::Shell, "Run desktop tests"),
                wake(
                    AgentPendingWakeKind::Shell,
                    "cargo test \\ -p termloop-agents"
                ),
                wake(AgentPendingWakeKind::Task, "Pair on review"),
            ]
        );
    }

    #[test]
    fn a_scheduled_wake_is_named_by_its_prompt() {
        let payload = json!({
            "hook_event_name": "Stop",
            "background_tasks": [{ "type": "shell", "status": "running" }],
            "session_crons": [{ "id": "c1", "prompt": "check the deploy" }],
        });
        assert_eq!(
            normalize_claude_pending_wakes(&payload).unwrap().waiting_on,
            vec![wake(AgentPendingWakeKind::Scheduled, "check the deploy")]
        );
    }

    #[test]
    fn a_label_is_one_line_within_the_contract_bound() {
        let clipped = pending_wake_label(&"word ".repeat(60)).unwrap();
        assert!(clipped.chars().count() <= MAX_PENDING_WAKE_LABEL_CHARS);
        assert!(clipped.ends_with('\u{2026}'));
        let unbroken = pending_wake_label(&"x".repeat(300)).unwrap();
        assert_eq!(unbroken.chars().count(), MAX_PENDING_WAKE_LABEL_CHARS);
        assert_eq!(pending_wake_label("  \n "), None);
        for kind in [
            AgentPendingWakeKind::Shell,
            AgentPendingWakeKind::Subagent,
            AgentPendingWakeKind::Monitor,
            AgentPendingWakeKind::Workflow,
            AgentPendingWakeKind::Task,
            AgentPendingWakeKind::Scheduled,
        ] {
            assert_eq!(AgentPendingWakeKind::parse(kind.as_str()), Some(kind));
        }
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
