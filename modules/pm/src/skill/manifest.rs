//! A skill manifest: what an installed capability reads, when it runs, the
//! exact tools a run may call, and its instructions. A manifest is data,
//! never code; each install records one immutable version of it.

use crate::agent::{PM_MCP_SERVER_NAME, SKILL_READ_TOOLS};
use crate::validation::{valid_label, valid_non_blank_text};

pub const SKILL_NAME_MAX_CHARS: usize = 80;
pub const SKILL_DESCRIPTION_MAX_CHARS: usize = 500;
pub const SKILL_INSTRUCTIONS_MAX_CHARS: usize = 8_000;
pub const SKILL_TOOLS_MAX: usize = 16;
pub const SKILL_CHANNELS_MAX: usize = 20;
/// Tools of the agent's own MCP servers one skill may approve.
pub const SKILL_AGENT_TOOLS_MAX: usize = 8;
/// A scheduled skill runs at most this often.
pub const SKILL_SCHEDULE_MIN_MINUTES: u32 = 15;
/// And at least once a week.
pub const SKILL_SCHEDULE_MAX_MINUTES: u32 = 7 * 24 * 60;
pub(crate) const CHANNEL_ID_MAX_BYTES: usize = 32;
pub(crate) const CHANNEL_NAME_MAX_CHARS: usize = 80;
const AGENT_TOOL_NAME_MAX_BYTES: usize = 128;
/// Words that make a tool name a write; a skill run only reads.
const WRITE_WORDS: &[&str] = &[
    "add", "archive", "close", "complete", "create", "delete", "draft", "edit", "invite", "join",
    "kick", "leave", "mark", "move", "open", "pin", "post", "publish", "react", "remove", "rename",
    "reply", "schedule", "send", "set", "share", "unpin", "update", "upload", "write",
];

/// When a skill runs on its own; every skill can also be run by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SkillTrigger {
    Manual,
    #[serde(rename_all = "camelCase")]
    Schedule {
        every_minutes: u32,
    },
    Event {
        event: SkillEvent,
    },
}

/// A daemon event a skill can wait for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillEvent {
    /// A Jira pull applied changes.
    JiraPulled,
    /// A delivery check answered for a Playbook step.
    DeployChanged,
    /// A ticket or sprint changed.
    BoardChanged,
}

/// What a skill reads. Only names; the daemon owns every read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Board,
    Jira,
    Deployments,
    Slack,
    Git,
    #[serde(rename = "github")]
    GitHub,
}

/// The deterministic check that decides, before any agent starts, whether a
/// run has anything new to look at. Nothing new means no agent launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillPrefilter {
    /// Tickets changed since the last run.
    BoardChanges,
    /// Slack messages since the channel watermarks that name a ticket key,
    /// a sprint ticket title, or an assignee.
    SlackMentions,
    /// New or changed tickets that read like a bug.
    BugTickets,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillManifest {
    pub name: String,
    /// Plain language: what the skill does for the project manager.
    pub description: String,
    pub trigger: SkillTrigger,
    pub sources: Vec<SkillSource>,
    pub prefilter: SkillPrefilter,
    /// The exact read tools a run may call; proposal tools are added to
    /// every run. Nothing else is visible to it.
    pub approved_tools: Vec<String>,
    /// The run's prompt.
    pub instructions: String,
    /// The Slack channels the skill reads; only for a Slack source.
    #[serde(default)]
    pub channels: Vec<SkillChannel>,
    /// Read-only tools of the agent's own MCP servers a run may call
    /// without asking, as `mcp__<server>__<tool>`; Slack is read this way.
    #[serde(default)]
    pub agent_tools: Vec<String>,
}

/// A Slack channel a skill reads, as the creator listed it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillChannel {
    pub id: String,
    pub name: String,
}

impl SkillChannel {
    fn is_valid(&self) -> bool {
        valid_channel_id(&self.id) && valid_label(&self.name, CHANNEL_NAME_MAX_CHARS)
    }
}

/// A read-only tool of one of the agent's own MCP servers, named the way
/// the agent sees it: `mcp__<server>__<tool>`, never a PM tool and never a
/// name that reads like a write.
pub fn valid_agent_tool(name: &str) -> bool {
    name.len() <= AGENT_TOOL_NAME_MAX_BYTES
        && termloop_launch::external_tool(name, PM_MCP_SERVER_NAME).is_ok_and(|(_, tool)| {
            !tool_words(tool).any(|word| WRITE_WORDS.contains(&word.as_str()))
        })
}

/// The lowercase words of a tool name: split on `_`, `-` and camel case.
fn tool_words(tool: &str) -> impl Iterator<Item = String> + '_ {
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut previous_lower = false;
    for character in tool.chars() {
        if character == '_' || character == '-' {
            words.push(std::mem::take(&mut word));
            previous_lower = false;
            continue;
        }
        if character.is_ascii_uppercase() && previous_lower {
            words.push(std::mem::take(&mut word));
        }
        previous_lower = character.is_ascii_lowercase() || character.is_ascii_digit();
        word.push(character.to_ascii_lowercase());
    }
    words.push(word);
    words.into_iter().filter(|word| !word.is_empty())
}

fn unique<T: PartialEq>(items: &[T]) -> bool {
    items
        .iter()
        .enumerate()
        .all(|(index, item)| !items[index + 1..].contains(item))
}

fn valid_channel_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= CHANNEL_ID_MAX_BYTES
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

impl SkillManifest {
    /// Why the manifest is refused, naming the field; `None` when valid.
    pub fn invalid_field(&self) -> Option<&'static str> {
        if !valid_label(&self.name, SKILL_NAME_MAX_CHARS) {
            return Some("name");
        }
        if !valid_label(&self.description, SKILL_DESCRIPTION_MAX_CHARS) {
            return Some("description");
        }
        if let SkillTrigger::Schedule { every_minutes } = self.trigger
            && !(SKILL_SCHEDULE_MIN_MINUTES..=SKILL_SCHEDULE_MAX_MINUTES).contains(&every_minutes)
        {
            return Some("trigger");
        }
        if self.sources.is_empty() || !unique(&self.sources) {
            return Some("sources");
        }
        if self.approved_tools.len() > SKILL_TOOLS_MAX
            || !unique(&self.approved_tools)
            || !self
                .approved_tools
                .iter()
                .all(|tool| SKILL_READ_TOOLS.contains(&tool.as_str()))
        {
            return Some("approvedTools");
        }
        if !valid_non_blank_text(&self.instructions, SKILL_INSTRUCTIONS_MAX_CHARS) {
            return Some("instructions");
        }
        let slack = self.sources.contains(&SkillSource::Slack);
        let ids: Vec<&str> = self
            .channels
            .iter()
            .map(|channel| channel.id.as_str())
            .collect();
        if self.channels.len() > SKILL_CHANNELS_MAX
            || !unique(&ids)
            || !self.channels.iter().all(SkillChannel::is_valid)
            || (!slack && !self.channels.is_empty())
            || (slack
                && self.prefilter == SkillPrefilter::SlackMentions
                && self.channels.is_empty())
        {
            return Some("channels");
        }
        if self.agent_tools.len() > SKILL_AGENT_TOOLS_MAX
            || !unique(&self.agent_tools)
            || !self.agent_tools.iter().all(|tool| valid_agent_tool(tool))
        {
            return Some("agentTools");
        }
        let fits = match self.prefilter {
            SkillPrefilter::BoardChanges | SkillPrefilter::BugTickets => true,
            SkillPrefilter::SlackMentions => slack,
        };
        (!fits).then_some("prefilter")
    }

    pub fn is_valid(&self) -> bool {
        self.invalid_field().is_none()
    }

    /// Every tool a run may call beyond proposals: the PM read tools and
    /// the agent's own; each needs an approval the first time.
    pub fn all_tools(&self) -> impl Iterator<Item = &String> {
        self.approved_tools.iter().chain(&self.agent_tools)
    }

    pub fn reads_channel(&self, id: &str) -> bool {
        self.channels.iter().any(|channel| channel.id == id)
    }

    pub fn schedule_minutes(&self) -> Option<u32> {
        match self.trigger {
            SkillTrigger::Schedule { every_minutes } => Some(every_minutes),
            _ => None,
        }
    }

    pub fn waits_for(&self, event: SkillEvent) -> bool {
        self.trigger == SkillTrigger::Event { event }
    }
}
