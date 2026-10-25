//! A delivery check's report: what the agent found about one ticket's
//! environments, its notes, what an agent-read probe showed, and probes it
//! suggests. Everything lands in the PM store only; nothing external is
//! written.

use super::checks::close_check;
use super::facts::{current_facts, store_facts};
use super::probe::{insert_proposed_probe, probe_value, require_probe};
use super::{check_id, require_ticket};
use crate::delivery::checks::{DeliveryCheck, DeliveryCheckOutcome};
use crate::delivery::facts::{CheckNotes, TICKET_CHECK_NOTES_MAX_BYTES};
use crate::store::running_check;
use crate::validation::valid_non_blank_text;
use crate::{
    EnvironmentDeployState, FactSource, NewProbe, PmError, PmStore, ProbeAuthor, ProbeMatcher,
    ProbeStatus, TicketDeliveryFacts, valid_environment_name,
};

/// Notes' blockers paragraph bound, as on the facts record.
const CHECK_BLOCKERS_MAX_CHARS: usize = 2_000;
/// Probe proposals one report may carry.
pub const CHECK_PROBE_PROPOSALS_MAX: usize = 4;

/// One environment state the check found evidence for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportedEnvironment {
    pub name: String,
    pub state: EnvironmentDeployState,
    pub detail: Option<String>,
}

/// What the agent read from an approved agent-matcher probe's output: the
/// state of the probe's environment for this ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProbeReading {
    pub probe_id: String,
    pub state: EnvironmentDeployState,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckReport {
    pub ticket_id: String,
    pub environments: Vec<ReportedEnvironment>,
    pub blockers: Option<String>,
    pub notes_markdown: String,
    pub agent_probe: Option<AgentProbeReading>,
    /// Commands the agent found that tell an environment's state. They are
    /// proposed only; the PM approves them before they ever run.
    pub probe_proposals: Vec<NewProbe>,
}

/// What recording a report changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCheckReport {
    pub facts: TicketDeliveryFacts,
    pub proposed_probe_ids: Vec<String>,
    /// The ticket's running check, now closed as reported.
    pub finished_check: Option<DeliveryCheck>,
}

fn check_report_shape(report: &CheckReport) -> Result<(), PmError> {
    if !valid_non_blank_text(&report.notes_markdown, usize::MAX)
        || report.notes_markdown.len() > TICKET_CHECK_NOTES_MAX_BYTES
    {
        return Err(PmError::Invalid("notesMarkdown"));
    }
    if report
        .blockers
        .as_deref()
        .is_some_and(|text| !valid_non_blank_text(text, CHECK_BLOCKERS_MAX_CHARS))
    {
        return Err(PmError::Invalid("blockers"));
    }
    if report
        .environments
        .iter()
        .any(|environment| !valid_environment_name(&environment.name))
    {
        return Err(PmError::Invalid("environments"));
    }
    if report.probe_proposals.len() > CHECK_PROBE_PROPOSALS_MAX {
        return Err(PmError::Invalid("probeProposals"));
    }
    Ok(())
}

impl PmStore {
    /// Records one delivery check report about a ticket of `project_id` in
    /// one transaction: environment facts (source `check`), the check notes,
    /// the environment an agent-matcher probe's output shows (source
    /// `probe`), and proposed probes. A proposal the project already has,
    /// or one beyond the probe bound, is skipped rather than failing the
    /// report. The ticket's running check, if any, is closed as reported. An
    /// invalid report records nothing.
    pub fn record_check_report(
        &mut self,
        project_id: &str,
        report: CheckReport,
    ) -> Result<RecordedCheckReport, PmError> {
        check_id(project_id, "projectId")?;
        check_report_shape(&report)?;
        let now = self.now();
        let ids = self.id_source();
        self.write(|transaction| {
            let ticket = require_ticket(transaction, &report.ticket_id)?;
            if ticket.project_id != project_id {
                return Err(PmError::NotFound);
            }
            let mut facts = current_facts(transaction, &ticket.id)?;
            for environment in report.environments {
                facts.observe_environment(
                    &environment.name,
                    environment.state,
                    environment.detail,
                    FactSource::Check,
                    now,
                );
            }
            if let Some(reading) = report.agent_probe {
                let probe = require_probe(transaction, &reading.probe_id)?;
                if probe.project_id != project_id
                    || probe.status != ProbeStatus::Approved
                    || probe.matcher != ProbeMatcher::Agent
                {
                    return Err(PmError::Invalid("agentProbe"));
                }
                facts.observe_environment(
                    &probe.environment,
                    reading.state,
                    reading.detail,
                    FactSource::Probe,
                    now,
                );
            }
            facts.check_notes = Some(CheckNotes {
                blockers: report.blockers,
                markdown: report.notes_markdown,
                recorded_at_epoch_ms: now,
            });
            facts.recorded_at_epoch_ms = now;
            store_facts(transaction, &facts)?;

            let mut proposed_probe_ids = Vec::new();
            for new in report.probe_proposals {
                if new.project_id != project_id {
                    return Err(PmError::Invalid("probeProposals"));
                }
                let probe = probe_value(new, ProbeAuthor::Agent, ids(), now)?;
                if insert_proposed_probe(transaction, &probe)? {
                    proposed_probe_ids.push(probe.id);
                }
            }
            let finished_check = running_check(transaction, &ticket.id)?
                .map(|check| close_check(transaction, &check, DeliveryCheckOutcome::Reported, now))
                .transpose()?;
            Ok(RecordedCheckReport {
                facts,
                proposed_probe_ids,
                finished_check,
            })
        })
    }
}
