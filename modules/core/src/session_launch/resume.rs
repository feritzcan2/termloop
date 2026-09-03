use super::lifecycle::resume_failure_retryable;
use super::{
    AgentResumePreviewTicket, CodexRuntime, MAX_QUICK_ACTION_PREVIEWS, QUICK_ACTION_PREVIEW_TTL,
    start_codex_runtime,
};
use crate::{
    AgentObservationTransport, AgentRuntimeSignal, CoreError, CoreRuntime, required_string,
    store_error, terminal_error,
};
use serde_json::Value;
use std::path::Path;
use std::sync::mpsc::Sender;
use termloop_domain::{
    AgentConversationReadiness, AgentLaunchSelection, ResumeFailureReason, ResumeRef, SessionKind,
};
use termloop_terminal::TerminalService;
use uuid::Uuid;

pub struct AgentResumePlan {
    pub(super) session_id: String,
    pub(super) project_id: String,
    pub(super) cwd: String,
    pub(super) cwd_identity: termloop_platform::PathComparisonInput,
    pub(super) agent_id: String,
    pub(super) launch_selection: AgentLaunchSelection,
    pub(super) resume_ref: termloop_domain::ResumeRef,
    pub(super) launch_guard: Option<termloop_domain::ResumeLaunchGuard>,
    pub(super) managed_worktree_trust: bool,
    pub(super) observation_token: Option<String>,
    pub(super) mcp_token: Option<String>,
    pub(super) mcp_role: Option<super::AgentMcpRole>,
    pub(super) worker_prompt: Option<String>,
    pub(super) worker_system_prompt: Option<String>,
    pub(super) steward_system_prompt: Option<String>,
    pub(super) mcp_authorizer: super::McpAuthorizer,
    pub(super) observation_transport: AgentObservationTransport,
    pub(super) runtime_signal_sender: Option<Sender<AgentRuntimeSignal>>,
    pub(super) codex_runtime: Option<CodexRuntime>,
    pub(super) preparation_kind: AgentResumePreparationKind,
    pub(super) prepared_launch: Option<termloop_invocation::LaunchPayload>,
    pub(super) pending_generated_input: Option<termloop_invocation::GeneratedTerminalSubmission>,
    pub(super) terminal: TerminalService,
    pub(super) runtime_epoch: u64,
    pub(super) pty_spawned: bool,
    pub(super) committed: bool,
    pub(super) shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(super) cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(super) relocation: Option<super::relocation::AgentRelocationContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentResumeCandidate {
    session_id: String,
    project_id: String,
    lane: super::AgentResumeLane,
}

impl AgentResumeCandidate {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn lane(&self) -> super::AgentResumeLane {
        self.lane
    }
}

#[cfg(test)]
impl AgentResumePlan {
    pub(crate) fn resume_ref_for_test(&self) -> &ResumeRef {
        &self.resume_ref
    }

    pub(crate) fn observation_token_for_test(&self) -> Option<&str> {
        self.observation_token.as_deref()
    }

    pub(crate) fn retires_source_runtime_for_test(&self) -> bool {
        matches!(
            self.preparation_kind,
            AgentResumePreparationKind::Restart { .. }
        )
    }

    pub(crate) fn mcp_role_for_test(&self) -> Option<&super::AgentMcpRole> {
        self.mcp_role.as_ref()
    }

    pub(crate) fn managed_worktree_trust_for_test(&self) -> bool {
        self.managed_worktree_trust
    }
}

pub(super) enum AgentResumePreparationKind {
    Resume,
    Restart {
        retired_codex_runtime: Option<CodexRuntime>,
    },
}

pub enum AgentResumePlanOutcome {
    Current(Value),
    Prepare(Box<AgentResumePlan>),
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum AgentResumePreparationError {
    #[error("an existing runtime ownership record conflicts with resume")]
    RuntimeConflict,
    #[error("the resume PTY could not be started")]
    PtySpawnFailed,
    #[error("the original resume target is no longer available")]
    TargetUnavailable,
    #[error("the provider rejected runtime preparation")]
    ProviderRejected,
    #[error("the provider history is damaged and requires explicit repair")]
    ProviderHistoryDamaged,
    #[error("daemon shutdown interrupted resume preparation")]
    DaemonInterrupted,
    #[error("exact runtime absence could not be proven")]
    RuntimeOwnershipUncertain,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
#[error("exact runtime absence could not be proven")]
pub struct AgentResumeReapError;

#[derive(Clone)]
pub struct AgentResumeTargetValidation {
    cwd: String,
    cwd_identity: termloop_platform::PathComparisonInput,
}

impl AgentResumePlan {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn resume_lane(&self) -> super::AgentResumeLane {
        self.mcp_role
            .as_ref()
            .map(super::AgentMcpRole::resume_lane)
            .unwrap_or(super::AgentResumeLane::Ordinary)
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn cancellation(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.cancellation.clone()
    }

    pub fn runtime_epoch(&self) -> u64 {
        self.runtime_epoch
    }

    pub fn is_relocation(&self) -> bool {
        self.relocation.is_some()
    }

    pub fn relocation_cwds(&self) -> Option<(&str, &str)> {
        self.relocation
            .as_ref()
            .map(|relocation| (relocation.source_cwd.as_str(), self.cwd.as_str()))
    }

    pub fn target_validation(&self) -> AgentResumeTargetValidation {
        AgentResumeTargetValidation {
            cwd: self.cwd.clone(),
            cwd_identity: self.cwd_identity.clone(),
        }
    }

    /// Reaps any runtime still owned by an uncommitted plan and reports
    /// whether exact absence was proven. Server failure paths call this
    /// explicitly before publishing a retryable durable state; `Drop` remains
    /// only a last-resort safety net for unwinding.
    pub fn reap_uncommitted_runtime(&mut self) -> Result<(), AgentResumeReapError> {
        self.revoke_provisional_mcp();
        if matches!(
            self.preparation_kind,
            AgentResumePreparationKind::Restart { .. }
        ) {
            self.terminate_registered_pty()?;
            self.preparation_kind = AgentResumePreparationKind::Resume;
        }
        if self.pty_spawned && !self.committed {
            self.terminate_registered_pty()?;
            self.pty_spawned = false;
        }
        if let Some(runtime) = self.codex_runtime.take() {
            runtime.reap()?;
        }
        Ok(())
    }

    fn terminate_registered_pty(&self) -> Result<(), AgentResumeReapError> {
        match self.terminal.contains_session(&self.session_id) {
            Ok(true) => self
                .terminal
                .terminate(&self.session_id)
                .map_err(|_| AgentResumeReapError),
            Ok(false) => Ok(()),
            Err(_) => Err(AgentResumeReapError),
        }
    }

    fn register_provisional_mcp(&self) {
        if let (Some(token), Some(role)) = (self.mcp_token.as_ref(), self.mcp_role.as_ref()) {
            self.mcp_authorizer.register_provisional(
                self.session_id.clone(),
                self.runtime_epoch,
                role.clone(),
                token.clone(),
            );
        }
    }

    fn revoke_provisional_mcp(&self) {
        self.mcp_authorizer
            .remove_provisional(&self.session_id, self.runtime_epoch);
    }

    pub(super) fn compose_resume_launch(
        &self,
        observation: Option<termloop_invocation::AgentObservationLaunch<'_>>,
    ) -> Result<termloop_invocation::LaunchPayload, AgentResumePreparationError> {
        if let Some(role) = self.mcp_role.as_ref().and_then(|role| match role {
            super::AgentMcpRole::Steward { .. } => Some((
                termloop_invocation::ExecutorRole::Steward,
                termloop_invocation::AgentMcpProfile::Steward,
                self.steward_system_prompt.as_deref(),
                None,
            )),
            super::AgentMcpRole::Worker { .. } => Some((
                termloop_invocation::ExecutorRole::Worker,
                termloop_invocation::AgentMcpProfile::Worker,
                self.worker_system_prompt.as_deref(),
                self.worker_prompt.as_deref(),
            )),
            _ => None,
        }) {
            let token = self
                .mcp_token
                .as_ref()
                .ok_or(AgentResumePreparationError::ProviderRejected)?;
            return termloop_invocation::persistent_assistant_agent(
                termloop_invocation::PersistentAssistantLaunch {
                    agent_id: &self.agent_id,
                    model: &self.launch_selection.model,
                    permission: &self.launch_selection.permission,
                    reasoning: &self.launch_selection.reasoning,
                    role: role.0,
                    system_prompt: role.2,
                    worker_prompt: role.3,
                    cwd: &self.cwd,
                    conversation: termloop_invocation::AgentConversationLaunch::Resume {
                        resume_ref: &self.resume_ref,
                    },
                    observation,
                    mcp: termloop_invocation::AgentMcpLaunch {
                        endpoint: &self.observation_transport.mcp_endpoint,
                        token,
                        claude_config_path: &self.observation_transport.claude_mcp_config_path,
                        profile: role.1,
                    },
                },
            )
            .map_err(|_| AgentResumePreparationError::ProviderRejected);
        }
        if let Some(super::AgentMcpRole::Helper { request_id }) = &self.mcp_role {
            let conversation = termloop_invocation::AgentConversationLaunch::Resume {
                resume_ref: &self.resume_ref,
            };
            let mcp = self
                .mcp_token
                .as_ref()
                .map(|token| termloop_invocation::AgentMcpLaunch {
                    endpoint: &self.observation_transport.mcp_endpoint,
                    token,
                    claude_config_path: &self.observation_transport.claude_mcp_config_path,
                    profile: termloop_invocation::AgentMcpProfile::Helper,
                });
            let launch = if self.managed_worktree_trust {
                termloop_invocation::configured_ask_to_helper_for_managed_worktree_conversation_resume(
                    &self.agent_id,
                    &self.cwd,
                    &self.launch_selection.model,
                    &self.launch_selection.permission,
                    &self.launch_selection.reasoning,
                    request_id.as_deref(),
                    conversation,
                    observation,
                    mcp,
                )
            } else {
                termloop_invocation::configured_ask_to_helper_for_conversation_resume(
                    &self.agent_id,
                    &self.cwd,
                    &self.launch_selection.model,
                    &self.launch_selection.permission,
                    &self.launch_selection.reasoning,
                    request_id.as_deref(),
                    conversation,
                    observation,
                    mcp,
                )
            };
            return launch.map_err(|_| AgentResumePreparationError::ProviderRejected);
        }
        let conversation = termloop_invocation::AgentConversationLaunch::Resume {
            resume_ref: &self.resume_ref,
        };
        let mcp = self
            .mcp_token
            .as_ref()
            .map(|token| termloop_invocation::AgentMcpLaunch {
                endpoint: &self.observation_transport.mcp_endpoint,
                token,
                claude_config_path: &self.observation_transport.claude_mcp_config_path,
                profile: termloop_invocation::AgentMcpProfile::Interactive,
            });
        let launch = if self.managed_worktree_trust {
            termloop_invocation::configured_interactive_agent_for_managed_worktree_conversation(
                &self.agent_id,
                &self.cwd,
                &self.launch_selection.model,
                &self.launch_selection.permission,
                &self.launch_selection.reasoning,
                conversation,
                observation,
                mcp,
            )
        } else {
            termloop_invocation::configured_interactive_agent_for_conversation(
                &self.agent_id,
                &self.cwd,
                &self.launch_selection.model,
                &self.launch_selection.permission,
                &self.launch_selection.reasoning,
                conversation,
                observation,
                mcp,
            )
        };
        launch.map_err(|_| AgentResumePreparationError::ProviderRejected)
    }

    pub fn prepare_runtime(&mut self) -> Result<(), AgentResumePreparationError> {
        if self.shutdown.load(std::sync::atomic::Ordering::Acquire)
            || self.cancellation.load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(AgentResumePreparationError::DaemonInterrupted);
        }
        if let AgentResumePreparationKind::Restart {
            retired_codex_runtime,
        } = std::mem::replace(
            &mut self.preparation_kind,
            AgentResumePreparationKind::Resume,
        ) {
            self.terminal
                .terminate(&self.session_id)
                .map_err(|_| AgentResumePreparationError::RuntimeConflict)?;
            // Provider and PTY ownership use separate records. Drop the old
            // Codex App Server only after the old PTY is absent and before a
            // fresh provider record is created for the resume attempt.
            if let Some(runtime) = retired_codex_runtime {
                runtime
                    .reap()
                    .map_err(|_| AgentResumePreparationError::RuntimeOwnershipUncertain)?;
            }
        }
        self.target_validation().validate()?;
        // Codex eagerly initializes configured MCP servers while its App Server
        // and remote TUI are still becoming ready. Admit only transport-level
        // MCP traffic during that window; core commands remain unauthorized
        // until complete_agent_resume promotes this exact token.
        self.register_provisional_mcp();
        if self.agent_id == "codex" {
            let runtime = start_codex_runtime(
                &self.session_id,
                self.runtime_epoch,
                &self.cwd,
                self.managed_worktree_trust,
                &self.observation_transport.provider_process_directory,
                self.mcp_token
                    .as_ref()
                    .map(|token| termloop_invocation::AgentMcpLaunch {
                        endpoint: &self.observation_transport.mcp_endpoint,
                        token,
                        claude_config_path: &self.observation_transport.claude_mcp_config_path,
                        profile: self
                            .mcp_role
                            .as_ref()
                            .map(super::AgentMcpRole::invocation_profile)
                            .unwrap_or(termloop_invocation::AgentMcpProfile::Interactive),
                    }),
                self.runtime_signal_sender
                    .take()
                    .ok_or(AgentResumePreparationError::ProviderRejected)?,
            )?;
            // Prove the complete durable projection before the resume TUI can
            // append. A damaged history is a repair state, while an unavailable
            // probe fails closed so app restart cannot race another writer and
            // create the same duplicate ordinal again.
            if let Err(probe_error) =
                runtime.warm_thread_history(&self.resume_ref.native_session_id)
            {
                self.revoke_provisional_mcp();
                runtime
                    .reap()
                    .map_err(|_| AgentResumePreparationError::RuntimeOwnershipUncertain)?;
                return Err(match probe_error {
                    termloop_agents::CodexThreadHistoryProbeError::Damaged => {
                        AgentResumePreparationError::ProviderHistoryDamaged
                    }
                    termloop_agents::CodexThreadHistoryProbeError::Unavailable => {
                        AgentResumePreparationError::ProviderRejected
                    }
                });
            }
            if let Some(launch) = self.prepared_launch.as_mut() {
                launch
                    .bind_codex_app_server_endpoint(runtime.bridge.endpoint())
                    .map_err(|_| AgentResumePreparationError::ProviderRejected)?;
            }
            self.codex_runtime = Some(runtime);
        }
        if self.shutdown.load(std::sync::atomic::Ordering::Acquire)
            || self.cancellation.load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(AgentResumePreparationError::DaemonInterrupted);
        }

        let codex_endpoint = self
            .codex_runtime
            .as_ref()
            .map(|runtime| runtime.bridge.endpoint());
        let observation = self.observation_transport.invocation_observation(
            &self.agent_id,
            &self.session_id,
            self.observation_token.as_deref(),
            codex_endpoint,
        );
        let launch = if let Some(launch) = self.prepared_launch.take() {
            launch
        } else {
            self.compose_resume_launch(observation)?
        };
        self.pending_generated_input = launch.initial_input_submission();
        self.terminal
            .spawn(termloop_terminal::PtySpawnSpec {
                session_id: self.session_id.clone(),
                runtime_epoch: self.runtime_epoch,
                program: launch.program().to_owned(),
                args: launch.args().to_vec(),
                cwd: self.cwd.clone(),
                environment: launch.environment().clone(),
                recent_output_replay: true,
            })
            .map_err(|error| match error {
                termloop_terminal::TerminalError::SessionExists
                | termloop_terminal::TerminalError::OwnershipConflict => {
                    AgentResumePreparationError::RuntimeConflict
                }
                _ => AgentResumePreparationError::PtySpawnFailed,
            })?;
        self.pty_spawned = true;
        if self.shutdown.load(std::sync::atomic::Ordering::Acquire)
            || self.cancellation.load(std::sync::atomic::Ordering::Acquire)
        {
            let _ = self.terminal.terminate(&self.session_id);
            self.pty_spawned = false;
            return Err(AgentResumePreparationError::DaemonInterrupted);
        }
        Ok(())
    }
}

impl AgentResumeTargetValidation {
    pub fn validate(&self) -> Result<(), AgentResumePreparationError> {
        let canonical = termloop_platform::canonical_existing_directory(&self.cwd)
            .map_err(|_| AgentResumePreparationError::TargetUnavailable)?;
        if canonical.to_string_lossy() != self.cwd {
            return Err(AgentResumePreparationError::TargetUnavailable);
        }
        let current_identity =
            termloop_platform::existing_directory_comparison_input(std::path::Path::new(&self.cwd))
                .map_err(|_| AgentResumePreparationError::TargetUnavailable)?;
        if current_identity != self.cwd_identity {
            return Err(AgentResumePreparationError::TargetUnavailable);
        }
        // The ResumeLaunchGuard is launch provenance, not a resume gate.
        // Resume restores the process authority a live agent would have
        // kept through branch switches, re-registration, or proof drift, so the
        // spawn gate is only exact-directory identity plus the plan-time
        // cleanup/repair reservation refusal. Fork, Steward reuse, and cleanup
        // keep their full managed-worktree proofs.
        Ok(())
    }
}

impl Drop for AgentResumePlan {
    fn drop(&mut self) {
        let _ = self.reap_uncommitted_runtime();
    }
}

impl CoreRuntime {
    fn managed_worktree_guard_is_current(
        &self,
        project_id: &str,
        cwd: &str,
        guard: &termloop_domain::ResumeLaunchGuard,
    ) -> bool {
        if guard.path != cwd {
            return false;
        }
        let task_matches = self.store.tasks().iter().any(|task| {
            task.id == guard.task_id
                && task.project_id == project_id
                && task.worktree_generation == guard.worktree_generation
                && task
                    .worktree
                    .as_ref()
                    .is_some_and(|worktree| worktree.path == guard.path)
        });
        let proof_matches = self.store.managed_worktrees().iter().any(|proof| {
            proof.task_id == guard.task_id
                && proof.operation_id == guard.managed_worktree_operation_id
                && proof.worktree_generation == guard.worktree_generation
                && proof.registered_worktree_path == guard.path
        });
        task_matches && proof_matches
    }

    pub(super) fn session_has_current_managed_worktree_proof(
        &self,
        session: &termloop_domain::SessionRecord,
    ) -> bool {
        let Some(guard) = session.resume_launch_guard.as_ref() else {
            return false;
        };
        self.managed_worktree_guard_is_current(&session.project_id, &session.process.cwd, guard)
    }

    fn resumed_mcp_role(
        &self,
        session: &termloop_domain::SessionRecord,
        transport: &AgentObservationTransport,
    ) -> Option<super::AgentMcpRole> {
        super::resume_role::derive_resumed_mcp_role(
            session,
            self.store.sessions(),
            self.store.steward_configurations(),
            self.store.worker_configurations(),
            transport,
        )
    }

    fn resume_lane_for_session(
        &self,
        session: &termloop_domain::SessionRecord,
    ) -> super::AgentResumeLane {
        self.observation_transport
            .as_ref()
            .and_then(|transport| self.resumed_mcp_role(session, transport))
            .as_ref()
            .map(super::AgentMcpRole::resume_lane)
            .unwrap_or(super::AgentResumeLane::Ordinary)
    }

    pub fn preview_agent_resume(&mut self, params: Value) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        self.ensure_session_not_individually_archived(&session_id)?;
        if self.session_is_archive_suspended(&session_id) {
            return Err(CoreError::SessionSuspendedByTaskArchive { session_id });
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        let agent_id = session
            .process
            .agent_id
            .as_deref()
            .ok_or(CoreError::AgentUnsupported)?;
        let resume_ref = session
            .resume_ref
            .as_ref()
            .ok_or(CoreError::AgentUnsupported)?;
        let transport = self
            .observation_transport
            .as_ref()
            .ok_or(CoreError::AgentUnsupported)?;
        // A durable ResumeRef proves that this logical conversation previously
        // reached the provider-specific identity path. Capability discovery is
        // only a startup hint: a transient help-probe failure must not turn an
        // otherwise resumable Session into a permanent dead end. Build the
        // exact fail-closed resume attempt and let provider startup/readiness
        // decide it; invocation never falls back to a fresh conversation.
        let observation_token = transport
            .launch_scoped_observation_supported(agent_id)
            .then(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));
        let mcp_role = self.resumed_mcp_role(session, transport);
        let mcp_token = mcp_role
            .is_some()
            .then(termloop_platform::generate_capability_token);
        let observation = transport.invocation_observation(
            agent_id,
            &session_id,
            observation_token.as_deref(),
            Some(termloop_invocation::CODEX_APP_SERVER_RUNTIME_PLACEHOLDER),
        );
        let mcp = mcp_token
            .as_ref()
            .map(|token| termloop_invocation::AgentMcpLaunch {
                endpoint: &transport.mcp_endpoint,
                token,
                claude_config_path: &transport.claude_mcp_config_path,
                profile: mcp_role
                    .as_ref()
                    .map(super::AgentMcpRole::invocation_profile)
                    .unwrap_or(termloop_invocation::AgentMcpProfile::Interactive),
            });
        let managed_worktree_trust = self.session_has_current_managed_worktree_proof(session);
        let launch = if let Some(super::AgentMcpRole::Helper { request_id }) = &mcp_role {
            if managed_worktree_trust {
                termloop_invocation::configured_ask_to_helper_for_managed_worktree_conversation_resume(
                    agent_id,
                    &session.process.cwd,
                    &session.launch_selection.model,
                    &session.launch_selection.permission,
                    &session.launch_selection.reasoning,
                    request_id.as_deref(),
                    termloop_invocation::AgentConversationLaunch::Resume { resume_ref },
                    observation,
                    mcp,
                )
            } else {
                termloop_invocation::configured_ask_to_helper_for_conversation_resume(
                    agent_id,
                    &session.process.cwd,
                    &session.launch_selection.model,
                    &session.launch_selection.permission,
                    &session.launch_selection.reasoning,
                    request_id.as_deref(),
                    termloop_invocation::AgentConversationLaunch::Resume { resume_ref },
                    observation,
                    mcp,
                )
            }
        } else if managed_worktree_trust {
            termloop_invocation::configured_interactive_agent_for_managed_worktree_conversation(
                agent_id,
                &session.process.cwd,
                &session.launch_selection.model,
                &session.launch_selection.permission,
                &session.launch_selection.reasoning,
                termloop_invocation::AgentConversationLaunch::Resume { resume_ref },
                observation,
                mcp,
            )
        } else {
            termloop_invocation::configured_interactive_agent_for_conversation(
                agent_id,
                &session.process.cwd,
                &session.launch_selection.model,
                &session.launch_selection.permission,
                &session.launch_selection.reasoning,
                termloop_invocation::AgentConversationLaunch::Resume { resume_ref },
                observation,
                mcp,
            )
        }
        .map_err(super::invocation_error)?;
        let manifest = launch.inspectable_manifest().clone();
        self.agent_resume_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        if self.agent_resume_previews.len() >= MAX_QUICK_ACTION_PREVIEWS {
            self.agent_resume_previews.pop_front();
        }
        let mut launch_ticket = termloop_platform::generate_opaque_runtime_token();
        while self
            .agent_resume_previews
            .iter()
            .any(|(ticket, _)| ticket == &launch_ticket)
        {
            launch_ticket = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = termloop_platform::MonotonicDeadline::after(QUICK_ACTION_PREVIEW_TTL)
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.agent_resume_previews.push_back((
            launch_ticket.clone(),
            AgentResumePreviewTicket {
                session_id,
                launch,
                observation_token,
                mcp_token,
                managed_worktree_trust,
                deadline,
            },
        ));
        Ok(serde_json::json!({ "launch_ticket": launch_ticket, "manifest": manifest }))
    }

    pub fn plan_ticketed_agent_resume(
        &mut self,
        params: Value,
    ) -> Result<crate::AgentResumePlanOutcome, CoreError> {
        self.agent_resume_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        let launch_ticket = required_string(&params, "launchTicket")?;
        let session_id = required_string(&params, "sessionId")?;
        self.ensure_session_not_individually_archived(&session_id)?;
        if self.session_is_archive_suspended(&session_id) {
            return Err(CoreError::SessionSuspendedByTaskArchive { session_id });
        }
        let position = self
            .agent_resume_previews
            .iter()
            .position(|(ticket, _)| ticket == &launch_ticket)
            .ok_or_else(|| CoreError::InvalidParams("launchTicket".into()))?;
        let (_, preview) = self
            .agent_resume_previews
            .remove(position)
            .expect("ticket position came from the same bounded queue");
        if preview.session_id != session_id {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        let current_managed_worktree_trust = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .is_some_and(|session| self.session_has_current_managed_worktree_proof(session));
        if preview.managed_worktree_trust != current_managed_worktree_trust {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        // A preview ticket is explicit, short-lived user intent. It may reopen an
        // explicitly stopped Agent or retry any prior failure that still has a
        // valid provider conversation identity. Automatic/startup paths retain
        // their narrower retry policy.
        let outcome = self.plan_agent_resume_internal_with_restart_facts(
            params, None, None, /*explicit_user_resume*/ true,
        )?;
        if let crate::AgentResumePlanOutcome::Prepare(mut plan) = outcome {
            plan.observation_token = preview.observation_token.clone();
            plan.mcp_token = preview.mcp_token;
            plan.prepared_launch = Some(preview.launch);
            if let Some(capability) = self.agent_observations.get_mut(&session_id) {
                capability.token = preview.observation_token;
            }
            Ok(crate::AgentResumePlanOutcome::Prepare(plan))
        } else {
            Ok(outcome)
        }
    }

    pub fn plan_agent_resume(
        &mut self,
        params: Value,
    ) -> Result<crate::AgentResumePlanOutcome, CoreError> {
        self.plan_agent_resume_internal(params, None)
    }

    pub fn plan_running_agent_restart(
        &mut self,
        params: Value,
        observed_at_epoch_ms: u64,
    ) -> Result<crate::AgentResumePlanOutcome, CoreError> {
        self.plan_agent_resume_internal(params, Some(observed_at_epoch_ms))
    }

    pub fn plan_daemon_restart_agent_resume(
        &mut self,
        params: Value,
        observed_at_epoch_ms: u64,
    ) -> Result<crate::AgentResumePlanOutcome, CoreError> {
        self.plan_agent_resume_internal_with_daemon_handoff(params, observed_at_epoch_ms)
    }

    fn plan_agent_resume_internal(
        &mut self,
        params: Value,
        client_restart_observed_at_epoch_ms: Option<u64>,
    ) -> Result<crate::AgentResumePlanOutcome, CoreError> {
        self.plan_agent_resume_internal_with_restart_facts(
            params,
            client_restart_observed_at_epoch_ms,
            None,
            /*explicit_user_resume*/ false,
        )
    }

    fn plan_agent_resume_internal_with_daemon_handoff(
        &mut self,
        params: Value,
        observed_at_epoch_ms: u64,
    ) -> Result<crate::AgentResumePlanOutcome, CoreError> {
        self.plan_agent_resume_internal_with_restart_facts(
            params,
            None,
            Some(observed_at_epoch_ms),
            /*explicit_user_resume*/ false,
        )
    }

    fn plan_agent_resume_internal_with_restart_facts(
        &mut self,
        params: Value,
        client_restart_observed_at_epoch_ms: Option<u64>,
        daemon_restart_observed_at_epoch_ms: Option<u64>,
        explicit_user_resume: bool,
    ) -> Result<crate::AgentResumePlanOutcome, CoreError> {
        let restart_running = client_restart_observed_at_epoch_ms.is_some();
        let session_id = required_string(&params, "sessionId")?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if session.kind != SessionKind::Agent {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        if self
            .provider_history_repair_reservations
            .contains(&session_id)
        {
            return Err(CoreError::ProviderHistoryRepairUnavailable {
                session_id,
                reason: crate::ProviderHistoryRepairUnavailableReason::RuntimeConflict,
            });
        }
        if self.resume_reservations.contains(&session_id)
            || (session.lifecycle_state == "running" && !restart_running)
            || (session.lifecycle_state != "running" && restart_running)
        {
            return Ok(crate::AgentResumePlanOutcome::Current(
                self.project_session(&session),
            ));
        }
        if (session.lifecycle_state == "exited" && !explicit_user_resume)
            || (session.lifecycle_state == "resumeFailed"
                && !explicit_user_resume
                && !session.resume_failure.is_some_and(resume_failure_retryable))
        {
            return Ok(crate::AgentResumePlanOutcome::Current(
                self.project_session(&session),
            ));
        }
        let Some(resume_ref) = session.resume_ref.clone().filter(ResumeRef::validate) else {
            self.store
                .mark_session_resume_failed(
                    &self.write_authority,
                    &session_id,
                    ResumeFailureReason::ResumeRefMissing,
                )
                .map_err(store_error)?;
            return Ok(crate::AgentResumePlanOutcome::Current(
                self.project_session(
                    self.store
                        .sessions()
                        .iter()
                        .find(|candidate| candidate.id == session_id)
                        .ok_or(CoreError::NotFound)?,
                ),
            ));
        };
        let agent_id = session
            .process
            .agent_id
            .clone()
            .ok_or_else(|| CoreError::InvalidParams("sessionId".into()))?;
        let transport = self
            .observation_transport
            .clone()
            .ok_or(CoreError::AgentUnsupported)?;
        if self
            .ensure_launch_not_reserved(Path::new(&session.process.cwd))
            .is_err()
        {
            self.store
                .mark_session_resume_failed(
                    &self.write_authority,
                    &session_id,
                    ResumeFailureReason::LaunchReserved,
                )
                .map_err(store_error)?;
            let current = self
                .store
                .sessions()
                .iter()
                .find(|candidate| candidate.id == session_id)
                .ok_or(CoreError::NotFound)?;
            return Ok(crate::AgentResumePlanOutcome::Current(
                self.project_session(current),
            ));
        }
        let cwd_identity = match termloop_platform::existing_directory_comparison_input(Path::new(
            &session.process.cwd,
        )) {
            Ok(identity) => identity,
            Err(_) => {
                self.store
                    .mark_session_resume_failed(
                        &self.write_authority,
                        &session_id,
                        ResumeFailureReason::CwdUnavailable,
                    )
                    .map_err(store_error)?;
                let current = self
                    .store
                    .sessions()
                    .iter()
                    .find(|candidate| candidate.id == session_id)
                    .ok_or(CoreError::NotFound)?;
                return Ok(crate::AgentResumePlanOutcome::Current(
                    self.project_session(current),
                ));
            }
        };
        // A stored ResumeLaunchGuard is not revalidated against current Task
        // state here. The Session provably ran in this exact
        // directory; an advanced generation, rebound Task, or missing managed
        // proof no longer refuses resume. Reservation refusal and directory
        // identity above remain the fail-closed spawn gates.
        let restart_observation = if agent_id == "codex"
            && let Some(observed_at_epoch_ms) = client_restart_observed_at_epoch_ms
            && let Some(previous) = self
                .agent_observations
                .get(&session_id)
                .and_then(|capability| capability.observation)
            && previous.state == termloop_agents::AgentState::Working
        {
            let sequence = self.next_observation_sequence()?;
            Some(termloop_agents::reduce_observation(
                Some(previous),
                termloop_agents::AgentSignal::ClientRestartInterrupted,
                termloop_agents::AgentSignalSource::Process,
                sequence,
                observed_at_epoch_ms,
            ))
        } else {
            daemon_restart_observed_at_epoch_ms.and_then(|observed_at_epoch_ms| {
                let handoff = self.daemon_restart_handoffs.remove(&session_id)?;
                if handoff.agent_id != agent_id || handoff.runtime_epoch != session.runtime_epoch {
                    return None;
                }
                if !termloop_agents::has_global_resume_identity(&agent_id) {
                    return None;
                }
                let sequence = self.next_observation_sequence().ok()?;
                Some(termloop_agents::reduce_observation(
                    None,
                    termloop_agents::AgentSignal::DaemonRestartInterrupted,
                    termloop_agents::AgentSignalSource::Process,
                    sequence,
                    observed_at_epoch_ms,
                ))
            })
        };
        // A stopped Agent retains a real interactive shell under its logical
        // Session id. Retry is the explicit handoff back to a provider PTY, so
        // retire that shell only after every fail-closed preflight has passed.
        self.release_agent_terminal_hold_for_resume(&session_id)?;
        self.store
            .mark_session_resuming(&self.write_authority, &session_id)
            .map_err(store_error)?;
        self.resume_reservations.insert(session_id.clone());
        self.resume_ready.remove(&session_id);
        self.suspend_ask_to_session_for_resume(&session_id);
        let observation_token = (agent_id == "claude")
            .then(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));
        let mcp_role = self.resumed_mcp_role(&session, &transport);
        let (worker_prompt, worker_system_prompt, steward_system_prompt) = match &mcp_role {
            Some(super::AgentMcpRole::Worker { worker_id, .. }) => self
                .store
                .worker_configurations()
                .iter()
                .find(|configuration| configuration.id == *worker_id)
                .map(|configuration| {
                    (
                        Some(configuration.worker_prompt.clone()),
                        Some(configuration.system_prompt.clone()),
                        None,
                    )
                })
                .unwrap_or((None, None, None)),
            Some(super::AgentMcpRole::Steward { project_id }) => self
                .store
                .steward_configurations()
                .iter()
                .find(|configuration| configuration.project_id == *project_id)
                .map(|configuration| (None, None, Some(configuration.system_prompt.clone())))
                .unwrap_or((None, None, None)),
            _ => (None, None, None),
        };
        let mcp_token = mcp_role
            .is_some()
            .then(termloop_platform::generate_capability_token);
        // A successful replacement PTY always uses a fresh generation. Keep
        // that generation on the observation capability so delayed signals
        // from an older Codex bridge cannot satisfy this resume reservation.
        let mut runtime_epoch = self.runtime_epoch;
        while runtime_epoch == session.runtime_epoch {
            runtime_epoch = termloop_platform::generate_runtime_epoch();
        }
        self.transition_generated_input_runtime_epoch(&session_id, runtime_epoch);
        self.agent_observations.insert(
            session_id.clone(),
            crate::AgentObservationCapability {
                token: observation_token.clone(),
                runtime_epoch,
                observation: restart_observation,
                last_signal: None,
                pending_generated_input: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
            },
        );
        let retired_codex_runtime = restart_running
            .then(|| self.codex_runtimes.remove(&session_id))
            .flatten();
        let managed_worktree_trust = self.session_has_current_managed_worktree_proof(&session);
        // Most daemon-restart resumes use the new daemon epoch. A Retry may,
        // however, follow a failed client-launch restart in the same daemon,
        // where the durable descriptor still carries this daemon's original
        // epoch. Every successfully prepared replacement PTY must have a
        // distinct generation, regardless of which path requested it.
        Ok(crate::AgentResumePlanOutcome::Prepare(Box::new(
            crate::AgentResumePlan {
                session_id,
                project_id: session.project_id,
                cwd: session.process.cwd,
                cwd_identity,
                agent_id,
                launch_selection: session.launch_selection,
                resume_ref,
                launch_guard: session.resume_launch_guard,
                managed_worktree_trust,
                observation_token,
                mcp_token,
                mcp_role,
                worker_prompt,
                worker_system_prompt,
                steward_system_prompt,
                mcp_authorizer: self.mcp_authorizer.clone(),
                observation_transport: transport,
                runtime_signal_sender: Some(self.agent_runtime_sender.clone()),
                codex_runtime: None,
                preparation_kind: if restart_running {
                    AgentResumePreparationKind::Restart {
                        retired_codex_runtime,
                    }
                } else {
                    AgentResumePreparationKind::Resume
                },
                prepared_launch: None,
                pending_generated_input: None,
                terminal: self.terminal.clone(),
                runtime_epoch,
                pty_spawned: false,
                committed: false,
                shutdown: self.resume_shutdown.clone(),
                cancellation: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                relocation: None,
            },
        )))
    }

    pub fn capture_daemon_restart_handoff(&self) -> Vec<crate::AgentDaemonRestartHandoff> {
        const MAX_HANDOFFS: usize = 256;
        let mut handoffs = self
            .store
            .sessions()
            .iter()
            .filter_map(|session| {
                let agent_id = session.process.agent_id.as_deref()?;
                let observation = self.agent_observations.get(&session.id)?.observation?;
                (session.kind == SessionKind::Agent
                    && session.lifecycle_state == "running"
                    && self
                        .observation_transport
                        .as_ref()
                        .is_some_and(|transport| transport.resume_supported(agent_id))
                    && session.resume_ref.as_ref().is_some_and(ResumeRef::validate)
                    && self
                        .terminal
                        .session_is_running(&session.id, session.runtime_epoch)
                        .ok()
                        == Some(true)
                    && observation.state == termloop_agents::AgentState::Working)
                    .then(|| crate::AgentDaemonRestartHandoff {
                        session_id: session.id.clone(),
                        agent_id: agent_id.to_owned(),
                        runtime_epoch: session.runtime_epoch,
                    })
            })
            .collect::<Vec<_>>();
        handoffs.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        handoffs.truncate(MAX_HANDOFFS);
        handoffs
    }

    pub fn install_daemon_restart_handoff(
        &mut self,
        handoffs: Vec<crate::AgentDaemonRestartHandoff>,
    ) {
        const MAX_HANDOFFS: usize = 256;
        self.daemon_restart_handoffs.clear();
        for handoff in handoffs.into_iter().take(MAX_HANDOFFS) {
            let valid = self.store.sessions().iter().any(|session| {
                session.id == handoff.session_id
                    && session.kind == SessionKind::Agent
                    && session.lifecycle_state == "resuming"
                    && session.runtime_epoch == handoff.runtime_epoch
                    && session.process.agent_id.as_deref() == Some(handoff.agent_id.as_str())
                    && termloop_agents::has_global_resume_identity(&handoff.agent_id)
                    && session.resume_ref.as_ref().is_some_and(ResumeRef::validate)
            });
            if valid {
                self.daemon_restart_handoffs
                    .insert(handoff.session_id.clone(), handoff);
            }
        }
    }

    pub fn client_launch_restart_snapshot(&self) -> Result<Vec<AgentResumeCandidate>, CoreError> {
        let mut by_project =
            std::collections::BTreeMap::<String, std::collections::VecDeque<String>>::new();
        for session in self.store.sessions().iter().filter(|session| {
            session.kind == SessionKind::Agent
                && session.lifecycle_state == "running"
                && session.resume_ref.as_ref().is_some_and(ResumeRef::validate)
                && matches!(
                    self.store.agent_conversation_readiness(&session.id),
                    Some(
                        AgentConversationReadiness::LegacyUnknown
                            | AgentConversationReadiness::Resumable
                    )
                )
        }) {
            if self
                .terminal
                .contains_session(&session.id)
                .map_err(terminal_error)?
            {
                by_project
                    .entry(session.project_id.clone())
                    .or_default()
                    .push_back(session.id.clone());
            }
        }
        let mut result = Vec::new();
        loop {
            let mut admitted = false;
            for (project_id, sessions) in &mut by_project {
                if let Some(session_id) = sessions.pop_front() {
                    let session = self
                        .store
                        .sessions()
                        .iter()
                        .find(|session| session.id == session_id)
                        .expect("restart snapshot session remains present");
                    result.push(AgentResumeCandidate {
                        session_id,
                        project_id: project_id.clone(),
                        lane: self.resume_lane_for_session(session),
                    });
                    admitted = true;
                }
            }
            if !admitted {
                return Ok(result);
            }
        }
    }

    pub fn complete_agent_resume(
        &mut self,
        plan: &mut crate::AgentResumePlan,
    ) -> Result<Value, CoreError> {
        if !self.resume_reservations.contains(&plan.session_id) {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        if !self.project_exists(&plan.project_id) {
            return self.reject_prepared_resume(plan, ResumeFailureReason::LaunchReserved);
        }
        if self
            .ensure_launch_not_reserved(Path::new(&plan.cwd))
            .is_err()
        {
            return self.reject_prepared_resume(plan, ResumeFailureReason::LaunchReserved);
        }
        if let Some(guard) = plan.launch_guard.as_ref()
            && !self.managed_worktree_guard_is_current(&plan.project_id, &plan.cwd, guard)
        {
            return self.reject_prepared_resume(plan, ResumeFailureReason::CwdUnavailable);
        }
        if !self.resume_ready.contains(&plan.session_id) {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        let commit_result = if let Some(relocation) = plan.relocation.as_ref() {
            self.store
                .commit_session_relocation(
                    &self.write_authority,
                    &plan.session_id,
                    &relocation.operation_id,
                    plan.runtime_epoch,
                    &plan.resume_ref,
                )
                .map(|_| ())
        } else {
            self.store
                .complete_session_resume(
                    &self.write_authority,
                    &plan.session_id,
                    &plan.resume_ref,
                    plan.runtime_epoch,
                )
                .map(|_| ())
        };
        if let Err(error) = commit_result {
            self.agent_observations.remove(&plan.session_id);
            self.resume_reservations.remove(&plan.session_id);
            self.resume_ready.remove(&plan.session_id);
            self.pending_agent_resume_refs.remove(&plan.session_id);
            return Err(store_error(error));
        }
        self.resume_reservations.remove(&plan.session_id);
        self.resume_ready.remove(&plan.session_id);
        self.pending_agent_resume_refs.remove(&plan.session_id);
        if let (Some(token), Some(role)) = (plan.mcp_token.as_ref(), plan.mcp_role.as_ref()) {
            self.mcp_authorizer.register(
                plan.session_id.clone(),
                plan.runtime_epoch,
                role.clone(),
                token.clone(),
            );
        }
        self.refresh_ask_to_runtime_epoch(&plan.session_id, plan.runtime_epoch);
        if let Some(capability) = self.agent_observations.get_mut(&plan.session_id) {
            capability.pending_generated_input = plan.pending_generated_input.take();
        }
        // Readiness was proven before this commit. If terminal delivery races a
        // transient provider state, retain the sequence for the next structured
        // observation instead of weakening the successful resume transaction.
        let _ = self.deliver_pending_agent_generated_input(&plan.session_id);
        plan.committed = true;
        if let Some(runtime) = plan.codex_runtime.take() {
            self.codex_runtimes.insert(plan.session_id.clone(), runtime);
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == plan.session_id)
            .ok_or(CoreError::NotFound)?;
        Ok(self.project_session(session))
    }

    fn reject_prepared_resume(
        &mut self,
        plan: &crate::AgentResumePlan,
        reason: ResumeFailureReason,
    ) -> Result<Value, CoreError> {
        self.resume_reservations.remove(&plan.session_id);
        self.resume_ready.remove(&plan.session_id);
        self.agent_observations.remove(&plan.session_id);
        self.pending_agent_resume_refs.remove(&plan.session_id);
        if let Some(relocation) = plan.relocation.as_ref() {
            self.store
                .fail_session_relocation(
                    &self.write_authority,
                    &plan.session_id,
                    &relocation.operation_id,
                    reason,
                )
                .map_err(store_error)?;
        } else {
            self.store
                .mark_session_resume_failed(&self.write_authority, &plan.session_id, reason)
                .map_err(store_error)?;
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == plan.session_id)
            .ok_or(CoreError::NotFound)?;
        Ok(self.project_session(session))
    }

    pub fn agent_resume_readiness(&self, session_id: &str) -> Option<bool> {
        self.resume_reservations
            .contains(session_id)
            .then(|| self.resume_ready.contains(session_id))
    }

    /// Marks the exact resume whose prepared runtime is about to be reaped for
    /// a known failure. Process teardown must stay outside Core's lock, so the
    /// terminal exit reconciler uses this runtime-only marker to leave the
    /// reservation and durable lifecycle untouched until `fail_agent_resume`
    /// commits the caller's typed reason.
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

    pub fn cancel_agent_resume_for_shutdown(
        &mut self,
        session_id: &str,
    ) -> Result<Value, CoreError> {
        self.resume_failure_reaps.remove(session_id);
        self.resume_reservations.remove(session_id);
        self.resume_ready.remove(session_id);
        self.agent_observations.remove(session_id);
        self.pending_agent_resume_refs.remove(session_id);
        if let Some(operation) = self
            .store
            .session_relocation_operations()
            .iter()
            .find(|operation| operation.session_id == session_id)
            .cloned()
        {
            self.store
                .fail_session_relocation(
                    &self.write_authority,
                    session_id,
                    &operation.operation_id,
                    ResumeFailureReason::DaemonInterrupted,
                )
                .map_err(store_error)?;
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        Ok(self.project_session(session))
    }

    pub fn fail_agent_resume(
        &mut self,
        session_id: &str,
        reason: ResumeFailureReason,
    ) -> Result<Value, CoreError> {
        self.resume_failure_reaps.remove(session_id);
        self.resume_reservations.remove(session_id);
        self.resume_ready.remove(session_id);
        self.agent_observations.remove(session_id);
        self.pending_agent_resume_refs.remove(session_id);
        if let Some(operation) = self
            .store
            .session_relocation_operations()
            .iter()
            .find(|operation| operation.session_id == session_id)
            .cloned()
        {
            let failed = self
                .store
                .fail_session_relocation(
                    &self.write_authority,
                    session_id,
                    &operation.operation_id,
                    reason,
                )
                .map_err(store_error)?;
            return Ok(self.project_session(&failed));
        }
        if self.store.sessions().iter().any(|session| {
            session.id == session_id
                && matches!(session.lifecycle_state.as_str(), "exited" | "resumeFailed")
        }) {
            self.spawn_agent_terminal_hold(session_id)?;
            let session = self
                .store
                .sessions()
                .iter()
                .find(|session| session.id == session_id)
                .ok_or(CoreError::NotFound)?;
            return Ok(self.project_session(session));
        }
        self.store
            .mark_session_resume_failed(&self.write_authority, session_id, reason)
            .map_err(store_error)?;
        self.spawn_agent_terminal_hold(session_id)?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        Ok(self.project_session(session))
    }

    pub fn startup_resume_session_ids(&mut self) -> Result<Vec<AgentResumeCandidate>, CoreError> {
        const ADMISSION_CAP_PER_LANE: usize = 68;
        let mut by_lane = std::array::from_fn::<
            std::collections::BTreeMap<String, std::collections::VecDeque<AgentResumeCandidate>>,
            3,
            _,
        >(|_| std::collections::BTreeMap::new());
        for session in self.store.sessions().iter().filter(|session| {
            session.kind == SessionKind::Agent
                && (session.lifecycle_state == "resuming"
                    || session.lifecycle_state == "resumeFailed"
                        && self.session_is_persistent_assistant_executor(&session.id))
        }) {
            let lane = self.resume_lane_for_session(session);
            let lane_index = match lane {
                super::AgentResumeLane::Ordinary => 0,
                super::AgentResumeLane::Steward => 1,
                super::AgentResumeLane::Worker => 2,
            };
            by_lane[lane_index]
                .entry(session.project_id.clone())
                .or_default()
                .push_back(AgentResumeCandidate {
                    session_id: session.id.clone(),
                    project_id: session.project_id.clone(),
                    lane,
                });
        }
        let mut result = Vec::with_capacity(ADMISSION_CAP_PER_LANE * by_lane.len());
        for projects in &mut by_lane {
            let lane_start = result.len();
            while result.len() - lane_start < ADMISSION_CAP_PER_LANE {
                let mut admitted_this_round = false;
                for sessions in projects.values_mut() {
                    if let Some(candidate) = sessions.pop_front() {
                        result.push(candidate);
                        admitted_this_round = true;
                    }
                    if result.len() - lane_start == ADMISSION_CAP_PER_LANE {
                        break;
                    }
                }
                if !admitted_this_round {
                    break;
                }
            }
        }
        self.store
            .mark_startup_resume_overflow(
                &self.write_authority,
                &result
                    .iter()
                    .map(|candidate| candidate.session_id.clone())
                    .collect::<Vec<_>>(),
            )
            .map_err(store_error)?;
        Ok(result)
    }

    pub fn mark_startup_runtime_ownership_uncertain(
        &mut self,
        session_ids: &[String],
        all_agent_sessions: bool,
    ) -> Result<(), CoreError> {
        let failures = self
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.kind == SessionKind::Agent
                    && matches!(session.lifecycle_state.as_str(), "running" | "resuming")
                    && (all_agent_sessions
                        || session_ids
                            .iter()
                            .any(|session_id| session_id == &session.id))
            })
            .map(|session| {
                (
                    session.id.clone(),
                    ResumeFailureReason::RuntimeOwnershipUncertain,
                )
            })
            .collect::<Vec<_>>();
        self.store
            .mark_sessions_resume_failed(&self.write_authority, &failures)
            .map_err(store_error)?;
        Ok(())
    }
    pub fn mark_agent_resume_ownership_uncertain(
        &mut self,
        session_id: &str,
    ) -> Result<Value, CoreError> {
        self.resume_reservations.remove(session_id);
        self.resume_ready.remove(session_id);
        self.agent_observations.remove(session_id);
        self.pending_agent_resume_refs.remove(session_id);
        self.store
            .mark_session_resume_failed(
                &self.write_authority,
                session_id,
                ResumeFailureReason::RuntimeOwnershipUncertain,
            )
            .map_err(store_error)?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        Ok(self.project_session(session))
    }

    pub fn current_agent_resume(&self, session_id: &str) -> Result<Value, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id && session.kind == SessionKind::Agent)
            .ok_or(CoreError::NotFound)?;
        Ok(self.project_session(session))
    }
}
