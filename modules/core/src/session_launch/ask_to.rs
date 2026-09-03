use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
#[cfg(test)]
use std::time::Duration;

use serde_json::{Value, json};
use termloop_domain::AskToContinuation;
use uuid::Uuid;

use crate::{CoreError, CoreRuntime, store_error};

use super::{AgentLaunchPlan, AgentMcpRole, TaskLaunchGuard};

const PROJECT_LIVE_HELPER_LIMIT: usize = 4;
const DAEMON_LIVE_HELPER_LIMIT: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AskToStatus {
    Pending,
    Completed(String),
    HelperUnavailable,
    RequestGone,
}

impl AskToStatus {
    fn name(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed(_) => "completed",
            Self::HelperUnavailable => "helperUnavailable",
            Self::RequestGone => "requestGone",
        }
    }
}

pub(crate) struct AskToRequest {
    request_id: String,
    conversation_id: String,
    source_session_id: String,
    source_runtime_epoch: u64,
    helper_session_id: String,
    project_id: String,
    idempotency_key: Option<String>,
    status: AskToStatus,
    reply_delivered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AskToGeneratedInputCompletion {
    FollowUp { request_id: String },
    Reply { request_id: String },
}

impl AskToGeneratedInputCompletion {
    fn request_id(&self) -> &str {
        match self {
            Self::FollowUp { request_id } | Self::Reply { request_id } => request_id,
        }
    }

    fn template_ref(&self) -> &'static str {
        match self {
            Self::FollowUp { .. } => "builtin.agent.ask-to-followup",
            Self::Reply { .. } => "builtin.agent.ask-to-reply",
        }
    }
}

#[derive(Clone)]
pub(crate) struct AskToConversation {
    source_session_id: String,
    source_runtime_epoch: u64,
    helper_session_id: String,
    helper_runtime_epoch: u64,
    project_id: String,
    target: String,
}

#[derive(Clone)]
pub struct McpAuthorizer {
    entries: Arc<RwLock<HashMap<String, AgentMcpCapability>>>,
}

impl Default for McpAuthorizer {
    fn default() -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

struct AgentMcpCapability {
    token: String,
    principal: McpPrincipal,
    command_authorized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpPrincipal {
    session_id: String,
    runtime_epoch: u64,
    role: AgentMcpRole,
}

impl McpPrincipal {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn role(&self) -> &AgentMcpRole {
        &self.role
    }

    pub fn runtime_epoch(&self) -> u64 {
        self.runtime_epoch
    }
}

impl McpAuthorizer {
    pub fn authenticate(&self, token: &str) -> Result<McpPrincipal, CoreError> {
        self.authenticate_entry(token, true)
    }

    pub fn authenticate_transport(&self, token: &str) -> Result<McpPrincipal, CoreError> {
        self.authenticate_entry(token, false)
    }

    fn authenticate_entry(
        &self,
        token: &str,
        require_command_authority: bool,
    ) -> Result<McpPrincipal, CoreError> {
        let entries = self
            .entries
            .read()
            .map_err(|_| CoreError::CapabilityDenied)?;
        entries
            .values()
            .find(|entry| {
                (!require_command_authority || entry.command_authorized)
                    && crate::capability_equal(entry.token.as_bytes(), token.as_bytes())
            })
            .map(|entry| entry.principal.clone())
            .ok_or(CoreError::CapabilityDenied)
    }

    pub(crate) fn register(
        &self,
        session_id: String,
        runtime_epoch: u64,
        role: AgentMcpRole,
        token: String,
    ) {
        self.register_with_command_authority(session_id, runtime_epoch, role, token, true);
    }

    pub(crate) fn register_provisional(
        &self,
        session_id: String,
        runtime_epoch: u64,
        role: AgentMcpRole,
        token: String,
    ) {
        self.register_with_command_authority(session_id, runtime_epoch, role, token, false);
    }

    fn register_with_command_authority(
        &self,
        session_id: String,
        runtime_epoch: u64,
        role: AgentMcpRole,
        token: String,
        command_authorized: bool,
    ) {
        if let Ok(mut entries) = self.entries.write() {
            entries.insert(
                session_id.clone(),
                AgentMcpCapability {
                    token,
                    command_authorized,
                    principal: McpPrincipal {
                        session_id,
                        runtime_epoch,
                        role,
                    },
                },
            );
        }
    }

    pub(crate) fn remove_provisional(&self, session_id: &str, runtime_epoch: u64) {
        if let Ok(mut entries) = self.entries.write()
            && entries.get(session_id).is_some_and(|entry| {
                !entry.command_authorized && entry.principal.runtime_epoch == runtime_epoch
            })
        {
            entries.remove(session_id);
        }
    }

    pub(crate) fn remove(&self, session_id: &str) {
        if let Ok(mut entries) = self.entries.write() {
            entries.remove(session_id);
        }
    }

    pub(crate) fn role_for_session(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<AgentMcpRole, CoreError> {
        let entries = self
            .entries
            .read()
            .map_err(|_| CoreError::CapabilityDenied)?;
        entries
            .get(session_id)
            .filter(|entry| {
                entry.command_authorized && entry.principal.runtime_epoch == runtime_epoch
            })
            .map(|entry| entry.principal.role.clone())
            .ok_or(CoreError::CapabilityDenied)
    }

    fn bind_helper_request(
        &self,
        session_id: &str,
        runtime_epoch: u64,
        request_id: Option<String>,
    ) -> Result<(), CoreError> {
        let mut entries = self
            .entries
            .write()
            .map_err(|_| CoreError::CapabilityDenied)?;
        let entry = entries
            .get_mut(session_id)
            .filter(|entry| {
                entry.principal.runtime_epoch == runtime_epoch
                    && matches!(entry.principal.role, AgentMcpRole::Helper { .. })
            })
            .ok_or(CoreError::ConversationUnavailable)?;
        entry.principal.role = AgentMcpRole::Helper { request_id };
        Ok(())
    }
}

pub struct AskToLaunchCompletion {
    pub session: Value,
    pub acknowledgement: Value,
}

pub enum AskToPlanOutcome {
    Existing(Value),
    FollowUp(Value),
    Launch(Box<AgentLaunchPlan>),
}

pub struct AskToInput {
    pub target: String,
    pub message: String,
    pub idempotency_key: Option<String>,
    pub conversation_id: Option<String>,
}

impl CoreRuntime {
    pub(crate) fn source_has_in_flight_ask_to(&self, source_session_id: &str) -> bool {
        self.ask_to_by_source
            .get(source_session_id)
            .and_then(|request_id| self.ask_to_requests.get(request_id))
            .is_some_and(|request| {
                request.status == AskToStatus::Pending
                    || matches!(request.status, AskToStatus::Completed(_))
                        && !request.reply_delivered
            })
    }

    pub fn mcp_authorizer(&self) -> McpAuthorizer {
        self.mcp_authorizer.clone()
    }

    pub fn plan_ask_to(
        &mut self,
        token: &str,
        params: AskToInput,
    ) -> Result<AskToPlanOutcome, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        if !matches!(
            principal.role,
            AgentMcpRole::Interactive | AgentMcpRole::Improver { .. } | AgentMcpRole::Helper { .. }
        ) {
            return Err(CoreError::CapabilityDenied);
        }
        if !termloop_agents::supports_tracked_helpers(&params.target)
            || params.message.trim().is_empty()
            || params.message.chars().count() > 32_768
            || params
                .idempotency_key
                .as_ref()
                .is_some_and(|key| key.trim().is_empty() || key.chars().count() > 128)
            || params
                .conversation_id
                .as_ref()
                .is_some_and(|id| id.trim().is_empty() || id.chars().count() > 128)
            || params
                .message
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err(CoreError::InvalidParams("askTo".into()));
        }
        let source_session_id = principal.session_id;
        if let Some(current_id) = self.ask_to_by_source.get(&source_session_id).cloned() {
            let current = self
                .ask_to_requests
                .get(&current_id)
                .ok_or(CoreError::AskToRequestUnavailable)?;
            if params.idempotency_key.is_some() && params.idempotency_key == current.idempotency_key
            {
                return Ok(AskToPlanOutcome::Existing(request_value(current)));
            }
            if current.status == AskToStatus::Pending
                || matches!(current.status, AskToStatus::Completed(_)) && !current.reply_delivered
            {
                return Err(CoreError::AskToInProgress {
                    request_id: current.request_id.clone(),
                    status: current.status.name().into(),
                });
            }
        }

        let source = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == source_session_id
                    && session.kind == termloop_domain::SessionKind::Agent
                    && session.lifecycle_state == "running"
                    && session.runtime_epoch == principal.runtime_epoch
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        if let Some(conversation_id) = params.conversation_id.clone() {
            return self.plan_ask_to_follow_up(
                &source,
                principal.runtime_epoch,
                &conversation_id,
                params,
            );
        }
        let (daemon_helper_count, project_helper_count) =
            self.live_helper_counts(&source.project_id);
        if daemon_helper_count >= DAEMON_LIVE_HELPER_LIMIT {
            return Err(CoreError::HelperCapacityExhausted);
        }
        if project_helper_count >= PROJECT_LIVE_HELPER_LIMIT {
            return Err(CoreError::HelperCapacityExhausted);
        }

        let target = params.target;
        self.observation_transport
            .as_ref()
            .filter(|transport| transport.mcp_http_supported(&target))
            .ok_or(CoreError::AgentUnsupported)?;
        if termloop_agents::executable_for(&target).is_none() {
            return Err(CoreError::AgentUnsupported);
        }
        self.ensure_launch_not_reserved(std::path::Path::new(&source.process.cwd))?;

        let request_id = Uuid::new_v4().to_string();
        let conversation_id = Uuid::new_v4().to_string();
        let helper_session_id = Uuid::new_v4().to_string();
        let task_guard = source
            .resume_launch_guard
            .as_ref()
            .map(|guard| {
                let proof = self
                    .store
                    .managed_worktrees()
                    .iter()
                    .find(|proof| {
                        proof.task_id == guard.task_id
                            && proof.operation_id == guard.managed_worktree_operation_id
                            && proof.worktree_generation == guard.worktree_generation
                    })
                    .ok_or_else(|| CoreError::TaskWorktreeUnavailable {
                        task_id: guard.task_id.clone(),
                        reason: crate::TaskWorktreeUnavailableReason::ManagedProofMissing,
                    })?;
                Ok::<_, CoreError>(TaskLaunchGuard {
                    task_id: guard.task_id.clone(),
                    managed_worktree_operation_id: guard.managed_worktree_operation_id.clone(),
                    worktree_generation: guard.worktree_generation,
                    cwd: guard.path.clone(),
                    repository_common_dir: proof.repository_common_dir.clone(),
                    branch_ref: proof.branch_ref.clone(),
                })
            })
            .transpose()?;
        if task_guard
            .as_ref()
            .is_some_and(|guard| guard.cwd != source.process.cwd)
        {
            return Err(CoreError::TaskWorktreeUnavailable {
                task_id: task_guard
                    .as_ref()
                    .expect("checked task guard")
                    .task_id
                    .clone(),
                reason: crate::TaskWorktreeUnavailableReason::ManagedProofMismatch,
            });
        }
        let mut plan = self.plan_agent_launch_at(
            source.project_id.clone(),
            source.process.cwd.clone(),
            target.clone(),
            helper_session_id.clone(),
            AgentMcpRole::Helper {
                request_id: Some(request_id.clone()),
            },
        )?;
        plan.task_guard = task_guard;
        plan.task_guard_requires_observation = plan.task_guard.is_some();
        plan.helper_prompt = Some((request_id.clone(), params.message));
        plan.ask_to_source_session_id = Some(source_session_id.clone());
        plan.ask_to_continuation = Some(AskToContinuation {
            conversation_id: conversation_id.clone(),
            current_request_id: Some(request_id.clone()),
        });

        if let Some(previous_id) = self
            .ask_to_by_source
            .insert(source_session_id.clone(), request_id.clone())
        {
            self.ask_to_requests.remove(&previous_id);
        }
        self.ask_to_requests.insert(
            request_id.clone(),
            AskToRequest {
                request_id,
                conversation_id: conversation_id.clone(),
                source_session_id: source_session_id.clone(),
                source_runtime_epoch: principal.runtime_epoch,
                helper_session_id: helper_session_id.clone(),
                project_id: source.project_id.clone(),
                idempotency_key: params.idempotency_key,
                status: AskToStatus::Pending,
                reply_delivered: false,
            },
        );
        self.ask_to_conversations.insert(
            conversation_id,
            AskToConversation {
                source_session_id,
                source_runtime_epoch: principal.runtime_epoch,
                helper_session_id,
                helper_runtime_epoch: self.runtime_epoch,
                project_id: source.project_id,
                target,
            },
        );
        Ok(AskToPlanOutcome::Launch(Box::new(plan)))
    }

    fn plan_ask_to_follow_up(
        &mut self,
        source: &termloop_domain::SessionRecord,
        source_runtime_epoch: u64,
        conversation_id: &str,
        params: AskToInput,
    ) -> Result<AskToPlanOutcome, CoreError> {
        let conversation = self
            .ask_to_conversations
            .get(conversation_id)
            .filter(|conversation| {
                conversation.source_session_id == source.id
                    && conversation.source_runtime_epoch == source_runtime_epoch
                    && conversation.project_id == source.project_id
                    && conversation.target == params.target
            })
            .cloned()
            .ok_or(CoreError::ConversationUnavailable)?;
        let helper = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == conversation.helper_session_id
                    && session.project_id == conversation.project_id
                    && session.runtime_epoch == conversation.helper_runtime_epoch
                    && session.lifecycle_state == "running"
                    && session.process.agent_id.as_deref() == Some(conversation.target.as_str())
                    && session.process.template_ref.as_deref()
                        == Some("builtin.agent.ask-to-helper")
            })
            .cloned()
            .ok_or(CoreError::ConversationUnavailable)?;
        if !self
            .terminal
            .session_is_running(&helper.id, helper.runtime_epoch)
            .unwrap_or(false)
        {
            self.ask_to_conversations.remove(conversation_id);
            return Err(CoreError::ConversationUnavailable);
        }
        let observation = self
            .agent_observations
            .get(&helper.id)
            .and_then(|capability| capability.observation)
            .ok_or(CoreError::ConversationUnavailable)?;
        match observation.state {
            termloop_agents::AgentState::Idle
                if matches!(
                    observation.source,
                    termloop_agents::AgentSignalSource::Hook
                        | termloop_agents::AgentSignalSource::DaemonBridge
                ) => {}
            termloop_agents::AgentState::Working | termloop_agents::AgentState::AwaitingInput => {
                return Err(CoreError::ConversationBusy);
            }
            _ => return Err(CoreError::ConversationUnavailable),
        }

        let request_id = Uuid::new_v4().to_string();
        let prompt = termloop_invocation::ask_to_follow_up_prompt(&request_id, &params.message)
            .map_err(|_| CoreError::InvalidParams("message".into()))?;
        self.submit_generated_terminal_input(&helper.id, prompt.terminal_submission())?;
        if let Some(previous_id) = self
            .ask_to_by_source
            .insert(source.id.clone(), request_id.clone())
        {
            self.ask_to_requests.remove(&previous_id);
        }
        self.ask_to_requests.insert(
            request_id.clone(),
            AskToRequest {
                request_id: request_id.clone(),
                conversation_id: conversation_id.to_owned(),
                source_session_id: source.id.clone(),
                source_runtime_epoch,
                helper_session_id: helper.id.clone(),
                project_id: source.project_id.clone(),
                idempotency_key: params.idempotency_key,
                status: AskToStatus::Pending,
                reply_delivered: false,
            },
        );
        self.ask_to_delivery_completions.insert(
            helper.id.clone(),
            AskToGeneratedInputCompletion::FollowUp {
                request_id: request_id.clone(),
            },
        );
        let request = self
            .ask_to_requests
            .get(&request_id)
            .ok_or(CoreError::AskToRequestUnavailable)?;
        Ok(AskToPlanOutcome::FollowUp(request_value(request)))
    }

    pub fn fail_ask_to_launch(&mut self, request_id: &str) {
        let mut failed_conversation = None;
        if let Some(request) = self.ask_to_requests.get_mut(request_id)
            && request.status == AskToStatus::Pending
        {
            request.status = AskToStatus::HelperUnavailable;
            failed_conversation = Some(request.conversation_id.clone());
        }
        if let Some(conversation_id) = failed_conversation {
            self.ask_to_conversations.remove(&conversation_id);
        }
    }

    pub fn complete_ask_to_launch(
        &mut self,
        request_id: &str,
        plan: &mut AgentLaunchPlan,
    ) -> Result<AskToLaunchCompletion, CoreError> {
        let request = self
            .ask_to_requests
            .get(request_id)
            .filter(|request| {
                request.status == AskToStatus::Pending
                    && request.helper_session_id == plan.session_id
                    && self.ask_to_by_source.get(&request.source_session_id)
                        == Some(&request.request_id)
            })
            .ok_or(CoreError::AskToRequestUnavailable)?;
        let source_is_live = self.store.sessions().iter().any(|session| {
            session.id == request.source_session_id && session.lifecycle_state == "running"
        });
        if !source_is_live {
            return Err(CoreError::AskToRequestGone);
        }
        let session = self.complete_agent_launch(plan)?;
        let acknowledgement = self
            .ask_to_requests
            .get(request_id)
            .map(request_value)
            .ok_or(CoreError::AskToRequestUnavailable)?;
        Ok(AskToLaunchCompletion {
            session,
            acknowledgement,
        })
    }

    pub fn reply_to_request(
        &mut self,
        token: &str,
        request_id: &str,
        message: String,
    ) -> Result<Value, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        let helper_session_id = principal.session_id;
        match principal.role {
            AgentMcpRole::Helper {
                request_id: Some(allowed),
            } if allowed == request_id => {}
            _ => return Err(CoreError::CapabilityDenied),
        }
        if message.trim().is_empty()
            || message.chars().count() > 32_768
            || message
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err(CoreError::InvalidParams("message".into()));
        }
        let status = self
            .ask_to_requests
            .get(request_id)
            .filter(|request| request.helper_session_id == helper_session_id)
            .ok_or(CoreError::AskToRequestUnavailable)?
            .status
            .clone();
        match status {
            AskToStatus::Pending => {
                let request = self
                    .ask_to_requests
                    .get_mut(request_id)
                    .ok_or(CoreError::AskToRequestUnavailable)?;
                request.status = AskToStatus::Completed(message);
                self.try_deliver_ask_to_reply(request_id);
                Ok(json!({ "requestId": request_id, "status": "submitting" }))
            }
            AskToStatus::Completed(existing) if existing == message => {
                self.try_deliver_ask_to_reply(request_id);
                Ok(json!({
                    "requestId": request_id,
                    "status": "alreadyCompleted"
                }))
            }
            AskToStatus::Completed(_) => Err(CoreError::AskToAlreadyReplied),
            AskToStatus::RequestGone => Err(CoreError::AskToRequestGone),
            AskToStatus::HelperUnavailable => Err(CoreError::AskToRequestUnavailable),
        }
    }

    pub(crate) fn try_deliver_ask_to_reply_for_source(&mut self, source_session_id: &str) {
        if let Some(request_id) = self.ask_to_by_source.get(source_session_id).cloned() {
            self.try_deliver_ask_to_reply(&request_id);
        }
    }

    fn try_deliver_ask_to_reply(&mut self, request_id: &str) {
        let Some(request) = self.ask_to_requests.get(request_id) else {
            return;
        };
        let AskToStatus::Completed(message) = &request.status else {
            return;
        };
        if request.reply_delivered {
            return;
        }
        if self
            .ask_to_delivery_completions
            .get(&request.source_session_id)
            .is_some_and(|completion| completion.request_id() == request_id)
        {
            return;
        }
        let source_is_running = self.store.sessions().iter().any(|session| {
            session.id == request.source_session_id
                && session.runtime_epoch == request.source_runtime_epoch
                && session.lifecycle_state == "running"
        });
        if !source_is_running {
            return;
        }
        let Ok(prompt) = termloop_invocation::ask_to_reply_prompt(
            &request.request_id,
            &request.conversation_id,
            &request.helper_session_id,
            message,
        ) else {
            return;
        };
        let source_session_id = request.source_session_id.clone();
        if self
            .submit_generated_terminal_input(&source_session_id, prompt.terminal_submission())
            .is_ok()
        {
            self.ask_to_delivery_completions.insert(
                source_session_id,
                AskToGeneratedInputCompletion::Reply {
                    request_id: request_id.to_owned(),
                },
            );
        }
    }

    pub(crate) fn complete_ask_to_generated_input(
        &mut self,
        target_session_id: &str,
        runtime_epoch: u64,
    ) -> Result<bool, CoreError> {
        let Some(completion) = self
            .ask_to_delivery_completions
            .get(target_session_id)
            .cloned()
        else {
            return Ok(false);
        };
        if self
            .generated_input_deliveries
            .provenance(target_session_id, runtime_epoch)
            .is_none_or(|provenance| provenance.template_ref != completion.template_ref())
        {
            // An unattributed delivery deliberately leaves its feature
            // completion pending. A later, unrelated generated submission may
            // replace the terminal record, but its ACK must never complete the
            // older Ask-To operation.
            return Ok(false);
        }
        let (
            request_id,
            conversation_id,
            source_session_id,
            source_runtime_epoch,
            helper_session_id,
        ) = {
            let request = self
                .ask_to_requests
                .get(completion.request_id())
                .ok_or(CoreError::AskToRequestUnavailable)?;
            (
                request.request_id.clone(),
                request.conversation_id.clone(),
                request.source_session_id.clone(),
                request.source_runtime_epoch,
                request.helper_session_id.clone(),
            )
        };
        match completion {
            AskToGeneratedInputCompletion::FollowUp { .. } => {
                if helper_session_id != target_session_id {
                    return Err(CoreError::ConversationUnavailable);
                }
                let helper_runtime_epoch = self
                    .store
                    .sessions()
                    .iter()
                    .find(|session| session.id == helper_session_id)
                    .map(|session| session.runtime_epoch)
                    .filter(|current| *current == runtime_epoch)
                    .ok_or(CoreError::ConversationUnavailable)?;
                self.store
                    .set_ask_to_current_request(
                        &self.write_authority,
                        &helper_session_id,
                        &conversation_id,
                        Some(&request_id),
                    )
                    .map_err(store_error)?;
                if let Err(error) = self.mcp_authorizer.bind_helper_request(
                    &helper_session_id,
                    helper_runtime_epoch,
                    Some(request_id.clone()),
                ) {
                    let _ = self.store.set_ask_to_current_request(
                        &self.write_authority,
                        &helper_session_id,
                        &conversation_id,
                        None,
                    );
                    return Err(error);
                }
            }
            AskToGeneratedInputCompletion::Reply { .. } => {
                if source_session_id != target_session_id || source_runtime_epoch != runtime_epoch {
                    return Err(CoreError::ConversationUnavailable);
                }
                let helper_runtime_epoch = self
                    .store
                    .sessions()
                    .iter()
                    .find(|session| session.id == helper_session_id)
                    .map(|session| session.runtime_epoch)
                    .ok_or(CoreError::ConversationUnavailable)?;
                self.store
                    .set_ask_to_current_request(
                        &self.write_authority,
                        &helper_session_id,
                        &conversation_id,
                        None,
                    )
                    .map_err(store_error)?;
                if let Err(error) = self.mcp_authorizer.bind_helper_request(
                    &helper_session_id,
                    helper_runtime_epoch,
                    None,
                ) {
                    let _ = self.store.set_ask_to_current_request(
                        &self.write_authority,
                        &helper_session_id,
                        &conversation_id,
                        Some(&request_id),
                    );
                    return Err(error);
                }
                self.ask_to_requests
                    .get_mut(&request_id)
                    .ok_or(CoreError::AskToRequestUnavailable)?
                    .reply_delivered = true;
            }
        }
        self.ask_to_delivery_completions.remove(target_session_id);
        Ok(true)
    }

    pub(crate) fn retire_ask_to_session(&mut self, session_id: &str) {
        self.mcp_authorizer.remove(session_id);
        let related_request_ids = self
            .ask_to_requests
            .values()
            .filter(|request| {
                request.source_session_id == session_id || request.helper_session_id == session_id
            })
            .map(|request| request.request_id.clone())
            .collect::<HashSet<_>>();
        self.ask_to_delivery_completions
            .retain(|target_session_id, completion| {
                target_session_id != session_id
                    && !related_request_ids.contains(completion.request_id())
            });
        self.ask_to_conversations.retain(|_, conversation| {
            conversation.source_session_id != session_id
                && conversation.helper_session_id != session_id
        });
        if let Some(request_id) = self.ask_to_by_source.remove(session_id)
            && let Some(mut request) = self.ask_to_requests.remove(&request_id)
            && self.helper_session_is_live(&request.helper_session_id)
        {
            request.status = AskToStatus::RequestGone;
            self.ask_to_requests.insert(request_id, request);
        }
        let mut remove = Vec::new();
        for (request_id, request) in &mut self.ask_to_requests {
            if request.helper_session_id != session_id {
                continue;
            }
            if request.status == AskToStatus::Pending {
                request.status = AskToStatus::HelperUnavailable;
            } else if request.status == AskToStatus::RequestGone {
                remove.push(request_id.clone());
            }
        }
        for request_id in remove {
            self.ask_to_requests.remove(&request_id);
        }
    }

    pub(crate) fn suspend_ask_to_session_for_resume(&mut self, session_id: &str) {
        self.mcp_authorizer.remove(session_id);
    }

    pub(crate) fn refresh_ask_to_runtime_epoch(&mut self, session_id: &str, runtime_epoch: u64) {
        for conversation in self.ask_to_conversations.values_mut() {
            if conversation.source_session_id == session_id {
                conversation.source_runtime_epoch = runtime_epoch;
            }
            if conversation.helper_session_id == session_id {
                conversation.helper_runtime_epoch = runtime_epoch;
            }
        }
        for request in self.ask_to_requests.values_mut() {
            if request.source_session_id == session_id {
                request.source_runtime_epoch = runtime_epoch;
            }
        }
        self.try_deliver_ask_to_reply_for_source(session_id);
    }

    pub(crate) fn forget_ask_to_session(&mut self, session_id: &str) {
        self.retire_ask_to_session(session_id);
    }

    fn helper_session_is_live(&self, session_id: &str) -> bool {
        self.store.sessions().iter().any(|session| {
            session.id == session_id
                && session.lifecycle_state == "running"
                && session.process.template_ref.as_deref() == Some("builtin.agent.ask-to-helper")
        })
    }

    fn live_helper_counts(&self, project_id: &str) -> (usize, usize) {
        let live_sessions = self.store.sessions().iter().filter(|session| {
            session.lifecycle_state == "running"
                && session.process.template_ref.as_deref() == Some("builtin.agent.ask-to-helper")
        });
        let mut daemon = 0;
        let mut project = 0;
        for session in live_sessions {
            daemon += 1;
            project += usize::from(session.project_id == project_id);
        }
        for request in self.ask_to_requests.values().filter(|request| {
            request.status == AskToStatus::Pending
                && !self
                    .store
                    .sessions()
                    .iter()
                    .any(|session| session.id == request.helper_session_id)
        }) {
            daemon += 1;
            project += usize::from(request.project_id == project_id);
        }
        (daemon, project)
    }
}

fn request_value(request: &AskToRequest) -> Value {
    json!({
        "requestId": request.request_id,
        "conversationId": request.conversation_id,
        "status": request.status.name(),
    })
}

pub(crate) type AskToMaps = (
    HashMap<String, AskToRequest>,
    HashMap<String, String>,
    HashMap<String, AskToConversation>,
);

pub(crate) fn restore_ask_to_maps(
    sessions: &[termloop_domain::SessionRecord],
) -> Result<AskToMaps, CoreError> {
    let mut requests = HashMap::new();
    let mut requests_by_source = HashMap::new();
    let mut conversations = HashMap::new();
    for helper in sessions {
        let (Some(source_session_id), Some(continuation), Some(target)) = (
            helper.ask_to_source_session_id.as_ref(),
            helper.ask_to_continuation.as_ref(),
            helper.process.agent_id.as_ref(),
        ) else {
            continue;
        };
        let Some(source) = sessions.iter().find(|source| {
            source.id == *source_session_id
                && source.project_id == helper.project_id
                && source.kind == termloop_domain::SessionKind::Agent
        }) else {
            continue;
        };
        conversations.insert(
            continuation.conversation_id.clone(),
            AskToConversation {
                source_session_id: source.id.clone(),
                source_runtime_epoch: source.runtime_epoch,
                helper_session_id: helper.id.clone(),
                helper_runtime_epoch: helper.runtime_epoch,
                project_id: helper.project_id.clone(),
                target: target.clone(),
            },
        );
        let Some(request_id) = continuation.current_request_id.as_ref() else {
            continue;
        };
        requests_by_source.insert(source.id.clone(), request_id.clone());
        requests.insert(
            request_id.clone(),
            AskToRequest {
                request_id: request_id.clone(),
                conversation_id: continuation.conversation_id.clone(),
                source_session_id: source.id.clone(),
                source_runtime_epoch: source.runtime_epoch,
                helper_session_id: helper.id.clone(),
                project_id: helper.project_id.clone(),
                idempotency_key: None,
                status: AskToStatus::Pending,
                reply_delivered: false,
            },
        );
    }

    Ok((requests, requests_by_source, conversations))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentResumePlanOutcome, GeneratedInputDeliveryState};
    use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
    use termloop_store::Store;
    use termloop_terminal::TerminalService;

    const TRANSPORT_EVENT_TIMEOUT: Duration = Duration::from_secs(30);

    fn runtime_with_asker() -> (CoreRuntime, String, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "termloop-core-ask-to-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(root.join("state.json")).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 7).unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({ "name": "Ask-To", "folderPath": root }),
            )
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: "asker".into(),
                    project_id,
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd: root.display().to_string(),
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.interactive".into()),
                        template_version: Some(1),
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 7,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        let mut transport = crate::test_agent_observation_transport(root.join("provider"));
        for capability in transport.agents.values_mut() {
            capability.observation = crate::AgentObservationRuntimeTransport::None;
            capability.fresh_session_id_supported = false;
            capability.resume_supported = false;
            capability.native_fork_supported = false;
        }
        runtime.configure_agent_observations(transport);
        runtime.mcp_authorizer.register(
            "asker".into(),
            7,
            AgentMcpRole::Interactive,
            "asker-token".into(),
        );
        (runtime, "asker-token".into(), root)
    }

    fn input(key: Option<&str>) -> AskToInput {
        AskToInput {
            target: "claude".into(),
            message: "Review this change".into(),
            idempotency_key: key.map(str::to_owned),
            conversation_id: None,
        }
    }

    fn insert_running_helper(runtime: &mut CoreRuntime, helper_session_id: &str, project_id: &str) {
        let cwd = runtime.store.sessions()[0].process.cwd.clone();
        let request = runtime
            .ask_to_requests
            .values()
            .find(|request| request.helper_session_id == helper_session_id)
            .unwrap();
        let continuation = AskToContinuation {
            conversation_id: request.conversation_id.clone(),
            current_request_id: Some(request.request_id.clone()),
        };
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    launch_selection: Default::default(),
                    id: helper_session_id.into(),
                    project_id: project_id.into(),
                    name: None,
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "claude".into(),
                        args: vec![],
                        cwd,
                        agent_id: Some("claude".into()),
                        template_ref: Some("builtin.agent.ask-to-helper".into()),
                        template_version: Some(1),
                    },
                    lifecycle_state: "running".into(),
                    runtime_epoch: 7,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: Some("asker".into()),
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: Some(continuation),
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
    }

    fn reserve_pending_helper(runtime: &mut CoreRuntime, id: &str, project_id: &str) {
        runtime.ask_to_requests.insert(
            id.into(),
            AskToRequest {
                request_id: id.into(),
                conversation_id: format!("conversation-{id}"),
                source_session_id: format!("source-{id}"),
                source_runtime_epoch: 7,
                helper_session_id: format!("helper-{id}"),
                project_id: project_id.into(),
                idempotency_key: None,
                status: AskToStatus::Pending,
                reply_delivered: false,
            },
        );
    }

    #[test]
    fn authorizer_is_independent_role_scoped_and_revocable() {
        let authorizer = McpAuthorizer::default();
        authorizer.register(
            "session-a".into(),
            4,
            AgentMcpRole::Interactive,
            "secret-a".into(),
        );
        let principal = authorizer.authenticate("secret-a").unwrap();
        assert_eq!(principal.session_id(), "session-a");
        assert_eq!(principal.role(), &AgentMcpRole::Interactive);
        authorizer.register_provisional(
            "session-b".into(),
            5,
            AgentMcpRole::Interactive,
            "secret-b".into(),
        );
        assert_eq!(
            authorizer
                .authenticate_transport("secret-b")
                .unwrap()
                .session_id(),
            "session-b"
        );
        assert!(matches!(
            authorizer.authenticate("secret-b"),
            Err(CoreError::CapabilityDenied)
        ));
        authorizer.register(
            "session-b".into(),
            5,
            AgentMcpRole::Interactive,
            "secret-b".into(),
        );
        authorizer.remove_provisional("session-b", 5);
        assert!(authorizer.authenticate("secret-b").is_ok());
        authorizer.remove("session-b");
        assert!(matches!(
            authorizer.authenticate_transport("secret-b"),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            authorizer.authenticate("wrong"),
            Err(CoreError::CapabilityDenied)
        ));
        authorizer.remove("session-a");
        assert!(matches!(
            authorizer.authenticate("secret-a"),
            Err(CoreError::CapabilityDenied)
        ));
    }

    #[tokio::test]
    async fn authentication_does_not_wait_for_the_serialized_core_lock() {
        let (runtime, token, root) = runtime_with_asker();
        let authorizer = runtime.mcp_authorizer();
        let core = tokio::sync::Mutex::new(runtime);
        let _held_core = core.lock().await;
        let principal = tokio::time::timeout(Duration::from_millis(50), async {
            authorizer.authenticate(&token)
        })
        .await
        .expect("authentication must not wait for core")
        .unwrap();
        assert_eq!(principal.session_id(), "asker");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn idempotent_retry_recovers_request_and_helper_reply_remains_request_scoped() {
        let (mut runtime, token, root) = runtime_with_asker();
        let first = runtime.plan_ask_to(&token, input(Some("retry-1"))).unwrap();
        let plan = match first {
            AskToPlanOutcome::Launch(plan) => plan,
            AskToPlanOutcome::Existing(_) | AskToPlanOutcome::FollowUp(_) => {
                panic!("first call must launch")
            }
        };
        let request_id = plan.ask_to_request_id().unwrap().to_owned();
        let helper_id = plan.session_id().to_owned();
        let durable_state = std::fs::read_to_string(root.join("state.json")).unwrap();
        assert!(!durable_state.contains("Review this change"));
        assert!(!durable_state.contains(&request_id));
        assert!(!durable_state.contains("asker-token"));
        let recovered = runtime.plan_ask_to(&token, input(Some("retry-1"))).unwrap();
        let AskToPlanOutcome::Existing(value) = recovered else {
            panic!("retry must not launch another helper")
        };
        assert_eq!(value["requestId"], request_id);
        assert!(matches!(
            runtime.plan_ask_to(&token, input(Some("other"))),
            Err(CoreError::AskToInProgress { .. })
        ));

        runtime.mcp_authorizer.register(
            helper_id,
            7,
            AgentMcpRole::Helper {
                request_id: Some(request_id.clone()),
            },
            "helper-token".into(),
        );
        assert!(matches!(
            runtime.reply_to_request("helper-token", "another-request", "wrong".into()),
            Err(CoreError::CapabilityDenied)
        ));
        let delivered = runtime
            .reply_to_request("helper-token", &request_id, "Looks good".into())
            .unwrap();
        assert_eq!(delivered["status"], "submitting");
        let duplicate = runtime
            .reply_to_request("helper-token", &request_id, "Looks good".into())
            .unwrap();
        assert_eq!(duplicate["status"], "alreadyCompleted");
        assert!(matches!(
            runtime.reply_to_request("helper-token", &request_id, "conflicting".into()),
            Err(CoreError::AskToAlreadyReplied)
        ));
        assert_eq!(
            runtime.ask_to_requests[&request_id].status,
            AskToStatus::Completed("Looks good".into())
        );
        assert!(matches!(
            runtime.plan_ask_to(&token, input(Some("before-delivery"))),
            Err(CoreError::AskToInProgress { status, .. }) if status == "completed"
        ));
        runtime
            .ask_to_requests
            .get_mut(&request_id)
            .unwrap()
            .reply_delivered = true;
        assert!(matches!(
            runtime.plan_ask_to(&token, input(Some("after-delivery"))),
            Ok(AskToPlanOutcome::Launch(_))
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn helper_reply_clears_routing_only_after_provider_confirmation() {
        let (mut runtime, token, root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        let request_id = plan.ask_to_request_id().unwrap().to_owned();
        let helper_id = plan.session_id().to_owned();
        let project_id = runtime.store.sessions()[0].project_id.clone();
        insert_running_helper(&mut runtime, &helper_id, &project_id);
        runtime.mcp_authorizer.register(
            helper_id.clone(),
            7,
            AgentMcpRole::Helper {
                request_id: Some(request_id.clone()),
            },
            "helper-token".into(),
        );
        let (program, args) = termloop_platform::default_shell();
        runtime
            .terminal
            .spawn(termloop_terminal::PtySpawnSpec {
                session_id: "asker".into(),
                runtime_epoch: 7,
                program,
                args,
                cwd: root.display().to_string(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: false,
            })
            .unwrap();
        runtime.agent_observations.insert(
            "asker".into(),
            crate::AgentObservationCapability {
                token: Some("asker-observation-token".into()),
                runtime_epoch: 7,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: Some(termloop_agents::AgentObservation {
                    state: termloop_agents::AgentState::Working,
                    source: termloop_agents::AgentSignalSource::Hook,
                    sequence: 3,
                    observed_at_epoch_ms: 10,
                }),
                pending_generated_input: None,
            },
        );
        let generated_input_events = runtime.take_generated_input_runtime_events().unwrap();

        let result = runtime
            .reply_to_request("helper-token", &request_id, "Verified answer".into())
            .unwrap();
        assert_eq!(result["status"], "submitting");
        assert!(
            runtime.agent_observations["asker"]
                .pending_generated_input
                .is_some()
        );
        assert_eq!(
            runtime.generated_input_delivery_state("asker", 7),
            Some(GeneratedInputDeliveryState::WritingPaste)
        );
        assert!(!runtime.ask_to_requests[&request_id].reply_delivered);
        assert_eq!(
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref())
                .and_then(|continuation| continuation.current_request_id.as_deref()),
            Some(request_id.as_str())
        );
        let event = generated_input_events
            .recv_timeout(TRANSPORT_EVENT_TIMEOUT)
            .unwrap();
        assert!(runtime.record_generated_input_runtime_event(event).unwrap());
        assert_eq!(
            runtime.generated_input_delivery_state("asker", 7),
            Some(GeneratedInputDeliveryState::AwaitingProviderAck)
        );
        assert!(!runtime.ask_to_requests[&request_id].reply_delivered);
        assert!(
            runtime
                .confirm_generated_input_progress("asker", 7, 4)
                .unwrap()
        );

        assert!(runtime.ask_to_requests[&request_id].reply_delivered);
        assert_eq!(
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref())
                .and_then(|continuation| continuation.current_request_id.as_deref()),
            None
        );
        assert_eq!(
            runtime
                .mcp_authorizer
                .authenticate("helper-token")
                .unwrap()
                .role(),
            &AgentMcpRole::Helper { request_id: None }
        );

        runtime.terminal.terminate("asker").unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reusable_helper_can_ask_another_agent() {
        let (mut runtime, _token, root) = runtime_with_asker();
        runtime.mcp_authorizer.register(
            "asker".into(),
            7,
            AgentMcpRole::Helper { request_id: None },
            "helper-token".into(),
        );

        assert!(matches!(
            runtime.plan_ask_to("helper-token", input(None)).unwrap(),
            AskToPlanOutcome::Launch(_)
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn session_projection_preserves_the_exact_ask_to_source_across_restart() {
        let (mut runtime, token, root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        assert_eq!(plan.ask_to_source_session_id.as_deref(), Some("asker"));
        let request_id = plan.ask_to_request_id().unwrap().to_owned();
        let helper_id = plan.session_id().to_owned();
        let project_id = runtime.store.sessions()[0].project_id.clone();
        insert_running_helper(&mut runtime, &helper_id, &project_id);
        runtime
            .store
            .establish_session_resume_ref(
                &runtime.write_authority,
                "asker",
                termloop_domain::ResumeRef::for_provider(
                    termloop_domain::ResumeProvider::Claude,
                    "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035".into(),
                )
                .unwrap(),
            )
            .unwrap();
        runtime
            .store
            .establish_session_resume_ref(
                &runtime.write_authority,
                &helper_id,
                termloop_domain::ResumeRef::for_provider(
                    termloop_domain::ResumeProvider::Claude,
                    "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036".into(),
                )
                .unwrap(),
            )
            .unwrap();
        runtime
            .store
            .mark_agent_conversation_resumable(&runtime.write_authority, "asker")
            .unwrap();
        runtime
            .store
            .mark_agent_conversation_resumable(&runtime.write_authority, &helper_id)
            .unwrap();
        let observation_transport = runtime.observation_transport.clone().unwrap();

        let sessions = runtime.list_sessions().unwrap();
        let sessions = sessions.as_array().unwrap();
        let asker = sessions
            .iter()
            .find(|session| session["id"] == "asker")
            .unwrap();
        let helper = sessions
            .iter()
            .find(|session| session["id"] == helper_id)
            .unwrap();
        assert!(asker["ask_to_source_session_id"].is_null());
        assert_eq!(helper["ask_to_source_session_id"], "asker");
        runtime.mcp_authorizer.register(
            helper_id.clone(),
            7,
            AgentMcpRole::Helper {
                request_id: Some(request_id.clone()),
            },
            "pre-restart-helper-token".into(),
        );

        drop(runtime);
        let mut reopened =
            CoreRuntime::open(root.join("state.json"), TerminalService::default(), 8).unwrap();
        reopened.configure_agent_observations(observation_transport);
        assert!(matches!(
            reopened
                .mcp_authorizer
                .authenticate("pre-restart-helper-token"),
            Err(CoreError::CapabilityDenied)
        ));
        assert_eq!(reopened.ask_to_requests.len(), 1);
        assert_eq!(reopened.ask_to_conversations.len(), 1);
        let sessions = reopened.list_sessions().unwrap();
        let helper = sessions
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == helper_id)
            .unwrap();
        assert_eq!(helper["ask_to_source_session_id"], "asker");

        let preview = reopened
            .preview_agent_resume(json!({ "sessionId": helper_id }))
            .unwrap();
        let manifest = preview["manifest"].to_string();
        assert!(manifest.contains("builtin.agent.ask-to-resume"));
        assert!(manifest.contains(&request_id));
        let AgentResumePlanOutcome::Prepare(helper_resume) = reopened
            .plan_agent_resume(json!({ "sessionId": helper_id }))
            .unwrap()
        else {
            panic!("helper must remain resumable")
        };
        assert!(matches!(
            helper_resume.mcp_role,
            Some(AgentMcpRole::Helper {
                request_id: Some(ref allowed)
            }) if allowed == &request_id
        ));
        assert!(
            helper_resume
                .mcp_token
                .as_deref()
                .is_some_and(|token| token != "pre-restart-helper-token")
        );
        assert_eq!(reopened.ask_to_requests.len(), 1);
        drop(helper_resume);
        reopened
            .fail_agent_resume(
                &helper_id,
                termloop_domain::ResumeFailureReason::ResumeRejected,
            )
            .unwrap();
        reopened
            .fail_agent_resume(
                "asker",
                termloop_domain::ResumeFailureReason::ResumeRejected,
            )
            .unwrap();

        reopened
            .close_session(json!({ "sessionId": "asker" }))
            .unwrap();
        assert!(reopened.ask_to_requests.is_empty());
        assert!(reopened.ask_to_conversations.is_empty());
        let sessions = reopened.list_sessions().unwrap();
        let helper = sessions
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == helper_id)
            .unwrap();
        assert!(helper["ask_to_source_session_id"].is_null());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn live_conversation_follow_up_reuses_exact_idle_helper_and_rebinds_reply() {
        let (mut runtime, token, root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        let first_request_id = plan.ask_to_request_id().unwrap().to_owned();
        let helper_id = plan.session_id().to_owned();
        let conversation_id = runtime.ask_to_requests[&first_request_id]
            .conversation_id
            .clone();
        let project_id = runtime.store.sessions()[0].project_id.clone();
        insert_running_helper(&mut runtime, &helper_id, &project_id);
        let (program, args) = termloop_platform::default_shell();
        runtime
            .terminal
            .spawn(termloop_terminal::PtySpawnSpec {
                session_id: helper_id.clone(),
                runtime_epoch: 7,
                program,
                args,
                cwd: root.display().to_string(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: false,
            })
            .unwrap();
        runtime.mcp_authorizer.register(
            helper_id.clone(),
            7,
            AgentMcpRole::Helper {
                request_id: Some(first_request_id.clone()),
            },
            "helper-token".into(),
        );
        runtime.agent_observations.insert(
            helper_id.clone(),
            crate::AgentObservationCapability {
                token: Some("observation-token".into()),
                runtime_epoch: 7,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                observation: Some(termloop_agents::AgentObservation {
                    state: termloop_agents::AgentState::Idle,
                    source: termloop_agents::AgentSignalSource::Hook,
                    sequence: 4,
                    observed_at_epoch_ms: 10,
                }),
                pending_generated_input: None,
            },
        );
        runtime
            .reply_to_request("helper-token", &first_request_id, "first answer".into())
            .unwrap();
        runtime
            .store
            .set_ask_to_current_request(
                &runtime.write_authority,
                &helper_id,
                &conversation_id,
                None,
            )
            .unwrap();
        runtime
            .mcp_authorizer
            .bind_helper_request(&helper_id, 7, None)
            .unwrap();
        runtime
            .ask_to_requests
            .get_mut(&first_request_id)
            .unwrap()
            .reply_delivered = true;
        let AskToPlanOutcome::Launch(second_plan) = runtime
            .plan_ask_to(&token, input(Some("second-helper")))
            .unwrap()
        else {
            panic!("a separate question must launch a second helper")
        };
        let second_helper_id = second_plan.session_id().to_owned();
        let second_helper_request_id = second_plan.ask_to_request_id().unwrap().to_owned();
        insert_running_helper(&mut runtime, &second_helper_id, &project_id);
        runtime.mcp_authorizer.register(
            second_helper_id,
            7,
            AgentMcpRole::Helper {
                request_id: Some(second_helper_request_id.clone()),
            },
            "second-helper-token".into(),
        );
        runtime
            .reply_to_request(
                "second-helper-token",
                &second_helper_request_id,
                "other answer".into(),
            )
            .unwrap();
        runtime
            .ask_to_requests
            .get_mut(&second_helper_request_id)
            .unwrap()
            .reply_delivered = true;
        let session_count = runtime.store.sessions().len();
        let generated_input_events = runtime.take_generated_input_runtime_events().unwrap();

        runtime
            .agent_observations
            .get_mut(&helper_id)
            .unwrap()
            .observation
            .as_mut()
            .unwrap()
            .state = termloop_agents::AgentState::Working;
        let mut busy_follow_up = input(None);
        busy_follow_up.conversation_id = Some(conversation_id.clone());
        assert!(matches!(
            runtime.plan_ask_to(&token, busy_follow_up),
            Err(CoreError::ConversationBusy)
        ));
        runtime
            .agent_observations
            .get_mut(&helper_id)
            .unwrap()
            .observation
            .as_mut()
            .unwrap()
            .state = termloop_agents::AgentState::Idle;

        let mut follow_up = input(Some("follow-up-1"));
        follow_up.message = "Build on your first answer".into();
        follow_up.conversation_id = Some(conversation_id.clone());
        let AskToPlanOutcome::FollowUp(value) = runtime.plan_ask_to(&token, follow_up).unwrap()
        else {
            panic!("follow-up must reuse the live helper")
        };
        let second_request_id = value["requestId"].as_str().unwrap().to_owned();
        assert_ne!(second_request_id, first_request_id);
        assert_eq!(value["conversationId"], conversation_id);
        assert_eq!(value["status"], "pending");
        assert_eq!(runtime.store.sessions().len(), session_count);
        assert_eq!(
            runtime
                .mcp_authorizer
                .authenticate("helper-token")
                .unwrap()
                .role(),
            &AgentMcpRole::Helper { request_id: None }
        );
        assert_eq!(
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref())
                .and_then(|continuation| continuation.current_request_id.as_deref()),
            None
        );
        assert!(
            !runtime
                .confirm_generated_input_submission(&helper_id, 7, 5)
                .unwrap()
        );
        let event = generated_input_events
            .recv_timeout(TRANSPORT_EVENT_TIMEOUT)
            .unwrap();
        assert!(runtime.record_generated_input_runtime_event(event).unwrap());
        assert_eq!(
            runtime
                .mcp_authorizer
                .authenticate("helper-token")
                .unwrap()
                .role(),
            &AgentMcpRole::Helper {
                request_id: Some(second_request_id.clone())
            }
        );
        assert_eq!(
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref())
                .and_then(|continuation| continuation.current_request_id.as_deref()),
            Some(second_request_id.as_str())
        );
        runtime
            .reply_to_request("helper-token", &second_request_id, "second answer".into())
            .unwrap();
        assert_eq!(
            runtime.ask_to_requests[&second_request_id].status,
            AskToStatus::Completed("second answer".into())
        );
        runtime
            .ask_to_requests
            .get_mut(&second_request_id)
            .unwrap()
            .reply_delivered = true;

        let mut wrong_target = input(None);
        wrong_target.target = "codex".into();
        wrong_target.conversation_id = Some(conversation_id);
        assert!(matches!(
            runtime.plan_ask_to(&token, wrong_target),
            Err(CoreError::ConversationUnavailable)
        ));
        runtime.terminal.terminate(&helper_id).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn asker_revocation_removes_the_capability_and_unlaunched_request() {
        let (mut runtime, token, root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        let request_id = plan.ask_to_request_id().unwrap().to_owned();
        runtime.retire_ask_to_session("asker");
        assert!(matches!(
            runtime.mcp_authorizer.authenticate(&token),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(!runtime.ask_to_requests.contains_key(&request_id));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn transient_termination_preserves_ask_to_until_explicit_close() {
        let (mut runtime, token, root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        let request_id = plan.ask_to_request_id().unwrap().to_owned();
        let helper_id = plan.session_id().to_owned();
        let project_id = runtime.store.sessions()[0].project_id.clone();
        insert_running_helper(&mut runtime, &helper_id, &project_id);
        runtime.mcp_authorizer.register(
            helper_id.clone(),
            7,
            AgentMcpRole::Helper {
                request_id: Some(request_id.clone()),
            },
            "helper-token".into(),
        );
        let (program, args) = termloop_platform::default_shell();
        runtime
            .terminal
            .spawn(termloop_terminal::PtySpawnSpec {
                session_id: "asker".into(),
                runtime_epoch: 7,
                program,
                args,
                cwd: root.display().to_string(),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: false,
            })
            .unwrap();

        runtime
            .terminate_session(json!({ "sessionId": "asker" }))
            .unwrap();

        assert_eq!(
            runtime.ask_to_requests[&request_id].status,
            AskToStatus::Pending
        );
        assert_eq!(
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref())
                .and_then(|continuation| continuation.current_request_id.as_deref()),
            Some(request_id.as_str())
        );
        assert_eq!(
            runtime
                .reply_to_request("helper-token", &request_id, "late answer".into())
                .unwrap()["status"],
            "submitting"
        );
        assert_eq!(
            runtime.ask_to_requests[&request_id].status,
            AskToStatus::Completed("late answer".into())
        );

        runtime
            .close_session(json!({ "sessionId": "asker" }))
            .unwrap();

        assert!(matches!(
            runtime.reply_to_request("helper-token", &request_id, "late answer".into()),
            Err(CoreError::AskToRequestGone)
        ));
        assert_eq!(
            runtime
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref()),
            None
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn daemon_restart_restores_ask_to_for_a_transiently_exited_source() {
        let (mut runtime, token, root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        let request_id = plan.ask_to_request_id().unwrap().to_owned();
        let helper_id = plan.session_id().to_owned();
        let project_id = runtime.store.sessions()[0].project_id.clone();
        insert_running_helper(&mut runtime, &helper_id, &project_id);
        runtime
            .store
            .mark_session_exited(&runtime.write_authority, "asker")
            .unwrap();
        drop(runtime);

        let mut reopened =
            CoreRuntime::open(root.join("state.json"), TerminalService::default(), 8).unwrap();

        assert_eq!(reopened.ask_to_by_source.get("asker"), Some(&request_id));
        assert_eq!(
            reopened.ask_to_requests[&request_id].status,
            AskToStatus::Pending
        );
        assert_eq!(reopened.ask_to_conversations.len(), 1);
        assert_eq!(
            reopened
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref())
                .and_then(|continuation| continuation.current_request_id.as_deref()),
            Some(request_id.as_str())
        );

        reopened
            .close_session(json!({ "sessionId": "asker" }))
            .unwrap();
        assert!(!reopened.ask_to_requests.contains_key(&request_id));
        assert!(reopened.ask_to_conversations.is_empty());
        assert_eq!(
            reopened
                .store
                .sessions()
                .iter()
                .find(|session| session.id == helper_id)
                .and_then(|session| session.ask_to_continuation.as_ref()),
            None
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn session_retirement_removes_related_cross_session_delivery_completions() {
        let (mut source_runtime, source_token, source_root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(source_plan) = source_runtime
            .plan_ask_to(&source_token, input(None))
            .unwrap()
        else {
            panic!("first call must launch")
        };
        let source_request_id = source_plan.ask_to_request_id().unwrap().to_owned();
        let source_helper_id = source_plan.session_id().to_owned();
        source_runtime.ask_to_delivery_completions.insert(
            source_helper_id,
            AskToGeneratedInputCompletion::FollowUp {
                request_id: source_request_id,
            },
        );

        source_runtime.retire_ask_to_session("asker");

        assert!(source_runtime.ask_to_delivery_completions.is_empty());

        let (mut helper_runtime, helper_token, helper_root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(helper_plan) = helper_runtime
            .plan_ask_to(&helper_token, input(None))
            .unwrap()
        else {
            panic!("first call must launch")
        };
        let helper_request_id = helper_plan.ask_to_request_id().unwrap().to_owned();
        let helper_session_id = helper_plan.session_id().to_owned();
        helper_runtime.ask_to_delivery_completions.insert(
            "asker".into(),
            AskToGeneratedInputCompletion::Reply {
                request_id: helper_request_id,
            },
        );

        helper_runtime.retire_ask_to_session(&helper_session_id);

        assert!(helper_runtime.ask_to_delivery_completions.is_empty());
        let _ = std::fs::remove_dir_all(source_root);
        let _ = std::fs::remove_dir_all(helper_root);
    }

    #[test]
    fn pending_request_has_no_wall_clock_expiry_and_late_reply_sees_gone_asker() {
        let (mut runtime, token, root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        let request_id = plan.ask_to_request_id().unwrap().to_owned();
        assert_eq!(
            request_value(&runtime.ask_to_requests[&request_id])["status"],
            "pending"
        );
        assert!(matches!(
            runtime.plan_ask_to(&token, input(None)),
            Err(CoreError::AskToInProgress { .. })
        ));

        let (mut gone_runtime, gone_token, gone_root) = runtime_with_asker();
        let AskToPlanOutcome::Launch(gone_plan) =
            gone_runtime.plan_ask_to(&gone_token, input(None)).unwrap()
        else {
            panic!("first call must launch")
        };
        let gone_request_id = gone_plan.ask_to_request_id().unwrap().to_owned();
        let gone_helper_id = gone_plan.session_id().to_owned();
        let project_id = gone_runtime.store.sessions()[0].project_id.clone();
        insert_running_helper(&mut gone_runtime, &gone_helper_id, &project_id);
        gone_runtime.mcp_authorizer.register(
            gone_helper_id.clone(),
            7,
            AgentMcpRole::Helper {
                request_id: Some(gone_request_id.clone()),
            },
            "late-helper".into(),
        );
        gone_runtime.retire_ask_to_session("asker");
        assert!(matches!(
            gone_runtime.reply_to_request("late-helper", &gone_request_id, "late".into()),
            Err(CoreError::AskToRequestGone)
        ));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(gone_root);
    }

    #[test]
    fn terminal_requests_are_reclaimed_in_both_session_exit_orders() {
        for helper_exits_first in [true, false] {
            let (mut runtime, token, root) = runtime_with_asker();
            let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
            else {
                panic!("first call must launch")
            };
            let request_id = plan.ask_to_request_id().unwrap().to_owned();
            let helper_id = plan.session_id().to_owned();
            let project_id = runtime.store.sessions()[0].project_id.clone();
            insert_running_helper(&mut runtime, &helper_id, &project_id);
            runtime.mcp_authorizer.register(
                helper_id.clone(),
                7,
                AgentMcpRole::Helper {
                    request_id: Some(request_id.clone()),
                },
                "helper-token".into(),
            );
            runtime
                .reply_to_request("helper-token", &request_id, "done".into())
                .unwrap();

            if helper_exits_first {
                runtime
                    .store
                    .mark_session_exited(&runtime.write_authority, &helper_id)
                    .unwrap();
                runtime.retire_ask_to_session(&helper_id);
                assert!(runtime.ask_to_requests.contains_key(&request_id));
                runtime
                    .store
                    .mark_session_exited(&runtime.write_authority, "asker")
                    .unwrap();
                runtime.retire_ask_to_session("asker");
            } else {
                runtime
                    .store
                    .mark_session_exited(&runtime.write_authority, "asker")
                    .unwrap();
                runtime.retire_ask_to_session("asker");
                assert_eq!(
                    runtime.ask_to_requests[&request_id].status,
                    AskToStatus::RequestGone
                );
                runtime
                    .store
                    .mark_session_exited(&runtime.write_authority, &helper_id)
                    .unwrap();
                runtime.retire_ask_to_session(&helper_id);
            }
            assert!(!runtime.ask_to_requests.contains_key(&request_id));
            assert!(runtime.ask_to_conversations.is_empty());
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn project_helper_capacity_fails_before_a_process_plan_is_created() {
        let (mut runtime, token, root) = runtime_with_asker();
        let project_id = runtime.store.sessions()[0].project_id.clone();
        for index in 0..PROJECT_LIVE_HELPER_LIMIT {
            reserve_pending_helper(&mut runtime, &index.to_string(), &project_id);
        }
        assert!(matches!(
            runtime.plan_ask_to(&token, input(None)),
            Err(CoreError::HelperCapacityExhausted)
        ));
        assert_eq!(runtime.ask_to_requests.len(), PROJECT_LIVE_HELPER_LIMIT);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_pre_session_launch_releases_derived_helper_capacity() {
        let (mut runtime, token, root) = runtime_with_asker();
        let project_id = runtime.store.sessions()[0].project_id.clone();
        let AskToPlanOutcome::Launch(plan) = runtime.plan_ask_to(&token, input(None)).unwrap()
        else {
            panic!("first call must reserve one helper")
        };
        runtime.fail_ask_to_launch(plan.ask_to_request_id().unwrap());
        for index in 0..(PROJECT_LIVE_HELPER_LIMIT - 1) {
            reserve_pending_helper(&mut runtime, &index.to_string(), &project_id);
        }
        assert!(matches!(
            runtime.plan_ask_to(&token, input(Some("after-failure"))),
            Ok(AskToPlanOutcome::Launch(_))
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sequential_requests_have_no_session_lifetime_cap() {
        let (mut runtime, token, root) = runtime_with_asker();
        for index in 0..32 {
            let AskToPlanOutcome::Launch(plan) = runtime
                .plan_ask_to(&token, input(Some(&format!("request-{index}"))))
                .unwrap()
            else {
                panic!("each terminal request must allow a new launch")
            };
            runtime.fail_ask_to_launch(plan.ask_to_request_id().unwrap());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn daemon_helper_capacity_fails_before_a_process_plan_is_created() {
        let (mut runtime, token, root) = runtime_with_asker();
        for index in 0..DAEMON_LIVE_HELPER_LIMIT {
            reserve_pending_helper(
                &mut runtime,
                &index.to_string(),
                &format!("other-project-{index}"),
            );
        }
        assert!(matches!(
            runtime.plan_ask_to(&token, input(None)),
            Err(CoreError::HelperCapacityExhausted)
        ));
        assert_eq!(runtime.ask_to_requests.len(), DAEMON_LIVE_HELPER_LIMIT);
        let _ = std::fs::remove_dir_all(root);
    }
}
