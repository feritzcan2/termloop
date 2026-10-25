//! Deterministic delivery risks of a PM ticket, derived from its delivery
//! facts, the PM's own record, and its sprint on every board read. Nothing
//! here is stored or written by an agent.

use super::facts::{
    EnvironmentDeployState, FactSource, JiraStatusCategory, PullRequestFactChecks,
    PullRequestFactState, TicketDeliveryFacts,
};
use super::stage::{DeliveryStage, DeliveryStageKind, production_fact};
use crate::{ProjectEnvironment, Sprint, SprintState, Ticket, TicketStatus};

pub(crate) const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// A Jira status of started work unchanged this long is stuck.
pub const STUCK_IN_STATUS_MS: u64 = 5 * DAY_MS;
/// An open pull request waiting this long for an approval.
pub const REVIEW_WAIT_MS: u64 = 2 * DAY_MS;
/// A merge no environment shows deployed after this long.
pub const MERGED_NOT_DEPLOYED_MS: u64 = 2 * DAY_MS;
/// A change deployed somewhere but not to production after this long.
pub const NOT_IN_PRODUCTION_MS: u64 = 3 * DAY_MS;
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
    MergedNotDeployed,
    NotInProduction,
    JiraBehind,
    JiraAhead,
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
    pub stage: &'a DeliveryStage,
    pub environments: &'a [ProjectEnvironment],
    pub now_epoch_ms: u64,
}

/// What may keep one ticket from delivery, most pressing first. A done
/// ticket has none.
pub fn delivery_risks(inputs: RiskInputs<'_>) -> Vec<DeliveryRisk> {
    let RiskInputs {
        ticket,
        sprint,
        facts,
        stage,
        environments,
        now_epoch_ms: now,
    } = inputs;
    let mut risks = Vec::new();
    if ticket.status == TicketStatus::Done || stage.kind == DeliveryStageKind::Done {
        return risks;
    }
    let mut push = |kind, detail: String, since_epoch_ms| {
        risks.push(DeliveryRisk {
            kind,
            detail,
            since_epoch_ms,
        });
    };
    let blockers = ticket
        .blockers
        .first()
        .map(|blocker| blocker.text.as_str())
        .or_else(|| facts?.check_notes.as_ref()?.blockers.as_deref());
    if let Some(blockers) = blockers.map(str::trim).filter(|text| !text.is_empty()) {
        push(DeliveryRiskKind::Blocked, first_line(blockers), None);
    }
    if let Some(facts) = facts {
        fact_risks(facts, environments, now, &mut push);
    }
    let open_sprint = sprint.filter(|sprint| sprint.state != SprintState::Closed);
    if let Some(ends_at) = open_sprint
        .filter(|sprint| sprint.state == SprintState::Active)
        .and_then(|sprint| sprint.ends_at_epoch_ms)
        && stage.kind == DeliveryStageKind::ToDo
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
    environments: &[ProjectEnvironment],
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
    let merged_at = pull_requests
        .iter()
        .filter(|pull_request| pull_request.state == PullRequestFactState::Merged)
        .map(|pull_request| pull_request.updated_at_epoch_ms)
        .max();
    let deployed = facts
        .environments
        .iter()
        .filter(|environment| environment.state == EnvironmentDeployState::Deployed)
        .collect::<Vec<_>>();
    let production = production_fact(facts, environments);
    let in_production =
        production.is_some_and(|environment| environment.state == EnvironmentDeployState::Deployed);
    // A configured production environment counts even before a fact names it.
    let production_name = production
        .map(|environment| environment.name.as_str())
        .or_else(|| {
            environments
                .iter()
                .find(|environment| environment.production)
                .map(|environment| environment.name.as_str())
        });
    if let Some(merged_at) = merged_at
        && deployed.is_empty()
        && now.saturating_sub(merged_at) >= MERGED_NOT_DEPLOYED_MS
    {
        push(
            DeliveryRiskKind::MergedNotDeployed,
            format!(
                "Merged {} ago; no environment shows it deployed",
                days(now, merged_at)
            ),
            Some(merged_at),
        );
    }
    if let Some(production_name) = production_name
        && !in_production
        && let Some(earliest) = deployed
            .iter()
            .min_by_key(|environment| environment.changed_at_epoch_ms)
        && now.saturating_sub(earliest.changed_at_epoch_ms) >= NOT_IN_PRODUCTION_MS
    {
        push(
            DeliveryRiskKind::NotInProduction,
            format!(
                "On {} for {} but not on {production_name}",
                earliest.name,
                days(now, earliest.changed_at_epoch_ms),
            ),
            Some(earliest.changed_at_epoch_ms),
        );
    }
    if let Some(jira) = &facts.jira {
        let done = jira.done();
        if in_production && !done {
            push(
                DeliveryRiskKind::JiraBehind,
                format!("In production, but Jira still says {}", jira.status),
                production.map(|environment| environment.changed_at_epoch_ms),
            );
        } else if done && production_name.is_some() && !in_production {
            push(
                DeliveryRiskKind::JiraAhead,
                format!("Jira says {}, but it is not in production", jira.status),
                Some(jira.changed_at_epoch_ms),
            );
        }
    }
}

fn source_name(source: FactSource) -> &'static str {
    match source {
        FactSource::Jira => "Jira",
        FactSource::GitHost => "Pull requests",
        FactSource::Probe => "A probe",
        FactSource::Check => "A delivery check",
        FactSource::ProjectManager => "The project manager",
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
