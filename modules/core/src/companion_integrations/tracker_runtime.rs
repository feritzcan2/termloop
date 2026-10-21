//! Bounded Routine scheduling, Steward claims, and current reports.
//!
//! A scheduled Routine runs one Steward-held check at a time. A Playbook step
//! runs one independent check per Task standing at it, so one Task's check,
//! verdict, retry, or move never waits on or invalidates another Task's.

use std::collections::{HashMap, VecDeque};

mod report;
mod run_now;
mod step_claims;
mod steward_claims;

use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use termloop_domain::{
    PendingRoutineFinding, ROUTINE_CONTEXT_MAX_BYTES, ROUTINE_FINDING_EVIDENCE_MAX_BYTES,
    ROUTINE_FINDING_SUMMARY_MAX_BYTES, ROUTINE_PENDING_FINDINGS_MAX,
    ROUTINE_RECENT_SOURCE_KEYS_MAX, ROUTINE_RELATED_TASKS_MAX, ROUTINE_SOURCE_KEY_MAX_BYTES,
    RoutineActionHandling, TRACKER_REPORT_SOURCE_REF_MAX_BYTES, TRACKER_REPORT_SOURCE_REFS_MAX,
    TRACKER_REPORTS_PER_PROJECT_MAX, TrackerConfiguration, TrackerReport, TrackerReportKind,
};

const CHECK_DEADLINE_MAX_MS: u64 = 10 * 60 * 1_000;
const OVERDUE_PING_GRACE_MS: u64 = 60 * 1_000;
const CHECK_TIMEOUT_RETRY_MS: u64 = 60 * 1_000;
const WAKE_REDELIVERY_MS: u64 = 60 * 1_000;
const ROUTINE_SCAN_OVERLAP_MS: u64 = 5 * 60 * 1_000;
const ROUTINE_REPORT_PROJECTION_MAX_ENCODED_BYTES: usize = 3 * 1024 * 1024;
/// Independent Playbook step checks one Project may run at once. Each runs in
/// its own evaluation fork, so this bounds concurrent agent processes.
const PROJECT_STEP_CHECKS_MAX: usize = 8;

#[derive(Debug, Clone)]
struct ActiveTrackerCheck {
    check_id: String,
    /// The exact pipeline question this claim was issued for, when the Routine
    /// is a step check. A later verdict must answer that question, not
    /// whichever one the board happens to show when the answer arrives.
    step_milestone_id: Option<String>,
    /// The exact Task paired with `step_milestone_id`. A board edit may leave
    /// the same question current while changing which Task has focus; both
    /// values must still match before a claim can be reused or reported.
    step_task_id: Option<String>,
    /// Who will answer this step claim, and why a deterministic check did
    /// not. Lives and dies with the claim; never stored.
    step_evaluation: (
        termloop_domain::PlaybookStepEvaluator,
        Option<termloop_domain::PlaybookDeterministicFallback>,
    ),
    generation: u64,
    claimed_at_epoch_ms: u64,
    deadline_epoch_ms: u64,
    ping_sent: bool,
    project_id: String,
    steward_generation: u64,
    steward_session_id: String,
}

#[derive(Debug, Clone, Default)]
struct TrackerHealth {
    /// A scheduled Routine holds at most one check. A step Routine holds at
    /// most one check per Task.
    checks: Vec<ActiveTrackerCheck>,
    pending_trigger: bool,
    attention_message: Option<String>,
}

impl TrackerHealth {
    fn check(&self, check_id: &str) -> Option<&ActiveTrackerCheck> {
        self.checks.iter().find(|check| check.check_id == check_id)
    }

    fn checks_task(&self, task_id: &str) -> bool {
        self.checks
            .iter()
            .any(|check| check.step_task_id.as_deref() == Some(task_id))
    }

    fn remove_check(&mut self, check_id: &str) {
        self.checks.retain(|check| check.check_id != check_id);
    }
}

#[derive(Debug, Clone)]
struct PendingStewardWake {
    steward_session_id: String,
    retry_at_epoch_ms: u64,
}

#[derive(Default)]
pub(crate) struct TrackerRuntimeState {
    health: HashMap<String, TrackerHealth>,
    reports: VecDeque<TrackerReport>,
    next_due_epoch_ms: HashMap<String, u64>,
    pending_steward_wakes: HashMap<String, PendingStewardWake>,
    /// "Run now": the user overriding a step's own delay for one run.
    step_run_now: HashMap<String, StepRunNow>,
    /// Earliest moment one Task's check at one step may be claimed again. A
    /// step's due time is otherwise derived entirely from stored verdicts, so
    /// without this a run that answered nothing would be due again the instant
    /// it finished. It holds back only that Task, never others at the step.
    step_task_not_before: HashMap<(String, String), u64>,
}

#[derive(Debug, Clone)]
struct StepRunNow {
    at_epoch_ms: u64,
    /// An exact Task selected from Task details. `None` runs the step's next
    /// Task.
    task_id: Option<String>,
}

impl TrackerRuntimeState {
    pub(crate) fn tracker_is_active(&self, routine_id: &str) -> bool {
        self.health
            .get(routine_id)
            .is_some_and(|health| !health.checks.is_empty())
    }

    pub(crate) fn step_task_is_checked(&self, routine_id: &str, task_id: &str) -> bool {
        self.health
            .get(routine_id)
            .is_some_and(|health| health.checks_task(task_id))
    }

    pub(crate) fn cancel_tracker_check(&mut self, routine_id: &str) {
        self.health.remove(routine_id);
        self.next_due_epoch_ms.remove(routine_id);
        self.step_run_now.remove(routine_id);
        self.step_task_not_before
            .retain(|(routine, _), _| routine != routine_id);
    }

    /// Cancels only one Task's check and wait at a step. Checks running for
    /// other Tasks at the same step keep their claims.
    pub(crate) fn cancel_step_task_check(&mut self, routine_id: &str, task_id: &str) {
        if let Some(health) = self.health.get_mut(routine_id) {
            health
                .checks
                .retain(|check| check.step_task_id.as_deref() != Some(task_id));
        }
        self.step_task_not_before
            .remove(&(routine_id.to_owned(), task_id.to_owned()));
        if self
            .step_run_now
            .get(routine_id)
            .is_some_and(|run_now| run_now.task_id.as_deref() == Some(task_id))
        {
            self.step_run_now.remove(routine_id);
        }
    }

    pub(crate) fn remove_tracker(&mut self, routine_id: &str) {
        self.cancel_tracker_check(routine_id);
        self.reports
            .retain(|report| report.routine_id != routine_id);
    }

    pub(crate) fn schedule_tracker_now(&mut self, routine_id: &str, now_epoch_ms: u64) {
        self.next_due_epoch_ms
            .insert(routine_id.to_owned(), now_epoch_ms);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackerCheckCapability {
    pub project_id: String,
    pub tracker_id: String,
    pub check_id: String,
    pub generation: u64,
    pub claimed_at_epoch_ms: u64,
    pub deadline_epoch_ms: u64,
    pub steward_generation: u64,
    pub steward_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueStewardWake {
    pub project_id: String,
    pub steward_generation: u64,
    pub steward_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutineFinding {
    pub id: String,
    pub source_key: String,
    pub summary: String,
    pub evidence: String,
    pub source_references: Vec<String>,
    pub related_task_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct StewardRoutineClaim {
    pub capability: Option<TrackerCheckCapability>,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackerDeadlineAdvance {
    pub changed: bool,
}

impl CoreRuntime {
    fn initialize_routine_schedules(&mut self) {
        let enabled = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|configuration| configuration.enabled)
            .map(|configuration| configuration.id.clone())
            .collect::<std::collections::HashSet<_>>();
        self.tracker_runtime
            .next_due_epoch_ms
            .retain(|routine_id, _| enabled.contains(routine_id));
        // A step check has no cadence of its own. Its due time is derived from
        // the Tasks standing at its question right now, so it is recomputed on
        // every pass rather than remembered: a Task arriving, passing, or being
        // deleted changes the answer immediately.
        let scheduled = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|configuration| configuration.enabled)
            .map(|configuration| {
                (
                    configuration.id.clone(),
                    configuration.trigger_mode.is_scheduled(),
                    routine_next_due(configuration),
                )
            })
            .collect::<Vec<_>>();
        for (routine_id, is_scheduled, cadence_due) in scheduled {
            if is_scheduled {
                self.tracker_runtime
                    .next_due_epoch_ms
                    .entry(routine_id)
                    .or_insert(cadence_due);
                continue;
            }
            // The due time already includes each Task's own wait and skips
            // Tasks whose check is running.
            match self.playbook_step_due_epoch_ms(&routine_id) {
                Some(due) => {
                    // "Run now" is the user overriding exactly the wait this
                    // would otherwise sit out. Once its Task is being checked,
                    // the step returns to the next Task's own due time.
                    let next = self
                        .tracker_runtime
                        .step_run_now
                        .get(&routine_id)
                        .filter(|run_now| {
                            run_now.task_id.as_deref().is_none_or(|task_id| {
                                !self
                                    .tracker_runtime
                                    .step_task_is_checked(&routine_id, task_id)
                            })
                        })
                        .map_or(due, |run_now| run_now.at_epoch_ms.min(due));
                    self.tracker_runtime
                        .next_due_epoch_ms
                        .insert(routine_id, next);
                }
                // No unchecked Task is waiting at this question, so there is no
                // job. An override with nothing to run is dropped.
                None => {
                    self.tracker_runtime.next_due_epoch_ms.remove(&routine_id);
                    self.tracker_runtime.step_run_now.remove(&routine_id);
                }
            }
        }
    }

    pub(crate) fn tracker_runtime_next_due_epoch_ms(&self, routine_id: &str) -> Option<u64> {
        self.tracker_runtime
            .next_due_epoch_ms
            .get(routine_id)
            .copied()
    }

    fn claimed_check(&self, capability: &TrackerCheckCapability) -> Option<&ActiveTrackerCheck> {
        self.tracker_runtime
            .health
            .get(&capability.tracker_id)?
            .check(&capability.check_id)
    }

    /// The question this exact claim was issued for.
    pub(crate) fn claimed_step_milestone_id(
        &self,
        capability: &TrackerCheckCapability,
    ) -> Option<String> {
        self.claimed_check(capability)?.step_milestone_id.clone()
    }

    /// The earliest moment this Task's check at this step may run again.
    pub(crate) fn step_retry_not_before_epoch_ms(&self, routine_id: &str, task_id: &str) -> u64 {
        self.tracker_runtime
            .step_task_not_before
            .get(&(routine_id.to_owned(), task_id.to_owned()))
            .copied()
            .unwrap_or(0)
    }

    /// The exact Task this step claim was issued for.
    pub(crate) fn claimed_step_task_id(
        &self,
        capability: &TrackerCheckCapability,
    ) -> Option<String> {
        self.claimed_check(capability)?.step_task_id.clone()
    }

    pub(crate) fn step_task_is_checked(&self, routine_id: &str, task_id: &str) -> bool {
        self.tracker_runtime
            .step_task_is_checked(routine_id, task_id)
    }

    /// Every current step check of this Routine, one per Task. Expiry is the
    /// deadline supervisor's decision, so this checks only that each claim is
    /// still the one Core holds.
    pub(crate) fn current_step_checks(&self, routine_id: &str) -> Vec<TrackerCheckCapability> {
        self.tracker_runtime
            .health
            .get(routine_id)
            .into_iter()
            .flat_map(|health| health.checks.iter())
            .filter(|active| active.step_task_id.is_some())
            .map(|active| active_capability(routine_id, active))
            .filter(|capability| {
                self.validate_current_check(capability, capability.claimed_at_epoch_ms)
                    .is_ok()
            })
            .collect()
    }

    /// A Task-detail override waiting to be claimed by this step Routine.
    pub(crate) fn step_run_now_task_id(&self, routine_id: &str) -> Option<&str> {
        self.tracker_runtime
            .step_run_now
            .get(routine_id)
            .and_then(|run_now| run_now.task_id.as_deref())
    }

    /// Finishes one claim and decides when its Routine may be claimed again.
    /// A scheduled Routine waits out its cadence; a step check's next moment
    /// comes from the verdicts it just recorded, floored so a run that
    /// answered nothing cannot be claimed again in the same instant.
    pub(crate) fn finish_steward_routine_check(
        &mut self,
        capability: &TrackerCheckCapability,
        attention_message: Option<String>,
        completed_at_epoch_ms: u64,
        configuration: &TrackerConfiguration,
    ) -> bool {
        if !configuration.trigger_mode.is_scheduled()
            && let Some(task_id) = self.claimed_step_task_id(capability)
        {
            // Setting the wait also ends any "Run now": the override lasts
            // exactly one run. The wait holds back only this Task.
            let retry_delay_seconds = self.claimed_step_milestone(capability).map_or(
                termloop_domain::PLAYBOOK_RETRY_DELAY_MIN_SECONDS,
                |milestone| milestone.retry_delay_seconds,
            );
            self.end_step_run_now(&capability.tracker_id, &task_id);
            self.tracker_runtime.step_task_not_before.insert(
                (capability.tracker_id.clone(), task_id),
                completed_at_epoch_ms.saturating_add(retry_delay_seconds.saturating_mul(1_000)),
            );
        }
        self.finish_runtime_check(
            capability,
            attention_message,
            completed_at_epoch_ms,
            configuration.schedule_interval_seconds,
        )
    }

    /// Finishes a valid per-Task step verdict. The verdict itself carries the
    /// Task's retry time, so no separate wait is kept for it.
    pub(crate) fn finish_steward_step_check(
        &mut self,
        capability: &TrackerCheckCapability,
        completed_at_epoch_ms: u64,
        configuration: &TrackerConfiguration,
    ) -> bool {
        if let Some(task_id) = self.claimed_step_task_id(capability) {
            self.end_step_run_now(&capability.tracker_id, &task_id);
            self.tracker_runtime
                .step_task_not_before
                .remove(&(capability.tracker_id.clone(), task_id));
        }
        self.finish_runtime_check(
            capability,
            None,
            completed_at_epoch_ms,
            configuration.schedule_interval_seconds,
        )
    }

    /// A "Run now" lasts one run: the run for its exact Task, or the next run
    /// at the step when no Task was named.
    fn end_step_run_now(&mut self, routine_id: &str, task_id: &str) {
        if self
            .tracker_runtime
            .step_run_now
            .get(routine_id)
            .is_some_and(|run_now| run_now.task_id.as_deref().is_none_or(|id| id == task_id))
        {
            self.tracker_runtime.step_run_now.remove(routine_id);
        }
    }

    pub(crate) fn validate_current_check(
        &self,
        capability: &TrackerCheckCapability,
        completed_at_epoch_ms: u64,
    ) -> Result<TrackerConfiguration, CoreError> {
        let configuration = self
            .store
            .tracker_configurations()
            .iter()
            .find(|configuration| configuration.id == capability.tracker_id)
            .cloned()
            .ok_or(CoreError::TrackerReportStale)?;
        let active = self
            .claimed_check(capability)
            .ok_or(CoreError::TrackerReportStale)?;
        // A step check belongs to its evaluator, not to the Steward session
        // that happened to be current when it was claimed.
        let steward_current = if active.step_task_id.is_some() {
            self.playbook_automation_enabled(&capability.project_id)
        } else {
            self.store.steward_configurations().iter().any(|steward| {
                steward.project_id == capability.project_id
                    && steward.enabled
                    && steward.generation == capability.steward_generation
                    && steward.executor_session_id.as_deref()
                        == Some(capability.steward_session_id.as_str())
            })
        };
        if !configuration.enabled
            || configuration.project_id != capability.project_id
            || configuration.generation != capability.generation
            || active.check_id != capability.check_id
            || active.generation != capability.generation
            || active.claimed_at_epoch_ms != capability.claimed_at_epoch_ms
            || active.project_id != capability.project_id
            || active.steward_generation != capability.steward_generation
            || active.steward_session_id != capability.steward_session_id
            || completed_at_epoch_ms
                > active
                    .deadline_epoch_ms
                    .saturating_add(OVERDUE_PING_GRACE_MS)
            || !steward_current
        {
            return Err(CoreError::TrackerReportStale);
        }
        Ok(configuration)
    }

    fn finish_runtime_check(
        &mut self,
        capability: &TrackerCheckCapability,
        attention_message: Option<String>,
        completed_at_epoch_ms: u64,
        schedule_interval_seconds: u64,
    ) -> bool {
        let health = self
            .tracker_runtime
            .health
            .get_mut(&capability.tracker_id)
            .expect("validated active Routine check");
        health.remove_check(&capability.check_id);
        health.attention_message = attention_message;
        let pending_trigger = std::mem::take(&mut health.pending_trigger);
        let next_due = if pending_trigger {
            completed_at_epoch_ms
        } else {
            completed_at_epoch_ms.saturating_add(schedule_interval_seconds.saturating_mul(1_000))
        };
        self.tracker_runtime
            .next_due_epoch_ms
            .insert(capability.tracker_id.clone(), next_due);
        pending_trigger
    }

    pub(crate) fn push_runtime_report(&mut self, report: TrackerReport) {
        if self
            .tracker_runtime
            .reports
            .iter()
            .filter(|candidate| candidate.project_id == report.project_id)
            .count()
            >= TRACKER_REPORTS_PER_PROJECT_MAX
            && let Some(index) = self
                .tracker_runtime
                .reports
                .iter()
                .position(|candidate| candidate.project_id == report.project_id)
        {
            self.tracker_runtime.reports.remove(index);
        }
        self.tracker_runtime.reports.push_back(report);
    }

    pub fn advance_tracker_deadlines(
        &mut self,
        now_epoch_ms: u64,
    ) -> Result<TrackerDeadlineAdvance, CoreError> {
        let mut changed = false;
        let mut expired = Vec::new();
        for (routine_id, health) in &mut self.tracker_runtime.health {
            for active in &mut health.checks {
                if !active.ping_sent && now_epoch_ms >= active.deadline_epoch_ms {
                    active.ping_sent = true;
                    changed = true;
                }
            }
            let before = health.checks.len();
            health.checks.retain(|active| {
                let overdue = active.ping_sent
                    && now_epoch_ms
                        >= active
                            .deadline_epoch_ms
                            .saturating_add(OVERDUE_PING_GRACE_MS);
                if overdue {
                    expired.push((routine_id.clone(), active.step_task_id.clone()));
                }
                !overdue
            });
            if health.checks.len() != before {
                health.pending_trigger = false;
                changed = true;
            }
        }
        for (routine_id, step_task_id) in expired {
            let retry_at = now_epoch_ms.saturating_add(CHECK_TIMEOUT_RETRY_MS);
            match step_task_id {
                // A step check's due time is otherwise derived from the Task
                // that is still waiting, which would make the abandoned claim
                // due again at once; the floor is what actually holds that
                // Task back. Other Tasks at the step are unaffected.
                Some(task_id) => {
                    self.tracker_runtime
                        .step_task_not_before
                        .insert((routine_id, task_id), retry_at);
                }
                None => {
                    self.tracker_runtime
                        .next_due_epoch_ms
                        .insert(routine_id, retry_at);
                }
            }
        }
        Ok(TrackerDeadlineAdvance { changed })
    }

    pub fn next_tracker_deadline_epoch_ms(&self) -> Option<u64> {
        self.tracker_runtime
            .health
            .values()
            .flat_map(|health| health.checks.iter())
            .map(|active| {
                if active.ping_sent {
                    active
                        .deadline_epoch_ms
                        .saturating_add(OVERDUE_PING_GRACE_MS)
                } else {
                    active.deadline_epoch_ms
                }
            })
            .min()
    }

    pub fn tracker_check_is_current(&self, capability: &TrackerCheckCapability) -> bool {
        self.validate_current_check(capability, capability.claimed_at_epoch_ms)
            .is_ok()
    }

    /// Returns the exact focused Task for a current Playbook step check, or
    /// `None` for a current scheduled Routine. Server-side Task-read receipts
    /// use this to prevent one Task's read from authorizing another's verdict.
    pub fn tracker_check_task_id(
        &self,
        capability: &TrackerCheckCapability,
    ) -> Result<Option<String>, CoreError> {
        self.validate_current_check(capability, capability.claimed_at_epoch_ms)?;
        Ok(self.claimed_step_task_id(capability))
    }

    pub fn release_steward_routine_claim(&mut self, capability: &TrackerCheckCapability) -> bool {
        let Some(active) = self.claimed_check(capability).cloned().filter(|active| {
            active.generation == capability.generation
                && active.claimed_at_epoch_ms == capability.claimed_at_epoch_ms
                && active.deadline_epoch_ms == capability.deadline_epoch_ms
                && active.project_id == capability.project_id
                && active.steward_generation == capability.steward_generation
                && active.steward_session_id == capability.steward_session_id
        }) else {
            return false;
        };
        if let Some(health) = self.tracker_runtime.health.get_mut(&capability.tracker_id) {
            health.remove_check(&capability.check_id);
        }
        // A claim handed back unused answered nothing, so the wait it would
        // have earned is dropped. A "Run now" the user is still waiting on is
        // not: this run never happened.
        match active.step_task_id {
            Some(task_id) => {
                self.tracker_runtime
                    .step_task_not_before
                    .remove(&(capability.tracker_id.clone(), task_id));
            }
            None => {
                self.tracker_runtime.next_due_epoch_ms.insert(
                    capability.tracker_id.clone(),
                    capability.claimed_at_epoch_ms,
                );
            }
        }
        true
    }

    pub fn steward_assignment_is_current(&self, wake: &DueStewardWake) -> bool {
        self.store.steward_configurations().iter().any(|steward| {
            steward.project_id == wake.project_id
                && steward.enabled
                && steward.generation == wake.steward_generation
                && steward.executor_session_id.as_deref() == Some(wake.steward_session_id.as_str())
        }) && self
            .tracker_runtime
            .pending_steward_wakes
            .get(&wake.project_id)
            .is_some_and(|pending| pending.steward_session_id == wake.steward_session_id)
    }

    pub fn fail_steward_assignment_delivery(
        &mut self,
        wake: &DueStewardWake,
        retry_at_epoch_ms: u64,
    ) {
        if self.steward_assignment_is_current(wake)
            && let Some(pending) = self
                .tracker_runtime
                .pending_steward_wakes
                .get_mut(&wake.project_id)
        {
            pending.retry_at_epoch_ms = retry_at_epoch_ms;
        }
    }

    pub fn acknowledge_steward_assignment_delivery(&mut self, wake: &DueStewardWake) {
        self.tracker_runtime
            .pending_steward_wakes
            .remove(&wake.project_id);
    }

    pub(crate) fn retain_current_tracker_runtime(&mut self) {
        let routine_ids = self
            .store
            .tracker_configurations()
            .iter()
            .map(|configuration| configuration.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let project_ids = self
            .store
            .steward_configurations()
            .iter()
            .map(|steward| steward.project_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        self.tracker_runtime
            .health
            .retain(|routine_id, _| routine_ids.contains(routine_id.as_str()));
        self.tracker_runtime
            .reports
            .retain(|report| routine_ids.contains(report.routine_id.as_str()));
        self.tracker_runtime
            .next_due_epoch_ms
            .retain(|routine_id, _| routine_ids.contains(routine_id.as_str()));
        self.tracker_runtime
            .step_run_now
            .retain(|routine_id, _| routine_ids.contains(routine_id.as_str()));
        self.tracker_runtime
            .step_task_not_before
            .retain(|(routine_id, _), _| routine_ids.contains(routine_id.as_str()));
        self.tracker_runtime
            .pending_steward_wakes
            .retain(|project_id, _| project_ids.contains(project_id.as_str()));
    }

    /// The scheduled Routine check the Steward itself is working on. Step
    /// checks run in evaluation forks and never occupy the Steward.
    fn steward_held_check_for_project(
        &self,
        project_id: &str,
    ) -> Option<(String, ActiveTrackerCheck)> {
        self.tracker_runtime
            .health
            .iter()
            .find_map(|(routine_id, health)| {
                health
                    .checks
                    .iter()
                    .find(|active| active.project_id == project_id && active.step_task_id.is_none())
                    .map(|active| (routine_id.clone(), active.clone()))
            })
    }

    fn project_step_check_count(&self, project_id: &str) -> usize {
        self.tracker_runtime
            .health
            .values()
            .flat_map(|health| health.checks.iter())
            .filter(|active| active.project_id == project_id && active.step_task_id.is_some())
            .count()
    }

    /// Projects whose Steward is busy with a scheduled Routine check. Running
    /// step checks never hold back the Steward or other Tasks.
    fn busy_project_ids(&self) -> std::collections::HashSet<String> {
        self.tracker_runtime
            .health
            .values()
            .flat_map(|health| health.checks.iter())
            .filter(|active| active.step_task_id.is_none())
            .map(|active| active.project_id.clone())
            .collect()
    }

    fn same_project_tasks_exist(&self, project_id: &str, task_ids: &[String]) -> bool {
        task_ids.iter().all(|task_id| {
            self.store
                .tasks()
                .iter()
                .any(|task| task.id == *task_id && task.project_id == project_id)
        })
    }
}

fn active_capability(routine_id: &str, active: &ActiveTrackerCheck) -> TrackerCheckCapability {
    TrackerCheckCapability {
        project_id: active.project_id.clone(),
        tracker_id: routine_id.to_owned(),
        check_id: active.check_id.clone(),
        generation: active.generation,
        claimed_at_epoch_ms: active.claimed_at_epoch_ms,
        deadline_epoch_ms: active.deadline_epoch_ms,
        steward_generation: active.steward_generation,
        steward_session_id: active.steward_session_id.clone(),
    }
}

fn routine_next_due(configuration: &TrackerConfiguration) -> u64 {
    let last_finished_at = configuration
        .last_attempt_at_epoch_ms
        .or(configuration.last_successful_report_at_epoch_ms);
    last_finished_at.map_or(configuration.updated_at_epoch_ms, |finished_at| {
        finished_at.saturating_add(
            configuration
                .schedule_interval_seconds
                .saturating_mul(1_000),
        )
    })
}

pub(crate) fn is_routine_problem_source_key(value: &str) -> bool {
    value.starts_with("routine-problem:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{
        AgentLaunchSelection, ProcessDescriptor, ResumeProvider, ResumeRef, RoutineTriggerMode,
        SessionKind, SessionRecord, StewardAgentId, StewardConfiguration,
    };
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::TerminalService;
    use uuid::Uuid;

    fn runtime_with_routines(count: usize) -> (CoreRuntime, std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!(
            "termloop-core-routine-runtime-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let state_path = root.join("state.json");
        let authority = issue_core_write_authority_for_composition();
        let store = Store::open(&state_path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project = runtime
            .handle(
                "project.create",
                json!({"name":"Routine Project","folderPath":root}),
            )
            .unwrap();
        let project_id = project["id"].as_str().unwrap().to_owned();
        runtime
            .store
            .set_steward_configuration(
                &runtime.write_authority,
                StewardConfiguration {
                    playbook_evaluator: Default::default(),
                    project_id: project_id.clone(),

                    agent_id: StewardAgentId::Codex,
                    model: "default".into(),
                    permission: "bypassPermissions".into(),
                    reasoning: "default".into(),
                    enabled: true,

                    system_prompt: String::new(),
                    executor_session_id: None,
                    generation: 1,
                    updated_at_epoch_ms: 100,
                },
                runtime.store.revision(),
            )
            .unwrap();
        runtime
            .store
            .attach_steward_executor_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "steward-session".into(),
                    project_id: project_id.clone(),
                    name: Some("Routine Steward".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: root.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.steward.executor".into()),
                        template_version: Some(6),
                    },
                    launch_selection: AgentLaunchSelection::default(),
                    lifecycle_state: "running".into(),
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: ResumeRef::for_provider(
                        ResumeProvider::Codex,
                        Uuid::new_v4().to_string(),
                    ),
                    resume_launch_guard: None,
                    resume_failure: None,
                },
                &project_id,
                1,
                100,
            )
            .unwrap();
        runtime
            .store
            .mark_agent_conversation_resumable(&runtime.write_authority, "steward-session")
            .unwrap();
        for index in 0..count {
            runtime
                .store
                .set_tracker_configuration(
                    &runtime.write_authority,
                    TrackerConfiguration {
                        id: format!(
                            "routine-{}",
                            char::from(b'a' + u8::try_from(index).unwrap())
                        ),
                        project_id: project_id.clone(),
                        trigger_mode: RoutineTriggerMode::Schedule,
                        name: format!("Routine {index}"),
                        prompt: "Inspect Slack and update the visible context.".into(),
                        steward_instructions: String::new(),

                        enabled: true,
                        schedule_interval_seconds: 60,
                        generation: 1,
                        context_markdown: String::new(),
                        context_revision: 1,
                        recent_source_keys: vec![],
                        related_task_ids: vec![],
                        action_handling: RoutineActionHandling::Off,
                        pending_routine_findings: vec![],
                        last_check_started_at_epoch_ms: None,
                        last_attempt_at_epoch_ms: None,
                        last_successful_report_at_epoch_ms: None,
                        updated_at_epoch_ms: 100,
                    },
                    runtime.store.revision(),
                )
                .unwrap();
        }
        (runtime, root, project_id)
    }

    #[test]
    fn get_next_is_one_at_a_time_idempotent_and_restart_keeps_completion_schedule() {
        let (mut runtime, root, project_id) = runtime_with_routines(2);
        let first = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-a".into(), 100)
            .unwrap();
        let first_capability = first.capability.unwrap();
        assert_eq!(first_capability.tracker_id, "routine-a");
        let retried = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "ignored".into(), 101)
            .unwrap();
        assert_eq!(retried.capability.unwrap().check_id, "check-a");

        runtime
            .complete_steward_routine(
                &first_capability,
                1,
                String::new(),
                None,
                vec![],
                vec![],
                "report-a".into(),
                200,
            )
            .unwrap();
        let second = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-b".into(), 201)
            .unwrap();
        let second_capability = second.capability.unwrap();
        assert_eq!(second_capability.tracker_id, "routine-b");
        runtime
            .complete_steward_routine(
                &second_capability,
                1,
                String::new(),
                None,
                vec![],
                vec![],
                "report-b".into(),
                250,
            )
            .unwrap();
        let idle = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "unused".into(), 251)
            .unwrap();
        assert!(idle.capability.is_none());
        assert_eq!(idle.result["nextWakeAtEpochMs"], 60_200);

        drop(runtime);
        let store = Store::open(root.join("state.json")).unwrap();
        let mut reopened = CoreRuntime::new(
            store,
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            2,
        )
        .unwrap();
        assert_eq!(
            reopened.store.steward_configurations()[0]
                .executor_session_id
                .as_deref(),
            Some("steward-session")
        );
        assert_eq!(
            reopened
                .store
                .sessions()
                .iter()
                .find(|session| session.id == "steward-session")
                .unwrap()
                .lifecycle_state,
            "resuming"
        );
        let after_restart = reopened
            .claim_next_steward_routine(&project_id, "steward-session", "too-early".into(), 300)
            .unwrap();
        assert!(after_restart.capability.is_none());
        assert_eq!(after_restart.result["nextWakeAtEpochMs"], 60_200);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_get_next_readiness_exposes_a_future_schedule_to_the_supervisor() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), Some(100));
        let idle = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "not-due".into(), 0)
            .unwrap();
        assert!(idle.capability.is_none());
        assert_eq!(idle.result["nextWakeAtEpochMs"], 100);
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), Some(100));
        assert!(runtime.admit_due_steward_wakes(99).is_empty());
        let wakes = runtime.admit_due_steward_wakes(100);
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].project_id, project_id);
        let claimed = runtime
            .claim_due_steward_routine(&wakes[0], "due".into(), 100)
            .unwrap();
        assert_eq!(claimed.capability.unwrap().tracker_id, "routine-a");
        assert!(runtime.steward_assignment_is_current(&wakes[0]));
        runtime.acknowledge_steward_assignment_delivery(&wakes[0]);
        assert!(!runtime.steward_assignment_is_current(&wakes[0]));

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_steward_already_mid_turn_is_not_pinged_until_it_finishes() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let idle = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "not-due".into(), 0)
            .unwrap();
        assert!(idle.capability.is_none());

        // The Steward is in the middle of a turn. A wake is a message typed into
        // its terminal, and one typed now is not read until the turn ends, so
        // the ping is held rather than stacked behind it.
        runtime.agent_observations.insert(
            "steward-session".into(),
            crate::AgentObservationCapability {
                token: Some("steward-token".into()),
                runtime_epoch: 1,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
                pending_wakes: Default::default(),
                observation: Some(termloop_agents::reduce_observation(
                    None,
                    termloop_agents::AgentSignal::PromptSubmitted,
                    termloop_agents::AgentSignalSource::Hook,
                    1,
                    60_000,
                )),
                pending_generated_input: None,
            },
        );
        assert!(runtime.admit_due_steward_wakes(60_000).is_empty());
        // The loop must agree with the admission, or it would spin on a ping it
        // has already decided not to send.
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), None);

        // Nothing was spent: the ping is still due, so finishing the turn is
        // enough to be told at once.
        let observation = runtime
            .agent_observations
            .get_mut("steward-session")
            .expect("the Steward Session is still observed");
        observation.observation = Some(termloop_agents::reduce_observation(
            observation.observation,
            termloop_agents::AgentSignal::Stopped,
            termloop_agents::AgentSignalSource::Hook,
            2,
            60_100,
        ));
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), Some(100));
        let wakes = runtime.admit_due_steward_wakes(60_100);
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].project_id, project_id);

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_steward_configuration_keeps_the_running_session() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let updated = runtime
            .set_steward_configuration(
                crate::companion_integrations::steward::StewardConfigurationUpdate {
                    playbook_evaluator: None,
                    project_id: &project_id,
                    agent_id: "codex",
                    model: "default".into(),
                    permission: "bypassPermissions".into(),
                    reasoning: "default".into(),
                    enabled: true,
                    system_prompt: String::new(),
                    expected_revision: runtime.state_revision(),
                    capability: crate::AssistantAvailability::Proven,
                    updated_at_epoch_ms: 500,
                },
            )
            .unwrap();
        assert_eq!(
            updated.result["configuration"]["executorSessionId"],
            "steward-session"
        );
        assert_eq!(updated.result["configuration"]["generation"], 1);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changing_steward_prompt_retires_the_running_session() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let editable = "Answer briefly in Turkish.";
        let updated = runtime
            .set_steward_configuration(
                crate::companion_integrations::steward::StewardConfigurationUpdate {
                    playbook_evaluator: None,
                    project_id: &project_id,
                    agent_id: "codex",
                    model: "gpt-5.6-sol".into(),
                    permission: "bypassPermissions".into(),
                    reasoning: "high".into(),
                    enabled: true,
                    system_prompt: editable.into(),
                    expected_revision: runtime.state_revision(),
                    capability: crate::AssistantAvailability::Proven,
                    updated_at_epoch_ms: 500,
                },
            )
            .unwrap();
        assert_eq!(updated.result["configuration"]["systemPrompt"], editable);
        assert!(updated.result["configuration"]["executorSessionId"].is_null());
        assert_eq!(updated.result["configuration"]["generation"], 2);
        assert_eq!(updated.result["configuration"]["model"], "gpt-5.6-sol");
        assert_eq!(updated.result["configuration"]["reasoning"], "high");
        let projected = runtime
            .get_steward_configuration(json!({"projectId": project_id}))
            .unwrap();
        let context = &projected["promptContext"];
        assert_eq!(
            context["instructionsPrompt"].as_str().unwrap(),
            format!(
                "{}\n\n{editable}",
                context["protectedPrompt"].as_str().unwrap()
            )
        );
        assert!(
            context["protectedPrompt"]
                .as_str()
                .unwrap()
                .contains("steward_complete_assignment")
        );
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completion_cas_persists_visible_context_and_silences_duplicate_findings() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let task = runtime
            .handle(
                "task.create",
                json!({
                    "projectId":project_id,
                    "title":"Follow up",
                    "brief":null,
                    "worktreeIntent":"none"
                }),
            )
            .unwrap();
        let task_id = task["id"].as_str().unwrap().to_owned();
        let first = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-1".into(), 1_000)
            .unwrap()
            .capability
            .unwrap();
        assert!(matches!(
            runtime.complete_steward_routine(
                &first,
                2,
                "# Slack\nNothing hidden.".into(),
                None,
                vec![],
                vec![],
                "stale-report".into(),
                1_050,
            ),
            Err(CoreError::RevisionConflict)
        ));
        assert!(runtime.tracker_check_is_current(&first));
        assert_eq!(runtime.tracker_check_task_id(&first).unwrap(), None);

        let finding = RoutineFinding {
            id: "finding-1".into(),
            source_key: "slack:C123:1700.001".into(),
            summary: "A follow-up is waiting.".into(),
            evidence: "The follow-up message has no visible response.".into(),
            source_references: vec!["slack://C123/1700.001".into()],
            related_task_ids: vec![task_id.clone()],
        };
        let completed = runtime
            .complete_steward_routine(
                &first,
                1,
                "# Slack\nNothing hidden.".into(),
                None,
                vec![finding.clone()],
                vec![task_id.clone()],
                "report-1".into(),
                1_100,
            )
            .unwrap();
        assert_eq!(completed["reportCreated"], true);
        assert_eq!(completed["newFindingCount"], 1);
        assert_eq!(completed["contextChanged"], true);
        assert_eq!(completed["contextRevision"], 2);
        let stored = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == "routine-a")
            .unwrap();
        assert_eq!(stored.context_markdown, "# Slack\nNothing hidden.");
        assert_eq!(stored.recent_source_keys, ["slack:C123:1700.001"]);
        assert_eq!(stored.related_task_ids, std::slice::from_ref(&task_id));
        assert_eq!(stored.last_attempt_at_epoch_ms, Some(1_100));

        assert!(runtime.run_routine_now("routine-a", 1_200).unwrap());
        let duplicate_check = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-2".into(), 1_200)
            .unwrap()
            .capability
            .unwrap();
        let duplicate = runtime
            .complete_steward_routine(
                &duplicate_check,
                2,
                "# Slack\nNothing hidden.".into(),
                None,
                vec![finding],
                vec![task_id],
                "report-2".into(),
                1_250,
            )
            .unwrap();
        assert_eq!(duplicate["reportCreated"], false);
        assert_eq!(duplicate["newFindingCount"], 0);
        assert_eq!(duplicate["contextChanged"], false);
        assert_eq!(duplicate["contextRevision"], 2);
        let runtime_projection = runtime
            .list_tracker_runtime(json!({"projectId":project_id}))
            .unwrap();
        assert_eq!(runtime_projection["reports"].as_array().unwrap().len(), 1);
        assert_eq!(runtime_projection["health"][0]["nextDueAtEpochMs"], 61_250);

        assert!(runtime.run_routine_now("routine-a", 1_300).unwrap());
        let action_check = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-3".into(), 1_300)
            .unwrap()
            .capability
            .unwrap();
        let action = runtime
            .complete_steward_routine(
                &action_check,
                2,
                "# Slack\nNothing hidden.".into(),
                Some("Sent the requested recurring project update.".into()),
                vec![],
                vec![],
                "report-3".into(),
                1_350,
            )
            .unwrap();
        assert_eq!(action["reportCreated"], true);
        assert_eq!(action["newFindingCount"], 0);
        let runtime_projection = runtime
            .list_tracker_runtime(json!({"projectId":project_id}))
            .unwrap();
        assert_eq!(runtime_projection["reports"].as_array().unwrap().len(), 2);
        assert_eq!(
            runtime_projection["reports"][0]["message"],
            "Sent the requested recurring project update."
        );

        drop(runtime);
        let store = Store::open(root.join("state.json")).unwrap();
        let reopened = CoreRuntime::new(
            store,
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            2,
        )
        .unwrap();
        let after_restart = reopened
            .list_tracker_runtime(json!({"projectId":project_id}))
            .unwrap();
        assert!(after_restart["reports"].as_array().unwrap().is_empty());
        assert_eq!(
            after_restart["health"][0]["contextMarkdown"],
            "# Slack\nNothing hidden."
        );
        assert_eq!(
            after_restart["health"][0]["contextRevision"],
            action["contextRevision"]
        );
        assert!(after_restart["health"][0].get("kind").is_none());
        assert_eq!(after_restart["health"][0]["triggerMode"], "schedule");
        assert_eq!(after_restart["health"][0]["name"], "Routine 0");
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn factual_findings_are_current_deduplicated_and_resolvable_by_the_steward() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let mut routine = runtime.store.tracker_configurations()[0].clone();
        routine.action_handling = RoutineActionHandling::Ask;
        routine.steward_instructions =
            "When a review request is absent, propose asking the assigned reviewer.".into();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, routine, runtime.store.revision())
            .unwrap();
        let steward_generation = runtime.store.steward_configurations()[0].generation;
        let first = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "action-1".into(), 1_000)
            .unwrap();
        assert!(first.result["routine"].get("actionHandling").is_none());
        assert!(first.result["routine"].get("stewardInstructions").is_none());
        let first = first.capability.unwrap();
        let finding = RoutineFinding {
            id: "finding-1".into(),
            source_key: "slack:C123:review-request:42".into(),
            summary: "No review request for PR 42 is visible.".into(),
            evidence: "The inspected channel contains no message referencing PR 42.".into(),
            source_references: vec!["slack://C123".into()],
            related_task_ids: vec![],
        };
        let second_finding = RoutineFinding {
            id: "finding-2".into(),
            source_key: "slack:C123:review-request:43".into(),
            summary: "No review request for PR 43 is visible.".into(),
            evidence: "The inspected channel contains no message referencing PR 43.".into(),
            source_references: vec!["slack://C123".into()],
            related_task_ids: vec![],
        };
        let completed = runtime
            .complete_steward_routine(
                &first,
                1,
                String::new(),
                None,
                vec![finding.clone(), second_finding],
                vec![],
                "report-1".into(),
                1_100,
            )
            .unwrap();
        assert_eq!(completed["newPendingFindingCount"], 2);
        assert!(runtime.has_current_routine_findings(&project_id));
        let pending = runtime
            .read_routine_findings_for_steward(&project_id, "steward-session")
            .unwrap();
        assert_eq!(pending["routines"][0]["findings"][0]["id"], "finding-1");
        assert_eq!(
            pending["routines"][0]["whileWaiting"]["instructions"],
            "When a review request is absent, propose asking the assigned reviewer."
        );
        runtime.observe_steward_idle("steward-session", 1);
        let retries = runtime.take_steward_finding_disposition_retries();
        assert_eq!(retries.len(), 1);
        assert_eq!(retries[0].project_id, project_id);
        assert_eq!(retries[0].generation, steward_generation);
        runtime
            .read_routine_findings_for_steward(&project_id, "steward-session")
            .unwrap();
        runtime.observe_steward_idle("steward-session", 1);
        assert!(
            runtime
                .take_steward_finding_disposition_retries()
                .is_empty(),
            "the same exact finding state receives only one recovery wake"
        );

        assert!(runtime.run_routine_now("routine-a", 1_200).unwrap());
        let duplicate = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "action-2".into(), 1_200)
            .unwrap()
            .capability
            .unwrap();
        let duplicate = runtime
            .complete_steward_routine(
                &duplicate,
                2,
                String::new(),
                None,
                vec![RoutineFinding {
                    id: "finding-2".into(),
                    ..finding
                }],
                vec![],
                "report-2".into(),
                1_250,
            )
            .unwrap();
        assert_eq!(duplicate["newPendingFindingCount"], 0);

        let before_problem = runtime.state_revision();
        let problem = runtime
            .append_steward_suggestion(
                "steward-session",
                &project_id,
                "problem",
                crate::companion_integrations::transcript::CompanionMessageRefsInput {
                    task_id: None,
                    session_id: None,
                    routine_finding_id: Some("finding-2".into()),
                    routine_finding_ids: vec![],
                },
                "The required review source is unavailable.".into(),
                1_290,
            )
            .unwrap();
        assert_eq!(runtime.state_revision(), before_problem + 1);
        assert_eq!(problem["dismissedRoutineFindingIds"], json!(["finding-2"]));
        assert_eq!(
            runtime.read_routine_findings(&project_id).unwrap()["routines"][0]["findings"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        assert!(matches!(
            runtime.resolve_routine_finding(&project_id, "finding-1", "completed", 1_300),
            Err(CoreError::CapabilityDenied)
        ));
        assert!(matches!(
            runtime.append_steward_suggestion(
                "steward-session",
                &project_id,
                "proposal",
                crate::companion_integrations::transcript::CompanionMessageRefsInput {
                    task_id: None,
                    session_id: None,
                    routine_finding_id: None,
                    routine_finding_ids: vec!["finding-1".into(), "routine-a".into()],
                },
                "Ask for reviews of PRs 42 and 43?".into(),
                1_305,
            ),
            Err(CoreError::CapabilityDenied)
        ));
        let proposal = runtime
            .append_steward_suggestion(
                "steward-session",
                &project_id,
                "proposal",
                crate::companion_integrations::transcript::CompanionMessageRefsInput {
                    task_id: None,
                    session_id: None,
                    routine_finding_id: Some("finding-1".into()),
                    routine_finding_ids: vec![],
                },
                "Ask the assigned reviewer to review PR 42?".into(),
                1_310,
            )
            .unwrap();
        assert!(matches!(
            runtime.append_steward_suggestion(
                "steward-session",
                &project_id,
                "attention",
                crate::companion_integrations::transcript::CompanionMessageRefsInput {
                    task_id: None,
                    session_id: None,
                    routine_finding_id: Some("finding-1".into()),
                    routine_finding_ids: vec![],
                },
                "Please review PR 42 yourself.".into(),
                1_312,
            ),
            Err(CoreError::CompanionProposalPending { proposal_message_id })
                if proposal_message_id == proposal["message"]["id"]
        ));
        assert!(matches!(
            runtime.append_steward_suggestion(
                "steward-session",
                &project_id,
                "proposal",
                crate::companion_integrations::transcript::CompanionMessageRefsInput {
                    task_id: None,
                    session_id: None,
                    routine_finding_id: Some("finding-1".into()),
                    routine_finding_ids: vec![],
                },
                "Ask the assigned reviewer again?".into(),
                1_315,
            ),
            Err(CoreError::CompanionProposalPending { proposal_message_id })
                if !proposal_message_id.is_empty()
        ));
        runtime
            .respond_to_companion_proposal(
                &project_id,
                proposal["message"]["id"].as_str().unwrap(),
                "approve",
                1_320,
            )
            .unwrap();
        runtime
            .resolve_routine_finding(&project_id, "finding-1", "completed", 1_330)
            .unwrap();
        assert!(
            runtime.read_routine_findings(&project_id).unwrap()["routines"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(!runtime.has_current_routine_findings(&project_id));
        let stored = &runtime.store.tracker_configurations()[0];
        assert_eq!(
            stored.recent_source_keys,
            [
                "slack:C123:review-request:42",
                "slack:C123:review-request:43"
            ]
        );

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changed_context_is_projected_even_when_a_duplicate_finding_creates_no_report() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let finding = RoutineFinding {
            id: "finding-1".into(),
            source_key: "slack:C123:1700.001".into(),
            summary: "A follow-up is waiting.".into(),
            evidence: "The follow-up message has no visible response.".into(),
            source_references: vec!["slack://C123/1700.001".into()],
            related_task_ids: vec![],
        };
        let first = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-1".into(), 1_000)
            .unwrap()
            .capability
            .unwrap();
        runtime
            .complete_steward_routine(
                &first,
                1,
                "# Slack\nInitial context.".into(),
                None,
                vec![finding.clone()],
                vec![],
                "report-1".into(),
                1_100,
            )
            .unwrap();

        assert!(runtime.run_routine_now("routine-a", 1_200).unwrap());
        let refresh = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-2".into(), 1_200)
            .unwrap()
            .capability
            .unwrap();
        let completed = runtime
            .complete_steward_routine(
                &refresh,
                2,
                "# Slack\nRefreshed current context.".into(),
                None,
                vec![finding],
                vec![],
                "report-2".into(),
                1_300,
            )
            .unwrap();

        assert_eq!(completed["reportCreated"], false);
        assert_eq!(completed["newFindingCount"], 0);
        assert_eq!(completed["contextChanged"], true);
        assert_eq!(completed["contextRevision"], 3);
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn releasing_an_exact_claim_survives_a_routine_generation_change() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let stale = runtime
            .claim_next_steward_routine(
                &project_id,
                "steward-session",
                "check-before-edit".into(),
                1_000,
            )
            .unwrap()
            .capability
            .unwrap();

        let mut edited = runtime.store.tracker_configurations()[0].clone();
        edited.generation = 2;
        edited.prompt = "Inspect the edited source.".into();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, edited, runtime.store.revision())
            .unwrap();

        assert!(!runtime.tracker_check_is_current(&stale));
        assert!(runtime.release_steward_routine_claim(&stale));
        assert!(!runtime.release_steward_routine_claim(&stale));

        let fresh = runtime
            .claim_next_steward_routine(
                &project_id,
                "steward-session",
                "check-after-edit".into(),
                1_001,
            )
            .unwrap()
            .capability
            .unwrap();
        assert_eq!(fresh.check_id, "check-after-edit");
        assert_eq!(fresh.generation, 2);

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn user_context_edit_is_revision_checked_and_is_the_next_claim_source() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let edited = runtime
            .update_routine_context(
                "routine-a",
                "# User context\nWatch the release channel.".into(),
                1,
                runtime.state_revision(),
                500,
            )
            .unwrap();
        assert_eq!(edited["configuration"]["contextRevision"], 2);
        assert!(matches!(
            runtime.update_routine_context(
                "routine-a",
                "stale overwrite".into(),
                1,
                runtime.state_revision(),
                501,
            ),
            Err(CoreError::RevisionConflict)
        ));
        let claim = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-context".into(), 500)
            .unwrap();
        assert_eq!(claim.result["context"]["revision"], 2);
        assert_eq!(claim.result["context"]["evidenceKind"], "routineMemory");
        assert_eq!(claim.result["context"]["independentlyVerified"], false);
        assert_eq!(
            claim.result["context"]["markdown"],
            "# User context\nWatch the release channel."
        );

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn user_context_edit_wins_without_losing_the_in_flight_completion() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let claim = runtime
            .claim_next_steward_routine(
                &project_id,
                "steward-session",
                "check-user-edit".into(),
                1_000,
            )
            .unwrap()
            .capability
            .unwrap();
        runtime
            .update_routine_context(
                "routine-a",
                "# User reset\nKeep this newer memory.".into(),
                1,
                runtime.state_revision(),
                1_025,
            )
            .unwrap();

        let completed = runtime
            .complete_steward_routine(
                &claim,
                1,
                "# Steward replacement\nThis came from the old memory.".into(),
                Some("The source check completed.".into()),
                vec![],
                vec![],
                "report-user-edit".into(),
                1_050,
            )
            .unwrap();

        assert_eq!(completed["contextMarkdownApplied"], false);
        assert_eq!(completed["contextRevision"], 2);
        assert_eq!(completed["reportCreated"], true);
        assert!(!runtime.tracker_check_is_current(&claim));
        let stored = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == "routine-a")
            .unwrap();
        assert_eq!(
            stored.context_markdown,
            "# User reset\nKeep this newer memory."
        );
        assert_eq!(stored.last_successful_report_at_epoch_ms, Some(1_050));

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn routine_preserves_its_name_and_accepts_provider_neutral_source_keys() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let mut custom = runtime.store.tracker_configurations()[0].clone();
        custom.name = "Weekly customer pulse".into();
        custom.prompt = "Use the visible name and context as the bounded recurring check.".into();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, custom, runtime.store.revision())
            .unwrap();

        let claim = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "check-custom".into(), 500)
            .unwrap();
        assert_eq!(claim.result["routine"]["name"], "Weekly customer pulse");
        assert!(claim.result["routine"].get("kind").is_none());
        let capability = claim.capability.unwrap();
        runtime
            .complete_steward_routine(
                &capability,
                1,
                "# Customer pulse".into(),
                Some("Customer pulse check completed.".into()),
                vec![RoutineFinding {
                    id: "custom-finding".into(),
                    source_key: "observed:customer-pulse:2026-W33".into(),
                    summary: "No new escalations".into(),
                    evidence: "The inspected customer pulse contains no escalation.".into(),
                    source_references: vec![],
                    related_task_ids: vec![],
                }],
                vec![],
                "custom-report".into(),
                560,
            )
            .unwrap();

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn routine_creation_uses_the_visible_provider_neutral_prompt() {
        let (mut runtime, root, project_id) = runtime_with_routines(0);
        let created = runtime
            .create_tracker_configuration(
                "custom-routine".into(),
                &project_id,
                RoutineTriggerMode::Schedule,
                "Customer pulse".into(),
                2_700,
                RoutineActionHandling::Off,
                None,
                None,
                runtime.state_revision(),
                500,
            )
            .unwrap();
        assert!(created["configuration"].get("kind").is_none());
        assert_eq!(created["configuration"]["name"], "Customer pulse");
        assert_eq!(created["configuration"]["enabled"], false);
        assert!(
            created["configuration"]["instructions"]
                .as_str()
                .unwrap()
                .contains("exact configured instructions")
        );

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn problem_finishes_on_schedule_while_timeout_retries_after_backoff() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let problem_check = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "problem-check".into(), 100)
            .unwrap()
            .capability
            .unwrap();
        runtime
            .report_steward_routine_problem(
                &problem_check,
                "Slack access is unavailable.".into(),
                vec!["slack://C123".into()],
                "problem-report".into(),
                200,
            )
            .unwrap();
        let attention = runtime
            .list_tracker_runtime(json!({"projectId":project_id}))
            .unwrap();
        assert_eq!(attention["health"][0]["state"], "attention");
        assert_eq!(attention["health"][0]["nextDueAtEpochMs"], 60_200);
        assert_eq!(attention["reports"][0]["kind"], "problem");

        runtime.run_routine_now("routine-a", 300).unwrap();
        let timed_out = runtime
            .claim_next_steward_routine(&project_id, "steward-session", "timeout-check".into(), 300)
            .unwrap()
            .capability
            .unwrap();
        assert!(
            runtime
                .advance_tracker_deadlines(timed_out.deadline_epoch_ms)
                .unwrap()
                .changed
        );
        assert_eq!(
            runtime
                .list_tracker_runtime(json!({"projectId":project_id}))
                .unwrap()["health"][0]["state"],
            "overdue"
        );
        let expired_at = timed_out
            .deadline_epoch_ms
            .saturating_add(OVERDUE_PING_GRACE_MS);
        assert!(
            runtime
                .advance_tracker_deadlines(expired_at)
                .unwrap()
                .changed
        );
        let retry = runtime
            .list_tracker_runtime(json!({"projectId":project_id}))
            .unwrap();
        assert_eq!(retry["health"][0]["state"], "attention");
        assert_eq!(
            retry["health"][0]["nextDueAtEpochMs"],
            expired_at + CHECK_TIMEOUT_RETRY_MS
        );

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}
