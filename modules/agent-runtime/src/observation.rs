use termloop_agents::AgentObservation;

pub struct SessionObservation {
    pub token: Option<String>,
    pub runtime_epoch: u64,
    pub observation: Option<AgentObservation>,
    pub last_signal: Option<termloop_agents::AgentSignal>,
    // Agent TUIs may flush PTY input while entering interactive mode. Keep the
    // exact invocation-owned bytes runtime-only until authenticated structured
    // provider state proves that the composer is idle, then consume them once.
    pub pending_generated_input: Option<termloop_launch::GeneratedTerminalSubmission>,
    pub defer_generated_input_until_hook_response: bool,
    pub last_notification_type: Option<String>,
}

pub fn observation_token_matches(expected: &str, token: &str) -> bool {
    !expected.is_empty()
        && expected.len() <= 256
        && token.len() <= 256
        && capability_equal(expected.as_bytes(), token.as_bytes())
}

fn capability_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_require_the_entire_exact_nonempty_token() {
        let prefix = "a".repeat(64);
        assert!(observation_token_matches(&prefix, &prefix));
        assert!(!observation_token_matches("", ""));
        assert!(!observation_token_matches(&prefix, &(prefix.clone() + "b")));
        assert!(!observation_token_matches(
            &(prefix.clone() + "a"),
            &(prefix + "b")
        ));
        assert!(!observation_token_matches(
            &"a".repeat(257),
            &"a".repeat(257)
        ));
    }
}
