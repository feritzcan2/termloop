//! Deterministic delivery risks of Project Manager Tasks, derived from the
//! delivery facts and the Project Manager's own record on every board read.
//! Nothing here is stored or written by an Agent.

use serde_json::{Value, json};
use termloop_domain::{
    EnvironmentDeployState, FactSource, JiraFact, JiraStatusCategory, ProjectEnvironment,
    PullRequestFactChecks, PullRequestFactState, TaskDeliveryFacts, TaskStatus, TaskTrackingRecord,
    environment_is_production,
};

use crate::CoreRuntime;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// An open pull request untouched this long is stalled in review.
const REVIEW_STALL_MS: u64 = 3 * DAY_MS;
/// A merge no environment shows deployed after this long.
const MERGED_NOT_DEPLOYED_MS: u64 = 2 * DAY_MS;
/// A change deployed somewhere but not to production after this long.
const NOT_IN_PRODUCTION_MS: u64 = 3 * DAY_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeliveryRiskKind {
    Blocked,
    ReadFailed,
    ReviewStalled,
    ChecksFailing,
    MergedNotDeployed,
    NotInProduction,
    JiraBehind,
    JiraAhead,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeliveryRisk {
    pub(crate) kind: DeliveryRiskKind,
    pub(crate) detail: String,
    pub(crate) since_epoch_ms: Option<u64>,
}

impl CoreRuntime {
    /// The risks of every open Task of a Project, for the board.
    pub(super) fn project_risks_json(&self, project_id: &str, now_epoch_ms: u64) -> Vec<Value> {
        let mut tasks = self
            .store
            .tasks()
            .iter()
            .filter(|task| {
                task.project_id == project_id
                    && task.status == TaskStatus::Open
                    && task.archived_at_epoch_ms.is_none()
            })
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.rank);
        let environments = self.store.project_environments(project_id);
        tasks
            .into_iter()
            .flat_map(|task| {
                delivery_risks(
                    self.store.task_tracking(&task.id),
                    self.store.task_delivery_facts_for(&task.id),
                    environments,
                    now_epoch_ms,
                )
                .into_iter()
                .map(|risk| {
                    json!({
                        "taskId": task.id,
                        "kind": risk.kind,
                        "detail": risk.detail,
                        "sinceEpochMs": risk.since_epoch_ms,
                    })
                })
            })
            .collect()
    }
}

/// What may keep one Task from delivery, most pressing first.
pub(crate) fn delivery_risks(
    tracking: Option<&TaskTrackingRecord>,
    facts: Option<&TaskDeliveryFacts>,
    environments: &[ProjectEnvironment],
    now_epoch_ms: u64,
) -> Vec<DeliveryRisk> {
    let mut risks = Vec::new();
    let blockers = tracking
        .and_then(|record| record.blockers.as_deref())
        .or_else(|| facts?.check_notes.as_ref()?.blockers.as_deref());
    if let Some(blockers) = blockers.map(str::trim).filter(|text| !text.is_empty()) {
        risks.push(DeliveryRisk {
            kind: DeliveryRiskKind::Blocked,
            detail: first_line(blockers),
            since_epoch_ms: None,
        });
    }
    let Some(facts) = facts else {
        return risks;
    };
    for failure in &facts.read_failures {
        risks.push(DeliveryRisk {
            kind: DeliveryRiskKind::ReadFailed,
            detail: format!(
                "{} could not be read: {}",
                source_name(failure.source),
                failure.reason
            ),
            since_epoch_ms: Some(failure.at_epoch_ms),
        });
    }
    let pull_requests = facts
        .pull_requests
        .as_ref()
        .map(|fact| fact.items.as_slice())
        .unwrap_or_default();
    let open = pull_requests.iter().filter(|pull_request| {
        matches!(
            pull_request.state,
            PullRequestFactState::Open | PullRequestFactState::Draft
        )
    });
    for pull_request in open {
        if pull_request.checks == PullRequestFactChecks::Failing {
            risks.push(DeliveryRisk {
                kind: DeliveryRiskKind::ChecksFailing,
                detail: format!("Checks fail on #{}", pull_request.number),
                since_epoch_ms: Some(pull_request.updated_at_epoch_ms),
            });
        } else if now_epoch_ms.saturating_sub(pull_request.updated_at_epoch_ms) >= REVIEW_STALL_MS {
            risks.push(DeliveryRisk {
                kind: DeliveryRiskKind::ReviewStalled,
                detail: format!(
                    "#{} has not moved for {}",
                    pull_request.number,
                    days(now_epoch_ms, pull_request.updated_at_epoch_ms)
                ),
                since_epoch_ms: Some(pull_request.updated_at_epoch_ms),
            });
        }
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
    // A configured production environment counts even before any fact names it.
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
        && now_epoch_ms.saturating_sub(merged_at) >= MERGED_NOT_DEPLOYED_MS
    {
        risks.push(DeliveryRisk {
            kind: DeliveryRiskKind::MergedNotDeployed,
            detail: format!(
                "Merged {} ago; no environment shows it deployed",
                days(now_epoch_ms, merged_at)
            ),
            since_epoch_ms: Some(merged_at),
        });
    }
    if let Some(production_name) = production_name
        && !in_production
        && let Some(earliest) = deployed
            .iter()
            .min_by_key(|environment| environment.changed_at_epoch_ms)
        && now_epoch_ms.saturating_sub(earliest.changed_at_epoch_ms) >= NOT_IN_PRODUCTION_MS
    {
        risks.push(DeliveryRisk {
            kind: DeliveryRiskKind::NotInProduction,
            detail: format!(
                "On {} for {} but not on {}",
                earliest.name,
                days(now_epoch_ms, earliest.changed_at_epoch_ms),
                production_name
            ),
            since_epoch_ms: Some(earliest.changed_at_epoch_ms),
        });
    }
    if let Some(jira) = &facts.jira {
        let done = jira_done(jira);
        if in_production && !done {
            risks.push(DeliveryRisk {
                kind: DeliveryRiskKind::JiraBehind,
                detail: format!("In production, but Jira still says {}", jira.status),
                since_epoch_ms: production.map(|environment| environment.changed_at_epoch_ms),
            });
        } else if done && production_name.is_some() && !in_production {
            risks.push(DeliveryRisk {
                kind: DeliveryRiskKind::JiraAhead,
                detail: format!("Jira says {}, but it is not in production", jira.status),
                since_epoch_ms: Some(jira.changed_at_epoch_ms),
            });
        }
    }
    risks
}

/// A Task's production environment fact: deployed if any production
/// environment runs it, otherwise the first production one named.
pub(super) fn production_fact<'a>(
    facts: &'a TaskDeliveryFacts,
    environments: &[ProjectEnvironment],
) -> Option<&'a termloop_domain::EnvironmentFact> {
    let mut production = facts
        .environments
        .iter()
        .filter(|environment| environment_is_production(environments, &environment.name));
    let first = production.clone().next();
    production
        .find(|environment| environment.state == EnvironmentDeployState::Deployed)
        .or(first)
}

/// Whether Jira says the work is finished: its status category when Jira
/// sent one, otherwise the status name.
pub(super) fn jira_done(jira: &JiraFact) -> bool {
    jira.status_category.map_or_else(
        || jira_status_done(&jira.status),
        |category| category == JiraStatusCategory::Done,
    )
}

/// Whether a Jira status name means the work is finished. Jira workflows
/// name it differently; these are the common spellings.
fn jira_status_done(status: &str) -> bool {
    let status = status.trim().to_ascii_lowercase();
    matches!(
        status.as_str(),
        "done" | "closed" | "resolved" | "released" | "complete" | "completed" | "shipped"
    ) || status.starts_with("done")
}

fn source_name(source: FactSource) -> &'static str {
    match source {
        FactSource::Jira => "Jira",
        FactSource::GitHost => "Pull requests",
        FactSource::Probe => "A probe",
        FactSource::Check => "A delivery check",
        FactSource::ProjectManager => "The Project Manager",
    }
}

fn days(now_epoch_ms: u64, since_epoch_ms: u64) -> String {
    match now_epoch_ms.saturating_sub(since_epoch_ms) / DAY_MS {
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
