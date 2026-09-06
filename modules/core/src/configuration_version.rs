use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use termloop_domain::{
    ImproverSessionTarget, ImproverSessionTargetKind, McpToolDescription, RoutineActionHandling,
    RoutineTriggerMode, RunConfiguration, RunConfigurationEnvVar, RunConfigurationKind,
    RunSetupPolicy, StewardAgentId, StewardConfiguration, TrackerConfiguration,
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
struct RoutineSnapshot {
    trigger_mode: RoutineTriggerMode,
    name: String,
    instructions: String,
    while_waiting: RoutineWhileWaitingSnapshot,
    enabled: bool,
    schedule_interval_seconds: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoutineWhileWaitingSnapshot {
    mode: RoutineActionHandling,
    instructions: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlaybookSnapshot {
    active_pipeline_name: String,
    milestones: Vec<PlaybookMilestoneDraft>,
    saved_pipelines: Vec<PlaybookPipelineDraft>,
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
    trigger_mode: RoutineTriggerMode,
    instructions: String,
    while_waiting: RoutineWhileWaitingSnapshot,
    enabled: bool,
    schedule_interval_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRoutineSnapshot {
    kind: String,
    trigger_mode: RoutineTriggerMode,
    name: String,
    prompt: String,
    steward_instructions: String,
    worker_id: String,
    enabled: bool,
    schedule_interval_seconds: u64,
    action_handling: RoutineActionHandling,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyNewRoutineSnapshot {
    kind: String,
    trigger_mode: RoutineTriggerMode,
    name: String,
    prompt: String,
    steward_instructions: String,
    enabled: bool,
    schedule_interval_seconds: u64,
    action_handling: RoutineActionHandling,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPlaybookSnapshot {
    active_pipeline_name: String,
    milestones: Vec<LegacyPlaybookMilestoneDraft>,
    saved_pipelines: Vec<LegacyPlaybookPipelineDraft>,
    worker_id: Option<String>,
    preferred_worker_agent_id: StewardAgentId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPlaybookPipelineDraft {
    name: String,
    milestones: Vec<LegacyPlaybookMilestoneDraft>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPlaybookMilestoneDraft {
    id: String,
    title: String,
    gate: termloop_domain::PlaybookGateKind,
    check: LegacyPlaybookStepCheckDraft,
    retry_delay_seconds: u64,
    condition: String,
    approver: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPlaybookStepCheckDraft {
    kind: String,
    instructions: String,
    steward_instructions: String,
    action_handling: RoutineActionHandling,
    worker_id: Option<String>,
}

impl TryFrom<LegacyRoutineSnapshot> for RoutineSnapshot {
    type Error = CoreError;

    fn try_from(value: LegacyRoutineSnapshot) -> Result<Self, Self::Error> {
        require_legacy_routine_kind(&value.kind)?;
        Ok(Self {
            trigger_mode: value.trigger_mode,
            name: value.name,
            instructions: value.prompt,
            while_waiting: RoutineWhileWaitingSnapshot {
                mode: value.action_handling,
                instructions: value.steward_instructions,
            },
            enabled: value.enabled,
            schedule_interval_seconds: value.schedule_interval_seconds,
        })
    }
}

impl TryFrom<LegacyNewRoutineSnapshot> for NewRoutineSnapshot {
    type Error = CoreError;

    fn try_from(value: LegacyNewRoutineSnapshot) -> Result<Self, Self::Error> {
        require_legacy_routine_kind(&value.kind)?;
        Ok(Self {
            name: value.name,
            trigger_mode: value.trigger_mode,
            instructions: value.prompt,
            while_waiting: RoutineWhileWaitingSnapshot {
                mode: value.action_handling,
                instructions: value.steward_instructions,
            },
            enabled: value.enabled,
            schedule_interval_seconds: value.schedule_interval_seconds,
        })
    }
}

impl TryFrom<LegacyPlaybookMilestoneDraft> for PlaybookMilestoneDraft {
    type Error = CoreError;

    fn try_from(value: LegacyPlaybookMilestoneDraft) -> Result<Self, Self::Error> {
        require_legacy_routine_kind(&value.check.kind)?;
        Ok(Self {
            id: value.id,
            title: value.title,
            gate: value.gate,
            complete_when: merge_legacy_complete_when(value.check.instructions, value.condition),
            while_waiting: crate::companion_integrations::playbook::PlaybookWhileWaitingDraft {
                mode: value.check.action_handling,
                instructions: value.check.steward_instructions,
            },
            retry_delay_seconds: value.retry_delay_seconds,
            approver: value.approver,
        })
    }
}

fn merge_legacy_complete_when(instructions: String, condition: String) -> String {
    let instructions = instructions.trim();
    let condition = condition.trim();
    match (instructions.is_empty(), condition.is_empty()) {
        (false, false) => format!("{instructions}\n\nApplies when: {condition}"),
        (false, true) => instructions.to_owned(),
        (true, false) => condition.to_owned(),
        (true, true) => String::new(),
    }
}

impl TryFrom<LegacyPlaybookSnapshot> for PlaybookSnapshot {
    type Error = CoreError;

    fn try_from(value: LegacyPlaybookSnapshot) -> Result<Self, Self::Error> {
        Ok(Self {
            active_pipeline_name: value.active_pipeline_name,
            milestones: value
                .milestones
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            saved_pipelines: value
                .saved_pipelines
                .into_iter()
                .map(|pipeline| {
                    Ok(PlaybookPipelineDraft {
                        name: pipeline.name,
                        milestones: pipeline
                            .milestones
                            .into_iter()
                            .map(TryInto::try_into)
                            .collect::<Result<_, CoreError>>()?,
                    })
                })
                .collect::<Result<_, CoreError>>()?,
        })
    }
}

fn require_legacy_routine_kind(value: &str) -> Result<(), CoreError> {
    matches!(
        value,
        "slack" | "jira" | "runtime" | "delivery" | "ciPr" | "custom"
    )
    .then_some(())
    .ok_or_else(|| CoreError::InvalidParams("content".into()))
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
        let content = active
            .map(|version| {
                self.canonicalize_configuration_content(
                    &session.project_id,
                    target,
                    &version.content,
                )
            })
            .transpose()?;
        Ok(json!({
            "activeVersionId": active.map(|version| version.id.as_str()),
            "content": content,
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
                let routine_id = termloop_platform::generate_opaque_id();
                let routine = RoutineSnapshot {
                    trigger_mode: snapshot.trigger_mode,
                    name: snapshot.name,
                    instructions: snapshot.instructions,
                    while_waiting: snapshot.while_waiting,
                    enabled: snapshot.enabled,
                    schedule_interval_seconds: snapshot.schedule_interval_seconds,
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
                        "expectedPlaybookRevision": current.map_or(0, |value| value.revision),
                        "expectedRevision": self.store.revision(),
                    }),
                    (0..routine_capacity)
                        .map(|_| termloop_platform::generate_opaque_id())
                        .collect(),
                    created_at_epoch_ms,
                )?;
                let _ = result;
                effects.tracker_runtime_changed = true;
                effects.steward_configuration_changed = !steward_was_enabled
                    && self
                        .current_enabled_steward_wake(&plan.project_id)
                        .is_some();
                plan.target.clone()
            }
            ImproverSessionTargetKind::RunConfiguration => {
                let snapshot: RunConfigurationSnapshot = parse_snapshot(&plan.content)?;
                let mut params = serde_json::to_value(snapshot)
                    .map_err(|error| CoreError::Store(error.to_string()))?;
                params["expectedRevision"] = json!(self.store.revision());
                let configuration_id = plan
                    .target
                    .target_id
                    .as_ref()
                    .ok_or_else(|| CoreError::InvalidParams("targetId".into()))?;
                params["configurationId"] = json!(configuration_id);
                self.handle("runConfiguration.update", params)?;
                plan.target.clone()
            }
            ImproverSessionTargetKind::NewRunConfiguration => {
                let snapshot: RunConfigurationSnapshot = parse_snapshot(&plan.content)?;
                let mut params = serde_json::to_value(snapshot)
                    .map_err(|error| CoreError::Store(error.to_string()))?;
                params["expectedRevision"] = json!(self.store.revision());
                params["projectId"] = json!(plan.project_id.clone());
                let result = self.handle("runConfiguration.create", params)?;
                ImproverSessionTarget {
                    target_kind: ImproverSessionTargetKind::RunConfiguration,
                    target_id: result["configuration"]["id"]
                        .as_str()
                        .map(ToOwned::to_owned),
                }
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
            let steward = self
                .store
                .steward_configurations()
                .iter()
                .find(|steward| steward.project_id == candidate.project_id)
                .ok_or(CoreError::NotFound)?;
            if !steward.enabled {
                return Err(CoreError::AgentCapabilityUnproven);
            }
        }
        let routine_id = candidate.id.clone();
        let enabled = candidate.enabled;
        self.store
            .set_tracker_configuration(&self.write_authority, candidate, self.store.revision())
            .map_err(store_error)?;
        self.tracker_runtime.cancel_tracker_check(&routine_id);
        if enabled {
            self.tracker_runtime
                .schedule_tracker_now(&routine_id, updated_at_epoch_ms);
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
            ImproverSessionTargetKind::RoutineInstructions => {
                let snapshot = parse_routine_snapshot(content)?;
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
                    trigger_mode: snapshot.trigger_mode,
                    name: snapshot.name.clone(),
                    prompt: snapshot.instructions.clone(),
                    steward_instructions: snapshot.while_waiting.instructions.clone(),
                    enabled: snapshot.enabled,
                    schedule_interval_seconds: snapshot.schedule_interval_seconds,
                    generation: current.generation,
                    context_markdown: current.context_markdown.clone(),
                    context_revision: current.context_revision,
                    recent_source_keys: current.recent_source_keys.clone(),
                    related_task_ids: current.related_task_ids.clone(),
                    action_handling: snapshot.while_waiting.mode,
                    pending_routine_findings: current.pending_routine_findings.clone(),
                    last_check_started_at_epoch_ms: current.last_check_started_at_epoch_ms,
                    last_attempt_at_epoch_ms: current.last_attempt_at_epoch_ms,
                    last_successful_report_at_epoch_ms: current.last_successful_report_at_epoch_ms,
                    updated_at_epoch_ms: current.updated_at_epoch_ms,
                };
                if !candidate.is_valid() {
                    return Err(invalid());
                }
                serialize(&snapshot)
            }
            ImproverSessionTargetKind::Playbook => {
                let snapshot = parse_playbook_snapshot(content)?;
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
                let snapshot = parse_new_routine_snapshot(content)?;
                let candidate = TrackerConfiguration {
                    id: "candidate".into(),
                    project_id: project_id.to_owned(),
                    trigger_mode: snapshot.trigger_mode,
                    name: snapshot.name.clone(),
                    prompt: snapshot.instructions.clone(),
                    steward_instructions: snapshot.while_waiting.instructions.clone(),
                    enabled: snapshot.enabled,
                    schedule_interval_seconds: snapshot.schedule_interval_seconds,
                    generation: 1,
                    context_markdown: String::new(),
                    context_revision: 1,
                    recent_source_keys: vec![],
                    related_task_ids: vec![],
                    action_handling: snapshot.while_waiting.mode,
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

fn parse_routine_snapshot(content: &str) -> Result<RoutineSnapshot, CoreError> {
    if let Ok(snapshot) = serde_json::from_str(content) {
        return Ok(snapshot);
    }
    serde_json::from_str::<LegacyRoutineSnapshot>(content)
        .map_err(|_| CoreError::InvalidParams("content".into()))?
        .try_into()
}

fn parse_new_routine_snapshot(content: &str) -> Result<NewRoutineSnapshot, CoreError> {
    if let Ok(snapshot) = serde_json::from_str(content) {
        return Ok(snapshot);
    }
    serde_json::from_str::<LegacyNewRoutineSnapshot>(content)
        .map_err(|_| CoreError::InvalidParams("content".into()))?
        .try_into()
}

fn parse_playbook_snapshot(content: &str) -> Result<PlaybookSnapshot, CoreError> {
    if let Ok(snapshot) = serde_json::from_str(content) {
        return Ok(snapshot);
    }
    serde_json::from_str::<LegacyPlaybookSnapshot>(content)
        .map_err(|_| CoreError::InvalidParams("content".into()))?
        .try_into()
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
        trigger_mode: snapshot.trigger_mode,
        name: snapshot.name.clone(),
        prompt: snapshot.instructions.clone(),
        steward_instructions: snapshot.while_waiting.instructions.clone(),
        enabled: snapshot.enabled,
        schedule_interval_seconds: snapshot.schedule_interval_seconds,
        generation,
        context_markdown: String::new(),
        context_revision: 1,
        recent_source_keys: vec![],
        related_task_ids: vec![],
        action_handling: snapshot.while_waiting.mode,
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

    #[test]
    fn new_run_configuration_target_uses_kind_marker_to_create_configuration() {
        let (mut runtime, state_path, _) = runtime();
        let project_id = runtime.store.projects()[0].id.clone();
        let initial_configuration_count = runtime.store.run_configurations().len();
        let target = ImproverSessionTarget {
            target_kind: ImproverSessionTargetKind::NewRunConfiguration,
            target_id: Some("devServer".into()),
        };
        let content = serialize(&RunConfigurationSnapshot {
            name: "Dev server".into(),
            kind: RunConfigurationKind::DevServer,
            command: "cargo build -p termloop-server && cargo run -p termloop-server".into(),
            working_directory: ".".into(),
            env: vec![],
            setup_command: None,
            setup_policy: RunSetupPolicy::Never,
            url_auto_detect: false,
            fallback_urls: vec![],
            auto_open_first_url: false,
        })
        .unwrap();
        let plan = ConfigurationApplicationPlan {
            project_id: project_id.clone(),
            target: target.clone(),
            content,
            summary: "Create the dev server run configuration".into(),
            expected_previous_version_id: None,
            expected_current_content: None,
            source_session_id: Some("improver-session".into()),
            selected_existing_version_id: None,
        };

        let (result, _) = runtime
            .apply_owned_configuration_application(plan, AssistantAvailability::Proven, 2)
            .unwrap();

        assert_eq!(
            runtime.store.run_configurations().len(),
            initial_configuration_count + 1
        );
        let created_id = result["target"]["targetId"].as_str().unwrap();
        assert_eq!(result["target"]["kind"], "runConfiguration");
        assert_eq!(result["activeVersion"]["target"], result["target"]);
        assert_eq!(
            result["activeVersion"]["sourceSessionId"],
            "improver-session"
        );
        assert!(
            runtime
                .store
                .run_configurations()
                .iter()
                .any(|configuration| {
                    configuration.id == created_id
                        && configuration.command.contains("termloop-server")
                })
        );
        assert!(
            runtime
                .store
                .active_configuration_version(&project_id, &target)
                .is_none()
        );
        let _ = std::fs::remove_file(&state_path);
        let _ = std::fs::remove_dir_all(state_path.with_extension("project"));
    }

    #[test]
    fn legacy_routine_snapshot_is_read_as_the_canonical_provider_neutral_shape() {
        let snapshot = parse_routine_snapshot(
            r#"{
                "kind":"ciPr",
                "triggerMode":"onDemand",
                "name":"Review approved",
                "prompt":"Inspect the live review state.",
                "stewardInstructions":"Offer to request a review.",
                "workerId":"worker-1",
                "enabled":true,
                "scheduleIntervalSeconds":300,
                "actionHandling":"ask"
            }"#,
        )
        .unwrap();
        let canonical: Value = serde_json::from_str(&serialize(&snapshot).unwrap()).unwrap();

        assert_eq!(canonical["instructions"], "Inspect the live review state.");
        assert_eq!(canonical["whileWaiting"]["mode"], "ask");
        assert_eq!(
            canonical["whileWaiting"]["instructions"],
            "Offer to request a review."
        );
        assert!(canonical.get("kind").is_none());
        assert!(canonical.get("prompt").is_none());
        assert!(canonical.get("actionHandling").is_none());
    }

    #[test]
    fn legacy_playbook_snapshot_preserves_completion_and_applicability_in_one_rule() {
        let snapshot = parse_playbook_snapshot(
            r#"{
                "activePipelineName":"Delivery",
                "milestones":[{
                    "id":"review",
                    "title":"Review approved",
                    "gate":"automatic",
                    "check":{
                        "kind":"ciPr",
                        "instructions":"Inspect the live review state.",
                        "stewardInstructions":"Offer to request a review.",
                        "actionHandling":"ask",
                        "workerId":"worker-1"
                    },
                    "retryDelaySeconds":300,
                    "condition":"The development pull request exists.",
                    "approver":null
                }],
                "savedPipelines":[],
                "workerId":"worker-1",
                "preferredWorkerAgentId":"codex"
            }"#,
        )
        .unwrap();
        let canonical: Value = serde_json::from_str(&serialize(&snapshot).unwrap()).unwrap();

        assert_eq!(
            canonical["milestones"][0]["completeWhen"],
            "Inspect the live review state.\n\nApplies when: The development pull request exists."
        );
        assert_eq!(canonical["milestones"][0]["whileWaiting"]["mode"], "ask");
        assert_eq!(canonical["milestones"][0]["workerId"], "worker-1");
        assert!(canonical["milestones"][0].get("check").is_none());
        assert!(canonical["milestones"][0].get("condition").is_none());
    }
}
