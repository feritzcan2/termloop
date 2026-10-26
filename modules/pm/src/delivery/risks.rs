//! Deterministic delivery risks of a PM ticket, derived from its delivery
//! facts, where it stands on the Playbook, the PM's own record, and its
//! sprint on every board read. Nothing here is stored or written by an agent.

use super::facts::{
    FactSource, JiraStatusCategory, PullRequestFactChecks, PullRequestFactState,
    TicketDeliveryFacts,
};
use crate::playbook::{Playbook, StepEvaluator, StepVerdict, TicketPlaybook};
use crate::{Sprint, SprintState, Ticket, TicketStatus};

pub(crate) const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// A Jira status of started work unchanged this long is stuck.
pub const STUCK_IN_STATUS_MS: u64 = 5 * DAY_MS;
/// An open pull request waiting this long for an approval.
pub const REVIEW_WAIT_MS: u64 = 2 * DAY_MS;
/// Work not started this close to its active sprint's end.
pub const SPRINT_END_NEAR_MS: u64 = 2 * DAY_MS;
/// A ticket carried over this often keeps slipping.
pub const CARRY_OVER_RISK_COUNT: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryRiskKind {
    Blocked,
    ReadFailed,
    ChecksFailing,
    ReviewWaiting,
    StuckInStatus,
    /// An agent could not read what the ticket's next step needs.
    StepBlocked,
    NotStartedNearSprintEnd,
    CarriedOver,
    Unassigned,
    NoAcceptanceCriteria,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRisk {
    pub kind: DeliveryRiskKind,
    pub detail: String,
    pub since_epoch_ms: Option<u64>,
}

/// Everything one ticket's risks are derived from.
#[derive(Debug, Clone, Copy)]
pub struct RiskInputs<'a> {
    pub ticket: &'a Ticket,
    /// The ticket's sprint, when it is in one.
    pub sprint: Option<&'a Sprint>,
    pub facts: Option<&'a TicketDeliveryFacts>,
    pub playbook: &'a Playbook,
    pub progress: &'a TicketPlaybook,
    pub now_epoch_ms: u64,
}

/// What may keep one ticket from delivery, most pressing first. A done
/// ticket, or one past every step, has none.
pub fn delivery_risks(inputs: RiskInputs<'_>) -> Vec<DeliveryRisk> {
    let RiskInputs {
        ticket,
        sprint,
        facts,
        playbook,
        progress,
        now_epoch_ms: now,
    } = inputs;
    let mut risks = Vec::new();
    let Some(next) = progress.next_index() else {
        return risks;
    };
    if ticket.status == TicketStatus::Done {
        return risks;
    }
    let mut push = |kind, detail: String, since_epoch_ms| {
        risks.push(DeliveryRisk {
            kind,
            detail,
            since_epoch_ms,
        });
    };
    let blockers = ticket.blockers.first().map(|blocker| blocker.text.trim());
    if let Some(blockers) = blockers.filter(|text| !text.is_empty()) {
        push(DeliveryRiskKind::Blocked, first_line(blockers), None);
    }
    let state = &progress.steps[next];
    if state.verdict == Some(StepVerdict::Blocked) && state.evaluator == Some(StepEvaluator::Agent)
    {
        push(
            DeliveryRiskKind::StepBlocked,
            format!(
                "Can't check {}: {}",
                playbook.steps[next].title,
                first_line(state.evidence.as_deref().unwrap_or_default())
            ),
            state.decided_at_epoch_ms,
        );
    }
    if let Some(facts) = facts {
        fact_risks(facts, now, &mut push);
    }
    let open_sprint = sprint.filter(|sprint| sprint.state != SprintState::Closed);
    if let Some(ends_at) = open_sprint
        .filter(|sprint| sprint.state == SprintState::Active)
        .and_then(|sprint| sprint.ends_at_epoch_ms)
        && progress.position.is_none()
        && ends_at.saturating_sub(now) <= SPRINT_END_NEAR_MS
    {
        let detail = if now >= ends_at {
            "Not started and the sprint has ended".to_owned()
        } else {
            format!("Not started; the sprint ends in {}", days(ends_at, now))
        };
        push(DeliveryRiskKind::NotStartedNearSprintEnd, detail, None);
    }
    if ticket.carry_over_count >= CARRY_OVER_RISK_COUNT {
        push(
            DeliveryRiskKind::CarriedOver,
            format!("Carried over {} times", ticket.carry_over_count),
            None,
        );
    }
    if open_sprint.is_some() {
        let jira_assignee = facts.and_then(|facts| facts.jira.as_ref()?.assignee.as_deref());
        if ticket.assignee.is_none() && jira_assignee.is_none() {
            push(
                DeliveryRiskKind::Unassigned,
                "Nobody is assigned".into(),
                None,
            );
        }
        if ticket.acceptance_criteria.is_empty() {
            push(
                DeliveryRiskKind::NoAcceptanceCriteria,
                "No acceptance criteria".into(),
                None,
            );
        }
    }
    risks
}

/// The risks only delivery facts show.
fn fact_risks(
    facts: &TicketDeliveryFacts,
    now: u64,
    push: &mut impl FnMut(DeliveryRiskKind, String, Option<u64>),
) {
    for failure in &facts.read_failures {
        push(
            DeliveryRiskKind::ReadFailed,
            format!(
                "{} could not be read: {}",
                source_name(failure.source),
                failure.reason
            ),
            Some(failure.at_epoch_ms),
        );
    }
    let pull_requests = facts.pull_request_items();
    for pull_request in pull_requests.iter().filter(|pull_request| {
        matches!(
            pull_request.state,
            PullRequestFactState::Open | PullRequestFactState::Draft
        )
    }) {
        if pull_request.checks == PullRequestFactChecks::Failing {
            push(
                DeliveryRiskKind::ChecksFailing,
                format!("Checks fail on #{}", pull_request.number),
                Some(pull_request.updated_at_epoch_ms),
            );
        } else if pull_request.awaits_review() {
            let since = pull_request
                .awaiting_review_since_epoch_ms
                .unwrap_or(pull_request.updated_at_epoch_ms);
            if now.saturating_sub(since) >= REVIEW_WAIT_MS {
                push(
                    DeliveryRiskKind::ReviewWaiting,
                    format!(
                        "#{} has waited {} for review",
                        pull_request.number,
                        days(now, since)
                    ),
                    Some(since),
                );
            }
        }
    }
    if let Some(jira) = &facts.jira
        && !jira.done()
        && jira.status_category != Some(JiraStatusCategory::New)
        && now.saturating_sub(jira.changed_at_epoch_ms) >= STUCK_IN_STATUS_MS
    {
        push(
            DeliveryRiskKind::StuckInStatus,
            format!(
                "In {} for {}",
                jira.status,
                days(now, jira.changed_at_epoch_ms)
            ),
            Some(jira.changed_at_epoch_ms),
        );
    }
}

fn source_name(source: FactSource) -> &'static str {
    match source {
        FactSource::Jira => "Jira",
        FactSource::GitHost => "Pull requests",
    }
}

fn days(later_epoch_ms: u64, earlier_epoch_ms: u64) -> String {
    match later_epoch_ms.saturating_sub(earlier_epoch_ms) / DAY_MS {
        0 | 1 => "a day".to_owned(),
        count => format!("{count} days"),
    }
}

fn first_line(text: &str) -> String {
    text.lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect()
}

#[cfg(test)]
mod tests;
