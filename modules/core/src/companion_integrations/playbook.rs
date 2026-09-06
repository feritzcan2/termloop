//! Durable current Project delivery Playbook commands and Steward brief writes.
//!
//! The Playbook is one user-owned document per Project: the ordered stages a
//! Task completes on its way to done. The Steward reads it as data and never
//! edits it. A Task's position is derived from current completion verdicts,
//! never stored itself.

use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use termloop_domain::{
    PlaybookConfiguration, PlaybookGateKind, PlaybookMilestone, PlaybookPipeline,
    RoutineActionHandling, RoutineTriggerMode, StewardConfiguration, TASK_STEWARD_BRIEF_MAX_BYTES,
    TrackerConfiguration,
};
use termloop_store::PlaybookApply;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlaybookUpdateDraft {
    project_id: String,
    active_pipeline_name: String,
    milestones: Vec<PlaybookMilestoneDraft>,
    saved_pipelines: Vec<PlaybookPipelineDraft>,
    expected_playbook_revision: u64,
    expected_revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlaybookPipelineDraft {
    pub(crate) name: String,
    pub(crate) milestones: Vec<PlaybookMilestoneDraft>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlaybookMilestoneDraft {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) gate: PlaybookGateKind,
    pub(crate) complete_when: String,
    pub(crate) while_waiting: PlaybookWhileWaitingDraft,
    pub(crate) retry_delay_seconds: u64,
    pub(crate) approver: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlaybookWhileWaitingDraft {
    pub(crate) mode: RoutineActionHandling,
    pub(crate) instructions: String,
}

impl CoreRuntime {
    pub(crate) fn get_playbook(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        Ok(json!({
            "playbook": self.playbook_value(&project_id)?,
            "stateRevision": self.store.revision(),
        }))
    }

    /// Returns the visible pipeline and stage that still own an internal
    /// on-demand Routine. Kept pipelines count exactly like the active one.
    pub(crate) fn playbook_step_holding_routine(
        &self,
        routine_id: &str,
    ) -> Option<(String, String)> {
        self.store
            .playbook_configurations()
            .iter()
            .find_map(|configuration| {
                configuration
                    .milestones
                    .iter()
                    .find(|milestone| milestone.routine_id == routine_id)
                    .map(|milestone| {
                        (
                            configuration.active_pipeline_name.clone(),
                            milestone.title.clone(),
                        )
                    })
                    .or_else(|| {
                        configuration.saved_pipelines.iter().find_map(|pipeline| {
                            pipeline
                                .milestones
                                .iter()
                                .find(|milestone| milestone.routine_id == routine_id)
                                .map(|milestone| (pipeline.name.clone(), milestone.title.clone()))
                        })
                    })
            })
    }

    /// Atomically replaces the Playbook and the internal on-demand checks each
    /// step owns. Random IDs are supplied by the server/platform boundary; Core
    /// decides which are actually consumed after reusing unchanged step checks.
    pub fn update_playbook(
        &mut self,
        params: Value,
        new_routine_ids: Vec<String>,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let draft: PlaybookUpdateDraft = serde_json::from_value(params)
            .map_err(|_| CoreError::InvalidParams("playbook".into()))?;
        if !self.project_exists(&draft.project_id) {
            return Err(CoreError::NotFound);
        }
        let current = self.store.playbook_for_project(&draft.project_id).cloned();
        if current.as_ref().map_or(0, |value| value.revision) != draft.expected_playbook_revision {
            return Err(CoreError::RevisionConflict);
        }

        let has_steps = !draft.milestones.is_empty()
            || draft
                .saved_pipelines
                .iter()
                .any(|pipeline| !pipeline.milestones.is_empty());
        let steward_configuration = if has_steps {
            self.store
                .steward_configurations()
                .iter()
                .find(|configuration| {
                    configuration.project_id == draft.project_id && !configuration.enabled
                })
                .map(|current| {
                    let mut enabled = current.clone();
                    enabled.enabled = true;
                    enabled.executor_session_id = None;
                    enabled.generation = enabled
                        .generation
                        .checked_add(1)
                        .ok_or(CoreError::RevisionConflict)?;
                    enabled.updated_at_epoch_ms = updated_at_epoch_ms;
                    Ok::<StewardConfiguration, CoreError>(enabled)
                })
                .transpose()?
        } else {
            None
        };

        let current_steps = current
            .as_ref()
            .map(current_step_routines)
            .unwrap_or_default();
        let current_routines = self
            .store
            .tracker_configurations()
            .iter()
            .map(|routine| (routine.id.clone(), routine.clone()))
            .collect::<HashMap<_, _>>();
        let mut ids = new_routine_ids.into_iter();
        let mut reused = HashSet::new();
        let mut next_routine_ids = HashSet::new();
        let mut upsert_routines = Vec::new();
        let mut routines_changed = false;

        let (milestones, active_routines_changed) = materialize_pipeline(
            &draft.project_id,
            &draft.active_pipeline_name,
            &draft.milestones,
            &current_steps,
            &current_routines,
            &mut ids,
            &mut reused,
            &mut next_routine_ids,
            &mut upsert_routines,
            updated_at_epoch_ms,
        )?;
        routines_changed |= active_routines_changed;
        let mut saved_pipelines = Vec::with_capacity(draft.saved_pipelines.len());
        for pipeline in &draft.saved_pipelines {
            let (pipeline_milestones, changed) = materialize_pipeline(
                &draft.project_id,
                &pipeline.name,
                &pipeline.milestones,
                &current_steps,
                &current_routines,
                &mut ids,
                &mut reused,
                &mut next_routine_ids,
                &mut upsert_routines,
                updated_at_epoch_ms,
            )?;
            routines_changed |= changed;
            saved_pipelines.push(PlaybookPipeline {
                name: pipeline.name.clone(),
                milestones: pipeline_milestones,
            });
        }

        let current_owned_ids = current
            .as_ref()
            .into_iter()
            .flat_map(PlaybookConfiguration::all_milestones)
            .map(|milestone| milestone.routine_id.clone())
            .collect::<HashSet<_>>();
        let delete_routine_ids = current_owned_ids
            .difference(&next_routine_ids)
            .cloned()
            .collect::<Vec<_>>();
        routines_changed |= !delete_routine_ids.is_empty();

        let document_changed = current.as_ref().is_none_or(|value| {
            value.active_pipeline_name != draft.active_pipeline_name
                || value.milestones != milestones
                || value.saved_pipelines != saved_pipelines
        });
        if !document_changed
            && !routines_changed
            && steward_configuration.is_none()
        {
            if draft.expected_revision != self.store.revision() {
                return Err(CoreError::RevisionConflict);
            }
            let current = current.as_ref().ok_or(CoreError::NotFound)?;
            return Ok(json!({
                "playbook": playbook_projection(current, self.store.tracker_configurations())?,
                "stateRevision": self.store.revision(),
            }));
        }

        let revision = current.as_ref().map_or(Ok(1), |value| {
            value
                .revision
                .checked_add(1)
                .ok_or(CoreError::RevisionConflict)
        })?;
        let configuration = PlaybookConfiguration {
            project_id: draft.project_id,
            revision,
            active_pipeline_name: draft.active_pipeline_name,
            milestones,
            saved_pipelines,
            updated_at_epoch_ms,
        };
        if !configuration.is_valid() {
            return Err(CoreError::InvalidParams("playbook".into()));
        }
        let changed_routine_ids = upsert_routines
            .iter()
            .filter(|routine| current_routines.get(&routine.id) != Some(routine))
            .map(|routine| routine.id.clone())
            .collect::<Vec<_>>();
        let configuration = self
            .store
            .apply_playbook(
                &self.write_authority,
                PlaybookApply {
                    configuration,
                    steward_configuration,
                    upsert_routines,
                    delete_routine_ids: delete_routine_ids.clone(),
                },
                draft.expected_revision,
            )
            .map_err(store_error)?;
        for routine_id in delete_routine_ids {
            self.tracker_runtime.remove_tracker(&routine_id);
        }
        for routine_id in changed_routine_ids {
            self.tracker_runtime.cancel_tracker_check(&routine_id);
        }
        Ok(json!({
            "playbook": playbook_projection(&configuration, self.store.tracker_configurations())?,
            "stateRevision": self.store.revision(),
        }))
    }

    /// Steward-facing read of the current Playbook. The caller's Project scope
    /// comes from its authenticated principal, never from arguments.
    pub fn playbook_projection_for_executor(&self, project_id: &str) -> Result<Value, CoreError> {
        if !self.project_exists(project_id) {
            return Err(CoreError::NotFound);
        }
        let runtime = self.playbook_runtime(json!({"projectId": project_id}))?;
        Ok(json!({
            "playbook": self.playbook_value(project_id)?,
            "runtime": runtime,
            "stateRevision": self.store.revision(),
        }))
    }

    /// Replaces the one current Steward brief on a same-Project active Task.
    /// Replace-only with a document-revision CAS; never an appended diary.
    pub fn set_steward_task_brief(
        &mut self,
        steward_session_id: &str,
        project_id: &str,
        task_id: &str,
        brief_markdown: String,
        expected_brief_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        self.authorize_steward_task_execution(steward_session_id, project_id, task_id)?;
        self.ensure_task_active(task_id)?;
        if brief_markdown.len() > TASK_STEWARD_BRIEF_MAX_BYTES
            || (!brief_markdown.is_empty() && brief_markdown.trim().is_empty())
        {
            return Err(CoreError::InvalidParams("briefMarkdown".into()));
        }
        let task = self
            .store
            .update_task_steward_brief(
                &self.write_authority,
                task_id,
                brief_markdown,
                expected_brief_revision,
                updated_at_epoch_ms,
            )
            .map_err(store_error)?;
        Ok(json!({
            "taskId": task.id,
            "status": "updated",
            "briefRevision": task.steward_brief_revision,
        }))
    }

    fn playbook_value(&self, project_id: &str) -> Result<Value, CoreError> {
        self.store
            .playbook_for_project(project_id)
            .map(|playbook| playbook_projection(playbook, self.store.tracker_configurations()))
            .transpose()
            .map(|playbook| playbook.unwrap_or(Value::Null))
    }
}

fn current_step_routines(
    playbook: &PlaybookConfiguration,
) -> HashMap<(String, String), PlaybookMilestone> {
    let mut values = HashMap::new();
    for milestone in &playbook.milestones {
        values.insert(
            (playbook.active_pipeline_name.clone(), milestone.id.clone()),
            milestone.clone(),
        );
    }
    for pipeline in &playbook.saved_pipelines {
        for milestone in &pipeline.milestones {
            values.insert(
                (pipeline.name.clone(), milestone.id.clone()),
                milestone.clone(),
            );
        }
    }
    values
}

#[allow(clippy::too_many_arguments)]
fn materialize_pipeline(
    project_id: &str,
    pipeline_name: &str,
    drafts: &[PlaybookMilestoneDraft],
    current_steps: &HashMap<(String, String), PlaybookMilestone>,
    current_routines: &HashMap<String, TrackerConfiguration>,
    generated_ids: &mut impl Iterator<Item = String>,
    reused_ids: &mut HashSet<String>,
    next_routine_ids: &mut HashSet<String>,
    upsert_routines: &mut Vec<TrackerConfiguration>,
    updated_at_epoch_ms: u64,
) -> Result<(Vec<PlaybookMilestone>, bool), CoreError> {
    let mut milestones = Vec::with_capacity(drafts.len());
    let mut changed = false;
    for draft in drafts {
        let prompt = step_check_prompt(&draft.complete_when)?;
        let steward_instructions =
            step_steward_instructions(&draft.while_waiting.instructions, draft.while_waiting.mode)?;
        let name = bounded_check_name(&draft.title);
        let current_milestone = current_steps.get(&(pipeline_name.to_owned(), draft.id.clone()));
        let reusable = current_milestone.and_then(|milestone| {
            let routine = current_routines.get(&milestone.routine_id)?;
            (milestone.title == draft.title
                && milestone.gate == draft.gate
                && milestone.retry_delay_seconds == draft.retry_delay_seconds
                && milestone.approver == draft.approver
                && routine.project_id == project_id
                && routine.trigger_mode == RoutineTriggerMode::OnDemand
                && routine.name == name
                && routine.prompt == prompt
                && routine.steward_instructions == steward_instructions
                && routine.action_handling == draft.while_waiting.mode
                && !reused_ids.contains(&routine.id))
            .then_some(routine)
        });
        let (routine_id, configuration) = if let Some(current) = reusable {
            reused_ids.insert(current.id.clone());
            let configuration = if current.enabled {
                current.clone()
            } else {
                changed = true;
                TrackerConfiguration {
                    enabled: true,
                    generation: current
                        .generation
                        .checked_add(1)
                        .ok_or(CoreError::RevisionConflict)?,
                    updated_at_epoch_ms,
                    pending_routine_findings: Vec::new(),
                    ..current.clone()
                }
            };
            (current.id.clone(), configuration)
        } else {
            changed = true;
            let routine_id = generated_ids
                .next()
                .ok_or_else(|| CoreError::InvalidParams("milestones".into()))?;
            reused_ids.insert(routine_id.clone());
            (
                routine_id.clone(),
                TrackerConfiguration {
                    id: routine_id,
                    project_id: project_id.to_owned(),
                    trigger_mode: RoutineTriggerMode::OnDemand,
                    name,
                    prompt,
                    steward_instructions,
                    enabled: true,
                    schedule_interval_seconds: 60,
                    generation: 1,
                    context_markdown: String::new(),
                    context_revision: 1,
                    recent_source_keys: Vec::new(),
                    related_task_ids: Vec::new(),
                    action_handling: draft.while_waiting.mode,
                    pending_routine_findings: Vec::new(),
                    last_check_started_at_epoch_ms: None,
                    last_attempt_at_epoch_ms: None,
                    last_successful_report_at_epoch_ms: None,
                    updated_at_epoch_ms,
                },
            )
        };
        next_routine_ids.insert(routine_id.clone());
        upsert_routines.push(configuration);
        milestones.push(PlaybookMilestone {
            id: draft.id.clone(),
            title: draft.title.clone(),
            gate: draft.gate,
            routine_id,
            retry_delay_seconds: draft.retry_delay_seconds,
            approver: draft.approver.clone(),
        });
    }
    Ok((milestones, changed))
}

fn step_check_prompt(instructions: &str) -> Result<String, CoreError> {
    if !instructions.is_empty() {
        return Ok(instructions.to_owned());
    }
    termloop_invocation::tracker_assignment_prompt(
        termloop_invocation::ExecutorRole::StepCheckTracker,
    )
    .map(|prompt| prompt.delivered_preview().to_owned())
    .map_err(|error| CoreError::Terminal(error.to_string()))
}

fn step_steward_instructions(
    instructions: &str,
    action_handling: RoutineActionHandling,
) -> Result<String, CoreError> {
    if instructions.len() > termloop_domain::TRACKER_PROMPT_MAX_BYTES
        || (!instructions.is_empty() && instructions.trim().is_empty())
        || (action_handling != RoutineActionHandling::Off && instructions.trim().is_empty())
    {
        return Err(CoreError::InvalidParams("playbook".into()));
    }
    Ok(instructions.to_owned())
}

fn bounded_check_name(title: &str) -> String {
    let mut value = String::new();
    for character in title.trim().chars() {
        if value.len() + character.len_utf8() > termloop_domain::TRACKER_NAME_MAX_BYTES {
            break;
        }
        value.push(character);
    }
    value
}

fn playbook_projection(
    configuration: &PlaybookConfiguration,
    routines: &[TrackerConfiguration],
) -> Result<Value, CoreError> {
    let milestone = |value: &PlaybookMilestone| -> Result<Value, CoreError> {
        let routine = routines
            .iter()
            .find(|routine| {
                routine.id == value.routine_id && routine.project_id == configuration.project_id
            })
            .ok_or_else(|| CoreError::Store("Playbook Routine is missing".into()))?;
        Ok(json!({
            "id": value.id,
            "title": value.title,
            "gate": value.gate,
            "routineId": value.routine_id,
            "retryDelaySeconds": value.retry_delay_seconds,
            "completeWhen": routine.prompt,
            "whileWaiting": {
                "mode": routine.action_handling,
                "instructions": routine.steward_instructions,
            },
            "approver": value.approver,
        }))
    };
    let milestones = configuration
        .milestones
        .iter()
        .map(milestone)
        .collect::<Result<Vec<_>, _>>()?;
    let saved_pipelines = configuration
        .saved_pipelines
        .iter()
        .map(|pipeline| {
            Ok(json!({
                "name": pipeline.name,
                "milestones": pipeline
                    .milestones
                    .iter()
                    .map(milestone)
                    .collect::<Result<Vec<_>, CoreError>>()?,
            }))
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    Ok(json!({
        "projectId": configuration.project_id,
        "revision": configuration.revision,
        "activePipelineName": configuration.active_pipeline_name,
        "milestones": milestones,
        "savedPipelines": saved_pipelines,
        "updatedAtEpochMs": configuration.updated_at_epoch_ms,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{
        PlaybookGateKind, RoutineTriggerMode, StewardAgentId, TrackerConfiguration,
    };
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::TerminalService;

    fn runtime_with_empty_project() -> (std::path::PathBuf, std::path::PathBuf, CoreRuntime, String)
    {
        let path = std::env::temp_dir().join(format!(
            "termloop-core-playbook-{}-{}.json",
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
        let project_id = runtime
            .handle("project.create", json!({"name":"Demo","folderPath":folder}))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        (path, folder, runtime, project_id)
    }

    fn runtime_with_project() -> (std::path::PathBuf, std::path::PathBuf, CoreRuntime, String) {
        let (path, folder, mut runtime, project_id) = runtime_with_empty_project();
        install_step_routine(&mut runtime, &project_id);
        (path, folder, runtime, project_id)
    }

    fn milestone_value() -> Value {
        json!({
            "id": "pr-approved",
            "title": "PR approved",
            "gate": "human",
            "retryDelaySeconds": 600,
            "completeWhen": "PR review projection shows an approval.",
            "whileWaiting": {"mode":"off","instructions":""},
            "approver": "ferit"
        })
    }

    fn document_milestone_value() -> Value {
        json!({
            "id": "pr-approved",
            "title": "PR approved",
            "gate": "human",
            "routineId": "routine-pr",
            "retryDelaySeconds": 600,
            "completeWhen": "Check the Task's pull request.",
            "whileWaiting": {"mode":"off","instructions":""},
            "approver": "ferit"
        })
    }

    fn apply_playbook(
        runtime: &mut CoreRuntime,
        mut params: Value,
        updated_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        params["expectedRevision"] = json!(runtime.state_revision());
        runtime.update_playbook(
            params,
            (0..32)
                .map(|index| format!("generated-routine-{updated_at_epoch_ms}-{index}"))
                .collect(),
            updated_at_epoch_ms,
        )
    }

    /// A step may only name a Routine that already exists in its Project, so
    /// the fixture Project owns the on-demand Routine first.
    fn install_step_routine(runtime: &mut CoreRuntime, project_id: &str) {
        let revision = runtime.state_revision();
        runtime
            .store
            .set_tracker_configuration(
                &runtime.write_authority,
                TrackerConfiguration {
                    id: "routine-pr".into(),
                    project_id: project_id.to_owned(),
                    trigger_mode: RoutineTriggerMode::OnDemand,
                    name: "PR checker".into(),
                    prompt: "Check the Task's pull request.".into(),
                    steward_instructions: String::new(),
                    enabled: true,
                    schedule_interval_seconds: 300,
                    generation: 1,
                    context_markdown: String::new(),
                    context_revision: 1,
                    recent_source_keys: vec![],
                    related_task_ids: vec![],
                    action_handling: termloop_domain::RoutineActionHandling::Off,
                    pending_routine_findings: vec![],
                    last_check_started_at_epoch_ms: None,
                    last_attempt_at_epoch_ms: None,
                    last_successful_report_at_epoch_ms: None,
                    updated_at_epoch_ms: 1,
                },
                revision,
            )
            .unwrap();
    }

    #[test]
    fn executable_playbook_apply_enables_the_configured_steward() {
        let (path, folder, mut runtime, project_id) = runtime_with_empty_project();
        let revision = runtime.state_revision();
        runtime
            .store
            .set_steward_configuration(
                &runtime.write_authority,
                StewardConfiguration {
                    project_id: project_id.clone(),
                    agent_id: StewardAgentId::Codex,
                    model: "gpt-5.6-luna".into(),
                    permission: "bypassPermissions".into(),
                    reasoning: "medium".into(),
                    enabled: false,
                    system_prompt: String::new(),
                    executor_session_id: None,
                    generation: 1,
                    updated_at_epoch_ms: 0,
                },
                revision,
            )
            .unwrap();
        let milestone = milestone_value();

        runtime
            .update_playbook(
                json!({
                    "projectId": project_id.clone(),
                    "activePipelineName": "Draft",
                    "savedPipelines": [],
                    "milestones": [],
                    "expectedPlaybookRevision": 0,
                    "expectedRevision": runtime.state_revision(),
                }),
                Vec::new(),
                1,
            )
            .unwrap();
        assert!(!runtime.store.steward_configurations()[0].enabled);

        let result = runtime
            .update_playbook(
                json!({
                    "projectId": project_id.clone(),
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [milestone.clone()],
                    "expectedPlaybookRevision": 1,
                    "expectedRevision": runtime.state_revision(),
                }),
                vec!["generated-routine".into()],
                1,
            )
            .unwrap();

        assert_eq!(result["playbook"]["revision"], 2);
        assert_eq!(
            result["playbook"]["milestones"].as_array().unwrap().len(),
            1
        );
        let steward = &runtime.store.steward_configurations()[0];
        assert!(steward.enabled);
        assert_eq!(steward.generation, 2);
        assert_eq!(steward.updated_at_epoch_ms, 1);

        // Applying a later executable pipeline also restores its execution
        // capacity when the Steward was disabled after the first apply.
        let revision = runtime.state_revision();
        let mut disabled_again = steward.clone();
        disabled_again.enabled = false;
        disabled_again.generation = 3;
        disabled_again.updated_at_epoch_ms = 2;
        runtime
            .store
            .set_steward_configuration(&runtime.write_authority, disabled_again, revision)
            .unwrap();
        let revised = apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production revised",
                "savedPipelines": [],
                "milestones": [milestone],
                "expectedPlaybookRevision": 2,
            }),
            3,
        )
        .unwrap();
        assert_eq!(revised["playbook"]["revision"], 3);
        let steward = &runtime.store.steward_configurations()[0];
        assert!(steward.enabled);
        assert_eq!(steward.generation, 4);
        assert_eq!(steward.updated_at_epoch_ms, 3);

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn playbook_materializes_more_than_the_legacy_sixteen_routines() {
        let (path, folder, mut runtime, project_id) = runtime_with_empty_project();
        let milestones = (0..20)
            .map(|index| {
                let mut milestone = milestone_value();
                milestone["id"] = json!(format!("stage-{index}"));
                milestone["title"] = json!(format!("Stage {index}"));
                milestone
            })
            .collect::<Vec<_>>();

        let result = apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production",
                "savedPipelines": [],
                "milestones": milestones,
                "expectedPlaybookRevision": 0,
            }),
            1,
        )
        .unwrap();

        assert_eq!(
            result["playbook"]["milestones"].as_array().unwrap().len(),
            20
        );
        assert_eq!(runtime.store.tracker_configurations().len(), 20);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn playbook_update_is_replace_only_with_document_revision_cas() {
        let (path, folder, mut runtime, project_id) = runtime_with_project();

        // Create requires expectedPlaybookRevision 0.
        assert!(matches!(
            apply_playbook(
                &mut runtime,
                json!({
                    "projectId": project_id,
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [milestone_value()],
                    "expectedPlaybookRevision": 3,
                }),
                1,
            ),
            Err(CoreError::RevisionConflict)
        ));
        let created = apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production",
                "savedPipelines": [],
                "milestones": [milestone_value()],
                "expectedPlaybookRevision": 0,
            }),
            1,
        )
        .unwrap();
        assert_eq!(created["playbook"]["revision"], 1);
        let created_routine_id = created["playbook"]["milestones"][0]["routineId"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut created_routine = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == created_routine_id)
            .cloned()
            .unwrap();
        created_routine.action_handling = termloop_domain::RoutineActionHandling::Ask;
        created_routine.steward_instructions =
            "If approval is still missing, consider asking the named approver.".into();
        created_routine.updated_at_epoch_ms = 2;
        let revision = runtime.state_revision();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, created_routine, revision)
            .unwrap();
        let read = runtime
            .handle("playbook.get", json!({"projectId": project_id}))
            .unwrap();
        assert_eq!(read["playbook"]["milestones"][0]["id"], "pr-approved");
        assert_eq!(
            runtime
                .playbook_projection_for_executor(&project_id)
                .unwrap()["playbook"]["revision"],
            1
        );
        let executor_projection = runtime
            .playbook_projection_for_executor(&project_id)
            .unwrap();
        assert_eq!(
            executor_projection["runtime"]["activePipelineName"],
            "Ship to production"
        );
        assert_eq!(
            executor_projection["runtime"]["stateRevision"],
            runtime.state_revision()
        );

        // Replace requires the exact current document revision.
        assert!(matches!(
            apply_playbook(
                &mut runtime,
                json!({
                    "projectId": project_id,
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [milestone_value()],
                    "expectedPlaybookRevision": 0,
                }),
                2,
            ),
            Err(CoreError::RevisionConflict)
        ));
        let mut renamed = milestone_value();
        renamed["title"] = json!("Is the PR approved?");
        renamed["whileWaiting"]["instructions"] = json!(
            "If approval is still missing, propose asking the named approver and ask Ferit whether to send it."
        );
        renamed["whileWaiting"]["mode"] = json!("ask");
        let replaced = apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production",
                "savedPipelines": [],
                "milestones": [renamed.clone()],
                "expectedPlaybookRevision": 1,
            }),
            2,
        )
        .unwrap();
        assert_eq!(replaced["playbook"]["revision"], 2);
        let replaced_routine_id = replaced["playbook"]["milestones"][0]["routineId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(replaced_routine_id, created_routine_id);
        assert!(
            runtime
                .store
                .tracker_configurations()
                .iter()
                .all(|routine| routine.id != created_routine_id)
        );
        let replaced_routine = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == replaced_routine_id)
            .unwrap();
        assert_eq!(
            replaced_routine.action_handling,
            termloop_domain::RoutineActionHandling::Ask
        );
        assert_eq!(
            replaced_routine.steward_instructions,
            "If approval is still missing, propose asking the named approver and ask Ferit whether to send it."
        );

        // An identical document is a no-op that keeps the document revision.
        let unchanged = apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production",
                "savedPipelines": [],
                "milestones": [renamed],
                "expectedPlaybookRevision": 2,
            }),
            3,
        )
        .unwrap();
        assert_eq!(unchanged["playbook"]["revision"], 2);
        assert_eq!(
            unchanged["playbook"]["milestones"][0]["routineId"],
            replaced_routine_id
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn clearing_the_board_needs_no_provider_cli() {
        let (path, folder, mut runtime, project_id) = runtime_with_project();
        apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production",
                "savedPipelines": [],
                "milestones": [milestone_value()],
                "expectedPlaybookRevision": 0,
            }),
            1,
        )
        .unwrap();
        let result = runtime
            .update_playbook(
                json!({
                    "projectId": project_id,
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [],
                    "expectedPlaybookRevision": 1,
                    "expectedRevision": runtime.state_revision(),
                }),
                vec![],
                2,
            )
            .unwrap();
        assert!(
            result["playbook"]["milestones"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn playbook_rejects_unknown_projects_and_invalid_documents() {
        let (path, folder, mut runtime, project_id) = runtime_with_project();

        assert!(matches!(
            apply_playbook(
                &mut runtime,
                json!({
                    "projectId": "missing-project",
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [],
                    "expectedPlaybookRevision": 0,
                }),
                1,
            ),
            Err(CoreError::NotFound)
        ));

        // An approver on an automatic gate fails domain validation.
        let mut automatic = milestone_value();
        automatic["gate"] = json!("automatic");
        assert!(matches!(
            apply_playbook(&mut runtime,
                json!({
                    "projectId": project_id,
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [automatic],
                    "expectedPlaybookRevision": 0,
                }),
                1,
            ),
            Err(CoreError::InvalidParams(field)) if field == "playbook"
        ));

        // Human gates must name the approver whose visible action can satisfy
        // the milestone; otherwise the Steward could never prove the gate.
        let mut human_without_approver = milestone_value();
        human_without_approver
            .as_object_mut()
            .unwrap()
            .remove("approver");
        assert!(matches!(
            apply_playbook(&mut runtime,
                json!({
                    "projectId": project_id,
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [human_without_approver],
                    "expectedPlaybookRevision": 0,
                }),
                1,
            ),
            Err(CoreError::InvalidParams(field)) if field == "playbook"
        ));

        // An actionable waiting policy is incomplete unless the Steward knows
        // what bounded response it may offer or perform.
        let mut missing_steward_policy = milestone_value();
        missing_steward_policy["whileWaiting"]["mode"] = json!("ask");
        assert!(matches!(
            apply_playbook(
                &mut runtime,
                json!({
                    "projectId": project_id,
                    "activePipelineName": "Ship to production",
                    "savedPipelines": [],
                    "milestones": [missing_steward_policy],
                    "expectedPlaybookRevision": 0,
                }),
                1,
            ),
            Err(CoreError::InvalidParams(field)) if field == "playbook"
        ));

        assert!(matches!(
            runtime.handle("playbook.get", json!({"projectId": "missing-project"})),
            Err(CoreError::NotFound)
        ));
        assert_eq!(
            runtime
                .handle("playbook.get", json!({"projectId": project_id}))
                .unwrap()["playbook"],
            Value::Null
        );

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn a_kept_playbook_step_prevents_its_routine_from_being_deleted() {
        let (path, folder, mut runtime, project_id) = runtime_with_project();
        apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production",
                "savedPipelines": [],
                "milestones": [milestone_value()],
                "expectedPlaybookRevision": 0,
            }),
            1,
        )
        .unwrap();

        // Park the pipeline so the question survives only in a pipeline the
        // Project keeps. A kept question used to be the hardest hold to escape:
        // the sidebar showed the Routine as unasked, while the store still
        // refused to delete it.
        apply_playbook(
            &mut runtime,
            json!({
                "projectId": project_id,
                "activePipelineName": "Ship to production",
                "savedPipelines": [{"name": "Parked", "milestones": [milestone_value()]}],
                "milestones": [],
                "expectedPlaybookRevision": 1,
            }),
            2,
        )
        .unwrap();

        let routine_id = runtime.store.playbook_for_project(&project_id).unwrap()
            .saved_pipelines[0].milestones[0].routine_id.clone();
        let mut routine = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|candidate| candidate.id == routine_id)
            .unwrap()
            .clone();
        routine.enabled = false;
        let revision = runtime.state_revision();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, routine, revision)
            .unwrap();
        assert!(matches!(
            runtime.delete_tracker_configuration(&routine_id, runtime.state_revision()),
            Err(CoreError::PlaybookStepRoutineHeld { .. })
        ));

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn domain_playbook_round_trips_through_wire_field_names() {
        // The domain serde shape is the wire shape: gate and verdict names must
        // match the generated contract enums exactly.
        let milestone: PlaybookMilestone =
            serde_json::from_value(document_milestone_value()).unwrap();
        assert_eq!(milestone.gate, PlaybookGateKind::Human);
        assert_eq!(milestone.routine_id, "routine-pr");
        assert_eq!(milestone.retry_delay_seconds, 600);
        assert_eq!(
            serde_json::to_value([
                termloop_domain::PlaybookStepVerdict::Passed,
                termloop_domain::PlaybookStepVerdict::Waiting,
            ])
            .unwrap(),
            json!(["passed", "waiting"])
        );
        assert_eq!(
            serde_json::to_value([PlaybookGateKind::Automatic, PlaybookGateKind::Human]).unwrap(),
            json!(["automatic", "human"])
        );
    }
}
