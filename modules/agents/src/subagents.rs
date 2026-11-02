/// The in-process subagents a Claude Session is running. Claude reports a
/// child's lifecycle through `SubagentStart`/`SubagentStop`, tags every hook a
/// child fires with its `agent_id`, and lists still-running background children
/// in the lead `Stop`. The hook process turns each payload into one bounded
/// update keyed by an opaque digest of the provider id, so the provider's
/// child identity never leaves the hook process; the daemon folds the updates
/// into a runtime-only roster the Session row renders as nested children.
use sha2::{Digest, Sha256};
use std::collections::VecDeque;

/// Matches the contract bound on the projected roster.
pub const MAX_AGENT_SUBAGENTS: usize = 16;
const MAX_PENDING_LAUNCHES: usize = 8;
const MAX_SUBAGENT_ID_BYTES: usize = 128;
pub const MAX_SUBAGENT_TYPE_BYTES: usize = 64;
pub const MAX_SUBAGENT_TEXT_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSubagentListing {
    pub key: String,
    pub agent_type: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSubagentUpdate {
    /// The lead called its `Agent` tool; the child it starts next inherits
    /// this description, because `SubagentStart` carries none.
    Launching {
        agent_type: Option<String>,
        description: Option<String>,
    },
    Started {
        key: String,
        agent_type: Option<String>,
    },
    /// A hook the child itself fired, which also proves it is still alive.
    Active {
        key: String,
        agent_type: Option<String>,
        activity: Option<String>,
    },
    /// A background launch returned and named the child it started.
    Described {
        key: String,
        description: String,
    },
    Stopped {
        key: String,
    },
    /// A lead `Stop` lists every child still running. Foreground children
    /// cannot outlive the lead turn, so anything unlisted has ended even when
    /// its `SubagentStop` was lost.
    Inventory(Vec<AgentSubagentListing>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSubagent {
    pub key: String,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub activity: Option<String>,
    pub started_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentSubagentRoster {
    children: Vec<AgentSubagent>,
    pending_launches: VecDeque<(Option<String>, Option<String>)>,
}

impl AgentSubagentRoster {
    pub fn children(&self) -> &[AgentSubagent] {
        &self.children
    }

    pub fn clear(&mut self) -> bool {
        let changed = !self.children.is_empty();
        self.children.clear();
        self.pending_launches.clear();
        changed
    }

    /// Applies one update and reports whether the projected children changed.
    pub fn apply(&mut self, update: AgentSubagentUpdate, now_epoch_ms: u64) -> bool {
        let before = self.children.clone();
        match update {
            AgentSubagentUpdate::Launching {
                agent_type,
                description,
            } => {
                if self.pending_launches.len() == MAX_PENDING_LAUNCHES {
                    self.pending_launches.pop_front();
                }
                self.pending_launches.push_back((agent_type, description));
            }
            AgentSubagentUpdate::Started { key, agent_type } => {
                if !self.children.iter().any(|child| child.key == key) {
                    let description = self.take_launch_description(agent_type.as_deref());
                    self.insert(key, agent_type, description, now_epoch_ms);
                }
            }
            AgentSubagentUpdate::Active {
                key,
                agent_type,
                activity,
            } => {
                let child = self.upsert(key, now_epoch_ms);
                if let Some(child) = child {
                    if child.agent_type.is_none() {
                        child.agent_type = agent_type;
                    }
                    if activity.is_some() {
                        child.activity = activity;
                    }
                }
            }
            AgentSubagentUpdate::Described { key, description } => {
                if let Some(child) = self.upsert(key, now_epoch_ms) {
                    child.description = Some(description);
                }
            }
            AgentSubagentUpdate::Stopped { key } => {
                self.children.retain(|child| child.key != key);
            }
            AgentSubagentUpdate::Inventory(listings) => {
                self.pending_launches.clear();
                self.children
                    .retain(|child| listings.iter().any(|listing| listing.key == child.key));
                for listing in listings {
                    match self
                        .children
                        .iter_mut()
                        .find(|child| child.key == listing.key)
                    {
                        Some(child) => {
                            if child.agent_type.is_none() {
                                child.agent_type = listing.agent_type;
                            }
                            if child.description.is_none() {
                                child.description = listing.description;
                            }
                        }
                        None => self.insert(
                            listing.key,
                            listing.agent_type,
                            listing.description,
                            now_epoch_ms,
                        ),
                    }
                }
            }
        }
        self.children != before
    }

    fn take_launch_description(&mut self, agent_type: Option<&str>) -> Option<String> {
        let index = self
            .pending_launches
            .iter()
            .position(|(launch_type, _)| launch_type.as_deref() == agent_type)
            .or_else(|| (!self.pending_launches.is_empty()).then_some(0))?;
        self.pending_launches.remove(index)?.1
    }

    fn insert(
        &mut self,
        key: String,
        agent_type: Option<String>,
        description: Option<String>,
        now_epoch_ms: u64,
    ) {
        if self.children.len() < MAX_AGENT_SUBAGENTS {
            self.children.push(AgentSubagent {
                key,
                agent_type,
                description,
                activity: None,
                started_at_epoch_ms: now_epoch_ms,
            });
        }
    }

    fn upsert(&mut self, key: String, now_epoch_ms: u64) -> Option<&mut AgentSubagent> {
        if !self.children.iter().any(|child| child.key == key) {
            let description = self.take_launch_description(None);
            self.insert(key.clone(), None, description, now_epoch_ms);
        }
        self.children.iter_mut().find(|child| child.key == key)
    }
}

/// Reads the one subagent fact a Claude hook payload carries, if any.
pub fn normalize_claude_subagent_update(
    payload: &serde_json::Value,
) -> Option<AgentSubagentUpdate> {
    let event = text(payload, &["hook_event_name", "hookEventName"])?;
    let child_key = text(payload, &["agent_id", "agentId"])
        .filter(|id| id.len() <= MAX_SUBAGENT_ID_BYTES)
        .map(subagent_key);
    let agent_type = bounded(
        payload,
        &["agent_type", "agentType"],
        MAX_SUBAGENT_TYPE_BYTES,
    );
    if let Some(key) = child_key {
        return Some(match event {
            "SubagentStart" => AgentSubagentUpdate::Started { key, agent_type },
            // An API error skips the child's `SubagentStop` and reports only a
            // `StopFailure` carrying its id.
            "SubagentStop" | "StopFailure" => AgentSubagentUpdate::Stopped { key },
            _ => AgentSubagentUpdate::Active {
                key,
                agent_type,
                activity: (event == "PreToolUse")
                    .then(|| tool_activity(payload))
                    .flatten(),
            },
        });
    }
    match event {
        "Stop" => Some(AgentSubagentUpdate::Inventory(
            payload
                .get("background_tasks")
                .and_then(serde_json::Value::as_array)
                .map(|tasks| {
                    tasks
                        .iter()
                        .filter(|task| {
                            text(task, &["type"]) == Some("subagent")
                                && text(task, &["status"]) == Some("running")
                        })
                        .filter_map(|task| {
                            Some(AgentSubagentListing {
                                key: subagent_key(
                                    text(task, &["id"])
                                        .filter(|id| id.len() <= MAX_SUBAGENT_ID_BYTES)?,
                                ),
                                agent_type: bounded(
                                    task,
                                    &["agent_type", "agentType"],
                                    MAX_SUBAGENT_TYPE_BYTES,
                                ),
                                description: bounded(
                                    task,
                                    &["description"],
                                    MAX_SUBAGENT_TEXT_BYTES,
                                ),
                            })
                        })
                        .take(MAX_AGENT_SUBAGENTS)
                        .collect()
                })
                .unwrap_or_default(),
        )),
        "PreToolUse" | "PostToolUse" if is_agent_tool(payload) => {
            let input = payload
                .get("tool_input")
                .or_else(|| payload.get("toolInput"));
            if event == "PreToolUse" {
                return Some(AgentSubagentUpdate::Launching {
                    agent_type: input.and_then(|input| {
                        bounded(input, &["subagent_type"], MAX_SUBAGENT_TYPE_BYTES)
                    }),
                    description: input.and_then(|input| {
                        bounded(input, &["description"], MAX_SUBAGENT_TEXT_BYTES)
                    }),
                });
            }
            // A foreground launch reports only after its child finished, so
            // only an asynchronous launch still names a running child.
            let response = payload
                .get("tool_response")
                .or_else(|| payload.get("toolResponse"))?;
            if text(response, &["status"]) != Some("async_launched") {
                return None;
            }
            Some(AgentSubagentUpdate::Described {
                key: subagent_key(
                    text(response, &["agentId", "agent_id"])
                        .filter(|id| id.len() <= MAX_SUBAGENT_ID_BYTES)?,
                ),
                description: bounded(response, &["description"], MAX_SUBAGENT_TEXT_BYTES).or_else(
                    || {
                        input.and_then(|input| {
                            bounded(input, &["description"], MAX_SUBAGENT_TEXT_BYTES)
                        })
                    },
                )?,
            })
        }
        _ => None,
    }
}

fn is_agent_tool(payload: &serde_json::Value) -> bool {
    matches!(
        text(payload, &["tool_name", "toolName"]),
        Some("Agent" | "Task")
    )
}

fn tool_activity(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("tool_input")
        .or_else(|| payload.get("toolInput"))
        .and_then(|input| bounded(input, &["description"], MAX_SUBAGENT_TEXT_BYTES))
        .or_else(|| bounded(payload, &["tool_name", "toolName"], MAX_SUBAGENT_TYPE_BYTES))
}

/// An opaque, stable stand-in for the provider's child id.
fn subagent_key(provider_id: &str) -> String {
    Sha256::digest(provider_id.as_bytes())[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn text<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key))?
        .as_str()
        .filter(|value| !value.trim().is_empty())
}

/// Keeps a display string within its byte bound, cutting on a character
/// boundary rather than dropping a long description outright.
fn bounded(value: &serde_json::Value, keys: &[&str], max_bytes: usize) -> Option<String> {
    let value = text(value, keys)?.trim();
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    Some(value[..end].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn apply(roster: &mut AgentSubagentRoster, payload: serde_json::Value) -> bool {
        roster.apply(
            normalize_claude_subagent_update(&payload).expect("subagent update"),
            1_000,
        )
    }

    #[test]
    fn a_started_child_takes_the_description_of_its_launch_and_leaves_on_stop() {
        let mut roster = AgentSubagentRoster::default();
        assert!(!apply(
            &mut roster,
            json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Agent",
                "tool_input": { "description": "Review the diff", "subagent_type": "code-reviewer" },
            })
        ));
        assert!(apply(
            &mut roster,
            json!({ "hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "code-reviewer" })
        ));
        assert!(apply(
            &mut roster,
            json!({
                "hook_event_name": "PreToolUse",
                "agent_id": "a1",
                "tool_name": "Bash",
                "tool_input": { "command": "git diff", "description": "Show the diff" },
            })
        ));
        let child = &roster.children()[0];
        assert_eq!(child.key, subagent_key("a1"));
        assert_ne!(child.key, "a1");
        assert_eq!(child.agent_type.as_deref(), Some("code-reviewer"));
        assert_eq!(child.description.as_deref(), Some("Review the diff"));
        assert_eq!(child.activity.as_deref(), Some("Show the diff"));

        assert!(apply(
            &mut roster,
            json!({ "hook_event_name": "SubagentStop", "agent_id": "a1", "agent_type": "code-reviewer" })
        ));
        assert!(roster.children().is_empty());
    }

    #[test]
    fn a_start_less_stop_changes_nothing() {
        let mut roster = AgentSubagentRoster::default();
        assert!(!apply(
            &mut roster,
            json!({ "hook_event_name": "SubagentStop", "agent_id": "summarizer", "agent_type": "" })
        ));
    }

    #[test]
    fn a_lead_stop_keeps_only_running_background_children() {
        let mut roster = AgentSubagentRoster::default();
        apply(
            &mut roster,
            json!({ "hook_event_name": "SubagentStart", "agent_id": "foreground" }),
        );
        apply(
            &mut roster,
            json!({ "hook_event_name": "SubagentStart", "agent_id": "background" }),
        );
        assert!(apply(
            &mut roster,
            json!({
                "hook_event_name": "Stop",
                "background_tasks": [
                    { "id": "background", "type": "subagent", "status": "running", "description": "Sleep 8 seconds", "agent_type": "general-purpose" },
                    { "id": "shell", "type": "shell", "status": "running" },
                    { "id": "done", "type": "subagent", "status": "completed" },
                ],
            })
        ));
        let keys: Vec<_> = roster.children().iter().map(|child| &child.key).collect();
        assert_eq!(keys, vec![&subagent_key("background")]);
        assert_eq!(
            roster.children()[0].description.as_deref(),
            Some("Sleep 8 seconds")
        );
        assert!(apply(
            &mut roster,
            json!({ "hook_event_name": "Stop", "background_tasks": [] })
        ));
        assert!(roster.children().is_empty());
    }

    #[test]
    fn only_an_asynchronous_launch_result_names_a_running_child() {
        let foreground = json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "Agent",
            "tool_input": { "description": "Look around" },
            "tool_response": { "status": "completed", "agentId": "a1" },
        });
        assert_eq!(normalize_claude_subagent_update(&foreground), None);
        let background = json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "Agent",
            "tool_input": { "description": "Run 120s sleep command" },
            "tool_response": { "isAsync": true, "status": "async_launched", "agentId": "a8", "description": "Run 120s sleep command" },
        });
        let mut roster = AgentSubagentRoster::default();
        assert!(apply(&mut roster, background));
        assert_eq!(
            roster.children()[0].description.as_deref(),
            Some("Run 120s sleep command")
        );
    }

    #[test]
    fn a_child_api_failure_ends_the_child_not_the_lead() {
        assert_eq!(
            normalize_claude_subagent_update(
                &json!({ "hook_event_name": "StopFailure", "agent_id": "a1" })
            ),
            Some(AgentSubagentUpdate::Stopped {
                key: subagent_key("a1")
            })
        );
        assert_eq!(
            normalize_claude_subagent_update(&json!({ "hook_event_name": "StopFailure" })),
            None
        );
    }

    #[test]
    fn the_roster_and_its_text_stay_bounded() {
        let mut roster = AgentSubagentRoster::default();
        for index in 0..(MAX_AGENT_SUBAGENTS + 4) {
            apply(
                &mut roster,
                json!({ "hook_event_name": "SubagentStart", "agent_id": format!("a{index}") }),
            );
        }
        assert_eq!(roster.children().len(), MAX_AGENT_SUBAGENTS);
        let long = "é".repeat(MAX_SUBAGENT_TEXT_BYTES);
        let Some(AgentSubagentUpdate::Launching { description, .. }) =
            normalize_claude_subagent_update(&json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Task",
                "tool_input": { "description": long },
            }))
        else {
            panic!("launch update");
        };
        let description = description.expect("description");
        assert!(description.len() <= MAX_SUBAGENT_TEXT_BYTES);
        assert!(roster.clear());
        assert!(roster.children().is_empty());
    }
}
