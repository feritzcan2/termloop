#![forbid(unsafe_code)]

pub mod companion_integrations;
mod configuration_version;
mod context_bank;
mod error;
mod keep_awake;
pub mod mcp_settings;
pub mod project;
mod run_configuration;
mod settings_improvement;
mod skills;
mod task_source;
pub use run_configuration::RunConfigurationImproverBindings;
mod runtime;
pub mod session_launch;
pub mod task_worktree;

pub use companion_integrations::assistant_reset::ProjectAssistantResetCommit;
pub use companion_integrations::assistant_session::ConfirmedStewardWake;
pub use companion_integrations::prompt_improvement::{
    AssistantPromptImproverBindings, AssistantPromptSurface,
};
pub use companion_integrations::steward::{
    AssistantAvailability, StewardConfigurationUpdate, StewardTaskAgentAssignmentState,
    StewardTaskAgentStartPlan,
};
pub use configuration_version::{
    ConfigurationApplicationEffects, ConfigurationApplicationPlan, target_kind_wire,
};
pub use context_bank::{
    ContextBankCatalogPlan, ContextBankFilePlan, ContextBankSiblingConflictPlan,
};
pub use error::{
    AgentForkUnavailableReason, CoreError, ProjectDeleteBlocker,
    ProviderHistoryRepairUnavailableReason, TaskAgentStartStage, TaskAgentStartSuggestedAction,
    TaskWorktreeUnavailableReason,
};
pub(crate) use error::{json_error, required_string, store_error, terminal_error};
pub use mcp_settings::{McpToolCatalogEntry, McpToolDescriptions, McpToolRole};
pub use runtime::generated_input_delivery::{
    GeneratedInputDeliveryCancelCause, GeneratedInputDeliveryDiagnostics,
    GeneratedInputDeliveryFailure, GeneratedInputDeliveryState, GeneratedInputRuntimeEvent,
};
pub use session_launch::archive::SessionArchiveRetirementPlan;
pub use session_launch::{
    AgentLaunchPlan, AgentResumeCandidate, AgentResumeLane, AgentResumePlan,
    AgentResumePlanOutcome, AgentResumePreparationError, AgentResumeTargetValidation, CodexRuntime,
    McpAuthorizer, McpPrincipal, ObservedSessionRelocationPreview, ObservedTaskWorktreeLaunch,
    SessionRelocationPreviewOutcome, SessionRelocationPreviewPlan, TaskWorktreeLaunchPlan,
};
pub use settings_improvement::{SettingsImproverEntry, settings_entry_kind};
pub use skills::{SkillCatalogPlan, SkillDeploymentAgent, SkillDeploymentPlan};
pub use task_source::{
    JiraTaskSourceRefreshObserver, TaskSourceBoard, TaskSourceBoardList, TaskSourceBoardObserver,
    TaskSourceBoardSelection, TaskSourceCandidateSnapshot, TaskSourceCandidateView,
    TaskSourceConfiguration, TaskSourceDelete, TaskSourceFailure, TaskSourceImport,
    TaskSourceImportPolicy, TaskSourceJiraObserver, TaskSourceMutation, TaskSourceRefreshApply,
    TaskSourceRefreshObserver, TaskSourceRefreshOutcome, TaskSourceRefreshPlan,
    TaskSourceRuntimeStatus, TaskSourceStatus, TaskSourceStatusList, TaskSourceStatusSelection,
    TaskSourceView, UnavailableTaskSourceRefreshObserver, task_source_candidate_json,
    task_source_failure_wire, task_source_view_json,
};
pub use task_worktree::archive::TaskArchiveRetirementPlan;
pub use task_worktree::{
    ExecutedTaskWorktreeProvisioningStep, ObservedTaskBranchBinding,
    ObservedTaskWorktreeProvisioning, ObservedTaskWorktreeProvisioningDismissal,
    TaskBranchBindingPlan, TaskWorktreeProvisioningDismissPlan, TaskWorktreeProvisioningPlan,
    TaskWorktreeProvisioningProgress, TaskWorktreeProvisioningStep, managed_task_checkout_names,
};
pub use termloop_domain::McpToolName;
pub use termloop_domain::ProjectTaskAutomationConfiguration;
pub use termloop_domain::RoutineActionHandling;
pub use termloop_domain::RoutineTriggerMode;
pub use termloop_domain::{ImproverSessionTarget, ImproverSessionTargetKind};
/// Re-exported so the daemon composition root can map the keep-awake
/// preference onto its generated contract shape without depending on `domain`.
pub use termloop_domain::{KeepAwakeMode, KeepAwakePreference};
pub use termloop_invocation::SettingsEntryKind;
pub use termloop_providers::{OpenAiVoiceService as VoiceService, VoiceProviderError};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc::{Receiver, Sender};
use termloop_agents::{AgentObservation, AgentSignalSource, AgentState};
use termloop_store::{CoreWriteAuthority, Store};
use termloop_terminal::TerminalService;

pub type AgentRuntimeSignal = termloop_agents::AgentRuntimeSignal;
pub type AgentRuntimeEvent = termloop_agents::AgentRuntimeEvent;
pub type AgentPlan = termloop_agents::AgentPlan;
pub type AgentPlanUpdate = termloop_agents::AgentPlanUpdate;
pub type AgentPlanSource = termloop_agents::AgentPlanSource;
pub type AgentPlanStep = termloop_agents::AgentPlanStep;
pub type AgentPlanStepStatus = termloop_agents::AgentPlanStepStatus;
pub type ObservationCapability = termloop_agents::ObservationCapability;
pub type ProviderHookObservationInput = termloop_agents::ProviderHookObservationInput;
pub type ProviderHookSettings = termloop_agents::ProviderHookSettings;
pub type ProviderHookSettingsDelivery = termloop_agents::ProviderHookSettingsDelivery;
pub type ResumeFailureReason = termloop_domain::ResumeFailureReason;

const MAX_QUEUED_GENERATED_INPUTS_PER_SESSION: usize = 16;
const MAX_QUEUED_GENERATED_INPUTS: usize = 256;

struct PendingGeneratedInputQueue {
    runtime_epoch: u64,
    submissions: VecDeque<termloop_invocation::GeneratedTerminalSubmission>,
}

pub fn normalize_claude_hook_plan(payload: &Value) -> Option<AgentPlanUpdate> {
    termloop_agents::normalize_claude_plan_update(payload)
}

pub fn provider_hook_settings(
    agent_id: &str,
    executable: &std::path::Path,
) -> Result<Option<ProviderHookSettings>, serde_json::Error> {
    termloop_agents::provider_hook_settings(agent_id, executable)
}

pub fn supports_provider_hook_observation(agent_id: &str) -> bool {
    termloop_agents::supports_provider_hook_observation(agent_id)
}

/// Claude hooks never carry the active model, so the hook client reads it from
/// the bounded transcript tail the payload already points at.
pub fn normalize_claude_transcript_model(tail: &str, native_session_id: &str) -> Option<String> {
    termloop_agents::normalize_claude_transcript_model(tail, native_session_id)
}

/// Claude fires no hook for a user interrupt either, so the daemon asks the
/// same bounded tail whether the exact running turn was cut off.
pub fn claude_turn_interrupted(tail: &str, native_session_id: &str, prompt_id: &str) -> bool {
    termloop_agents::claude_turn_interrupted(tail, native_session_id, prompt_id)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDaemonRestartHandoff {
    pub session_id: String,
    pub agent_id: String,
    pub runtime_epoch: u64,
}

pub struct CoreRuntime {
    pub(crate) store: Store,
    pub(crate) write_authority: CoreWriteAuthority,
    pub(crate) terminal: TerminalService,
    pub(crate) runtime_epoch: u64,
    pub(crate) observation_transport: Option<AgentObservationTransport>,
    pub(crate) agent_observations: HashMap<String, AgentObservationCapability>,
    pub(crate) provider_observation_ingress:
        runtime::provider_observation_ingress::ProviderObservationIngress,
    pub(crate) daemon_restart_handoffs: HashMap<String, AgentDaemonRestartHandoff>,
    pub(crate) mcp_authorizer: session_launch::McpAuthorizer,
    pub(crate) mcp_tool_catalog: Vec<McpToolCatalogEntry>,
    pub(crate) mcp_tool_descriptions: McpToolDescriptions,
    pub(crate) ask_to_requests: HashMap<String, session_launch::ask_to::AskToRequest>,
    pub(crate) ask_to_by_source: HashMap<String, String>,
    pub(crate) ask_to_conversations: HashMap<String, session_launch::ask_to::AskToConversation>,
    pub(crate) ask_to_delivery_completions:
        HashMap<String, session_launch::ask_to::AskToGeneratedInputCompletion>,
    pub(crate) agent_conversation_activity: HashSet<String>,
    pub(crate) agent_runtime_signals: Option<Receiver<AgentRuntimeSignal>>,
    pub(crate) agent_runtime_sender: Sender<AgentRuntimeSignal>,
    pub(crate) generated_input_deliveries:
        runtime::generated_input_delivery::GeneratedInputDeliveryRuntime,
    pending_generated_input_queues: HashMap<String, PendingGeneratedInputQueue>,
    pub(crate) pending_assistant_wake_deliveries:
        HashMap<String, companion_integrations::assistant_session::PendingAssistantWakeDelivery>,
    pub(crate) confirmed_steward_wakes: VecDeque<ConfirmedStewardWake>,
    pub(crate) codex_runtimes: HashMap<String, CodexRuntime>,
    /// A reserved Project deletion makes the Project unavailable to every new
    /// or completing launch while the daemon terminates its Session runtimes
    /// outside the serialized core lock.
    pub(crate) project_delete_reservations: HashSet<String>,
    /// A committed Project Assistant reset keeps the Project unavailable until
    /// its exact assistant processes have been reaped, fencing late Builder
    /// launches prepared against the deleted Playbook state.
    pub(crate) project_assistant_reset_reservations: HashSet<String>,
    pub(crate) resume_reservations: HashSet<String>,
    pub(crate) provider_history_repair_reservations: HashSet<String>,
    pub(crate) resume_ready: HashSet<String>,
    /// Resume teardown runs outside the serialized Core lock. Entries here
    /// keep the terminal exit reconciler from reclassifying that intentional
    /// PTY reap before the exact typed failure is committed.
    pub(crate) resume_failure_reaps: HashSet<String>,
    pub(crate) pending_agent_forks: HashSet<String>,
    /// Runtime-only fork presentation provenance. Native fork deliberately
    /// does not create durable parentage; this bounded map lets the current
    /// projection keep the child directly beneath its source while both are
    /// present in this daemon runtime.
    pub(crate) fork_source_session_ids: HashMap<String, String>,
    /// Agent commands may exit while the user still needs the PTY as an
    /// interactive terminal. These runtime-only entries identify replacement
    /// shells that keep the exact logical Session open until Retry or an
    /// explicit close retires them.
    pub(crate) agent_terminal_holds: HashSet<String>,
    pub(crate) pending_agent_resume_refs: HashMap<String, termloop_domain::ResumeRef>,
    pub(crate) quick_action_previews: VecDeque<(String, session_launch::QuickActionPreviewTicket)>,
    pub(crate) agent_launch_previews: VecDeque<(String, session_launch::AgentLaunchPreviewTicket)>,
    pub(crate) agent_resume_previews: VecDeque<(String, session_launch::AgentResumePreviewTicket)>,
    pub(crate) session_history: session_launch::session_history::SessionHistoryRuntime,
    pub(crate) session_relocation_previews:
        VecDeque<(String, session_launch::SessionRelocationPreviewTicket)>,
    pub(crate) session_archive_previews:
        VecDeque<(String, session_launch::archive::SessionArchivePreviewTicket)>,
    pub(crate) task_archive_previews:
        VecDeque<(String, task_worktree::archive::TaskArchivePreviewTicket)>,
    pub(crate) resume_shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(crate) worktree_projections: task_worktree::WorktreeProjectionCache,
    pub(crate) worktree_change_observations: task_worktree::WorktreeChangeObservationCache,
    pub(crate) project_change_observations: project::ProjectChangeObservationCache,
    pub(crate) branch_commit_summaries: task_worktree::BranchCommitSummaryCache,
    pub(crate) branch_commit_observations: task_worktree::BranchCommitObservationCache,
    pub(crate) provider_cache: termloop_store::ProviderCacheHandle,
    pub(crate) github_client: Option<termloop_providers::GitHubClient>,
    pub(crate) azure_devops_client: Option<termloop_providers::AzureDevOpsClient>,
    pub(crate) git_host_local_facts: companion_integrations::GitHostLocalFactsCache,
    pub(crate) git_host_projections: companion_integrations::GitHostSemanticCache,
    pub(crate) git_host_change_observations:
        companion_integrations::pull_request_changes::PullRequestChangeObservationCache,
    pub(crate) git_host_invalidated_tasks: VecDeque<String>,
    pub(crate) tracker_runtime: companion_integrations::tracker_runtime::TrackerRuntimeState,
    pub(crate) task_source_runtime: task_source::TaskSourceRuntimeState,
    pub(crate) run_runtimes: HashMap<String, run_configuration::RunRuntimeObservation>,
    /// Claude reports a user interrupt through no hook at all, so a working
    /// turn keeps the bounded pointers needed to ask its transcript whether it
    /// was cut off. Runtime-only: a restarted daemon re-learns them from the
    /// next prompt.
    pub(crate) claude_turn_watches: HashMap<String, ClaudeTurnWatch>,
}

/// Core's own bound on the hook-only prompt identity. The wire bound is
/// declared separately in the contract; neither trusts the other.
const MAX_CLAUDE_PROMPT_ID_BYTES: usize = 128;

#[derive(Debug, Clone)]
pub(crate) struct ClaudeTurnWatch {
    pub runtime_epoch: u64,
    pub transcript_path: std::path::PathBuf,
    pub prompt_id: String,
}

/// One bounded transcript question, planned under the core lock and answered
/// outside it.
#[derive(Debug, Clone)]
pub struct ClaudeInterruptCheck {
    pub session_id: String,
    pub transcript_path: std::path::PathBuf,
    pub native_session_id: String,
    pub prompt_id: String,
}

#[derive(Clone)]
pub struct AgentObservationTransport {
    pub endpoint: String,
    pub provider_process_directory: std::path::PathBuf,
    pub agents: HashMap<String, AgentRuntimeCapabilities>,
    pub mcp_endpoint: String,
    pub claude_mcp_config_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentObservationRuntimeTransport {
    None,
    LaunchScopedConfig(AgentLaunchScopedConfig),
    DaemonOwnedBridge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLaunchScopedConfig {
    InlineSettings {
        content: String,
        inspectable_content: String,
    },
    EnvironmentSettingsPath {
        variable: String,
        path: String,
        content: String,
        inspectable_content: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRuntimeCapabilities {
    pub observation: AgentObservationRuntimeTransport,
    pub fresh_session_id_supported: bool,
    pub resume_supported: bool,
    pub native_fork_supported: bool,
    pub mcp_http_supported: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordedProviderHookObservation {
    pub status_changed: bool,
    pub session_changed: bool,
    pub provider_session_replaced: bool,
    pub session_started: bool,
}

impl AgentRuntimeCapabilities {
    pub fn launch_only() -> Self {
        Self {
            observation: AgentObservationRuntimeTransport::None,
            fresh_session_id_supported: false,
            resume_supported: false,
            native_fork_supported: false,
            mcp_http_supported: false,
        }
    }
}

impl AgentObservationTransport {
    pub fn capability(&self, agent_id: &str) -> Option<&AgentRuntimeCapabilities> {
        self.agents.get(agent_id)
    }

    pub fn observation_supported(&self, agent_id: &str) -> bool {
        self.capability(agent_id).is_some_and(|capability| {
            capability.observation != AgentObservationRuntimeTransport::None
        })
    }

    pub fn launch_scoped_observation_supported(&self, agent_id: &str) -> bool {
        self.capability(agent_id).is_some_and(|capability| {
            matches!(
                capability.observation,
                AgentObservationRuntimeTransport::LaunchScopedConfig(_)
            )
        })
    }

    pub fn daemon_owned_bridge_supported(&self, agent_id: &str) -> bool {
        self.capability(agent_id).is_some_and(|capability| {
            capability.observation == AgentObservationRuntimeTransport::DaemonOwnedBridge
        })
    }

    pub fn resume_supported(&self, agent_id: &str) -> bool {
        self.capability(agent_id)
            .is_some_and(|capability| capability.resume_supported)
    }

    pub fn native_fork_supported(&self, agent_id: &str) -> bool {
        self.capability(agent_id)
            .is_some_and(|capability| capability.native_fork_supported)
    }

    pub fn mcp_http_supported(&self, agent_id: &str) -> bool {
        self.capability(agent_id)
            .is_some_and(|capability| capability.mcp_http_supported)
    }

    pub fn invocation_observation<'a>(
        &'a self,
        agent_id: &str,
        session_id: &'a str,
        token: Option<&'a str>,
        daemon_bridge_endpoint: Option<&'a str>,
    ) -> Option<termloop_invocation::AgentObservationLaunch<'a>> {
        let capability = self.capability(agent_id)?;
        let transport = match &capability.observation {
            AgentObservationRuntimeTransport::None => return None,
            AgentObservationRuntimeTransport::LaunchScopedConfig(config) => {
                let token = token?;
                let transport = match config {
                    AgentLaunchScopedConfig::InlineSettings {
                        content,
                        inspectable_content,
                    } => termloop_invocation::AgentObservationLaunchTransport::InlineSettings {
                        content,
                        inspectable_content,
                    },
                    AgentLaunchScopedConfig::EnvironmentSettingsPath {
                        variable,
                        path,
                        content,
                        inspectable_content,
                    } => {
                        termloop_invocation::AgentObservationLaunchTransport::EnvironmentSettingsPath {
                            variable,
                            path,
                            content,
                            inspectable_content,
                        }
                    }
                };
                return Some(termloop_invocation::AgentObservationLaunch {
                    session_id,
                    endpoint: &self.endpoint,
                    token,
                    transport,
                });
            }
            AgentObservationRuntimeTransport::DaemonOwnedBridge => {
                termloop_invocation::AgentObservationLaunchTransport::DaemonOwnedBridge {
                    endpoint: daemon_bridge_endpoint?,
                }
            }
        };
        Some(termloop_invocation::AgentObservationLaunch {
            session_id,
            endpoint: &self.endpoint,
            token: "",
            transport,
        })
    }

    #[cfg(test)]
    pub(crate) fn replace_test_inline_settings(
        &mut self,
        agent_id: &str,
        content: &str,
        inspectable_content: &str,
    ) {
        let capability = self
            .agents
            .get_mut(agent_id)
            .expect("test provider capability exists");
        capability.observation = AgentObservationRuntimeTransport::LaunchScopedConfig(
            AgentLaunchScopedConfig::InlineSettings {
                content: content.into(),
                inspectable_content: inspectable_content.into(),
            },
        );
    }
}

#[cfg(test)]
pub(crate) fn test_agent_observation_transport(
    provider_process_directory: std::path::PathBuf,
) -> AgentObservationTransport {
    test_agent_observation_transport_with_claude_settings(
        provider_process_directory,
        "{\"hooks\":{}}",
        "{\"hooks\":{}}",
    )
}

#[cfg(test)]
pub(crate) fn test_agent_observation_transport_with_claude_settings(
    provider_process_directory: std::path::PathBuf,
    content: &str,
    inspectable_content: &str,
) -> AgentObservationTransport {
    AgentObservationTransport {
        endpoint: "http://127.0.0.1:1/agent-observation".into(),
        provider_process_directory,
        agents: HashMap::from([
            (
                "claude".into(),
                AgentRuntimeCapabilities {
                    observation: AgentObservationRuntimeTransport::LaunchScopedConfig(
                        AgentLaunchScopedConfig::InlineSettings {
                            content: content.into(),
                            inspectable_content: inspectable_content.into(),
                        },
                    ),
                    fresh_session_id_supported: true,
                    resume_supported: true,
                    native_fork_supported: true,
                    mcp_http_supported: true,
                },
            ),
            (
                "codex".into(),
                AgentRuntimeCapabilities {
                    observation: AgentObservationRuntimeTransport::DaemonOwnedBridge,
                    fresh_session_id_supported: false,
                    resume_supported: true,
                    native_fork_supported: true,
                    mcp_http_supported: true,
                },
            ),
            (
                "gemini".into(),
                AgentRuntimeCapabilities {
                    observation: AgentObservationRuntimeTransport::LaunchScopedConfig(
                        AgentLaunchScopedConfig::EnvironmentSettingsPath {
                            variable: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH".into(),
                            path: "/tmp/gemini-observation.json".into(),
                            content: "{\"hooks\":{}}".into(),
                            inspectable_content: "{\"hooks\":{}}".into(),
                        },
                    ),
                    fresh_session_id_supported: false,
                    resume_supported: false,
                    native_fork_supported: false,
                    mcp_http_supported: false,
                },
            ),
        ]),
        mcp_endpoint: "http://127.0.0.1:1/mcp".into(),
        claude_mcp_config_path: "/tmp/mcp.json".into(),
    }
}

pub(crate) struct AgentObservationCapability {
    pub token: Option<String>,
    pub runtime_epoch: u64,
    pub observation: Option<AgentObservation>,
    pub last_signal: Option<termloop_agents::AgentSignal>,
    // Agent TUIs may flush PTY input while entering interactive mode. Keep the
    // exact invocation-owned bytes runtime-only until authenticated structured
    // provider state proves that the composer is idle, then consume them once.
    pub pending_generated_input: Option<termloop_invocation::GeneratedTerminalSubmission>,
    pub defer_generated_input_until_hook_response: bool,
    pub last_notification_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredAgentCapabilities {
    pub agent_id: String,
    pub label: String,
    pub available: bool,
    pub version: Option<String>,
    pub integration_level: String,
    pub degraded_reason: Option<String>,
    pub models: Vec<String>,
    pub permissions: Vec<String>,
    pub reasoning: Vec<String>,
    pub observation_supported: bool,
    pub quick_action_supported: bool,
    pub tracked_helpers_supported: bool,
    pub observation: ObservationCapability,
    pub fresh_session_id_supported: bool,
    pub resume_supported: bool,
    pub native_fork_supported: bool,
    pub mcp_http_supported: bool,
}

pub fn discover_agent_capabilities() -> Vec<DiscoveredAgentCapabilities> {
    termloop_agents::agent_catalog()
        .iter()
        .map(|descriptor| termloop_agents::discover_capabilities(descriptor.id))
        .map(|capability| {
            let descriptor = termloop_agents::agent_descriptor(&capability.agent_id)
                .expect("discovery iterates the same catalog");
            DiscoveredAgentCapabilities {
                agent_id: capability.agent_id.clone(),
                label: descriptor.label.into(),
                available: capability.available,
                version: capability.version.clone(),
                integration_level: capability.integration_level().as_str().into(),
                degraded_reason: capability
                    .degraded_reason()
                    .map(|reason| reason.as_str().into()),
                models: descriptor
                    .models
                    .iter()
                    .map(|value| (*value).into())
                    .collect(),
                permissions: descriptor
                    .permissions
                    .iter()
                    .map(|value| (*value).into())
                    .collect(),
                reasoning: descriptor
                    .reasoning
                    .iter()
                    .map(|value| (*value).into())
                    .collect(),
                observation_supported: capability.observation
                    != termloop_agents::ObservationCapability::None,
                quick_action_supported: capability.quick_action_supported(),
                tracked_helpers_supported: capability.tracked_helpers_supported(),
                observation: capability.observation,
                fresh_session_id_supported: capability.fresh_session_id_supported,
                resume_supported: capability.resume_supported,
                native_fork_supported: capability.native_fork_supported,
                mcp_http_supported: capability.mcp_http_supported,
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn test_generated_terminal_submission(
    content: &str,
) -> termloop_invocation::GeneratedTerminalSubmission {
    termloop_invocation::quick_action_agent_for_conversation(
        "codex",
        ".",
        "default",
        "default",
        "default",
        content,
        termloop_invocation::AgentConversationLaunch::Fresh { resume_ref: None },
        None,
        None,
    )
    .unwrap()
    .initial_input_submission()
    .unwrap()
}

fn same_generated_terminal_submission(
    left: &termloop_invocation::GeneratedTerminalSubmission,
    right: &termloop_invocation::GeneratedTerminalSubmission,
) -> bool {
    left.provenance() == right.provenance()
        && left.paste_input() == right.paste_input()
        && left.submit_input() == right.submit_input()
}

impl CoreRuntime {
    pub fn open(
        state_path: impl Into<std::path::PathBuf>,
        terminal: TerminalService,
        runtime_epoch: u64,
    ) -> Result<Self, CoreError> {
        let store = Store::open(state_path).map_err(store_error)?;
        Self::new(
            store,
            termloop_store::issue_core_write_authority_for_composition(),
            terminal,
            runtime_epoch,
        )
    }

    pub fn new(
        mut store: Store,
        write_authority: CoreWriteAuthority,
        terminal: TerminalService,
        runtime_epoch: u64,
    ) -> Result<Self, CoreError> {
        store
            .reconcile_session_relocations(&write_authority)
            .map_err(store_error)?;
        store
            .reconcile_restart(&write_authority)
            .map_err(store_error)?;
        let provider_cache = store.open_provider_cache().map_err(store_error)?;
        let (agent_runtime_sender, agent_runtime_signals) = std::sync::mpsc::channel();
        let (ask_to_requests, ask_to_by_source, ask_to_conversations) =
            session_launch::ask_to::restore_ask_to_maps(store.sessions())?;
        let mut runtime = Self {
            store,
            write_authority,
            terminal,
            runtime_epoch,
            observation_transport: None,
            agent_observations: HashMap::new(),
            provider_observation_ingress:
                runtime::provider_observation_ingress::ProviderObservationIngress::default(),
            daemon_restart_handoffs: HashMap::new(),
            mcp_authorizer: session_launch::McpAuthorizer::default(),
            mcp_tool_catalog: Vec::new(),
            mcp_tool_descriptions: McpToolDescriptions::default(),
            ask_to_requests,
            ask_to_by_source,
            ask_to_conversations,
            ask_to_delivery_completions: HashMap::new(),
            agent_conversation_activity: HashSet::new(),
            agent_runtime_signals: Some(agent_runtime_signals),
            agent_runtime_sender,
            generated_input_deliveries:
                runtime::generated_input_delivery::GeneratedInputDeliveryRuntime::default(),
            pending_generated_input_queues: HashMap::new(),
            pending_assistant_wake_deliveries: HashMap::new(),
            confirmed_steward_wakes: VecDeque::new(),
            codex_runtimes: HashMap::new(),
            project_delete_reservations: HashSet::new(),
            project_assistant_reset_reservations: HashSet::new(),
            resume_reservations: HashSet::new(),
            provider_history_repair_reservations: HashSet::new(),
            resume_ready: HashSet::new(),
            resume_failure_reaps: HashSet::new(),
            pending_agent_forks: HashSet::new(),
            fork_source_session_ids: HashMap::new(),
            agent_terminal_holds: HashSet::new(),
            pending_agent_resume_refs: HashMap::new(),
            quick_action_previews: VecDeque::new(),
            agent_launch_previews: VecDeque::new(),
            agent_resume_previews: VecDeque::new(),
            session_history: session_launch::session_history::SessionHistoryRuntime::default(),
            session_relocation_previews: VecDeque::new(),
            session_archive_previews: VecDeque::new(),
            task_archive_previews: VecDeque::new(),
            resume_shutdown: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            worktree_projections: task_worktree::WorktreeProjectionCache::default(),
            worktree_change_observations: task_worktree::WorktreeChangeObservationCache::default(),
            project_change_observations: project::ProjectChangeObservationCache::default(),
            branch_commit_summaries: task_worktree::BranchCommitSummaryCache::default(),
            branch_commit_observations: task_worktree::BranchCommitObservationCache::default(),
            provider_cache,
            github_client: None,
            azure_devops_client: None,
            git_host_local_facts: companion_integrations::GitHostLocalFactsCache::default(),
            git_host_projections: companion_integrations::GitHostSemanticCache::default(),
            git_host_change_observations:
                companion_integrations::pull_request_changes::PullRequestChangeObservationCache::default(),
            git_host_invalidated_tasks: VecDeque::new(),
            tracker_runtime: companion_integrations::tracker_runtime::TrackerRuntimeState::default(),
            task_source_runtime: task_source::TaskSourceRuntimeState::default(),
            run_runtimes: HashMap::new(),
            claude_turn_watches: HashMap::new(),
        };
        runtime.reconcile_expired_deleted_sessions();
        runtime.reconcile_session_archive_operations();
        runtime.reconcile_task_archive_operations();
        runtime.reconcile_task_worktree_operations();
        runtime.reconcile_task_worktree_cleanup_operations();
        runtime.reconcile_task_worktree_repair_operations();
        runtime.reconcile_task_worktree_stale_resolution_operations();
        Ok(runtime)
    }

    pub fn terminal_service(&self) -> TerminalService {
        self.terminal.clone()
    }

    pub fn state_revision(&self) -> u64 {
        self.store.revision()
    }

    pub fn runtime_epoch(&self) -> u64 {
        self.runtime_epoch
    }

    pub fn configure_agent_observations(&mut self, transport: AgentObservationTransport) {
        self.github_client = Some(termloop_providers::GitHubClient::new(
            transport.provider_process_directory.clone(),
        ));
        self.azure_devops_client = Some(termloop_providers::AzureDevOpsClient::new(
            transport.provider_process_directory.clone(),
        ));
        self.observation_transport = Some(transport);
    }

    pub fn configure_resume_shutdown(
        &mut self,
        shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        self.resume_shutdown = shutdown;
    }

    pub fn record_provider_hook_observation(
        &mut self,
        token: &str,
        session_id: &str,
        input: ProviderHookObservationInput,
        sequence: u64,
        observed_at_epoch_ms: u64,
    ) -> Result<RecordedProviderHookObservation, CoreError> {
        let durable_session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.kind == termloop_domain::SessionKind::Agent
                    && (session.lifecycle_state == "running"
                        || (session.lifecycle_state == "resuming"
                            && self.resume_reservations.contains(session_id)))
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        self.authorized_agent_observation(session_id, token)?;
        if !self
            .provider_observation_ingress
            .admit(session_id, observed_at_epoch_ms)
        {
            return Err(CoreError::CapabilityDenied);
        }
        let agent_id = durable_session
            .process
            .agent_id
            .as_deref()
            .ok_or(CoreError::CapabilityDenied)?;
        if !self
            .observation_transport
            .as_ref()
            .is_some_and(|transport| transport.launch_scoped_observation_supported(agent_id))
        {
            return Err(CoreError::CapabilityDenied);
        }
        let hook_notification_type = (input.event_name == "Notification")
            .then(|| input.notification_type.as_deref().map(bounded_hook_label))
            .flatten();
        let normalized = termloop_agents::normalize_provider_hook_observation(agent_id, input)
            .ok_or_else(|| CoreError::InvalidParams("eventName".into()))?;
        if normalized.ingress != termloop_agents::ProviderObservationIngress::LaunchScopedHook
            || normalized.source != AgentSignalSource::Hook
        {
            return Err(CoreError::CapabilityDenied);
        }
        let signal = normalized.signal;
        let plan_changed = if let Some(plan) = normalized.plan {
            let mut current_plan = self
                .store
                .agent_plans()
                .iter()
                .find(|current| current.session_id == session_id)
                .cloned();
            let changed =
                apply_claude_plan_update(&mut current_plan, session_id, plan, observed_at_epoch_ms);
            if changed {
                persist_agent_plan(
                    &mut self.store,
                    &self.write_authority,
                    session_id,
                    current_plan,
                )?;
            }
            changed
        } else {
            false
        };
        let readiness_changed = signal == termloop_agents::AgentSignal::PromptSubmitted
            && self.record_agent_conversation_activity(session_id)?;
        let capability = self
            .agent_observations
            .get_mut(session_id)
            .expect("authenticated observation capability remains present");
        let resume_started = signal == termloop_agents::AgentSignal::SessionStarted;
        let previous = capability.observation;
        let next = termloop_agents::reduce_observation(
            previous,
            signal,
            AgentSignalSource::Hook,
            sequence,
            observed_at_epoch_ms,
        );
        capability.observation = Some(next);
        capability.last_signal = Some(signal);
        capability.last_notification_type = hook_notification_type;
        let defer_generated_input_until_hook_response =
            resume_started && capability.pending_generated_input.is_some();
        if defer_generated_input_until_hook_response {
            capability.defer_generated_input_until_hook_response = true;
        }
        let capability_runtime_epoch = capability.runtime_epoch;
        let generated_input_confirmed = if signal == termloop_agents::AgentSignal::PromptSubmitted {
            self.confirm_generated_input_submission(
                session_id,
                capability_runtime_epoch,
                next.sequence,
            )?
        } else {
            false
        };
        let generated_input_progress_confirmed = if provider_signal_proves_turn_progress(signal) {
            self.confirm_generated_input_progress(
                session_id,
                capability_runtime_epoch,
                next.sequence,
            )?
        } else {
            false
        };
        // The interrupt question only applies to a turn that is still running.
        // Any other outcome answers it authoritatively, so the watch retires
        // rather than lingering to be re-asked every ten seconds. Compaction is
        // not an outcome: an auto compact happens inside the turn, which
        // resumes and can still be interrupted afterwards.
        if !turn_is_running(next.state) {
            self.claude_turn_watches.remove(session_id);
        }
        if resume_started
            && self.resume_reservations.contains(session_id)
            && self
                .observation_transport
                .as_ref()
                .is_some_and(|transport| transport.resume_supported(agent_id))
        {
            self.resume_ready.insert(session_id.to_owned());
        }
        let status_changed = observation_projection_changed(previous, next)
            || plan_changed
            || readiness_changed
            || generated_input_confirmed
            || generated_input_progress_confirmed;
        // Every fresh/resumed hook-observed launch reaches this callback from
        // the synchronous SessionStart hook itself. Delivering any initial
        // prompt before that response leaves the daemon can put its paste and
        // Enter into the provider's startup input burst. The server releases
        // the exact pending submission only after the hook response is on the
        // wire; later generated input keeps the ordinary idle path.
        if !defer_generated_input_until_hook_response {
            self.deliver_pending_agent_generated_input(session_id)?;
        }
        if next.state == AgentState::Idle {
            self.try_deliver_ask_to_reply_for_source(session_id);
        }

        let mut session_changed = false;
        let mut provider_session_replaced = false;
        if self
            .observation_transport
            .as_ref()
            .is_some_and(|transport| transport.resume_supported(agent_id))
            && let Some(resume_ref) = normalized.resume_ref.as_ref()
        {
            // Resume persistence is provider-specific. A valid future
            // provider resume fact must never invalidate an otherwise
            // authenticated status observation merely because durable resume
            // support has not been implemented here yet.
            if let (termloop_domain::ResumeProvider::Claude, "claude") =
                (resume_ref.provider, agent_id)
            {
                match self.record_claude_resume_ref(
                    token,
                    session_id,
                    &resume_ref.native_session_id,
                ) {
                    Ok(changed) => session_changed |= changed,
                    Err(CoreError::ResumeRefReplacement) => {
                        provider_session_replaced = true;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        if !provider_session_replaced {
            if let Some(turn_watch) = normalized.turn_watch {
                let _ = self.record_claude_turn_watch(
                    token,
                    session_id,
                    &turn_watch.transcript_path,
                    &turn_watch.prompt_id,
                );
            }
            if let Some(provider_model_id) = normalized.provider_model_id.as_deref() {
                session_changed |= self
                    .record_claude_model_selection(token, session_id, provider_model_id)
                    .unwrap_or(false);
            }
            if let Some(permission_mode) = normalized.permission_mode.as_deref() {
                session_changed |= self
                    .record_claude_permission_selection(token, session_id, permission_mode)
                    .unwrap_or(false);
            }
            if let Some(reasoning_level) = normalized.reasoning_level.as_deref() {
                session_changed |= self
                    .record_claude_reasoning_selection(token, session_id, reasoning_level)
                    .unwrap_or(false);
            }
        }
        Ok(RecordedProviderHookObservation {
            status_changed,
            session_changed,
            provider_session_replaced,
            session_started: resume_started,
        })
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn record_agent_observation(
        &mut self,
        token: &str,
        session_id: &str,
        signal: &str,
        notification_type: Option<&str>,
        plan: Option<AgentPlanUpdate>,
        sequence: u64,
        observed_at_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        self.record_provider_hook_observation(
            token,
            session_id,
            ProviderHookObservationInput {
                event_name: signal.to_owned(),
                notification_type: notification_type.map(str::to_owned),
                native_session_id: None,
                provider_model_id: None,
                permission_mode: None,
                reasoning_level: None,
                transcript_path: None,
                prompt_id: None,
                plan,
            },
            sequence,
            observed_at_epoch_ms,
        )
        .map(|outcome| outcome.status_changed || outcome.session_changed)
    }

    pub fn take_agent_runtime_signals(&mut self) -> Option<Receiver<AgentRuntimeSignal>> {
        self.agent_runtime_signals.take()
    }

    pub fn take_generated_input_runtime_events(
        &mut self,
    ) -> Option<Receiver<GeneratedInputRuntimeEvent>> {
        self.generated_input_deliveries.take_events()
    }

    pub fn record_generated_input_runtime_event(
        &mut self,
        event: GeneratedInputRuntimeEvent,
    ) -> Result<bool, CoreError> {
        let session_id = event.session_id().to_owned();
        let runtime_epoch = event.runtime_epoch();
        let mut changed = self.generated_input_deliveries.apply_transport_event(event);
        let latest_provider_progress = self
            .agent_observations
            .get(&session_id)
            .filter(|capability| capability.runtime_epoch == runtime_epoch)
            .and_then(|capability| {
                capability
                    .last_signal
                    .filter(|signal| provider_signal_proves_turn_progress(*signal))
                    .zip(
                        capability
                            .observation
                            .map(|observation| observation.sequence),
                    )
            });
        if let Some((_, provider_sequence)) = latest_provider_progress {
            changed |= self.generated_input_deliveries.confirm_provider_progress(
                &session_id,
                runtime_epoch,
                provider_sequence,
            );
        }
        self.complete_confirmed_generated_input(&session_id, runtime_epoch, changed)
    }

    pub fn generated_input_delivery_state(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<GeneratedInputDeliveryState> {
        self.generated_input_deliveries
            .state(session_id, runtime_epoch)
    }

    pub fn generated_input_delivery_failure(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<GeneratedInputDeliveryFailure> {
        self.generated_input_deliveries
            .failure(session_id, runtime_epoch)
    }

    pub fn generated_input_delivery_provenance(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Option<&termloop_invocation::Provenance> {
        self.generated_input_deliveries
            .provenance(session_id, runtime_epoch)
    }

    pub fn take_confirmed_steward_wakes(&mut self) -> Vec<ConfirmedStewardWake> {
        let confirmations = self.confirmed_steward_wakes.drain(..).collect::<Vec<_>>();
        for confirmation in &confirmations {
            let session_id = self
                .pending_assistant_wake_deliveries
                .iter()
                .find_map(|(session_id, pending)| match pending {
                    companion_integrations::assistant_session::PendingAssistantWakeDelivery::Steward {
                        project_id,
                        generation,
                        wake_id,
                        confirmation_queued: true,
                        ..
                    } if project_id == &confirmation.project_id
                        && *generation == confirmation.generation
                        && *wake_id == confirmation.wake_id => Some(session_id.clone()),
                    _ => None,
                });
            if let Some(session_id) = session_id {
                self.pending_assistant_wake_deliveries.remove(&session_id);
            }
        }
        confirmations
    }

    pub(crate) fn prune_stale_pending_assistant_wake_deliveries(&mut self) {
        let sessions = self.store.sessions();
        let generated_input_deliveries = &self.generated_input_deliveries;
        let agent_observations = &self.agent_observations;
        let pending_generated_input_queues = &self.pending_generated_input_queues;
        self.pending_assistant_wake_deliveries
            .retain(|session_id, pending| {
                let runtime_epoch = pending.runtime_epoch();
                let submission = pending.submission();
                let session_is_current = pending.session_id() == session_id
                    && sessions.iter().any(|session| {
                        session.id == *session_id
                            && session.runtime_epoch == runtime_epoch
                            && session.lifecycle_state == "running"
                    });
                session_is_current
                    && (generated_input_deliveries.contains_submission(
                        session_id,
                        runtime_epoch,
                        submission,
                    ) || agent_observations
                        .get(session_id)
                        .is_some_and(|capability| {
                            capability.runtime_epoch == runtime_epoch
                                && capability.pending_generated_input.as_ref().is_some_and(
                                    |candidate| {
                                        same_generated_terminal_submission(candidate, submission)
                                    },
                                )
                        })
                        || pending_generated_input_queues
                            .get(session_id)
                            .is_some_and(|queue| {
                                queue.runtime_epoch == runtime_epoch
                                    && queue.submissions.iter().any(|candidate| {
                                        same_generated_terminal_submission(candidate, submission)
                                    })
                            }))
            });
        debug_assert!(self.pending_assistant_wake_deliveries.len() <= 256);
    }

    pub fn record_daemon_bridge_observation(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        signal: termloop_agents::AgentSignal,
        sequence: u64,
        observed_at_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        let durable_session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.kind == termloop_domain::SessionKind::Agent
                    && (session.lifecycle_state == "running"
                        || (session.lifecycle_state == "resuming"
                            && self.resume_reservations.contains(session_id)))
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        let agent_id = durable_session
            .process
            .agent_id
            .as_deref()
            .ok_or(CoreError::CapabilityDenied)?;
        if !self
            .observation_transport
            .as_ref()
            .is_some_and(|transport| transport.daemon_owned_bridge_supported(agent_id))
        {
            return Err(CoreError::CapabilityDenied);
        }
        if self
            .agent_observations
            .get(session_id)
            .is_none_or(|capability| capability.runtime_epoch != runtime_epoch)
        {
            return Err(CoreError::CapabilityDenied);
        }
        let readiness_changed = signal == termloop_agents::AgentSignal::PromptSubmitted
            && self.record_agent_conversation_activity(session_id)?;
        let capability = self
            .agent_observations
            .get_mut(session_id)
            .expect("validated app-server capability remains present");
        let previous = capability.observation;
        let next = termloop_agents::reduce_observation(
            previous,
            signal,
            AgentSignalSource::DaemonBridge,
            sequence,
            observed_at_epoch_ms,
        );
        capability.observation = Some(next);
        capability.last_signal = Some(signal);
        capability.last_notification_type = None;
        let generated_input_confirmed = if signal == termloop_agents::AgentSignal::PromptSubmitted {
            self.confirm_generated_input_submission(session_id, runtime_epoch, next.sequence)?
        } else {
            false
        };
        let generated_input_progress_confirmed = if provider_signal_proves_turn_progress(signal) {
            self.confirm_generated_input_progress(session_id, runtime_epoch, next.sequence)?
        } else {
            false
        };
        // A resumed Codex TUI does not necessarily emit `thread/started`
        // again: the thread identity is already established and the fresh
        // App Server can instead begin with a typed status notification for
        // that thread. Any normalized message received through this
        // attempt-scoped bridge proves that the resumed TUI reached the
        // structured provider surface, so it is the readiness boundary.
        if self.resume_reservations.contains(session_id) {
            self.resume_ready.insert(session_id.to_owned());
        }
        let projection_changed = observation_projection_changed(previous, next)
            || readiness_changed
            || generated_input_confirmed
            || generated_input_progress_confirmed;
        self.deliver_pending_agent_generated_input(session_id)?;
        if next.state == AgentState::Idle {
            self.try_deliver_ask_to_reply_for_source(session_id);
        }
        Ok(projection_changed)
    }

    #[cfg(test)]
    pub fn record_app_server_observation(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        signal: termloop_agents::AgentSignal,
        sequence: u64,
        observed_at_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        self.record_daemon_bridge_observation(
            session_id,
            runtime_epoch,
            signal,
            sequence,
            observed_at_epoch_ms,
        )
    }

    pub fn record_app_server_plan(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        plan: AgentPlan,
        observed_at_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        if plan.source != AgentPlanSource::DaemonOwnedBridge {
            return Err(CoreError::InvalidParams("plan".into()));
        }
        if !self.store.sessions().iter().any(|session| {
            session.id == session_id
                && session.kind == termloop_domain::SessionKind::Agent
                && session.process.agent_id.as_deref() == Some("codex")
                && (session.lifecycle_state == "running"
                    || (session.lifecycle_state == "resuming"
                        && self.resume_reservations.contains(session_id)))
        }) {
            return Err(CoreError::CapabilityDenied);
        }
        if self
            .agent_observations
            .get(session_id)
            .is_none_or(|capability| capability.runtime_epoch != runtime_epoch)
        {
            return Err(CoreError::CapabilityDenied);
        }
        let durable = durable_agent_plan(session_id, &plan, observed_at_epoch_ms);
        if durable.steps.is_empty() {
            let had_plan = self
                .store
                .agent_plans()
                .iter()
                .any(|current| current.session_id == session_id);
            if had_plan {
                self.store
                    .clear_agent_plan(&self.write_authority, session_id)
                    .map_err(store_error)?;
            }
            return Ok(had_plan);
        }
        if self.store.agent_plans().iter().any(|current| {
            current.session_id == session_id && agent_plan_content_equal(current, &durable)
        }) {
            return Ok(false);
        }
        self.store
            .replace_agent_plan(&self.write_authority, durable)
            .map_err(store_error)?;
        Ok(true)
    }

    pub(crate) fn submit_generated_terminal_input(
        &mut self,
        session_id: &str,
        submission: termloop_invocation::GeneratedTerminalSubmission,
    ) -> Result<(), CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.kind == termloop_domain::SessionKind::Agent
                    && session.lifecycle_state == "running"
                    && session
                        .process
                        .agent_id
                        .as_deref()
                        .is_some_and(termloop_agents::supports_generated_input_coordination)
            })
            .ok_or(CoreError::NotFound)?;
        let runtime_epoch = session.runtime_epoch;
        if !self
            .terminal
            .session_is_running(session_id, runtime_epoch)
            .map_err(terminal_error)?
        {
            return Err(CoreError::NotFound);
        }
        let capability = self
            .agent_observations
            .get(session_id)
            .filter(|capability| capability.runtime_epoch == runtime_epoch)
            .ok_or(CoreError::ConversationBusy)?;
        if capability.pending_generated_input.is_some()
            || !self
                .generated_input_deliveries
                .accepts_new_submission(session_id, runtime_epoch)
        {
            return self.enqueue_generated_terminal_input(session_id, runtime_epoch, submission);
        }
        let capability = self
            .agent_observations
            .get_mut(session_id)
            .expect("validated generated input capability remains present");
        capability.pending_generated_input = Some(submission);
        capability.defer_generated_input_until_hook_response = false;
        if let Err(error) = self.deliver_pending_agent_generated_input(session_id) {
            if let Some(capability) = self.agent_observations.get_mut(session_id)
                && capability.runtime_epoch == runtime_epoch
            {
                capability.pending_generated_input = None;
            }
            return Err(error);
        }
        Ok(())
    }

    fn enqueue_generated_terminal_input(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        submission: termloop_invocation::GeneratedTerminalSubmission,
    ) -> Result<(), CoreError> {
        self.pending_generated_input_queues
            .retain(|candidate, queue| {
                !queue.submissions.is_empty()
                    && self.store.sessions().iter().any(|session| {
                        session.id == *candidate
                            && session.runtime_epoch == queue.runtime_epoch
                            && session.lifecycle_state == "running"
                    })
            });
        let total_queued = self
            .pending_generated_input_queues
            .values()
            .map(|queue| queue.submissions.len())
            .sum::<usize>();
        let queue = self
            .pending_generated_input_queues
            .entry(session_id.to_owned())
            .or_insert_with(|| PendingGeneratedInputQueue {
                runtime_epoch,
                submissions: VecDeque::new(),
            });
        if queue.runtime_epoch != runtime_epoch {
            queue.runtime_epoch = runtime_epoch;
            queue.submissions.clear();
        }
        if queue.submissions.len() >= MAX_QUEUED_GENERATED_INPUTS_PER_SESSION
            || total_queued >= MAX_QUEUED_GENERATED_INPUTS
        {
            return Err(CoreError::ConversationBusy);
        }
        queue.submissions.push_back(submission);
        Ok(())
    }

    fn promote_queued_generated_terminal_input(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> bool {
        let submission = self
            .pending_generated_input_queues
            .get_mut(session_id)
            .filter(|queue| queue.runtime_epoch == runtime_epoch)
            .and_then(|queue| queue.submissions.pop_front());
        let remove_queue = self
            .pending_generated_input_queues
            .get(session_id)
            .is_some_and(|queue| {
                queue.runtime_epoch != runtime_epoch || queue.submissions.is_empty()
            });
        if remove_queue {
            self.pending_generated_input_queues.remove(session_id);
        }
        let Some(submission) = submission else {
            return false;
        };
        let Some(capability) = self
            .agent_observations
            .get_mut(session_id)
            .filter(|capability| {
                capability.runtime_epoch == runtime_epoch
                    && capability.pending_generated_input.is_none()
            })
        else {
            return false;
        };
        capability.pending_generated_input = Some(submission);
        capability.defer_generated_input_until_hook_response = false;
        true
    }

    fn deliver_pending_agent_generated_input(&mut self, session_id: &str) -> Result<(), CoreError> {
        let Some((
            runtime_epoch,
            provider_sequence_baseline,
            provider_state,
            provider_source,
            provider_signal,
            notification_type,
            submission,
        )) = self
            .agent_observations
            .get(session_id)
            .and_then(|capability| {
                capability
                    .pending_generated_input
                    .as_ref()
                    .map(|submission| {
                        (
                            capability.runtime_epoch,
                            capability
                                .observation
                                .map(|observation| observation.sequence)
                                .unwrap_or(0),
                            capability.observation.map(|observation| observation.state),
                            capability.observation.map(|observation| observation.source),
                            capability.last_signal,
                            capability.last_notification_type.clone(),
                            submission.clone(),
                        )
                    })
            })
        else {
            return Ok(());
        };
        let Some(agent_id) = self.store.sessions().iter().find_map(|session| {
            (session.id == session_id
                && session.runtime_epoch == runtime_epoch
                && session.kind == termloop_domain::SessionKind::Agent)
                .then_some(session.process.agent_id.as_deref())
                .flatten()
        }) else {
            return Err(CoreError::NotFound);
        };
        if let Some(state) = self
            .generated_input_deliveries
            .state(session_id, runtime_epoch)
            && !self
                .generated_input_deliveries
                .can_begin_pending_submission(session_id, runtime_epoch)
        {
            if state == GeneratedInputDeliveryState::WritingPaste
                && provider_state == Some(AgentState::AwaitingInput)
            {
                self.generated_input_deliveries
                    .block_for_unavailable_composer(
                        session_id,
                        runtime_epoch,
                        provider_sequence_baseline,
                        submission,
                        unavailable_composer_cause(provider_state, provider_signal),
                        notification_type.as_deref(),
                    );
            }
            return Ok(());
        }
        let provider_queue_ready = generated_input_may_enter_provider_queue(
            submission.provenance().template_ref.as_str(),
            provider_state,
        );
        let composer_ready =
            generated_input_composer_may_accept(agent_id, provider_state) || provider_queue_ready;
        if !composer_ready {
            if provider_state.is_some() {
                self.generated_input_deliveries
                    .block_for_unavailable_composer(
                        session_id,
                        runtime_epoch,
                        provider_sequence_baseline,
                        submission,
                        unavailable_composer_cause(provider_state, provider_signal),
                        notification_type.as_deref(),
                    );
            }
            return Ok(());
        }
        if !self.generated_input_deliveries.begin(
            &self.terminal,
            session_id,
            runtime_epoch,
            provider_sequence_baseline,
            submission,
            generated_input_settlement(agent_id, provider_source, provider_queue_ready),
        ) {
            return Err(CoreError::ConversationBusy);
        }
        Ok(())
    }

    pub(crate) fn transition_generated_input_runtime_epoch(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> bool {
        self.generated_input_deliveries
            .transition_runtime_epoch(session_id, runtime_epoch)
    }

    fn confirm_generated_input_submission(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        provider_sequence: u64,
    ) -> Result<bool, CoreError> {
        let user_input_activity = self
            .terminal
            .user_input_activity(session_id, runtime_epoch)
            .ok();
        let changed = self.generated_input_deliveries.confirm_provider_submission(
            session_id,
            runtime_epoch,
            provider_sequence,
            user_input_activity,
        );
        self.complete_confirmed_generated_input(session_id, runtime_epoch, changed)
    }

    fn confirm_generated_input_progress(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        provider_sequence: u64,
    ) -> Result<bool, CoreError> {
        let changed = self.generated_input_deliveries.confirm_provider_progress(
            session_id,
            runtime_epoch,
            provider_sequence,
        );
        let changed = self
            .generated_input_deliveries
            .confirm_provider_queue_progress(session_id, runtime_epoch, provider_sequence)
            || changed;
        self.complete_confirmed_generated_input(session_id, runtime_epoch, changed)
    }

    fn complete_confirmed_generated_input(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        mut changed: bool,
    ) -> Result<bool, CoreError> {
        match self
            .generated_input_deliveries
            .state(session_id, runtime_epoch)
        {
            Some(GeneratedInputDeliveryState::Confirmed) => {
                let completion_changed =
                    self.complete_ask_to_generated_input(session_id, runtime_epoch)?;
                let assistant_wake_changed =
                    self.complete_assistant_wake_generated_input(session_id, runtime_epoch);
                if (changed || completion_changed)
                    && let Some(capability) = self.agent_observations.get_mut(session_id)
                    && capability.runtime_epoch == runtime_epoch
                {
                    capability.pending_generated_input = None;
                    capability.defer_generated_input_until_hook_response = false;
                }
                if changed || completion_changed {
                    let promoted =
                        self.promote_queued_generated_terminal_input(session_id, runtime_epoch);
                    if promoted {
                        self.deliver_pending_agent_generated_input(session_id)?;
                    }
                    changed |= promoted;
                }
                changed |= completion_changed;
                changed |= assistant_wake_changed;
            }
            Some(GeneratedInputDeliveryState::ConfirmedUnattributed) if changed => {
                // A newer provider submission proves the terminal is no longer
                // wedged, but user activity means it cannot honestly complete
                // an Ask-To or assignment delivery. Drop only the runtime
                // pending payload so a later explicit submission can proceed.
                if let Some(capability) = self.agent_observations.get_mut(session_id)
                    && capability.runtime_epoch == runtime_epoch
                {
                    capability.pending_generated_input = None;
                    capability.defer_generated_input_until_hook_response = false;
                }
                let promoted =
                    self.promote_queued_generated_terminal_input(session_id, runtime_epoch);
                if promoted {
                    self.deliver_pending_agent_generated_input(session_id)?;
                }
                changed |= promoted;
            }
            _ => {}
        }
        Ok(changed)
    }

    fn complete_assistant_wake_generated_input(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> bool {
        use companion_integrations::assistant_session::PendingAssistantWakeDelivery;

        let Some(pending) = self.pending_assistant_wake_deliveries.get_mut(session_id) else {
            return false;
        };
        if pending.session_id() != session_id || pending.runtime_epoch() != runtime_epoch {
            return false;
        }
        match pending {
            PendingAssistantWakeDelivery::Steward {
                project_id,
                generation,
                wake_id,
                confirmation_queued,
                ..
            } if !*confirmation_queued => {
                self.confirmed_steward_wakes
                    .push_back(ConfirmedStewardWake {
                        project_id: project_id.clone(),
                        generation: *generation,
                        wake_id: *wake_id,
                    });
                *confirmation_queued = true;
                true
            }
            PendingAssistantWakeDelivery::Steward { .. }
            | PendingAssistantWakeDelivery::Worker { .. } => false,
        }
    }

    pub(crate) fn agent_session_runtime_is_current(
        &self,
        session: &termloop_domain::SessionRecord,
    ) -> bool {
        session.lifecycle_state == "running"
            && self
                .agent_observations
                .get(&session.id)
                .is_some_and(|capability| capability.runtime_epoch == session.runtime_epoch)
            && self
                .terminal
                .session_is_running(&session.id, session.runtime_epoch)
                .unwrap_or(false)
    }

    fn record_agent_conversation_activity(&mut self, session_id: &str) -> Result<bool, CoreError> {
        self.agent_conversation_activity
            .insert(session_id.to_owned());
        let has_valid_resume_ref = self.store.sessions().iter().any(|session| {
            session.id == session_id
                && session
                    .resume_ref
                    .as_ref()
                    .is_some_and(termloop_domain::ResumeRef::validate)
        });
        if !has_valid_resume_ref {
            // Codex can report `turn/started` immediately before the adjacent
            // `thread/started` identity event is applied. The RAM marker lets
            // `record_agent_resume_ref` finish the same durable transition.
            return Ok(false);
        }
        let previous_revision = self.store.revision();
        self.store
            .mark_agent_conversation_resumable(&self.write_authority, session_id)
            .map_err(store_error)?;
        Ok(self.store.revision() != previous_revision)
    }

    pub fn record_agent_resume_ref(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        resume_ref: termloop_domain::ResumeRef,
    ) -> Result<bool, CoreError> {
        let session =
            self.store
                .sessions()
                .iter()
                .find(|session| {
                    session.id == session_id
                        && session.kind == termloop_domain::SessionKind::Agent
                        && session.process.agent_id.as_deref() == Some("codex")
                        && ((session.lifecycle_state == "running"
                            && session.runtime_epoch == runtime_epoch)
                            || (session.lifecycle_state == "resuming"
                                && self.resume_reservations.contains(session_id)
                                && self.agent_observations.get(session_id).is_some_and(
                                    |capability| capability.runtime_epoch == runtime_epoch,
                                )))
                })
                .cloned()
                .ok_or(CoreError::CapabilityDenied)?;
        let previous_revision = self.store.revision();
        match session.resume_ref.as_ref() {
            Some(current) if current != &resume_ref && session.lifecycle_state == "running" => {
                self.store
                    .replace_running_session_resume_ref(
                        &self.write_authority,
                        session_id,
                        current,
                        resume_ref,
                    )
                    .map_err(store_error)?;
            }
            _ => {
                self.store
                    .establish_session_resume_ref(&self.write_authority, session_id, resume_ref)
                    .map_err(|error| match error {
                        termloop_store::StoreError::ResumeRefReplacement => {
                            CoreError::ResumeRefReplacement
                        }
                        error => store_error(error),
                    })?;
            }
        }
        if self.agent_conversation_activity.contains(session_id) {
            self.store
                .mark_agent_conversation_resumable(&self.write_authority, session_id)
                .map_err(store_error)?;
        }
        if self.resume_reservations.contains(session_id) {
            self.resume_ready.insert(session_id.to_owned());
        }
        // Identity and composer readiness are separate facts. The App Server
        // bridge normalizes the status carried by `thread/started` (or a later
        // status notification), and only that idle observation may release
        // pending generated input.
        Ok(self.store.revision() != previous_revision)
    }

    pub fn record_codex_thread_settings(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
        observation: termloop_agents::CodexThreadSettingsObservation,
    ) -> Result<bool, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.runtime_epoch == runtime_epoch
                    && session.kind == termloop_domain::SessionKind::Agent
                    && session.process.agent_id.as_deref() == Some("codex")
                    && session.lifecycle_state == "running"
                    && session.resume_ref.as_ref().is_some_and(|resume_ref| {
                        resume_ref.provider == termloop_domain::ResumeProvider::Codex
                            && resume_ref.native_session_id == observation.native_thread_id
                    })
            })
            .ok_or(CoreError::CapabilityDenied)?;
        let resume_ref = session
            .resume_ref
            .clone()
            .ok_or(CoreError::CapabilityDenied)?;
        let mut launch_selection = session.launch_selection.clone();
        if let Some(model) = observation.model {
            launch_selection.model = model;
        }
        launch_selection.permission = observation.permission.as_launch_selection().into();
        if let Some(reasoning) = observation.reasoning {
            launch_selection.reasoning = reasoning;
        }
        termloop_invocation::validate_agent_configuration(
            "codex",
            &launch_selection.model,
            &launch_selection.permission,
            &launch_selection.reasoning,
        )
        .map_err(|_| CoreError::InvalidParams("launchSelection".into()))?;
        let previous_revision = self.store.revision();
        self.store
            .update_running_agent_session_launch_selection(
                &self.write_authority,
                session_id,
                runtime_epoch,
                &resume_ref,
                &launch_selection,
            )
            .map_err(store_error)?;
        Ok(self.store.revision() != previous_revision)
    }

    /// The single authentication gate for every observation a provider process
    /// reports about its own Session: the hook-only token must match the
    /// capability minted for that exact Session.
    fn authorized_agent_observation(
        &self,
        session_id: &str,
        token: &str,
    ) -> Result<&AgentObservationCapability, CoreError> {
        self.agent_observations
            .get(session_id)
            .filter(|value| {
                value
                    .token
                    .as_deref()
                    .is_some_and(|expected| capability_equal(expected.as_bytes(), token.as_bytes()))
            })
            .ok_or(CoreError::CapabilityDenied)
    }

    /// The live Claude conversation behind a Session, or `None` when the
    /// Session is not a running Claude agent with a Claude ResumeRef. Every
    /// transcript-derived observation needs exactly this much identity.
    fn running_claude_agent_session(
        &self,
        session_id: &str,
    ) -> Option<&termloop_domain::SessionRecord> {
        self.store.sessions().iter().find(|session| {
            session.id == session_id
                && session.kind == termloop_domain::SessionKind::Agent
                && session.process.agent_id.as_deref() == Some("claude")
                && session.lifecycle_state == "running"
                && session.resume_ref.as_ref().is_some_and(|resume_ref| {
                    resume_ref.provider == termloop_domain::ResumeProvider::Claude
                })
        })
    }

    pub fn record_claude_resume_ref(
        &mut self,
        token: &str,
        session_id: &str,
        native_session_id: &str,
    ) -> Result<bool, CoreError> {
        let durable_session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.kind == termloop_domain::SessionKind::Agent
                    && session.process.agent_id.as_deref() == Some("claude")
                    && (session.lifecycle_state == "running"
                        || (session.lifecycle_state == "resuming"
                            && self.resume_reservations.contains(session_id)))
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        self.authorized_agent_observation(session_id, token)?;
        let provider_id = uuid::Uuid::parse_str(native_session_id)
            .map_err(|_| CoreError::InvalidParams("nativeSessionId".into()))?
            .to_string();
        let resume_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Claude,
            provider_id,
        )
        .ok_or_else(|| CoreError::InvalidParams("nativeSessionId".into()))?;
        if durable_session.lifecycle_state == "resuming"
            && self.resume_reservations.contains(session_id)
            && let Some(expected) = self.pending_agent_resume_refs.get(session_id)
        {
            return if expected == &resume_ref {
                Ok(false)
            } else {
                Err(CoreError::ResumeRefReplacement)
            };
        }
        let previous_revision = self.store.revision();
        match durable_session.resume_ref.as_ref() {
            // Claude's interactive `/resume` picker changes the provider
            // conversation inside the already-authorized PTY. The hook token
            // still proves the exact logical Session, so retain that Session
            // and CAS its current provider reference just as the Codex thread
            // transition path does. Rejecting this transition terminated the
            // provider immediately after the user selected a conversation and
            // left the rail showing Exited.
            Some(current)
                if current != &resume_ref && durable_session.lifecycle_state == "running" =>
            {
                self.store
                    .replace_running_session_resume_ref(
                        &self.write_authority,
                        &durable_session.id,
                        current,
                        resume_ref,
                    )
                    .map_err(store_error)?;
            }
            Some(current) if current == &resume_ref => {}
            Some(_) => return Err(CoreError::ResumeRefReplacement),
            None => {
                self.store
                    .establish_session_resume_ref(
                        &self.write_authority,
                        &durable_session.id,
                        resume_ref,
                    )
                    .map_err(|error| match error {
                        termloop_store::StoreError::ResumeRefReplacement => {
                            CoreError::ResumeRefReplacement
                        }
                        error => store_error(error),
                    })?;
            }
        }
        Ok(self.store.revision() != previous_revision)
    }

    /// Records the model an in-TUI `/model` left the Claude conversation on.
    /// Without this the launch-time selection would be reasserted as `--model`
    /// on the next resume and silently undo the user's choice.
    pub fn record_claude_model_selection(
        &mut self,
        token: &str,
        session_id: &str,
        provider_model_id: &str,
    ) -> Result<bool, CoreError> {
        let Some(observed) = termloop_agents::claude_observed_model(provider_model_id) else {
            // An unrecognised provider model is not authority to rewrite a
            // stored selection; the observation degrades instead of failing.
            return Ok(false);
        };
        let durable_session = self
            .running_claude_agent_session(session_id)
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        self.authorized_agent_observation(session_id, token)?;
        // `default` passes no `--model`, so Claude's own persisted choice
        // already survives resume and TermLoop must not pin it to a concrete
        // model behind the user's back.
        if durable_session.launch_selection.model == "default"
            || observed.matches_selection(&durable_session.launch_selection.model)
        {
            return Ok(false);
        }
        let resume_ref = durable_session
            .resume_ref
            .clone()
            .ok_or(CoreError::CapabilityDenied)?;
        let mut launch_selection = durable_session.launch_selection.clone();
        launch_selection.model = observed.canonical_selection().to_owned();
        termloop_invocation::validate_agent_configuration(
            "claude",
            &launch_selection.model,
            &launch_selection.permission,
            &launch_selection.reasoning,
        )
        .map_err(|_| CoreError::InvalidParams("launchSelection".into()))?;
        let previous_revision = self.store.revision();
        self.store
            .update_running_agent_session_launch_selection(
                &self.write_authority,
                session_id,
                durable_session.runtime_epoch,
                &resume_ref,
                &launch_selection,
            )
            .map_err(store_error)?;
        Ok(self.store.revision() != previous_revision)
    }

    /// Records the permission mode an in-TUI `Shift+Tab` left the Claude
    /// conversation on. Every resume reapplies the stored selection as
    /// `--permission-mode`, so without this a restart silently undid the user's
    /// switch and reopened the Session in its launch-time mode.
    pub fn record_claude_permission_selection(
        &mut self,
        token: &str,
        session_id: &str,
        permission_mode: &str,
    ) -> Result<bool, CoreError> {
        let Some(observed) = termloop_agents::claude_observed_permission(permission_mode) else {
            // An unrecognised provider mode is not authority to rewrite a
            // stored selection; the observation degrades instead of failing.
            return Ok(false);
        };
        // A persistent Steward launches in the visible `bypassPermissions`
        // mode that its own configuration resolves. An in-TUI switch is not
        // authority to weaken that launch profile, so assistant executors keep
        // their configured mode.
        if self.session_is_persistent_assistant_executor(session_id) {
            return Ok(false);
        }
        let durable_session = self
            .running_claude_agent_session(session_id)
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        self.authorized_agent_observation(session_id, token)?;
        if durable_session.launch_selection.permission == observed {
            return Ok(false);
        }
        let resume_ref = durable_session
            .resume_ref
            .clone()
            .ok_or(CoreError::CapabilityDenied)?;
        let mut launch_selection = durable_session.launch_selection.clone();
        launch_selection.permission = observed.to_owned();
        termloop_invocation::validate_agent_configuration(
            "claude",
            &launch_selection.model,
            &launch_selection.permission,
            &launch_selection.reasoning,
        )
        .map_err(|_| CoreError::InvalidParams("launchSelection".into()))?;
        let previous_revision = self.store.revision();
        self.store
            .update_running_agent_session_launch_selection(
                &self.write_authority,
                session_id,
                durable_session.runtime_epoch,
                &resume_ref,
                &launch_selection,
            )
            .map_err(store_error)?;
        Ok(self.store.revision() != previous_revision)
    }

    /// Records the effort level an in-TUI change left the Claude conversation
    /// on, for the same reason as the permission mode: resume reapplies the
    /// stored selection as `--effort`.
    pub fn record_claude_reasoning_selection(
        &mut self,
        token: &str,
        session_id: &str,
        effort_level: &str,
    ) -> Result<bool, CoreError> {
        let Some(observed) = termloop_agents::claude_observed_reasoning(effort_level) else {
            return Ok(false);
        };
        if self.session_is_persistent_assistant_executor(session_id) {
            return Ok(false);
        }
        let durable_session = self
            .running_claude_agent_session(session_id)
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        self.authorized_agent_observation(session_id, token)?;
        // `default` passes no `--effort`, and the provider reports its own
        // level regardless, so pinning it would invent a selection the user
        // never made.
        if durable_session.launch_selection.reasoning == "default"
            || durable_session.launch_selection.reasoning == observed
        {
            return Ok(false);
        }
        let resume_ref = durable_session
            .resume_ref
            .clone()
            .ok_or(CoreError::CapabilityDenied)?;
        let mut launch_selection = durable_session.launch_selection.clone();
        launch_selection.reasoning = observed.to_owned();
        termloop_invocation::validate_agent_configuration(
            "claude",
            &launch_selection.model,
            &launch_selection.permission,
            &launch_selection.reasoning,
        )
        .map_err(|_| CoreError::InvalidParams("launchSelection".into()))?;
        let previous_revision = self.store.revision();
        self.store
            .update_running_agent_session_launch_selection(
                &self.write_authority,
                session_id,
                durable_session.runtime_epoch,
                &resume_ref,
                &launch_selection,
            )
            .map_err(store_error)?;
        Ok(self.store.revision() != previous_revision)
    }

    /// Whether a Session is the current executor of a persistent Steward or
    /// Worker. Their launch configuration owns the permission and effort modes.
    fn session_is_persistent_assistant_executor(&self, session_id: &str) -> bool {
        self.store
            .steward_configurations()
            .iter()
            .any(|configuration| configuration.executor_session_id.as_deref() == Some(session_id))
            || self
                .store
                .worker_configurations()
                .iter()
                .any(|configuration| {
                    configuration.executor_session_id.as_deref() == Some(session_id)
                })
    }

    /// Remembers which transcript and turn a working Claude Session belongs to.
    /// Claude emits no signal when the user presses `Esc`, so without this the
    /// Session would stay `working` until some later unrelated hook arrived.
    pub fn record_claude_turn_watch(
        &mut self,
        token: &str,
        session_id: &str,
        transcript_path: &str,
        prompt_id: &str,
    ) -> Result<(), CoreError> {
        let runtime_epoch = self
            .authorized_agent_observation(session_id, token)?
            .runtime_epoch;
        let path = std::path::PathBuf::from(transcript_path);
        if !path.is_absolute() || path.extension().is_none_or(|value| value != "jsonl") {
            return Err(CoreError::InvalidParams("transcriptPath".into()));
        }
        if prompt_id.is_empty() || prompt_id.len() > MAX_CLAUDE_PROMPT_ID_BYTES {
            return Err(CoreError::InvalidParams("promptId".into()));
        }
        self.claude_turn_watches.insert(
            session_id.to_owned(),
            ClaudeTurnWatch {
                runtime_epoch,
                transcript_path: path,
                prompt_id: prompt_id.to_owned(),
            },
        );
        Ok(())
    }

    /// Plans the bounded transcript reads for every Claude turn that still
    /// looks like it is working. Reading happens outside the core lock; the
    /// answer comes back through `apply_claude_interrupt_observation`.
    pub fn plan_claude_interrupt_checks(&mut self) -> Vec<ClaudeInterruptCheck> {
        // A watch belongs to one process lifetime: a replaced or retired
        // capability retires the question with it.
        self.claude_turn_watches.retain(|session_id, watch| {
            self.agent_observations
                .get(session_id)
                .is_some_and(|capability| capability.runtime_epoch == watch.runtime_epoch)
        });
        self.claude_turn_watches
            .iter()
            .filter(|(session_id, _)| {
                self.agent_observations
                    .get(*session_id)
                    .is_some_and(|capability| {
                        capability
                            .observation
                            .is_some_and(|observation| turn_is_running(observation.state))
                    })
            })
            .filter_map(|(session_id, watch)| {
                let native_session_id = self
                    .running_claude_agent_session(session_id)?
                    .resume_ref
                    .as_ref()?
                    .native_session_id
                    .clone();
                Some(ClaudeInterruptCheck {
                    session_id: session_id.clone(),
                    transcript_path: watch.transcript_path.clone(),
                    native_session_id,
                    prompt_id: watch.prompt_id.clone(),
                })
            })
            .collect()
    }

    /// Applies a proven interruption after revalidating that the exact Session,
    /// runtime epoch, and turn the read was planned against are still current.
    pub fn apply_claude_interrupt_observation(
        &mut self,
        check: &ClaudeInterruptCheck,
        sequence: u64,
        observed_at_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        let runtime_epoch = self
            .claude_turn_watches
            .get(&check.session_id)
            .filter(|watch| watch.prompt_id == check.prompt_id)
            .map(|watch| watch.runtime_epoch)
            .ok_or(CoreError::CapabilityDenied)?;
        let capability = self
            .agent_observations
            .get_mut(&check.session_id)
            .filter(|capability| capability.runtime_epoch == runtime_epoch)
            .ok_or(CoreError::CapabilityDenied)?;
        let previous = capability.observation;
        // The check is public, so the turn is re-proven to still be running
        // here rather than trusting the planned value.
        if previous.is_none_or(|observation| !turn_is_running(observation.state)) {
            return Err(CoreError::CapabilityDenied);
        }
        let next = termloop_agents::reduce_observation(
            previous,
            termloop_agents::AgentSignal::Interrupted,
            AgentSignalSource::Transcript,
            sequence,
            observed_at_epoch_ms,
        );
        capability.observation = Some(next);
        self.claude_turn_watches.remove(&check.session_id);
        Ok(observation_projection_changed(previous, next))
    }

    pub fn agent_status_list(&self) -> Result<Value, CoreError> {
        self.agent_status_list_for_project(None)
    }

    pub fn agent_status_projection_for_executor(
        &self,
        project_id: &str,
    ) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        self.agent_status_list_for_project(Some(project_id))
    }

    fn agent_status_list_for_project(&self, project_id: Option<&str>) -> Result<Value, CoreError> {
        let values: Vec<_> = self
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.kind == termloop_domain::SessionKind::Agent
                    && project_id.is_none_or(|project_id| session.project_id == project_id)
            })
            .map(|session| {
                let live = matches!(session.lifecycle_state.as_str(), "running" | "resuming");
                let (state, source, observed_at_epoch_ms) = if !live {
                    (AgentState::Exited, AgentSignalSource::Process, 0)
                } else if let Some(observation) = self
                    .agent_observations
                    .get(&session.id)
                    .and_then(|value| value.observation)
                {
                    (
                        observation.state,
                        observation.source,
                        observation.observed_at_epoch_ms,
                    )
                } else {
                    (AgentState::Unknown, AgentSignalSource::None, 0)
                };
                let plan = self
                    .store
                    .agent_plans()
                    .iter()
                    .find(|plan| plan.session_id == session.id)
                    .map(agent_plan_json);
                let generated_input_delivery = live
                    .then(|| self.agent_observations.get(&session.id))
                    .flatten()
                    .and_then(|capability| {
                        let runtime_epoch = capability.runtime_epoch;
                        let state = self
                            .generated_input_deliveries
                            .state(&session.id, runtime_epoch)?;
                        let provenance = self
                            .generated_input_deliveries
                            .provenance(&session.id, runtime_epoch)?;
                        let diagnostics = self
                            .generated_input_deliveries
                            .diagnostics(&session.id, runtime_epoch)?;
                        Some(serde_json::json!({
                            "state": generated_input_delivery_state_name(state),
                            "failure": self.generated_input_deliveries
                                .failure(&session.id, runtime_epoch)
                                .map(generated_input_delivery_failure_name),
                            "originalFailure": diagnostics.original_failure
                                .map(generated_input_delivery_failure_name),
                            "cancelCause": diagnostics.cancel_cause
                                .map(generated_input_delivery_cancel_cause_name),
                            "cancelNotificationType": diagnostics.cancel_notification_type,
                            "pasteReceipted": diagnostics.paste_receipted,
                            "settlementEvidence": diagnostics.settlement_evidence
                                .map(generated_input_settlement_evidence_name),
                            "submitReceipted": diagnostics.submit_receipted,
                            "submitAttempts": diagnostics.submit_attempts,
                            "protocolReplyWaits": diagnostics.protocol_reply_waits,
                            "userInputMutated": diagnostics.user_input_mutated,
                            "outputChunks": diagnostics.output_activity.output_chunks,
                            "synchronizedFrames": diagnostics.output_activity.synchronized_frames,
                            "composerRenders": diagnostics.output_activity.composer_renders,
                            "completedComposerFrames": diagnostics.output_activity.completed_composer_frames,
                            "composerSurfaceFrames": diagnostics.output_activity.composer_surface_frames,
                            "composerCursorMoved": diagnostics.output_activity.composer_cursor_moved,
                            "templateRef": provenance.template_ref,
                            "templateVersion": provenance.template_version,
                        }))
                    });
                serde_json::json!({
                    "sessionId": session.id,
                    "status": agent_state_name(state),
                    "source": agent_source_name(source),
                    "observedAtEpochMs": observed_at_epoch_ms,
                    "plan": plan,
                    "generatedInputDelivery": generated_input_delivery,
                })
            })
            .collect();
        Ok(Value::Array(values))
    }
}

fn agent_plan_json(current: &termloop_domain::DurableAgentPlan) -> Value {
    serde_json::json!({
        "source": match current.source {
            termloop_domain::DurableAgentPlanSource::ClaudeHook => "claudeHook",
            termloop_domain::DurableAgentPlanSource::CodexAppServer => "codexAppServer",
        },
        "explanation": current.explanation,
        "steps": current.steps.iter().map(|step| serde_json::json!({
            "text": step.text,
            "status": match step.status {
                termloop_domain::DurableAgentPlanStepStatus::Pending => "pending",
                termloop_domain::DurableAgentPlanStepStatus::InProgress => "inProgress",
                termloop_domain::DurableAgentPlanStepStatus::Completed => "completed",
            },
        })).collect::<Vec<_>>(),
        "updatedAtEpochMs": current.updated_at_epoch_ms,
    })
}

fn apply_claude_plan_update(
    current: &mut Option<termloop_domain::DurableAgentPlan>,
    session_id: &str,
    update: AgentPlanUpdate,
    observed_at_epoch_ms: u64,
) -> bool {
    if let AgentPlanUpdate::Replace(plan) = update {
        if plan.source != AgentPlanSource::LaunchScopedHook {
            return false;
        }
        let replacement = durable_agent_plan(session_id, &plan, observed_at_epoch_ms);
        if current
            .as_ref()
            .is_some_and(|current| agent_plan_content_equal(current, &replacement))
        {
            return false;
        }
        *current = Some(replacement);
        return true;
    }

    if matches!(update, AgentPlanUpdate::UpsertTask { .. }) && current.is_none() {
        *current = Some(termloop_domain::DurableAgentPlan {
            session_id: session_id.to_owned(),
            source: termloop_domain::DurableAgentPlanSource::ClaudeHook,
            explanation: None,
            steps: Vec::new(),
            updated_at_epoch_ms: observed_at_epoch_ms,
        });
    }
    let Some(current) = current.as_mut() else {
        return false;
    };
    if current.source != termloop_domain::DurableAgentPlanSource::ClaudeHook {
        return false;
    }
    let changed = match update {
        AgentPlanUpdate::Replace(_) => unreachable!("replace handled above"),
        AgentPlanUpdate::UpsertTask {
            task_id,
            text,
            status,
        } => {
            match current.steps.iter().position(|candidate| {
                candidate.provider_task_id.as_deref() == Some(task_id.as_str())
            }) {
                Some(index) => {
                    let step = &mut current.steps[index];
                    let status = durable_step_status(status);
                    let changed = step.text != text || step.status != status;
                    step.text = text;
                    step.status = status;
                    changed
                }
                None if current.steps.len() < 32 => {
                    current.steps.push(termloop_domain::DurableAgentPlanStep {
                        text,
                        status: durable_step_status(status),
                        provider_task_id: Some(task_id),
                    });
                    true
                }
                None => false,
            }
        }
        AgentPlanUpdate::SetTaskStatus { task_id, status } => current
            .steps
            .iter()
            .position(|candidate| candidate.provider_task_id.as_deref() == Some(task_id.as_str()))
            .is_some_and(|index| {
                let step = &mut current.steps[index];
                let status = durable_step_status(status);
                let changed = step.status != status;
                step.status = status;
                changed
            }),
        AgentPlanUpdate::RemoveTask { task_id } => current
            .steps
            .iter()
            .position(|candidate| candidate.provider_task_id.as_deref() == Some(task_id.as_str()))
            .is_some_and(|index| {
                current.steps.remove(index);
                true
            }),
    };
    if changed {
        current.updated_at_epoch_ms = observed_at_epoch_ms;
    }
    changed
}

fn durable_agent_plan(
    session_id: &str,
    plan: &AgentPlan,
    updated_at_epoch_ms: u64,
) -> termloop_domain::DurableAgentPlan {
    termloop_domain::DurableAgentPlan {
        session_id: session_id.to_owned(),
        source: match plan.source {
            AgentPlanSource::LaunchScopedHook => {
                termloop_domain::DurableAgentPlanSource::ClaudeHook
            }
            AgentPlanSource::DaemonOwnedBridge => {
                termloop_domain::DurableAgentPlanSource::CodexAppServer
            }
        },
        explanation: plan.explanation.clone(),
        steps: plan
            .steps
            .iter()
            .map(|step| termloop_domain::DurableAgentPlanStep {
                text: step.text.clone(),
                status: durable_step_status(step.status),
                provider_task_id: None,
            })
            .collect(),
        updated_at_epoch_ms,
    }
}

fn durable_step_status(status: AgentPlanStepStatus) -> termloop_domain::DurableAgentPlanStepStatus {
    match status {
        AgentPlanStepStatus::Pending => termloop_domain::DurableAgentPlanStepStatus::Pending,
        AgentPlanStepStatus::InProgress => termloop_domain::DurableAgentPlanStepStatus::InProgress,
        AgentPlanStepStatus::Completed => termloop_domain::DurableAgentPlanStepStatus::Completed,
    }
}

fn agent_plan_content_equal(
    left: &termloop_domain::DurableAgentPlan,
    right: &termloop_domain::DurableAgentPlan,
) -> bool {
    left.session_id == right.session_id
        && left.source == right.source
        && left.explanation == right.explanation
        && left.steps == right.steps
}

fn persist_agent_plan(
    store: &mut Store,
    authority: &CoreWriteAuthority,
    session_id: &str,
    plan: Option<termloop_domain::DurableAgentPlan>,
) -> Result<(), CoreError> {
    match plan {
        Some(plan) if !plan.steps.is_empty() => store
            .replace_agent_plan(authority, plan)
            .map(|_| ())
            .map_err(store_error),
        Some(_) | None => store
            .clear_agent_plan(authority, session_id)
            .map(|_| ())
            .map_err(store_error),
    }
}

fn capability_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..64 {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn observation_projection_changed(
    previous: Option<AgentObservation>,
    next: AgentObservation,
) -> bool {
    previous.is_none_or(|previous| previous.state != next.state || previous.source != next.source)
}

impl CoreRuntime {
    /// Whether this Session is in the middle of a turn right now.
    ///
    /// A wake is a message typed into a live terminal. One typed while the
    /// assistant is mid-turn is not read until the turn ends, so a repeating
    /// wake would stack up behind a single long turn and be answered all at
    /// once. A Session TermLoop has no observation for is treated as free:
    /// silence is not evidence of work.
    pub(crate) fn session_turn_is_running(&self, session_id: &str) -> bool {
        self.agent_observations
            .get(session_id)
            .and_then(|capability| capability.observation)
            .is_some_and(|observation| turn_is_running(observation.state))
    }
}

/// Whether the Session is inside a turn that could still be cut off. Compaction
/// is a step within the turn, not its outcome: the provider resumes the same
/// turn afterwards and the user can interrupt either side of it.
fn turn_is_running(state: AgentState) -> bool {
    matches!(state, AgentState::Working | AgentState::Compacting)
}

/// Signals after `PromptSubmitted` that prove the provider advanced that turn.
/// Startup and ambient events are deliberately excluded: neither is evidence
/// that the submitted composer content actually began or completed work.
fn provider_signal_proves_turn_progress(signal: termloop_agents::AgentSignal) -> bool {
    matches!(
        signal,
        termloop_agents::AgentSignal::ToolStarted
            | termloop_agents::AgentSignal::ToolFinished
            | termloop_agents::AgentSignal::PermissionRequested
            | termloop_agents::AgentSignal::Notification
            | termloop_agents::AgentSignal::IdleNotified
            | termloop_agents::AgentSignal::CompactStarted
            | termloop_agents::AgentSignal::Stopped
            | termloop_agents::AgentSignal::Failed
            | termloop_agents::AgentSignal::Interrupted
            | termloop_agents::AgentSignal::SessionEnded
    )
}

fn agent_state_name(value: AgentState) -> &'static str {
    match value {
        AgentState::Unknown => "unknown",
        AgentState::Working => "working",
        AgentState::AwaitingInput => "awaitingInput",
        AgentState::Idle => "idle",
        AgentState::Compacting => "compacting",
        AgentState::Failed => "failed",
        AgentState::Interrupted => "interrupted",
        AgentState::Exited => "exited",
    }
}

fn agent_source_name(value: AgentSignalSource) -> &'static str {
    match value {
        AgentSignalSource::Hook => "hook",
        AgentSignalSource::DaemonBridge => "appServer",
        AgentSignalSource::Transcript => "transcript",
        AgentSignalSource::Process => "process",
        AgentSignalSource::None => "none",
    }
}

fn bounded_hook_label(value: &str) -> String {
    value.chars().take(64).collect()
}

fn generated_input_composer_may_accept(agent_id: &str, provider_state: Option<AgentState>) -> bool {
    provider_state == Some(AgentState::Idle)
        // `turn/completed: interrupted` ends the Codex turn and returns the
        // TUI to its composer, but App Server does not follow it with a second
        // `thread/status: idle` notification. Keep the interruption visible as
        // the turn outcome while allowing the Codex-only structural readiness
        // gate to prove that a new prompt can actually be pasted.
        || (agent_id == "codex" && provider_state == Some(AgentState::Interrupted))
}

fn generated_input_may_enter_provider_queue(
    template_ref: &str,
    provider_state: Option<AgentState>,
) -> bool {
    matches!(
        provider_state,
        Some(AgentState::Working | AgentState::Compacting)
    ) && matches!(
        template_ref,
        "builtin.agent.ask-to-reply"
            | "builtin.agent.ask-to-followup"
            | "builtin.agent.handoff"
            | "builtin.steward.agent-message"
            | "builtin.agent.menu-ask-to"
            | "builtin.agent.menu-handover-to"
    )
}

fn generated_input_settlement(
    agent_id: &str,
    provider_source: Option<AgentSignalSource>,
    provider_queue_ready: bool,
) -> runtime::generated_input_delivery::GeneratedInputSettlement {
    use runtime::generated_input_delivery::GeneratedInputSettlement;

    if provider_queue_ready {
        GeneratedInputSettlement::ProviderQueue
    } else if agent_id == "codex" && provider_source != Some(AgentSignalSource::DaemonBridge) {
        // Without App Server's structured idle observation, the terminal must
        // prove that Codex's current composer prompt is on screen.
        GeneratedInputSettlement::CodexComposerRender
    } else if matches!(agent_id, "codex" | "claude") {
        // App Server idle already proves Codex is accepting a new turn. Keep
        // the terminal's bracketed-paste handshake as the transport gate, but
        // do not depend on a TUI glyph that may have rendered before tracking
        // began or may change independently of the structured protocol.
        GeneratedInputSettlement::ComposerRender
    } else {
        GeneratedInputSettlement::OutputActivity
    }
}

fn unavailable_composer_cause(
    provider_state: Option<AgentState>,
    provider_signal: Option<termloop_agents::AgentSignal>,
) -> GeneratedInputDeliveryCancelCause {
    match provider_signal {
        Some(termloop_agents::AgentSignal::PermissionRequested) => {
            GeneratedInputDeliveryCancelCause::PermissionRequested
        }
        Some(termloop_agents::AgentSignal::Notification) => {
            GeneratedInputDeliveryCancelCause::Notification
        }
        _ if provider_state == Some(AgentState::AwaitingInput) => {
            GeneratedInputDeliveryCancelCause::ProviderAwaitingInput
        }
        _ => GeneratedInputDeliveryCancelCause::ProviderBusy,
    }
}

fn generated_input_delivery_state_name(value: GeneratedInputDeliveryState) -> &'static str {
    match value {
        GeneratedInputDeliveryState::WritingPaste => "writingPaste",
        GeneratedInputDeliveryState::AwaitingProviderAck => "awaitingProviderAck",
        GeneratedInputDeliveryState::Confirmed => "confirmed",
        GeneratedInputDeliveryState::ConfirmedUnattributed => "confirmedUnattributed",
        GeneratedInputDeliveryState::Stalled => "stalled",
        GeneratedInputDeliveryState::Blocked => "blocked",
        GeneratedInputDeliveryState::Failed => "failed",
        GeneratedInputDeliveryState::RequiresUserResubmit => "requiresUserResubmit",
    }
}

fn generated_input_delivery_failure_name(value: GeneratedInputDeliveryFailure) -> &'static str {
    match value {
        GeneratedInputDeliveryFailure::TerminalUnavailable => "terminalUnavailable",
        GeneratedInputDeliveryFailure::PasteWriteFailed => "pasteWriteFailed",
        GeneratedInputDeliveryFailure::OutputDidNotSettle => "outputDidNotSettle",
        GeneratedInputDeliveryFailure::UserInputInterleaved => "userInputInterleaved",
        GeneratedInputDeliveryFailure::ProviderAckMissing => "providerAckMissing",
        GeneratedInputDeliveryFailure::ComposerUnavailable => "composerUnavailable",
        GeneratedInputDeliveryFailure::ComposerNotReady => "composerNotReady",
        GeneratedInputDeliveryFailure::RuntimeEpochChanged => "runtimeEpochChanged",
        GeneratedInputDeliveryFailure::TerminalClosed => "terminalClosed",
        GeneratedInputDeliveryFailure::SubmitWriteFailed => "submitWriteFailed",
        GeneratedInputDeliveryFailure::WorkerUnavailable => "workerUnavailable",
    }
}

fn generated_input_delivery_cancel_cause_name(
    value: GeneratedInputDeliveryCancelCause,
) -> &'static str {
    match value {
        GeneratedInputDeliveryCancelCause::PermissionRequested => "permissionRequested",
        GeneratedInputDeliveryCancelCause::Notification => "notification",
        GeneratedInputDeliveryCancelCause::ProviderAwaitingInput => "providerAwaitingInput",
        GeneratedInputDeliveryCancelCause::ProviderBusy => "providerBusy",
    }
}

fn generated_input_settlement_evidence_name(
    value: termloop_terminal::OutputSettlementEvidence,
) -> &'static str {
    match value {
        termloop_terminal::OutputSettlementEvidence::Quiescence => "quiescence",
        termloop_terminal::OutputSettlementEvidence::SynchronizedFrame => "synchronizedFrame",
        termloop_terminal::OutputSettlementEvidence::ComposerRenderQuiescence => {
            "composerRenderQuiescence"
        }
        termloop_terminal::OutputSettlementEvidence::ComposerCursorMovement => {
            "composerCursorMovement"
        }
        termloop_terminal::OutputSettlementEvidence::ComposerSurfaceStability => {
            "composerSurfaceStability"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_app_server_idle_uses_structured_composer_readiness() {
        use runtime::generated_input_delivery::GeneratedInputSettlement;

        assert_eq!(
            generated_input_settlement("codex", Some(AgentSignalSource::DaemonBridge), false),
            GeneratedInputSettlement::ComposerRender
        );
        assert_eq!(
            generated_input_settlement("codex", Some(AgentSignalSource::Transcript), false),
            GeneratedInputSettlement::CodexComposerRender
        );
        assert_eq!(
            generated_input_settlement("codex", None, true),
            GeneratedInputSettlement::ProviderQueue
        );
    }

    #[test]
    fn steward_wake_confirmation_is_emitted_once_and_retires_exact_pending_identity() {
        use companion_integrations::assistant_session::PendingAssistantWakeDelivery;

        let path = std::env::temp_dir().join(format!(
            "termloop-core-steward-wake-confirmation-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut runtime = CoreRuntime::new(
            Store::open(&path).unwrap(),
            termloop_store::issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        runtime.pending_assistant_wake_deliveries.insert(
            "steward-session".into(),
            PendingAssistantWakeDelivery::Steward {
                project_id: "project".into(),
                generation: 4,
                wake_id: 11,
                session_id: "steward-session".into(),
                runtime_epoch: 8,
                submission: companion_integrations::assistant_session::compose_steward_wake(
                    companion_integrations::assistant_session::StewardWakeKind::ConfigurationChanged,
                )
                .unwrap()
                .terminal_submission(),
                confirmation_queued: false,
            },
        );

        assert!(runtime.complete_assistant_wake_generated_input("steward-session", 8));
        assert!(!runtime.complete_assistant_wake_generated_input("steward-session", 8));
        assert_eq!(
            runtime.take_confirmed_steward_wakes(),
            vec![ConfirmedStewardWake {
                project_id: "project".into(),
                generation: 4,
                wake_id: 11,
            }]
        );
        assert!(runtime.pending_assistant_wake_deliveries.is_empty());
        assert!(runtime.take_confirmed_steward_wakes().is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn assistant_availability_projections_never_cross_project_boundaries() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-restricted-projection-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let mut store = Store::open(&path).unwrap();
        for project_id in ["project-a", "project-b"] {
            store
                .insert_project(
                    &authority,
                    termloop_domain::ProjectRecord {
                        id: project_id.into(),
                        name: project_id.into(),
                        folder_path: format!("/tmp/{project_id}"),
                    },
                )
                .unwrap();
            store
                .insert_session(
                    &authority,
                    termloop_domain::SessionRecord {
                        launch_selection: Default::default(),
                        id: format!("session-{project_id}"),
                        project_id: project_id.into(),
                        name: None,
                        kind: termloop_domain::SessionKind::Agent,
                        process: termloop_domain::ProcessDescriptor {
                            program: "agent".into(),
                            args: vec![],
                            cwd: format!("/tmp/{project_id}"),
                            agent_id: Some("claude".into()),
                            template_ref: None,
                            template_version: None,
                        },
                        lifecycle_state: "running".into(),
                        runtime_epoch: 1,
                        archived_at_epoch_ms: None,
                        ask_to_source_session_id: None,
                        run_configuration_id: None,
                        improver_target: None,
                        ask_to_continuation: None,
                        resume_ref: None,
                        resume_launch_guard: None,
                        resume_failure: None,
                    },
                )
                .unwrap();
        }
        let runtime = CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let projects = runtime
            .project_projection_for_executor("project-a")
            .unwrap();
        assert_eq!(projects.as_array().unwrap().len(), 1);
        assert_eq!(projects[0]["id"], "project-a");
        let agents = runtime
            .agent_status_projection_for_executor("project-a")
            .unwrap();
        assert_eq!(agents.as_array().unwrap().len(), 1);
        assert_eq!(agents[0]["sessionId"], "session-project-a");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_claude_interrupt_check_is_armed_by_a_turn_and_answered_once() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-claude-interrupt-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        runtime.configure_agent_observations(test_agent_observation_transport(
            std::env::temp_dir().join("termloop-core-interrupt-provider"),
        ));
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                termloop_domain::SessionRecord {
                    launch_selection: Default::default(),
                    id: "claude-live".into(),
                    project_id: "project-1".into(),
                    name: None,
                    kind: termloop_domain::SessionKind::Agent,
                    process: termloop_domain::ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd: "/tmp".into(),
                        agent_id: Some("claude".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        runtime.agent_observations.insert(
            "claude-live".into(),
            AgentObservationCapability {
                token: Some("token-live".into()),
                runtime_epoch: 1,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: None,
                pending_generated_input: None,
            },
        );
        let native_session_id = uuid::Uuid::new_v4().to_string();
        runtime
            .record_claude_resume_ref("token-live", "claude-live", &native_session_id)
            .unwrap();

        let transcript = std::env::temp_dir().join("termloop-core-interrupt-fixture.jsonl");
        assert!(matches!(
            runtime.record_claude_turn_watch(
                "token-wrong",
                "claude-live",
                &transcript.display().to_string(),
                "prompt-1",
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.record_claude_turn_watch("token-live", "claude-live", "relative.jsonl", "p"),
            Err(CoreError::InvalidParams(field)) if field == "transcriptPath"
        ));
        assert!(matches!(
            runtime.record_claude_turn_watch(
                "token-live",
                "claude-live",
                &transcript.display().to_string(),
                "",
            ),
            Err(CoreError::InvalidParams(field)) if field == "promptId"
        ));

        // An armed but not-yet-working turn is not a question worth asking.
        runtime
            .record_claude_turn_watch(
                "token-live",
                "claude-live",
                &transcript.display().to_string(),
                "prompt-1",
            )
            .unwrap();
        assert!(runtime.plan_claude_interrupt_checks().is_empty());

        runtime
            .record_agent_observation(
                "token-live",
                "claude-live",
                "UserPromptSubmit",
                None,
                None,
                1,
                1,
            )
            .unwrap();
        let checks = runtime.plan_claude_interrupt_checks();
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].prompt_id, "prompt-1");
        assert_eq!(checks[0].native_session_id, native_session_id);
        assert_eq!(checks[0].transcript_path, transcript);

        assert!(
            runtime
                .apply_claude_interrupt_observation(&checks[0], 2, 2)
                .unwrap()
        );
        let projected = runtime.agent_status_list().unwrap();
        let session = projected
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["sessionId"] == "claude-live")
            .unwrap();
        assert_eq!(session["status"], "interrupted");
        assert_eq!(session["source"], "transcript");

        // The answer retires the question: no repeat check, no second apply.
        assert!(runtime.plan_claude_interrupt_checks().is_empty());
        assert!(matches!(
            runtime.apply_claude_interrupt_observation(&checks[0], 3, 3),
            Err(CoreError::CapabilityDenied)
        ));

        // A finished turn also retires it, and a stale runtime epoch never
        // answers for the current one.
        runtime
            .record_claude_turn_watch(
                "token-live",
                "claude-live",
                &transcript.display().to_string(),
                "prompt-2",
            )
            .unwrap();
        runtime
            .record_agent_observation(
                "token-live",
                "claude-live",
                "UserPromptSubmit",
                None,
                None,
                4,
                4,
            )
            .unwrap();
        assert_eq!(runtime.plan_claude_interrupt_checks().len(), 1);

        // Compaction happens inside the turn, so it reports its own status
        // without answering the interrupt question or retiring the watch.
        runtime
            .record_agent_observation("token-live", "claude-live", "PreCompact", None, None, 5, 5)
            .unwrap();
        let projected = runtime.agent_status_list().unwrap();
        assert_eq!(
            projected
                .as_array()
                .unwrap()
                .iter()
                .find(|value| value["sessionId"] == "claude-live")
                .unwrap()["status"],
            "compacting"
        );
        assert_eq!(runtime.plan_claude_interrupt_checks().len(), 1);

        runtime
            .record_agent_observation("token-live", "claude-live", "Stop", None, None, 6, 6)
            .unwrap();
        assert!(runtime.plan_claude_interrupt_checks().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn claude_transcript_model_replaces_only_a_contradicted_session_selection() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-claude-model-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        for (session_id, model) in [("claude-live", "sonnet"), ("claude-default", "default")] {
            runtime
                .store
                .insert_session(
                    &runtime.write_authority,
                    termloop_domain::SessionRecord {
                        launch_selection: termloop_domain::AgentLaunchSelection::new(
                            model, "default", "default",
                        ),
                        id: session_id.into(),
                        project_id: "project-1".into(),
                        name: None,
                        kind: termloop_domain::SessionKind::Agent,
                        process: termloop_domain::ProcessDescriptor {
                            program: "claude".into(),
                            args: vec![],
                            cwd: "/tmp".into(),
                            agent_id: Some("claude".into()),
                            template_ref: None,
                            template_version: None,
                        },
                        lifecycle_state: "running".into(),
                        runtime_epoch: 1,
                        archived_at_epoch_ms: None,
                        ask_to_source_session_id: None,
                        run_configuration_id: None,
                        improver_target: None,
                        ask_to_continuation: None,
                        resume_ref: None,
                        resume_launch_guard: None,
                        resume_failure: None,
                    },
                )
                .unwrap();
            runtime.agent_observations.insert(
                session_id.into(),
                AgentObservationCapability {
                    token: Some(format!("token-{session_id}")),
                    runtime_epoch: 1,
                    last_signal: None,
                    defer_generated_input_until_hook_response: false,
                    last_notification_type: None,
                    observation: None,
                    pending_generated_input: None,
                },
            );
            runtime
                .record_claude_resume_ref(
                    &format!("token-{session_id}"),
                    session_id,
                    &uuid::Uuid::new_v4().to_string(),
                )
                .unwrap();
        }

        assert!(matches!(
            runtime.record_claude_model_selection(
                "token-claude-default",
                "claude-live",
                "claude-fable-5",
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(
            runtime
                .record_claude_model_selection("token-claude-live", "claude-live", "claude-fable-5")
                .unwrap()
        );
        assert_eq!(runtime.store.sessions()[0].launch_selection.model, "fable");
        assert!(
            !runtime
                .record_claude_model_selection("token-claude-live", "claude-live", "claude-fable-5")
                .unwrap()
        );

        // An unrecognised provider model never rewrites a stored selection.
        assert!(
            !runtime
                .record_claude_model_selection("token-claude-live", "claude-live", "gpt-5.6-sol")
                .unwrap()
        );
        assert_eq!(runtime.store.sessions()[0].launch_selection.model, "fable");

        // The transcript cannot separate `opus` from `opus[1m]`, so a
        // compatible observation keeps the selection instead of downgrading it.
        assert!(
            runtime
                .record_claude_model_selection(
                    "token-claude-live",
                    "claude-live",
                    "claude-opus-5[1m]",
                )
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0].launch_selection.model,
            "opus[1m]"
        );
        assert!(
            !runtime
                .record_claude_model_selection("token-claude-live", "claude-live", "claude-opus-5")
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0].launch_selection.model,
            "opus[1m]"
        );

        // `default` passes no `--model`, so Claude already owns that Session's
        // model and TermLoop must not pin it.
        assert!(
            !runtime
                .record_claude_model_selection(
                    "token-claude-default",
                    "claude-default",
                    "claude-haiku-4-5-20251001",
                )
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[1].launch_selection.model,
            "default"
        );

        runtime
            .store
            .mark_session_exited(&runtime.write_authority, "claude-live")
            .unwrap();
        assert!(matches!(
            runtime.record_claude_model_selection(
                "token-claude-live",
                "claude-live",
                "claude-sonnet-5",
            ),
            Err(CoreError::CapabilityDenied)
        ));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn claude_permission_observation_replaces_only_an_ordinary_session_selection() {
        fn selection_of(
            runtime: &CoreRuntime,
            session_id: &str,
        ) -> termloop_domain::AgentLaunchSelection {
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == session_id)
                .unwrap()
                .launch_selection
                .clone()
        }
        fn permission_of(runtime: &CoreRuntime, session_id: &str) -> String {
            selection_of(runtime, session_id).permission
        }
        fn reasoning_of(runtime: &CoreRuntime, session_id: &str) -> String {
            selection_of(runtime, session_id).reasoning
        }

        let root = std::env::temp_dir().join(format!(
            "termloop-core-claude-permission-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(root.join("state.json")).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project = runtime
            .handle(
                "project.create",
                serde_json::json!({"name":"Demo","folderPath":root}),
            )
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        for session_id in ["claude-live", "claude-steward"] {
            runtime
                .store
                .insert_session(
                    &runtime.write_authority,
                    termloop_domain::SessionRecord {
                        launch_selection: termloop_domain::AgentLaunchSelection::new(
                            "opus[1m]",
                            "acceptEdits",
                            "xhigh",
                        ),
                        id: session_id.into(),
                        project_id: project_id.clone(),
                        name: None,
                        kind: termloop_domain::SessionKind::Agent,
                        process: termloop_domain::ProcessDescriptor {
                            program: "claude".into(),
                            args: vec![],
                            cwd: "/tmp".into(),
                            agent_id: Some("claude".into()),
                            template_ref: None,
                            template_version: None,
                        },
                        lifecycle_state: "running".into(),
                        runtime_epoch: 1,
                        archived_at_epoch_ms: None,
                        ask_to_source_session_id: None,
                        run_configuration_id: None,
                        improver_target: None,
                        ask_to_continuation: None,
                        resume_ref: None,
                        resume_launch_guard: None,
                        resume_failure: None,
                    },
                )
                .unwrap();
            runtime.agent_observations.insert(
                session_id.into(),
                AgentObservationCapability {
                    token: Some(format!("token-{session_id}")),
                    runtime_epoch: 1,
                    last_signal: None,
                    defer_generated_input_until_hook_response: false,
                    last_notification_type: None,
                    observation: None,
                    pending_generated_input: None,
                },
            );
            runtime
                .record_claude_resume_ref(
                    &format!("token-{session_id}"),
                    session_id,
                    &uuid::Uuid::new_v4().to_string(),
                )
                .unwrap();
        }
        let revision = runtime.store.revision();
        runtime
            .store
            .set_steward_configuration(
                &runtime.write_authority,
                termloop_domain::StewardConfiguration {
                    project_id: project_id.clone(),
                    agent_id: termloop_domain::StewardAgentId::Claude,
                    model: "default".into(),
                    permission: "bypassPermissions".into(),
                    reasoning: "default".into(),
                    enabled: true,
                    system_prompt: String::new(),
                    executor_session_id: Some("claude-steward".into()),
                    generation: 1,
                    updated_at_epoch_ms: 1,
                },
                revision,
            )
            .unwrap();

        // One Session's capability never reports another Session's mode.
        assert!(matches!(
            runtime.record_claude_permission_selection(
                "token-claude-steward",
                "claude-live",
                "manual",
            ),
            Err(CoreError::CapabilityDenied)
        ));

        // The provider's current names land in the launch vocabulary, and the
        // same mode twice is not a second write.
        assert!(
            runtime
                .record_claude_permission_selection("token-claude-live", "claude-live", "manual")
                .unwrap()
        );
        assert_eq!(permission_of(&runtime, "claude-live"), "default");
        assert!(
            !runtime
                .record_claude_permission_selection("token-claude-live", "claude-live", "manual")
                .unwrap()
        );
        assert!(
            runtime
                .record_claude_permission_selection("token-claude-live", "claude-live", "auto")
                .unwrap()
        );
        assert_eq!(permission_of(&runtime, "claude-live"), "acceptEdits");

        // An unrecognised mode is not authority to rewrite the selection.
        assert!(
            !runtime
                .record_claude_permission_selection("token-claude-live", "claude-live", "dontAsk")
                .unwrap()
        );
        assert_eq!(permission_of(&runtime, "claude-live"), "acceptEdits");

        // A persistent assistant executor keeps the mode its configuration
        // resolves at launch.
        assert!(
            !runtime
                .record_claude_permission_selection(
                    "token-claude-steward",
                    "claude-steward",
                    "manual",
                )
                .unwrap()
        );
        assert_eq!(permission_of(&runtime, "claude-steward"), "acceptEdits");

        // The effort level travels the same path: a real change is stored, an
        // unrecognised level is not, and a Session left on `default` is never
        // pinned to the level the provider happens to report.
        assert!(
            runtime
                .record_claude_reasoning_selection("token-claude-live", "claude-live", "medium")
                .unwrap()
        );
        assert_eq!(reasoning_of(&runtime, "claude-live"), "medium");
        assert!(
            !runtime
                .record_claude_reasoning_selection("token-claude-live", "claude-live", "medium")
                .unwrap()
        );
        assert!(
            !runtime
                .record_claude_reasoning_selection("token-claude-live", "claude-live", "default")
                .unwrap()
        );
        assert_eq!(reasoning_of(&runtime, "claude-live"), "medium");
        assert!(
            !runtime
                .record_claude_reasoning_selection("token-claude-steward", "claude-steward", "low")
                .unwrap()
        );
        assert_eq!(reasoning_of(&runtime, "claude-steward"), "xhigh");

        runtime
            .store
            .mark_session_exited(&runtime.write_authority, "claude-live")
            .unwrap();
        assert!(matches!(
            runtime.record_claude_permission_selection(
                "token-claude-live",
                "claude-live",
                "manual"
            ),
            Err(CoreError::CapabilityDenied)
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn observation_capability_is_scoped_to_one_session() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-observation-capability-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        runtime.configure_agent_observations(test_agent_observation_transport(
            std::env::temp_dir().join("termloop-core-observation-provider"),
        ));
        for (session_id, agent_id) in [("session-a", "claude"), ("session-b", "gemini")] {
            runtime
                .store
                .insert_session(
                    &runtime.write_authority,
                    termloop_domain::SessionRecord {
                        launch_selection: Default::default(),
                        id: session_id.into(),
                        project_id: "project-1".into(),
                        name: None,
                        kind: termloop_domain::SessionKind::Agent,
                        process: termloop_domain::ProcessDescriptor {
                            program: "agent".into(),
                            args: vec![],
                            cwd: "/tmp".into(),
                            agent_id: Some(agent_id.into()),
                            template_ref: None,
                            template_version: None,
                        },
                        lifecycle_state: "running".into(),
                        runtime_epoch: 1,
                        archived_at_epoch_ms: None,
                        ask_to_source_session_id: None,
                        run_configuration_id: None,
                        improver_target: None,
                        ask_to_continuation: None,
                        resume_ref: None,
                        resume_launch_guard: None,
                        resume_failure: None,
                    },
                )
                .unwrap();
        }
        runtime.agent_observations.insert(
            "session-a".into(),
            AgentObservationCapability {
                token: Some("token-a".into()),
                runtime_epoch: 1,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: None,
                pending_generated_input: None,
            },
        );
        runtime.agent_observations.insert(
            "session-b".into(),
            AgentObservationCapability {
                token: Some("token-b".into()),
                runtime_epoch: 1,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: None,
                pending_generated_input: None,
            },
        );
        runtime
            .observation_transport
            .as_mut()
            .unwrap()
            .agents
            .get_mut("gemini")
            .unwrap()
            .resume_supported = true;
        assert!(matches!(
            runtime.record_agent_observation(
                "token-a",
                "session-b",
                "SessionStart",
                None,
                None,
                1,
                1
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.record_provider_hook_observation(
                "token-b",
                "session-b",
                ProviderHookObservationInput {
                    event_name: "UserPromptSubmit".into(),
                    notification_type: None,
                    native_session_id: None,
                    provider_model_id: None,
                    permission_mode: None,
                    reasoning_level: None,
                    transcript_path: None,
                    prompt_id: None,
                    plan: None,
                },
                1,
                1,
            ),
            Err(CoreError::InvalidParams(field)) if field == "eventName"
        ));
        let gemini_native_session_id = uuid::Uuid::new_v4().to_string();
        let gemini = runtime
            .record_provider_hook_observation(
                "token-b",
                "session-b",
                ProviderHookObservationInput {
                    event_name: "BeforeAgent".into(),
                    notification_type: None,
                    native_session_id: Some(gemini_native_session_id),
                    provider_model_id: None,
                    permission_mode: None,
                    reasoning_level: None,
                    transcript_path: None,
                    prompt_id: None,
                    plan: None,
                },
                2,
                2,
            )
            .unwrap();
        assert!(gemini.status_changed);
        assert!(!gemini.session_changed);
        assert!(!gemini.provider_session_replaced);
        assert_eq!(
            runtime.agent_observations["session-b"]
                .observation
                .unwrap()
                .state,
            AgentState::Working
        );
        // Even if runtime discovery eventually proves Gemini resume support,
        // its project-directory-scoped hook UUID must not fail an observation
        // or become durable resume authority until Core implements that exact
        // identity contract.
        assert!(
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == "session-b")
                .unwrap()
                .resume_ref
                .is_none()
        );
        assert!(
            runtime
                .record_agent_observation("token-a", "session-a", "SessionStart", None, None, 1, 1)
                .unwrap()
        );
        assert_eq!(
            runtime.agent_observations["session-a"]
                .observation
                .unwrap()
                .state,
            AgentState::Idle
        );
        assert!(
            !runtime
                .record_agent_observation("token-a", "session-a", "SessionStart", None, None, 2, 2)
                .unwrap()
        );
        assert_eq!(
            runtime.agent_observations["session-a"]
                .observation
                .unwrap()
                .sequence,
            2
        );
        // The invalid Gemini event and the valid BeforeAgent above consumed
        // the first two authenticated ingress slots. Exercise the command
        // boundary, not only the limiter in isolation, and prove the 257th
        // same-window request is denied before it can affect provider state.
        for sequence in 3..=256 {
            runtime
                .record_provider_hook_observation(
                    "token-b",
                    "session-b",
                    ProviderHookObservationInput {
                        event_name: "BeforeAgent".into(),
                        notification_type: None,
                        native_session_id: None,
                        provider_model_id: None,
                        permission_mode: None,
                        reasoning_level: None,
                        transcript_path: None,
                        prompt_id: None,
                        plan: None,
                    },
                    sequence,
                    2,
                )
                .unwrap();
        }
        assert!(matches!(
            runtime.record_provider_hook_observation(
                "token-b",
                "session-b",
                ProviderHookObservationInput {
                    event_name: "BeforeAgent".into(),
                    notification_type: None,
                    native_session_id: None,
                    provider_model_id: None,
                    permission_mode: None,
                    reasoning_level: None,
                    transcript_path: None,
                    prompt_id: None,
                    plan: None,
                },
                257,
                2,
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(!runtime.agent_conversation_activity.contains("session-a"));
        let plan = AgentPlan {
            source: AgentPlanSource::LaunchScopedHook,
            explanation: None,
            steps: vec![AgentPlanStep {
                text: "Run focused tests".into(),
                status: AgentPlanStepStatus::InProgress,
            }],
        };
        assert!(
            runtime
                .record_agent_observation(
                    "token-a",
                    "session-a",
                    "PreToolUse",
                    None,
                    Some(AgentPlanUpdate::Replace(plan)),
                    3,
                    3,
                )
                .unwrap()
        );
        let projected = runtime.agent_status_list().unwrap();
        let session_a = projected
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["sessionId"] == "session-a")
            .unwrap();
        assert_eq!(session_a["plan"]["source"], "claudeHook");
        assert_eq!(session_a["plan"]["steps"][0]["status"], "inProgress");
        assert_eq!(session_a["plan"]["updatedAtEpochMs"], 3);
        assert!(
            runtime
                .record_agent_observation(
                    "token-a",
                    "session-a",
                    "TaskCreated",
                    None,
                    Some(AgentPlanUpdate::UpsertTask {
                        task_id: "task-7".into(),
                        text: "Render the sidebar plan".into(),
                        status: AgentPlanStepStatus::Pending,
                    }),
                    4,
                    4,
                )
                .unwrap()
        );
        assert!(
            runtime
                .record_agent_observation(
                    "token-a",
                    "session-a",
                    "PostToolUse",
                    None,
                    Some(AgentPlanUpdate::SetTaskStatus {
                        task_id: "task-7".into(),
                        status: AgentPlanStepStatus::InProgress,
                    }),
                    5,
                    5,
                )
                .unwrap()
        );
        let projected = runtime.agent_status_list().unwrap();
        let session_a = projected
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["sessionId"] == "session-a")
            .unwrap();
        assert_eq!(
            session_a["plan"]["steps"][1]["text"],
            "Render the sidebar plan"
        );
        assert_eq!(session_a["plan"]["steps"][1]["status"], "inProgress");
        assert_eq!(session_a["plan"]["updatedAtEpochMs"], 5);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.agent_plans()[0].steps[1]
                .provider_task_id
                .as_deref(),
            Some("task-7")
        );
        let restarted = CoreRuntime::new(
            reopened,
            termloop_store::issue_core_write_authority_for_composition(),
            TerminalService::default(),
            2,
        )
        .unwrap();
        let restarted_projection = restarted.agent_status_list().unwrap();
        let restarted_session = restarted_projection
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["sessionId"] == "session-a")
            .unwrap();
        assert_eq!(
            restarted_session["plan"]["steps"][1]["text"],
            "Render the sidebar plan"
        );
        assert!(
            restarted_session["plan"]["steps"][1]
                .get("providerTaskId")
                .is_none()
        );
        runtime
            .record_agent_observation("token-a", "session-a", "UserPromptSubmit", None, None, 6, 6)
            .unwrap();
        assert!(runtime.agent_conversation_activity.contains("session-a"));
        let projected = runtime.agent_status_list().unwrap();
        let session_a = projected
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["sessionId"] == "session-a")
            .unwrap();
        assert_eq!(
            session_a["plan"]["steps"][1]["text"],
            "Render the sidebar plan"
        );
        assert_eq!(Store::open(&path).unwrap().agent_plans().len(), 1);
        runtime
            .record_agent_observation(
                "token-a",
                "session-a",
                "PreToolUse",
                None,
                Some(AgentPlanUpdate::Replace(AgentPlan {
                    source: AgentPlanSource::LaunchScopedHook,
                    explanation: None,
                    steps: vec![],
                })),
                7,
                7,
            )
            .unwrap();
        let projected = runtime.agent_status_list().unwrap();
        let session_a = projected
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["sessionId"] == "session-a")
            .unwrap();
        assert!(session_a["plan"].is_null());
        assert!(Store::open(&path).unwrap().agent_plans().is_empty());
        let private_id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            runtime.record_claude_resume_ref("token-b", "session-a", &private_id),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(
            runtime
                .record_claude_resume_ref("token-a", "session-a", &private_id)
                .unwrap()
        );
        assert!(
            !runtime
                .record_claude_resume_ref("token-a", "session-a", &private_id)
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0]
                .resume_ref
                .as_ref()
                .unwrap()
                .native_session_id,
            private_id
        );
        assert!(matches!(
            runtime.record_claude_resume_ref("token-a", "session-a", "not-a-uuid"),
            Err(CoreError::InvalidParams(field)) if field == "nativeSessionId"
        ));
        let selected_conversation = uuid::Uuid::new_v4().to_string();
        assert!(
            runtime
                .record_claude_resume_ref("token-a", "session-a", &selected_conversation)
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0]
                .resume_ref
                .as_ref()
                .unwrap()
                .native_session_id,
            selected_conversation
        );
        runtime
            .store
            .mark_session_exited(&runtime.write_authority, "session-a")
            .unwrap();
        assert!(matches!(
            runtime.record_agent_observation("token-a", "session-a", "Stop", None, None, 2, 2),
            Err(CoreError::CapabilityDenied)
        ));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn in_tui_resume_revives_the_projected_status_of_a_live_claude_session() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-in-tui-resume-revival-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        runtime.configure_agent_observations(test_agent_observation_transport(
            std::env::temp_dir().join("termloop-core-in-tui-provider"),
        ));
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                termloop_domain::SessionRecord {
                    launch_selection: Default::default(),
                    id: "session-live".into(),
                    project_id: "project-1".into(),
                    name: None,
                    kind: termloop_domain::SessionKind::Agent,
                    process: termloop_domain::ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd: "/tmp".into(),
                        agent_id: Some("claude".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        runtime.agent_observations.insert(
            "session-live".into(),
            AgentObservationCapability {
                token: Some("token-live".into()),
                runtime_epoch: 1,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: None,
                pending_generated_input: None,
            },
        );
        let projected_status = |runtime: &CoreRuntime| {
            runtime.agent_status_list().unwrap()[0]["status"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let original_conversation = uuid::Uuid::new_v4().to_string();
        runtime
            .record_agent_observation(
                "token-live",
                "session-live",
                "SessionStart",
                None,
                None,
                1,
                1,
            )
            .unwrap();
        runtime
            .record_claude_resume_ref("token-live", "session-live", &original_conversation)
            .unwrap();
        // Claude's in-TUI /resume ends the current conversation inside the
        // still-live process before starting the selected one.
        assert!(
            runtime
                .record_agent_observation(
                    "token-live",
                    "session-live",
                    "SessionEnd",
                    None,
                    None,
                    2,
                    2
                )
                .unwrap()
        );
        assert_eq!(projected_status(&runtime), "exited");
        assert_eq!(runtime.store.sessions()[0].lifecycle_state, "running");
        // The follow-up SessionStart for the selected conversation must revive
        // the projection instead of being absorbed by the exited observation.
        assert!(
            runtime
                .record_agent_observation(
                    "token-live",
                    "session-live",
                    "SessionStart",
                    None,
                    None,
                    3,
                    3
                )
                .unwrap()
        );
        assert_eq!(projected_status(&runtime), "idle");
        let selected_conversation = uuid::Uuid::new_v4().to_string();
        assert!(
            runtime
                .record_claude_resume_ref("token-live", "session-live", &selected_conversation)
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0]
                .resume_ref
                .as_ref()
                .unwrap()
                .native_session_id,
            selected_conversation
        );
        runtime
            .record_agent_observation(
                "token-live",
                "session-live",
                "UserPromptSubmit",
                None,
                None,
                4,
                4,
            )
            .unwrap();
        assert_eq!(projected_status(&runtime), "working");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn live_codex_thread_transition_retargets_only_the_running_session() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-codex-retarget-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        let original = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "thread-a".into(),
        )
        .unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                termloop_domain::SessionRecord {
                    launch_selection: Default::default(),
                    id: "codex-live".into(),
                    project_id: "project-1".into(),
                    name: None,
                    kind: termloop_domain::SessionKind::Agent,
                    process: termloop_domain::ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: termloop_platform::canonical_existing_directory_path(
                            &std::env::temp_dir(),
                        )
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: Some(original),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        let replacement = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "thread-b".into(),
        )
        .unwrap();

        assert!(
            runtime
                .record_agent_resume_ref("codex-live", 1, replacement.clone())
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0].resume_ref.as_ref(),
            Some(&replacement)
        );
        assert!(
            !runtime
                .record_agent_resume_ref("codex-live", 1, replacement.clone())
                .unwrap()
        );
        let stale_runtime_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "thread-from-stale-runtime".into(),
        )
        .unwrap();
        assert!(matches!(
            runtime.record_agent_resume_ref("codex-live", 2, stale_runtime_ref),
            Err(CoreError::CapabilityDenied)
        ));
        assert_eq!(
            runtime.store.sessions()[0].resume_ref.as_ref(),
            Some(&replacement)
        );

        assert!(
            runtime
                .record_codex_thread_settings(
                    "codex-live",
                    1,
                    termloop_agents::CodexThreadSettingsObservation {
                        native_thread_id: "thread-b".into(),
                        model: Some("gpt-5.6-terra".into()),
                        permission: termloop_agents::CodexPermissionMode::BypassPermissions,
                        reasoning: Some("xhigh".into()),
                    },
                )
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0].launch_selection.permission,
            "bypassPermissions"
        );
        assert_eq!(
            runtime.store.sessions()[0].launch_selection.model,
            "gpt-5.6-terra"
        );
        assert_eq!(
            runtime.store.sessions()[0].launch_selection.reasoning,
            "xhigh"
        );
        assert!(
            !runtime
                .record_codex_thread_settings(
                    "codex-live",
                    1,
                    termloop_agents::CodexThreadSettingsObservation {
                        native_thread_id: "thread-b".into(),
                        model: Some("gpt-5.6-terra".into()),
                        permission: termloop_agents::CodexPermissionMode::BypassPermissions,
                        reasoning: Some("xhigh".into()),
                    },
                )
                .unwrap()
        );
        assert!(matches!(
            runtime.record_codex_thread_settings(
                "codex-live",
                1,
                termloop_agents::CodexThreadSettingsObservation {
                    native_thread_id: "thread-a".into(),
                    model: None,
                    permission: termloop_agents::CodexPermissionMode::Default,
                    reasoning: None,
                },
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.record_codex_thread_settings(
                "codex-live",
                2,
                termloop_agents::CodexThreadSettingsObservation {
                    native_thread_id: "thread-b".into(),
                    model: None,
                    permission: termloop_agents::CodexPermissionMode::Default,
                    reasoning: None,
                },
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(
            runtime
                .record_codex_thread_settings(
                    "codex-live",
                    1,
                    termloop_agents::CodexThreadSettingsObservation {
                        native_thread_id: "thread-b".into(),
                        model: None,
                        permission: termloop_agents::CodexPermissionMode::Default,
                        reasoning: None,
                    },
                )
                .unwrap()
        );
        assert_eq!(
            runtime.store.sessions()[0].launch_selection.permission,
            "default"
        );
        assert!(
            runtime
                .record_codex_thread_settings(
                    "codex-live",
                    1,
                    termloop_agents::CodexThreadSettingsObservation {
                        native_thread_id: "thread-b".into(),
                        model: Some("gpt-5.6-sol".into()),
                        permission: termloop_agents::CodexPermissionMode::BypassPermissions,
                        reasoning: Some("high".into()),
                    },
                )
                .unwrap()
        );

        runtime
            .store
            .mark_session_resuming(&runtime.write_authority, "codex-live")
            .unwrap();
        let rejected = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "thread-c".into(),
        )
        .unwrap();
        assert!(matches!(
            runtime.record_agent_resume_ref("codex-live", 1, rejected),
            Err(CoreError::CapabilityDenied)
        ));
        assert_eq!(
            runtime.store.sessions()[0].resume_ref.as_ref(),
            Some(&replacement)
        );
        runtime
            .store
            .mark_agent_conversation_resumable(&runtime.write_authority, "codex-live")
            .unwrap();
        drop(runtime);

        let store = Store::open(&path).unwrap();
        let restarted_authority = termloop_store::issue_core_write_authority_for_composition();
        let mut restarted =
            CoreRuntime::new(store, restarted_authority, TerminalService::default(), 2).unwrap();
        assert_eq!(
            restarted.store.sessions()[0].launch_selection.permission,
            "bypassPermissions"
        );
        assert_eq!(
            restarted.store.sessions()[0].launch_selection.model,
            "gpt-5.6-sol"
        );
        assert_eq!(
            restarted.store.sessions()[0].launch_selection.reasoning,
            "high"
        );
        let mut transport = crate::test_agent_observation_transport(std::env::temp_dir());
        transport.agents.remove("claude");
        let codex = transport.agents.get_mut("codex").unwrap();
        codex.native_fork_supported = false;
        codex.mcp_http_supported = false;
        restarted.configure_agent_observations(transport);
        let resume_plan = match restarted
            .plan_agent_resume(serde_json::json!({"sessionId": "codex-live"}))
            .unwrap()
        {
            crate::AgentResumePlanOutcome::Prepare(plan) => plan,
            crate::AgentResumePlanOutcome::Current(_) => panic!("resume was not prepared"),
        };
        assert_eq!(resume_plan.resume_ref_for_test(), &replacement);
        drop(resume_plan);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn typed_codex_status_marks_a_reserved_resume_ready() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-codex-resume-readiness-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let mut store = Store::open(&path).unwrap();
        store
            .insert_session(
                &authority,
                termloop_domain::SessionRecord {
                    launch_selection: Default::default(),
                    id: "codex-resume".into(),
                    project_id: "project-1".into(),
                    name: None,
                    kind: termloop_domain::SessionKind::Agent,
                    process: termloop_domain::ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: termloop_platform::canonical_existing_directory_path(
                            &std::env::temp_dir(),
                        )
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: "resuming".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: termloop_domain::ResumeRef::for_provider(
                        termloop_domain::ResumeProvider::Codex,
                        "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        store
            .mark_agent_conversation_resumable(&authority, "codex-resume")
            .unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap();
        runtime.configure_agent_observations(test_agent_observation_transport(
            std::env::temp_dir().join("termloop-core-codex-resume-provider"),
        ));
        runtime.resume_reservations.insert("codex-resume".into());
        runtime.agent_observations.insert(
            "codex-resume".into(),
            AgentObservationCapability {
                token: None,
                runtime_epoch: 2,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: None,
                pending_generated_input: None,
            },
        );
        assert_eq!(runtime.agent_resume_readiness("codex-resume"), Some(false));

        let resume_ref = termloop_domain::ResumeRef::for_provider(
            termloop_domain::ResumeProvider::Codex,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        assert!(matches!(
            runtime.record_agent_resume_ref("codex-resume", 1, resume_ref.clone()),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(
            !runtime
                .record_agent_resume_ref("codex-resume", 2, resume_ref)
                .unwrap()
        );
        assert_eq!(runtime.agent_resume_readiness("codex-resume"), Some(true));
        runtime.resume_ready.remove("codex-resume");

        runtime
            .record_app_server_observation(
                "codex-resume",
                2,
                termloop_agents::AgentSignal::Stopped,
                1,
                1,
            )
            .unwrap();

        assert_eq!(runtime.agent_resume_readiness("codex-resume"), Some(true));
        assert!(!runtime.agent_conversation_activity.contains("codex-resume"));
        assert!(
            runtime
                .record_app_server_plan(
                    "codex-resume",
                    2,
                    AgentPlan {
                        source: AgentPlanSource::DaemonOwnedBridge,
                        explanation: Some("Current turn".into()),
                        steps: vec![AgentPlanStep {
                            text: "Implement projection".into(),
                            status: AgentPlanStepStatus::Completed,
                        }],
                    },
                    2,
                )
                .unwrap()
        );
        let statuses = runtime.agent_status_list().unwrap();
        let status = statuses
            .as_array()
            .unwrap()
            .iter()
            .find(|status| status["sessionId"] == "codex-resume")
            .unwrap();
        assert_eq!(status["plan"]["source"], "codexAppServer");
        runtime
            .record_app_server_observation(
                "codex-resume",
                2,
                termloop_agents::AgentSignal::PromptSubmitted,
                3,
                3,
            )
            .unwrap();
        assert!(runtime.agent_conversation_activity.contains("codex-resume"));
        assert_eq!(
            runtime.store.agent_conversation_readiness("codex-resume"),
            Some(termloop_domain::AgentConversationReadiness::Resumable)
        );
        let statuses = runtime.agent_status_list().unwrap();
        let status = statuses
            .as_array()
            .unwrap()
            .iter()
            .find(|status| status["sessionId"] == "codex-resume")
            .unwrap();
        assert_eq!(status["plan"]["steps"][0]["text"], "Implement projection");
        assert!(
            runtime
                .record_app_server_plan(
                    "codex-resume",
                    2,
                    AgentPlan {
                        source: AgentPlanSource::DaemonOwnedBridge,
                        explanation: None,
                        steps: vec![],
                    },
                    4,
                )
                .unwrap()
        );
        let statuses = runtime.agent_status_list().unwrap();
        let status = statuses
            .as_array()
            .unwrap()
            .iter()
            .find(|status| status["sessionId"] == "codex-resume")
            .unwrap();
        assert!(status["plan"].is_null());
        let _ = std::fs::remove_file(path);
    }
}
