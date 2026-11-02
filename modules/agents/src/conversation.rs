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

/// Makes one provider conversation resumable from another account of the same
/// provider by linking its transcript to the same relative path below the new
/// account's provider root. Both accounts then share one file, so history keeps
/// accruing in a single place. Returns `false` when no transcript was found;
/// an existing transcript at the destination is left untouched.
pub fn bridge_agent_conversation(
    from: &AgentAccountContext,
    to: &AgentAccountContext,
    resume: &ResumeRef,
) -> Result<bool, &'static str> {
    let (provider, directories, depth) = match resume.provider {
        ResumeProvider::Codex => ("codex", &["sessions", "archived_sessions"][..], 5),
        ResumeProvider::Claude => ("claude", &["projects"][..], 3),
        _ => return Ok(false),
    };
    if !resume.validate() || from.agent_id != provider || to.agent_id != provider {
        return Err("The conversation belongs to another provider.");
    }
    let root = |account: &AgentAccountContext| {
        account
            .config_directory
            .clone()
            .or_else(|| user_home_directory().map(|home| home.join(format!(".{provider}"))))
    };
    let (Some(source_root), Some(target_root)) = (root(from), root(to)) else {
        return Err("The provider folder is unavailable.");
    };
    if source_root == target_root {
        return Ok(true);
    }
    let suffix = format!("{}.jsonl", resume.native_session_id);
    let never = AtomicBool::new(false);
    for directory in directories {
        let Ok(files) = discover_bounded_history_files_cancellable(
            &source_root.join(directory),
            "jsonl",
            depth,
            20_000,
            &never,
        ) else {
            continue;
        };
        for file in files {
            let Some(name) = file.path().file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name != suffix && !(provider == "codex" && name.ends_with(&format!("-{suffix}"))) {
                continue;
            }
            let Ok(window) = read_bounded_history_file_window(&file, None, 256 * 1024, 256 * 1024)
            else {
                continue;
            };
            if !identifies_conversation(&window.head, resume) {
                continue;
            }
            let Ok(relative) = file.path().strip_prefix(file.root()) else {
                continue;
            };
            let relative = std::path::Path::new(directory).join(relative);
            return termloop_platform::link_or_copy_private_file(
                file.path(),
                &target_root,
                &relative,
            )
            .map(|_| true)
            .map_err(|_| "The conversation could not be shared with the other account.");
        }
    }
    Ok(false)
}

/// Whether Claude can still find one conversation's transcript in an account
/// with its own provider root. Claude keeps each transcript directly below one
/// `projects/<folder>` entry, so this checks that exact file name in every
/// folder. `Some(false)` means every folder was checked and none holds it;
/// an ambient root, another provider, or any unreadable or oversized listing
/// stays unknown so a resume is never refused on incomplete evidence.
pub fn claude_conversation_transcript_exists(
    account: Option<&AgentAccountContext>,
    resume: &ResumeRef,
) -> Option<bool> {
    const MAX_PROJECT_FOLDERS: usize = 20_000;
    if resume.provider != ResumeProvider::Claude || !resume.validate() {
        return None;
    }
    let account = account.filter(|account| account.agent_id == "claude")?;
    let projects = account.config_directory.as_ref()?.join("projects");
    let entries = match std::fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(false),
        Err(_) => return None,
    };
    let name = format!("{}.jsonl", resume.native_session_id);
    for (index, entry) in entries.enumerate() {
        if index >= MAX_PROJECT_FOLDERS {
            return None;
        }
        let entry = entry.ok()?;
        match std::fs::metadata(entry.path().join(&name)) {
            Ok(metadata) if metadata.is_file() => return Some(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {}
            Err(_) => return None,
        }
    }
    Some(false)
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
    fn bridging_links_the_exact_transcript_into_the_other_account_once() {
        let root = std::env::temp_dir().join(format!(
            "termloop-bridge-{}",
            termloop_platform::generate_uuid_v4()
        ));
        let account = |id: &str| AgentAccountContext {
            agent_id: "codex".into(),
            account_id: id.into(),
            name: id.into(),
            config_directory: Some(root.join(id)),
        };
        let (from, to) = (account("a"), account("b"));
        let resume = resume(ResumeProvider::Codex);
        let day = root.join("a/sessions/2026/10/22");
        std::fs::create_dir_all(&day).unwrap();
        let name = format!(
            "rollout-2026-10-22T10-00-00-{}.jsonl",
            resume.native_session_id
        );
        let meta = json!({"type":"session_meta","payload":{"id":resume.native_session_id}});
        std::fs::write(day.join(&name), format!("{meta}\n")).unwrap();
        std::fs::write(day.join("rollout-other.jsonl"), "{}\n").unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();

        assert_eq!(bridge_agent_conversation(&from, &to, &resume), Ok(true));
        let bridged = root.join("b/sessions/2026/10/22").join(&name);
        assert_eq!(
            std::fs::read(&bridged).unwrap(),
            std::fs::read(day.join(&name)).unwrap()
        );
        assert!(
            !root
                .join("b/sessions/2026/10/22/rollout-other.jsonl")
                .exists()
        );
        assert_eq!(bridge_agent_conversation(&from, &to, &resume), Ok(true));
        let unknown = ResumeRef::for_provider(
            ResumeProvider::Codex,
            "019f1dae-0000-73d1-b3c7-08ddbbd1f035".into(),
        )
        .unwrap();
        assert_eq!(bridge_agent_conversation(&from, &to, &unknown), Ok(false));
        let claude = AgentAccountContext {
            agent_id: "claude".into(),
            ..to.clone()
        };
        assert!(bridge_agent_conversation(&from, &claude, &resume).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claude_transcript_absence_is_reported_only_after_every_project_folder_is_checked() {
        let root = std::env::temp_dir().join(format!(
            "termloop-claude-transcript-{}",
            termloop_platform::generate_uuid_v4()
        ));
        let account = AgentAccountContext {
            agent_id: "claude".into(),
            account_id: "work".into(),
            name: "work".into(),
            config_directory: Some(root.clone()),
        };
        let resume = resume(ResumeProvider::Claude);
        assert_eq!(
            claude_conversation_transcript_exists(Some(&account), &resume),
            Some(false)
        );
        let project = root.join("projects/-Users-me-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(root.join("projects/stray.json"), "{}").unwrap();
        std::fs::write(project.join("other.jsonl"), "{}\n").unwrap();
        assert_eq!(
            claude_conversation_transcript_exists(Some(&account), &resume),
            Some(false)
        );
        std::fs::write(
            project.join(format!("{}.jsonl", resume.native_session_id)),
            "{}\n",
        )
        .unwrap();
        assert_eq!(
            claude_conversation_transcript_exists(Some(&account), &resume),
            Some(true)
        );
        // The ambient root and other providers are never judged absent.
        assert_eq!(claude_conversation_transcript_exists(None, &resume), None);
        let ambient = AgentAccountContext {
            config_directory: None,
            ..account.clone()
        };
        assert_eq!(
            claude_conversation_transcript_exists(Some(&ambient), &resume),
            None
        );
        assert_eq!(
            claude_conversation_transcript_exists(
                Some(&account),
                &self::resume(ResumeProvider::Codex)
            ),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
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
