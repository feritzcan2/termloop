//! Ordinary shell continuity: current descriptors stay in Store; bounded text
//! snapshots live in private, replace-in-place files outside the state model.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
use termloop_terminal::{PtySpawnSpec, ShellHistory, TerminalService};

use crate::{CoreError, CoreRuntime, store_error, terminal_error};

const SLOT_COUNT: usize = 64;
const FILE_LIMIT: usize = 1024 * 1024;
const METADATA_LIMIT: usize = 8 * 1024;
const MAGIC: &[u8; 4] = b"TLH1";

#[derive(Serialize, Deserialize)]
struct Metadata {
    session_id: String,
    project_id: String,
    runtime_epoch: u64,
    cwd: String,
}

struct Entry {
    slot: usize,
    runtime_epoch: u64,
    revision: u64,
    cwd: String,
}

/// Exactly 64 fixed file slots bound disk use without an unbounded index or
/// directory scan. The single server writer owns this value from start to stop.
pub struct ShellHistoryStore {
    directory: PathBuf,
    entries: HashMap<String, Entry>,
}

impl ShellHistoryStore {
    pub fn open(state_directory: &Path) -> Result<Self, termloop_platform::PlatformError> {
        let directory = state_directory.join("terminal-history");
        termloop_platform::ensure_private_directory(&directory)?;
        termloop_platform::remove_atomic_replace_temporaries(
            &directory,
            &(0..SLOT_COUNT)
                .map(|slot| format!("{slot:02}.bin"))
                .collect::<Vec<_>>(),
        )?;
        let mut store = Self {
            directory,
            entries: HashMap::new(),
        };
        for slot in 0..SLOT_COUNT {
            if let Some((metadata, _)) = store.read_slot(slot) {
                store.entries.insert(
                    metadata.session_id,
                    Entry {
                        slot,
                        runtime_epoch: metadata.runtime_epoch,
                        revision: 0,
                        cwd: metadata.cwd,
                    },
                );
            } else {
                // Only our exact private snapshot slots are eligible for removal.
                termloop_platform::remove_file_if_present(&store.path(slot))?;
            }
        }
        Ok(store)
    }

    fn path(&self, slot: usize) -> PathBuf {
        self.directory.join(format!("{slot:02}.bin"))
    }

    fn read_slot(&self, slot: usize) -> Option<(Metadata, String)> {
        // The primitive reads at most limit+1 bytes, even if an external writer
        // replaced this file with a huge one. Oversize/corrupt snapshots are disposable.
        let bytes = termloop_platform::read_file_tail_if_present(&self.path(slot), FILE_LIMIT + 1)
            .ok()??;
        decode_snapshot(&bytes)
    }

    fn read(&self, session: &SessionRecord) -> Option<(Metadata, String)> {
        let entry = self.entries.get(&session.id)?;
        let (metadata, text) = self.read_slot(entry.slot)?;
        (metadata.session_id == session.id && metadata.project_id == session.project_id)
            .then_some((metadata, text))
    }

    fn retain(
        &mut self,
        targets: &[SessionRecord],
    ) -> Result<(), termloop_platform::PlatformError> {
        let removed = self
            .entries
            .iter()
            .filter(|(id, _)| !targets.iter().any(|target| &target.id == *id))
            .map(|(id, entry)| (id.clone(), entry.slot))
            .collect::<Vec<_>>();
        for (id, slot) in removed {
            termloop_platform::remove_file_if_present(&self.path(slot))?;
            self.entries.remove(&id);
        }
        Ok(())
    }

    fn write(&mut self, metadata: Metadata, text: &str, revision: u64) -> Result<(), String> {
        let slot = self
            .entries
            .get(&metadata.session_id)
            .map(|entry| entry.slot)
            .or_else(|| {
                (0..SLOT_COUNT).find(|slot| !self.entries.values().any(|entry| entry.slot == *slot))
            })
            .ok_or_else(|| "terminal history capacity reached".to_owned())?;
        let header = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        if header.len() > METADATA_LIMIT || header.len() + text.len() + 8 > FILE_LIMIT {
            return Err("terminal history snapshot exceeds its bound".into());
        }
        let mut bytes = Vec::with_capacity(header.len() + text.len() + 8);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(text.as_bytes());
        termloop_platform::atomic_replace_private_snapshot(&self.path(slot), &bytes)
            .map_err(|error| error.to_string())?;
        self.entries.insert(
            metadata.session_id,
            Entry {
                slot,
                runtime_epoch: metadata.runtime_epoch,
                revision,
                cwd: metadata.cwd,
            },
        );
        Ok(())
    }
}

fn decode_snapshot(bytes: &[u8]) -> Option<(Metadata, String)> {
    if bytes.len() < 8 || bytes.len() > FILE_LIMIT || &bytes[..4] != MAGIC {
        return None;
    }
    let size = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    if size > METADATA_LIMIT || size > bytes.len() - 8 {
        return None;
    }
    let metadata: Metadata = serde_json::from_slice(&bytes[8..8 + size]).ok()?;
    if metadata.session_id.is_empty()
        || metadata.session_id.len() > 128
        || metadata.project_id.is_empty()
        || metadata.project_id.len() > 128
        || metadata.cwd.is_empty()
        || metadata.cwd.len() > 4096
    {
        return None;
    }
    let text = std::str::from_utf8(&bytes[8 + size..]).ok()?.to_owned();
    Some((metadata, text))
}

pub struct ShellHistoryCheckpointPlan {
    targets: Vec<SessionRecord>,
    terminal: TerminalService,
}

pub struct ShellHistoryCheckpoint {
    directories: Vec<(SessionRecord, String)>,
    pub errors: Vec<String>,
}

impl ShellHistoryCheckpointPlan {
    /// Process observation and all file I/O run outside the serialized Core lock.
    pub fn checkpoint(self, store: &mut ShellHistoryStore) -> ShellHistoryCheckpoint {
        let mut result = ShellHistoryCheckpoint {
            directories: Vec::new(),
            errors: Vec::new(),
        };
        if let Err(error) = store.retain(&self.targets) {
            result.errors.push(error.to_string());
            return result;
        }
        for session in self.targets {
            let after = store
                .entries
                .get(&session.id)
                .filter(|entry| entry.runtime_epoch == session.runtime_epoch)
                .map_or(0, |entry| entry.revision);
            match self
                .terminal
                .shell_history_snapshot(&session.id, session.runtime_epoch, after)
            {
                Ok(Some(snapshot)) => {
                    let cwd = snapshot.cwd.unwrap_or_else(|| session.process.cwd.clone());
                    let metadata = Metadata {
                        session_id: session.id.clone(),
                        project_id: session.project_id.clone(),
                        runtime_epoch: session.runtime_epoch,
                        cwd: cwd.clone(),
                    };
                    if let Err(error) = store.write(metadata, &snapshot.text, snapshot.revision) {
                        result.errors.push(error);
                        // Keep the descriptor and its saved directory aligned:
                        // an older file must not override a newer descriptor on
                        // restart after this snapshot failed to reach disk.
                        continue;
                    }
                    if cwd != session.process.cwd {
                        result.directories.push((session, cwd));
                    }
                }
                Ok(None) => {
                    // If the text file committed but the descriptor transaction
                    // failed, retry the directory CAS even without new output.
                    if let Some(entry) = store.entries.get(&session.id)
                        && entry.runtime_epoch == session.runtime_epoch
                        && entry.revision > 0
                        && entry.cwd != session.process.cwd
                        && session.lifecycle_state == "running"
                    {
                        result.directories.push((session, entry.cwd.clone()));
                    }
                }
                Err(error) => result.errors.push(error.to_string()),
            }
        }
        result
    }
}

fn ordinary_shell(session: &SessionRecord) -> bool {
    session.kind == SessionKind::Terminal
        && session.run_configuration_id.is_none()
        && session.process.agent_id.is_none()
        && session.process.template_ref.is_none()
        && session.archived_at_epoch_ms.is_none()
}

pub(super) fn shell_program() -> (String, Vec<String>) {
    let (program, mut args) = termloop_platform::default_shell();
    let name = Path::new(&program)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name.eq_ignore_ascii_case("powershell") || name.eq_ignore_ascii_case("pwsh") {
        // Profiles are still loaded and their prompt is retained. Only this
        // shell process gets the reporting hook; no user profile is modified.
        args.extend([
            "-NoExit".to_owned(),
            "-Command".to_owned(),
            POWERSHELL_DIRECTORY_PROMPT.to_owned(),
        ]);
    }
    (program, args)
}

const POWERSHELL_DIRECTORY_PROMPT: &str = r#"$global:__termloop_original_prompt = $function:prompt
function global:prompt {
    if ($pwd.Provider.Name -eq 'FileSystem') {
        [Console]::Write("$([char]27)]9;9;$($pwd.ProviderPath)$([char]7)")
    }
    & $global:__termloop_original_prompt
}"#;

impl CoreRuntime {
    /// Called once during daemon composition, before Core is shared or locked.
    /// Restore only interrupted ordinary shells, never explicitly stopped
    /// terminals, configured Run commands, archived Sessions, or uncertain owners.
    pub fn restore_terminal_sessions(
        &mut self,
        history: Option<&ShellHistoryStore>,
        uncertain_session_ids: &[String],
        unscoped_uncertainty: bool,
    ) -> Vec<(String, CoreError)> {
        let sessions = self
            .store
            .sessions()
            .iter()
            .filter(|session| ordinary_shell(session) && session.lifecycle_state == "stale")
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for session in sessions {
            let restored = self.restore_terminal_session(
                &session,
                history,
                uncertain_session_ids,
                unscoped_uncertainty,
            );
            if let Err(error) = restored {
                errors.push((session.id, error));
            }
        }
        errors
    }

    fn restore_terminal_session(
        &mut self,
        session: &SessionRecord,
        history: Option<&ShellHistoryStore>,
        uncertain_session_ids: &[String],
        unscoped_uncertainty: bool,
    ) -> Result<(), CoreError> {
        if unscoped_uncertainty || uncertain_session_ids.contains(&session.id) {
            return Err(CoreError::InvalidParams("runtimeOwnershipUncertain".into()));
        }
        let saved = history.and_then(|history| history.read(session));
        let cwd = saved
            .as_ref()
            .filter(|(metadata, _)| metadata.runtime_epoch == session.runtime_epoch)
            .map(|(metadata, _)| metadata.cwd.as_str())
            .unwrap_or(&session.process.cwd);
        let cwd = termloop_platform::canonical_existing_directory(cwd)
            .map_err(|_| CoreError::InvalidParams("cwdUnavailable".into()))?
            .display()
            .to_string();
        self.ensure_launch_not_reserved(Path::new(&cwd))?;
        let current_path = crate::task_worktree::comparison_key(Path::new(&cwd))
            .map_err(|_| CoreError::InvalidParams("cwdUnavailable".into()))?;
        for archived in self.archived_worktree_paths() {
            if let Ok(archived) = crate::task_worktree::comparison_key(Path::new(&archived))
                && archived.contains_or_equals(&current_path)
            {
                return Err(CoreError::InvalidParams("taskArchived".into()));
            }
        }
        // Resolve a fresh interactive shell, never execute saved argv or any
        // previously typed command as restart input.
        let (program, args) = shell_program();
        let process = ProcessDescriptor {
            program: program.clone(),
            args: args.clone(),
            cwd: cwd.clone(),
            agent_id: None,
            template_ref: None,
            template_version: None,
        };
        let history = ShellHistory::restored(saved.as_ref().map(|(_, text)| text.as_str()));
        self.terminal
            .spawn_shell(
                PtySpawnSpec {
                    session_id: session.id.clone(),
                    runtime_epoch: self.runtime_epoch,
                    program,
                    args,
                    cwd,
                    environment: termloop_platform::LaunchEnvironment::os_baseline(),
                    recent_output_replay: true,
                },
                history,
            )
            .map_err(terminal_error)?;
        if let Err(error) = self.store.restore_terminal_session(
            &self.write_authority,
            session,
            process,
            self.runtime_epoch,
        ) {
            let _ = self
                .terminal
                .terminate_epoch(&session.id, self.runtime_epoch);
            return Err(store_error(error));
        }
        Ok(())
    }

    pub fn plan_shell_history_checkpoint(&self) -> ShellHistoryCheckpointPlan {
        let targets = self
            .store
            .sessions()
            .iter()
            .rev()
            .filter(|session| ordinary_shell(session))
            .take(SLOT_COUNT)
            .cloned()
            .collect::<Vec<_>>();
        self.terminal.retain_shell_histories(
            &targets
                .iter()
                .map(|session| session.id.clone())
                .collect::<Vec<_>>(),
        );
        ShellHistoryCheckpointPlan {
            targets,
            terminal: self.terminal.clone(),
        }
    }

    pub fn apply_shell_directory_observations(
        &mut self,
        checkpoint: ShellHistoryCheckpoint,
    ) -> Result<u64, CoreError> {
        for (session, cwd) in checkpoint.directories {
            self.store
                .observe_terminal_directory(
                    &self.write_authority,
                    &session.id,
                    session.runtime_epoch,
                    &session.process.cwd,
                    &cwd,
                )
                .map_err(store_error)?;
        }
        Ok(self.store.revision())
    }
}

#[cfg(test)]
mod tests;
