use serde::Deserialize;

/// How long a Claude process must have rested at `idle` before the watched
/// turn counts as ended without its `Stop` hook. A finished turn writes `idle`
/// and fires `Stop` together; the delay leaves that hook ample time to arrive
/// first, so the settled check never overrides an ordinary completion.
pub const CLAUDE_TURN_WITHDRAWAL_SETTLE_MS: u64 = 5_000;

/// The live record is written by the provider and the turn start is observed
/// by the daemon when the `UserPromptSubmit` hook lands; both use the same
/// wall clock, but the record can lead the hook by a few milliseconds.
const TURN_START_TOLERANCE_MS: u64 = 2_000;

/// One provider-authored live status for the exact observed conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeLiveStatus {
    idle: bool,
    updated_at_epoch_ms: u64,
}

#[derive(Deserialize)]
struct LiveStatusRecord {
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "statusUpdatedAt")]
    status_updated_at: Option<u64>,
}

/// Reads one record from Claude's per-process live status directory. Only a
/// record naming the exact observed conversation with a status timestamp
/// counts; any other process, shape, or missing field is not evidence.
pub fn parse_claude_live_status(record: &str, native_session_id: &str) -> Option<ClaudeLiveStatus> {
    let record = serde_json::from_str::<LiveStatusRecord>(record).ok()?;
    if native_session_id.is_empty() || record.session_id.as_deref() != Some(native_session_id) {
        return None;
    }
    Some(ClaudeLiveStatus {
        idle: record.status.as_deref() == Some("idle"),
        updated_at_epoch_ms: record.status_updated_at?,
    })
}

/// Whether the watched turn ended without any hook. `Esc` pressed before the
/// first response token cancels the request and returns the prompt to the
/// composer: Claude then fires no `Stop` and writes no interruption record, so
/// its own live status returning to `idle` is the only provider evidence.
///
/// The newest record decides, because a crashed process can leave an older
/// record for the same conversation behind. It must be `idle`, written after
/// the watched turn started, and settled long enough that a `Stop` hook for a
/// normally finished turn would already have arrived.
pub fn claude_turn_withdrawn(
    statuses: impl IntoIterator<Item = ClaudeLiveStatus>,
    turn_started_at_epoch_ms: u64,
    now_epoch_ms: u64,
) -> bool {
    statuses
        .into_iter()
        .max_by_key(|status| status.updated_at_epoch_ms)
        .is_some_and(|newest| {
            newest.idle
                && newest.updated_at_epoch_ms
                    >= turn_started_at_epoch_ms.saturating_sub(TURN_START_TOLERANCE_MS)
                && now_epoch_ms.saturating_sub(newest.updated_at_epoch_ms)
                    >= CLAUDE_TURN_WITHDRAWAL_SETTLE_MS
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "ce75b68b-ce99-44fd-9bd5-71beaf9340d0";

    fn record(session_id: &str, status: &str, updated_at: u64) -> String {
        format!(
            r#"{{"pid":33122,"sessionId":"{session_id}","kind":"interactive","status":"{status}","statusUpdatedAt":{updated_at}}}"#
        )
    }

    fn status(state: &str, updated_at: u64) -> ClaudeLiveStatus {
        parse_claude_live_status(&record(SESSION, state, updated_at), SESSION).unwrap()
    }

    #[test]
    fn only_a_record_for_the_exact_conversation_is_evidence() {
        assert_eq!(
            parse_claude_live_status(&record(SESSION, "idle", 7), SESSION),
            Some(ClaudeLiveStatus {
                idle: true,
                updated_at_epoch_ms: 7
            })
        );
        assert!(!status("busy", 7).idle);
        assert_eq!(
            parse_claude_live_status(&record("other", "idle", 7), SESSION),
            None
        );
        assert_eq!(parse_claude_live_status(&record("", "idle", 7), ""), None);
        assert_eq!(
            parse_claude_live_status(
                &format!(r#"{{"sessionId":"{SESSION}","status":"idle"}}"#),
                SESSION
            ),
            None
        );
        assert_eq!(parse_claude_live_status("{truncated", SESSION), None);
    }

    #[test]
    fn a_settled_idle_after_the_turn_started_proves_a_withdrawn_turn() {
        let started = 1_000_000;
        let idle_at = started + 650;
        assert!(claude_turn_withdrawn(
            [status("idle", idle_at)],
            started,
            idle_at + CLAUDE_TURN_WITHDRAWAL_SETTLE_MS
        ));
        // `Stop` gets the settle window to arrive first.
        assert!(!claude_turn_withdrawn(
            [status("idle", idle_at)],
            started,
            idle_at + CLAUDE_TURN_WITHDRAWAL_SETTLE_MS - 1
        ));
    }

    #[test]
    fn a_busy_or_older_idle_record_never_ends_a_running_turn() {
        let started = 1_000_000;
        let later = started + 60_000;
        assert!(!claude_turn_withdrawn(
            [status("busy", started + 10)],
            started,
            later
        ));
        // An idle written before the turn started describes the previous turn.
        assert!(!claude_turn_withdrawn(
            [status("idle", started - TURN_START_TOLERANCE_MS - 1)],
            started,
            later
        ));
        assert!(!claude_turn_withdrawn([], started, later));
    }

    #[test]
    fn the_newest_record_for_the_conversation_decides() {
        let started = 1_000_000;
        let later = started + 60_000;
        // A crashed process left an idle record; the live process is busy.
        assert!(!claude_turn_withdrawn(
            [status("idle", started + 5), status("busy", started + 10)],
            started,
            later
        ));
        assert!(claude_turn_withdrawn(
            [status("busy", started + 5), status("idle", started + 10)],
            started,
            later
        ));
    }
}
