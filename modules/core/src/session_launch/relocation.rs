use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use termloop_domain::{
    ResumeRef, SessionKind, SessionRecord, SessionRelocationOperation, SessionRelocationStage,
    SessionRelocationTarget, TaskRecord, TaskStatus,
};
use uuid::Uuid;

use super::resume::AgentResumePreparationKind;
use super::{AgentMcpRole, AgentResumePlan, AgentResumePlanOutcome, TaskWorktreeLaunchPlan};
use crate::{CoreError, CoreRuntime, required_string, store_error};

const RELOCATION_PREVIEW_TTL: Duration = Duration::from_secs(30);
const RELOCATION_PREVIEW_CAP: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionRelocationMode {
    Resume,
    Fresh,
}

impl SessionRelocationMode {
    fn parse(params: &Value) -> Result<Self, CoreError> {
        match required_string(params, "mode")?.as_str() {
            "resume" => Ok(Self::Resume),
            "fresh" => Ok(Self::Fresh),
            _ => Err(CoreError::InvalidParams("mode".into())),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Resume => "resume",
            Self::Fresh => "fresh",
        }
    }
}

pub enum SessionRelocationPreviewOutcome {
    Current(Value),
    Observe(Box<SessionRelocationPreviewPlan>),
}

#[derive(Clone)]
pub struct SessionRelocationPreviewPlan {
    session: SessionRecord,
    task: TaskRecord,
    task_launch: TaskWorktreeLaunchPlan,
    mode: SessionRelocationMode,
}

pub struct ObservedSessionRelocationPreview {
    plan: SessionRelocationPreviewPlan,
    task_launch: Result<super::ObservedTaskWorktreeLaunch, CoreError>,
}

pub(crate) struct SessionRelocationPreviewTicket {
    session: SessionRecord,
    task: TaskRecord,
    task_launch: Option<TaskWorktreeLaunchPlan>,
    target: SessionRelocationTarget,
    target_cwd: String,
    launch: termloop_invocation::LaunchPayload,
    resume_ref: ResumeRef,
    mode: SessionRelocationMode,
    observation_token: Option<String>,
    mcp_token: Option<String>,
    mcp_role: AgentMcpRole,
    deadline: termloop_platform::MonotonicDeadline,
}

impl SessionRelocationPreviewTicket {
    pub(crate) fn project_id(&self) -> &str {
        &self.session.project_id
    }
}

#[derive(Debug, Clone)]
pub(super) struct AgentRelocationContext {
    pub operation_id: String,
    pub source_cwd: String,
}

impl SessionRelocationPreviewPlan {
    pub fn project_id(&self) -> &str {
        &self.session.project_id
    }

    pub fn task_id(&self) -> &str {
        &self.task.id
    }

    pub fn observe(self, timeout: Duration) -> ObservedSessionRelocationPreview {
        let task_launch = self.task_launch.clone().observe(timeout);
        ObservedSessionRelocationPreview {
            plan: self,
            task_launch,
        }
    }
}

impl CoreRuntime {
    pub fn plan_session_relocation_preview(
        &mut self,
        params: Value,
    ) -> Result<SessionRelocationPreviewOutcome, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        let task_id = required_string(&params, "taskId")?;
        let mode = SessionRelocationMode::parse(&params)?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let blockers = self.session_relocation_blockers(&session, &task, mode);
        if !blockers.is_empty() {
            return Ok(SessionRelocationPreviewOutcome::Current(
                self.session_relocation_preview_value(&session, &task, mode, blockers, None, None)?,
            ));
        }
        let task_launch = self.plan_task_worktree_launch(json!({ "taskId": task.id }), false)?;
        Ok(SessionRelocationPreviewOutcome::Observe(Box::new(
            SessionRelocationPreviewPlan {
                session,
                task,
                task_launch,
                mode,
            },
        )))
    }

    pub fn complete_session_relocation_preview(
        &mut self,
        observed: ObservedSessionRelocationPreview,
    ) -> Result<Value, CoreError> {
        let current_session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == observed.plan.session.id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let current_task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == observed.plan.task.id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let mut blockers =
            self.session_relocation_blockers(&current_session, &current_task, observed.plan.mode);
        if current_session != observed.plan.session || current_task != observed.plan.task {
            push_blocker(&mut blockers, "lifecycleInProgress");
        }
        if observed.task_launch.is_err() {
            push_blocker(&mut blockers, "worktreeUnhealthy");
        }
        if !blockers.is_empty() {
            return self.session_relocation_preview_value(
                &current_session,
                &current_task,
                observed.plan.mode,
                blockers,
                None,
                None,
            );
        }
        let _ = observed
            .task_launch
            .expect("successful worktree observation was checked");

        let agent_id = current_session
            .process
            .agent_id
            .as_deref()
            .ok_or(CoreError::AgentUnsupported)?;
        let source_resume_ref = current_session
            .resume_ref
            .as_ref()
            .ok_or(CoreError::AgentUnsupported)?;
        let resume_ref = match observed.plan.mode {
            SessionRelocationMode::Resume => source_resume_ref.clone(),
            SessionRelocationMode::Fresh => ResumeRef::for_provider(
                termloop_domain::ResumeProvider::Claude,
                Uuid::new_v4().to_string(),
            )
            .ok_or(CoreError::AgentUnsupported)?,
        };
        let transport = self
            .observation_transport
            .as_ref()
            .ok_or(CoreError::AgentUnsupported)?;
        let observation_token = transport
            .launch_scoped_observation_supported(agent_id)
            .then(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));
        let mcp_token = transport
            .mcp_http_supported(agent_id)
            .then(termloop_platform::generate_capability_token);
        let observation = relocation_observation(
            agent_id,
            &current_session.id,
            observation_token.as_deref(),
            transport,
        );
        let mcp = mcp_token
            .as_ref()
            .map(|token| termloop_invocation::AgentMcpLaunch {
                endpoint: &transport.mcp_endpoint,
                token,
                claude_config_path: &transport.claude_mcp_config_path,
                profile: termloop_invocation::AgentMcpProfile::Interactive,
            });
        let target_cwd = current_task
            .worktree
            .as_ref()
            .map(|worktree| worktree.path.as_str())
            .ok_or_else(|| CoreError::TaskWorktreeRequired {
                task_id: current_task.id.clone(),
            })?;
        let conversation = match observed.plan.mode {
            SessionRelocationMode::Resume => termloop_invocation::AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            SessionRelocationMode::Fresh => termloop_invocation::AgentConversationLaunch::Fresh {
                resume_ref: Some(&resume_ref),
            },
        };
        let launch = termloop_invocation::configured_interactive_agent_for_worktree_relocation(
            agent_id,
            &current_session.process.cwd,
            target_cwd,
            &current_task.id,
            &current_task.title,
            &current_session.launch_selection.model,
            &current_session.launch_selection.permission,
            &current_session.launch_selection.reasoning,
            conversation,
            observation,
            mcp,
        )
        .map_err(super::invocation_error)?;
        let manifest = launch.inspectable_manifest().clone();
        self.session_relocation_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        if self.session_relocation_previews.len() >= RELOCATION_PREVIEW_CAP {
            self.session_relocation_previews.pop_front();
        }
        let mut relocation_ticket = termloop_platform::generate_opaque_runtime_token();
        while self
            .session_relocation_previews
            .iter()
            .any(|(ticket, _)| ticket == &relocation_ticket)
        {
            relocation_ticket = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = termloop_platform::MonotonicDeadline::after(RELOCATION_PREVIEW_TTL)
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.session_relocation_previews.push_back((
            relocation_ticket.clone(),
            SessionRelocationPreviewTicket {
                session: current_session.clone(),
                task: current_task.clone(),
                task_launch: Some(observed.plan.task_launch),
                target: SessionRelocationTarget::TaskWorktree,
                target_cwd: target_cwd.to_owned(),
                launch,
                resume_ref,
                mode: observed.plan.mode,
                observation_token,
                mcp_token,
                mcp_role: AgentMcpRole::Interactive,
                deadline,
            },
        ));
        self.session_relocation_preview_value(
            &current_session,
            &current_task,
            observed.plan.mode,
            Vec::new(),
            Some(relocation_ticket),
            Some(manifest),
        )
    }

    pub fn preview_session_relocation_to_project(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        let project_id = required_string(&params, "projectId")?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let source_task = self.source_task_for_project_relocation(&session).cloned();
        let mut blockers =
            self.project_relocation_blockers(&session, &project.id, source_task.as_ref());
        if termloop_platform::existing_directory_comparison_input(Path::new(&project.folder_path))
            .is_err()
        {
            push_blocker(&mut blockers, "projectRootUnavailable");
        }
        let Some(task) = source_task else {
            return self.project_relocation_preview_value(
                &session,
                None,
                &project.folder_path,
                blockers,
                None,
                None,
            );
        };
        if !blockers.is_empty() {
            return self.project_relocation_preview_value(
                &session,
                Some(&task),
                &project.folder_path,
                blockers,
                None,
                None,
            );
        }

        let agent_id = session
            .process
            .agent_id
            .as_deref()
            .ok_or(CoreError::AgentUnsupported)?;
        let resume_ref = session
            .resume_ref
            .as_ref()
            .cloned()
            .ok_or(CoreError::AgentUnsupported)?;
        let transport = self
            .observation_transport
            .as_ref()
            .ok_or(CoreError::AgentUnsupported)?;
        let mcp_role = super::resume_role::derive_resumed_mcp_role(
            &session,
            self.store.sessions(),
            self.store.steward_configurations(),
            self.store.worker_configurations(),
            transport,
        )
        .unwrap_or(AgentMcpRole::Interactive);
        let observation_token = transport
            .launch_scoped_observation_supported(agent_id)
            .then(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));
        let mcp_token = transport
            .mcp_http_supported(agent_id)
            .then(termloop_platform::generate_capability_token);
        let observation = relocation_observation(
            agent_id,
            &session.id,
            observation_token.as_deref(),
            transport,
        );
        let mcp = mcp_token
            .as_ref()
            .map(|token| termloop_invocation::AgentMcpLaunch {
                endpoint: &transport.mcp_endpoint,
                token,
                claude_config_path: &transport.claude_mcp_config_path,
                profile: mcp_role.invocation_profile(),
            });
        let launch = if let AgentMcpRole::Helper { request_id } = &mcp_role {
            termloop_invocation::configured_ask_to_helper_for_conversation_resume(
                agent_id,
                &project.folder_path,
                &session.launch_selection.model,
                &session.launch_selection.permission,
                &session.launch_selection.reasoning,
                request_id.as_deref(),
                termloop_invocation::AgentConversationLaunch::Resume {
                    resume_ref: &resume_ref,
                },
                observation,
                mcp,
            )
        } else {
            termloop_invocation::configured_interactive_agent_for_project_relocation(
                agent_id,
                &session.process.cwd,
                &project.folder_path,
                &task.id,
                &task.title,
                &session.launch_selection.model,
                &session.launch_selection.permission,
                &session.launch_selection.reasoning,
                termloop_invocation::AgentConversationLaunch::Resume {
                    resume_ref: &resume_ref,
                },
                observation,
                mcp,
            )
        }
        .map_err(super::invocation_error)?;
        let manifest = launch.inspectable_manifest().clone();
        self.session_relocation_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        if self.session_relocation_previews.len() >= RELOCATION_PREVIEW_CAP {
            self.session_relocation_previews.pop_front();
        }
        let mut relocation_ticket = termloop_platform::generate_opaque_runtime_token();
        while self
            .session_relocation_previews
            .iter()
            .any(|(ticket, _)| ticket == &relocation_ticket)
        {
            relocation_ticket = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = termloop_platform::MonotonicDeadline::after(RELOCATION_PREVIEW_TTL)
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.session_relocation_previews.push_back((
            relocation_ticket.clone(),
            SessionRelocationPreviewTicket {
                session: session.clone(),
                task: task.clone(),
                task_launch: None,
                target: SessionRelocationTarget::ProjectRoot,
                target_cwd: project.folder_path.clone(),
                launch,
                resume_ref,
                mode: SessionRelocationMode::Resume,
                observation_token,
                mcp_token,
                mcp_role,
                deadline,
            },
        ));
        self.project_relocation_preview_value(
            &session,
            Some(&task),
            &project.folder_path,
            Vec::new(),
            Some(relocation_ticket),
            Some(manifest),
        )
    }

    pub fn plan_ticketed_agent_relocation(
        &mut self,
        params: Value,
    ) -> Result<AgentResumePlanOutcome, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        let requested_target = if let Some(task_id) = params.get("taskId").and_then(Value::as_str) {
            (SessionRelocationTarget::TaskWorktree, task_id.to_owned())
        } else {
            (
                SessionRelocationTarget::ProjectRoot,
                required_string(&params, "projectId")?,
            )
        };
        let operation_id = required_string(&params, "operationId")?;
        if let Some(current) = self
            .store
            .session_relocation_receipts()
            .iter()
            .find(|receipt| receipt.operation_id == operation_id)
        {
            let target_matches = match requested_target.0 {
                SessionRelocationTarget::TaskWorktree => {
                    current.target == requested_target.0
                        && current.target_task_id == requested_target.1
                }
                SessionRelocationTarget::ProjectRoot => {
                    current.target == requested_target.0 && current.project_id == requested_target.1
                }
            };
            if current.session_id == session_id && target_matches {
                let session = self
                    .store
                    .sessions()
                    .iter()
                    .find(|session| session.id == session_id)
                    .ok_or(CoreError::NotFound)?;
                return Ok(AgentResumePlanOutcome::Current(
                    self.project_session(session),
                ));
            }
            return Err(CoreError::OperationIdReused { operation_id });
        }
        if let Some(current) = self
            .store
            .session_relocation_operations()
            .iter()
            .find(|operation| operation.operation_id == operation_id)
        {
            let target_matches = match requested_target.0 {
                SessionRelocationTarget::TaskWorktree => {
                    current.target == requested_target.0
                        && current.target_task_id == requested_target.1
                }
                SessionRelocationTarget::ProjectRoot => {
                    current.target == requested_target.0 && current.project_id == requested_target.1
                }
            };
            if current.session_id == session_id && target_matches {
                let session = self
                    .store
                    .sessions()
                    .iter()
                    .find(|session| session.id == session_id)
                    .ok_or(CoreError::NotFound)?;
                return Ok(AgentResumePlanOutcome::Current(
                    self.project_session(session),
                ));
            }
            return Err(CoreError::OperationIdReused { operation_id });
        }

        self.session_relocation_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        let relocation_ticket = required_string(&params, "relocationTicket")?;
        let position = self
            .session_relocation_previews
            .iter()
            .position(|(ticket, _)| ticket == &relocation_ticket)
            .ok_or_else(|| CoreError::InvalidParams("relocationTicket".into()))?;
        let (_, preview) = self
            .session_relocation_previews
            .remove(position)
            .expect("ticket position came from the same bounded queue");
        let preview_target_matches = preview.target == requested_target.0
            && match preview.target {
                SessionRelocationTarget::TaskWorktree => preview.task.id == requested_target.1,
                SessionRelocationTarget::ProjectRoot => {
                    preview.session.project_id == requested_target.1
                }
            };
        if preview.session.id != session_id || !preview_target_matches {
            return Err(CoreError::InvalidParams("relocationTicket".into()));
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == preview.task.id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let blockers = match preview.target {
            SessionRelocationTarget::TaskWorktree => {
                self.session_relocation_blockers(&session, &task, preview.mode)
            }
            SessionRelocationTarget::ProjectRoot => {
                self.project_relocation_blockers(&session, &requested_target.1, Some(&task))
            }
        };
        if session != preview.session || task != preview.task || !blockers.is_empty() {
            return Err(CoreError::InvalidParams("relocationTicket".into()));
        }
        if let Some(task_launch) = preview.task_launch.as_ref() {
            self.revalidate_task_launch(task_launch)?;
        }
        let task_id = task.id.clone();
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .cloned()
            .ok_or_else(|| CoreError::TaskWorktreeUnavailable {
                task_id: task_id.clone(),
                reason: crate::TaskWorktreeUnavailableReason::ManagedProofMissing,
            })?;
        let target_cwd = preview.target_cwd.clone();
        let cwd_identity =
            termloop_platform::existing_directory_comparison_input(Path::new(&target_cwd))
                .map_err(|_| CoreError::InvalidParams("relocationTicket".into()))?;
        let resume_ref = preview.resume_ref.clone();
        let source_was_running = session.lifecycle_state == "running";
        let agent_id = session
            .process
            .agent_id
            .clone()
            .ok_or(CoreError::AgentUnsupported)?;
        let transport = self
            .observation_transport
            .clone()
            .ok_or(CoreError::AgentUnsupported)?;
        let now = termloop_platform::current_epoch_ms();
        let operation = SessionRelocationOperation {
            operation_id: operation_id.clone(),
            session_id: session_id.clone(),
            project_id: session.project_id.clone(),
            source_runtime_epoch: session.runtime_epoch,
            source_cwd: session.process.cwd.clone(),
            target: preview.target,
            target_task_id: task_id.clone(),
            target_cwd: target_cwd.clone(),
            target_worktree_generation: task.worktree_generation,
            target_managed_worktree_operation_id: proof.operation_id.clone(),
            stage: SessionRelocationStage::SourceRetiring,
            started_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        self.store
            .begin_session_relocation(&self.write_authority, operation)
            .map_err(store_error)?;
        self.resume_reservations.insert(session_id.clone());
        if preview.mode == SessionRelocationMode::Fresh {
            self.pending_agent_resume_refs
                .insert(session_id.clone(), resume_ref.clone());
        }
        self.resume_ready.remove(&session_id);
        self.suspend_ask_to_session_for_resume(&session_id);
        if preview.mode == SessionRelocationMode::Fresh {
            self.agent_conversation_activity.remove(&session_id);
        }
        let mut runtime_epoch = self.runtime_epoch;
        while runtime_epoch == session.runtime_epoch {
            runtime_epoch = termloop_platform::generate_runtime_epoch();
        }
        self.transition_generated_input_runtime_epoch(&session_id, runtime_epoch);
        self.agent_observations.insert(
            session_id.clone(),
            crate::AgentObservationCapability {
                token: preview.observation_token.clone(),
                runtime_epoch,
                observation: None,
                last_signal: None,
                pending_generated_input: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
            },
        );
        let retired_codex_runtime = source_was_running
            .then(|| self.codex_runtimes.remove(&session_id))
            .flatten();
        Ok(AgentResumePlanOutcome::Prepare(Box::new(AgentResumePlan {
            session_id,
            project_id: session.project_id,
            cwd: target_cwd.clone(),
            cwd_identity,
            agent_id,
            launch_selection: session.launch_selection,
            resume_ref,
            launch_guard: (preview.target == SessionRelocationTarget::TaskWorktree).then(|| {
                termloop_domain::ResumeLaunchGuard {
                    task_id: task_id.clone(),
                    managed_worktree_operation_id: proof.operation_id.clone(),
                    worktree_generation: proof.worktree_generation,
                    path: target_cwd,
                }
            }),
            managed_worktree_trust: preview.target == SessionRelocationTarget::TaskWorktree,
            observation_token: preview.observation_token,
            mcp_token: preview.mcp_token,
            mcp_role: Some(preview.mcp_role),
            worker_prompt: None,
            worker_system_prompt: None,
            agent_profile_ref: None,
            steward_system_prompt: None,
            mcp_authorizer: self.mcp_authorizer.clone(),
            observation_transport: transport,
            runtime_signal_sender: Some(self.agent_runtime_sender.clone()),
            codex_runtime: None,
            preparation_kind: if source_was_running {
                AgentResumePreparationKind::Restart {
                    retired_codex_runtime,
                }
            } else {
                AgentResumePreparationKind::Resume
            },
            prepared_launch: Some(preview.launch),
            pending_generated_input: None,
            terminal: self.terminal.clone(),
            runtime_epoch,
            pty_spawned: false,
            committed: false,
            shutdown: self.resume_shutdown.clone(),
            cancellation: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            relocation: Some(AgentRelocationContext {
                operation_id,
                source_cwd: session.process.cwd,
            }),
        })))
    }

    pub fn mark_agent_relocation_target_starting(
        &mut self,
        plan: &AgentResumePlan,
    ) -> Result<(), CoreError> {
        let Some(relocation) = plan.relocation.as_ref() else {
            return Ok(());
        };
        self.store
            .mark_session_relocation_target_starting(
                &self.write_authority,
                &plan.session_id,
                &relocation.operation_id,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        Ok(())
    }

    fn session_relocation_blockers(
        &self,
        session: &SessionRecord,
        task: &TaskRecord,
        mode: SessionRelocationMode,
    ) -> Vec<&'static str> {
        let mut blockers = Vec::new();
        let ordinary_template = matches!(
            session.process.template_ref.as_deref(),
            Some("builtin.agent.interactive" | "builtin.quick-action.free-prompt")
        );
        if session.kind != SessionKind::Agent
            || !ordinary_template
            || session.ask_to_source_session_id.is_some()
        {
            push_blocker(&mut blockers, "sourceNotOrdinaryAgent");
        }
        let terminal_live = self
            .terminal
            .contains_session(&session.id)
            .is_ok_and(|live| live);
        let running_source = session.lifecycle_state == "running" && terminal_live;
        let retryable_source = session.lifecycle_state == "resumeFailed"
            && session
                .resume_failure
                .is_some_and(super::lifecycle::resume_failure_retryable)
            && !terminal_live;
        if !running_source && !retryable_source {
            push_blocker(&mut blockers, "sourceNotRunning");
        }
        if session
            .resume_ref
            .as_ref()
            .is_none_or(|resume_ref| !resume_ref.validate())
        {
            push_blocker(&mut blockers, "resumeRefMissing");
        }
        let agent_id = session.process.agent_id.as_deref();
        if mode == SessionRelocationMode::Fresh && agent_id != Some("claude") {
            push_blocker(&mut blockers, "freshHandoffUnsupported");
        }
        if agent_id.is_none_or(|agent_id| {
            !termloop_agents::is_supported_agent(agent_id)
                || self
                    .observation_transport
                    .as_ref()
                    .is_none_or(|transport| !transport.resume_supported(agent_id))
        }) {
            push_blocker(&mut blockers, "resumeCapabilityUnavailable");
        }
        let ask_to_current = self.source_has_in_flight_ask_to(&session.id)
            || self.store.sessions().iter().any(|candidate| {
                candidate.ask_to_source_session_id.as_deref() == Some(&session.id)
                    && candidate
                        .ask_to_continuation
                        .as_ref()
                        .is_some_and(|continuation| continuation.current_request_id.is_some())
            });
        if ask_to_current {
            push_blocker(&mut blockers, "askToInProgress");
        }
        if task.project_id != session.project_id {
            push_blocker(&mut blockers, "sameProjectRequired");
        }
        if task.archived_at_epoch_ms.is_some() {
            push_blocker(&mut blockers, "taskArchived");
        }
        if task.status != TaskStatus::Open {
            push_blocker(&mut blockers, "taskNotOpen");
        }
        let Some(worktree) = task.worktree.as_ref() else {
            push_blocker(&mut blockers, "worktreeRequired");
            return blockers;
        };
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task.id);
        match proof {
            None => push_blocker(&mut blockers, "managedProofMissing"),
            Some(proof)
                if proof.worktree_generation != task.worktree_generation
                    || proof.registered_worktree_path != worktree.path =>
            {
                push_blocker(&mut blockers, "managedProofMismatch")
            }
            Some(_) => {}
        }
        if let (Ok(source), Ok(target)) = (
            crate::task_worktree::comparison_key(Path::new(&session.process.cwd)),
            crate::task_worktree::comparison_key(Path::new(&worktree.path)),
        ) && target.contains_or_equals(&source)
        {
            push_blocker(&mut blockers, "alreadyInTargetWorktree");
        } else if self.store.tasks().iter().any(|candidate| {
            candidate.project_id == session.project_id
                && candidate
                    .worktree
                    .as_ref()
                    .is_some_and(|candidate_worktree| {
                        crate::task_worktree::comparison_key(Path::new(&candidate_worktree.path))
                            .ok()
                            .zip(
                                crate::task_worktree::comparison_key(Path::new(
                                    &session.process.cwd,
                                ))
                                .ok(),
                            )
                            .is_some_and(|(root, cwd)| root.contains_or_equals(&cwd))
                    })
        }) {
            push_blocker(&mut blockers, "sourceAlreadyTaskAttached");
        }
        if self.resume_reservations.contains(&session.id)
            || self
                .provider_history_repair_reservations
                .contains(&session.id)
            || self
                .store
                .session_archive_operations()
                .iter()
                .any(|operation| operation.session_id == session.id)
            || self
                .store
                .session_relocation_operations()
                .iter()
                .any(|operation| operation.session_id == session.id)
            || self
                .store
                .task_archive_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .provisioning_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .provisioning_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .cleanup_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .repair_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .stale_resolution_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
        {
            push_blocker(&mut blockers, "lifecycleInProgress");
        }
        if self
            .ensure_launch_not_reserved(Path::new(&worktree.path))
            .is_err()
        {
            push_blocker(&mut blockers, "launchReserved");
        }
        blockers
    }

    fn source_task_for_project_relocation(&self, session: &SessionRecord) -> Option<&TaskRecord> {
        self.store.tasks().iter().find(|task| {
            if task.project_id != session.project_id || task.archived_at_epoch_ms.is_some() {
                return false;
            }
            let Some(worktree) = task.worktree.as_ref() else {
                return false;
            };
            session.process.cwd == worktree.path
                || session.resume_launch_guard.as_ref().is_some_and(|guard| {
                    guard.task_id == task.id
                        && guard.path == worktree.path
                        && guard.worktree_generation == task.worktree_generation
                })
        })
    }

    fn project_relocation_blockers(
        &self,
        session: &SessionRecord,
        project_id: &str,
        source_task: Option<&TaskRecord>,
    ) -> Vec<&'static str> {
        let mut blockers = Vec::new();
        let template = session.process.template_ref.as_deref();
        let persistent_assistant = self
            .observation_transport
            .as_ref()
            .and_then(|transport| {
                super::resume_role::derive_resumed_mcp_role(
                    session,
                    self.store.sessions(),
                    self.store.steward_configurations(),
                    self.store.worker_configurations(),
                    transport,
                )
            })
            .is_some_and(|role| {
                matches!(
                    role,
                    AgentMcpRole::Steward { .. } | AgentMcpRole::Worker { .. }
                )
            });
        if session.kind != SessionKind::Agent
            || persistent_assistant
            || matches!(
                template,
                Some("builtin.steward.executor" | "builtin.worker.executor")
            )
        {
            push_blocker(&mut blockers, "sourceNotOrdinaryAgent");
        }
        if template == Some("builtin.agent.ask-to-helper")
            && self.observation_transport.as_ref().is_none_or(|transport| {
                !matches!(
                    super::resume_role::derive_resumed_mcp_role(
                        session,
                        self.store.sessions(),
                        self.store.steward_configurations(),
                        self.store.worker_configurations(),
                        transport,
                    ),
                    Some(AgentMcpRole::Helper { .. })
                )
            })
        {
            push_blocker(&mut blockers, "resumeCapabilityUnavailable");
        }
        let terminal_live = self
            .terminal
            .contains_session(&session.id)
            .is_ok_and(|live| live);
        let running_source = session.lifecycle_state == "running" && terminal_live;
        let retryable_source = session.lifecycle_state == "resumeFailed"
            && session
                .resume_failure
                .is_some_and(super::lifecycle::resume_failure_retryable)
            && !terminal_live;
        if !running_source && !retryable_source {
            push_blocker(&mut blockers, "sourceNotRunning");
        }
        if session
            .resume_ref
            .as_ref()
            .is_none_or(|resume_ref| !resume_ref.validate())
        {
            push_blocker(&mut blockers, "resumeRefMissing");
        }
        let agent_id = session.process.agent_id.as_deref();
        if agent_id.is_none_or(|agent_id| {
            !termloop_agents::is_supported_agent(agent_id)
                || self
                    .observation_transport
                    .as_ref()
                    .is_none_or(|transport| !transport.resume_supported(agent_id))
        }) {
            push_blocker(&mut blockers, "resumeCapabilityUnavailable");
        }
        if self.source_has_in_flight_ask_to(&session.id)
            || self.store.sessions().iter().any(|candidate| {
                candidate.ask_to_source_session_id.as_deref() == Some(&session.id)
                    && candidate
                        .ask_to_continuation
                        .as_ref()
                        .is_some_and(|continuation| continuation.current_request_id.is_some())
            })
        {
            push_blocker(&mut blockers, "askToInProgress");
        }
        if session.project_id != project_id {
            push_blocker(&mut blockers, "sameProjectRequired");
        }
        let Some(task) = source_task else {
            push_blocker(&mut blockers, "sourceNotTaskAttached");
            return blockers;
        };
        let proof_matches = task.worktree.as_ref().is_some_and(|worktree| {
            self.store.managed_worktrees().iter().any(|proof| {
                proof.task_id == task.id
                    && proof.worktree_generation == task.worktree_generation
                    && proof.registered_worktree_path == worktree.path
                    && session.resume_launch_guard.as_ref().is_none_or(|guard| {
                        session.process.cwd == worktree.path
                            || guard.managed_worktree_operation_id == proof.operation_id
                    })
            })
        });
        if !proof_matches {
            push_blocker(&mut blockers, "managedProofMismatch");
        }
        if self.resume_reservations.contains(&session.id)
            || self
                .provider_history_repair_reservations
                .contains(&session.id)
            || self
                .store
                .session_archive_operations()
                .iter()
                .any(|operation| operation.session_id == session.id)
            || self
                .store
                .session_relocation_operations()
                .iter()
                .any(|operation| operation.session_id == session.id)
            || self
                .store
                .task_archive_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .cleanup_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .repair_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
            || self
                .store
                .stale_resolution_operations()
                .iter()
                .any(|operation| operation.task_id == task.id)
        {
            push_blocker(&mut blockers, "lifecycleInProgress");
        }
        if self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .is_none_or(|project| {
                project.folder_path == session.process.cwd
                    || self
                        .ensure_launch_not_reserved(Path::new(&project.folder_path))
                        .is_err()
            })
        {
            push_blocker(&mut blockers, "launchReserved");
        }
        blockers
    }

    fn project_relocation_preview_value(
        &mut self,
        session: &SessionRecord,
        task: Option<&TaskRecord>,
        target_cwd: &str,
        blockers: Vec<&'static str>,
        relocation_ticket: Option<String>,
        manifest: Option<termloop_invocation::InspectableLaunchManifest>,
    ) -> Result<Value, CoreError> {
        let mut warnings = vec!["taskLifecycleNoLongerApplies", "crossCwdPathsMayBeStale"];
        if self
            .agent_observations
            .get(&session.id)
            .and_then(|capability| capability.observation)
            .is_some_and(|observation| {
                matches!(
                    observation.state,
                    termloop_agents::AgentState::Working
                        | termloop_agents::AgentState::AwaitingInput
                )
            })
        {
            warnings.push("sourceTurnWillBeInterrupted");
        }
        let target_agent_count = self
            .store
            .sessions()
            .iter()
            .filter(|candidate| {
                candidate.id != session.id
                    && candidate.kind == SessionKind::Agent
                    && candidate.lifecycle_state == "running"
                    && candidate.process.cwd == target_cwd
            })
            .count() as u32;
        if target_agent_count > 0 {
            warnings.push("targetHasActiveSessions");
        }
        let can_relocate = blockers.is_empty() && relocation_ticket.is_some() && manifest.is_some();
        Ok(json!({
            "session": self.project_session(session),
            "task": task.map(|task| self.task_projection(task)).transpose()?,
            "source_cwd": session.process.cwd,
            "target_cwd": target_cwd,
            "agent_id": session.process.agent_id,
            "model": session.launch_selection.model,
            "permission": session.launch_selection.permission,
            "reasoning": session.launch_selection.reasoning,
            "mode": "resume",
            "target_agent_count": target_agent_count,
            "target_terminal_count": 0,
            "warnings": warnings,
            "blockers": blockers,
            "can_relocate": can_relocate,
            "relocation_ticket": relocation_ticket,
            "expires_in_ms": 30_000,
            "manifest": manifest,
        }))
    }

    fn session_relocation_preview_value(
        &mut self,
        session: &SessionRecord,
        task: &TaskRecord,
        mode: SessionRelocationMode,
        blockers: Vec<&'static str>,
        relocation_ticket: Option<String>,
        manifest: Option<termloop_invocation::InspectableLaunchManifest>,
    ) -> Result<Value, CoreError> {
        if task.worktree.is_some() {
            let _ = self
                .observe_task_worktree_presence(&task.id, termloop_platform::current_epoch_ms());
        }
        let presence = self.cached_task_worktree_presence(&task.id);
        let agent_count = presence.map_or(0, |presence| presence.agent_count);
        let terminal_count = presence.map_or(0, |presence| presence.terminal_count);
        let mut warnings = vec!["taskLifecycleApplies", "crossCwdPathsMayBeStale"];
        if self
            .agent_observations
            .get(&session.id)
            .and_then(|capability| capability.observation)
            .is_some_and(|observation| {
                matches!(
                    observation.state,
                    termloop_agents::AgentState::Working
                        | termloop_agents::AgentState::AwaitingInput
                )
            })
        {
            warnings.push("sourceTurnWillBeInterrupted");
        }
        if agent_count > 0 || terminal_count > 0 {
            warnings.push("targetHasActiveSessions");
        }
        if mode == SessionRelocationMode::Fresh {
            warnings.push("freshConversationWillStart");
        }
        let can_relocate = blockers.is_empty() && relocation_ticket.is_some() && manifest.is_some();
        Ok(json!({
            "session": self.project_session(session),
            "task": self.task_projection(task)?,
            "source_cwd": session.process.cwd,
            "target_cwd": task.worktree.as_ref().map(|worktree| worktree.path.as_str()),
            "agent_id": session.process.agent_id,
            "model": session.launch_selection.model,
            "permission": session.launch_selection.permission,
            "reasoning": session.launch_selection.reasoning,
            "mode": mode.as_str(),
            "target_agent_count": agent_count,
            "target_terminal_count": terminal_count,
            "warnings": warnings,
            "blockers": blockers,
            "can_relocate": can_relocate,
            "relocation_ticket": relocation_ticket,
            "expires_in_ms": 30_000,
            "manifest": manifest,
        }))
    }
}

fn relocation_observation<'a>(
    agent_id: &str,
    session_id: &'a str,
    observation_token: Option<&'a str>,
    transport: &'a crate::AgentObservationTransport,
) -> Option<termloop_invocation::AgentObservationLaunch<'a>> {
    transport.invocation_observation(
        agent_id,
        session_id,
        observation_token,
        Some(termloop_invocation::CODEX_APP_SERVER_RUNTIME_PLACEHOLDER),
    )
}

fn push_blocker(blockers: &mut Vec<&'static str>, blocker: &'static str) {
    if !blockers.contains(&blocker) {
        blockers.push(blocker);
    }
}
