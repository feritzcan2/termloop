//! Skills: installed capabilities, each a versioned manifest the PM ticks
//! on or off. A skill run is an agent launch whose only output is proposals
//! (suggestions) the PM accepts; a skill creator agent drafts manifests,
//! dry-runs them, and the PM installs a draft with an explicit approval of
//! every tool it uses for the first time.

mod manifest;
mod owners;

pub(crate) use manifest::{CHANNEL_ID_MAX_BYTES, CHANNEL_NAME_MAX_CHARS};
pub use manifest::{
    SKILL_AGENT_TOOLS_MAX, SKILL_CHANNELS_MAX, SKILL_DESCRIPTION_MAX_CHARS,
    SKILL_INSTRUCTIONS_MAX_CHARS, SKILL_NAME_MAX_CHARS, SKILL_SCHEDULE_MAX_MINUTES,
    SKILL_SCHEDULE_MIN_MINUTES, SKILL_TOOLS_MAX, SkillChannel, SkillEvent, SkillManifest,
    SkillPrefilter, SkillSource, SkillTrigger, valid_agent_tool,
};
#[cfg(test)]
pub(crate) use owners::{OWNER_CANDIDATES_MAX, OWNER_PATHS_MAX, named_paths};
pub use owners::{
    OwnerCandidate, OwnerSignal, OwnerSignalKind, OwnerSourceRead, owner_limitation, rank_owners,
    similar_tickets, ticket_paths,
};

use crate::ProposalChange;
use crate::delivery::risks::DAY_MS;
use crate::validation::{valid_id, valid_label, valid_non_blank_text};

/// Skills one project may hold, the built-in one included.
pub const PROJECT_SKILLS_MAX: usize = 32;
/// Drafts waiting for review per project.
pub const PROJECT_SKILL_DRAFTS_MAX: usize = 16;
/// Dry-run samples kept per draft.
pub const SKILL_DRAFT_SAMPLES_MAX: usize = 10;
pub const SKILL_NEEDED_TOOLS_MAX: usize = 16;
pub const SKILL_WHAT_IT_DOES_MAX_CHARS: usize = 1_000;
pub const SKILL_STEPS_MAX_CHARS: usize = 1_000;
pub const SKILL_CHANGELOG_MAX_CHARS: usize = 500;
pub const SKILL_RUN_SUMMARY_MAX_CHARS: usize = 500;
pub const SKILL_FEEDBACK_REASON_MAX_CHARS: usize = 300;
/// Runs kept per skill; older ones are dropped.
pub const SKILL_RUNS_KEPT: u32 = 200;
/// Feedback entries kept per skill; older ones are dropped.
pub const SKILL_FEEDBACK_KEPT: u32 = 500;
/// A run that has not reported by then is abandoned.
pub const SKILL_RUN_DEADLINE_MS: u64 = 20 * 60 * 1000;
/// How far back a dry run looks.
pub const SKILL_DRY_RUN_WINDOW_MS: u64 = 3 * DAY_MS;
pub const EVIDENCE_MAX: usize = 5;
pub const EVIDENCE_LABEL_MAX_CHARS: usize = 120;
pub const EVIDENCE_QUOTE_MAX_CHARS: usize = 280;
const EVIDENCE_URL_MAX_BYTES: usize = 2_048;
const NEEDED_TOOL_NAME_MAX_CHARS: usize = 80;

/// A built-in skill the PM app ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BuiltinSkill {
    /// Wraps the delivery checks and probes; on by default when the
    /// project lists environments.
    DeploymentControl,
}

crate::ticket::stored_names!(BuiltinSkill {
    DeploymentControl => "deploymentControl",
});

impl BuiltinSkill {
    pub fn manifest(self) -> SkillManifest {
        match self {
            Self::DeploymentControl => SkillManifest {
                name: "Deployment control".to_owned(),
                description: "Finds out which environments run each ticket's change: it runs \
                              the approved probes and starts a delivery check when a ticket's \
                              deployment is unknown or changed."
                    .to_owned(),
                trigger: SkillTrigger::Event {
                    event: SkillEvent::DeployChanged,
                },
                sources: vec![SkillSource::Deployments, SkillSource::Board],
                prefilter: SkillPrefilter::DeliveryChecks,
                approved_tools: Vec::new(),
                instructions: "Start the delivery checks that are due.".to_owned(),
                channels: Vec::new(),
                agent_tools: Vec::new(),
            },
        }
    }
}

/// One link a suggestion rests on: a Slack permalink, a pull request, a
/// commit. A quote is at most 280 characters; full message text is never
/// stored.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Evidence {
    pub label: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
}

impl Evidence {
    pub fn is_valid(&self) -> bool {
        valid_label(&self.label, EVIDENCE_LABEL_MAX_CHARS)
            && self.url.as_deref().is_none_or(valid_evidence_url)
            && self
                .quote
                .as_deref()
                .is_none_or(|quote| valid_label(quote, EVIDENCE_QUOTE_MAX_CHARS))
    }
}

fn valid_evidence_url(url: &str) -> bool {
    url.len() <= EVIDENCE_URL_MAX_BYTES
        && url
            .strip_prefix("https://")
            .is_some_and(|rest| !rest.is_empty() && !rest.contains('@'))
        && url.bytes().all(|byte| byte.is_ascii_graphic())
}

pub fn valid_evidence(evidence: &[Evidence]) -> bool {
    evidence.len() <= EVIDENCE_MAX && evidence.iter().all(Evidence::is_valid)
}

/// A quote cut to the stored bound on a character boundary, on one line.
pub fn bounded_quote(text: &str) -> String {
    bounded_line(text, EVIDENCE_QUOTE_MAX_CHARS)
}

/// Text on one line, cut to `max` characters on a character boundary.
pub(crate) fn bounded_line(text: &str, max: usize) -> String {
    let line: String = text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed = line.trim();
    match trimmed.char_indices().nth(max - 1) {
        Some((end, _)) => format!("{}…", trimmed[..end].trim_end()),
        None => trimmed.to_owned(),
    }
}

/// How a run ended. A running run has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillRunOutcome {
    /// The agent finished and reported.
    Reported,
    /// The agent exited without reporting, or did not start.
    Failed,
    /// The deadline passed or the daemon restarted.
    Abandoned,
    /// The prefilter found nothing new; no agent was launched.
    Skipped,
}

crate::ticket::stored_names!(SkillRunOutcome {
    Reported => "reported",
    Failed => "failed",
    Abandoned => "abandoned",
    Skipped => "skipped",
});

/// Why a run started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillRunTrigger {
    Manual,
    Schedule,
    Event,
    /// A draft's sample run; its suggestions are samples, not proposals.
    DryRun,
}

crate::ticket::stored_names!(SkillRunTrigger {
    Manual => "manual",
    Schedule => "schedule",
    Event => "event",
    DryRun => "dryRun",
});

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillRun {
    pub id: String,
    pub project_id: String,
    /// The installed skill run; `None` for a dry run.
    pub skill_id: Option<String>,
    /// The draft dry-run; `None` for an installed skill's run.
    pub draft_id: Option<String>,
    pub version: Option<u32>,
    pub trigger: SkillRunTrigger,
    /// What the prefilter kept for the run.
    pub items: u32,
    pub started_at_epoch_ms: u64,
    pub finished_at_epoch_ms: Option<u64>,
    pub outcome: Option<SkillRunOutcome>,
    pub summary: Option<String>,
}

impl SkillRun {
    pub fn is_running(&self) -> bool {
        self.finished_at_epoch_ms.is_none()
    }
}

/// An installed skill with its current manifest and derived state.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub project_id: String,
    pub builtin: Option<BuiltinSkill>,
    pub enabled: bool,
    pub version: u32,
    pub manifest: SkillManifest,
    pub last_run_at_epoch_ms: Option<u64>,
    pub last_outcome: Option<SkillRunOutcome>,
    /// The last run has not finished yet.
    pub running: bool,
    pub pending_suggestion_count: u32,
    /// Agent launches since the start of the current UTC day.
    pub runs_today: u32,
    pub consecutive_failures: u32,
    /// Set when the skill was paused after repeated failures.
    pub paused_reason: Option<String>,
    /// After a failure: when the skill is next due, backing off.
    pub next_attempt_at_epoch_ms: Option<u64>,
    pub created_at_epoch_ms: u64,
}

/// Where a draft came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillDraftOrigin {
    Creator,
    Import,
    Revision,
}

crate::ticket::stored_names!(SkillDraftOrigin {
    Creator => "creator",
    Import => "import",
    Revision => "revision",
});

/// A tool a draft needs: available ones were verified by the creator;
/// missing ones come with the exact steps for a human to add them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NeededTool {
    pub name: String,
    pub available: bool,
    #[serde(default)]
    pub steps: Option<String>,
}

impl NeededTool {
    pub fn is_valid(&self) -> bool {
        valid_label(&self.name, NEEDED_TOOL_NAME_MAX_CHARS)
            && self
                .steps
                .as_deref()
                .is_none_or(|steps| valid_non_blank_text(steps, SKILL_STEPS_MAX_CHARS))
            && (self.available || self.steps.is_some())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DryRunState {
    #[default]
    None,
    Running,
    Completed,
    Failed,
}

crate::ticket::stored_names!(DryRunState {
    None => "none",
    Running => "running",
    Completed => "completed",
    Failed => "failed",
});

/// A suggestion a dry run would have made; never a proposal.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillSample {
    pub ticket_id: String,
    pub change: ProposalChange,
    pub summary: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    pub id: String,
    pub project_id: String,
    pub origin: SkillDraftOrigin,
    /// The installed skill a revision replaces.
    pub base_skill_id: Option<String>,
    pub manifest: SkillManifest,
    pub what_it_will_do: String,
    pub needed_tools: Vec<NeededTool>,
    /// Tools no earlier version of the skill approved; each needs its own
    /// tick at install.
    pub first_use_tools: Vec<String>,
    pub changelog: Option<String>,
    pub dry_run_state: DryRunState,
    pub dry_run_at_epoch_ms: Option<u64>,
    pub samples: Vec<SkillSample>,
    pub created_at_epoch_ms: u64,
}

/// What the creator submits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSkillDraft {
    pub project_id: String,
    pub origin: SkillDraftOrigin,
    pub base_skill_id: Option<String>,
    pub manifest: SkillManifest,
    pub what_it_will_do: String,
    pub needed_tools: Vec<NeededTool>,
    pub changelog: Option<String>,
}

impl NewSkillDraft {
    pub(crate) fn invalid_field(&self) -> Option<&'static str> {
        if !valid_id(&self.project_id) {
            return Some("projectId");
        }
        if self
            .base_skill_id
            .as_deref()
            .is_some_and(|id| !valid_id(id))
            || (self.origin == SkillDraftOrigin::Revision) != self.base_skill_id.is_some()
        {
            return Some("baseSkillId");
        }
        if let Some(field) = self.manifest.invalid_field() {
            return Some(field);
        }
        if !valid_non_blank_text(&self.what_it_will_do, SKILL_WHAT_IT_DOES_MAX_CHARS) {
            return Some("whatItWillDo");
        }
        if self.needed_tools.len() > SKILL_NEEDED_TOOLS_MAX
            || !self.needed_tools.iter().all(NeededTool::is_valid)
        {
            return Some("neededTools");
        }
        if self
            .changelog
            .as_deref()
            .is_some_and(|text| !valid_label(text, SKILL_CHANGELOG_MAX_CHARS))
        {
            return Some("changelog");
        }
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedbackOutcome {
    Accepted,
    Rejected,
}

crate::ticket::stored_names!(FeedbackOutcome {
    Accepted => "accepted",
    Rejected => "rejected",
});

/// The PM's verdict on one suggestion of a skill, per manifest version.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFeedback {
    pub skill_id: String,
    pub version: u32,
    pub ticket_id: String,
    pub kind: String,
    pub outcome: FeedbackOutcome,
    /// Where the suggestion's evidence came from, e.g. Slack channel ids.
    pub sources: Vec<String>,
    pub reason: Option<String>,
    pub recorded_at_epoch_ms: u64,
}

/// Where a suggestion's evidence comes from, for the feedback a revision
/// reads: `slack:<channel id>` for a Slack permalink, else the link's host.
pub fn evidence_sources(evidence: &[Evidence]) -> Vec<String> {
    let mut sources: Vec<String> = Vec::new();
    for url in evidence.iter().filter_map(|item| item.url.as_deref()) {
        let rest = url.trim_start_matches("https://");
        let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
        let source = match path.strip_prefix("archives/") {
            Some(archive) if host.ends_with(".slack.com") => {
                format!("slack:{}", archive.split('/').next().unwrap_or_default())
            }
            _ => host.to_ascii_lowercase(),
        };
        if !sources.contains(&source) {
            sources.push(source);
        }
    }
    sources
}

/// Identifies "this suggestion on this evidence": a rejected one is never
/// suggested again. `None` without evidence.
pub(crate) fn evidence_key(ticket_id: &str, kind: &str, evidence: &[Evidence]) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut parts: Vec<String> = evidence
        .iter()
        .map(|item| {
            item.url.clone().unwrap_or_else(|| {
                format!(
                    "{}\u{1f}{}",
                    item.label,
                    item.quote.as_deref().unwrap_or("")
                )
            })
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    parts.sort();
    parts.dedup();
    let digest = Sha256::digest(format!(
        "{ticket_id}\u{1e}{kind}\u{1e}{}",
        parts.join("\u{1e}")
    ));
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
