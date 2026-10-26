//! How much of a project's delivery the PM can see, derived from its
//! configuration on every read: tickets only, tickets and code, or past the
//! merge through agent-checked Playbook steps.

use crate::ProjectSources;
use crate::playbook::Playbook;

/// The furthest kind of delivery data a project has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataTier {
    /// PM tickets, optionally mirrored from Jira.
    Tickets,
    /// Plus pull requests from a GitHub repository.
    Code,
    /// Plus Playbook steps an agent checks, such as a deployment.
    Deploy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    pub jira: bool,
    pub code: bool,
    pub deploy: bool,
    pub tier: DataTier,
}

impl Tracking {
    pub fn derive(sources: &ProjectSources, playbook: &Playbook) -> Self {
        let code = sources.has_code_host();
        let deploy = playbook.steps.iter().any(|step| step.agent.is_some());
        Self {
            jira: sources.jira.is_some(),
            code,
            deploy,
            tier: if deploy {
                DataTier::Deploy
            } else if code {
                DataTier::Code
            } else {
                DataTier::Tickets
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GitHubSource;

    #[test]
    fn the_tier_is_the_furthest_configured_kind_of_data() {
        let none = ProjectSources::default();
        let default = Playbook::default_for("p1");
        assert_eq!(Tracking::derive(&none, &default).tier, DataTier::Tickets);
        let github = ProjectSources {
            github: Some(GitHubSource {
                owner: "acme".into(),
                name: "pay".into(),
            }),
            ..ProjectSources::default()
        };
        let tracking = Tracking::derive(&github, &default);
        assert_eq!((tracking.tier, tracking.jira), (DataTier::Code, false));
        let mut checked = default;
        checked.steps[3].agent = Some(crate::playbook::AgentCheck {
            instructions: "Read the release pipeline.".into(),
            retry_minutes: 30,
        });
        assert_eq!(Tracking::derive(&none, &checked).tier, DataTier::Deploy);
    }
}
