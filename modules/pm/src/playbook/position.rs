//! Where one ticket stands on its project's Playbook, derived on every read
//! from its status, its delivery facts, and the stored verdicts.
//!
//! A ticket stands at the furthest step it passed: later evidence implies the
//! earlier steps, so a ticket imported already merged never waits at "In
//! progress". A ticket the project manager marked done passed every step.

use crate::TicketStatus;
use crate::delivery::facts::{JiraStatusCategory, PullRequestFactState, TicketDeliveryFacts};

use super::{
    Playbook, PlaybookStep, PullRequestStepState, StatusCategory, StepCheck, StepEvaluator,
    StepVerdict, StepVerdictRecord,
};

/// One step of one ticket, as the board shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub step_id: String,
    /// `None`: nothing has answered for this step yet.
    pub verdict: Option<StepVerdict>,
    pub evidence: Option<String>,
    pub evaluator: Option<StepEvaluator>,
    pub decided_at_epoch_ms: Option<u64>,
    /// Counted as passed because a later step passed.
    pub implied: bool,
    pub next_attempt_at_epoch_ms: Option<u64>,
}

/// A ticket on its project's Playbook.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketPlaybook {
    /// The furthest passed step's index; `None` before the first.
    pub position: Option<usize>,
    /// One per Playbook step, in order.
    pub steps: Vec<StepState>,
}

impl TicketPlaybook {
    /// The step the ticket works toward: the one after its position, or
    /// `None` once every step passed.
    pub fn next_index(&self) -> Option<usize> {
        let next = self.position.map_or(0, |position| position + 1);
        (next < self.steps.len()).then_some(next)
    }
}

pub fn ticket_playbook(
    playbook: &Playbook,
    status: TicketStatus,
    facts: Option<&TicketDeliveryFacts>,
    stored: &[StepVerdictRecord],
) -> TicketPlaybook {
    let mut steps: Vec<StepState> = playbook
        .steps
        .iter()
        .map(|step| step_state(step, status, facts, stored))
        .collect();
    let marked_done = status == TicketStatus::Done;
    let furthest = steps
        .iter()
        .rposition(|step| step.verdict == Some(StepVerdict::Passed));
    let position = if marked_done {
        steps.len().checked_sub(1)
    } else {
        furthest
    };
    if let Some(position) = position {
        for step in &mut steps[..=position] {
            if step.verdict != Some(StepVerdict::Passed) {
                step.implied = true;
                step.verdict = Some(StepVerdict::Passed);
                step.next_attempt_at_epoch_ms = None;
            }
        }
    }
    TicketPlaybook { position, steps }
}

/// The step an agent should look at for this ticket now, if any: the next
/// step, when it has an agent check, its facts did not pass it, and its
/// stored answer is due again.
pub fn agent_step_due<'a>(
    playbook: &'a Playbook,
    ticket: &TicketPlaybook,
    now_epoch_ms: u64,
) -> Option<&'a PlaybookStep> {
    let index = ticket.next_index()?;
    let step = &playbook.steps[index];
    step.agent.as_ref()?;
    let state = &ticket.steps[index];
    match state.evaluator {
        Some(StepEvaluator::Facts) => None,
        _ => state
            .next_attempt_at_epoch_ms
            .is_none_or(|at| at <= now_epoch_ms)
            .then_some(step),
    }
}

fn step_state(
    step: &PlaybookStep,
    status: TicketStatus,
    facts: Option<&TicketDeliveryFacts>,
    stored: &[StepVerdictRecord],
) -> StepState {
    if let Some(evidence) = step
        .checks
        .iter()
        .find_map(|check| check_evidence(check, status, facts))
    {
        return StepState {
            step_id: step.id.clone(),
            verdict: Some(StepVerdict::Passed),
            evidence: Some(evidence),
            evaluator: Some(StepEvaluator::Facts),
            decided_at_epoch_ms: None,
            implied: false,
            next_attempt_at_epoch_ms: None,
        };
    }
    let record = stored.iter().find(|record| record.step_id == step.id);
    StepState {
        step_id: step.id.clone(),
        verdict: record.map(|record| record.verdict),
        evidence: record.map(|record| record.evidence.clone()),
        evaluator: record.map(|record| record.evaluator),
        decided_at_epoch_ms: record.map(|record| record.decided_at_epoch_ms),
        implied: false,
        next_attempt_at_epoch_ms: record.and_then(|record| record.next_attempt_at_epoch_ms),
    }
}

/// Why the check holds, in one sentence, or `None` when it does not.
fn check_evidence(
    check: &StepCheck,
    status: TicketStatus,
    facts: Option<&TicketDeliveryFacts>,
) -> Option<String> {
    match check {
        StepCheck::Status { names, category } => {
            let (name, actual) = match facts.and_then(|facts| facts.jira.as_ref()) {
                Some(jira) => (
                    jira.status.as_str(),
                    if jira.done() {
                        Some(StatusCategory::Done)
                    } else if jira.status_category == Some(JiraStatusCategory::Indeterminate) {
                        Some(StatusCategory::Started)
                    } else {
                        None
                    },
                ),
                None => (pm_status_name(status), pm_status_category(status)),
            };
            let source = if facts.is_some_and(|facts| facts.jira.is_some()) {
                "Jira"
            } else {
                "The ticket"
            };
            let named = names
                .iter()
                .any(|listed| listed.trim().eq_ignore_ascii_case(name.trim()));
            (named || (category.is_some() && *category == actual))
                .then(|| format!("{source} status is {name}."))
        }
        StepCheck::PullRequest { state, base_branch } => {
            let wanted = match state {
                PullRequestStepState::Open => PullRequestFactState::Open,
                PullRequestStepState::Merged => PullRequestFactState::Merged,
            };
            let pull_request = facts?.pull_request_items().iter().find(|pull_request| {
                pull_request.state == wanted
                    && base_branch
                        .as_deref()
                        .is_none_or(|branch| pull_request.base_branch == branch)
            })?;
            Some(match state {
                PullRequestStepState::Open => format!(
                    "Pull request #{} is open into {}.",
                    pull_request.number, pull_request.base_branch
                ),
                PullRequestStepState::Merged => format!(
                    "Pull request #{} is merged into {}.",
                    pull_request.number, pull_request.base_branch
                ),
            })
        }
    }
}

fn pm_status_name(status: TicketStatus) -> &'static str {
    match status {
        TicketStatus::Todo => "To do",
        TicketStatus::InProgress => "In progress",
        TicketStatus::InReview => "In review",
        TicketStatus::Done => "Done",
    }
}

fn pm_status_category(status: TicketStatus) -> Option<StatusCategory> {
    match status {
        TicketStatus::Todo => None,
        TicketStatus::InProgress | TicketStatus::InReview => Some(StatusCategory::Started),
        TicketStatus::Done => Some(StatusCategory::Done),
    }
}
