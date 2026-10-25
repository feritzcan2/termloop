//! Where a ticket stands on its way to production, derived from its delivery
//! facts on every board read. The stage is the furthest step its evidence
//! shows; nothing here is stored.

use super::facts::{
    EnvironmentDeployState, EnvironmentFact, JiraStatusCategory, PullRequestFactState,
    TicketDeliveryFacts,
};
use crate::{ProjectEnvironment, TicketStatus, environment_is_production};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryStageKind {
    ToDo,
    InProgress,
    InReview,
    Merged,
    Deployed,
    Live,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStage {
    pub kind: DeliveryStageKind,
    /// The environment of a `deployed` or `live` stage.
    pub environment: Option<String>,
    pub since_epoch_ms: Option<u64>,
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

/// The furthest stage one ticket's facts show.
///
/// - A ticket the PM marked done is done.
/// - Deployed to production is live, and done once Jira also says done.
/// - Jira done counts as done on its own only while nothing tells
///   environments apart: no environment list and no environment facts.
/// - Otherwise the furthest deployed environment in the project's order,
///   then a merged pull request, then an open one, then a draft or Jira in
///   progress.
/// - Without delivery evidence, the PM's own ticket status decides between
///   to do, in progress, and in review.
pub fn delivery_stage(
    status: TicketStatus,
    facts: Option<&TicketDeliveryFacts>,
    environments: &[ProjectEnvironment],
) -> DeliveryStage {
    use DeliveryStageKind::*;
    if status == TicketStatus::Done {
        return DeliveryStage::new(Done, None);
    }
    let from_status = || match status {
        TicketStatus::InProgress => InProgress,
        TicketStatus::InReview => InReview,
        TicketStatus::Todo | TicketStatus::Done => ToDo,
    };
    let Some(facts) = facts else {
        return DeliveryStage::new(from_status(), None);
    };
    let jira_is_done = facts.jira.as_ref().is_some_and(|jira| jira.done());
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
    // Listed environments rank by the project's order, above unlisted ones;
    // time breaks ties.
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
    let latest = |state: PullRequestFactState| {
        facts
            .pull_request_items()
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
        _ => DeliveryStage::new(from_status(), None),
    }
}

/// A ticket's production environment fact: deployed if any production
/// environment runs it, otherwise the first production one named.
pub(crate) fn production_fact<'a>(
    facts: &'a TicketDeliveryFacts,
    environments: &[ProjectEnvironment],
) -> Option<&'a EnvironmentFact> {
    let mut production = facts
        .environments
        .iter()
        .filter(|environment| environment_is_production(environments, &environment.name));
    let first = production.clone().next();
    production
        .find(|environment| environment.state == EnvironmentDeployState::Deployed)
        .or(first)
}

#[cfg(test)]
mod tests {
    use super::super::facts::{
        FactSource, JiraFact, PullRequestFact, PullRequestFactChecks, PullRequestFactReview,
        PullRequestsFact,
    };
    use super::DeliveryStageKind::*;
    use super::*;

    fn jira(category: JiraStatusCategory) -> JiraFact {
        JiraFact {
            status: "Status".into(),
            status_category: Some(category),
            assignee: None,
            updated_at_epoch_ms: None,
            observed_at_epoch_ms: 9,
            changed_at_epoch_ms: 3,
        }
    }

    fn pull_request(number: u64, state: PullRequestFactState, updated: u64) -> PullRequestFact {
        PullRequestFact {
            number,
            title: "PAY-42".into(),
            url: format!("https://github.com/acme/pay/pull/{number}"),
            state,
            checks: PullRequestFactChecks::Passing,
            review: PullRequestFactReview::Unknown,
            base_branch: "main".into(),
            head_branch: "feature/PAY-42".into(),
            merge_commit: None,
            updated_at_epoch_ms: updated,
            awaiting_review_since_epoch_ms: None,
        }
    }

    fn environment(name: &str, state: EnvironmentDeployState, changed: u64) -> EnvironmentFact {
        EnvironmentFact {
            name: name.into(),
            state,
            detail: None,
            source: FactSource::Probe,
            observed_at_epoch_ms: changed,
            changed_at_epoch_ms: changed,
        }
    }

    fn facts(
        jira: Option<JiraFact>,
        pull_requests: Vec<PullRequestFact>,
        environments: Vec<EnvironmentFact>,
    ) -> TicketDeliveryFacts {
        TicketDeliveryFacts {
            jira,
            pull_requests: Some(PullRequestsFact {
                repository: "github.com/acme/pay".into(),
                items: pull_requests,
                truncated: false,
                observed_at_epoch_ms: 9,
                changed_at_epoch_ms: 9,
            }),
            environments,
            ..TicketDeliveryFacts::new("t1")
        }
    }

    fn kind(facts: &TicketDeliveryFacts, environments: &[ProjectEnvironment]) -> DeliveryStageKind {
        delivery_stage(TicketStatus::Todo, Some(facts), environments).kind
    }

    fn list(names: &[(&str, bool)]) -> Vec<ProjectEnvironment> {
        names
            .iter()
            .map(|(name, production)| ProjectEnvironment {
                name: (*name).into(),
                production: *production,
            })
            .collect()
    }

    #[test]
    fn work_moves_from_to_do_through_review_to_merged() {
        assert_eq!(delivery_stage(TicketStatus::Todo, None, &[]).kind, ToDo);
        assert_eq!(delivery_stage(TicketStatus::Done, None, &[]).kind, Done);
        assert_eq!(
            delivery_stage(TicketStatus::InReview, None, &[]).kind,
            InReview
        );
        assert_eq!(
            kind(
                &facts(Some(jira(JiraStatusCategory::New)), vec![], vec![]),
                &[]
            ),
            ToDo
        );
        let started = facts(
            Some(jira(JiraStatusCategory::Indeterminate)),
            vec![],
            vec![],
        );
        let stage = delivery_stage(TicketStatus::Todo, Some(&started), &[]);
        assert_eq!((stage.kind, stage.since_epoch_ms), (InProgress, Some(3)));
        let draft = vec![pull_request(1, PullRequestFactState::Draft, 4)];
        assert_eq!(kind(&facts(None, draft, vec![]), &[]), InProgress);
        let open = vec![
            pull_request(1, PullRequestFactState::Open, 4),
            pull_request(2, PullRequestFactState::Closed, 8),
        ];
        assert_eq!(kind(&facts(None, open, vec![]), &[]), InReview);
        let merged = vec![
            pull_request(1, PullRequestFactState::Open, 4),
            pull_request(2, PullRequestFactState::Merged, 5),
        ];
        let stage = delivery_stage(TicketStatus::Todo, Some(&facts(None, merged, vec![])), &[]);
        assert_eq!((stage.kind, stage.since_epoch_ms), (Merged, Some(5)));
    }

    #[test]
    fn deployments_follow_the_project_order_and_production_is_live() {
        let order = list(&[("dev", false), ("uat", false), ("live", true)]);
        let deployed = EnvironmentDeployState::Deployed;
        let on_uat_and_dev = facts(
            None,
            vec![],
            vec![
                environment("uat", deployed, 5),
                environment("dev", deployed, 7),
            ],
        );
        let stage = delivery_stage(TicketStatus::Todo, Some(&on_uat_and_dev), &order);
        assert_eq!(stage.kind, Deployed);
        assert_eq!(stage.environment.as_deref(), Some("uat"));
        assert_eq!(stage.since_epoch_ms, Some(5));

        let on_live = facts(None, vec![], vec![environment("live", deployed, 8)]);
        let stage = delivery_stage(TicketStatus::InProgress, Some(&on_live), &order);
        assert_eq!(
            (stage.kind, stage.environment.as_deref()),
            (Live, Some("live"))
        );
        let live_and_done = facts(
            Some(jira(JiraStatusCategory::Done)),
            vec![],
            vec![environment("live", deployed, 8)],
        );
        assert_eq!(kind(&live_and_done, &order), Done);

        // Without a list, a "prod" name is production.
        let on_production = facts(None, vec![], vec![environment("production", deployed, 1)]);
        assert_eq!(kind(&on_production, &[]), Live);
    }

    #[test]
    fn jira_done_alone_is_done_only_when_nothing_tracks_environments() {
        let done = facts(Some(jira(JiraStatusCategory::Done)), vec![], vec![]);
        assert_eq!(kind(&done, &[]), Done);
        assert_eq!(kind(&done, &list(&[("live", true)])), InProgress);
    }
}
