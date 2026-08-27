use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex as StdMutex, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use termloop_contract::current::{ProjectionInvalidatedPayload, ProjectionTopic};
use termloop_core::CoreError;
use termloop_terminal::TerminalService;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio::time::{Duration, MissedTickBehavior};

mod access_plane;
mod attachments;
mod companion_supervisor;
mod control;
mod core_lock;
mod discovery;
mod forward_plane;
mod gates;
mod health;
mod invalidation;
mod keep_awake;
mod mcp;
mod runtime_health;
mod steward_presence;
mod steward_task_start;
mod task_automation;
mod terminal_grids;
mod terminal_plane;
mod tracker_runtime;

use control::{control_upgrade, reconcile_agent_resumes_after_start};
use core_lock::{CoreProjectionSnapshot, MonitoredMutex};
use gates::{
    AGENT_RESUME_SHUTDOWN_TIMEOUT, AgentResumeGates, FairObservationGate, GitHostQueryScheduler,
    ObservationPriority,
};
use health::{
    HealthDemandRegistry, HealthTrigger, run_git_host_scheduler, run_health_integrity_fallback,
    run_health_scheduler,
};
use invalidation::{
    InvalidationRequest, coalesce_invalidations, queue_task_invalidation,
    refresh_task_presence_for_cwd,
};
use mcp::{mcp_delete, mcp_get, mcp_post};
use terminal_plane::terminal_upgrade;

const EXIT_REAPER_INTERVAL: Duration = Duration::from_secs(1);
const EXIT_REAPER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const MCP_READINESS_TIMEOUT: Duration = Duration::from_secs(5);
const MCP_READINESS_REQUEST: &[u8] =
    b"GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
const MCP_READINESS_STATUS: &[u8] = b"HTTP/1.1 405";
const AGENT_RESTART_HANDOFF_FILE: &str = "agent-restart-handoff.json";
const AGENT_RESTART_HANDOFF_LIMIT: usize = 64 * 1024;
const AGENT_RESUME_STALL_FILE: &str = "agent-resume-stall.json";
const AGENT_RESUME_STALL_LIMIT: usize = 4 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRestartHandoffFile {
    version: u8,
    sessions: Vec<termloop_core::AgentDaemonRestartHandoff>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentResumeStallFile {
    version: u8,
    session_id: String,
}

#[derive(Clone)]
struct AppState {
    access_plane: access_plane::AccessPlane,
    attachments: attachments::AttachmentStore,
    control_token: Arc<str>,
    read_only_token: Arc<str>,
    companion_credentials: companion_supervisor::CompanionCredentialRegistry,
    companion_last_seen: companion_supervisor::CompanionHeartbeat,
    companion_status: companion_supervisor::CompanionSupervisorStatus,
    terminal_token: Arc<str>,
    control_endpoint: Arc<str>,
    core: MonitoredMutex<termloop_core::CoreRuntime>,
    core_projection: CoreProjectionSnapshot,
    runtime_health: runtime_health::RuntimeHealth,
    mcp_authorizer: termloop_core::McpAuthorizer,
    mcp_tool_descriptions: termloop_core::McpToolDescriptions,
    skill_manager: termloop_platform::SkillManager,
    secure_credentials: Arc<dyn termloop_platform::SecureCredentialStore>,
    task_source_credential_states:
        Arc<StdMutex<HashMap<String, control::TaskSourceCredentialPresence>>>,
    task_source_refresh_observer: Arc<dyn termloop_core::TaskSourceJiraObserver>,
    terminal: TerminalService,
    terminal_grids: terminal_grids::TerminalGridStore,
    terminal_resizes: terminal_plane::TerminalResizeRegistry,
    runtime_epoch: u64,
    observation_sequence: Arc<AtomicU64>,
    invalidation_requests: mpsc::Sender<InvalidationRequest>,
    invalidations: broadcast::Sender<ProjectionInvalidatedPayload>,
    health_triggers: mpsc::Sender<HealthTrigger>,
    health_demands: Arc<tokio::sync::Mutex<HealthDemandRegistry>>,
    git_observation_gate: FairObservationGate,
    git_host_query_scheduler: GitHostQueryScheduler,
    repair_request_locks: Arc<StdMutex<HashMap<String, Weak<Mutex<()>>>>>,
    task_source_refresh_locks: Arc<StdMutex<HashMap<String, Weak<Mutex<()>>>>>,
    steward_task_start_locks: Arc<StdMutex<HashMap<String, Weak<Mutex<()>>>>>,
    agent_capabilities: Arc<Vec<termloop_core::DiscoveredAgentCapabilities>>,
    agent_resume_gates: AgentResumeGates,
    tracker_report_capabilities: Arc<StdMutex<tracker_runtime::TrackerReportCapabilityRegistry>>,
    steward_launch_gate: StewardLaunchGate,
    tracker_runtime_wake: Arc<tokio::sync::Notify>,
    resume_shutdown: tokio::sync::watch::Receiver<bool>,
    provider_process_directory: Arc<PathBuf>,
    pty_process_directory: Arc<PathBuf>,
    client_launch_restarts: Arc<StdMutex<ClientLaunchRestartRegistry>>,
    companion_wakes: companion_supervisor::CompanionWakeQueue,
    steward_presence: steward_presence::StewardPresenceState,
    /// The single process-wide keep-awake hold. Owned by the daemon because
    /// agents outlive any desktop window and can be launched without one.
    keep_awake: keep_awake::KeepAwakeSupervisor,
    resume_diagnostics: termloop_platform::BoundedPrivateLog,
    /// Fires when an authenticated Full-scope client requested a graceful
    /// daemon shutdown over the control plane. Composed with the platform OS
    /// signal wait so managed daemons shut down cleanly on every OS.
    shutdown_requests: Arc<tokio::sync::Notify>,
}

/// Delay between replying success to a `system.shutdown` request and waking
/// the graceful-shutdown future, so the response leaves the control outbound
/// queue before axum stops serving.
const CONTROL_SHUTDOWN_REPLY_GRACE: Duration = Duration::from_millis(100);

/// Reply-first trigger for a control-plane `system.shutdown` request: the
/// notifier stores a permit, so the graceful-shutdown wait completes even if
/// it is polled only after the grace delay elapsed.
pub(in crate::app) fn schedule_control_shutdown(shutdown_requests: Arc<tokio::sync::Notify>) {
    tokio::spawn(async move {
        tokio::time::sleep(CONTROL_SHUTDOWN_REPLY_GRACE).await;
        shutdown_requests.notify_one();
    });
}

/// Completes when either the OS delivers a daemon shutdown signal (platform
/// owns that conditional) or a control-plane shutdown was requested. Windows
/// desktops have no SIGTERM equivalent short of a hard TerminateProcess, so
/// the control-plane path is what lets a managed daemon reach the same
/// graceful teardown on every OS.
async fn wait_for_daemon_shutdown(shutdown_requests: Arc<tokio::sync::Notify>) {
    tokio::select! {
        _ = termloop_platform::wait_for_daemon_shutdown_signal() => {}
        _ = shutdown_requests.notified() => {}
    }
}

#[derive(Default)]
struct ClientLaunchRestartRegistry {
    accepted: Option<(String, usize)>,
}

fn generated_mcp_tool_catalog()
-> Result<Vec<termloop_core::McpToolCatalogEntry>, Box<dyn std::error::Error>> {
    let definitions: Vec<serde_json::Value> =
        serde_json::from_str(termloop_contract::current::MCP_TOOL_DEFINITIONS_JSON)?;
    if definitions.len() != termloop_contract::current::MCP_TOOLS.len() {
        return Err("generated MCP tool catalog is incomplete".into());
    }
    definitions
        .into_iter()
        .map(|definition| {
            let name = definition
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or("generated MCP tool name is missing")?;
            let name = name
                .parse::<termloop_core::McpToolName>()
                .map_err(|_| "generated MCP tool name is unknown")?;
            let title = definition
                .pointer("/annotations/title")
                .and_then(serde_json::Value::as_str)
                .ok_or("generated MCP tool title is missing")?
                .to_owned();
            let canonical_description = definition
                .get("description")
                .and_then(serde_json::Value::as_str)
                .ok_or("generated MCP tool description is missing")?
                .to_owned();
            let tool_name = name.as_str();
            let mut roles = Vec::new();
            if termloop_contract::current::MCP_INTERACTIVE_TOOLS.contains(&tool_name) {
                roles.push(termloop_core::McpToolRole::Interactive);
            }
            if termloop_contract::current::MCP_HELPER_TOOLS.contains(&tool_name) {
                roles.push(termloop_core::McpToolRole::Helper);
            }
            if termloop_contract::current::MCP_STEWARD_TOOLS.contains(&tool_name) {
                roles.push(termloop_core::McpToolRole::Steward);
            }
            if termloop_contract::current::MCP_WORKER_TOOLS.contains(&tool_name) {
                roles.push(termloop_core::McpToolRole::Worker);
            }
            if termloop_contract::current::MCP_IMPROVER_TOOLS.contains(&tool_name) {
                roles.push(termloop_core::McpToolRole::Improver);
            }
            Ok(termloop_core::McpToolCatalogEntry {
                name,
                title,
                canonical_description,
                roles,
            })
        })
        .collect::<Result<Vec<_>, &str>>()
        .map_err(Into::into)
}

#[derive(Clone, Default)]
struct StewardLaunchGate {
    projects: Arc<StdMutex<HashSet<String>>>,
}

struct StewardLaunchPermit {
    gate: StewardLaunchGate,
    project_id: String,
}

impl StewardLaunchGate {
    fn try_admit(&self, project_id: String) -> Option<StewardLaunchPermit> {
        let inserted = self.projects.lock().ok()?.insert(project_id.clone());
        inserted.then_some(StewardLaunchPermit {
            gate: self.clone(),
            project_id,
        })
    }
}

impl Drop for StewardLaunchPermit {
    fn drop(&mut self) {
        if let Ok(mut projects) = self.gate.projects.lock() {
            projects.remove(&self.project_id);
        }
    }
}

impl ClientLaunchRestartRegistry {
    fn accept(&mut self, client_launch_id: String, candidate_count: usize) -> (bool, usize) {
        if let Some((_, previous_count)) = &self.accepted {
            return (true, *previous_count);
        }
        self.accepted = Some((client_launch_id, candidate_count));
        (false, candidate_count)
    }
}

pub(crate) async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let tracing_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("termloop_server=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(tracing_filter)
        .with_writer(std::io::stderr)
        .init();
    if std::env::args().nth(1).as_deref() == Some("hook") {
        return crate::hook::run_hook_client().await;
    }
    let runtime_directory = termloop_platform::runtime_directory()?;
    let _daemon_instance_lease =
        termloop_platform::acquire_daemon_instance_lease(&runtime_directory)?;
    let agent_restart_handoff_path = runtime_directory.join(AGENT_RESTART_HANDOFF_FILE);
    let agent_resume_stall_path = runtime_directory.join(AGENT_RESUME_STALL_FILE);
    let agent_restart_handoffs = take_agent_restart_handoff(&agent_restart_handoff_path);
    let legacy_provider_directory = runtime_directory.join("provider-processes");
    let process_root = runtime_directory.join("managed-processes");
    let provider_process_directory = process_root.join("provider");
    let pty_process_directory = process_root.join("pty");
    let companion_process_directory = process_root.join("companion");
    let mut uncertain_process_sessions = HashSet::new();
    let mut unscoped_process_uncertainty = false;
    for (role, directory) in [
        ("legacy-provider", &legacy_provider_directory),
        ("provider", &provider_process_directory),
        ("pty", &pty_process_directory),
        ("companion", &companion_process_directory),
    ] {
        let recovered = termloop_platform::reap_tracked_managed_processes(directory)?;
        if role != "legacy-provider" {
            uncertain_process_sessions.extend(recovered.uncertain_record_ids.iter().cloned());
            unscoped_process_uncertainty |= recovered.unscoped_failures > 0;
        }
        if recovered.terminated > 0 || recovered.stale_records > 0 || recovered.failures > 0 {
            tracing::info!(
                process_role = role,
                terminated = recovered.terminated,
                stale_records = recovered.stale_records,
                failures = recovered.failures,
                "reconciled managed processes from the previous daemon epoch"
            );
        }
    }
    let terminal = TerminalService::with_process_registry(pty_process_directory.clone());
    let state_directory = termloop_platform::state_directory()?;
    // Before any Session is restarted for this client launch, so those PTYs
    // open at the geometry their surface last had instead of the fallback.
    terminal.seed_terminal_grids(terminal_grids::load(&state_directory));
    let access_plane =
        access_plane::AccessPlane::open(&state_directory).map_err(std::io::Error::other)?;
    let attachments = attachments::AttachmentStore::new(state_directory.clone());
    let runtime_epoch = termloop_platform::generate_runtime_epoch();
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
    let address = listener.local_addr()?;
    let hook_executable = termloop_platform::current_executable()?;
    let claude_mcp_config_path = runtime_directory.join("agent-mcp.json");
    let mcp_endpoint = format!("http://{address}/mcp");
    write_claude_mcp_config(&claude_mcp_config_path, &mcp_endpoint)?;
    let agent_capabilities = termloop_core::discover_agent_capabilities();
    for capability in &agent_capabilities {
        tracing::info!(
            agent = capability.agent_id,
            available = capability.available,
            version = capability.version.as_deref().unwrap_or("unknown"),
            observation = capability.observation_supported,
            resume = capability.resume_supported,
            native_fork = capability.native_fork_supported,
            mcp_http = capability.mcp_http_supported,
            "discovered agent capabilities"
        );
    }
    let agent_capabilities = Arc::new(agent_capabilities);
    let mut runtime_agent_capabilities = std::collections::HashMap::new();
    for capability in agent_capabilities.iter() {
        let observation = match capability.observation {
            termloop_core::ObservationCapability::None => {
                termloop_core::AgentObservationRuntimeTransport::None
            }
            termloop_core::ObservationCapability::DaemonOwnedBridge => {
                termloop_core::AgentObservationRuntimeTransport::DaemonOwnedBridge
            }
            termloop_core::ObservationCapability::LaunchScopedHook => {
                let settings = termloop_core::provider_hook_settings(
                    &capability.agent_id,
                    hook_executable.path(),
                )?
                .ok_or("launch-scoped observation provider has no hook settings adapter")?;
                let config = match settings.delivery {
                    termloop_core::ProviderHookSettingsDelivery::InlineSettings => {
                        termloop_core::AgentLaunchScopedConfig::InlineSettings {
                            content: settings.content,
                            inspectable_content: settings.inspectable_content,
                        }
                    }
                    termloop_core::ProviderHookSettingsDelivery::EnvironmentSettingsPath {
                        variable,
                    } => {
                        let path = runtime_directory.join(format!(
                            "agent-{}-observation-settings.json",
                            capability.agent_id
                        ));
                        termloop_platform::write_private_file(&path, settings.content.as_bytes())?;
                        termloop_core::AgentLaunchScopedConfig::EnvironmentSettingsPath {
                            variable: variable.into(),
                            path: path.display().to_string(),
                            content: settings.content,
                            inspectable_content: settings.inspectable_content,
                        }
                    }
                };
                termloop_core::AgentObservationRuntimeTransport::LaunchScopedConfig(config)
            }
        };
        runtime_agent_capabilities.insert(
            capability.agent_id.clone(),
            termloop_core::AgentRuntimeCapabilities {
                observation,
                fresh_session_id_supported: capability.fresh_session_id_supported,
                resume_supported: capability.resume_supported,
                native_fork_supported: capability.native_fork_supported,
                mcp_http_supported: capability.mcp_http_supported,
            },
        );
    }
    let mut core = termloop_core::CoreRuntime::open(
        state_path(&state_directory),
        terminal.clone(),
        runtime_epoch,
    )?;
    core.install_daemon_restart_handoff(agent_restart_handoffs);
    core.configure_mcp_tool_catalog(generated_mcp_tool_catalog()?)?;
    core.mark_startup_runtime_ownership_uncertain(
        &uncertain_process_sessions.into_iter().collect::<Vec<_>>(),
        unscoped_process_uncertainty,
    )?;
    apply_agent_resume_stall_quarantine(&mut core, &agent_resume_stall_path)?;
    core.restore_agent_terminal_holds();
    let resume_shutdown_flag = Arc::new(AtomicBool::new(false));
    core.configure_resume_shutdown(resume_shutdown_flag.clone());
    core.configure_agent_observations(termloop_core::AgentObservationTransport {
        endpoint: format!("http://{address}/agent-observation"),
        provider_process_directory: provider_process_directory.clone(),
        agents: runtime_agent_capabilities,
        mcp_endpoint,
        claude_mcp_config_path: claude_mcp_config_path.display().to_string(),
    });
    let agent_runtime_signals = core
        .take_agent_runtime_signals()
        .expect("agent runtime signal receiver is composed once");
    let generated_input_runtime_events = core
        .take_generated_input_runtime_events()
        .expect("generated input runtime receiver is composed once");
    let token = generate_token();
    let read_only_token = generate_token();
    let terminal_token = generate_token();
    let (invalidation_requests, invalidation_receiver) = mpsc::channel(256);
    let (invalidations, _) = broadcast::channel(256);
    let (health_triggers, health_trigger_receiver) = mpsc::channel(256);
    let health_demands = Arc::new(tokio::sync::Mutex::new(HealthDemandRegistry::default()));
    let git_observation_gate = FairObservationGate::new();
    let git_host_query_scheduler = GitHostQueryScheduler::new();
    let mcp_authorizer = core.mcp_authorizer();
    let mcp_tool_descriptions = core.mcp_tool_descriptions();
    let observation_sequence = Arc::new(AtomicU64::new(0));
    let core_projection = CoreProjectionSnapshot::new(
        core.state_revision(),
        core.observation_sequence(),
        observation_sequence.clone(),
    );
    let core = MonitoredMutex::new_with_projection(
        core,
        core_projection.clone(),
        |core: &termloop_core::CoreRuntime| (core.state_revision(), core.observation_sequence()),
    );
    let runtime_health = runtime_health::RuntimeHealth::new();
    let (resume_shutdown_sender, resume_shutdown) = tokio::sync::watch::channel(false);
    let agent_resume_gates = AgentResumeGates::new();
    let resume_diagnostics = termloop_platform::BoundedPrivateLog::open(
        &runtime_directory.join("agent-resume-cycles.jsonl"),
        512 * 1024,
    )?;
    let skill_manager = termloop_platform::SkillManager::discover();
    let task_source_refresh_observer: Arc<dyn termloop_core::TaskSourceJiraObserver> =
        match tokio::task::spawn_blocking(termloop_core::JiraTaskSourceRefreshObserver::new).await {
            Ok(Ok(observer)) => Arc::new(observer),
            Ok(Err(_)) | Err(_) => Arc::new(termloop_core::UnavailableTaskSourceRefreshObserver),
        };
    let state = AppState {
        access_plane,
        attachments,
        control_token: Arc::from(token.as_str()),
        read_only_token: Arc::from(read_only_token.as_str()),
        companion_credentials: companion_supervisor::CompanionCredentialRegistry::default(),
        companion_last_seen: companion_supervisor::CompanionHeartbeat::default(),
        companion_status: companion_supervisor::CompanionSupervisorStatus::default(),
        terminal_token: Arc::from(terminal_token.as_str()),
        control_endpoint: Arc::from(format!("ws://{address}/control")),
        core: core.clone(),
        core_projection,
        runtime_health: runtime_health.clone(),
        mcp_authorizer,
        mcp_tool_descriptions,
        skill_manager,
        secure_credentials: Arc::new(termloop_platform::NativeSecureCredentialStore),
        task_source_credential_states: Arc::new(StdMutex::new(HashMap::new())),
        task_source_refresh_observer,
        terminal: terminal.clone(),
        terminal_grids: terminal_grids::TerminalGridStore::spawn(
            &state_directory,
            terminal.clone(),
        ),
        terminal_resizes: terminal_plane::TerminalResizeRegistry::default(),
        runtime_epoch,
        observation_sequence: observation_sequence.clone(),
        invalidation_requests: invalidation_requests.clone(),
        invalidations: invalidations.clone(),
        health_triggers,
        health_demands,
        git_observation_gate: git_observation_gate.clone(),
        git_host_query_scheduler,
        repair_request_locks: Arc::new(StdMutex::new(HashMap::new())),
        task_source_refresh_locks: Arc::new(StdMutex::new(HashMap::new())),
        steward_task_start_locks: Arc::new(StdMutex::new(HashMap::new())),
        agent_capabilities,
        agent_resume_gates: agent_resume_gates.clone(),
        tracker_report_capabilities: Arc::new(StdMutex::new(
            tracker_runtime::TrackerReportCapabilityRegistry::default(),
        )),
        steward_launch_gate: StewardLaunchGate::default(),
        tracker_runtime_wake: Arc::new(tokio::sync::Notify::new()),
        resume_shutdown,
        provider_process_directory: Arc::new(provider_process_directory.clone()),
        pty_process_directory: Arc::new(pty_process_directory.clone()),
        client_launch_restarts: Arc::new(StdMutex::new(ClientLaunchRestartRegistry::default())),
        companion_wakes: companion_supervisor::CompanionWakeQueue::default(),
        steward_presence: steward_presence::StewardPresenceState::default(),
        keep_awake: keep_awake::KeepAwakeSupervisor::default(),
        resume_diagnostics,
        shutdown_requests: Arc::new(tokio::sync::Notify::new()),
    };
    tokio::spawn(coalesce_invalidations(invalidation_receiver, invalidations));
    let terminal_exit_reconciler = tokio::spawn(reconcile_terminal_exits(state.clone()));
    tokio::spawn(reconcile_terminal_activity(state.clone()));
    tokio::spawn(reconcile_claude_interrupts(state.clone()));
    tokio::spawn(keep_awake::supervise(state.clone()));
    tokio::spawn(tracker_runtime::run_tracker_deadlines(state.clone()));
    tokio::spawn(control::run_task_source_deadlines(state.clone()));
    tokio::spawn(reconcile_agent_runtime_signals(
        bridge_agent_runtime_signals(agent_runtime_signals),
        state.core.clone(),
        state.companion_wakes.clone(),
        state.observation_sequence.clone(),
        state.invalidation_requests.clone(),
        state.tracker_runtime_wake.clone(),
    ));
    tokio::spawn(reconcile_generated_input_runtime_events(
        bridge_generated_input_runtime_events(generated_input_runtime_events),
        state.core.clone(),
        state.companion_wakes.clone(),
        state.observation_sequence.clone(),
        state.invalidation_requests.clone(),
    ));
    tokio::spawn(run_health_scheduler(
        health_trigger_receiver,
        state.health_triggers.clone(),
        state.core.clone(),
        state.observation_sequence.clone(),
        state.invalidations.clone(),
        state.health_demands.clone(),
        git_observation_gate,
    ));
    tokio::spawn(run_health_integrity_fallback(state.clone()));
    tokio::spawn(run_git_host_scheduler(state.clone()));
    tokio::spawn(reconcile_cleanup_recoveries(state.clone()));
    tokio::spawn(runtime_health.run_heartbeat());
    tokio::spawn(state.core.clone().watch_stalls(
        state.resume_shutdown.clone(),
        Arc::new(agent_resume_stall_path),
    ));
    let app = Router::new()
        .route("/healthz", get(runtime_health::healthz))
        .route("/control", get(control_upgrade))
        .route(
            "/agent-observation",
            post(control::agent_observation_post).layer(DefaultBodyLimit::max(
                control::MAX_AGENT_OBSERVATION_POST_BYTES,
            )),
        )
        .route("/terminal", get(terminal_upgrade))
        .route("/attachments", post(attachments::attachment_upload))
        .route("/mcp", get(mcp_get).post(mcp_post).delete(mcp_delete))
        .with_state(state.clone());
    let discovery_path = discovery::write(
        &runtime_directory,
        address,
        &token,
        &terminal_token,
        &read_only_token,
    )?;
    println!("{}", discovery_path.display());
    let shutdown_state = state.clone();
    let shutdown_handoff_path = agent_restart_handoff_path.clone();
    let control_shutdown_requests = state.shutdown_requests.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                wait_for_daemon_shutdown(control_shutdown_requests).await;
                resume_shutdown_flag.store(true, Ordering::Release);
                // Stop accepting remote work before capturing the restart
                // handoff. Otherwise a remote launch could race in after the
                // snapshot and be lost during daemon teardown.
                shutdown_state.access_plane.shutdown().await;
                let handoffs = shutdown_state
                    .core
                    .lock()
                    .await
                    .capture_daemon_restart_handoff();
                let _ = resume_shutdown_sender.send(true);
                if let Err(error) = write_agent_restart_handoff(&shutdown_handoff_path, handoffs) {
                    tracing::warn!(%error, "failed to write the bounded agent restart handoff");
                }
            })
            .await
    });
    // Claude does not reliably reconnect after its launch-time MCP probe fails.
    // Prove the router is serving before any persistent agent can be recovered.
    if let Err(error) = wait_for_mcp_readiness(address).await {
        server.abort();
        let _ = server.await;
        return Err(error.into());
    }

    state.access_plane.start_if_enabled(state.clone()).await;

    tokio::spawn(reconcile_agent_resumes_after_start(state.clone()));
    {
        let core = state.core.lock().await;
        let project_limit = core.project_count();
        for wake in core.enabled_steward_wakes() {
            let reason = companion_supervisor::startup_wake_reason(
                core.has_current_routine_findings(&wake.project_id),
            );
            state
                .companion_wakes
                .enqueue(wake.project_id, reason, wake.generation, project_limit);
        }
    }
    let companion_supervisor = tokio::spawn(companion_supervisor::run(
        state.clone(),
        termloop_platform::sibling_executable("termloop-companion").ok(),
        companion_process_directory.clone(),
        runtime_directory.clone(),
    ));
    let workers_to_restart = state.core.lock().await.enabled_worker_ids_needing_launch();
    for worker_id in workers_to_restart {
        let worker_state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = control::launch_current_worker(&worker_id, &worker_state).await {
                tracing::warn!(%error, %worker_id, "persistent Worker restart failed");
            }
        });
    }
    let server_result = server.await?;
    state.access_plane.shutdown().await;
    server_result?;
    let _ =
        tokio::time::timeout(AGENT_RESUME_SHUTDOWN_TIMEOUT, agent_resume_gates.shutdown()).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), companion_supervisor).await;
    // Daemon-owned PTY teardown emits the same EOF signal as a spontaneous
    // process exit. Stop and join the policy reconciler first so shutdown
    // cannot turn resumable agent descriptors into explicit `exited` state.
    stop_terminal_exit_reconciler(terminal_exit_reconciler).await;
    if let Err(error) = terminal.terminate_all() {
        tracing::warn!(%error, "failed to reap every PTY during daemon shutdown");
    }
    for directory in [
        provider_process_directory,
        pty_process_directory,
        companion_process_directory,
    ] {
        let recovery = tokio::task::spawn_blocking(move || {
            termloop_platform::reap_tracked_managed_processes(&directory)
        })
        .await;
        match recovery {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "managed-process shutdown reaper failed");
            }
            Err(error) => {
                tracing::warn!(%error, "managed-process shutdown reaper did not join");
            }
        }
    }
    Ok(())
}

fn take_agent_restart_handoff(
    path: &std::path::Path,
) -> Vec<termloop_core::AgentDaemonRestartHandoff> {
    let bytes = match termloop_platform::take_bounded_file(path, AGENT_RESTART_HANDOFF_LIMIT) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "discarded an unreadable agent restart handoff");
            return Vec::new();
        }
    };
    match serde_json::from_slice::<AgentRestartHandoffFile>(&bytes) {
        Ok(handoff) if handoff.version == 1 => handoff.sessions,
        Ok(_) => {
            tracing::warn!("discarded an unsupported agent restart handoff");
            Vec::new()
        }
        Err(error) => {
            tracing::warn!(%error, "discarded an invalid agent restart handoff");
            Vec::new()
        }
    }
}

fn apply_agent_resume_stall_quarantine(
    core: &mut termloop_core::CoreRuntime,
    path: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes =
        match termloop_platform::read_bounded_file_if_present(path, AGENT_RESUME_STALL_LIMIT) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Ok(()),
            Err(error) => {
                tracing::warn!(%error, "discarded an unreadable resume stall quarantine marker");
                let _ = termloop_platform::remove_file_if_present(path);
                return Ok(());
            }
        };
    let marker = match serde_json::from_slice::<AgentResumeStallFile>(&bytes) {
        Ok(marker)
            if marker.version == 1
                && !marker.session_id.is_empty()
                && marker.session_id.len() <= 128
                && marker
                    .session_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') =>
        {
            marker
        }
        Ok(_) | Err(_) => {
            tracing::warn!("discarded an invalid resume stall quarantine marker");
            termloop_platform::remove_file_if_present(path)?;
            return Ok(());
        }
    };
    match core.fail_agent_resume(
        &marker.session_id,
        termloop_core::ResumeFailureReason::DaemonInterrupted,
    ) {
        Ok(_) => {
            tracing::warn!(
                session_id = %marker.session_id,
                "quarantined the Session whose automatic resume stalled the previous daemon"
            );
            termloop_platform::remove_file_if_present(path)?;
            Ok(())
        }
        Err(CoreError::NotFound) => {
            tracing::warn!(
                session_id = %marker.session_id,
                "discarded a resume stall marker for a missing Session"
            );
            termloop_platform::remove_file_if_present(path)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn write_agent_restart_handoff(
    path: &std::path::Path,
    sessions: Vec<termloop_core::AgentDaemonRestartHandoff>,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = serde_json::to_vec(&AgentRestartHandoffFile {
        version: 1,
        sessions,
    })?;
    if bytes.len() > AGENT_RESTART_HANDOFF_LIMIT {
        return Err("agent restart handoff exceeded its fixed bound".into());
    }
    termloop_platform::atomic_replace_private_file(path, &bytes)?;
    Ok(())
}

async fn wait_for_mcp_readiness(address: SocketAddr) -> std::io::Result<()> {
    tokio::time::timeout(MCP_READINESS_TIMEOUT, async move {
        let mut stream = TcpStream::connect(address).await?;
        stream.write_all(MCP_READINESS_REQUEST).await?;
        let mut status = [0; MCP_READINESS_STATUS.len()];
        stream.read_exact(&mut status).await?;
        if status != MCP_READINESS_STATUS {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "MCP readiness probe returned an unexpected response",
            ));
        }
        Ok(())
    })
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "MCP endpoint did not become ready before agent recovery",
        )
    })?
}

fn write_claude_mcp_config(
    path: &std::path::Path,
    endpoint: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    termloop_platform::write_private_file(
        path,
        &serde_json::to_vec_pretty(&json!({
            "mcpServers": {
                "termloop_next": {
                    "type": "http",
                    "url": endpoint,
                    "headers": {
                        "Authorization": "Bearer ${TERMLOOP_MCP_TOKEN}"
                    }
                }
            }
        }))?,
    )?;
    Ok(())
}

fn state_path(state_directory: &std::path::Path) -> PathBuf {
    state_directory.join("state.v1.json")
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn reconcile_cleanup_recoveries(state: AppState) {
    let plans = {
        let mut core = state.core.lock().await;
        core.plan_task_worktree_cleanup_recovery()
    };
    for plan in plans {
        let Ok(_permit) = state
            .git_observation_gate
            .acquire("__recovery__", ObservationPriority::Background)
            .await
        else {
            return;
        };
        let observed = tokio::task::spawn_blocking(move || plan.observe()).await;
        let Ok(Ok(observed)) = observed else {
            continue;
        };
        let (previous_revision, revision) = {
            let mut core = state.core.lock().await;
            let previous = core.state_revision();
            let _ = core.apply_task_worktree_cleanup_observation(observed);
            (previous, core.state_revision())
        };
        if revision != previous_revision {
            queue_task_invalidation(&state, revision);
        }
    }
}

async fn reconcile_terminal_exits(state: AppState) {
    let mut shutdown = state.resume_shutdown.clone();
    let mut lifecycle = state.terminal.subscribe_lifecycle();
    let mut fallback = tokio::time::interval(EXIT_REAPER_INTERVAL);
    fallback.set_missed_tick_behavior(MissedTickBehavior::Skip);
    while wait_for_terminal_exit_reconcile(&mut shutdown, &mut lifecycle, &mut fallback).await {
        if *shutdown.borrow() {
            break;
        }
        let reconciled = {
            let mut core = state.core.lock().await;
            if *shutdown.borrow() {
                break;
            }
            match core.reconcile_exited_sessions() {
                Ok(result) => result,
                Err(error) => {
                    tracing::warn!(%error, "failed to reconcile exited terminal sessions");
                    termloop_core::session_launch::ReconciledSessionExits {
                        state_revision: None,
                        exited_session_ids: Vec::new(),
                        retired_runtimes: Vec::new(),
                        changed_cwds: Vec::new(),
                    }
                }
            }
        };
        if let Ok(mut capabilities) = state.tracker_report_capabilities.lock() {
            for session_id in &reconciled.exited_session_ids {
                capabilities.revoke_session(session_id);
            }
        }
        if !reconciled.retired_runtimes.is_empty() {
            tokio::task::spawn_blocking(move || drop(reconciled.retired_runtimes));
        }
        for cwd in reconciled.changed_cwds {
            refresh_task_presence_for_cwd(&state, &cwd).await;
        }
        if let Some(state_revision) = reconciled.state_revision {
            let request = InvalidationRequest {
                topics: vec![
                    ProjectionTopic::Session,
                    ProjectionTopic::AgentStatus,
                    ProjectionTopic::Steward,
                    ProjectionTopic::Worker,
                    ProjectionTopic::Routine,
                    ProjectionTopic::Run,
                ],
                state_revision,
                observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
            };
            if state.invalidation_requests.send(request).await.is_err() {
                break;
            }
        }
    }
}

/// Claude fires no hook when the user presses `Esc`, so a working turn is asked
/// its own transcript on a fixed cadence instead. Ten seconds keeps a stale
/// `working` row short-lived while leaving the check far cheaper than the hooks
/// it stands in for.
const CLAUDE_INTERRUPT_POLL_INTERVAL: Duration = Duration::from_secs(10);

async fn reconcile_claude_interrupts(state: AppState) {
    let mut ticker = tokio::time::interval(CLAUDE_INTERRUPT_POLL_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let checks = {
            let mut core = state.core.lock().await;
            core.plan_claude_interrupt_checks()
        };
        if checks.is_empty() {
            continue;
        }
        // Reading files while holding the serialized core lock is forbidden,
        // and a blocking read belongs off the async worker regardless.
        let Ok(interrupted) = tokio::task::spawn_blocking(move || {
            checks
                .into_iter()
                .filter(crate::hook::claude_turn_was_interrupted)
                .collect::<Vec<_>>()
        })
        .await
        else {
            continue;
        };
        for check in interrupted {
            let (changed, state_revision, observation_sequence) = {
                let mut core = state.core.lock().await;
                let Ok(observation_sequence) = core.next_observation_sequence() else {
                    continue;
                };
                let changed = core
                    .apply_claude_interrupt_observation(
                        &check,
                        observation_sequence,
                        current_epoch_ms(),
                    )
                    .unwrap_or(false);
                (changed, core.state_revision(), observation_sequence)
            };
            state
                .observation_sequence
                .fetch_max(observation_sequence, Ordering::Relaxed);
            if changed {
                let _ = state.invalidation_requests.try_send(InvalidationRequest {
                    topics: vec![ProjectionTopic::AgentStatus],
                    state_revision,
                    observation_sequence,
                });
            }
        }
    }
}

async fn reconcile_terminal_activity(state: AppState) {
    let mut activity = state.terminal.subscribe_activity();
    loop {
        match activity.recv().await {
            Ok(event) => {
                let observed_at_epoch_ms = current_epoch_ms();
                state.steward_presence.record_activity(
                    event.session_id,
                    event.runtime_epoch,
                    observed_at_epoch_ms,
                );
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn wait_for_terminal_exit_reconcile(
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
    lifecycle: &mut broadcast::Receiver<termloop_terminal::TerminalLifecycleEvent>,
    fallback: &mut tokio::time::Interval,
) -> bool {
    if *shutdown.borrow() {
        return false;
    }
    tokio::select! {
        biased;
        changed = shutdown.changed() => {
            changed.is_ok() && !*shutdown.borrow()
        }
        event = lifecycle.recv() => {
            matches!(event, Ok(_) | Err(broadcast::error::RecvError::Lagged(_)))
        }
        _ = fallback.tick() => true,
    }
}

async fn stop_terminal_exit_reconciler(mut task: tokio::task::JoinHandle<()>) {
    match tokio::time::timeout(EXIT_REAPER_SHUTDOWN_TIMEOUT, &mut task).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(%error, "terminal exit reconciler did not join cleanly");
        }
        Err(_) => {
            task.abort();
            if let Err(error) = task.await
                && !error.is_cancelled()
            {
                tracing::warn!(%error, "terminal exit reconciler abort did not join cleanly");
            }
            tracing::warn!("terminal exit reconciler exceeded its shutdown deadline");
        }
    }
}

async fn reconcile_agent_runtime_signals(
    mut signals: mpsc::UnboundedReceiver<termloop_core::AgentRuntimeSignal>,
    core: MonitoredMutex<termloop_core::CoreRuntime>,
    companion_wakes: companion_supervisor::CompanionWakeQueue,
    observation_sequence: Arc<AtomicU64>,
    invalidation_requests: mpsc::Sender<InvalidationRequest>,
    tracker_runtime_wake: Arc<tokio::sync::Notify>,
) {
    while let Some(event) = signals.recv().await {
        let (changed, topic, state_revision, latest_sequence) = {
            let mut core = core.lock().await;
            let latest_sequence = match core.next_observation_sequence() {
                Ok(value) => value,
                Err(error) => {
                    tracing::warn!(%error, "failed to allocate observation sequence");
                    continue;
                }
            };
            let (changed, topic) = match event.event {
                termloop_core::AgentRuntimeEvent::Observation(signal) => (
                    core.record_daemon_bridge_observation(
                        &event.session_id,
                        event.runtime_epoch,
                        signal,
                        latest_sequence,
                        current_epoch_ms(),
                    )
                    .map_err(|error| (error, "failed to record Codex App Server observation")),
                    ProjectionTopic::AgentStatus,
                ),
                termloop_core::AgentRuntimeEvent::ResumeRefObserved(resume_ref) => (
                    core.record_agent_resume_ref(
                        &event.session_id,
                        event.runtime_epoch,
                        resume_ref,
                    )
                    .map_err(|error| (error, "failed to record current Codex resume reference")),
                    ProjectionTopic::Session,
                ),
                termloop_core::AgentRuntimeEvent::ThreadSettingsObserved(observation) => (
                    core.record_codex_thread_settings(
                        &event.session_id,
                        event.runtime_epoch,
                        observation,
                    )
                    .map_err(|error| (error, "failed to record current Codex thread settings")),
                    ProjectionTopic::Session,
                ),
                termloop_core::AgentRuntimeEvent::PlanUpdated(plan) => (
                    core.record_app_server_plan(
                        &event.session_id,
                        event.runtime_epoch,
                        plan,
                        current_epoch_ms(),
                    )
                    .map_err(|error| (error, "failed to record current Codex plan")),
                    ProjectionTopic::AgentStatus,
                ),
            };
            let changed = match changed {
                Ok(value) => value,
                Err((CoreError::CapabilityDenied, _)) => false,
                Err((error, message)) => {
                    tracing::warn!(%error, "{message}");
                    false
                }
            };
            acknowledge_confirmed_steward_wakes(&mut core, &companion_wakes);
            (changed, topic, core.state_revision(), latest_sequence)
        };
        observation_sequence.fetch_max(latest_sequence, Ordering::Relaxed);
        if changed && topic == ProjectionTopic::AgentStatus {
            // A Worker's turn ending is what makes it wakeable again, and the
            // Routine loop is asleep until told that something moved.
            tracker_runtime_wake.notify_one();
        }
        if changed
            && invalidation_requests
                .send(InvalidationRequest {
                    topics: vec![topic],
                    state_revision,
                    observation_sequence: latest_sequence,
                })
                .await
                .is_err()
        {
            break;
        }
    }
}

fn bridge_agent_runtime_signals(
    signals: std::sync::mpsc::Receiver<termloop_core::AgentRuntimeSignal>,
) -> mpsc::UnboundedReceiver<termloop_core::AgentRuntimeSignal> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::Builder::new()
        .name("agent-runtime-signals".into())
        .spawn(move || {
            while let Ok(signal) = signals.recv() {
                if sender.send(signal).is_err() {
                    break;
                }
            }
        })
        .expect("agent runtime signal relay must start");
    receiver
}

async fn reconcile_generated_input_runtime_events(
    mut events: mpsc::UnboundedReceiver<termloop_core::GeneratedInputRuntimeEvent>,
    core: MonitoredMutex<termloop_core::CoreRuntime>,
    companion_wakes: companion_supervisor::CompanionWakeQueue,
    observation_sequence: Arc<AtomicU64>,
    invalidation_requests: mpsc::Sender<InvalidationRequest>,
) {
    while let Some(event) = events.recv().await {
        let (changed, state_revision, latest_sequence) = {
            let mut core = core.lock().await;
            let latest_sequence = match core.next_observation_sequence() {
                Ok(value) => value,
                Err(error) => {
                    tracing::warn!(%error, "failed to allocate generated input sequence");
                    continue;
                }
            };
            let changed = match core.record_generated_input_runtime_event(event) {
                Ok(changed) => changed,
                Err(error) => {
                    tracing::warn!(%error, "failed to complete generated input delivery");
                    continue;
                }
            };
            acknowledge_confirmed_steward_wakes(&mut core, &companion_wakes);
            (changed, core.state_revision(), latest_sequence)
        };
        observation_sequence.fetch_max(latest_sequence, Ordering::Relaxed);
        if changed
            && invalidation_requests
                .send(InvalidationRequest {
                    topics: vec![ProjectionTopic::AgentStatus],
                    state_revision,
                    observation_sequence: latest_sequence,
                })
                .await
                .is_err()
        {
            break;
        }
    }
}

fn acknowledge_confirmed_steward_wakes(
    core: &mut termloop_core::CoreRuntime,
    companion_wakes: &companion_supervisor::CompanionWakeQueue,
) {
    for confirmation in core.take_confirmed_steward_wakes() {
        companion_wakes.acknowledge(
            &confirmation.project_id,
            confirmation.generation,
            confirmation.wake_id,
        );
    }
}

fn bridge_generated_input_runtime_events(
    events: std::sync::mpsc::Receiver<termloop_core::GeneratedInputRuntimeEvent>,
) -> mpsc::UnboundedReceiver<termloop_core::GeneratedInputRuntimeEvent> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::Builder::new()
        .name("generated-input-runtime-events".into())
        .spawn(move || {
            while let Ok(event) = events.recv() {
                if sender.send(event).is_err() {
                    break;
                }
            }
        })
        .expect("generated input runtime relay must start");
    receiver
}

fn current_epoch_ms() -> u64 {
    termloop_platform::current_epoch_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mcp_readiness_waits_for_the_router_to_serve_requests() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (start_sender, start_receiver) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            start_receiver.await.unwrap();
            axum::serve(listener, Router::new().route("/mcp", get(mcp_get)))
                .await
                .unwrap();
        });
        let mut readiness = Box::pin(wait_for_mcp_readiness(address));

        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut readiness)
                .await
                .is_err()
        );
        start_sender.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), &mut readiness)
            .await
            .unwrap()
            .unwrap();

        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn terminal_exit_reconciler_prioritizes_shutdown_over_ready_exit_events() {
        let (shutdown_sender, mut shutdown) = tokio::sync::watch::channel(false);
        let (lifecycle_sender, mut lifecycle) = broadcast::channel(1);
        let mut fallback = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(60),
            EXIT_REAPER_INTERVAL,
        );
        lifecycle_sender
            .send(termloop_terminal::TerminalLifecycleEvent {
                session_id: "shutdown-session".into(),
                runtime_epoch: 7,
                kind: termloop_terminal::TerminalLifecycleEventKind::Eof,
            })
            .unwrap();
        shutdown_sender.send(true).unwrap();

        assert!(
            !wait_for_terminal_exit_reconcile(&mut shutdown, &mut lifecycle, &mut fallback).await
        );
        assert_eq!(lifecycle.try_recv().unwrap().session_id, "shutdown-session");
    }

    #[test]
    fn client_launch_restart_registry_accepts_only_one_wave_per_daemon_epoch() {
        let mut registry = ClientLaunchRestartRegistry::default();
        assert_eq!(registry.accept("launch-a".into(), 3), (false, 3));
        assert_eq!(registry.accept("launch-a".into(), 99), (true, 3));
        assert_eq!(registry.accept("launch-b".into(), 7), (true, 3));
        assert_eq!(registry.accepted, Some(("launch-a".into(), 3)));
    }

    #[test]
    fn generated_mcp_catalog_maps_every_tool_once_into_the_closed_core_identity() {
        let catalog = generated_mcp_tool_catalog().unwrap();
        assert_eq!(catalog.len(), termloop_contract::current::MCP_TOOLS.len());
        assert_eq!(
            catalog
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            termloop_contract::current::MCP_TOOLS
        );
        assert!(catalog.iter().all(|tool| !tool.roles.is_empty()));
    }

    #[test]
    fn steward_launch_gate_coalesces_and_drop_always_releases_project() {
        let gate = StewardLaunchGate::default();
        let permit = gate.try_admit("project-1".into()).unwrap();
        assert!(gate.try_admit("project-1".into()).is_none());
        assert!(gate.try_admit("project-2".into()).is_some());
        drop(permit);
        assert!(gate.try_admit("project-1".into()).is_some());
    }

    #[tokio::test]
    async fn control_shutdown_request_completes_the_graceful_shutdown_wait() {
        let shutdown_requests = Arc::new(tokio::sync::Notify::new());
        schedule_control_shutdown(shutdown_requests.clone());
        tokio::time::timeout(
            Duration::from_secs(5),
            wait_for_daemon_shutdown(shutdown_requests),
        )
        .await
        .expect("a control-plane shutdown request must complete the graceful wait");
    }

    #[tokio::test]
    async fn control_shutdown_permit_survives_until_the_graceful_wait_is_polled() {
        // The reply-first grace delay may elapse before the shutdown future is
        // polled; Notify::notify_one stores a permit so the wake is not lost.
        let shutdown_requests = Arc::new(tokio::sync::Notify::new());
        schedule_control_shutdown(shutdown_requests.clone());
        tokio::time::sleep(CONTROL_SHUTDOWN_REPLY_GRACE * 3).await;
        tokio::time::timeout(
            Duration::from_secs(1),
            wait_for_daemon_shutdown(shutdown_requests),
        )
        .await
        .expect("a stored shutdown permit must complete a later graceful wait");
    }

    #[test]
    fn agent_restart_handoff_round_trips_and_is_consumed_once() {
        let root = std::env::temp_dir().join(format!(
            "termloop-server-agent-handoff-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let path = root.join(AGENT_RESTART_HANDOFF_FILE);
        let expected = vec![termloop_core::AgentDaemonRestartHandoff {
            session_id: "session-a".into(),
            agent_id: "codex".into(),
            runtime_epoch: 17,
        }];
        write_agent_restart_handoff(&path, expected.clone()).unwrap();
        assert_eq!(take_agent_restart_handoff(&path), expected);
        assert!(take_agent_restart_handoff(&path).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }
}
