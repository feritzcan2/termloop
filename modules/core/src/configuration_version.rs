use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use termloop_domain::{
    ImproverSessionTarget, ImproverSessionTargetKind, McpToolDescription, RoutineActionHandling,
    RoutineTriggerMode, RunConfiguration, RunConfigurationEnvVar, RunConfigurationKind,
    RunSetupPolicy, StewardAgentId, StewardConfiguration, TrackerConfiguration, TrackerKind,
    WorkerConfiguration,
};

use crate::companion_integrations::playbook::{PlaybookMilestoneDraft, PlaybookPipelineDraft};
use crate::{
    AssistantAvailability, CoreError, CoreRuntime, StewardConfigurationUpdate, required_string,
    store_error,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StewardSnapshot {
    agent_id: StewardAgentId,
    model: String,
    permission: String,
    reasoning: String,
    enabled: bool,
    system_prompt: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerSnapshot {
    name: String,
    agent_id: StewardAgentId,
    model: String,
    permission: String,
    reasoning: String,
    enabled: bool,
    ping_interval_seconds: u64,
    worker_prompt: String,
    system_prompt: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoutineSnapshot {
    kind: TrackerKind,
    trigger_mode: RoutineTriggerMode,
    name: String,
    prompt: String,
    steward_instructions: String,
    worker_id: String,
    enabled: bool,
    schedule_interval_seconds: u64,
    action_handling: RoutineActionHandling,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlaybookSnapshot {
    active_pipeline_name: String,
    milestones: Vec<PlaybookMilestoneDraft>,
    saved_pipelines: Vec<PlaybookPipelineDraft>,
    worker_id: Option<String>,
    preferred_worker_agent_id: StewardAgentId,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunConfigurationSnapshot {
    name: String,
    kind: RunConfigurationKind,
    command: String,
    working_directory: String,
    env: Vec<RunConfigurationEnvVar>,
    setup_command: Option<String>,
    setup_policy: RunSetupPolicy,
    url_auto_detect: bool,
    fallback_urls: Vec<String>,
    auto_open_first_url: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewRoutineSnapshot {
    name: String,
    kind: TrackerKind,
    trigger_mode: RoutineTriggerMode,
    prompt: String,
    steward_instructions: String,
    enabled: bool,
    schedule_interval_seconds: u64,
    action_handling: RoutineActionHandling,
}

#[derive(Debug, Clone)]
pub struct ConfigurationApplicationPlan {
    pub project_id: String,
    pub target: ImproverSessionTarget,
    pub content: String,
    pub summary: String,
    pub expected_previous_version_id: Option<String>,
    pub expected_current_content: Option<String>,
    pub source_session_id: Option<String>,
    pub selected_existing_version_id: Option<String>,
}

#[derive(Debug, Default)]
pub struct ConfigurationApplicationEffects {
    pub retired_session_ids: Vec<String>,
    pub launch_worker_id: Option<String>,
    pub steward_configuration_changed: bool,
    pub tracker_runtime_changed: bool,
}

impl CoreRuntime {
    pub fn sync_external_configuration_version(
        &mut self,
        project_id: &str,
        target: ImproverSessionTarget,
        content: String,
        observed_at_epoch_ms: u64,
    ) -> Result<(), CoreError> {
        if !self.project_exists(project_id)
            || !matches!(
                target.target_kind,
                ImproverSessionTargetKind::SettingsSkill
                    | ImproverSessionTargetKind::SettingsPrompt
                    | ImproverSessionTargetKind::SettingsMcpTool
            )
        {
            return Err(CoreError::InvalidParams("target".into()));
        }
        let content = self.canonicalize_configuration_content(project_id, &target, &content)?;
        self.store
            .sync_external_configuration_version(
                &self.write_authority,
                project_id,
                target,
                content,
                observed_at_epoch_ms,
            )
            .map_err(store_error)?;
        Ok(())
    }

    pub(crate) fn list_configuration_versions(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let target = target_from_wire(&params)?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let versions = self
            .store
            .configuration_versions()
            .iter()
            .filter(|version| version.project_id == project_id && version.target == target)
            .map(version_value)
            .collect::<Vec<_>>();
        let active_version_id = self
            .store
            .active_configuration_version(&project_id, &target)
            .map(|version| version.id.as_str());
        Ok(json!({
            "target": target_value(&target),
            "activeVersionId": active_version_id,
            "versions": versions,
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn read_improver_configuration_version(
        &self,
        session_id: &str,
        target: &ImproverSessionTarget,
    ) -> Result<Value, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if session.improver_target.as_ref() != Some(target) {
            return Err(CoreError::CapabilityDenied);
        }
        let active = self
            .store
            .active_configuration_version(&session.project_id, target);
        Ok(json!({
            "activeVersionId": active.map(|version| version.id.as_str()),
            "content": active.map(|version| version.content.as_str()),
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn prepare_improver_configuration_write(
        &self,
        session_id: &str,
        target: &ImproverSessionTarget,
        expected_active_version_id: Option<String>,
        content: String,
        summary: String,
    ) -> Result<ConfigurationApplicationPlan, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if session.improver_target.as_ref() != Some(target) {
            return Err(CoreError::CapabilityDenied);
        }
        let active = self
            .store
            .active_configuration_version(&session.project_id, target);
        let active_id = active.map(|version| version.id.clone());
        if active_id != expected_active_version_id {
            return Err(CoreError::RevisionConflict);
        }
        let content =
            self.canonicalize_configuration_content(&session.project_id, target, &content)?;
        Ok(ConfigurationApplicationPlan {
            project_id: session.project_id,
            target: target.clone(),
            content,
            summary: summary.trim().to_owned(),
            expected_previous_version_id: active_id,
            expected_current_content: active.map(|version| version.content.clone()),
            source_session_id: Some(session_id.to_owned()),
            selected_existing_version_id: None,
        })
    }

    pub fn prepare_configuration_version_restore(
        &self,
        params: Value,
    ) -> Result<ConfigurationApplicationPlan, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let version_id = required_string(&params, "versionId")?;
        let expected_active_version_id =
            required_nullable_string(&params, "expectedActiveVersionId")?;
        let version = self
            .store
            .configuration_versions()
            .iter()
            .find(|version| version.id == version_id && version.project_id == project_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let active_id = self
            .store
            .active_configuration_version(&project_id, &version.target)
            .map(|active| active.id.clone());
        let expected_current_content = self
            .store
            .active_configuration_version(&project_id, &version.target)
            .map(|active| active.content.clone());
        if active_id != expected_active_version_id {
            return Err(CoreError::RevisionConflict);
        }
        let content = self.canonicalize_configuration_content(
            &project_id,
            &version.target,
            &version.content,
        )?;
        Ok(ConfigurationApplicationPlan {
            project_id,
            target: version.target,
            content,
            summary: format!("Restored version {}", version.sequence),
            expected_previous_version_id: active_id,
            expected_current_content,
            source_session_id: None,
            selected_existing_version_id: Some(version.id),
        })
    }

    pub fn finish_configuration_application(
        &mut self,
        plan: ConfigurationApplicationPlan,
        activated_target: ImproverSessionTarget,
        activated_content: String,
        created_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let previous_version_id = (activated_target == plan.target)
            .then_some(plan.expected_previous_version_id.as_deref())
            .flatten();
        let version =
            if let Some(selected_version_id) = plan.selected_existing_version_id.as_deref() {
                if activated_target != plan.target {
                    return Err(CoreError::InvalidParams("versionId".into()));
                }
                self.store
                    .select_configuration_version(
                        &self.write_authority,
                        &plan.project_id,
                        &activated_target,
                        previous_version_id,
                        selected_version_id,
                        &activated_content,
                    )
                    .map_err(store_error)?
            } else {
                self.store
                    .finalize_configuration_activation(
                        &self.write_authority,
                        &plan.project_id,
                        &activated_target,
                        previous_version_id,
                        &activated_content,
                        &plan.summary,
                        plan.source_session_id.as_deref(),
                        created_at_epoch_ms,
                    )
                    .map_err(store_error)?
            };
        Ok(json!({
            "target": target_value(&activated_target),
            "activeVersion": version_value(&version),
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn apply_owned_configuration_application(
        &mut self,
        plan: ConfigurationApplicationPlan,
        availability: AssistantAvailability,
        created_at_epoch_ms: u64,
    ) -> Result<(Value, ConfigurationApplicationEffects), CoreError> {
        let mut effects = ConfigurationApplicationEffects::default();
        let activated_target = match plan.target.target_kind {
            ImproverSessionTargetKind::StewardInstructions => {
                let snapshot: StewardSnapshot = parse_snapshot(&plan.content)?;
                let previous_session_id = self.steward_executor_session_id(&plan.project_id);
                let previous_revision = self.store.revision();
                self.set_steward_configuration(StewardConfigurationUpdate {
                    project_id: &plan.project_id,
                    agent_id: agent_wire(snapshot.agent_id),
                    model: snapshot.model,
                    permission: snapshot.permission,
                    reasoning: snapshot.reasoning,
                    enabled: snapshot.enabled,
                    system_prompt: snapshot.system_prompt,
                    expected_revision: self.store.revision(),
                    capability: availability,
                    updated_at_epoch_ms: created_at_epoch_ms,
                })?;
                effects.steward_configuration_changed = self.store.revision() != previous_revision;
                let retained = self.steward_executor_session_id(&plan.project_id);
                if previous_session_id != retained
                    && let Some(session_id) = previous_session_id
                {
                    effects.retired_session_ids.push(session_id);
                }
                plan.target.clone()
            }
            ImproverSessionTargetKind::WorkerInstructions => {
                let snapshot: WorkerSnapshot = parse_snapshot(&plan.content)?;
                let worker_id = plan
                    .target
                    .target_id
                    .as_deref()
                    .ok_or_else(|| CoreError::InvalidParams("targetId".into()))?;
                let previous_session_id = self.worker_executor_session_id(worker_id);
                self.update_worker_configuration(
                    worker_id,
                    snapshot.name,
                    agent_wire(snapshot.agent_id),
                    snapshot.model,
                    snapshot.permission,
                    snapshot.reasoning,
                    snapshot.enabled,
                    snapshot.ping_interval_seconds,
                    snapshot.worker_prompt,
                    snapshot.system_prompt,
                    self.store.revision(),
                    availability,
                    created_at_epoch_ms,
                )?;
                let retained = self.worker_executor_session_id(worker_id);
                if previous_session_id != retained
                    && let Some(session_id) = previous_session_id
                {
                    effects.retired_session_ids.push(session_id);
                }
                if snapshot.enabled && retained.is_none() {
                    effects.launch_worker_id = Some(worker_id.to_owned());
                }
                plan.target.clone()
            }
            ImproverSessionTargetKind::RoutineInstructions => {
                let snapshot: RoutineSnapshot = parse_snapshot(&plan.content)?;
                let routine_id = plan
                    .target
                    .target_id
                    .as_deref()
                    .ok_or_else(|| CoreError::InvalidParams("targetId".into()))?;
                self.apply_routine_snapshot(
                    routine_id,
                    &plan.project_id,
                    snapshot,
                    created_at_epoch_ms,
                )?;
                effects.tracker_runtime_changed = true;
                plan.target.clone()
            }
            ImproverSessionTargetKind::RoutineBuilder => {
                let snapshot: NewRoutineSnapshot = parse_snapshot(&plan.content)?;
                let worker_id = plan
                    .target
                    .target_id
                    .as_deref()
                    .ok_or_else(|| CoreError::InvalidParams("targetId".into()))?;
                let routine_id = termloop_platform::generate_opaque_id();
                let routine = RoutineSnapshot {
                    kind: snapshot.kind,
                    trigger_mode: snapshot.trigger_mode,
                    name: snapshot.name,
                    prompt: snapshot.prompt,
                    steward_instructions: snapshot.steward_instructions,
                    worker_id: worker_id.to_owned(),
                    enabled: snapshot.enabled,
                    schedule_interval_seconds: snapshot.schedule_interval_seconds,
                    action_handling: snapshot.action_handling,
                };
                self.apply_new_routine_snapshot(
                    &routine_id,
                    &plan.project_id,
                    routine,
                    created_at_epoch_ms,
                )?;
                effects.tracker_runtime_changed = true;
                ImproverSessionTarget {
                    target_kind: ImproverSessionTargetKind::RoutineInstructions,
                    target_id: Some(routine_id),
                }
            }
            ImproverSessionTargetKind::Playbook => {
                let snapshot: PlaybookSnapshot = parse_snapshot(&plan.content)?;
                let current = self.store.playbook_for_project(&plan.project_id);
                let steward_was_enabled = self
                    .current_enabled_steward_wake(&plan.project_id)
                    .is_some();
                let routine_capacity = snapshot.milestones.len()
                    + snapshot
                        .saved_pipelines
                        .iter()
                        .map(|pipeline| pipeline.milestones.len())
                        .sum::<usize>();
                let result = self.update_playbook(
                    json!({
                        "projectId": plan.project_id,
                        "activePipelineName": snapshot.active_pipeline_name,
                        "milestones": snapshot.milestones,
                        "savedPipelines": snapshot.saved_pipelines,
                        "workerId": snapshot.worker_id,
                        "preferredWorkerAgentId": snapshot.preferred_worker_agent_id,
                        "expectedPlaybookRevision": current.map_or(0, |value| value.revision),
                        "expectedRevision": self.store.revision(),
                    }),
                    termloop_platform::generate_opaque_id(),
                    (0..routine_capacity)
                        .map(|_| termloop_platform::generate_opaque_id())
                        .collect(),
                    availability == AssistantAvailability::Proven,
                    created_at_epoch_ms,
                )?;
                effects.launch_worker_id = result["workerId"].as_str().map(ToOwned::to_owned);
                effects.tracker_runtime_changed = true;
                effects.steward_configuration_changed = !steward_was_enabled
                    && self
                        .current_enabled_steward_wake(&plan.project_id)
                        .is_some();
                plan.target.clone()
            }
            ImproverSessionTargetKind::RunConfiguration
            | ImproverSessionTargetKind::NewRunConfiguration => {
                let snapshot: RunConfigurationSnapshot = parse_snapshot(&plan.content)?;
                let mut params = serde_json::to_value(snapshot)
                    .map_err(|error| CoreError::Store(error.to_string()))?;
                params["expectedRevision"] = json!(self.store.revision());
                let (method, activated_target) =
                    if let Some(configuration_id) = plan.target.target_id.as_ref() {
                        params["configurationId"] = json!(configuration_id);
                        ("runConfiguration.update", plan.target.clone())
                    } else {
                        params["projectId"] = json!(plan.project_id.clone());
                        (
                            "runConfiguration.create",
                            ImproverSessionTarget {
                                target_kind: ImproverSessionTargetKind::RunConfiguration,
                                target_id: None,
                            },
                        )
                    };
                let result = self.handle(method, params)?;
                let mut activated_target = activated_target;
                if activated_target.target_id.is_none() {
                    activated_target.target_id = result["configuration"]["id"]
                        .as_str()
                        .map(ToOwned::to_owned);
                }
                activated_target
            }
            ImproverSessionTargetKind::SettingsMcpTool => {
                let tool = plan
                    .target
                    .target_id
                    .as_deref()
                    .ok_or_else(|| CoreError::InvalidParams("targetId".into()))?;
                self.update_mcp_tool_description(json!({
                    "tool": tool,
                    "description": plan.content.clone(),
                    "expectedRevision": self.store.revision(),
                }))?;
                plan.target.clone()
            }
            ImproverSessionTargetKind::SettingsSkill
            | ImproverSessionTargetKind::SettingsPrompt => {
                return Err(CoreError::InvalidParams(
                    "externalConfigurationTarget".into(),
                ));
            }
        };
        let activated_content = self
            .store
            .active_configuration_version(&plan.project_id, &activated_target)
            .map(|version| version.content.clone())
            .unwrap_or_else(|| plan.content.clone());
        let result = self.finish_configuration_application(
            plan,
            activated_target,
            activated_content,
            created_at_epoch_ms,
        )?;
        Ok((result, effects))
    }

    fn apply_routine_snapshot(
        &mut self,
        routine_id: &str,
        project_id: &str,
        snapshot: RoutineSnapshot,
        updated_at_epoch_ms: u64,
    ) -> Result<(), CoreError> {
        let current = self
            .store
            .tracker_configurations()
            .iter()
            .find(|configuration| {
                configuration.id == routine_id && configuration.project_id == project_id
            })
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if current.enabled && current.worker_id != snapshot.worker_id {
            return Err(CoreError::TrackerRuntimeActive);
        }
        let mut candidate = routine_candidate(
            routine_id,
            project_id,
            &snapshot,
            current.generation.saturating_add(1),
            updated_at_epoch_ms,
        );
        candidate.context_markdown = current.context_markdown;
        candidate.context_revision = current.context_revision;
        candidate.related_task_ids = current.related_task_ids;
        candidate.last_check_started_at_epoch_ms = current.last_check_started_at_epoch_ms;
        candidate.last_attempt_at_epoch_ms = current.last_attempt_at_epoch_ms;
        candidate.last_successful_report_at_epoch_ms = current.last_successful_report_at_epoch_ms;
        self.save_routine_snapshot(candidate, updated_at_epoch_ms)
    }

    fn apply_new_routine_snapshot(
        &mut self,
        routine_id: &str,
        project_id: &str,
        snapshot: RoutineSnapshot,
        updated_at_epoch_ms: u64,
    ) -> Result<(), CoreError> {
        let candidate =
            routine_candidate(routine_id, project_id, &snapshot, 1, updated_at_epoch_ms);
        self.save_routine_snapshot(candidate, updated_at_epoch_ms)
    }

    fn save_routine_snapshot(
        &mut self,
        candidate: TrackerConfiguration,
        updated_at_epoch_ms: u64,
    ) -> Result<(), CoreError> {
        if candidate.enabled {
            let worker = self
                .store
                .worker_configurations()
                .iter()
                .find(|worker| {
                    worker.id == candidate.worker_id && worker.project_id == candidate.project_id
                })
                .ok_or(CoreError::NotFound)?;
            if !worker.enabled || worker.executor_session_id.is_none() {
                return Err(CoreError::AgentCapabilityUnproven);
            }
        }
        let routine_id = candidate.id.clone();
        let enabled = candidate.enabled;
        let worker_id = candidate.worker_id.clone();
        self.store
            .set_tracker_configuration(&self.write_authority, candidate, self.store.revision())
            .map_err(store_error)?;
        self.tracker_runtime.cancel_tracker_check(&routine_id);
        if enabled {
            self.tracker_runtime
                .schedule_tracker_now(&routine_id, updated_at_epoch_ms);
            self.tracker_runtime
                .schedule_worker_ping_now(&worker_id, updated_at_epoch_ms);
        }
        Ok(())
    }

    fn canonicalize_configuration_content(
        &self,
        project_id: &str,
        target: &ImproverSessionTarget,
        content: &str,
    ) -> Result<String, CoreError> {
        let invalid = || CoreError::InvalidParams("content".into());
        match target.target_kind {
            ImproverSessionTargetKind::StewardInstructions => {
                let snapshot: StewardSnapshot =
                    serde_json::from_str(content).map_err(|_| invalid())?;
                let current = self
                    .store
                    .steward_configurations()
                    .iter()
                    .find(|configuration| configuration.project_id == project_id)
                    .ok_or(CoreError::NotFound)?;
                termloop_invocation::validate_agent_configuration(
                    agent_wire(snapshot.agent_id),
                    &snapshot.model,
                    &snapshot.permission,
                    &snapshot.reasoning,
                )
                .map_err(|_| invalid())?;
                let candidate = StewardConfiguration {
                    project_id: project_id.to_owned(),
                    agent_id: snapshot.agent_id,
                    model: snapshot.model.clone(),
                    permission: snapshot.permission.clone(),
                    reasoning: snapshot.reasoning.clone(),
                    enabled: snapshot.enabled,
                    system_prompt: snapshot.system_prompt.trim().to_owned(),
                    executor_session_id: current.executor_session_id.clone(),
                    generation: current.generation,
                    updated_at_epoch_ms: current.updated_at_epoch_ms,
                };
                if !candidate.is_valid() {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::WorkerInstructions => {
                let snapshot: WorkerSnapshot =
                    serde_json::from_str(content).map_err(|_| invalid())?;
                let worker_id = target.target_id.as_deref().ok_or_else(invalid)?;
                let current = self
                    .store
                    .worker_configurations()
                    .iter()
                    .find(|configuration| {
                        configuration.id == worker_id && configuration.project_id == project_id
                    })
                    .ok_or(CoreError::NotFound)?;
                termloop_invocation::validate_agent_configuration(
                    agent_wire(snapshot.agent_id),
                    &snapshot.model,
                    &snapshot.permission,
                    &snapshot.reasoning,
                )
                .map_err(|_| invalid())?;
                let candidate = WorkerConfiguration {
                    id: current.id.clone(),
                    project_id: project_id.to_owned(),
                    name: snapshot.name.clone(),
                    agent_id: snapshot.agent_id,
                    model: snapshot.model.clone(),
                    permission: snapshot.permission.clone(),
                    reasoning: snapshot.reasoning.clone(),
                    enabled: snapshot.enabled,
                    ping_interval_seconds: snapshot.ping_interval_seconds,
                    worker_prompt: snapshot.worker_prompt.clone(),
                    system_prompt: snapshot.system_prompt.clone(),
                    executor_session_id: current.executor_session_id.clone(),
                    generation: current.generation,
                    updated_at_epoch_ms: current.updated_at_epoch_ms,
                };
                if !candidate.is_valid() {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::RoutineInstructions => {
                let snapshot: RoutineSnapshot =
                    serde_json::from_str(content).map_err(|_| invalid())?;
                let routine_id = target.target_id.as_deref().ok_or_else(invalid)?;
                let current = self
                    .store
                    .tracker_configurations()
                    .iter()
                    .find(|configuration| {
                        configuration.id == routine_id && configuration.project_id == project_id
                    })
                    .ok_or(CoreError::NotFound)?;
                let candidate = TrackerConfiguration {
                    id: current.id.clone(),
                    project_id: project_id.to_owned(),
                    kind: snapshot.kind,
                    trigger_mode: snapshot.trigger_mode,
                    name: snapshot.name.clone(),
                    prompt: snapshot.prompt.clone(),
                    steward_instructions: snapshot.steward_instructions.clone(),
                    worker_id: snapshot.worker_id.clone(),
                    enabled: snapshot.enabled,
                    schedule_interval_seconds: snapshot.schedule_interval_seconds,
                    generation: current.generation,
                    context_markdown: current.context_markdown.clone(),
                    context_revision: current.context_revision,
                    recent_source_keys: current.recent_source_keys.clone(),
                    related_task_ids: current.related_task_ids.clone(),
                    action_handling: snapshot.action_handling,
                    pending_routine_findings: current.pending_routine_findings.clone(),
                    last_check_started_at_epoch_ms: current.last_check_started_at_epoch_ms,
                    last_attempt_at_epoch_ms: current.last_attempt_at_epoch_ms,
                    last_successful_report_at_epoch_ms: current.last_successful_report_at_epoch_ms,
                    updated_at_epoch_ms: current.updated_at_epoch_ms,
                };
                if !candidate.is_valid()
                    || !self.store.worker_configurations().iter().any(|worker| {
                        worker.id == snapshot.worker_id && worker.project_id == project_id
                    })
                {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::Playbook => {
                let snapshot: PlaybookSnapshot =
                    serde_json::from_str(content).map_err(|_| invalid())?;
                let milestone_count = snapshot.milestones.len()
                    + snapshot
                        .saved_pipelines
                        .iter()
                        .map(|pipeline| pipeline.milestones.len())
                        .sum::<usize>();
                if snapshot.active_pipeline_name.trim().is_empty()
                    || snapshot.milestones.len() > 24
                    || snapshot.saved_pipelines.len() > 16
                    || milestone_count > 24 * 17
                    || snapshot.worker_id.as_deref().is_some_and(|worker_id| {
                        !self
                            .store
                            .worker_configurations()
                            .iter()
                            .any(|worker| worker.id == worker_id && worker.project_id == project_id)
                    })
                {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::RunConfiguration => {
                let snapshot: RunConfigurationSnapshot =
                    serde_json::from_str(content).map_err(|_| invalid())?;
                let configuration_id = target.target_id.as_deref().ok_or_else(invalid)?;
                let current = self
                    .store
                    .run_configurations()
                    .iter()
                    .find(|configuration| {
                        configuration.id == configuration_id
                            && configuration.project_id == project_id
                    })
                    .ok_or(CoreError::NotFound)?;
                if !run_candidate(
                    project_id,
                    current.id.clone(),
                    current.generation,
                    &snapshot,
                )
                .is_valid()
                {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::NewRunConfiguration => {
                let snapshot: RunConfigurationSnapshot =
                    serde_json::from_str(content).map_err(|_| invalid())?;
                if !run_candidate(project_id, "candidate".into(), 1, &snapshot).is_valid() {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::RoutineBuilder => {
                let snapshot: NewRoutineSnapshot =
                    serde_json::from_str(content).map_err(|_| invalid())?;
                let worker_id = target.target_id.as_deref().ok_or_else(invalid)?;
                if !self
                    .store
                    .worker_configurations()
                    .iter()
                    .any(|worker| worker.id == worker_id && worker.project_id == project_id)
                {
                    return Err(CoreError::NotFound);
                }
                let candidate = TrackerConfiguration {
                    id: "candidate".into(),
                    project_id: project_id.to_owned(),
                    kind: snapshot.kind,
                    trigger_mode: snapshot.trigger_mode,
                    name: snapshot.name.clone(),
                    prompt: snapshot.prompt.clone(),
                    steward_instructions: snapshot.steward_instructions.clone(),
                    worker_id: worker_id.to_owned(),
                    enabled: snapshot.enabled,
                    schedule_interval_seconds: snapshot.schedule_interval_seconds,
                    generation: 1,
                    context_markdown: String::new(),
                    context_revision: 1,
                    recent_source_keys: vec![],
                    related_task_ids: vec![],
                    action_handling: snapshot.action_handling,
                    pending_routine_findings: vec![],
                    last_check_started_at_epoch_ms: None,
                    last_attempt_at_epoch_ms: None,
                    last_successful_report_at_epoch_ms: None,
                    updated_at_epoch_ms: 1,
                };
                if !candidate.is_valid() {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::SettingsMcpTool => {
                McpToolDescription::new(content.to_owned()).ok_or_else(invalid)?;
                Ok(content.to_owned())
            }
            ImproverSessionTargetKind::SettingsSkill
            | ImproverSessionTargetKind::SettingsPrompt => {
                if content.trim().is_empty()
                    || content.len() > termloop_domain::CONFIGURATION_VERSION_CONTENT_MAX_BYTES
                {
                    return Err(invalid());
                }
                Ok(content.to_owned())
            }
        }
    }
}

fn required_nullable_string(params: &Value, field: &str) -> Result<Option<String>, CoreError> {
    let value = params
        .as_object()
        .and_then(|object| object.get(field))
        .ok_or_else(|| CoreError::InvalidParams(field.into()))?;
    if value.is_null() {
        Ok(None)
    } else {
        value
            .as_str()
            .filter(|value| !value.is_empty())
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| CoreError::InvalidParams(field.into()))
    }
}

fn parse_snapshot<T: for<'de> Deserialize<'de>>(content: &str) -> Result<T, CoreError> {
    serde_json::from_str(content).map_err(|_| CoreError::InvalidParams("content".into()))
}

fn routine_candidate(
    id: &str,
    project_id: &str,
    snapshot: &RoutineSnapshot,
    generation: u64,
    updated_at_epoch_ms: u64,
) -> TrackerConfiguration {
    TrackerConfiguration {
        id: id.to_owned(),
        project_id: project_id.to_owned(),
        kind: snapshot.kind,
        trigger_mode: snapshot.trigger_mode,
        name: snapshot.name.clone(),
        prompt: snapshot.prompt.clone(),
        steward_instructions: snapshot.steward_instructions.clone(),
        worker_id: snapshot.worker_id.clone(),
        enabled: snapshot.enabled,
        schedule_interval_seconds: snapshot.schedule_interval_seconds,
        generation,
        context_markdown: String::new(),
        context_revision: 1,
        recent_source_keys: vec![],
        related_task_ids: vec![],
        action_handling: snapshot.action_handling,
        pending_routine_findings: vec![],
        last_check_started_at_epoch_ms: None,
        last_attempt_at_epoch_ms: None,
        last_successful_report_at_epoch_ms: None,
        updated_at_epoch_ms: updated_at_epoch_ms.max(1),
    }
}

pub(crate) fn target_from_wire(params: &Value) -> Result<ImproverSessionTarget, CoreError> {
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .and_then(target_kind_from_wire)
        .ok_or_else(|| CoreError::InvalidParams("kind".into()))?;
    let target = ImproverSessionTarget {
        target_kind: kind,
        target_id: params
            .get("targetId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    };
    target
        .is_well_formed()
        .then_some(target)
        .ok_or_else(|| CoreError::InvalidParams("targetId".into()))
}

pub fn target_kind_wire(kind: ImproverSessionTargetKind) -> &'static str {
    match kind {
        ImproverSessionTargetKind::StewardInstructions => "stewardInstructions",
        ImproverSessionTargetKind::WorkerInstructions => "workerInstructions",
        ImproverSessionTargetKind::RoutineInstructions => "routineInstructions",
        ImproverSessionTargetKind::RoutineBuilder => "routineBuilder",
        ImproverSessionTargetKind::Playbook => "playbook",
        ImproverSessionTargetKind::RunConfiguration => "runConfiguration",
        ImproverSessionTargetKind::NewRunConfiguration => "newRunConfiguration",
        ImproverSessionTargetKind::SettingsSkill => "settingsSkill",
        ImproverSessionTargetKind::SettingsPrompt => "settingsPrompt",
        ImproverSessionTargetKind::SettingsMcpTool => "settingsMcpTool",
    }
}

fn target_kind_from_wire(value: &str) -> Option<ImproverSessionTargetKind> {
    Some(match value {
        "stewardInstructions" => ImproverSessionTargetKind::StewardInstructions,
        "workerInstructions" => ImproverSessionTargetKind::WorkerInstructions,
        "routineInstructions" => ImproverSessionTargetKind::RoutineInstructions,
        "routineBuilder" => ImproverSessionTargetKind::RoutineBuilder,
        "playbook" => ImproverSessionTargetKind::Playbook,
        "runConfiguration" => ImproverSessionTargetKind::RunConfiguration,
        "newRunConfiguration" => ImproverSessionTargetKind::NewRunConfiguration,
        "settingsSkill" => ImproverSessionTargetKind::SettingsSkill,
        "settingsPrompt" => ImproverSessionTargetKind::SettingsPrompt,
        "settingsMcpTool" => ImproverSessionTargetKind::SettingsMcpTool,
        _ => return None,
    })
}

fn target_value(target: &ImproverSessionTarget) -> Value {
    json!({
        "kind": target_kind_wire(target.target_kind),
        "targetId": target.target_id,
    })
}

fn version_value(version: &termloop_domain::ConfigurationVersion) -> Value {
    json!({
        "id": version.id,
        "target": target_value(&version.target),
        "sequence": version.sequence,
        "content": version.content,
        "summary": version.summary,
        "sourceSessionId": version.source_session_id,
        "createdAtEpochMs": version.created_at_epoch_ms,
    })
}

fn run_candidate(
    project_id: &str,
    id: String,
    generation: u64,
    snapshot: &RunConfigurationSnapshot,
) -> RunConfiguration {
    RunConfiguration {
        id,
        project_id: project_id.to_owned(),
        name: snapshot.name.clone(),
        kind: snapshot.kind,
        command: snapshot.command.clone(),
        working_directory: snapshot.working_directory.clone(),
        env: snapshot.env.clone(),
        setup_command: snapshot.setup_command.clone(),
        setup_policy: snapshot.setup_policy,
        url_auto_detect: snapshot.url_auto_detect,
        fallback_urls: snapshot.fallback_urls.clone(),
        auto_open_first_url: snapshot.auto_open_first_url,
        generation,
        updated_at_epoch_ms: 1,
    }
}

fn agent_wire(agent_id: StewardAgentId) -> &'static str {
    match agent_id {
        StewardAgentId::Claude => "claude",
        StewardAgentId::Codex => "codex",
    }
}

fn serialize(value: &impl Serialize) -> Result<String, CoreError> {
    serde_json::to_string(value).map_err(|error| CoreError::Store(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::TerminalService;

    fn runtime() -> (CoreRuntime, std::path::PathBuf, ImproverSessionTarget) {
        let state_path = std::env::temp_dir().join(format!(
            "termloop-core-configuration-version-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project_path = state_path.with_extension("project");
        std::fs::create_dir_all(&project_path).unwrap();
        let project_folder = project_path.to_string_lossy().into_owned();
        let mut runtime = CoreRuntime::new(
            Store::open(&state_path).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        runtime
            .handle(
                "project.create",
                json!({"name":"Project","folderPath":project_folder.clone()}),
            )
            .unwrap();
        runtime
            .handle(
                "runConfiguration.create",
                json!({
                    "projectId": runtime.store.projects()[0].id,
                    "name": "Development",
                    "kind": "devServer",
                    "command": "npm run dev",
                    "workingDirectory": ".",
                    "env": [],
                    "setupCommand": null,
                    "setupPolicy": "never",
                    "urlAutoDetect": true,
                    "fallbackUrls": [],
                    "autoOpenFirstUrl": false,
                    "expectedRevision": runtime.state_revision()
                }),
            )
            .unwrap();
        let project_id = runtime.store.projects()[0].id.clone();
        let run_id = runtime.store.run_configurations()[0].id.clone();
        let target = ImproverSessionTarget {
            target_kind: ImproverSessionTargetKind::RunConfiguration,
            target_id: Some(run_id),
        };
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "improver-session".into(),
                    project_id,
                    name: Some("Improve run".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: project_folder,
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.improver.run-configuration".into()),
                        template_version: Some(1),
                    },
                    launch_selection: Default::default(),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: Some(target.clone()),
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        (runtime, state_path, target)
    }

    #[test]
    fn target_bound_agent_writes_activate_new_versions_and_selection_reuses_history() {
        let (mut runtime, state_path, target) = runtime();
        let initial = runtime
            .store
            .active_configuration_version(&runtime.store.projects()[0].id, &target)
            .unwrap()
            .clone();
        let mut snapshot: Value = serde_json::from_str(&initial.content).unwrap();
        snapshot["command"] = json!("pnpm dev");
        let plan = runtime
            .prepare_improver_configuration_write(
                "improver-session",
                &target,
                Some(initial.id.clone()),
                snapshot.to_string(),
                "Use the workspace package manager".into(),
            )
            .unwrap();
        let (result, _) = runtime
            .apply_owned_configuration_application(plan, AssistantAvailability::Proven, 2)
            .unwrap();
        let second_id = result["activeVersion"]["id"].as_str().unwrap().to_owned();
        assert_eq!(result["activeVersion"]["sequence"], 2);
        assert_eq!(
            result["activeVersion"]["sourceSessionId"],
            "improver-session"
        );
        assert!(matches!(
            runtime.prepare_improver_configuration_write(
                "improver-session",
                &target,
                Some(initial.id.clone()),
                snapshot.to_string(),
                "Stale".into(),
            ),
            Err(CoreError::RevisionConflict)
        ));

        let unchanged = runtime
            .prepare_improver_configuration_write(
                "improver-session",
                &target,
                Some(second_id.clone()),
                snapshot.to_string(),
                "No content change".into(),
            )
            .unwrap();
        let (unchanged, unchanged_effects) = runtime
            .apply_owned_configuration_application(unchanged, AssistantAvailability::Proven, 3)
            .unwrap();
        assert_eq!(unchanged["activeVersion"]["id"], second_id);
        assert_eq!(runtime.store.configuration_versions().len(), 2);
        assert!(unchanged_effects.retired_session_ids.is_empty());
        assert!(!unchanged_effects.steward_configuration_changed);

        let project_id = runtime.store.projects()[0].id.clone();
        let restore = runtime
            .prepare_configuration_version_restore(json!({
                "projectId": project_id,
                "versionId": initial.id,
                "expectedActiveVersionId": second_id,
            }))
            .unwrap();
        let (restored, _) = runtime
            .apply_owned_configuration_application(restore, AssistantAvailability::Proven, 4)
            .unwrap();
        assert_eq!(restored["activeVersion"]["sequence"], 1);
        assert_eq!(runtime.store.configuration_versions().len(), 2);
        let listed = runtime
            .list_configuration_versions(json!({
                "projectId": project_id,
                "kind": "runConfiguration",
                "targetId": target.target_id,
            }))
            .unwrap();
        assert_eq!(listed["activeVersionId"], restored["activeVersion"]["id"]);
        assert_eq!(listed["versions"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_file(&state_path);
        let _ = std::fs::remove_dir_all(state_path.with_extension("project"));
    }
}
