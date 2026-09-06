//! Session/agent launch and resume ownership boundary.

mod agent_message;
pub mod archive;
pub(crate) mod ask_to;
mod deleted;
mod history_repair;
mod lifecycle;
mod relocation;
mod resume;
mod resume_role;
pub(crate) mod session_history;

pub use ask_to::{
    AskToInput, AskToLaunchCompletion, AskToPlanOutcome, McpAuthorizer, McpPrincipal,
};
pub use deleted::{
    DeletedSessionListPlan, DeletedSessionRestorePlan, ObservedDeletedSessionRestore,
};
pub use history_repair::{
    ObservedProviderHistoryRepair, ProviderHistoryRepairOutcome, ProviderHistoryRepairPlan,
};
pub use lifecycle::ReconciledSessionExits;
pub use relocation::{
    ObservedSessionRelocationPreview, SessionRelocationPreviewOutcome, SessionRelocationPreviewPlan,
};
pub use resume::{
    AgentResumeCandidate, AgentResumePlan, AgentResumePlanOutcome, AgentResumePreparationError,
    AgentResumeReapError, AgentResumeTargetValidation,
};
pub use session_history::{
    ObservedSessionHistoryResume, ObservedSessionHistoryScan, SessionHistoryListPlanOutcome,
    SessionHistoryResumePlan, SessionHistoryScanPlan,
};

use crate::{
    AgentObservationTransport, AgentRuntimeSignal, CoreError, CoreRuntime,
    TaskWorktreeUnavailableReason, required_string, store_error, terminal_error,
};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::mpsc::Sender;
use std::time::Duration;
use termloop_domain::{
    AgentLaunchSelection, ImproverSessionTarget, ImproverSessionTargetKind, IssueLinkProvider,
    ProcessDescriptor, ResumeProvider, ResumeRef, SessionKind, SessionRecord,
};
use termloop_gitio::{GitError, GitFailureKind, GitRunner, RegisteredPathState};
use termloop_terminal::PtySpawnSpec;
use uuid::Uuid;

const QUICK_ACTION_PREVIEW_TTL: Duration = Duration::from_secs(30);
const MAX_QUICK_ACTION_PREVIEWS: usize = 64;
const SESSION_NAME_MAX_CHARS: usize = 80;

pub struct CodexRuntime {
    process: termloop_platform::ManagedProcess,
    bridge: termloop_agents::CodexAppServerBridge,
    upstream_endpoint: String,
}

impl CodexRuntime {
    pub(crate) fn endpoint(&self) -> &str {
        self.bridge.endpoint()
    }

    fn warm_thread_history(
        &self,
        native_thread_id: &str,
    ) -> Result<(), termloop_agents::CodexThreadHistoryProbeError> {
        termloop_agents::probe_codex_thread_history(&self.upstream_endpoint, native_thread_id)
    }

    fn inspect_thread_history(
        &self,
        native_thread_id: &str,
    ) -> Result<
        termloop_agents::CodexThreadHistoryInspection,
        termloop_agents::CodexThreadHistoryProbeError,
    > {
        termloop_agents::inspect_codex_thread_history(&self.upstream_endpoint, native_thread_id)
    }

    pub fn reap(self) -> Result<(), AgentResumeReapError> {
        let Self {
            mut process,
            bridge,
            upstream_endpoint: _,
        } = self;
        let bridge_reaped = bridge.shutdown().is_ok();
        let process_reaped = process.terminate().is_ok();
        if bridge_reaped && process_reaped {
            Ok(())
        } else {
            Err(AgentResumeReapError)
        }
    }
}

pub struct AgentLaunchPlan {
    session_id: String,
    runtime_epoch: u64,
    project_id: String,
    cwd: String,
    cwd_identity: termloop_platform::PathComparisonInput,
    agent_id: String,
    observation_token: Option<String>,
    observation_transport: Option<AgentObservationTransport>,
    runtime_signal_sender: Option<Sender<AgentRuntimeSignal>>,
    codex_runtime: Option<CodexRuntime>,
    observation_warning: Option<String>,
    task_guard: Option<TaskLaunchGuard>,
    task_guard_requires_observation: bool,
    resume_ref: Option<termloop_domain::ResumeRef>,
    history_source_handle: Option<String>,
    history_source_ref: Option<termloop_domain::ResumeRef>,
    history_source: Option<termloop_agents::DiscoveredAgentConversation>,
    history_source_validated: bool,
    history_name: Option<String>,
    fork_source_session_id: Option<String>,
    fork_source_ref: Option<termloop_domain::ResumeRef>,
    fork_name: Option<String>,
    fork_worktree_plan: Option<TaskWorktreeLaunchPlan>,
    fork_worktree_observed: bool,
    interactive_options: Option<AgentLaunchSelection>,
    quick_action: Option<QuickActionLaunch>,
    /// Set only for an Improve-with-agent launch against an existing
    /// configuration. It binds the preview ticket to the exact configuration
    /// that was inspected.
    improver_configuration_id: Option<String>,
    /// Set only for an Improve-with-agent launch that would create a
    /// configuration. It binds the ticket to the exact kind instead.
    improver_new_kind: Option<String>,
    /// Set only for an Improve-with-agent launch against one editable
    /// assistant prompt. The pair binds the ticket to the exact prompt that
    /// was inspected, so an approved preview cannot be retargeted.
    improver_prompt_surface: Option<String>,
    improver_prompt_owner_id: Option<String>,
    /// Set only for an Improve-with-agent launch against one application
    /// settings entry. The pair binds the ticket to the exact entry that was
    /// inspected, so an approved preview cannot be retargeted at another.
    settings_entry_kind: Option<String>,
    settings_entry_id: Option<String>,
    /// The rail name for an Improve-with-agent launch, stating the job and its
    /// target rather than leaving another unnamed provider row.
    improver_session_name: Option<String>,
    prepared_launch: Option<termloop_invocation::LaunchPayload>,
    mcp_authorizer: McpAuthorizer,
    mcp_role: AgentMcpRole,
    mcp_token: Option<String>,
    helper_prompt: Option<(String, String)>,
    ask_to_source_session_id: Option<String>,
    ask_to_continuation: Option<termloop_domain::AskToContinuation>,
    steward_task_assignment: Option<StewardTaskAssignmentLaunch>,
    task_kickoff: Option<TaskKickoffLaunch>,
}

pub(crate) struct QuickActionPreviewTicket {
    plan: AgentLaunchPlan,
    deadline: termloop_platform::MonotonicDeadline,
}

impl QuickActionPreviewTicket {
    pub(crate) fn project_id(&self) -> &str {
        &self.plan.project_id
    }

    pub(crate) fn is_assistant_prompt_improver(&self) -> bool {
        self.plan.improver_prompt_surface.is_some()
    }
}

pub(crate) struct AgentLaunchPreviewTicket {
    plan: AgentLaunchPlan,
    deadline: termloop_platform::MonotonicDeadline,
}

impl AgentLaunchPreviewTicket {
    pub(crate) fn project_id(&self) -> &str {
        &self.plan.project_id
    }
}

pub(crate) struct AgentResumePreviewTicket {
    session_id: String,
    launch: termloop_invocation::LaunchPayload,
    observation_token: Option<String>,
    mcp_token: Option<String>,
    managed_worktree_trust: bool,
    deadline: termloop_platform::MonotonicDeadline,
}

impl AgentResumePreviewTicket {
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }
}

pub(crate) use relocation::SessionRelocationPreviewTicket;

#[derive(Clone)]
struct QuickActionLaunch {
    selection: AgentLaunchSelection,
    template_ref: String,
    prompt: String,
    attachments: Vec<termloop_invocation::QuickActionImageAttachment>,
}

#[derive(Clone)]
struct StewardTaskAssignmentLaunch {
    task_id: String,
    steward_session_id: String,
    title: String,
    brief: Option<String>,
    jira_url: Option<String>,
    assignment: String,
}

#[derive(Clone)]
struct TaskKickoffLaunch {
    task_id: String,
    title: String,
    brief: Option<String>,
    jira_url: Option<String>,
    kickoff_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentMcpRole {
    Interactive,
    /// One target-bound Improve Agent. It may use ordinary Agent coordination
    /// tools, but configuration writes can create and activate versions only
    /// for its authenticated target after the user confirms in conversation.
    Improver {
        target: ImproverSessionTarget,
    },
    Steward {
        project_id: String,
    },
    Worker {
        project_id: String,
        worker_id: String,
    },
    Helper {
        request_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentResumeLane {
    Ordinary,
    Steward,
    Worker,
}

impl AgentMcpRole {
    pub(super) fn invocation_profile(&self) -> termloop_invocation::AgentMcpProfile {
        match self {
            Self::Interactive => termloop_invocation::AgentMcpProfile::Interactive,
            Self::Improver { .. } => termloop_invocation::AgentMcpProfile::Improver,
            Self::Steward { .. } => termloop_invocation::AgentMcpProfile::Steward,
            Self::Worker { .. } => termloop_invocation::AgentMcpProfile::Worker,
            Self::Helper { .. } => termloop_invocation::AgentMcpProfile::Helper,
        }
    }

    fn resume_lane(&self) -> AgentResumeLane {
        match self {
            Self::Steward { .. } => AgentResumeLane::Steward,
            Self::Worker { .. } => AgentResumeLane::Worker,
            Self::Interactive | Self::Improver { .. } | Self::Helper { .. } => {
                AgentResumeLane::Ordinary
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TaskLaunchGuard {
    task_id: String,
    managed_worktree_operation_id: String,
    worktree_generation: u64,
    cwd: String,
    repository_common_dir: String,
    branch_ref: String,
}

#[derive(Debug, Clone)]
pub struct TaskWorktreeLaunchPlan {
    task_id: String,
    project_id: String,
    cwd: String,
    managed_worktree_operation_id: String,
    worktree_generation: u64,
    repository_common_dir: String,
    branch_ref: String,
    agent_id: Option<String>,
    interactive_options: Option<AgentLaunchSelection>,
}

#[derive(Debug, Clone)]
pub struct ObservedTaskWorktreeLaunch {
    pub(crate) plan: TaskWorktreeLaunchPlan,
}

impl AgentLaunchPlan {
    fn has_observed_managed_worktree(&self) -> bool {
        self.task_guard.is_some()
            && !self.task_guard_requires_observation
            && self.fork_worktree_observed
    }

    pub fn observe_task_worktree(&mut self, timeout: std::time::Duration) -> Result<(), CoreError> {
        if !self.task_guard_requires_observation {
            return Ok(());
        }
        let guard = self
            .task_guard
            .as_ref()
            .ok_or_else(|| CoreError::InvalidParams("taskGuard".into()))?;
        TaskWorktreeLaunchPlan {
            task_id: guard.task_id.clone(),
            project_id: self.project_id.clone(),
            cwd: guard.cwd.clone(),
            managed_worktree_operation_id: guard.managed_worktree_operation_id.clone(),
            worktree_generation: guard.worktree_generation,
            repository_common_dir: guard.repository_common_dir.clone(),
            branch_ref: guard.branch_ref.clone(),
            agent_id: Some(self.agent_id.clone()),
            interactive_options: self.interactive_options.clone(),
        }
        .observe(timeout)?;
        self.task_guard_requires_observation = false;
        self.fork_worktree_observed = true;
        Ok(())
    }

    pub fn prepare_runtime(&mut self) {
        if let Some(source) = self.history_source.as_ref() {
            let fresh = termloop_platform::read_bounded_history_file_slices(&source.source, 1, 1);
            self.history_source_validated = fresh.is_ok_and(|fresh| {
                fresh.modified_at_epoch_ms == source.source_modified_at_epoch_ms
                    && fresh.size_bytes == source.source_size_bytes
                    && fresh.window_sha256 == source.source_window_sha256
            });
            if !self.history_source_validated {
                self.prepared_launch = None;
                self.observation_warning =
                    Some("the discovered provider history changed before launch".into());
                return;
            }
        }
        if self.agent_id != "codex"
            || !self
                .observation_transport
                .as_ref()
                .is_some_and(|transport| transport.daemon_owned_bridge_supported("codex"))
        {
            return;
        }
        let Some(transport) = self.observation_transport.clone() else {
            return;
        };
        let Some(runtime_signal_sender) = self.runtime_signal_sender.take() else {
            return;
        };
        // Codex eagerly initializes configured MCP servers while its App
        // Server is still starting. Admit only transport-level traffic before
        // process creation; complete_agent_launch promotes this exact token to
        // command authority only after every launch revalidation passes.
        self.register_provisional_mcp();
        match start_codex_runtime(
            &self.session_id,
            self.runtime_epoch,
            &self.cwd,
            self.has_observed_managed_worktree(),
            &transport.provider_process_directory,
            self.mcp_token
                .as_ref()
                .map(|token| termloop_invocation::AgentMcpLaunch {
                    endpoint: &transport.mcp_endpoint,
                    token,
                    claude_config_path: &transport.claude_mcp_config_path,
                    profile: self.mcp_role.invocation_profile(),
                }),
            // The sender is installed by `CoreRuntime::plan_agent_launch`.
            runtime_signal_sender,
        ) {
            Ok(runtime) => {
                if let Some(source_ref) = self.history_source_ref.as_ref()
                    && runtime
                        .warm_thread_history(&source_ref.native_session_id)
                        .is_err()
                {
                    self.revoke_provisional_mcp();
                    let _ = runtime.reap();
                    self.prepared_launch = None;
                    self.observation_warning =
                        Some("the Codex conversation history could not be verified".into());
                    return;
                }
                let endpoint = runtime.bridge.endpoint();
                if let Some(launch) = self.prepared_launch.as_mut()
                    && launch.bind_codex_app_server_endpoint(endpoint).is_err()
                {
                    // Re-resolve from the typed plan below rather than ever
                    // spawning the preview placeholder as real argv.
                    self.prepared_launch = None;
                }
                self.codex_runtime = Some(runtime);
            }
            Err(error) => {
                self.revoke_provisional_mcp();
                // A Quick Action preview can carry only invocation's private
                // runtime placeholder. If observation preparation fails,
                // discard that payload and resolve a normal fresh launch
                // below; never pass the placeholder to Codex as an endpoint.
                self.prepared_launch = None;
                self.observation_warning = Some(error.to_string());
            }
        }
    }

    pub fn observation_warning(&self) -> Option<&str> {
        self.observation_warning.as_deref()
    }

    fn register_provisional_mcp(&self) {
        if let Some(token) = self.mcp_token.as_ref() {
            self.mcp_authorizer.register_provisional(
                self.session_id.clone(),
                self.runtime_epoch,
                self.mcp_role.clone(),
                token.clone(),
            );
        }
    }

    fn revoke_provisional_mcp(&self) {
        self.mcp_authorizer
            .remove_provisional(&self.session_id, self.runtime_epoch);
    }

    pub fn fork_runtime_ready(&self) -> bool {
        fork_runtime_is_ready(
            &self.agent_id,
            self.fork_source_ref.is_some(),
            self.codex_runtime.is_some(),
        )
    }

    pub fn verify_fork_source_history(&mut self) -> Result<(), CoreError> {
        if self.agent_id != "codex" {
            return Ok(());
        }
        let native_thread_id = self
            .fork_source_ref
            .as_ref()
            .map(|resume_ref| resume_ref.native_session_id.as_str())
            .ok_or(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::ResumeRefMissing,
            })?;
        let result = self
            .codex_runtime
            .as_ref()
            .ok_or(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::RuntimeConflict,
            })?
            .warm_thread_history(native_thread_id);
        let reason = match result {
            Ok(()) => return Ok(()),
            Err(termloop_agents::CodexThreadHistoryProbeError::Damaged) => {
                crate::AgentForkUnavailableReason::ProviderHistoryDamaged
            }
            Err(termloop_agents::CodexThreadHistoryProbeError::Unavailable) => {
                crate::AgentForkUnavailableReason::ProviderRejected
            }
        };
        self.revoke_provisional_mcp();
        if self
            .codex_runtime
            .take()
            .is_some_and(|runtime| runtime.reap().is_err())
        {
            return Err(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::RuntimeConflict,
            });
        }
        Err(CoreError::AgentForkUnavailable { reason })
    }

    pub fn ask_to_request_id(&self) -> Option<&str> {
        self.helper_prompt
            .as_ref()
            .map(|(request_id, _)| request_id.as_str())
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn runtime_epoch(&self) -> u64 {
        self.runtime_epoch
    }
}

fn fork_runtime_is_ready(agent_id: &str, has_source_ref: bool, has_codex_runtime: bool) -> bool {
    has_source_ref && (agent_id != "codex" || has_codex_runtime)
}

impl CoreRuntime {
    pub(crate) fn launch_terminal(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let cwd = launch_directory(&params)?;
        self.ensure_launch_not_reserved(Path::new(&cwd))?;
        self.launch_terminal_at(project_id, cwd)
    }

    fn launch_terminal_at(&mut self, project_id: String, cwd: String) -> Result<Value, CoreError> {
        let session_id = Uuid::new_v4().to_string();
        let (program, args) = termloop_platform::default_shell();
        let session = SessionRecord {
            launch_selection: Default::default(),
            id: session_id,
            project_id,
            name: None,
            kind: SessionKind::Terminal,
            process: ProcessDescriptor {
                program: program.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
                agent_id: None,
                template_ref: None,
                template_version: None,
            },
            lifecycle_state: "running".into(),
            runtime_epoch: self.runtime_epoch,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: None,
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: None,
            resume_launch_guard: None,
            resume_failure: None,
        };
        if let Err(error) = self.terminal.spawn(PtySpawnSpec {
            session_id: session.id.clone(),
            runtime_epoch: self.runtime_epoch,
            program,
            args,
            cwd,
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            // A shell can emit startup output before its first renderer
            // attaches. On Windows, PowerShell may then block waiting for a
            // cursor-position response to a DSR request that would otherwise
            // be lost before the terminal subscriber exists.
            recent_output_replay: true,
        }) {
            return Err(terminal_error(error));
        }
        if let Err(error) = self
            .store
            .insert_session(&self.write_authority, session.clone())
        {
            let _ = self.terminal.terminate(&session.id);
            return Err(store_error(error));
        }
        Ok(self.project_session(&session))
    }

    pub fn plan_agent_launch(&self, params: Value) -> Result<AgentLaunchPlan, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let cwd = launch_directory(&params)?;
        let cwd_identity = termloop_platform::existing_directory_comparison_input(Path::new(&cwd))
            .map_err(|_| CoreError::InvalidParams("cwd".into()))?;
        self.ensure_launch_not_reserved(Path::new(&cwd))?;
        let agent_id = required_string(&params, "agentId")?;
        if termloop_agents::executable_for(&agent_id).is_none() {
            return Err(CoreError::AgentUnsupported);
        }
        let interactive_options = interactive_agent_options(&params, &agent_id)?;
        let session_id = Uuid::new_v4().to_string();
        let mut plan = self.plan_agent_launch_at(
            project_id,
            cwd,
            agent_id,
            session_id,
            AgentMcpRole::Interactive,
        )?;
        plan.cwd_identity = cwd_identity;
        plan.interactive_options = interactive_options;
        Ok(plan)
    }

    pub(super) fn plan_agent_launch_at(
        &self,
        project_id: String,
        cwd: String,
        agent_id: String,
        session_id: String,
        mcp_role: AgentMcpRole,
    ) -> Result<AgentLaunchPlan, CoreError> {
        let cwd_identity = termloop_platform::existing_directory_comparison_input(Path::new(&cwd))
            .map_err(|_| CoreError::InvalidParams("cwd".into()))?;
        let observation_token = self.observation_transport.as_ref().and_then(|transport| {
            transport
                .launch_scoped_observation_supported(&agent_id)
                .then(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()))
        });
        let resume_ref = self
            .observation_transport
            .as_ref()
            .is_some_and(|transport| {
                agent_id == "claude"
                    && transport.capability(&agent_id).is_some_and(|capability| {
                        capability.fresh_session_id_supported && capability.resume_supported
                    })
            })
            .then(|| ResumeRef {
                provider: ResumeProvider::Claude,
                native_session_id: Uuid::new_v4().to_string(),
            });
        let mcp_token = self.observation_transport.as_ref().and_then(|transport| {
            transport
                .mcp_http_supported(&agent_id)
                .then(termloop_platform::generate_capability_token)
        });
        Ok(AgentLaunchPlan {
            session_id,
            runtime_epoch: self.runtime_epoch,
            project_id,
            cwd,
            cwd_identity,
            agent_id,
            observation_token,
            observation_transport: self.observation_transport.clone(),
            runtime_signal_sender: Some(self.agent_runtime_sender.clone()),
            codex_runtime: None,
            observation_warning: None,
            task_guard: None,
            task_guard_requires_observation: false,
            resume_ref,
            history_source_handle: None,
            history_source_ref: None,
            history_source: None,
            history_source_validated: false,
            history_name: None,
            fork_source_session_id: None,
            fork_source_ref: None,
            fork_name: None,
            fork_worktree_plan: None,
            fork_worktree_observed: false,
            interactive_options: None,
            quick_action: None,
            improver_configuration_id: None,
            improver_new_kind: None,
            improver_prompt_surface: None,
            settings_entry_kind: None,
            settings_entry_id: None,
            improver_prompt_owner_id: None,
            improver_session_name: None,
            prepared_launch: None,
            mcp_authorizer: self.mcp_authorizer.clone(),
            mcp_token,
            mcp_role,
            helper_prompt: None,
            ask_to_source_session_id: None,
            ask_to_continuation: None,
            steward_task_assignment: None,
            task_kickoff: None,
        })
    }

    pub fn plan_agent_fork(&self, params: Value) -> Result<AgentLaunchPlan, CoreError> {
        let source_session_id = required_string(&params, "sessionId")?;
        if self
            .provider_history_repair_reservations
            .contains(&source_session_id)
        {
            return Err(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::RuntimeConflict,
            });
        }
        self.ensure_session_not_individually_archived(&source_session_id)?;
        let source = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == source_session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if source.kind != SessionKind::Agent {
            return Err(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::SourceNotRunning,
            });
        }
        let agent_id = source
            .process
            .agent_id
            .clone()
            .ok_or(CoreError::AgentUnsupported)?;
        let source_ref = source
            .resume_ref
            .clone()
            .filter(ResumeRef::validate)
            .ok_or(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::ResumeRefMissing,
            })?;
        let cwd = termloop_platform::canonical_existing_directory(&source.process.cwd)
            .map_err(|_| CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::CwdUnavailable,
            })?
            .into_os_string()
            .into_string()
            .map_err(|_| CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::CwdUnavailable,
            })?;
        self.ensure_launch_not_reserved(Path::new(&cwd))?;
        let mut plan = self.plan_agent_launch(json!({
            "projectId": source.project_id,
            "cwd": cwd,
            "agentId": agent_id,
        }))?;
        plan.interactive_options = Some(source.launch_selection.clone());
        plan.resume_ref = None;
        plan.fork_name = Some(fork_session_name(&source, &agent_id));
        plan.fork_source_session_id = Some(source.id);
        plan.fork_source_ref = Some(source_ref);
        if let Some(guard) = source.resume_launch_guard {
            let worktree_plan =
                self.plan_task_worktree_launch(json!({ "taskId": guard.task_id }), false)?;
            if worktree_plan.cwd != guard.path
                || worktree_plan.managed_worktree_operation_id
                    != guard.managed_worktree_operation_id
                || worktree_plan.worktree_generation != guard.worktree_generation
            {
                return Err(CoreError::TaskWorktreeUnavailable {
                    task_id: worktree_plan.task_id,
                    reason: TaskWorktreeUnavailableReason::ManagedProofMismatch,
                });
            }
            plan.task_guard = Some(TaskLaunchGuard {
                task_id: worktree_plan.task_id.clone(),
                managed_worktree_operation_id: worktree_plan.managed_worktree_operation_id.clone(),
                worktree_generation: worktree_plan.worktree_generation,
                cwd: worktree_plan.cwd.clone(),
                repository_common_dir: worktree_plan.repository_common_dir.clone(),
                branch_ref: worktree_plan.branch_ref.clone(),
            });
            plan.fork_worktree_plan = Some(worktree_plan);
        }
        Ok(plan)
    }

    pub fn preview_quick_action(&mut self, params: Value) -> Result<Value, CoreError> {
        let mut plan = self.plan_quick_action_launch(params)?;
        let quick_action = plan
            .quick_action
            .as_ref()
            .expect("quick action plan")
            .clone();
        let (observation, mcp) = preview_transport_bindings(&plan);
        let conversation = termloop_invocation::AgentConversationLaunch::Fresh {
            resume_ref: plan.resume_ref.as_ref(),
        };
        let launch =
            resolve_quick_action_launch(&plan, &quick_action, conversation, observation, mcp)
                .map_err(invocation_error)?;
        let delivered_preview = launch
            .delivered_prompt()
            .expect("Quick Action launch has a delivered prompt")
            .to_owned();
        let manifest = launch.inspectable_manifest().clone();
        plan.prepared_launch = Some(launch);
        self.cache_quick_action_preview(plan, manifest, delivered_preview)
    }

    /// Previews an Improve-with-agent launch for one run configuration.
    ///
    /// The improver is an ordinary Agent with the caller's own permission
    /// selection. It runs in the Project's own checkout because verifying a run
    /// configuration means actually running it. Its closed MCP profile may
    /// create and activate a target-bound immutable version only after the user
    /// confirms in the Agent chat. Every fact it is told — the target and its
    /// current value — is resolved here from durable state and rendered by `invocation`, so
    /// the client cannot supply or extend the delivered instructions.
    pub fn preview_run_configuration_improver(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let bindings = self.run_configuration_improver_bindings(
            &project_id,
            params
                .get("bindings")
                .ok_or_else(|| CoreError::InvalidParams("bindings".into()))?,
        )?;
        // The template a caller names must be the one its own target resolves
        // to, so no request can pair a create prompt with an existing
        // configuration or the reverse.
        let target = bindings.improver_target();
        if params.get("templateRef").and_then(Value::as_str) != Some(target.template_ref()) {
            return Err(CoreError::InvalidParams("templateRef".into()));
        }
        let agent_id = required_string(&params, "agentId")?;
        if termloop_agents::executable_for(&agent_id).is_none() {
            return Err(CoreError::AgentUnsupported);
        }
        let selection = interactive_agent_options(&params, &agent_id)?
            .ok_or_else(|| CoreError::InvalidParams("agent launch options".into()))?;
        let checkout_path = bindings.checkout_path().to_owned();
        let cwd_identity =
            termloop_platform::existing_directory_comparison_input(Path::new(&checkout_path))
                .map_err(|_| CoreError::InvalidParams("cwd".into()))?;
        self.ensure_launch_not_reserved(Path::new(&checkout_path))?;
        let improver_target = if let Some(configuration_id) = bindings.configuration_id() {
            ImproverSessionTarget {
                target_kind: ImproverSessionTargetKind::RunConfiguration,
                target_id: Some(configuration_id.to_owned()),
            }
        } else {
            ImproverSessionTarget {
                target_kind: ImproverSessionTargetKind::NewRunConfiguration,
                target_id: bindings.new_kind().map(str::to_owned),
            }
        };
        let mut plan = self.plan_agent_launch_at(
            project_id,
            checkout_path,
            agent_id,
            Uuid::new_v4().to_string(),
            AgentMcpRole::Improver {
                target: improver_target,
            },
        )?;
        plan.cwd_identity = cwd_identity;
        plan.interactive_options = Some(selection.clone());
        plan.improver_configuration_id = bindings.configuration_id().map(str::to_owned);
        plan.improver_new_kind = bindings.new_kind().map(str::to_owned);
        plan.improver_session_name = Some(bindings.session_name());
        let (observation, mcp) = preview_transport_bindings(&plan);
        let launch = termloop_invocation::improver_agent(
            &plan.agent_id,
            &plan.cwd,
            &selection.model,
            &selection.permission,
            &selection.reasoning,
            target,
            termloop_invocation::AgentConversationLaunch::Fresh {
                resume_ref: plan.resume_ref.as_ref(),
            },
            observation,
            mcp,
        )
        .map_err(invocation_error)?;
        let delivered_preview = launch
            .delivered_prompt()
            .expect("improver launch has a delivered prompt")
            .to_owned();
        let manifest = launch.inspectable_manifest().clone();
        plan.prepared_launch = Some(launch);
        self.cache_quick_action_preview(plan, manifest, delivered_preview)
    }

    /// Redeems one improver preview ticket and re-checks everything the ticket
    /// is bound to except its own target selector: the Project, the agent, the
    /// inspected selection, and the exact template. Each improver then adds the
    /// target check its own bindings carry.
    fn take_improver_ticket(&mut self, params: &Value) -> Result<AgentLaunchPlan, CoreError> {
        self.quick_action_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        let launch_ticket = required_string(params, "launchTicket")?;
        let position = self
            .quick_action_previews
            .iter()
            .position(|(ticket, _)| ticket == &launch_ticket)
            .ok_or_else(|| CoreError::InvalidParams("launchTicket".into()))?;
        let (_, preview) = self
            .quick_action_previews
            .remove(position)
            .expect("ticket position came from the same bounded queue");
        let selection = preview.plan.interactive_options.clone().unwrap_or_default();
        let matches = params.get("projectId").and_then(Value::as_str)
            == Some(preview.plan.project_id.as_str())
            && params.get("agentId").and_then(Value::as_str)
                == Some(preview.plan.agent_id.as_str())
            && params.get("model").and_then(Value::as_str) == Some(selection.model.as_str())
            && params.get("permission").and_then(Value::as_str)
                == Some(selection.permission.as_str())
            && params.get("reasoning").and_then(Value::as_str)
                == Some(selection.reasoning.as_str())
            && params.get("templateRef").and_then(Value::as_str)
                == preview
                    .plan
                    .prepared_launch
                    .as_ref()
                    .map(|launch| launch.provenance().template_ref.as_str());
        if !matches {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        Ok(preview.plan)
    }

    /// Redeems an improver preview ticket. The ticket is bound to the exact
    /// Project, agent, selection, and configuration that were inspected, so a
    /// launch cannot retarget an approved preview at another configuration.
    pub fn take_run_configuration_improver_launch(
        &mut self,
        params: Value,
    ) -> Result<AgentLaunchPlan, CoreError> {
        let preview_plan = self.take_improver_ticket(&params)?;
        let binding = |name: &str| {
            params
                .get("bindings")
                .and_then(|bindings| bindings.get(name))
                .and_then(Value::as_str)
        };
        if binding("configurationId") != preview_plan.improver_configuration_id.as_deref()
            || binding("newKind") != preview_plan.improver_new_kind.as_deref()
        {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        Ok(preview_plan)
    }

    /// Previews an Improve-with-agent launch for one editable assistant prompt.
    ///
    /// It is the same ordinary Agent as the run-configuration improver: the
    /// caller's own permission selection and no `bypassPermissions`. A
    /// every improver receives the same target-bound immutable-version profile.
    /// It works in the Project's own checkout because
    /// deciding what a Steward, Worker, or Routine should be told means reading
    /// this repository. Every fact it is given — the built-in part it may not
    /// change and the current editable value — is resolved here
    /// from durable state and rendered by `invocation`, so the client cannot
    /// supply or extend the delivered instructions.
    pub fn preview_assistant_prompt_improver(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let bindings = self.assistant_prompt_improver_bindings(
            &project_id,
            params
                .get("bindings")
                .ok_or_else(|| CoreError::InvalidParams("bindings".into()))?,
        )?;
        // The template a caller names must be the one its own surface resolves
        // to, so no request can pair a Routine's prompt with the Steward's
        // instructions.
        let target = bindings.improver_target();
        if params.get("templateRef").and_then(Value::as_str) != Some(target.template_ref()) {
            return Err(CoreError::InvalidParams("templateRef".into()));
        }
        let agent_id = required_string(&params, "agentId")?;
        if termloop_agents::executable_for(&agent_id).is_none() {
            return Err(CoreError::AgentUnsupported);
        }
        let selection = interactive_agent_options(&params, &agent_id)?
            .ok_or_else(|| CoreError::InvalidParams("agent launch options".into()))?;
        let checkout_path = bindings.checkout_path().to_owned();
        let cwd_identity =
            termloop_platform::existing_directory_comparison_input(Path::new(&checkout_path))
                .map_err(|_| CoreError::InvalidParams("cwd".into()))?;
        self.ensure_launch_not_reserved(Path::new(&checkout_path))?;
        let mcp_role = AgentMcpRole::Improver {
            target: ImproverSessionTarget {
                target_kind: match bindings.surface() {
                    crate::AssistantPromptSurface::StewardInstructions => {
                        ImproverSessionTargetKind::StewardInstructions
                    }
                    crate::AssistantPromptSurface::WorkerInstructions => {
                        ImproverSessionTargetKind::WorkerInstructions
                    }
                    crate::AssistantPromptSurface::RoutineInstructions => {
                        ImproverSessionTargetKind::RoutineInstructions
                    }
                    crate::AssistantPromptSurface::RoutineBuilder => {
                        ImproverSessionTargetKind::RoutineBuilder
                    }
                    crate::AssistantPromptSurface::Playbook => ImproverSessionTargetKind::Playbook,
                },
                target_id: bindings.owner_id().map(str::to_owned),
            },
        };
        let mut plan = self.plan_agent_launch_at(
            project_id,
            checkout_path,
            agent_id,
            Uuid::new_v4().to_string(),
            mcp_role,
        )?;
        plan.cwd_identity = cwd_identity;
        plan.interactive_options = Some(selection.clone());
        plan.improver_prompt_surface = Some(bindings.surface().wire().to_owned());
        plan.improver_prompt_owner_id = bindings.owner_id().map(str::to_owned);
        plan.improver_session_name = Some(bindings.session_name());
        let (observation, mcp) = preview_transport_bindings(&plan);
        let launch = termloop_invocation::improver_agent(
            &plan.agent_id,
            &plan.cwd,
            &selection.model,
            &selection.permission,
            &selection.reasoning,
            target,
            termloop_invocation::AgentConversationLaunch::Fresh {
                resume_ref: plan.resume_ref.as_ref(),
            },
            observation,
            mcp,
        )
        .map_err(invocation_error)?;
        let delivered_preview = launch
            .delivered_prompt()
            .expect("improver launch has a delivered prompt")
            .to_owned();
        let manifest = launch.inspectable_manifest().clone();
        plan.prepared_launch = Some(launch);
        self.cache_quick_action_preview(plan, manifest, delivered_preview)
    }

    /// Inspects the Improve-with-agent launch for one application settings
    /// entry. The entry is resolved before this call — a skill and a prompt are
    /// read where they live, an MCP tool description comes from durable state —
    /// and the request's own selector must name that exact entry.
    pub fn preview_settings_improver(
        &mut self,
        params: Value,
        entry: crate::SettingsImproverEntry,
    ) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let bindings = params
            .get("bindings")
            .ok_or_else(|| CoreError::InvalidParams("bindings".into()))?;
        if bindings.get("kind").and_then(Value::as_str) != Some(entry.kind.wire())
            || bindings.get("id").and_then(Value::as_str) != Some(entry.id.as_str())
        {
            return Err(CoreError::InvalidParams("bindings".into()));
        }
        let version_target = entry.version_target();
        let target = entry.improver_target();
        // The template a caller names must be the one its own kind resolves to,
        // so no request can pair a skill's prompt with an MCP tool description.
        if params.get("templateRef").and_then(Value::as_str) != Some(target.template_ref()) {
            return Err(CoreError::InvalidParams("templateRef".into()));
        }
        let agent_id = required_string(&params, "agentId")?;
        if termloop_agents::executable_for(&agent_id).is_none() {
            return Err(CoreError::AgentUnsupported);
        }
        let selection = interactive_agent_options(&params, &agent_id)?
            .ok_or_else(|| CoreError::InvalidParams("agent launch options".into()))?;
        let checkout_path = self.project_checkout_path(&project_id)?;
        let cwd_identity =
            termloop_platform::existing_directory_comparison_input(Path::new(&checkout_path))
                .map_err(|_| CoreError::InvalidParams("cwd".into()))?;
        self.ensure_launch_not_reserved(Path::new(&checkout_path))?;
        let mcp_role = AgentMcpRole::Improver {
            target: version_target.clone(),
        };
        let mut plan = self.plan_agent_launch_at(
            project_id,
            checkout_path,
            agent_id,
            Uuid::new_v4().to_string(),
            mcp_role,
        )?;
        plan.cwd_identity = cwd_identity;
        plan.interactive_options = Some(selection.clone());
        plan.settings_entry_kind = Some(entry.kind.wire().to_owned());
        plan.settings_entry_id = version_target.target_id;
        plan.improver_session_name = Some(entry.session_name());
        let (observation, mcp) = preview_transport_bindings(&plan);
        let launch = termloop_invocation::improver_agent(
            &plan.agent_id,
            &plan.cwd,
            &selection.model,
            &selection.permission,
            &selection.reasoning,
            target,
            termloop_invocation::AgentConversationLaunch::Fresh {
                resume_ref: plan.resume_ref.as_ref(),
            },
            observation,
            mcp,
        )
        .map_err(invocation_error)?;
        let delivered_preview = launch
            .delivered_prompt()
            .expect("improver launch has a delivered prompt")
            .to_owned();
        let manifest = launch.inspectable_manifest().clone();
        plan.prepared_launch = Some(launch);
        self.cache_quick_action_preview(plan, manifest, delivered_preview)
    }

    /// Redeems a settings-improver preview ticket. The ticket is bound to the
    /// exact Project, agent, selection, and entry that were inspected.
    pub fn take_settings_improver_launch(
        &mut self,
        params: Value,
    ) -> Result<AgentLaunchPlan, CoreError> {
        let plan = self.take_improver_ticket(&params)?;
        let binding = |name: &str| {
            params
                .get("bindings")
                .and_then(|bindings| bindings.get(name))
                .and_then(Value::as_str)
        };
        if binding("kind") != plan.settings_entry_kind.as_deref()
            || binding("id") != plan.settings_entry_id.as_deref()
        {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        Ok(plan)
    }

    /// Redeems a prompt-improver preview ticket. The ticket is bound to the
    /// exact Project, agent, selection, and prompt that were inspected.
    pub fn take_assistant_prompt_improver_launch(
        &mut self,
        params: Value,
    ) -> Result<AgentLaunchPlan, CoreError> {
        let preview_plan = self.take_improver_ticket(&params)?;
        let binding = |name: &str| {
            params
                .get("bindings")
                .and_then(|bindings| bindings.get(name))
                .and_then(Value::as_str)
        };
        if binding("surface") != preview_plan.improver_prompt_surface.as_deref()
            || binding("ownerId") != preview_plan.improver_prompt_owner_id.as_deref()
        {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        Ok(preview_plan)
    }

    fn cache_quick_action_preview(
        &mut self,
        plan: AgentLaunchPlan,
        manifest: termloop_invocation::InspectableLaunchManifest,
        delivered_preview: String,
    ) -> Result<Value, CoreError> {
        self.quick_action_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        if self.quick_action_previews.len() >= MAX_QUICK_ACTION_PREVIEWS {
            self.quick_action_previews.pop_front();
        }
        let mut launch_ticket = termloop_platform::generate_opaque_runtime_token();
        while self
            .quick_action_previews
            .iter()
            .any(|(ticket, _)| ticket == &launch_ticket)
        {
            launch_ticket = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = termloop_platform::MonotonicDeadline::after(QUICK_ACTION_PREVIEW_TTL)
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.quick_action_previews.push_back((
            launch_ticket.clone(),
            QuickActionPreviewTicket { plan, deadline },
        ));
        Ok(json!({
            "agent_id": manifest.target.agent_id,
            "model": manifest.target.model,
            "permission": manifest.target.permission,
            "reasoning": manifest.target.reasoning,
            "template_ref": manifest.provenance.template_ref,
            "template_version": manifest.provenance.template_version,
            "delivery": manifest.transport.kind,
            "delivered_preview": delivered_preview,
            "launch_ticket": launch_ticket,
            "manifest": manifest,
        }))
    }

    pub fn preview_agent_launch(&mut self, params: Value) -> Result<Value, CoreError> {
        let plan = self.plan_agent_launch(params)?;
        self.cache_agent_launch_preview(plan)
    }

    pub fn preview_prepared_task_agent_launch(
        &mut self,
        plan: AgentLaunchPlan,
    ) -> Result<Value, CoreError> {
        self.cache_agent_launch_preview(plan)
    }

    fn cache_agent_launch_preview(
        &mut self,
        mut plan: AgentLaunchPlan,
    ) -> Result<Value, CoreError> {
        let launch = resolve_interactive_agent_launch(&plan)?;
        let manifest = launch.inspectable_manifest().clone();
        plan.prepared_launch = Some(launch);
        self.agent_launch_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        if self.agent_launch_previews.len() >= MAX_QUICK_ACTION_PREVIEWS {
            self.agent_launch_previews.pop_front();
        }
        let mut launch_ticket = termloop_platform::generate_opaque_runtime_token();
        while self
            .agent_launch_previews
            .iter()
            .any(|(ticket, _)| ticket == &launch_ticket)
        {
            launch_ticket = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = termloop_platform::MonotonicDeadline::after(QUICK_ACTION_PREVIEW_TTL)
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.agent_launch_previews.push_back((
            launch_ticket.clone(),
            AgentLaunchPreviewTicket { plan, deadline },
        ));
        Ok(json!({ "launch_ticket": launch_ticket, "manifest": manifest }))
    }

    pub fn take_agent_launch(&mut self, params: Value) -> Result<AgentLaunchPlan, CoreError> {
        self.agent_launch_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        let launch_ticket = required_string(&params, "launchTicket")?;
        let position = self
            .agent_launch_previews
            .iter()
            .position(|(ticket, _)| ticket == &launch_ticket)
            .ok_or_else(|| CoreError::InvalidParams("launchTicket".into()))?;
        let (_, preview) = self
            .agent_launch_previews
            .remove(position)
            .expect("ticket position came from the same bounded queue");
        if params
            .get("agentId")
            .and_then(Value::as_str)
            .is_some_and(|agent_id| agent_id != preview.plan.agent_id)
            || params
                .get("projectId")
                .and_then(Value::as_str)
                .is_some_and(|project_id| project_id != preview.plan.project_id)
            || params
                .get("taskId")
                .and_then(Value::as_str)
                .is_some_and(|task_id| {
                    preview
                        .plan
                        .task_guard
                        .as_ref()
                        .map(|guard| guard.task_id.as_str())
                        != Some(task_id)
                })
            || params.get("historyHandle").and_then(Value::as_str)
                != preview.plan.history_source_handle.as_deref()
        {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        if let Some(assignment) = preview.plan.steward_task_assignment.as_ref() {
            let current = self.current_task_agent_sessions_for_steward_start(
                &preview.plan.project_id,
                &assignment.task_id,
            )?;
            if let Some(session) = current
                .iter()
                .copied()
                .find(|session| {
                    session.process.template_ref.as_deref()
                        != Some("builtin.steward.task-assignment")
                })
                .or_else(|| current.first().copied())
            {
                return Err(CoreError::TaskAgentAlreadyAttached {
                    task_id: assignment.task_id.clone(),
                    session_id: session.id.clone(),
                });
            }
        }
        Ok(preview.plan)
    }

    pub fn take_quick_action_launch(
        &mut self,
        params: Value,
    ) -> Result<AgentLaunchPlan, CoreError> {
        self.quick_action_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        let launch_ticket = required_string(&params, "launchTicket")?;
        let position = self
            .quick_action_previews
            .iter()
            .position(|(ticket, _)| ticket == &launch_ticket)
            .ok_or_else(|| CoreError::InvalidParams("launchTicket".into()))?;
        let (_, preview) = self
            .quick_action_previews
            .remove(position)
            .expect("ticket position came from the same bounded queue");
        let quick_action = preview
            .plan
            .quick_action
            .as_ref()
            .expect("quick action plan");
        let prompt = params
            .get("bindings")
            .and_then(|bindings| bindings.get("prompt"))
            .and_then(Value::as_str);
        let attachments = quick_action_attachments(&params)?;
        let requested_cwd = launch_directory(&params)?;
        let matches = params.get("projectId").and_then(Value::as_str)
            == Some(preview.plan.project_id.as_str())
            && requested_cwd == preview.plan.cwd
            && params.get("agentId").and_then(Value::as_str)
                == Some(preview.plan.agent_id.as_str())
            && params.get("model").and_then(Value::as_str)
                == Some(quick_action.selection.model.as_str())
            && params.get("permission").and_then(Value::as_str)
                == Some(quick_action.selection.permission.as_str())
            && params.get("reasoning").and_then(Value::as_str)
                == Some(quick_action.selection.reasoning.as_str())
            && params.get("templateRef").and_then(Value::as_str)
                == Some(quick_action.template_ref.as_str())
            && prompt == Some(quick_action.prompt.as_str())
            && attachments == quick_action.attachments;
        if !matches {
            return Err(CoreError::InvalidParams("launchTicket".into()));
        }
        Ok(preview.plan)
    }

    pub fn discard_quick_action_preview(&mut self, launch_ticket: &str) {
        if let Some(position) = self
            .quick_action_previews
            .iter()
            .position(|(ticket, _)| ticket == launch_ticket)
        {
            self.quick_action_previews.remove(position);
        }
    }

    pub fn plan_quick_action_launch(&self, params: Value) -> Result<AgentLaunchPlan, CoreError> {
        let template_ref = required_string(&params, "templateRef")?;
        let profile = if template_ref == termloop_invocation::QUICK_ACTION_FREE_PROMPT_TEMPLATE_REF
        {
            None
        } else {
            Some(
                termloop_invocation::agent_profile(&template_ref)
                    .filter(|profile| profile.user_invocable)
                    .ok_or_else(|| CoreError::InvalidParams("templateRef".into()))?,
            )
        };
        let model = required_string(&params, "model")?;
        let permission = required_string(&params, "permission")?;
        let reasoning = required_string(&params, "reasoning")?;
        let prompt = params
            .get("bindings")
            .and_then(|bindings| bindings.get("prompt"))
            .and_then(Value::as_str)
            .filter(|prompt| !prompt.is_empty())
            .ok_or_else(|| CoreError::InvalidParams("bindings.prompt".into()))?
            .to_owned();
        let attachments = quick_action_attachments(&params)?;
        let mut plan = self.plan_agent_launch(params)?;
        if let Some(profile) = profile {
            if !profile
                .supported_agent_ids
                .contains(&plan.agent_id.as_str())
            {
                return Err(CoreError::AgentUnsupported);
            }
            if permission != profile.permission {
                return Err(CoreError::InvalidParams("permission".into()));
            }
        }
        termloop_invocation::validate_quick_action_with_attachments(
            &plan.agent_id,
            &model,
            &permission,
            &reasoning,
            &prompt,
            &attachments,
        )
        .map_err(invocation_error)?;
        plan.quick_action = Some(QuickActionLaunch {
            selection: AgentLaunchSelection::new(&model, &permission, &reasoning),
            template_ref,
            prompt,
            attachments,
        });
        Ok(plan)
    }

    pub fn agent_profile_list(&self) -> Value {
        Value::Array(
            termloop_invocation::agent_profiles()
                .iter()
                .map(|profile| {
                    json!({
                        "id": profile.id,
                        "name": profile.name,
                        "description": profile.description,
                        "category": profile.category,
                        "version": profile.version,
                        "permission": profile.permission,
                        "read_only": profile.read_only,
                        "user_invocable": profile.user_invocable,
                        "agent_ids": profile.supported_agent_ids,
                    })
                })
                .collect(),
        )
    }

    pub fn plan_task_worktree_launch(
        &self,
        params: Value,
        agent: bool,
    ) -> Result<TaskWorktreeLaunchPlan, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let worktree = task
            .worktree
            .as_ref()
            .ok_or_else(|| CoreError::TaskWorktreeRequired {
                task_id: task_id.clone(),
            })?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == task_id)
            .ok_or_else(|| CoreError::TaskWorktreeUnavailable {
                task_id: task_id.clone(),
                reason: TaskWorktreeUnavailableReason::ManagedProofMissing,
            })?;
        if proof.worktree_generation != task.worktree_generation
            || proof.registered_worktree_path != worktree.path
            || proof.branch_ref
                != task
                    .branch
                    .as_ref()
                    .map(|branch| format!("refs/heads/{}", branch.name))
                    .unwrap_or_default()
        {
            return Err(CoreError::TaskWorktreeUnavailable {
                task_id,
                reason: TaskWorktreeUnavailableReason::ManagedProofMismatch,
            });
        }
        self.ensure_launch_not_reserved(Path::new(&worktree.path))?;
        let agent_id = agent
            .then(|| required_string(&params, "agentId"))
            .transpose()?;
        if agent_id
            .as_deref()
            .is_some_and(|agent_id| termloop_agents::executable_for(agent_id).is_none())
        {
            return Err(CoreError::AgentUnsupported);
        }
        let interactive_options = agent_id
            .as_deref()
            .map(|agent_id| interactive_agent_options(&params, agent_id))
            .transpose()?
            .flatten();
        Ok(TaskWorktreeLaunchPlan {
            task_id,
            project_id: task.project_id.clone(),
            cwd: worktree.path.clone(),
            managed_worktree_operation_id: proof.operation_id.clone(),
            worktree_generation: proof.worktree_generation,
            repository_common_dir: proof.repository_common_dir.clone(),
            branch_ref: proof.branch_ref.clone(),
            agent_id,
            interactive_options,
        })
    }

    pub fn complete_task_terminal_launch(
        &mut self,
        observed: ObservedTaskWorktreeLaunch,
    ) -> Result<Value, CoreError> {
        self.revalidate_task_launch(&observed.plan)?;
        self.launch_terminal_at(observed.plan.project_id, observed.plan.cwd)
    }

    pub fn complete_task_agent_launch_plan(
        &self,
        observed: ObservedTaskWorktreeLaunch,
    ) -> Result<AgentLaunchPlan, CoreError> {
        self.revalidate_task_launch(&observed.plan)?;
        let mut params = json!({
            "projectId": observed.plan.project_id,
            "cwd": observed.plan.cwd,
            "agentId": observed.plan.agent_id.as_deref().ok_or_else(|| CoreError::InvalidParams("agentId".into()))?,
        });
        if let Some(options) = &observed.plan.interactive_options {
            params["model"] = json!(options.model);
            params["permission"] = json!(options.permission);
            params["reasoning"] = json!(options.reasoning);
        }
        let mut plan = self.plan_agent_launch(params)?;
        plan.task_guard = Some(TaskLaunchGuard {
            task_id: observed.plan.task_id,
            managed_worktree_operation_id: observed.plan.managed_worktree_operation_id,
            worktree_generation: observed.plan.worktree_generation,
            cwd: observed.plan.cwd,
            repository_common_dir: observed.plan.repository_common_dir,
            branch_ref: observed.plan.branch_ref,
        });
        plan.fork_worktree_observed = true;
        Ok(plan)
    }

    pub fn attach_steward_task_assignment(
        &self,
        mut plan: AgentLaunchPlan,
        steward_session_id: &str,
        task_id: &str,
        assignment: &str,
    ) -> Result<AgentLaunchPlan, CoreError> {
        if plan
            .task_guard
            .as_ref()
            .is_none_or(|guard| guard.task_id != task_id)
        {
            return Err(CoreError::CapabilityDenied);
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == plan.project_id)
            .ok_or(CoreError::CapabilityDenied)?;
        let jira_url = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task_id && link.provider == IssueLinkProvider::Jira)
            .and_then(|link| link.url.as_deref());
        termloop_invocation::steward_task_assignment_prompt(
            task_id,
            steward_session_id,
            &task.title,
            task.brief.as_deref(),
            jira_url,
            assignment,
        )
        .map_err(|_| CoreError::InvalidParams("assignment".into()))?;
        plan.steward_task_assignment = Some(StewardTaskAssignmentLaunch {
            task_id: task_id.to_owned(),
            steward_session_id: steward_session_id.to_owned(),
            title: task.title.clone(),
            brief: task.brief.clone(),
            jira_url: jira_url.map(str::to_owned),
            assignment: assignment.to_owned(),
        });
        Ok(plan)
    }

    pub fn attach_task_kickoff(
        &self,
        mut plan: AgentLaunchPlan,
        task_id: &str,
        kickoff_message: &str,
    ) -> Result<AgentLaunchPlan, CoreError> {
        if plan
            .task_guard
            .as_ref()
            .is_none_or(|guard| guard.task_id != task_id)
        {
            return Err(CoreError::CapabilityDenied);
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == plan.project_id)
            .ok_or(CoreError::CapabilityDenied)?;
        let jira_url = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task_id && link.provider == IssueLinkProvider::Jira)
            .and_then(|link| link.url.as_deref());
        termloop_invocation::task_kickoff_prompt(
            task_id,
            &task.title,
            task.brief.as_deref(),
            jira_url,
            kickoff_message,
        )
        .map_err(|_| CoreError::InvalidParams("kickoffMessage".into()))?;
        plan.task_kickoff = Some(TaskKickoffLaunch {
            task_id: task_id.to_owned(),
            title: task.title.clone(),
            brief: task.brief.clone(),
            jira_url: jira_url.map(str::to_owned),
            kickoff_message: kickoff_message.to_owned(),
        });
        Ok(plan)
    }

    pub(crate) fn revalidate_task_launch(
        &self,
        plan: &TaskWorktreeLaunchPlan,
    ) -> Result<(), CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == plan.task_id)
            .ok_or(CoreError::NotFound)?;
        let proof = self
            .store
            .managed_worktrees()
            .iter()
            .find(|proof| proof.task_id == plan.task_id);
        let current = task.worktree.as_ref().zip(proof);
        if !current.is_some_and(|(worktree, proof)| {
            task.project_id == plan.project_id
                && task.worktree_generation == plan.worktree_generation
                && worktree.path == plan.cwd
                && proof.operation_id == plan.managed_worktree_operation_id
                && proof.worktree_generation == plan.worktree_generation
                && proof.registered_worktree_path == plan.cwd
                && proof.repository_common_dir == plan.repository_common_dir
                && proof.branch_ref == plan.branch_ref
        }) {
            return Err(CoreError::TaskWorktreeUnavailable {
                task_id: plan.task_id.clone(),
                reason: TaskWorktreeUnavailableReason::ManagedProofMismatch,
            });
        }
        self.ensure_launch_not_reserved(Path::new(&plan.cwd))
    }

    pub fn complete_agent_launch(
        &mut self,
        plan: &mut AgentLaunchPlan,
    ) -> Result<Value, CoreError> {
        if !self.project_exists(&plan.project_id) {
            return Err(CoreError::NotFound);
        }
        self.validate_history_launch_plan(plan)?;
        if plan.history_source_ref.is_some()
            && (!plan.history_source_validated
                || (plan.agent_id == "codex" && plan.codex_runtime.is_none()))
        {
            return Err(CoreError::InvalidParams("historyHandle".into()));
        }
        if let Some(source_session_id) = plan.fork_source_session_id.as_deref() {
            if self
                .provider_history_repair_reservations
                .contains(source_session_id)
            {
                return Err(CoreError::AgentForkUnavailable {
                    reason: crate::AgentForkUnavailableReason::RuntimeConflict,
                });
            }
            let source = self
                .store
                .sessions()
                .iter()
                .find(|session| session.id == source_session_id)
                .ok_or(CoreError::AgentForkUnavailable {
                    reason: crate::AgentForkUnavailableReason::SourceNotRunning,
                })?;
            if source.kind != SessionKind::Agent
                || source.project_id != plan.project_id
                || source.process.cwd != plan.cwd
                || source.process.agent_id.as_deref() != Some(plan.agent_id.as_str())
            {
                return Err(CoreError::AgentForkUnavailable {
                    reason: crate::AgentForkUnavailableReason::SourceNotRunning,
                });
            }
            if source.resume_ref.as_ref() != plan.fork_source_ref.as_ref() {
                return Err(CoreError::AgentForkUnavailable {
                    reason: crate::AgentForkUnavailableReason::ResumeRefMissing,
                });
            }
            let current_cwd = termloop_platform::canonical_existing_directory(&source.process.cwd)
                .map_err(|_| CoreError::AgentForkUnavailable {
                    reason: crate::AgentForkUnavailableReason::CwdUnavailable,
                })?;
            if current_cwd != Path::new(&plan.cwd) {
                return Err(CoreError::AgentForkUnavailable {
                    reason: crate::AgentForkUnavailableReason::CwdUnavailable,
                });
            }
            if plan.task_guard.is_some() && !plan.fork_worktree_observed {
                return Err(CoreError::AgentForkUnavailable {
                    reason: crate::AgentForkUnavailableReason::RuntimeConflict,
                });
            }
        }
        self.ensure_launch_not_reserved(Path::new(&plan.cwd))?;
        let current_cwd_identity =
            termloop_platform::existing_directory_comparison_input(Path::new(&plan.cwd))
                .map_err(|_| CoreError::InvalidParams("cwd".into()))?;
        if current_cwd_identity != plan.cwd_identity {
            return Err(CoreError::InvalidParams("cwd".into()));
        }
        if let Some(guard) = &plan.task_guard {
            if plan.task_guard_requires_observation {
                return Err(CoreError::TaskWorktreeUnavailable {
                    task_id: guard.task_id.clone(),
                    reason: TaskWorktreeUnavailableReason::ObservationUnknown,
                });
            }
            let task = self
                .store
                .tasks()
                .iter()
                .find(|task| task.id == guard.task_id)
                .ok_or(CoreError::NotFound)?;
            let proof = self
                .store
                .managed_worktrees()
                .iter()
                .find(|proof| proof.task_id == guard.task_id);
            if !task
                .worktree
                .as_ref()
                .zip(proof)
                .is_some_and(|(worktree, proof)| {
                    task.worktree_generation == guard.worktree_generation
                        && worktree.path == guard.cwd
                        && proof.operation_id == guard.managed_worktree_operation_id
                        && proof.worktree_generation == guard.worktree_generation
                        && proof.registered_worktree_path == guard.cwd
                        && proof.repository_common_dir == guard.repository_common_dir
                        && proof.branch_ref == guard.branch_ref
                })
            {
                return Err(CoreError::TaskWorktreeUnavailable {
                    task_id: guard.task_id.clone(),
                    reason: TaskWorktreeUnavailableReason::ManagedProofMismatch,
                });
            }
        }
        let codex_endpoint = plan
            .codex_runtime
            .as_ref()
            .map(|runtime| runtime.bridge.endpoint());
        let observation = plan.observation_transport.as_ref().and_then(|transport| {
            transport.invocation_observation(
                &plan.agent_id,
                &plan.session_id,
                plan.observation_token.as_deref(),
                codex_endpoint,
            )
        });
        let mcp = plan.mcp_token.as_ref().and_then(|token| {
            plan.observation_transport.as_ref().map(|transport| {
                termloop_invocation::AgentMcpLaunch {
                    endpoint: &transport.mcp_endpoint,
                    token,
                    claude_config_path: &transport.claude_mcp_config_path,
                    profile: plan.mcp_role.invocation_profile(),
                }
            })
        });
        let conversation = match plan.fork_source_ref.as_ref() {
            Some(source_ref) => termloop_invocation::AgentConversationLaunch::Fork { source_ref },
            None if plan.history_source_ref.is_some() => {
                termloop_invocation::AgentConversationLaunch::Resume {
                    resume_ref: plan
                        .history_source_ref
                        .as_ref()
                        .expect("history source checked above"),
                }
            }
            None => termloop_invocation::AgentConversationLaunch::Fresh {
                resume_ref: plan.resume_ref.as_ref(),
            },
        };
        let managed_worktree = plan.has_observed_managed_worktree();
        let launch = if let Some(launch) = plan.prepared_launch.take() {
            Ok(launch)
        } else if let Some(quick_action) = &plan.quick_action {
            resolve_quick_action_launch(plan, quick_action, conversation, observation, mcp)
        } else if let Some((request_id, message)) = plan.helper_prompt.as_ref() {
            let mcp = mcp.ok_or(CoreError::AgentUnsupported)?;
            if managed_worktree {
                termloop_invocation::ask_to_helper_agent_for_managed_worktree_conversation(
                    &plan.agent_id,
                    &plan.cwd,
                    conversation,
                    request_id,
                    message,
                    observation,
                    mcp,
                )
            } else {
                termloop_invocation::ask_to_helper_agent_for_conversation(
                    &plan.agent_id,
                    &plan.cwd,
                    conversation,
                    request_id,
                    message,
                    observation,
                    mcp,
                )
            }
        } else if let Some(options) = &plan.interactive_options {
            if managed_worktree {
                termloop_invocation::configured_interactive_agent_for_managed_worktree_conversation(
                    &plan.agent_id,
                    &plan.cwd,
                    &options.model,
                    &options.permission,
                    &options.reasoning,
                    conversation,
                    observation,
                    mcp,
                )
            } else {
                termloop_invocation::configured_interactive_agent_for_conversation(
                    &plan.agent_id,
                    &plan.cwd,
                    &options.model,
                    &options.permission,
                    &options.reasoning,
                    conversation,
                    observation,
                    mcp,
                )
            }
        } else if managed_worktree {
            termloop_invocation::interactive_agent_for_managed_worktree_conversation(
                &plan.agent_id,
                &plan.cwd,
                conversation,
                observation,
                mcp,
            )
        } else {
            termloop_invocation::interactive_agent_for_conversation(
                &plan.agent_id,
                &plan.cwd,
                conversation,
                observation,
                mcp,
            )
        }
        .map_err(invocation_error)?;
        let program = launch.program().to_owned();
        let args = launch.args().to_vec();
        let environment = launch.environment().clone();
        let initial_input_submission = launch.initial_input_submission();
        let generated_input_observable =
            plan.observation_token.is_some() || plan.codex_runtime.is_some();
        if initial_input_submission.is_some() && !generated_input_observable {
            return Err(CoreError::AgentCapabilityUnproven);
        }
        let pending_generated_input = initial_input_submission;
        let session = SessionRecord {
            launch_selection: effective_launch_selection(plan),
            id: plan.session_id.clone(),
            project_id: plan.project_id.clone(),
            name: launch_session_name(plan),
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: program.clone(),
                // Agent argv may contain a private provider conversation ID. The
                // durable/public descriptor intentionally records no raw argv.
                args: vec![],
                cwd: plan.cwd.clone(),
                agent_id: Some(plan.agent_id.clone()),
                template_ref: Some(launch.provenance().template_ref.clone()),
                template_version: Some(launch.provenance().template_version),
            },
            lifecycle_state: "running".into(),
            runtime_epoch: self.runtime_epoch,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: plan.ask_to_source_session_id.clone(),
            run_configuration_id: None,
            improver_target: improver_session_target(plan),
            ask_to_continuation: plan.ask_to_continuation.clone(),
            resume_ref: plan
                .history_source_ref
                .clone()
                .or_else(|| plan.resume_ref.clone()),
            resume_launch_guard: plan.task_guard.as_ref().map(|guard| {
                termloop_domain::ResumeLaunchGuard {
                    task_id: guard.task_id.clone(),
                    managed_worktree_operation_id: guard.managed_worktree_operation_id.clone(),
                    worktree_generation: guard.worktree_generation,
                    path: guard.cwd.clone(),
                }
            }),
            resume_failure: None,
        };
        if generated_input_observable {
            self.agent_observations.insert(
                session.id.clone(),
                crate::AgentObservationCapability {
                    token: plan.observation_token.clone(),
                    runtime_epoch: session.runtime_epoch,
                    observation: None,
                    last_signal: None,
                    pending_generated_input,
                    defer_generated_input_until_hook_response: false,
                    last_notification_type: None,
                },
            );
        }
        if let Some(token) = plan.mcp_token.as_ref() {
            self.mcp_authorizer.register(
                session.id.clone(),
                self.runtime_epoch,
                plan.mcp_role.clone(),
                token.clone(),
            );
        }
        if let Err(error) = self.terminal.spawn(PtySpawnSpec {
            session_id: session.id.clone(),
            runtime_epoch: self.runtime_epoch,
            program,
            args,
            cwd: plan.cwd.clone(),
            environment,
            recent_output_replay: true,
        }) {
            self.agent_observations.remove(&session.id);
            self.mcp_authorizer.remove(&session.id);
            return Err(terminal_error(error));
        }
        let remember_launch_selection = matches!(
            plan.mcp_role,
            AgentMcpRole::Interactive | AgentMcpRole::Improver { .. }
        ) && plan.helper_prompt.is_none()
            && plan.steward_task_assignment.is_none();
        let inserted = if remember_launch_selection {
            self.store
                .insert_session_and_remember_agent_launch(&self.write_authority, session.clone())
        } else {
            self.store
                .insert_session(&self.write_authority, session.clone())
        };
        if let Err(error) = inserted {
            let _ = self.terminal.terminate(&session.id);
            self.agent_observations.remove(&session.id);
            self.mcp_authorizer.remove(&session.id);
            return Err(store_error(error));
        }
        if let Some(source_session_id) = plan.fork_source_session_id.as_ref() {
            self.fork_source_session_ids
                .insert(session.id.clone(), source_session_id.clone());
            self.pending_agent_forks.insert(session.id.clone());
        }
        if let Some(runtime) = plan.codex_runtime.take() {
            self.codex_runtimes.insert(session.id.clone(), runtime);
        }
        self.consume_history_handle(plan);
        Ok(self.project_session(&session))
    }

    pub(crate) fn ensure_launch_not_reserved(&self, cwd: &Path) -> Result<(), CoreError> {
        if let Some(task) = self.store.tasks().iter().find(|task| {
            task.archived_at_epoch_ms.is_some()
                && task
                    .worktree
                    .as_ref()
                    .is_some_and(|binding| cwd.starts_with(Path::new(&binding.path)))
        }) {
            return Err(CoreError::TaskArchived {
                task_id: task.id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .task_archive_operations()
            .iter()
            .find(|operation| {
                operation
                    .worktree_path
                    .as_ref()
                    .is_some_and(|path| cwd.starts_with(Path::new(path)))
            })
        {
            return Err(CoreError::ArchiveInProgress {
                task_id: operation.task_id.clone(),
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self.store.repair_operations().iter().find(|operation| {
            Path::new(&operation.candidate_path) == cwd
                || self
                    .store
                    .tasks()
                    .iter()
                    .find(|task| task.id == operation.task_id)
                    .and_then(|task| task.worktree.as_ref())
                    .is_some_and(|binding| Path::new(&binding.path) == cwd)
        }) {
            if operation.failure.as_ref().is_some_and(|failure| {
                failure.kind == termloop_domain::WorktreeRepairFailureKind::RecoveryAttention
            }) || operation.stage != termloop_domain::WorktreeRepairStage::Reserved
            {
                return Err(CoreError::TaskWorktreeUnavailable {
                    task_id: operation.task_id.clone(),
                    reason: TaskWorktreeUnavailableReason::RepairRecoveryAttention,
                });
            }
            return Err(CoreError::RepairInProgress {
                task_id: operation.task_id.clone(),
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some((task_id, operation_id)) = self.cleanup_reservation_for_cwd(cwd) {
            Err(CoreError::CleanupInProgress {
                task_id,
                operation_id,
            })
        } else {
            Ok(())
        }
    }
}

impl Drop for AgentLaunchPlan {
    fn drop(&mut self) {
        // A committed launch has already promoted its entry, which
        // remove_provisional deliberately preserves. Any abandoned fresh
        // Codex plan loses its transport-only admission here.
        self.revoke_provisional_mcp();
    }
}

impl AgentLaunchPlan {
    pub fn fork_task_scope(&self) -> Option<(&str, &str)> {
        self.fork_worktree_plan
            .as_ref()
            .map(|plan| (plan.task_id.as_str(), plan.project_id.as_str()))
    }

    pub fn observe_fork_worktree(&mut self, timeout: std::time::Duration) -> Result<(), CoreError> {
        if let Some(plan) = self.fork_worktree_plan.clone() {
            plan.observe(timeout)?;
            self.fork_worktree_observed = true;
        }
        Ok(())
    }
}

fn launch_session_name(plan: &AgentLaunchPlan) -> Option<String> {
    plan.quick_action
        .as_ref()
        .and_then(quick_action_launch_session_name)
        .or_else(|| {
            plan.improver_session_name
                .as_deref()
                .map(|name| name.chars().take(SESSION_NAME_MAX_CHARS).collect())
        })
        .or_else(|| {
            plan.history_name
                .as_deref()
                .map(|name| name.chars().take(SESSION_NAME_MAX_CHARS).collect())
        })
        .or_else(|| plan.fork_name.clone())
}

fn resolve_quick_action_launch(
    plan: &AgentLaunchPlan,
    quick_action: &QuickActionLaunch,
    conversation: termloop_invocation::AgentConversationLaunch<'_>,
    observation: Option<termloop_invocation::AgentObservationLaunch<'_>>,
    mcp: Option<termloop_invocation::AgentMcpLaunch<'_>>,
) -> Result<termloop_invocation::LaunchPayload, termloop_invocation::InvocationError> {
    if quick_action.template_ref == termloop_invocation::QUICK_ACTION_FREE_PROMPT_TEMPLATE_REF {
        termloop_invocation::quick_action_agent_with_attachments_for_conversation(
            &plan.agent_id,
            &plan.cwd,
            &quick_action.selection.model,
            &quick_action.selection.permission,
            &quick_action.selection.reasoning,
            &quick_action.prompt,
            &quick_action.attachments,
            conversation,
            observation,
            mcp,
        )
    } else {
        termloop_invocation::profile_quick_action_agent_with_attachments_for_conversation(
            &quick_action.template_ref,
            &plan.agent_id,
            &plan.cwd,
            &quick_action.selection.model,
            &quick_action.selection.permission,
            &quick_action.selection.reasoning,
            &quick_action.prompt,
            &quick_action.attachments,
            conversation,
            observation,
            mcp,
        )
    }
}

fn improver_session_target(plan: &AgentLaunchPlan) -> Option<ImproverSessionTarget> {
    if let Some(surface) = plan.improver_prompt_surface.as_deref() {
        let target_kind = match surface {
            "stewardInstructions" => ImproverSessionTargetKind::StewardInstructions,
            "workerInstructions" => ImproverSessionTargetKind::WorkerInstructions,
            "routineInstructions" => ImproverSessionTargetKind::RoutineInstructions,
            "routineBuilder" => ImproverSessionTargetKind::RoutineBuilder,
            "playbook" => ImproverSessionTargetKind::Playbook,
            _ => return None,
        };
        return Some(ImproverSessionTarget {
            target_kind,
            target_id: plan.improver_prompt_owner_id.clone(),
        });
    }
    if let (Some(kind), Some(id)) = (
        plan.settings_entry_kind.as_deref(),
        plan.settings_entry_id.as_ref(),
    ) {
        let target_kind = match kind {
            "skill" => ImproverSessionTargetKind::SettingsSkill,
            "prompt" => ImproverSessionTargetKind::SettingsPrompt,
            "mcpTool" => ImproverSessionTargetKind::SettingsMcpTool,
            _ => return None,
        };
        return Some(ImproverSessionTarget {
            target_kind,
            target_id: Some(id.clone()),
        });
    }
    if let Some(configuration_id) = plan.improver_configuration_id.as_ref() {
        return Some(ImproverSessionTarget {
            target_kind: ImproverSessionTargetKind::RunConfiguration,
            target_id: Some(configuration_id.clone()),
        });
    }
    plan.improver_new_kind
        .as_ref()
        .map(|kind| ImproverSessionTarget {
            target_kind: ImproverSessionTargetKind::NewRunConfiguration,
            target_id: Some(kind.clone()),
        })
}

fn quick_action_launch_session_name(quick_action: &QuickActionLaunch) -> Option<String> {
    let first_line = quick_action.prompt.trim().lines().next()?.trim();
    let raw_name = termloop_invocation::agent_profile(&quick_action.template_ref)
        .map(|profile| format!("{} · {first_line}", profile.name))
        .unwrap_or_else(|| first_line.to_owned());
    quick_action_session_name(&raw_name)
}

fn quick_action_session_name(prompt: &str) -> Option<String> {
    let first_line = prompt.trim().lines().next()?.trim();
    let name = first_line
        .chars()
        .take(SESSION_NAME_MAX_CHARS)
        .collect::<String>();
    (!name.is_empty()).then_some(name)
}

fn fork_session_name(source: &SessionRecord, agent_id: &str) -> String {
    const SUFFIX: &str = " fork-1";
    let fallback = match agent_id {
        "claude" => "Claude",
        "codex" => "Codex",
        _ => "Agent",
    };
    let base = source
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback);
    let retained = SESSION_NAME_MAX_CHARS - SUFFIX.chars().count();
    let base = base.chars().take(retained).collect::<String>();
    format!("{base}{SUFFIX}")
}

fn invocation_error(error: termloop_invocation::InvocationError) -> CoreError {
    match error {
        termloop_invocation::InvocationError::UnsupportedAgent(_) => CoreError::AgentUnsupported,
        termloop_invocation::InvocationError::UnsupportedModel { .. }
        | termloop_invocation::InvocationError::UnsupportedPermission { .. }
        | termloop_invocation::InvocationError::UnsupportedReasoning { .. }
        | termloop_invocation::InvocationError::InvalidPrompt
        | termloop_invocation::InvocationError::InvalidImageAttachment => {
            CoreError::InvalidParams(error.to_string())
        }
        other => CoreError::Terminal(other.to_string()),
    }
}

fn quick_action_attachments(
    params: &Value,
) -> Result<Vec<termloop_invocation::QuickActionImageAttachment>, CoreError> {
    let values = params
        .get("attachments")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidParams("attachments".into()))?;
    if values.len() > 1 {
        return Err(CoreError::InvalidParams("attachments".into()));
    }
    values
        .iter()
        .map(|value| {
            let byte_length = value
                .get("byteLength")
                .and_then(Value::as_u64)
                .ok_or_else(|| CoreError::InvalidParams("attachments.byteLength".into()))?;
            let width = value
                .get("width")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| CoreError::InvalidParams("attachments.width".into()))?;
            let height = value
                .get("height")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| CoreError::InvalidParams("attachments.height".into()))?;
            Ok(termloop_invocation::QuickActionImageAttachment {
                attachment_id: required_string(value, "attachmentId")?,
                file_path: required_string(value, "filePath")?,
                media_type: required_string(value, "mediaType")?,
                byte_length,
                sha256: required_string(value, "sha256")?,
                width,
                height,
            })
        })
        .collect()
}

fn interactive_agent_options(
    params: &Value,
    agent_id: &str,
) -> Result<Option<AgentLaunchSelection>, CoreError> {
    match (
        params.get("model").and_then(Value::as_str),
        params.get("permission").and_then(Value::as_str),
        params.get("reasoning").and_then(Value::as_str),
    ) {
        (None, None, None) => Ok(None),
        (Some(model), Some(permission), Some(reasoning)) => {
            termloop_invocation::validate_agent_configuration(
                agent_id, model, permission, reasoning,
            )
            .map_err(invocation_error)?;
            Ok(Some(AgentLaunchSelection::new(
                model, permission, reasoning,
            )))
        }
        _ => Err(CoreError::InvalidParams("agent launch options".into())),
    }
}

/// The observation and MCP bindings a preview-time composition passes to
/// `invocation`. Quick Action and Improve-with-agent resolve the same pair from
/// the same plan, so it stays one derivation rather than two that can drift.
fn preview_transport_bindings(
    plan: &AgentLaunchPlan,
) -> (
    Option<termloop_invocation::AgentObservationLaunch<'_>>,
    Option<termloop_invocation::AgentMcpLaunch<'_>>,
) {
    let placeholder_endpoint = termloop_invocation::CODEX_APP_SERVER_RUNTIME_PLACEHOLDER;
    let observation = plan.observation_transport.as_ref().and_then(|transport| {
        transport.invocation_observation(
            &plan.agent_id,
            &plan.session_id,
            plan.observation_token.as_deref(),
            Some(placeholder_endpoint),
        )
    });
    let mcp = plan.mcp_token.as_ref().and_then(|token| {
        plan.observation_transport
            .as_ref()
            .map(|transport| termloop_invocation::AgentMcpLaunch {
                endpoint: &transport.mcp_endpoint,
                token,
                claude_config_path: &transport.claude_mcp_config_path,
                profile: plan.mcp_role.invocation_profile(),
            })
    });
    (observation, mcp)
}

fn effective_launch_selection(plan: &AgentLaunchPlan) -> AgentLaunchSelection {
    if let Some(quick_action) = &plan.quick_action {
        quick_action.selection.clone()
    } else if let Some(options) = &plan.interactive_options {
        options.clone()
    } else {
        // An unconfigured launch records exactly what `invocation` launches, so
        // a later resume reapplies the same permission mode instead of falling
        // back to the provider's ask-every-time default.
        AgentLaunchSelection::new(
            "default",
            termloop_invocation::default_permission(&plan.agent_id),
            "default",
        )
    }
}

fn resolve_interactive_agent_launch(
    plan: &AgentLaunchPlan,
) -> Result<termloop_invocation::LaunchPayload, CoreError> {
    let observation = plan.observation_transport.as_ref().and_then(|transport| {
        transport.invocation_observation(
            &plan.agent_id,
            &plan.session_id,
            plan.observation_token.as_deref(),
            Some(termloop_invocation::CODEX_APP_SERVER_RUNTIME_PLACEHOLDER),
        )
    });
    let conversation = match plan.history_source_ref.as_ref() {
        Some(resume_ref) => termloop_invocation::AgentConversationLaunch::Resume { resume_ref },
        None => termloop_invocation::AgentConversationLaunch::Fresh {
            resume_ref: plan.resume_ref.as_ref(),
        },
    };
    let mcp = plan.mcp_token.as_ref().and_then(|token| {
        plan.observation_transport
            .as_ref()
            .map(|transport| termloop_invocation::AgentMcpLaunch {
                endpoint: &transport.mcp_endpoint,
                token,
                claude_config_path: &transport.claude_mcp_config_path,
                profile: plan.mcp_role.invocation_profile(),
            })
    });
    let managed_worktree = plan.has_observed_managed_worktree();
    if let Some(assignment) = &plan.steward_task_assignment {
        let selection = plan.interactive_options.clone().unwrap_or_default();
        if managed_worktree {
            termloop_invocation::steward_task_agent_for_managed_worktree_conversation(
                &plan.agent_id,
                &plan.cwd,
                &selection.model,
                &selection.permission,
                &selection.reasoning,
                &assignment.task_id,
                &assignment.steward_session_id,
                &assignment.title,
                assignment.brief.as_deref(),
                assignment.jira_url.as_deref(),
                &assignment.assignment,
                conversation,
                observation,
                mcp,
            )
        } else {
            termloop_invocation::steward_task_agent_for_conversation(
                &plan.agent_id,
                &plan.cwd,
                &selection.model,
                &selection.permission,
                &selection.reasoning,
                &assignment.task_id,
                &assignment.steward_session_id,
                &assignment.title,
                assignment.brief.as_deref(),
                assignment.jira_url.as_deref(),
                &assignment.assignment,
                conversation,
                observation,
                mcp,
            )
        }
    } else if let Some(kickoff) = &plan.task_kickoff {
        let selection = plan.interactive_options.clone().unwrap_or_default();
        if managed_worktree {
            termloop_invocation::task_agent_with_kickoff_for_managed_worktree_conversation(
                &plan.agent_id,
                &plan.cwd,
                &selection.model,
                &selection.permission,
                &selection.reasoning,
                &kickoff.task_id,
                &kickoff.title,
                kickoff.brief.as_deref(),
                kickoff.jira_url.as_deref(),
                &kickoff.kickoff_message,
                conversation,
                observation,
                mcp,
            )
        } else {
            termloop_invocation::task_agent_with_kickoff_for_conversation(
                &plan.agent_id,
                &plan.cwd,
                &selection.model,
                &selection.permission,
                &selection.reasoning,
                &kickoff.task_id,
                &kickoff.title,
                kickoff.brief.as_deref(),
                kickoff.jira_url.as_deref(),
                &kickoff.kickoff_message,
                conversation,
                observation,
                mcp,
            )
        }
    } else if let Some(options) = &plan.interactive_options {
        if managed_worktree {
            termloop_invocation::configured_interactive_agent_for_managed_worktree_conversation(
                &plan.agent_id,
                &plan.cwd,
                &options.model,
                &options.permission,
                &options.reasoning,
                conversation,
                observation,
                mcp,
            )
        } else {
            termloop_invocation::configured_interactive_agent_for_conversation(
                &plan.agent_id,
                &plan.cwd,
                &options.model,
                &options.permission,
                &options.reasoning,
                conversation,
                observation,
                mcp,
            )
        }
    } else if managed_worktree {
        termloop_invocation::interactive_agent_for_managed_worktree_conversation(
            &plan.agent_id,
            &plan.cwd,
            conversation,
            observation,
            mcp,
        )
    } else {
        termloop_invocation::interactive_agent_for_conversation(
            &plan.agent_id,
            &plan.cwd,
            conversation,
            observation,
            mcp,
        )
    }
    .map_err(invocation_error)
}

pub(crate) fn start_codex_runtime(
    session_id: &str,
    runtime_epoch: u64,
    cwd: &str,
    managed_worktree: bool,
    provider_process_directory: &Path,
    mcp: Option<termloop_invocation::AgentMcpLaunch<'_>>,
    signals: Sender<crate::AgentRuntimeSignal>,
) -> Result<CodexRuntime, crate::AgentResumePreparationError> {
    let port = termloop_platform::reserve_loopback_port()
        .map_err(|_| crate::AgentResumePreparationError::ProviderRejected)?;
    let upstream_endpoint = format!("ws://127.0.0.1:{port}");
    let launch = if managed_worktree {
        termloop_invocation::codex_app_server_for_managed_worktree(
            &upstream_endpoint,
            cwd,
            session_id,
            mcp,
        )
    } else {
        termloop_invocation::codex_app_server(&upstream_endpoint, cwd, session_id, mcp)
    }
    .map_err(|_| crate::AgentResumePreparationError::ProviderRejected)?;
    let mut process = termloop_platform::spawn_tracked_managed_process_with_environment(
        launch.program(),
        launch.args(),
        Path::new(cwd),
        provider_process_directory,
        session_id,
        launch.environment(),
    )
    .map_err(|error| match error {
        termloop_platform::PlatformError::ProcessOwnershipUncertain => {
            crate::AgentResumePreparationError::RuntimeOwnershipUncertain
        }
        termloop_platform::PlatformError::Io(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            crate::AgentResumePreparationError::RuntimeConflict
        }
        _ => crate::AgentResumePreparationError::ProviderRejected,
    })?;
    let bridge = match termloop_agents::CodexAppServerBridge::start(
        upstream_endpoint.clone(),
        session_id.to_owned(),
        runtime_epoch,
        signals,
    ) {
        Ok(bridge) => bridge,
        Err(_) if process.terminate().is_err() => {
            return Err(crate::AgentResumePreparationError::RuntimeOwnershipUncertain);
        }
        Err(_) => return Err(crate::AgentResumePreparationError::ProviderRejected),
    };
    Ok(CodexRuntime {
        process,
        bridge,
        upstream_endpoint,
    })
}

impl TaskWorktreeLaunchPlan {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub(crate) fn worktree_path(&self) -> &str {
        &self.cwd
    }

    pub fn observe(
        self,
        timeout: std::time::Duration,
    ) -> Result<ObservedTaskWorktreeLaunch, CoreError> {
        let path = Path::new(&self.cwd);
        match termloop_platform::path_entry_state(path) {
            Ok(termloop_platform::PathEntryState::Absent) => {
                return Err(self.unavailable(TaskWorktreeUnavailableReason::PathAbsent));
            }
            Ok(termloop_platform::PathEntryState::Present) => {}
            Err(_) => {
                return Err(self.unavailable(TaskWorktreeUnavailableReason::ObservationUnknown));
            }
        }
        let canonical_path = termloop_platform::canonical_existing_directory(&self.cwd)
            .map_err(|_| self.unavailable(TaskWorktreeUnavailableReason::PathReplaced))?;
        let runner =
            GitRunner::discover_with_timeout(timeout).map_err(|error| self.git_error(error))?;
        let observation = runner
            .inspect_worktree_health(path)
            .map_err(|error| self.git_error(error))?;
        if observation.repository.common_dir.to_string_lossy() != self.repository_common_dir {
            return Err(self.unavailable(TaskWorktreeUnavailableReason::ManagedProofMismatch));
        }
        if observation.repository.worktree_root.as_deref() != Some(canonical_path.as_path()) {
            return Err(self.unavailable(TaskWorktreeUnavailableReason::PathReplaced));
        }
        let registration = observation
            .registration
            .as_ref()
            .ok_or_else(|| self.unavailable(TaskWorktreeUnavailableReason::RegistrationAbsent))?;
        let registration_path_matches = matches!(
            &registration.path_state,
            RegisteredPathState::Present { canonical_path: registered } if registered == &canonical_path
        );
        if !registration_path_matches {
            return Err(self.unavailable(TaskWorktreeUnavailableReason::RegistrationMismatch));
        }
        // The checked-out branch and HEAD attachment state never gate
        // Task-scoped launch. A live session in this worktree survives a
        // branch switch or a mid-rebase detached HEAD; a fresh launch is
        // admitted under the same registration and managed-proof identity.
        Ok(ObservedTaskWorktreeLaunch { plan: self })
    }

    fn unavailable(&self, reason: TaskWorktreeUnavailableReason) -> CoreError {
        CoreError::TaskWorktreeUnavailable {
            task_id: self.task_id.clone(),
            reason,
        }
    }

    fn git_error(&self, error: GitError) -> CoreError {
        let reason = match error {
            GitError::PermissionDenied { .. }
            | GitError::CommandFailed {
                kind: GitFailureKind::DubiousOwnership,
                ..
            } => TaskWorktreeUnavailableReason::PermissionDenied,
            GitError::UnsupportedVersion { .. } => TaskWorktreeUnavailableReason::UnsupportedGit,
            GitError::Timeout { .. } => TaskWorktreeUnavailableReason::Timeout,
            GitError::OutputLimitExceeded { .. } => TaskWorktreeUnavailableReason::OutputLimit,
            GitError::NotRepository | GitError::MissingRegistration => {
                TaskWorktreeUnavailableReason::RegistrationAbsent
            }
            GitError::GitUnavailable
            | GitError::CommandFailed { .. }
            | GitError::ParseFailed { .. } => TaskWorktreeUnavailableReason::RepositoryUnavailable,
            _ => TaskWorktreeUnavailableReason::ObservationUnknown,
        };
        self.unavailable(reason)
    }
}

fn launch_directory(params: &Value) -> Result<String, CoreError> {
    let cwd = required_string(params, "cwd")?;
    termloop_platform::canonical_existing_directory(&cwd)
        .map_err(|_| CoreError::InvalidParams("cwd".into()))?
        .into_os_string()
        .into_string()
        .map_err(|_| CoreError::InvalidParams("cwd".into()))
}

#[cfg(test)]
mod tests;
