//! Durable current Tracker assignment configuration. Trackers own no Session;
//! a selected persistent Worker executes their bounded checks.

use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde_json::{Value, json, to_value};
use termloop_domain::{
    RoutineActionHandling, RoutineTriggerMode, TRACKER_PROMPT_MAX_BYTES, TrackerConfiguration,
    TrackerKind,
};

impl CoreRuntime {
    pub fn has_current_routine_findings(&self, project_id: &str) -> bool {
        self.store
            .tracker_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .any(|configuration| {
                configuration
                    .pending_routine_findings
                    .iter()
                    .any(|finding| self.routine_finding_is_current(configuration, finding))
            })
    }

    pub fn read_routine_findings(&self, project_id: &str) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let routines = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .filter_map(|configuration| {
                let findings = configuration
                    .pending_routine_findings
                    .iter()
                    .filter(|finding| self.routine_finding_is_current(configuration, finding))
                    .collect::<Vec<_>>();
                (!findings.is_empty()).then(|| {
                    json!({
                        "routineId": configuration.id,
                        "routineName": configuration.name,
                        "routineGeneration": configuration.generation,
                        "actionHandling": configuration.action_handling,
                        "workerInstructions": configuration.prompt,
                        "stewardInstructions": configuration.steward_instructions,
                        "findings": findings,
                    })
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "routines": routines }))
    }

    pub fn resolve_routine_finding(
        &mut self,
        project_id: &str,
        finding_id: &str,
        resolution: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if !matches!(resolution, "completed" | "dismissed") {
            return Err(CoreError::InvalidParams("resolution".into()));
        }
        let mut configuration = self
            .store
            .tracker_configurations()
            .iter()
            .find(|configuration| {
                configuration.project_id == project_id
                    && configuration
                        .pending_routine_findings
                        .iter()
                        .any(|finding| finding.id == finding_id)
            })
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if !configuration.enabled
            || configuration.action_handling == RoutineActionHandling::Off
            || configuration
                .pending_routine_findings
                .iter()
                .find(|finding| finding.id == finding_id)
                .is_none_or(|finding| !self.routine_finding_is_current(&configuration, finding))
        {
            return Err(CoreError::TrackerReportStale);
        }
        if resolution == "completed"
            && configuration.action_handling == RoutineActionHandling::Ask
            && !self.routine_finding_has_current_approval(project_id, finding_id)
        {
            return Err(CoreError::CapabilityDenied);
        }
        configuration
            .pending_routine_findings
            .retain(|finding| finding.id != finding_id);
        configuration.updated_at_epoch_ms = updated_at_epoch_ms;
        self.store
            .set_tracker_configuration(&self.write_authority, configuration, self.store.revision())
            .map_err(store_error)?;
        Ok(json!({
            "status": "resolved",
            "findingId": finding_id,
            "resolution": resolution,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn current_routine_finding(
        &self,
        project_id: &str,
        finding_id: &str,
    ) -> Option<(
        &TrackerConfiguration,
        &termloop_domain::PendingRoutineFinding,
    )> {
        self.store
            .tracker_configurations()
            .iter()
            .filter(|configuration| {
                configuration.project_id == project_id
                    && configuration.enabled
                    && configuration.action_handling != RoutineActionHandling::Off
            })
            .find_map(|configuration| {
                configuration
                    .pending_routine_findings
                    .iter()
                    .find(|finding| {
                        finding.id == finding_id
                            && self.routine_finding_is_current(configuration, finding)
                    })
                    .map(|finding| (configuration, finding))
            })
    }

    pub(crate) fn routine_finding_is_current(
        &self,
        configuration: &TrackerConfiguration,
        finding: &termloop_domain::PendingRoutineFinding,
    ) -> bool {
        finding.routine_generation == configuration.generation
            && (configuration.trigger_mode.is_scheduled()
                || self.step_waiting_finding_is_current(configuration, finding))
    }

    fn routine_finding_has_current_approval(&self, project_id: &str, finding_id: &str) -> bool {
        self.store
            .companion_messages()
            .iter()
            .rev()
            .find(|message| {
                message.project_id == project_id
                    && message
                        .refs
                        .as_ref()
                        .is_some_and(|refs| refs.references_routine_finding(finding_id))
            })
            .is_some_and(|message| {
                message.author == termloop_domain::CompanionMessageAuthor::User
                    && message.kind == termloop_domain::CompanionMessageKind::Approval
            })
    }

    pub(crate) fn list_tracker_configurations(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let configurations = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .map(tracker_projection)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"configurations": configurations, "stateRevision": self.store.revision()}))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_tracker_configuration(
        &mut self,
        tracker_id: String,
        project_id: &str,
        kind: &str,
        trigger_mode: RoutineTriggerMode,
        name: String,
        worker_id: String,
        schedule_interval_seconds: u64,
        action_handling: RoutineActionHandling,
        prompt: Option<String>,
        steward_instructions: Option<String>,
        expected_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let kind = parse_kind(kind)?;
        // A step check is a pipeline question, not a scan: its built-in
        // instructions are about answering for a named set of Tasks, so the
        // kind only says where the answer comes from.
        let role = if trigger_mode.is_scheduled() {
            super::assistant_session::tracker_role(kind)
        } else {
            termloop_invocation::ExecutorRole::StepCheckTracker
        };
        let prompt = match prompt {
            Some(prompt)
                if !prompt.trim().is_empty() && prompt.len() <= TRACKER_PROMPT_MAX_BYTES =>
            {
                prompt.trim().to_owned()
            }
            Some(_) => return Err(CoreError::InvalidParams("prompt".into())),
            None => termloop_invocation::tracker_assignment_prompt(role)
                .map_err(|error| CoreError::Terminal(error.to_string()))?
                .delivered_preview()
                .to_owned(),
        };
        let steward_instructions = steward_instructions.unwrap_or_default();
        if steward_instructions.len() > TRACKER_PROMPT_MAX_BYTES
            || (action_handling != RoutineActionHandling::Off
                && steward_instructions.trim().is_empty())
        {
            return Err(CoreError::InvalidParams("stewardInstructions".into()));
        }
        let configuration = TrackerConfiguration {
            id: tracker_id,
            project_id: project_id.to_owned(),
            kind,
            trigger_mode,
            name,
            prompt,
            steward_instructions: steward_instructions.trim().to_owned(),
            worker_id,
            enabled: false,
            schedule_interval_seconds,
            generation: 1,
            context_markdown: String::new(),
            context_revision: 1,
            recent_source_keys: vec![],
            related_task_ids: vec![],
            action_handling,
            pending_routine_findings: vec![],
            last_check_started_at_epoch_ms: None,
            last_attempt_at_epoch_ms: None,
            last_successful_report_at_epoch_ms: None,
            updated_at_epoch_ms,
        };
        let configuration = self
            .store
            .set_tracker_configuration(&self.write_authority, configuration, expected_revision)
            .map_err(store_error)?;
        Ok(
            json!({"configuration": tracker_projection(&configuration)?, "stateRevision": self.store.revision()}),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_tracker_configuration(
        &mut self,
        tracker_id: &str,
        trigger_mode: RoutineTriggerMode,
        name: String,
        prompt: String,
        steward_instructions: String,
        worker_id: String,
        enabled: bool,
        schedule_interval_seconds: u64,
        action_handling: RoutineActionHandling,
        expected_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let current = self
            .store
            .tracker_configurations()
            .iter()
            .find(|configuration| configuration.id == tracker_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let worker = self
            .store
            .worker_configurations()
            .iter()
            .find(|worker| worker.id == worker_id && worker.project_id == current.project_id)
            .ok_or(CoreError::NotFound)?;
        if enabled && (!worker.enabled || worker.executor_session_id.is_none()) {
            return Err(CoreError::AgentCapabilityUnproven);
        }
        let changed = current.name != name
            || current.prompt != prompt
            || current.steward_instructions != steward_instructions
            || current.worker_id != worker_id
            || current.enabled != enabled
            || current.trigger_mode != trigger_mode
            || current.schedule_interval_seconds != schedule_interval_seconds
            || current.action_handling != action_handling;
        if !changed {
            if expected_revision != self.store.revision() {
                return Err(CoreError::RevisionConflict);
            }
            return Ok(
                json!({"configuration": tracker_projection(&current)?, "stateRevision": self.store.revision()}),
            );
        }
        if current.enabled && current.worker_id != worker_id {
            return Err(CoreError::TrackerRuntimeActive);
        }
        let generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidParams("routineId".into()))?;
        let configuration = TrackerConfiguration {
            id: current.id,
            project_id: current.project_id,
            kind: current.kind,
            trigger_mode,
            name,
            prompt,
            steward_instructions,
            worker_id,
            enabled,
            schedule_interval_seconds,
            generation,
            context_markdown: current.context_markdown,
            context_revision: current.context_revision,
            recent_source_keys: vec![],
            related_task_ids: current.related_task_ids,
            action_handling,
            pending_routine_findings: vec![],
            last_check_started_at_epoch_ms: current.last_check_started_at_epoch_ms,
            last_attempt_at_epoch_ms: current.last_attempt_at_epoch_ms,
            last_successful_report_at_epoch_ms: current.last_successful_report_at_epoch_ms,
            updated_at_epoch_ms,
        };
        let configuration = self
            .store
            .set_tracker_configuration(&self.write_authority, configuration, expected_revision)
            .map_err(store_error)?;
        self.tracker_runtime.cancel_tracker_check(tracker_id);
        if enabled {
            self.tracker_runtime
                .schedule_tracker_now(tracker_id, updated_at_epoch_ms);
            self.tracker_runtime
                .schedule_worker_ping_now(&configuration.worker_id, updated_at_epoch_ms);
        }
        Ok(
            json!({"configuration": tracker_projection(&configuration)?, "stateRevision": self.store.revision()}),
        )
    }

    pub fn update_routine_context(
        &mut self,
        routine_id: &str,
        context_markdown: String,
        expected_context_revision: u64,
        expected_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let current = self
            .store
            .tracker_configurations()
            .iter()
            .find(|configuration| configuration.id == routine_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if current.context_revision != expected_context_revision {
            return Err(CoreError::RevisionConflict);
        }
        if current.context_markdown == context_markdown {
            if expected_revision != self.store.revision() {
                return Err(CoreError::RevisionConflict);
            }
            return Ok(
                json!({"configuration": tracker_projection(&current)?, "stateRevision": self.store.revision()}),
            );
        }
        let context_revision = current
            .context_revision
            .checked_add(1)
            .ok_or(CoreError::RevisionConflict)?;
        let configuration = TrackerConfiguration {
            context_markdown,
            context_revision,
            updated_at_epoch_ms,
            ..current
        };
        let configuration = self
            .store
            .set_tracker_configuration(&self.write_authority, configuration, expected_revision)
            .map_err(store_error)?;
        Ok(
            json!({"configuration": tracker_projection(&configuration)?, "stateRevision": self.store.revision()}),
        )
    }

    pub fn delete_tracker_configuration(
        &mut self,
        tracker_id: &str,
        expected_revision: u64,
    ) -> Result<Value, CoreError> {
        let current = self
            .store
            .tracker_configurations()
            .iter()
            .find(|configuration| configuration.id == tracker_id)
            .ok_or(CoreError::NotFound)?;
        if current.enabled || self.tracker_runtime.tracker_is_active(tracker_id) {
            return Err(CoreError::TrackerRuntimeActive);
        }
        if let Some((pipeline, step)) = self.playbook_step_holding_routine(tracker_id) {
            return Err(CoreError::PlaybookStepRoutineHeld { step, pipeline });
        }
        let deleted = self
            .store
            .delete_tracker_configuration(&self.write_authority, tracker_id, expected_revision)
            .map_err(store_error)?;
        self.tracker_runtime.remove_tracker(tracker_id);
        Ok(
            json!({"routineId": deleted.id, "deleted": true, "stateRevision": self.store.revision()}),
        )
    }
}

fn tracker_projection(configuration: &TrackerConfiguration) -> Result<Value, CoreError> {
    to_value(configuration).map_err(|error| CoreError::Store(error.to_string()))
}

fn parse_kind(value: &str) -> Result<TrackerKind, CoreError> {
    match value {
        "slack" => Ok(TrackerKind::Slack),
        "jira" => Ok(TrackerKind::Jira),
        "runtime" => Ok(TrackerKind::Runtime),
        "delivery" => Ok(TrackerKind::Delivery),
        "ciPr" => Ok(TrackerKind::CiPr),
        "custom" => Ok(TrackerKind::Custom),
        _ => Err(CoreError::InvalidParams("kind".into())),
    }
}
