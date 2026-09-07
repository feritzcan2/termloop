//! Pure Project-scoped workflow configuration values.
//!
//! A workflow is a small, durable recipe for coordinating ordinary Agent
//! Sessions. One bounded current execution may be retained per Task so Core
//! can enforce the next step and conversation reuse across daemon restarts;
//! completed attempts and execution history are never accumulated.

use crate::{AgentLaunchSelection, agent_id_is_well_formed};

pub const WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX: usize = 16;
pub const WORKFLOW_STEPS_MAX: usize = 8;
pub const WORKFLOW_ID_MAX_BYTES: usize = 64;
pub const WORKFLOW_NAME_MAX_BYTES: usize = 80;
pub const WORKFLOW_STEP_ID_MAX_BYTES: usize = 64;
pub const WORKFLOW_STEP_TITLE_MAX_BYTES: usize = 120;
pub const WORKFLOW_STEP_INSTRUCTIONS_MAX_BYTES: usize = 4 * 1024;
pub const WORKFLOW_REVIEW_CYCLES_MAX: u8 = 3;
pub const WORKFLOW_GOAL_MAX_BYTES: usize = 32 * 1024;
pub const WORKFLOW_EXECUTION_ID_MAX_BYTES: usize = 64;
pub const WORKFLOW_STEP_RESULT_SUMMARY_MAX_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowStepKind {
    Discuss,
    Implement,
    Review,
    Fix,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub id: String,
    pub kind: WorkflowStepKind,
    pub title: String,
    pub instructions: String,
    /// Helper Agent used by discussion and review steps. The coordinator owns
    /// implementation and fix steps, so they never carry a helper Agent.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// A review may continue one earlier helper conversation instead of
    /// launching a fresh helper. The referenced step must precede this step
    /// and use the same helper Agent.
    #[serde(default)]
    pub reuse_step_id: Option<String>,
    /// Fresh helper conversations carry their exact launch selection. Reused
    /// conversations inherit the selection already stored on that Session.
    #[serde(default)]
    pub launch_selection: Option<AgentLaunchSelection>,
}

impl WorkflowStep {
    pub fn is_valid(&self) -> bool {
        bounded_slug(&self.id, WORKFLOW_STEP_ID_MAX_BYTES)
            && bounded_text(&self.title, WORKFLOW_STEP_TITLE_MAX_BYTES)
            && bounded_text(&self.instructions, WORKFLOW_STEP_INSTRUCTIONS_MAX_BYTES)
            && match self.kind {
                WorkflowStepKind::Discuss | WorkflowStepKind::Review => {
                    self.agent_id
                        .as_deref()
                        .is_some_and(agent_id_is_well_formed)
                        && match self.reuse_step_id {
                            Some(_) => self.launch_selection.is_none(),
                            None => self
                                .launch_selection
                                .as_ref()
                                .is_some_and(AgentLaunchSelection::is_well_formed),
                        }
                }
                WorkflowStepKind::Implement | WorkflowStepKind::Fix => {
                    self.agent_id.is_none() && self.launch_selection.is_none()
                }
            }
            && (self.kind == WorkflowStepKind::Review || self.reuse_step_id.is_none())
            && self
                .reuse_step_id
                .as_deref()
                .is_none_or(|id| bounded_slug(id, WORKFLOW_STEP_ID_MAX_BYTES))
    }
}

/// One named coordinator workflow available to all Tasks in a Project.
/// Discussion steps are ordered; one contiguous review group fans out behind
/// the implementation step and joins before the optional fix loop.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowConfiguration {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub coordinator_agent_id: String,
    pub launch_selection: AgentLaunchSelection,
    pub max_review_cycles: u8,
    pub steps: Vec<WorkflowStep>,
    pub generation: u64,
    pub updated_at_epoch_ms: u64,
}

impl WorkflowConfiguration {
    pub fn is_valid(&self) -> bool {
        let implement_index = self
            .steps
            .iter()
            .position(|step| step.kind == WorkflowStepKind::Implement);
        bounded_slug(&self.id, WORKFLOW_ID_MAX_BYTES)
            && !self.project_id.trim().is_empty()
            && bounded_text(&self.name, WORKFLOW_NAME_MAX_BYTES)
            && agent_id_is_well_formed(&self.coordinator_agent_id)
            && self.launch_selection.is_well_formed()
            && (1..=WORKFLOW_REVIEW_CYCLES_MAX).contains(&self.max_review_cycles)
            && !self.steps.is_empty()
            && self.steps.len() <= WORKFLOW_STEPS_MAX
            && self.steps.iter().all(WorkflowStep::is_valid)
            && self.steps.iter().enumerate().all(|(index, step)| {
                !self.steps[index + 1..]
                    .iter()
                    .any(|candidate| candidate.id == step.id)
            })
            && implement_index.is_some_and(|implement_index| {
                let fix_indexes = self
                    .steps
                    .iter()
                    .enumerate()
                    .filter_map(|(index, step)| {
                        (step.kind == WorkflowStepKind::Fix).then_some(index)
                    })
                    .collect::<Vec<_>>();
                self.steps
                    .iter()
                    .filter(|step| step.kind == WorkflowStepKind::Implement)
                    .count()
                    == 1
                    && self.steps[..implement_index]
                        .iter()
                        .all(|step| step.kind == WorkflowStepKind::Discuss)
                    && self.steps[implement_index + 1..].iter().all(|step| {
                        matches!(step.kind, WorkflowStepKind::Review | WorkflowStepKind::Fix)
                    })
                    && fix_indexes.len() <= 1
                    && fix_indexes.first().is_none_or(|fix_index| {
                        *fix_index == self.steps.len() - 1
                            && self.steps[implement_index + 1..*fix_index]
                                .iter()
                                .any(|step| step.kind == WorkflowStepKind::Review)
                    })
            })
            && self.steps.iter().enumerate().all(|(index, step)| {
                step.reuse_step_id.as_deref().is_none_or(|reuse_step_id| {
                    self.steps[..index].iter().any(|candidate| {
                        candidate.id == reuse_step_id
                            && matches!(
                                candidate.kind,
                                WorkflowStepKind::Discuss | WorkflowStepKind::Review
                            )
                            && candidate.agent_id == step.agent_id
                    })
                })
            })
            && self.generation >= 1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowExecutionPhase {
    AwaitingCoordinator,
    AwaitingHelper,
    AwaitingStepCompletion,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowParticipant {
    pub step_id: String,
    pub helper_session_id: String,
}

/// One in-flight helper request in the current parallel review group. The
/// request identifiers are routing state only; reviewer text remains in the
/// independent Agent conversations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowReviewRequest {
    pub step_id: String,
    pub request_id: String,
    pub reply_delivered: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowStepResultOutcome {
    Completed,
    Approved,
    ChangesRequested,
    Skipped,
}

/// The latest bounded report for one configured step in the current workflow
/// execution. Repeated review cycles replace the same step's report; this is
/// current progress, not an execution or transcript history.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepResult {
    pub step_id: String,
    pub review_cycle: u8,
    pub outcome: WorkflowStepResultOutcome,
    pub summary: String,
    pub completed_at_epoch_ms: u64,
}

impl WorkflowStepResult {
    fn is_valid_for(&self, step: &WorkflowStep, execution: &WorkflowExecution) -> bool {
        let outcome_is_valid = match step.kind {
            WorkflowStepKind::Discuss | WorkflowStepKind::Implement | WorkflowStepKind::Fix => {
                self.outcome == WorkflowStepResultOutcome::Completed
                    || (step.kind == WorkflowStepKind::Fix
                        && self.outcome == WorkflowStepResultOutcome::Skipped)
            }
            WorkflowStepKind::Review => matches!(
                self.outcome,
                WorkflowStepResultOutcome::Approved | WorkflowStepResultOutcome::ChangesRequested
            ),
        };
        self.step_id == step.id
            && bounded_text(&self.summary, WORKFLOW_STEP_RESULT_SUMMARY_MAX_BYTES)
            && (1..=execution.review_cycle).contains(&self.review_cycle)
            && (matches!(step.kind, WorkflowStepKind::Review | WorkflowStepKind::Fix)
                || self.review_cycle == 1)
            && outcome_is_valid
            && self.completed_at_epoch_ms >= execution.started_at_epoch_ms
            && self.completed_at_epoch_ms <= execution.updated_at_epoch_ms
    }
}

/// The single current execution snapshot for one Task. It contains routing
/// state only: provider replies and review text remain in Agent conversations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecution {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub configuration: WorkflowConfiguration,
    pub goal: String,
    pub coordinator_session_id: String,
    pub current_step_index: u8,
    pub review_cycle: u8,
    pub phase: WorkflowExecutionPhase,
    /// The next coordinator prompt is durable work until provider delivery is
    /// confirmed. A daemon restart may safely resubmit only this exact prompt.
    #[serde(default)]
    pub coordinator_prompt_pending: bool,
    pub current_request_id: Option<String>,
    pub participants: Vec<WorkflowParticipant>,
    /// Requests launched for the contiguous REVIEW group at
    /// `current_step_index`. Empty outside an active review group and cleared
    /// before another review cycle starts.
    #[serde(default)]
    pub review_requests: Vec<WorkflowReviewRequest>,
    #[serde(default)]
    pub step_results: Vec<WorkflowStepResult>,
    pub review_changes_requested: bool,
    pub started_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

impl WorkflowExecution {
    pub fn current_step(&self) -> Option<&WorkflowStep> {
        self.configuration
            .steps
            .get(usize::from(self.current_step_index))
    }

    pub fn is_valid(&self) -> bool {
        let step_index = usize::from(self.current_step_index);
        let step_count = self.configuration.steps.len();
        let active_review_step_ids = self
            .configuration
            .steps
            .get(step_index..)
            .unwrap_or_default()
            .iter()
            .take_while(|step| step.kind == WorkflowStepKind::Review)
            .map(|step| step.id.as_str())
            .collect::<Vec<_>>();
        let review_requests_are_valid = self.review_requests.len() <= active_review_step_ids.len()
            && self
                .review_requests
                .iter()
                .enumerate()
                .all(|(index, request)| {
                    active_review_step_ids.contains(&request.step_id.as_str())
                        && !request.request_id.trim().is_empty()
                        && request.request_id.len() <= 128
                        && !self.review_requests[index + 1..].iter().any(|candidate| {
                            candidate.step_id == request.step_id
                                || candidate.request_id == request.request_id
                        })
                });
        let active_review_request_state_is_valid = if self
            .current_step()
            .is_some_and(|step| step.kind == WorkflowStepKind::Review)
        {
            match self.phase {
                WorkflowExecutionPhase::AwaitingCoordinator => {
                    self.current_request_id.is_none()
                        && self.review_requests.len() < active_review_step_ids.len()
                }
                WorkflowExecutionPhase::AwaitingHelper => {
                    self.current_request_id.is_none()
                        && self.review_requests.len() == active_review_step_ids.len()
                        && self
                            .review_requests
                            .iter()
                            .any(|request| !request.reply_delivered)
                }
                WorkflowExecutionPhase::AwaitingStepCompletion => {
                    self.current_request_id.is_none()
                        && self.review_requests.len() == active_review_step_ids.len()
                        && self
                            .review_requests
                            .iter()
                            .all(|request| request.reply_delivered)
                }
                WorkflowExecutionPhase::Completed => false,
            }
        } else {
            self.review_requests.is_empty()
        };
        let active_step_is_valid = self.current_step().is_some_and(|step| match self.phase {
            WorkflowExecutionPhase::AwaitingCoordinator
            | WorkflowExecutionPhase::AwaitingStepCompletion => true,
            WorkflowExecutionPhase::AwaitingHelper => matches!(
                step.kind,
                WorkflowStepKind::Discuss | WorkflowStepKind::Review
            ),
            WorkflowExecutionPhase::Completed => false,
        });
        bounded_slug(&self.id, WORKFLOW_EXECUTION_ID_MAX_BYTES)
            && !self.project_id.trim().is_empty()
            && !self.task_id.trim().is_empty()
            && self.configuration.is_valid()
            && self.configuration.project_id == self.project_id
            && bounded_text(&self.goal, WORKFLOW_GOAL_MAX_BYTES)
            && !self.coordinator_session_id.trim().is_empty()
            && (1..=self.configuration.max_review_cycles).contains(&self.review_cycle)
            && (!self.coordinator_prompt_pending
                || self.phase == WorkflowExecutionPhase::AwaitingCoordinator)
            && match self.phase {
                WorkflowExecutionPhase::Completed => {
                    step_index == step_count && self.current_request_id.is_none()
                }
                WorkflowExecutionPhase::AwaitingCoordinator => {
                    active_step_is_valid && self.current_request_id.is_none()
                }
                WorkflowExecutionPhase::AwaitingStepCompletion => {
                    active_step_is_valid
                        && self.current_request_id.is_none()
                        && self.current_step().is_some_and(|step| {
                            matches!(
                                step.kind,
                                WorkflowStepKind::Discuss | WorkflowStepKind::Review
                            )
                        })
                }
                WorkflowExecutionPhase::AwaitingHelper => {
                    active_step_is_valid
                        && (self
                            .current_step()
                            .is_some_and(|step| step.kind == WorkflowStepKind::Review)
                            || self
                                .current_request_id
                                .as_deref()
                                .is_some_and(|request_id| {
                                    !request_id.trim().is_empty() && request_id.len() <= 128
                                }))
                }
            }
            && review_requests_are_valid
            && active_review_request_state_is_valid
            && self.participants.len() <= self.configuration.steps.len()
            && self
                .participants
                .iter()
                .enumerate()
                .all(|(index, participant)| {
                    bounded_slug(&participant.step_id, WORKFLOW_STEP_ID_MAX_BYTES)
                        && !participant.helper_session_id.trim().is_empty()
                        && self.configuration.steps.iter().any(|step| {
                            step.id == participant.step_id
                                && matches!(
                                    step.kind,
                                    WorkflowStepKind::Discuss | WorkflowStepKind::Review
                                )
                        })
                        && !self.participants[index + 1..]
                            .iter()
                            .any(|candidate| candidate.step_id == participant.step_id)
                })
            && self.step_results.len() <= self.configuration.steps.len()
            && self.step_results.iter().enumerate().all(|(index, result)| {
                self.configuration
                    .steps
                    .iter()
                    .find(|step| step.id == result.step_id)
                    .is_some_and(|step| result.is_valid_for(step, self))
                    && !self.step_results[index + 1..]
                        .iter()
                        .any(|candidate| candidate.step_id == result.step_id)
            })
            && self.configuration.steps.iter().all(|step| {
                step.reuse_step_id.as_deref().is_none_or(|source_step_id| {
                    let participant = self
                        .participants
                        .iter()
                        .find(|participant| participant.step_id == step.id);
                    let source = self
                        .participants
                        .iter()
                        .find(|participant| participant.step_id == source_step_id);
                    participant.is_none()
                        || source.is_some_and(|source| {
                            participant.is_some_and(|participant| {
                                participant.helper_session_id == source.helper_session_id
                            })
                        })
                })
            })
            && self.started_at_epoch_ms > 0
            && self.updated_at_epoch_ms >= self.started_at_epoch_ms
    }
}

fn bounded_slug(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn bounded_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.contains('\0')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration() -> WorkflowConfiguration {
        WorkflowConfiguration {
            id: "discuss-build-review".into(),
            project_id: "project-1".into(),
            name: "Discuss, build, review".into(),
            coordinator_agent_id: "codex".into(),
            launch_selection: AgentLaunchSelection::default(),
            max_review_cycles: 2,
            steps: vec![
                WorkflowStep {
                    id: "discuss".into(),
                    kind: WorkflowStepKind::Discuss,
                    title: "Challenge the approach".into(),
                    instructions: "Debate the approach and surface tradeoffs.".into(),
                    agent_id: Some("claude".into()),
                    reuse_step_id: None,
                    launch_selection: Some(AgentLaunchSelection::new(
                        "default",
                        "bypassPermissions",
                        "default",
                    )),
                },
                WorkflowStep {
                    id: "implement".into(),
                    kind: WorkflowStepKind::Implement,
                    title: "Implement".into(),
                    instructions: "Implement the agreed solution and verify it.".into(),
                    agent_id: None,
                    reuse_step_id: None,
                    launch_selection: None,
                },
                WorkflowStep {
                    id: "review".into(),
                    kind: WorkflowStepKind::Review,
                    title: "Independent review".into(),
                    instructions: "Review the diff and report concrete findings.".into(),
                    agent_id: Some("claude".into()),
                    reuse_step_id: Some("discuss".into()),
                    launch_selection: None,
                },
                WorkflowStep {
                    id: "fix".into(),
                    kind: WorkflowStepKind::Fix,
                    title: "Fix findings".into(),
                    instructions: "Apply the accepted review findings and verify again.".into(),
                    agent_id: None,
                    reuse_step_id: None,
                    launch_selection: None,
                },
            ],
            generation: 1,
            updated_at_epoch_ms: 1,
        }
    }

    #[test]
    fn workflow_accepts_discuss_implement_review() {
        assert!(configuration().is_valid());
    }

    #[test]
    fn workflow_requires_one_ordered_implementation_step() {
        let mut value = configuration();
        value.steps.swap(0, 1);
        assert!(!value.is_valid());

        let mut value = configuration();
        value.steps.push(value.steps[1].clone());
        assert!(!value.is_valid());
    }

    #[test]
    fn workflow_requires_helpers_only_for_collaboration_steps() {
        let mut value = configuration();
        value.steps[0].agent_id = None;
        assert!(!value.is_valid());

        let mut value = configuration();
        value.steps[1].agent_id = Some("claude".into());
        assert!(!value.is_valid());

        let mut value = configuration();
        value.steps[3].agent_id = Some("codex".into());
        assert!(!value.is_valid());
    }

    #[test]
    fn workflow_reuse_targets_an_earlier_matching_helper() {
        let mut value = configuration();
        value.steps[2].reuse_step_id = Some("missing".into());
        assert!(!value.is_valid());

        let mut value = configuration();
        value.steps[2].agent_id = Some("codex".into());
        assert!(!value.is_valid());

        let mut value = configuration();
        value.steps[0].reuse_step_id = Some("review".into());
        assert!(!value.is_valid());
    }

    #[test]
    fn workflow_fresh_helpers_select_launch_options_and_reuse_inherits_them() {
        let mut value = configuration();
        value.steps[0].launch_selection = None;
        assert!(!value.is_valid());

        let mut value = configuration();
        value.steps[2].launch_selection = Some(AgentLaunchSelection::default());
        assert!(!value.is_valid());

        let mut value = configuration();
        value.steps[1].launch_selection = Some(AgentLaunchSelection::default());
        assert!(!value.is_valid());
    }

    #[test]
    fn workflow_fix_is_optional_but_final_and_follows_review() {
        let mut legacy = configuration();
        legacy.steps.pop();
        assert!(legacy.is_valid());

        let mut value = configuration();
        value.steps.swap(2, 3);
        assert!(!value.is_valid());
    }

    #[test]
    fn workflow_rejects_duplicate_steps_and_unbounded_values() {
        let mut value = configuration();
        value.steps[2].id = value.steps[0].id.clone();
        assert!(!value.is_valid());

        let mut value = configuration();
        value.name = "x".repeat(WORKFLOW_NAME_MAX_BYTES + 1);
        assert!(!value.is_valid());

        let mut value = configuration();
        value.max_review_cycles = 0;
        assert!(!value.is_valid());
    }

    #[test]
    fn current_execution_is_bounded_and_reuse_keeps_one_helper_identity() {
        let configuration = configuration();
        let mut execution = WorkflowExecution {
            id: "execution-1".into(),
            project_id: configuration.project_id.clone(),
            task_id: "task-1".into(),
            configuration,
            goal: "Implement the workflow engine".into(),
            coordinator_session_id: "coordinator-1".into(),
            current_step_index: 2,
            review_cycle: 1,
            phase: WorkflowExecutionPhase::AwaitingCoordinator,
            coordinator_prompt_pending: false,
            current_request_id: None,
            participants: vec![
                WorkflowParticipant {
                    step_id: "discuss".into(),
                    helper_session_id: "helper-1".into(),
                },
                WorkflowParticipant {
                    step_id: "review".into(),
                    helper_session_id: "helper-1".into(),
                },
            ],
            review_requests: vec![],
            step_results: vec![WorkflowStepResult {
                step_id: "discuss".into(),
                review_cycle: 1,
                outcome: WorkflowStepResultOutcome::Completed,
                summary: "Chose the bounded Core-owned approach.".into(),
                completed_at_epoch_ms: 2,
            }],
            review_changes_requested: false,
            started_at_epoch_ms: 1,
            updated_at_epoch_ms: 2,
        };
        assert!(execution.is_valid());

        execution.participants[1].helper_session_id = "replacement".into();
        assert!(!execution.is_valid());
    }

    #[test]
    fn current_execution_keeps_only_one_bounded_result_per_step() {
        let mut execution = WorkflowExecution {
            id: "execution-1".into(),
            project_id: "project-1".into(),
            task_id: "task-1".into(),
            configuration: configuration(),
            goal: "Implement the workflow engine".into(),
            coordinator_session_id: "coordinator-1".into(),
            current_step_index: 2,
            review_cycle: 2,
            phase: WorkflowExecutionPhase::AwaitingCoordinator,
            coordinator_prompt_pending: false,
            current_request_id: None,
            participants: vec![],
            review_requests: vec![],
            step_results: vec![WorkflowStepResult {
                step_id: "review".into(),
                review_cycle: 1,
                outcome: WorkflowStepResultOutcome::ChangesRequested,
                summary: "One actionable finding remains.".into(),
                completed_at_epoch_ms: 2,
            }],
            review_changes_requested: false,
            started_at_epoch_ms: 1,
            updated_at_epoch_ms: 2,
        };
        assert!(execution.is_valid());

        execution
            .step_results
            .push(execution.step_results[0].clone());
        assert!(!execution.is_valid());
    }

    #[test]
    fn current_execution_models_a_wait_all_review_barrier() {
        let mut execution = WorkflowExecution {
            id: "execution-1".into(),
            project_id: "project-1".into(),
            task_id: "task-1".into(),
            configuration: configuration(),
            goal: "Implement the workflow engine".into(),
            coordinator_session_id: "coordinator-1".into(),
            current_step_index: 2,
            review_cycle: 1,
            phase: WorkflowExecutionPhase::AwaitingHelper,
            coordinator_prompt_pending: false,
            current_request_id: None,
            participants: vec![],
            review_requests: vec![WorkflowReviewRequest {
                step_id: "review".into(),
                request_id: "request-1".into(),
                reply_delivered: false,
            }],
            step_results: vec![],
            review_changes_requested: false,
            started_at_epoch_ms: 1,
            updated_at_epoch_ms: 1,
        };
        assert!(execution.is_valid());

        execution.review_requests[0].reply_delivered = true;
        assert!(!execution.is_valid());
        execution.phase = WorkflowExecutionPhase::AwaitingStepCompletion;
        assert!(execution.is_valid());
    }
}
