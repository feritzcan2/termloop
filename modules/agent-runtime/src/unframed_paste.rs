use std::time::Duration;

use termloop_terminal::{
    INPUT_SEQUENCE_GAP, MAX_INPUT_SEQUENCE_CHUNKS, PendingInputWrite, TerminalError,
    TerminalService,
};

// Without bracketed-paste framing a TUI can only infer a paste from read
// bursts. ConPTY hands one large write to the child in 2 KiB reads, and Claude
// Code takes the later read as a new paste that replaces the earlier one, so
// only the tail of a long generated message reaches the composer. Pieces of at
// most 1 KiB, separated by the writer's sequence gap, each arrive as one read
// and stay within 2 KiB even if two are read together.
const UNFRAMED_PASTE_PIECE_BYTES: usize = 1024;
const PIECE_RECEIPT_ALLOWANCE: Duration = Duration::from_millis(50);

/// Splits one generated paste for the host terminal. Framed pastes and short
/// unframed ones stay a single write.
pub(crate) fn paste_pieces(paste: &[u8]) -> Vec<Vec<u8>> {
    if termloop_platform::host_uses_bracketed_paste_framing() {
        return vec![paste.to_vec()];
    }
    unframed_pieces(paste)
}

fn unframed_pieces(paste: &[u8]) -> Vec<Vec<u8>> {
    if paste.len() <= UNFRAMED_PASTE_PIECE_BYTES {
        return vec![paste.to_vec()];
    }
    // Beyond the sequence bound, pieces grow instead of dropping content.
    let target = UNFRAMED_PASTE_PIECE_BYTES.max(paste.len().div_ceil(MAX_INPUT_SEQUENCE_CHUNKS));
    let mut pieces = Vec::new();
    let mut start = 0;
    while start < paste.len() {
        let mut end = (start + target).min(paste.len());
        // Never split a UTF-8 character or a CRLF pair.
        while end < paste.len()
            && end > start + 1
            && (is_utf8_continuation(paste[end])
                || (paste[end] == b'\n' && paste[end - 1] == b'\r'))
        {
            end -= 1;
        }
        pieces.push(paste[start..end].to_vec());
        start = end;
    }
    pieces
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

pub(crate) fn write_paste(
    terminal: &TerminalService,
    session_id: &str,
    runtime_epoch: u64,
    paste: &[u8],
) -> Result<PendingInputWrite, TerminalError> {
    let pieces = paste_pieces(paste);
    if pieces.len() < 2 {
        terminal.input_atomic_receipted(session_id, runtime_epoch, paste)
    } else {
        terminal.input_sequence_receipted(session_id, runtime_epoch, &pieces)
    }
}

/// The paste receipt arrives only after every piece and the gaps between them.
pub(crate) fn paste_receipt_timeout(base: Duration, paste: &[u8]) -> Duration {
    let gaps = paste_pieces(paste).len().saturating_sub(1) as u32;
    base + (INPUT_SEQUENCE_GAP + PIECE_RECEIPT_ALLOWANCE) * gaps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_unframed_paste_stays_one_write() {
        let paste = vec![b'a'; UNFRAMED_PASTE_PIECE_BYTES];
        assert_eq!(unframed_pieces(&paste), vec![paste]);
    }

    #[test]
    fn long_unframed_paste_splits_into_bounded_pieces_without_loss() {
        let paste: Vec<u8> = (0..3_846).map(|i| b'a' + (i % 26) as u8).collect();
        let pieces = unframed_pieces(&paste);

        assert_eq!(pieces.len(), 4);
        assert!(
            pieces
                .iter()
                .all(|piece| piece.len() <= UNFRAMED_PASTE_PIECE_BYTES)
        );
        assert_eq!(pieces.concat(), paste);
    }

    #[test]
    fn pieces_keep_utf8_characters_and_crlf_pairs_whole() {
        let mut paste = vec![b'a'; UNFRAMED_PASTE_PIECE_BYTES - 1];
        paste.extend_from_slice("ö".as_bytes());
        paste.extend(vec![b'b'; UNFRAMED_PASTE_PIECE_BYTES - 2]);
        paste.extend_from_slice(b"\r\n");
        paste.extend(vec![b'c'; 10]);
        let pieces = unframed_pieces(&paste);

        assert_eq!(pieces.concat(), paste);
        for piece in &pieces {
            assert!(std::str::from_utf8(piece).is_ok());
            assert_ne!(piece.first(), Some(&b'\n'));
        }
    }

    #[test]
    fn paste_beyond_the_sequence_bound_uses_larger_pieces() {
        let paste = vec![b'a'; UNFRAMED_PASTE_PIECE_BYTES * MAX_INPUT_SEQUENCE_CHUNKS * 2];
        let pieces = unframed_pieces(&paste);

        assert_eq!(pieces.len(), MAX_INPUT_SEQUENCE_CHUNKS);
        assert_eq!(pieces.concat(), paste);
    }

    #[test]
    fn receipt_timeout_covers_every_gap() {
        let base = Duration::from_secs(2);
        let paste = vec![b'a'; UNFRAMED_PASTE_PIECE_BYTES * 3];
        let expected = if termloop_platform::host_uses_bracketed_paste_framing() {
            base
        } else {
            base + (INPUT_SEQUENCE_GAP + PIECE_RECEIPT_ALLOWANCE) * 2
        };
        assert_eq!(paste_receipt_timeout(base, &paste), expected);
    }
}
