//! Sending a Task back to an earlier step.
//!
//! Position stays derived: a send-back removes the answers that let the Task
//! stand past the target step, so the first unpassed step becomes the target.
//! The answering step keeps a waiting answer that carries how many times it
//! has sent this Task back, which is the only state the limit needs.

use serde_json::{Value, json};
use termloop_domain::{
    PlaybookConfiguration, PlaybookEvaluationOutcome, PlaybookEvaluationRecord,
    PlaybookStepEvaluator, PlaybookStepProgress, PlaybookStepVerdict, TrackerConfiguration,
    TrackerReport, TrackerReportKind,
};

use super::StewardStepVerdict;
use crate::companion_integrations::tracker_runtime::TrackerCheckCapability;
use crate::{CoreError, CoreRuntime};

impl CoreRuntime {
    /// Records the claimed step's observation that its send-back condition
    /// holds for the focused Task. Within the step's limit the Task returns to
    /// the rule's target step; past it the answer is recorded as blocked so a
    /// human decides instead of the pipeline looping.
    pub(crate) fn apply_playbook_step_rewind(
        &mut self,
        capability: &TrackerCheckCapability,
        reported_task_id: &str,
        evidence: String,
        report_id: String,
        completed_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let configuration = self.validate_current_check(capability, completed_at_epoch_ms)?;
        if configuration.trigger_mode.is_scheduled() {
            return Err(CoreError::InvalidParams(
                "status rewind is only for a Playbook step with a rewind rule".into(),
            ));
        }
        let milestone_id = self
            .claimed_step_milestone_id(capability)
            .ok_or(CoreError::TrackerReportStale)?;
        let task_id = self
            .claimed_step_task_id(capability)
            .ok_or(CoreError::TrackerReportStale)?;
        if task_id != reported_task_id {
            return Err(CoreError::TrackerReportInvalid);
        }
        let assignment = self
            .playbook_step_assignment_for_task(&capability.tracker_id, &task_id)
            .filter(|assignment| {
                assignment.milestone.id == milestone_id && assignment.waiting[0].task_id == task_id
            })
            .ok_or(CoreError::TrackerReportStale)?;
        let Some(rule) = assignment.milestone.rewind.clone() else {
            return Err(CoreError::InvalidParams(
                "This step has no rewind rule. Report satisfied, pending, or blocked.".into(),
            ));
        };
        let (evaluator, deterministic_fallback) = self.claimed_step_evaluation(capability);
        if evaluator == PlaybookStepEvaluator::Deterministic {
            return Err(CoreError::TrackerReportInvalid);
        }
        let observed = evidence.trim();
        if observed.is_empty() || observed.len() > termloop_domain::PLAYBOOK_EVIDENCE_MAX_BYTES {
            return Err(CoreError::TrackerReportInvalid);
        }

        let playbook = self
            .store
            .playbook_for_project(&assignment.project_id)
            .ok_or(CoreError::TrackerReportStale)?
            .clone();
        let index_of = |id: &str| {
            playbook
                .milestones
                .iter()
                .position(|milestone| milestone.id == id)
        };
        let current_index = index_of(&milestone_id).ok_or(CoreError::TrackerReportStale)?;
        let target_index = index_of(&rule.to_milestone_id)
            .filter(|index| *index < current_index)
            .ok_or(CoreError::TrackerReportStale)?;
        let target = playbook.milestones[target_index].clone();

        let previous = self
            .store
            .playbook_step_progress()
            .iter()
            .find(|answer| answer.task_id == task_id && answer.milestone_id == milestone_id);
        let count = previous.map_or(0, |answer| answer.rewind_count);
        if count >= rule.max_times {
            let evidence = bounded_evidence(&format!(
                "Send-back limit reached ({count}/{}); a person decides how to continue. {observed}",
                rule.max_times,
            ));
            return self.apply_playbook_step_verdicts(
                capability,
                vec![StewardStepVerdict {
                    task_id,
                    verdict: PlaybookStepVerdict::Blocked,
                    evidence,
                }],
                report_id,
                completed_at_epoch_ms,
            );
        }

        let rewind_count = count + 1;
        let evidence = bounded_evidence(&format!(
            "Sent back to “{}” ({rewind_count}/{}): {observed}",
            target.title, rule.max_times,
        ));
        let waiting = PlaybookStepProgress {
            task_id: task_id.clone(),
            milestone_id: milestone_id.clone(),
            routine_id: assignment.milestone.routine_id.clone(),
            verdict: PlaybookStepVerdict::Waiting,
            evidence: evidence.clone(),
            decided_at_epoch_ms: completed_at_epoch_ms,
            // Only asked again once the Task walks back here, and then at
            // once: the reworked result is exactly what it waits for.
            next_attempt_at_epoch_ms: Some(completed_at_epoch_ms),
            evaluator,
            deterministic_fallback,
            rewind_count,
            pull_request_number: None,
        };
        let task_title = assignment.waiting[0].title.clone();
        let message = format!(
            "{} — {task_title} was sent back to “{}”.\n- {task_id} rewound: {evidence}",
            assignment.milestone.title, target.title,
        );
        let record = self
            .completed_evaluation_record(&capability.check_id, &waiting)
            .map(|mut record| {
                record.outcome = PlaybookEvaluationOutcome::Rewound;
                record
            });
        self.send_task_back(
            capability,
            configuration,
            &playbook,
            SendBack {
                task_id: &task_id,
                answering_milestone_id: &milestone_id,
                target_index,
                kept: Some(waiting),
                report_id,
                message,
                record,
            },
            completed_at_epoch_ms,
        )?;
        Ok(json!({
            "status": "rewound",
            "milestoneId": milestone_id,
            "toMilestoneId": target.id,
            "rewindCount": rewind_count,
            "maxTimes": rule.max_times,
            "passedCount": 0,
            "waitingCount": 1,
            "blockedCount": 0,
            "newPendingFindingCount": 0,
            "stewardReviewRequired": false,
            "stateRevision": self.store.revision(),
        }))
    }
}

/// One send-back: which Task returns to which step, and what is kept.
pub(crate) struct SendBack<'a> {
    pub(crate) task_id: &'a str,
    /// The step whose claim observed the reason; its pending Agent report is
    /// settled as waiting.
    pub(crate) answering_milestone_id: &'a str,
    pub(crate) target_index: usize,
    /// A row the answering step keeps, such as its send-back count.
    pub(crate) kept: Option<PlaybookStepProgress>,
    pub(crate) report_id: String,
    pub(crate) message: String,
    pub(crate) record: Option<PlaybookEvaluationRecord>,
}

impl CoreRuntime {
    /// Moves a Task back to `target_index` in one commit: answers before the
    /// target stay, the target and every later step are asked again, so a
    /// pass recorded for the old work can never carry the Task past the
    /// reopened work. The claim is finished and the target asked at once.
    pub(crate) fn send_task_back(
        &mut self,
        capability: &TrackerCheckCapability,
        mut configuration: TrackerConfiguration,
        playbook: &PlaybookConfiguration,
        send: SendBack<'_>,
        completed_at_epoch_ms: u64,
    ) -> Result<(), CoreError> {
        let target = &playbook.milestones[send.target_index];
        let mut answers = self
            .store
            .playbook_step_progress()
            .iter()
            .filter(|answer| {
                answer.task_id == send.task_id
                    && playbook
                        .milestones
                        .iter()
                        .position(|milestone| milestone.id == answer.milestone_id)
                        .is_some_and(|index| index < send.target_index)
            })
            .cloned()
            .collect::<Vec<_>>();
        answers.extend(send.kept);

        configuration
            .pending_routine_findings
            .retain(|finding| !finding.related_task_ids.iter().any(|id| id == send.task_id));
        configuration.last_check_started_at_epoch_ms = Some(capability.claimed_at_epoch_ms);
        configuration.last_attempt_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.last_successful_report_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.updated_at_epoch_ms = completed_at_epoch_ms;

        let report = TrackerReport {
            id: send.report_id,
            project_id: capability.project_id.clone(),
            routine_id: capability.tracker_id.clone(),
            check_id: capability.check_id.clone(),
            generation: capability.generation,
            kind: TrackerReportKind::Success,
            message: send.message,
            source_references: Vec::new(),
            related_task_ids: vec![send.task_id.to_owned()],
            created_at_epoch_ms: completed_at_epoch_ms,
        };
        if !report.is_valid() {
            return Err(CoreError::TrackerReportInvalid);
        }
        self.store
            .rewind_task_playbook_progress(
                &self.write_authority,
                &playbook.project_id,
                send.task_id,
                answers,
                configuration.clone(),
                send.record,
                self.store.revision(),
            )
            .map_err(crate::store_error)?;
        self.finish_steward_step_check(capability, completed_at_epoch_ms, &configuration);
        self.settle_agent_step_report(
            send.task_id,
            send.answering_milestone_id,
            capability.claimed_at_epoch_ms,
            PlaybookStepVerdict::Waiting,
            completed_at_epoch_ms,
        );
        self.push_runtime_report(report);
        self.tracker_runtime
            .schedule_tracker_now(&target.routine_id, completed_at_epoch_ms);
        Ok(())
    }
}

/// The restart a claim at a later step watches for: the latest earlier step
/// that opted to restart on a new pull request, which this Task passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestartWatch {
    pub(crate) milestone_id: String,
    /// The watched step's own base-branch filter, if its check has one.
    pub(crate) base_branch: Option<String>,
    /// The pull request the Task's later steps follow; `None` until a read
    /// records one.
    pub(crate) pull_request_number: Option<u64>,
}

impl CoreRuntime {
    pub(crate) fn restart_watch(
        &self,
        capability: &TrackerCheckCapability,
    ) -> Option<RestartWatch> {
        let task_id = self.claimed_step_task_id(capability)?;
        let step_id = self.claimed_step_milestone_id(capability)?;
        let playbook = self.routine_playbook(&capability.tracker_id)?;
        let index = playbook
            .milestones
            .iter()
            .position(|milestone| milestone.id == step_id)?;
        let watched = playbook.milestones[..index]
            .iter()
            .rev()
            .find(|milestone| milestone.restart_on_new_pull_request)?;
        let passed = self.store.playbook_step_progress().iter().find(|answer| {
            answer.task_id == task_id
                && answer.milestone_id == watched.id
                && answer.routine_id == watched.routine_id
                && answer.verdict == PlaybookStepVerdict::Passed
        })?;
        Some(RestartWatch {
            milestone_id: watched.id.clone(),
            base_branch: watched
                .deterministic_check
                .as_ref()
                .and_then(|check| check.base_branch.clone()),
            pull_request_number: passed.pull_request_number,
        })
    }

    /// Records the pull request the Task's later steps follow on the watched
    /// step's passed answer.
    pub(crate) fn adopt_restart_pull_request(
        &mut self,
        project_id: &str,
        task_id: &str,
        watched_milestone_id: &str,
        number: u64,
    ) -> Result<(), CoreError> {
        let answers = self
            .store
            .playbook_step_progress()
            .iter()
            .filter(|answer| answer.task_id == task_id)
            .map(|answer| {
                let mut answer = answer.clone();
                if answer.milestone_id == watched_milestone_id {
                    answer.pull_request_number = Some(number);
                }
                answer
            })
            .collect::<Vec<_>>();
        self.store
            .replace_task_playbook_progress(
                &self.write_authority,
                project_id,
                task_id,
                answers,
                self.store.revision(),
            )
            .map_err(crate::store_error)?;
        Ok(())
    }

    /// A newer pull request opened while the Task stood at the claimed step:
    /// the Task returns to the watched step, which then asks about it.
    pub(crate) fn restart_for_new_pull_request(
        &mut self,
        capability: &TrackerCheckCapability,
        configuration: TrackerConfiguration,
        watched_milestone_id: &str,
        task_id: &str,
        evidence: &str,
        completed_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let playbook = self
            .routine_playbook(&capability.tracker_id)
            .ok_or(CoreError::TrackerReportStale)?
            .clone();
        let step_id = self
            .claimed_step_milestone_id(capability)
            .ok_or(CoreError::TrackerReportStale)?;
        let index_of = |id: &str| {
            playbook
                .milestones
                .iter()
                .position(|milestone| milestone.id == id)
        };
        let step_index = index_of(&step_id).ok_or(CoreError::TrackerReportStale)?;
        let target_index = index_of(watched_milestone_id)
            .filter(|index| *index < step_index)
            .ok_or(CoreError::TrackerReportStale)?;
        let task_title = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .map(|task| task.title.clone())
            .ok_or(CoreError::TrackerReportStale)?;
        let step_title = playbook.milestones[step_index].title.clone();
        let target_title = playbook.milestones[target_index].title.clone();
        self.send_task_back(
            capability,
            configuration,
            &playbook,
            SendBack {
                task_id,
                answering_milestone_id: &step_id,
                target_index,
                kept: None,
                report_id: termloop_platform::generate_opaque_id(),
                message: format!(
                    "{step_title} — {task_title} was sent back to “{target_title}”.\n- {task_id} rewound: {evidence}"
                ),
                record: None,
            },
            completed_at_epoch_ms,
        )?;
        Ok(json!({
            "status": "rewound",
            "milestoneId": step_id,
            "toMilestoneId": watched_milestone_id,
            "passedCount": 0,
            "waitingCount": 0,
            "blockedCount": 0,
            "newPendingFindingCount": 0,
            "stewardReviewRequired": false,
            "stateRevision": self.store.revision(),
        }))
    }
}

/// Evidence is one bounded sentence; a long prefix never pushes it past the
/// stored limit or splits a character.
fn bounded_evidence(text: &str) -> String {
    let max = termloop_domain::PLAYBOOK_EVIDENCE_MAX_BYTES;
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max - '…'.len_utf8();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", text[..end].trim_end())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use termloop_domain::{
        PlaybookEvaluationOutcome, PlaybookPosition, PlaybookStepRewind, PlaybookStepVerdict,
        pipeline_position,
    };

    use super::super::StewardStepVerdict;
    use super::super::tests::pipeline_runtime;
    use crate::CoreError;

    const NOW: u64 = 1_000_000;

    fn position(runtime: &crate::CoreRuntime, project_id: &str, task_id: &str) -> PlaybookPosition {
        let playbook = runtime.store.playbook_for_project(project_id).unwrap();
        let answers = runtime
            .store
            .playbook_step_progress()
            .iter()
            .filter(|answer| answer.task_id == task_id)
            .collect::<Vec<_>>();
        pipeline_position(&playbook.milestones, &answers)
    }

    #[test]
    fn a_send_back_reopens_earlier_steps_until_its_limit_then_blocks() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let mut playbook = runtime
            .store
            .playbook_for_project(&project_id)
            .unwrap()
            .clone();
        playbook.revision = 2;
        playbook.milestones[1].rewind = Some(PlaybookStepRewind {
            to_milestone_id: "pr-open".into(),
            when: "A new fix pull request from the Task branch is open.".into(),
            max_times: 1,
        });
        let revision = runtime.store.revision();
        runtime
            .store
            .set_playbook_configuration(&runtime.write_authority, playbook, revision)
            .unwrap();
        // Task 2 is done, so every claim below focuses Task 1.
        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-2", 2, 2, revision, NOW)
            .unwrap();
        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-1", 1, 2, revision, NOW)
            .unwrap();

        // The deployed step's evaluator sees the rule and reports it.
        let claim = runtime
            .claim_next_playbook_step_or_idle(&project_id, "deploy-1".into(), NOW + 1)
            .unwrap();
        assert_eq!(claim.result["step"]["milestoneId"], "deployed");
        assert_eq!(
            claim.result["step"]["rewind"],
            json!({
                "toMilestoneId": "pr-open",
                "when": "A new fix pull request from the Task branch is open.",
                "maxTimes": 1,
                "reportStatus": "rewind",
            })
        );
        let capability = claim.capability.unwrap();
        // Only the claimed Task can be sent back.
        assert!(matches!(
            runtime.report_steward_step_rewind(
                &capability,
                "task-2",
                "Fix PR #520 is open.".into(),
                "wrong-task".into(),
                NOW + 2,
            ),
            Err(CoreError::TrackerReportInvalid)
        ));
        let result = runtime
            .report_steward_step_rewind(
                &capability,
                "task-1",
                "Fix PR #520 is open.".into(),
                "rewind-1".into(),
                NOW + 2,
            )
            .unwrap();
        assert_eq!(result["status"], "rewound");
        assert_eq!(result["toMilestoneId"], "pr-open");
        assert_eq!(result["rewindCount"], 1);
        assert_eq!(
            position(&runtime, &project_id, "task-1"),
            PlaybookPosition::At(0)
        );
        let deployed = runtime
            .store
            .playbook_step_progress()
            .iter()
            .find(|answer| answer.task_id == "task-1" && answer.milestone_id == "deployed")
            .unwrap()
            .clone();
        assert_eq!(deployed.verdict, PlaybookStepVerdict::Waiting);
        assert_eq!(deployed.rewind_count, 1);
        assert_eq!(
            deployed.evidence,
            "Sent back to “pr-open completed” (1/1): Fix PR #520 is open."
        );
        let view = runtime
            .playbook_runtime(json!({"projectId": project_id}))
            .unwrap();
        assert_eq!(view["steps"][0]["waitingTaskIds"], json!(["task-1"]));
        let progress = view["steps"][1]["progress"].as_array().unwrap();
        let task_one = progress
            .iter()
            .find(|entry| entry["taskId"] == "task-1")
            .unwrap();
        assert_eq!(task_one["rewindCount"], 1);

        // The reopened step has no rule, so it cannot send anything back.
        let claim = runtime
            .claim_next_playbook_step_or_idle(&project_id, "pr-1".into(), NOW + 3)
            .unwrap();
        assert_eq!(claim.result["step"]["milestoneId"], "pr-open");
        assert!(claim.result["step"].get("rewind").is_none());
        let capability = claim.capability.unwrap();
        assert!(matches!(
            runtime.report_steward_step_rewind(
                &capability,
                "task-1",
                "Another PR.".into(),
                "no-rule".into(),
                NOW + 4,
            ),
            Err(CoreError::InvalidParams(_))
        ));
        runtime
            .report_steward_step_verdicts(
                &capability,
                vec![StewardStepVerdict {
                    task_id: "task-1".into(),
                    verdict: PlaybookStepVerdict::Passed,
                    evidence: "Fix PR #520 is open.".into(),
                }],
                "pr-pass".into(),
                NOW + 5,
            )
            .unwrap();

        // Back at the deployed step it is asked at once, and the count
        // survives. A second send-back is past the limit and blocks.
        let claim = runtime
            .claim_next_playbook_step_or_idle(&project_id, "deploy-2".into(), NOW + 6)
            .unwrap();
        assert_eq!(claim.result["step"]["milestoneId"], "deployed");
        let result = runtime
            .report_steward_step_rewind(
                &claim.capability.unwrap(),
                "task-1",
                "Deploy failed again; fix PR #521 is open.".into(),
                "rewind-2".into(),
                NOW + 7,
            )
            .unwrap();
        assert_eq!(result["status"], "verdictsRecorded");
        assert_eq!(result["blockedCount"], 1);
        assert_eq!(
            position(&runtime, &project_id, "task-1"),
            PlaybookPosition::At(1)
        );
        let deployed = runtime
            .store
            .playbook_step_progress()
            .iter()
            .find(|answer| answer.task_id == "task-1" && answer.milestone_id == "deployed")
            .unwrap();
        assert_eq!(deployed.verdict, PlaybookStepVerdict::Blocked);
        assert_eq!(deployed.rewind_count, 1);
        assert!(
            deployed
                .evidence
                .starts_with("Send-back limit reached (1/1)")
        );
        // No evaluator fork ran here, so there is no receipt to mark.
        assert!(
            runtime
                .store
                .playbook_evaluations()
                .iter()
                .all(|record| record.outcome != PlaybookEvaluationOutcome::Rewound)
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn long_send_back_evidence_stays_within_the_stored_bound() {
        let text = format!("Sent back to “x” (1/2): {}", "é".repeat(400));
        let bounded = super::bounded_evidence(&text);
        assert!(bounded.len() <= termloop_domain::PLAYBOOK_EVIDENCE_MAX_BYTES);
        assert!(bounded.ends_with('…'));
    }
}
