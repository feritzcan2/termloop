//! Where each Task of a Project opened as Project Manager stands on its way
//! to production, derived from its delivery facts on every board read. The
//! stage is the furthest step its evidence shows; nothing here is stored,
//! and it is independent of any Playbook. The Project Manager sets the
//! Project's environments, in delivery order, with
//! `projectManager.environmentsSet`.

use serde_json::{Value, json};
use termloop_domain::{
    EnvironmentDeployState, JiraStatusCategory, ProjectEnvironment, PullRequestFactState,
    TaskDeliveryFacts, TaskStatus, valid_project_environments,
};

use super::risks::{jira_done, production_fact};
use crate::{CoreError, CoreRuntime, required_string, store_error};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeliveryStageKind {
    ToDo,
    InProgress,
    InReview,
    Merged,
    Deployed,
    Live,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeliveryStage {
    pub(crate) kind: DeliveryStageKind,
    /// The environment of a `deployed` or `live` stage.
    pub(crate) environment: Option<String>,
    pub(crate) since_epoch_ms: Option<u64>,
}

impl DeliveryStage {
    fn new(kind: DeliveryStageKind, since_epoch_ms: Option<u64>) -> Self {
        Self {
            kind,
            environment: None,
            since_epoch_ms,
        }
    }
}

impl CoreRuntime {
    /// `projectManager.environmentsSet`: replaces the Project's environment
    /// list; an empty list goes back to telling production apart by name.
    pub(crate) fn set_project_environments_command(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        self.ensure_project_manager_project(&project_id)?;
        let environments = params
            .get("environments")
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<ProjectEnvironment>>(value).ok())
            .filter(|list| list.is_empty() || valid_project_environments(list))
            .ok_or_else(|| CoreError::InvalidParams("environments".into()))?;
        let revision = self.store.revision();
        self.store
            .set_project_environments(&self.write_authority, &project_id, environments, revision)
            .map_err(store_error)?;
        Ok(self.project_manager_board(&project_id))
    }

    /// The stage of every unarchived Task of a Project, for the board.
    pub(super) fn project_stages_json(&self, project_id: &str) -> Vec<Value> {
        let environments = self.store.project_environments(project_id);
        self.store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id && task.archived_at_epoch_ms.is_none())
            .map(|task| {
                let stage = delivery_stage(
                    task.status == TaskStatus::Open,
                    self.store.task_delivery_facts_for(&task.id),
                    environments,
                );
                json!({
                    "taskId": task.id,
                    "stage": stage.kind,
                    "environment": stage.environment,
                    "sinceEpochMs": stage.since_epoch_ms,
                })
            })
            .collect()
    }
}

/// The furthest stage one Task's facts show.
///
/// - A closed Task is done.
/// - Deployed to production is live, and done once Jira also says done.
/// - Jira done counts as done on its own only while nothing tells
///   environments apart: no environment list and no environment facts.
/// - Otherwise the furthest deployed environment in the Project's order,
///   then a merged pull request, then an open one, then a draft or Jira
///   in progress.
pub(crate) fn delivery_stage(
    open: bool,
    facts: Option<&TaskDeliveryFacts>,
    environments: &[ProjectEnvironment],
) -> DeliveryStage {
    use DeliveryStageKind::*;
    if !open {
        return DeliveryStage::new(Done, None);
    }
    let Some(facts) = facts else {
        return DeliveryStage::new(ToDo, None);
    };
    let jira_is_done = facts.jira.as_ref().is_some_and(jira_done);
    if let Some(production) = production_fact(facts, environments)
        .filter(|environment| environment.state == EnvironmentDeployState::Deployed)
    {
        return DeliveryStage {
            kind: if jira_is_done { Done } else { Live },
            environment: Some(production.name.clone()),
            since_epoch_ms: Some(production.changed_at_epoch_ms),
        };
    }
    if jira_is_done && environments.is_empty() && facts.environments.is_empty() {
        return DeliveryStage::new(
            Done,
            facts.jira.as_ref().map(|jira| jira.changed_at_epoch_ms),
        );
    }
    // Listed environments rank by the Project's order, above unlisted
    // ones; time breaks ties.
    let position = |name: &str| {
        environments
            .iter()
            .position(|environment| environment.name.eq_ignore_ascii_case(name))
            .map_or(0, |index| index + 1)
    };
    if let Some(deployed) = facts
        .environments
        .iter()
        .filter(|environment| environment.state == EnvironmentDeployState::Deployed)
        .max_by_key(|environment| (position(&environment.name), environment.changed_at_epoch_ms))
    {
        return DeliveryStage {
            kind: Deployed,
            environment: Some(deployed.name.clone()),
            since_epoch_ms: Some(deployed.changed_at_epoch_ms),
        };
    }
    let pull_requests = facts
        .pull_requests
        .as_ref()
        .map(|fact| fact.items.as_slice())
        .unwrap_or_default();
    let latest = |state: PullRequestFactState| {
        pull_requests
            .iter()
            .filter(|pull_request| pull_request.state == state)
            .map(|pull_request| pull_request.updated_at_epoch_ms)
            .max()
    };
    if let Some(merged_at) = latest(PullRequestFactState::Merged) {
        return DeliveryStage::new(Merged, Some(merged_at));
    }
    if let Some(opened) = latest(PullRequestFactState::Open) {
        return DeliveryStage::new(InReview, Some(opened));
    }
    if let Some(drafted) = latest(PullRequestFactState::Draft) {
        return DeliveryStage::new(InProgress, Some(drafted));
    }
    match &facts.jira {
        // Jira done without delivery evidence is still only work started.
        Some(jira)
            if jira_is_done || jira.status_category == Some(JiraStatusCategory::Indeterminate) =>
        {
            DeliveryStage::new(InProgress, Some(jira.changed_at_epoch_ms))
        }
        _ => DeliveryStage::new(ToDo, None),
    }
}

#[cfg(test)]
mod tests;
