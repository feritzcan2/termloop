//! The PM daemon: one loopback listener serving the PM control plane, the
//! binary terminal plane for PM agents, and the MCP endpoint those agents
//! call. It owns the PM store, the PM agents' PTYs, and their schedulers.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use termloop_platform::SecureCredentialStore;
use termloop_pm::{PmError, PmStore};
use termloop_pm_contract::pm::{CONTRACT_IDENTITY, ControlEvent, EventName};
use termloop_terminal::TerminalService;
use tokio::net::TcpListener;
use tokio::sync::{Notify, broadcast};

mod agents;
mod control;
mod credentials;
mod discovery;
mod jira;
mod jira_browse;
mod mcp;
mod owners;
mod scheduler;
mod skill_discovery;
mod skills;
mod terminal;

#[cfg(test)]
mod tests;

/// The daemon's subdirectory of the platform runtime directory. It holds the
/// instance lease, the managed-process registries, agent MCP configs, and
/// the discovery file, apart from the developer daemon's runtime files.
const DAEMON_DIRECTORY: &str = "pm";
const EXIT_REAPER_INTERVAL: Duration = Duration::from_secs(1);
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// The PM store behind one lock. Store calls are short SQLite transactions;
/// provider calls never run while the lock is held.
#[derive(Clone)]
pub(crate) struct Store {
    inner: Arc<StdMutex<PmStore>>,
    path: Option<Arc<PathBuf>>,
}

impl Store {
    pub(crate) fn new(store: PmStore, path: Option<PathBuf>) -> Self {
        Self {
            inner: Arc::new(StdMutex::new(store)),
            path: path.map(Arc::new),
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, PmStore> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A second connection to the same database, for a command that calls a
    /// provider between its reads and writes (a Jira write) so it never
    /// holds the daemon's store lock across the network.
    pub(crate) fn open_detached(&self) -> Result<PmStore, PmError> {
        match &self.path {
            Some(path) => PmStore::open(path),
            None => Err(PmError::Storage(
                "the store has no database file".to_owned(),
            )),
        }
    }
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) store: Store,
    /// The one bearer of this daemon run, for control and terminal clients.
    pub(crate) token: Arc<str>,
    pub(crate) events: broadcast::Sender<ControlEvent>,
    pub(crate) credentials: Arc<dyn SecureCredentialStore>,
    pub(crate) terminal: TerminalService,
    pub(crate) runtime_epoch: u64,
    pub(crate) agents: agents::AgentRegistry,
    /// `http://127.0.0.1:<port>/mcp`.
    pub(crate) mcp_endpoint: Arc<str>,
    pub(crate) daemon_directory: Arc<PathBuf>,
    pub(crate) provider_directory: Arc<PathBuf>,
    /// Wakes the fact refresh, after a Jira pull.
    pub(crate) fact_refresh: Arc<Notify>,
}

impl AppState {
    /// Publishes one event to every subscribed control connection. The
    /// payload is checked against the contract; an invalid one is dropped.
    pub(crate) fn publish(&self, event: EventName, payload: serde_json::Value) {
        let name = serde_json::to_value(&event)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        if !termloop_pm_contract::pm::validate_event_payload(&name, &payload) {
            tracing::warn!(event = %name, "dropped an event payload outside the contract");
            return;
        }
        let _ = self.events.send(ControlEvent {
            protocol_version: CONTRACT_IDENTITY.to_owned(),
            event,
            payload,
        });
    }

    pub(crate) fn board_changed(&self, project_id: &str) {
        self.publish(
            EventName::PmBoardChanged,
            serde_json::json!({ "projectId": project_id }),
        );
    }
}

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/control", get(control::control_upgrade))
        .route("/terminal", get(terminal::terminal_upgrade))
        .route(
            "/mcp",
            get(mcp::mcp_get)
                .post(mcp::mcp_post)
                .delete(mcp::mcp_delete)
                .layer(DefaultBodyLimit::max(mcp::MAX_MCP_BODY_BYTES)),
        )
        .with_state(state)
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("termloop_pm_daemon=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();

    let runtime_directory = termloop_platform::runtime_directory()?;
    std::fs::create_dir_all(&runtime_directory)?;
    let daemon_directory = runtime_directory.join(DAEMON_DIRECTORY);
    termloop_platform::ensure_private_directory(&daemon_directory)?;
    let _instance_lease = termloop_platform::acquire_daemon_instance_lease(&daemon_directory)?;
    let process_root = daemon_directory.join("managed-processes");
    let pty_directory = process_root.join("pty");
    let provider_directory = process_root.join("provider");
    termloop_platform::ensure_private_directory(&process_root)?;
    for directory in [&pty_directory, &provider_directory] {
        termloop_platform::ensure_private_directory(directory)?;
        let recovered = termloop_platform::reap_tracked_managed_processes(directory)?;
        if recovered.terminated > 0 || recovered.failures > 0 {
            tracing::info!(
                terminated = recovered.terminated,
                failures = recovered.failures,
                "reconciled PM agent processes from the previous daemon run"
            );
        }
    }
    let terminal = TerminalService::with_process_registry(pty_directory);
    let state_directory = termloop_platform::state_directory()?;
    let store_path = PmStore::default_path()?;
    let mut pm_store = PmStore::open(&store_path)?;
    // No agent of an earlier run is alive, so none of its checks or skill
    // runs can report.
    let abandoned = pm_store.abandon_stale_checks(u64::MAX)?;
    if !abandoned.is_empty() {
        tracing::info!(
            count = abandoned.len(),
            "abandoned delivery checks of the previous run"
        );
    }
    let abandoned_runs = pm_store.abandon_stale_skill_runs(u64::MAX)?;
    if !abandoned_runs.is_empty() {
        tracing::info!(
            count = abandoned_runs.len(),
            "abandoned skill runs of the previous run"
        );
    }
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
    let address = listener.local_addr()?;
    let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
    let state = AppState {
        store: Store::new(pm_store, Some(store_path)),
        token: Arc::from(termloop_platform::generate_capability_token()),
        events,
        credentials: Arc::new(termloop_platform::PersistentSecureCredentialStore::new(
            &state_directory,
        )),
        terminal,
        runtime_epoch: termloop_platform::generate_runtime_epoch(),
        agents: agents::AgentRegistry::default(),
        mcp_endpoint: Arc::from(format!("http://{address}/mcp")),
        daemon_directory: Arc::new(daemon_directory.clone()),
        provider_directory: Arc::new(provider_directory),
        fact_refresh: Arc::new(Notify::new()),
    };
    let app = router(state.clone());
    let discovery_path = discovery::write(
        &daemon_directory,
        address,
        &state.token,
        state.runtime_epoch,
    )?;
    println!("{}", discovery_path.display());

    let reaper = tokio::spawn(run_exit_reaper(state.clone()));
    let checks = tokio::spawn(scheduler::run_check_scheduler(state.clone()));
    let facts = tokio::spawn(scheduler::run_fact_scheduler(state.clone()));
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(termloop_platform::wait_for_daemon_shutdown_signal())
        .await;
    for task in [&reaper, &checks, &facts] {
        task.abort();
    }
    if let Err(error) = state.terminal.terminate_all() {
        tracing::warn!(%error, "failed to stop every PM agent at shutdown");
    }
    let _ = termloop_platform::remove_file_if_present(&discovery_path);
    agents::remove_agent_files(&state);
    served?;
    Ok(())
}

/// Observes PM agent exits: each exited PTY is reaped once and its agent
/// session closed.
async fn run_exit_reaper(state: AppState) {
    let mut interval = tokio::time::interval(EXIT_REAPER_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        match state.terminal.reap_exited() {
            Ok(exited) => {
                for terminal in exited {
                    agents::on_agent_exit(&state, &terminal.session_id);
                }
            }
            Err(error) => tracing::warn!(%error, "failed to reap exited PM agents"),
        }
    }
}
