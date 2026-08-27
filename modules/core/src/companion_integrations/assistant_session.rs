//! Persistent lightweight Steward/Worker Session composition.
//!
//! These assistants use the ordinary provider executable and PTY path. Core
//! binds the exact current configuration to one Session and is the only caller
//! allowed to deliver a provenance-bearing automated wake.

use std::path::Path;

use serde_json::{Value, json, to_value};
use termloop_domain::{
    ProcessDescriptor, ResumeProvider, ResumeRef, SessionKind, SessionRecord, StewardAgentId,
    TrackerKind,
};
use termloop_terminal::PtySpawnSpec;

use crate::{CoreError, CoreRuntime, store_error};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersistentAssistantIdentity {
    Steward {
        project_id: String,
        generation: u64,
    },
    Worker {
        project_id: String,
        worker_id: String,
        generation: u64,
    },
}

#[derive(Debug, Clone)]
pub struct PersistentAssistantTarget {
    pub identity: PersistentAssistantIdentity,
    pub agent_id: String,
    pub model: String,
    pub permission: String,
    pub reasoning: String,
    pub cwd: String,
    pub system_prompt: Option<String>,
    pub worker_prompt: Option<String>,
}

pub struct PersistentAssistantLaunchPlan {
    target: PersistentAssistantTarget,
    session_id: String,
    resume_ref: Option<ResumeRef>,
    observation_token: Option<String>,
    mcp_token: String,
    mcp_role: crate::session_launch::AgentMcpRole,
    mcp_authorizer: crate::McpAuthorizer,
    runtime_epoch: u64,
    observation_transport: crate::AgentObservationTransport,
    runtime_signal_sender: Option<std::sync::mpsc::Sender<crate::AgentRuntimeSignal>>,
    codex_runtime: Option<crate::CodexRuntime>,
    launch: termloop_invocation::LaunchPayload,
}

impl std::fmt::Debug for PersistentAssistantLaunchPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PersistentAssistantLaunchPlan")
            .field("identity", &self.target.identity)
            .field("agent_id", &self.target.agent_id)
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl PersistentAssistantLaunchPlan {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn prepare_runtime(&mut self) -> Result<(), CoreError> {
        if self.target.agent_id != "codex"
            || !self
                .observation_transport
                .daemon_owned_bridge_supported("codex")
        {
            return Ok(());
        }
        let runtime_signal_sender = self
            .runtime_signal_sender
            .take()
            .ok_or_else(|| CoreError::Terminal("Codex runtime signal path unavailable".into()))?;
        self.mcp_authorizer.register_provisional(
            self.session_id.clone(),
            self.runtime_epoch,
            self.mcp_role.clone(),
            self.mcp_token.clone(),
        );
        let runtime = crate::session_launch::start_codex_runtime(
            &self.session_id,
            self.runtime_epoch,
            &self.target.cwd,
            false,
            &self.observation_transport.provider_process_directory,
            Some(termloop_invocation::AgentMcpLaunch {
                endpoint: &self.observation_transport.mcp_endpoint,
                token: &self.mcp_token,
                claude_config_path: &self.observation_transport.claude_mcp_config_path,
                profile: self.mcp_role.invocation_profile(),
            }),
            runtime_signal_sender,
        )
        .map_err(|error| {
            self.mcp_authorizer
                .remove_provisional(&self.session_id, self.runtime_epoch);
            CoreError::Terminal(error.to_string())
        })?;
        if let Err(error) = self
            .launch
            .bind_codex_app_server_endpoint(runtime.endpoint())
        {
            self.mcp_authorizer
                .remove_provisional(&self.session_id, self.runtime_epoch);
            return Err(CoreError::Terminal(error.to_string()));
        }
        self.codex_runtime = Some(runtime);
        Ok(())
    }

    pub fn discard(mut self) {
        self.mcp_authorizer
            .remove_provisional(&self.session_id, self.runtime_epoch);
        self.codex_runtime.take();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StewardWakeKind {
    UserMessage,
    PipelineMoved,
    PipelineMovedAndRoutineFinding,
    RoutineFinding,
    ConfigurationChanged,
    StartupRefresh,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PendingAssistantWakeDelivery {
    Steward {
        project_id: String,
        generation: u64,
        wake_id: u64,
        session_id: String,
        runtime_epoch: u64,
        confirmation_queued: bool,
    },
    Worker {
        worker_id: String,
        worker_generation: u64,
        session_id: String,
        runtime_epoch: u64,
    },
}

impl PendingAssistantWakeDelivery {
    pub(crate) fn session_id(&self) -> &str {
        match self {
            Self::Steward { session_id, .. } | Self::Worker { session_id, .. } => session_id,
        }
    }

    pub(crate) fn runtime_epoch(&self) -> u64 {
        match self {
            Self::Steward { runtime_epoch, .. } | Self::Worker { runtime_epoch, .. } => {
                *runtime_epoch
            }
        }
    }

    fn is_same_steward_wake(
        &self,
        project_id: &str,
        generation: u64,
        wake_id: u64,
        session_id: &str,
        runtime_epoch: u64,
    ) -> bool {
        matches!(
            self,
            Self::Steward {
                project_id: pending_project_id,
                generation: pending_generation,
                wake_id: pending_wake_id,
                session_id: pending_session_id,
                runtime_epoch: pending_runtime_epoch,
                ..
            } if pending_project_id == project_id
                && *pending_generation == generation
                && *pending_wake_id == wake_id
                && pending_session_id == session_id
                && *pending_runtime_epoch == runtime_epoch
        )
    }

    fn is_same_worker_wake(
        &self,
        worker_id: &str,
        worker_generation: u64,
        session_id: &str,
        runtime_epoch: u64,
    ) -> bool {
        matches!(
            self,
            Self::Worker {
                worker_id: pending_worker_id,
                worker_generation: pending_worker_generation,
                session_id: pending_session_id,
                runtime_epoch: pending_runtime_epoch,
            } if pending_worker_id == worker_id
                && *pending_worker_generation == worker_generation
                && pending_session_id == session_id
                && *pending_runtime_epoch == runtime_epoch
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmedStewardWake {
    pub project_id: String,
    pub generation: u64,
    pub wake_id: u64,
}

pub fn compose_steward_wake(
    kind: StewardWakeKind,
) -> Result<termloop_invocation::AssistantWakeMessage, CoreError> {
    let reason = match kind {
        StewardWakeKind::UserMessage => {
            termloop_invocation::AssistantWakeReason::StewardUserMessage
        }
        StewardWakeKind::PipelineMoved => {
            termloop_invocation::AssistantWakeReason::StewardPipelineMoved
        }
        StewardWakeKind::PipelineMovedAndRoutineFinding => {
            termloop_invocation::AssistantWakeReason::StewardPipelineMovedAndRoutineFinding
        }
        StewardWakeKind::RoutineFinding => {
            termloop_invocation::AssistantWakeReason::StewardRoutineFinding
        }
        StewardWakeKind::ConfigurationChanged => {
            termloop_invocation::AssistantWakeReason::StewardConfigurationChanged
        }
        StewardWakeKind::StartupRefresh => {
            termloop_invocation::AssistantWakeReason::StewardStartupRefresh
        }
    };
    termloop_invocation::assistant_wake_message(
        termloop_invocation::ExecutorRole::Steward,
        reason,
        None,
        None,
    )
    .map_err(|error| CoreError::Terminal(error.to_string()))
}

pub fn compose_tracker_wake(
    kind: TrackerKind,
    check_id: &str,
    prompt: &str,
) -> Result<termloop_invocation::AssistantWakeMessage, CoreError> {
    termloop_invocation::assistant_wake_message(
        tracker_role(kind),
        termloop_invocation::AssistantWakeReason::ScheduledCheck,
        Some(check_id),
        Some(prompt),
    )
    .map_err(|error| CoreError::Terminal(error.to_string()))
}

pub fn compose_worker_routine_wake() -> Result<termloop_invocation::AssistantWakeMessage, CoreError>
{
    termloop_invocation::assistant_wake_message(
        termloop_invocation::ExecutorRole::Worker,
        termloop_invocation::AssistantWakeReason::ScheduledCheck,
        None,
        None,
    )
    .map_err(|error| CoreError::Terminal(error.to_string()))
}

pub struct AdmittedPersistentAssistantLaunch {
    session_id: String,
    terminal: termloop_terminal::TerminalService,
    spawn: PtySpawnSpec,
    result: Value,
    mcp_authorizer: crate::McpAuthorizer,
}

impl AdmittedPersistentAssistantLaunch {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn execute(self) -> Result<Value, CoreError> {
        if let Err(error) = self.terminal.spawn(self.spawn) {
            self.mcp_authorizer.remove(&self.session_id);
            return Err(crate::terminal_error(error));
        }
        Ok(self.result)
    }
}

impl CoreRuntime {
    /// True only while invocation-owned initial input is waiting for the
    /// synchronous provider SessionStart hook response to leave the daemon.
    /// This applies uniformly to ordinary Agents, Improvers, helpers, Stewards,
    /// and Workers; feature identity never selects terminal sequencing policy.
    pub fn pending_generated_input_after_hook_response(&self, session_id: &str) -> bool {
        self.agent_observations
            .get(session_id)
            .is_some_and(|capability| {
                capability.defer_generated_input_until_hook_response
                    && capability.pending_generated_input.is_some()
            })
    }

    /// Releases one exact initial submission after its synchronous provider
    /// hook response has been written. Later generated submissions never enter
    /// this path and continue through the ordinary idle coordinator.
    pub fn deliver_pending_generated_input_after_hook_response(
        &mut self,
        session_id: &str,
    ) -> Result<bool, CoreError> {
        if !self.pending_generated_input_after_hook_response(session_id) {
            return Ok(false);
        }
        self.agent_observations
            .get_mut(session_id)
            .expect("validated deferred generated input remains present")
            .defer_generated_input_until_hook_response = false;
        self.deliver_pending_agent_generated_input(session_id)?;
        Ok(true)
    }

    pub fn prepare_persistent_assistant_launch(
        &self,
        target: PersistentAssistantTarget,
        session_id: String,
    ) -> Result<PersistentAssistantLaunchPlan, CoreError> {
        if uuid::Uuid::parse_str(&session_id).is_err() || !Path::new(&target.cwd).is_absolute() {
            return Err(CoreError::InvalidParams("assistantLaunch".into()));
        }
        let transport = self
            .observation_transport
            .as_ref()
            .ok_or(CoreError::AgentUnsupported)?;
        if !transport.mcp_http_supported(&target.agent_id) {
            return Err(CoreError::AgentUnsupported);
        }
        let role = match &target.identity {
            PersistentAssistantIdentity::Steward { .. } => {
                termloop_invocation::ExecutorRole::Steward
            }
            PersistentAssistantIdentity::Worker { .. } => termloop_invocation::ExecutorRole::Worker,
        };
        let mcp_role = match &target.identity {
            PersistentAssistantIdentity::Steward { project_id, .. } => {
                crate::session_launch::AgentMcpRole::Steward {
                    project_id: project_id.clone(),
                }
            }
            PersistentAssistantIdentity::Worker {
                project_id,
                worker_id,
                ..
            } => crate::session_launch::AgentMcpRole::Worker {
                project_id: project_id.clone(),
                worker_id: worker_id.clone(),
            },
        };
        let mcp_token = termloop_platform::generate_capability_token();
        let observation_token = transport
            .launch_scoped_observation_supported(&target.agent_id)
            .then(termloop_platform::generate_capability_token);
        let resume_ref = match target.agent_id.as_str() {
            "claude" => ResumeRef::for_provider(
                ResumeProvider::Claude,
                termloop_platform::generate_uuid_v4(),
            ),
            "codex" => None,
            _ => return Err(CoreError::AgentUnsupported),
        };
        let conversation = match resume_ref.as_ref() {
            Some(resume_ref) => termloop_invocation::AgentConversationLaunch::Fresh {
                resume_ref: Some(resume_ref),
            },
            None => termloop_invocation::AgentConversationLaunch::Fresh { resume_ref: None },
        };
        let codex_observation = (target.agent_id == "codex"
            && transport.daemon_owned_bridge_supported("codex"))
        .then_some(termloop_invocation::CODEX_APP_SERVER_RUNTIME_PLACEHOLDER);
        let observation = transport.invocation_observation(
            &target.agent_id,
            &session_id,
            observation_token.as_deref(),
            codex_observation,
        );
        let launch = termloop_invocation::persistent_assistant_agent(
            termloop_invocation::PersistentAssistantLaunch {
                agent_id: &target.agent_id,
                model: &target.model,
                permission: &target.permission,
                reasoning: &target.reasoning,
                role,
                system_prompt: target.system_prompt.as_deref(),
                worker_prompt: target.worker_prompt.as_deref(),
                cwd: &target.cwd,
                conversation,
                observation,
                mcp: termloop_invocation::AgentMcpLaunch {
                    endpoint: &transport.mcp_endpoint,
                    token: &mcp_token,
                    claude_config_path: &transport.claude_mcp_config_path,
                    profile: match role {
                        termloop_invocation::ExecutorRole::Steward => {
                            termloop_invocation::AgentMcpProfile::Steward
                        }
                        termloop_invocation::ExecutorRole::Worker => {
                            termloop_invocation::AgentMcpProfile::Worker
                        }
                        _ => unreachable!("persistent assistant role was validated"),
                    },
                },
            },
        )
        .map_err(|error| CoreError::Terminal(error.to_string()))?;
        Ok(PersistentAssistantLaunchPlan {
            target,
            session_id,
            resume_ref,
            observation_token,
            mcp_token,
            mcp_role,
            mcp_authorizer: self.mcp_authorizer.clone(),
            runtime_epoch: self.runtime_epoch,
            observation_transport: transport.clone(),
            runtime_signal_sender: Some(self.agent_runtime_sender.clone()),
            codex_runtime: None,
            launch,
        })
    }

    pub fn request_persistent_steward_launch(
        &self,
        project_id: &str,
    ) -> Option<PersistentAssistantTarget> {
        let configuration = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)?;
        if !configuration.enabled || configuration.executor_session_id.is_some() {
            return None;
        }
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)?;
        Some(PersistentAssistantTarget {
            identity: PersistentAssistantIdentity::Steward {
                project_id: project_id.to_owned(),
                generation: configuration.generation,
            },
            agent_id: agent_name(configuration.agent_id).into(),
            model: configuration.model.clone(),
            permission: configuration.permission.clone(),
            reasoning: configuration.reasoning.clone(),
            cwd: project.folder_path.clone(),
            system_prompt: Some(configuration.system_prompt.clone()),
            worker_prompt: None,
        })
    }

    pub fn request_persistent_worker_launch(
        &self,
        worker_id: &str,
    ) -> Option<PersistentAssistantTarget> {
        let configuration = self
            .store
            .worker_configurations()
            .iter()
            .find(|configuration| configuration.id == worker_id)?;
        if !configuration.enabled || configuration.executor_session_id.is_some() {
            return None;
        }
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == configuration.project_id)?;
        Some(PersistentAssistantTarget {
            identity: PersistentAssistantIdentity::Worker {
                project_id: configuration.project_id.clone(),
                worker_id: worker_id.to_owned(),
                generation: configuration.generation,
            },
            agent_id: agent_name(configuration.agent_id).into(),
            model: configuration.model.clone(),
            permission: configuration.permission.clone(),
            reasoning: configuration.reasoning.clone(),
            cwd: project.folder_path.clone(),
            system_prompt: Some(configuration.system_prompt.clone()),
            worker_prompt: Some(configuration.worker_prompt.clone()),
        })
    }

    pub fn admit_persistent_assistant_launch(
        &mut self,
        plan: PersistentAssistantLaunchPlan,
        updated_at_epoch_ms: u64,
    ) -> Result<AdmittedPersistentAssistantLaunch, CoreError> {
        let PersistentAssistantLaunchPlan {
            target,
            session_id,
            resume_ref,
            observation_token,
            mcp_token,
            mcp_role,
            mcp_authorizer,
            runtime_epoch,
            observation_transport: _,
            runtime_signal_sender: _,
            codex_runtime,
            launch,
        } = plan;
        let initial_input_submission = launch.initial_input_submission();
        let generated_input_observable = observation_token.is_some() || codex_runtime.is_some();
        if initial_input_submission.is_some() && !generated_input_observable {
            mcp_authorizer.remove_provisional(&session_id, runtime_epoch);
            return Err(CoreError::AgentCapabilityUnproven);
        }
        let pending_generated_input = initial_input_submission;
        let template = launch.provenance().clone();
        let session_name = match &target.identity {
            PersistentAssistantIdentity::Steward { .. } => "Project Steward".to_owned(),
            PersistentAssistantIdentity::Worker { worker_id, .. } => match self
                .store
                .worker_configurations()
                .iter()
                .find(|configuration| configuration.id == *worker_id)
                .map(|configuration| configuration.name.clone())
            {
                Some(name) => name,
                None => {
                    mcp_authorizer.remove_provisional(&session_id, runtime_epoch);
                    return Err(CoreError::NotFound);
                }
            },
        };
        let session = SessionRecord {
            launch_selection: termloop_domain::AgentLaunchSelection::new(
                &target.model,
                &target.permission,
                &target.reasoning,
            ),
            id: session_id.clone(),
            project_id: project_id(&target.identity).to_owned(),
            name: Some(session_name),
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: target.agent_id.clone(),
                args: vec![],
                cwd: target.cwd.clone(),
                agent_id: Some(target.agent_id.clone()),
                template_ref: Some(template.template_ref),
                template_version: Some(template.template_version),
            },
            lifecycle_state: "running".into(),
            runtime_epoch: self.runtime_epoch,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: None,
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: resume_ref.clone(),
            resume_launch_guard: None,
            resume_failure: None,
        };
        let configuration = match match &target.identity {
            PersistentAssistantIdentity::Steward {
                project_id,
                generation,
            } => self
                .store
                .attach_steward_executor_session(
                    &self.write_authority,
                    session,
                    project_id,
                    *generation,
                    updated_at_epoch_ms,
                )
                .map(to_value),
            PersistentAssistantIdentity::Worker {
                worker_id,
                generation,
                ..
            } => self
                .store
                .attach_worker_executor_session(
                    &self.write_authority,
                    session,
                    worker_id,
                    *generation,
                    updated_at_epoch_ms,
                )
                .map(to_value),
        } {
            Ok(Ok(configuration)) => configuration,
            Ok(Err(error)) => {
                mcp_authorizer.remove_provisional(&session_id, runtime_epoch);
                return Err(CoreError::Store(error.to_string()));
            }
            Err(error) => {
                mcp_authorizer.remove_provisional(&session_id, runtime_epoch);
                return Err(store_error(error));
            }
        };
        let spawn = PtySpawnSpec {
            session_id: session_id.clone(),
            runtime_epoch: self.runtime_epoch,
            program: launch.program().to_owned(),
            args: launch.args().to_vec(),
            cwd: target.cwd,
            environment: launch.environment().clone(),
            recent_output_replay: true,
        };
        if generated_input_observable {
            self.agent_observations.insert(
                session_id.clone(),
                crate::AgentObservationCapability {
                    token: observation_token,
                    runtime_epoch: self.runtime_epoch,
                    observation: None,
                    last_signal: None,
                    pending_generated_input,
                    defer_generated_input_until_hook_response: false,
                    last_notification_type: None,
                },
            );
        }
        self.mcp_authorizer
            .register(session_id.clone(), self.runtime_epoch, mcp_role, mcp_token);
        if let Some(runtime) = codex_runtime {
            self.codex_runtimes.insert(session_id.clone(), runtime);
        }
        Ok(AdmittedPersistentAssistantLaunch {
            session_id,
            terminal: self.terminal.clone(),
            spawn,
            result: json!({
                "configuration": configuration,
                "stateRevision": self.store.revision(),
            }),
            mcp_authorizer: self.mcp_authorizer.clone(),
        })
    }

    pub fn deliver_steward_wake(
        &mut self,
        project_id: &str,
        generation: u64,
        wake_id: u64,
        message: &termloop_invocation::AssistantWakeMessage,
    ) -> Result<String, CoreError> {
        let configuration = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .ok_or(CoreError::NotFound)?;
        if !configuration.enabled || configuration.generation != generation {
            return Err(CoreError::RevisionConflict);
        }
        let session_id = configuration
            .executor_session_id
            .clone()
            .ok_or(CoreError::NotFound)?;
        let runtime_epoch = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| session.runtime_epoch)
            .ok_or(CoreError::NotFound)?;
        self.prune_stale_pending_assistant_wake_deliveries();
        if let Some(pending) = self.pending_assistant_wake_deliveries.get(&session_id) {
            return pending
                .is_same_steward_wake(project_id, generation, wake_id, &session_id, runtime_epoch)
                .then_some(session_id)
                .ok_or(CoreError::ConversationBusy);
        }
        self.deliver_assistant_wake(&session_id, message)?;
        self.prune_stale_pending_assistant_wake_deliveries();
        self.pending_assistant_wake_deliveries.insert(
            session_id.clone(),
            PendingAssistantWakeDelivery::Steward {
                project_id: project_id.to_owned(),
                generation,
                wake_id,
                session_id: session_id.clone(),
                runtime_epoch,
                confirmation_queued: false,
            },
        );
        Ok(session_id)
    }

    pub fn deliver_worker_routine_wake(
        &mut self,
        wake: &super::tracker_runtime::DueWorkerWake,
        message: &termloop_invocation::AssistantWakeMessage,
    ) -> Result<String, CoreError> {
        if !self.worker_wake_is_current(wake) {
            return Err(CoreError::TrackerReportStale);
        }
        let worker = self
            .store
            .worker_configurations()
            .iter()
            .find(|worker| worker.id == wake.worker_id)
            .ok_or(CoreError::NotFound)?;
        if worker.generation != wake.worker_generation
            || worker.executor_session_id.as_deref() != Some(wake.worker_session_id.as_str())
        {
            return Err(CoreError::TrackerReportStale);
        }
        let session_id = worker
            .executor_session_id
            .clone()
            .ok_or(CoreError::NotFound)?;
        let runtime_epoch = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| session.runtime_epoch)
            .ok_or(CoreError::NotFound)?;
        self.prune_stale_pending_assistant_wake_deliveries();
        if let Some(pending) = self.pending_assistant_wake_deliveries.get(&session_id) {
            return pending
                .is_same_worker_wake(
                    &wake.worker_id,
                    wake.worker_generation,
                    &session_id,
                    runtime_epoch,
                )
                .then_some(session_id)
                .ok_or(CoreError::ConversationBusy);
        }
        self.deliver_assistant_wake(&session_id, message)?;
        self.prune_stale_pending_assistant_wake_deliveries();
        self.pending_assistant_wake_deliveries.insert(
            session_id.clone(),
            PendingAssistantWakeDelivery::Worker {
                worker_id: wake.worker_id.clone(),
                worker_generation: wake.worker_generation,
                session_id: session_id.clone(),
                runtime_epoch,
            },
        );
        Ok(session_id)
    }

    fn deliver_assistant_wake(
        &mut self,
        session_id: &str,
        message: &termloop_invocation::AssistantWakeMessage,
    ) -> Result<(), CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if !self.agent_session_runtime_is_current(session) {
            return Err(CoreError::RevisionConflict);
        }
        self.submit_generated_terminal_input(session_id, message.terminal_submission())
    }
}

fn project_id(identity: &PersistentAssistantIdentity) -> &str {
    match identity {
        PersistentAssistantIdentity::Steward { project_id, .. }
        | PersistentAssistantIdentity::Worker { project_id, .. } => project_id,
    }
}

fn agent_name(agent_id: StewardAgentId) -> &'static str {
    match agent_id {
        StewardAgentId::Claude => "claude",
        StewardAgentId::Codex => "codex",
    }
}

pub fn tracker_role(kind: TrackerKind) -> termloop_invocation::ExecutorRole {
    match kind {
        TrackerKind::Slack => termloop_invocation::ExecutorRole::SlackTracker,
        TrackerKind::Jira => termloop_invocation::ExecutorRole::JiraTracker,
        TrackerKind::Runtime => termloop_invocation::ExecutorRole::RuntimeTracker,
        TrackerKind::Delivery => termloop_invocation::ExecutorRole::DeliveryTracker,
        TrackerKind::CiPr => termloop_invocation::ExecutorRole::CiPrTracker,
        TrackerKind::Custom => termloop_invocation::ExecutorRole::CustomTracker,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_wake_identity_coalesces_only_the_exact_delivery() {
        let steward = PendingAssistantWakeDelivery::Steward {
            project_id: "project".into(),
            generation: 3,
            wake_id: 13,
            session_id: "steward".into(),
            runtime_epoch: 7,
            confirmation_queued: false,
        };
        assert!(steward.is_same_steward_wake("project", 3, 13, "steward", 7));
        assert!(!steward.is_same_steward_wake("project", 3, 14, "steward", 7));

        let worker = PendingAssistantWakeDelivery::Worker {
            worker_id: "worker".into(),
            worker_generation: 5,
            session_id: "worker-session".into(),
            runtime_epoch: 9,
        };
        assert!(worker.is_same_worker_wake("worker", 5, "worker-session", 9));
        assert!(!worker.is_same_worker_wake("worker", 5, "worker-session", 10));
    }
    #[test]
    fn worker_assignment_wake_contains_exact_visible_tracker_instructions_and_enter() {
        let prompt = "Use the Slack connector to inspect #product and report to the Steward.";
        let wake = compose_tracker_wake(
            TrackerKind::Slack,
            "0123456789abcdef0123456789abcdef",
            prompt,
        )
        .unwrap();
        assert!(
            wake.delivered_preview()
                .contains("Exact configured Task instructions")
        );
        assert!(wake.delivered_preview().contains(prompt));
        assert_eq!(wake.terminal_submission().submit_input(), b"\r");
    }
}
