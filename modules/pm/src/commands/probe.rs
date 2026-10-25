//! Delivery probe commands: the PM writes probes (approved as written), a
//! delivery check proposes them (never run until approved), and each run's
//! outcome is recorded with the environment states it proves.

use rusqlite::{Connection, params};

use super::check_id;
use super::facts::{current_facts, store_facts};
use crate::delivery::facts::FactSource;
use crate::delivery::probe::{
    CommitAncestryFact, PROJECT_PROBES_MAX, ProbeOutcome, ProbeRun, commit_ancestry_states,
    next_probe_run, valid_probe_argv, valid_probe_environment, valid_probe_reason,
};
use crate::store::{probe_by_id, project_facts, project_probes, project_tickets, to_json};
use crate::{
    DeliveryProbe, PmError, PmStore, ProbeAuthor, ProbeMatcher, ProbeStatus, TicketStatus,
};

/// A probe as the PM writes it or a delivery check proposes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProbe {
    pub project_id: String,
    pub environment: String,
    pub argv: Vec<String>,
    pub matcher: ProbeMatcher,
    pub reason: Option<String>,
}

/// What recording one probe run changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedProbeRun {
    pub run: ProbeRun,
    /// The successful output differs from the previous one; for an agent
    /// probe this is what starts a delivery check.
    pub output_changed: bool,
    /// Tickets whose environment fact the run set.
    pub ticket_ids: Vec<String>,
}

fn require_probe(connection: &Connection, probe_id: &str) -> Result<DeliveryProbe, PmError> {
    check_id(probe_id, "probeId")?;
    probe_by_id(connection, probe_id)?.ok_or(PmError::NotFound)
}

impl PmStore {
    /// The PM writes a probe; it is approved as written.
    pub fn create_probe(&mut self, probe: NewProbe) -> Result<DeliveryProbe, PmError> {
        self.insert_probe(probe, ProbeAuthor::ProjectManager)
    }

    /// A delivery check proposes a probe; it never runs until approved.
    pub fn propose_probe(&mut self, probe: NewProbe) -> Result<DeliveryProbe, PmError> {
        self.insert_probe(probe, ProbeAuthor::Agent)
    }

    fn insert_probe(
        &mut self,
        new: NewProbe,
        author: ProbeAuthor,
    ) -> Result<DeliveryProbe, PmError> {
        check_id(&new.project_id, "projectId")?;
        if !valid_probe_environment(&new.environment) {
            return Err(PmError::Invalid("environment"));
        }
        if !valid_probe_argv(&new.argv) {
            return Err(PmError::Invalid("argv"));
        }
        if new
            .reason
            .as_deref()
            .is_some_and(|reason| !valid_probe_reason(reason))
        {
            return Err(PmError::Invalid("reason"));
        }
        let probe = DeliveryProbe {
            id: self.new_id(),
            project_id: new.project_id,
            environment: new.environment,
            argv: new.argv,
            matcher: new.matcher,
            status: match author {
                ProbeAuthor::ProjectManager => ProbeStatus::Approved,
                ProbeAuthor::Agent => ProbeStatus::Proposed,
            },
            author,
            reason: new.reason,
            created_at_epoch_ms: self.now(),
            last_run: None,
        };
        self.write(|transaction| {
            let existing = project_probes(transaction, &probe.project_id)?;
            if existing.iter().any(|other| other.same_as(&probe)) {
                return Err(PmError::Constraint("the same probe already exists"));
            }
            if existing.len() >= PROJECT_PROBES_MAX {
                return Err(PmError::Constraint("too many probes"));
            }
            transaction.execute(
                "INSERT INTO delivery_probes (id, project_id, environment, argv_json, matcher, \
                     status, author, reason, created_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    probe.id,
                    probe.project_id,
                    probe.environment,
                    to_json(&probe.argv)?,
                    probe.matcher.as_str(),
                    probe.status.as_str(),
                    probe.author.as_str(),
                    probe.reason,
                    probe.created_at_epoch_ms
                ],
            )?;
            Ok(())
        })?;
        Ok(probe)
    }

    /// Lets a proposed probe run. Approving an approved probe changes
    /// nothing.
    pub fn approve_probe(&mut self, probe_id: &str) -> Result<DeliveryProbe, PmError> {
        self.write(|transaction| {
            require_probe(transaction, probe_id)?;
            transaction.execute(
                "UPDATE delivery_probes SET status = 'approved' WHERE id = ?1",
                [probe_id],
            )?;
            require_probe(transaction, probe_id)
        })
    }

    /// Turns a proposal down; it is removed. An approved probe is deleted
    /// with [`Self::delete_probe`] instead.
    pub fn reject_probe(&mut self, probe_id: &str) -> Result<(), PmError> {
        self.write(|transaction| {
            if require_probe(transaction, probe_id)?.status != ProbeStatus::Proposed {
                return Err(PmError::Constraint("only a proposed probe can be rejected"));
            }
            transaction.execute("DELETE FROM delivery_probes WHERE id = ?1", [probe_id])?;
            Ok(())
        })
    }

    pub fn delete_probe(&mut self, probe_id: &str) -> Result<(), PmError> {
        self.write(|transaction| {
            require_probe(transaction, probe_id)?;
            transaction.execute("DELETE FROM delivery_probes WHERE id = ?1", [probe_id])?;
            Ok(())
        })
    }

    /// The open tickets of a project whose one merged pull request names a
    /// merge commit: what a commit-ancestry probe asks Git about.
    pub fn commit_ancestry_targets(
        &self,
        project_id: &str,
    ) -> Result<Vec<(String, String)>, PmError> {
        check_id(project_id, "projectId")?;
        let facts = project_facts(self.connection(), project_id)?;
        Ok(project_tickets(self.connection(), project_id)?
            .into_iter()
            .filter(|ticket| ticket.status != TicketStatus::Done)
            .filter_map(|ticket| {
                let commit = facts.get(&ticket.id)?.merged_commit()?.to_owned();
                Some((ticket.id, commit))
            })
            .collect())
    }

    /// Records one run of an approved probe, run with `argv`. A probe that
    /// was edited, deleted, or unapproved meanwhile is left alone. For a
    /// commit-ancestry output naming a commit, each known Git answer sets
    /// that ticket's environment fact; an unknown answer changes nothing.
    pub fn record_probe_run(
        &mut self,
        probe_id: &str,
        argv: &[String],
        outcome: &ProbeOutcome,
        ancestry: &[CommitAncestryFact],
    ) -> Result<RecordedProbeRun, PmError> {
        let now = self.now();
        self.write(|transaction| {
            let probe = require_probe(transaction, probe_id)?;
            if probe.status != ProbeStatus::Approved || probe.argv != argv {
                return Err(PmError::Conflict);
            }
            let run = next_probe_run(probe.matcher, probe.last_run.as_ref(), outcome, now);
            if !run.is_valid() {
                return Err(PmError::Invalid("outcome"));
            }
            let output_changed = matches!(outcome, ProbeOutcome::Output { .. })
                && probe
                    .last_run
                    .as_ref()
                    .and_then(|previous| previous.output_hash.as_ref())
                    .is_some_and(|previous| Some(previous) != run.output_hash.as_ref());
            transaction.execute(
                "UPDATE delivery_probes SET last_run_json = ?2 WHERE id = ?1",
                params![probe_id, to_json(&run)?],
            )?;
            let mut ticket_ids = Vec::new();
            if let (ProbeMatcher::CommitAncestry, Some(commit)) =
                (probe.matcher, run.deployed_commit.as_deref())
                && matches!(outcome, ProbeOutcome::Output { .. })
            {
                let tickets = project_tickets(transaction, &probe.project_id)?;
                for (ticket_id, state, detail) in commit_ancestry_states(commit, ancestry) {
                    if !tickets.iter().any(|ticket| ticket.id == ticket_id) {
                        continue;
                    }
                    let mut facts = current_facts(transaction, &ticket_id)?;
                    facts.observe_environment(
                        &probe.environment,
                        state,
                        Some(detail),
                        FactSource::Probe,
                        now,
                    );
                    facts.recorded_at_epoch_ms = now;
                    store_facts(transaction, &facts)?;
                    ticket_ids.push(ticket_id);
                }
            }
            Ok(RecordedProbeRun {
                run,
                output_changed,
                ticket_ids,
            })
        })
    }
}
