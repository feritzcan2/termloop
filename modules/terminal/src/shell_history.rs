//! Bounded, inert text from ordinary shells. Persistence policy belongs to Core.
//! This is a transcript tail, not a VT screen checkpoint or a command log.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

use crate::{PtySpawnSpec, TerminalError, TerminalService};

const MAX_TEXT_BYTES: usize = 960 * 1024;
const MAX_LINES: usize = 10_000;
const MAX_LINE_CHARS: usize = 8_192;
pub const MAX_SHELL_HISTORIES: usize = 64;
const NEW_SHELL: &str = "--- New shell after application restart ---";

#[derive(Clone)]
pub struct ShellHistory(Arc<Mutex<Recorder>>, Arc<(Mutex<bool>, Condvar)>);

pub struct ShellHistorySnapshot {
    pub revision: u64,
    pub text: String,
    pub cwd: Option<String>,
}

struct Recorder {
    parser: vte::Parser<8192>,
    text: Transcript,
    revision: u64,
    prefix: Option<Vec<u8>>,
    enabled: bool,
    cwd: Option<String>,
}

impl Default for ShellHistory {
    fn default() -> Self {
        Self(
            Arc::new(Mutex::new(Recorder {
                parser: vte::Parser::new_with_size(),
                text: Transcript::default(),
                revision: 1,
                prefix: None,
                enabled: true,
                cwd: None,
            })),
            Arc::new((Mutex::new(false), Condvar::new())),
        )
    }
}

impl ShellHistory {
    pub fn restored(previous: Option<&str>) -> Self {
        let history = Self::default();
        {
            let mut recorder = history.0.lock().expect("shell history poisoned");
            // Even a modified history file cannot inject a terminal reply,
            // clipboard write, mode change, or other escape into the new PTY.
            if let Some(previous) = previous.filter(|text| !text.is_empty()) {
                for c in previous.chars() {
                    if c == '\n' {
                        recorder.text.finish_line();
                    } else if !c.is_control() {
                        recorder.text.print_char(c);
                    }
                }
                if !recorder.text.line.is_empty() {
                    recorder.text.finish_line();
                }
            } else {
                recorder
                    .text
                    .append_line("[No saved terminal output is available]");
            }
            recorder.text.append_line(NEW_SHELL);
            let text = recorder.text.snapshot();
            let prefix = format!(
                "--- Previous terminal output ---\r\n{}",
                text.replace('\n', "\r\n")
            );
            recorder.prefix = Some(prefix.into_bytes());
        }
        history
    }

    pub(crate) fn replay_prefix(&self) -> Vec<u8> {
        self.0
            .lock()
            .expect("shell history poisoned")
            .prefix
            .take()
            .unwrap_or_default()
    }

    pub(crate) fn record(&self, bytes: &[u8]) {
        let mut recorder = self.0.lock().expect("shell history poisoned");
        if !recorder.enabled {
            return;
        }
        let Recorder {
            parser,
            text,
            revision,
            ..
        } = &mut *recorder;
        parser.advance(text, bytes);
        *revision = revision.saturating_add(1);
    }

    pub(crate) fn remember_directory(&self, process_id: Option<u32>) {
        let Some(cwd) = process_id
            .and_then(termloop_platform::process_working_directory)
            .and_then(|path| path.into_os_string().into_string().ok())
        else {
            return;
        };
        let mut recorder = self.0.lock().expect("shell history poisoned");
        if recorder.cwd.as_ref() != Some(&cwd) {
            recorder.cwd = Some(cwd);
            recorder.revision = recorder.revision.saturating_add(1);
        }
    }

    pub(crate) fn close(&self) {
        let (closed, changed) = &*self.1;
        *closed.lock().expect("shell history EOF poisoned") = true;
        changed.notify_all();
    }

    pub(crate) fn wait_closed(&self) {
        let (closed, changed) = &*self.1;
        let guard = closed.lock().expect("shell history EOF poisoned");
        let _ =
            changed.wait_timeout_while(guard, std::time::Duration::from_millis(250), |closed| {
                !*closed
            });
    }
}

impl TerminalService {
    /// Only Core's ordinary-shell launch path opts into transcript capture.
    /// Agents and configured commands keep their existing memory-only replay.
    pub fn spawn_shell(
        &self,
        spec: PtySpawnSpec,
        history: ShellHistory,
    ) -> Result<(), TerminalError> {
        let id = spec.session_id.clone();
        let epoch = spec.runtime_epoch;
        self.spawn_with_shell_history(spec, Some(history.clone()))?;
        let mut histories = self
            .inner
            .shell_histories
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        histories.retain(|(previous, _, _)| previous != &id);
        histories.push_back((id, epoch, history));
        while histories.len() > MAX_SHELL_HISTORIES {
            if let Some((_, _, evicted)) = histories.pop_front() {
                let mut recorder = evicted.0.lock().expect("shell history poisoned");
                recorder.enabled = false;
                recorder.text = Transcript::default();
            }
        }
        Ok(())
    }

    pub fn retain_shell_histories(&self, session_ids: &[String]) {
        if let Ok(mut histories) = self.inner.shell_histories.lock() {
            histories.retain(|(id, _, history)| {
                if session_ids.contains(id) {
                    return true;
                }
                let mut recorder = history.0.lock().expect("shell history poisoned");
                recorder.enabled = false;
                recorder.text = Transcript::default();
                false
            });
        }
    }

    /// Called outside the Core lock. Holding this exact runtime prevents the
    /// child from being reaped/PID-reused while its directory is observed.
    pub fn shell_history_snapshot(
        &self,
        session_id: &str,
        epoch: u64,
        after_revision: u64,
    ) -> Result<Option<ShellHistorySnapshot>, TerminalError> {
        let history = self
            .inner
            .shell_histories
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?
            .iter()
            .find(|(id, generation, _)| id == session_id && *generation == epoch)
            .map(|(_, _, history)| history.clone());
        let Some(history) = history else {
            return Ok(None);
        };
        if let Ok(runtime) = self.runtime(session_id) {
            let runtime = runtime
                .lock()
                .map_err(|_| TerminalError::RegistryPoisoned)?;
            if runtime.epoch == epoch {
                history.remember_directory(runtime.child.process_id());
            }
        }
        let recorder = history
            .0
            .lock()
            .map_err(|_| TerminalError::RegistryPoisoned)?;
        if recorder.revision <= after_revision {
            return Ok(None);
        }
        let text = recorder.text.snapshot();
        let revision = recorder.revision;
        let cwd = recorder.cwd.clone().or_else(|| recorder.text.cwd.clone());
        drop(recorder);
        Ok(Some(ShellHistorySnapshot {
            revision,
            text,
            cwd,
        }))
    }
}

#[derive(Default)]
struct Transcript {
    lines: VecDeque<String>,
    bytes: usize,
    line: Vec<char>,
    cursor: usize,
    alternate: bool,
    truncated: bool,
    cwd: Option<String>,
}

impl Transcript {
    fn print_char(&mut self, c: char) {
        if self.alternate || c.is_control() {
            return;
        }
        if self.cursor >= MAX_LINE_CHARS {
            self.finish_line();
            self.truncated = true;
        }
        if self.cursor >= self.line.len() {
            self.line.resize(self.cursor + 1, ' ');
        }
        self.line[self.cursor] = c;
        self.cursor += 1;
    }

    fn append_line(&mut self, line: &str) {
        self.bytes += line.len() + 1;
        self.lines.push_back(line.to_owned());
        // Reserve space for the in-progress Unicode line and truncation notice.
        while self.bytes > MAX_TEXT_BYTES - MAX_LINE_CHARS * 4 - 128 || self.lines.len() > MAX_LINES
        {
            if let Some(line) = self.lines.pop_front() {
                self.bytes -= line.len() + 1;
                self.truncated = true;
            }
        }
    }

    fn finish_line(&mut self) {
        let line = self.line.iter().collect::<String>();
        self.append_line(line.trim_end());
        self.line.clear();
        self.cursor = 0;
    }

    fn snapshot(&self) -> String {
        let mut result = String::with_capacity(self.bytes + self.line.len());
        if self.truncated {
            result.push_str("[Earlier terminal output omitted]\n");
        }
        for line in &self.lines {
            result.push_str(line);
            result.push('\n');
        }
        result.extend(&self.line);
        result
    }
}

impl vte::Perform for Transcript {
    fn print(&mut self, c: char) {
        self.print_char(c);
    }

    fn execute(&mut self, byte: u8) {
        if self.alternate {
            return;
        }
        match byte {
            b'\n' => self.finish_line(),
            b'\r' => self.cursor = 0,
            8 => self.cursor = self.cursor.saturating_sub(1),
            b'\t' => {
                let count = 8 - self.cursor % 8;
                for _ in 0..count {
                    self.print_char(' ');
                }
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        // The ordinary PowerShell prompt reports its filesystem location using
        // OSC 9;9. This metadata is consumed here, never copied into history.
        if self.alternate || params.len() < 3 || params[0] != b"9" || params[1] != b"9" {
            return;
        }
        let bytes = params[2..].join(&b';');
        if bytes.len() > 4096 {
            return;
        }
        if let Ok(cwd) = String::from_utf8(bytes)
            && !cwd.is_empty()
            && !cwd.chars().any(char::is_control)
        {
            self.cwd = Some(cwd);
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        action: char,
    ) {
        if ignore {
            return;
        }
        let value = params
            .iter()
            .next()
            .and_then(|p| p.first())
            .copied()
            .unwrap_or(0) as usize;
        if intermediates == b"?"
            && matches!(action, 'h' | 'l')
            && params
                .iter()
                .any(|p| matches!(p.first(), Some(47 | 1047 | 1049)))
        {
            if action == 'h' && !self.alternate {
                if !self.line.is_empty() {
                    self.finish_line();
                }
                self.append_line("[Full-screen application output omitted]");
            }
            self.alternate = action == 'h';
            return;
        }
        if self.alternate || !intermediates.is_empty() {
            return;
        }
        match action {
            'C' => self.cursor = (self.cursor + value.max(1)).min(MAX_LINE_CHARS - 1),
            'D' => self.cursor = self.cursor.saturating_sub(value.max(1)),
            'G' | '`' => self.cursor = value.saturating_sub(1).min(MAX_LINE_CHARS - 1),
            'K' => match value {
                0 => self.line.truncate(self.cursor),
                1 => {
                    for c in self.line.iter_mut().take(self.cursor + 1) {
                        *c = ' ';
                    }
                }
                2 => self.line.clear(),
                _ => {}
            },
            'P' => {
                let start = self.cursor.min(self.line.len());
                let end = (start + value.max(1)).min(self.line.len());
                self.line.drain(start..end);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(history: &ShellHistory) -> String {
        history.0.lock().unwrap().text.snapshot()
    }

    #[test]
    fn split_unicode_and_escape_sequences_become_inert_readable_text() {
        let history = ShellHistory::default();
        for byte in "\x1b[31mTürkçe 🦀\x1b[0m\r\n\x1b]52;c;secret\x07\x1b[6nready".as_bytes() {
            history.record(&[*byte]);
        }
        assert_eq!(text(&history), "Türkçe 🦀\nready");
        assert!(!text(&history).contains('\x1b'));
    }

    #[test]
    fn progress_updates_and_line_editing_replace_the_current_line() {
        let history = ShellHistory::default();
        history.record(b"progress 100%\rready\x1b[K\r\nabc\x08d\r\n");
        assert_eq!(text(&history), "ready\nabd\n");
    }

    #[test]
    fn alternate_screen_and_unbounded_control_payloads_do_not_fill_history() {
        let history = ShellHistory::default();
        history.record(b"shell\r\n\x1b[?1049h");
        history.record(&vec![b'x'; 2 * 1024 * 1024]);
        history.record(b"\x1b[?1049l\x1b]52;c;");
        history.record(&vec![b'x'; 2 * 1024 * 1024]);
        history.record(b"\x07done\r\n");
        assert_eq!(
            text(&history),
            "shell\n[Full-screen application output omitted]\ndone\n"
        );
    }

    #[test]
    fn tail_and_replay_are_bounded_and_report_eviction() {
        let history = ShellHistory::default();
        for _ in 0..12_000 {
            history.record(&[b'x'; 100]);
            history.record(b"\r\n");
        }
        let saved = text(&history);
        assert!(saved.starts_with("[Earlier terminal output omitted]"));
        assert!(saved.len() <= MAX_TEXT_BYTES);
        let restored = ShellHistory::restored(Some(&saved));
        let prefix = restored.replay_prefix();
        assert!(prefix.len() < crate::MAX_RECENT_REPLAY_BYTES);
        assert!(prefix.ends_with(format!("{NEW_SHELL}\r\n").as_bytes()));
        assert!(restored.replay_prefix().is_empty());
    }

    #[test]
    fn loaded_text_cannot_restore_terminal_controls_or_replay_input() {
        let history = ShellHistory::restored(Some("saved\n\x1b]52;c;fake\x07\u{009b}6n"));
        let prefix = history.replay_prefix();
        assert!(!prefix.contains(&27));
        assert!(!prefix.contains(&7));
        assert!(!String::from_utf8(prefix).unwrap().contains('\u{009b}'));
    }

    #[test]
    fn powershell_directory_reports_are_metadata_and_preserve_path_separators() {
        let history = ShellHistory::default();
        for byte in b"\x1b]9;9;C:\\work;tree\x07PS> " {
            history.record(&[*byte]);
        }
        let recorder = history.0.lock().unwrap();
        assert_eq!(recorder.text.cwd.as_deref(), Some("C:\\work;tree"));
        assert_eq!(recorder.text.snapshot(), "PS> ");
    }
}
