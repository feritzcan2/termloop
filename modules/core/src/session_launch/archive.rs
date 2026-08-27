use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use termloop_domain::{SessionArchiveOperation, SessionArchiveOperationState, SessionKind};
use uuid::Uuid;

use crate::{CoreError, CoreRuntime, required_string, store_error, terminal_error};

const SESSION_ARCHIVE_PREVIEW_TTL: Duration = Duration::from_secs(30);
const SESSION_ARCHIVE_PREVIEW_CAP: usize = 64;

#[derive(Clone)]
pub(crate) struct SessionArchivePreviewTicket {
    session_id: String,
    runtime_epoch: u64,
    deadline: termloop_platform::MonotonicDeadline,
    can_archive: bool,
}

impl SessionArchivePreviewTicket {
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }
}

#[derive(Clone)]
pub struct SessionArchiveRetirementPlan {
    session_id: String,
    operation_id: String,
}

impl SessionArchiveRetirementPlan {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
}

impl CoreRuntime {
    pub(crate) fn reconcile_session_archive_operations(&mut self) {
        for operation in self.store.session_archive_operations().to_vec() {
            let absent = self
                .terminal
                .contains_session(&operation.session_id)
                .is_ok_and(|live| !live);
            if absent
                && self
                    .store
                    .commit_session_archive(
                        &self.write_authority,
                        &operation.session_id,
                        &operation.operation_id,
                        termloop_platform::current_epoch_ms(),
                    )
                    .is_ok()
            {
                continue;
            }
            let _ = self.store.mark_session_archive_recovery_attention(
                &self.write_authority,
                &operation.session_id,
                &operation.operation_id,
            );
        }
    }

    fn session_archive_blocker(&self, session_id: &str) -> Result<Option<&'static str>, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if session.archived_at_epoch_ms.is_some() {
            return Ok(Some("alreadyArchived"));
        }
        if self
            .store
            .session_archive_operations()
            .iter()
            .any(|operation| operation.session_id == session_id)
        {
            return Ok(Some("archiveInProgress"));
        }
        if session.kind != SessionKind::Agent {
            return Ok(Some("notAgent"));
        }
        if session.ask_to_source_session_id.is_some()
            || matches!(
                session.process.template_ref.as_deref(),
                Some(
                    "builtin.agent.ask-to-helper"
                        | "builtin.steward.executor"
                        | "builtin.worker.executor"
                )
            )
        {
            return Ok(Some("assistantRole"));
        }
        if self.session_is_archive_suspended(session_id) {
            return Ok(Some("taskArchived"));
        }
        if session
            .resume_ref
            .as_ref()
            .is_none_or(|resume_ref| !resume_ref.validate())
        {
            return Ok(Some("resumeUnavailable"));
        }
        if session.lifecycle_state != "running"
            || self.resume_reservations.contains(session_id)
            || self
                .provider_history_repair_reservations
                .contains(session_id)
            || !self
                .terminal
                .contains_session(session_id)
                .map_err(terminal_error)?
        {
            return Ok(Some("notRunning"));
        }
        Ok(None)
    }

    pub(crate) fn inspect_session_archive(&mut self, params: Value) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        let blocker = self.session_archive_blocker(&session_id)?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        self.session_archive_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        if self.session_archive_previews.len() >= SESSION_ARCHIVE_PREVIEW_CAP {
            self.session_archive_previews.pop_front();
        }
        let mut archive_ticket = termloop_platform::generate_opaque_runtime_token();
        while self
            .session_archive_previews
            .iter()
            .any(|(ticket, _)| ticket == &archive_ticket)
        {
            archive_ticket = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = termloop_platform::MonotonicDeadline::after(SESSION_ARCHIVE_PREVIEW_TTL)
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.session_archive_previews.push_back((
            archive_ticket.clone(),
            SessionArchivePreviewTicket {
                session_id,
                runtime_epoch: session.runtime_epoch,
                deadline,
                can_archive: blocker.is_none(),
            },
        ));
        Ok(json!({
            "session": self.project_session(&session),
            "archive_ticket": archive_ticket,
            "expires_in_ms": 30_000,
            "can_archive": blocker.is_none(),
            "blocker": blocker,
        }))
    }

    pub(crate) fn archive_session(&mut self, params: Value) -> Result<Value, CoreError> {
        let plan = self.prepare_session_archive(params)?;
        if self
            .terminal
            .contains_session(plan.session_id())
            .map_err(terminal_error)?
        {
            self.terminal
                .terminate(plan.session_id())
                .map_err(terminal_error)?;
        }
        self.complete_session_archive(plan)
    }

    pub fn prepare_session_archive(
        &mut self,
        params: Value,
    ) -> Result<SessionArchiveRetirementPlan, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        let operation_id = required_string(&params, "operationId")?;
        Uuid::parse_str(&operation_id)
            .map_err(|_| CoreError::InvalidParams("operationId".into()))?;
        let archive_ticket = required_string(&params, "archiveTicket")?;
        let index = self
            .session_archive_previews
            .iter()
            .position(|(ticket, _)| ticket == &archive_ticket)
            .ok_or_else(|| CoreError::InvalidParams("archiveTicket".into()))?;
        let (_, preview) = self
            .session_archive_previews
            .remove(index)
            .expect("preview index was present");
        if preview.deadline.remaining().is_none()
            || preview.session_id != session_id
            || !preview.can_archive
        {
            return Err(CoreError::InvalidParams("archiveTicket".into()));
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if session.runtime_epoch != preview.runtime_epoch
            || self.session_archive_blocker(&session_id)?.is_some()
        {
            return Err(CoreError::InvalidParams("archiveTicket".into()));
        }
        self.store
            .begin_session_archive(
                &self.write_authority,
                SessionArchiveOperation {
                    operation_id: operation_id.clone(),
                    session_id: session_id.clone(),
                    project_id: session.project_id.clone(),
                    runtime_epoch: session.runtime_epoch,
                    state: SessionArchiveOperationState::Prepared,
                    requested_at_epoch_ms: termloop_platform::current_epoch_ms(),
                },
            )
            .map_err(store_error)?;
        Ok(SessionArchiveRetirementPlan {
            session_id,
            operation_id,
        })
    }

    pub fn detach_session_archive_runtime(
        &mut self,
        plan: &SessionArchiveRetirementPlan,
    ) -> Option<crate::CodexRuntime> {
        self.agent_observations.remove(plan.session_id());
        self.agent_conversation_activity.remove(plan.session_id());
        self.resume_ready.remove(plan.session_id());
        self.mcp_authorizer.remove(plan.session_id());
        self.codex_runtimes.remove(plan.session_id())
    }

    pub fn mark_session_archive_recovery_attention(
        &mut self,
        plan: &SessionArchiveRetirementPlan,
    ) -> Result<(), CoreError> {
        self.store
            .mark_session_archive_recovery_attention(
                &self.write_authority,
                plan.session_id(),
                plan.operation_id(),
            )
            .map_err(store_error)?;
        Ok(())
    }

    pub fn complete_session_archive(
        &mut self,
        plan: SessionArchiveRetirementPlan,
    ) -> Result<Value, CoreError> {
        if self
            .terminal
            .contains_session(plan.session_id())
            .map_or(true, |live| live)
        {
            self.mark_session_archive_recovery_attention(&plan)?;
            return Err(CoreError::InvalidParams(
                "sessionArchiveRecoveryAttention".into(),
            ));
        }
        let session = self
            .store
            .commit_session_archive(
                &self.write_authority,
                plan.session_id(),
                plan.operation_id(),
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.agent_observations.remove(plan.session_id());
        self.agent_conversation_activity.remove(plan.session_id());
        self.resume_ready.remove(plan.session_id());
        self.codex_runtimes.remove(plan.session_id());
        self.mcp_authorizer.remove(plan.session_id());
        Ok(self.project_session(&session))
    }

    pub(crate) fn list_archived_sessions(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        Ok(Value::Array(
            self.store
                .sessions()
                .iter()
                .filter(|session| {
                    session.project_id == project_id && session.archived_at_epoch_ms.is_some()
                })
                .map(|session| self.project_session(session))
                .collect(),
        ))
    }

    pub(crate) fn restore_archived_session(&mut self, params: Value) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if session.archived_at_epoch_ms.is_none() {
            return Ok(self.project_session(&session));
        }
        if self.store.tasks().iter().any(|task| {
            task.archived_at_epoch_ms.is_some()
                && task.worktree.as_ref().is_some_and(|worktree| {
                    crate::task_worktree::comparison_key(Path::new(&worktree.path))
                        .ok()
                        .zip(
                            crate::task_worktree::comparison_key(Path::new(&session.process.cwd))
                                .ok(),
                        )
                        .is_some_and(|(root, cwd)| root.contains_or_equals(&cwd))
                })
        }) {
            return Err(CoreError::TaskArchived {
                task_id: "containingTask".into(),
            });
        }
        let session = self
            .store
            .restore_archived_session_descriptor(&self.write_authority, &session_id)
            .map_err(store_error)?;
        Ok(self.project_session(&session))
    }

    pub(crate) fn delete_archived_session(&mut self, params: Value) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        if self.resume_reservations.contains(&session_id)
            || self
                .provider_history_repair_reservations
                .contains(&session_id)
            || self.codex_runtimes.contains_key(&session_id)
            || self
                .terminal
                .contains_session(&session_id)
                .map_err(terminal_error)?
        {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        self.store
            .delete_archived_session_descriptor(&self.write_authority, &session_id)
            .map_err(store_error)?;
        self.agent_observations.remove(&session_id);
        self.agent_conversation_activity.remove(&session_id);
        self.resume_ready.remove(&session_id);
        Ok(json!({ "sessionId": session_id, "closed": true }))
    }

    pub(crate) fn ensure_session_not_individually_archived(
        &self,
        session_id: &str,
    ) -> Result<(), CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if session.archived_at_epoch_ms.is_some() {
            return Err(CoreError::InvalidParams("sessionArchived".into()));
        }
        if self
            .store
            .session_archive_operations()
            .iter()
            .any(|operation| operation.session_id == session_id)
        {
            return Err(CoreError::InvalidParams("sessionArchiveInProgress".into()));
        }
        Ok(())
    }
}
