use std::collections::HashMap;

use serde_json::{Value, json};
use termloop_agents::{AgentObservation, AgentState};

use crate::companion_integrations::playbook_runtime::StewardStepVerdict;
use crate::companion_integrations::tracker_runtime::{StewardRoutineClaim, TrackerCheckCapability};
use crate::session_launch::AgentMcpRole;
use crate::{CoreError, CoreRuntime};

pub(crate) const EVALUATOR_TEMPLATE: &str = "builtin.agent.playbook-evaluator";
const MAX_EVALUATIONS: usize = 64;
const MAX_ACTIVITY_ENTRIES: usize = 4096;

#[derive(Default)]
pub(crate) struct PlaybookEvaluationRuntime {
    pub(crate) evaluations: HashMap<String, PlaybookEvaluation>,
    pub(crate) fallbacks: HashMap<String, String>,
    activity: HashMap<String, TaskAgentActivity>,
}

#[derive(Clone)]
pub(crate) struct PlaybookEvaluation {
    pub(crate) capability: TrackerCheckCapability,
    pub(crate) task_id: String,
    pub(crate) source_session_id: String,
    pub(crate) session_id: String,
    pub(crate) runtime_epoch: u64,
    pub(crate) playbook_revision: u64,
    pub(crate) worktree_generation: u64,
    pub(crate) assignment: Value,
    read: bool,
}

#[derive(Default)]
struct TaskAgentActivity {
    task_id: String,
    worktree_generation: u64,
    runtime_epoch: u64,
    native_id: Option<String>,
    working_ms: u64,
    working_since: Option<u64>,
    last_contribution_at: u64,
    sequence: u64,
}

impl TaskAgentActivity {
    fn observe(&mut self, next: AgentObservation) {
        if next.sequence <= self.sequence {
            return;
        }
        let now = next.observed_at_epoch_ms.max(self.last_contribution_at);
        if let Some(since) = self.working_since {
            self.working_ms = self.working_ms.saturating_add(now.saturating_sub(since));
            self.last_contribution_at = now;
        }
        self.working_since = (next.state == AgentState::Working).then_some(now);
        if self.working_since.is_some() {
            self.last_contribution_at = now;
        }
        self.sequence = next.sequence;
    }

    fn score(&self, now: u64) -> (u64, u64) {
        (
            self.working_ms.saturating_add(
                self.working_since
                    .map_or(0, |since| now.saturating_sub(since)),
            ),
            self.last_contribution_at,
        )
    }
}

impl CoreRuntime {
    /// UI routing is derived from the exact live claim, never Session names or cwd.
    pub(crate) fn playbook_evaluation_projection(&self, routine_id: &str) -> Option<Value> {
        let capability = self.current_step_check(routine_id)?;
        let task_id = self.tracker_check_task_id(&capability).ok()??;
        let mut projection = json!({
            "routineId": routine_id, "taskId": task_id, "mode": "starting",
            "sessionId": null, "sourceSessionId": null, "reason": null,
        });
        if let Some(evaluation) = self
            .playbook_evaluation
            .evaluations
            .get(&capability.check_id)
        {
            self.validate_playbook_evaluation(evaluation, termloop_platform::current_epoch_ms())
                .ok()?;
            projection["sourceSessionId"] = json!(evaluation.source_session_id);
            if self.store.sessions().iter().any(|session| {
                session.id == evaluation.session_id
                    && session.runtime_epoch == evaluation.runtime_epoch
                    && session.lifecycle_state == "running"
            }) && !self.pending_agent_forks.contains(&evaluation.session_id)
            {
                projection["mode"] = json!("taskAgentFork");
                projection["sessionId"] = json!(evaluation.session_id);
            }
        } else if let Some(reason) = self.playbook_evaluation.fallbacks.get(&capability.check_id) {
            projection["mode"] = json!("stewardFallback");
            projection["reason"] = json!(reason);
            projection["sessionId"] = json!(capability.steward_session_id);
        }
        Some(projection)
    }

    pub fn record_playbook_evaluation_fallback(&mut self, claim: &StewardRoutineClaim) {
        let Some(capability) = claim.capability.as_ref() else {
            return;
        };
        if claim.result["evaluation"]["mode"] != "stewardFallback"
            || !self.tracker_check_is_current(capability)
        {
            return;
        }
        let Some(reason) = claim.result["evaluation"]["reason"]
            .as_str()
            .filter(|reason| {
                matches!(
                    *reason,
                    "noUnambiguousTaskAgent"
                        | "forkUnsupported"
                        | "forkUnavailable"
                        | "evaluationCapacity"
                )
            })
        else {
            return;
        };
        self.playbook_evaluation
            .fallbacks
            .insert(capability.check_id.clone(), reason.to_owned());
    }

    /// Only authenticated structured observations contribute. No PTY text,
    /// session age, token estimates, or invented pre-restart activity.
    pub(crate) fn observe_task_agent_work(
        &mut self,
        session_id: &str,
        previous: Option<AgentObservation>,
        next: AgentObservation,
    ) {
        let Some(session) = self.store.sessions().iter().find(|s| s.id == session_id) else {
            return;
        };
        if session.ask_to_source_session_id.is_some()
            || session.improver_target.is_some()
            || session.process.template_ref.as_deref() == Some(EVALUATOR_TEMPLATE)
            || self
                .store
                .steward_configurations()
                .iter()
                .any(|s| s.executor_session_id.as_deref() == Some(session_id))
        {
            return;
        }
        // Exact launch identity only: task association is not inferred from text.
        let mut tasks = self.store.tasks().iter().filter(|task| {
            task.project_id == session.project_id
                && task.archived_at_epoch_ms.is_none()
                && task
                    .worktree
                    .as_ref()
                    .is_some_and(|w| w.path == session.process.cwd)
        });
        let Some(task) = tasks.next() else {
            return;
        };
        if tasks.next().is_some() {
            return;
        }
        let native_id = session
            .resume_ref
            .as_ref()
            .map(|r| r.native_session_id.clone());
        if !self.playbook_evaluation.activity.contains_key(session_id)
            && self.playbook_evaluation.activity.len() >= MAX_ACTIVITY_ENTRIES
        {
            return;
        }
        let activity = self
            .playbook_evaluation
            .activity
            .entry(session_id.to_owned())
            .or_default();
        if activity.task_id != task.id
            || activity.worktree_generation != task.worktree_generation
            || activity.runtime_epoch != session.runtime_epoch
            || activity.native_id != native_id
        {
            *activity = TaskAgentActivity {
                task_id: task.id.clone(),
                worktree_generation: task.worktree_generation,
                runtime_epoch: session.runtime_epoch,
                native_id,
                ..Default::default()
            };
        }
        if previous.is_none() {
            // A new process has no observed interval across its downtime.
            activity.working_since = None;
            activity.sequence = 0;
        }
        activity.observe(next);
    }

    pub(crate) fn select_playbook_source(
        &self,
        project_id: &str,
        task_id: &str,
        now: u64,
    ) -> Result<Option<String>, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|t| t.id == task_id && t.project_id == project_id)
            .ok_or(CoreError::NotFound)?;
        let candidates = self.task_agent_status_projection_for_executor(project_id, task_id)?;
        let mut scores = Vec::new();
        for candidate in candidates.as_array().into_iter().flatten() {
            let Some(id) = candidate["sessionId"].as_str() else {
                continue;
            };
            let Some(session) = self
                .store
                .sessions()
                .iter()
                .find(|s| s.id == id && s.lifecycle_state == "running")
            else {
                continue;
            };
            let score = self
                .playbook_evaluation
                .activity
                .get(id)
                .filter(|a| {
                    a.task_id == task_id
                        && a.worktree_generation == task.worktree_generation
                        && a.runtime_epoch == session.runtime_epoch
                        && a.native_id.as_deref()
                            == session
                                .resume_ref
                                .as_ref()
                                .map(|r| r.native_session_id.as_str())
                })
                .map_or((0, 0), |a| {
                    if self
                        .agent_observations
                        .get(id)
                        .and_then(|c| c.observation)
                        .is_some_and(|o| o.sequence == a.sequence && o.state == AgentState::Working)
                    {
                        a.score(now)
                    } else {
                        (a.working_ms, a.last_contribution_at)
                    }
                });
            scores.push((id.to_owned(), score));
        }
        scores.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        match scores.as_slice() {
            [(id, _)] => Ok(Some(id.clone())),
            [(id, score), (_, second), ..] if score.0 > 0 && score != second => {
                Ok(Some(id.clone()))
            }
            _ => {
                let canonical =
                    self.task_coordination_agent_projection_for_executor(project_id, task_id)?;
                Ok(canonical["sessionId"]
                    .as_str()
                    .filter(|id| scores.iter().any(|(candidate, _)| candidate == id))
                    .map(str::to_owned))
            }
        }
    }

    pub(crate) fn reserve_playbook_evaluation(
        &mut self,
        claim: &StewardRoutineClaim,
        source: String,
        session_id: String,
        runtime_epoch: u64,
    ) -> Result<(), CoreError> {
        let capability = claim
            .capability
            .clone()
            .ok_or(CoreError::TrackerReportStale)?;
        self.validate_current_check(&capability, termloop_platform::current_epoch_ms())?;
        if self.playbook_evaluation.evaluations.len() >= MAX_EVALUATIONS {
            return Err(CoreError::HelperCapacityExhausted);
        }
        let task_id = self
            .tracker_check_task_id(&capability)?
            .ok_or(CoreError::TrackerReportStale)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|t| t.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let playbook_revision = self
            .store
            .playbook_for_project(&capability.project_id)
            .ok_or(CoreError::TrackerReportStale)?
            .revision;
        let mut assignment = claim.result.clone();
        assignment["step"]["finishWith"] = json!("playbook_evaluation_complete");
        assignment["step"]["taskRead"] = json!({"requiredBeforeVerdict": true, "tool": "playbook_evaluation_read", "arguments": {}});
        self.playbook_evaluation.evaluations.insert(
            capability.check_id.clone(),
            PlaybookEvaluation {
                capability,
                task_id,
                source_session_id: source,
                session_id,
                runtime_epoch,
                playbook_revision,
                worktree_generation: task.worktree_generation,
                assignment,
                read: false,
            },
        );
        Ok(())
    }

    pub(crate) fn validate_playbook_evaluation(
        &self,
        evaluation: &PlaybookEvaluation,
        now: u64,
    ) -> Result<(), CoreError> {
        self.validate_current_check(&evaluation.capability, now)?;
        if self
            .store
            .playbook_for_project(&evaluation.capability.project_id)
            .is_none_or(|p| p.revision != evaluation.playbook_revision)
            || self
                .tracker_check_task_id(&evaluation.capability)?
                .as_deref()
                != Some(evaluation.task_id.as_str())
            || self
                .store
                .tasks()
                .iter()
                .find(|t| t.id == evaluation.task_id)
                .is_none_or(|t| {
                    t.worktree_generation != evaluation.worktree_generation
                        || t.archived_at_epoch_ms.is_some()
                        || t.status != termloop_domain::TaskStatus::Open
                })
        {
            return Err(CoreError::TrackerReportStale);
        }
        Ok(())
    }

    fn authenticated_playbook_evaluation(
        &self,
        token: &str,
    ) -> Result<PlaybookEvaluation, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        if !self.store.sessions().iter().any(|s| {
            s.id == principal.session_id()
                && s.runtime_epoch == principal.runtime_epoch()
                && s.lifecycle_state == "running"
                && s.process.template_ref.as_deref() == Some(EVALUATOR_TEMPLATE)
        }) {
            return Err(CoreError::CapabilityDenied);
        }
        let AgentMcpRole::PlaybookEvaluator { check_id } = principal.role() else {
            return Err(CoreError::CapabilityDenied);
        };
        self.playbook_evaluation
            .evaluations
            .get(check_id)
            .filter(|e| {
                e.session_id == principal.session_id()
                    && e.runtime_epoch == principal.runtime_epoch()
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)
    }

    pub fn read_playbook_evaluation(&mut self, token: &str) -> Result<Value, CoreError> {
        let evaluation = self.authenticated_playbook_evaluation(token)?;
        self.validate_playbook_evaluation(&evaluation, termloop_platform::current_epoch_ms())?;
        let task = self
            .task_projection_for_executor(&evaluation.capability.project_id, &evaluation.task_id)?;
        self.playbook_evaluation
            .evaluations
            .get_mut(&evaluation.capability.check_id)
            .expect("authenticated evaluation")
            .read = true;
        Ok(
            json!({"assignment": evaluation.assignment, "task": task, "sourceSessionId": evaluation.source_session_id}),
        )
    }

    pub fn complete_playbook_evaluation(
        &mut self,
        token: &str,
        check_id: &str,
        verdict: termloop_domain::PlaybookStepVerdict,
        evidence: String,
    ) -> Result<Value, CoreError> {
        let evaluation = self.authenticated_playbook_evaluation(token)?;
        if evaluation.capability.check_id != check_id || !evaluation.read {
            return Err(CoreError::CapabilityDenied);
        }
        let now = termloop_platform::current_epoch_ms();
        self.validate_playbook_evaluation(&evaluation, now)?;
        let result = self.apply_playbook_step_verdicts(
            &evaluation.capability,
            vec![StewardStepVerdict {
                task_id: evaluation.task_id,
                verdict,
                evidence,
            }],
            termloop_platform::generate_opaque_id(),
            now,
        )?;
        self.playbook_evaluation.evaluations.remove(check_id);
        self.mcp_authorizer.remove(&evaluation.session_id);
        Ok(
            json!({"projectId": evaluation.capability.project_id, "sessionId": evaluation.session_id, "result": result}),
        )
    }

    pub fn fail_playbook_evaluation_launch(&mut self, check_id: &str) {
        if let Some(evaluation) = self.playbook_evaluation.evaluations.remove(check_id) {
            self.mcp_authorizer.remove(&evaluation.session_id);
            self.pending_agent_forks.remove(&evaluation.session_id);
            self.playbook_evaluation
                .fallbacks
                .insert(check_id.to_owned(), "forkUnavailable".into());
        }
    }

    pub fn retire_playbook_evaluator_descriptor(
        &mut self,
        session_id: &str,
    ) -> Result<(), CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|s| s.id == session_id)
            .ok_or(CoreError::NotFound)?;
        if session.process.template_ref.as_deref() != Some(EVALUATOR_TEMPLATE)
            || self
                .playbook_evaluation
                .evaluations
                .values()
                .any(|e| e.session_id == session_id)
            || self
                .terminal
                .contains_session(session_id)
                .map_err(crate::terminal_error)?
            || self.codex_runtimes.contains_key(session_id)
            || self.resume_reservations.contains(session_id)
            || matches!(
                session.resume_failure,
                Some(
                    termloop_domain::ResumeFailureReason::RuntimeOwnershipUncertain
                        | termloop_domain::ResumeFailureReason::RuntimeConflict
                )
            )
        {
            return Err(CoreError::CapabilityDenied);
        }
        // An abandoned temporary evaluator is never resumed. With no managed
        // runtime, reservation, or uncertain ownership, retire its descriptor.
        if session.lifecycle_state != "exited" {
            self.store
                .mark_session_exited(&self.write_authority, session_id)
                .map_err(crate::store_error)?;
        }
        self.store
            .delete_session_descriptor(&self.write_authority, session_id)
            .map_err(crate::store_error)?;
        let retired = self.retire_closed_session_runtime(session_id);
        debug_assert!(retired.is_none());
        self.mcp_authorizer.remove(session_id);
        Ok(())
    }

    pub fn obsolete_playbook_evaluator_sessions(&mut self) -> Vec<String> {
        let now = termloop_platform::current_epoch_ms();
        let stale = self
            .playbook_evaluation
            .evaluations
            .iter()
            .filter(|(_, e)| self.validate_playbook_evaluation(e, now).is_err())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in stale {
            self.fail_playbook_evaluation_launch(&id);
        }
        self.playbook_evaluation
            .activity
            .retain(|id, _| self.store.sessions().iter().any(|s| s.id == *id));
        self.store
            .sessions()
            .iter()
            .filter(|s| {
                s.process.template_ref.as_deref() == Some(EVALUATOR_TEMPLATE)
                    && !self.pending_agent_forks.contains(&s.id)
                    && !self
                        .playbook_evaluation
                        .evaluations
                        .values()
                        .any(|e| e.session_id == s.id)
            })
            .map(|s| s.id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests;
