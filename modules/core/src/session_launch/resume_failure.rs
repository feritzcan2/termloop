use super::AgentResumePlan;
use crate::{CoreError, CoreRuntime, store_error};
use serde_json::Value;
use termloop_domain::{ResumeFailureReason, ResumeRef, SessionKind};

#[cfg(test)]
mod tests;

pub enum AgentResumeCompletion {
    Committed(Value),
    Rejected(ResumeFailureReason),
}

#[derive(Clone, Copy)]
pub enum AgentResumeFailureOutcome {
    Failed(ResumeFailureReason),
    Shutdown,
}

impl AgentResumeFailureOutcome {
    fn reason(self) -> ResumeFailureReason {
        match self {
            Self::Failed(reason) => reason,
            Self::Shutdown => ResumeFailureReason::DaemonInterrupted,
        }
    }
}

/// Exact current-state proof held across blocking process cleanup.
#[derive(Clone)]
pub struct AgentResumeFailurePlan {
    session_id: String,
    runtime_epoch: u64,
    observation_epoch: Option<u64>,
    source_epoch: u64,
    source_project: String,
    source_cwd: String,
    source_resume_ref: Option<ResumeRef>,
    relocation_id: Option<String>,
    outcome: AgentResumeFailureOutcome,
}

pub struct ObservedAgentResumeFailure {
    plan: AgentResumeFailurePlan,
    ownership_absent: bool,
}

impl AgentResumeFailurePlan {
    pub fn cleanup_failed(self) -> ObservedAgentResumeFailure {
        ObservedAgentResumeFailure {
            plan: self,
            ownership_absent: false,
        }
    }

    /// Runs only on the blocking pool, with no Core guard held. The opaque
    /// result cannot be constructed before the prepared runtime is reaped.
    pub fn reap(self, mut runtime: AgentResumePlan) -> ObservedAgentResumeFailure {
        assert_eq!(self.session_id, runtime.session_id());
        assert_eq!(self.runtime_epoch, runtime.runtime_epoch());
        let ownership_absent = runtime.reap_uncommitted_runtime().is_ok();
        ObservedAgentResumeFailure {
            plan: self,
            ownership_absent,
        }
    }
}

impl CoreRuntime {
    pub fn begin_agent_resume_failure_reap(&mut self, session_id: &str) -> Result<(), CoreError> {
        let lifecycle = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id && session.kind == SessionKind::Agent)
            .map(|session| session.lifecycle_state.as_str())
            .ok_or(CoreError::NotFound)?;
        let relocation_pending = self
            .store
            .session_relocation_operations()
            .iter()
            .any(|operation| operation.session_id == session_id);
        if self.resume_reservations.contains(session_id) {
            if lifecycle != "resuming" && !relocation_pending {
                return Err(CoreError::InvalidParams("sessionId".into()));
            }
            self.resume_ready.remove(session_id);
            self.resume_failure_reaps.insert(session_id.to_owned());
            return Ok(());
        }
        if matches!(lifecycle, "exited" | "resumeFailed") {
            return Ok(());
        }
        Err(CoreError::InvalidParams("sessionId".into()))
    }

    pub fn begin_resume_failure(
        &mut self,
        runtime: &AgentResumePlan,
        outcome: AgentResumeFailureOutcome,
    ) -> Result<AgentResumeFailurePlan, CoreError> {
        let session_id = runtime.session_id();
        let observation_epoch = self
            .agent_observations
            .get(session_id)
            .map(|entry| entry.runtime_epoch);
        if observation_epoch.is_some_and(|epoch| epoch != runtime.runtime_epoch()) {
            return Err(CoreError::RevisionConflict);
        }
        self.begin_agent_resume_failure_reap(session_id)?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        Ok(AgentResumeFailurePlan {
            session_id: session_id.to_owned(),
            runtime_epoch: runtime.runtime_epoch(),
            observation_epoch,
            source_epoch: session.runtime_epoch,
            source_project: session.project_id.clone(),
            source_cwd: session.process.cwd.clone(),
            source_resume_ref: session.resume_ref.clone(),
            relocation_id: self
                .store
                .session_relocation_operations()
                .iter()
                .find(|operation| operation.session_id == session_id)
                .map(|operation| operation.operation_id.clone()),
            outcome,
        })
    }

    pub fn complete_resume_failure(
        &mut self,
        observed: ObservedAgentResumeFailure,
    ) -> Result<Value, CoreError> {
        let plan = observed.plan;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == plan.session_id)
            .ok_or(CoreError::NotFound)?;
        let observation_epoch = self
            .agent_observations
            .get(&plan.session_id)
            .map(|entry| entry.runtime_epoch);
        let relocation_id = self
            .store
            .session_relocation_operations()
            .iter()
            .find(|operation| operation.session_id == plan.session_id)
            .map(|operation| operation.operation_id.as_str());
        if session.runtime_epoch != plan.source_epoch
            || session.project_id != plan.source_project
            || session.process.cwd != plan.source_cwd
            || session.resume_ref != plan.source_resume_ref
            || observation_epoch != plan.observation_epoch
            || relocation_id != plan.relocation_id.as_deref()
        {
            return Err(CoreError::RevisionConflict);
        }
        let outcome = if observed.ownership_absent {
            plan.outcome
        } else {
            AgentResumeFailureOutcome::Failed(ResumeFailureReason::RuntimeOwnershipUncertain)
        };
        self.apply_resume_failure(&plan.session_id, outcome)
    }

    /// Used for process-loss/startup facts that own no prepared resume plan.
    pub fn fail_agent_resume(
        &mut self,
        session_id: &str,
        reason: ResumeFailureReason,
    ) -> Result<Value, CoreError> {
        self.apply_resume_failure(session_id, AgentResumeFailureOutcome::Failed(reason))
    }

    pub fn mark_agent_resume_ownership_uncertain(
        &mut self,
        session_id: &str,
    ) -> Result<Value, CoreError> {
        self.apply_resume_failure(
            session_id,
            AgentResumeFailureOutcome::Failed(ResumeFailureReason::RuntimeOwnershipUncertain),
        )
    }

    fn apply_resume_failure(
        &mut self,
        session_id: &str,
        outcome: AgentResumeFailureOutcome,
    ) -> Result<Value, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id && session.kind == SessionKind::Agent)
            .ok_or(CoreError::NotFound)?;
        let already_failed = matches!(session.lifecycle_state.as_str(), "exited" | "resumeFailed");
        let relocation = self
            .store
            .session_relocation_operations()
            .iter()
            .find(|operation| operation.session_id == session_id)
            .cloned();
        let ownership_uncertain =
            outcome.reason() == ResumeFailureReason::RuntimeOwnershipUncertain;
        if let Some(operation) = &relocation {
            self.store
                .fail_session_relocation(
                    &self.write_authority,
                    session_id,
                    &operation.operation_id,
                    outcome.reason(),
                )
                .map_err(store_error)?;
        } else if matches!(outcome, AgentResumeFailureOutcome::Failed(_))
            && (!already_failed || ownership_uncertain)
        {
            self.store
                .mark_session_resume_failed(&self.write_authority, session_id, outcome.reason())
                .map_err(store_error)?;
        }
        // Persistence succeeded (or the existing failure intentionally wins).
        // Never free the reservation on a failed durable write.
        self.resume_failure_reaps.remove(session_id);
        self.resume_reservations.remove(session_id);
        self.resume_ready.remove(session_id);
        self.agent_observations.remove(session_id);
        self.pending_agent_resume_refs.remove(session_id);
        if matches!(outcome, AgentResumeFailureOutcome::Failed(_))
            && relocation.is_none()
            && !ownership_uncertain
        {
            self.spawn_agent_terminal_hold(session_id)?;
        }
        self.current_agent_resume(session_id)
    }
}
