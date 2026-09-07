use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::OutputSettlementFailure;
use crate::output_settlement::{CursorPosition, TerminalStructure, TerminalStructureParser};

const BRACKETED_PASTE_ENABLE: &[u8] = b"\x1b[?2004h";
const BRACKETED_PASTE_DISABLE: &[u8] = b"\x1b[?2004l";
const ALTERNATE_SCREEN_ENABLE: &[u8] = b"\x1b[?1049h";
const ALTERNATE_SCREEN_DISABLE: &[u8] = b"\x1b[?1049l";
const SYNCHRONIZED_OUTPUT_BEGIN: &[u8] = b"\x1b[?2026h";
const SYNCHRONIZED_OUTPUT_END: &[u8] = b"\x1b[?2026l";
const SHOW_CURSOR: &[u8] = b"\x1b[?25h";
const RIGHT_ANGLE_PROMPT: &[u8] = "›".as_bytes();

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
struct InputReadinessState {
    sequence: u64,
    structural_sequence: u64,
    bracketed_paste_enabled: bool,
    alternate_screen_active: bool,
    composer_prompt_seen_in_current_alternate_screen: bool,
    composer_prompt_render_count: u64,
    composer_prompt_seen_after_bracketed_paste: bool,
    composer_prompt_ready_count: u64,
    bracketed_paste_enable_match: usize,
    bracketed_paste_disable_match: usize,
    alternate_screen_enable_match: usize,
    alternate_screen_disable_match: usize,
    synchronized_output_begin_match: usize,
    synchronized_output_end_match: usize,
    show_cursor_match: usize,
    right_angle_prompt_match: usize,
    show_cursor_count: u64,
    right_angle_prompt_count: u64,
    synchronized_frame_open: bool,
    synchronized_frame_had_show_cursor: bool,
    synchronized_frame_cursor_position: Option<CursorPosition>,
    synchronized_frame_cursor_position_observed: bool,
    synchronized_frame_visible_cursor_position: Option<CursorPosition>,
    synchronized_frame_last_right_angle_prompt_position: Option<CursorPosition>,
    visible_right_angle_prompt_position: Option<CursorPosition>,
    completed_frame_cursor_position: Option<CursorPosition>,
    terminal_structure_parser: TerminalStructureParser,
    closed: bool,
}

/// Byte-free terminal facts used by Core to decide whether an input surface is
/// ready. Terminal intentionally does not attach provider identity or delivery
/// policy to these facts and never retains the bytes that produced them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputReadinessFacts {
    pub sequence: u64,
    pub bracketed_paste_enabled: bool,
    pub alternate_screen_active: bool,
    pub composer_prompt_seen_in_current_alternate_screen: bool,
    pub composer_prompt_render_count: u64,
    pub composer_prompt_seen_after_bracketed_paste: bool,
    pub composer_prompt_ready_count: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputReadinessDiagnostics {
    pub accepts_normalized_screen_diff: bool,
    pub synchronized_frame_open: bool,
    pub show_cursor_count: u64,
    pub right_angle_prompt_count: u64,
    pub visible_prompt_position: Option<(u16, u16)>,
    pub cursor_position: (u16, u16),
}

impl InputReadinessFacts {
    fn from_state(state: &InputReadinessState) -> Self {
        Self {
            sequence: state.sequence,
            bracketed_paste_enabled: state.bracketed_paste_enabled,
            alternate_screen_active: state.alternate_screen_active,
            composer_prompt_seen_in_current_alternate_screen: state
                .composer_prompt_seen_in_current_alternate_screen,
            composer_prompt_render_count: state.composer_prompt_render_count,
            composer_prompt_seen_after_bracketed_paste: state
                .composer_prompt_seen_after_bracketed_paste,
            composer_prompt_ready_count: state.composer_prompt_ready_count,
        }
    }
}

fn completed_frame_has_composer_prompt(state: &InputReadinessState) -> bool {
    state.synchronized_frame_open
        && state.synchronized_frame_had_show_cursor
        && state
            .synchronized_frame_last_right_angle_prompt_position
            .zip(state.synchronized_frame_visible_cursor_position)
            .is_some_and(|(prompt, cursor)| {
                prompt.row == cursor.row && cursor.column > prompt.column
            })
}

fn record_completed_composer_prompt(state: &mut InputReadinessState) {
    state.composer_prompt_render_count = state.composer_prompt_render_count.saturating_add(1);
    if state.alternate_screen_active {
        state.composer_prompt_seen_in_current_alternate_screen = true;
    }
    if state.bracketed_paste_enabled {
        state.composer_prompt_seen_after_bracketed_paste = true;
        state.composer_prompt_ready_count = state.composer_prompt_ready_count.saturating_add(1);
    }
    state.structural_sequence = state.structural_sequence.saturating_add(1);
}

#[derive(Clone)]
pub(crate) struct InputReadinessTracker {
    inner: Arc<(Mutex<InputReadinessState>, Condvar)>,
    accepts_normalized_screen_diff: bool,
}

impl Default for InputReadinessTracker {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            accepts_normalized_screen_diff: !termloop_platform::host_uses_bracketed_paste_framing(),
        }
    }
}

impl InputReadinessTracker {
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
                    _ => {}
                }

                if record_marker(
                    byte,
                    ALTERNATE_SCREEN_ENABLE,
                    &mut state.alternate_screen_enable_match,
                ) {
                    state.alternate_screen_active = true;
                    state.composer_prompt_seen_in_current_alternate_screen = false;
                    state.composer_prompt_seen_after_bracketed_paste = false;
                    state.structural_sequence = state.structural_sequence.saturating_add(1);
                }
                if record_marker(
                    byte,
                    ALTERNATE_SCREEN_DISABLE,
                    &mut state.alternate_screen_disable_match,
                ) {
                    state.alternate_screen_active = false;
                    state.composer_prompt_seen_in_current_alternate_screen = false;
                    state.composer_prompt_seen_after_bracketed_paste = false;
                    state.structural_sequence = state.structural_sequence.saturating_add(1);
                }
                if record_marker(
                    byte,
                    BRACKETED_PASTE_ENABLE,
                    &mut state.bracketed_paste_enable_match,
                ) {
                    let newly_enabled = !state.bracketed_paste_enabled;
                    state.bracketed_paste_enabled = true;
                    if newly_enabled && state.composer_prompt_seen_in_current_alternate_screen {
                        state.composer_prompt_seen_after_bracketed_paste = true;
                        state.composer_prompt_ready_count =
                            state.composer_prompt_ready_count.saturating_add(1);
                    }
                    state.structural_sequence = state.structural_sequence.saturating_add(1);
                }
                if record_marker(
                    byte,
                    BRACKETED_PASTE_DISABLE,
                    &mut state.bracketed_paste_disable_match,
                ) {
                    state.bracketed_paste_enabled = false;
                    state.composer_prompt_seen_after_bracketed_paste = false;
                    state.structural_sequence = state.structural_sequence.saturating_add(1);
                }

                if record_marker(
                    byte,
                    SYNCHRONIZED_OUTPUT_BEGIN,
                    &mut state.synchronized_output_begin_match,
                ) {
                    state.synchronized_frame_open = true;
                    state.synchronized_frame_had_show_cursor = false;
                    state.synchronized_frame_cursor_position =
                        state.completed_frame_cursor_position;
                    state.synchronized_frame_cursor_position_observed = false;
                    state.synchronized_frame_visible_cursor_position = None;
                    state.synchronized_frame_last_right_angle_prompt_position = None;
                }
                let showed_cursor = record_marker(byte, SHOW_CURSOR, &mut state.show_cursor_match);
                if showed_cursor {
                    state.show_cursor_count = state.show_cursor_count.saturating_add(1);
                }
                if showed_cursor && state.synchronized_frame_open {
                    state.synchronized_frame_had_show_cursor = true;
                    // Codex may position the composer cursor immediately before
                    // or after making it visible. Accept either order only when
                    // that position was observed in this exact frame; the prior
                    // frame's remembered cursor is not readiness evidence.
                    state.synchronized_frame_visible_cursor_position =
                        if state.synchronized_frame_cursor_position_observed {
                            state.synchronized_frame_cursor_position
                        } else {
                            None
                        };
                }
                if record_marker(
                    byte,
                    RIGHT_ANGLE_PROMPT,
                    &mut state.right_angle_prompt_match,
                ) {
                    state.right_angle_prompt_count =
                        state.right_angle_prompt_count.saturating_add(1);
                    let prompt_position = state.terminal_structure_parser.cursor_position();
                    state.visible_right_angle_prompt_position = Some(prompt_position);
                    if state.synchronized_frame_open {
                        state.synchronized_frame_last_right_angle_prompt_position =
                            Some(prompt_position);
                    }
                }
                // ConPTY consumes synchronized-output framing and emits the
                // resulting screen diff after the frame has closed. Preserve
                // the same byte-free prompt-at-visible-cursor proof from that
                // normalized stream without weakening the framed Unix path.
                if showed_cursor
                    && self.accepts_normalized_screen_diff
                    && !state.synchronized_frame_open
                    && state.alternate_screen_active
                    && state
                        .visible_right_angle_prompt_position
                        .is_some_and(|prompt| {
                            let cursor = state.terminal_structure_parser.cursor_position();
                            prompt.row == cursor.row && cursor.column > prompt.column
                        })
                {
                    record_completed_composer_prompt(&mut state);
                }
                if record_marker(
                    byte,
                    SYNCHRONIZED_OUTPUT_END,
                    &mut state.synchronized_output_end_match,
                ) {
                    if completed_frame_has_composer_prompt(&state) {
                        record_completed_composer_prompt(&mut state);
                    }
                    state.completed_frame_cursor_position = state
                        .synchronized_frame_visible_cursor_position
                        .or(state.synchronized_frame_cursor_position);
                    state.synchronized_frame_open = false;
                    state.synchronized_frame_had_show_cursor = false;
                    state.synchronized_frame_cursor_position = None;
                    state.synchronized_frame_cursor_position_observed = false;
                    state.synchronized_frame_visible_cursor_position = None;
                    state.synchronized_frame_last_right_angle_prompt_position = None;
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
    ) -> Result<InputReadinessSnapshot, OutputSettlementFailure> {
        let state = self
            .inner
            .0
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
        Ok(InputReadinessSnapshot {
            session_id,
            runtime_epoch,
            structural_sequence: state.structural_sequence,
            facts: InputReadinessFacts::from_state(&state),
            tracker: self.clone(),
        })
    }
}

#[derive(Clone)]
pub struct InputReadinessSnapshot {
    session_id: String,
    runtime_epoch: u64,
    structural_sequence: u64,
    facts: InputReadinessFacts,
    tracker: InputReadinessTracker,
}

impl std::fmt::Debug for InputReadinessSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InputReadinessSnapshot")
            .field("session_id", &self.session_id)
            .field("runtime_epoch", &self.runtime_epoch)
            .field("structural_sequence", &self.structural_sequence)
            .field("facts", &self.facts)
            .finish_non_exhaustive()
    }
}

impl InputReadinessSnapshot {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn runtime_epoch(&self) -> u64 {
        self.runtime_epoch
    }

    pub fn facts(&self) -> InputReadinessFacts {
        self.facts
    }

    pub fn current_facts(&self) -> Result<InputReadinessFacts, OutputSettlementFailure> {
        let state = self
            .tracker
            .inner
            .0
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
        if state.closed {
            return Err(OutputSettlementFailure::TerminalClosed);
        }
        Ok(InputReadinessFacts::from_state(&state))
    }

    pub fn diagnostics(&self) -> Result<InputReadinessDiagnostics, OutputSettlementFailure> {
        let state = self
            .tracker
            .inner
            .0
            .lock()
            .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
        let cursor = state.terminal_structure_parser.cursor_position();
        Ok(InputReadinessDiagnostics {
            accepts_normalized_screen_diff: self.tracker.accepts_normalized_screen_diff,
            synchronized_frame_open: state.synchronized_frame_open,
            show_cursor_count: state.show_cursor_count,
            right_angle_prompt_count: state.right_angle_prompt_count,
            visible_prompt_position: state
                .visible_right_angle_prompt_position
                .map(|position| (position.row, position.column)),
            cursor_position: (cursor.row, cursor.column),
        })
    }

    /// Waits for the next structural terminal fact and advances this snapshot.
    /// The caller owns the deadline and the provider-specific readiness rule.
    pub fn wait_for_change(
        &mut self,
        timeout: Duration,
    ) -> Result<InputReadinessFacts, OutputSettlementFailure> {
        if timeout.is_zero() {
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
            if state.structural_sequence > self.structural_sequence {
                self.structural_sequence = state.structural_sequence;
                self.facts = InputReadinessFacts::from_state(&state);
                return Ok(self.facts);
            }
            let remaining = deadline
                .remaining()
                .ok_or(OutputSettlementFailure::TimedOut)?;
            let (next, wait) = changed
                .wait_timeout(state, remaining)
                .map_err(|_| OutputSettlementFailure::TrackerUnavailable)?;
            state = next;
            if wait.timed_out() && state.structural_sequence <= self.structural_sequence {
                return Err(OutputSettlementFailure::TimedOut);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_prompt_frame(tracker: &InputReadinessTracker, prompt_row: u16, cursor_row: u16) {
        tracker.record(
            format!(
                "\x1b[?2026h\x1b[{prompt_row};1H\x1b[K\x1b[1m›\x1b[0m Ask Codex\
                 \x1b[?25h\x1b[{cursor_row};3H\x1b[?2026l"
            )
            .as_bytes(),
        );
    }

    #[test]
    fn codex_composer_prompt_requires_a_completed_frame_at_the_visible_cursor() {
        let tracker = InputReadinessTracker::default();
        tracker.record(b"shell ");
        tracker.record("› codex\r\n".as_bytes());
        tracker.record(ALTERNATE_SCREEN_ENABLE);
        tracker.record(BRACKETED_PASTE_ENABLE);
        record_prompt_frame(&tracker, 8, 36);
        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(
            !facts.composer_prompt_seen_in_current_alternate_screen,
            "a transcript prompt in the same frame is not the active composer"
        );
        assert!(!facts.composer_prompt_seen_after_bracketed_paste);
        assert_eq!(facts.composer_prompt_render_count, 0);

        record_prompt_frame(&tracker, 36, 36);
        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(facts.alternate_screen_active);
        assert!(facts.bracketed_paste_enabled);
        assert!(facts.composer_prompt_seen_in_current_alternate_screen);
        assert_eq!(facts.composer_prompt_render_count, 1);
        assert!(facts.composer_prompt_seen_after_bracketed_paste);
        assert_eq!(facts.composer_prompt_ready_count, 1);
    }

    #[test]
    fn codex_composer_accepts_cursor_position_before_show_cursor() {
        let tracker = InputReadinessTracker::default();
        tracker.record(BRACKETED_PASTE_ENABLE);

        tracker.record(
            "\x1b[?2026h\x1b[8;1H\x1b[K\x1b[1m›\x1b[22m prior prompt\
             \x1b[49;3H\x1b[?25h\x1b[?2026l"
                .as_bytes(),
        );
        assert!(
            !tracker
                .snapshot("session".into(), 7)
                .unwrap()
                .facts()
                .composer_prompt_seen_after_bracketed_paste,
            "a transcript prompt must not become ready from a visible cursor on another row"
        );

        tracker.record(
            "\x1b[?2026h\x1b[49;1H\x1b[K\x1b[1m›\x1b[22m Ask Codex to do anything\
             \x1b[49;3H\x1b[?25h\x1b[?2026l"
                .as_bytes(),
        );
        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(facts.composer_prompt_seen_after_bracketed_paste);
        assert_eq!(facts.composer_prompt_render_count, 1);
        assert_eq!(facts.composer_prompt_ready_count, 1);
    }

    #[test]
    fn leaving_the_alternate_screen_revokes_the_current_prompt_fact() {
        let tracker = InputReadinessTracker::default();
        tracker.record(ALTERNATE_SCREEN_ENABLE);
        tracker.record(BRACKETED_PASTE_ENABLE);
        record_prompt_frame(&tracker, 36, 36);
        tracker.record(ALTERNATE_SCREEN_DISABLE);

        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(!facts.alternate_screen_active);
        assert!(!facts.composer_prompt_seen_in_current_alternate_screen);
        assert!(!facts.composer_prompt_seen_after_bracketed_paste);
        assert_eq!(facts.composer_prompt_render_count, 1);
    }

    #[test]
    fn prompt_before_the_paste_handshake_is_ready_only_when_the_agent_owned_the_screen() {
        let tracker = InputReadinessTracker::default();
        tracker.record(ALTERNATE_SCREEN_ENABLE);
        record_prompt_frame(&tracker, 36, 36);
        tracker.record(BRACKETED_PASTE_ENABLE);

        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(facts.composer_prompt_seen_after_bracketed_paste);
        assert_eq!(facts.composer_prompt_ready_count, 1);
    }

    #[test]
    fn prompt_after_the_paste_handshake_does_not_require_alternate_screen() {
        let tracker = InputReadinessTracker::default();
        tracker.record(BRACKETED_PASTE_ENABLE);
        record_prompt_frame(&tracker, 36, 36);

        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(facts.composer_prompt_seen_after_bracketed_paste);
        assert_eq!(facts.composer_prompt_ready_count, 1);
    }

    #[test]
    fn conpty_screen_diff_preserves_prompt_at_visible_cursor_proof() {
        let tracker = InputReadinessTracker {
            accepts_normalized_screen_diff: true,
            ..InputReadinessTracker::default()
        };
        tracker.record(ALTERNATE_SCREEN_ENABLE);

        // ConPTY consumes synchronized-output framing and emits the resulting
        // screen diff afterward. A transcript prompt on another row must not
        // become composer readiness even though the cursor is shown.
        tracker.record(b"\x1b[?2026h\x1b[?2026l\x1b[H");
        for _ in 0..7 {
            tracker.record(b"\r\n");
        }
        tracker.record("› prior prompt".as_bytes());
        for _ in 0..12 {
            tracker.record(b"\r\n");
        }
        tracker.record(b"\r\x1b[2C\x1b[?25h");
        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(!facts.composer_prompt_seen_in_current_alternate_screen);

        // A later normalized repaint puts the prompt and final visible cursor
        // on the same row. No terminal bytes or screen grid are retained.
        tracker.record("\r› Ask Codex".as_bytes());
        tracker.record(b"\r\x1b[2C\x1b[?25h");
        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(facts.composer_prompt_seen_in_current_alternate_screen);
        assert_eq!(facts.composer_prompt_render_count, 1);
    }

    #[test]
    fn conpty_normalized_codex_fixture_output_marks_the_current_composer() {
        let tracker = InputReadinessTracker {
            accepts_normalized_screen_diff: true,
            ..InputReadinessTracker::default()
        };
        tracker.record(
            b"\x1b[?1049h\x1b[?2026h\x1b[?2026l\x1b[?2026h\x1b[?2026l\
              \x1b[?25l\x1b[H\x1b[K\r\n\x1b[K\r\n",
        );
        tracker.record("TERMLOOP_INITIAL_INPUT_READY\r\n\x1b[K\r\n\x1b[K\r\n".as_bytes());
        tracker.record(
            "\x1b[8;1H\x1b[K\x1b[1m›\x1b[22m prior prompt\x1b[K\
             \x1b[21;1H\x1b[?25h"
                .as_bytes(),
        );
        assert!(
            !tracker
                .snapshot("session".into(), 7)
                .unwrap()
                .facts()
                .composer_prompt_seen_in_current_alternate_screen
        );

        tracker.record(
            "\x1b[?2026h\x1b[?2026l\x1b[?25l\x1b[1m\x1b[20;1H›\
             \x1b[22m Ask Codex to do anything TERMLOOP_CODEX_COMPOSER_READY\x1b[K\
             \x1b[?25h"
                .as_bytes(),
        );
        let facts = tracker.snapshot("session".into(), 7).unwrap().facts();
        assert!(facts.composer_prompt_seen_in_current_alternate_screen);
        assert_eq!(facts.composer_prompt_render_count, 1);
    }

    #[test]
    fn wait_for_change_handles_a_split_marker_without_retaining_output() {
        let tracker = InputReadinessTracker::default();
        tracker.record(ALTERNATE_SCREEN_ENABLE);
        tracker.record(BRACKETED_PASTE_ENABLE);
        let mut snapshot = tracker.snapshot("session".into(), 7).unwrap();
        let producer = tracker.clone();
        std::thread::spawn(move || {
            producer.record(b"\x1b[?2026h\x1b[36;1H\x1b[K\x1b[1m\xe2\x80");
            producer.record(b"\xba\x1b[0m Ask Codex\x1b[?25h\x1b[36;3H\x1b[?2026l");
        });

        let facts = snapshot.wait_for_change(Duration::from_secs(1)).unwrap();
        assert!(facts.composer_prompt_seen_in_current_alternate_screen);
    }
}
