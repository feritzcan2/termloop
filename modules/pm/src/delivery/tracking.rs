//! How much of a project's delivery the PM can see, derived from its
//! configuration on every read: tickets only, tickets and code, or all the
//! way to deployments.

use super::check_reasons::deploy_tracking_enabled;
use super::probe::DeliveryProbe;
use crate::{ProjectEnvironment, ProjectSources};

/// The furthest kind of delivery data a project has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataTier {
    /// PM tickets, optionally mirrored from Jira.
    Tickets,
    /// Plus pull requests from a GitHub repository.
    Code,
    /// Plus which environments run each change.
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
    pub fn derive(
        sources: &ProjectSources,
        environments: &[ProjectEnvironment],
        probes: &[DeliveryProbe],
    ) -> Self {
        let code = sources.github.is_some();
        let deploy = deploy_tracking_enabled(environments, probes);
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
        assert_eq!(Tracking::derive(&none, &[], &[]).tier, DataTier::Tickets);
        let github = ProjectSources {
            github: Some(GitHubSource {
                owner: "acme".into(),
                name: "pay".into(),
            }),
            ..ProjectSources::default()
        };
        let tracking = Tracking::derive(&github, &[], &[]);
        assert_eq!((tracking.tier, tracking.jira), (DataTier::Code, false));
        let live = [ProjectEnvironment {
            name: "live".into(),
            production: true,
        }];
        assert_eq!(Tracking::derive(&none, &live, &[]).tier, DataTier::Deploy);
    }
}
