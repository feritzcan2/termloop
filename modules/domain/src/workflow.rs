//! Pure Project-scoped workflow configuration values.
//!
//! A workflow is a small, durable recipe for coordinating ordinary Agent
//! Sessions. Executions remain normal Sessions; this module intentionally
//! does not introduce workflow runs, attempts, or execution history.

use crate::{AgentLaunchSelection, agent_id_is_well_formed};

pub const WORKFLOW_CONFIGURATIONS_PER_PROJECT_MAX: usize = 16;
pub const WORKFLOW_STEPS_MAX: usize = 8;
pub const WORKFLOW_ID_MAX_BYTES: usize = 64;
pub const WORKFLOW_NAME_MAX_BYTES: usize = 80;
pub const WORKFLOW_STEP_ID_MAX_BYTES: usize = 64;
pub const WORKFLOW_STEP_TITLE_MAX_BYTES: usize = 120;
pub const WORKFLOW_STEP_INSTRUCTIONS_MAX_BYTES: usize = 4 * 1024;
pub const WORKFLOW_REVIEW_CYCLES_MAX: u8 = 3;

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
}

impl WorkflowStep {
    pub fn is_valid(&self) -> bool {
        bounded_slug(&self.id, WORKFLOW_STEP_ID_MAX_BYTES)
            && bounded_text(&self.title, WORKFLOW_STEP_TITLE_MAX_BYTES)
            && bounded_text(&self.instructions, WORKFLOW_STEP_INSTRUCTIONS_MAX_BYTES)
            && match self.kind {
                WorkflowStepKind::Discuss | WorkflowStepKind::Review => self
                    .agent_id
                    .as_deref()
                    .is_some_and(agent_id_is_well_formed),
                WorkflowStepKind::Implement | WorkflowStepKind::Fix => self.agent_id.is_none(),
            }
            && (self.kind == WorkflowStepKind::Review || self.reuse_step_id.is_none())
            && self
                .reuse_step_id
                .as_deref()
                .is_none_or(|id| bounded_slug(id, WORKFLOW_STEP_ID_MAX_BYTES))
    }
}

/// One named, linear coordinator workflow available to all Tasks in a Project.
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
                },
                WorkflowStep {
                    id: "implement".into(),
                    kind: WorkflowStepKind::Implement,
                    title: "Implement".into(),
                    instructions: "Implement the agreed solution and verify it.".into(),
                    agent_id: None,
                    reuse_step_id: None,
                },
                WorkflowStep {
                    id: "review".into(),
                    kind: WorkflowStepKind::Review,
                    title: "Independent review".into(),
                    instructions: "Review the diff and report concrete findings.".into(),
                    agent_id: Some("claude".into()),
                    reuse_step_id: Some("discuss".into()),
                },
                WorkflowStep {
                    id: "fix".into(),
                    kind: WorkflowStepKind::Fix,
                    title: "Fix findings".into(),
                    instructions: "Apply the accepted review findings and verify again.".into(),
                    agent_id: None,
                    reuse_step_id: None,
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
}
