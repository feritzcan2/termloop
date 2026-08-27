use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use termloop_domain::{ResumeProvider, ResumeRef};
use termloop_platform::{
    BoundedHistoryFile, BoundedHistoryFileSlices, discover_bounded_history_files_cancellable,
    read_bounded_history_file_slices, user_home_directory,
};

#[cfg(test)]
use termloop_platform::discover_bounded_history_files;

const MAX_CANDIDATES_PER_PROVIDER: usize = 200;
const MAX_HEAD_BYTES: usize = 256 * 1024;
const MAX_TAIL_BYTES: usize = 256 * 1024;
const MAX_PREVIEW_MESSAGES: usize = 3;
const MAX_PREVIEW_CHARS: usize = 480;
const MAX_TITLE_CHARS: usize = 120;
const MAX_CWD_BYTES: usize = 4096;
const MAX_BRANCH_BYTES: usize = 255;
const MAX_MODEL_BYTES: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHistoryPreviewRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentHistoryPreviewMessage {
    pub role: AgentHistoryPreviewRole,
    pub text: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct DiscoveredAgentConversation {
    pub resume_ref: ResumeRef,
    pub agent_id: String,
    pub title: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub updated_at_epoch_ms: u64,
    pub preview_messages: Vec<AgentHistoryPreviewMessage>,
    pub source: BoundedHistoryFile,
    pub source_modified_at_epoch_ms: u64,
    pub source_size_bytes: u64,
    pub source_window_sha256: [u8; 32],
}

impl std::fmt::Debug for DiscoveredAgentConversation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DiscoveredAgentConversation")
            .field("resume_ref", &self.resume_ref)
            .field("agent_id", &self.agent_id)
            .field("title", &"<private preview>")
            .field("cwd", &"<private>")
            .field("branch", &self.branch)
            .field("model", &self.model)
            .field("updated_at_epoch_ms", &self.updated_at_epoch_ms)
            .field("preview_count", &self.preview_messages.len())
            .field("source", &self.source)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHistoryScanIssue {
    HomeUnavailable,
    ClaudeDiscoveryUnavailable,
    CodexDiscoveryUnavailable,
    SourceUnreadable,
    SourceUnrecognized,
}

#[derive(Debug, Clone, Default)]
pub struct AgentHistoryScan {
    pub conversations: Vec<DiscoveredAgentConversation>,
    pub issues: Vec<AgentHistoryScanIssue>,
    pub candidate_limit_reached: bool,
}

/// Scans only the default user-local Claude and Codex stores. Provider roots
/// and native conversation identities remain daemon-private; Core later scopes
/// these host facts to one Project and replaces them with opaque handles.
pub fn scan_local_agent_history() -> AgentHistoryScan {
    scan_local_agent_history_cancellable(&AtomicBool::new(false))
}

pub fn scan_local_agent_history_cancellable(cancellation: &AtomicBool) -> AgentHistoryScan {
    scan_local_agent_history_cancellable_with_limit(cancellation, MAX_CANDIDATES_PER_PROVIDER)
}

pub fn scan_local_agent_history_cancellable_with_limit(
    cancellation: &AtomicBool,
    max_candidates_per_provider: usize,
) -> AgentHistoryScan {
    let Some(home) = user_home_directory() else {
        return AgentHistoryScan {
            conversations: Vec::new(),
            issues: vec![AgentHistoryScanIssue::HomeUnavailable],
            candidate_limit_reached: false,
        };
    };
    let max_candidates_per_provider =
        max_candidates_per_provider.clamp(1, MAX_CANDIDATES_PER_PROVIDER);
    let mut scan = AgentHistoryScan::default();
    scan_provider(
        &home.join(".claude").join("projects"),
        ResumeProvider::Claude,
        3,
        max_candidates_per_provider,
        cancellation,
        &mut scan,
    );
    scan_provider(
        &home.join(".codex").join("sessions"),
        ResumeProvider::Codex,
        5,
        max_candidates_per_provider,
        cancellation,
        &mut scan,
    );
    let mut deduplicated = HashMap::<(String, String), DiscoveredAgentConversation>::new();
    for conversation in scan.conversations.drain(..) {
        let key = (
            conversation.agent_id.clone(),
            conversation.resume_ref.native_session_id.clone(),
        );
        let replace = deduplicated
            .get(&key)
            .is_none_or(|current| conversation.updated_at_epoch_ms > current.updated_at_epoch_ms);
        if replace {
            deduplicated.insert(key, conversation);
        }
    }
    scan.conversations = deduplicated.into_values().collect();
    scan.conversations.sort_by(|left, right| {
        right
            .updated_at_epoch_ms
            .cmp(&left.updated_at_epoch_ms)
            .then_with(|| left.agent_id.cmp(&right.agent_id))
    });
    scan
}

fn scan_provider(
    root: &Path,
    provider: ResumeProvider,
    max_depth: usize,
    max_candidates: usize,
    cancellation: &AtomicBool,
    scan: &mut AgentHistoryScan,
) {
    let discovery_limit = max_candidates.saturating_add(1);
    let candidates = match discover_bounded_history_files_cancellable(
        root,
        "jsonl",
        max_depth,
        discovery_limit,
        cancellation,
    ) {
        Ok(candidates) => candidates,
        Err(_) => {
            scan.issues.push(match provider {
                ResumeProvider::Claude => AgentHistoryScanIssue::ClaudeDiscoveryUnavailable,
                ResumeProvider::Codex => AgentHistoryScanIssue::CodexDiscoveryUnavailable,
                _ => AgentHistoryScanIssue::SourceUnrecognized,
            });
            return;
        }
    };
    if candidates.len() > max_candidates {
        scan.candidate_limit_reached = true;
    }
    for candidate in candidates.into_iter().take(max_candidates) {
        if cancellation.load(Ordering::Acquire) {
            break;
        }
        let slices =
            match read_bounded_history_file_slices(&candidate, MAX_HEAD_BYTES, MAX_TAIL_BYTES) {
                Ok(slices) => slices,
                Err(_) => {
                    scan.issues.push(AgentHistoryScanIssue::SourceUnreadable);
                    continue;
                }
            };
        let parsed = match provider {
            ResumeProvider::Claude => parse_claude(&candidate, &slices),
            ResumeProvider::Codex => parse_codex(&candidate, &slices),
            _ => None,
        };
        if let Some(parsed) = parsed {
            scan.conversations.push(parsed);
        } else {
            scan.issues.push(AgentHistoryScanIssue::SourceUnrecognized);
        }
    }
}

#[derive(Default)]
struct ConversationAccumulator {
    native_session_id: Option<String>,
    cwd: Option<String>,
    branch: Option<String>,
    model: Option<String>,
    explicit_title: Option<String>,
    first_user_title: Option<String>,
    preview_messages: VecDeque<AgentHistoryPreviewMessage>,
    rejected: bool,
}

fn parse_claude(
    source: &BoundedHistoryFile,
    slices: &BoundedHistoryFileSlices,
) -> Option<DiscoveredAgentConversation> {
    let mut accumulator = ConversationAccumulator::default();
    for record in records(slices) {
        if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(session_id) = bounded_string(record.get("sessionId"), 256) {
            accumulator.native_session_id = Some(session_id);
        }
        if let Some(cwd) = valid_cwd(record.get("cwd")) {
            accumulator.cwd = Some(cwd);
        }
        if let Some(branch) = bounded_string(record.get("gitBranch"), MAX_BRANCH_BYTES) {
            accumulator.branch = Some(branch);
        }
        match record.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                accumulator.explicit_title =
                    bounded_text(record.get("customTitle"), MAX_TITLE_CHARS)
            }
            Some("ai-title") if accumulator.explicit_title.is_none() => {
                accumulator.explicit_title = bounded_text(record.get("aiTitle"), MAX_TITLE_CHARS)
            }
            Some("user") if record.get("isMeta").and_then(Value::as_bool) != Some(true) => {
                if let Some(text) = message_text(record.pointer("/message/content")) {
                    accumulator
                        .first_user_title
                        .get_or_insert_with(|| truncate_chars(&text, MAX_TITLE_CHARS));
                    push_preview(&mut accumulator, AgentHistoryPreviewRole::User, text);
                }
            }
            Some("assistant") => {
                if let Some(model) =
                    bounded_string(record.pointer("/message/model"), MAX_MODEL_BYTES)
                    && !model.starts_with('<')
                {
                    accumulator.model = Some(model);
                }
                if let Some(text) = message_text(record.pointer("/message/content")) {
                    push_preview(&mut accumulator, AgentHistoryPreviewRole::Assistant, text);
                }
            }
            _ => {}
        }
    }
    finish(
        source,
        slices,
        ResumeProvider::Claude,
        "claude",
        accumulator,
    )
}

fn parse_codex(
    source: &BoundedHistoryFile,
    slices: &BoundedHistoryFileSlices,
) -> Option<DiscoveredAgentConversation> {
    let mut accumulator = ConversationAccumulator::default();
    for record in records(slices) {
        let payload = record.get("payload");
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let thread_source =
                    bounded_string(payload.and_then(|value| value.get("thread_source")), 64);
                if thread_source
                    .as_deref()
                    .is_some_and(|source| source != "user")
                    || payload
                        .and_then(|value| value.get("source"))
                        .and_then(|value| value.get("subagent"))
                        .is_some()
                {
                    accumulator.rejected = true;
                    break;
                }
                accumulator.native_session_id =
                    bounded_string(payload.and_then(|value| value.get("id")), 256);
                if let Some(cwd) = valid_cwd(payload.and_then(|value| value.get("cwd"))) {
                    accumulator.cwd = Some(cwd);
                }
                accumulator.branch = bounded_string(
                    payload.and_then(|value| value.pointer("/git/branch")),
                    MAX_BRANCH_BYTES,
                );
            }
            Some("turn_context") => {
                if let Some(cwd) = valid_cwd(payload.and_then(|value| value.get("cwd"))) {
                    accumulator.cwd = Some(cwd);
                }
                if let Some(model) = bounded_string(
                    payload.and_then(|value| value.get("model")),
                    MAX_MODEL_BYTES,
                ) {
                    accumulator.model = Some(model);
                }
            }
            Some("response_item")
                if payload
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    == Some("message") =>
            {
                let role = payload
                    .and_then(|value| value.get("role"))
                    .and_then(Value::as_str);
                if let Some(text) = message_text(payload.and_then(|value| value.get("content"))) {
                    consume_codex_message(&mut accumulator, role, text);
                }
            }
            Some("event_msg") => {
                let event_type = payload
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str);
                let role = match event_type {
                    Some("user_message") => Some("user"),
                    Some("agent_message") => Some("assistant"),
                    _ => None,
                };
                if let Some(text) = message_text(payload.and_then(|value| value.get("message"))) {
                    consume_codex_message(&mut accumulator, role, text);
                }
            }
            _ => {}
        }
    }
    finish(source, slices, ResumeProvider::Codex, "codex", accumulator)
}

fn consume_codex_message(
    accumulator: &mut ConversationAccumulator,
    role: Option<&str>,
    text: String,
) {
    match role {
        Some("user") => {
            accumulator
                .first_user_title
                .get_or_insert_with(|| truncate_chars(&text, MAX_TITLE_CHARS));
            push_preview(accumulator, AgentHistoryPreviewRole::User, text);
        }
        Some("assistant") => push_preview(accumulator, AgentHistoryPreviewRole::Assistant, text),
        _ => {}
    }
}

fn finish(
    source: &BoundedHistoryFile,
    slices: &BoundedHistoryFileSlices,
    provider: ResumeProvider,
    agent_id: &str,
    accumulator: ConversationAccumulator,
) -> Option<DiscoveredAgentConversation> {
    if accumulator.rejected {
        return None;
    }
    let resume_ref = ResumeRef::for_provider(provider, accumulator.native_session_id?)?;
    let cwd = accumulator.cwd?;
    let title = accumulator
        .explicit_title
        .or(accumulator.first_user_title)
        .unwrap_or_else(|| format!("{} conversation", title_case(agent_id)));
    Some(DiscoveredAgentConversation {
        resume_ref,
        agent_id: agent_id.to_owned(),
        title,
        cwd,
        branch: accumulator.branch,
        model: accumulator.model,
        updated_at_epoch_ms: slices.modified_at_epoch_ms,
        preview_messages: accumulator.preview_messages.into_iter().collect(),
        source: source.clone(),
        source_modified_at_epoch_ms: slices.modified_at_epoch_ms,
        source_size_bytes: slices.size_bytes,
        source_window_sha256: slices.window_sha256,
    })
}

fn records(slices: &BoundedHistoryFileSlices) -> Vec<Value> {
    let mut records = Vec::new();
    let observed_bytes = slices.head.len() as u64 + slices.tail.len() as u64;
    if observed_bytes == slices.size_bytes {
        let mut complete = Vec::with_capacity(slices.head.len() + slices.tail.len());
        complete.extend_from_slice(&slices.head);
        complete.extend_from_slice(&slices.tail);
        parse_lines(&complete, false, false, &mut records);
    } else {
        parse_lines(&slices.head, false, true, &mut records);
        parse_lines(&slices.tail, true, false, &mut records);
    }
    records
}

fn parse_lines(bytes: &[u8], skip_first: bool, skip_last: bool, records: &mut Vec<Value>) {
    let text = String::from_utf8_lossy(bytes);
    let line_count = text.lines().count();
    for (index, line) in text.lines().enumerate() {
        if (skip_first && index == 0) || (skip_last && index + 1 == line_count) {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<Value>(line)
            && record.is_object()
        {
            records.push(record);
        }
    }
}

fn push_preview(
    accumulator: &mut ConversationAccumulator,
    role: AgentHistoryPreviewRole,
    text: String,
) {
    let text = truncate_chars(&normalize_text(&text), MAX_PREVIEW_CHARS);
    if text.is_empty() {
        return;
    }
    if accumulator.preview_messages.len() == MAX_PREVIEW_MESSAGES {
        accumulator.preview_messages.pop_front();
    }
    accumulator
        .preview_messages
        .push_back(AgentHistoryPreviewMessage { role, text });
}

fn message_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => non_empty_normalized(text),
        Value::Array(parts) => {
            let combined = parts
                .iter()
                .filter_map(|part| {
                    part.as_object()
                        .and_then(|part| part.get("text"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("\n");
            non_empty_normalized(&combined)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .and_then(non_empty_normalized),
        _ => None,
    }
}

fn bounded_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(non_empty_normalized)
        .map(|value| truncate_chars(&value, max_chars))
}

fn bounded_string(value: Option<&Value>, max_bytes: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

fn valid_cwd(value: Option<&Value>) -> Option<String> {
    let cwd = bounded_string(value, MAX_CWD_BYTES)?;
    Path::new(&cwd).is_absolute().then_some(cwd)
}

fn non_empty_normalized(value: &str) -> Option<String> {
    let value = normalize_text(value);
    (!value.is_empty()).then_some(value)
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(
        provider: &str,
        body: &str,
    ) -> (
        BoundedHistoryFile,
        BoundedHistoryFileSlices,
        std::path::PathBuf,
    ) {
        let root =
            std::env::temp_dir().join(format!("termloop-history-parser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(format!("{provider}.jsonl")), body).unwrap();
        let candidate = discover_bounded_history_files(&root, "jsonl", 0, 1)
            .unwrap()
            .pop()
            .unwrap();
        let slices =
            read_bounded_history_file_slices(&candidate, MAX_HEAD_BYTES, MAX_TAIL_BYTES).unwrap();
        (candidate, slices, root)
    }

    #[test]
    fn claude_parser_keeps_private_resume_identity_and_bounded_preview() {
        let body = [
            r#"{"type":"user","sessionId":"019f1dae-3bf3-73d1-b3c7-08ddbbd1f035","cwd":"/tmp/project","gitBranch":"main","message":{"content":"Build the history panel"}}"#,
            r#"{"type":"assistant","sessionId":"019f1dae-3bf3-73d1-b3c7-08ddbbd1f035","cwd":"/tmp/project","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"Working on it"}]}}"#,
        ].join("\n");
        let (candidate, slices, root) = source("claude", &body);
        let parsed = parse_claude(&candidate, &slices).unwrap();
        assert_eq!(parsed.title, "Build the history panel");
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(parsed.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(parsed.preview_messages.len(), 2);
        assert!(!format!("{parsed:?}").contains("019f1dae"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_parser_rejects_worker_threads() {
        let body = r#"{"type":"session_meta","payload":{"id":"thread-1","cwd":"/tmp/project","thread_source":"subagent"}}"#;
        let (candidate, slices, root) = source("codex", body);
        assert!(parse_codex(&candidate, &slices).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_scan_reads_only_its_recent_candidate_budget() {
        let root =
            std::env::temp_dir().join(format!("termloop-history-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..2 {
            let session_id = uuid::Uuid::new_v4();
            std::fs::write(
                root.join(format!("{index}.jsonl")),
                format!(
                    r#"{{"type":"user","sessionId":"{session_id}","cwd":"/tmp/project","message":{{"content":"Conversation {index}"}}}}"#
                ),
            )
            .unwrap();
        }
        let mut scan = AgentHistoryScan::default();
        scan_provider(
            &root,
            ResumeProvider::Claude,
            0,
            1,
            &AtomicBool::new(false),
            &mut scan,
        );
        assert_eq!(scan.conversations.len(), 1);
        assert!(scan.candidate_limit_reached);
        std::fs::remove_dir_all(root).unwrap();
    }
}
