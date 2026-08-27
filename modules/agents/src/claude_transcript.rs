use serde::Deserialize;

/// Claude hooks carry `permission_mode` but never the active model, so the
/// newest main-thread assistant entry in the provider transcript is the only
/// provider-authored evidence that an in-TUI `/model` moved the Session off its
/// launch selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeObservedModel {
    canonical: &'static str,
    compatible: &'static [&'static str],
}

impl ClaudeObservedModel {
    /// The launch selection to store when the observation contradicts the
    /// current one.
    pub fn canonical_selection(&self) -> &'static str {
        self.canonical
    }

    /// One provider model id can back several selections: the transcript
    /// records `claude-opus-5` for both `opus` and `opus[1m]`, so an already
    /// compatible selection is kept rather than silently downgraded.
    pub fn matches_selection(&self, selection: &str) -> bool {
        self.compatible.contains(&selection)
    }
}

/// Provider id prefix, the selection it proves, and every selection it cannot
/// distinguish. The exact 1M-context id is tried first because the ordinary
/// Opus prefix also matches it.
const MODEL_FAMILIES: &[(&str, ClaudeObservedModel)] = &[
    (
        "claude-opus-5[1m]",
        ClaudeObservedModel {
            canonical: "opus[1m]",
            compatible: &["opus[1m]"],
        },
    ),
    (
        "claude-opus-",
        ClaudeObservedModel {
            canonical: "opus",
            compatible: &["opus", "opus[1m]"],
        },
    ),
    (
        "claude-fable-",
        ClaudeObservedModel {
            canonical: "fable",
            compatible: &["fable"],
        },
    ),
    (
        "claude-sonnet-",
        ClaudeObservedModel {
            canonical: "sonnet",
            compatible: &["sonnet"],
        },
    ),
    (
        "claude-haiku-",
        ClaudeObservedModel {
            canonical: "haiku",
            compatible: &["haiku"],
        },
    ),
];

const MAX_PROVIDER_MODEL_ID_BYTES: usize = 64;

/// Maps one hook-reported permission mode onto the launch selection vocabulary.
/// Claude renamed the modes it displays (`manual`, `auto`) while still
/// accepting the older names, and every hook payload carries the mode the
/// Session is on right now — the only provider-authored evidence that an
/// in-TUI `Shift+Tab` moved the Session off its launch selection.
///
/// An unrecognised mode degrades to `None`. `dontAsk` has no launch selection
/// that means exactly the same thing, and guessing `bypassPermissions` would
/// escalate the resumed Session past what the user actually picked.
pub fn claude_observed_permission(permission_mode: &str) -> Option<&'static str> {
    match permission_mode {
        "default" | "manual" => Some("default"),
        "acceptEdits" | "auto" => Some("acceptEdits"),
        "plan" => Some("plan"),
        "bypassPermissions" => Some("bypassPermissions"),
        _ => None,
    }
}

/// Maps one hook-reported effort level onto the launch selection vocabulary.
/// A tool or turn boundary reports the level the Session is on right now, which
/// is the only provider-authored evidence that an in-TUI effort change moved
/// the Session off its launch selection. An unrecognised level degrades to
/// `None`.
pub fn claude_observed_reasoning(effort_level: &str) -> Option<&'static str> {
    match effort_level {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// Maps one provider model id onto the launch selection vocabulary. An
/// unrecognised id degrades to `None`: an unknown provider model is not
/// authority to rewrite a stored selection.
pub fn claude_observed_model(provider_model_id: &str) -> Option<ClaudeObservedModel> {
    if provider_model_id.is_empty() || provider_model_id.len() > MAX_PROVIDER_MODEL_ID_BYTES {
        return None;
    }
    MODEL_FAMILIES
        .iter()
        .find(|(prefix, _)| provider_model_id.starts_with(prefix))
        .map(|(_, observed)| *observed)
}

#[derive(Deserialize)]
struct TranscriptEntry {
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(default, rename = "isSidechain")]
    is_sidechain: bool,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default, rename = "promptId")]
    prompt_id: Option<String>,
    #[serde(default, rename = "interruptedMessageId")]
    interrupted_message_id: Option<String>,
    #[serde(default)]
    message: Option<TranscriptMessage>,
}

#[derive(Deserialize)]
struct TranscriptMessage {
    #[serde(default)]
    model: Option<String>,
}

/// Reads the newest provider model id out of a bounded transcript tail. The
/// tail may start mid-record and it may replay a subagent or a foreign
/// conversation, so only a complete main-thread entry belonging to the exact
/// observed conversation counts.
pub fn normalize_claude_transcript_model(tail: &str, native_session_id: &str) -> Option<String> {
    tail.lines().rev().find_map(|line| {
        let entry = serde_json::from_str::<TranscriptEntry>(line).ok()?;
        if entry.entry_type != "assistant"
            || entry.is_sidechain
            || entry.session_id.as_deref() != Some(native_session_id)
        {
            return None;
        }
        let model = entry.message?.model?;
        // Claude writes `<synthetic>` for locally generated turns such as an
        // interrupt notice; those never prove a model selection.
        if model.is_empty() || model.len() > MAX_PROVIDER_MODEL_ID_BYTES || model.starts_with('<') {
            return None;
        }
        Some(model)
    })
}

/// Reports whether the exact turn started by `prompt_id` was interrupted by the
/// user. Claude fires no hook at all for `Esc`, so this transcript record is the
/// only provider-authored proof that a working turn ended without finishing.
///
/// `interruptedMessageId` is the structured marker; the accompanying
/// `[Request interrupted by user]` text is display copy and is never matched.
/// The prompt identity is what makes the answer exact: an older turn's
/// interruption still sitting in the tail carries a different `promptId`.
pub fn claude_turn_interrupted(tail: &str, native_session_id: &str, prompt_id: &str) -> bool {
    if prompt_id.is_empty() {
        return false;
    }
    tail.lines().rev().any(|line| {
        let Ok(entry) = serde_json::from_str::<TranscriptEntry>(line) else {
            return false;
        };
        entry.entry_type == "user"
            && !entry.is_sidechain
            && entry.session_id.as_deref() == Some(native_session_id)
            && entry.prompt_id.as_deref() == Some(prompt_id)
            && entry
                .interrupted_message_id
                .is_some_and(|value| !value.is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(session_id: &str, model: &str, sidechain: bool) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":{sidechain},"sessionId":"{session_id}","message":{{"role":"assistant","model":"{model}","content":[]}}}}"#
        )
    }

    #[test]
    fn the_newest_main_thread_assistant_entry_proves_the_model() {
        let tail = [
            assistant("session-a", "claude-opus-5", false),
            assistant("session-a", "claude-fable-5", false),
        ]
        .join("\n");
        assert_eq!(
            normalize_claude_transcript_model(&tail, "session-a").as_deref(),
            Some("claude-fable-5")
        );
    }

    #[test]
    fn subagent_foreign_and_synthetic_entries_are_not_model_authority() {
        let tail = [
            assistant("session-a", "claude-opus-5", false),
            assistant("session-a", "claude-haiku-4-5-20251001", true),
            assistant("session-b", "claude-sonnet-5", false),
            assistant("session-a", "<synthetic>", false),
            r#"{"type":"user","sessionId":"session-a","message":{"role":"user"}}"#.into(),
        ]
        .join("\n");
        assert_eq!(
            normalize_claude_transcript_model(&tail, "session-a").as_deref(),
            Some("claude-opus-5")
        );
    }

    #[test]
    fn a_truncated_leading_record_is_skipped_rather_than_guessed() {
        let tail = format!(
            "aude-opus-5\",\"content\":[]}}}}\n{}",
            assistant("session-a", "claude-sonnet-5", false)
        );
        assert_eq!(
            normalize_claude_transcript_model(&tail, "session-a").as_deref(),
            Some("claude-sonnet-5")
        );
        assert_eq!(
            normalize_claude_transcript_model("not json", "session-a"),
            None
        );
        assert_eq!(normalize_claude_transcript_model("", "session-a"), None);
    }

    fn interrupt(session_id: &str, prompt_id: &str) -> String {
        format!(
            r#"{{"type":"user","isSidechain":false,"sessionId":"{session_id}","promptId":"{prompt_id}","message":{{"role":"user","content":[{{"type":"text","text":"[Request interrupted by user]"}}]}},"interruptedMessageId":"msg_01abc"}}"#
        )
    }

    fn turn_start(session_id: &str, prompt_id: &str) -> String {
        format!(
            r#"{{"type":"user","isSidechain":false,"sessionId":"{session_id}","promptId":"{prompt_id}","message":{{"role":"user","content":[{{"type":"text","text":"do the thing"}}]}}}}"#
        )
    }

    #[test]
    fn an_interruption_is_proven_by_the_marker_for_the_exact_running_turn() {
        let tail = [
            turn_start("session-a", "prompt-1"),
            assistant("session-a", "claude-opus-5", false),
            interrupt("session-a", "prompt-1"),
        ]
        .join("\n");
        assert!(claude_turn_interrupted(&tail, "session-a", "prompt-1"));
    }

    #[test]
    fn an_older_or_foreign_interruption_never_reports_the_running_turn() {
        let tail = [
            interrupt("session-a", "prompt-1"),
            interrupt("session-b", "prompt-2"),
            turn_start("session-a", "prompt-2"),
            assistant("session-a", "claude-opus-5", false),
        ]
        .join("\n");
        // The running turn is prompt-2 in session-a: the only prompt-2
        // interruption belongs to another conversation.
        assert!(!claude_turn_interrupted(&tail, "session-a", "prompt-2"));
        assert!(claude_turn_interrupted(&tail, "session-a", "prompt-1"));
        assert!(!claude_turn_interrupted(&tail, "session-a", ""));
        assert!(!claude_turn_interrupted("", "session-a", "prompt-1"));
        assert!(!claude_turn_interrupted(
            "not json",
            "session-a",
            "prompt-1"
        ));
    }

    #[test]
    fn a_completed_turn_is_not_an_interruption() {
        let tail = [
            turn_start("session-a", "prompt-1"),
            assistant("session-a", "claude-opus-5", false),
            r#"{"type":"system","subtype":"stop_hook_summary","sessionId":"session-a"}"#.into(),
        ]
        .join("\n");
        assert!(!claude_turn_interrupted(&tail, "session-a", "prompt-1"));
    }

    #[test]
    fn one_provider_id_keeps_every_selection_it_cannot_distinguish() {
        let opus = claude_observed_model("claude-opus-5").unwrap();
        assert_eq!(opus.canonical_selection(), "opus");
        assert!(opus.matches_selection("opus"));
        assert!(opus.matches_selection("opus[1m]"));
        assert!(!opus.matches_selection("sonnet"));
        assert!(!opus.matches_selection("default"));

        assert_eq!(
            claude_observed_model("claude-opus-5[1m]")
                .unwrap()
                .canonical_selection(),
            "opus[1m]"
        );
        assert_eq!(
            claude_observed_model("claude-haiku-4-5-20251001")
                .unwrap()
                .canonical_selection(),
            "haiku"
        );
        assert_eq!(
            claude_observed_model("claude-sonnet-5")
                .unwrap()
                .canonical_selection(),
            "sonnet"
        );
        assert_eq!(
            claude_observed_model("claude-fable-5")
                .unwrap()
                .canonical_selection(),
            "fable"
        );
    }

    #[test]
    fn every_named_permission_mode_maps_onto_one_launch_selection() {
        assert_eq!(claude_observed_permission("auto"), Some("acceptEdits"));
        assert_eq!(
            claude_observed_permission("acceptEdits"),
            Some("acceptEdits")
        );
        assert_eq!(claude_observed_permission("manual"), Some("default"));
        assert_eq!(claude_observed_permission("default"), Some("default"));
        assert_eq!(claude_observed_permission("plan"), Some("plan"));
        assert_eq!(
            claude_observed_permission("bypassPermissions"),
            Some("bypassPermissions")
        );
        // No launch selection means exactly `dontAsk`, so it stays an
        // unrecognised mode rather than an inferred escalation.
        assert_eq!(claude_observed_permission("dontAsk"), None);
        assert_eq!(claude_observed_permission(""), None);
        assert_eq!(claude_observed_permission("Auto"), None);
    }

    #[test]
    fn every_named_effort_level_maps_onto_one_launch_selection() {
        for level in ["low", "medium", "high", "xhigh", "max"] {
            assert_eq!(claude_observed_reasoning(level), Some(level));
        }
        // `default` is the absence of an effort selection, never a level the
        // provider reports back.
        assert_eq!(claude_observed_reasoning("default"), None);
        assert_eq!(claude_observed_reasoning(""), None);
        assert_eq!(claude_observed_reasoning("High"), None);
    }

    #[test]
    fn an_unknown_or_unbounded_provider_id_is_not_selection_authority() {
        assert!(claude_observed_model("gpt-5.6-sol").is_none());
        assert!(claude_observed_model("<synthetic>").is_none());
        assert!(claude_observed_model("").is_none());
        assert!(claude_observed_model(&"claude-opus-".repeat(16)).is_none());
    }
}
