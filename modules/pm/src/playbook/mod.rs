//! A project's delivery Playbook: the ordered steps a ticket passes on its
//! way to done, and how each step is told passed.
//!
//! A step passes from facts the PM app reads itself (the ticket's status, its
//! pull requests), from an agent that follows the step's instructions, or by
//! the project manager's own hand. Fact verdicts are derived on every read;
//! only agent and project manager verdicts are stored. Where a ticket stands
//! is never stored either: it is the furthest step it passed.

mod position;

pub use position::{StepState, TicketPlaybook, agent_step_due, ticket_playbook};

use crate::validation::{valid_id, valid_label, valid_non_blank_text};

pub const PLAYBOOK_STEPS_MAX: usize = 16;
pub const PLAYBOOK_STEP_TITLE_MAX_CHARS: usize = 60;
pub const PLAYBOOK_STEP_CHECKS_MAX: usize = 4;
pub const PLAYBOOK_STATUS_NAMES_MAX: usize = 12;
pub const PLAYBOOK_STATUS_NAME_MAX_CHARS: usize = 120;
pub const PLAYBOOK_BRANCH_MAX_CHARS: usize = 255;
pub const PLAYBOOK_INSTRUCTIONS_MAX_CHARS: usize = 8_000;
/// One short factual sentence per verdict, never raw external content.
pub const PLAYBOOK_EVIDENCE_MAX_CHARS: usize = 600;
pub const PLAYBOOK_RETRY_MINUTES_MIN: u32 = 5;
pub const PLAYBOOK_RETRY_MINUTES_MAX: u32 = 24 * 60;
pub const PLAYBOOK_RETRY_MINUTES_DEFAULT: u32 = 30;
pub const PLAYBOOK_SUMMARY_MAX_CHARS: usize = 600;

/// The one current Playbook of a project. Replace-only: a save carries the
/// complete next document.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Playbook {
    pub project_id: String,
    /// 0 for a project that never saved one: it walks [`default_steps`].
    pub revision: u64,
    pub steps: Vec<PlaybookStep>,
    pub updated_at_epoch_ms: u64,
}

impl Playbook {
    /// The Playbook of a project that never saved one.
    pub fn default_for(project_id: &str) -> Self {
        Self {
            project_id: project_id.to_owned(),
            revision: 0,
            steps: default_steps(),
            updated_at_epoch_ms: 0,
        }
    }

    pub fn step(&self, step_id: &str) -> Option<&PlaybookStep> {
        self.steps.iter().find(|step| step.id == step_id)
    }
}

/// One stop on the way to done.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlaybookStep {
    pub id: String,
    pub title: String,
    /// Facts the app reads itself; the step passes when any of them holds.
    #[serde(default)]
    pub checks: Vec<StepCheck>,
    /// How an agent tells the step passed when no check does.
    #[serde(default)]
    pub agent: Option<AgentCheck>,
}

impl PlaybookStep {
    /// Whether a stored verdict for `self` still answers `next`: the same
    /// step asked the same way.
    pub fn same_question(&self, next: &PlaybookStep) -> bool {
        self.id == next.id && self.checks == next.checks && self.agent == next.agent
    }
}

/// A fact the PM app reads itself.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    deny_unknown_fields,
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum StepCheck {
    /// The ticket's status: its Jira status when it has one, otherwise the
    /// PM's own. Holds when the name is listed (ignoring case) or the status
    /// is of the category.
    Status {
        #[serde(default)]
        names: Vec<String>,
        #[serde(default)]
        category: Option<StatusCategory>,
    },
    /// A pull request naming the ticket is in the state, into `base_branch`
    /// when one is set.
    PullRequest {
        state: PullRequestStepState,
        #[serde(default)]
        base_branch: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusCategory {
    /// Work started and not finished.
    Started,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestStepState {
    /// Open and ready for review.
    Open,
    Merged,
}

/// An agent's way of telling the step passed, in the project manager's
/// words: what to read and what counts as passed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentCheck {
    pub instructions: String,
    /// How long a ticket waits before the agent looks again.
    pub retry_minutes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepVerdict {
    Passed,
    /// Looked and could not show it passed yet.
    Waiting,
    /// Could not read what the step needs; never advances the ticket.
    Blocked,
}

impl StepVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Waiting => "waiting",
            Self::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "passed" => Some(Self::Passed),
            "waiting" => Some(Self::Waiting),
            "blocked" => Some(Self::Blocked),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepEvaluator {
    /// The app read the ticket's status or pull requests.
    Facts,
    Agent,
    ProjectManager,
}

impl StepEvaluator {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Facts => "facts",
            Self::Agent => "agent",
            Self::ProjectManager => "projectManager",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "facts" => Some(Self::Facts),
            "agent" => Some(Self::Agent),
            "projectManager" => Some(Self::ProjectManager),
            _ => None,
        }
    }
}

/// A stored verdict: an agent's or the project manager's answer for one
/// ticket and step. Current state, replaced by the next answer.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepVerdictRecord {
    pub ticket_id: String,
    pub step_id: String,
    pub verdict: StepVerdict,
    pub evidence: String,
    pub evaluator: StepEvaluator,
    pub decided_at_epoch_ms: u64,
    /// When the agent may look again; `None` once passed.
    pub next_attempt_at_epoch_ms: Option<u64>,
}

/// What a Playbook setup found, waiting for the project manager: at most one
/// per project, replaced by the next setup.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookProposal {
    pub project_id: String,
    pub summary: String,
    pub steps: Vec<PlaybookStep>,
    pub created_at_epoch_ms: u64,
}

/// The steps of a project that never saved a Playbook: started, in review,
/// merged, done.
pub fn default_steps() -> Vec<PlaybookStep> {
    let step = |id: &str, title: &str, check: StepCheck| PlaybookStep {
        id: id.to_owned(),
        title: title.to_owned(),
        checks: vec![check],
        agent: None,
    };
    let status = |category| StepCheck::Status {
        names: Vec::new(),
        category: Some(category),
    };
    let pull_request = |state| StepCheck::PullRequest {
        state,
        base_branch: None,
    };
    vec![
        step("started", "In progress", status(StatusCategory::Started)),
        step(
            "review",
            "In review",
            pull_request(PullRequestStepState::Open),
        ),
        step(
            "merged",
            "Merged",
            pull_request(PullRequestStepState::Merged),
        ),
        step("done", "Done", status(StatusCategory::Done)),
    ]
}

/// Ids are unique, every step has a title and a way to pass, and the bounds
/// hold. A step with neither checks nor an agent passes only by hand, which
/// is valid.
pub fn valid_playbook_steps(steps: &[PlaybookStep]) -> bool {
    !steps.is_empty()
        && steps.len() <= PLAYBOOK_STEPS_MAX
        && steps.iter().enumerate().all(|(index, step)| {
            valid_id(&step.id)
                && !steps[index + 1..].iter().any(|other| other.id == step.id)
                && valid_label(&step.title, PLAYBOOK_STEP_TITLE_MAX_CHARS)
                && step.checks.len() <= PLAYBOOK_STEP_CHECKS_MAX
                && step.checks.iter().all(valid_check)
                && step.agent.as_ref().is_none_or(valid_agent_check)
        })
}

fn valid_check(check: &StepCheck) -> bool {
    match check {
        StepCheck::Status { names, category } => {
            (!names.is_empty() || category.is_some())
                && names.len() <= PLAYBOOK_STATUS_NAMES_MAX
                && names
                    .iter()
                    .all(|name| valid_label(name, PLAYBOOK_STATUS_NAME_MAX_CHARS))
        }
        StepCheck::PullRequest { base_branch, .. } => base_branch
            .as_deref()
            .is_none_or(|branch| valid_label(branch, PLAYBOOK_BRANCH_MAX_CHARS)),
    }
}

fn valid_agent_check(agent: &AgentCheck) -> bool {
    valid_non_blank_text(&agent.instructions, PLAYBOOK_INSTRUCTIONS_MAX_CHARS)
        && (PLAYBOOK_RETRY_MINUTES_MIN..=PLAYBOOK_RETRY_MINUTES_MAX).contains(&agent.retry_minutes)
}

pub fn valid_step_evidence(evidence: &str) -> bool {
    valid_non_blank_text(evidence, PLAYBOOK_EVIDENCE_MAX_CHARS)
}

pub fn valid_playbook_summary(summary: &str) -> bool {
    valid_non_blank_text(summary, PLAYBOOK_SUMMARY_MAX_CHARS)
}
