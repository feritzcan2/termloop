//! Task Agent step reports: the Agent working a Task tells TermLoop that its
//! own work reached, or is blocked at, the Playbook step the Task stands at.
//!
//! A report is a claim, not a verdict. Under a step's default `signal` policy
//! it only brings that Task's evaluation forward through the same nudge a pull
//! request change uses, and travels to the evaluator as unverified context.
//! Only a `trusted` automatic step records the claim as its verdict. Reports
//! are runtime-only, one per Task, and describe only the step they named.

use super::pull_request_nudge::NUDGE_DEBOUNCE_MS;
use super::*;
use termloop_domain::{
    PLAYBOOK_EVIDENCE_MAX_BYTES, PlaybookAgentReportPolicy, PlaybookConfiguration,
    PlaybookGateKind, PlaybookMilestone, PlaybookPosition, PlaybookStepEvaluator,
    PlaybookStepProgress, PlaybookStepVerdict, TaskStatus,
};

const AGENT_STEP_REPORTS_MAX: usize = 512;
/// A repeated report inside this window rides along with the evaluation it
/// already requested instead of asking for another one.
const AGENT_REPORT_RENUDGE_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStepReportStatus {
    Reached,
    Blocked,
}

impl AgentStepReportStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reached => "reached",
            Self::Blocked => "blocked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentStepReport {
    session_id: String,
    milestone_id: String,
    routine_id: String,
    status: AgentStepReportStatus,
    evidence: String,
    reported_at_epoch_ms: u64,
}

impl AgentStepReport {
    fn describes(&self, milestone: &PlaybookMilestone) -> bool {
        self.milestone_id == milestone.id && self.routine_id == milestone.routine_id
    }

    /// What an evaluator sees: the Agent's own words, marked as unverified.
    pub(crate) fn evaluator_context(&self) -> Value {
        json!({
            "status": self.status.as_str(),
            "evidence": self.evidence,
            "reportedAtEpochMs": self.reported_at_epoch_ms,
            "kind": "taskAgentClaim",
            "independentlyVerified": false,
        })
    }

    fn projection(&self, task_id: &str) -> Value {
        json!({
            "taskId": task_id,
            "sessionId": self.session_id,
            "status": self.status.as_str(),
            "evidence": self.evidence,
            "reportedAtEpochMs": self.reported_at_epoch_ms,
        })
    }
}

/// What one accepted report changed, so the caller wakes only what it must.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentStepReportReceipt {
    pub project_id: String,
    pub result: Value,
    /// A step check became due sooner or the next step became due.
    pub wake_step_scheduler: bool,
    /// The Task passed the step, so its pipeline position moved.
    pub position_changed: bool,
}

/// The Task this authenticated Session is the canonical Agent of, and where
/// that Task stands on its Project's active pipeline.
struct TaskAgentStanding {
    session_id: String,
    project_id: String,
    task_id: String,
    task_title: String,
    playbook: PlaybookConfiguration,
    position: PlaybookPosition,
    answers: Vec<PlaybookStepProgress>,
}

impl CoreRuntime {
    fn task_agent_standing(&self, token: &str) -> Result<TaskAgentStanding, CoreError> {
        let principal = self.mcp_authorizer.authenticate(token)?;
        if !matches!(
            principal.role(),
            crate::session_launch::AgentMcpRole::Interactive
        ) {
            return Err(CoreError::CapabilityDenied);
        }
        let session_id = principal.session_id();
        let project_id = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| session.project_id.clone())
            .ok_or(CoreError::CapabilityDenied)?;
        // Only the one Agent that Steward coordination would address for a
        // Task may speak for it; a peer or helper in the same worktree cannot.
        let task = self
            .store
            .tasks()
            .iter()
            .filter(|task| {
                task.project_id == project_id
                    && task.status == TaskStatus::Open
                    && task.archived_at_epoch_ms.is_none()
            })
            .find(|task| {
                self.ensure_task_agent_request_target_for_executor(
                    &project_id,
                    &task.id,
                    session_id,
                )
                .is_ok()
            })
            .ok_or(CoreError::NoTaskPlaybook)?;
        let playbook = self
            .store
            .playbook_for_project(&project_id)
            .filter(|playbook| !playbook.milestones.is_empty())
            .ok_or(CoreError::NoTaskPlaybook)?
            .clone();
        let (position, answers) = self
            .task_playbook_position(&task.id)
            .ok_or(CoreError::NoTaskPlaybook)?;
        Ok(TaskAgentStanding {
            session_id: session_id.to_owned(),
            project_id,
            task_id: task.id.clone(),
            task_title: task.title.clone(),
            playbook,
            position,
            answers,
        })
    }

    /// This Task Agent's view of its own Task's pipeline: every step, where
    /// the Task stands, what the current step requires, and how a report on
    /// it is treated.
    pub fn read_task_agent_playbook_step(&self, token: &str) -> Result<Value, CoreError> {
        let standing = self.task_agent_standing(token)?;
        let current_index = match standing.position {
            PlaybookPosition::At(index) => Some(index),
            PlaybookPosition::Done => None,
        };
        let steps = standing
            .playbook
            .milestones
            .iter()
            .enumerate()
            .map(|(index, milestone)| {
                let state = match current_index {
                    Some(current) if index == current => "current",
                    Some(current) if index > current => "ahead",
                    _ => "passed",
                };
                let answer = standing.answers.iter().find(|answer| {
                    answer.milestone_id == milestone.id && answer.routine_id == milestone.routine_id
                });
                let mut step = json!({
                    "milestoneId": milestone.id,
                    "title": milestone.title,
                    "gate": milestone.gate,
                    "approver": milestone.approver,
                    "agentReport": milestone.agent_report,
                    "state": state,
                    "verdict": answer.map(|answer| answer.verdict),
                    "evidence": answer.map(|answer| answer.evidence.as_str()),
                });
                // Only the step being worked carries its full criteria; the
                // rest stay a bounded outline of the path ahead.
                if state == "current" {
                    step["completeWhen"] = self
                        .store
                        .tracker_configurations()
                        .iter()
                        .find(|routine| routine.id == milestone.routine_id)
                        .map_or(Value::Null, |routine| Value::String(routine.prompt.clone()));
                    step["deterministicCheck"] = json!(milestone.deterministic_check);
                }
                step
            })
            .collect::<Vec<_>>();
        let current = current_index.map(|index| &standing.playbook.milestones[index]);
        Ok(json!({
            "taskId": standing.task_id,
            "taskTitle": standing.task_title,
            "playbookRevision": standing.playbook.revision,
            "pipelineName": standing.playbook.active_pipeline_name,
            "currentMilestoneId": current.map(|milestone| milestone.id.as_str()),
            "automationEnabled": self.playbook_automation_enabled(&standing.project_id),
            "steps": steps,
            "latestReport": current
                .and_then(|milestone| self.current_agent_step_report(&standing.task_id, milestone))
                .map(|report| report.projection(&standing.task_id)),
            "reportWith": "playbook_step_report",
        }))
    }

    /// Accepts one Task Agent report for the exact step its Task stands at.
    pub fn report_task_agent_playbook_step(
        &mut self,
        token: &str,
        milestone_id: &str,
        playbook_revision: u64,
        status: AgentStepReportStatus,
        evidence: &str,
        now_epoch_ms: u64,
    ) -> Result<AgentStepReportReceipt, CoreError> {
        let standing = self.task_agent_standing(token)?;
        // A report names the step it read. A Playbook edited or a Task moved
        // since then would attach the claim to a question it never saw.
        if playbook_revision != standing.playbook.revision {
            return Err(CoreError::TrackerReportStale);
        }
        let PlaybookPosition::At(index) = standing.position else {
            return Err(CoreError::TrackerReportStale);
        };
        let milestone = standing.playbook.milestones[index].clone();
        if milestone.id != milestone_id {
            return Err(CoreError::TrackerReportStale);
        }
        let evidence = evidence.trim();
        if evidence.is_empty()
            || evidence.len() > PLAYBOOK_EVIDENCE_MAX_BYTES
            || evidence.chars().any(char::is_control)
        {
            return Err(CoreError::InvalidParams(
                "evidence must be one non-empty line of at most 600 UTF-8 bytes".into(),
            ));
        }
        if milestone.agent_report == PlaybookAgentReportPolicy::Off {
            return Err(CoreError::InvalidParams(
                "this Playbook step does not accept Task Agent reports; its evaluator observes it on its own schedule".into(),
            ));
        }
        let TaskAgentStanding {
            session_id,
            project_id,
            task_id,
            playbook,
            answers,
            ..
        } = standing;

        if status == AgentStepReportStatus::Reached
            && milestone.agent_report == PlaybookAgentReportPolicy::Trusted
            && milestone.gate == PlaybookGateKind::Automatic
        {
            let mut answers = answers
                .into_iter()
                .filter(|answer| answer.milestone_id != milestone.id)
                .collect::<Vec<_>>();
            answers.push(PlaybookStepProgress {
                task_id: task_id.clone(),
                milestone_id: milestone.id.clone(),
                routine_id: milestone.routine_id.clone(),
                verdict: PlaybookStepVerdict::Passed,
                evidence: evidence.to_owned(),
                decided_at_epoch_ms: now_epoch_ms,
                next_attempt_at_epoch_ms: None,
                evaluator: PlaybookStepEvaluator::Agent,
                deterministic_fallback: None,
            });
            self.store
                .replace_task_playbook_progress(
                    &self.write_authority,
                    &project_id,
                    &task_id,
                    answers,
                    self.store.revision(),
                )
                .map_err(store_error)?;
            // A check claimed before this verdict must not land afterwards
            // and move the Task again.
            self.tracker_runtime
                .cancel_step_task_check(&milestone.routine_id, &task_id);
            self.tracker_runtime.agent_step_reports.remove(&task_id);
            if let Some(next) = playbook.milestones.get(index + 1) {
                self.tracker_runtime
                    .schedule_tracker_now(&next.routine_id, now_epoch_ms);
            }
            return Ok(AgentStepReportReceipt {
                project_id,
                result: self.agent_report_result("passed", &milestone.id),
                wake_step_scheduler: true,
                position_changed: true,
            });
        }

        let previous = self
            .tracker_runtime
            .agent_step_reports
            .get(&task_id)
            .filter(|report| report.describes(&milestone))
            .cloned();
        self.remember_agent_step_report(
            task_id.clone(),
            AgentStepReport {
                session_id,
                milestone_id: milestone.id.clone(),
                routine_id: milestone.routine_id.clone(),
                status,
                evidence: evidence.to_owned(),
                reported_at_epoch_ms: now_epoch_ms,
            },
        );
        let recently_requested = previous.is_some_and(|previous| {
            previous.status == AgentStepReportStatus::Reached
                && now_epoch_ms.saturating_sub(previous.reported_at_epoch_ms)
                    < AGENT_REPORT_RENUDGE_MS
        });
        let outcome = match status {
            // A blocker is for the Steward to read, not a reason to re-check.
            AgentStepReportStatus::Blocked => "recorded",
            AgentStepReportStatus::Reached => {
                self.request_agent_reported_check(&task_id, recently_requested, now_epoch_ms)
            }
        };
        Ok(AgentStepReportReceipt {
            project_id,
            result: self.agent_report_result(outcome, &milestone.id),
            wake_step_scheduler: outcome == "verificationRequested",
            position_changed: false,
        })
    }

    /// Brings the Task's automatic step check forward, unless one is already
    /// due, running, or recently requested. A human gate or a step whose
    /// automation is off only keeps the report.
    fn request_agent_reported_check(
        &mut self,
        task_id: &str,
        recently_requested: bool,
        now_epoch_ms: u64,
    ) -> &'static str {
        let Some((routine_id, due_at)) = self.playbook_automatic_step_for_task(task_id) else {
            return "recorded";
        };
        let active = self.store.tracker_configurations().iter().any(|routine| {
            routine.id == routine_id
                && routine.enabled
                && !routine.trigger_mode.is_scheduled()
                && self.playbook_automation_enabled(&routine.project_id)
        });
        if !active {
            return "recorded";
        }
        if recently_requested
            || self
                .tracker_runtime
                .step_task_is_checked(&routine_id, task_id)
            || due_at <= now_epoch_ms.saturating_add(NUDGE_DEBOUNCE_MS)
            || !self.nudge_playbook_steps(&[task_id.to_owned()], now_epoch_ms)
        {
            return "verificationPending";
        }
        "verificationRequested"
    }

    fn remember_agent_step_report(&mut self, task_id: String, report: AgentStepReport) {
        let reports = &mut self.tracker_runtime.agent_step_reports;
        reports.insert(task_id, report);
        while reports.len() > AGENT_STEP_REPORTS_MAX {
            let Some(oldest) = reports
                .iter()
                .min_by_key(|(task_id, report)| (report.reported_at_epoch_ms, (*task_id).clone()))
                .map(|(task_id, _)| task_id.clone())
            else {
                break;
            };
            reports.remove(&oldest);
        }
    }

    fn agent_report_result(&self, outcome: &str, milestone_id: &str) -> Value {
        json!({
            "outcome": outcome,
            "milestoneId": milestone_id,
            "stateRevision": self.store.revision(),
        })
    }

    /// The Task Agent's current report for exactly this step, if any.
    pub(crate) fn current_agent_step_report(
        &self,
        task_id: &str,
        milestone: &PlaybookMilestone,
    ) -> Option<&AgentStepReport> {
        self.tracker_runtime
            .agent_step_reports
            .get(task_id)
            .filter(|report| report.describes(milestone))
    }

    /// Board projection of the reports for Tasks standing at this step.
    pub(crate) fn agent_step_report_projections(
        &self,
        milestone: &PlaybookMilestone,
        waiting_task_ids: &[String],
    ) -> Vec<Value> {
        waiting_task_ids
            .iter()
            .filter_map(|task_id| {
                self.current_agent_step_report(task_id, milestone)
                    .map(|report| report.projection(task_id))
            })
            .collect()
    }

    /// Settles a report once an evaluator answered its step. A report the
    /// check already saw is consumed. One that arrived while the check was
    /// running asks for another check when the answer was not a pass.
    pub(crate) fn settle_agent_step_report(
        &mut self,
        task_id: &str,
        milestone_id: &str,
        claimed_at_epoch_ms: u64,
        verdict: PlaybookStepVerdict,
        now_epoch_ms: u64,
    ) {
        let Some(report) = self
            .tracker_runtime
            .agent_step_reports
            .get(task_id)
            .filter(|report| report.milestone_id == milestone_id)
        else {
            return;
        };
        let arrived_during_check = report.reported_at_epoch_ms > claimed_at_epoch_ms;
        if verdict == PlaybookStepVerdict::Passed || !arrived_during_check {
            self.tracker_runtime.agent_step_reports.remove(task_id);
        } else if report.status == AgentStepReportStatus::Reached {
            self.nudge_playbook_steps(&[task_id.to_owned()], now_epoch_ms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_integrations::playbook_runtime::StewardStepVerdict;
    use crate::companion_integrations::playbook_runtime::tests::pipeline_runtime;
    use crate::runtime::playbook_evaluation::tests::attach_agents;
    use crate::session_launch::AgentMcpRole;

    const NOW: u64 = 1_000_000;

    fn with_task_agent() -> (CoreRuntime, std::path::PathBuf, String) {
        let (mut runtime, root, project_id) = pipeline_runtime();
        attach_agents(&mut runtime, &root, &["implementer"]);
        runtime.mcp_authorizer.register(
            "implementer".into(),
            1,
            AgentMcpRole::Interactive,
            "implementer-token".into(),
        );
        (runtime, root, project_id)
    }

    fn set_first_step_policy(
        runtime: &mut CoreRuntime,
        project_id: &str,
        policy: PlaybookAgentReportPolicy,
    ) {
        let mut playbook = runtime
            .store
            .playbook_for_project(project_id)
            .unwrap()
            .clone();
        playbook.milestones[0].agent_report = policy;
        playbook.revision += 1;
        let revision = runtime.store.revision();
        runtime
            .store
            .set_playbook_configuration(&runtime.write_authority, playbook, revision)
            .unwrap();
    }

    fn report(
        runtime: &mut CoreRuntime,
        milestone: &str,
        revision: u64,
        now: u64,
    ) -> Result<AgentStepReportReceipt, CoreError> {
        runtime.report_task_agent_playbook_step(
            "implementer-token",
            milestone,
            revision,
            AgentStepReportStatus::Reached,
            "Opened pull request #42 for review",
            now,
        )
    }

    #[test]
    fn a_task_agent_reads_its_current_step_and_its_report_asks_for_an_early_check() {
        let (mut runtime, root, project_id) = with_task_agent();
        let read = runtime
            .read_task_agent_playbook_step("implementer-token")
            .unwrap();
        assert_eq!(read["taskId"], "task-1");
        assert_eq!(read["currentMilestoneId"], "pr-open");
        assert_eq!(read["steps"][0]["state"], "current");
        assert_eq!(read["steps"][0]["agentReport"], "signal");
        assert!(read["steps"][0]["completeWhen"].is_string());
        assert_eq!(read["steps"][1]["state"], "ahead");
        assert!(read["steps"][1].get("completeWhen").is_none());

        // The step was asked about and is waiting out its retry delay.
        let claim = runtime
            .claim_next_playbook_step_or_idle(&project_id, "first".into(), NOW)
            .unwrap();
        runtime
            .report_steward_step_verdicts(
                &claim.capability.unwrap(),
                vec![StewardStepVerdict {
                    task_id: "task-1".into(),
                    verdict: PlaybookStepVerdict::Waiting,
                    evidence: "No pull request yet".into(),
                }],
                "report-first".into(),
                NOW + 1,
            )
            .unwrap();

        let receipt = report(&mut runtime, "pr-open", 1, NOW + 2).unwrap();
        assert_eq!(receipt.result["outcome"], "verificationRequested");
        assert!(receipt.wake_step_scheduler);
        assert!(!receipt.position_changed);
        // A repeated claim rides along with the evaluation already requested.
        let again = report(&mut runtime, "pr-open", 1, NOW + 3).unwrap();
        assert_eq!(again.result["outcome"], "verificationPending");

        let board = runtime
            .playbook_runtime(json!({"projectId": project_id}))
            .unwrap();
        assert_eq!(board["steps"][0]["agentReports"][0]["taskId"], "task-1");
        assert_eq!(board["steps"][1]["agentReports"], json!([]));

        // The evaluator receives the claim as unverified context, and once it
        // answers, the claim it saw is consumed.
        let other = runtime
            .claim_next_playbook_step_or_idle(&project_id, "other".into(), NOW + 4)
            .unwrap();
        assert_eq!(other.result["step"]["tasks"][0]["taskId"], "task-2");
        let nudged = runtime
            .claim_next_playbook_step_or_idle(&project_id, "nudged".into(), NOW + 2 + 15_000)
            .unwrap();
        let task = &nudged.result["step"]["tasks"][0];
        assert_eq!(task["taskId"], "task-1");
        assert_eq!(task["agentReport"]["independentlyVerified"], false);
        assert_eq!(
            task["agentReport"]["evidence"],
            "Opened pull request #42 for review"
        );
        runtime
            .report_steward_step_verdicts(
                &nudged.capability.unwrap(),
                vec![StewardStepVerdict {
                    task_id: "task-1".into(),
                    verdict: PlaybookStepVerdict::Waiting,
                    evidence: "Pull request #42 is still a draft".into(),
                }],
                "report-nudged".into(),
                NOW + 20_000,
            )
            .unwrap();
        let read = runtime
            .read_task_agent_playbook_step("implementer-token")
            .unwrap();
        assert!(read["latestReport"].is_null());
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_trusted_automatic_step_records_the_agent_claim_as_its_verdict() {
        let (mut runtime, root, project_id) = with_task_agent();
        set_first_step_policy(
            &mut runtime,
            &project_id,
            PlaybookAgentReportPolicy::Trusted,
        );
        let receipt = report(&mut runtime, "pr-open", 2, NOW).unwrap();
        assert_eq!(receipt.result["outcome"], "passed");
        assert!(receipt.position_changed);
        let (position, answers) = runtime.task_playbook_position("task-1").unwrap();
        assert_eq!(position, PlaybookPosition::At(1));
        assert_eq!(answers[0].evaluator, PlaybookStepEvaluator::Agent);
        assert_eq!(answers[0].verdict, PlaybookStepVerdict::Passed);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_report_names_the_exact_step_and_only_the_task_agent_may_make_it() {
        let (mut runtime, root, project_id) = with_task_agent();
        assert!(matches!(
            report(&mut runtime, "pr-open", 2, NOW),
            Err(CoreError::TrackerReportStale)
        ));
        assert!(matches!(
            report(&mut runtime, "deployed", 1, NOW),
            Err(CoreError::TrackerReportStale)
        ));
        assert!(matches!(
            runtime.report_task_agent_playbook_step(
                "implementer-token",
                "pr-open",
                1,
                AgentStepReportStatus::Blocked,
                "  ",
                NOW,
            ),
            Err(CoreError::InvalidParams(_))
        ));
        let blocked = runtime
            .report_task_agent_playbook_step(
                "implementer-token",
                "pr-open",
                1,
                AgentStepReportStatus::Blocked,
                "CI credentials are missing",
                NOW,
            )
            .unwrap();
        assert_eq!(blocked.result["outcome"], "recorded");
        assert!(!blocked.wake_step_scheduler);

        set_first_step_policy(&mut runtime, &project_id, PlaybookAgentReportPolicy::Off);
        assert!(matches!(
            report(&mut runtime, "pr-open", 2, NOW),
            Err(CoreError::InvalidParams(_))
        ));

        // A Session outside every Task worktree speaks for no Task.
        let mut outsider = runtime
            .store
            .sessions()
            .iter()
            .find(|session| session.id == "implementer")
            .unwrap()
            .clone();
        outsider.id = "outsider".into();
        outsider.process.cwd = root.join("elsewhere").to_string_lossy().into_owned();
        runtime
            .store
            .insert_session(&runtime.write_authority, outsider)
            .unwrap();
        runtime.mcp_authorizer.register(
            "outsider".into(),
            1,
            AgentMcpRole::Interactive,
            "outsider-token".into(),
        );
        assert!(matches!(
            runtime.read_task_agent_playbook_step("outsider-token"),
            Err(CoreError::NoTaskPlaybook)
        ));
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}
