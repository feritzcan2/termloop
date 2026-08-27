use serde_json::{Value, json};
use termloop_domain::{
    AgentLaunchSelection, CompanionMessageAuthor, IssueLink, IssueLinkProvider,
    IssueLinkSyncAuthority, SessionKind, StewardAgentId, StewardConfiguration,
};

use super::transcript::CompanionMessageRefsInput;
use crate::{CoreError, CoreRuntime, required_string, store_error};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentStewardWake {
    pub project_id: String,
    pub generation: u64,
    pub agent_id: String,
}

/// Compatibility name for the current generated contract. Persistent
/// assistants need only ordinary CLI availability; no restricted-executor
/// proof is constructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistantAvailability {
    Proven,
    Unavailable,
    Unknown,
}

pub struct StewardConfigurationUpdate<'a> {
    pub project_id: &'a str,
    pub agent_id: &'a str,
    pub model: String,
    pub permission: String,
    pub reasoning: String,
    pub enabled: bool,
    pub system_prompt: String,
    pub expected_revision: u64,
    pub capability: AssistantAvailability,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StewardTaskAgentStartPlan {
    task_id: String,
    title: String,
    brief: Option<String>,
    branch_name: String,
    worktree_leaf: String,
    existing_branch_name: Option<String>,
    existing_worktree_path: Option<String>,
    agent_id: String,
    launch_selection: AgentLaunchSelection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StewardTaskAgentAssignmentState {
    Pending,
    Delivered,
    ReadyForDirectDelivery,
}

impl StewardTaskAgentStartPlan {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn brief(&self) -> Option<&str> {
        self.brief.as_deref()
    }

    pub fn operation_id(&self) -> &str {
        &self.task_id
    }

    pub fn branch_name(&self) -> &str {
        self.existing_branch_name
            .as_deref()
            .unwrap_or(&self.branch_name)
    }

    pub fn planned_branch_name(&self) -> &str {
        &self.branch_name
    }

    pub fn worktree_leaf(&self) -> &str {
        &self.worktree_leaf
    }

    pub fn existing_worktree_path(&self) -> Option<&str> {
        self.existing_worktree_path.as_deref()
    }

    pub fn existing_branch_name(&self) -> Option<&str> {
        self.existing_branch_name.as_deref()
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn launch_selection(&self) -> &AgentLaunchSelection {
        &self.launch_selection
    }
}

impl AssistantAvailability {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Proven => "proven",
            Self::Unavailable => "unavailable",
            Self::Unknown => "unknown",
        }
    }
}

impl CoreRuntime {
    pub fn project_count(&self) -> usize {
        self.store.projects().len()
    }

    pub fn current_enabled_steward_wake(&self, project_id: &str) -> Option<CurrentStewardWake> {
        self.store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id && configuration.enabled)
            .map(steward_wake)
    }

    pub fn enabled_steward_wakes(&self) -> Vec<CurrentStewardWake> {
        self.store
            .steward_configurations()
            .iter()
            .filter(|configuration| configuration.enabled)
            .map(steward_wake)
            .collect()
    }

    pub fn append_steward_suggestion(
        &mut self,
        session_id: &str,
        project_id: &str,
        kind: &str,
        refs: CompanionMessageRefsInput,
        content: String,
        created_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if self.store.steward_project_for_executor_session(session_id) != Some(project_id) {
            return Err(CoreError::CapabilityDenied);
        }
        if !matches!(
            kind,
            "reply" | "update" | "attention" | "problem" | "suggestion" | "proposal"
        ) {
            return Err(CoreError::CapabilityDenied);
        }
        if matches!(kind, "suggestion" | "proposal")
            && let Some(pending) = self.current_pending_companion_proposal(project_id)
        {
            return Err(CoreError::CompanionProposalPending {
                proposal_message_id: pending.id.clone(),
            });
        }
        if refs.task_id.as_deref().is_some_and(|task_id| {
            !self
                .store
                .tasks()
                .iter()
                .any(|task| task.id == task_id && task.project_id == project_id)
        }) || refs
            .session_id
            .as_deref()
            .is_some_and(|referenced_session_id| {
                !self.store.sessions().iter().any(|session| {
                    session.id == referenced_session_id && session.project_id == project_id
                })
            })
            || refs.all_routine_finding_ids().any(|finding_id| {
                kind != "proposal"
                    || self
                        .current_routine_finding(project_id, finding_id)
                        .is_none()
            })
        {
            // Model-authored references are presentation links, not authority.
            // Only identifiers already observed in this Project may be projected.
            return Err(CoreError::CapabilityDenied);
        }
        if refs.all_routine_finding_ids().any(|finding_id| {
            self.store.companion_messages().iter().any(|message| {
                message.project_id == project_id
                    && message.author == termloop_domain::CompanionMessageAuthor::Steward
                    && message.kind == termloop_domain::CompanionMessageKind::Proposal
                    && message.refs.as_ref().is_some_and(|message_refs| {
                        message_refs.references_routine_finding(finding_id)
                    })
            })
        }) {
            // A finding is one current decision, even if its evidence is
            // refreshed while the user considers it. Re-proposing the same
            // decision would turn a heartbeat into chat spam.
            return Err(CoreError::RevisionConflict);
        }
        self.append_companion_message(
            project_id,
            "steward",
            kind,
            refs,
            content,
            created_at_epoch_ms,
        )
    }

    pub fn append_steward_action(
        &mut self,
        steward_session_id: &str,
        project_id: &str,
        content: &str,
        task_id: Option<String>,
        referenced_session_id: Option<String>,
        created_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if !self.is_current_steward_session(project_id, steward_session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        self.append_companion_message(
            project_id,
            "steward",
            "action",
            CompanionMessageRefsInput {
                task_id,
                session_id: referenced_session_id,
                routine_finding_id: None,
                routine_finding_ids: vec![],
            },
            content.to_owned(),
            created_at_epoch_ms,
        )
    }

    pub fn is_current_steward_session(&self, project_id: &str, session_id: &str) -> bool {
        self.store.steward_project_for_executor_session(session_id) == Some(project_id)
    }

    pub fn steward_system_prompt_for_executor(
        &self,
        steward_session_id: &str,
        project_id: &str,
    ) -> Result<Value, CoreError> {
        if !self.is_current_steward_session(project_id, steward_session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        let configuration = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .ok_or(CoreError::CapabilityDenied)?;
        Ok(json!({
            "systemPrompt": termloop_invocation::editable_steward_system_prompt(
                &configuration.system_prompt
            )
        }))
    }

    /// Replaces only this current Steward's Project-scoped instructions after
    /// proving both the exact newest user request and the editable source text
    /// that the model read. The invocation-owned built-in prompt is never MCP
    /// input. This prevents stale read-modify-write overwrites without making
    /// the editable budget depend on built-in prompt length.
    pub fn update_steward_system_prompt(
        &mut self,
        steward_session_id: &str,
        project_id: &str,
        user_message_id: &str,
        expected_system_prompt: &str,
        system_prompt: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        if !self.is_current_steward_session(project_id, steward_session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        let newest_message = self
            .store
            .companion_messages()
            .iter()
            .filter(|message| message.project_id == project_id)
            .max_by_key(|message| message.sequence)
            .ok_or(CoreError::CapabilityDenied)?;
        if newest_message.id != user_message_id
            || newest_message.author != CompanionMessageAuthor::User
        {
            return Err(CoreError::CapabilityDenied);
        }
        let current = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        let current_editable_system_prompt =
            termloop_invocation::editable_steward_system_prompt(&current.system_prompt);
        if expected_system_prompt != current_editable_system_prompt {
            return Err(CoreError::RevisionConflict);
        }
        let system_prompt = system_prompt.trim();
        if system_prompt.len() > termloop_domain::STEWARD_SYSTEM_PROMPT_MAX_BYTES
            || termloop_invocation::editable_steward_system_prompt_from_effective(system_prompt)
                .is_some()
        {
            return Err(CoreError::InvalidParams("systemPrompt".into()));
        }
        if current_editable_system_prompt == system_prompt {
            return Ok(false);
        }
        let generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?;
        self.store
            .set_steward_configuration(
                &self.write_authority,
                StewardConfiguration {
                    project_id: current.project_id,
                    agent_id: current.agent_id,
                    model: current.model,
                    permission: current.permission,
                    reasoning: current.reasoning,
                    enabled: current.enabled,
                    system_prompt: system_prompt.to_owned(),
                    executor_session_id: None,
                    generation,
                    updated_at_epoch_ms,
                },
                self.store.revision(),
            )
            .map_err(store_error)?;
        Ok(true)
    }

    pub fn send_steward_agent_message(
        &mut self,
        steward_session_id: &str,
        project_id: &str,
        target_session_id: &str,
        message: &str,
    ) -> Result<(), CoreError> {
        if !self.is_current_steward_session(project_id, steward_session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        let target = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == target_session_id)
            .ok_or(CoreError::NotFound)?;
        if target.project_id != project_id
            || target.kind != SessionKind::Agent
            || !self.agent_session_runtime_is_current(target)
            || self
                .store
                .steward_configurations()
                .iter()
                .any(|configuration| {
                    configuration.executor_session_id.as_deref() == Some(target_session_id)
                })
            || self
                .store
                .worker_configurations()
                .iter()
                .any(|configuration| {
                    configuration.executor_session_id.as_deref() == Some(target_session_id)
                })
        {
            return Err(CoreError::CapabilityDenied);
        }
        let prompt = termloop_invocation::steward_agent_message_prompt(message)
            .map_err(|_| CoreError::InvalidParams("message".into()))?;
        self.submit_generated_terminal_input(target_session_id, prompt.terminal_submission())
    }

    pub fn execute_steward_task_command(
        &mut self,
        steward_session_id: &str,
        project_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        if !self.is_current_steward_session(project_id, steward_session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        match method {
            "task.create" => {
                if params.get("projectId").and_then(Value::as_str) != Some(project_id) {
                    return Err(CoreError::CapabilityDenied);
                }
            }
            "task.rename" | "task.updateBrief" | "task.close" | "task.reopen" | "task.delete" => {
                let task_id = params
                    .get("taskId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::InvalidParams("taskId".into()))?;
                self.authorize_steward_task_execution(steward_session_id, project_id, task_id)?;
            }
            _ => return Err(CoreError::CapabilityDenied),
        }
        self.handle(method, params)
    }

    pub fn authorize_steward_task_execution(
        &self,
        steward_session_id: &str,
        project_id: &str,
        task_id: &str,
    ) -> Result<(), CoreError> {
        if !self.is_current_steward_session(project_id, steward_session_id) {
            return Err(CoreError::CapabilityDenied);
        }
        self.store
            .tasks()
            .iter()
            .any(|task| task.id == task_id && task.project_id == project_id)
            .then_some(())
            .ok_or(CoreError::CapabilityDenied)
    }

    pub fn set_steward_task_jira_url(
        &mut self,
        steward_session_id: &str,
        project_id: &str,
        task_id: &str,
        jira_url: &str,
    ) -> Result<String, CoreError> {
        self.authorize_steward_task_execution(steward_session_id, project_id, task_id)?;
        if let Some(existing) = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task_id && link.provider == IssueLinkProvider::Jira)
        {
            return Err(CoreError::TaskJiraUrlAlreadySet {
                task_id: task_id.to_owned(),
                jira_url: existing.url.clone().unwrap_or_default(),
            });
        }
        let normalized = termloop_providers::normalize_jira_issue_url(jira_url)
            .map_err(|_| CoreError::InvalidParams("jiraUrl".into()))?;
        self.store
            .insert_task_jira_issue_link(
                &self.write_authority,
                IssueLink {
                    task_id: task_id.to_owned(),
                    provider: IssueLinkProvider::Jira,
                    external_ref: normalized.external_ref,
                    source_id: None,
                    external_id: None,
                    external_updated_at: None,
                    url: Some(normalized.url.clone()),
                    sync_authority: IssueLinkSyncAuthority::None,
                },
            )
            .map_err(store_error)?;
        Ok(normalized.url)
    }

    pub fn plan_steward_task_agent_start(
        &self,
        steward_session_id: &str,
        project_id: &str,
        task_id: &str,
        requested_agent_id: Option<&str>,
        requested_model: Option<&str>,
    ) -> Result<StewardTaskAgentStartPlan, CoreError> {
        self.authorize_steward_task_execution(steward_session_id, project_id, task_id)?;
        let (agent_id, launch_selection) = match requested_agent_id {
            Some(agent_id) => {
                let model = requested_model.unwrap_or("default");
                let selection = AgentLaunchSelection::new(
                    model,
                    termloop_invocation::default_permission(agent_id),
                    "default",
                );
                termloop_invocation::validate_agent_configuration(
                    agent_id,
                    &selection.model,
                    &selection.permission,
                    &selection.reasoning,
                )
                .map_err(|_| CoreError::InvalidParams("agentId/model".into()))?;
                (agent_id.to_owned(), selection)
            }
            None if requested_model.is_some() => {
                return Err(CoreError::InvalidParams("agentId".into()));
            }
            None => {
                let saved_launch = self.store.last_agent_launch_selection().ok_or(
                    CoreError::TaskAgentStartFailed {
                        stage: crate::TaskAgentStartStage::Planning,
                        retryable: false,
                        suggested_action: crate::TaskAgentStartSuggestedAction::ConfigureAgent,
                        observed_branches: Vec::new(),
                    },
                )?;
                (
                    saved_launch.agent_id.clone(),
                    saved_launch.selection.clone(),
                )
            }
        };
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::CapabilityDenied)?;
        let checkout_names = crate::task_worktree::managed_task_checkout_names(
            &task.title,
            &task.id,
            termloop_domain::PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT,
        );
        Ok(StewardTaskAgentStartPlan {
            task_id: task.id.clone(),
            title: task.title.clone(),
            brief: task.brief.clone(),
            branch_name: checkout_names.branch_name,
            worktree_leaf: checkout_names.worktree_leaf,
            existing_branch_name: task.branch.as_ref().map(|branch| branch.name.clone()),
            existing_worktree_path: task.worktree.as_ref().map(|worktree| worktree.path.clone()),
            agent_id,
            launch_selection,
        })
    }

    pub fn reusable_steward_task_agent_session(
        &self,
        steward_session_id: &str,
        project_id: &str,
        task_id: &str,
        agent_id: &str,
        launch_selection: &AgentLaunchSelection,
    ) -> Result<Option<String>, CoreError> {
        self.authorize_steward_task_execution(steward_session_id, project_id, task_id)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::CapabilityDenied)?;
        let Some(worktree) = task.worktree.as_ref() else {
            return Ok(None);
        };
        Ok(self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.project_id == project_id
                    && session.kind == SessionKind::Agent
                    && self.agent_session_runtime_is_current(session)
                    && session.process.agent_id.as_deref() == Some(agent_id)
                    && session.launch_selection == *launch_selection
                    && session.resume_launch_guard.as_ref().is_some_and(|guard| {
                        guard.task_id == task_id
                            && guard.path == worktree.path
                            && guard.worktree_generation == task.worktree_generation
                    })
                    && !self.is_assistant_executor_session(&session.id)
            })
            .map(|session| session.id.clone()))
    }

    pub fn steward_task_agent_assignment_state(
        &self,
        steward_session_id: &str,
        project_id: &str,
        task_id: &str,
        target_session_id: &str,
    ) -> Result<StewardTaskAgentAssignmentState, CoreError> {
        self.authorize_steward_task_execution(steward_session_id, project_id, task_id)?;
        let target = self.current_task_agent(project_id, task_id, target_session_id)?;
        if let Some(state) = initial_assignment_state(
            target.process.template_ref.as_deref(),
            self.agent_observations.get(target_session_id),
        ) {
            return Ok(state);
        }
        if self
            .generated_input_deliveries
            .provenance(target_session_id, target.runtime_epoch)
            .is_some_and(|provenance| provenance.template_ref == "builtin.steward.task-assignment")
        {
            return Ok(
                if self
                    .generated_input_deliveries
                    .state(target_session_id, target.runtime_epoch)
                    == Some(crate::GeneratedInputDeliveryState::Confirmed)
                {
                    StewardTaskAgentAssignmentState::Delivered
                } else {
                    StewardTaskAgentAssignmentState::Pending
                },
            );
        }
        let ready = self
            .agent_observations
            .get(target_session_id)
            .and_then(|capability| capability.observation)
            .is_some_and(|observation| {
                observation.state == termloop_agents::AgentState::Idle
                    && matches!(
                        observation.source,
                        termloop_agents::AgentSignalSource::Hook
                            | termloop_agents::AgentSignalSource::DaemonBridge
                    )
            });
        Ok(if ready {
            StewardTaskAgentAssignmentState::ReadyForDirectDelivery
        } else {
            StewardTaskAgentAssignmentState::Pending
        })
    }

    pub fn send_steward_task_assignment(
        &mut self,
        steward_session_id: &str,
        project_id: &str,
        task_id: &str,
        target_session_id: &str,
        assignment: &str,
    ) -> Result<(), CoreError> {
        self.authorize_steward_task_execution(steward_session_id, project_id, task_id)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::CapabilityDenied)?;
        self.current_task_agent(project_id, task_id, target_session_id)?;
        let jira_url = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task_id && link.provider == IssueLinkProvider::Jira)
            .and_then(|link| link.url.as_deref());
        let ready = self
            .agent_observations
            .get(target_session_id)
            .and_then(|capability| capability.observation)
            .is_some_and(|observation| {
                observation.state == termloop_agents::AgentState::Idle
                    && matches!(
                        observation.source,
                        termloop_agents::AgentSignalSource::Hook
                            | termloop_agents::AgentSignalSource::DaemonBridge
                    )
            });
        if !ready {
            return Err(CoreError::ConversationBusy);
        }
        let prompt = termloop_invocation::steward_task_assignment_prompt(
            task_id,
            steward_session_id,
            &task.title,
            task.brief.as_deref(),
            jira_url,
            assignment,
        )
        .map_err(|_| CoreError::InvalidParams("assignment".into()))?;
        self.submit_generated_terminal_input(target_session_id, prompt.terminal_submission())
    }

    fn current_task_agent<'a>(
        &'a self,
        project_id: &str,
        task_id: &str,
        target_session_id: &str,
    ) -> Result<&'a termloop_domain::SessionRecord, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::CapabilityDenied)?;
        let worktree = task.worktree.as_ref().ok_or(CoreError::CapabilityDenied)?;
        let target = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == target_session_id)
            .ok_or(CoreError::NotFound)?;
        if target.project_id != project_id
            || target.kind != SessionKind::Agent
            || !self.agent_session_runtime_is_current(target)
            || target.resume_launch_guard.as_ref().is_none_or(|guard| {
                guard.task_id != task_id
                    || guard.path != worktree.path
                    || guard.worktree_generation != task.worktree_generation
            })
            || self.is_assistant_executor_session(target_session_id)
        {
            return Err(CoreError::CapabilityDenied);
        }
        Ok(target)
    }

    fn is_assistant_executor_session(&self, session_id: &str) -> bool {
        self.store
            .steward_configurations()
            .iter()
            .any(|configuration| configuration.executor_session_id.as_deref() == Some(session_id))
            || self
                .store
                .worker_configurations()
                .iter()
                .any(|configuration| {
                    configuration.executor_session_id.as_deref() == Some(session_id)
                })
    }

    pub fn steward_executor_session_id(&self, project_id: &str) -> Option<String> {
        self.store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .and_then(|configuration| configuration.executor_session_id.clone())
    }

    pub(crate) fn get_steward_configuration(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let configuration = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .cloned();
        let default_system_prompt = termloop_invocation::default_steward_system_prompt();
        let instructions_prompt = configuration
            .as_ref()
            .map(|configuration| {
                termloop_invocation::effective_steward_system_prompt(&configuration.system_prompt)
            })
            .unwrap_or_else(|| default_system_prompt.to_owned());
        let instruction_delivery = match configuration
            .as_ref()
            .map(|configuration| configuration.agent_id)
            .unwrap_or(StewardAgentId::Codex)
        {
            StewardAgentId::Claude => "claudeAppendedSystemPrompt",
            StewardAgentId::Codex => "codexDeveloperInstructions",
        };
        let activation_prompt = termloop_invocation::assistant_activation_message(
            termloop_invocation::ExecutorRole::Steward,
        )
        .map_err(|_| CoreError::Store("invalid Steward activation prompt".into()))?;
        let wake_prompt = termloop_invocation::assistant_wake_message(
            termloop_invocation::ExecutorRole::Steward,
            termloop_invocation::AssistantWakeReason::StewardPipelineMoved,
            None,
            None,
        )
        .map_err(|_| CoreError::Store("invalid Steward wake prompt".into()))?;
        Ok(json!({
            "configuration": configuration,
            "defaultSystemPrompt": default_system_prompt,
            "promptContext": {
                "initialPrompt": activation_prompt.delivered_preview(),
                "instructionsPrompt": instructions_prompt,
                "instructionDelivery": instruction_delivery,
                "protectedPrompt": default_system_prompt,
                "wakePrompt": wake_prompt.delivered_preview(),
            },
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn set_steward_configuration(
        &mut self,
        update: StewardConfigurationUpdate<'_>,
    ) -> Result<Value, CoreError> {
        let StewardConfigurationUpdate {
            project_id,
            agent_id,
            model,
            permission,
            reasoning,
            enabled,
            system_prompt,
            expected_revision,
            capability,
            updated_at_epoch_ms,
        } = update;
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        if enabled && capability != AssistantAvailability::Proven {
            return Err(CoreError::AgentCapabilityUnproven);
        }
        let agent_id = match agent_id {
            "claude" => StewardAgentId::Claude,
            "codex" => StewardAgentId::Codex,
            _ => return Err(CoreError::InvalidParams("agentId".into())),
        };
        termloop_invocation::validate_agent_configuration(
            match agent_id {
                StewardAgentId::Claude => "claude",
                StewardAgentId::Codex => "codex",
            },
            &model,
            &permission,
            &reasoning,
        )
        .map_err(|_| CoreError::InvalidParams("launchSelection".into()))?;
        let system_prompt = system_prompt.trim().to_owned();
        if system_prompt.len() > termloop_domain::STEWARD_SYSTEM_PROMPT_MAX_BYTES {
            return Err(CoreError::InvalidParams("systemPrompt".into()));
        }
        let current = self
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id);
        if let Some(current) = current
            && current.agent_id == agent_id
            && current.model == model
            && current.permission == permission
            && current.reasoning == reasoning
            && current.enabled == enabled
            && current.system_prompt == system_prompt
        {
            if expected_revision != self.store.revision() {
                return Err(CoreError::RevisionConflict);
            }
            return Ok(json!({
                "configuration": current,
                "stateRevision": self.store.revision(),
            }));
        }
        let generation = current
            .map(|configuration| configuration.generation)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidParams("projectId".into()))?;
        let configuration = StewardConfiguration {
            project_id: project_id.to_owned(),
            agent_id,
            model,
            permission,
            reasoning,
            enabled,
            system_prompt,
            executor_session_id: None,
            generation,
            updated_at_epoch_ms,
        };
        let configuration = self
            .store
            .set_steward_configuration(&self.write_authority, configuration, expected_revision)
            .map_err(store_error)?;
        Ok(json!({
            "configuration": configuration,
            "stateRevision": self.store.revision(),
        }))
    }

    /// Rolls back a durable assistant admission after the out-of-lock PTY spawn
    /// failed, so a process that never started cannot remain current state.
    pub fn rollback_assistant_launch(
        &mut self,
        session_id: &str,
    ) -> Result<(u64, Option<crate::CodexRuntime>), CoreError> {
        self.agent_observations.remove(session_id);
        self.mcp_authorizer.remove(session_id);
        let revision = self
            .store
            .rollback_assistant_launch(&self.write_authority, session_id)
            .map_err(store_error)?;
        Ok((revision, self.codex_runtimes.remove(session_id)))
    }
}

fn initial_assignment_state(
    template_ref: Option<&str>,
    capability: Option<&crate::AgentObservationCapability>,
) -> Option<StewardTaskAgentAssignmentState> {
    (template_ref == Some("builtin.steward.task-assignment")).then(|| {
        if capability.is_some_and(|capability| {
            capability.pending_generated_input.is_none()
                && capability.observation.is_some_and(|observation| {
                    matches!(
                        observation.source,
                        termloop_agents::AgentSignalSource::Hook
                            | termloop_agents::AgentSignalSource::DaemonBridge
                    )
                })
        }) {
            StewardTaskAgentAssignmentState::Delivered
        } else {
            StewardTaskAgentAssignmentState::Pending
        }
    })
}

fn steward_wake(configuration: &StewardConfiguration) -> CurrentStewardWake {
    CurrentStewardWake {
        project_id: configuration.project_id.clone(),
        generation: configuration.generation,
        agent_id: match configuration.agent_id {
            StewardAgentId::Claude => "claude".into(),
            StewardAgentId::Codex => "codex".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::TerminalService;

    #[test]
    fn enabling_requires_an_available_cli_and_provider_change_advances_generation() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-steward-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let folder = path.with_extension("project");
        std::fs::create_dir_all(&folder).unwrap();
        let mut runtime = CoreRuntime::new(
            Store::open(&path).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        let project = runtime
            .handle("project.create", json!({"name":"Demo","folderPath":folder}))
            .unwrap();
        let project_id = project["id"].as_str().unwrap();
        assert!(matches!(
            runtime.set_steward_configuration(StewardConfigurationUpdate {
                project_id,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled: true,
                system_prompt: String::new(),
                expected_revision: runtime.state_revision(),
                capability: AssistantAvailability::Unknown,
                updated_at_epoch_ms: 1,
            }),
            Err(CoreError::AgentCapabilityUnproven)
        ));
        runtime
            .set_steward_configuration(StewardConfigurationUpdate {
                project_id,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled: false,
                system_prompt: String::new(),
                expected_revision: runtime.state_revision(),
                capability: AssistantAvailability::Unknown,
                updated_at_epoch_ms: 1,
            })
            .unwrap();
        assert!(matches!(
            runtime.set_steward_configuration(StewardConfigurationUpdate {
                project_id,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled: false,
                system_prompt: "x".repeat(
                    termloop_domain::STEWARD_SYSTEM_PROMPT_MAX_BYTES + 1,
                ),
                expected_revision: runtime.state_revision(),
                capability: AssistantAvailability::Unknown,
                updated_at_epoch_ms: 2,
            }),
            Err(CoreError::InvalidParams(field)) if field == "systemPrompt"
        ));
        let changed = runtime
            .set_steward_configuration(StewardConfigurationUpdate {
                project_id,
                agent_id: "claude",
                model: "default".into(),
                permission: "default".into(),
                reasoning: "default".into(),
                enabled: true,
                system_prompt: String::new(),
                expected_revision: runtime.state_revision(),
                capability: AssistantAvailability::Proven,
                updated_at_epoch_ms: 2,
            })
            .unwrap();
        assert_eq!(changed["configuration"]["generation"], 2);
        assert_eq!(changed["configuration"]["systemPrompt"], "");
        assert_eq!(runtime.enabled_steward_wakes().len(), 1);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn steward_task_commands_are_closed_and_project_scoped() {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-steward-task-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let first_folder = path.with_extension("first");
        let second_folder = path.with_extension("second");
        std::fs::create_dir_all(&first_folder).unwrap();
        std::fs::create_dir_all(&second_folder).unwrap();
        let mut runtime = CoreRuntime::new(
            Store::open(&path).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            7,
        )
        .unwrap();
        let first = runtime
            .handle(
                "project.create",
                json!({"name":"First","folderPath":first_folder}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let second = runtime
            .handle(
                "project.create",
                json!({"name":"Second","folderPath":second_folder}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let initial_prompt = "Preserve existing assignment guidance.";
        let initial_effective_prompt =
            termloop_invocation::effective_steward_system_prompt(initial_prompt);
        runtime
            .set_steward_configuration(StewardConfigurationUpdate {
                project_id: &first,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled: true,
                system_prompt: initial_prompt.into(),
                expected_revision: runtime.state_revision(),
                capability: AssistantAvailability::Proven,
                updated_at_epoch_ms: 1,
            })
            .unwrap();
        runtime
            .store
            .attach_steward_executor_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "steward-session".into(),
                    project_id: first.clone(),
                    name: Some("Project Steward".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: first_folder.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.steward.executor".into()),
                        template_version: Some(4),
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
                    launch_selection: Default::default(),
                },
                &first,
                1,
                2,
            )
            .unwrap();
        let created = runtime
            .execute_steward_task_command(
                "steward-session",
                &first,
                "task.create",
                json!({
                    "projectId": first,
                    "title": "Plan release",
                    "brief": null,
                    "worktreeIntent": "none",
                }),
            )
            .unwrap();
        let foreign = runtime
            .handle(
                "task.create",
                json!({
                    "projectId": second,
                    "title": "Foreign",
                    "brief": null,
                    "worktreeIntent": "none",
                }),
            )
            .unwrap();
        assert_eq!(created["title"], "Plan release");
        assert!(matches!(
            runtime.plan_steward_task_agent_start(
                "steward-session",
                &first,
                created["id"].as_str().unwrap(),
                None,
                None,
            ),
            Err(CoreError::TaskAgentStartFailed {
                suggested_action: crate::TaskAgentStartSuggestedAction::ConfigureAgent,
                ..
            })
        ));
        let explicit = runtime
            .plan_steward_task_agent_start(
                "steward-session",
                &first,
                created["id"].as_str().unwrap(),
                Some("claude"),
                Some("fable"),
            )
            .unwrap();
        assert_eq!(explicit.agent_id(), "claude");
        // A Steward-requested Claude opens in auto, the same unconfigured
        // default an ordinary Claude launch resolves, so the mode is identical
        // whoever started the Task Agent.
        assert_eq!(
            explicit.launch_selection(),
            &AgentLaunchSelection::new("fable", "acceptEdits", "default")
        );
        let explicit_default = runtime
            .plan_steward_task_agent_start(
                "steward-session",
                &first,
                created["id"].as_str().unwrap(),
                Some("codex"),
                None,
            )
            .unwrap();
        assert_eq!(explicit_default.agent_id(), "codex");
        assert!(explicit_default.launch_selection().is_default());
        assert!(matches!(
            runtime.plan_steward_task_agent_start(
                "steward-session",
                &first,
                created["id"].as_str().unwrap(),
                None,
                Some("fable"),
            ),
            Err(CoreError::InvalidParams(field)) if field == "agentId"
        ));
        assert!(matches!(
            runtime.plan_steward_task_agent_start(
                "steward-session",
                &first,
                created["id"].as_str().unwrap(),
                Some("codex"),
                Some("opus"),
            ),
            Err(CoreError::InvalidParams(field)) if field == "agentId/model"
        ));
        runtime
            .store
            .insert_session_and_remember_agent_launch(
                &runtime.write_authority,
                termloop_domain::SessionRecord {
                    id: "ordinary-agent".into(),
                    project_id: first.clone(),
                    name: None,
                    kind: termloop_domain::SessionKind::Agent,
                    process: termloop_domain::ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: "/tmp/project-one".into(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.agent.interactive".into()),
                        template_version: Some(1),
                    },
                    launch_selection: termloop_domain::AgentLaunchSelection::new(
                        "gpt-5.6-sol",
                        "bypassPermissions",
                        "high",
                    ),
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
        let start_plan = runtime
            .plan_steward_task_agent_start(
                "steward-session",
                &first,
                created["id"].as_str().unwrap(),
                None,
                None,
            )
            .unwrap();
        assert_eq!(start_plan.agent_id(), "codex");
        assert_eq!(start_plan.launch_selection().model, "gpt-5.6-sol");
        assert_eq!(
            start_plan.launch_selection().permission,
            "bypassPermissions"
        );
        assert_eq!(start_plan.launch_selection().reasoning, "high");
        assert!(
            start_plan
                .branch_name()
                .starts_with("termloop/plan-release-")
        );
        assert!(
            start_plan
                .worktree_leaf()
                .starts_with("termloop-plan-release-")
        );
        assert!(start_plan.worktree_leaf().ends_with("_worktree"));
        assert_eq!(start_plan.operation_id(), created["id"].as_str().unwrap());
        assert!(
            runtime
                .authorize_steward_task_execution(
                    "steward-session",
                    &first,
                    created["id"].as_str().unwrap(),
                )
                .is_ok()
        );
        assert!(matches!(
            runtime.authorize_steward_task_execution(
                "steward-session",
                &first,
                foreign["id"].as_str().unwrap(),
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.authorize_steward_task_execution(
                "not-the-steward",
                &first,
                created["id"].as_str().unwrap(),
            ),
            Err(CoreError::CapabilityDenied)
        ));
        let task_id = created["id"].as_str().unwrap();
        assert_eq!(created["jira_url"], Value::Null);
        let revision = runtime.state_revision();
        assert!(matches!(
            runtime.set_steward_task_jira_url(
                "steward-session",
                &first,
                task_id,
                "TERM-42",
            ),
            Err(CoreError::InvalidParams(field)) if field == "jiraUrl"
        ));
        assert_eq!(runtime.state_revision(), revision);
        assert!(matches!(
            runtime.set_steward_task_jira_url(
                "steward-session",
                &first,
                foreign["id"].as_str().unwrap(),
                "https://example.atlassian.net/browse/TERM-42",
            ),
            Err(CoreError::CapabilityDenied)
        ));
        let jira_url = runtime
            .set_steward_task_jira_url(
                "steward-session",
                &first,
                task_id,
                "https://example.atlassian.net/browse/TERM-42/",
            )
            .unwrap();
        assert_eq!(jira_url, "https://example.atlassian.net/browse/TERM-42");
        assert_eq!(
            runtime.task_current_projection(task_id).unwrap()["jira_url"],
            jira_url
        );
        let revision = runtime.state_revision();
        assert!(matches!(
            runtime.set_steward_task_jira_url(
                "steward-session",
                &first,
                task_id,
                "https://example.atlassian.net/browse/TERM-43",
            ),
            Err(CoreError::TaskJiraUrlAlreadySet { task_id: existing_task_id, jira_url: existing_url })
                if existing_task_id == task_id && existing_url == jira_url
        ));
        assert_eq!(runtime.state_revision(), revision);
        assert!(matches!(
            runtime.execute_steward_task_command(
                "steward-session",
                &first,
                "task.delete",
                json!({"taskId": foreign["id"]}),
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.execute_steward_task_command(
                "steward-session",
                &first,
                "project.delete",
                json!({"projectId": first}),
            ),
            Err(CoreError::CapabilityDenied)
        ));
        for (session_id, session_project, lifecycle) in [
            ("foreign-agent", second.as_str(), "running"),
            ("stopped-agent", first.as_str(), "exited"),
        ] {
            runtime
                .store
                .insert_session(
                    &runtime.write_authority,
                    SessionRecord {
                        id: session_id.into(),
                        project_id: session_project.into(),
                        name: None,
                        kind: SessionKind::Agent,
                        process: ProcessDescriptor {
                            program: "codex".into(),
                            args: vec![],
                            cwd: first_folder.to_string_lossy().into_owned(),
                            agent_id: Some("codex".into()),
                            template_ref: Some("builtin.agent.interactive".into()),
                            template_version: Some(1),
                        },
                        lifecycle_state: lifecycle.into(),
                        runtime_epoch: 7,
                        archived_at_epoch_ms: None,
                        ask_to_source_session_id: None,
                        run_configuration_id: None,
                        improver_target: None,
                        ask_to_continuation: None,
                        resume_ref: None,
                        resume_launch_guard: None,
                        resume_failure: None,
                        launch_selection: Default::default(),
                    },
                )
                .unwrap();
        }
        for target in ["foreign-agent", "stopped-agent", "steward-session"] {
            assert!(matches!(
                runtime.send_steward_agent_message(
                    "steward-session",
                    &first,
                    target,
                    "Please report status."
                ),
                Err(CoreError::CapabilityDenied)
            ));
        }
        assert!(matches!(
            runtime.append_steward_suggestion(
                "steward-session",
                &first,
                "proposal",
                CompanionMessageRefsInput {
                    task_id: Some(foreign["id"].as_str().unwrap().into()),
                    session_id: None,
                    routine_finding_id: None,
                    routine_finding_ids: vec![],
                },
                "May I change that Task?".into(),
                3,
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(
            runtime
                .append_steward_suggestion(
                    "steward-session",
                    &first,
                    "proposal",
                    CompanionMessageRefsInput {
                        task_id: Some(created["id"].as_str().unwrap().into()),
                        session_id: Some("stopped-agent".into()),
                        routine_finding_id: None,
                        routine_finding_ids: vec![],
                    },
                    "May I continue this Task?".into(),
                    4,
                )
                .is_ok()
        );
        for kind in ["suggestion", "proposal"] {
            assert!(matches!(
                runtime.append_steward_suggestion(
                    "steward-session",
                    &first,
                    kind,
                    CompanionMessageRefsInput {
                        task_id: Some(created["id"].as_str().unwrap().into()),
                        session_id: None,
                        routine_finding_id: None,
                        routine_finding_ids: vec![],
                    },
                    "A second unanswered interaction.".into(),
                    5,
                ),
                Err(CoreError::CompanionProposalPending { proposal_message_id })
                    if !proposal_message_id.is_empty()
            ));
        }
        let same_prompt_request = runtime
            .append_companion_message(
                &first,
                "user",
                "reply",
                CompanionMessageRefsInput::default(),
                "Keep the current system prompt.".into(),
                5,
            )
            .unwrap()["message"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            !runtime
                .update_steward_system_prompt(
                    "steward-session",
                    &first,
                    &same_prompt_request,
                    initial_prompt,
                    initial_prompt,
                    6,
                )
                .unwrap()
        );
        assert_eq!(
            runtime
                .steward_system_prompt_for_executor("steward-session", &first)
                .unwrap()["systemPrompt"],
            initial_prompt
        );
        assert_eq!(
            runtime.steward_executor_session_id(&first).as_deref(),
            Some("steward-session")
        );

        runtime
            .append_steward_suggestion(
                "steward-session",
                &first,
                "reply",
                CompanionMessageRefsInput::default(),
                "The current prompt is unchanged.".into(),
                7,
            )
            .unwrap();
        assert!(matches!(
            runtime.update_steward_system_prompt(
                "steward-session",
                &first,
                &same_prompt_request,
                initial_prompt,
                "Be concise.",
                8,
            ),
            Err(CoreError::CapabilityDenied)
        ));

        let change_request = runtime
            .append_companion_message(
                &first,
                "user",
                "reply",
                CompanionMessageRefsInput::default(),
                "Change your system prompt to be concise.".into(),
                9,
            )
            .unwrap()["message"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let foreign_request = runtime
            .append_companion_message(
                &second,
                "user",
                "reply",
                CompanionMessageRefsInput::default(),
                "Change the other Project's prompt.".into(),
                9,
            )
            .unwrap()["message"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(matches!(
            runtime.update_steward_system_prompt(
                "steward-session",
                &first,
                &foreign_request,
                initial_prompt,
                "Be concise.",
                10,
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.update_steward_system_prompt(
                "steward-session",
                &first,
                &same_prompt_request,
                initial_prompt,
                "Be concise.",
                10,
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.update_steward_system_prompt(
                "not-the-steward",
                &first,
                &change_request,
                initial_prompt,
                "Be concise.",
                10,
            ),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.update_steward_system_prompt(
                "steward-session",
                &first,
                &change_request,
                "stale source text",
                "Preserve existing assignment guidance.\n\nBe concise.",
                10,
            ),
            Err(CoreError::RevisionConflict)
        ));
        assert!(matches!(
            runtime.update_steward_system_prompt(
                "steward-session",
                &first,
                &change_request,
                initial_prompt,
                &format!("{initial_effective_prompt}\n\nBe concise."),
                10,
            ),
            Err(CoreError::InvalidParams(field)) if field == "systemPrompt"
        ));
        assert!(matches!(
            runtime.update_steward_system_prompt(
                "steward-session",
                &first,
                &change_request,
                initial_prompt,
                &"x".repeat(termloop_domain::STEWARD_SYSTEM_PROMPT_MAX_BYTES + 1),
                10,
            ),
            Err(CoreError::InvalidParams(field)) if field == "systemPrompt"
        ));
        let replacement_prompt = format!(
            "{initial_prompt}\n\n{}",
            "x".repeat(termloop_domain::STEWARD_SYSTEM_PROMPT_MAX_BYTES - initial_prompt.len() - 2)
        );
        assert_eq!(
            replacement_prompt.len(),
            termloop_domain::STEWARD_SYSTEM_PROMPT_MAX_BYTES
        );
        assert!(
            runtime
                .update_steward_system_prompt(
                    "steward-session",
                    &first,
                    &change_request,
                    initial_prompt,
                    &replacement_prompt,
                    10,
                )
                .unwrap()
        );
        let changed = runtime
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == first)
            .unwrap();
        assert_eq!(changed.system_prompt, replacement_prompt);
        assert_eq!(changed.generation, 2);
        assert_eq!(changed.executor_session_id, None);
        let projected = runtime
            .get_steward_configuration(json!({"projectId": first}))
            .unwrap();
        assert_eq!(
            projected["configuration"]["systemPrompt"],
            replacement_prompt
        );
        assert!(
            projected["promptContext"]["initialPrompt"]
                .as_str()
                .unwrap()
                .contains("Persistent Assistant Activation")
        );
        assert_eq!(
            projected["promptContext"]["instructionsPrompt"],
            termloop_invocation::effective_steward_system_prompt(&replacement_prompt)
        );
        assert_eq!(
            projected["promptContext"]["protectedPrompt"],
            termloop_invocation::default_steward_system_prompt()
        );
        let wake_prompt = projected["promptContext"]["wakePrompt"].as_str().unwrap();
        assert!(wake_prompt.contains("**Delivery pipeline moved**"));
        assert!(wake_prompt.contains("visible Steward wake protocol"));
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(first_folder);
        let _ = std::fs::remove_dir_all(second_folder);
    }

    #[test]
    fn initial_task_assignment_requires_authenticated_readiness_and_consumption() {
        let pending = crate::AgentObservationCapability {
            token: None,
            runtime_epoch: 1,
            last_signal: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
            observation: Some(termloop_agents::AgentObservation {
                state: termloop_agents::AgentState::Idle,
                source: termloop_agents::AgentSignalSource::DaemonBridge,
                sequence: 1,
                observed_at_epoch_ms: 1,
            }),
            pending_generated_input: Some(crate::test_generated_terminal_submission("assignment")),
        };
        let delivered = crate::AgentObservationCapability {
            token: None,
            runtime_epoch: 1,
            last_signal: None,
            defer_generated_input_until_hook_response: false,
            last_notification_type: None,
            observation: pending.observation,
            pending_generated_input: None,
        };
        assert_eq!(
            initial_assignment_state(Some("builtin.steward.task-assignment"), None),
            Some(StewardTaskAgentAssignmentState::Pending)
        );
        assert_eq!(
            initial_assignment_state(Some("builtin.steward.task-assignment"), Some(&pending)),
            Some(StewardTaskAgentAssignmentState::Pending)
        );
        assert_eq!(
            initial_assignment_state(Some("builtin.steward.task-assignment"), Some(&delivered)),
            Some(StewardTaskAgentAssignmentState::Delivered)
        );
        assert_eq!(
            initial_assignment_state(Some("builtin.agent.interactive"), Some(&delivered)),
            None
        );
    }
}
