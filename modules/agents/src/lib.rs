#![forbid(unsafe_code)]

mod catalog;
mod claude_transcript;
mod codex_history;
mod codex_settings;
mod provider_hooks;
mod provider_observation;
mod session_history;

pub use catalog::{
    AgentDescriptor, BuiltinAgentAdapter, ResumeIdentityScope, agent_catalog, agent_descriptor,
    has_global_resume_identity, is_supported_agent, supports_generated_input_coordination,
    supports_tracked_helpers,
};
pub use claude_transcript::{
    ClaudeObservedModel, claude_observed_model, claude_observed_permission,
    claude_observed_reasoning, claude_turn_interrupted, normalize_claude_transcript_model,
};
pub use codex_history::{
    CodexThreadHistoryInspection, CodexThreadHistoryProbeError, CodexThreadHistoryRepair,
    CodexThreadHistoryRepairError, inspect_codex_thread_history, probe_codex_thread_history,
    repair_codex_thread_history,
};
pub use codex_settings::{
    CodexPermissionMode, CodexThreadSettingsObservation, normalize_codex_thread_settings,
};
use futures_util::{SinkExt, StreamExt};
pub use provider_hooks::{
    ProviderHookSettings, ProviderHookSettingsDelivery, provider_hook_settings,
    supports_provider_hook_observation,
};
pub use provider_observation::{
    NormalizedProviderObservation, ProviderHookObservationInput, ProviderObservationIngress,
    ProviderTurnWatch, normalize_provider_hook_observation,
};
pub use session_history::{
    AgentHistoryPreviewMessage, AgentHistoryPreviewRole, AgentHistoryScan, AgentHistoryScanIssue,
    DiscoveredAgentConversation, scan_local_agent_history, scan_local_agent_history_cancellable,
    scan_local_agent_history_cancellable_with_limit,
};
use std::collections::VecDeque;
use std::net::TcpListener;
use std::sync::mpsc::Sender;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use termloop_domain::{ResumeProvider, ResumeRef};
use tokio_tungstenite::{
    accept_async_with_config, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Unknown,
    Working,
    AwaitingInput,
    Idle,
    /// The provider is summarizing its own conversation to reclaim context.
    /// Measured on Claude Code 2.1.233 at over two minutes, which is far too
    /// long to leave indistinguishable from ordinary work.
    Compacting,
    Failed,
    Interrupted,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSignal {
    SignalUnavailable,
    SessionStarted,
    PromptSubmitted,
    ToolStarted,
    ToolFinished,
    PermissionRequested,
    Notification,
    IdleNotified,
    AmbientNotification,
    CompactStarted,
    Stopped,
    Failed,
    Interrupted,
    ClientRestartInterrupted,
    DaemonRestartInterrupted,
    SessionEnded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSignalSource {
    Hook,
    DaemonBridge,
    /// A provider-authored transcript record, read because the provider has no
    /// signal for the fact. Claude's user interrupt is the only such fact
    /// today; it is structured provider state, never terminal text.
    Transcript,
    Process,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentObservation {
    pub state: AgentState,
    pub source: AgentSignalSource,
    pub sequence: u64,
    pub observed_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationCapability {
    None,
    LaunchScopedHook,
    DaemonOwnedBridge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRuntimeSignal {
    pub session_id: String,
    pub runtime_epoch: u64,
    pub event: AgentRuntimeEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentRuntimeEvent {
    Observation(AgentSignal),
    ResumeRefObserved(ResumeRef),
    ThreadSettingsObserved(CodexThreadSettingsObservation),
    PlanUpdated(AgentPlan),
}

const MAX_AGENT_PLAN_STEPS: usize = 32;
const MAX_AGENT_PLAN_STEP_BYTES: usize = 512;
const MAX_AGENT_PLAN_EXPLANATION_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPlanSource {
    LaunchScopedHook,
    DaemonOwnedBridge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AgentPlanStep {
    pub text: String,
    pub status: AgentPlanStepStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AgentPlan {
    pub source: AgentPlanSource,
    pub explanation: Option<String>,
    pub steps: Vec<AgentPlanStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentPlanUpdate {
    Replace(AgentPlan),
    UpsertTask {
        task_id: String,
        text: String,
        status: AgentPlanStepStatus,
    },
    SetTaskStatus {
        task_id: String,
        status: AgentPlanStepStatus,
    },
    RemoveTask {
        task_id: String,
    },
}

/// Transparent, Session-scoped Codex App Server proxy. It observes only typed
/// protocol messages while forwarding every frame unchanged to the real TUI.
/// Process ownership remains outside this module.
pub struct CodexAppServerBridge {
    endpoint: String,
    stopping: tokio::sync::watch::Sender<bool>,
    worker: Option<JoinHandle<()>>,
}

// Codex serializes a saved thread into one App Server message while resuming or
// forking it, and may send that message as one WebSocket frame. Tungstenite's
// 64 MiB message and 16 MiB frame defaults disconnect valid long-running
// threads. Keep the Session-scoped loopback bridge bounded while allowing the
// provider's larger transcript projection to pass through unchanged.
const CODEX_APP_SERVER_MAX_MESSAGE_BYTES: usize = 256 << 20;

fn codex_app_server_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(CODEX_APP_SERVER_MAX_MESSAGE_BYTES))
        .max_frame_size(Some(CODEX_APP_SERVER_MAX_MESSAGE_BYTES))
}

impl CodexAppServerBridge {
    pub fn start(
        upstream_endpoint: String,
        session_id: String,
        runtime_epoch: u64,
        signals: Sender<AgentRuntimeSignal>,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let endpoint = format!("ws://{}", listener.local_addr()?);
        let (stopping, worker_stopping) = tokio::sync::watch::channel(false);
        let (ready, readiness) = std::sync::mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name(format!("codex-app-server-{session_id}"))
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                if let Ok(runtime) = runtime {
                    runtime.block_on(run_codex_proxy(
                        listener,
                        upstream_endpoint,
                        session_id,
                        runtime_epoch,
                        signals,
                        worker_stopping,
                        ready,
                    ));
                } else {
                    let _ = ready.send(false);
                }
            })?;
        if readiness.recv_timeout(Duration::from_secs(9)) != Ok(true) {
            let _ = stopping.send(true);
            let _ = worker.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "Codex App Server did not accept a WebSocket connection",
            ));
        }
        Ok(Self {
            endpoint,
            stopping,
            worker: Some(worker),
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Stops the bridge and proves its worker thread has exited. `Drop`
    /// remains a best-effort fallback, while orchestration paths that publish
    /// ownership facts use this fallible form.
    pub fn shutdown(mut self) -> std::io::Result<()> {
        self.stop()
    }

    fn stop(&mut self) -> std::io::Result<()> {
        let _ = self.stopping.send(true);
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| std::io::Error::other("Codex App Server bridge worker panicked"))?;
        }
        Ok(())
    }
}

impl Drop for CodexAppServerBridge {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCapabilities {
    pub agent_id: String,
    pub available: bool,
    /// Typed reason the CLI could not be resolved when `available` is false
    /// for a resolution failure. Probe failures of a resolved CLI keep `None`.
    pub unavailability: Option<AgentCliResolutionError>,
    pub version: Option<String>,
    pub observation: ObservationCapability,
    pub fresh_session_id_supported: bool,
    pub resume_supported: bool,
    pub native_fork_supported: bool,
    pub mcp_http_supported: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentIntegrationLevel {
    LaunchOnly,
    Observable,
    Resumable,
    Full,
}

impl AgentIntegrationLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LaunchOnly => "launchOnly",
            Self::Observable => "observable",
            Self::Resumable => "resumable",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCapabilityDegradedReason {
    CliUnavailable,
    ObservationUnavailable,
    ResumeUnavailable,
    NativeForkUnavailable,
    TrackedHelpersUnavailable,
}

impl AgentCapabilityDegradedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CliUnavailable => "cliUnavailable",
            Self::ObservationUnavailable => "observationUnavailable",
            Self::ResumeUnavailable => "resumeUnavailable",
            Self::NativeForkUnavailable => "nativeForkUnavailable",
            Self::TrackedHelpersUnavailable => "trackedHelpersUnavailable",
        }
    }
}

impl AgentCapabilities {
    pub fn quick_action_supported(&self) -> bool {
        self.available
            && self.observation != ObservationCapability::None
            && supports_generated_input_coordination(&self.agent_id)
    }

    pub fn tracked_helpers_supported(&self) -> bool {
        self.quick_action_supported()
            && self.resume_supported
            && self.mcp_http_supported
            && supports_tracked_helpers(&self.agent_id)
    }

    pub fn integration_level(&self) -> AgentIntegrationLevel {
        if !self.available || self.observation == ObservationCapability::None {
            AgentIntegrationLevel::LaunchOnly
        } else if !self.resume_supported {
            AgentIntegrationLevel::Observable
        } else if !self.native_fork_supported || !self.tracked_helpers_supported() {
            AgentIntegrationLevel::Resumable
        } else {
            AgentIntegrationLevel::Full
        }
    }

    pub fn degraded_reason(&self) -> Option<AgentCapabilityDegradedReason> {
        if !self.available {
            Some(AgentCapabilityDegradedReason::CliUnavailable)
        } else if self.observation == ObservationCapability::None {
            Some(AgentCapabilityDegradedReason::ObservationUnavailable)
        } else if !self.resume_supported {
            Some(AgentCapabilityDegradedReason::ResumeUnavailable)
        } else if !self.native_fork_supported {
            Some(AgentCapabilityDegradedReason::NativeForkUnavailable)
        } else if !self.tracked_helpers_supported() {
            Some(AgentCapabilityDegradedReason::TrackedHelpersUnavailable)
        } else {
            None
        }
    }
}

pub fn normalize_hook_event(value: &str, notification_type: Option<&str>) -> Option<AgentSignal> {
    match value {
        "SessionStart" => Some(AgentSignal::SessionStarted),
        "UserPromptSubmit" => Some(AgentSignal::PromptSubmitted),
        "PreToolUse" => Some(AgentSignal::ToolStarted),
        "PostToolUse" | "TaskCreated" | "TaskCompleted" => Some(AgentSignal::ToolFinished),
        "PermissionRequest" => Some(AgentSignal::PermissionRequested),
        "Notification" => Some(notification_signal(notification_type)),
        "PreCompact" => Some(AgentSignal::CompactStarted),
        "Stop" => Some(AgentSignal::Stopped),
        "StopFailure" => Some(AgentSignal::Failed),
        "SessionEnd" => Some(AgentSignal::SessionEnded),
        _ => None,
    }
}

/// One Notification event multiplexes unrelated desktop notices, so the event
/// name alone cannot mean "blocked on the user". `idle_prompt` is the nudge that
/// nobody has typed for a while, which is a resting turn rather than a blocked
/// one, and ambient notices carry no turn state at all. An unrecognised type
/// still claims attention: losing a real prompt is worse than an extra badge.
fn notification_signal(notification_type: Option<&str>) -> AgentSignal {
    match notification_type {
        Some("idle_prompt") => AgentSignal::IdleNotified,
        Some(
            "agent_completed"
            | "auth_success"
            | "computer_use_enter"
            | "computer_use_exit"
            | "elicitation_complete"
            | "elicitation_response"
            | "push_notification",
        ) => AgentSignal::AmbientNotification,
        _ => AgentSignal::Notification,
    }
}

pub fn reduce_observation(
    previous: Option<AgentObservation>,
    signal: AgentSignal,
    source: AgentSignalSource,
    sequence: u64,
    observed_at_epoch_ms: u64,
) -> AgentObservation {
    // `SessionEnd` also fires when a conversation ends inside a live process
    // (Claude's in-TUI `/resume` picker or `/clear`), so `Exited` is not
    // absorbing: an observation only exists while the daemon owns that live
    // process, and a genuinely exited process has its observation removed and
    // its durable lifecycle marked exited by reconciliation, after which hook
    // signals are rejected outright. Any newer authoritative signal therefore
    // proves the conversation is live again; ordering is still enforced by
    // `sequence`.
    if let Some(previous) = previous
        && sequence <= previous.sequence
    {
        return previous;
    }
    if let Some(previous) = previous
        && previous.state == AgentState::Interrupted
        && (matches!(signal, AgentSignal::Stopped | AgentSignal::IdleNotified)
            || (previous.source == AgentSignalSource::Process
                && matches!(
                    signal,
                    AgentSignal::SessionStarted
                        | AgentSignal::ToolStarted
                        | AgentSignal::ToolFinished
                )))
    {
        return previous;
    }
    if let Some(previous) = previous
        && previous.state == AgentState::Failed
        && matches!(
            signal,
            AgentSignal::Stopped | AgentSignal::IdleNotified | AgentSignal::AmbientNotification
        )
    {
        return previous;
    }
    // A Codex completion-only signal proves that already-started work finished;
    // it cannot begin a new turn. App Server can deliver an `item/completed`
    // notification after the matching `turn/completed`, so do not let that
    // trailing item regress the authoritative idle turn outcome to `working`.
    if let Some(previous) = previous
        && previous.state == AgentState::Idle
        && source == AgentSignalSource::DaemonBridge
        && signal == AgentSignal::ToolFinished
    {
        return previous;
    }
    let state = match signal {
        AgentSignal::SignalUnavailable => AgentState::Unknown,
        AgentSignal::SessionStarted => AgentState::Idle,
        AgentSignal::PromptSubmitted | AgentSignal::ToolStarted | AgentSignal::ToolFinished => {
            AgentState::Working
        }
        AgentSignal::PermissionRequested | AgentSignal::Notification => AgentState::AwaitingInput,
        AgentSignal::AmbientNotification => {
            previous.map_or(AgentState::Unknown, |previous| previous.state)
        }
        // `PreCompact` announces the intent, not the outcome: it fires before
        // the provider decides whether there is anything to compact, and
        // nothing at all fires when compaction ends. The state is therefore
        // held only until the next authoritative signal — the resumed turn's
        // tool/stop events after an auto compact, or the idle nudge after a
        // manual one.
        AgentSignal::CompactStarted => AgentState::Compacting,
        AgentSignal::Stopped | AgentSignal::IdleNotified => AgentState::Idle,
        AgentSignal::Failed => AgentState::Failed,
        AgentSignal::Interrupted
        | AgentSignal::ClientRestartInterrupted
        | AgentSignal::DaemonRestartInterrupted => AgentState::Interrupted,
        AgentSignal::SessionEnded => AgentState::Exited,
    };
    AgentObservation {
        state,
        source,
        sequence,
        observed_at_epoch_ms,
    }
}

pub fn executable_for(agent_id: &str) -> Option<&'static str> {
    agent_descriptor(agent_id)?
        .executable_candidates
        .first()
        .copied()
}

/// A typed reason a supported agent's CLI could not be resolved for launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCliResolutionError {
    /// The agent id is not in the catalog.
    UnsupportedAgent,
    /// No CLI candidate exists on the launch environment's `PATH`.
    NotFound,
    /// A candidate exists on `PATH` but cannot be launched.
    Unusable,
}

/// Resolves a supported agent's externally installed CLI through the shared
/// platform launch-target resolver. Capability discovery probes and agent
/// launches must both obtain their spawn composition from this single seam
/// (`ResolvedLaunchTarget::command_line`) against the same
/// allowlist-reconstructed launch environment, so the CLI that was probed and
/// the CLI that is spawned can never disagree.
pub fn resolve_agent_cli(
    agent_id: &str,
    environment: &termloop_platform::LaunchEnvironment,
) -> Result<termloop_platform::ResolvedLaunchTarget, AgentCliResolutionError> {
    let descriptor = agent_descriptor(agent_id).ok_or(AgentCliResolutionError::UnsupportedAgent)?;
    let mut unusable = false;
    for program in descriptor.executable_candidates {
        match termloop_platform::resolve_launch_target(program, environment) {
            Ok(target) => return Ok(target),
            Err(termloop_platform::PlatformError::LaunchTargetNotFound) => {}
            Err(_) => unusable = true,
        }
    }
    Err(if unusable {
        AgentCliResolutionError::Unusable
    } else {
        AgentCliResolutionError::NotFound
    })
}

/// Runs one bounded capability probe through the exact resolved CLI spawn
/// composition. The legacy bare-name `probe_command` is bypassed deliberately:
/// spawning a bare program name cannot start Windows `.cmd` shims.
fn probe_agent_cli(
    target: &termloop_platform::ResolvedLaunchTarget,
    environment: &termloop_platform::LaunchEnvironment,
    args: &[&str],
) -> Result<termloop_platform::CommandProbe, termloop_platform::PlatformError> {
    let (program, arguments) = target.command_line(args.iter().copied());
    let outcome = termloop_platform::run_command(
        termloop_platform::CommandRequest::new(program)
            .args(arguments)
            .launch_environment(environment.clone()),
    )?;
    Ok(termloop_platform::CommandProbe {
        success: outcome.success(),
        stdout: String::from_utf8_lossy(&outcome.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&outcome.stderr).into_owned(),
    })
}

fn unavailable_capabilities(
    agent_id: &str,
    unavailability: AgentCliResolutionError,
) -> AgentCapabilities {
    AgentCapabilities {
        agent_id: agent_id.to_owned(),
        available: false,
        unavailability: Some(unavailability),
        version: None,
        observation: ObservationCapability::None,
        fresh_session_id_supported: false,
        resume_supported: false,
        native_fork_supported: false,
        mcp_http_supported: false,
    }
}

pub fn discover_capabilities(agent_id: &str) -> AgentCapabilities {
    // The same allowlist-reconstructed environment `invocation` composes for
    // the real launch; discovery never consults the ambient process
    // environment directly.
    discover_capabilities_with_environment(
        agent_id,
        &termloop_platform::LaunchEnvironment::os_baseline(),
    )
}

pub fn discover_capabilities_with_environment(
    agent_id: &str,
    environment: &termloop_platform::LaunchEnvironment,
) -> AgentCapabilities {
    let Some(descriptor) = agent_descriptor(agent_id) else {
        return unavailable_capabilities(agent_id, AgentCliResolutionError::UnsupportedAgent);
    };
    let target = match resolve_agent_cli(agent_id, environment) {
        Ok(target) => target,
        Err(unavailability) => return unavailable_capabilities(agent_id, unavailability),
    };
    let help = probe_agent_cli(&target, environment, &["--help"]);
    let version = probe_agent_cli(&target, environment, &["--version"])
        .ok()
        .filter(|probe| probe.success)
        .and_then(|probe| first_nonempty_line(&probe.stdout, &probe.stderr));
    let available = help.is_ok();
    let app_server_help = (descriptor.adapter == BuiltinAgentAdapter::Codex)
        .then(|| probe_agent_cli(&target, environment, &["app-server", "--help"]))
        .and_then(Result::ok)
        .filter(|probe| probe.success)
        .map(|probe| format!("{}\n{}", probe.stdout, probe.stderr));
    let resume_help = (descriptor.adapter == BuiltinAgentAdapter::Codex)
        .then(|| probe_agent_cli(&target, environment, &["resume", "--help"]))
        .and_then(Result::ok)
        .filter(|probe| probe.success)
        .map(|probe| format!("{}\n{}", probe.stdout, probe.stderr));
    let fork_help = (descriptor.adapter == BuiltinAgentAdapter::Codex)
        .then(|| probe_agent_cli(&target, environment, &["fork", "--help"]))
        .and_then(Result::ok)
        .filter(|probe| probe.success)
        .map(|probe| format!("{}\n{}", probe.stdout, probe.stderr));
    let gemini_hooks_help = (descriptor.adapter == BuiltinAgentAdapter::Gemini)
        .then(|| probe_agent_cli(&target, environment, &["hooks", "--help"]))
        .and_then(Result::ok)
        .filter(|probe| probe.success)
        .map(|probe| format!("{}\n{}", probe.stdout, probe.stderr));
    let observation = help
        .as_ref()
        .ok()
        .filter(|probe| probe.success)
        .map(|probe| {
            observation_capability_for_adapter(
                descriptor.adapter,
                &probe.stdout,
                &probe.stderr,
                app_server_help.as_deref(),
                gemini_hooks_help.as_deref(),
                !termloop_platform::gemini_cli_system_defaults_source_present(environment),
            )
        })
        .unwrap_or(ObservationCapability::None);
    let mcp_http_supported = help.as_ref().is_ok_and(|probe| {
        probe.success
            && match descriptor.adapter {
                BuiltinAgentAdapter::Claude => {
                    help_advertises_flag(&probe.stdout, &probe.stderr, "--mcp-config")
                }
                BuiltinAgentAdapter::Codex => codex_http_mcp_supported(version.as_deref()),
                BuiltinAgentAdapter::Gemini => false,
            }
    });
    AgentCapabilities {
        agent_id: agent_id.to_owned(),
        available,
        unavailability: None,
        version,
        observation,
        fresh_session_id_supported: descriptor.adapter == BuiltinAgentAdapter::Claude
            && help.as_ref().is_ok_and(|probe| {
                probe.success && help_advertises_flag(&probe.stdout, &probe.stderr, "--session-id")
            }),
        resume_supported: descriptor.resume_identity_scope == ResumeIdentityScope::Global
            && match descriptor.adapter {
                BuiltinAgentAdapter::Claude => help.as_ref().is_ok_and(|probe| {
                    probe.success && help_advertises_flag(&probe.stdout, &probe.stderr, "--resume")
                }),
                BuiltinAgentAdapter::Codex => {
                    observation == ObservationCapability::DaemonOwnedBridge
                        && resume_help
                            .as_deref()
                            .is_some_and(codex_resume_help_supported)
                }
                BuiltinAgentAdapter::Gemini => help.as_ref().is_ok_and(|probe| {
                    probe.success && help_advertises_flag(&probe.stdout, &probe.stderr, "--resume")
                }),
            },
        native_fork_supported: match descriptor.adapter {
            BuiltinAgentAdapter::Claude => help.as_ref().is_ok_and(|probe| {
                probe.success
                    && help_advertises_flag(&probe.stdout, &probe.stderr, "--resume")
                    && help_advertises_flag(&probe.stdout, &probe.stderr, "--fork-session")
            }),
            BuiltinAgentAdapter::Codex => {
                observation == ObservationCapability::DaemonOwnedBridge
                    && fork_help.as_deref().is_some_and(codex_fork_help_supported)
            }
            BuiltinAgentAdapter::Gemini => false,
        },
        mcp_http_supported,
    }
}

fn codex_http_mcp_supported(version: Option<&str>) -> bool {
    let Some(((major, minor, patch), prerelease)) = codex_semver(version) else {
        return false;
    };
    prerelease.is_none() && (major, minor, patch) >= (0, 147, 0)
}

type SemanticVersion = (u64, u64, u64);
type ParsedCodexVersion<'a> = (SemanticVersion, Option<&'a str>);

fn codex_semver(version: Option<&str>) -> Option<ParsedCodexVersion<'_>> {
    let candidate = version?
        .split_ascii_whitespace()
        .map(|part| part.strip_prefix('v').unwrap_or(part))
        .find(|part| {
            part.bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_digit())
        })?;
    let (core, prerelease) = candidate
        .split_once('-')
        .map_or((candidate, None), |(core, prerelease)| {
            (core, (!prerelease.is_empty()).then_some(prerelease))
        });
    let components = core.split('.').collect::<Vec<_>>();
    if components.len() != 3
        || components
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    let mut parts = components.into_iter().map(str::parse::<u64>);
    let (Some(Ok(major)), Some(Ok(minor)), Some(Ok(patch))) =
        (parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    Some(((major, minor, patch), prerelease))
}

fn codex_resume_help_supported(help: &str) -> bool {
    help.lines().any(|line| {
        let line = line.trim();
        line.starts_with("Usage:")
            && line
                .split_ascii_whitespace()
                .any(|word| word == "[SESSION_ID]")
    })
}

fn codex_fork_help_supported(help: &str) -> bool {
    help.lines().any(|line| {
        let line = line.trim();
        line.starts_with("Usage:")
            && line
                .split_ascii_whitespace()
                .any(|word| word == "[SESSION_ID]")
    }) && help_advertises_flag(help, "", "--remote")
}

#[cfg(test)]
fn observation_capability(
    agent_id: &str,
    stdout: &str,
    stderr: &str,
    app_server_help: Option<&str>,
) -> ObservationCapability {
    agent_descriptor(agent_id).map_or(ObservationCapability::None, |descriptor| {
        observation_capability_for_adapter(
            descriptor.adapter,
            stdout,
            stderr,
            app_server_help,
            None,
            true,
        )
    })
}

fn observation_capability_for_adapter(
    adapter: BuiltinAgentAdapter,
    stdout: &str,
    stderr: &str,
    app_server_help: Option<&str>,
    gemini_hooks_help: Option<&str>,
    gemini_overlay_available: bool,
) -> ObservationCapability {
    match adapter {
        BuiltinAgentAdapter::Claude if help_advertises_flag(stdout, stderr, "--settings") => {
            ObservationCapability::LaunchScopedHook
        }
        BuiltinAgentAdapter::Codex
            if help_advertises_flag(stdout, stderr, "--remote")
                && app_server_help
                    .is_some_and(|help| help_advertises_flag(help, "", "--listen")) =>
        {
            ObservationCapability::DaemonOwnedBridge
        }
        BuiltinAgentAdapter::Gemini if gemini_overlay_available && gemini_hooks_help.is_some() => {
            ObservationCapability::LaunchScopedHook
        }
        BuiltinAgentAdapter::Claude | BuiltinAgentAdapter::Codex | BuiltinAgentAdapter::Gemini => {
            ObservationCapability::None
        }
    }
}

fn help_advertises_flag(stdout: &str, stderr: &str, flag: &str) -> bool {
    stdout.lines().chain(stderr.lines()).any(|line| {
        let line = line.trim_start();
        // Only option-declaration lines are authority. This accepts aliases
        // such as `-r, --resume [value]` without treating prose that merely
        // mentions a flag as a discovered capability.
        line.starts_with('-')
            && line.split_ascii_whitespace().any(|token| {
                let token = token.trim_end_matches(',');
                token == flag
                    || token
                        .strip_prefix(flag)
                        .is_some_and(|suffix| suffix.starts_with('='))
            })
    })
}

pub fn normalize_codex_app_server_message(raw: &str) -> Option<AgentSignal> {
    let message: serde_json::Value = serde_json::from_str(raw).ok()?;
    let method = message.get("method")?.as_str()?;
    match method {
        "thread/started" => {
            normalize_codex_thread_status(message.pointer("/params/thread/status")?)
        }
        "thread/status/changed" => {
            normalize_codex_thread_status(message.pointer("/params/status")?)
        }
        "turn/started" => Some(AgentSignal::PromptSubmitted),
        "turn/completed" => match message.pointer("/params/turn/status")?.as_str()? {
            "interrupted" => Some(AgentSignal::Interrupted),
            "completed" => Some(AgentSignal::Stopped),
            "failed" => Some(AgentSignal::Failed),
            _ => None,
        },
        // A transient `notLoaded`/`systemError` status can arrive while the
        // turn continues. These typed progress notifications are subsequent
        // authoritative proof that Codex is working, so they must recover the
        // projection instead of leaving the live Session stuck at `unknown`.
        "turn/plan/updated" | "item/started" => Some(AgentSignal::ToolStarted),
        "item/completed" => Some(AgentSignal::ToolFinished),
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval"
        | "item/tool/requestUserInput" => Some(AgentSignal::PermissionRequested),
        _ => None,
    }
}

fn normalize_codex_thread_status(status: &serde_json::Value) -> Option<AgentSignal> {
    match status.get("type")?.as_str()? {
        "idle" => Some(AgentSignal::Stopped),
        "active" => {
            let waiting = status
                .get("activeFlags")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|flags| {
                    flags.iter().any(|flag| {
                        matches!(
                            flag.as_str(),
                            Some("waitingOnApproval" | "waitingOnUserInput")
                        )
                    })
                });
            Some(if waiting {
                AgentSignal::PermissionRequested
            } else {
                AgentSignal::ToolStarted
            })
        }
        "systemError" | "notLoaded" => Some(AgentSignal::SignalUnavailable),
        _ => None,
    }
}

/// Reads the complete current plan projection emitted by Codex App Server.
/// Streaming `item/plan/delta` text is deliberately ignored: the protocol
/// explicitly does not promise that concatenated deltas equal the completed
/// plan item, while `turn/plan/updated` carries the authoritative step list.
pub fn normalize_codex_plan_update(raw: &str) -> Option<AgentPlan> {
    let message: serde_json::Value = serde_json::from_str(raw).ok()?;
    if message.get("method")?.as_str()? != "turn/plan/updated" {
        return None;
    }
    normalize_plan(
        AgentPlanSource::DaemonOwnedBridge,
        message.pointer("/params/explanation"),
        message.pointer("/params/plan")?,
        "step",
    )
}

/// Claude exposes plan changes through authenticated hooks rather than terminal
/// output. Modern Task hooks are incremental; legacy `TodoWrite` replaces the
/// complete checklist.
pub fn normalize_claude_plan_update(payload: &serde_json::Value) -> Option<AgentPlanUpdate> {
    let event = payload
        .get("hook_event_name")
        .or_else(|| payload.get("hookEventName"))?
        .as_str()?;
    if matches!(event, "TaskCreated" | "TaskCompleted") {
        let task_id = bounded_nonempty_string(
            payload.get("task_id").or_else(|| payload.get("taskId"))?,
            128,
        )?;
        let text = bounded_nonempty_string(
            payload
                .get("task_subject")
                .or_else(|| payload.get("taskSubject"))?,
            MAX_AGENT_PLAN_STEP_BYTES,
        )?;
        return Some(AgentPlanUpdate::UpsertTask {
            task_id,
            text,
            status: if event == "TaskCompleted" {
                AgentPlanStepStatus::Completed
            } else {
                AgentPlanStepStatus::Pending
            },
        });
    }
    let tool_name = payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))?
        .as_str()?;
    let tool_input = payload
        .get("tool_input")
        .or_else(|| payload.get("toolInput"))?;
    if event == "PreToolUse" && tool_name == "TodoWrite" {
        return normalize_plan(
            AgentPlanSource::LaunchScopedHook,
            None,
            tool_input.get("todos")?,
            "content",
        )
        .map(AgentPlanUpdate::Replace);
    }
    if event != "PostToolUse" || tool_name != "TaskUpdate" {
        return None;
    }
    let task_id = bounded_nonempty_string(
        tool_input
            .get("taskId")
            .or_else(|| tool_input.get("task_id"))?,
        128,
    )?;
    match tool_input.get("status")?.as_str()? {
        "pending" => Some(AgentPlanUpdate::SetTaskStatus {
            task_id,
            status: AgentPlanStepStatus::Pending,
        }),
        "in_progress" | "inProgress" => Some(AgentPlanUpdate::SetTaskStatus {
            task_id,
            status: AgentPlanStepStatus::InProgress,
        }),
        "completed" => Some(AgentPlanUpdate::SetTaskStatus {
            task_id,
            status: AgentPlanStepStatus::Completed,
        }),
        "deleted" => Some(AgentPlanUpdate::RemoveTask { task_id }),
        _ => None,
    }
}

fn bounded_nonempty_string(value: &serde_json::Value, max_bytes: usize) -> Option<String> {
    let value = value.as_str()?;
    (!value.trim().is_empty() && value.len() <= max_bytes).then(|| value.to_owned())
}

fn normalize_plan(
    source: AgentPlanSource,
    explanation: Option<&serde_json::Value>,
    steps: &serde_json::Value,
    text_key: &str,
) -> Option<AgentPlan> {
    let explanation = match explanation {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let value = value.as_str()?;
            Some((value.len() <= MAX_AGENT_PLAN_EXPLANATION_BYTES).then(|| value.to_owned())?)
        }
    };
    let steps = steps.as_array()?;
    if steps.len() > MAX_AGENT_PLAN_STEPS {
        return None;
    }
    let steps = steps
        .iter()
        .map(|step| {
            let text = step.get(text_key)?.as_str()?;
            if text.trim().is_empty() || text.len() > MAX_AGENT_PLAN_STEP_BYTES {
                return None;
            }
            let status = match step.get("status")?.as_str()? {
                "pending" => AgentPlanStepStatus::Pending,
                "inProgress" | "in_progress" => AgentPlanStepStatus::InProgress,
                "completed" => AgentPlanStepStatus::Completed,
                _ => return None,
            };
            Some(AgentPlanStep {
                text: text.to_owned(),
                status,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(AgentPlan {
        source,
        explanation,
        steps,
    })
}

pub fn normalize_codex_resume_ref(raw: &str) -> Option<ResumeRef> {
    let message: serde_json::Value = serde_json::from_str(raw).ok()?;
    if message.get("method")?.as_str()? != "thread/started" {
        return None;
    }
    let native_session_id = message.pointer("/params/thread/id")?.as_str()?.to_owned();
    ResumeRef::for_provider(ResumeProvider::Codex, native_session_id)
}

const MAX_PENDING_CODEX_THREAD_RESUMES: usize = 8;
const MAX_PENDING_CODEX_NEW_THREADS: usize = 8;

#[derive(Default)]
struct CodexAppServerThreadScope {
    native_thread_id: Option<String>,
    pending_new_thread_requests: VecDeque<String>,
}

impl CodexAppServerThreadScope {
    fn observe_downstream_request(&mut self, raw: &str) {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(raw) else {
            return;
        };
        match message.get("method").and_then(serde_json::Value::as_str) {
            Some("thread/resume") => {
                if let Some(native_thread_id) = message
                    .pointer("/params/threadId")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    self.native_thread_id = Some(native_thread_id.to_owned());
                }
            }
            Some("thread/start" | "thread/fork") => {
                let Some(id) = message.get("id").and_then(json_rpc_id_key) else {
                    return;
                };
                if self.pending_new_thread_requests.len() == MAX_PENDING_CODEX_NEW_THREADS {
                    self.pending_new_thread_requests.pop_front();
                }
                self.pending_new_thread_requests.push_back(id);
            }
            _ => {}
        }
    }

    fn observe_upstream_response(&mut self, raw: &str) {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(raw) else {
            return;
        };
        let Some(id) = message.get("id").and_then(json_rpc_id_key) else {
            return;
        };
        let Some(position) = self
            .pending_new_thread_requests
            .iter()
            .position(|candidate| candidate == &id)
        else {
            return;
        };
        self.pending_new_thread_requests.remove(position);
        if let Some(native_thread_id) = message
            .pointer("/result/thread/id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.native_thread_id = Some(native_thread_id.to_owned());
        }
    }

    fn observe_resume_ref(&mut self, resume_ref: &ResumeRef) {
        self.native_thread_id = Some(resume_ref.native_session_id.clone());
    }

    fn admits_notification(&mut self, raw: &str) -> bool {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(raw) else {
            return true;
        };
        let Some(method) = message.get("method").and_then(serde_json::Value::as_str) else {
            return true;
        };
        let Some(native_thread_id) = codex_app_server_message_thread_id(&message) else {
            // Older App Server notifications do not always carry a thread ID.
            // Preserve their existing behavior because they cannot be scoped.
            return true;
        };
        if self.native_thread_id.as_deref() == Some(native_thread_id) {
            return true;
        }
        if method == "thread/started"
            && (self.native_thread_id.is_none() || !self.pending_new_thread_requests.is_empty())
        {
            self.native_thread_id = Some(native_thread_id.to_owned());
            return true;
        }
        // Until the client selects a thread, retain the old fail-open behavior.
        // Once selected, global notifications for history probes, pickers, and
        // other threads must not mutate this TermLoop Session's projection.
        self.native_thread_id.is_none()
    }
}

fn codex_app_server_message_thread_id(message: &serde_json::Value) -> Option<&str> {
    message
        .pointer("/params/threadId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            message
                .pointer("/params/thread/id")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
        })
}

fn observe_codex_thread_resume_request(raw: &str, pending: &mut VecDeque<String>) {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    if message.get("method").and_then(serde_json::Value::as_str) != Some("thread/resume") {
        return;
    }
    let Some(id) = message.get("id").and_then(json_rpc_id_key) else {
        return;
    };
    if pending.len() == MAX_PENDING_CODEX_THREAD_RESUMES {
        pending.pop_front();
    }
    pending.push_back(id);
}

fn normalize_codex_thread_resume_response(
    raw: &str,
    pending: &mut VecDeque<String>,
) -> Option<ResumeRef> {
    let message: serde_json::Value = serde_json::from_str(raw).ok()?;
    let id = message.get("id").and_then(json_rpc_id_key)?;
    let position = pending.iter().position(|candidate| candidate == &id)?;
    pending.remove(position);
    let native_session_id = message.pointer("/result/thread/id")?.as_str()?.to_owned();
    ResumeRef::for_provider(ResumeProvider::Codex, native_session_id)
}

fn json_rpc_id_key(value: &serde_json::Value) -> Option<String> {
    matches!(
        value,
        serde_json::Value::String(_) | serde_json::Value::Number(_)
    )
    .then(|| value.to_string())
}

async fn run_codex_proxy(
    listener: TcpListener,
    upstream_endpoint: String,
    session_id: String,
    runtime_epoch: u64,
    signals: Sender<AgentRuntimeSignal>,
    mut stopping: tokio::sync::watch::Receiver<bool>,
    ready: std::sync::mpsc::SyncSender<bool>,
) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        let _ = ready.send(false);
        return;
    };
    let Some(upstream) = connect_upstream(&upstream_endpoint, &mut stopping).await else {
        let _ = ready.send(false);
        return;
    };
    let _ = ready.send(true);
    let mut first_upstream = Some(upstream);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                let upstream = match first_upstream.take() {
                    Some(upstream) => Some(upstream),
                    None => connect_upstream(&upstream_endpoint, &mut stopping).await,
                };
                let Some(upstream) = upstream else { break };
                connections.spawn(proxy_codex_connection(
                    stream,
                    upstream,
                    session_id.clone(),
                    runtime_epoch,
                    signals.clone(),
                    stopping.clone(),
                ));
            }
            _ = connections.join_next(), if !connections.is_empty() => {}
            _ = stopping.changed() => break,
        }
    }
    while connections.join_next().await.is_some() {}
}

async fn proxy_codex_connection(
    downstream: tokio::net::TcpStream,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    session_id: String,
    runtime_epoch: u64,
    signals: Sender<AgentRuntimeSignal>,
    mut stopping: tokio::sync::watch::Receiver<bool>,
) {
    let Ok(downstream) =
        accept_async_with_config(downstream, Some(codex_app_server_websocket_config())).await
    else {
        return;
    };
    let (mut upstream_write, mut upstream_read) = upstream.split();
    let (mut downstream_write, mut downstream_read) = downstream.split();
    let mut pending_thread_resumes = VecDeque::new();
    let mut thread_scope = CodexAppServerThreadScope::default();
    loop {
        tokio::select! {
            frame = upstream_read.next() => match frame {
                Some(Ok(message)) => {
                    if let Message::Text(text) = &message {
                        thread_scope.observe_upstream_response(text);
                        let notification_is_in_scope = thread_scope.admits_notification(text);
                        if let Some(resume_ref) = normalize_codex_thread_resume_response(
                            text,
                            &mut pending_thread_resumes,
                        ) {
                            thread_scope.observe_resume_ref(&resume_ref);
                            let _ = signals.send(AgentRuntimeSignal {
                                session_id: session_id.clone(),
                                runtime_epoch,
                                event: AgentRuntimeEvent::ResumeRefObserved(resume_ref),
                            });
                        }
                        if notification_is_in_scope {
                            if let Some(resume_ref) = normalize_codex_resume_ref(text) {
                                thread_scope.observe_resume_ref(&resume_ref);
                                let _ = signals.send(AgentRuntimeSignal {
                                    session_id: session_id.clone(),
                                    runtime_epoch,
                                    event: AgentRuntimeEvent::ResumeRefObserved(resume_ref),
                                });
                            }
                            if let Some(signal) = normalize_codex_app_server_message(text) {
                                let _ = signals.send(AgentRuntimeSignal {
                                    session_id: session_id.clone(),
                                    runtime_epoch,
                                    event: AgentRuntimeEvent::Observation(signal),
                                });
                            }
                            if let Some(plan) = normalize_codex_plan_update(text) {
                                let _ = signals.send(AgentRuntimeSignal {
                                    session_id: session_id.clone(),
                                    runtime_epoch,
                                    event: AgentRuntimeEvent::PlanUpdated(plan),
                                });
                            }
                            if let Some(settings) = normalize_codex_thread_settings(text) {
                                let _ = signals.send(AgentRuntimeSignal {
                                    session_id: session_id.clone(),
                                    runtime_epoch,
                                    event: AgentRuntimeEvent::ThreadSettingsObserved(settings),
                                });
                            }
                        }
                    }
                    if downstream_write.send(message).await.is_err() { break; }
                }
                _ => break,
            },
            frame = downstream_read.next() => match frame {
                Some(Ok(message)) => {
                    if let Message::Text(text) = &message {
                        thread_scope.observe_downstream_request(text);
                        observe_codex_thread_resume_request(text, &mut pending_thread_resumes);
                    }
                    if upstream_write.send(message).await.is_err() { break; }
                }
                _ => break,
            },
            _ = stopping.changed() => break,
        }
    }
    let _ = upstream_write.close().await;
    let _ = downstream_write.close().await;
}

async fn connect_upstream(
    endpoint: &str,
    stopping: &mut tokio::sync::watch::Receiver<bool>,
) -> Option<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !*stopping.borrow() && Instant::now() < deadline {
        tokio::select! {
            result = connect_async_with_config(
                endpoint,
                Some(codex_app_server_websocket_config()),
                false,
            ) => {
                if let Ok((socket, _)) = result {
                    return Some(socket);
                }
            }
            _ = stopping.changed() => return None,
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            _ = stopping.changed() => return None,
        }
    }
    None
}

fn first_nonempty_line(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reducer_uses_structured_signals_and_newer_signals_revive_an_exit() {
        let idle = reduce_observation(
            None,
            AgentSignal::SessionStarted,
            AgentSignalSource::Hook,
            1,
            9,
        );
        assert_eq!(idle.state, AgentState::Idle);
        let working = reduce_observation(
            Some(idle),
            AgentSignal::PromptSubmitted,
            AgentSignalSource::Hook,
            2,
            10,
        );
        assert_eq!(working.state, AgentState::Working);
        let awaiting = reduce_observation(
            Some(working),
            AgentSignal::PermissionRequested,
            AgentSignalSource::Hook,
            3,
            11,
        );
        assert_eq!(awaiting.state, AgentState::AwaitingInput);
        let exited = reduce_observation(
            Some(awaiting),
            AgentSignal::SessionEnded,
            AgentSignalSource::Hook,
            4,
            12,
        );
        assert_eq!(exited.state, AgentState::Exited);
        // A live process is the only thing that can deliver a newer signal, so
        // the exit is not absorbing.
        assert_eq!(
            reduce_observation(
                Some(exited),
                AgentSignal::PromptSubmitted,
                AgentSignalSource::Hook,
                5,
                13,
            )
            .state,
            AgentState::Working
        );
    }

    #[test]
    fn session_start_revives_an_exited_conversation_in_a_live_process() {
        let exited = reduce_observation(
            None,
            AgentSignal::SessionEnded,
            AgentSignalSource::Hook,
            1,
            10,
        );
        assert_eq!(exited.state, AgentState::Exited);
        // A stale SessionStart from before the end never resurrects.
        assert_eq!(
            reduce_observation(
                Some(exited),
                AgentSignal::SessionStarted,
                AgentSignalSource::Hook,
                1,
                10,
            ),
            exited
        );
        // The in-TUI /resume or /clear flow: SessionEnd then SessionStart in
        // the same live process must land back on a live idle turn.
        let revived = reduce_observation(
            Some(exited),
            AgentSignal::SessionStarted,
            AgentSignalSource::Hook,
            2,
            11,
        );
        assert_eq!(revived.state, AgentState::Idle);
        assert_eq!(revived.sequence, 2);
        let working = reduce_observation(
            Some(revived),
            AgentSignal::PromptSubmitted,
            AgentSignalSource::Hook,
            3,
            12,
        );
        assert_eq!(working.state, AgentState::Working);
    }

    #[test]
    fn structured_work_recovers_a_transient_unavailable_app_server_status() {
        let unavailable_signal = normalize_codex_app_server_message(
            r#"{"method":"thread/status/changed","params":{"status":{"type":"notLoaded"}}}"#,
        )
        .unwrap();
        let unavailable = reduce_observation(
            None,
            unavailable_signal,
            AgentSignalSource::DaemonBridge,
            1,
            10,
        );
        assert_eq!(unavailable.state, AgentState::Unknown);

        let progress_signal = normalize_codex_app_server_message(
            r#"{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"reasoning","id":"item-1"}}}"#,
        )
        .unwrap();
        let recovered = reduce_observation(
            Some(unavailable),
            progress_signal,
            AgentSignalSource::DaemonBridge,
            2,
            11,
        );
        assert_eq!(recovered.state, AgentState::Working);
        assert_eq!(recovered.source, AgentSignalSource::DaemonBridge);
    }

    #[test]
    fn terminal_like_text_is_not_a_hook_observation() {
        assert_eq!(
            normalize_hook_event("Allow this command? [y/N]", None),
            None
        );
        assert_eq!(normalize_hook_event("waiting for input", None), None);
    }

    #[test]
    fn idle_notification_rests_the_turn_while_attention_notices_block_it() {
        assert_eq!(
            normalize_hook_event("Notification", Some("idle_prompt")),
            Some(AgentSignal::IdleNotified)
        );
        assert_eq!(
            normalize_hook_event("Notification", Some("worker_permission_prompt")),
            Some(AgentSignal::Notification)
        );
        assert_eq!(
            normalize_hook_event("Notification", Some("agent_needs_input")),
            Some(AgentSignal::Notification)
        );
        assert_eq!(
            normalize_hook_event("Notification", Some("auth_success")),
            Some(AgentSignal::AmbientNotification)
        );
        // An unrecognised or absent type keeps the pre-existing attention meaning.
        assert_eq!(
            normalize_hook_event("Notification", Some("future_prompt_kind")),
            Some(AgentSignal::Notification)
        );
        assert_eq!(
            normalize_hook_event("Notification", None),
            Some(AgentSignal::Notification)
        );
    }

    #[test]
    fn compaction_is_its_own_state_and_yields_to_the_next_real_signal() {
        assert_eq!(
            normalize_hook_event("PreCompact", None),
            Some(AgentSignal::CompactStarted)
        );
        // An auto compact happens inside a working turn.
        let working = reduce_observation(
            None,
            AgentSignal::PromptSubmitted,
            AgentSignalSource::Hook,
            1,
            10,
        );
        let compacting = reduce_observation(
            Some(working),
            AgentSignal::CompactStarted,
            AgentSignalSource::Hook,
            2,
            11,
        );
        assert_eq!(compacting.state, AgentState::Compacting);
        // Nothing fires when compaction ends, so the resumed turn's own tool
        // event is what retires the state.
        let resumed = reduce_observation(
            Some(compacting),
            AgentSignal::ToolFinished,
            AgentSignalSource::Hook,
            3,
            12,
        );
        assert_eq!(resumed.state, AgentState::Working);
        // A manual compact rests instead, via the provider's idle nudge.
        let rested = reduce_observation(
            Some(compacting),
            AgentSignal::IdleNotified,
            AgentSignalSource::Hook,
            3,
            12,
        );
        assert_eq!(rested.state, AgentState::Idle);
    }

    #[test]
    fn a_stopped_turn_stays_idle_through_the_idle_nudge() {
        let working = reduce_observation(
            None,
            AgentSignal::PromptSubmitted,
            AgentSignalSource::Hook,
            1,
            10,
        );
        let stopped = reduce_observation(
            Some(working),
            AgentSignal::Stopped,
            AgentSignalSource::Hook,
            2,
            11,
        );
        assert_eq!(stopped.state, AgentState::Idle);
        let nudged = reduce_observation(
            Some(stopped),
            AgentSignal::IdleNotified,
            AgentSignalSource::Hook,
            3,
            12,
        );
        assert_eq!(nudged.state, AgentState::Idle);
        let blocked = reduce_observation(
            Some(nudged),
            AgentSignal::Notification,
            AgentSignalSource::Hook,
            4,
            13,
        );
        assert_eq!(blocked.state, AgentState::AwaitingInput);
    }

    #[test]
    fn a_failed_claude_turn_remains_failed_until_new_work_starts() {
        assert_eq!(
            normalize_hook_event("StopFailure", None),
            Some(AgentSignal::Failed)
        );
        let working = reduce_observation(
            None,
            AgentSignal::PromptSubmitted,
            AgentSignalSource::Hook,
            1,
            10,
        );
        let failed = reduce_observation(
            Some(working),
            AgentSignal::Failed,
            AgentSignalSource::Hook,
            2,
            11,
        );
        assert_eq!(failed.state, AgentState::Failed);
        let idle_nudge = reduce_observation(
            Some(failed),
            AgentSignal::IdleNotified,
            AgentSignalSource::Hook,
            3,
            12,
        );
        assert_eq!(idle_nudge.state, AgentState::Failed);
        let resumed = reduce_observation(
            Some(idle_nudge),
            AgentSignal::PromptSubmitted,
            AgentSignalSource::Hook,
            4,
            13,
        );
        assert_eq!(resumed.state, AgentState::Working);
    }

    #[test]
    fn ambient_notifications_do_not_move_the_turn() {
        let working = reduce_observation(
            None,
            AgentSignal::ToolStarted,
            AgentSignalSource::Hook,
            1,
            10,
        );
        let ambient = reduce_observation(
            Some(working),
            AgentSignal::AmbientNotification,
            AgentSignalSource::Hook,
            2,
            11,
        );
        assert_eq!(ambient.state, AgentState::Working);
        assert_eq!(ambient.sequence, 2);
        let unseeded = reduce_observation(
            None,
            AgentSignal::AmbientNotification,
            AgentSignalSource::Hook,
            1,
            10,
        );
        assert_eq!(unseeded.state, AgentState::Unknown);
    }

    #[test]
    fn an_interrupted_turn_is_not_cleared_by_the_idle_nudge() {
        let interrupted = reduce_observation(
            None,
            AgentSignal::Interrupted,
            AgentSignalSource::Hook,
            1,
            10,
        );
        assert_eq!(
            reduce_observation(
                Some(interrupted),
                AgentSignal::IdleNotified,
                AgentSignalSource::Hook,
                2,
                11,
            ),
            interrupted
        );
    }

    #[test]
    fn a_client_restart_interrupts_working_until_the_next_structured_turn() {
        let working = reduce_observation(
            None,
            AgentSignal::ToolStarted,
            AgentSignalSource::DaemonBridge,
            1,
            10,
        );
        let interrupted = reduce_observation(
            Some(working),
            AgentSignal::ClientRestartInterrupted,
            AgentSignalSource::Process,
            2,
            11,
        );
        assert_eq!(interrupted.state, AgentState::Interrupted);
        assert_eq!(interrupted.source, AgentSignalSource::Process);
        assert_eq!(
            reduce_observation(
                Some(interrupted),
                AgentSignal::Stopped,
                AgentSignalSource::DaemonBridge,
                3,
                12,
            ),
            interrupted
        );
        let resumed_work = reduce_observation(
            Some(interrupted),
            AgentSignal::PromptSubmitted,
            AgentSignalSource::DaemonBridge,
            4,
            13,
        );
        assert_eq!(resumed_work.state, AgentState::Working);
        assert_eq!(resumed_work.source, AgentSignalSource::DaemonBridge);
    }

    #[test]
    fn daemon_restart_interruption_survives_codex_bootstrap_only() {
        let codex_interrupted = reduce_observation(
            None,
            AgentSignal::DaemonRestartInterrupted,
            AgentSignalSource::Process,
            1,
            10,
        );
        assert_eq!(codex_interrupted.state, AgentState::Interrupted);
        assert_eq!(
            reduce_observation(
                Some(codex_interrupted),
                AgentSignal::ToolStarted,
                AgentSignalSource::DaemonBridge,
                2,
                11,
            ),
            codex_interrupted
        );
        assert_eq!(
            reduce_observation(
                Some(codex_interrupted),
                AgentSignal::ToolFinished,
                AgentSignalSource::DaemonBridge,
                3,
                12,
            ),
            codex_interrupted
        );
        assert_eq!(
            reduce_observation(
                Some(codex_interrupted),
                AgentSignal::PromptSubmitted,
                AgentSignalSource::DaemonBridge,
                4,
                13,
            )
            .state,
            AgentState::Working
        );
    }

    #[test]
    fn duplicate_reordered_and_late_observations_do_not_regress_state() {
        let working = reduce_observation(
            None,
            AgentSignal::ToolStarted,
            AgentSignalSource::Hook,
            10,
            100,
        );
        let duplicate = reduce_observation(
            Some(working),
            AgentSignal::ToolStarted,
            AgentSignalSource::Hook,
            11,
            101,
        );
        assert_eq!(duplicate.state, working.state);
        assert_eq!(duplicate.sequence, 11);
        assert_eq!(
            reduce_observation(
                Some(duplicate),
                AgentSignal::Stopped,
                AgentSignalSource::Hook,
                10,
                100,
            ),
            duplicate
        );
        let exited = reduce_observation(
            Some(duplicate),
            AgentSignal::SessionEnded,
            AgentSignalSource::Hook,
            12,
            102,
        );
        // A stale delivery from before the end never rewrites the exit...
        assert_eq!(
            reduce_observation(
                Some(exited),
                AgentSignal::ToolFinished,
                AgentSignalSource::Hook,
                12,
                101,
            ),
            exited
        );
        // ...but a genuinely newer signal proves the process is still live.
        assert_eq!(
            reduce_observation(
                Some(exited),
                AgentSignal::ToolFinished,
                AgentSignalSource::Hook,
                13,
                103,
            )
            .state,
            AgentState::Working
        );
    }

    #[test]
    fn a_late_codex_item_completion_cannot_reopen_a_completed_turn() {
        let working = reduce_observation(
            None,
            AgentSignal::PromptSubmitted,
            AgentSignalSource::DaemonBridge,
            1,
            100,
        );
        let completed = reduce_observation(
            Some(working),
            AgentSignal::Stopped,
            AgentSignalSource::DaemonBridge,
            2,
            200,
        );
        assert_eq!(completed.state, AgentState::Idle);

        let late_item = reduce_observation(
            Some(completed),
            AgentSignal::ToolFinished,
            AgentSignalSource::DaemonBridge,
            3,
            300,
        );
        assert_eq!(late_item, completed);

        let next_turn = reduce_observation(
            Some(late_item),
            AgentSignal::PromptSubmitted,
            AgentSignalSource::DaemonBridge,
            4,
            400,
        );
        assert_eq!(next_turn.state, AgentState::Working);
    }

    #[test]
    fn capability_parser_enables_only_a_supported_claude_settings_flag() {
        assert!(help_advertises_flag(
            "  -r, --resume [value]  Resume by session ID",
            "",
            "--resume"
        ));
        assert!(!help_advertises_flag(
            "Resume later with --resume when needed",
            "",
            "--resume"
        ));
        assert_eq!(
            observation_capability("claude", "  --settings <file>  Settings path", "", None),
            ObservationCapability::LaunchScopedHook
        );
        assert!(codex_resume_help_supported(
            "Usage: codex resume [OPTIONS] [SESSION_ID]\n  --remote <ADDR>"
        ));
        assert!(!codex_resume_help_supported(
            "Usage: codex resume [OPTIONS]\n  --remote <ADDR>"
        ));
        assert!(codex_fork_help_supported(
            "Usage: codex fork [OPTIONS] [SESSION_ID] [PROMPT]\n  --remote <ADDR>"
        ));
        assert!(!codex_fork_help_supported(
            "Usage: codex fork [OPTIONS] [SESSION_ID] [PROMPT]"
        ));
        assert_eq!(
            observation_capability(
                "claude",
                "Use configuration supplied via --settings when available",
                "",
                None,
            ),
            ObservationCapability::None
        );
        assert!(codex_http_mcp_supported(Some("codex-cli 0.147.0")));
        assert!(codex_http_mcp_supported(Some("codex-cli 0.148.1")));
        assert!(!codex_http_mcp_supported(Some("codex-cli 0.146.9")));
        assert!(!codex_http_mcp_supported(Some("codex-cli 0.147.0-beta")));
        assert!(!codex_http_mcp_supported(Some("development build")));
        assert_eq!(
            observation_capability("claude", "Usage: claude", "", None),
            ObservationCapability::None
        );
        assert_eq!(
            observation_capability("codex", "Usage: codex [--settings file]", "", None),
            ObservationCapability::None
        );
        assert_eq!(
            observation_capability("codex", "Usage: codex\n  --remote <ADDR>", "", None,),
            ObservationCapability::None
        );
        assert_eq!(
            observation_capability(
                "codex",
                "Usage: codex\n  --remote <ADDR>",
                "",
                Some("Usage: codex app-server\n  --listen <ADDR>"),
            ),
            ObservationCapability::DaemonOwnedBridge
        );
        assert!(codex_resume_help_supported(
            "Usage: codex resume [OPTIONS] [SESSION_ID]"
        ));
        assert!(!codex_resume_help_supported(
            "Usage: codex resume [OPTIONS]"
        ));
    }

    #[test]
    fn integration_levels_are_capability_derived_and_honest() {
        let capabilities =
            |agent_id: &str,
             available: bool,
             observation: ObservationCapability,
             resume_supported: bool,
             native_fork_supported: bool,
             mcp_http_supported: bool| AgentCapabilities {
                agent_id: agent_id.into(),
                available,
                unavailability: None,
                version: None,
                observation,
                fresh_session_id_supported: false,
                resume_supported,
                native_fork_supported,
                mcp_http_supported,
            };
        let full = capabilities(
            "claude",
            true,
            ObservationCapability::LaunchScopedHook,
            true,
            true,
            true,
        );
        assert_eq!(full.integration_level(), AgentIntegrationLevel::Full);
        assert_eq!(full.degraded_reason(), None);
        assert!(full.quick_action_supported());
        assert!(full.tracked_helpers_supported());

        let gemini = capabilities(
            "gemini",
            true,
            ObservationCapability::LaunchScopedHook,
            false,
            false,
            false,
        );
        assert_eq!(
            gemini.integration_level(),
            AgentIntegrationLevel::Observable
        );
        assert_eq!(
            gemini.degraded_reason(),
            Some(AgentCapabilityDegradedReason::ResumeUnavailable)
        );
        assert!(gemini.quick_action_supported());
        assert!(!gemini.tracked_helpers_supported());

        let unavailable = capabilities(
            "gemini",
            false,
            ObservationCapability::None,
            false,
            false,
            false,
        );
        assert_eq!(
            unavailable.degraded_reason(),
            Some(AgentCapabilityDegradedReason::CliUnavailable)
        );
    }

    #[test]
    fn codex_app_server_status_is_normalized_from_structured_frames() {
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"thread/started","params":{"thread":{"id":"thread-1","status":{"type":"idle"}}}}"#,
            ),
            Some(AgentSignal::Stopped)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"thread/status/changed","params":{"status":{"type":"active","activeFlags":[]}}}"#,
            ),
            Some(AgentSignal::ToolStarted)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"thread/status/changed","params":{"status":{"type":"active","activeFlags":["waitingOnApproval"]}}}"#,
            ),
            Some(AgentSignal::PermissionRequested)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"thread/status/changed","params":{"status":{"type":"idle"}}}"#,
            ),
            Some(AgentSignal::Stopped)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"turn/plan/updated","params":{"threadId":"thread-1","turnId":"turn-1","plan":[]}}"#,
            ),
            Some(AgentSignal::ToolStarted)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"reasoning","id":"item-1"}}}"#,
            ),
            Some(AgentSignal::ToolStarted)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"reasoning","id":"item-1"}}}"#,
            ),
            Some(AgentSignal::ToolFinished)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"interrupted"}}}"#,
            ),
            Some(AgentSignal::Interrupted)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"turn/completed","params":{"turn":{"id":"turn-2","status":"completed"}}}"#,
            ),
            Some(AgentSignal::Stopped)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"turn/completed","params":{"turn":{"id":"turn-3","status":"failed"}}}"#,
            ),
            Some(AgentSignal::Failed)
        );
        assert_eq!(
            normalize_codex_app_server_message(
                r#"{"method":"item/commandExecution/requestApproval","id":7,"params":{}}"#,
            ),
            Some(AgentSignal::PermissionRequested)
        );
        assert_eq!(
            normalize_codex_app_server_message("Allow this command? [y/N]"),
            None
        );
        let resume_ref = normalize_codex_resume_ref(
            r#"{"method":"thread/started","params":{"thread":{"id":"019f1dae-3bf3-73d1-b3c7-08ddbbd1f035","sessionId":"do-not-use"}}}"#,
        )
        .unwrap();
        assert_eq!(resume_ref.provider, ResumeProvider::Codex);
        assert_eq!(
            resume_ref.native_session_id,
            "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035"
        );
        assert!(
            normalize_codex_resume_ref(
                r#"{"method":"thread/started","params":{"thread":{"sessionId":"wrong"}}}"#
            )
            .is_none()
        );

        let mut pending = VecDeque::new();
        observe_codex_thread_resume_request(
            r#"{"id":42,"method":"thread/resume","params":{"threadId":"thread-b"}}"#,
            &mut pending,
        );
        assert!(
            normalize_codex_thread_resume_response(
                r#"{"id":41,"result":{"thread":{"id":"wrong-thread"}}}"#,
                &mut pending,
            )
            .is_none()
        );
        let resumed = normalize_codex_thread_resume_response(
            r#"{"id":42,"result":{"thread":{"id":"thread-b"}}}"#,
            &mut pending,
        )
        .unwrap();
        assert_eq!(resumed.provider, ResumeProvider::Codex);
        assert_eq!(resumed.native_session_id, "thread-b");
        assert!(pending.is_empty());

        observe_codex_thread_resume_request(
            r#"{"id":"failed","method":"thread/resume","params":{"threadId":"thread-c"}}"#,
            &mut pending,
        );
        assert!(
            normalize_codex_thread_resume_response(
                r#"{"id":"failed","error":{"code":-32600,"message":"active writer"}}"#,
                &mut pending,
            )
            .is_none()
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn provider_plan_updates_are_complete_bounded_structured_projections() {
        let codex = normalize_codex_plan_update(
            r#"{"method":"turn/plan/updated","params":{"threadId":"thread-1","turnId":"turn-1","explanation":"Ship safely","plan":[{"step":"Inspect the flow","status":"completed"},{"step":"Implement the projection","status":"inProgress"},{"step":"Run tests","status":"pending"}]}}"#,
        )
        .unwrap();
        assert_eq!(codex.source, AgentPlanSource::DaemonOwnedBridge);
        assert_eq!(codex.explanation.as_deref(), Some("Ship safely"));
        assert_eq!(codex.steps.len(), 3);
        assert_eq!(codex.steps[1].status, AgentPlanStepStatus::InProgress);

        let claude = normalize_claude_plan_update(&serde_json::json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "TodoWrite",
            "tool_input": {
                "todos": [
                    { "content": "Inspect the flow", "status": "completed", "activeForm": "Inspecting" },
                    { "content": "Run tests", "status": "in_progress", "activeForm": "Testing" }
                ]
            }
        }))
        .unwrap();
        let AgentPlanUpdate::Replace(claude) = claude else {
            panic!("TodoWrite must replace the plan")
        };
        assert_eq!(claude.source, AgentPlanSource::LaunchScopedHook);
        assert_eq!(claude.steps[1].status, AgentPlanStepStatus::InProgress);
        assert!(claude.explanation.is_none());

        assert_eq!(
            normalize_claude_plan_update(&serde_json::json!({
                "hook_event_name": "TaskCreated",
                "task_id": "7",
                "task_subject": "Wire the sidebar"
            })),
            Some(AgentPlanUpdate::UpsertTask {
                task_id: "7".into(),
                text: "Wire the sidebar".into(),
                status: AgentPlanStepStatus::Pending,
            })
        );
        assert_eq!(
            normalize_claude_plan_update(&serde_json::json!({
                "hook_event_name": "PostToolUse",
                "tool_name": "TaskUpdate",
                "tool_input": { "taskId": "7", "status": "in_progress" }
            })),
            Some(AgentPlanUpdate::SetTaskStatus {
                task_id: "7".into(),
                status: AgentPlanStepStatus::InProgress,
            })
        );
        assert_eq!(
            normalize_claude_plan_update(&serde_json::json!({
                "hook_event_name": "TaskCompleted",
                "task_id": "7",
                "task_subject": "Wire the sidebar"
            })),
            Some(AgentPlanUpdate::UpsertTask {
                task_id: "7".into(),
                text: "Wire the sidebar".into(),
                status: AgentPlanStepStatus::Completed,
            })
        );

        assert!(
            normalize_codex_plan_update(
                r#"{"method":"item/plan/delta","params":{"delta":"not authoritative"}}"#
            )
            .is_none()
        );
        assert!(
            normalize_claude_plan_update(&serde_json::json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": { "todos": [] }
            }))
            .is_none()
        );
        assert!(
            normalize_claude_plan_update(&serde_json::json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "TodoWrite",
                "tool_input": { "todos": [{ "content": " ", "status": "pending" }] }
            }))
            .is_none()
        );
    }

    #[test]
    fn codex_interruption_survives_trailing_idle_until_the_next_turn() {
        let working = reduce_observation(
            None,
            AgentSignal::PromptSubmitted,
            AgentSignalSource::DaemonBridge,
            1,
            10,
        );
        let interrupted = reduce_observation(
            Some(working),
            AgentSignal::Interrupted,
            AgentSignalSource::DaemonBridge,
            2,
            11,
        );
        assert_eq!(interrupted.state, AgentState::Interrupted);
        assert_eq!(
            reduce_observation(
                Some(interrupted),
                AgentSignal::Stopped,
                AgentSignalSource::DaemonBridge,
                3,
                12,
            ),
            interrupted
        );
        assert_eq!(
            reduce_observation(
                Some(interrupted),
                AgentSignal::PromptSubmitted,
                AgentSignalSource::DaemonBridge,
                4,
                13,
            )
            .state,
            AgentState::Working
        );
    }

    fn capability_fixture_directory(label: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "termloop-agents-cli-{label}-{}-{}",
            std::process::id(),
            termloop_platform::current_epoch_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn unresolved_agent_clis_degrade_to_typed_unavailability() {
        let directory = capability_fixture_directory("missing");
        let environment =
            termloop_platform::LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        assert!(matches!(
            resolve_agent_cli("claude", &environment),
            Err(AgentCliResolutionError::NotFound)
        ));
        assert!(matches!(
            resolve_agent_cli("unknown", &environment),
            Err(AgentCliResolutionError::UnsupportedAgent)
        ));
        let missing = discover_capabilities_with_environment("claude", &environment);
        assert!(!missing.available);
        assert_eq!(
            missing.unavailability,
            Some(AgentCliResolutionError::NotFound)
        );
        assert_eq!(missing.observation, ObservationCapability::None);
        let unsupported = discover_capabilities_with_environment("unknown", &environment);
        assert!(!unsupported.available);
        assert_eq!(
            unsupported.unavailability,
            Some(AgentCliResolutionError::UnsupportedAgent)
        );
        // A present-but-unusable candidate needs the POSIX execute-bit model.
        if termloop_platform::test_support::write_unusable_cli_fixture(&directory, "codex") {
            assert!(matches!(
                resolve_agent_cli("codex", &environment),
                Err(AgentCliResolutionError::Unusable)
            ));
            let unusable = discover_capabilities_with_environment("codex", &environment);
            assert!(!unusable.available);
            assert_eq!(
                unusable.unavailability,
                Some(AgentCliResolutionError::Unusable)
            );
        }
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn claude_discovery_probes_run_through_the_resolved_launch_target() {
        let directory = capability_fixture_directory("claude");
        let fixture_path = termloop_platform::test_support::write_cli_fixture(
            &directory,
            "claude",
            concat!(
                "#!/bin/sh\n",
                "case \"$1\" in\n",
                "--help)\n",
                "printf '  --settings <file>  Settings path\\n'\n",
                "printf '  --resume [id]  Resume a session\\n'\n",
                "printf '  --fork-session  Fork on resume\\n'\n",
                "printf '  --session-id <id>  Fresh session id\\n'\n",
                "printf '  --mcp-config <file>  MCP config\\n'\n",
                "exit 0 ;;\n",
                "--version)\n",
                "printf '9.9.9 (Fixture Claude)\\n'\n",
                "exit 0 ;;\n",
                "esac\n",
                "exit 1\n",
            ),
            concat!(
                "@echo off\r\n",
                "if \"%1\"==\"--help\" (echo   --settings ^<file^>  Settings path& echo   --resume [id]  Resume a session& echo   --fork-session  Fork on resume& echo   --session-id ^<id^>  Fresh session id& echo   --mcp-config ^<file^>  MCP config& exit /b 0)\r\n",
                "if \"%1\"==\"--version\" (echo 9.9.9 ^(Fixture Claude^)& exit /b 0)\r\n",
                "exit /b 1\r\n",
            ),
        )
        .unwrap();
        let environment =
            termloop_platform::LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        let target = resolve_agent_cli("claude", &environment).unwrap();
        assert_eq!(target.target_path(), fixture_path.as_path());
        let capabilities = discover_capabilities_with_environment("claude", &environment);
        assert!(capabilities.available);
        assert_eq!(capabilities.unavailability, None);
        assert_eq!(
            capabilities.version.as_deref(),
            Some("9.9.9 (Fixture Claude)")
        );
        assert_eq!(
            capabilities.observation,
            ObservationCapability::LaunchScopedHook
        );
        assert!(capabilities.fresh_session_id_supported);
        assert!(capabilities.resume_supported);
        assert!(capabilities.native_fork_supported);
        assert!(capabilities.mcp_http_supported);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn codex_discovery_keeps_resume_available_when_the_provider_exposes_it() {
        let directory = capability_fixture_directory("codex");
        termloop_platform::test_support::write_cli_fixture(
            &directory,
            "codex",
            concat!(
                "#!/bin/sh\n",
                "case \"$1\" in\n",
                "--help)\n",
                "printf 'Usage: codex\\n  --remote <ADDR>  Remote app server\\n'\n",
                "exit 0 ;;\n",
                "--version)\n",
                "printf 'codex-cli 0.147.0\\n'\n",
                "exit 0 ;;\n",
                "app-server)\n",
                "printf 'Usage: codex app-server\\n  --listen <ADDR>\\n'\n",
                "exit 0 ;;\n",
                "resume)\n",
                "printf 'Usage: codex resume [OPTIONS] [SESSION_ID]\\n'\n",
                "exit 0 ;;\n",
                "fork)\n",
                "printf 'Usage: codex fork [OPTIONS] [SESSION_ID]\\n  --remote <ADDR>\\n'\n",
                "exit 0 ;;\n",
                "esac\n",
                "exit 1\n",
            ),
            concat!(
                "@echo off\r\n",
                "if \"%1\"==\"--help\" (echo Usage: codex& echo   --remote ^<ADDR^>  Remote app server& exit /b 0)\r\n",
                "if \"%1\"==\"--version\" (echo codex-cli 0.147.0& exit /b 0)\r\n",
                "if \"%1\"==\"app-server\" (echo Usage: codex app-server& echo   --listen ^<ADDR^>& exit /b 0)\r\n",
                "if \"%1\"==\"resume\" (echo Usage: codex resume [OPTIONS] [SESSION_ID]& exit /b 0)\r\n",
                "if \"%1\"==\"fork\" (echo Usage: codex fork [OPTIONS] [SESSION_ID]& echo   --remote ^<ADDR^>& exit /b 0)\r\n",
                "exit /b 1\r\n",
            ),
        )
        .unwrap();
        let environment =
            termloop_platform::LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        let capabilities = discover_capabilities_with_environment("codex", &environment);
        assert!(capabilities.available);
        assert_eq!(capabilities.unavailability, None);
        assert_eq!(capabilities.version.as_deref(), Some("codex-cli 0.147.0"));
        assert_eq!(
            capabilities.observation,
            ObservationCapability::DaemonOwnedBridge
        );
        assert!(!capabilities.fresh_session_id_supported);
        // Capability discovery must not turn a provider-version warning into
        // a launch gate. If this Codex build rejects resume, the bounded
        // provider launch reports that failure through the normal Session
        // recovery path.
        assert!(capabilities.resume_supported);
        assert!(capabilities.native_fork_supported);
        assert!(capabilities.mcp_http_supported);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn gemini_discovery_enables_only_a_non_masking_launch_scoped_hook_overlay() {
        let directory = capability_fixture_directory("gemini");
        let fixture_path = termloop_platform::test_support::write_cli_fixture(
            &directory,
            "gemini",
            concat!(
                "#!/bin/sh\n",
                "case \"$1\" in\n",
                "--help)\n",
                "printf '  -m, --model <name>  Model\\n'\n",
                "printf '  -r, --resume <id>  Resume\\n'\n",
                "exit 0 ;;\n",
                "--version) printf '0.39.1\\n'; exit 0 ;;\n",
                "hooks) printf 'Usage: gemini hooks\\n'; exit 0 ;;\n",
                "esac\n",
                "exit 1\n",
            ),
            concat!(
                "@echo off\r\n",
                "if \"%1\"==\"--help\" (echo   -m, --model ^<name^>  Model& echo   -r, --resume ^<id^>  Resume& exit /b 0)\r\n",
                "if \"%1\"==\"--version\" (echo 0.39.1& exit /b 0)\r\n",
                "if \"%1\"==\"hooks\" (echo Usage: gemini hooks& exit /b 0)\r\n",
                "exit /b 1\r\n",
            ),
        )
        .unwrap();
        let environment =
            termloop_platform::LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        let target = resolve_agent_cli("gemini", &environment).unwrap();
        assert_eq!(target.target_path(), fixture_path.as_path());

        let capabilities = discover_capabilities_with_environment("gemini", &environment);
        assert!(capabilities.available);
        assert_eq!(capabilities.unavailability, None);
        assert_eq!(capabilities.version.as_deref(), Some("0.39.1"));
        assert_eq!(
            capabilities.observation,
            ObservationCapability::LaunchScopedHook
        );
        assert!(!capabilities.fresh_session_id_supported);
        assert!(!capabilities.resume_supported);
        assert!(!capabilities.native_fork_supported);
        assert!(!capabilities.mcp_http_supported);

        let managed_environment = environment
            .clone()
            .with_explicit("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", "/managed/defaults.json");
        let managed = discover_capabilities_with_environment("gemini", &managed_environment);
        assert_eq!(managed.observation, ObservationCapability::None);
        assert_eq!(
            managed.integration_level(),
            AgentIntegrationLevel::LaunchOnly
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn codex_bridge_forwards_frames_and_emits_structured_runtime_facts() {
        use tokio_tungstenite::tungstenite::{Message, accept, connect};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let upstream = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = accept(stream).unwrap();
            assert_eq!(socket.read().unwrap(), Message::Text("initialize".into()));
            socket
                .send(Message::Text(
                    r#"{"method":"thread/started","params":{"thread":{"id":"019f1dae-3bf3-73d1-b3c7-08ddbbd1f035","status":{"type":"idle"}}}}"#.into(),
                ))
                .unwrap();
            socket
                .send(Message::Text(
                    r#"{"method":"thread/status/changed","params":{"status":{"type":"active","activeFlags":["waitingOnApproval"]}}}"#.into(),
                ))
                .unwrap();
            socket
                .send(Message::Text(
                    r#"{"method":"thread/settings/updated","params":{"threadId":"019f1dae-3bf3-73d1-b3c7-08ddbbd1f035","threadSettings":{"approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":{"id":":danger-full-access","extends":null},"model":"gpt-5.6-terra","effort":"xhigh"}}}"#.into(),
                ))
                .unwrap();
            let _ = socket.close(None);
        });
        let (signals, received) = std::sync::mpsc::channel();
        let bridge =
            CodexAppServerBridge::start(upstream_endpoint, "session-codex".into(), 77, signals)
                .unwrap();
        let (mut client, _) = connect(bridge.endpoint()).unwrap();
        client.send(Message::Text("initialize".into())).unwrap();
        assert!(matches!(client.read().unwrap(), Message::Text(_)));
        assert!(matches!(client.read().unwrap(), Message::Text(_)));
        assert!(matches!(client.read().unwrap(), Message::Text(_)));
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AgentRuntimeSignal {
                session_id: "session-codex".into(),
                runtime_epoch: 77,
                event: AgentRuntimeEvent::ResumeRefObserved(
                    ResumeRef::for_provider(
                        ResumeProvider::Codex,
                        "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
                    )
                    .unwrap(),
                ),
            }
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AgentRuntimeSignal {
                session_id: "session-codex".into(),
                runtime_epoch: 77,
                event: AgentRuntimeEvent::Observation(AgentSignal::Stopped),
            }
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AgentRuntimeSignal {
                session_id: "session-codex".into(),
                runtime_epoch: 77,
                event: AgentRuntimeEvent::Observation(AgentSignal::PermissionRequested),
            }
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AgentRuntimeSignal {
                session_id: "session-codex".into(),
                runtime_epoch: 77,
                event: AgentRuntimeEvent::ThreadSettingsObserved(CodexThreadSettingsObservation {
                    native_thread_id: "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
                    model: Some("gpt-5.6-terra".into()),
                    permission: CodexPermissionMode::BypassPermissions,
                    reasoning: Some("xhigh".into()),
                },),
            }
        );
        drop(client);
        bridge.shutdown().unwrap();
        upstream.join().unwrap();
    }

    #[test]
    fn codex_bridge_ignores_runtime_facts_from_an_unrelated_thread() {
        use tokio_tungstenite::tungstenite::{Message, accept, connect};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let resume_request =
            r#"{"id":42,"method":"thread/resume","params":{"threadId":"thread-main"}}"#;
        let resume_response = r#"{"id":42,"result":{"thread":{"id":"thread-main"}}}"#;
        let history_probe_status = r#"{"method":"thread/status/changed","params":{"threadId":"thread-history-probe","status":{"type":"notLoaded"}}}"#;
        let main_status = r#"{"method":"thread/status/changed","params":{"threadId":"thread-main","status":{"type":"idle"}}}"#;
        let upstream = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = accept(stream).unwrap();
            assert_eq!(socket.read().unwrap(), Message::Text(resume_request.into()));
            socket.send(Message::Text(resume_response.into())).unwrap();
            socket
                .send(Message::Text(history_probe_status.into()))
                .unwrap();
            socket.send(Message::Text(main_status.into())).unwrap();
            let _ = socket.close(None);
        });
        let (signals, received) = std::sync::mpsc::channel();
        let bridge =
            CodexAppServerBridge::start(upstream_endpoint, "session-codex".into(), 77, signals)
                .unwrap();
        let (mut client, _) = connect(bridge.endpoint()).unwrap();
        client.send(Message::Text(resume_request.into())).unwrap();
        assert_eq!(
            client.read().unwrap(),
            Message::Text(resume_response.into())
        );
        assert_eq!(
            client.read().unwrap(),
            Message::Text(history_probe_status.into())
        );
        assert_eq!(client.read().unwrap(), Message::Text(main_status.into()));

        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AgentRuntimeSignal {
                session_id: "session-codex".into(),
                runtime_epoch: 77,
                event: AgentRuntimeEvent::ResumeRefObserved(
                    ResumeRef::for_provider(ResumeProvider::Codex, "thread-main".into()).unwrap(),
                ),
            }
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AgentRuntimeSignal {
                session_id: "session-codex".into(),
                runtime_epoch: 77,
                event: AgentRuntimeEvent::Observation(AgentSignal::Stopped),
            }
        );
        assert!(matches!(
            received.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        drop(client);
        bridge.shutdown().unwrap();
        upstream.join().unwrap();
    }

    #[test]
    fn codex_bridge_forwards_large_thread_history_frames() {
        use tokio_tungstenite::tungstenite::{
            Message, accept, client::client_with_config, protocol::WebSocketConfig,
        };

        const LARGE_FRAME_BYTES: usize = (16 << 20) + 1;
        let proxy_config = codex_app_server_websocket_config();
        assert_eq!(
            proxy_config.max_message_size,
            Some(CODEX_APP_SERVER_MAX_MESSAGE_BYTES)
        );
        assert_eq!(
            proxy_config.max_frame_size,
            Some(CODEX_APP_SERVER_MAX_MESSAGE_BYTES)
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let upstream = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut socket = accept(stream).unwrap();
            assert_eq!(socket.read().unwrap(), Message::Text("thread/read".into()));
            socket
                .send(Message::Text("x".repeat(LARGE_FRAME_BYTES).into()))
                .unwrap();
            let _ = socket.close(None);
        });
        let (signals, _received) = std::sync::mpsc::channel();
        let bridge =
            CodexAppServerBridge::start(upstream_endpoint, "session-codex".into(), 77, signals)
                .unwrap();
        let stream = std::net::TcpStream::connect(
            bridge
                .endpoint()
                .strip_prefix("ws://")
                .expect("bridge endpoint is a loopback WebSocket URL"),
        )
        .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let client_config = WebSocketConfig::default()
            .max_message_size(Some(LARGE_FRAME_BYTES + 1))
            .max_frame_size(Some(LARGE_FRAME_BYTES + 1));
        let (mut client, _) =
            client_with_config(bridge.endpoint(), stream, Some(client_config)).unwrap();
        client.send(Message::Text("thread/read".into())).unwrap();
        assert!(matches!(
            client.read().unwrap(),
            Message::Text(text) if text.len() == LARGE_FRAME_BYTES
        ));

        drop(client);
        bridge.shutdown().unwrap();
        upstream.join().unwrap();
    }

    #[test]
    fn codex_bridge_keeps_the_tui_live_while_a_session_picker_connects() {
        use tokio_tungstenite::tungstenite::{Message, accept, connect};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let upstream = std::thread::spawn(move || {
            let connected = std::sync::Arc::new(std::sync::Barrier::new(2));
            let handlers = (0..2)
                .map(|_| {
                    let (stream, _) = listener.accept().unwrap();
                    let connected = connected.clone();
                    std::thread::spawn(move || {
                        let mut socket = accept(stream).unwrap();
                        let request = socket.read().unwrap();
                        let response = if request == Message::Text("tui".into()) {
                            request
                        } else {
                            assert_eq!(
                                request,
                                Message::Text(
                                    r#"{"id":7,"method":"thread/resume","params":{"threadId":"thread-selected"}}"#
                                        .into()
                                )
                            );
                            Message::Text(
                                r#"{"id":7,"result":{"thread":{"id":"thread-selected"}}}"#
                                    .into(),
                            )
                        };
                        socket.send(response).unwrap();
                        connected.wait();
                        let _ = socket.close(None);
                    })
                })
                .collect::<Vec<_>>();
            for handler in handlers {
                handler.join().unwrap();
            }
        });
        let (signals, received) = std::sync::mpsc::channel();
        let bridge =
            CodexAppServerBridge::start(upstream_endpoint, "session-codex".into(), 77, signals)
                .unwrap();

        let (mut tui, _) = connect(bridge.endpoint()).unwrap();
        tui.send(Message::Text("tui".into())).unwrap();
        assert_eq!(tui.read().unwrap(), Message::Text("tui".into()));

        let (mut picker, _) = connect(bridge.endpoint()).unwrap();
        picker
            .send(Message::Text(
                r#"{"id":7,"method":"thread/resume","params":{"threadId":"thread-selected"}}"#
                    .into(),
            ))
            .unwrap();
        assert_eq!(
            picker.read().unwrap(),
            Message::Text(r#"{"id":7,"result":{"thread":{"id":"thread-selected"}}}"#.into())
        );

        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AgentRuntimeSignal {
                session_id: "session-codex".into(),
                runtime_epoch: 77,
                event: AgentRuntimeEvent::ResumeRefObserved(
                    ResumeRef::for_provider(ResumeProvider::Codex, "thread-selected".into())
                        .unwrap(),
                ),
            }
        );

        drop(picker);
        drop(tui);
        bridge.shutdown().unwrap();
        upstream.join().unwrap();
    }
}
