//! The delivery pipeline engine: which Task is focused at which question,
//! when it may be asked again, and what one run answers.
//!
//! A step is a per-Task job. The engine keeps advancing one ready Task through
//! consecutive questions, then yields to the next ready Task when the focused
//! one waits or finishes. This prevents one broad question from sweeping every
//! Task and producing interleaved pipeline movement.
//!
//! Nothing here runs on a clock. A question exists as work only while its
//! focused Task is due; with nobody ready it is never claimed.

use std::collections::HashMap;

use crate::{CoreError, CoreRuntime};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use termloop_domain::{
    PendingRoutineFinding, PlaybookConfiguration, PlaybookMilestone, PlaybookPosition,
    PlaybookStepProgress, PlaybookStepVerdict, ROUTINE_PENDING_FINDINGS_MAX,
    ROUTINE_RECENT_SOURCE_KEYS_MAX, ROUTINE_RELATED_TASKS_MAX, RoutineActionHandling, TaskRecord,
    TaskStatus, TrackerConfiguration, TrackerReport, TrackerReportKind, pipeline_position,
};

/// One Task standing at a question, and when it may be asked about again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybookWaitingTask {
    pub task_id: String,
    pub title: String,
    pub due_at_epoch_ms: u64,
    /// What the last run said about this Task, if it has been asked before.
    pub last_evidence: Option<String>,
}

/// One question and the exact focused Task waiting at it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybookStepAssignment {
    pub project_id: String,
    pub milestone: PlaybookMilestone,
    /// Exactly one Task. The wire shape remains an array so the Worker report
    /// contract can stay uniform, but the scheduler never batches Tasks.
    pub waiting: Vec<PlaybookWaitingTask>,
    /// The earliest moment this Task may be answered.
    pub due_at_epoch_ms: u64,
}

/// One Worker-reported answer for one Task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerStepVerdict {
    pub task_id: String,
    pub passed: bool,
    pub evidence: String,
}

/// One open Task, where it stands on its Project's pipeline, and the answers
/// that put it there.
struct PipelineStanding<'a> {
    task: &'a TaskRecord,
    position: PlaybookPosition,
    answers: Vec<&'a PlaybookStepProgress>,
}

impl<'a> PipelineStanding<'a> {
    fn answer_for(&self, milestone_id: &str) -> Option<&'a PlaybookStepProgress> {
        self.answers
            .iter()
            .copied()
            .find(|answer| answer.milestone_id == milestone_id)
    }

    /// A Task that has never been asked is due the moment it arrives; one told
    /// "not yet" waits out the step's delay.
    fn due_at_epoch_ms(&self, milestone_id: &str) -> u64 {
        self.answer_for(milestone_id)
            .and_then(|answer| answer.next_attempt_at_epoch_ms)
            .unwrap_or(0)
    }
}

impl CoreRuntime {
    /// Sets one open Task at an exact level of its Project's active pipeline.
    /// Position remains derived state: the command atomically rebuilds this
    /// Task's current answers so exactly the first `passed_milestone_count`
    /// questions are passed and every later answer is absent.
    pub fn set_task_playbook_position(
        &mut self,
        project_id: &str,
        task_id: &str,
        passed_milestone_count: u64,
        expected_playbook_revision: u64,
        expected_revision: u64,
        decided_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        if expected_revision != self.store.revision() {
            return Err(CoreError::RevisionConflict);
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if task.project_id != project_id {
            return Err(CoreError::NotFound);
        }
        if task.archived_at_epoch_ms.is_some() {
            return Err(CoreError::TaskArchived {
                task_id: task_id.to_owned(),
            });
        }
        if task.status != TaskStatus::Open {
            return Err(CoreError::InvalidParams(
                "Task must be open to change its delivery pipeline position".into(),
            ));
        }

        let playbook = self
            .store
            .playbook_for_project(project_id)
            .ok_or(CoreError::NotFound)?
            .clone();
        if playbook.revision != expected_playbook_revision {
            return Err(CoreError::RevisionConflict);
        }
        let passed_milestone_count = usize::try_from(passed_milestone_count)
            .map_err(|_| CoreError::InvalidParams("passedMilestoneCount".into()))?;
        if passed_milestone_count > playbook.milestones.len() {
            return Err(CoreError::InvalidParams("passedMilestoneCount".into()));
        }

        let current_answers = self
            .store
            .playbook_step_progress()
            .iter()
            .filter(|answer| answer.task_id == task_id)
            .cloned()
            .collect::<Vec<_>>();
        let current_answer_refs = current_answers.iter().collect::<Vec<_>>();
        let previous_position = pipeline_position(&playbook.milestones, &current_answer_refs);
        let answers = playbook
            .milestones
            .iter()
            .take(passed_milestone_count)
            .map(|milestone| {
                current_answers
                    .iter()
                    .find(|answer| {
                        answer.milestone_id == milestone.id
                            && answer.routine_id == milestone.routine_id
                            && answer.verdict == PlaybookStepVerdict::Passed
                    })
                    .cloned()
                    .unwrap_or_else(|| PlaybookStepProgress {
                        task_id: task_id.to_owned(),
                        milestone_id: milestone.id.clone(),
                        routine_id: milestone.routine_id.clone(),
                        verdict: PlaybookStepVerdict::Passed,
                        evidence: "Position set manually from Task details.".into(),
                        decided_at_epoch_ms,
                        next_attempt_at_epoch_ms: None,
                    })
            })
            .collect::<Vec<_>>();

        self.store
            .replace_task_playbook_progress(
                &self.write_authority,
                project_id,
                task_id,
                answers,
                expected_revision,
            )
            .map_err(crate::store_error)?;

        // A report claimed before this explicit user decision must not arrive
        // later and move the Task again. Cancelling the old standing question
        // fences that claim; the newly selected question is due immediately.
        if let PlaybookPosition::At(index) = previous_position {
            self.tracker_runtime
                .cancel_tracker_check(&playbook.milestones[index].routine_id);
        }
        if let Some(milestone) = playbook.milestones.get(passed_milestone_count) {
            self.tracker_runtime
                .schedule_tracker_now(&milestone.routine_id, decided_at_epoch_ms);
        }

        Ok(json!({
            "taskId": task_id,
            "passedMilestoneCount": passed_milestone_count,
            "stateRevision": self.store.revision(),
        }))
    }

    /// Where every open Task of this Project stands, from one pass over the
    /// stored answers. Every question of the pipeline is read from this, so
    /// each Task's position is derived once rather than once per Routine.
    fn pipeline_standings<'a>(
        &'a self,
        playbook: &PlaybookConfiguration,
    ) -> Vec<PipelineStanding<'a>> {
        let mut by_task: HashMap<&str, Vec<&PlaybookStepProgress>> = HashMap::new();
        for progress in self.store.playbook_step_progress() {
            by_task
                .entry(progress.task_id.as_str())
                .or_default()
                .push(progress);
        }
        self.store
            .tasks()
            .iter()
            .filter(|task| {
                task.project_id == playbook.project_id
                    && task.status == TaskStatus::Open
                    && task.archived_at_epoch_ms.is_none()
            })
            .map(|task| {
                let answers = by_task.remove(task.id.as_str()).unwrap_or_default();
                PipelineStanding {
                    task,
                    position: pipeline_position(&playbook.milestones, &answers),
                    answers,
                }
            })
            .collect()
    }

    /// The pipeline this Routine's Project is walking, if both still exist.
    fn routine_playbook(&self, routine_id: &str) -> Option<&PlaybookConfiguration> {
        let routine = self
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == routine_id)?;
        self.store.playbook_for_project(&routine.project_id)
    }

    /// The question this Routine answers next for the Project's focused Task.
    ///
    /// Ready Tasks sort before delayed Tasks, then by the same rank/id ordering
    /// used on the Task board. A Task that passes remains immediately due at
    /// its next question and therefore keeps focus. A waiting Task receives a
    /// future due time, allowing the next ready Task to take focus instead.
    /// A single run contains exactly one Task and one question.
    pub(crate) fn playbook_step_assignment(
        &self,
        routine_id: &str,
    ) -> Option<PlaybookStepAssignment> {
        if let Some(task_id) = self.step_run_now_task_id(routine_id) {
            return self.playbook_step_assignment_for_task(routine_id, task_id);
        }
        let playbook = self.routine_playbook(routine_id)?;
        let standings = self.pipeline_standings(playbook);
        let mut focused: Option<((u64, u64, String), PlaybookStepAssignment)> = None;
        for standing in standings {
            let PlaybookPosition::At(index) = standing.position else {
                continue;
            };
            let milestone = &playbook.milestones[index];
            let due_at_epoch_ms = standing.due_at_epoch_ms(&milestone.id);
            let priority = (
                due_at_epoch_ms,
                standing.task.rank,
                standing.task.id.clone(),
            );
            let assignment = PlaybookStepAssignment {
                project_id: playbook.project_id.clone(),
                milestone: milestone.clone(),
                waiting: vec![PlaybookWaitingTask {
                    task_id: standing.task.id.clone(),
                    title: standing.task.title.clone(),
                    due_at_epoch_ms,
                    last_evidence: standing
                        .answer_for(&milestone.id)
                        .map(|answer| answer.evidence.clone())
                        .filter(|evidence| !evidence.is_empty()),
                }],
                due_at_epoch_ms,
            };
            if focused
                .as_ref()
                .is_none_or(|(current_priority, _)| priority < *current_priority)
            {
                focused = Some((priority, assignment));
            }
        }
        focused
            .map(|(_, assignment)| assignment)
            .filter(|assignment| assignment.milestone.routine_id == routine_id)
    }

    /// The current question for one explicitly selected Task, provided this
    /// Routine owns that exact question. Used only by Task-detail Run Now.
    pub(crate) fn playbook_step_assignment_for_task(
        &self,
        routine_id: &str,
        task_id: &str,
    ) -> Option<PlaybookStepAssignment> {
        let playbook = self.routine_playbook(routine_id)?;
        let standing = self
            .pipeline_standings(playbook)
            .into_iter()
            .find(|standing| standing.task.id == task_id)?;
        let PlaybookPosition::At(index) = standing.position else {
            return None;
        };
        let milestone = &playbook.milestones[index];
        if milestone.routine_id != routine_id {
            return None;
        }
        let due_at_epoch_ms = standing.due_at_epoch_ms(&milestone.id);
        Some(PlaybookStepAssignment {
            project_id: playbook.project_id.clone(),
            milestone: milestone.clone(),
            waiting: vec![PlaybookWaitingTask {
                task_id: standing.task.id.clone(),
                title: standing.task.title.clone(),
                due_at_epoch_ms,
                last_evidence: standing
                    .answer_for(&milestone.id)
                    .map(|answer| answer.evidence.clone())
                    .filter(|evidence| !evidence.is_empty()),
            }],
            due_at_epoch_ms,
        })
    }

    /// When this on-demand Routine next has something to answer, or `None`
    /// when no Task stands at any question it owns.
    ///
    /// Only the Routine owning the focused Task's current question has work.
    /// Every other step stays unscheduled until that Task waits or completes.
    pub(crate) fn playbook_step_due_epoch_ms(&self, routine_id: &str) -> Option<u64> {
        self.playbook_step_assignment(routine_id)
            .map(|assignment| assignment.due_at_epoch_ms)
    }

    /// The question the Routine's current claim was issued for, as the exact
    /// step of the pipeline it belongs to.
    pub(crate) fn claimed_step_milestone(&self, routine_id: &str) -> Option<&PlaybookMilestone> {
        let milestone_id = self.claimed_step_milestone_id(routine_id)?;
        self.routine_playbook(routine_id)?
            .milestones
            .iter()
            .find(|milestone| milestone.id == milestone_id)
    }

    pub(crate) fn step_waiting_finding_is_current(
        &self,
        configuration: &TrackerConfiguration,
        finding: &PendingRoutineFinding,
    ) -> bool {
        if configuration.trigger_mode.is_scheduled()
            || finding.routine_generation != configuration.generation
            || finding.related_task_ids.len() != 1
        {
            return false;
        }
        let Some(playbook) = self.store.playbook_for_project(&configuration.project_id) else {
            return false;
        };
        let task_id = &finding.related_task_ids[0];
        self.pipeline_standings(playbook)
            .into_iter()
            .find(|standing| standing.task.id == *task_id)
            .and_then(|standing| match standing.position {
                PlaybookPosition::At(index) => {
                    let milestone = playbook.milestones.get(index)?;
                    let answer = standing.answer_for(&milestone.id)?;
                    Some(
                        milestone.routine_id == configuration.id
                            && answer.verdict == PlaybookStepVerdict::Waiting
                            && answer.evidence == finding.evidence,
                    )
                }
                PlaybookPosition::Done => None,
            })
            .unwrap_or(false)
    }

    /// Records one run's answer for its exact focused Task and finishes the
    /// claim. This is the on-demand counterpart of
    /// `complete_worker_routine`: a step check reports verdicts, not findings.
    pub fn report_worker_step_verdicts(
        &mut self,
        capability: &super::tracker_runtime::TrackerCheckCapability,
        verdicts: Vec<WorkerStepVerdict>,
        report_id: String,
        completed_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let mut configuration = self.validate_current_check(capability, completed_at_epoch_ms)?;
        if configuration.trigger_mode.is_scheduled() {
            return Err(CoreError::InvalidParams("verdicts".into()));
        }
        // The question answered is the one this claim was issued for. The
        // board may have moved on since; answering the newest question with a
        // run that read the old one would record a verdict nobody asked for.
        let milestone_id = self
            .claimed_step_milestone_id(&capability.tracker_id)
            .ok_or(CoreError::TrackerReportStale)?;
        let task_id = self
            .claimed_step_task_id(&capability.tracker_id)
            .ok_or(CoreError::TrackerReportStale)?;
        let assignment = self
            .playbook_step_assignment(&capability.tracker_id)
            .filter(|assignment| {
                assignment.milestone.id == milestone_id && assignment.waiting[0].task_id == task_id
            })
            .ok_or(CoreError::TrackerReportStale)?;
        if verdicts.len() != assignment.waiting.len() {
            return Err(CoreError::TrackerReportInvalid);
        }
        let mut answers = Vec::with_capacity(verdicts.len());
        for verdict in &verdicts {
            let evidence = verdict.evidence.trim();
            if evidence.is_empty()
                || evidence.len() > termloop_domain::PLAYBOOK_EVIDENCE_MAX_BYTES
                || !assignment
                    .waiting
                    .iter()
                    .any(|task| task.task_id == verdict.task_id)
                || answers
                    .iter()
                    .any(|answer: &PlaybookStepProgress| answer.task_id == verdict.task_id)
            {
                return Err(CoreError::TrackerReportInvalid);
            }
            answers.push(PlaybookStepProgress {
                task_id: verdict.task_id.clone(),
                milestone_id: assignment.milestone.id.clone(),
                routine_id: assignment.milestone.routine_id.clone(),
                verdict: if verdict.passed {
                    PlaybookStepVerdict::Passed
                } else {
                    PlaybookStepVerdict::Waiting
                },
                evidence: evidence.to_owned(),
                decided_at_epoch_ms: completed_at_epoch_ms,
                next_attempt_at_epoch_ms: (!verdict.passed).then(|| {
                    completed_at_epoch_ms.saturating_add(
                        assignment
                            .milestone
                            .retry_delay_seconds
                            .saturating_mul(1_000),
                    )
                }),
            });
        }
        let mut new_pending_findings = Vec::new();
        for (index, answer) in answers.iter().enumerate() {
            if answer.verdict == PlaybookStepVerdict::Passed {
                configuration
                    .pending_routine_findings
                    .retain(|finding| !finding.related_task_ids.contains(&answer.task_id));
                continue;
            }
            let source_key = step_waiting_source_key(
                configuration.kind,
                &assignment.milestone.id,
                &answer.task_id,
                &answer.evidence,
            );
            let same_pending_exists = configuration
                .pending_routine_findings
                .iter()
                .any(|finding| finding.source_key == source_key);
            if same_pending_exists {
                if !configuration.recent_source_keys.contains(&source_key) {
                    configuration.recent_source_keys.push(source_key);
                }
                continue;
            }
            if configuration.action_handling == RoutineActionHandling::Off {
                configuration.recent_source_keys.push(source_key);
                continue;
            }
            let title = assignment
                .waiting
                .iter()
                .find(|task| task.task_id == answer.task_id)
                .map(|task| task.title.as_str())
                .unwrap_or(answer.task_id.as_str());
            let summary = format!("{title} is waiting at “{}”.", assignment.milestone.title);
            if let Some(existing) = configuration
                .pending_routine_findings
                .iter_mut()
                .find(|finding| finding.related_task_ids.contains(&answer.task_id))
            {
                // New evidence may refine the same pending Steward decision,
                // but it must not manufacture another proposal opportunity.
                // Preserve the finding identity and refresh only its current
                // factual observation.
                existing.source_key = source_key.clone();
                existing.summary = summary;
                existing.evidence = answer.evidence.clone();
                existing.source_references.clear();
                existing.created_at_epoch_ms = completed_at_epoch_ms;
                if !configuration.recent_source_keys.contains(&source_key) {
                    configuration.recent_source_keys.push(source_key);
                }
                continue;
            }
            if configuration.recent_source_keys.contains(&source_key) {
                continue;
            }
            if configuration.pending_routine_findings.len() + new_pending_findings.len()
                >= ROUTINE_PENDING_FINDINGS_MAX
            {
                // Leave the source unprocessed so a later retry can surface it
                // after the bounded current review queue has capacity.
                continue;
            }
            configuration.recent_source_keys.push(source_key.clone());
            new_pending_findings.push(PendingRoutineFinding {
                id: format!("{report_id}-{index}"),
                source_key,
                routine_generation: configuration.generation,
                summary,
                evidence: answer.evidence.clone(),
                source_references: vec![],
                related_task_ids: vec![answer.task_id.clone()],
                created_at_epoch_ms: completed_at_epoch_ms,
            });
        }
        if configuration.recent_source_keys.len() > ROUTINE_RECENT_SOURCE_KEYS_MAX {
            configuration.recent_source_keys.drain(
                ..configuration
                    .recent_source_keys
                    .len()
                    .saturating_sub(ROUTINE_RECENT_SOURCE_KEYS_MAX),
            );
        }
        configuration
            .pending_routine_findings
            .extend(new_pending_findings.iter().cloned());

        let passed = answers
            .iter()
            .filter(|answer| answer.verdict == PlaybookStepVerdict::Passed)
            .collect::<Vec<_>>();
        let message = std::iter::once(format!(
            "{} — {} of {} Task(s) passed.",
            assignment.milestone.title,
            passed.len(),
            answers.len(),
        ))
        .chain(answers.iter().map(|answer| {
            format!(
                "- {} {}: {}",
                answer.task_id,
                if answer.verdict == PlaybookStepVerdict::Passed {
                    "passed"
                } else {
                    "waiting"
                },
                answer.evidence,
            )
        }))
        .collect::<Vec<_>>()
        .join("\n");
        let report = TrackerReport {
            id: report_id,
            project_id: capability.project_id.clone(),
            routine_id: capability.tracker_id.clone(),
            check_id: capability.check_id.clone(),
            generation: capability.generation,
            kind: TrackerReportKind::Success,
            message,
            source_references: Vec::new(),
            // Only a passed focused Task moved forward, so only it is named.
            related_task_ids: passed
                .iter()
                .take(ROUTINE_RELATED_TASKS_MAX)
                .map(|answer| answer.task_id.clone())
                .collect(),
            created_at_epoch_ms: completed_at_epoch_ms,
        };
        if !report.is_valid() {
            return Err(CoreError::TrackerReportInvalid);
        }
        configuration.last_check_started_at_epoch_ms = Some(capability.claimed_at_epoch_ms);
        configuration.last_attempt_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.last_successful_report_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.updated_at_epoch_ms = completed_at_epoch_ms;
        self.store
            .record_playbook_step_progress_with_routine(
                &self.write_authority,
                &assignment.project_id,
                answers.clone(),
                configuration.clone(),
                self.store.revision(),
            )
            .map_err(crate::store_error)?;
        self.finish_worker_step_check(capability, completed_at_epoch_ms, &configuration);
        self.push_runtime_report(report);
        let still_waiting = answers.len() - passed.len();
        Ok(json!({
            "status": "verdictsRecorded",
            "milestoneId": assignment.milestone.id,
            "passedCount": passed.len(),
            "waitingCount": still_waiting,
            "newPendingFindingCount": new_pending_findings.len(),
            "stateRevision": self.store.revision(),
        }))
    }

    /// The board's current runtime state: who is standing where, and when each
    /// question is asked again. Derived on every read; nothing here is stored.
    pub fn playbook_runtime(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = crate::required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let Some(playbook) = self.store.playbook_for_project(&project_id) else {
            return Ok(json!({
                "activePipelineName": "",
                "processingTaskId": null,
                "steps": [],
                "doneTaskIds": [],
                "stateRevision": self.store.revision(),
            }));
        };
        let mut waiting_at = vec![Vec::<String>::new(); playbook.milestones.len()];
        let mut done_task_ids = Vec::new();
        for standing in self.pipeline_standings(playbook) {
            match standing.position {
                PlaybookPosition::At(index) => waiting_at[index].push(standing.task.id.clone()),
                PlaybookPosition::Done => done_task_ids.push(standing.task.id.clone()),
            }
        }
        let project_task_ids = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let steps = playbook
            .milestones
            .iter()
            .enumerate()
            .map(|(index, milestone)| {
                let progress = self
                    .store
                    .playbook_step_progress()
                    .iter()
                    .filter(|entry| {
                        entry.milestone_id == milestone.id
                            && entry.routine_id == milestone.routine_id
                            && project_task_ids.contains(entry.task_id.as_str())
                    })
                    .map(|entry| {
                        json!({
                            "taskId": entry.task_id,
                            "verdict": entry.verdict,
                            "evidence": entry.evidence,
                            "decidedAtEpochMs": entry.decided_at_epoch_ms,
                            "nextAttemptAtEpochMs": entry.next_attempt_at_epoch_ms,
                        })
                    })
                    .collect::<Vec<_>>();
                json!({
                    "milestoneId": milestone.id,
                    "routineId": milestone.routine_id,
                    "waitingTaskIds": waiting_at[index],
                    "progress": progress,
                    "nextAttemptAtEpochMs": self
                        .tracker_runtime_next_due_epoch_ms(&milestone.routine_id),
                })
            })
            .collect::<Vec<_>>();
        let processing_task_id = playbook
            .milestones
            .iter()
            .find_map(|milestone| self.claimed_step_task_id(&milestone.routine_id));
        // A pipeline that asks nothing has nobody standing on it; every open
        // Task is reported as done rather than invented into a first step.
        Ok(json!({
            "activePipelineName": playbook.active_pipeline_name,
            "processingTaskId": processing_task_id,
            "steps": steps,
            "doneTaskIds": done_task_ids,
            "stateRevision": self.store.revision(),
        }))
    }
}

fn step_waiting_source_key(
    kind: termloop_domain::TrackerKind,
    milestone_id: &str,
    task_id: &str,
    evidence: &str,
) -> String {
    let mut digest = Sha256::new();
    for part in [milestone_id, task_id, evidence] {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    let digest = digest.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    format!(
        "{}step-waiting:{hex}",
        super::tracker_runtime::routine_source_prefix(kind)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use termloop_domain::{
        AgentLaunchSelection, PlaybookConfiguration, PlaybookGateKind, PlaybookMilestone,
        ProcessDescriptor, RoutineTriggerMode, SessionKind, SessionRecord, StewardAgentId,
        TaskRecord, TrackerConfiguration, TrackerKind, WorkerConfiguration,
    };
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::TerminalService;

    const NOW: u64 = 1_000_000;

    fn milestone(id: &str, routine_id: &str, retry: u64) -> PlaybookMilestone {
        PlaybookMilestone {
            id: id.into(),
            title: format!("{id} completed"),
            gate: PlaybookGateKind::Automatic,
            routine_id: routine_id.into(),
            retry_delay_seconds: retry,
            condition: String::new(),
            approver: None,
        }
    }

    /// A Project with two stages, evaluated by two step Routines in one enabled
    /// Worker, and two open Tasks on it.
    fn pipeline_runtime() -> (CoreRuntime, std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!(
            "termloop-core-playbook-runtime-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut runtime = CoreRuntime::new(
            Store::open(root.join("state.json")).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        let project_id = runtime
            .handle(
                "project.create",
                json!({"name":"Pipeline","folderPath":root}),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let revision = runtime.store.revision();
        runtime
            .store
            .set_worker_configuration(
                &runtime.write_authority,
                WorkerConfiguration {
                    id: "worker-1".into(),
                    project_id: project_id.clone(),
                    name: "Pipeline Worker".into(),
                    agent_id: StewardAgentId::Codex,
                    model: "default".into(),
                    permission: "bypassPermissions".into(),
                    reasoning: "default".into(),
                    enabled: true,
                    ping_interval_seconds: 60,
                    worker_prompt: String::new(),
                    system_prompt: String::new(),
                    executor_session_id: None,
                    generation: 1,
                    updated_at_epoch_ms: 100,
                },
                revision,
            )
            .unwrap();
        runtime
            .store
            .attach_worker_executor_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "worker-session".into(),
                    project_id: project_id.clone(),
                    name: Some("Pipeline Worker".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: root.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.worker.executor".into()),
                        template_version: Some(10),
                    },
                    launch_selection: AgentLaunchSelection::default(),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
                "worker-1",
                1,
                100,
            )
            .unwrap();
        for routine_id in ["routine-pr", "routine-deploy"] {
            let revision = runtime.store.revision();
            runtime
                .store
                .set_tracker_configuration(
                    &runtime.write_authority,
                    TrackerConfiguration {
                        id: routine_id.into(),
                        project_id: project_id.clone(),
                        kind: TrackerKind::CiPr,
                        trigger_mode: RoutineTriggerMode::OnDemand,
                        name: routine_id.into(),
                        prompt: "Answer the pipeline question for the focused Task.".into(),
                        steward_instructions: String::new(),
                        worker_id: "worker-1".into(),
                        enabled: true,
                        schedule_interval_seconds: 60,
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
                        updated_at_epoch_ms: 100,
                    },
                    revision,
                )
                .unwrap();
        }
        for task_id in ["task-1", "task-2"] {
            runtime
                .store
                .insert_task(
                    &runtime.write_authority,
                    TaskRecord {
                        id: task_id.into(),
                        project_id: project_id.clone(),
                        title: task_id.into(),
                        brief: None,
                        status: termloop_domain::TaskStatus::Open,
                        archived_at_epoch_ms: None,
                        branch: None,
                        worktree: None,
                        worktree_generation: 0,
                        steward_brief_markdown: String::new(),
                        steward_brief_revision: 1,
                        rank: 0,
                        created_at_epoch_ms: 1,
                        updated_at_epoch_ms: 1,
                    },
                )
                .unwrap();
        }
        let revision = runtime.store.revision();
        runtime
            .store
            .set_playbook_configuration(
                &runtime.write_authority,
                PlaybookConfiguration {
                    project_id: project_id.clone(),
                    revision: 1,
                    active_pipeline_name: "Ship to production".into(),
                    milestones: vec![
                        milestone("pr-open", "routine-pr", 600),
                        milestone("deployed", "routine-deploy", 3600),
                    ],
                    saved_pipelines: Vec::new(),
                    updated_at_epoch_ms: 100,
                },
                revision,
            )
            .unwrap();
        (runtime, root, project_id)
    }

    #[test]
    fn task_position_set_rebuilds_answers_and_fences_an_older_claim() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let initial_revision = runtime.state_revision();

        let moved = runtime
            .set_task_playbook_position(&project_id, "task-1", 1, 1, initial_revision, NOW)
            .unwrap();
        assert_eq!(moved["passedMilestoneCount"], 1);
        let runtime_view = runtime
            .playbook_runtime(json!({"projectId": project_id}))
            .unwrap();
        assert_eq!(
            runtime_view["steps"][0]["waitingTaskIds"],
            json!(["task-2"])
        );
        assert_eq!(
            runtime_view["steps"][1]["waitingTaskIds"],
            json!(["task-1"])
        );
        assert_eq!(
            runtime_view["steps"][0]["progress"][0]["evidence"],
            "Position set manually from Task details."
        );

        assert!(matches!(
            runtime.set_task_playbook_position(
                &project_id,
                "task-1",
                0,
                1,
                initial_revision,
                NOW + 1,
            ),
            Err(CoreError::RevisionConflict)
        ));
        assert!(matches!(
            runtime.set_task_playbook_position(
                &project_id,
                "task-1",
                3,
                1,
                runtime.state_revision(),
                NOW + 1,
            ),
            Err(CoreError::InvalidParams(_))
        ));

        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-1", 0, 1, revision, NOW + 2)
            .unwrap();
        let claim = runtime
            .claim_next_worker_routine(
                &project_id,
                "worker-session",
                "position-claim".into(),
                NOW + 2,
            )
            .unwrap();
        let capability = claim.capability.unwrap();
        assert_eq!(capability.tracker_id, "routine-pr");

        // Setting the same visible level is still an explicit reset: it drops
        // retry evidence and fences the answer already in flight.
        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-1", 0, 1, revision, NOW + 3)
            .unwrap();
        assert!(matches!(
            runtime.report_worker_step_verdicts(
                &capability,
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "This answer was claimed before the reset.".into(),
                }],
                "stale-position-report".into(),
                NOW + 4,
            ),
            Err(CoreError::TrackerReportStale)
        ));

        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-1", 2, 1, revision, NOW + 5)
            .unwrap();
        let runtime_view = runtime
            .playbook_runtime(json!({"projectId": project_id}))
            .unwrap();
        assert_eq!(runtime_view["doneTaskIds"], json!(["task-1"]));
        assert_eq!(
            runtime
                .store
                .playbook_step_progress()
                .iter()
                .filter(|answer| answer.task_id == "task-1")
                .count(),
            2
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn get_next_retires_a_claim_for_a_step_the_playbook_replaced() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let old_claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "old-step-check".into(), NOW)
            .unwrap();
        let old_capability = old_claim.capability.unwrap();
        assert_eq!(old_claim.result["step"]["milestoneId"], "pr-open");

        // Simulate a durable Playbook replacement that lands while the Worker
        // is still inspecting the old step. Runtime cleanup is intentionally
        // skipped here: get-next is the recovery boundary for this state.
        let mut playbook = runtime
            .store
            .playbook_for_project(&project_id)
            .unwrap()
            .clone();
        playbook.revision += 1;
        playbook.milestones[0].id = "pr-open-replaced".into();
        playbook.updated_at_epoch_ms = NOW + 1;
        let revision = runtime.store.revision();
        runtime
            .store
            .set_playbook_configuration(&runtime.write_authority, playbook, revision)
            .unwrap();

        let fresh_claim = runtime
            .claim_next_worker_routine(
                &project_id,
                "worker-session",
                "fresh-step-check".into(),
                NOW + 2,
            )
            .unwrap();
        let fresh_capability = fresh_claim.capability.unwrap();
        assert_eq!(fresh_capability.check_id, "fresh-step-check");
        assert_ne!(fresh_capability.check_id, old_capability.check_id);
        assert_eq!(
            fresh_claim.result["step"]["milestoneId"],
            "pr-open-replaced"
        );
        assert!(matches!(
            runtime.report_worker_step_verdicts(
                &old_capability,
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "This answer belongs to the replaced step.".into(),
                }],
                "stale-old-step-report".into(),
                NOW + 3,
            ),
            Err(CoreError::TrackerReportStale)
        ));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn get_next_retires_a_claim_when_focus_changes_at_the_same_step() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let old_claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "task-1-check".into(), NOW)
            .unwrap();
        let old_capability = old_claim.capability.unwrap();
        assert_eq!(old_claim.result["step"]["milestoneId"], "pr-open");
        assert_eq!(old_claim.result["step"]["tasks"][0]["taskId"], "task-1");

        // Closing the focused Task changes the assignment to task-2 without
        // changing the milestone. Simulate the durable mutation without the
        // normal runtime cleanup so get-next proves its own recovery boundary.
        runtime
            .store
            .set_task_status(
                &runtime.write_authority,
                "task-1",
                TaskStatus::Closed,
                NOW + 1,
            )
            .unwrap();

        let fresh_claim = runtime
            .claim_next_worker_routine(
                &project_id,
                "worker-session",
                "task-2-check".into(),
                NOW + 2,
            )
            .unwrap();
        assert_eq!(
            fresh_claim.capability.as_ref().unwrap().check_id,
            "task-2-check"
        );
        assert_eq!(fresh_claim.result["step"]["milestoneId"], "pr-open");
        assert_eq!(fresh_claim.result["step"]["tasks"][0]["taskId"], "task-2");
        assert!(matches!(
            runtime.report_worker_step_verdicts(
                &old_capability,
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "This answer belongs to the former focused Task.".into(),
                }],
                "stale-task-1-report".into(),
                NOW + 3,
            ),
            Err(CoreError::TrackerReportStale)
        ));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn one_task_keeps_focus_across_steps_before_the_next_task_starts() {
        let (mut runtime, root, project_id) = pipeline_runtime();

        // Both Tasks are at the first stage, but the claim carries only the
        // first Task in board order.
        let claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-1".into(), NOW)
            .unwrap();
        assert_eq!(claim.result["status"], "assigned");
        assert_eq!(claim.result["routine"]["id"], "routine-pr");
        assert_eq!(claim.result["step"]["milestoneId"], "pr-open");
        assert_eq!(claim.result["step"]["title"], "pr-open completed");
        assert!(claim.result["step"].get("question").is_none());
        assert_eq!(
            claim.result["step"]["finishWith"],
            "worker_report_step_verdicts"
        );
        assert_eq!(
            claim.result["step"]["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|task| task["taskId"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            vec!["task-1"]
        );
        assert_eq!(
            runtime
                .playbook_runtime(json!({"projectId": project_id}))
                .unwrap()["processingTaskId"],
            "task-1"
        );
        let capability = claim.capability.expect("a step check issues a capability");

        // Passing advances only the focused Task.
        let recorded = runtime
            .report_worker_step_verdicts(
                &capability,
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "PR #12 is open against main.".into(),
                }],
                "report-1".into(),
                NOW + 1_000,
            )
            .unwrap();
        assert_eq!(recorded["passedCount"], 1);
        assert_eq!(recorded["waitingCount"], 0);
        assert_eq!(
            runtime
                .playbook_runtime(json!({"projectId": project_id}))
                .unwrap()["processingTaskId"],
            Value::Null
        );

        // Position remains per Task: task-1 moved, task-2 has not started.
        let runtime_view = runtime
            .playbook_runtime(json!({"projectId": project_id}))
            .unwrap();
        let steps = runtime_view["steps"].as_array().unwrap();
        assert_eq!(steps[0]["waitingTaskIds"], json!(["task-2"]));
        assert_eq!(steps[1]["waitingTaskIds"], json!(["task-1"]));
        assert_eq!(runtime_view["doneTaskIds"], json!([]));

        // task-1 stays focused at its next question instead of sweeping
        // task-2 through the first question.
        let next = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-2".into(), NOW + 2_000)
            .unwrap();
        assert_eq!(next.result["routine"]["id"], "routine-deploy");
        assert_eq!(next.result["step"]["tasks"][0]["taskId"], "task-1");
        assert_eq!(
            next.result["step"]["tasks"].as_array().unwrap().len(),
            1,
            "a step claim always carries one focused Task"
        );
        runtime
            .report_worker_step_verdicts(
                &next.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "The deployed commit matches task-1 HEAD.".into(),
                }],
                "report-2".into(),
                NOW + 3_000,
            )
            .unwrap();

        // Only after task-1 finishes does task-2 begin at the first step.
        let following = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-3".into(), NOW + 4_000)
            .unwrap();
        assert_eq!(following.result["routine"]["id"], "routine-pr");
        assert_eq!(following.result["step"]["tasks"][0]["taskId"], "task-2");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_question_nobody_is_waiting_at_is_not_work() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-1", 1, 1, revision, NOW)
            .unwrap();
        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-2", 1, 1, revision, NOW)
            .unwrap();

        // Nobody is left at the first question, so it has no next moment at
        // all — it is not scheduled, not merely far away.
        assert!(runtime.playbook_step_due_epoch_ms("routine-pr").is_none());

        // Both Tasks moved to the second question, but it still claims them
        // one at a time.
        let next = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-2".into(), NOW + 2_000)
            .unwrap();
        assert_eq!(next.result["routine"]["id"], "routine-deploy");
        assert_eq!(next.result["step"]["tasks"][0]["taskId"], "task-1");
        runtime
            .report_worker_step_verdicts(
                &next.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "Deployed commit matches the branch head.".into(),
                }],
                "report-2".into(),
                NOW + 3_000,
            )
            .unwrap();
        let final_claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-3".into(), NOW + 4_000)
            .unwrap();
        assert_eq!(final_claim.result["step"]["tasks"][0]["taskId"], "task-2");
        runtime
            .report_worker_step_verdicts(
                &final_claim.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-2".into(),
                    passed: true,
                    evidence: "Deployed commit matches the branch head.".into(),
                }],
                "report-3".into(),
                NOW + 5_000,
            )
            .unwrap();

        // With every question answered the pipeline has no work left, so the
        // Worker is idle rather than looping on a clock.
        let idle = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-4".into(), NOW + 6_000)
            .unwrap();
        assert_eq!(idle.result["status"], "idle");
        assert!(idle.capability.is_none());

        let view = runtime
            .playbook_runtime(json!({"projectId": project_id}))
            .unwrap();
        assert_eq!(view["doneTaskIds"], json!(["task-1", "task-2"]));
        assert_eq!(view["steps"][0]["waitingTaskIds"], json!([]));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn run_now_overrides_the_step_delay_but_invents_no_work() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-1".into(), NOW)
            .unwrap();
        let capability = claim.capability.unwrap();
        runtime
            .report_worker_step_verdicts(
                &capability,
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: false,
                    evidence: "No branch pushed yet.".into(),
                }],
                "report-1".into(),
                NOW + 1_000,
            )
            .unwrap();

        // A waiting focused Task yields immediately to the next ready Task,
        // even though both use the same Routine.
        let switched = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-2".into(), NOW + 2_000)
            .unwrap();
        assert_eq!(switched.result["step"]["tasks"][0]["taskId"], "task-2");
        runtime
            .report_worker_step_verdicts(
                &switched.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-2".into(),
                    passed: false,
                    evidence: "No branch pushed yet.".into(),
                }],
                "report-2".into(),
                NOW + 3_000,
            )
            .unwrap();

        // Both Tasks now wait out their own 10-minute delay.
        let idle = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "idle".into(), NOW + 4_000)
            .unwrap();
        assert_eq!(idle.result["status"], "idle");

        // "Run now" is the user overriding exactly that delay.
        assert!(runtime.run_routine_now("routine-pr", NOW + 5_000).unwrap());
        let forced = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-3".into(), NOW + 5_000)
            .unwrap();
        assert_eq!(forced.result["routine"]["id"], "routine-pr");
        assert_eq!(forced.result["step"]["tasks"][0]["taskId"], "task-1");

        // The override lasts one run: finishing puts the step back on its own
        // delay rather than leaving it permanently hot.
        let capability = forced.capability.unwrap();
        runtime
            .report_worker_step_verdicts(
                &capability,
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: false,
                    evidence: "Still nothing pushed.".into(),
                }],
                "report-3".into(),
                NOW + 6_000,
            )
            .unwrap();
        assert_eq!(
            runtime
                .claim_next_worker_routine(
                    &project_id,
                    "worker-session",
                    "check-4".into(),
                    NOW + 7_000,
                )
                .unwrap()
                .result["status"],
            "idle"
        );

        // A claim handed back unused spends nothing: the run never happened, so
        // the user's "Run now" is still waiting to.
        assert!(runtime.run_routine_now("routine-pr", NOW + 8_000).unwrap());
        let handed_back = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-5".into(), NOW + 8_000)
            .unwrap();
        assert!(runtime.release_worker_routine_claim(&handed_back.capability.unwrap()));
        assert_eq!(
            runtime
                .claim_next_worker_routine(
                    &project_id,
                    "worker-session",
                    "check-6".into(),
                    NOW + 9_000,
                )
                .unwrap()
                .result["routine"]["id"],
            "routine-pr"
        );

        // And a question nobody stands at cannot be run at all — the button
        // says so instead of reporting a run the schedule would drop.
        assert!(matches!(
            runtime.run_routine_now("routine-deploy", NOW + 10_000),
            Err(CoreError::PlaybookStepIdle)
        ));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn task_detail_run_now_targets_that_task_instead_of_the_global_focus() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-1", 1, 1, revision, NOW)
            .unwrap();

        // Normal scheduling keeps task-1 focused at the second question, so a
        // general request for the first Routine correctly has no focused work.
        assert!(matches!(
            runtime.run_routine_now("routine-pr", NOW + 1_000),
            Err(CoreError::PlaybookStepIdle)
        ));
        assert!(matches!(
            runtime.run_task_routine_now("routine-pr", "task-1", NOW + 1_000),
            Err(CoreError::PlaybookStepIdle)
        ));

        // Task details names task-2 explicitly. That one-shot request outranks
        // the normal focused question and claims exactly the selected Task.
        assert!(
            runtime
                .run_task_routine_now("routine-pr", "task-2", NOW + 2_000)
                .unwrap()
        );
        let claim = runtime
            .claim_next_worker_routine(
                &project_id,
                "worker-session",
                "task-detail-check".into(),
                NOW + 2_000,
            )
            .unwrap();
        assert_eq!(claim.result["routine"]["id"], "routine-pr");
        assert_eq!(claim.result["step"]["tasks"][0]["taskId"], "task-2");
        assert_eq!(
            runtime
                .playbook_runtime(json!({"projectId": project_id}))
                .unwrap()["processingTaskId"],
            "task-2"
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_verdict_answers_only_the_claimed_question_for_the_focused_task() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-1".into(), NOW)
            .unwrap();
        let capability = claim.capability.unwrap();

        // A Task that is not standing at this question cannot be answered for.
        assert!(matches!(
            runtime.report_worker_step_verdicts(
                &capability,
                vec![WorkerStepVerdict {
                    task_id: "task-missing".into(),
                    passed: true,
                    evidence: "Invented.".into(),
                }],
                "report-1".into(),
                NOW + 1_000,
            ),
            Err(CoreError::TrackerReportInvalid)
        ));

        // `passed` always carries the evidence it rests on.
        assert!(matches!(
            runtime.report_worker_step_verdicts(
                &capability,
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "   ".into(),
                }],
                "report-1".into(),
                NOW + 1_000,
            ),
            Err(CoreError::TrackerReportInvalid)
        ));

        // A claim that never answered still backs off, so a Worker that
        // finishes without verdicts cannot spin on the same question.
        let configuration = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == "routine-pr")
            .cloned()
            .unwrap();
        runtime.finish_worker_routine_check(&capability, None, NOW + 1_000, &configuration);
        let next = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-2".into(), NOW + 2_000)
            .unwrap();
        assert_ne!(next.result["routine"]["id"], "routine-pr");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn materially_new_waiting_evidence_refreshes_the_pending_steward_decision() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-2", 2, 1, revision, NOW - 1)
            .unwrap();
        let mut routine = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == "routine-pr")
            .cloned()
            .unwrap();
        routine.action_handling = termloop_domain::RoutineActionHandling::Ask;
        routine.steward_instructions =
            "If review is still missing, consider asking the configured reviewer.".into();
        let revision = runtime.state_revision();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, routine, revision)
            .unwrap();

        let claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-1".into(), NOW)
            .unwrap();
        assert!(claim.result["routine"].get("actionHandling").is_none());
        assert!(claim.result["routine"].get("stewardInstructions").is_none());
        let first = runtime
            .report_worker_step_verdicts(
                &claim.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: false,
                    evidence: "No matching pull-request approval is visible.".into(),
                }],
                "report-1".into(),
                NOW + 1_000,
            )
            .unwrap();
        assert_eq!(first["newPendingFindingCount"], 1);
        let findings = runtime.read_routine_findings(&project_id).unwrap();
        assert_eq!(findings["routines"][0]["routineId"], "routine-pr");
        assert_eq!(findings["routines"][0]["actionHandling"], "ask");
        assert_eq!(
            findings["routines"][0]["stewardInstructions"],
            "If review is still missing, consider asking the configured reviewer."
        );
        let first_finding_id = findings["routines"][0]["findings"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        assert!(runtime.run_routine_now("routine-pr", NOW + 2_000).unwrap());
        let changed_claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-2".into(), NOW + 2_000)
            .unwrap();
        let changed = runtime
            .report_worker_step_verdicts(
                &changed_claim.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: false,
                    evidence: "The PR exists, but its required reviewer has not approved it."
                        .into(),
                }],
                "report-2".into(),
                NOW + 3_000,
            )
            .unwrap();
        assert_eq!(changed["newPendingFindingCount"], 0);
        let findings = runtime.read_routine_findings(&project_id).unwrap();
        assert_eq!(
            findings["routines"][0]["findings"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            findings["routines"][0]["findings"][0]["id"],
            first_finding_id
        );
        assert_eq!(
            findings["routines"][0]["findings"][0]["evidence"],
            "The PR exists, but its required reviewer has not approved it."
        );

        assert!(runtime.run_routine_now("routine-pr", NOW + 4_000).unwrap());
        let duplicate_claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-3".into(), NOW + 4_000)
            .unwrap();
        let duplicate = runtime
            .report_worker_step_verdicts(
                &duplicate_claim.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: false,
                    evidence: "The PR exists, but its required reviewer has not approved it."
                        .into(),
                }],
                "report-3".into(),
                NOW + 5_000,
            )
            .unwrap();
        assert_eq!(duplicate["newPendingFindingCount"], 0);
        assert_eq!(
            runtime.read_routine_findings(&project_id).unwrap()["routines"][0]["findings"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        assert!(runtime.run_routine_now("routine-pr", NOW + 6_000).unwrap());
        let passed_claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-4".into(), NOW + 6_000)
            .unwrap();
        let passed = runtime
            .report_worker_step_verdicts(
                &passed_claim.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: true,
                    evidence: "The required approval is now visible.".into(),
                }],
                "report-4".into(),
                NOW + 7_000,
            )
            .unwrap();
        assert_eq!(passed["passedCount"], 1);
        assert_eq!(passed["newPendingFindingCount"], 0);
        assert_eq!(
            runtime.read_routine_findings(&project_id).unwrap()["routines"],
            json!([])
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_waiting_finding_cannot_be_resolved_after_the_task_moves() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let mut routine = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == "routine-pr")
            .cloned()
            .unwrap();
        routine.action_handling = termloop_domain::RoutineActionHandling::Auto;
        routine.steward_instructions = "Notify the configured reviewer.".into();
        let revision = runtime.state_revision();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, routine, revision)
            .unwrap();
        let claim = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-1".into(), NOW)
            .unwrap();
        runtime
            .report_worker_step_verdicts(
                &claim.capability.unwrap(),
                vec![WorkerStepVerdict {
                    task_id: "task-1".into(),
                    passed: false,
                    evidence: "Approval is absent.".into(),
                }],
                "report-1".into(),
                NOW + 1_000,
            )
            .unwrap();
        let finding_id =
            runtime.read_routine_findings(&project_id).unwrap()["routines"][0]["findings"][0]["id"]
                .as_str()
                .unwrap()
                .to_owned();

        let revision = runtime.state_revision();
        runtime
            .set_task_playbook_position(&project_id, "task-1", 1, 1, revision, NOW + 2_000)
            .unwrap();
        assert_eq!(
            runtime.read_routine_findings(&project_id).unwrap()["routines"],
            json!([])
        );
        assert!(
            runtime
                .store
                .tracker_configurations()
                .iter()
                .find(|routine| routine.id == "routine-pr")
                .unwrap()
                .pending_routine_findings
                .is_empty()
        );
        assert!(matches!(
            runtime.resolve_routine_finding(&project_id, &finding_id, "completed", NOW + 3_000,),
            Err(CoreError::NotFound)
        ));

        std::fs::remove_dir_all(root).ok();
    }
}
