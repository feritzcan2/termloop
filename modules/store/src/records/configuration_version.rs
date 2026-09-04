use serde_json::json;
use termloop_domain::{
    CONFIGURATION_VERSIONS_PER_TARGET_MAX, ConfigurationVersion, ConfigurationVersionSelection,
    ImproverSessionTarget, ImproverSessionTargetKind, PlaybookConfiguration, PlaybookMilestone,
    PlaybookPipeline, RunConfiguration, StewardAgentId, StewardConfiguration, TrackerConfiguration,
    WorkerConfiguration,
};

use super::super::{CoreWriteAuthority, CurrentState, Store, StoreError};

impl Store {
    pub fn configuration_versions(&self) -> &[ConfigurationVersion] {
        &self.state.configuration_versions
    }

    pub fn active_configuration_version(
        &self,
        project_id: &str,
        target: &ImproverSessionTarget,
    ) -> Option<&ConfigurationVersion> {
        active_version(&self.state, project_id, target)
    }

    /// Selects an already recorded immutable snapshot after its content has
    /// been applied by the owning command. Owned commands may have recorded a
    /// transient generic snapshot while saving; remove only that exact new
    /// head before moving the active pointer to the requested version.
    pub fn select_configuration_version(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        target: &ImproverSessionTarget,
        expected_previous_version_id: Option<&str>,
        selected_version_id: &str,
        applied_content: &str,
    ) -> Result<ConfigurationVersion, StoreError> {
        let selected = self
            .state
            .configuration_versions
            .iter()
            .find(|version| {
                version.id == selected_version_id
                    && version.project_id == project_id
                    && &version.target == target
                    && version.content == applied_content
            })
            .cloned()
            .ok_or(StoreError::NotFound)?;
        let current = active_version(&self.state, project_id, target).cloned();
        let current_is_transient_save = current.as_ref().is_some_and(|version| {
            Some(version.id.as_str()) != expected_previous_version_id
                && version.id != selected_version_id
                && version.content == applied_content
                && version.source_session_id.is_none()
        });
        if current.as_ref().map(|version| version.id.as_str()) != expected_previous_version_id
            && !current_is_transient_save
        {
            return Err(StoreError::RevisionConflict);
        }

        let previous = self.state.clone();
        if current_is_transient_save && let Some(current) = current {
            self.state
                .configuration_versions
                .retain(|version| version.id != current.id);
        }
        set_active_version(
            &mut self.state,
            project_id,
            target.clone(),
            selected_version_id,
        );
        self.commit_or_restore(previous)?;
        Ok(selected)
    }

    /// Synchronizes a configuration whose source of truth lives outside the
    /// store (currently skill and prompt files, plus the effective MCP copy).
    /// Opening an improver records the exact observed baseline, and records a
    /// new head only when that external value changed since the last snapshot.
    pub fn sync_external_configuration_version(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        target: ImproverSessionTarget,
        content: String,
        observed_at_epoch_ms: u64,
    ) -> Result<ConfigurationVersion, StoreError> {
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == project_id)
            || !target.is_well_formed()
            || content.is_empty()
            || content.len() > termloop_domain::CONFIGURATION_VERSION_CONTENT_MAX_BYTES
        {
            return Err(StoreError::ConstraintViolation);
        }
        if let Some(active) = active_version(&self.state, project_id, &target)
            && active.content == content
        {
            return Ok(active.clone());
        }
        let previous = self.state.clone();
        let version = record_version(
            &mut self.state,
            project_id,
            target,
            content,
            VersionRecord {
                summary: "Current configuration",
                source_session_id: None,
                created_at_epoch_ms: observed_at_epoch_ms.max(1),
            },
        )
        .expect("different external content creates a version");
        self.commit_or_restore(previous)?;
        Ok(version)
    }

    /// Finalizes an Agent commit after the target's named command has saved its
    /// complete content. Normal editors already create a generic version in
    /// that command; this transaction attributes that exact newest version.
    /// A no-op leaves the existing immutable snapshot untouched.
    #[allow(clippy::too_many_arguments)]
    pub fn finalize_configuration_activation(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        target: &ImproverSessionTarget,
        expected_previous_version_id: Option<&str>,
        content: &str,
        summary: &str,
        source_session_id: Option<&str>,
        created_at_epoch_ms: u64,
    ) -> Result<ConfigurationVersion, StoreError> {
        let active = active_version(&self.state, project_id, target).cloned();
        if active.is_none() && expected_previous_version_id.is_some()
            || active.as_ref().is_some_and(|active| {
                active.id != expected_previous_version_id.unwrap_or_default()
                    && active.content != content
            })
        {
            return Err(StoreError::RevisionConflict);
        }
        let active_matches_expected =
            active.as_ref().map(|version| version.id.as_str()) == expected_previous_version_id;
        if active_matches_expected
            && active
                .as_ref()
                .is_some_and(|version| version.content == content)
        {
            return active.ok_or(StoreError::NotFound);
        }
        let previous = self.state.clone();
        if active_matches_expected {
            record_version(
                &mut self.state,
                project_id,
                target.clone(),
                content.to_owned(),
                VersionRecord {
                    summary,
                    source_session_id: source_session_id.map(ToOwned::to_owned),
                    created_at_epoch_ms: created_at_epoch_ms.max(1),
                },
            );
        }
        let active_id = active_version(&self.state, project_id, target)
            .map(|version| version.id.clone())
            .ok_or(StoreError::NotFound)?;
        let active = self
            .state
            .configuration_versions
            .iter_mut()
            .find(|version| version.id == active_id)
            .ok_or(StoreError::NotFound)?;
        active.summary = summary.to_owned();
        active.source_session_id = source_session_id.map(ToOwned::to_owned);
        active.created_at_epoch_ms = created_at_epoch_ms.max(1);
        let result = active.clone();
        self.commit_or_restore(previous)?;
        Ok(result)
    }
}

pub(crate) fn initialize_configuration_versions(state: &mut CurrentState) {
    if !state.configuration_versions.is_empty() {
        return;
    }
    let steward = state.steward_configurations.clone();
    let workers = state.worker_configurations.clone();
    let routines = state.tracker_configurations.clone();
    let playbooks = state.playbook_configurations.clone();
    let runs = state.run_configurations.clone();
    for configuration in &steward {
        record_steward_version(state, configuration, None, "Initial configuration");
    }
    for configuration in &workers {
        record_worker_version(state, configuration, None, "Initial configuration");
    }
    for configuration in &routines {
        record_routine_version(state, configuration, None, "Initial configuration");
    }
    for configuration in &playbooks {
        record_playbook_version(state, configuration, None, "Initial configuration");
    }
    for configuration in &runs {
        record_run_configuration_version(state, configuration, None, "Initial configuration");
    }
}

pub(crate) fn initialize_configuration_version_selections(state: &mut CurrentState) {
    state.configuration_version_selections.clear();
    let versions = state.configuration_versions.clone();
    for version in versions {
        let newest = state
            .configuration_versions
            .iter()
            .filter(|candidate| {
                candidate.project_id == version.project_id && candidate.target == version.target
            })
            .max_by_key(|candidate| candidate.sequence);
        if newest.is_some_and(|candidate| candidate.id == version.id) {
            set_active_version(state, &version.project_id, version.target, &version.id);
        }
    }
}

pub(crate) fn record_steward_version(
    state: &mut CurrentState,
    configuration: &StewardConfiguration,
    source_session_id: Option<String>,
    summary: &str,
) {
    let target = ImproverSessionTarget {
        target_kind: ImproverSessionTargetKind::StewardInstructions,
        target_id: None,
    };
    let content = serde_json::to_string(&json!({
        "agentId": configuration.agent_id,
        "model": configuration.model,
        "permission": configuration.permission,
        "reasoning": configuration.reasoning,
        "enabled": configuration.enabled,
        "systemPrompt": configuration.system_prompt,
    }))
    .expect("Steward configuration snapshot serializes");
    record_version(
        state,
        &configuration.project_id,
        target,
        content,
        VersionRecord {
            summary,
            source_session_id,
            created_at_epoch_ms: configuration.updated_at_epoch_ms.max(1),
        },
    );
}

pub(crate) fn record_worker_version(
    state: &mut CurrentState,
    configuration: &WorkerConfiguration,
    source_session_id: Option<String>,
    summary: &str,
) {
    let target = ImproverSessionTarget {
        target_kind: ImproverSessionTargetKind::WorkerInstructions,
        target_id: Some(configuration.id.clone()),
    };
    let content = serde_json::to_string(&json!({
        "name": configuration.name,
        "agentId": configuration.agent_id,
        "model": configuration.model,
        "permission": configuration.permission,
        "reasoning": configuration.reasoning,
        "enabled": configuration.enabled,
        "pingIntervalSeconds": configuration.ping_interval_seconds,
        "workerPrompt": configuration.worker_prompt,
        "systemPrompt": configuration.system_prompt,
    }))
    .expect("Worker configuration snapshot serializes");
    record_version(
        state,
        &configuration.project_id,
        target,
        content,
        VersionRecord {
            summary,
            source_session_id,
            created_at_epoch_ms: configuration.updated_at_epoch_ms.max(1),
        },
    );
}

pub(crate) fn record_routine_version(
    state: &mut CurrentState,
    configuration: &TrackerConfiguration,
    source_session_id: Option<String>,
    summary: &str,
) {
    let target = ImproverSessionTarget {
        target_kind: ImproverSessionTargetKind::RoutineInstructions,
        target_id: Some(configuration.id.clone()),
    };
    let content = serde_json::to_string(&json!({
        "triggerMode": configuration.trigger_mode,
        "name": configuration.name,
        "instructions": configuration.prompt,
        "whileWaiting": {
            "mode": configuration.action_handling,
            "instructions": configuration.steward_instructions,
        },
        "workerId": configuration.worker_id,
        "enabled": configuration.enabled,
        "scheduleIntervalSeconds": configuration.schedule_interval_seconds,
    }))
    .expect("Routine configuration snapshot serializes");
    record_version(
        state,
        &configuration.project_id,
        target,
        content,
        VersionRecord {
            summary,
            source_session_id,
            created_at_epoch_ms: configuration.updated_at_epoch_ms.max(1),
        },
    );
}

pub(crate) fn record_playbook_version(
    state: &mut CurrentState,
    configuration: &PlaybookConfiguration,
    source_session_id: Option<String>,
    summary: &str,
) {
    let target = ImproverSessionTarget {
        target_kind: ImproverSessionTargetKind::Playbook,
        target_id: None,
    };
    let worker_id = configuration
        .all_milestones()
        .find_map(|milestone| tracker_for_milestone(state, configuration, milestone))
        .map(|routine| routine.worker_id.clone());
    let preferred_worker_agent_id = worker_id
        .as_deref()
        .and_then(|worker_id| {
            state.worker_configurations.iter().find(|worker| {
                worker.id == worker_id && worker.project_id == configuration.project_id
            })
        })
        .map_or(StewardAgentId::Claude, |worker| worker.agent_id);
    let milestones = configuration
        .milestones
        .iter()
        .map(|milestone| playbook_milestone_snapshot(state, configuration, milestone))
        .collect::<Vec<_>>();
    let saved_pipelines = configuration
        .saved_pipelines
        .iter()
        .map(|pipeline| playbook_pipeline_snapshot(state, configuration, pipeline))
        .collect::<Vec<_>>();
    let content = serde_json::to_string(&json!({
        "activePipelineName": configuration.active_pipeline_name,
        "milestones": milestones,
        "savedPipelines": saved_pipelines,
        "workerId": worker_id,
        "preferredWorkerAgentId": preferred_worker_agent_id,
    }))
    .expect("Playbook configuration snapshot serializes");
    record_version(
        state,
        &configuration.project_id,
        target,
        content,
        VersionRecord {
            summary,
            source_session_id,
            created_at_epoch_ms: configuration.updated_at_epoch_ms.max(1),
        },
    );
}

fn playbook_pipeline_snapshot(
    state: &CurrentState,
    configuration: &PlaybookConfiguration,
    pipeline: &PlaybookPipeline,
) -> serde_json::Value {
    json!({
        "name": pipeline.name,
        "milestones": pipeline
            .milestones
            .iter()
            .map(|milestone| playbook_milestone_snapshot(state, configuration, milestone))
            .collect::<Vec<_>>(),
    })
}

fn playbook_milestone_snapshot(
    state: &CurrentState,
    configuration: &PlaybookConfiguration,
    milestone: &PlaybookMilestone,
) -> serde_json::Value {
    let routine = tracker_for_milestone(state, configuration, milestone)
        .expect("validated Playbook milestone has one same-Project Routine");
    json!({
        "id": milestone.id,
        "title": milestone.title,
        "gate": milestone.gate,
        "completeWhen": routine.prompt,
        "whileWaiting": {
            "mode": routine.action_handling,
            "instructions": routine.steward_instructions,
        },
        "workerId": routine.worker_id,
        "retryDelaySeconds": milestone.retry_delay_seconds,
        "approver": milestone.approver,
    })
}

fn tracker_for_milestone<'a>(
    state: &'a CurrentState,
    configuration: &PlaybookConfiguration,
    milestone: &PlaybookMilestone,
) -> Option<&'a TrackerConfiguration> {
    state.tracker_configurations.iter().find(|routine| {
        routine.id == milestone.routine_id && routine.project_id == configuration.project_id
    })
}

pub(crate) fn record_run_configuration_version(
    state: &mut CurrentState,
    configuration: &RunConfiguration,
    source_session_id: Option<String>,
    summary: &str,
) {
    let target = ImproverSessionTarget {
        target_kind: ImproverSessionTargetKind::RunConfiguration,
        target_id: Some(configuration.id.clone()),
    };
    let content = serde_json::to_string(&json!({
        "name": configuration.name,
        "kind": configuration.kind,
        "command": configuration.command,
        "workingDirectory": configuration.working_directory,
        "env": configuration.env,
        "setupCommand": configuration.setup_command,
        "setupPolicy": configuration.setup_policy,
        "urlAutoDetect": configuration.url_auto_detect,
        "fallbackUrls": configuration.fallback_urls,
        "autoOpenFirstUrl": configuration.auto_open_first_url,
    }))
    .expect("Run configuration snapshot serializes");
    record_version(
        state,
        &configuration.project_id,
        target,
        content,
        VersionRecord {
            summary,
            source_session_id,
            created_at_epoch_ms: configuration.updated_at_epoch_ms.max(1),
        },
    );
}

fn active_version<'a>(
    state: &'a CurrentState,
    project_id: &str,
    target: &ImproverSessionTarget,
) -> Option<&'a ConfigurationVersion> {
    let active_id = state
        .configuration_version_selections
        .iter()
        .find(|selection| selection.project_id == project_id && &selection.target == target)
        .map(|selection| selection.version_id.as_str())?;
    state
        .configuration_versions
        .iter()
        .find(|version| version.id == active_id)
}

fn newest_version<'a>(
    state: &'a CurrentState,
    project_id: &str,
    target: &ImproverSessionTarget,
) -> Option<&'a ConfigurationVersion> {
    state
        .configuration_versions
        .iter()
        .filter(|version| version.project_id == project_id && &version.target == target)
        .max_by_key(|version| version.sequence)
}

fn set_active_version(
    state: &mut CurrentState,
    project_id: &str,
    target: ImproverSessionTarget,
    version_id: &str,
) {
    if let Some(selection) = state
        .configuration_version_selections
        .iter_mut()
        .find(|selection| selection.project_id == project_id && selection.target == target)
    {
        selection.version_id = version_id.to_owned();
    } else {
        state
            .configuration_version_selections
            .push(ConfigurationVersionSelection {
                project_id: project_id.to_owned(),
                target,
                version_id: version_id.to_owned(),
            });
    }
}

struct VersionRecord<'a> {
    summary: &'a str,
    source_session_id: Option<String>,
    created_at_epoch_ms: u64,
}

fn record_version(
    state: &mut CurrentState,
    project_id: &str,
    target: ImproverSessionTarget,
    content: String,
    record: VersionRecord<'_>,
) -> Option<ConfigurationVersion> {
    let active = active_version(state, project_id, &target);
    if active.is_some_and(|version| version.content == content) {
        return None;
    }
    let sequence = newest_version(state, project_id, &target)
        .map_or(1, |version| version.sequence.saturating_add(1));
    let version = ConfigurationVersion {
        id: termloop_platform::generate_opaque_id(),
        project_id: project_id.to_owned(),
        target: target.clone(),
        sequence,
        content,
        summary: record.summary.to_owned(),
        source_session_id: record.source_session_id,
        created_at_epoch_ms: record.created_at_epoch_ms,
    };
    state.configuration_versions.push(version.clone());
    set_active_version(state, project_id, target.clone(), &version.id);
    let mut indices = state
        .configuration_versions
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.project_id == project_id && candidate.target == target)
        .map(|(index, candidate)| (index, candidate.sequence))
        .collect::<Vec<_>>();
    indices.sort_by_key(|(_, sequence)| *sequence);
    let total = state
        .configuration_versions
        .iter()
        .filter(|candidate| candidate.project_id == project_id && candidate.target == target)
        .count();
    let excess = total.saturating_sub(CONFIGURATION_VERSIONS_PER_TARGET_MAX);
    for (index, _) in indices.into_iter().take(excess).rev() {
        state.configuration_versions.remove(index);
    }
    Some(version)
}

pub(crate) fn remove_configuration_target_state(
    state: &mut CurrentState,
    project_id: &str,
    target: &ImproverSessionTarget,
) {
    state
        .configuration_versions
        .retain(|version| version.project_id != project_id || &version.target != target);
    state
        .configuration_version_selections
        .retain(|selection| selection.project_id != project_id || &selection.target != target);
}
