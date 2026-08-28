//! Durable Project Companion transcript commands and projections.

use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde_json::{Value, json};
use termloop_domain::{
    COMPANION_TRANSCRIPT_HARD_BYTES, COMPANION_TRANSCRIPT_HARD_MESSAGES,
    COMPANION_TRANSCRIPT_SOFT_BYTES, COMPANION_TRANSCRIPT_SOFT_MESSAGES, CompanionMessage,
    CompanionMessageAuthor, CompanionMessageInputMode, CompanionMessageKind, CompanionMessageRefs,
};

const MAX_TRANSCRIPT_PAGE: usize = 100;
const MAX_TRANSCRIPT_PAGE_ENCODED_BYTES: usize = 3 * 1024 * 1024;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CompanionMessageRefsInput {
    pub task_id: Option<String>,
    pub session_id: Option<String>,
    pub routine_finding_id: Option<String>,
    pub routine_finding_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionMessageAppendInput {
    pub author: String,
    pub kind: String,
    pub input_mode: String,
    pub refs: CompanionMessageRefsInput,
    pub content: String,
}

impl CompanionMessageRefsInput {
    pub fn all_routine_finding_ids(&self) -> impl Iterator<Item = &str> {
        self.routine_finding_id
            .iter()
            .map(String::as_str)
            .chain(self.routine_finding_ids.iter().map(String::as_str))
    }
}

impl CoreRuntime {
    pub fn accept_companion_suggestion(
        &mut self,
        project_id: &str,
        suggestion_message_id: &str,
        created_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let pending = self
            .current_unanswered_steward_interaction(project_id)
            .filter(|message| {
                message.id == suggestion_message_id
                    && message.kind == CompanionMessageKind::Suggestion
            })
            .cloned()
            .ok_or(CoreError::RevisionConflict)?;
        let refs = pending
            .refs
            .map_or_else(CompanionMessageRefsInput::default, |refs| {
                CompanionMessageRefsInput {
                    task_id: refs.task_id,
                    session_id: refs.session_id,
                    routine_finding_id: refs.routine_finding_id,
                    routine_finding_ids: refs.routine_finding_ids,
                }
            });
        self.append_companion_message(
            project_id,
            "user",
            "acceptance",
            refs,
            "Accepted. Proceed with this suggestion.".into(),
            created_at_epoch_ms,
        )
    }

    pub fn respond_to_companion_proposal(
        &mut self,
        project_id: &str,
        proposal_message_id: &str,
        decision: &str,
        created_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let pending = self.current_pending_companion_proposal(project_id);
        if pending.is_none_or(|message| message.id != proposal_message_id) {
            return Err(CoreError::RevisionConflict);
        }
        let refs = pending
            .and_then(|message| message.refs.as_ref())
            .map_or_else(CompanionMessageRefsInput::default, |refs| {
                CompanionMessageRefsInput {
                    task_id: refs.task_id.clone(),
                    session_id: refs.session_id.clone(),
                    routine_finding_id: refs.routine_finding_id.clone(),
                    routine_finding_ids: refs.routine_finding_ids.clone(),
                }
            });
        let (kind, content) = match decision {
            "approve" => ("approval", "Approved. Proceed with the proposed action."),
            "decline" => ("decline", "Not now."),
            _ => return Err(CoreError::InvalidParams("decision".into())),
        };
        self.append_companion_message(
            project_id,
            "user",
            kind,
            refs,
            content.into(),
            created_at_epoch_ms,
        )
    }

    pub fn append_companion_message(
        &mut self,
        project_id: &str,
        author: &str,
        kind: &str,
        refs: CompanionMessageRefsInput,
        content: String,
        created_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        self.append_companion_message_input(
            project_id,
            CompanionMessageAppendInput {
                author: author.into(),
                kind: kind.into(),
                input_mode: "text".into(),
                refs,
                content,
            },
            created_at_epoch_ms,
        )
    }

    pub fn append_companion_message_input(
        &mut self,
        project_id: &str,
        input: CompanionMessageAppendInput,
        created_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let CompanionMessageAppendInput {
            author,
            kind,
            input_mode,
            refs,
            content,
        } = input;
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let author = match author.as_str() {
            "user" => CompanionMessageAuthor::User,
            "steward" => CompanionMessageAuthor::Steward,
            _ => return Err(CoreError::InvalidParams("author".into())),
        };
        let kind = match kind.as_str() {
            "reply" => CompanionMessageKind::Reply,
            "update" => CompanionMessageKind::Update,
            "attention" => CompanionMessageKind::Attention,
            "problem" => CompanionMessageKind::Problem,
            "suggestion" => CompanionMessageKind::Suggestion,
            "acceptance" => CompanionMessageKind::Acceptance,
            "action" => CompanionMessageKind::Action,
            "proposal" => CompanionMessageKind::Proposal,
            "approval" => CompanionMessageKind::Approval,
            "decline" => CompanionMessageKind::Decline,
            _ => return Err(CoreError::InvalidParams("kind".into())),
        };
        let input_mode = match input_mode.as_str() {
            "text" => CompanionMessageInputMode::Text,
            "voice" => CompanionMessageInputMode::Voice,
            _ => return Err(CoreError::InvalidParams("inputMode".into())),
        };
        let refs = (refs.task_id.is_some()
            || refs.session_id.is_some()
            || refs.routine_finding_id.is_some()
            || !refs.routine_finding_ids.is_empty())
        .then_some(CompanionMessageRefs {
            task_id: refs.task_id,
            session_id: refs.session_id,
            routine_finding_id: refs.routine_finding_id,
            routine_finding_ids: refs.routine_finding_ids,
        });
        let sequence = self
            .store
            .companion_messages()
            .iter()
            .filter(|message| message.project_id == project_id)
            .map(|message| message.sequence)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?;
        let message = CompanionMessage {
            id: format!("{project_id}:{sequence}"),
            project_id: project_id.to_owned(),
            sequence,
            author,
            kind,
            input_mode,
            refs,
            content,
            created_at_epoch_ms,
        };
        let message = self
            .store
            .append_companion_message(&self.write_authority, message)
            .map_err(store_error)?;
        let usage = self.companion_transcript_usage(project_id);
        Ok(json!({
            "message": companion_message_projection(&message)?,
            "usage": usage,
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn companion_has_pending_proposal(&self, project_id: &str) -> bool {
        self.current_pending_companion_proposal(project_id)
            .is_some()
    }

    /// A proposal remains pending across later Steward status messages. Only a
    /// newer user-authored message answers or supersedes it. This keeps a
    /// background Playbook update from silently removing an approval request.
    pub(crate) fn current_pending_companion_proposal(
        &self,
        project_id: &str,
    ) -> Option<&CompanionMessage> {
        self.current_unanswered_steward_interaction(project_id)
            .filter(|message| message.kind == CompanionMessageKind::Proposal)
    }

    fn current_unanswered_steward_interaction(
        &self,
        project_id: &str,
    ) -> Option<&CompanionMessage> {
        let newest_user_sequence = self
            .store
            .companion_messages()
            .iter()
            .filter(|message| {
                message.project_id == project_id && message.author == CompanionMessageAuthor::User
            })
            .map(|message| message.sequence)
            .max()
            .unwrap_or(0);
        self.store
            .companion_messages()
            .iter()
            .rev()
            .find(|message| {
                message.project_id == project_id
                    && message.sequence > newest_user_sequence
                    && message.author == CompanionMessageAuthor::Steward
                    && matches!(
                        message.kind,
                        CompanionMessageKind::Suggestion | CompanionMessageKind::Proposal
                    )
            })
    }

    pub fn list_companion_transcript(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let before_sequence = params.get("beforeSequence").and_then(Value::as_u64);
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| (1..=MAX_TRANSCRIPT_PAGE).contains(value))
            .ok_or_else(|| CoreError::InvalidParams("limit".into()))?;
        let mut matching = self
            .store
            .companion_messages()
            .iter()
            .rev()
            .filter(|message| {
                message.project_id == project_id
                    && before_sequence.is_none_or(|before| message.sequence < before)
            });
        let mut messages = Vec::with_capacity(limit);
        let mut encoded_bytes = 0_usize;
        let mut stopped_for_bytes = false;
        while messages.len() < limit {
            let Some(message) = matching.next() else {
                break;
            };
            let projected = companion_message_projection(message)?;
            let message_bytes = serde_json::to_vec(&projected)
                .map_err(|_| CoreError::Store("transcript projection encoding failed".into()))?
                .len();
            if encoded_bytes.saturating_add(message_bytes) > MAX_TRANSCRIPT_PAGE_ENCODED_BYTES {
                stopped_for_bytes = true;
                break;
            }
            encoded_bytes = encoded_bytes.saturating_add(message_bytes);
            messages.push(projected);
        }
        let has_more = stopped_for_bytes || matching.next().is_some();
        let next_before_sequence = has_more
            .then(|| {
                messages
                    .last()
                    .and_then(|message| message["sequence"].as_u64())
            })
            .flatten();
        Ok(json!({
            "messages": messages,
            "nextBeforeSequence": next_before_sequence,
            "usage": self.companion_transcript_usage(&project_id),
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn clear_companion_transcript(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let expected_revision = params
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| CoreError::InvalidParams("expectedRevision".into()))?;
        let deleted = self
            .store
            .clear_companion_transcript(&self.write_authority, &project_id, expected_revision)
            .map_err(store_error)?;
        Ok(json!({
            "projectId": project_id,
            "deletedMessages": deleted,
            "stateRevision": self.store.revision(),
        }))
    }

    fn companion_transcript_usage(&self, project_id: &str) -> Value {
        let used_bytes = self.store.companion_transcript_storage_bytes(project_id);
        let used_messages = self.store.companion_transcript_message_count(project_id);
        json!({
            "usedBytes": used_bytes,
            "usedMessages": used_messages,
            "softLimitBytes": COMPANION_TRANSCRIPT_SOFT_BYTES,
            "hardLimitBytes": COMPANION_TRANSCRIPT_HARD_BYTES,
            "hardMessageLimit": COMPANION_TRANSCRIPT_HARD_MESSAGES,
            "softLimitExceeded": used_bytes >= COMPANION_TRANSCRIPT_SOFT_BYTES
                || used_messages >= COMPANION_TRANSCRIPT_SOFT_MESSAGES,
        })
    }
}

fn companion_message_projection(message: &CompanionMessage) -> Result<Value, CoreError> {
    let mut value = serde_json::to_value(message)
        .map_err(|_| CoreError::Store("transcript projection encoding failed".into()))?;
    value["kind"] = json!(match message.kind {
        CompanionMessageKind::Reply => "reply",
        CompanionMessageKind::Update => "update",
        CompanionMessageKind::Attention => "attention",
        CompanionMessageKind::Problem => "problem",
        CompanionMessageKind::Suggestion => "suggestion",
        CompanionMessageKind::Acceptance => "acceptance",
        CompanionMessageKind::Action => "action",
        CompanionMessageKind::Proposal => "proposal",
        CompanionMessageKind::Approval => "approval",
        CompanionMessageKind::Decline => "decline",
    });
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::TerminalService;

    fn runtime() -> (CoreRuntime, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-companion-transcript-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let authority = issue_core_write_authority_for_composition();
        let store = Store::open(&path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project_folder = path.with_extension("project");
        std::fs::create_dir_all(&project_folder).unwrap();
        runtime
            .handle(
                "project.create",
                json!({"name":"Demo","folderPath":project_folder}),
            )
            .unwrap();
        (runtime, path)
    }

    #[test]
    fn append_list_and_clear_are_project_scoped_and_revision_checked() {
        let (mut runtime, path) = runtime();
        let project_id = runtime.store.projects()[0].id.clone();
        runtime
            .append_companion_message_input(
                &project_id,
                CompanionMessageAppendInput {
                    author: "user".into(),
                    kind: "reply".into(),
                    input_mode: "voice".into(),
                    refs: CompanionMessageRefsInput::default(),
                    content: "first".into(),
                },
                1,
            )
            .unwrap();
        runtime
            .append_companion_message(
                &project_id,
                "steward",
                "suggestion",
                CompanionMessageRefsInput::default(),
                "second".into(),
                2,
            )
            .unwrap();
        let page = runtime
            .list_companion_transcript(json!({
                "projectId": project_id,
                "limit": 1
            }))
            .unwrap();
        assert_eq!(page["messages"][0]["content"], "second");
        assert_eq!(page["nextBeforeSequence"], 2);
        assert!(page["usage"]["usedBytes"].as_u64().unwrap() > 11);
        assert_eq!(page["usage"]["usedMessages"], 2);
        assert_eq!(
            runtime
                .list_companion_transcript(json!({
                    "projectId": project_id,
                    "limit": 2
                }))
                .unwrap()["messages"][1]["inputMode"],
            "voice"
        );

        assert!(matches!(
            runtime.clear_companion_transcript(json!({
                "projectId": project_id,
                "expectedRevision": 0
            })),
            Err(CoreError::RevisionConflict)
        ));
        let revision = runtime.state_revision();
        let cleared = runtime
            .clear_companion_transcript(json!({
                "projectId": project_id,
                "expectedRevision": revision
            }))
            .unwrap();
        assert_eq!(cleared["deletedMessages"], 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn transcript_page_stays_below_the_control_transport_budget() {
        let (mut runtime, path) = runtime();
        let project_id = runtime.store.projects()[0].id.clone();
        for index in 0..70 {
            runtime
                .append_companion_message(
                    &project_id,
                    "steward",
                    "reply",
                    CompanionMessageRefsInput::default(),
                    format!("{index:02}{}", "x".repeat(49_000)),
                    index,
                )
                .unwrap();
        }
        let page = runtime
            .list_companion_transcript(json!({
                "projectId": project_id,
                "limit": 100
            }))
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() < 4 * 1024 * 1024);
        assert!(page["messages"].as_array().unwrap().len() < 70);
        assert!(!page["nextBeforeSequence"].is_null());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pending_proposal_is_cleared_by_the_next_user_message() {
        let (mut runtime, path) = runtime();
        let project_id = runtime.store.projects()[0].id.clone();
        runtime
            .append_companion_message(
                &project_id,
                "steward",
                "proposal",
                CompanionMessageRefsInput {
                    task_id: Some("task-1".into()),
                    session_id: None,
                    routine_finding_id: None,
                    routine_finding_ids: vec![],
                },
                "May I start the Task Agent?".into(),
                1,
            )
            .unwrap();
        assert!(runtime.companion_has_pending_proposal(&project_id));
        runtime
            .append_companion_message(
                &project_id,
                "user",
                "reply",
                CompanionMessageRefsInput::default(),
                "Not now.".into(),
                2,
            )
            .unwrap();
        assert!(!runtime.companion_has_pending_proposal(&project_id));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn proposal_response_targets_the_pending_proposal_across_steward_updates() {
        let (mut runtime, path) = runtime();
        let project_id = runtime.store.projects()[0].id.clone();
        let proposal = runtime
            .append_companion_message(
                &project_id,
                "steward",
                "proposal",
                CompanionMessageRefsInput::default(),
                "May I start the Task Agent?".into(),
                1,
            )
            .unwrap();
        let proposal_id = proposal["message"]["id"].as_str().unwrap();
        runtime
            .append_companion_message(
                &project_id,
                "steward",
                "update",
                CompanionMessageRefsInput::default(),
                "Another pipeline stage moved.".into(),
                2,
            )
            .unwrap();
        assert!(runtime.companion_has_pending_proposal(&project_id));
        let approved = runtime
            .respond_to_companion_proposal(&project_id, proposal_id, "approve", 3)
            .unwrap();
        assert_eq!(
            approved["message"]["content"],
            "Approved. Proceed with the proposed action."
        );
        assert_eq!(approved["message"]["author"], "user");
        assert!(!runtime.companion_has_pending_proposal(&project_id));
        assert!(matches!(
            runtime.respond_to_companion_proposal(&project_id, proposal_id, "decline", 4),
            Err(CoreError::RevisionConflict)
        ));
        assert!(matches!(
            runtime.respond_to_companion_proposal(&project_id, "missing", "approve", 4),
            Err(CoreError::RevisionConflict)
        ));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn transcript_projects_non_actionable_and_attention_message_kinds() {
        let (mut runtime, path) = runtime();
        let project_id = runtime.store.projects()[0].id.clone();
        for (index, kind) in ["update", "attention", "problem"].into_iter().enumerate() {
            runtime
                .append_companion_message(
                    &project_id,
                    "steward",
                    kind,
                    CompanionMessageRefsInput::default(),
                    format!("{kind} message"),
                    index as u64 + 1,
                )
                .unwrap();
        }
        let page = runtime
            .list_companion_transcript(json!({
                "projectId": project_id,
                "limit": 3
            }))
            .unwrap();
        assert_eq!(page["messages"][0]["kind"], "problem");
        assert_eq!(page["messages"][1]["kind"], "attention");
        assert_eq!(page["messages"][2]["kind"], "update");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn suggestion_accept_requires_the_exact_newest_typed_suggestion() {
        let (mut runtime, path) = runtime();
        let project_id = runtime.store.projects()[0].id.clone();
        let task_id = runtime
            .handle(
                "task.create",
                json!({
                    "projectId": project_id,
                    "title": "Review failure",
                    "brief": null,
                    "worktreeIntent": "none",
                }),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let suggestion = runtime
            .append_companion_message(
                &project_id,
                "steward",
                "suggestion",
                CompanionMessageRefsInput {
                    task_id: Some(task_id.clone()),
                    session_id: None,
                    routine_finding_id: None,
                    routine_finding_ids: vec![],
                },
                "I suggest reviewing the failed check.".into(),
                1,
            )
            .unwrap();
        let suggestion_id = suggestion["message"]["id"].as_str().unwrap();
        runtime
            .append_companion_message(
                &project_id,
                "steward",
                "update",
                CompanionMessageRefsInput::default(),
                "A separate pipeline stage moved.".into(),
                2,
            )
            .unwrap();
        let accepted = runtime
            .accept_companion_suggestion(&project_id, suggestion_id, 3)
            .unwrap();
        assert_eq!(
            accepted["message"]["content"],
            "Accepted. Proceed with this suggestion."
        );
        assert_eq!(accepted["message"]["author"], "user");
        assert_eq!(accepted["message"]["kind"], "acceptance");
        assert_eq!(accepted["message"]["refs"]["taskId"], task_id);
        assert!(matches!(
            runtime.accept_companion_suggestion(&project_id, suggestion_id, 4),
            Err(CoreError::RevisionConflict)
        ));
        let _ = std::fs::remove_file(path);
    }
}
