use std::collections::HashMap;

const WINDOW_MILLISECONDS: u64 = 1_000;
const MAX_EVENTS_PER_WINDOW: u16 = 256;
const MAX_TRACKED_SESSIONS: usize = 1_024;

#[derive(Debug, Clone, Copy)]
struct IngressWindow {
    started_at_epoch_ms: u64,
    last_seen_at_epoch_ms: u64,
    events: u16,
}

#[derive(Debug, Default)]
pub(crate) struct ProviderObservationIngress {
    windows: HashMap<String, IngressWindow>,
}

impl ProviderObservationIngress {
    pub(crate) fn admit(&mut self, session_id: &str, observed_at_epoch_ms: u64) -> bool {
        if let Some(window) = self.windows.get_mut(session_id) {
            let elapsed = observed_at_epoch_ms.checked_sub(window.started_at_epoch_ms);
            if elapsed.is_none_or(|elapsed| elapsed >= WINDOW_MILLISECONDS) {
                *window = IngressWindow {
                    started_at_epoch_ms: observed_at_epoch_ms,
                    last_seen_at_epoch_ms: observed_at_epoch_ms,
                    events: 1,
                };
                return true;
            }
            window.last_seen_at_epoch_ms = observed_at_epoch_ms;
            if window.events >= MAX_EVENTS_PER_WINDOW {
                return false;
            }
            window.events += 1;
            return true;
        }

        if self.windows.len() >= MAX_TRACKED_SESSIONS
            && let Some(oldest) = self
                .windows
                .iter()
                .min_by_key(|(_, window)| window.last_seen_at_epoch_ms)
                .map(|(session_id, _)| session_id.clone())
        {
            self.windows.remove(&oldest);
        }
        self.windows.insert(
            session_id.to_owned(),
            IngressWindow {
                started_at_epoch_ms: observed_at_epoch_ms,
                last_seen_at_epoch_ms: observed_at_epoch_ms,
                events: 1,
            },
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingress_is_session_scoped_bounded_and_recovers_at_the_next_window() {
        let mut ingress = ProviderObservationIngress::default();
        for _ in 0..MAX_EVENTS_PER_WINDOW {
            assert!(ingress.admit("session-a", 10));
        }
        assert!(!ingress.admit("session-a", 10));
        assert!(ingress.admit("session-b", 10));
        assert!(ingress.admit("session-a", 10 + WINDOW_MILLISECONDS));
        // A clock correction starts a fresh bounded window instead of keeping
        // the Session permanently throttled.
        assert!(ingress.admit("session-a", 1));
    }

    #[test]
    fn tracked_session_state_has_a_fixed_upper_bound() {
        let mut ingress = ProviderObservationIngress::default();
        for index in 0..=MAX_TRACKED_SESSIONS {
            assert!(ingress.admit(&format!("session-{index}"), index as u64));
        }
        assert_eq!(ingress.windows.len(), MAX_TRACKED_SESSIONS);
        assert!(!ingress.windows.contains_key("session-0"));
    }
}
