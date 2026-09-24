use termloop_launch::LaunchPayload;
use termloop_terminal::{PtySpawnSpec, TerminalError, TerminalService};

/// The only agent PTY spawn seam. The terminal service owns its epoch-bound
/// process registry; each product supplies an isolated registry directory when
/// constructing that service and owns its own durable session records.
pub fn spawn_agent_terminal(
    terminal: &TerminalService,
    session_id: &str,
    runtime_epoch: u64,
    cwd: &str,
    launch: &LaunchPayload,
) -> Result<(), TerminalError> {
    terminal.spawn(PtySpawnSpec {
        session_id: session_id.into(),
        runtime_epoch,
        program: launch.program().into(),
        args: launch.args().to_vec(),
        cwd: cwd.into(),
        environment: launch.environment().clone(),
        recent_output_replay: true,
    })
}

/// An admitted launch may cross a product transaction boundary without handing
/// raw provider argv to the product. Starting it consumes this exact payload.
pub struct PreparedAgentTerminal {
    session_id: String,
    runtime_epoch: u64,
    cwd: String,
    launch: LaunchPayload,
}

impl PreparedAgentTerminal {
    pub fn new(session_id: String, runtime_epoch: u64, cwd: String, launch: LaunchPayload) -> Self {
        Self {
            session_id,
            runtime_epoch,
            cwd,
            launch,
        }
    }

    pub fn spawn(self, terminal: &TerminalService) -> Result<(), TerminalError> {
        spawn_agent_terminal(
            terminal,
            &self.session_id,
            self.runtime_epoch,
            &self.cwd,
            &self.launch,
        )
    }
}
