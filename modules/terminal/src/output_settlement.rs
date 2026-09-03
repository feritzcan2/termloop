use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const SYNCHRONIZED_OUTPUT_END: &[u8] = b"\x1b[?2026l";
const SYNCHRONIZED_OUTPUT_BEGIN: &[u8] = b"\x1b[?2026h";
const SHOW_CURSOR: &[u8] = b"\x1b[?25h";
const HIDE_CURSOR: &[u8] = b"\x1b[?25l";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CursorPosition {
    pub(crate) row: u16,
    pub(crate) column: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalStructure {
    CursorPosition(CursorPosition),
    EraseLine,
}

#[derive(Debug)]
pub(crate) struct TerminalStructureParser {
    stage: u8,
    private: bool,
    parameter_index: usize,
    parameters: [Option<u16>; 2],
    cursor_position: CursorPosition,
}

impl Default for TerminalStructureParser {
    fn default() -> Self {
        Self {
            stage: 0,
            private: false,
            parameter_index: 0,
            parameters: [None, None],
            cursor_position: CursorPosition { row: 1, column: 1 },
        }
    }
}

impl TerminalStructureParser {
    pub(crate) fn record(&mut self, byte: u8) -> Option<TerminalStructure> {
        match self.stage {
            0 if byte == b'\x1b' => self.stage = 1,
            0 if byte == b'\r' => {
                self.cursor_position.column = 1;
                return Some(TerminalStructure::CursorPosition(self.cursor_position));
            }
            0 if byte == b'\n' => {
                self.cursor_position.row = self.cursor_position.row.saturating_add(1);
                return Some(TerminalStructure::CursorPosition(self.cursor_position));
            }
            0 if byte == b'\x08' => {
                self.cursor_position.column = self.cursor_position.column.saturating_sub(1).max(1);
                return Some(TerminalStructure::CursorPosition(self.cursor_position));
            }
            0 if byte == b'\t' => {
                self.cursor_position.column = self
                    .cursor_position
                    .column
                    .saturating_sub(1)
                    .saturating_div(8)
                    .saturating_add(1)
                    .saturating_mul(8)
                    .saturating_add(1);
                return Some(TerminalStructure::CursorPosition(self.cursor_position));
            }
            // Count one cell for ASCII graphics and for the leading byte of a
            // UTF-8 scalar. Continuation bytes and C0 controls do not advance
            // the cursor. This bounded cursor model is sufficient for the
            // row/ordering facts emitted by ConPTY's normalized screen diff;
            // it is deliberately not a retained VT grid.
            0 if byte.is_ascii_graphic() || byte == b' ' || byte >= 0xc0 => {
                self.cursor_position.column = self.cursor_position.column.saturating_add(1);
            }
            1 if byte == b'[' => {
                self.stage = 2;
                self.private = false;
                self.parameter_index = 0;
                self.parameters = [None, None];
            }
            1 if byte == b'\x1b' => {}
            1 => self.reset(),
            2 if byte == b'\x1b' => {
                self.reset();
                self.stage = 1;
            }
            2 if byte == b'?' || byte == b'>' || byte == b'!' => {
                self.private = true;
            }
            2 if byte.is_ascii_digit() => {
                if let Some(parameter) = self.parameters.get_mut(self.parameter_index) {
                    let value = parameter.get_or_insert(0);
                    *value = value
                        .saturating_mul(10)
                        .saturating_add(u16::from(byte - b'0'));
                } else {
                    self.private = true;
                }
            }
            2 if byte == b';' => {
                self.parameter_index = self.parameter_index.saturating_add(1);
                if self.parameter_index >= self.parameters.len() {
                    self.private = true;
                }
            }
            2 if (0x40..=0x7e).contains(&byte) => {
                let structure = (!self.private).then(|| {
                    let first = self.parameters[0].unwrap_or(1).max(1);
                    let second = self.parameters[1].unwrap_or(1).max(1);
                    match byte {
                        b'H' | b'f' => {
                            self.cursor_position = CursorPosition {
                                row: first,
                                column: second,
                            };
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'A' => {
                            self.cursor_position.row =
                                self.cursor_position.row.saturating_sub(first).max(1);
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'B' => {
                            self.cursor_position.row =
                                self.cursor_position.row.saturating_add(first);
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'C' => {
                            self.cursor_position.column =
                                self.cursor_position.column.saturating_add(first);
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'D' => {
                            self.cursor_position.column =
                                self.cursor_position.column.saturating_sub(first).max(1);
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'E' => {
                            self.cursor_position.row =
                                self.cursor_position.row.saturating_add(first);
                            self.cursor_position.column = 1;
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'F' => {
                            self.cursor_position.row =
                                self.cursor_position.row.saturating_sub(first).max(1);
                            self.cursor_position.column = 1;
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'G' => {
                            self.cursor_position.column = first;
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'd' => {
                            self.cursor_position.row = first;
                            Some(TerminalStructure::CursorPosition(self.cursor_position))
                        }
                        b'K' => Some(TerminalStructure::EraseLine),
                        _ => None,
                    }
                });
                self.reset();
                return structure.flatten();
            }
            2 if !(0x20..=0x3f).contains(&byte) => self.reset(),
            _ => {}
        }
        None
    }

    pub(crate) fn cursor_position(&self) -> CursorPosition {
        self.cursor_position
    }

    fn reset(&mut self) {
        self.stage = 0;
        self.private = false;
        self.parameter_index = 0;
        self.parameters = [None, None];
    }
}

const TRACKED_TERMINAL_ROWS: usize = 1_024;
const TRACKED_TERMINAL_ROW_WORDS: usize = TRACKED_TERMINAL_ROWS / u64::BITS as usize;

#[derive(Debug, Clone)]
struct ErasedTerminalRows {
    words: [u64; TRACKED_TERMINAL_ROW_WORDS],
}

impl Default for ErasedTerminalRows {
    fn default() -> Self {
        Self {
            words: [0; TRACKED_TERMINAL_ROW_WORDS],
        }
    }
}

impl ErasedTerminalRows {
    fn clear(&mut self) {
        self.words.fill(0);
    }

    fn record(&mut self, row: u16) {
        let index = usize::from(row.saturating_sub(1));
        if index >= TRACKED_TERMINAL_ROWS {
            return;
        }
        self.words[index / u64::BITS as usize] |= 1 << (index % u64::BITS as usize);
    }

    fn contains(&self, row: u16) -> bool {
        let index = usize::from(row.saturating_sub(1));
        index < TRACKED_TERMINAL_ROWS
            && self.words[index / u64::BITS as usize] & (1 << (index % u64::BITS as usize)) != 0
    }
}

fn record_marker(byte: u8, marker: &[u8], matched: &mut usize) -> bool {
    if byte == marker[*matched] {
        *matched += 1;
        if *matched == marker.len() {
            *matched = 0;
            return true;
        }
    } else {
        *matched = usize::from(byte == marker[0]);
    }
    false
}

#[derive(Debug, Default)]
struct OutputActivityState {
    sequence: u64,
    synchronized_frame_sequence: u64,
    synchronized_frame_count: u64,
    synchronized_output_begin_match: usize,
    synchronized_output_match: usize,
    synchronized_frame_open: bool,
    synchronized_frame_had_show_cursor: bool,
    synchronized_frame_cursor_position: Option<CursorPosition>,
    synchronized_frame_cursor_position_observed: bool,
    synchronized_frame_visible_cursor_position: Option<CursorPosition>,
    synchronized_frame_erased_rows: ErasedTerminalRows,
    composer_render_sequence: u64,
    composer_render_count: u64,
    completed_composer_frame_sequence: u64,
    completed_composer_frame_count: u64,
    completed_composer_frame_cursor_position: Option<CursorPosition>,
    composer_surface_render_sequence: u64,
    composer_surface_render_count: u64,
    composer_surface_render_cursor_position: Option<CursorPosition>,
    show_cursor_match: usize,
    hide_cursor_match: usize,
    normalized_repaint_open: bool,
    normalized_repaint_cursor_position: Option<CursorPosition>,
    normalized_repaint_erased_rows: ErasedTerminalRows,
    terminal_structure_parser: TerminalStructureParser,
    closed: bool,
}

#[derive(Clone)]
pub(crate) struct OutputActivityTracker {
    inner: Arc<(Mutex<OutputActivityState>, Condvar)>,
    accepts_normalized_screen_diff: bool,
}

impl Default for OutputActivityTracker {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            accepts_normalized_screen_diff: !termloop_platform::host_uses_bracketed_paste_framing(),
        }
    }
}

impl OutputActivityTracker {
    pub(crate) fn record(&self, bytes: &[u8]) {
        let (state, changed) = &*self.inner;
        if let Ok(mut state) = state.lock() {
            state.sequence = state.sequence.saturating_add(1);
            for &byte in bytes {
                match state.terminal_structure_parser.record(byte) {
                    Some(TerminalStructure::CursorPosition(position))
                        if state.synchronized_frame_open =>
                    {
                        state.synchronized_frame_cursor_position = Some(position);
                        state.synchronized_frame_cursor_position_observed = true;
                        if state.synchronized_frame_had_show_cursor {
                            state.synchronized_frame_visible_cursor_position = Some(position);
                        }
                    }
                    Some(TerminalStructure::CursorPosition(position))
                        if self.accepts_normalized_screen_diff && state.normalized_repaint_open =>
                    {
                        state.normalized_repaint_cursor_position = Some(position);
                    }
                    Some(TerminalStructure::EraseLine) if state.synchronized_frame_open => {
                        if let Some(position) = state.synchronized_frame_cursor_position {
                            state.synchronized_frame_erased_rows.record(position.row);
                        }
                    }
                    Some(TerminalStructure::EraseLine)
                        if self.accepts_normalized_screen_diff && state.normalized_repaint_open =>
                    {
                        if let Some(position) = state.normalized_repaint_cursor_position {
                            state.normalized_repaint_erased_rows.record(position.row);
                        }
                    }
                    _ => {}
                }

                if record_marker(
                    byte,
                    SYNCHRONIZED_OUTPUT_BEGIN,
                    &mut state.synchronized_output_begin_match,
                ) {
                    state.synchronized_frame_open = true;
                    state.synchronized_frame_had_show_cursor = false;
                    state.synchronized_frame_cursor_position =
                        state.completed_composer_frame_cursor_position;
                    state.synchronized_frame_cursor_position_observed = false;
                    state.synchronized_frame_visible_cursor_position = None;
                    state.synchronized_frame_erased_rows.clear();
                }
                if record_marker(byte, HIDE_CURSOR, &mut state.hide_cursor_match)
                    && self.accepts_normalized_screen_diff
                {
                    state.normalized_repaint_open = true;
                    state.normalized_repaint_cursor_position =
                        Some(state.terminal_structure_parser.cursor_position());
                    state.normalized_repaint_erased_rows.clear();
                }
                if record_marker(byte, SHOW_CURSOR, &mut state.show_cursor_match) {
                    state.composer_render_sequence = state.sequence;
                    state.composer_render_count = state.composer_render_count.saturating_add(1);
                    if state.synchronized_frame_open {
                        state.synchronized_frame_had_show_cursor = true;
                        // A visible synchronized-frame cursor is structural
                        // evidence whether the frame positioned it immediately
                        // before or after showing it. Never reuse a position
                        // inherited from the previous completed frame.
                        state.synchronized_frame_visible_cursor_position =
                            if state.synchronized_frame_cursor_position_observed {
                                state.synchronized_frame_cursor_position
                            } else {
                                None
                            };
                    }
                    if self.accepts_normalized_screen_diff && state.normalized_repaint_open {
                        let position = state.terminal_structure_parser.cursor_position();
                        state.completed_composer_frame_sequence = state.sequence;
                        state.completed_composer_frame_count =
                            state.completed_composer_frame_count.saturating_add(1);
                        state.completed_composer_frame_cursor_position = Some(position);
                        if state.normalized_repaint_erased_rows.contains(position.row) {
                            state.composer_surface_render_sequence = state.sequence;
                            state.composer_surface_render_count =
                                state.composer_surface_render_count.saturating_add(1);
                            state.composer_surface_render_cursor_position = Some(position);
                        }
                        state.normalized_repaint_open = false;
                        state.normalized_repaint_cursor_position = None;
                        state.normalized_repaint_erased_rows.clear();
                    }
                }
                if record_marker(
                    byte,
                    SYNCHRONIZED_OUTPUT_END,
                    &mut state.synchronized_output_match,
                ) {
                    state.synchronized_frame_sequence = state.sequence;
                    state.synchronized_frame_count =
                        state.synchronized_frame_count.saturating_add(1);
                    if state.synchronized_frame_open
                        && state.synchronized_frame_had_show_cursor
                        && let Some(position) = state.synchronized_frame_visible_cursor_position
                    {
                        state.completed_composer_frame_sequence = state.sequence;
                        state.completed_composer_frame_count =
                            state.completed_composer_frame_count.saturating_add(1);
                        state.completed_composer_frame_cursor_position = Some(position);
                        if state.synchronized_frame_erased_rows.contains(position.row) {
                            state.composer_surface_render_sequence = state.sequence;
                            state.composer_surface_render_count =
                                state.composer_surface_render_count.saturating_add(1);
                            state.composer_surface_render_cursor_position = Some(position);
                        }
                    }
                    state.synchronized_frame_open = false;
                    state.synchronized_frame_had_show_cursor = false;
                    state.synchronized_frame_cursor_position = None;
                    state.synchronized_frame_cursor_position_observed = false;
                    state.synchronized_frame_visible_cursor_position = None;
                    state.synchronized_frame_erased_rows.clear();
                }
            }
            changed.notify_all();
        }
    }

    pub(crate) fn close(&self) {
        let (state, changed) = &*self.inner;
        if let Ok(mut state) = state.lock() {
            state.closed = true;
            changed.notify_all();
        }
    }

    pub(crate) fn snapshot(
        &self,
        session_id: String,
        runtime_epoch: u64,
    ) -> Result<OutputActivitySnapshot, OutputSettlementFailure> {
        let state = self
            .inner
            .0
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
        Ok(OutputActivitySnapshot {
            session_id,
            runtime_epoch,
            sequence: state.sequence,
            synchronized_frame_sequence: state.synchronized_frame_sequence,
            synchronized_frame_count: state.synchronized_frame_count,
            composer_render_sequence: state.composer_render_sequence,
            composer_render_count: state.composer_render_count,
            completed_composer_frame_sequence: state.completed_composer_frame_sequence,
            completed_composer_frame_count: state.completed_composer_frame_count,
            completed_composer_frame_cursor_position: state
                .completed_composer_frame_cursor_position,
            composer_surface_render_sequence: state.composer_surface_render_sequence,
            composer_surface_render_count: state.composer_surface_render_count,
            tracker: self.clone(),
        })
    }

    /// Holds the output generation lock across one PTY input write and captures
    /// its exact post-flush baseline before the reader can record output caused
    /// by that write. The snapshot is byte-free; callers still own all
    /// readiness and delivery policy.
    pub(crate) fn capture_after_input_write<T>(
        &self,
        session_id: String,
        runtime_epoch: u64,
        write: impl FnOnce() -> T,
    ) -> Result<(T, OutputActivitySnapshot), OutputSettlementFailure> {
        let state = self
            .inner
            .0
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
        let result = write();
        let snapshot = OutputActivitySnapshot {
            session_id,
            runtime_epoch,
            sequence: state.sequence,
            synchronized_frame_sequence: state.synchronized_frame_sequence,
            synchronized_frame_count: state.synchronized_frame_count,
            composer_render_sequence: state.composer_render_sequence,
            composer_render_count: state.composer_render_count,
            completed_composer_frame_sequence: state.completed_composer_frame_sequence,
            completed_composer_frame_count: state.completed_composer_frame_count,
            completed_composer_frame_cursor_position: state
                .completed_composer_frame_cursor_position,
            composer_surface_render_sequence: state.composer_surface_render_sequence,
            composer_surface_render_count: state.composer_surface_render_count,
            tracker: self.clone(),
        };
        Ok((result, snapshot))
    }
}

#[derive(Clone)]
pub struct OutputActivitySnapshot {
    session_id: String,
    runtime_epoch: u64,
    sequence: u64,
    synchronized_frame_sequence: u64,
    synchronized_frame_count: u64,
    composer_render_sequence: u64,
    composer_render_count: u64,
    completed_composer_frame_sequence: u64,
    completed_composer_frame_count: u64,
    completed_composer_frame_cursor_position: Option<CursorPosition>,
    composer_surface_render_sequence: u64,
    composer_surface_render_count: u64,
    tracker: OutputActivityTracker,
}

impl std::fmt::Debug for OutputActivitySnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OutputActivitySnapshot")
            .field("session_id", &self.session_id)
            .field("runtime_epoch", &self.runtime_epoch)
            .field("sequence", &self.sequence)
            .field(
                "synchronized_frame_sequence",
                &self.synchronized_frame_sequence,
            )
            .field("synchronized_frame_count", &self.synchronized_frame_count)
            .field("composer_render_sequence", &self.composer_render_sequence)
            .field("composer_render_count", &self.composer_render_count)
            .field(
                "completed_composer_frame_sequence",
                &self.completed_composer_frame_sequence,
            )
            .field(
                "completed_composer_frame_count",
                &self.completed_composer_frame_count,
            )
            .field(
                "composer_surface_render_sequence",
                &self.composer_surface_render_sequence,
            )
            .field(
                "composer_surface_render_count",
                &self.composer_surface_render_count,
            )
            .finish_non_exhaustive()
    }
}

impl OutputActivitySnapshot {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn runtime_epoch(&self) -> u64 {
        self.runtime_epoch
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    /// Returns bounded, byte-free structural activity observed after this
    /// snapshot. Generated-input diagnostics can retain these counters without
    /// retaining terminal content or reconstructing a screen.
    pub fn diagnostics_since(&self) -> Result<OutputActivityDiagnostics, OutputSettlementFailure> {
        let state = self
            .tracker
            .inner
            .0
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
        Ok(OutputActivityDiagnostics {
            output_chunks: state.sequence.saturating_sub(self.sequence),
            synchronized_frames: state
                .synchronized_frame_count
                .saturating_sub(self.synchronized_frame_count),
            composer_renders: state
                .composer_render_count
                .saturating_sub(self.composer_render_count),
            completed_composer_frames: state
                .completed_composer_frame_count
                .saturating_sub(self.completed_composer_frame_count),
            composer_surface_frames: state
                .composer_surface_render_count
                .saturating_sub(self.composer_surface_render_count),
            composer_cursor_moved: self
                .completed_composer_frame_cursor_position
                .zip(state.completed_composer_frame_cursor_position)
                .is_some_and(|(before, after)| before != after),
        })
    }

    pub fn wait_for_settlement(
        &self,
        quiet_window: Duration,
        timeout: Duration,
    ) -> Result<OutputSettlementReceipt, OutputSettlementFailure> {
        self.wait_for_settlement_inner(quiet_window, timeout, false)
    }

    /// Waits for quiet or a newer synchronized frame when output activity was
    /// already observed between an earlier transport baseline and this
    /// snapshot. This keeps the evidence byte-free while allowing a caller to
    /// move its settlement baseline past a completed input flush without
    /// missing a render that raced the flush receipt.
    pub fn wait_for_settlement_after_observed_activity(
        &self,
        quiet_window: Duration,
        timeout: Duration,
    ) -> Result<OutputSettlementReceipt, OutputSettlementFailure> {
        self.wait_for_settlement_inner(quiet_window, timeout, true)
    }

    /// Waits for a post-baseline composer render. A completed synchronized
    /// frame whose final visible cursor moved supplies byte-free causal
    /// evidence even when animation keeps drawing. A multiline composer can
    /// grow upward while leaving that final cursor unchanged, so a completed
    /// frame that explicitly rewrites the final cursor row starts a structural
    /// stability window. Repeated redraws at that same cursor position do not
    /// restart the window; an actual surface-position change does. This keeps
    /// a responsive TUI from failing solely because it redraws the same
    /// composer while preserving time for outstanding terminal-protocol
    /// replies. Other TUIs retain the show-cursor plus global-quiescence
    /// fallback. Callers own readiness and delivery policy.
    pub fn wait_for_composer_render_settlement(
        &self,
        quiet_window: Duration,
        timeout: Duration,
    ) -> Result<OutputSettlementReceipt, OutputSettlementFailure> {
        self.wait_for_composer_render_settlement_inner(quiet_window, timeout, false)
    }

    /// ConPTY may consume synchronized-output boundaries and emit a normalized
    /// hide/repaint/show screen diff afterward. This variant accepts either a
    /// stable structural composer surface or post-baseline output quiescence;
    /// a synchronized boundary alone is never sufficient.
    pub fn wait_for_normalized_composer_render_settlement(
        &self,
        quiet_window: Duration,
        timeout: Duration,
    ) -> Result<OutputSettlementReceipt, OutputSettlementFailure> {
        self.wait_for_composer_render_settlement_inner(quiet_window, timeout, true)
    }

    fn wait_for_composer_render_settlement_inner(
        &self,
        quiet_window: Duration,
        timeout: Duration,
        allow_unmarked_output_quiescence: bool,
    ) -> Result<OutputSettlementReceipt, OutputSettlementFailure> {
        if quiet_window.is_zero() || timeout < quiet_window {
            return Err(OutputSettlementFailure::InvalidWindow);
        }
        let deadline = termloop_platform::MonotonicDeadline::after(timeout)
            .map_err(|_| OutputSettlementFailure::InvalidWindow)?;
        let (state, changed) = &*self.tracker.inner;
        let mut state = state
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
        let mut composer_surface_stability: Option<(
            CursorPosition,
            u64,
            termloop_platform::MonotonicDeadline,
        )> = None;
        loop {
            if state.closed {
                return Err(OutputSettlementFailure::TerminalClosed);
            }
            if state.completed_composer_frame_sequence > self.completed_composer_frame_sequence
                && self
                    .completed_composer_frame_cursor_position
                    .zip(state.completed_composer_frame_cursor_position)
                    .is_some_and(|(before, after)| before != after)
            {
                return Ok(OutputSettlementReceipt {
                    runtime_epoch: self.runtime_epoch,
                    baseline_sequence: self.sequence,
                    settled_sequence: state.sequence,
                    evidence: OutputSettlementEvidence::ComposerCursorMovement,
                });
            }
            if state.composer_surface_render_sequence > self.composer_surface_render_sequence {
                let surface_sequence = state.composer_surface_render_sequence;
                let surface_cursor = state
                    .composer_surface_render_cursor_position
                    .expect("composer surface render has a final cursor position");
                match composer_surface_stability.as_mut() {
                    Some((candidate_cursor, observed_sequence, candidate_deadline))
                        if *observed_sequence != surface_sequence
                            && *candidate_cursor != surface_cursor =>
                    {
                        *candidate_cursor = surface_cursor;
                        *observed_sequence = surface_sequence;
                        *candidate_deadline =
                            termloop_platform::MonotonicDeadline::after(quiet_window)
                                .map_err(|_| OutputSettlementFailure::InvalidWindow)?;
                    }
                    Some((_, observed_sequence, _)) => {
                        *observed_sequence = surface_sequence;
                    }
                    None => {
                        composer_surface_stability = Some((
                            surface_cursor,
                            surface_sequence,
                            termloop_platform::MonotonicDeadline::after(quiet_window)
                                .map_err(|_| OutputSettlementFailure::InvalidWindow)?,
                        ));
                    }
                }
                let candidate_remaining = composer_surface_stability
                    .as_ref()
                    .and_then(|(_, _, deadline)| deadline.remaining());
                let Some(candidate_remaining) = candidate_remaining else {
                    return Ok(OutputSettlementReceipt {
                        runtime_epoch: self.runtime_epoch,
                        baseline_sequence: self.sequence,
                        settled_sequence: state.sequence,
                        evidence: OutputSettlementEvidence::ComposerSurfaceStability,
                    });
                };
                let remaining = deadline
                    .remaining()
                    .ok_or(OutputSettlementFailure::TimedOut)?;
                let (next, _) = changed
                    .wait_timeout(state, candidate_remaining.min(remaining))
                    .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
                state = next;
                continue;
            }
            if state.composer_render_sequence <= self.composer_render_sequence
                && (!allow_unmarked_output_quiescence || state.sequence <= self.sequence)
            {
                let remaining = deadline
                    .remaining()
                    .ok_or(OutputSettlementFailure::TimedOut)?;
                let (next, wait) = changed
                    .wait_timeout(state, remaining)
                    .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
                state = next;
                if wait.timed_out()
                    && state.composer_render_sequence <= self.composer_render_sequence
                {
                    return Err(OutputSettlementFailure::TimedOut);
                }
                continue;
            }

            if allow_unmarked_output_quiescence
                && state.composer_render_sequence <= self.composer_render_sequence
            {
                let settled_sequence = state.sequence;
                let remaining = deadline
                    .remaining()
                    .ok_or(OutputSettlementFailure::TimedOut)?;
                let wait_for = quiet_window.min(remaining);
                let (next, wait) = changed
                    .wait_timeout(state, wait_for)
                    .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
                state = next;
                if state.closed {
                    return Err(OutputSettlementFailure::TerminalClosed);
                }
                if state.sequence == settled_sequence && wait.timed_out() {
                    if wait_for < quiet_window {
                        return Err(OutputSettlementFailure::TimedOut);
                    }
                    return Ok(OutputSettlementReceipt {
                        runtime_epoch: self.runtime_epoch,
                        baseline_sequence: self.sequence,
                        settled_sequence,
                        evidence: OutputSettlementEvidence::Quiescence,
                    });
                }
                continue;
            }

            let settled_sequence = state.sequence;
            let remaining = deadline
                .remaining()
                .ok_or(OutputSettlementFailure::TimedOut)?;
            let wait_for = quiet_window.min(remaining);
            let (next, wait) = changed
                .wait_timeout(state, wait_for)
                .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
            state = next;
            if state.closed {
                return Err(OutputSettlementFailure::TerminalClosed);
            }
            if state.sequence == settled_sequence && wait.timed_out() {
                if wait_for < quiet_window {
                    return Err(OutputSettlementFailure::TimedOut);
                }
                return Ok(OutputSettlementReceipt {
                    runtime_epoch: self.runtime_epoch,
                    baseline_sequence: self.sequence,
                    settled_sequence,
                    evidence: OutputSettlementEvidence::ComposerRenderQuiescence,
                });
            }
        }
    }

    fn wait_for_settlement_inner(
        &self,
        quiet_window: Duration,
        timeout: Duration,
        mut activity_observed: bool,
    ) -> Result<OutputSettlementReceipt, OutputSettlementFailure> {
        if quiet_window.is_zero() || timeout < quiet_window {
            return Err(OutputSettlementFailure::InvalidWindow);
        }
        let deadline = termloop_platform::MonotonicDeadline::after(timeout)
            .map_err(|_| OutputSettlementFailure::InvalidWindow)?;
        let (state, changed) = &*self.tracker.inner;
        let mut state = state
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;

        loop {
            if state.closed {
                return Err(OutputSettlementFailure::TerminalClosed);
            }
            if state.synchronized_frame_sequence > self.synchronized_frame_sequence {
                return Ok(OutputSettlementReceipt {
                    runtime_epoch: self.runtime_epoch,
                    baseline_sequence: self.sequence,
                    settled_sequence: state.sequence,
                    evidence: OutputSettlementEvidence::SynchronizedFrame,
                });
            }
            if state.sequence <= self.sequence && !activity_observed {
                let remaining = deadline
                    .remaining()
                    .ok_or(OutputSettlementFailure::TimedOut)?;
                let (next, wait) = changed
                    .wait_timeout(state, remaining)
                    .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
                state = next;
                if wait.timed_out() && state.sequence <= self.sequence {
                    return Err(OutputSettlementFailure::TimedOut);
                }
                continue;
            }

            activity_observed = true;
            let settled_sequence = state.sequence;
            let remaining = deadline
                .remaining()
                .ok_or(OutputSettlementFailure::TimedOut)?;
            let wait_for = quiet_window.min(remaining);
            let (next, wait) = changed
                .wait_timeout(state, wait_for)
                .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
            state = next;
            if state.closed {
                return Err(OutputSettlementFailure::TerminalClosed);
            }
            if state.sequence == settled_sequence && wait.timed_out() {
                if wait_for < quiet_window {
                    return Err(OutputSettlementFailure::TimedOut);
                }
                return Ok(OutputSettlementReceipt {
                    runtime_epoch: self.runtime_epoch,
                    baseline_sequence: self.sequence,
                    settled_sequence,
                    evidence: OutputSettlementEvidence::Quiescence,
                });
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputSettlementReceipt {
    pub runtime_epoch: u64,
    pub baseline_sequence: u64,
    pub settled_sequence: u64,
    pub evidence: OutputSettlementEvidence,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutputActivityDiagnostics {
    pub output_chunks: u64,
    pub synchronized_frames: u64,
    pub composer_renders: u64,
    pub completed_composer_frames: u64,
    pub composer_surface_frames: u64,
    pub composer_cursor_moved: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputSettlementEvidence {
    Quiescence,
    SynchronizedFrame,
    ComposerRenderQuiescence,
    ComposerCursorMovement,
    ComposerSurfaceStability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OutputSettlementFailure {
    #[error("terminal output did not settle before the deadline")]
    TimedOut,
    #[error("terminal closed while output settlement was pending")]
    TerminalClosed,
    #[error("terminal output activity tracker is unavailable")]
    TrackerUnavailable,
    #[error("terminal output settlement window is invalid")]
    InvalidWindow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structural_diagnostics_are_bounded_deltas_without_terminal_bytes() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"\x1b[?2026hidle\x1b[?25h\x1b[36;3H\x1b[?2026l");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();

        tracker.record(b"\x1b[?2026h\x1b[37;1H\x1b[Kcomposer\x1b[?25h\x1b[37;4H\x1b[?2026l");

        assert_eq!(
            snapshot.diagnostics_since().unwrap(),
            OutputActivityDiagnostics {
                output_chunks: 1,
                synchronized_frames: 1,
                composer_renders: 1,
                completed_composer_frames: 1,
                composer_surface_frames: 1,
                composer_cursor_moved: true,
            }
        );
    }

    #[test]
    fn structural_diagnostics_accept_cursor_position_before_show_cursor() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"\x1b[?2026hidle\x1b[36;3H\x1b[?25h\x1b[?2026l");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();

        tracker.record(b"\x1b[?2026h\x1b[37;1H\x1b[Kcomposer\x1b[37;4H\x1b[?25h\x1b[?2026l");

        assert_eq!(
            snapshot.diagnostics_since().unwrap(),
            OutputActivityDiagnostics {
                output_chunks: 1,
                synchronized_frames: 1,
                composer_renders: 1,
                completed_composer_frames: 1,
                composer_surface_frames: 1,
                composer_cursor_moved: true,
            }
        );
    }

    #[test]
    fn settlement_requires_post_baseline_output_then_quiescence() {
        let tracker = OutputActivityTracker::default();
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            producer.record(b"first frame");
            std::thread::sleep(Duration::from_millis(10));
            producer.record(b"second frame");
        });

        let receipt = snapshot
            .wait_for_settlement(Duration::from_millis(20), Duration::from_secs(1))
            .unwrap();

        assert_eq!(receipt.runtime_epoch, 7);
        assert_eq!(receipt.baseline_sequence, 0);
        assert_eq!(receipt.settled_sequence, 2);
        assert_eq!(receipt.evidence, OutputSettlementEvidence::Quiescence);
    }

    #[test]
    fn synchronized_output_end_settles_without_a_quiet_window() {
        let tracker = OutputActivityTracker::default();
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            producer.record(b"\x1b[?2026hframe\x1b[?20");
            producer.record(b"26l");
        });

        let receipt = snapshot
            .wait_for_settlement(Duration::from_secs(1), Duration::from_secs(2))
            .unwrap();

        assert_eq!(
            receipt.evidence,
            OutputSettlementEvidence::SynchronizedFrame
        );
        assert_eq!(receipt.settled_sequence, 2);
    }

    #[test]
    fn activity_observed_before_the_flush_snapshot_can_settle_on_quiet() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"paste render");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();

        let receipt = snapshot
            .wait_for_settlement_after_observed_activity(
                Duration::from_millis(10),
                Duration::from_millis(30),
            )
            .unwrap();

        assert_eq!(receipt.baseline_sequence, 1);
        assert_eq!(receipt.settled_sequence, 1);
        assert_eq!(receipt.evidence, OutputSettlementEvidence::Quiescence);
    }

    #[test]
    fn synchronized_frame_before_the_flush_snapshot_does_not_release_settlement() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"\x1b[?2026hold frame\x1b[?2026l");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            producer.record(b"\x1b[?2026hpost-flush frame\x1b[?2026l");
        });

        let receipt = snapshot
            .wait_for_settlement_after_observed_activity(
                Duration::from_millis(100),
                Duration::from_secs(1),
            )
            .unwrap();

        assert_eq!(receipt.baseline_sequence, 1);
        assert_eq!(receipt.settled_sequence, 2);
        assert_eq!(
            receipt.evidence,
            OutputSettlementEvidence::SynchronizedFrame
        );
    }

    #[test]
    fn synchronized_frame_does_not_release_composer_render_settlement() {
        let tracker = OutputActivityTracker::default();
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            producer.record(b"\x1b[?2026hpartial paste frame\x1b[?2026l");
        });

        assert_eq!(
            snapshot.wait_for_composer_render_settlement(
                Duration::from_millis(10),
                Duration::from_millis(30),
            ),
            Err(OutputSettlementFailure::TimedOut)
        );
    }

    #[test]
    fn composer_render_marker_then_quiescence_releases_settlement() {
        let tracker = OutputActivityTracker::default();
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            producer.record(b"paste preview\x1b[?25h");
            std::thread::sleep(Duration::from_millis(8));
            producer.record(b"final redraw");
        });

        let receipt = snapshot
            .wait_for_composer_render_settlement(
                Duration::from_millis(15),
                Duration::from_millis(100),
            )
            .unwrap();

        assert_eq!(receipt.baseline_sequence, 0);
        assert_eq!(receipt.settled_sequence, 2);
        assert_eq!(
            receipt.evidence,
            OutputSettlementEvidence::ComposerRenderQuiescence
        );
    }

    #[test]
    fn composer_render_marker_can_span_output_chunks() {
        let tracker = OutputActivityTracker::default();
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            producer.record(b"paste preview\x1b[?2");
            producer.record(b"5h");
        });

        assert_eq!(
            snapshot
                .wait_for_composer_render_settlement(
                    Duration::from_millis(10),
                    Duration::from_millis(100),
                )
                .unwrap()
                .evidence,
            OutputSettlementEvidence::ComposerRenderQuiescence
        );
    }

    #[test]
    fn normalized_screen_diff_ignores_early_sync_boundary_then_settles_on_quiet() {
        let tracker = OutputActivityTracker {
            accepts_normalized_screen_diff: true,
            ..OutputActivityTracker::default()
        };
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        let producer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            producer.record(b"\x1b[?2026h\x1b[?2026l");
            std::thread::sleep(Duration::from_millis(5));
            producer.record(b"normalized paste preview");
        });
        producer.join().unwrap();

        let receipt = snapshot
            .wait_for_normalized_composer_render_settlement(
                Duration::from_millis(20),
                Duration::from_secs(1),
            )
            .unwrap();

        assert_eq!(receipt.settled_sequence, 2);
        assert_eq!(receipt.evidence, OutputSettlementEvidence::Quiescence);
    }

    #[test]
    fn normalized_composer_surface_settles_during_periodic_redraws() {
        let tracker = OutputActivityTracker {
            accepts_normalized_screen_diff: true,
            ..OutputActivityTracker::default()
        };
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(5));
                producer.record(
                    b"\x1b[?2026h\x1b[?2026l\x1b[?25l\x1b[7;1Hanimation\
                      \x1b[20;1H\x1b[K>\x1b[1C\x1b[?25h",
                );
            }
        });

        let receipt = snapshot
            .wait_for_normalized_composer_render_settlement(
                Duration::from_millis(20),
                Duration::from_millis(200),
            )
            .unwrap();

        assert_eq!(
            receipt.evidence,
            OutputSettlementEvidence::ComposerSurfaceStability
        );
    }

    #[test]
    fn composer_cursor_movement_settles_while_synchronized_redraws_continue() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"\x1b[?2026hidle\x1b[?25h\x1b[36;3H\x1b[?2026l");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            for _ in 0..4 {
                std::thread::sleep(Duration::from_millis(3));
                producer.record(b"\x1b[?2026hanimation\x1b[?25h\x1b[36;3H\x1b[?2026l");
            }
            producer.record(b"\x1b[?2026hpasted composer\x1b[?25h\x1b[36;");
            producer.record(b"19H\x1b[?2026l");
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(3));
                producer.record(b"\x1b[?2026hanimation\x1b[?25h\x1b[36;19H\x1b[?2026l");
            }
        });

        let receipt = snapshot
            .wait_for_composer_render_settlement(
                Duration::from_millis(30),
                Duration::from_millis(100),
            )
            .unwrap();

        assert_eq!(
            receipt.evidence,
            OutputSettlementEvidence::ComposerCursorMovement
        );
    }

    #[test]
    fn multiline_composer_surface_settles_while_status_redraws_continue() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"\x1b[?2026hidle\x1b[?25h\x1b[36;3H\x1b[?2026l");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            for _ in 0..4 {
                std::thread::sleep(Duration::from_millis(3));
                producer
                    .record(b"\x1b[?2026h\x1b[7;1H\x1b[Kanimation\x1b[?25h\x1b[36;3H\x1b[?2026l");
            }
            producer
                .record(b"\x1b[?2026h\x1b[34;1H\x1b[Kcomposer top\x1b[35;1H\x1b[Kcomposer body");
            producer.record(b"\x1b[36;1H\x1b[K>\x1b[?25h\x1b[36;3H\x1b[?2026l");
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(3));
                producer
                    .record(b"\x1b[?2026h\x1b[7;1H\x1b[Kanimation\x1b[?25h\x1b[36;3H\x1b[?2026l");
            }
        });

        let receipt = snapshot
            .wait_for_composer_render_settlement(
                Duration::from_millis(20),
                Duration::from_millis(120),
            )
            .unwrap();

        assert_eq!(
            receipt.evidence,
            OutputSettlementEvidence::ComposerSurfaceStability
        );
    }

    #[test]
    fn repeated_same_position_composer_surface_redraws_cannot_withhold_submit() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"\x1b[?2026h\x1b[36;1H\x1b[K>\x1b[?25h\x1b[36;3H\x1b[?2026l");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(3));
                producer
                    .record(b"\x1b[?2026h\x1b[36;1H\x1b[K> pasted\x1b[?25h\x1b[36;3H\x1b[?2026l");
            }
        });

        let receipt = snapshot
            .wait_for_composer_render_settlement(
                Duration::from_millis(20),
                Duration::from_millis(50),
            )
            .unwrap();

        assert_eq!(
            receipt.evidence,
            OutputSettlementEvidence::ComposerSurfaceStability
        );
    }

    #[test]
    fn unchanged_periodic_composer_frames_do_not_falsely_settle() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"\x1b[?2026hidle\x1b[?25h\x1b[36;3H\x1b[?2026l");
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(3));
                producer
                    .record(b"\x1b[?2026h\x1b[7;1H\x1b[Kanimation\x1b[?25h\x1b[36;3H\x1b[?2026l");
            }
        });

        assert_eq!(
            snapshot.wait_for_composer_render_settlement(
                Duration::from_millis(20),
                Duration::from_millis(50),
            ),
            Err(OutputSettlementFailure::TimedOut)
        );
    }

    #[test]
    fn input_write_barrier_places_concurrent_render_after_the_receipt_snapshot() {
        let tracker = OutputActivityTracker::default();
        tracker.record(b"startup\x1b[?25h");
        let concurrent = tracker.clone();
        let (recorded, observed) = std::sync::mpsc::sync_channel(1);

        let (_, snapshot) = tracker
            .capture_after_input_write("session".into(), 7, || {
                std::thread::spawn(move || {
                    concurrent.record(b"paste-render\x1b[?25h");
                    let _ = recorded.send(());
                });
                assert!(matches!(
                    observed.recv_timeout(Duration::from_millis(20)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ));
            })
            .unwrap();

        observed.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            snapshot
                .wait_for_composer_render_settlement(
                    Duration::from_millis(10),
                    Duration::from_secs(1),
                )
                .unwrap()
                .evidence,
            OutputSettlementEvidence::ComposerRenderQuiescence
        );
    }

    #[test]
    fn settlement_times_out_without_new_output() {
        let snapshot = OutputActivityTracker::default()
            .snapshot("session".into(), 7)
            .unwrap();

        assert_eq!(
            snapshot.wait_for_settlement(Duration::from_millis(10), Duration::from_millis(20)),
            Err(OutputSettlementFailure::TimedOut)
        );
    }

    #[test]
    fn the_same_snapshot_can_settle_on_a_bounded_retry() {
        let tracker = OutputActivityTracker::default();
        let snapshot = tracker.snapshot("session".into(), 7).unwrap();
        assert_eq!(
            snapshot.wait_for_settlement(Duration::from_millis(10), Duration::from_millis(20)),
            Err(OutputSettlementFailure::TimedOut)
        );

        tracker.record(b"\x1b[?2026hframe\x1b[?2026l");
        assert_eq!(
            snapshot
                .wait_for_settlement(Duration::from_millis(10), Duration::from_millis(20))
                .unwrap()
                .evidence,
            OutputSettlementEvidence::SynchronizedFrame
        );
    }
}
