//! Bounded, read-only pages of visible messages from one exact provider conversation.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use termloop_domain::{ResumeProvider, ResumeRef};
use termloop_platform::{
    discover_bounded_history_files_cancellable, read_bounded_history_file_window,
    user_home_directory,
};

use crate::{AgentAccountContext, AgentHistoryPreviewRole};

const WINDOW_BYTES: usize = 4 * 1024 * 1024;
const PAGE_BYTES: usize = 256 * 1024;
const MESSAGE_BYTES: usize = 64 * 1024;
const PAGE_MESSAGES: usize = 50;

pub struct ConversationMessage {
    pub role: AgentHistoryPreviewRole,
    pub text: String,
    pub truncated: bool,
}

#[derive(Default)]
pub struct ConversationPage {
    pub available: bool,
    pub messages: Vec<ConversationMessage>,
    pub next_before: Option<u64>,
    pub incomplete: bool,
}

pub fn read_agent_conversation(
    account: &AgentAccountContext,
    resume: &ResumeRef,
    before: Option<u64>,
    cancellation: &AtomicBool,
) -> ConversationPage {
    let (provider, directories, depth) = match resume.provider {
        ResumeProvider::Codex => ("codex", &["sessions", "archived_sessions"][..], 5),
        ResumeProvider::Claude => ("claude", &["projects"][..], 3),
        _ => return ConversationPage::default(),
    };
    if !resume.validate() || account.agent_id != provider {
        return ConversationPage::default();
    }
    let Some(root) = account
        .config_directory
        .clone()
        .or_else(|| user_home_directory().map(|home| home.join(format!(".{provider}"))))
    else {
        return ConversationPage::default();
    };
    let suffix = format!("{}.jsonl", resume.native_session_id);
    for directory in directories {
        let Ok(files) = discover_bounded_history_files_cancellable(
            &root.join(directory),
            "jsonl",
            depth,
            20_000,
            cancellation,
        ) else {
            continue;
        };
        for file in files {
            if cancellation.load(Ordering::Acquire) {
                return ConversationPage::default();
            }
            let Some(name) = file.path().file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name != suffix && !(provider == "codex" && name.ends_with(&format!("-{suffix}"))) {
                continue;
            }
            let Ok(window) =
                read_bounded_history_file_window(&file, before, 256 * 1024, WINDOW_BYTES)
            else {
                return ConversationPage::default();
            };
            if !identifies_conversation(&window.head, resume) {
                continue;
            }
            return parse_page(&window.bytes, window.start, resume);
        }
    }
    ConversationPage::default()
}

fn identifies_conversation(bytes: &[u8], resume: &ResumeRef) -> bool {
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .any(|record| match resume.provider {
            ResumeProvider::Codex => {
                record.get("type").and_then(Value::as_str) == Some("session_meta")
                    && record.pointer("/payload/id").and_then(Value::as_str)
                        == Some(&resume.native_session_id)
            }
            ResumeProvider::Claude => {
                record.get("sessionId").and_then(Value::as_str) == Some(&resume.native_session_id)
            }
            _ => false,
        })
}

fn parse_page(bytes: &[u8], start: u64, resume: &ResumeRef) -> ConversationPage {
    let mut page = ConversationPage {
        available: true,
        ..ConversationPage::default()
    };
    // The first record may start in the previous window. Leave that record for
    // the next page, whose exclusive end includes this prefix in full.
    let first = if start == 0 {
        0
    } else {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1)
    };
    let mut position = first;
    let mut lines = Vec::new();
    for line in bytes[first..].split_inclusive(|byte| *byte == b'\n') {
        lines.push((start + position as u64, line));
        position += line.len();
    }
    let mut next_before = start + first as u64;
    let mut text_bytes = 0;
    for (offset, line) in lines.into_iter().rev() {
        let record = match serde_json::from_slice::<Value>(line) {
            Ok(record) => record,
            Err(_) => {
                page.incomplete = true;
                next_before = offset;
                continue;
            }
        };
        if let Some(message) = visible_message(&record, resume) {
            if page.messages.len() >= PAGE_MESSAGES || text_bytes + message.text.len() > PAGE_BYTES
            {
                break;
            }
            text_bytes += message.text.len();
            page.messages.push(message);
        }
        next_before = offset;
    }
    let end = start + bytes.len() as u64;
    if next_before == end && start > 0 {
        // A single record exceeds the read window. Make bounded progress and
        // explicitly report the omitted record instead of looping forever.
        page.incomplete = true;
        next_before = start;
    }
    page.next_before = (next_before > 0).then_some(next_before);
    page.messages.reverse();
    page
}

fn visible_message(record: &Value, resume: &ResumeRef) -> Option<ConversationMessage> {
    let message = match resume.provider {
        ResumeProvider::Codex => {
            // response_item is the recorded message; event_msg mirrors it and
            // would duplicate both user prompts and assistant answers.
            if record.get("type")?.as_str()? != "response_item" {
                return None;
            }
            let payload = record.get("payload")?;
            if payload.get("type")?.as_str()? != "message"
                || payload.get("channel").and_then(Value::as_str) == Some("analysis")
            {
                return None;
            }
            payload
        }
        ResumeProvider::Claude => {
            if record.get("sessionId")?.as_str()? != resume.native_session_id
                || record.get("isSidechain").and_then(Value::as_bool) == Some(true)
                || record.get("isMeta").and_then(Value::as_bool) == Some(true)
                || !matches!(
                    record.get("type").and_then(Value::as_str),
                    Some("user" | "assistant")
                )
            {
                return None;
            }
            record.get("message")?
        }
        _ => return None,
    };
    let role = match message
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| record.get("type").and_then(Value::as_str))
    {
        Some("user") => AgentHistoryPreviewRole::User,
        Some("assistant") => AgentHistoryPreviewRole::Assistant,
        _ => return None,
    };
    let content = message.get("content")?;
    let text = if let Some(text) = content.as_str() {
        text.to_owned()
    } else {
        content
            .as_array()?
            .iter()
            .filter_map(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("text" | "input_text" | "output_text")
                )
                .then(|| part.get("text").and_then(Value::as_str))
                .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let text = text.trim();
    if role == AgentHistoryPreviewRole::User
        && [
            "<environment_context>",
            "# AGENTS.md instructions for ",
            "<permissions instructions>",
        ]
        .iter()
        .any(|prefix| text.starts_with(prefix))
    {
        return None;
    }
    let mut clean = String::new();
    let mut truncated = false;
    for character in text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
    {
        if clean.len() + character.len_utf8() > MESSAGE_BYTES {
            truncated = true;
            break;
        }
        clean.push(character);
    }
    (!clean.trim().is_empty()).then_some(ConversationMessage {
        role,
        text: clean,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resume(provider: ResumeProvider) -> ResumeRef {
        ResumeRef::for_provider(provider, "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into()).unwrap()
    }

    fn codex(role: &str, text: &str) -> Value {
        json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":"output_text","text":text}]}})
    }

    #[test]
    fn pages_preserve_complete_answers_formatting_and_repeated_user_messages() {
        let resume = resume(ResumeProvider::Codex);
        let answer = format!("## Heading\n\n{}\n\nLast paragraph", "ş".repeat(3500));
        let records = (0..123)
            .map(|index| codex("assistant", &format!("{index}: {answer}")))
            .collect::<Vec<_>>();
        let bytes = records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>()
            .into_bytes();
        let mut end = bytes.len();
        let mut messages = Vec::new();
        loop {
            let start = end.saturating_sub(100_000);
            let page = parse_page(&bytes[start..end], start as u64, &resume);
            assert!(
                page.messages
                    .iter()
                    .all(|message| !message.truncated && message.text.ends_with("Last paragraph"))
            );
            messages.splice(0..0, page.messages.into_iter().map(|message| message.text));
            let Some(before) = page.next_before else {
                break;
            };
            assert!((before as usize) < end);
            end = before as usize;
        }
        assert_eq!(messages.len(), 123);
        for (index, message) in messages.iter().enumerate() {
            assert_eq!(message, &format!("{index}: {answer}"));
        }
        let repeated = format!("{}\n{}\n", codex("user", "again"), codex("user", "again"));
        assert_eq!(
            parse_page(repeated.as_bytes(), 0, &resume).messages.len(),
            2
        );
    }

    #[test]
    fn projects_only_visible_text_and_reports_oversized_messages() {
        let resume = resume(ResumeProvider::Codex);
        let mut records = vec![
            codex("developer", "hidden"),
            codex("user", "<environment_context>private context"),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"duplicate"}}),
            json!({"type":"response_item","payload":{"type":"reasoning","text":"hidden"}}),
        ];
        records.push(codex("assistant", &"ş".repeat(MESSAGE_BYTES)));
        let body = records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>();
        let page = parse_page(body.as_bytes(), 0, &resume);
        assert_eq!(page.messages.len(), 1);
        assert!(page.messages[0].truncated);
        assert_eq!(page.messages[0].text.len(), MESSAGE_BYTES);
    }

    #[test]
    fn claude_ignores_tools_thinking_sidechains_and_other_conversations() {
        let resume = resume(ResumeProvider::Claude);
        let record = json!({"type":"assistant","sessionId":resume.native_session_id,"message":{"role":"assistant","content":[
            {"type":"thinking","text":"hidden"}, {"type":"tool_use","text":"hidden"}, {"type":"text","text":"Visible\nanswer"}]}});
        assert_eq!(
            visible_message(&record, &resume).unwrap().text,
            "Visible\nanswer"
        );
        for (key, value) in [
            ("isSidechain", json!(true)),
            ("isMeta", json!(true)),
            ("sessionId", json!("different")),
        ] {
            let mut excluded = record.clone();
            excluded[key] = value;
            assert!(visible_message(&excluded, &resume).is_none());
        }
    }

    #[test]
    fn oversized_or_incomplete_records_cannot_stall_pagination() {
        let resume = resume(ResumeProvider::Codex);
        let page = parse_page(&[b'x'; 100], 100, &resume);
        assert_eq!(page.next_before, Some(100));
        assert!(page.incomplete);
        let page = parse_page(b"{broken\n", 0, &resume);
        assert!(page.incomplete);
        assert_eq!(page.next_before, None);
    }

    #[test]
    fn reads_the_exact_account_and_validates_native_identity_without_a_history_cache() {
        let root =
            std::env::temp_dir().join(format!("termloop-conversation-{}", uuid::Uuid::new_v4()));
        let resume = resume(ResumeProvider::Codex);
        let account = AgentAccountContext {
            agent_id: "codex".into(),
            account_id: "work".into(),
            name: "Work".into(),
            config_directory: Some(root.clone()),
        };
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let path = root
            .join("sessions")
            .join(format!("rollout-{}.jsonl", resume.native_session_id));
        let body = format!(
            "{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":resume.native_session_id}}),
            codex("assistant", "Entire\nanswer")
        );
        std::fs::write(&path, body).unwrap();
        let page = read_agent_conversation(&account, &resume, None, &AtomicBool::new(false));
        assert!(page.available);
        assert_eq!(page.messages[0].text, "Entire\nanswer");
        assert!(
            !read_agent_conversation(&account, &resume, None, &AtomicBool::new(true)).available
        );
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":"wrong"}}),
                codex("assistant", "Do not expose")
            ),
        )
        .unwrap();
        assert!(
            !read_agent_conversation(&account, &resume, None, &AtomicBool::new(false)).available
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
