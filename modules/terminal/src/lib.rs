#![forbid(unsafe_code)]

mod input_activity;
mod input_readiness;
mod input_writer;
mod output_settlement;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, TryLockError, mpsc};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use input_activity::{ClientInputActivity, ClientInputActivityKind};
use input_readiness::InputReadinessTracker;
pub use input_readiness::{InputReadinessDiagnostics, InputReadinessFacts, InputReadinessSnapshot};
#[cfg(test)]
use input_writer::INPUT_SEQUENCE_GAP;
pub use input_writer::{
    InputChunkReceipt, InputWriteFailure, InputWriteReceipt, PendingInputWrite,
};
use input_writer::{InputRequest, MAX_INPUT_SEQUENCE_CHUNKS};
use output_settlement::OutputActivityTracker;
pub use output_settlement::{
    OutputActivityDiagnostics, OutputActivitySnapshot, OutputSettlementEvidence,
    OutputSettlementFailure, OutputSettlementReceipt,
};

pub const TERMINAL_FRAME_MAGIC: &[u8; 4] = b"TL01";
pub const MAX_IO_CHUNK_BYTES: usize = 16 * 1024;
pub const MAX_ATOMIC_INPUT_BYTES: usize = 192 * 1024;
pub const MAX_RECENT_REPLAY_BYTES: usize = 1024 * 1024;
/// Minimal cursor-position report used to answer an xterm DSR query while a
/// headless interactive TUI has no renderer attached yet.
pub const HEADLESS_CURSOR_POSITION_REPORT: &[u8] = b"\x1b[1;1R";
const HANGUP_GRACE: Duration = Duration::from_millis(150);
const TERMINATE_GRACE: Duration = Duration::from_millis(350);
const KILL_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const REAP_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MIN_GRID_ROWS: u16 = 4;
const MAX_GRID_ROWS: u16 = 1024;
const MIN_GRID_COLS: u16 = 20;
const MAX_GRID_COLS: u16 = 4096;
/// Bounded so a long-lived daemon that has shown thousands of Sessions keeps a
/// fixed-size memory; the oldest remembered Session falls back to `latest`.
const MAX_REMEMBERED_GRIDS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Input = 1,
    Output = 2,
    Resize = 3,
    Gap = 4,
    Eof = 5,
    ReplayOutput = 6,
    Attach = 10,
    Ack = 11,
    Error = 12,
    Focus = 13,
    ResizeOwnership = 14,
    Detach = 15,
}

#[derive(Clone)]
pub struct PtySpawnSpec {
    pub session_id: String,
    pub runtime_epoch: u64,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub environment: termloop_platform::LaunchEnvironment,
    pub recent_output_replay: bool,
}

impl std::fmt::Debug for PtySpawnSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PtySpawnSpec")
            .field("session_id", &self.session_id)
            .field("runtime_epoch", &self.runtime_epoch)
            .field("program", &self.program)
            .field("private_arg_count", &self.args.len())
            .field("cwd", &self.cwd)
            .field("environment", &self.environment)
            .field("recent_output_replay", &self.recent_output_replay)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub enum TerminalEvent {
    Output(Vec<u8>),
    Gap(u64),
    Eof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLifecycleEvent {
    pub session_id: String,
    pub runtime_epoch: u64,
    pub kind: TerminalLifecycleEventKind,
}

/// Byte-free runtime fact emitted whenever a PTY reader observes non-empty
/// output. Consumers may timestamp it, but raw bytes remain on TerminalEvent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalActivityEvent {
    pub session_id: String,
    pub runtime_epoch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserInputActivitySnapshot {
    /// All direct input capable of changing or submitting terminal state.
    pub sequence: u64,
    /// The subset that can change composer or modal state; submit-only Enter is excluded.
    pub mutation_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReapedTerminal {
    pub session_id: String,
    pub exit_code: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalLifecycleEventKind {
    Eof,
}

/// Rows and columns a client actually renders a Session at.
///
/// The only resize a Session ever receives comes from an attached client, so a
/// PTY opened at the historical 24x80 fallback keeps laying every frame out for
/// a width no surface has until its pane is first mounted. Opening a Session
/// that ran unattached then pushes a screen wrapped for 80 columns into the
/// real grid, and the TUI repainting on that first resize erases the region it
/// believes it wrote rather than the mis-wrapped one the client shows. New
/// PTYs open at the remembered grid instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalGrid {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalGrid {
    /// Opening size before any client has reported a real grid.
    pub const FALLBACK: Self = Self { rows: 24, cols: 80 };

    /// Rejects the degenerate geometry a client can report while its surface is
    /// still being laid out, which would otherwise be remembered and reused as
    /// the opening size of every later Session.
    pub fn new(rows: u16, cols: u16) -> Option<Self> {
        let bounded = (MIN_GRID_ROWS..=MAX_GRID_ROWS).contains(&rows)
            && (MIN_GRID_COLS..=MAX_GRID_COLS).contains(&cols);
        bounded.then_some(Self { rows, cols })
    }
}

/// Transferable view of the remembered grids. The daemon reloads one at startup
/// so Sessions restarted for a client launch - which happens before any pane can
/// mount and report a size - open at the geometry their surface last had.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalGridMemory {
    /// Most recent grid any client reported, used for Sessions never shown.
    pub latest: Option<TerminalGrid>,
    /// Per-Session grids, oldest remembered first.
    pub sessions: Vec<(String, TerminalGrid)>,
}

#[derive(Default)]
struct SpawnGrids {
    latest: Option<TerminalGrid>,
    sessions: HashMap<String, TerminalGrid>,
    order: VecDeque<String>,
}

impl SpawnGrids {
    fn insert(&mut self, session_id: &str, grid: TerminalGrid) {
        if self.sessions.insert(session_id.to_owned(), grid).is_some() {
            return;
        }
        self.order.push_back(session_id.to_owned());
        while self.order.len() > MAX_REMEMBERED_GRIDS {
            match self.order.pop_front() {
                Some(evicted) => {
                    self.sessions.remove(&evicted);
                }
                None => break,
            }
        }
    }

    fn record(&mut self, session_id: &str, grid: TerminalGrid) {
        self.latest = Some(grid);
        self.insert(session_id, grid);
    }

    fn resolve(&self, session_id: &str) -> TerminalGrid {
        self.sessions
            .get(session_id)
            .copied()
            .or(self.latest)
            .unwrap_or(TerminalGrid::FALLBACK)
    }

    fn snapshot(&self) -> TerminalGridMemory {
        TerminalGridMemory {
            latest: self.latest,
            sessions: self
                .order
                .iter()
                .filter_map(|session_id| {
                    self.sessions
                        .get(session_id)
                        .map(|grid| (session_id.clone(), *grid))
                })
                .collect(),
        }
    }

    fn seed(&mut self, memory: TerminalGridMemory) {
        self.sessions.clear();
        self.order.clear();
        for (session_id, grid) in memory.sessions {
            self.insert(&session_id, grid);
        }
        self.latest = memory.latest;
    }
}

#[derive(Clone)]
pub struct TerminalService {
    inner: Arc<TerminalServiceInner>,
}

struct TerminalServiceInner {
    runtimes: Mutex<HashMap<String, SharedRuntime>>,
    launching: Mutex<HashMap<String, Arc<LaunchReservationState>>>,
    lifecycle: broadcast::Sender<TerminalLifecycleEvent>,
    activity: broadcast::Sender<TerminalActivityEvent>,
    process_registry: Option<std::path::PathBuf>,
    spawn_grids: Mutex<SpawnGrids>,
}

struct LaunchReservationState {
    runtime_epoch: u64,
    cancelled: AtomicBool,
}

struct LaunchReservation {
    inner: Arc<TerminalServiceInner>,
    session_id: String,
    state: Arc<LaunchReservationState>,
}

impl LaunchReservation {
    fn cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for LaunchReservation {
    fn drop(&mut self) {
        if let Ok(mut launching) = self.inner.launching.lock()
            && launching
                .get(&self.session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.state))
        {
            launching.remove(&self.session_id);
        }
    }
}

impl Default for TerminalService {
    fn default() -> Self {
        let (lifecycle, _) = broadcast::channel(256);
        let (activity, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(TerminalServiceInner {
                runtimes: Mutex::new(HashMap::new()),
                launching: Mutex::new(HashMap::new()),
                lifecycle,
                activity,
                process_registry: None,
                spawn_grids: Mutex::new(SpawnGrids::default()),
            }),
        }
    }
}

type SharedRuntime = Arc<Mutex<Runtime>>;

struct Runtime {
    epoch: u64,
    user_input_sequence: u64,
    user_input_mutation_sequence: u64,
    client_input_activity: Arc<ClientInputActivity>,
    retain_after_exit: bool,
    exit_reported: bool,
    writer: mpsc::SyncSender<InputRequest>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    events: broadcast::Sender<TerminalEvent>,
    input_readiness: InputReadinessTracker,
    output_activity: OutputActivityTracker,
    recent_replay: Arc<Mutex<RecentReplay>>,
    _ownership_record: Option<termloop_platform::TrackedProcessLease>,
    // Held for the child's whole lifetime. On Windows this is the kill-on-
    // close Job Object that signal_process_tree(pid, Kill) terminates; drop
    // after reaping is a no-op, while drop with live descendants (daemon
    // teardown, error paths) is the OS-level fail-closed backstop. On unix it
    // is a no-op because the setsid child already owns its process group.
    _process_tree_guard: Option<termloop_platform::ProcessTreeGuard>,
}

#[derive(Default)]
struct RecentReplay {
    enabled: bool,
    bytes: usize,
    dropped_frames: u64,
    events: VecDeque<TerminalEvent>,
}

impl RecentReplay {
    fn record_output(&mut self, bytes: &[u8]) {
        if !self.enabled || bytes.len() > MAX_RECENT_REPLAY_BYTES {
            return;
        }
        while self.bytes.saturating_add(bytes.len()) > MAX_RECENT_REPLAY_BYTES {
            match self.events.pop_front() {
                Some(TerminalEvent::Output(discarded)) => {
                    self.bytes = self.bytes.saturating_sub(discarded.len());
                    self.dropped_frames = self.dropped_frames.saturating_add(1);
                }
                Some(TerminalEvent::Gap(_)) => {}
                Some(TerminalEvent::Eof) => {}
                None => break,
            }
        }
        self.bytes += bytes.len();
        self.events.push_back(TerminalEvent::Output(bytes.to_vec()));
    }

    fn record_eof(&mut self) {
        if self.enabled {
            self.events.push_back(TerminalEvent::Eof);
        }
    }

    fn snapshot(&self) -> VecDeque<TerminalEvent> {
        if !self.enabled {
            return VecDeque::new();
        }
        // PTYs commonly produce many tiny reads while a TUI redraws. Replaying each
        // read as its own outbound frame can overflow an attachment's bounded frame
        // queue even though the entire replay is bounded to 1 MiB and would fit its
        // byte budget. Coalesce only the frozen snapshot; live delivery and the
        // eviction accounting above retain their original frame boundaries.
        let mut snapshot = VecDeque::new();
        for event in &self.events {
            match event {
                TerminalEvent::Output(bytes) => {
                    let append_to_last = snapshot.back_mut().and_then(|last| match last {
                        TerminalEvent::Output(existing)
                            if existing.len().saturating_add(bytes.len()) <= MAX_IO_CHUNK_BYTES =>
                        {
                            Some(existing)
                        }
                        _ => None,
                    });
                    if let Some(existing) = append_to_last {
                        existing.extend_from_slice(bytes);
                    } else {
                        snapshot.push_back(TerminalEvent::Output(bytes.clone()));
                    }
                }
                TerminalEvent::Gap(count) => snapshot.push_back(TerminalEvent::Gap(*count)),
                TerminalEvent::Eof => snapshot.push_back(TerminalEvent::Eof),
            }
        }
        if self.dropped_frames > 0 {
            snapshot.push_front(TerminalEvent::Gap(self.dropped_frames));
        }
        snapshot
    }
}

pub struct TerminalSubscription {
    replay: VecDeque<TerminalEvent>,
    live: broadcast::Receiver<TerminalEvent>,
}

pub struct TerminalDelivery {
    pub event: TerminalEvent,
    pub recent_replay: bool,
}

impl TerminalSubscription {
    pub async fn recv(&mut self) -> Result<TerminalEvent, broadcast::error::RecvError> {
        Ok(self.recv_delivery().await?.event)
    }

    pub async fn recv_delivery(&mut self) -> Result<TerminalDelivery, broadcast::error::RecvError> {
        if let Some(event) = self.replay.pop_front() {
            return Ok(TerminalDelivery {
                event,
                recent_replay: true,
            });
        }
        Ok(TerminalDelivery {
            event: self.live.recv().await?,
            recent_replay: false,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("session not found")]
    SessionNotFound,
    #[error("session already exists")]
    SessionExists,
    #[error("terminal process ownership record already exists")]
    OwnershipConflict,
    #[error("terminal launch was cancelled")]
    LaunchCancelled,
    #[error("PTY operation failed: {0}")]
    Pty(String),
    #[error("terminal input queue is full")]
    InputQueueFull,
    #[error("terminal input writer is unavailable")]
    InputWriterUnavailable,
    #[error("user input interleaved with generated terminal input")]
    UserInputInterleaved,
    #[error("a negotiated terminal protocol reply is still arriving")]
    ProtocolReplyPending,
    #[error("terminal registry is poisoned")]
    RegistryPoisoned,
    #[error("process did not exit after forced termination")]
    TerminationTimeout,
}

impl TerminalService {
    pub fn with_process_registry(registry_directory: std::path::PathBuf) -> Self {
        let (lifecycle, _) = broadcast::channel(256);
        let (activity, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(TerminalServiceInner {
                runtimes: Mutex::new(HashMap::new()),
                launching: Mutex::new(HashMap::new()),
                lifecycle,
                activity,
                process_registry: Some(registry_directory),
                spawn_grids: Mutex::new(SpawnGrids::default()),
            }),
        }
    }

    pub fn spawn(&self, spec: PtySpawnSpec) -> Result<(), TerminalError> {
        let reservation = self.reserve_launch(&spec.session_id, spec.runtime_epoch)?;
        if reservation.cancelled() {
            return Err(TerminalError::LaunchCancelled);
        }
        let grid = self.spawn_grid(&spec.session_id);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: grid.rows,
                cols: grid.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let mut command = CommandBuilder::new(&spec.program);
        command.env_clear();
        for arg in &spec.args {
            command.arg(arg);
        }
        for (key, value) in spec.environment.entries() {
            command.env(key, value);
        }
        command.cwd(Path::new(&spec.cwd));
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        // Attach process-tree containment immediately after spawn, before the
        // child can fan out. Descendants spawned after this attachment are
        // contained; the tiny pre-attachment window is an accepted race
        // documented on ProcessTreeGuard.
        let process_tree_guard = match child.process_id() {
            Some(process_id) => match termloop_platform::attach_process_tree_guard(process_id) {
                Ok(guard) => Some(guard),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(TerminalError::Pty(error.to_string()));
                }
            },
            None => None,
        };
        if reservation.cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(TerminalError::LaunchCancelled);
        }
        let ownership_record = if let Some(directory) = self.inner.process_registry.as_ref() {
            let process_id = child.process_id().ok_or_else(|| {
                TerminalError::Pty("spawned PTY process identity was unavailable".into())
            })?;
            match termloop_platform::register_existing_tracked_process(
                directory,
                &spec.session_id,
                process_id,
            ) {
                Ok(record) => Some(record),
                Err(termloop_platform::PlatformError::Io(error))
                    if error.kind() == std::io::ErrorKind::AlreadyExists =>
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(TerminalError::OwnershipConflict);
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(TerminalError::Pty(error.to_string()));
                }
            }
        } else {
            None
        };
        if reservation.cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(TerminalError::LaunchCancelled);
        }
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let output_activity = OutputActivityTracker::default();
        let input_readiness = InputReadinessTracker::default();
        let writer_tx = input_writer::spawn(
            writer,
            output_activity.clone(),
            spec.session_id.clone(),
            spec.runtime_epoch,
        );
        // 256 × 16 KiB reader chunks caps the daemon-side replay-free fan-out
        // buffer at 4 MiB per live session.
        let (events, _) = broadcast::channel(256);
        let reader_events = events.clone();
        let reader_input_readiness = input_readiness.clone();
        let reader_output_activity = output_activity.clone();
        let client_input_activity = Arc::new(ClientInputActivity::default());
        let reader_client_input_activity = Arc::clone(&client_input_activity);
        let recent_replay = Arc::new(Mutex::new(RecentReplay {
            enabled: spec.recent_output_replay,
            ..RecentReplay::default()
        }));
        let reader_recent_replay = recent_replay.clone();
        let lifecycle_events = self.inner.lifecycle.clone();
        let activity_events = self.inner.activity.clone();
        let lifecycle_session_id = spec.session_id.clone();
        let lifecycle_epoch = spec.runtime_epoch;
        std::thread::spawn(move || {
            let mut buffer = [0_u8; MAX_IO_CHUNK_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        reader_input_readiness.close();
                        reader_output_activity.close();
                        let mut replay = reader_recent_replay
                            .lock()
                            .expect("recent replay buffer poisoned");
                        replay.record_eof();
                        let _ = reader_events.send(TerminalEvent::Eof);
                        drop(replay);
                        let _ = lifecycle_events.send(TerminalLifecycleEvent {
                            session_id: lifecycle_session_id.clone(),
                            runtime_epoch: lifecycle_epoch,
                            kind: TerminalLifecycleEventKind::Eof,
                        });
                        break;
                    }
                    Ok(count) => {
                        let bytes = buffer[..count].to_vec();
                        reader_client_input_activity.record_output(&bytes);
                        reader_input_readiness.record(&bytes);
                        reader_output_activity.record(&bytes);
                        let _ = activity_events.send(TerminalActivityEvent {
                            session_id: lifecycle_session_id.clone(),
                            runtime_epoch: lifecycle_epoch,
                        });
                        let mut replay = reader_recent_replay
                            .lock()
                            .expect("recent replay buffer poisoned");
                        replay.record_output(&bytes);
                        let _ = reader_events.send(TerminalEvent::Output(bytes));
                        drop(replay);
                    }
                    Err(_) => {
                        reader_input_readiness.close();
                        reader_output_activity.close();
                        let mut replay = reader_recent_replay
                            .lock()
                            .expect("recent replay buffer poisoned");
                        replay.record_eof();
                        let _ = reader_events.send(TerminalEvent::Eof);
                        drop(replay);
                        let _ = lifecycle_events.send(TerminalLifecycleEvent {
                            session_id: lifecycle_session_id.clone(),
                            runtime_epoch: lifecycle_epoch,
                            kind: TerminalLifecycleEventKind::Eof,
                        });
                        break;
                    }
                }
            }
        });
        let runtime = Arc::new(Mutex::new(Runtime {
            epoch: spec.runtime_epoch,
            user_input_sequence: 0,
            user_input_mutation_sequence: 0,
            client_input_activity,
            retain_after_exit: false,
            exit_reported: false,
            writer: writer_tx,
            master: pair.master,
            child,
            events,
            input_readiness,
            output_activity,
            recent_replay,
            _ownership_record: ownership_record,
            _process_tree_guard: process_tree_guard,
        }));
        let mut registry = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if reservation.cancelled() {
            drop(registry);
            let mut runtime = runtime
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            terminate_child(runtime.child.as_mut())?;
            return Err(TerminalError::LaunchCancelled);
        }
        if registry.contains_key(&spec.session_id) {
            drop(registry);
            let mut runtime = runtime
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            terminate_child(runtime.child.as_mut())?;
            return Err(TerminalError::SessionExists);
        }
        registry.insert(spec.session_id, runtime);
        drop(registry);
        Ok(())
    }

    fn reserve_launch(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<LaunchReservation, TerminalError> {
        let registry = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if registry.contains_key(session_id) {
            return Err(TerminalError::SessionExists);
        }
        let mut launching = self
            .inner
            .launching
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if launching.contains_key(session_id) {
            return Err(TerminalError::SessionExists);
        }
        let state = Arc::new(LaunchReservationState {
            runtime_epoch,
            cancelled: AtomicBool::new(false),
        });
        launching.insert(session_id.to_owned(), state.clone());
        drop(launching);
        drop(registry);
        Ok(LaunchReservation {
            inner: self.inner.clone(),
            session_id: session_id.to_owned(),
            state,
        })
    }

    pub fn contains_session(&self, session_id: &str) -> Result<bool, TerminalError> {
        let registry = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if registry.contains_key(session_id) {
            return Ok(true);
        }
        let launching = self
            .inner
            .launching
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        Ok(launching.contains_key(session_id))
    }

    /// Observes whether the exact PTY generation still has a live child.
    ///
    /// This does not reap or deregister the runtime. Lifecycle policy remains
    /// with core; terminal only reports the provider-neutral process fact.
    pub fn session_is_running(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<bool, TerminalError> {
        let registry = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        let runtime = registry.get(session_id).cloned();
        if runtime.is_none() {
            let launching = self
                .inner
                .launching
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            return Ok(launching.get(session_id).is_some_and(|launch| {
                launch.runtime_epoch == runtime_epoch && !launch.cancelled.load(Ordering::Acquire)
            }));
        }
        drop(registry);
        let runtime = runtime.expect("runtime presence was checked above");
        let mut runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Ok(false);
        }
        runtime
            .child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| TerminalError::Pty(error.to_string()))
    }

    pub fn terminate_all(&self) -> Result<(), TerminalError> {
        let registry = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        let launching = self
            .inner
            .launching
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        let mut session_ids = registry.keys().cloned().collect::<Vec<_>>();
        for session_id in launching.keys() {
            if !session_ids.contains(session_id) {
                session_ids.push(session_id.clone());
            }
        }
        drop(launching);
        drop(registry);
        let mut first_error = None;
        for session_id in session_ids {
            if let Err(error) = self.terminate(&session_id)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn runtime(&self, session_id: &str) -> Result<SharedRuntime, TerminalError> {
        self.inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?
            .get(session_id)
            .cloned()
            .ok_or(TerminalError::SessionNotFound)
    }

    pub fn subscribe(
        &self,
        session_id: &str,
        epoch: u64,
    ) -> Result<TerminalSubscription, TerminalError> {
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != epoch {
            return Err(TerminalError::SessionNotFound);
        }
        let recent = runtime
            .recent_replay
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        // Create the live receiver while holding the same lock used by the
        // reader around buffer+publish. This makes the handoff gap-free and
        // prevents one chunk from appearing in both replay and live.
        let live = runtime.events.subscribe();
        let replay = recent.snapshot();
        Ok(TerminalSubscription { replay, live })
    }

    pub fn subscribe_lifecycle(&self) -> broadcast::Receiver<TerminalLifecycleEvent> {
        self.inner.lifecycle.subscribe()
    }

    pub fn subscribe_activity(&self) -> broadcast::Receiver<TerminalActivityEvent> {
        self.inner.activity.subscribe()
    }

    /// Keeps one exited runtime in the registry so a late attachment can replay
    /// its bounded in-memory output. The caller still owns Session lifecycle and
    /// must explicitly terminate the retained runtime before reusing its ID.
    pub fn set_exit_replay_retention(
        &self,
        session_id: &str,
        epoch: u64,
        retain: bool,
    ) -> Result<(), TerminalError> {
        let runtime = self.runtime(session_id)?;
        let mut runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != epoch {
            return Err(TerminalError::SessionNotFound);
        }
        runtime.retain_after_exit = retain;
        Ok(())
    }

    pub fn input(&self, session_id: &str, bytes: &[u8]) -> Result<(), TerminalError> {
        if bytes.len() > MAX_IO_CHUNK_BYTES {
            return Err(TerminalError::Pty("input chunk exceeds 16 KiB".to_owned()));
        }
        self.enqueue_input(session_id, bytes)
    }

    /// Enqueues direct client terminal input and advances a byte-free sequence
    /// for input capable of mutating or submitting TUI state. Negotiated
    /// protocol traffic and no-button pointer motion share this byte stream but
    /// cannot edit the composer, so the terminal-owned classifier excludes them.
    pub fn input_user(
        &self,
        session_id: &str,
        runtime_epoch: u64,
        bytes: &[u8],
    ) -> Result<(), TerminalError> {
        if bytes.len() > MAX_IO_CHUNK_BYTES {
            return Err(TerminalError::Pty(
                "user input chunk exceeds 16 KiB".to_owned(),
            ));
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let runtime = self.runtime(session_id)?;
        let mut runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        enqueue_request(&runtime.writer, InputRequest::bytes(bytes.to_vec()))?;
        match runtime.client_input_activity.classify(bytes) {
            ClientInputActivityKind::None => {}
            ClientInputActivityKind::SubmitOnly => {
                runtime.user_input_sequence = runtime.user_input_sequence.saturating_add(1);
            }
            ClientInputActivityKind::Mutating => {
                runtime.user_input_sequence = runtime.user_input_sequence.saturating_add(1);
                runtime.user_input_mutation_sequence =
                    runtime.user_input_mutation_sequence.saturating_add(1);
            }
        }
        Ok(())
    }

    pub fn user_input_sequence(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<u64, TerminalError> {
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        Ok(runtime.user_input_sequence)
    }

    pub fn user_input_activity(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<UserInputActivitySnapshot, TerminalError> {
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        Ok(UserInputActivitySnapshot {
            sequence: runtime.user_input_sequence,
            mutation_sequence: runtime.user_input_mutation_sequence,
        })
    }

    /// Waits only for a response that the terminal already classified as a
    /// query-bound protocol reply to finish arriving. No PTY bytes are retained
    /// or exposed, and ordinary user input never satisfies this wait.
    pub fn wait_for_client_protocol_reply_settlement(
        &self,
        session_id: &str,
        runtime_epoch: u64,
        timeout: Duration,
    ) -> Result<bool, TerminalError> {
        let runtime = self.runtime(session_id)?;
        let activity = {
            let runtime = runtime
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            if runtime.epoch != runtime_epoch {
                return Err(TerminalError::SessionNotFound);
            }
            Arc::clone(&runtime.client_input_activity)
        };
        Ok(activity.wait_for_protocol_reply_settlement(timeout))
    }

    /// Enqueues one caller-composed input sequence without allowing another
    /// producer to interleave bytes inside it. Content and authorization remain
    /// the caller's responsibility; terminal owns only bounded PTY mechanics.
    pub fn input_atomic(&self, session_id: &str, bytes: &[u8]) -> Result<(), TerminalError> {
        if bytes.len() > MAX_ATOMIC_INPUT_BYTES {
            return Err(TerminalError::Pty(
                "atomic input exceeds 192 KiB".to_owned(),
            ));
        }
        self.enqueue_input(session_id, bytes)
    }

    fn enqueue_input(&self, session_id: &str, bytes: &[u8]) -> Result<(), TerminalError> {
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        enqueue_request(&runtime.writer, InputRequest::bytes(bytes.to_vec()))
    }

    /// Queues one bounded atomic input and returns a byte-free handle that
    /// confirms the writer reached and flushed the PTY. Waiting on the handle
    /// is intentionally separate so callers never hold their orchestration
    /// lock across PTY I/O.
    pub fn input_atomic_receipted(
        &self,
        session_id: &str,
        runtime_epoch: u64,
        bytes: &[u8],
    ) -> Result<PendingInputWrite, TerminalError> {
        if bytes.is_empty() || bytes.len() > MAX_ATOMIC_INPUT_BYTES {
            return Err(TerminalError::Pty(
                "invalid receipted atomic input".to_owned(),
            ));
        }
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        let (request, pending) = InputRequest::receipted_bytes(bytes.to_vec(), runtime_epoch);
        enqueue_request(&runtime.writer, request)?;
        Ok(pending)
    }

    /// Atomically checks that no terminal-protocol reply is half-written and,
    /// only then, queues one input part. Ordinary client input does not block
    /// this primitive; the caller owns whether its single submit should follow
    /// user edits already serialized ahead of it.
    pub fn input_atomic_receipted_if_protocol_settled(
        &self,
        session_id: &str,
        runtime_epoch: u64,
        bytes: &[u8],
    ) -> Result<PendingInputWrite, TerminalError> {
        if bytes.is_empty() || bytes.len() > MAX_ATOMIC_INPUT_BYTES {
            return Err(TerminalError::Pty(
                "invalid receipted atomic input".to_owned(),
            ));
        }
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        if runtime
            .client_input_activity
            .has_incomplete_protocol_reply()
        {
            return Err(TerminalError::ProtocolReplyPending);
        }
        let (request, pending) = InputRequest::receipted_bytes(bytes.to_vec(), runtime_epoch);
        enqueue_request(&runtime.writer, request)?;
        Ok(pending)
    }

    /// Captures a byte-free output generation for one exact PTY epoch. A
    /// generated-input coordinator can wait for post-write rendering to settle
    /// without reading or parsing terminal content.
    pub fn output_activity_snapshot(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<OutputActivitySnapshot, TerminalError> {
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        runtime
            .output_activity
            .snapshot(session_id.to_owned(), runtime_epoch)
            .map_err(|_| TerminalError::RegistryPoisoned)
    }

    /// Captures bounded structural input-readiness facts for one exact PTY
    /// epoch. The snapshot retains no terminal bytes and applies no
    /// provider-specific readiness policy.
    pub fn input_readiness_snapshot(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<InputReadinessSnapshot, TerminalError> {
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        runtime
            .input_readiness
            .snapshot(session_id.to_owned(), runtime_epoch)
            .map_err(|_| TerminalError::RegistryPoisoned)
    }

    /// Queues a small ordered input sequence on the PTY writer. The dedicated
    /// writer inserts a short gap between chunks so interactive TUIs can
    /// distinguish pasted multiline content from the following Enter key.
    pub fn input_sequence(
        &self,
        session_id: &str,
        chunks: &[Vec<u8>],
    ) -> Result<(), TerminalError> {
        validate_input_sequence(chunks)?;
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        enqueue_request(&runtime.writer, InputRequest::sequence(chunks.to_vec()))
    }

    /// Receipt-bearing form of `input_sequence`. This remains a transport
    /// primitive: callers own content, readiness, and submission policy.
    pub fn input_sequence_receipted(
        &self,
        session_id: &str,
        runtime_epoch: u64,
        chunks: &[Vec<u8>],
    ) -> Result<PendingInputWrite, TerminalError> {
        validate_input_sequence(chunks)?;
        let runtime = self.runtime(session_id)?;
        let runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if runtime.epoch != runtime_epoch {
            return Err(TerminalError::SessionNotFound);
        }
        let (request, pending) = InputRequest::receipted_sequence(chunks.to_vec(), runtime_epoch);
        enqueue_request(&runtime.writer, request)?;
        Ok(pending)
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), TerminalError> {
        let runtime = self.runtime(session_id)?;
        runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        // A client only reports geometry it is really rendering, so an applied
        // resize is the one fact available about the surface this Session and
        // the next one will open into.
        if let Some(grid) = TerminalGrid::new(rows, cols)
            && let Ok(mut grids) = self.inner.spawn_grids.lock()
        {
            grids.record(session_id, grid);
        }
        Ok(())
    }

    /// Size the next PTY for `session_id` opens at: the grid a client last
    /// rendered that Session at, otherwise the most recent grid any client
    /// reported, otherwise the fallback.
    pub fn spawn_grid(&self, session_id: &str) -> TerminalGrid {
        self.inner
            .spawn_grids
            .lock()
            .map(|grids| grids.resolve(session_id))
            .unwrap_or(TerminalGrid::FALLBACK)
    }

    /// Restores grids observed before a daemon restart. Terminal keeps this
    /// memory in process; persisting it across restarts belongs to the daemon
    /// that owns the state directory.
    pub fn seed_terminal_grids(&self, memory: TerminalGridMemory) {
        if let Ok(mut grids) = self.inner.spawn_grids.lock() {
            grids.seed(memory);
        }
    }

    pub fn terminal_grids(&self) -> TerminalGridMemory {
        self.inner
            .spawn_grids
            .lock()
            .map(|grids| grids.snapshot())
            .unwrap_or_default()
    }

    pub fn terminate(&self, session_id: &str) -> Result<(), TerminalError> {
        let registry = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        let runtime = registry.get(session_id).cloned();
        let Some(runtime) = runtime else {
            let launching = self
                .inner
                .launching
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            let launch = launching
                .get(session_id)
                .cloned()
                .ok_or(TerminalError::SessionNotFound)?;
            launch.cancelled.store(true, Ordering::Release);
            return Ok(());
        };
        drop(registry);
        {
            // Only this Session is locked while its child is signalled and
            // reaped. The registry remains available to every unrelated PTY.
            let mut runtime_guard = runtime
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            terminate_child(runtime_guard.child.as_mut())?;
        }

        let mut registry = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if registry
            .get(session_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &runtime))
        {
            registry.remove(session_id);
        }
        Ok(())
    }

    /// Stops and reaps the process tree while retaining the bounded replay
    /// runtime for a later read-only attachment. Input to the exited child will
    /// fail naturally; explicit Session close removes the retained runtime via
    /// `terminate`.
    pub fn terminate_and_retain_output(&self, session_id: &str) -> Result<(), TerminalError> {
        let runtime = self.runtime(session_id)?;
        let mut runtime = runtime
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        runtime.retain_after_exit = true;
        terminate_child(runtime.child.as_mut())
    }

    pub fn reap_exited(&self) -> Result<Vec<ReapedTerminal>, TerminalError> {
        let runtimes: Vec<_> = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?
            .iter()
            .map(|(session_id, runtime)| (session_id.clone(), runtime.clone()))
            .collect();
        let mut exited = Vec::new();
        let mut removable = Vec::new();
        for (session_id, runtime) in &runtimes {
            let mut runtime = match runtime.try_lock() {
                Ok(runtime) => runtime,
                Err(TryLockError::WouldBlock) => continue,
                Err(TryLockError::Poisoned(_)) => return Err(TerminalError::RegistryPoisoned),
            };
            match runtime.child.try_wait() {
                Ok(Some(status)) if !runtime.exit_reported => {
                    runtime.exit_reported = true;
                    exited.push(ReapedTerminal {
                        session_id: session_id.to_owned(),
                        exit_code: status.exit_code(),
                    });
                    if !runtime.retain_after_exit {
                        removable.push(session_id.to_owned());
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => {}
                Err(error) => return Err(TerminalError::Pty(error.to_string())),
            }
        }
        if !removable.is_empty() {
            let mut registry = self
                .inner
                .runtimes
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            for session_id in &removable {
                let Some((_, observed_runtime)) = runtimes
                    .iter()
                    .find(|(observed_id, _)| observed_id == session_id)
                else {
                    continue;
                };
                if registry
                    .get(session_id)
                    .is_some_and(|registered| Arc::ptr_eq(registered, observed_runtime))
                {
                    registry.remove(session_id);
                }
            }
        }
        Ok(exited)
    }
}

fn validate_input_sequence(chunks: &[Vec<u8>]) -> Result<(), TerminalError> {
    let total_bytes = chunks
        .iter()
        .try_fold(0_usize, |total, chunk| total.checked_add(chunk.len()));
    if chunks.len() < 2
        || chunks.len() > MAX_INPUT_SEQUENCE_CHUNKS
        || chunks.iter().any(Vec::is_empty)
        || total_bytes.is_none_or(|total| total > MAX_ATOMIC_INPUT_BYTES)
    {
        return Err(TerminalError::Pty("invalid input sequence".to_owned()));
    }
    Ok(())
}

fn enqueue_request(
    writer: &mpsc::SyncSender<InputRequest>,
    request: InputRequest,
) -> Result<(), TerminalError> {
    match writer.try_send(request) {
        Ok(()) => Ok(()),
        Err(mpsc::TrySendError::Full(_)) => Err(TerminalError::InputQueueFull),
        Err(mpsc::TrySendError::Disconnected(_)) => Err(TerminalError::InputWriterUnavailable),
    }
}

fn terminate_child(child: &mut (dyn Child + Send + Sync)) -> Result<(), TerminalError> {
    let exited = child
        .try_wait()
        .map_err(|error| TerminalError::Pty(error.to_string()))?
        .is_some();

    let Some(process_id) = child.process_id() else {
        if exited {
            return Ok(());
        }
        child
            .kill()
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        return wait_for_exit(child, KILL_REAP_TIMEOUT);
    };
    if exited
        && termloop_platform::wait_for_process_tree_exit(process_id, Duration::ZERO)
            .map_err(|error| TerminalError::Pty(error.to_string()))?
    {
        return Ok(());
    }

    // A typed GracefulUnsupported outcome (Windows: a consoleless daemon has
    // no reliable cross-console graceful signal) means nothing was delivered,
    // so the phase's grace wait is skipped and the ladder escalates
    // immediately. Unix delivery — and any delivery error — keeps the grace
    // wait exactly as before. Note the ConPTY master is intentionally still
    // open here (it drops with the Runtime after termination), so no ConPTY
    // close event precedes the kill; the job-object kill is the effective
    // Windows path.
    let hangup = termloop_platform::signal_process_tree(
        process_id,
        termloop_platform::ProcessTreeSignal::Hangup,
    );
    if !matches!(
        hangup,
        Ok(termloop_platform::SignalDelivery::GracefulUnsupported)
    ) && wait_for_tree_and_child_exit_until(child, process_id, Instant::now() + HANGUP_GRACE)?
    {
        return Ok(());
    }

    let terminate = termloop_platform::signal_process_tree(
        process_id,
        termloop_platform::ProcessTreeSignal::Terminate,
    );
    if !matches!(
        terminate,
        Ok(termloop_platform::SignalDelivery::GracefulUnsupported)
    ) && wait_for_tree_and_child_exit_until(child, process_id, Instant::now() + TERMINATE_GRACE)?
    {
        return Ok(());
    }

    if let Err(error) = termloop_platform::signal_process_tree(
        process_id,
        termloop_platform::ProcessTreeSignal::Kill,
    ) && child
        .try_wait()
        .map_err(|wait_error| TerminalError::Pty(wait_error.to_string()))?
        .is_none()
    {
        return Err(TerminalError::Pty(error.to_string()));
    }
    wait_for_exit(child, KILL_REAP_TIMEOUT)?;
    if termloop_platform::wait_for_process_tree_exit(process_id, KILL_REAP_TIMEOUT)
        .map_err(|error| TerminalError::Pty(error.to_string()))?
    {
        Ok(())
    } else {
        Err(TerminalError::TerminationTimeout)
    }
}

fn wait_for_tree_and_child_exit_until(
    child: &mut (dyn Child + Send + Sync),
    process_id: u32,
    deadline: Instant,
) -> Result<bool, TerminalError> {
    loop {
        let child_exited = child
            .try_wait()
            .map_err(|error| TerminalError::Pty(error.to_string()))?
            .is_some();
        let tree_exited = termloop_platform::wait_for_process_tree_exit(process_id, Duration::ZERO)
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        if child_exited && tree_exited {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(REAP_POLL_INTERVAL);
    }
}

fn wait_for_exit(
    child: &mut (dyn Child + Send + Sync),
    timeout: Duration,
) -> Result<(), TerminalError> {
    if wait_for_exit_until(child, Instant::now() + timeout)? {
        Ok(())
    } else {
        Err(TerminalError::TerminationTimeout)
    }
}

fn wait_for_exit_until(
    child: &mut (dyn Child + Send + Sync),
    deadline: Instant,
) -> Result<bool, TerminalError> {
    loop {
        if child
            .try_wait()
            .map_err(|error| TerminalError::Pty(error.to_string()))?
            .is_some()
        {
            return Ok(true);
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        std::thread::sleep(REAP_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_sequence_gap_outlasts_supported_tui_paste_suppression() {
        const SUPPORTED_TUI_PASTE_SUPPRESSION: Duration = Duration::from_millis(120);

        assert!(INPUT_SEQUENCE_GAP > SUPPORTED_TUI_PASTE_SUPPRESSION);
    }

    #[test]
    fn in_flight_launch_is_visible_cancellable_and_releases_its_reservation() {
        let terminal = TerminalService::default();
        let reservation = terminal.reserve_launch("launching", 7).unwrap();

        assert!(terminal.contains_session("launching").unwrap());
        assert!(terminal.session_is_running("launching", 7).unwrap());
        assert!(matches!(
            terminal.reserve_launch("launching", 7),
            Err(TerminalError::SessionExists)
        ));
        terminal.terminate("launching").unwrap();
        assert!(!terminal.session_is_running("launching", 7).unwrap());
        assert!(reservation.cancelled());

        drop(reservation);
        assert!(!terminal.contains_session("launching").unwrap());
    }

    use std::time::Duration;

    fn selected_environment_report() -> String {
        let tool_resolves = std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success());
        format!(
            "CLAUDE_MARKER={}\nSECRET_NONCE={}\nPATH_PRESENT={}\nHOME_PRESENT={}\nTERM={}\nCOLORTERM={}\nLINES_PRESENT={}\nCOLUMNS_PRESENT={}\nTOOL_RESOLVES={}\n",
            std::env::var_os("CLAUDE_CODE_CHILD_SESSION").is_some(),
            std::env::var_os("TERMLOOP_TEST_SECRET_NONCE").is_some(),
            std::env::var_os("PATH").is_some(),
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .is_some(),
            std::env::var("TERM").unwrap_or_default(),
            std::env::var("COLORTERM").unwrap_or_default(),
            std::env::var_os("LINES").is_some(),
            std::env::var_os("COLUMNS").is_some(),
            tool_resolves,
        )
    }

    fn spec(id: &str) -> PtySpawnSpec {
        let (program, args) = termloop_platform::default_shell();
        PtySpawnSpec {
            session_id: id.to_owned(),
            runtime_epoch: 77,
            program,
            args,
            cwd: std::env::current_dir().unwrap().display().to_string(),
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        }
    }

    #[test]
    fn pty_environment_fixture() {
        std::thread::sleep(Duration::from_millis(50));
        print!("{}", selected_environment_report());
    }

    /// Reports the window size the PTY handed to the child, which is the only
    /// size a TUI can lay its first frame out for.
    #[test]
    fn pty_grid_fixture() {
        // The controlling terminal, not stdin: a test binary re-executed as the
        // PTY child keeps the slave as its controlling terminal even where the
        // harness has replaced its standard input.
        let reported = ["-f", "-F"]
            .into_iter()
            .find_map(|flag| {
                std::process::Command::new("stty")
                    .args([flag, "/dev/tty", "size"])
                    .output()
                    .ok()
                    .filter(|output| output.status.success())
                    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            })
            .unwrap_or_default();
        println!("GRID={reported}");
    }

    #[test]
    fn remembered_grids_prefer_the_session_then_the_latest_client_report() {
        let mut grids = SpawnGrids::default();
        assert_eq!(grids.resolve("never-shown"), TerminalGrid::FALLBACK);

        grids.record("narrow-pane", TerminalGrid::new(30, 60).unwrap());
        grids.record("wide-pane", TerminalGrid::new(43, 99).unwrap());

        assert_eq!(
            grids.resolve("narrow-pane"),
            TerminalGrid { rows: 30, cols: 60 }
        );
        assert_eq!(
            grids.resolve("wide-pane"),
            TerminalGrid { rows: 43, cols: 99 }
        );
        assert_eq!(
            grids.resolve("never-shown"),
            TerminalGrid { rows: 43, cols: 99 }
        );
    }

    #[test]
    fn degenerate_client_geometry_is_never_remembered() {
        assert!(TerminalGrid::new(0, 0).is_none());
        assert!(TerminalGrid::new(24, 1).is_none());
        assert!(TerminalGrid::new(1, 80).is_none());
        assert!(TerminalGrid::new(MAX_GRID_ROWS + 1, 80).is_none());
        assert!(TerminalGrid::new(24, MAX_GRID_COLS + 1).is_none());
        assert_eq!(
            TerminalGrid::new(MIN_GRID_ROWS, MIN_GRID_COLS),
            Some(TerminalGrid {
                rows: MIN_GRID_ROWS,
                cols: MIN_GRID_COLS
            })
        );
    }

    #[test]
    fn remembered_grids_stay_bounded_and_survive_a_seeded_restart() {
        let mut grids = SpawnGrids::default();
        for index in 0..MAX_REMEMBERED_GRIDS + 10 {
            grids.record(
                &format!("session-{index}"),
                TerminalGrid::new(24, 100).unwrap(),
            );
        }
        grids.record("kept", TerminalGrid::new(50, 120).unwrap());

        let snapshot = grids.snapshot();
        assert_eq!(snapshot.sessions.len(), MAX_REMEMBERED_GRIDS);
        assert!(!snapshot.sessions.iter().any(|(id, _)| id == "session-0"));

        let mut restarted = SpawnGrids::default();
        restarted.seed(snapshot);
        assert_eq!(
            restarted.resolve("kept"),
            TerminalGrid {
                rows: 50,
                cols: 120
            }
        );
        // The last grid any client reported, not the last one seeded back.
        assert_eq!(
            restarted.resolve("never-shown"),
            TerminalGrid {
                rows: 50,
                cols: 120
            }
        );
    }

    #[tokio::test]
    async fn an_applied_resize_becomes_the_grid_the_next_pty_opens_at() {
        if termloop_platform::host_requires_long_path_opt_in() {
            eprintln!(
                "UNMEASURED: stty fixture is unix-only; Windows ConPTY spawn geometry is not covered here"
            );
            return;
        }
        let service = TerminalService::default();
        service.spawn(spec("shown")).unwrap();

        service.resize("shown", 44, 118).unwrap();
        // Geometry a surface could not be rendering leaves the memory alone.
        service.resize("shown", 0, 0).unwrap();

        assert_eq!(
            service.spawn_grid("shown"),
            TerminalGrid {
                rows: 44,
                cols: 118
            }
        );
        assert_eq!(
            service.spawn_grid("never-shown"),
            TerminalGrid {
                rows: 44,
                cols: 118
            }
        );
        assert_eq!(
            service.terminal_grids(),
            TerminalGridMemory {
                latest: TerminalGrid::new(44, 118),
                sessions: vec![("shown".to_owned(), TerminalGrid::new(44, 118).unwrap())],
            }
        );
        service.terminate("shown").unwrap();
    }

    #[tokio::test]
    async fn a_new_pty_opens_at_the_grid_its_client_last_rendered() {
        if termloop_platform::host_requires_long_path_opt_in() {
            eprintln!(
                "UNMEASURED: stty fixture is unix-only; Windows ConPTY spawn geometry is not covered here"
            );
            return;
        }
        let service = TerminalService::default();
        service.seed_terminal_grids(TerminalGridMemory {
            latest: Some(TerminalGrid::new(31, 113).unwrap()),
            sessions: vec![("narrow".to_owned(), TerminalGrid::new(37, 61).unwrap())],
        });

        for (session_id, expected) in [("narrow", "37 61"), ("fresh", "31 113")] {
            let mut child_spec = spec(session_id);
            child_spec.program = std::env::current_exe()
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap();
            child_spec.args = vec![
                "--exact".into(),
                "tests::pty_grid_fixture".into(),
                "--nocapture".into(),
            ];
            service.spawn(child_spec).unwrap();
            let mut events = service.subscribe(session_id, 77).unwrap();
            let mut output = Vec::new();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    match events.recv().await.unwrap() {
                        TerminalEvent::Output(bytes) => {
                            output.extend(bytes);
                            if String::from_utf8_lossy(&output).contains("GRID=") {
                                break;
                            }
                        }
                        TerminalEvent::Eof => break,
                        TerminalEvent::Gap(_) => {}
                    }
                }
            })
            .await
            .unwrap();
            assert!(
                String::from_utf8_lossy(&output).contains(&format!("GRID={expected}")),
                "session {session_id} did not open at {expected}: {}",
                String::from_utf8_lossy(&output)
            );
            service.terminate(session_id).unwrap();
        }
    }

    #[tokio::test]
    async fn pty_environment_is_reconstructed_from_a_poisoned_parent() {
        if termloop_platform::host_requires_long_path_opt_in() {
            eprintln!(
                "UNMEASURED: raw headless ConPTY fixture; renderer-backed Windows PTY coverage lives in core session-launch tests"
            );
            return;
        }
        if std::env::var_os("TERMLOOP_TEST_ENV_REEXEC").is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::pty_environment_is_reconstructed_from_a_poisoned_parent",
                    "--nocapture",
                ])
                .env("TERMLOOP_TEST_ENV_REEXEC", "1")
                .env("CLAUDE_CODE_CHILD_SESSION", "poisoned-parent")
                .env("TERMLOOP_TEST_SECRET_NONCE", "must-not-cross")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }

        let service = TerminalService::default();
        let mut child_spec = spec("environment");
        child_spec.program = std::env::current_exe()
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap();
        child_spec.args = vec![
            "--exact".into(),
            "tests::pty_environment_fixture".into(),
            "--nocapture".into(),
        ];
        service.spawn(child_spec).unwrap();
        let mut events = service.subscribe("environment", 77).unwrap();
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let TerminalEvent::Output(bytes) = events.recv().await.unwrap() {
                output.extend(bytes);
            }
        })
        .await
        .unwrap();
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("CLAUDE_MARKER=false"));
        assert!(output.contains("SECRET_NONCE=false"));
        assert!(output.contains("PATH_PRESENT=true"));
        assert!(output.contains("HOME_PRESENT=true"));
        assert!(output.contains("TERM=xterm-256color"));
        assert!(output.contains("COLORTERM=truecolor"));
        assert!(output.contains("LINES_PRESENT=false"));
        assert!(output.contains("COLUMNS_PRESENT=false"));
        assert!(output.contains("TOOL_RESOLVES=true"));
    }

    #[tokio::test]
    async fn bounded_recent_output_is_replayed_to_each_late_attachment() {
        if termloop_platform::host_requires_long_path_opt_in() {
            eprintln!(
                "UNMEASURED: raw headless ConPTY fixture; renderer-backed Windows PTY coverage lives in core session-launch tests"
            );
            return;
        }
        let service = TerminalService::default();
        let mut child_spec = spec("recent-replay");
        child_spec.recent_output_replay = true;
        child_spec.program = std::env::current_exe()
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap();
        child_spec.args = vec![
            "--exact".into(),
            "tests::pty_environment_fixture".into(),
            "--nocapture".into(),
        ];
        let mut lifecycle = service.subscribe_lifecycle();
        service.spawn(child_spec).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = lifecycle.recv().await.unwrap();
                if event.session_id == "recent-replay" {
                    break;
                }
            }
        })
        .await
        .unwrap();

        let mut first = service.subscribe("recent-replay", 77).unwrap();
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let TerminalEvent::Output(bytes) = first.recv().await.unwrap() {
                    output.extend(bytes);
                    if String::from_utf8_lossy(&output).contains("PATH_PRESENT=true") {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert!(String::from_utf8_lossy(&output).contains("PATH_PRESENT=true"));

        let mut second = service.subscribe("recent-replay", 77).unwrap();
        let mut replayed = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let TerminalEvent::Output(bytes) = second.recv().await.unwrap() {
                    replayed.extend(bytes);
                    if String::from_utf8_lossy(&replayed).contains("PATH_PRESENT=true") {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert!(String::from_utf8_lossy(&replayed).contains("PATH_PRESENT=true"));

        let mut third = service.subscribe("recent-replay", 77).unwrap();
        let third_event = tokio::time::timeout(Duration::from_secs(1), third.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(third_event, TerminalEvent::Output(_)));
    }

    #[tokio::test]
    async fn retained_exit_is_reported_once_and_keeps_late_replay_attachable() {
        if termloop_platform::host_requires_long_path_opt_in() {
            eprintln!(
                "UNMEASURED: raw headless ConPTY fixture; renderer-backed Windows PTY coverage lives in core session-launch tests"
            );
            return;
        }
        let service = TerminalService::default();
        let mut child_spec = spec("retained-exit");
        child_spec.recent_output_replay = true;
        child_spec.program = std::env::current_exe()
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap();
        child_spec.args = vec![
            "--exact".into(),
            "tests::pty_environment_fixture".into(),
            "--nocapture".into(),
        ];
        let mut lifecycle = service.subscribe_lifecycle();
        service.spawn(child_spec).unwrap();
        service
            .set_exit_replay_retention("retained-exit", 77, true)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = lifecycle.recv().await.unwrap();
                if event.session_id == "retained-exit" {
                    break;
                }
            }
        })
        .await
        .unwrap();

        let mut first_reap = Vec::new();
        for _ in 0..100 {
            first_reap = service.reap_exited().unwrap();
            if !first_reap.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(first_reap.len(), 1);
        assert_eq!(first_reap[0].session_id, "retained-exit");
        assert!(service.reap_exited().unwrap().is_empty());
        assert!(service.contains_session("retained-exit").unwrap());

        let mut replay = service.subscribe("retained-exit", 77).unwrap();
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match replay.recv().await.unwrap() {
                    TerminalEvent::Output(bytes) => output.extend(bytes),
                    TerminalEvent::Eof => break,
                    TerminalEvent::Gap(_) => {}
                }
            }
        })
        .await
        .unwrap();
        assert!(String::from_utf8_lossy(&output).contains("PATH_PRESENT=true"));

        service.terminate("retained-exit").unwrap();
        assert!(!service.contains_session("retained-exit").unwrap());
    }

    #[test]
    fn recent_output_ring_keeps_recording_and_marks_eviction() {
        let mut replay = RecentReplay {
            enabled: true,
            ..RecentReplay::default()
        };
        replay.record_output(b"before");
        let first = replay.snapshot();
        assert!(matches!(first.front(), Some(TerminalEvent::Output(bytes)) if bytes == b"before"));

        replay.record_output(b"after");
        let second = replay.snapshot();
        assert!(
            matches!(second.front(), Some(TerminalEvent::Output(bytes)) if bytes == b"beforeafter")
        );

        let large = vec![b'x'; MAX_RECENT_REPLAY_BYTES / 2 + 1];
        replay.record_output(&large);
        replay.record_output(&large);
        let truncated = replay.snapshot();
        assert!(matches!(truncated.front(), Some(TerminalEvent::Gap(count)) if *count > 0));
        assert!(replay.bytes <= MAX_RECENT_REPLAY_BYTES);
    }

    #[test]
    fn recent_output_snapshot_coalesces_tiny_reads_below_attachment_queue_bound() {
        let mut replay = RecentReplay {
            enabled: true,
            ..RecentReplay::default()
        };
        for _ in 0..2_000 {
            replay.record_output(b"x");
        }

        let snapshot = replay.snapshot();
        assert_eq!(
            snapshot
                .iter()
                .filter(|event| matches!(event, TerminalEvent::Output(_)))
                .count(),
            1
        );
        assert_eq!(
            snapshot
                .iter()
                .filter_map(|event| match event {
                    TerminalEvent::Output(bytes) => Some(bytes.len()),
                    _ => None,
                })
                .sum::<usize>(),
            2_000
        );
    }

    #[test]
    fn recent_output_snapshot_preserves_order_around_non_output_events() {
        let replay = RecentReplay {
            enabled: true,
            events: VecDeque::from([
                TerminalEvent::Output(b"before".to_vec()),
                TerminalEvent::Gap(7),
                TerminalEvent::Output(b"after".to_vec()),
                TerminalEvent::Eof,
            ]),
            bytes: 11,
            dropped_frames: 3,
        };

        let snapshot = replay.snapshot();
        assert!(matches!(snapshot.front(), Some(TerminalEvent::Gap(3))));
        assert!(
            matches!(snapshot.get(1), Some(TerminalEvent::Output(bytes)) if bytes == b"before")
        );
        assert!(matches!(snapshot.get(2), Some(TerminalEvent::Gap(7))));
        assert!(matches!(snapshot.get(3), Some(TerminalEvent::Output(bytes)) if bytes == b"after"));
        assert!(matches!(snapshot.get(4), Some(TerminalEvent::Eof)));
    }

    #[test]
    fn spawn_spec_debug_redacts_environment_values() {
        let mut spawn = spec("redacted");
        spawn.environment = spawn
            .environment
            .with_explicit("TERMLOOP_HOOK_TOKEN", "must-not-appear");
        let debug = format!("{spawn:?}");
        assert!(debug.contains("TERMLOOP_HOOK_TOKEN"));
        assert!(!debug.contains("must-not-appear"));
    }

    #[tokio::test]
    async fn terminal_input_output_and_natural_reap_are_cross_platform() {
        if termloop_platform::host_requires_long_path_opt_in() {
            eprintln!(
                "UNMEASURED: raw headless ConPTY fixture; renderer-backed Windows PTY coverage lives in core session-launch tests"
            );
            return;
        }
        let service = TerminalService::default();
        let mut lifecycle = service.subscribe_lifecycle();
        let mut activity = service.subscribe_activity();
        service.spawn(spec("roundtrip")).unwrap();
        assert!(service.session_is_running("roundtrip", 77).unwrap());
        assert!(!service.session_is_running("roundtrip", 78).unwrap());
        let mut events = service.subscribe("roundtrip", 77).unwrap();
        assert_eq!(service.user_input_sequence("roundtrip", 77).unwrap(), 0);
        service
            .input_user("roundtrip", 77, b"echo TERMLOOP_USER_INPUT_TEST\r")
            .unwrap();
        assert_eq!(service.user_input_sequence("roundtrip", 77).unwrap(), 1);
        assert_eq!(
            service.user_input_activity("roundtrip", 77).unwrap(),
            UserInputActivitySnapshot {
                sequence: 1,
                mutation_sequence: 1,
            }
        );
        service.input_user("roundtrip", 77, b"\r").unwrap();
        assert_eq!(
            service.user_input_activity("roundtrip", 77).unwrap(),
            UserInputActivitySnapshot {
                sequence: 2,
                mutation_sequence: 1,
            }
        );
        service
            .input_atomic_receipted_if_protocol_settled("roundtrip", 77, b"\r")
            .unwrap()
            .wait(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(
            service.input_atomic_receipted("roundtrip", 78, b"stale"),
            Err(TerminalError::SessionNotFound)
        ));
        let pending = service
            .input_sequence_receipted(
                "roundtrip",
                77,
                &[b"echo TERMLOOP_TERMINAL_TEST".to_vec(), b"\r".to_vec()],
            )
            .unwrap();
        let receipt = pending.wait(Duration::from_secs(1)).unwrap();
        assert_eq!(receipt.runtime_epoch, 77);
        assert_eq!(receipt.chunks.len(), 2);
        service.input("roundtrip", b"exit\r\n").unwrap();

        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(30), async {
            while let TerminalEvent::Output(bytes) = events.recv().await.unwrap() {
                output.extend(bytes);
            }
        })
        .await
        .unwrap();
        assert!(String::from_utf8_lossy(&output).contains("TERMLOOP_TERMINAL_TEST"));
        let observed_activity = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let event = activity.recv().await.unwrap();
                if event.session_id == "roundtrip" {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(observed_activity.runtime_epoch, 77);
        let lifecycle_event = tokio::time::timeout(Duration::from_secs(1), lifecycle.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(lifecycle_event.session_id, "roundtrip");
        assert_eq!(lifecycle_event.runtime_epoch, 77);
        assert_eq!(lifecycle_event.kind, TerminalLifecycleEventKind::Eof);

        let mut reaped = Vec::new();
        for _ in 0..100 {
            reaped = service.reap_exited().unwrap();
            if !reaped.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            reaped,
            vec![ReapedTerminal {
                session_id: "roundtrip".into(),
                exit_code: 0,
            }]
        );
        assert!(!service.session_is_running("roundtrip", 77).unwrap());
    }

    #[tokio::test]
    async fn stale_epoch_is_rejected_and_terminate_deregisters_after_wait() {
        let service = TerminalService::default();
        service.spawn(spec("terminate")).unwrap();
        assert!(matches!(
            service.subscribe("terminate", 78),
            Err(TerminalError::SessionNotFound)
        ));
        assert!(matches!(
            service.input("terminate", &vec![0; MAX_IO_CHUNK_BYTES + 1]),
            Err(TerminalError::Pty(_))
        ));
        assert!(matches!(
            service.input_atomic("terminate", &vec![0; MAX_ATOMIC_INPUT_BYTES + 1]),
            Err(TerminalError::Pty(_))
        ));
        assert!(matches!(
            service.input_sequence(
                "terminate",
                &[vec![0; MAX_ATOMIC_INPUT_BYTES], b"\r".to_vec()]
            ),
            Err(TerminalError::Pty(_))
        ));
        service.terminate("terminate").unwrap();
        assert!(matches!(
            service.subscribe("terminate", 77),
            Err(TerminalError::SessionNotFound)
        ));
    }

    #[test]
    fn terminate_proves_the_entire_pty_process_group_exited() {
        if !termloop_platform::test_support::graceful_tree_signals_supported() {
            return;
        }
        let service = TerminalService::default();
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root_pid_path =
            std::env::temp_dir().join(format!("termloop-pty-tree-root-{nonce}.pid"));
        let child_pid_path =
            std::env::temp_dir().join(format!("termloop-pty-tree-child-{nonce}.pid"));
        let script = format!(
            "echo $$ > \"{}\"; /bin/sh -c 'trap \"\" HUP TERM; echo $$ > \"{}\"; while :; do sleep 1; done' & wait",
            root_pid_path.display(),
            child_pid_path.display()
        );
        let mut tree = spec("pty-tree");
        tree.program = "/bin/sh".into();
        tree.args = vec!["-c".into(), script];
        service.spawn(tree).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while !root_pid_path.exists() || !child_pid_path.exists() {
            assert!(
                Instant::now() < deadline,
                "PTY tree pids were not published"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let root_id = std::fs::read_to_string(&root_pid_path)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();

        service.terminate("pty-tree").unwrap();
        assert!(
            termloop_platform::wait_for_process_tree_exit(root_id, Duration::ZERO).unwrap(),
            "PTY descendant survived after its group leader exited"
        );
        let _ = std::fs::remove_file(root_pid_path);
        let _ = std::fs::remove_file(child_pid_path);
    }

    #[test]
    fn graceful_unsupported_termination_skips_grace_phases_and_kills_the_tree() {
        if termloop_platform::test_support::graceful_tree_signals_supported() {
            return;
        }
        let service = TerminalService::default();
        service.spawn(spec("windows-terminate")).unwrap();
        assert!(service.session_is_running("windows-terminate", 77).unwrap());
        let started = Instant::now();
        service.terminate("windows-terminate").unwrap();
        // Hangup/Terminate report GracefulUnsupported on Windows, so both
        // grace waits must be skipped and only the job-object kill remains.
        assert!(
            started.elapsed() < HANGUP_GRACE + TERMINATE_GRACE,
            "graceful-unsupported phases were not skipped"
        );
        assert!(matches!(
            service.subscribe("windows-terminate", 77),
            Err(TerminalError::SessionNotFound)
        ));
    }

    #[test]
    fn signal_ignoring_process_escalates_without_locking_unrelated_sessions() {
        let service = TerminalService::default();
        let ready_file = std::env::temp_dir().join(format!(
            "termloop-stubborn-child-{}-{}.ready",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let Some((program, args)) =
            termloop_platform::test_support::signal_ignoring_process(&ready_file)
        else {
            return;
        };
        let mut stubborn = spec("stubborn");
        stubborn.program = program;
        stubborn.args = args;
        service.spawn(stubborn).unwrap();
        service.spawn(spec("peer")).unwrap();

        let ready_deadline = Instant::now() + Duration::from_secs(5);
        while !ready_file.exists() {
            assert!(
                Instant::now() < ready_deadline,
                "signal traps were not installed"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        let (termination_tx, termination_rx) = mpsc::channel();
        let terminating_service = service.clone();
        std::thread::spawn(move || {
            let _ = termination_tx.send(terminating_service.terminate("stubborn"));
        });

        std::thread::sleep(Duration::from_millis(50));
        assert!(
            matches!(termination_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "stubborn process exited before escalation was exercised"
        );

        let (peer_tx, peer_rx) = mpsc::channel();
        let peer_service = service.clone();
        std::thread::spawn(move || {
            let result = peer_service
                .input("peer", b"echo PEER_REMAINS_RESPONSIVE\r\n")
                .and_then(|_| peer_service.resize("peer", 30, 100));
            let _ = peer_tx.send(result);
        });
        peer_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("unrelated Session blocked behind termination")
            .unwrap();

        termination_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("termination did not reach bounded SIGKILL escalation")
            .unwrap();
        assert!(matches!(
            service.subscribe("stubborn", 77),
            Err(TerminalError::SessionNotFound)
        ));

        service.terminate("peer").unwrap();
        let _ = std::fs::remove_file(ready_file);
    }
}
