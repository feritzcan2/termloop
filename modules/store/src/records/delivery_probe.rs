use termloop_domain::{DeliveryProbe, PROJECT_PROBES_MAX, ProbeRun, ProbeStatus};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    /// Adds a probe to its Project, bounded per Project.
    pub fn create_delivery_probe(
        &mut self,
        _authority: &CoreWriteAuthority,
        probe: DeliveryProbe,
    ) -> Result<u64, StoreError> {
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == probe.project_id)
        {
            return Err(StoreError::NotFound);
        }
        if self
            .state
            .delivery_probes
            .iter()
            .any(|existing| existing.id == probe.id)
        {
            return Err(StoreError::AlreadyExists);
        }
        if !probe.is_valid()
            || probe.last_run.is_some()
            || self
                .state
                .delivery_probes
                .iter()
                .filter(|existing| existing.project_id == probe.project_id)
                .count()
                >= PROJECT_PROBES_MAX
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.delivery_probes.push(probe);
        self.commit_or_restore(previous)
    }

    /// Approves a proposed probe so it starts running.
    pub fn approve_delivery_probe(
        &mut self,
        _authority: &CoreWriteAuthority,
        probe_id: &str,
    ) -> Result<u64, StoreError> {
        let index = self.probe_index(probe_id)?;
        if self.state.delivery_probes[index].status == ProbeStatus::Approved {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.delivery_probes[index].status = ProbeStatus::Approved;
        self.commit_or_restore(previous)
    }

    pub fn delete_delivery_probe(
        &mut self,
        _authority: &CoreWriteAuthority,
        probe_id: &str,
    ) -> Result<u64, StoreError> {
        let index = self.probe_index(probe_id)?;
        let previous = self.state.clone();
        self.state.delivery_probes.remove(index);
        self.commit_or_restore(previous)
    }

    /// Replaces an approved probe's last run. Only the run changes, so a
    /// probe edited or deleted while it ran is never overwritten.
    pub fn record_delivery_probe_run(
        &mut self,
        _authority: &CoreWriteAuthority,
        probe_id: &str,
        argv: &[String],
        run: ProbeRun,
    ) -> Result<u64, StoreError> {
        let index = self.probe_index(probe_id)?;
        let probe = &self.state.delivery_probes[index];
        if probe.status != ProbeStatus::Approved || probe.argv != argv || !run.is_valid() {
            return Err(StoreError::ConstraintViolation);
        }
        if probe.last_run.as_ref() == Some(&run) {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.delivery_probes[index].last_run = Some(run);
        self.commit_or_restore(previous)
    }

    fn probe_index(&self, probe_id: &str) -> Result<usize, StoreError> {
        self.state
            .delivery_probes
            .iter()
            .position(|probe| probe.id == probe_id)
            .ok_or(StoreError::NotFound)
    }
}
