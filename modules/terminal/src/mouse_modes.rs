//! Byte-free mouse protocol state survives eviction of the startup escape sequences.
//! A late renderer must use the same wheel encoding as the running terminal program.

#[derive(Default)]
pub(crate) struct MouseModeTracker {
    parser: vte::Parser,
    modes: MouseModes,
}

#[derive(Default)]
struct MouseModes(u32);

impl MouseModeTracker {
    pub(crate) fn record(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.modes, bytes);
    }

    // Low byte: none, X10, normal, button, any. Bit 8: SGR encoding.
    pub(crate) fn snapshot(&self) -> u32 {
        self.modes.0
    }
}

impl vte::Perform for MouseModes {
    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        action: char,
    ) {
        if ignore || intermediates != b"?" || !matches!(action, 'h' | 'l') {
            return;
        }
        for param in params {
            let [mode] = param else { continue };
            let tracking = match mode {
                9 => Some(1),
                1000 => Some(2),
                1002 => Some(3),
                1003 => Some(4),
                _ => None,
            };
            if let Some(tracking) = tracking {
                self.0 = (self.0 & 0x100) | if action == 'h' { tracking } else { 0 };
            } else if *mode == 1006 {
                self.0 = (self.0 & 0xff) | if action == 'h' { 0x100 } else { 0 };
            }
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
        if !ignore && intermediates.is_empty() && byte == b'c' {
            self.0 = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_split_combined_modes_and_explicit_disable() {
        let mut tracker = MouseModeTracker::default();
        tracker.record(b"\x1b[?100");
        tracker.record(b"0;1002;1006;1003h");
        assert_eq!(tracker.snapshot(), 0x104);
        tracker.record(b"\x1b[?1003l");
        assert_eq!(tracker.snapshot(), 0x100);
        tracker.record(b"\x1b[?1006l\x1b[?9h");
        assert_eq!(tracker.snapshot(), 1);
        tracker.record(b"\x1bc");
        assert_eq!(tracker.snapshot(), 0);
    }

    #[test]
    fn ignores_control_strings_and_ordinary_output() {
        let mut tracker = MouseModeTracker::default();
        tracker.record(b"\x1b]0;?1003h\x07plain text\x1b[1003h");
        assert_eq!(tracker.snapshot(), 0);
    }
}
