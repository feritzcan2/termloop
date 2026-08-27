/// Whether direct PTY input on this host preserves xterm bracketed-paste
/// framing. Windows ConPTY interprets input escape sequences before a cooked
/// child receives them, so daemon-injected input uses unframed content there.
pub fn host_uses_bracketed_paste_framing() -> bool {
    !cfg!(windows)
}

/// Configures the child side of a headless PTY fixture so tests can observe
/// paste framing and the submit key as exact byte boundaries.
pub fn configure_headless_terminal_input_fixture() -> Result<(), std::io::Error> {
    #[cfg(windows)]
    configure_windows_headless_terminal_input_fixture()?;
    #[cfg(unix)]
    {
        let status = std::process::Command::new("stty")
            .args(["-icanon", "min", "1", "time", "0", "-echo", "-icrnl"])
            .status()?;
        if !status.success() {
            return Err(std::io::Error::other(
                "headless terminal fixture input setup failed",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn configure_windows_headless_terminal_input_fixture() -> Result<(), std::io::Error> {
    use windows_sys::Win32::System::Console::{
        ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
        ENABLE_VIRTUAL_TERMINAL_INPUT, GetConsoleMode, STD_INPUT_HANDLE, SetConsoleMode,
    };

    // ConPTY starts the synthetic child in cooked console mode. Real agent
    // TUIs switch to VT/raw input before TermLoop delivers generated text;
    // mirror that setup so the fixture can observe the unframed paste and the
    // later Enter write as separate boundaries.
    let input = unsafe {
        // SAFETY: GetStdHandle reads the process-owned standard-input handle
        // and does not dereference caller memory.
        windows_sys::Win32::System::Console::GetStdHandle(STD_INPUT_HANDLE)
    };
    let mut mode = 0_u32;
    if unsafe {
        // SAFETY: `input` is the live process standard-input handle and `mode`
        // is valid writable storage for the duration of the call.
        GetConsoleMode(input, &mut mode)
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let raw_mode = (mode | ENABLE_VIRTUAL_TERMINAL_INPUT)
        & !(ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT);
    if unsafe {
        // SAFETY: `input` was accepted by GetConsoleMode and `raw_mode`
        // contains only documented console input flags.
        SetConsoleMode(input, raw_mode)
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GeneratedTerminalInputError {
    #[error("generated terminal input contains a paste framing terminator")]
    PasteTerminator,
    #[error("generated terminal input is not valid UTF-8")]
    InvalidUtf8,
    #[error("generated terminal input contains a terminal control character")]
    ControlCharacter,
}

/// Encodes one paste payload for direct delivery to the host PTY.
///
/// Callers own content validation. This primitive owns only the platform wire
/// representation and deliberately excludes the following submit key.
pub fn terminal_paste_input(content: &[u8]) -> Vec<u8> {
    if !host_uses_bracketed_paste_framing() {
        return content.to_vec();
    }
    let mut paste = Vec::with_capacity(content.len() + 12);
    paste.extend_from_slice(b"\x1b[200~");
    paste.extend_from_slice(content);
    paste.extend_from_slice(b"\x1b[201~");
    paste
}

/// Encodes a paste followed by one submit key as a single atomic write.
pub fn terminal_paste_submission(content: &[u8]) -> Vec<u8> {
    let mut submission = terminal_paste_input(content);
    submission.push(b'\r');
    submission
}

/// Encodes a paste and a delayed submit as two ordered PTY writes.
pub fn terminal_paste_submission_sequence(content: &[u8]) -> Vec<Vec<u8>> {
    vec![terminal_paste_input(content), b"\r".to_vec()]
}

/// Validates and encodes one TermLoop-generated paste plus its delayed submit
/// key. Generated content is UTF-8 by invariant; rejecting control characters
/// here is the platform-level backstop that prevents bracketed-paste
/// termination on Unix and raw carriage-return submission splitting on
/// Windows ConPTY, even if an invocation binding validator regresses.
pub fn generated_terminal_paste_submission_sequence(
    content: &[u8],
) -> Result<Vec<Vec<u8>>, GeneratedTerminalInputError> {
    if content
        .windows(b"\x1b[201~".len())
        .any(|window| window == b"\x1b[201~")
    {
        return Err(GeneratedTerminalInputError::PasteTerminator);
    }
    let content =
        std::str::from_utf8(content).map_err(|_| GeneratedTerminalInputError::InvalidUtf8)?;
    if content
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(GeneratedTerminalInputError::ControlCharacter);
    }
    Ok(terminal_paste_submission_sequence(content.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_submission_matches_the_host_pty_contract() {
        let paste = terminal_paste_input(b"review\nthis");
        if cfg!(windows) {
            assert_eq!(paste, b"review\nthis");
        } else {
            assert_eq!(paste, b"\x1b[200~review\nthis\x1b[201~");
        }
        assert_eq!(terminal_paste_submission_sequence(b"review")[1], b"\r");
        assert!(terminal_paste_submission(b"review").ends_with(b"\r"));
    }

    #[test]
    fn generated_paste_rejects_framing_and_submission_injection() {
        assert_eq!(
            generated_terminal_paste_submission_sequence(b"safe\ncontent\titem").unwrap(),
            terminal_paste_submission_sequence(b"safe\ncontent\titem")
        );
        assert_eq!(
            generated_terminal_paste_submission_sequence(b"escape\x1b[201~execute"),
            Err(GeneratedTerminalInputError::PasteTerminator)
        );
        assert_eq!(
            generated_terminal_paste_submission_sequence(b"first\rsecond"),
            Err(GeneratedTerminalInputError::ControlCharacter)
        );
        assert_eq!(
            generated_terminal_paste_submission_sequence("unsafe\u{009b}31m".as_bytes()),
            Err(GeneratedTerminalInputError::ControlCharacter)
        );
        assert_eq!(
            generated_terminal_paste_submission_sequence(&[0xff]),
            Err(GeneratedTerminalInputError::InvalidUtf8)
        );
    }
}
