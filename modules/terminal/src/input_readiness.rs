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
    synchronized_frame_open: bool,
    synchronized_frame_had_show_cursor: bool,
    synchronized_frame_cursor_position: Option<CursorPosition>,
    synchronized_frame_cursor_after_show: Option<CursorPosition>,
    synchronized_frame_last_right_angle_prompt_position: Option<CursorPosition>,
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
            .zip(state.synchronized_frame_cursor_after_show)
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

#[derive(Clone, Default)]
pub(crate) struct InputReadinessTracker {
    inner: Arc<(Mutex<InputReadinessState>, Condvar)>,
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
                        if state.synchronized_frame_had_show_cursor {
                            state.synchronized_frame_cursor_after_show = Some(position);
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
                    state.synchronized_frame_cursor_after_show = None;
                    state.synchronized_frame_last_right_angle_prompt_position = None;
                }
                if record_marker(byte, SHOW_CURSOR, &mut state.show_cursor_match)
                    && state.synchronized_frame_open
                {
                    state.synchronized_frame_had_show_cursor = true;
                    state.synchronized_frame_cursor_after_show = None;
                }
                if record_marker(
                    byte,
                    RIGHT_ANGLE_PROMPT,
                    &mut state.right_angle_prompt_match,
                ) && state.synchronized_frame_open
                {
                    state.synchronized_frame_last_right_angle_prompt_position =
                        state.synchronized_frame_cursor_position;
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
                        .synchronized_frame_cursor_after_show
                        .or(state.synchronized_frame_cursor_position);
                    state.synchronized_frame_open = false;
                    state.synchronized_frame_had_show_cursor = false;
                    state.synchronized_frame_cursor_position = None;
                    state.synchronized_frame_cursor_after_show = None;
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
