use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};
use termloop_agents::{AgentAccountContext, AgentHistoryPreviewRole, ConversationPage};
use termloop_domain::{ResumeRef, SessionKind};

use crate::{CoreError, CoreRuntime, required_string};

pub struct SessionConversationPlan {
    project_id: String,
    session_id: String,
    runtime_epoch: u64,
    resume: Option<ResumeRef>,
    account: Option<AgentAccountContext>,
    before: Option<u64>,
}

pub struct ObservedSessionConversation {
    plan: SessionConversationPlan,
    page: ConversationPage,
}

impl SessionConversationPlan {
    pub fn observe(self, cancellation: &AtomicBool) -> ObservedSessionConversation {
        let page = match (&self.account, &self.resume) {
            (Some(account), Some(resume)) => {
                termloop_agents::read_agent_conversation(account, resume, self.before, cancellation)
            }
            _ => ConversationPage::default(),
        };
        ObservedSessionConversation { plan: self, page }
    }
}

impl CoreRuntime {
    pub fn plan_session_conversation_read(
        &self,
        params: Value,
    ) -> Result<SessionConversationPlan, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let session_id = required_string(&params, "sessionId")?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.project_id == project_id
                    && session.kind == SessionKind::Agent
            })
            .ok_or(CoreError::NotFound)?;
        let before = match params.get("before") {
            None => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
                    .ok_or_else(|| CoreError::InvalidParams("before".into()))?,
            ),
        };
        Ok(SessionConversationPlan {
            project_id,
            session_id,
            runtime_epoch: session.runtime_epoch,
            resume: session.resume_ref.clone(),
            account: self.session_agent_account(session)?,
            before,
        })
    }

    pub fn complete_session_conversation_read(
        &self,
        observed: ObservedSessionConversation,
    ) -> Result<Value, CoreError> {
        let plan = observed.plan;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == plan.session_id
                    && session.project_id == plan.project_id
                    && session.kind == SessionKind::Agent
            })
            .ok_or(CoreError::NotFound)?;
        if session.runtime_epoch != plan.runtime_epoch
            || session.resume_ref != plan.resume
            || self.session_agent_account(session)? != plan.account
        {
            return Err(CoreError::InvalidParams(
                "Session changed while reading conversation".into(),
            ));
        }
        let page = observed.page;
        Ok(json!({
            "status": if page.available { "available" } else { "unavailable" },
            "messages": page.messages.into_iter().map(|message| json!({
                "role": match message.role { AgentHistoryPreviewRole::User => "user", AgentHistoryPreviewRole::Assistant => "assistant" },
                "text": message.text, "truncated": message.truncated,
            })).collect::<Vec<_>>(),
            "next_before": page.next_before,
            "incomplete": page.incomplete,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{ProcessDescriptor, ResumeProvider, SessionRecord};
    use termloop_store::Store;
    use termloop_terminal::TerminalService;

    #[test]
    fn conversation_reads_revalidate_project_runtime_resume_and_account() {
        let root = std::env::temp_dir().join(format!(
            "termloop-conversation-core-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(root.join("state.json")).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({"name":"Conversation", "folderPath":root}),
            )
            .unwrap();
        let project_id = project["id"].as_str().unwrap();
        let session = SessionRecord {
            id: "reader".into(),
            project_id: project_id.into(),
            name: None,
            kind: SessionKind::Agent,
            process: ProcessDescriptor {
                program: "codex".into(),
                args: vec![],
                cwd: root.to_string_lossy().into(),
                agent_id: Some("codex".into()),
                template_ref: None,
                template_version: None,
            },
            launch_selection: Default::default(),
            lifecycle_state: "running".into(),
            runtime_epoch: 1,
            archived_at_epoch_ms: None,
            ask_to_source_session_id: None,
            run_configuration_id: None,
            improver_target: None,
            ask_to_continuation: None,
            resume_ref: ResumeRef::for_provider(
                ResumeProvider::Codex,
                uuid::Uuid::new_v4().to_string(),
            ),
            resume_launch_guard: None,
            resume_failure: None,
        };
        runtime
            .store
            .insert_session(&runtime.write_authority, session)
            .unwrap();
        let params = json!({"projectId":project_id,"sessionId":"reader"});
        assert!(matches!(
            runtime
                .plan_session_conversation_read(json!({"projectId":"other","sessionId":"reader"})),
            Err(CoreError::NotFound)
        ));
        for before in [
            json!(0),
            json!(-1),
            json!("path"),
            json!(9_007_199_254_740_992u64),
        ] {
            let mut invalid = params.clone();
            invalid["before"] = before;
            assert!(runtime.plan_session_conversation_read(invalid).is_err());
        }
        for change in 0..4 {
            let mut plan = runtime
                .plan_session_conversation_read(params.clone())
                .unwrap();
            match change {
                0 => plan.runtime_epoch += 1,
                1 => {
                    plan.resume = ResumeRef::for_provider(
                        ResumeProvider::Codex,
                        uuid::Uuid::new_v4().to_string(),
                    )
                }
                2 => plan.account.as_mut().unwrap().account_id = "different".into(),
                _ => plan.project_id = "different".into(),
            }
            assert!(
                runtime
                    .complete_session_conversation_read(ObservedSessionConversation {
                        plan,
                        page: ConversationPage::default()
                    })
                    .is_err()
            );
        }
        let plan = runtime.plan_session_conversation_read(params).unwrap();
        let result = runtime
            .complete_session_conversation_read(ObservedSessionConversation {
                plan,
                page: ConversationPage {
                    available: true,
                    messages: vec![termloop_agents::ConversationMessage {
                        role: AgentHistoryPreviewRole::Assistant,
                        text: "Full\nanswer".into(),
                        truncated: false,
                    }],
                    next_before: Some(30),
                    incomplete: false,
                },
            })
            .unwrap();
        assert_eq!(
            result,
            json!({"status":"available","messages":[{"role":"assistant","text":"Full\nanswer","truncated":false}],"next_before":30,"incomplete":false})
        );
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}
