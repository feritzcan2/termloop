//! Bounds shared by the PM value types. Every check is pure and rejects
//! rather than normalizes: callers trim, the store never does.

pub const ID_MAX_BYTES: usize = 128;

/// An opaque identifier: printable ASCII without whitespace, bounded.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= ID_MAX_BYTES && id.bytes().all(|byte| byte.is_ascii_graphic())
}

/// Rejects an invalid id parameter, naming it.
pub(crate) fn check_id(id: &str, name: &'static str) -> Result<(), crate::PmError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(crate::PmError::Invalid(name))
    }
}

/// A single-line label: non-empty, already trimmed, bounded, no control
/// characters.
pub fn valid_label(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty()
        && value.trim() == value
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

/// Multi-line text: bounded, with no control characters other than line
/// breaks and tabs.
pub fn valid_text(value: &str, max_chars: usize) -> bool {
    value.chars().count() <= max_chars
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

/// Multi-line text that must say something.
pub fn valid_non_blank_text(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty() && valid_text(value, max_chars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_bounded_printable_ascii() {
        assert!(valid_id("3f2a-01"));
        assert!(!valid_id(""));
        assert!(!valid_id("a b"));
        assert!(!valid_id("ç"));
        assert!(!valid_id(&"x".repeat(ID_MAX_BYTES + 1)));
    }

    #[test]
    fn labels_are_trimmed_and_single_line() {
        assert!(valid_label("Sprint 14", 80));
        assert!(!valid_label(" Sprint", 80));
        assert!(!valid_label("a\nb", 80));
        assert!(!valid_label("abc", 2));
        assert!(valid_text("line\n\tnext", 20));
        assert!(!valid_text("bell\u{7}", 20));
        assert!(!valid_non_blank_text(" \n", 20));
    }
}
