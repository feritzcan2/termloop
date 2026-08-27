//! Target-bound Improve Agent launch context for assistant configuration.
//!
//! Agents save complete snapshots through the shared configuration MCP
//! surface. This module only resolves visible launch context.

use serde_json::{Value, json};
use termloop_domain::{
    STEWARD_SYSTEM_PROMPT_MAX_BYTES, TRACKER_PROMPT_MAX_BYTES, TrackerConfiguration,
    WORKER_SYSTEM_PROMPT_MAX_BYTES, WorkerConfiguration,
};

use crate::{CoreError, CoreRuntime};

const CONFIGURATION_DOCUMENT_MAX_BYTES: usize =
    termloop_domain::CONFIGURATION_VERSION_CONTENT_MAX_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistantPromptSurface {
    StewardInstructions,
    WorkerInstructions,
    RoutineInstructions,
    RoutineBuilder,
    Playbook,
}

impl AssistantPromptSurface {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "stewardInstructions" => Self::StewardInstructions,
            "workerInstructions" => Self::WorkerInstructions,
            "routineInstructions" => Self::RoutineInstructions,
            "routineBuilder" => Self::RoutineBuilder,
            "playbook" => Self::Playbook,
            _ => return None,
        })
    }

    pub fn wire(self) -> &'static str {
        match self {
            Self::StewardInstructions => "stewardInstructions",
            Self::WorkerInstructions => "workerInstructions",
            Self::RoutineInstructions => "routineInstructions",
            Self::RoutineBuilder => "routineBuilder",
            Self::Playbook => "playbook",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::StewardInstructions => STEWARD_SYSTEM_PROMPT_MAX_BYTES,
            Self::WorkerInstructions => WORKER_SYSTEM_PROMPT_MAX_BYTES,
            Self::RoutineInstructions => TRACKER_PROMPT_MAX_BYTES,
            Self::RoutineBuilder | Self::Playbook => CONFIGURATION_DOCUMENT_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AssistantPromptTarget {
    surface: AssistantPromptSurface,
    owner_id: Option<String>,
}

impl AssistantPromptTarget {
    fn parse(params: &Value) -> Result<Self, CoreError> {
        let surface = params
            .get("surface")
            .and_then(Value::as_str)
            .and_then(AssistantPromptSurface::parse)
            .ok_or_else(|| CoreError::InvalidParams("surface".into()))?;
        let owner_id = params
            .get("ownerId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned);
        let well_formed = match surface {
            AssistantPromptSurface::StewardInstructions | AssistantPromptSurface::Playbook => {
                owner_id.is_none()
            }
            _ => owner_id.is_some(),
        };
        well_formed
            .then_some(Self { surface, owner_id })
            .ok_or_else(|| CoreError::InvalidParams("ownerId".into()))
    }
}

#[derive(Debug, Clone)]
pub struct AssistantPromptImproverBindings {
    surface: AssistantPromptSurface,
    owner_id: Option<String>,
    subject_name: String,
    worker_name: String,
    built_in_instructions: String,
    routine_summary: String,
    checkout_path: String,
}

impl AssistantPromptImproverBindings {
    pub fn checkout_path(&self) -> &str {
        &self.checkout_path
    }

    pub fn surface(&self) -> AssistantPromptSurface {
        self.surface
    }

    pub fn owner_id(&self) -> Option<&str> {
        self.owner_id.as_deref()
    }

    pub fn session_name(&self) -> String {
        match self.surface {
            AssistantPromptSurface::StewardInstructions => "improve: Steward configuration".into(),
            AssistantPromptSurface::WorkerInstructions => {
                format!("improve: {} configuration", self.subject_name)
            }
            AssistantPromptSurface::RoutineInstructions => {
                format!("improve: {}", self.subject_name)
            }
            AssistantPromptSurface::RoutineBuilder => {
                format!("build: Routine for {}", self.subject_name)
            }
            AssistantPromptSurface::Playbook => "build: Project Playbook".into(),
        }
    }

    pub fn improver_target(&self) -> termloop_invocation::ImproverTarget<'_> {
        match self.surface {
            AssistantPromptSurface::StewardInstructions => {
                termloop_invocation::ImproverTarget::StewardInstructions {
                    project_name: &self.subject_name,
                    built_in_instructions: &self.built_in_instructions,
                    max_bytes: self.surface.max_bytes(),
                }
            }
            AssistantPromptSurface::WorkerInstructions => {
                termloop_invocation::ImproverTarget::WorkerInstructions {
                    worker_id: self.owner_id.as_deref().unwrap_or_default(),
                    worker_name: &self.subject_name,
                    built_in_instructions: &self.built_in_instructions,
                    routine_summary: &self.routine_summary,
                    max_bytes: self.surface.max_bytes(),
                }
            }
            AssistantPromptSurface::RoutineInstructions => {
                termloop_invocation::ImproverTarget::RoutineInstructions {
                    routine_id: self.owner_id.as_deref().unwrap_or_default(),
                    routine_name: &self.subject_name,
                    worker_name: &self.worker_name,
                    built_in_instructions: &self.built_in_instructions,
                    max_bytes: self.surface.max_bytes(),
                }
            }
            AssistantPromptSurface::RoutineBuilder => {
                termloop_invocation::ImproverTarget::RoutineBuilder {
                    project_name: &self.worker_name,
                    worker_id: self.owner_id.as_deref().unwrap_or_default(),
                    worker_name: &self.subject_name,
                    routine_summary: &self.routine_summary,
                }
            }
            AssistantPromptSurface::Playbook => termloop_invocation::ImproverTarget::Playbook {
                project_name: &self.subject_name,
            },
        }
    }
}

impl CoreRuntime {
    pub fn assistant_prompt_improver_bindings(
        &self,
        project_id: &str,
        params: &Value,
    ) -> Result<AssistantPromptImproverBindings, CoreError> {
        let target = AssistantPromptTarget::parse(params)?;
        let mut bindings = AssistantPromptImproverBindings {
            surface: target.surface,
            owner_id: target.owner_id.clone(),
            subject_name: String::new(),
            worker_name: String::new(),
            built_in_instructions: String::new(),
            routine_summary: String::new(),
            checkout_path: self.project_checkout_path(project_id)?,
        };
        match target.surface {
            AssistantPromptSurface::StewardInstructions => {
                self.owned_steward_configuration(project_id)?;
                bindings.subject_name = self.project_display_name(project_id)?;
                bindings.built_in_instructions =
                    termloop_invocation::default_steward_system_prompt().to_owned();
            }
            AssistantPromptSurface::WorkerInstructions => {
                let worker = self.owned_worker_configuration(
                    project_id,
                    target.owner_id.as_deref().unwrap_or_default(),
                )?;
                bindings.subject_name = worker.name.clone();
                bindings.built_in_instructions =
                    termloop_invocation::executor_prompt(termloop_invocation::ExecutorRole::Worker)
                        .map_err(|error| CoreError::Terminal(error.to_string()))?
                        .delivered_preview()
                        .trim()
                        .to_owned();
                bindings.routine_summary = self.worker_routine_summary(&worker.id);
            }
            AssistantPromptSurface::RoutineInstructions => {
                let routine = self.owned_routine_configuration(
                    project_id,
                    target.owner_id.as_deref().unwrap_or_default(),
                )?;
                bindings.subject_name = routine.name.clone();
                bindings.worker_name = self
                    .store
                    .worker_configurations()
                    .iter()
                    .find(|worker| worker.id == routine.worker_id)
                    .map(|worker| worker.name.clone())
                    .unwrap_or_else(|| "this Project's Worker".into());
                bindings.built_in_instructions =
                    termloop_invocation::tracker_assignment_prompt(routine_role(&routine))
                        .map_err(|error| CoreError::Terminal(error.to_string()))?
                        .delivered_preview()
                        .trim()
                        .to_owned();
            }
            AssistantPromptSurface::RoutineBuilder => {
                let worker = self.owned_worker_configuration(
                    project_id,
                    target.owner_id.as_deref().unwrap_or_default(),
                )?;
                bindings.subject_name = worker.name.clone();
                bindings.worker_name = self.project_display_name(project_id)?;
                bindings.routine_summary = self.worker_routine_summary(&worker.id);
            }
            AssistantPromptSurface::Playbook => {
                bindings.subject_name = self.project_display_name(project_id)?;
            }
        }
        Ok(bindings)
    }

    fn owned_steward_configuration(
        &self,
        project_id: &str,
    ) -> Result<termloop_domain::StewardConfiguration, CoreError> {
        self.store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .cloned()
            .ok_or(CoreError::NotFound)
    }

    fn owned_worker_configuration(
        &self,
        project_id: &str,
        worker_id: &str,
    ) -> Result<WorkerConfiguration, CoreError> {
        self.store
            .worker_configurations()
            .iter()
            .find(|worker| worker.id == worker_id && worker.project_id == project_id)
            .cloned()
            .ok_or(CoreError::NotFound)
    }

    fn owned_routine_configuration(
        &self,
        project_id: &str,
        routine_id: &str,
    ) -> Result<TrackerConfiguration, CoreError> {
        self.store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == routine_id && routine.project_id == project_id)
            .cloned()
            .ok_or(CoreError::NotFound)
    }

    fn project_display_name(&self, project_id: &str) -> Result<String, CoreError> {
        self.store
            .projects()
            .iter()
            .find(|project| project.id == project_id)
            .map(|project| project.name.clone())
            .ok_or(CoreError::NotFound)
    }

    fn worker_routine_summary(&self, worker_id: &str) -> String {
        let routines = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|routine| routine.worker_id == worker_id)
            .map(|routine| {
                json!({
                    "id": routine.id,
                    "name": routine.name,
                    "kind": routine.kind,
                    "triggerMode": routine.trigger_mode,
                    "enabled": routine.enabled,
                    "scheduleIntervalSeconds": routine.schedule_interval_seconds,
                    "actionHandling": routine.action_handling,
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_string_pretty(&json!({ "routines": routines }))
            .expect("Routine inventory serializes")
    }
}

fn routine_role(routine: &TrackerConfiguration) -> termloop_invocation::ExecutorRole {
    if routine.trigger_mode.is_scheduled() {
        super::assistant_session::tracker_role(routine.kind)
    } else {
        termloop_invocation::ExecutorRole::StepCheckTracker
    }
}
