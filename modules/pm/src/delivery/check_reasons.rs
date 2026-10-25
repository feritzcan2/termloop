//! When a delivery check is worth an agent: a ticket is merged or deployed,
//! an environment still ahead of it has no approved probe to tell whether
//! the change runs there, and no check has looked since the ticket reached
//! its stage. Derived on every board read; nothing here is stored.
//!
//! Only a project that tracks deployments asks such questions: one with an
//! environment list or at least one approved probe. Without either, there
//! are no check reasons at all.

use super::facts::{EnvironmentDeployState, TicketDeliveryFacts};
use super::probe::{DeliveryProbe, ProbeStatus};
use super::stage::{DeliveryStage, DeliveryStageKind};
use crate::{ProjectEnvironment, environment_is_production};

/// Whether a project tracks deployments: it lists its environments or has
/// approved at least one probe.
pub fn deploy_tracking_enabled(
    environments: &[ProjectEnvironment],
    probes: &[DeliveryProbe],
) -> bool {
    !environments.is_empty()
        || probes
            .iter()
            .any(|probe| probe.status == ProbeStatus::Approved)
}

/// Why one ticket needs a delivery check: one reason per environment group
/// ahead of it that nothing answers yet, or none.
pub fn check_reasons(
    stage: &DeliveryStage,
    facts: Option<&TicketDeliveryFacts>,
    probes: &[DeliveryProbe],
    environments: &[ProjectEnvironment],
) -> Vec<String> {
    if !deploy_tracking_enabled(environments, probes)
        || !matches!(
            stage.kind,
            DeliveryStageKind::Merged | DeliveryStageKind::Deployed
        )
    {
        return Vec::new();
    }
    // A check that looked after the ticket reached its stage already said
    // what it could find.
    let looked_since = facts
        .and_then(|facts| facts.check_notes.as_ref())
        .is_some_and(|notes| {
            stage
                .since_epoch_ms
                .is_some_and(|since| notes.recorded_at_epoch_ms >= since)
        });
    if looked_since {
        return Vec::new();
    }
    let deployed = |name: &str| {
        facts
            .and_then(|facts| facts.environment(name))
            .is_some_and(|environment| environment.state == EnvironmentDeployState::Deployed)
    };
    let probed = |name: &str| {
        probes.iter().any(|probe| {
            probe.status == ProbeStatus::Approved && probe.environment.eq_ignore_ascii_case(name)
        })
    };
    if environments.is_empty() {
        // Tracking through probes alone: production is the environment that
        // matters.
        let production_probed = probes.iter().any(|probe| {
            probe.status == ProbeStatus::Approved
                && environment_is_production(environments, &probe.environment)
        });
        return if production_probed {
            Vec::new()
        } else {
            vec!["No probe tells whether it reached production".to_owned()]
        };
    }
    let current = stage.environment.as_deref().and_then(|name| {
        environments
            .iter()
            .position(|environment| environment.name.eq_ignore_ascii_case(name))
    });
    environments
        .iter()
        .skip(current.map_or(0, |index| index + 1))
        .filter(|environment| !deployed(&environment.name) && !probed(&environment.name))
        .map(|environment| format!("No probe tells whether it reached {}", environment.name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::facts::{CheckNotes, EnvironmentFact, FactSource};
    use super::super::probe::{ProbeAuthor, ProbeMatcher};
    use super::*;

    fn stage(kind: DeliveryStageKind, environment: Option<&str>) -> DeliveryStage {
        DeliveryStage {
            kind,
            environment: environment.map(str::to_owned),
            since_epoch_ms: Some(100),
        }
    }

    fn probe(environment: &str, status: ProbeStatus) -> DeliveryProbe {
        DeliveryProbe {
            id: format!("probe-{environment}"),
            project_id: "p1".into(),
            environment: environment.into(),
            argv: vec!["curl".into(), "https://example.com/version".into()],
            matcher: ProbeMatcher::CommitAncestry,
            status,
            author: ProbeAuthor::Agent,
            reason: None,
            created_at_epoch_ms: 1,
            last_run: None,
        }
    }

    fn list(names: &[&str]) -> Vec<ProjectEnvironment> {
        names
            .iter()
            .map(|name| ProjectEnvironment {
                name: (*name).into(),
                production: *name == "live",
            })
            .collect()
    }

    fn deployed_on(name: &str) -> TicketDeliveryFacts {
        TicketDeliveryFacts {
            environments: vec![EnvironmentFact {
                name: name.into(),
                state: EnvironmentDeployState::Deployed,
                detail: None,
                source: FactSource::Probe,
                observed_at_epoch_ms: 1,
                changed_at_epoch_ms: 1,
            }],
            ..TicketDeliveryFacts::new("t1")
        }
    }

    #[test]
    fn only_a_merged_or_deployed_ticket_with_an_unprobed_environment_ahead_needs_a_check() {
        let order = list(&["dev", "uat", "live"]);
        let on_dev = stage(DeliveryStageKind::Deployed, Some("dev"));
        assert_eq!(
            check_reasons(&on_dev, None, &[], &order),
            vec![
                "No probe tells whether it reached uat",
                "No probe tells whether it reached live"
            ]
        );
        let uat = probe("UAT", ProbeStatus::Approved);
        assert_eq!(
            check_reasons(&on_dev, None, std::slice::from_ref(&uat), &order),
            vec!["No probe tells whether it reached live"]
        );
        // A proposed probe answers nothing yet.
        let proposed = probe("live", ProbeStatus::Proposed);
        assert_eq!(
            check_reasons(&on_dev, None, &[uat, proposed], &order).len(),
            1
        );
        let merged = stage(DeliveryStageKind::Merged, None);
        assert_eq!(
            check_reasons(&merged, Some(&deployed_on("dev")), &[], &order).len(),
            2
        );
        for kind in [
            DeliveryStageKind::ToDo,
            DeliveryStageKind::InReview,
            DeliveryStageKind::Live,
            DeliveryStageKind::Done,
        ] {
            assert!(check_reasons(&stage(kind, None), None, &[], &order).is_empty());
        }
    }

    #[test]
    fn without_deploy_tracking_there_is_never_a_reason_and_probes_alone_ask_about_production() {
        let merged = stage(DeliveryStageKind::Merged, None);
        assert!(check_reasons(&merged, None, &[], &[]).is_empty());
        // A proposal alone does not turn deploy tracking on.
        let proposed = probe("production", ProbeStatus::Proposed);
        assert!(!deploy_tracking_enabled(
            &[],
            std::slice::from_ref(&proposed)
        ));
        assert!(check_reasons(&merged, None, &[proposed], &[]).is_empty());
        // Approved probes without a list track deployments; production is
        // what matters then.
        let staging = probe("staging", ProbeStatus::Approved);
        assert!(deploy_tracking_enabled(&[], std::slice::from_ref(&staging)));
        assert_eq!(
            check_reasons(&merged, None, std::slice::from_ref(&staging), &[]),
            vec!["No probe tells whether it reached production"]
        );
        let production = probe("production", ProbeStatus::Approved);
        assert!(check_reasons(&merged, None, &[staging, production], &[]).is_empty());
    }

    #[test]
    fn a_check_after_the_stage_was_reached_answers_it() {
        let order = list(&["live"]);
        let merged = stage(DeliveryStageKind::Merged, None);
        let checked = |at| TicketDeliveryFacts {
            check_notes: Some(CheckNotes {
                blockers: None,
                markdown: "Not on live yet".into(),
                recorded_at_epoch_ms: at,
            }),
            ..TicketDeliveryFacts::new("t1")
        };
        assert!(check_reasons(&merged, Some(&checked(100)), &[], &order).is_empty());
        assert_eq!(
            check_reasons(&merged, Some(&checked(99)), &[], &order).len(),
            1
        );
    }
}
