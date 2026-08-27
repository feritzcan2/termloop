//! Keeps the terminal grids clients report across daemon restarts.
//!
//! Terminal opens each new PTY at the grid a client last rendered that Session
//! at, but it holds that memory in process. The Sessions most likely to be
//! opened cold are exactly the ones restarted for a client launch, which the
//! desktop requests as soon as its control subscription connects — before any
//! pane can mount and report a size. Reloading the previous daemon's grids at
//! startup is what lets those restarts open at a real surface geometry instead
//! of the 24x80 fallback.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use termloop_terminal::{TerminalGrid, TerminalGridMemory, TerminalService};
use tokio::sync::Notify;

const FILE_NAME: &str = "terminal-grids.json";
/// Coalesces the continuous stream of resizes a pane drag produces into one
/// write; the in-process memory is already current for every spawn.
const WRITE_DELAY: Duration = Duration::from_secs(2);
/// Terminal caps its own memory well below this; the limit only guards against
/// reading back a file that grew by some other means.
const MAX_LOADED_SESSIONS: usize = 512;

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredGrids {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    latest: Option<StoredGrid>,
    #[serde(default)]
    sessions: Vec<StoredSessionGrid>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct StoredGrid {
    rows: u16,
    cols: u16,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredSessionGrid {
    session_id: String,
    rows: u16,
    cols: u16,
}

/// Best effort: an unreadable or malformed file simply means the daemon starts
/// with no remembered geometry, which is the previous behaviour.
pub(super) fn load(state_directory: &Path) -> TerminalGridMemory {
    let Ok(bytes) = std::fs::read(state_directory.join(FILE_NAME)) else {
        return TerminalGridMemory::default();
    };
    let Ok(stored) = serde_json::from_slice::<StoredGrids>(&bytes) else {
        return TerminalGridMemory::default();
    };
    TerminalGridMemory {
        latest: stored
            .latest
            .and_then(|grid| TerminalGrid::new(grid.rows, grid.cols)),
        sessions: stored
            .sessions
            .into_iter()
            .filter_map(|entry| {
                TerminalGrid::new(entry.rows, entry.cols).map(|grid| (entry.session_id, grid))
            })
            .take(MAX_LOADED_SESSIONS)
            .collect(),
    }
}

#[derive(Clone)]
pub(super) struct TerminalGridStore {
    changes: Arc<Notify>,
}

impl TerminalGridStore {
    /// Starts the writer for the terminal grids `terminal` accumulates.
    pub(super) fn spawn(state_directory: &Path, terminal: TerminalService) -> Self {
        let changes = Arc::new(Notify::new());
        let path = state_directory.join(FILE_NAME);
        let task_changes = changes.clone();
        tokio::spawn(async move {
            let mut persisted = terminal.terminal_grids();
            loop {
                task_changes.notified().await;
                tokio::time::sleep(WRITE_DELAY).await;
                let snapshot = terminal.terminal_grids();
                if snapshot == persisted {
                    continue;
                }
                match write(&path, &snapshot) {
                    Ok(()) => persisted = snapshot,
                    Err(error) => {
                        tracing::debug!(%error, "terminal grid memory could not be persisted")
                    }
                }
            }
        });
        Self { changes }
    }

    /// Called after a client resize was applied to a live PTY.
    pub(super) fn record_change(&self) {
        self.changes.notify_one();
    }
}

fn write(path: &Path, memory: &TerminalGridMemory) -> Result<(), String> {
    let stored = StoredGrids {
        version: 1,
        latest: memory.latest.map(|grid| StoredGrid {
            rows: grid.rows,
            cols: grid.cols,
        }),
        sessions: memory
            .sessions
            .iter()
            .map(|(session_id, grid)| StoredSessionGrid {
                session_id: session_id.clone(),
                rows: grid.rows,
                cols: grid.cols,
            })
            .collect(),
    };
    let encoded = serde_json::to_vec(&stored).map_err(|error| error.to_string())?;
    termloop_platform::atomic_replace_private_file(path, &encoded)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_directory(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "termloop-terminal-grids-{label}-{}-{}",
            std::process::id(),
            termloop_platform::generate_opaque_id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn grids_round_trip_through_the_state_directory() {
        let root = scratch_directory("round-trip");
        let memory = TerminalGridMemory {
            latest: TerminalGrid::new(43, 99),
            sessions: vec![("narrow".to_owned(), TerminalGrid::new(37, 61).unwrap())],
        };

        write(&root.join(FILE_NAME), &memory).unwrap();

        assert_eq!(load(&root), memory);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_or_corrupt_file_starts_the_daemon_without_remembered_geometry() {
        let root = scratch_directory("corrupt");
        assert_eq!(load(&root), TerminalGridMemory::default());

        std::fs::write(root.join(FILE_NAME), b"{not json").unwrap();
        assert_eq!(load(&root), TerminalGridMemory::default());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn degenerate_persisted_geometry_is_discarded_on_load() {
        let root = scratch_directory("degenerate");
        std::fs::write(
            root.join(FILE_NAME),
            br#"{"version":1,"latest":{"rows":0,"cols":0},"sessions":[
                {"session_id":"broken","rows":1,"cols":1},
                {"session_id":"kept","rows":30,"cols":60}]}"#,
        )
        .unwrap();

        let loaded = load(&root);

        assert_eq!(loaded.latest, None);
        assert_eq!(
            loaded.sessions,
            vec![("kept".to_owned(), TerminalGrid::new(30, 60).unwrap())]
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
