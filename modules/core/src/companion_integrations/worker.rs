//! Durable Project Worker configuration. A Worker owns one persistent ordinary
//! assistant Session and may execute several Tracker assignments sequentially.

use crate::companion_integrations::steward::AssistantAvailability;
use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde_json::{Value, json};
use termloop_domain::{StewardAgentId, WorkerConfiguration};

impl CoreRuntime {
    /// Returns enabled Workers whose previous daemon-owned PTY is no longer
    /// current. The server uses this bounded snapshot once at startup so an
    /// enabled persistent Worker does not require a redundant Save click after
    /// daemon recovery.
    pub fn enabled_worker_ids_needing_launch(&self) -> Vec<String> {
        self.store
            .worker_configurations()
            .iter()
            .filter(|worker| worker.enabled && worker.executor_session_id.is_none())
            .map(|worker| worker.id.clone())
            .collect()
    }

    pub fn worker_executor_session_id(&self, worker_id: &str) -> Option<String> {
        self.store
            .worker_configurations()
            .iter()
            .find(|worker| worker.id == worker_id)
            .and_then(|worker| worker.executor_session_id.clone())
    }

    pub(crate) fn list_worker_configurations(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let configurations = self
            .store
            .worker_configurations()
            .iter()
            .filter(|worker| worker.project_id == project_id)
            .collect::<Vec<_>>();
        let protected_prompt =
            termloop_invocation::executor_prompt(termloop_invocation::ExecutorRole::Worker)
                .map_err(|_| CoreError::Store("invalid Worker runtime prompt".into()))?;
        let wake_prompt = termloop_invocation::assistant_wake_message(
            termloop_invocation::ExecutorRole::Worker,
            termloop_invocation::AssistantWakeReason::ScheduledCheck,
            None,
            None,
        )
        .map_err(|_| CoreError::Store("invalid Worker wake prompt".into()))?;
        let activation_prompt = termloop_invocation::assistant_activation_message(
            termloop_invocation::ExecutorRole::Worker,
        )
        .map_err(|_| CoreError::Store("invalid Worker activation prompt".into()))?;
        let prompt_contexts = configurations
            .iter()
            .map(|worker| {
                json!({
                    "workerId": worker.id,
                    "initialPrompt": activation_prompt.delivered_preview(),
                    "instructionsPrompt": termloop_invocation::effective_worker_prompt(
                        &worker.worker_prompt,
                        &worker.system_prompt,
                    ),
                    "instructionDelivery": match worker.agent_id {
                        StewardAgentId::Claude => "claudeAppendedSystemPrompt",
                        StewardAgentId::Codex => "codexDeveloperInstructions",
                    },
                    "protectedPrompt": protected_prompt.delivered_preview().trim(),
                    "wakePrompt": wake_prompt.delivered_preview(),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "configurations": configurations,
            "promptContexts": prompt_contexts,
            "stateRevision": self.store.revision(),
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_worker_configuration(
        &mut self,
        id: String,
        project_id: &str,
        name: String,
        agent_id: &str,
        enabled: bool,
        model: String,
        permission: String,
        reasoning: String,
        ping_interval_seconds: u64,
        worker_prompt: String,
        system_prompt: String,
        expected_revision: u64,
        availability: AssistantAvailability,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        if enabled && availability != AssistantAvailability::Proven {
            return Err(CoreError::AgentCapabilityUnproven);
        }
        termloop_invocation::validate_agent_configuration(
            agent_id,
            &model,
            &permission,
            &reasoning,
        )
        .map_err(|_| CoreError::InvalidParams("launchSelection".into()))?;
        let configuration = WorkerConfiguration {
            id,
            project_id: project_id.into(),
            name,
            agent_id: parse_agent_id(agent_id)?,
            model,
            permission,
            reasoning,
            enabled,
            ping_interval_seconds,
            worker_prompt,
            system_prompt,
            executor_session_id: None,
            generation: 1,
            updated_at_epoch_ms,
        };
        let configuration = self
            .store
            .set_worker_configuration(&self.write_authority, configuration, expected_revision)
            .map_err(store_error)?;
        Ok(json!({"configuration": configuration, "stateRevision": self.store.revision()}))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_worker_configuration(
        &mut self,
        worker_id: &str,
        name: String,
        agent_id: &str,
        model: String,
        permission: String,
        reasoning: String,
        enabled: bool,
        ping_interval_seconds: u64,
        worker_prompt: String,
        system_prompt: String,
        expected_revision: u64,
        availability: AssistantAvailability,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if enabled && availability != AssistantAvailability::Proven {
            return Err(CoreError::AgentCapabilityUnproven);
        }
        let current = self
            .store
            .worker_configurations()
            .iter()
            .find(|worker| worker.id == worker_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let agent_id = parse_agent_id(agent_id)?;
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
        if current.name == name
            && current.agent_id == agent_id
            && current.model == model
            && current.permission == permission
            && current.reasoning == reasoning
            && current.enabled == enabled
            && current.ping_interval_seconds == ping_interval_seconds
            && current.worker_prompt == worker_prompt
            && current.system_prompt == system_prompt
        {
            if expected_revision != self.store.revision() {
                return Err(CoreError::RevisionConflict);
            }
            return Ok(json!({"configuration": current, "stateRevision": self.store.revision()}));
        }
        let launch_changed = current.name != name
            || current.agent_id != agent_id
            || current.model != model
            || current.permission != permission
            || current.reasoning != reasoning
            || current.enabled != enabled
            || current.worker_prompt != worker_prompt
            || current.system_prompt != system_prompt;
        let generation = if launch_changed {
            current
                .generation
                .checked_add(1)
                .ok_or_else(|| CoreError::InvalidParams("workerId".into()))?
        } else {
            current.generation
        };
        let executor_session_id = (!launch_changed)
            .then(|| current.executor_session_id.clone())
            .flatten();
        let configuration = WorkerConfiguration {
            id: current.id,
            project_id: current.project_id,
            name,
            agent_id,
            model,
            permission,
            reasoning,
            enabled,
            ping_interval_seconds,
            worker_prompt,
            system_prompt,
            executor_session_id,
            generation,
            updated_at_epoch_ms,
        };
        let configuration = self
            .store
            .set_worker_configuration(&self.write_authority, configuration, expected_revision)
            .map_err(store_error)?;
        if !enabled {
            self.tracker_runtime.cancel_worker_checks(worker_id);
        } else if !launch_changed {
            self.tracker_runtime.reschedule_worker_ping(
                worker_id,
                configuration.executor_session_id.as_deref(),
                updated_at_epoch_ms,
                ping_interval_seconds,
            );
        }
        Ok(json!({"configuration": configuration, "stateRevision": self.store.revision()}))
    }

    pub fn delete_worker_configuration(
        &mut self,
        worker_id: &str,
        expected_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let current = self
            .store
            .worker_configurations()
            .iter()
            .find(|configuration| configuration.id == worker_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if expected_revision != self.store.revision() {
            return Err(CoreError::RevisionConflict);
        }
        let routine_ids = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|routine| routine.worker_id == worker_id)
            .map(|routine| routine.id.clone())
            .collect::<Vec<_>>();
        if let Some(session_id) = current.executor_session_id.as_deref() {
            self.retire_owned_assistant_runtime(session_id)?;
        }
        self.tracker_runtime.cancel_worker_checks(worker_id);
        let deleted = self
            .store
            .delete_worker_configuration(
                &self.write_authority,
                worker_id,
                expected_revision,
                updated_at_epoch_ms,
            )
            .map_err(store_error)?;
        for routine_id in &routine_ids {
            self.tracker_runtime.remove_tracker(routine_id);
        }
        Ok(json!({
            "workerId": deleted.id,
            "deleted": true,
            "deletedRoutines": routine_ids.len(),
            "stateRevision": self.store.revision()
        }))
    }
}

fn parse_agent_id(value: &str) -> Result<StewardAgentId, CoreError> {
    match value {
        "claude" => Ok(StewardAgentId::Claude),
        "codex" => Ok(StewardAgentId::Codex),
        _ => Err(CoreError::InvalidParams("agentId".into())),
    }
}
