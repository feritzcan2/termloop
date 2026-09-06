//! Core-owned progression for one current Task workflow execution.

use serde_json::{Value, json};
use termloop_domain::{
    IssueLinkProvider, WorkflowExecution, WorkflowExecutionPhase, WorkflowParticipant,
    WorkflowStepKind,
};

use crate::{CoreError, CoreRuntime, store_error};

use super::{AskToInput, AskToPlanOutcome};

pub struct WorkflowDelegatePlan {
    outcome: AskToPlanOutcome,
    commit: WorkflowDelegateCommit,
}

impl WorkflowDelegatePlan {
    pub fn into_parts(self) -> (AskToPlanOutcome, WorkflowDelegateCommit) {
        (self.outcome, self.commit)
    }
}

pub struct WorkflowDelegateCommit {
    execution_id: String,
    step_id: String,
    request_id: String,
    conversation_id: String,
    coordinator_session_id: String,
}

impl CoreRuntime {
    pub fn plan_workflow_delegate(
        &mut self,
        token: &str,
        message: String,
    ) -> Result<WorkflowDelegatePlan, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        let coordinator_session_id = principal.session_id().to_owned();
        let mut execution = self
            .store
            .workflow_executions()
            .iter()
            .find(|execution| execution.coordinator_session_id == coordinator_session_id)
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;

        // A daemon may stop after starting an Ask-To delivery but before the
        // exact helper request becomes recoverable. A new explicit delegate
        // call can retry that step; a still-current request remains fenced.
        if execution.phase == WorkflowExecutionPhase::AwaitingHelper {
            if execution
                .current_request_id
                .as_deref()
                .is_some_and(|request_id| self.ask_to_requests.contains_key(request_id))
            {
                return Err(CoreError::WorkflowExecutionState);
            }
            let expected = execution.clone();
            execution.phase = WorkflowExecutionPhase::AwaitingCoordinator;
            execution.current_request_id = None;
            execution.updated_at_epoch_ms = termloop_platform::current_epoch_ms();
            self.store
                .replace_workflow_execution(&self.write_authority, &expected, execution.clone())
                .map_err(store_error)?;
        }
        let step = execution
            .current_step()
            .filter(|step| {
                matches!(
                    step.kind,
                    WorkflowStepKind::Discuss | WorkflowStepKind::Review
                )
            })
            .filter(|_| {
                execution.phase == WorkflowExecutionPhase::AwaitingCoordinator
                    && !execution.coordinator_prompt_pending
            })
            .cloned()
            .ok_or(CoreError::WorkflowExecutionState)?;
        let target = step
            .agent_id
            .clone()
            .ok_or(CoreError::WorkflowExecutionState)?;

        let participant_step_id = execution
            .participants
            .iter()
            .find(|participant| participant.step_id == step.id)
            .map(|participant| participant.step_id.as_str())
            .or(step.reuse_step_id.as_deref());
        let conversation_id = participant_step_id
            .and_then(|step_id| {
                execution
                    .participants
                    .iter()
                    .find(|participant| participant.step_id == step_id)
            })
            .and_then(|participant| {
                self.store
                    .sessions()
                    .iter()
                    .find(|session| session.id == participant.helper_session_id)
            })
            .and_then(|session| session.ask_to_continuation.as_ref())
            .map(|continuation| continuation.conversation_id.clone());
        if participant_step_id.is_some() && conversation_id.is_none() {
            return Err(CoreError::ConversationUnavailable);
        }

        let idempotency_key = format!(
            "workflow:{}:{}:{}",
            execution.id, execution.review_cycle, step.id
        );
        let outcome = self.plan_ask_to(
            token,
            AskToInput {
                target,
                message,
                idempotency_key: Some(idempotency_key),
                conversation_id,
            },
        )?;
        let request_id = match &outcome {
            AskToPlanOutcome::Existing(value) | AskToPlanOutcome::FollowUp(value) => value
                .get("requestId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            AskToPlanOutcome::Launch(plan) => plan.ask_to_request_id().map(str::to_owned),
        }
        .ok_or(CoreError::AskToRequestUnavailable)?;
        let request = self
            .ask_to_requests
            .get(&request_id)
            .filter(|request| request.source_session_id == coordinator_session_id)
            .ok_or(CoreError::AskToRequestUnavailable)?;
        Ok(WorkflowDelegatePlan {
            outcome,
            commit: WorkflowDelegateCommit {
                execution_id: execution.id,
                step_id: step.id,
                request_id,
                conversation_id: request.conversation_id.clone(),
                coordinator_session_id,
            },
        })
    }

    pub fn complete_workflow_delegate(
        &mut self,
        token: &str,
        commit: WorkflowDelegateCommit,
    ) -> Result<Value, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        if principal.session_id() != commit.coordinator_session_id {
            return Err(CoreError::CapabilityDenied);
        }
        let expected = self
            .store
            .workflow_executions()
            .iter()
            .find(|execution| execution.id == commit.execution_id)
            .cloned()
            .ok_or(CoreError::WorkflowExecutionState)?;
        let step = expected
            .current_step()
            .filter(|step| step.id == commit.step_id)
            .filter(|step| {
                matches!(
                    step.kind,
                    WorkflowStepKind::Discuss | WorkflowStepKind::Review
                )
            })
            .ok_or(CoreError::WorkflowExecutionState)?;
        if expected.coordinator_session_id != commit.coordinator_session_id
            || expected.phase != WorkflowExecutionPhase::AwaitingCoordinator
            || expected.coordinator_prompt_pending
        {
            return Err(CoreError::WorkflowExecutionState);
        }
        let request = self
            .ask_to_requests
            .get(&commit.request_id)
            .filter(|request| {
                request.source_session_id == commit.coordinator_session_id
                    && request.conversation_id == commit.conversation_id
            })
            .ok_or(CoreError::AskToRequestUnavailable)?;
        let helper_session_id = request.helper_session_id.clone();
        if let Some(reuse_step_id) = step.reuse_step_id.as_deref() {
            let reused = expected
                .participants
                .iter()
                .find(|participant| participant.step_id == reuse_step_id)
                .ok_or(CoreError::WorkflowExecutionState)?;
            if reused.helper_session_id != helper_session_id {
                return Err(CoreError::ConversationUnavailable);
            }
        }

        let mut replacement = expected.clone();
        if let Some(participant) = replacement
            .participants
            .iter_mut()
            .find(|participant| participant.step_id == step.id)
        {
            if participant.helper_session_id != helper_session_id {
                return Err(CoreError::ConversationUnavailable);
            }
        } else {
            replacement.participants.push(WorkflowParticipant {
                step_id: step.id.clone(),
                helper_session_id,
            });
        }
        replacement.phase = WorkflowExecutionPhase::AwaitingHelper;
        replacement.current_request_id = Some(commit.request_id);
        replacement.updated_at_epoch_ms = termloop_platform::current_epoch_ms();
        self.store
            .replace_workflow_execution(&self.write_authority, &expected, replacement.clone())
            .map_err(store_error)?;
        Ok(workflow_action_json(&replacement))
    }

    pub fn complete_workflow_step(
        &mut self,
        token: &str,
        outcome: &str,
    ) -> Result<Value, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        let expected = self
            .store
            .workflow_executions()
            .iter()
            .find(|execution| execution.coordinator_session_id == principal.session_id())
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        let step = expected
            .current_step()
            .cloned()
            .ok_or(CoreError::WorkflowExecutionState)?;
        let phase_is_valid = match step.kind {
            WorkflowStepKind::Discuss | WorkflowStepKind::Review => {
                expected.phase == WorkflowExecutionPhase::AwaitingStepCompletion
            }
            WorkflowStepKind::Implement | WorkflowStepKind::Fix => {
                expected.phase == WorkflowExecutionPhase::AwaitingCoordinator
            }
        };
        let outcome_is_valid = match step.kind {
            WorkflowStepKind::Review => matches!(outcome, "approved" | "changesRequested"),
            WorkflowStepKind::Discuss | WorkflowStepKind::Implement | WorkflowStepKind::Fix => {
                outcome == "completed"
            }
        };
        if expected.coordinator_prompt_pending || !phase_is_valid || !outcome_is_valid {
            return Err(CoreError::WorkflowExecutionState);
        }

        let mut replacement = expected.clone();
        if step.kind == WorkflowStepKind::Review && outcome == "changesRequested" {
            replacement.review_changes_requested = true;
        }
        advance_execution(&mut replacement, step.kind);
        if replacement.phase != WorkflowExecutionPhase::Completed {
            replacement.coordinator_prompt_pending = true;
        }
        replacement.updated_at_epoch_ms = termloop_platform::current_epoch_ms();
        let next_prompt = if replacement.phase == WorkflowExecutionPhase::Completed {
            None
        } else {
            Some(self.compose_workflow_step_prompt(&replacement)?)
        };
        self.store
            .replace_workflow_execution(&self.write_authority, &expected, replacement.clone())
            .map_err(store_error)?;
        if let Some(prompt) = next_prompt {
            self.submit_generated_terminal_input(
                &replacement.coordinator_session_id,
                prompt.terminal_submission(),
            )?;
        }
        Ok(workflow_action_json(&replacement))
    }

    /// Resubmits only a step whose durable transition committed before its
    /// generated coordinator prompt was confirmed. This is called after an
    /// exact coordinator Session resume, never for an ordinary active step.
    pub fn redeliver_pending_workflow_prompt(
        &mut self,
        coordinator_session_id: &str,
    ) -> Result<bool, CoreError> {
        let Some(execution) = self
            .store
            .workflow_executions()
            .iter()
            .find(|execution| {
                execution.coordinator_session_id == coordinator_session_id
                    && execution.phase == WorkflowExecutionPhase::AwaitingCoordinator
                    && execution.coordinator_prompt_pending
            })
            .cloned()
        else {
            return Ok(false);
        };
        let runtime_epoch = self
            .store
            .sessions()
            .iter()
            .find(|session| {
                session.id == coordinator_session_id && session.lifecycle_state == "running"
            })
            .map(|session| session.runtime_epoch)
            .ok_or(CoreError::NotFound)?;
        let current_is_workflow_prompt = self
            .generated_input_deliveries
            .provenance(coordinator_session_id, runtime_epoch)
            .is_some_and(|provenance| provenance.template_ref == "builtin.agent.task-workflow");
        let queued_workflow_prompt = self
            .pending_generated_input_queues
            .get(coordinator_session_id)
            .filter(|queue| queue.runtime_epoch == runtime_epoch)
            .is_some_and(|queue| {
                queue.submissions.iter().any(|submission| {
                    submission.provenance().template_ref == "builtin.agent.task-workflow"
                })
            });
        if current_is_workflow_prompt || queued_workflow_prompt {
            return Ok(false);
        }
        let prompt = self.compose_workflow_step_prompt(&execution)?;
        self.submit_generated_terminal_input(coordinator_session_id, prompt.terminal_submission())?;
        Ok(true)
    }

    pub(crate) fn complete_workflow_helper_reply_delivery(
        &mut self,
        request_id: &str,
    ) -> Result<bool, CoreError> {
        let Some(expected) = self
            .store
            .workflow_executions()
            .iter()
            .find(|execution| {
                execution.phase == WorkflowExecutionPhase::AwaitingHelper
                    && execution.current_request_id.as_deref() == Some(request_id)
            })
            .cloned()
        else {
            return Ok(false);
        };
        let mut replacement = expected.clone();
        replacement.phase = WorkflowExecutionPhase::AwaitingStepCompletion;
        replacement.current_request_id = None;
        replacement.updated_at_epoch_ms = termloop_platform::current_epoch_ms();
        self.store
            .replace_workflow_execution(&self.write_authority, &expected, replacement)
            .map_err(store_error)?;
        Ok(true)
    }

    pub(crate) fn complete_workflow_coordinator_prompt_delivery(
        &mut self,
        coordinator_session_id: &str,
        runtime_epoch: u64,
    ) -> Result<bool, CoreError> {
        let Some(expected) = self
            .store
            .workflow_executions()
            .iter()
            .find(|execution| {
                execution.coordinator_session_id == coordinator_session_id
                    && execution.phase == WorkflowExecutionPhase::AwaitingCoordinator
                    && execution.coordinator_prompt_pending
            })
            .cloned()
        else {
            return Ok(false);
        };
        if self
            .generated_input_deliveries
            .provenance(coordinator_session_id, runtime_epoch)
            .is_none_or(|provenance| provenance.template_ref != "builtin.agent.task-workflow")
        {
            return Ok(false);
        }
        let mut replacement = expected.clone();
        replacement.coordinator_prompt_pending = false;
        replacement.updated_at_epoch_ms = termloop_platform::current_epoch_ms();
        self.store
            .replace_workflow_execution(&self.write_authority, &expected, replacement)
            .map_err(store_error)?;
        Ok(true)
    }

    fn compose_workflow_step_prompt(
        &self,
        execution: &WorkflowExecution,
    ) -> Result<termloop_invocation::AskToTerminalPrompt, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == execution.task_id && task.project_id == execution.project_id)
            .ok_or(CoreError::NotFound)?;
        let jira_url = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task.id && link.provider == IssueLinkProvider::Jira)
            .and_then(|link| link.url.as_deref());
        termloop_invocation::task_workflow_step_prompt(
            &execution.id,
            &task.id,
            &task.title,
            task.brief.as_deref(),
            jira_url,
            &execution.goal,
            &execution.configuration,
            usize::from(execution.current_step_index),
            execution.review_cycle,
        )
        .map_err(|_| CoreError::WorkflowExecutionState)
    }
}

fn advance_execution(execution: &mut WorkflowExecution, completed_kind: WorkflowStepKind) {
    let step_count = execution.configuration.steps.len();
    let next_index = usize::from(execution.current_step_index) + 1;
    if completed_kind == WorkflowStepKind::Fix {
        if execution.review_changes_requested
            && execution.review_cycle < execution.configuration.max_review_cycles
            && let Some(review_index) = execution
                .configuration
                .steps
                .iter()
                .position(|step| step.kind == WorkflowStepKind::Review)
        {
            execution.current_step_index = review_index as u8;
            execution.review_cycle += 1;
            execution.review_changes_requested = false;
            execution.phase = WorkflowExecutionPhase::AwaitingCoordinator;
            return;
        }
        complete_execution(execution, step_count);
        return;
    }
    if completed_kind == WorkflowStepKind::Review {
        match execution.configuration.steps.get(next_index) {
            Some(next) if next.kind == WorkflowStepKind::Review => {}
            Some(next) if next.kind == WorkflowStepKind::Fix => {
                if !execution.review_changes_requested {
                    complete_execution(execution, step_count);
                    return;
                }
            }
            None => {
                complete_execution(execution, step_count);
                return;
            }
            Some(_) => {}
        }
    }
    if next_index >= step_count {
        complete_execution(execution, step_count);
    } else {
        execution.current_step_index = next_index as u8;
        execution.phase = WorkflowExecutionPhase::AwaitingCoordinator;
        execution.current_request_id = None;
    }
}

fn complete_execution(execution: &mut WorkflowExecution, step_count: usize) {
    execution.current_step_index = step_count as u8;
    execution.phase = WorkflowExecutionPhase::Completed;
    execution.coordinator_prompt_pending = false;
    execution.current_request_id = None;
}

fn workflow_action_json(execution: &WorkflowExecution) -> Value {
    json!({
        "executionId": execution.id,
        "status": if execution.phase == WorkflowExecutionPhase::Completed {
            "completed"
        } else {
            "running"
        },
        "currentStepIndex": execution.current_step_index,
        "reviewCycle": execution.review_cycle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{AgentLaunchSelection, WorkflowConfiguration, WorkflowStep};

    fn execution() -> WorkflowExecution {
        WorkflowExecution {
            id: "workflow-execution-1".into(),
            project_id: "project-1".into(),
            task_id: "task-1".into(),
            configuration: WorkflowConfiguration {
                id: "workflow-1".into(),
                project_id: "project-1".into(),
                name: "Discuss, implement, review".into(),
                coordinator_agent_id: "codex".into(),
                launch_selection: AgentLaunchSelection::default(),
                max_review_cycles: 2,
                steps: vec![
                    WorkflowStep {
                        id: "discuss".into(),
                        kind: WorkflowStepKind::Discuss,
                        title: "Discuss".into(),
                        instructions: "Challenge the approach.".into(),
                        agent_id: Some("claude".into()),
                        reuse_step_id: None,
                    },
                    WorkflowStep {
                        id: "implement".into(),
                        kind: WorkflowStepKind::Implement,
                        title: "Implement".into(),
                        instructions: "Implement and verify.".into(),
                        agent_id: None,
                        reuse_step_id: None,
                    },
                    WorkflowStep {
                        id: "review-claude".into(),
                        kind: WorkflowStepKind::Review,
                        title: "Context review".into(),
                        instructions: "Review with prior context.".into(),
                        agent_id: Some("claude".into()),
                        reuse_step_id: Some("discuss".into()),
                    },
                    WorkflowStep {
                        id: "review-codex".into(),
                        kind: WorkflowStepKind::Review,
                        title: "Independent review".into(),
                        instructions: "Review independently.".into(),
                        agent_id: Some("codex".into()),
                        reuse_step_id: None,
                    },
                    WorkflowStep {
                        id: "fix".into(),
                        kind: WorkflowStepKind::Fix,
                        title: "Fix".into(),
                        instructions: "Apply the combined findings.".into(),
                        agent_id: None,
                        reuse_step_id: None,
                    },
                ],
                generation: 1,
                updated_at_epoch_ms: 1,
            },
            goal: "Build the feature.".into(),
            coordinator_session_id: "coordinator-1".into(),
            current_step_index: 2,
            review_cycle: 1,
            phase: WorkflowExecutionPhase::AwaitingStepCompletion,
            coordinator_prompt_pending: false,
            current_request_id: None,
            participants: vec![],
            review_changes_requested: false,
            started_at_epoch_ms: 1,
            updated_at_epoch_ms: 1,
        }
    }

    #[test]
    fn approved_review_group_skips_the_optional_fix_step() {
        let mut execution = execution();
        advance_execution(&mut execution, WorkflowStepKind::Review);
        assert_eq!(execution.current_step_index, 3);
        assert_eq!(execution.phase, WorkflowExecutionPhase::AwaitingCoordinator);

        execution.phase = WorkflowExecutionPhase::AwaitingStepCompletion;
        advance_execution(&mut execution, WorkflowStepKind::Review);
        assert_eq!(execution.current_step_index, 5);
        assert_eq!(execution.phase, WorkflowExecutionPhase::Completed);
    }

    #[test]
    fn combined_findings_run_fix_then_repeat_the_whole_review_group() {
        let mut execution = execution();
        execution.review_changes_requested = true;
        advance_execution(&mut execution, WorkflowStepKind::Review);
        execution.phase = WorkflowExecutionPhase::AwaitingStepCompletion;
        advance_execution(&mut execution, WorkflowStepKind::Review);
        assert_eq!(execution.current_step_index, 4);

        advance_execution(&mut execution, WorkflowStepKind::Fix);
        assert_eq!(execution.current_step_index, 2);
        assert_eq!(execution.review_cycle, 2);
        assert!(!execution.review_changes_requested);

        execution.phase = WorkflowExecutionPhase::AwaitingStepCompletion;
        advance_execution(&mut execution, WorkflowStepKind::Review);
        execution.phase = WorkflowExecutionPhase::AwaitingStepCompletion;
        execution.review_changes_requested = true;
        advance_execution(&mut execution, WorkflowStepKind::Review);
        advance_execution(&mut execution, WorkflowStepKind::Fix);
        assert_eq!(execution.current_step_index, 5);
        assert_eq!(execution.phase, WorkflowExecutionPhase::Completed);
    }
}
