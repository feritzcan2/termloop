//! Bounded Routine scheduling, one-at-a-time Worker claims, and current reports.

use std::collections::{HashMap, VecDeque};

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
    generation: u64,
    claimed_at_epoch_ms: u64,
    deadline_epoch_ms: u64,
    ping_sent: bool,
    worker_id: String,
    worker_generation: u64,
    worker_session_id: String,
}

#[derive(Debug, Clone, Default)]
struct TrackerHealth {
    active: Option<ActiveTrackerCheck>,
    pending_trigger: bool,
    attention_message: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingWorkerWake {
    worker_session_id: String,
    retry_at_epoch_ms: u64,
}

#[derive(Default)]
pub(crate) struct TrackerRuntimeState {
    health: HashMap<String, TrackerHealth>,
    reports: VecDeque<TrackerReport>,
    next_due_epoch_ms: HashMap<String, u64>,
    ready_worker_sessions: HashMap<String, String>,
    next_worker_ping_epoch_ms: HashMap<String, u64>,
    pending_worker_wakes: HashMap<String, PendingWorkerWake>,
    /// What holds a step check back from, or pushes it into, its next run. A
    /// step's due time is otherwise derived entirely from stored verdicts, so
    /// without this a run that answered nothing would be due again the instant
    /// it finished.
    step_gate: HashMap<String, StepGate>,
}

/// The one runtime fact that can move a step check off its derived due time.
/// The two are mutually exclusive by construction: an override is what a user
/// pressing "Run now" replaces the wait with, and finishing that run puts the
/// wait back.
#[derive(Debug, Clone)]
enum StepGate {
    /// Earliest moment this Routine may be claimed again.
    NotBefore(u64),
    /// "Run now": the user overriding the step's own delay for one run.
    RunNow {
        at_epoch_ms: u64,
        /// An exact Task selected from Task details. `None` preserves the
        /// general Routine action, which follows the pipeline's current focus.
        task_id: Option<String>,
    },
}

impl TrackerRuntimeState {
    pub(crate) fn tracker_is_active(&self, routine_id: &str) -> bool {
        self.health
            .get(routine_id)
            .is_some_and(|health| health.active.is_some())
    }

    pub(crate) fn cancel_worker_checks(&mut self, worker_id: &str) {
        self.ready_worker_sessions.remove(worker_id);
        self.next_worker_ping_epoch_ms.remove(worker_id);
        self.pending_worker_wakes.remove(worker_id);
        for health in self.health.values_mut() {
            if health
                .active
                .as_ref()
                .is_some_and(|active| active.worker_id == worker_id)
            {
                health.active = None;
                health.pending_trigger = false;
            }
        }
    }

    pub(crate) fn cancel_tracker_check(&mut self, routine_id: &str) {
        self.health.remove(routine_id);
        self.next_due_epoch_ms.remove(routine_id);
        self.step_gate.remove(routine_id);
    }

    pub(crate) fn remove_tracker(&mut self, routine_id: &str) {
        self.health.remove(routine_id);
        self.reports
            .retain(|report| report.routine_id != routine_id);
        self.next_due_epoch_ms.remove(routine_id);
        self.step_gate.remove(routine_id);
    }

    pub(crate) fn schedule_tracker_now(&mut self, routine_id: &str, now_epoch_ms: u64) {
        self.next_due_epoch_ms
            .insert(routine_id.to_owned(), now_epoch_ms);
    }

    pub(crate) fn schedule_worker_ping_now(&mut self, worker_id: &str, now_epoch_ms: u64) {
        if self.ready_worker_sessions.contains_key(worker_id) {
            self.next_worker_ping_epoch_ms
                .insert(worker_id.to_owned(), now_epoch_ms);
        }
    }

    pub(crate) fn reschedule_worker_ping(
        &mut self,
        worker_id: &str,
        session_id: Option<&str>,
        now_epoch_ms: u64,
        ping_interval_seconds: u64,
    ) {
        let Some(session_id) = session_id else {
            self.next_worker_ping_epoch_ms.remove(worker_id);
            return;
        };
        if self
            .ready_worker_sessions
            .get(worker_id)
            .is_some_and(|ready| ready == session_id)
        {
            self.next_worker_ping_epoch_ms.insert(
                worker_id.to_owned(),
                now_epoch_ms.saturating_add(ping_interval_seconds.saturating_mul(1_000)),
            );
        }
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
    pub worker_id: String,
    pub worker_generation: u64,
    pub worker_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueWorkerWake {
    pub project_id: String,
    pub worker_id: String,
    pub worker_generation: u64,
    pub worker_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRoutineFinding {
    pub id: String,
    pub source_key: String,
    pub summary: String,
    pub evidence: String,
    pub source_references: Vec<String>,
    pub related_task_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct WorkerRoutineClaim {
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
            match self.playbook_step_due_epoch_ms(&routine_id) {
                Some(due) => {
                    // "Run now" is the user overriding exactly the wait this
                    // would otherwise sit out.
                    let next = match self.tracker_runtime.step_gate.get(&routine_id) {
                        Some(StepGate::RunNow { at_epoch_ms, .. }) => *at_epoch_ms,
                        Some(StepGate::NotBefore(floor)) => due.max(*floor),
                        None => due,
                    };
                    self.tracker_runtime
                        .next_due_epoch_ms
                        .insert(routine_id, next);
                }
                // Nobody is waiting at this question, so there is no job. An
                // override with nothing to run is dropped; a wait is kept,
                // because the Task that arrives next has not served it.
                None => {
                    self.tracker_runtime.next_due_epoch_ms.remove(&routine_id);
                    if matches!(
                        self.tracker_runtime.step_gate.get(&routine_id),
                        Some(StepGate::RunNow { .. })
                    ) {
                        self.tracker_runtime.step_gate.remove(&routine_id);
                    }
                }
            }
        }
    }

    /// Whether this enabled Routine has anything to do at all. A scheduled
    /// Routine always does; a step check only while a Task stands at it.
    fn routine_has_work(&self, routine_id: &str) -> bool {
        self.tracker_runtime
            .next_due_epoch_ms
            .contains_key(routine_id)
    }

    pub(crate) fn tracker_runtime_next_due_epoch_ms(&self, routine_id: &str) -> Option<u64> {
        self.tracker_runtime
            .next_due_epoch_ms
            .get(routine_id)
            .copied()
    }

    /// The question the Routine's current claim was issued for.
    pub(crate) fn claimed_step_milestone_id(&self, routine_id: &str) -> Option<String> {
        self.tracker_runtime
            .health
            .get(routine_id)
            .and_then(|health| health.active.as_ref())
            .and_then(|active| active.step_milestone_id.clone())
    }

    /// The exact Task the Routine's current step claim was issued for.
    pub(crate) fn claimed_step_task_id(&self, routine_id: &str) -> Option<String> {
        self.tracker_runtime
            .health
            .get(routine_id)
            .and_then(|health| health.active.as_ref())
            .and_then(|active| active.step_task_id.clone())
    }

    /// A Task-detail override waiting to be claimed by this step Routine.
    pub(crate) fn step_run_now_task_id(&self, routine_id: &str) -> Option<&str> {
        match self.tracker_runtime.step_gate.get(routine_id) {
            Some(StepGate::RunNow {
                task_id: Some(task_id),
                ..
            }) => Some(task_id),
            _ => None,
        }
    }

    /// Finishes one claim and decides when its Routine may be claimed again.
    /// A scheduled Routine waits out its cadence; a step check's next moment
    /// comes from the verdicts it just recorded, floored so a run that
    /// answered nothing cannot be claimed again in the same instant.
    pub(crate) fn finish_worker_routine_check(
        &mut self,
        capability: &TrackerCheckCapability,
        attention_message: Option<String>,
        completed_at_epoch_ms: u64,
        configuration: &TrackerConfiguration,
    ) -> bool {
        if !configuration.trigger_mode.is_scheduled() {
            // Setting the wait also ends any "Run now": the override lasts
            // exactly one run.
            let retry_delay_seconds = self.claimed_step_milestone(&capability.tracker_id).map_or(
                termloop_domain::PLAYBOOK_RETRY_DELAY_MIN_SECONDS,
                |milestone| milestone.retry_delay_seconds,
            );
            self.tracker_runtime.step_gate.insert(
                capability.tracker_id.clone(),
                StepGate::NotBefore(
                    completed_at_epoch_ms.saturating_add(retry_delay_seconds.saturating_mul(1_000)),
                ),
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
    /// Task's retry time, so unlike an unanswered/failed run this must not put
    /// a Routine-wide floor in front of another ready Task at the same step.
    pub(crate) fn finish_worker_step_check(
        &mut self,
        capability: &TrackerCheckCapability,
        completed_at_epoch_ms: u64,
        configuration: &TrackerConfiguration,
    ) -> bool {
        self.tracker_runtime
            .step_gate
            .remove(&capability.tracker_id);
        self.finish_runtime_check(
            capability,
            None,
            completed_at_epoch_ms,
            configuration.schedule_interval_seconds,
        )
    }

    /// The first get-next call is also the readiness handshake. Durable
    /// completion timestamps still govern when each Routine becomes due.
    fn ready_worker_session(
        &mut self,
        project_id: &str,
        session_id: &str,
        now_epoch_ms: u64,
    ) -> Result<(), CoreError> {
        let worker = self
            .store
            .worker_configurations()
            .iter()
            .find(|worker| {
                worker.project_id == project_id
                    && worker.enabled
                    && worker.executor_session_id.as_deref() == Some(session_id)
            })
            .ok_or(CoreError::CapabilityDenied)?
            .clone();
        self.tracker_runtime
            .ready_worker_sessions
            .insert(worker.id.clone(), session_id.to_owned());
        self.tracker_runtime.next_worker_ping_epoch_ms.insert(
            worker.id,
            now_epoch_ms.saturating_add(worker.ping_interval_seconds.saturating_mul(1_000)),
        );
        Ok(())
    }

    /// Produces at most one wake per ready Worker. The server claims the exact
    /// assignment immediately before composing and delivering that wake.
    pub fn admit_due_worker_wakes(&mut self, now_epoch_ms: u64) -> Vec<DueWorkerWake> {
        self.initialize_routine_schedules();
        let busy_workers = self.busy_worker_ids();
        let mut wakes = Vec::new();
        for worker in self.store.worker_configurations().iter().filter(|worker| {
            worker.enabled
                && worker.executor_session_id.is_some()
                && !busy_workers.contains(&worker.id)
        }) {
            let session_id = worker
                .executor_session_id
                .as_deref()
                .expect("filtered above");
            if self
                .tracker_runtime
                .ready_worker_sessions
                .get(&worker.id)
                .is_none_or(|ready| ready != session_id)
            {
                continue;
            }
            let has_enabled_routine = self.store.tracker_configurations().iter().any(|routine| {
                routine.enabled
                    && routine.worker_id == worker.id
                    && self.routine_has_work(&routine.id)
            });
            let ping_is_due = self
                .tracker_runtime
                .next_worker_ping_epoch_ms
                .get(&worker.id)
                .is_some_and(|due| *due <= now_epoch_ms);
            // A Worker already working needs no telling. The ping repeats, so
            // one skipped now is not one lost: it stays due and lands the
            // moment the turn ends, instead of queueing behind it once a
            // minute until the Worker surfaces to a stack of them.
            if !has_enabled_routine || !ping_is_due || self.session_turn_is_running(session_id) {
                continue;
            }
            if let Some(pending) = self.tracker_runtime.pending_worker_wakes.get(&worker.id)
                && pending.worker_session_id == session_id
                && pending.retry_at_epoch_ms > now_epoch_ms
            {
                continue;
            }
            self.tracker_runtime.pending_worker_wakes.insert(
                worker.id.clone(),
                PendingWorkerWake {
                    worker_session_id: session_id.to_owned(),
                    retry_at_epoch_ms: now_epoch_ms.saturating_add(WAKE_REDELIVERY_MS),
                },
            );
            wakes.push(DueWorkerWake {
                project_id: worker.project_id.clone(),
                worker_id: worker.id.clone(),
                worker_generation: worker.generation,
                worker_session_id: session_id.to_owned(),
            });
        }
        wakes
    }

    pub fn next_tracker_schedule_epoch_ms(&mut self) -> Option<u64> {
        self.initialize_routine_schedules();
        let busy_workers = self.busy_worker_ids();
        let mut next = None;
        for worker in self
            .store
            .worker_configurations()
            .iter()
            .filter(|worker| worker.enabled)
        {
            let Some(session_id) = worker.executor_session_id.as_deref() else {
                continue;
            };
            if self
                .tracker_runtime
                .ready_worker_sessions
                .get(&worker.id)
                .is_none_or(|ready| ready != session_id)
                || busy_workers.contains(&worker.id)
                // Nothing is scheduled for a Worker mid-turn, so the loop
                // sleeps instead of spinning on a ping it would refuse to
                // admit. The turn ending is what wakes it.
                || self.session_turn_is_running(session_id)
            {
                continue;
            }
            let candidate =
                if let Some(pending) = self.tracker_runtime.pending_worker_wakes.get(&worker.id) {
                    Some(pending.retry_at_epoch_ms)
                } else if self.store.tracker_configurations().iter().any(|routine| {
                    routine.enabled
                        && routine.worker_id == worker.id
                        && self.routine_has_work(&routine.id)
                }) {
                    self.tracker_runtime
                        .next_worker_ping_epoch_ms
                        .get(&worker.id)
                        .copied()
                } else {
                    None
                };
            if let Some(candidate) = candidate {
                next = Some(next.map_or(candidate, |current: u64| current.min(candidate)));
            }
        }
        next
    }

    pub fn claim_next_worker_routine(
        &mut self,
        project_id: &str,
        session_id: &str,
        check_id: String,
        now_epoch_ms: u64,
    ) -> Result<WorkerRoutineClaim, CoreError> {
        self.ready_worker_session(project_id, session_id, now_epoch_ms)?;
        let worker = self
            .store
            .worker_configurations()
            .iter()
            .find(|worker| {
                worker.project_id == project_id
                    && worker.enabled
                    && worker.executor_session_id.as_deref() == Some(session_id)
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)?;
        self.tracker_runtime.pending_worker_wakes.remove(&worker.id);
        self.pending_assistant_wake_deliveries.remove(session_id);

        if let Some((routine_id, active)) = self.active_check_for_worker(&worker.id) {
            let capability = TrackerCheckCapability {
                project_id: project_id.to_owned(),
                tracker_id: routine_id.clone(),
                check_id: active.check_id.clone(),
                generation: active.generation,
                claimed_at_epoch_ms: active.claimed_at_epoch_ms,
                deadline_epoch_ms: active.deadline_epoch_ms,
                worker_id: worker.id.clone(),
                worker_generation: active.worker_generation,
                worker_session_id: session_id.to_owned(),
            };
            let reusable = self
                .validate_current_check(&capability, now_epoch_ms)
                .ok()
                .and_then(|routine| {
                    if routine.trigger_mode.is_scheduled() {
                        active
                            .step_milestone_id
                            .is_none()
                            .then_some((routine, None))
                    } else {
                        active
                            .step_milestone_id
                            .as_ref()
                            .zip(active.step_task_id.as_ref())
                            .and_then(|(milestone_id, task_id)| {
                                self.playbook_step_assignment(&routine.id)
                                    .filter(|assignment| {
                                        assignment.milestone.id == *milestone_id
                                            && assignment.waiting[0].task_id == *task_id
                                    })
                                    .map(|assignment| (routine, Some(assignment)))
                            })
                    }
                });
            if let Some((routine, step)) = reusable {
                return Ok(WorkerRoutineClaim {
                    result: assigned_routine_result(
                        &routine,
                        &capability,
                        now_epoch_ms,
                        step.as_ref(),
                    ),
                    capability: Some(capability),
                });
            }

            // A Playbook edit or explicit Task reset may move the board while
            // a Worker is checking the previously assigned step. Reports for
            // that claim are correctly fenced as stale; get-next must not then
            // replay the same unusable capability forever. Hand the exact
            // claim back and continue selection below so this call either
            // issues a fresh check or returns idle.
            self.release_worker_routine_claim(&capability);
        }

        self.initialize_routine_schedules();
        let selected = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|routine| routine.enabled && routine.worker_id == worker.id)
            .filter_map(|routine| {
                let due = self
                    .tracker_runtime
                    .next_due_epoch_ms
                    .get(&routine.id)
                    .copied()?;
                let explicitly_requested = matches!(
                    self.tracker_runtime.step_gate.get(&routine.id),
                    Some(StepGate::RunNow { .. })
                );
                (due <= now_epoch_ms).then(|| {
                    (
                        !explicitly_requested,
                        due,
                        routine.id.clone(),
                        routine.clone(),
                    )
                })
            })
            .min_by(|left, right| (left.0, left.1, &left.2).cmp(&(right.0, right.1, &right.2)));
        let Some((_, _, _, routine)) = selected else {
            let next_wake = self
                .tracker_runtime
                .next_worker_ping_epoch_ms
                .get(&worker.id)
                .copied();
            return Ok(WorkerRoutineClaim {
                capability: None,
                result: json!({
                    "status": "idle",
                    "nextWakeAtEpochMs": next_wake,
                }),
            });
        };
        if check_id.trim().is_empty() || check_id.len() > 128 {
            return Err(CoreError::InvalidParams("checkId".into()));
        }
        let capability = TrackerCheckCapability {
            project_id: project_id.to_owned(),
            tracker_id: routine.id.clone(),
            check_id,
            generation: routine.generation,
            claimed_at_epoch_ms: now_epoch_ms,
            deadline_epoch_ms: now_epoch_ms.saturating_add(CHECK_DEADLINE_MAX_MS),
            worker_id: worker.id.clone(),
            worker_generation: worker.generation,
            worker_session_id: session_id.to_owned(),
        };
        let step = (!routine.trigger_mode.is_scheduled())
            .then(|| self.playbook_step_assignment(&routine.id))
            .flatten();
        self.tracker_runtime
            .health
            .entry(routine.id.clone())
            .or_default()
            .active = Some(ActiveTrackerCheck {
            check_id: capability.check_id.clone(),
            step_milestone_id: step
                .as_ref()
                .map(|assignment| assignment.milestone.id.clone()),
            step_task_id: step
                .as_ref()
                .map(|assignment| assignment.waiting[0].task_id.clone()),
            generation: capability.generation,
            claimed_at_epoch_ms: capability.claimed_at_epoch_ms,
            deadline_epoch_ms: capability.deadline_epoch_ms,
            ping_sent: false,
            worker_id: capability.worker_id.clone(),
            worker_generation: capability.worker_generation,
            worker_session_id: capability.worker_session_id.clone(),
        });
        Ok(WorkerRoutineClaim {
            result: assigned_routine_result(&routine, &capability, now_epoch_ms, step.as_ref()),
            capability: Some(capability),
        })
    }

    /// Claims the exact due assignment before its scheduled wake is delivered.
    /// The pending wake stays live until terminal delivery succeeds so a failed
    /// submission can release the claim and retry without losing work.
    pub fn claim_due_worker_routine(
        &mut self,
        wake: &DueWorkerWake,
        check_id: String,
        now_epoch_ms: u64,
    ) -> Result<WorkerRoutineClaim, CoreError> {
        if !self.worker_wake_is_current(wake) {
            return Err(CoreError::TrackerReportStale);
        }
        let pending = self
            .tracker_runtime
            .pending_worker_wakes
            .get(&wake.worker_id)
            .cloned()
            .ok_or(CoreError::TrackerReportStale)?;
        let claim = self.claim_next_worker_routine(
            &wake.project_id,
            &wake.worker_session_id,
            check_id,
            now_epoch_ms,
        )?;
        if claim.capability.is_some() {
            self.tracker_runtime
                .pending_worker_wakes
                .insert(wake.worker_id.clone(), pending);
        }
        Ok(claim)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_worker_routine(
        &mut self,
        capability: &TrackerCheckCapability,
        expected_context_revision: u64,
        context_markdown: String,
        update_summary: Option<String>,
        findings: Vec<WorkerRoutineFinding>,
        related_task_ids: Vec<String>,
        report_id: String,
        completed_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let mut configuration = self.validate_current_check(capability, completed_at_epoch_ms)?;
        if expected_context_revision > configuration.context_revision {
            return Err(CoreError::RevisionConflict);
        }
        // A user may edit or clear this Routine's visible context while its
        // Worker is inspecting sources. The findings still belong to the live
        // claimed check, but its replacement Markdown came from an older
        // source document. Preserve the newer user document and finish the
        // check instead of overwriting it or making the Worker retry forever.
        let context_markdown_applied = configuration.context_revision == expected_context_revision;
        if context_markdown.len() > ROUTINE_CONTEXT_MAX_BYTES
            || update_summary
                .as_ref()
                .is_some_and(|summary| summary.trim().is_empty() || summary.len() > 4_096)
            || findings.len() > 16
            || !unique_bounded(&related_task_ids, ROUTINE_RELATED_TASKS_MAX, 256)
            || !self.same_project_tasks_exist(&configuration.project_id, &related_task_ids)
        {
            return Err(CoreError::InvalidParams("routineContext".into()));
        }
        let mut finding_ids = Vec::with_capacity(findings.len());
        let mut finding_keys = Vec::with_capacity(findings.len());
        for finding in &findings {
            let value = PendingRoutineFinding {
                id: finding.id.clone(),
                source_key: finding.source_key.clone(),
                routine_generation: configuration.generation,
                summary: finding.summary.clone(),
                evidence: finding.evidence.clone(),
                source_references: finding.source_references.clone(),
                related_task_ids: finding.related_task_ids.clone(),
                created_at_epoch_ms: completed_at_epoch_ms,
            };
            if !value.is_valid()
                || !valid_source_key(&finding.source_key)
                || finding.summary.trim().is_empty()
                || finding.summary.len() > ROUTINE_FINDING_SUMMARY_MAX_BYTES
                || finding.evidence.trim().is_empty()
                || finding.evidence.len() > ROUTINE_FINDING_EVIDENCE_MAX_BYTES
                || !unique_bounded(
                    &finding.source_references,
                    TRACKER_REPORT_SOURCE_REFS_MAX,
                    TRACKER_REPORT_SOURCE_REF_MAX_BYTES,
                )
                || !unique_bounded(&finding.related_task_ids, ROUTINE_RELATED_TASKS_MAX, 256)
                || finding_ids.contains(&finding.id)
                || finding_keys.contains(&finding.source_key)
                || !self
                    .same_project_tasks_exist(&configuration.project_id, &finding.related_task_ids)
            {
                return Err(CoreError::TrackerReportInvalid);
            }
            finding_ids.push(finding.id.clone());
            finding_keys.push(finding.source_key.clone());
        }

        let novel_findings = findings
            .into_iter()
            .filter(|finding| {
                !configuration
                    .recent_source_keys
                    .contains(&finding.source_key)
            })
            .collect::<Vec<_>>();
        let mut recent_source_keys = configuration.recent_source_keys.clone();
        for finding in &novel_findings {
            if !recent_source_keys.contains(&finding.source_key) {
                recent_source_keys.push(finding.source_key.clone());
            }
        }
        if recent_source_keys.len() > ROUTINE_RECENT_SOURCE_KEYS_MAX {
            recent_source_keys.drain(
                ..recent_source_keys
                    .len()
                    .saturating_sub(ROUTINE_RECENT_SOURCE_KEYS_MAX),
            );
        }
        let pending_findings = if configuration.trigger_mode.is_scheduled()
            && configuration.action_handling != RoutineActionHandling::Off
        {
            novel_findings
                .iter()
                .map(|finding| PendingRoutineFinding {
                    id: finding.id.clone(),
                    source_key: finding.source_key.clone(),
                    routine_generation: configuration.generation,
                    summary: finding.summary.trim().to_owned(),
                    evidence: finding.evidence.trim().to_owned(),
                    source_references: finding.source_references.clone(),
                    related_task_ids: finding.related_task_ids.clone(),
                    created_at_epoch_ms: completed_at_epoch_ms,
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        if configuration
            .pending_routine_findings
            .len()
            .saturating_add(pending_findings.len())
            > ROUTINE_PENDING_FINDINGS_MAX
        {
            return Err(CoreError::TrackerReportInvalid);
        }
        configuration
            .pending_routine_findings
            .extend(pending_findings.iter().cloned());
        let context_changed = (context_markdown_applied
            && configuration.context_markdown != context_markdown)
            || configuration.recent_source_keys != recent_source_keys
            || configuration.related_task_ids != related_task_ids;
        if context_changed {
            configuration.context_revision = configuration
                .context_revision
                .checked_add(1)
                .ok_or(CoreError::RevisionConflict)?;
        }
        if context_markdown_applied {
            configuration.context_markdown = context_markdown;
        }
        configuration.recent_source_keys = recent_source_keys;
        configuration.related_task_ids = related_task_ids.clone();
        configuration.last_check_started_at_epoch_ms = Some(capability.claimed_at_epoch_ms);
        configuration.last_attempt_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.last_successful_report_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.updated_at_epoch_ms = completed_at_epoch_ms;

        let update_summary = update_summary.map(|summary| summary.trim().to_owned());
        let report = if update_summary.is_none() && novel_findings.is_empty() {
            None
        } else {
            let mut message_parts = Vec::new();
            if let Some(summary) = update_summary.as_ref() {
                message_parts.push(summary.clone());
            }
            message_parts.extend(novel_findings.iter().map(|finding| {
                format!(
                    "- {}\n  Evidence: {}",
                    finding.summary.trim(),
                    finding.evidence.trim()
                )
            }));
            let message = message_parts.join("\n");
            let source_references = novel_findings
                .iter()
                .flat_map(|finding| finding.source_references.iter().cloned())
                .fold(Vec::new(), |mut values, reference| {
                    if !values.contains(&reference) {
                        values.push(reference);
                    }
                    values
                });
            let report_task_ids = update_summary
                .as_ref()
                .map_or_else(Vec::new, |_| related_task_ids.clone())
                .into_iter()
                .chain(
                    novel_findings
                        .iter()
                        .flat_map(|finding| finding.related_task_ids.iter().cloned()),
                )
                .fold(Vec::new(), |mut values, task_id| {
                    if !values.contains(&task_id) {
                        values.push(task_id);
                    }
                    values
                });
            let report = TrackerReport {
                id: report_id,
                project_id: capability.project_id.clone(),
                routine_id: capability.tracker_id.clone(),
                check_id: capability.check_id.clone(),
                generation: capability.generation,
                kind: TrackerReportKind::Success,
                message,
                source_references,
                related_task_ids: report_task_ids,
                created_at_epoch_ms: completed_at_epoch_ms,
            };
            if !report.is_valid() {
                return Err(CoreError::TrackerReportInvalid);
            }
            Some(report)
        };
        self.store
            .set_tracker_configuration(
                &self.write_authority,
                configuration.clone(),
                self.store.revision(),
            )
            .map_err(store_error)?;
        let pending_trigger = self.finish_worker_routine_check(
            capability,
            None,
            completed_at_epoch_ms,
            &configuration,
        );
        if let Some(report) = report.as_ref() {
            self.push_runtime_report(report.clone());
        }
        Ok(json!({
            "status": "completed",
            "newFindingCount": novel_findings.len(),
            "newPendingFindingCount": pending_findings.len(),
            "contextChanged": context_changed,
            "contextMarkdownApplied": context_markdown_applied,
            "contextRevision": configuration.context_revision,
            "pendingTrigger": pending_trigger,
            "reportCreated": report.is_some(),
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn report_worker_routine_problem(
        &mut self,
        capability: &TrackerCheckCapability,
        message: String,
        source_references: Vec<String>,
        report_id: String,
        completed_at_epoch_ms: u64,
    ) -> Result<Value, CoreError> {
        let mut configuration = self.validate_current_check(capability, completed_at_epoch_ms)?;
        let related_task_ids: Vec<String> = if configuration.trigger_mode.is_scheduled() {
            configuration
                .related_task_ids
                .iter()
                .filter(|task_id| {
                    self.store.tasks().iter().any(|task| {
                        task.id == **task_id && task.project_id == configuration.project_id
                    })
                })
                .cloned()
                .collect()
        } else {
            self.claimed_step_task_id(&capability.tracker_id)
                .into_iter()
                .collect()
        };
        let message = message.trim().to_owned();
        let report = TrackerReport {
            id: report_id,
            project_id: capability.project_id.clone(),
            routine_id: capability.tracker_id.clone(),
            check_id: capability.check_id.clone(),
            generation: capability.generation,
            kind: TrackerReportKind::Problem,
            message: message.clone(),
            source_references: source_references.clone(),
            related_task_ids: related_task_ids.clone(),
            created_at_epoch_ms: completed_at_epoch_ms,
        };
        if !report.is_valid() {
            return Err(CoreError::TrackerReportInvalid);
        }
        let duplicate_report = self
            .tracker_runtime
            .reports
            .iter()
            .rev()
            .find(|candidate| {
                candidate.project_id == report.project_id
                    && candidate.routine_id == report.routine_id
            })
            .is_some_and(|candidate| {
                candidate.kind == TrackerReportKind::Problem
                    && candidate.message == report.message
                    && candidate.source_references == report.source_references
                    && candidate.related_task_ids == report.related_task_ids
            });
        let problem_episode = configuration
            .last_successful_report_at_epoch_ms
            .unwrap_or(0)
            .to_string();
        let source_key = worker_problem_source_key(
            &configuration.id,
            &problem_episode,
            &message,
            &source_references,
            &related_task_ids,
        );
        let mut new_pending_finding_count = 0;
        let mut steward_review_required = false;
        if configuration.action_handling != RoutineActionHandling::Off {
            if configuration
                .pending_routine_findings
                .iter()
                .any(|finding| finding.source_key == source_key)
            {
                steward_review_required =
                    !self.companion_has_pending_proposal(&configuration.project_id);
            } else if !configuration.recent_source_keys.contains(&source_key) {
                let summary = format!(
                    "{} could not complete its evidence check.",
                    configuration.name
                );
                let evidence = truncate_utf8(&message, ROUTINE_FINDING_EVIDENCE_MAX_BYTES);
                let replacement_index = if related_task_ids.is_empty() {
                    None
                } else {
                    configuration
                        .pending_routine_findings
                        .iter()
                        .position(|finding| {
                            finding
                                .related_task_ids
                                .iter()
                                .any(|task_id| related_task_ids.contains(task_id))
                        })
                };
                if let Some(index) = replacement_index {
                    let finding_id = configuration.pending_routine_findings[index].id.clone();
                    configuration.pending_routine_findings[index] = PendingRoutineFinding {
                        id: finding_id.clone(),
                        source_key: source_key.clone(),
                        routine_generation: configuration.generation,
                        summary,
                        evidence,
                        source_references: source_references.clone(),
                        related_task_ids: related_task_ids.clone(),
                        created_at_epoch_ms: completed_at_epoch_ms,
                    };
                    steward_review_required =
                        !self.companion_has_pending_proposal(&configuration.project_id);
                } else if configuration.pending_routine_findings.len()
                    < ROUTINE_PENDING_FINDINGS_MAX
                {
                    configuration
                        .pending_routine_findings
                        .push(PendingRoutineFinding {
                            id: report.id.clone(),
                            source_key: source_key.clone(),
                            routine_generation: configuration.generation,
                            summary,
                            evidence,
                            source_references: source_references.clone(),
                            related_task_ids: related_task_ids.clone(),
                            created_at_epoch_ms: completed_at_epoch_ms,
                        });
                    new_pending_finding_count = 1;
                    steward_review_required = true;
                }
                if steward_review_required {
                    configuration.recent_source_keys.push(source_key);
                }
            }
        }
        if configuration.recent_source_keys.len() > ROUTINE_RECENT_SOURCE_KEYS_MAX {
            configuration.recent_source_keys.drain(
                ..configuration
                    .recent_source_keys
                    .len()
                    .saturating_sub(ROUTINE_RECENT_SOURCE_KEYS_MAX),
            );
        }
        configuration.last_check_started_at_epoch_ms = Some(capability.claimed_at_epoch_ms);
        configuration.last_attempt_at_epoch_ms = Some(completed_at_epoch_ms);
        configuration.updated_at_epoch_ms = completed_at_epoch_ms;
        self.store
            .set_tracker_configuration(
                &self.write_authority,
                configuration.clone(),
                self.store.revision(),
            )
            .map_err(store_error)?;
        let pending_trigger = self.finish_worker_routine_check(
            capability,
            Some(message),
            completed_at_epoch_ms,
            &configuration,
        );
        if !duplicate_report {
            self.push_runtime_report(report);
        }
        Ok(json!({
            "status": "problemReported",
            "pendingTrigger": pending_trigger,
            "problemChanged": !duplicate_report,
            "reportCreated": !duplicate_report,
            "relatedTaskIds": related_task_ids,
            "newPendingFindingCount": new_pending_finding_count,
            "stewardReviewRequired": steward_review_required,
            "stateRevision": self.store.revision(),
        }))
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
            .tracker_runtime
            .health
            .get(&capability.tracker_id)
            .and_then(|health| health.active.as_ref())
            .ok_or(CoreError::TrackerReportStale)?;
        let worker_current = self.store.worker_configurations().iter().any(|worker| {
            worker.id == capability.worker_id
                && worker.project_id == capability.project_id
                && worker.enabled
                && worker.generation == capability.worker_generation
                && worker.executor_session_id.as_deref()
                    == Some(capability.worker_session_id.as_str())
        });
        if !configuration.enabled
            || configuration.project_id != capability.project_id
            || configuration.generation != capability.generation
            || configuration.worker_id != capability.worker_id
            || active.check_id != capability.check_id
            || active.generation != capability.generation
            || active.claimed_at_epoch_ms != capability.claimed_at_epoch_ms
            || active.worker_id != capability.worker_id
            || active.worker_generation != capability.worker_generation
            || active.worker_session_id != capability.worker_session_id
            || completed_at_epoch_ms
                > active
                    .deadline_epoch_ms
                    .saturating_add(OVERDUE_PING_GRACE_MS)
            || !worker_current
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
        health.active = None;
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
            let Some(active) = health.active.as_mut() else {
                continue;
            };
            if !active.ping_sent && now_epoch_ms >= active.deadline_epoch_ms {
                active.ping_sent = true;
                changed = true;
            } else if active.ping_sent
                && now_epoch_ms
                    >= active
                        .deadline_epoch_ms
                        .saturating_add(OVERDUE_PING_GRACE_MS)
            {
                health.active = None;
                health.pending_trigger = false;
                expired.push(routine_id.clone());
                changed = true;
            }
        }
        for routine_id in expired {
            let retry_at = now_epoch_ms.saturating_add(CHECK_TIMEOUT_RETRY_MS);
            self.tracker_runtime
                .next_due_epoch_ms
                .insert(routine_id.clone(), retry_at);
            // A step check's due time is otherwise derived from Tasks that are
            // still waiting, which would make the abandoned claim due again at
            // once; the floor is what actually holds it back.
            if self
                .store
                .tracker_configurations()
                .iter()
                .any(|routine| routine.id == routine_id && !routine.trigger_mode.is_scheduled())
            {
                self.tracker_runtime
                    .step_gate
                    .insert(routine_id, StepGate::NotBefore(retry_at));
            }
        }
        Ok(TrackerDeadlineAdvance { changed })
    }

    pub fn next_tracker_deadline_epoch_ms(&self) -> Option<u64> {
        self.tracker_runtime
            .health
            .values()
            .filter_map(|health| health.active.as_ref())
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
        Ok(self.claimed_step_task_id(&capability.tracker_id))
    }

    pub fn release_worker_routine_claim(&mut self, capability: &TrackerCheckCapability) -> bool {
        let exact_active_claim = self
            .tracker_runtime
            .health
            .get(&capability.tracker_id)
            .and_then(|health| health.active.as_ref())
            .is_some_and(|active| {
                active.check_id == capability.check_id
                    && active.generation == capability.generation
                    && active.claimed_at_epoch_ms == capability.claimed_at_epoch_ms
                    && active.deadline_epoch_ms == capability.deadline_epoch_ms
                    && active.worker_id == capability.worker_id
                    && active.worker_generation == capability.worker_generation
                    && active.worker_session_id == capability.worker_session_id
            });
        if !exact_active_claim {
            return false;
        }
        if let Some(health) = self.tracker_runtime.health.get_mut(&capability.tracker_id) {
            health.active = None;
        }
        self.tracker_runtime.next_due_epoch_ms.insert(
            capability.tracker_id.clone(),
            capability.claimed_at_epoch_ms,
        );
        // A claim handed back unused answered nothing, so the wait it would
        // have earned is dropped. A "Run now" the user is still waiting on is
        // not: this run never happened.
        if matches!(
            self.tracker_runtime.step_gate.get(&capability.tracker_id),
            Some(StepGate::NotBefore(_))
        ) {
            self.tracker_runtime
                .step_gate
                .remove(&capability.tracker_id);
        }
        true
    }

    pub fn worker_wake_is_current(&self, wake: &DueWorkerWake) -> bool {
        self.store.worker_configurations().iter().any(|worker| {
            worker.id == wake.worker_id
                && worker.project_id == wake.project_id
                && worker.enabled
                && worker.generation == wake.worker_generation
                && worker.executor_session_id.as_deref() == Some(wake.worker_session_id.as_str())
        }) && self
            .tracker_runtime
            .pending_worker_wakes
            .get(&wake.worker_id)
            .is_some_and(|pending| pending.worker_session_id == wake.worker_session_id)
    }

    pub fn fail_worker_wake_delivery(&mut self, wake: &DueWorkerWake, retry_at_epoch_ms: u64) {
        if self.worker_wake_is_current(wake)
            && let Some(pending) = self
                .tracker_runtime
                .pending_worker_wakes
                .get_mut(&wake.worker_id)
        {
            pending.retry_at_epoch_ms = retry_at_epoch_ms;
        }
    }

    pub(crate) fn acknowledge_worker_wake_delivery(&mut self, wake: &DueWorkerWake) {
        self.tracker_runtime
            .pending_worker_wakes
            .remove(&wake.worker_id);
    }

    pub fn list_tracker_runtime(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let health = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .map(|configuration| {
                let current = self.tracker_runtime.health.get(&configuration.id);
                let active = current.and_then(|health| health.active.as_ref());
                json!({
                    "routineId": configuration.id,
                    "generation": configuration.generation,
                    "triggerMode": configuration.trigger_mode,
                    "name": configuration.name,
                    "contextMarkdown": configuration.context_markdown,
                    "contextRevision": configuration.context_revision,
                    "relatedTaskIds": configuration.related_task_ids,
                    "state": if active.is_some_and(|check| check.ping_sent) {
                        "overdue"
                    } else if active.is_some() {
                        "checking"
                    } else if current.is_some_and(|health| health.attention_message.is_some()) {
                        "attention"
                    } else {
                        "idle"
                    },
                    "checkId": active.map(|check| &check.check_id),
                    "deadlineEpochMs": active.map(|check| check.deadline_epoch_ms),
                    "pingSent": active.is_some_and(|check| check.ping_sent),
                    "pendingTrigger": current.is_some_and(|health| health.pending_trigger),
                    "attentionMessage": current.and_then(|health| health.attention_message.as_deref()),
                    "lastAttemptAtEpochMs": configuration.last_attempt_at_epoch_ms,
                    "lastSuccessfulReportAtEpochMs": configuration.last_successful_report_at_epoch_ms,
                    "nextDueAtEpochMs": self.tracker_runtime.next_due_epoch_ms.get(&configuration.id).copied().or_else(|| Some(routine_next_due(configuration))),
                })
            })
            .collect::<Vec<_>>();
        let mut reports = Vec::new();
        let mut encoded_bytes = 0_usize;
        let mut reports_truncated = false;
        for report in self
            .tracker_runtime
            .reports
            .iter()
            .rev()
            .filter(|report| report.project_id == project_id)
        {
            let report_bytes = serde_json::to_vec(report)
                .map_err(|_| CoreError::Store("Routine report projection encoding failed".into()))?
                .len();
            if encoded_bytes.saturating_add(report_bytes)
                > ROUTINE_REPORT_PROJECTION_MAX_ENCODED_BYTES
            {
                reports_truncated = true;
                break;
            }
            encoded_bytes = encoded_bytes.saturating_add(report_bytes);
            reports.push(report.clone());
        }
        Ok(json!({
            "health": health,
            "reports": reports,
            "reportsTruncated": reports_truncated,
            "stateRevision": self.store.revision(),
        }))
    }

    pub fn run_routine_now(
        &mut self,
        routine_id: &str,
        now_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        self.run_routine_now_target(routine_id, None, now_epoch_ms)
    }

    /// Runs one pipeline question for the exact Task selected in Task details.
    /// This is a one-shot runtime override; it does not reorder or persist the
    /// Project's normal focused-Task scheduler.
    pub fn run_task_routine_now(
        &mut self,
        routine_id: &str,
        task_id: &str,
        now_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        if task_id.trim().is_empty() || task_id.len() > 64 {
            return Err(CoreError::InvalidParams("taskId".into()));
        }
        self.run_routine_now_target(routine_id, Some(task_id), now_epoch_ms)
    }

    fn run_routine_now_target(
        &mut self,
        routine_id: &str,
        task_id: Option<&str>,
        now_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        let routine = self
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == routine_id)
            .ok_or(CoreError::NotFound)?;
        if !routine.enabled {
            return Err(CoreError::TrackerReportStale);
        }
        let worker_id = routine.worker_id.clone();
        let on_demand = !routine.trigger_mode.is_scheduled();
        if task_id.is_some() && !on_demand {
            return Err(CoreError::InvalidParams("taskId".into()));
        }
        if let Some(task_id) = task_id
            && self.tracker_runtime.tracker_is_active(routine_id)
        {
            return if self.claimed_step_task_id(routine_id).as_deref() == Some(task_id) {
                Ok(false)
            } else {
                Err(CoreError::InvalidParams(
                    "Routine is already checking another Task".into(),
                ))
            };
        }
        // A step check has nothing to run when no Task stands at its question.
        // Say so rather than reporting a run that the derived schedule would
        // silently drop on the next pass.
        let step_has_work = task_id.map_or_else(
            || self.playbook_step_due_epoch_ms(routine_id).is_some(),
            |task_id| {
                self.playbook_step_assignment_for_task(routine_id, task_id)
                    .is_some()
            },
        );
        if on_demand && !step_has_work {
            return Err(CoreError::PlaybookStepIdle);
        }
        let already_pending = self.tracker_runtime.tracker_is_active(routine_id)
            || self
                .tracker_runtime
                .next_due_epoch_ms
                .get(routine_id)
                .is_some_and(|due| *due <= now_epoch_ms);
        self.tracker_runtime
            .schedule_tracker_now(routine_id, now_epoch_ms);
        if on_demand {
            self.tracker_runtime.step_gate.insert(
                routine_id.to_owned(),
                StepGate::RunNow {
                    at_epoch_ms: now_epoch_ms,
                    task_id: task_id.map(str::to_owned),
                },
            );
        }
        self.tracker_runtime
            .schedule_worker_ping_now(&worker_id, now_epoch_ms);
        if self.tracker_runtime.tracker_is_active(routine_id) {
            self.tracker_runtime
                .health
                .entry(routine_id.to_owned())
                .or_default()
                .pending_trigger = true;
        }
        if let Some(pending) = self
            .tracker_runtime
            .pending_worker_wakes
            .get_mut(&worker_id)
        {
            pending.retry_at_epoch_ms = now_epoch_ms;
        }
        Ok(!already_pending)
    }

    pub(crate) fn retain_current_tracker_runtime(&mut self) {
        let routine_ids = self
            .store
            .tracker_configurations()
            .iter()
            .map(|configuration| configuration.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let worker_ids = self
            .store
            .worker_configurations()
            .iter()
            .map(|worker| worker.id.as_str())
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
            .step_gate
            .retain(|routine_id, _| routine_ids.contains(routine_id.as_str()));
        self.tracker_runtime
            .ready_worker_sessions
            .retain(|worker_id, _| worker_ids.contains(worker_id.as_str()));
        self.tracker_runtime
            .next_worker_ping_epoch_ms
            .retain(|worker_id, _| worker_ids.contains(worker_id.as_str()));
        self.tracker_runtime
            .pending_worker_wakes
            .retain(|worker_id, _| worker_ids.contains(worker_id.as_str()));
    }

    fn active_check_for_worker(&self, worker_id: &str) -> Option<(String, ActiveTrackerCheck)> {
        self.tracker_runtime
            .health
            .iter()
            .find_map(|(routine_id, health)| {
                health.active.as_ref().and_then(|active| {
                    (active.worker_id == worker_id).then(|| (routine_id.clone(), active.clone()))
                })
            })
    }

    fn busy_worker_ids(&self) -> std::collections::HashSet<String> {
        self.tracker_runtime
            .health
            .values()
            .filter_map(|health| {
                health
                    .active
                    .as_ref()
                    .map(|active| active.worker_id.clone())
            })
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

fn assigned_routine_result(
    routine: &TrackerConfiguration,
    capability: &TrackerCheckCapability,
    now_epoch_ms: u64,
    step: Option<&super::playbook_runtime::PlaybookStepAssignment>,
) -> Value {
    let scan_since = routine.last_check_started_at_epoch_ms.map_or_else(
        || now_epoch_ms.saturating_sub(routine.schedule_interval_seconds.saturating_mul(1_000)),
        |previous| previous.saturating_sub(ROUTINE_SCAN_OVERLAP_MS),
    );
    let mut result = json!({
        "status": "assigned",
        "checkId": capability.check_id,
        "routine": {
            "id": routine.id,
            "name": routine.name,
            "instructions": routine.prompt,
            "scheduleIntervalSeconds": routine.schedule_interval_seconds,
        },
        "context": {
            "revision": routine.context_revision,
            "markdown": routine.context_markdown,
            "evidenceKind": "workerAuthoredMemory",
            "independentlyVerified": false,
            "scanSinceEpochMs": scan_since,
            "lastFinishedAtEpochMs": routine.last_attempt_at_epoch_ms,
            "recentSourceKeys": routine.recent_source_keys,
            "relatedTaskIds": routine.related_task_ids,
        },
        "claimedAtEpochMs": capability.claimed_at_epoch_ms,
        "leaseExpiresAtEpochMs": capability.deadline_epoch_ms,
    });
    // A step Routine evaluates one stage for a named set of Tasks. It finishes
    // with verdicts rather than findings, so the assignment says so instead of
    // leaving the Worker to infer it from the trigger mode.
    if let Some(step) = step {
        result["step"] = json!({
            "milestoneId": step.milestone.id,
            "title": step.milestone.title,
            "gate": step.milestone.gate,
            "completeWhen": routine.prompt,
            "approver": step.milestone.approver,
            "retryDelaySeconds": step.milestone.retry_delay_seconds,
            "finishWith": "worker_complete_assignment",
            "taskRead": {
                "requiredBeforeVerdict": true,
                "tool": "task_read",
                "arguments": {
                    "taskId": step.waiting[0].task_id,
                    "checkId": capability.check_id,
                },
            },
            "tasks": step
                .waiting
                .iter()
                .map(|task| {
                    json!({
                        "taskId": task.task_id,
                        "title": task.title,
                        "dueAtEpochMs": task.due_at_epoch_ms,
                        "lastEvidence": task.last_evidence,
                        "lastEvidenceKind": "previousWorkerVerdict",
                        "lastEvidenceIndependentlyVerified": false,
                    })
                })
                .collect::<Vec<_>>(),
        });
    }
    result
}

pub(crate) fn is_worker_problem_source_key(value: &str) -> bool {
    value.starts_with("worker-problem:")
}

fn worker_problem_source_key(
    routine_id: &str,
    episode: &str,
    message: &str,
    source_references: &[String],
    related_task_ids: &[String],
) -> String {
    let mut digest = Sha256::new();
    for part in std::iter::once(routine_id)
        .chain(std::iter::once(episode))
        .chain(std::iter::once(message))
        .chain(source_references.iter().map(String::as_str))
        .chain(related_task_ids.iter().map(String::as_str))
    {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    let digest = digest.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    format!("worker-problem:{hex}")
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn valid_source_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= ROUTINE_SOURCE_KEY_MAX_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

fn unique_bounded(values: &[String], max_items: usize, max_bytes: usize) -> bool {
    values.len() <= max_items
        && values.iter().enumerate().all(|(index, value)| {
            !value.trim().is_empty()
                && value.len() <= max_bytes
                && !values[index + 1..].contains(value)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use termloop_domain::{
        AgentLaunchSelection, ProcessDescriptor, ResumeProvider, ResumeRef, RoutineTriggerMode,
        SessionKind, SessionRecord, StewardAgentId, WorkerConfiguration,
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
            .set_worker_configuration(
                &runtime.write_authority,
                WorkerConfiguration {
                    id: "worker-1".into(),
                    project_id: project_id.clone(),
                    name: "Routine Worker".into(),
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
                runtime.store.revision(),
            )
            .unwrap();
        runtime
            .store
            .attach_worker_executor_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "worker-session".into(),
                    project_id: project_id.clone(),
                    name: Some("Routine Worker".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: root.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.worker.executor".into()),
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
                "worker-1",
                1,
                100,
            )
            .unwrap();
        runtime
            .store
            .mark_agent_conversation_resumable(&runtime.write_authority, "worker-session")
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
                        worker_id: "worker-1".into(),
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-a".into(), 100)
            .unwrap();
        let first_capability = first.capability.unwrap();
        assert_eq!(first_capability.tracker_id, "routine-a");
        let retried = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "ignored".into(), 101)
            .unwrap();
        assert_eq!(retried.capability.unwrap().check_id, "check-a");

        runtime
            .complete_worker_routine(
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-b".into(), 201)
            .unwrap();
        let second_capability = second.capability.unwrap();
        assert_eq!(second_capability.tracker_id, "routine-b");
        runtime
            .complete_worker_routine(
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
            .claim_next_worker_routine(&project_id, "worker-session", "unused".into(), 251)
            .unwrap();
        assert!(idle.capability.is_none());
        assert_eq!(idle.result["nextWakeAtEpochMs"], 60_251);

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
            reopened.store.worker_configurations()[0]
                .executor_session_id
                .as_deref(),
            Some("worker-session")
        );
        assert_eq!(
            reopened
                .store
                .sessions()
                .iter()
                .find(|session| session.id == "worker-session")
                .unwrap()
                .lifecycle_state,
            "resuming"
        );
        let after_restart = reopened
            .claim_next_worker_routine(&project_id, "worker-session", "too-early".into(), 300)
            .unwrap();
        assert!(after_restart.capability.is_none());
        assert_eq!(after_restart.result["nextWakeAtEpochMs"], 60_300);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_get_next_readiness_exposes_a_future_schedule_to_the_supervisor() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), None);
        let idle = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "not-due".into(), 0)
            .unwrap();
        assert!(idle.capability.is_none());
        assert_eq!(idle.result["nextWakeAtEpochMs"], 60_000);
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), Some(60_000));
        assert!(runtime.admit_due_worker_wakes(59_999).is_empty());
        let wakes = runtime.admit_due_worker_wakes(60_000);
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].worker_id, "worker-1");
        let claimed = runtime
            .claim_due_worker_routine(&wakes[0], "due".into(), 60_000)
            .unwrap();
        assert_eq!(claimed.capability.unwrap().tracker_id, "routine-a");
        assert!(runtime.worker_wake_is_current(&wakes[0]));
        runtime.acknowledge_worker_wake_delivery(&wakes[0]);
        assert!(!runtime.worker_wake_is_current(&wakes[0]));

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_worker_already_mid_turn_is_not_pinged_until_it_finishes() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let idle = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "not-due".into(), 0)
            .unwrap();
        assert!(idle.capability.is_none());

        // The Worker is in the middle of a turn. A wake is a message typed into
        // its terminal, and one typed now is not read until the turn ends, so
        // the ping is held rather than stacked behind it.
        runtime.agent_observations.insert(
            "worker-session".into(),
            crate::AgentObservationCapability {
                token: Some("worker-token".into()),
                runtime_epoch: 1,
                last_signal: None,
                defer_generated_input_until_hook_response: false,
                last_notification_type: None,
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
        assert!(runtime.admit_due_worker_wakes(60_000).is_empty());
        // The loop must agree with the admission, or it would spin on a ping it
        // has already decided not to send.
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), None);

        // Nothing was spent: the ping is still due, so finishing the turn is
        // enough to be told at once.
        let observation = runtime
            .agent_observations
            .get_mut("worker-session")
            .expect("the Worker Session is still observed");
        observation.observation = Some(termloop_agents::reduce_observation(
            observation.observation,
            termloop_agents::AgentSignal::Stopped,
            termloop_agents::AgentSignalSource::Hook,
            2,
            60_100,
        ));
        assert_eq!(runtime.next_tracker_schedule_epoch_ms(), Some(60_000));
        let wakes = runtime.admit_due_worker_wakes(60_100);
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].worker_id, "worker-1");

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changing_worker_ping_interval_keeps_the_running_session() {
        let (mut runtime, root, _project_id) = runtime_with_routines(1);
        let updated = runtime
            .update_worker_configuration(
                "worker-1",
                "Routine Worker".into(),
                "codex",
                "default".into(),
                "bypassPermissions".into(),
                "default".into(),
                true,
                15 * 60,
                String::new(),
                String::new(),
                runtime.state_revision(),
                crate::AssistantAvailability::Proven,
                500,
            )
            .unwrap();
        assert_eq!(updated["configuration"]["pingIntervalSeconds"], 900);
        assert_eq!(
            updated["configuration"]["executorSessionId"],
            "worker-session"
        );
        assert_eq!(updated["configuration"]["generation"], 1);

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changing_worker_prompts_retires_the_running_session() {
        let (mut runtime, root, project_id) = runtime_with_routines(1);
        let updated = runtime
            .update_worker_configuration(
                "worker-1",
                "Routine Worker".into(),
                "codex",
                "gpt-5.6-sol".into(),
                "bypassPermissions".into(),
                "high".into(),
                true,
                60,
                "Summarize every Routine.".into(),
                "Answer briefly in Turkish.".into(),
                runtime.state_revision(),
                crate::AssistantAvailability::Proven,
                500,
            )
            .unwrap();
        assert_eq!(
            updated["configuration"]["workerPrompt"],
            "Summarize every Routine."
        );
        assert_eq!(
            updated["configuration"]["systemPrompt"],
            "Answer briefly in Turkish."
        );
        assert!(updated["configuration"]["executorSessionId"].is_null());
        assert_eq!(updated["configuration"]["generation"], 2);
        assert_eq!(updated["configuration"]["model"], "gpt-5.6-sol");
        assert_eq!(updated["configuration"]["reasoning"], "high");
        let projected = runtime
            .list_worker_configurations(json!({"projectId": project_id}))
            .unwrap();
        assert_eq!(projected["promptContexts"][0]["workerId"], "worker-1");
        assert!(
            projected["promptContexts"][0]["instructionsPrompt"]
                .as_str()
                .unwrap()
                .ends_with("## Configured System prompt\n\nAnswer briefly in Turkish.")
        );
        assert!(
            projected["promptContexts"][0]["protectedPrompt"]
                .as_str()
                .unwrap()
                .contains("worker_get_next_routine")
        );
        assert!(
            projected["promptContexts"][0]["wakePrompt"]
                .as_str()
                .unwrap()
                .contains("repeat until get-next returns idle")
        );

        let editable = "Handle Routine work and report only new findings.";
        runtime
            .update_worker_configuration(
                "worker-1",
                "Routine Worker".into(),
                "codex",
                "default".into(),
                "bypassPermissions".into(),
                "default".into(),
                true,
                60,
                String::new(),
                editable.into(),
                runtime.state_revision(),
                crate::AssistantAvailability::Proven,
                600,
            )
            .unwrap();
        let consolidated = runtime
            .list_worker_configurations(json!({"projectId": project_id}))
            .unwrap();
        let prompt_context = &consolidated["promptContexts"][0];
        assert_eq!(
            prompt_context["instructionsPrompt"].as_str().unwrap(),
            format!(
                "{}\n\n{editable}",
                prompt_context["protectedPrompt"].as_str().unwrap()
            )
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-1".into(), 1_000)
            .unwrap()
            .capability
            .unwrap();
        assert!(matches!(
            runtime.complete_worker_routine(
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

        let finding = WorkerRoutineFinding {
            id: "finding-1".into(),
            source_key: "slack:C123:1700.001".into(),
            summary: "A follow-up is waiting.".into(),
            evidence: "The follow-up message has no visible response.".into(),
            source_references: vec!["slack://C123/1700.001".into()],
            related_task_ids: vec![task_id.clone()],
        };
        let completed = runtime
            .complete_worker_routine(
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-2".into(), 1_200)
            .unwrap()
            .capability
            .unwrap();
        let duplicate = runtime
            .complete_worker_routine(
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-3".into(), 1_300)
            .unwrap()
            .capability
            .unwrap();
        let action = runtime
            .complete_worker_routine(
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
        runtime
            .set_steward_configuration(crate::StewardConfigurationUpdate {
                project_id: &project_id,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled: true,
                system_prompt: String::new(),
                expected_revision: runtime.state_revision(),
                capability: crate::AssistantAvailability::Proven,
                updated_at_epoch_ms: 900,
            })
            .unwrap();
        let steward_generation = runtime
            .store
            .steward_configurations()
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .unwrap()
            .generation;
        runtime
            .store
            .attach_steward_executor_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "steward-session".into(),
                    project_id: project_id.clone(),
                    name: Some("Project Steward".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: root.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.steward.executor".into()),
                        template_version: Some(1),
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
                &project_id,
                steward_generation,
                950,
            )
            .unwrap();

        let first = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "action-1".into(), 1_000)
            .unwrap();
        assert!(first.result["routine"].get("actionHandling").is_none());
        assert!(first.result["routine"].get("stewardInstructions").is_none());
        let first = first.capability.unwrap();
        let finding = WorkerRoutineFinding {
            id: "finding-1".into(),
            source_key: "slack:C123:review-request:42".into(),
            summary: "No review request for PR 42 is visible.".into(),
            evidence: "The inspected channel contains no message referencing PR 42.".into(),
            source_references: vec!["slack://C123".into()],
            related_task_ids: vec![],
        };
        let second_finding = WorkerRoutineFinding {
            id: "finding-2".into(),
            source_key: "slack:C123:review-request:43".into(),
            summary: "No review request for PR 43 is visible.".into(),
            evidence: "The inspected channel contains no message referencing PR 43.".into(),
            source_references: vec!["slack://C123".into()],
            related_task_ids: vec![],
        };
        let completed = runtime
            .complete_worker_routine(
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
            .claim_next_worker_routine(&project_id, "worker-session", "action-2".into(), 1_200)
            .unwrap()
            .capability
            .unwrap();
        let duplicate = runtime
            .complete_worker_routine(
                &duplicate,
                2,
                String::new(),
                None,
                vec![WorkerRoutineFinding {
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
        let finding = WorkerRoutineFinding {
            id: "finding-1".into(),
            source_key: "slack:C123:1700.001".into(),
            summary: "A follow-up is waiting.".into(),
            evidence: "The follow-up message has no visible response.".into(),
            source_references: vec!["slack://C123/1700.001".into()],
            related_task_ids: vec![],
        };
        let first = runtime
            .claim_next_worker_routine(&project_id, "worker-session", "check-1".into(), 1_000)
            .unwrap()
            .capability
            .unwrap();
        runtime
            .complete_worker_routine(
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-2".into(), 1_200)
            .unwrap()
            .capability
            .unwrap();
        let completed = runtime
            .complete_worker_routine(
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
            .claim_next_worker_routine(
                &project_id,
                "worker-session",
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
        assert!(runtime.release_worker_routine_claim(&stale));
        assert!(!runtime.release_worker_routine_claim(&stale));

        let fresh = runtime
            .claim_next_worker_routine(
                &project_id,
                "worker-session",
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-context".into(), 500)
            .unwrap();
        assert_eq!(claim.result["context"]["revision"], 2);
        assert_eq!(
            claim.result["context"]["evidenceKind"],
            "workerAuthoredMemory"
        );
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
            .claim_next_worker_routine(
                &project_id,
                "worker-session",
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
            .complete_worker_routine(
                &claim,
                1,
                "# Worker replacement\nThis came from the old memory.".into(),
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
            .claim_next_worker_routine(&project_id, "worker-session", "check-custom".into(), 500)
            .unwrap();
        assert_eq!(claim.result["routine"]["name"], "Weekly customer pulse");
        assert!(claim.result["routine"].get("kind").is_none());
        let capability = claim.capability.unwrap();
        runtime
            .complete_worker_routine(
                &capability,
                1,
                "# Customer pulse".into(),
                Some("Customer pulse check completed.".into()),
                vec![WorkerRoutineFinding {
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
                "worker-1".into(),
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
            .claim_next_worker_routine(&project_id, "worker-session", "problem-check".into(), 100)
            .unwrap()
            .capability
            .unwrap();
        runtime
            .report_worker_routine_problem(
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
            .claim_next_worker_routine(&project_id, "worker-session", "timeout-check".into(), 300)
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
