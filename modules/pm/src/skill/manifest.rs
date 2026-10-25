//! A skill manifest: what an installed capability reads, when it runs, the
//! exact tools a run may call, and its instructions. A manifest is data,
//! never code; each install records one immutable version of it.

use crate::agent::SKILL_READ_TOOLS;
use crate::validation::{valid_label, valid_non_blank_text};

pub const SKILL_NAME_MAX_CHARS: usize = 80;
pub const SKILL_DESCRIPTION_MAX_CHARS: usize = 500;
pub const SKILL_INSTRUCTIONS_MAX_CHARS: usize = 8_000;
pub const SKILL_TOOLS_MAX: usize = 16;
pub const SKILL_CHANNELS_MAX: usize = 20;
/// A scheduled skill runs at most this often.
pub const SKILL_SCHEDULE_MIN_MINUTES: u32 = 15;
/// And at least once a week.
pub const SKILL_SCHEDULE_MAX_MINUTES: u32 = 7 * 24 * 60;
const CHANNEL_ID_MAX_BYTES: usize = 32;

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
    /// A probe run or delivery check changed what runs where.
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
    /// Delivery checks that are due; the built-in Deployment control only.
    DeliveryChecks,
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
    /// Slack channel ids the skill reads; only for a Slack source.
    #[serde(default)]
    pub channels: Vec<String>,
}

fn unique<T: PartialEq>(items: &[T]) -> bool {
    items
        .iter()
        .enumerate()
        .all(|(index, item)| !items[index + 1..].contains(item))
}

pub(crate) fn valid_channel_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= CHANNEL_ID_MAX_BYTES
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

impl SkillManifest {
    /// Why the manifest is refused, naming the field; `None` when valid.
    pub fn invalid_field(&self) -> Option<&'static str> {
        self.invalid_field_of(false)
    }

    pub(crate) fn invalid_field_of(&self, builtin: bool) -> Option<&'static str> {
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
        if self.channels.len() > SKILL_CHANNELS_MAX
            || !unique(&self.channels)
            || !self.channels.iter().all(|id| valid_channel_id(id))
            || (!slack && !self.channels.is_empty())
        {
            return Some("channels");
        }
        let fits = match self.prefilter {
            SkillPrefilter::BoardChanges | SkillPrefilter::BugTickets => true,
            SkillPrefilter::SlackMentions => slack,
            // Only the built-in skill wraps delivery checks.
            SkillPrefilter::DeliveryChecks => builtin,
        };
        (!fits).then_some("prefilter")
    }

    pub fn is_valid(&self) -> bool {
        self.invalid_field().is_none()
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
