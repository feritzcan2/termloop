//! When a delivery check is worth an Agent: a Task of the active sprint is
//! merged or deployed, an environment still ahead of it has no approved
//! probe to tell whether the change runs there, and no check has looked
//! since the Task reached its stage. A probe whose output only an Agent can
//! read already starts a check when that output changes; everything else is
//! answered by Jira, pull requests, and commit-ancestry probes. Derived on
//! every board read; nothing here is stored.

use serde_json::{Value, json};
use termloop_domain::{
    DeliveryProbe, EnvironmentDeployState, ProbeStatus, ProjectEnvironment, TaskDeliveryFacts,
    environment_is_production,
};

use super::stage::{DeliveryStage, DeliveryStageKind, delivery_stage};
use crate::CoreRuntime;

impl CoreRuntime {
    /// Why each Task of the active sprint needs a delivery check, for the
    /// board.
    pub(super) fn project_check_reasons_json(&self, project_id: &str) -> Vec<Value> {
        let environments = self.store.project_environments(project_id);
        let probes = self
            .store
            .delivery_probes()
            .iter()
            .filter(|probe| probe.project_id == project_id)
            .collect::<Vec<_>>();
        let mut tasks = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id && self.task_in_active_sprint(&task.id))
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.rank);
        tasks
            .into_iter()
            .filter_map(|task| {
                let facts = self.store.task_delivery_facts_for(&task.id);
                let stage = delivery_stage(true, facts, environments);
                check_reason(&stage, facts, &probes, environments)
                    .map(|detail| json!({ "taskId": task.id, "detail": detail }))
            })
            .collect()
    }
}

/// Why one Task needs a delivery check, if it does.
pub(crate) fn check_reason(
    stage: &DeliveryStage,
    facts: Option<&TaskDeliveryFacts>,
    probes: &[&DeliveryProbe],
    environments: &[ProjectEnvironment],
) -> Option<String> {
    if !matches!(
        stage.kind,
        DeliveryStageKind::Merged | DeliveryStageKind::Deployed
    ) {
        return None;
    }
    // A check that looked after the Task reached its stage already said
    // what it could find.
    let looked_since = facts
        .and_then(|facts| facts.check_notes.as_ref())
        .is_some_and(|notes| {
            stage
                .since_epoch_ms
                .is_some_and(|since| notes.recorded_at_epoch_ms >= since)
        });
    if looked_since {
        return None;
    }
    let deployed = |name: &str| {
        facts.is_some_and(|facts| {
            facts.environments.iter().any(|environment| {
                environment.name.eq_ignore_ascii_case(name)
                    && environment.state == EnvironmentDeployState::Deployed
            })
        })
    };
    let probed = |name: &str| {
        probes.iter().any(|probe| {
            probe.status == ProbeStatus::Approved && probe.environment.eq_ignore_ascii_case(name)
        })
    };
    if environments.is_empty() {
        // Without a list, production is the environment that matters.
        let production_probed = probes.iter().any(|probe| {
            probe.status == ProbeStatus::Approved
                && environment_is_production(environments, &probe.environment)
        });
        return (!production_probed).then(|| "No probe tells whether it reached production".into());
    }
    let current = stage.environment.as_deref().and_then(|name| {
        environments
            .iter()
            .position(|environment| environment.name.eq_ignore_ascii_case(name))
    });
    let ahead = environments
        .iter()
        .skip(current.map_or(0, |index| index + 1))
        .filter(|environment| !deployed(&environment.name) && !probed(&environment.name))
        .map(|environment| environment.name.as_str())
        .collect::<Vec<_>>();
    (!ahead.is_empty()).then(|| format!("No probe tells whether it reached {}", ahead.join(", ")))
}

#[cfg(test)]
mod tests;
