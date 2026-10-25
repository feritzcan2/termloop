use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::check_id;
use super::probe::{
    NewProbe, approve_probe_row, delete_proposed_probe_row, insert_proposed_probe, probe_value,
};
use super::skill::{enable_skill_row, insert_builtin_skill};
use crate::environment::{
    valid_environment_proposal_summary, valid_project_environments, valid_proposed_environments,
};
use crate::skill::BuiltinSkill;
use crate::store::{json_column, project_environments, project_probes, to_json};
use crate::{
    DeliveryProbe, ENVIRONMENT_PROPOSAL_PROBES_MAX, EnvironmentProposal, PmError, PmStore,
    ProbeAuthor, ProbeStatus, ProjectEnvironment, ProposedEnvironment,
};

/// What the Deployment control setup submits: the environments it found and
/// the probes it proposes for them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEnvironmentProposal {
    pub project_id: String,
    pub summary: String,
    pub environments: Vec<ProposedEnvironment>,
    pub probes: Vec<NewProbe>,
}

/// A stored proposal: the probes are ids, resolved when it is read.
struct ProposalRow {
    summary: String,
    environments: Vec<ProposedEnvironment>,
    probe_ids: Vec<String>,
    created_at_epoch_ms: u64,
}

fn proposal_row(connection: &Connection, project_id: &str) -> Result<Option<ProposalRow>, PmError> {
    Ok(connection
        .query_row(
            "SELECT summary, environments_json, probe_ids_json, created_at_epoch_ms \
             FROM environment_proposals WHERE project_id = ?1",
            [project_id],
            |row| {
                Ok(ProposalRow {
                    summary: row.get(0)?,
                    environments: json_column(row, 1)?,
                    probe_ids: json_column(row, 2)?,
                    created_at_epoch_ms: row.get(3)?,
                })
            },
        )
        .optional()?)
}

/// Removes a proposal and the probes it proposed that are still waiting;
/// reports whether there was one.
fn drop_proposal(transaction: &Transaction<'_>, project_id: &str) -> Result<bool, PmError> {
    let Some(row) = proposal_row(transaction, project_id)? else {
        return Ok(false);
    };
    for probe_id in &row.probe_ids {
        delete_proposed_probe_row(transaction, probe_id)?;
    }
    transaction.execute(
        "DELETE FROM environment_proposals WHERE project_id = ?1",
        [project_id],
    )?;
    Ok(true)
}

/// The proposal with the probes it proposed that are still waiting; one
/// approved or rejected elsewhere drops out.
fn proposal_view(
    project_id: &str,
    row: ProposalRow,
    mut probes: Vec<DeliveryProbe>,
) -> EnvironmentProposal {
    probes
        .retain(|probe| probe.status == ProbeStatus::Proposed && row.probe_ids.contains(&probe.id));
    EnvironmentProposal {
        project_id: project_id.to_owned(),
        summary: row.summary,
        environments: row.environments,
        probes,
        created_at_epoch_ms: row.created_at_epoch_ms,
    }
}

fn replace_environments(
    transaction: &Transaction<'_>,
    project_id: &str,
    environments: &[ProjectEnvironment],
) -> Result<Vec<ProjectEnvironment>, PmError> {
    transaction.execute(
        "DELETE FROM project_environments WHERE project_id = ?1",
        [project_id],
    )?;
    for (position, environment) in (0_i64..).zip(environments) {
        transaction.execute(
            "INSERT INTO project_environments (project_id, position, name, production) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                project_id,
                position,
                environment.name,
                environment.production
            ],
        )?;
    }
    project_environments(transaction, project_id)
}

impl PmStore {
    /// Replaces a project's ordered environment list; an empty list removes
    /// it, so production falls back to the environment name.
    pub fn set_project_environments(
        &mut self,
        project_id: &str,
        environments: &[ProjectEnvironment],
    ) -> Result<Vec<ProjectEnvironment>, PmError> {
        check_id(project_id, "projectId")?;
        if !valid_project_environments(environments) {
            return Err(PmError::Invalid("environments"));
        }
        self.write(|transaction| replace_environments(transaction, project_id, environments))
    }

    /// Keeps what the Deployment control setup found for the PM, replacing
    /// an earlier proposal and its waiting probes. Each probe names one of
    /// the proposed environments; one the project already has is left out.
    pub fn propose_environments(
        &mut self,
        new: NewEnvironmentProposal,
    ) -> Result<EnvironmentProposal, PmError> {
        check_id(&new.project_id, "projectId")?;
        if !valid_environment_proposal_summary(&new.summary) {
            return Err(PmError::Invalid("summary"));
        }
        if !valid_proposed_environments(&new.environments) {
            return Err(PmError::Invalid("environments"));
        }
        if new.probes.len() > ENVIRONMENT_PROPOSAL_PROBES_MAX
            || new.probes.iter().any(|probe| {
                probe.project_id != new.project_id
                    || !new.environments.iter().any(|environment| {
                        environment.name.eq_ignore_ascii_case(&probe.environment)
                    })
            })
        {
            return Err(PmError::Invalid("probes"));
        }
        let now = self.now();
        let probes = new
            .probes
            .into_iter()
            .map(|probe| probe_value(probe, ProbeAuthor::Agent, self.new_id(), now))
            .collect::<Result<Vec<_>, _>>()?;
        let project_id = new.project_id;
        let row = self.write(|transaction| {
            drop_proposal(transaction, &project_id)?;
            let mut probe_ids = Vec::new();
            for probe in &probes {
                if insert_proposed_probe(transaction, probe)? {
                    probe_ids.push(probe.id.clone());
                }
            }
            transaction.execute(
                "INSERT INTO environment_proposals (project_id, summary, environments_json, \
                     probe_ids_json, created_at_epoch_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    project_id,
                    new.summary,
                    to_json(&new.environments)?,
                    to_json(&probe_ids)?,
                    now
                ],
            )?;
            Ok(ProposalRow {
                summary: new.summary,
                environments: new.environments,
                probe_ids,
                created_at_epoch_ms: now,
            })
        })?;
        Ok(proposal_view(&project_id, row, probes))
    }

    /// The project's waiting proposal, with the probes still proposed.
    pub fn environment_proposal(
        &self,
        project_id: &str,
    ) -> Result<Option<EnvironmentProposal>, PmError> {
        check_id(project_id, "projectId")?;
        let connection = self.connection();
        let Some(row) = proposal_row(connection, project_id)? else {
            return Ok(None);
        };
        let probes = project_probes(connection, project_id)?;
        Ok(Some(proposal_view(project_id, row, probes)))
    }

    /// Applies the PM's ticks: the ticked environments join the project's
    /// list, the ticked probes are approved, the rest of the proposal is
    /// dropped, and Deployment control is turned on.
    pub fn apply_environment_proposal(
        &mut self,
        project_id: &str,
        environments: &[String],
        probe_ids: &[String],
    ) -> Result<Vec<ProjectEnvironment>, PmError> {
        check_id(project_id, "projectId")?;
        let proposal = self
            .environment_proposal(project_id)?
            .ok_or(PmError::NotFound)?;
        let ticked = |proposed: &&ProposedEnvironment| {
            environments
                .iter()
                .any(|name| name.eq_ignore_ascii_case(&proposed.name))
        };
        if environments.is_empty()
            || proposal.environments.iter().filter(ticked).count() != environments.len()
        {
            return Err(PmError::Invalid("environments"));
        }
        if !probe_ids
            .iter()
            .all(|id| proposal.probes.iter().any(|probe| &probe.id == id))
        {
            return Err(PmError::Invalid("probeIds"));
        }
        let mut listed = project_environments(self.connection(), project_id)?;
        for proposed in proposal.environments.iter().filter(ticked) {
            if !listed
                .iter()
                .any(|environment| environment.name.eq_ignore_ascii_case(&proposed.name))
            {
                listed.push(proposed.listed());
            }
        }
        if !valid_project_environments(&listed) {
            return Err(PmError::Constraint("too many environments"));
        }
        let skill_id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            for probe_id in probe_ids {
                approve_probe_row(transaction, probe_id)?;
            }
            drop_proposal(transaction, project_id)?;
            let listed = replace_environments(transaction, project_id, &listed)?;
            let skill_id = insert_builtin_skill(
                transaction,
                project_id,
                BuiltinSkill::DeploymentControl,
                skill_id,
                now,
            )?;
            enable_skill_row(transaction, &skill_id)?;
            Ok(listed)
        })
    }

    /// Turns the proposal down with its waiting probes.
    pub fn discard_environment_proposal(&mut self, project_id: &str) -> Result<(), PmError> {
        check_id(project_id, "projectId")?;
        self.write(|transaction| {
            if drop_proposal(transaction, project_id)? {
                Ok(())
            } else {
                Err(PmError::NotFound)
            }
        })
    }
}
