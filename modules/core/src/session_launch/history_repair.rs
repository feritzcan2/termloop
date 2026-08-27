use serde_json::{Value, json};
use std::path::Path;
use std::sync::mpsc::Sender;
use termloop_domain::{ResumeProvider, ResumeRef, SessionKind};

use super::start_codex_runtime;
use crate::{
    AgentRuntimeSignal, CoreError, CoreRuntime, ProviderHistoryRepairUnavailableReason,
    required_string, store_error, terminal_error,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHistoryRepairOutcome {
    Repaired,
    AlreadyHealthy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedProviderHistoryRepair {
    pub outcome: ProviderHistoryRepairOutcome,
    pub repaired_records: u64,
    pub duplicate_boundaries: u64,
    pub backup_created: bool,
}

pub struct ProviderHistoryRepairPlan {
    session_id: String,
    runtime_epoch: u64,
    cwd: String,
    cwd_identity: termloop_platform::PathComparisonInput,
    managed_worktree_trust: bool,
    resume_ref: ResumeRef,
    provider_process_directory: std::path::PathBuf,
    runtime_signal_sender: Sender<AgentRuntimeSignal>,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ProviderHistoryRepairPlan {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn execute(&self) -> Result<ObservedProviderHistoryRepair, CoreError> {
        if self.shutdown.load(std::sync::atomic::Ordering::Acquire) {
            return Err(self.unavailable(ProviderHistoryRepairUnavailableReason::RuntimeConflict));
        }
        let inspection = self.inspect_with_fresh_runtime()?;
        let termloop_agents::CodexThreadHistoryInspection::Damaged {
            codex_home,
            rollout_path,
        } = inspection
        else {
            return Ok(ObservedProviderHistoryRepair {
                outcome: ProviderHistoryRepairOutcome::AlreadyHealthy,
                repaired_records: 0,
                duplicate_boundaries: 0,
                backup_created: false,
            });
        };
        let rollout_path = rollout_path.ok_or_else(|| {
            self.unavailable(ProviderHistoryRepairUnavailableReason::HistoryUnavailable)
        })?;
        let repair = termloop_agents::repair_codex_thread_history(
            &codex_home,
            &rollout_path,
            &self.resume_ref.native_session_id,
        )
        .map_err(|error| {
            let reason = match error {
                termloop_agents::CodexThreadHistoryRepairError::Unavailable => {
                    ProviderHistoryRepairUnavailableReason::HistoryUnavailable
                }
                termloop_agents::CodexThreadHistoryRepairError::DamageUnrecognized => {
                    ProviderHistoryRepairUnavailableReason::DamageUnrecognized
                }
                termloop_agents::CodexThreadHistoryRepairError::MutationFailed => {
                    ProviderHistoryRepairUnavailableReason::MutationFailed
                }
                termloop_agents::CodexThreadHistoryRepairError::VerificationFailed => {
                    ProviderHistoryRepairUnavailableReason::VerificationFailed
                }
                termloop_agents::CodexThreadHistoryRepairError::RecoveryAttention => {
                    ProviderHistoryRepairUnavailableReason::RecoveryAttention
                }
            };
            self.unavailable(reason)
        })?;
        if self.shutdown.load(std::sync::atomic::Ordering::Acquire) {
            return Err(self.unavailable(ProviderHistoryRepairUnavailableReason::RuntimeConflict));
        }
        let verification = match self.inspect_with_fresh_runtime() {
            Ok(inspection) => inspection,
            Err(
                error @ CoreError::ProviderHistoryRepairUnavailable {
                    reason: ProviderHistoryRepairUnavailableReason::RecoveryAttention,
                    ..
                },
            ) => return Err(error),
            Err(_) => {
                return Err(
                    self.unavailable(ProviderHistoryRepairUnavailableReason::VerificationFailed)
                );
            }
        };
        if !matches!(
            verification,
            termloop_agents::CodexThreadHistoryInspection::Healthy
        ) {
            return Err(
                self.unavailable(ProviderHistoryRepairUnavailableReason::VerificationFailed)
            );
        }
        Ok(ObservedProviderHistoryRepair {
            outcome: ProviderHistoryRepairOutcome::Repaired,
            repaired_records: repair.repaired_records,
            duplicate_boundaries: repair.duplicate_boundaries,
            backup_created: true,
        })
    }

    fn inspect_with_fresh_runtime(
        &self,
    ) -> Result<termloop_agents::CodexThreadHistoryInspection, CoreError> {
        let runtime = start_codex_runtime(
            &self.session_id,
            self.runtime_epoch,
            &self.cwd,
            self.managed_worktree_trust,
            &self.provider_process_directory,
            None,
            self.runtime_signal_sender.clone(),
        )
        .map_err(|error| {
            let reason = match error {
                super::AgentResumePreparationError::RuntimeConflict => {
                    ProviderHistoryRepairUnavailableReason::RuntimeConflict
                }
                super::AgentResumePreparationError::RuntimeOwnershipUncertain => {
                    ProviderHistoryRepairUnavailableReason::RecoveryAttention
                }
                _ => ProviderHistoryRepairUnavailableReason::HistoryUnavailable,
            };
            self.unavailable(reason)
        })?;
        let inspection = runtime.inspect_thread_history(&self.resume_ref.native_session_id);
        if runtime.reap().is_err() {
            return Err(self.unavailable(ProviderHistoryRepairUnavailableReason::RecoveryAttention));
        }
        inspection.map_err(|error| {
            let reason = match error {
                termloop_agents::CodexThreadHistoryProbeError::Damaged => {
                    // `inspect_thread_history` projects damage as a successful
                    // inspection; keep this arm fail-closed for future agents
                    // implementations that may return the typed probe error.
                    ProviderHistoryRepairUnavailableReason::DamageUnrecognized
                }
                termloop_agents::CodexThreadHistoryProbeError::Unavailable => {
                    ProviderHistoryRepairUnavailableReason::HistoryUnavailable
                }
            };
            self.unavailable(reason)
        })
    }

    fn unavailable(&self, reason: ProviderHistoryRepairUnavailableReason) -> CoreError {
        CoreError::ProviderHistoryRepairUnavailable {
            session_id: self.session_id.clone(),
            reason,
        }
    }
}

impl CoreRuntime {
    pub fn plan_provider_history_repair(
        &mut self,
        params: Value,
    ) -> Result<ProviderHistoryRepairPlan, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        if params
            .get("acknowledgeHistoryRewrite")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(CoreError::InvalidParams("acknowledgeHistoryRewrite".into()));
        }
        self.ensure_session_not_individually_archived(&session_id)?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let unavailable = |reason| CoreError::ProviderHistoryRepairUnavailable {
            session_id: session_id.clone(),
            reason,
        };
        if session.kind != SessionKind::Agent
            || session.process.agent_id.as_deref() != Some("codex")
        {
            return Err(unavailable(
                ProviderHistoryRepairUnavailableReason::ProviderUnsupported,
            ));
        }
        let resume_ref = session
            .resume_ref
            .clone()
            .filter(|resume_ref| {
                resume_ref.provider == ResumeProvider::Codex && resume_ref.validate()
            })
            .ok_or_else(|| unavailable(ProviderHistoryRepairUnavailableReason::ResumeRefMissing))?;
        if session.lifecycle_state == "running"
            || self
                .terminal
                .contains_session(&session_id)
                .map_err(terminal_error)?
        {
            return Err(unavailable(
                ProviderHistoryRepairUnavailableReason::SessionRunning,
            ));
        }
        if self.resume_reservations.contains(&session_id)
            || self.codex_runtimes.contains_key(&session_id)
            || !self
                .provider_history_repair_reservations
                .insert(session_id.clone())
        {
            return Err(unavailable(
                ProviderHistoryRepairUnavailableReason::RuntimeConflict,
            ));
        }
        let planned = (|| {
            self.ensure_launch_not_reserved(Path::new(&session.process.cwd))
                .map_err(|_| {
                    unavailable(ProviderHistoryRepairUnavailableReason::RuntimeConflict)
                })?;
            let cwd_identity = termloop_platform::existing_directory_comparison_input(Path::new(
                &session.process.cwd,
            ))
            .map_err(|_| unavailable(ProviderHistoryRepairUnavailableReason::HistoryUnavailable))?;
            let transport = self.observation_transport.as_ref().ok_or_else(|| {
                unavailable(ProviderHistoryRepairUnavailableReason::ProviderUnsupported)
            })?;
            if !transport.daemon_owned_bridge_supported("codex") {
                return Err(unavailable(
                    ProviderHistoryRepairUnavailableReason::ProviderUnsupported,
                ));
            }
            Ok(ProviderHistoryRepairPlan {
                session_id: session_id.clone(),
                runtime_epoch: self.runtime_epoch,
                cwd: session.process.cwd.clone(),
                cwd_identity,
                managed_worktree_trust: self.session_has_current_managed_worktree_proof(&session),
                resume_ref,
                provider_process_directory: transport.provider_process_directory.clone(),
                runtime_signal_sender: self.agent_runtime_sender.clone(),
                shutdown: self.resume_shutdown.clone(),
            })
        })();
        if planned.is_err() {
            self.provider_history_repair_reservations
                .remove(&session_id);
        }
        planned
    }

    pub fn complete_provider_history_repair(
        &mut self,
        plan: ProviderHistoryRepairPlan,
        observed: ObservedProviderHistoryRepair,
    ) -> Result<Value, CoreError> {
        let session_id = plan.session_id.clone();
        let unavailable = |reason| CoreError::ProviderHistoryRepairUnavailable {
            session_id: session_id.clone(),
            reason,
        };
        if !self
            .provider_history_repair_reservations
            .remove(&session_id)
        {
            return Err(unavailable(
                ProviderHistoryRepairUnavailableReason::RuntimeConflict,
            ));
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        let current_identity =
            termloop_platform::existing_directory_comparison_input(Path::new(&session.process.cwd))
                .map_err(|_| {
                    unavailable(ProviderHistoryRepairUnavailableReason::RuntimeConflict)
                })?;
        if session.kind != SessionKind::Agent
            || session.process.agent_id.as_deref() != Some("codex")
            || session.lifecycle_state == "running"
            || session.process.cwd != plan.cwd
            || current_identity != plan.cwd_identity
            || session.resume_ref.as_ref() != Some(&plan.resume_ref)
            || self.resume_reservations.contains(&session_id)
            || self.codex_runtimes.contains_key(&session_id)
            || self
                .terminal
                .contains_session(&session_id)
                .map_err(terminal_error)?
        {
            return Err(unavailable(
                ProviderHistoryRepairUnavailableReason::RuntimeConflict,
            ));
        }
        self.store
            .mark_session_exited(&self.write_authority, &session_id)
            .map_err(store_error)?;
        let outcome = match observed.outcome {
            ProviderHistoryRepairOutcome::Repaired => "repaired",
            ProviderHistoryRepairOutcome::AlreadyHealthy => "alreadyHealthy",
        };
        Ok(json!({
            "sessionId": session_id,
            "outcome": outcome,
            "repairedRecords": observed.repaired_records,
            "duplicateBoundaries": observed.duplicate_boundaries,
            "backupCreated": observed.backup_created,
        }))
    }

    pub fn cancel_provider_history_repair(&mut self, session_id: &str) {
        self.provider_history_repair_reservations.remove(session_id);
    }
}
