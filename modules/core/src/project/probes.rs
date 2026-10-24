//! The Project Manager's delivery probes: the ones a delivery check proposed
//! and the ones the Project Manager wrote. Nothing runs until it is approved;
//! a probe the Project Manager writes is approved as written.

use serde_json::{Value, json};
use termloop_domain::{
    DeliveryProbe, PROBE_REASON_MAX_CHARS, PROJECT_PROBES_MAX, ProbeAuthor, ProbeMatcher,
    ProbeStatus, valid_probe_argv, valid_probe_environment,
};

use crate::{CoreError, CoreRuntime, required_string, store_error};

/// A probe as a delivery check proposes it, before validation.
#[derive(Debug, Clone)]
pub struct DeliveryCheckProbeProposal {
    pub environment: String,
    pub argv: Vec<String>,
    /// `commitAncestry` or `agent`.
    pub matcher: String,
    pub reason: String,
}

impl CoreRuntime {
    /// `projectManager.probeCreate`: the Project Manager writes a probe,
    /// approved as written.
    pub(crate) fn create_probe_command(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        self.ensure_project_manager_project(&project_id)?;
        let argv = params
            .get("argv")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::InvalidParams("argv".into()))?
            .iter()
            .map(|value| value.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| CoreError::InvalidParams("argv".into()))?;
        let probe = probe(
            &project_id,
            required_string(&params, "environment")?.trim(),
            argv,
            params
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            params.get("reason").and_then(Value::as_str),
            ProbeAuthor::ProjectManager,
        )?;
        if self.same_probe_exists(&probe) {
            return Err(CoreError::InvalidParams("argv".into()));
        }
        if self.project_probe_count(&project_id) >= PROJECT_PROBES_MAX {
            return Err(CoreError::InvalidParams("probes".into()));
        }
        self.store
            .create_delivery_probe(&self.write_authority, probe)
            .map_err(store_error)?;
        Ok(self.project_manager_board(&project_id))
    }

    /// `projectManager.probeApprove`: lets a proposed probe run.
    pub(crate) fn approve_probe_command(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = self.probe_project(&params)?;
        self.store
            .approve_delivery_probe(&self.write_authority, &required_string(&params, "probeId")?)
            .map_err(store_error)?;
        Ok(self.project_manager_board(&project_id))
    }

    /// `projectManager.probeDelete`: removes a probe or rejects a proposal.
    pub(crate) fn delete_probe_command(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = self.probe_project(&params)?;
        self.store
            .delete_delivery_probe(&self.write_authority, &required_string(&params, "probeId")?)
            .map_err(store_error)?;
        Ok(self.project_manager_board(&project_id))
    }

    /// Validates a check's probe proposals. Proposals that repeat a probe,
    /// or do not fit beside the Project's probes, are left out.
    pub(crate) fn proposed_probes(
        &self,
        project_id: &str,
        proposals: &[DeliveryCheckProbeProposal],
    ) -> Result<Vec<DeliveryProbe>, CoreError> {
        let room = PROJECT_PROBES_MAX.saturating_sub(self.project_probe_count(project_id));
        let mut probes = Vec::<DeliveryProbe>::new();
        for proposal in proposals {
            let probe = probe(
                project_id,
                proposal.environment.trim(),
                proposal.argv.clone(),
                &proposal.matcher,
                Some(&proposal.reason),
                ProbeAuthor::Agent,
            )
            .map_err(|_| CoreError::InvalidParams("probeProposals".into()))?;
            if !self.same_probe_exists(&probe)
                && !probes.iter().any(|other| same_probe(other, &probe))
                && probes.len() < room
            {
                probes.push(probe);
            }
        }
        Ok(probes)
    }

    pub(super) fn probes_json(&self, project_id: &str) -> Vec<Value> {
        self.store
            .delivery_probes()
            .iter()
            .filter(|probe| probe.project_id == project_id)
            .map(|probe| {
                json!({
                    "id": probe.id,
                    "environment": probe.environment,
                    "argv": probe.argv,
                    "matcher": probe.matcher,
                    "status": probe.status,
                    "author": probe.author,
                    "reason": probe.reason,
                    "createdAtEpochMs": probe.created_at_epoch_ms,
                    "lastRun": probe.last_run.as_ref().map(|run| json!({
                        "atEpochMs": run.at_epoch_ms,
                        "changedAtEpochMs": run.changed_at_epoch_ms,
                        "deployedCommit": run.deployed_commit,
                        "failure": run.failure,
                    })),
                })
            })
            .collect()
    }

    /// What a delivery check is told about the Project's probes, so it does
    /// not propose one again.
    pub(crate) fn delivery_check_probes_json(&self, project_id: &str) -> Vec<Value> {
        self.store
            .delivery_probes()
            .iter()
            .filter(|probe| probe.project_id == project_id)
            .map(|probe| {
                json!({
                    "environment": probe.environment,
                    "argv": probe.argv,
                    "matcher": probe.matcher,
                    "status": probe.status,
                    "lastFailure": probe.last_run.as_ref().and_then(|run| run.failure.clone()),
                })
            })
            .collect()
    }

    fn probe_project(&self, params: &Value) -> Result<String, CoreError> {
        let probe_id = required_string(params, "probeId")?;
        let project_id = self
            .store
            .delivery_probes()
            .iter()
            .find(|probe| probe.id == probe_id)
            .map(|probe| probe.project_id.clone())
            .ok_or(CoreError::NotFound)?;
        self.ensure_project_manager_project(&project_id)?;
        Ok(project_id)
    }

    fn project_probe_count(&self, project_id: &str) -> usize {
        self.store
            .delivery_probes()
            .iter()
            .filter(|probe| probe.project_id == project_id)
            .count()
    }

    fn same_probe_exists(&self, probe: &DeliveryProbe) -> bool {
        self.store
            .delivery_probes()
            .iter()
            .any(|existing| same_probe(existing, probe))
    }
}

fn same_probe(left: &DeliveryProbe, right: &DeliveryProbe) -> bool {
    left.project_id == right.project_id
        && left.argv == right.argv
        && left.environment.eq_ignore_ascii_case(&right.environment)
}

fn probe(
    project_id: &str,
    environment: &str,
    argv: Vec<String>,
    matcher: &str,
    reason: Option<&str>,
    author: ProbeAuthor,
) -> Result<DeliveryProbe, CoreError> {
    let invalid = |field: &str| CoreError::InvalidParams(field.into());
    if !valid_probe_environment(environment) {
        return Err(invalid("environment"));
    }
    if !valid_probe_argv(&argv) {
        return Err(invalid("argv"));
    }
    let matcher = match matcher {
        "commitAncestry" => ProbeMatcher::CommitAncestry,
        "agent" => ProbeMatcher::Agent,
        _ => return Err(invalid("matcher")),
    };
    let reason = reason.map(str::trim).filter(|reason| !reason.is_empty());
    if reason.is_some_and(|reason| reason.chars().count() > PROBE_REASON_MAX_CHARS) {
        return Err(invalid("reason"));
    }
    Ok(DeliveryProbe {
        id: termloop_platform::generate_uuid_v4(),
        project_id: project_id.to_owned(),
        environment: environment.to_owned(),
        argv,
        matcher,
        status: match author {
            ProbeAuthor::ProjectManager => ProbeStatus::Approved,
            ProbeAuthor::Agent => ProbeStatus::Proposed,
        },
        author,
        reason: reason.map(str::to_owned),
        created_at_epoch_ms: termloop_platform::current_epoch_ms(),
        last_run: None,
    })
}
