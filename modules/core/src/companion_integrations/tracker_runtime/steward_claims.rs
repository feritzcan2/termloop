//! Steward wake admission and scheduled Routine claims.

use super::*;

impl CoreRuntime {
    fn current_steward(
        &self,
        project_id: &str,
        session_id: &str,
    ) -> Result<termloop_domain::StewardConfiguration, CoreError> {
        self.store
            .steward_configurations()
            .iter()
            .find(|steward| {
                steward.project_id == project_id
                    && steward.enabled
                    && steward.executor_session_id.as_deref() == Some(session_id)
            })
            .cloned()
            .ok_or(CoreError::CapabilityDenied)
    }

    /// Produces at most one wake per Project Steward, exactly when that
    /// Project has a due assignment. No periodic assistant ping is involved.
    pub fn admit_due_steward_wakes(&mut self, now_epoch_ms: u64) -> Vec<DueStewardWake> {
        self.initialize_routine_schedules();
        let busy_projects = self.busy_project_ids();
        let stewards = self
            .store
            .steward_configurations()
            .iter()
            .filter(|steward| steward.enabled && steward.executor_session_id.is_some())
            .cloned()
            .collect::<Vec<_>>();
        let mut wakes = Vec::new();
        for steward in stewards {
            if busy_projects.contains(&steward.project_id) {
                continue;
            }
            let session_id = steward
                .executor_session_id
                .as_deref()
                .expect("filtered above");
            // Playbook steps are admitted separately and never wake the
            // Steward; only its own scheduled Routines do.
            let has_due_assignment = self.store.tracker_configurations().iter().any(|routine| {
                routine.enabled
                    && routine.project_id == steward.project_id
                    && routine.trigger_mode.is_scheduled()
                    && self
                        .tracker_runtime
                        .next_due_epoch_ms
                        .get(&routine.id)
                        .is_some_and(|due| *due <= now_epoch_ms)
            });
            if !has_due_assignment || self.session_turn_is_running(session_id) {
                continue;
            }
            if let Some(pending) = self
                .tracker_runtime
                .pending_steward_wakes
                .get(&steward.project_id)
                && pending.steward_session_id == session_id
                && pending.retry_at_epoch_ms > now_epoch_ms
            {
                continue;
            }
            self.tracker_runtime.pending_steward_wakes.insert(
                steward.project_id.clone(),
                PendingStewardWake {
                    steward_session_id: session_id.to_owned(),
                    retry_at_epoch_ms: now_epoch_ms.saturating_add(WAKE_REDELIVERY_MS),
                },
            );
            wakes.push(DueStewardWake {
                project_id: steward.project_id,
                steward_generation: steward.generation,
                steward_session_id: session_id.to_owned(),
            });
        }
        wakes
    }

    pub fn next_tracker_schedule_epoch_ms(&mut self) -> Option<u64> {
        self.initialize_routine_schedules();
        let steps = self.next_playbook_step_epoch_ms();
        let stewards = self.next_steward_wake_epoch_ms();
        match (steps, stewards) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        }
    }

    fn next_steward_wake_epoch_ms(&self) -> Option<u64> {
        let busy_projects = self.busy_project_ids();
        let stewards = self
            .store
            .steward_configurations()
            .iter()
            .filter(|steward| steward.enabled)
            .cloned()
            .collect::<Vec<_>>();
        let mut next = None;
        for steward in stewards {
            let Some(session_id) = steward.executor_session_id.as_deref() else {
                continue;
            };
            if busy_projects.contains(&steward.project_id)
                || self.session_turn_is_running(session_id)
            {
                continue;
            }
            let candidate = self
                .tracker_runtime
                .pending_steward_wakes
                .get(&steward.project_id)
                .map(|pending| pending.retry_at_epoch_ms)
                .or_else(|| {
                    self.store
                        .tracker_configurations()
                        .iter()
                        .filter(|routine| {
                            routine.enabled
                                && routine.project_id == steward.project_id
                                && routine.trigger_mode.is_scheduled()
                        })
                        .filter_map(|routine| {
                            self.tracker_runtime
                                .next_due_epoch_ms
                                .get(&routine.id)
                                .copied()
                        })
                        .min()
                });
            if let Some(candidate) = candidate {
                next = Some(next.map_or(candidate, |current: u64| current.min(candidate)));
            }
        }
        next
    }

    pub fn claim_next_steward_routine(
        &mut self,
        project_id: &str,
        session_id: &str,
        check_id: String,
        now_epoch_ms: u64,
    ) -> Result<StewardRoutineClaim, CoreError> {
        let steward = self.current_steward(project_id, session_id)?;
        self.tracker_runtime
            .pending_steward_wakes
            .remove(project_id);
        self.pending_assistant_wake_deliveries.remove(session_id);

        // A scheduled Routine's check is held by the Steward itself, so the
        // Steward gets it back until it reports. Playbook steps are claimed
        // by TermLoop for its evaluators and never reach the Steward.
        if let Some((routine_id, active)) = self.steward_held_check_for_project(project_id) {
            let mut capability = active_capability(&routine_id, &active);
            capability.steward_session_id = session_id.to_owned();
            if let Some(routine) = self
                .validate_current_check(&capability, now_epoch_ms)
                .ok()
                .filter(|routine| routine.trigger_mode.is_scheduled())
            {
                return Ok(StewardRoutineClaim {
                    result: assigned_routine_result(&routine, &capability, now_epoch_ms, None),
                    capability: Some(capability),
                });
            }

            // A Routine edit can invalidate an in-flight claim. Release the
            // exact stale claim before selecting fresh work.
            self.release_steward_routine_claim(&capability);
        }

        self.initialize_routine_schedules();
        let scheduled = |routine: &&TrackerConfiguration| {
            routine.enabled
                && routine.project_id == project_id
                && routine.trigger_mode.is_scheduled()
        };
        let selected = self
            .store
            .tracker_configurations()
            .iter()
            .filter(scheduled)
            .filter(|routine| !self.tracker_runtime.tracker_is_active(&routine.id))
            .filter_map(|routine| {
                let due = self
                    .tracker_runtime
                    .next_due_epoch_ms
                    .get(&routine.id)
                    .copied()?;
                (due <= now_epoch_ms).then(|| (due, routine.id.clone(), routine.clone()))
            })
            .min_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));
        let Some((_, _, routine)) = selected else {
            let next_wake = self
                .store
                .tracker_configurations()
                .iter()
                .filter(scheduled)
                .filter_map(|routine| {
                    self.tracker_runtime
                        .next_due_epoch_ms
                        .get(&routine.id)
                        .copied()
                })
                .min();
            return Ok(StewardRoutineClaim {
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
            steward_generation: steward.generation,
            steward_session_id: session_id.to_owned(),
        };
        self.hold_routine_check(&routine.id, &capability, None);
        Ok(StewardRoutineClaim {
            result: assigned_routine_result(&routine, &capability, now_epoch_ms, None),
            capability: Some(capability),
        })
    }

    /// Records a claimed check as the one Core holds for its Routine.
    pub(super) fn hold_routine_check(
        &mut self,
        routine_id: &str,
        capability: &TrackerCheckCapability,
        step: Option<&super::super::playbook_runtime::PlaybookStepAssignment>,
    ) {
        self.tracker_runtime
            .health
            .entry(routine_id.to_owned())
            .or_default()
            .checks
            .push(ActiveTrackerCheck {
                check_id: capability.check_id.clone(),
                step_milestone_id: step.map(|assignment| assignment.milestone.id.clone()),
                step_task_id: step.map(|assignment| assignment.waiting[0].task_id.clone()),
                step_evaluation: (termloop_domain::PlaybookStepEvaluator::Routine, None),
                generation: capability.generation,
                claimed_at_epoch_ms: capability.claimed_at_epoch_ms,
                deadline_epoch_ms: capability.deadline_epoch_ms,
                ping_sent: false,
                project_id: capability.project_id.clone(),
                steward_generation: capability.steward_generation,
                steward_session_id: capability.steward_session_id.clone(),
            });
    }

    /// Claims the exact due assignment before its scheduled wake is delivered.
    /// The pending wake stays live until terminal delivery succeeds so a failed
    /// submission can release the claim and retry without losing work.
    pub fn claim_due_steward_routine(
        &mut self,
        wake: &DueStewardWake,
        check_id: String,
        now_epoch_ms: u64,
    ) -> Result<StewardRoutineClaim, CoreError> {
        if !self.steward_assignment_is_current(wake) {
            return Err(CoreError::TrackerReportStale);
        }
        let pending = self
            .tracker_runtime
            .pending_steward_wakes
            .get(&wake.project_id)
            .cloned()
            .ok_or(CoreError::TrackerReportStale)?;
        let claim = self.claim_next_steward_routine(
            &wake.project_id,
            &wake.steward_session_id,
            check_id,
            now_epoch_ms,
        )?;
        if claim.capability.is_some() {
            self.tracker_runtime
                .pending_steward_wakes
                .insert(wake.project_id.clone(), pending);
        }
        Ok(claim)
    }
}

pub(super) fn assigned_routine_result(
    routine: &TrackerConfiguration,
    capability: &TrackerCheckCapability,
    now_epoch_ms: u64,
    step: Option<&super::super::playbook_runtime::PlaybookStepAssignment>,
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
            "evidenceKind": "routineMemory",
            "independentlyVerified": false,
            "scanSinceEpochMs": scan_since,
            "lastFinishedAtEpochMs": routine.last_attempt_at_epoch_ms,
            "recentSourceKeys": routine.recent_source_keys,
            "relatedTaskIds": routine.related_task_ids,
        },
        "claimedAtEpochMs": capability.claimed_at_epoch_ms,
        "leaseExpiresAtEpochMs": capability.deadline_epoch_ms,
    });
    // A step Routine evaluates one stage for one Task in TermLoop's
    // evaluator. It observes only, so the step's `whileWaiting` response,
    // which belongs to the Steward, is not part of its assignment.
    if let Some(step) = step {
        result["step"] = json!({
            "milestoneId": step.milestone.id,
            "title": step.milestone.title,
            "gate": step.milestone.gate,
            "completeWhen": routine.prompt,
            "approver": step.milestone.approver,
            "retryDelaySeconds": step.milestone.retry_delay_seconds,
            "finishWith": "playbook_evaluation_complete",
            "taskRead": {
                "requiredBeforeVerdict": true,
                "tool": "playbook_evaluation_read",
                "arguments": {},
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
                        "lastEvidenceKind": "previousEvaluation",
                        "lastEvidenceIndependentlyVerified": false,
                        "passedEarlierSteps": task
                            .passed_earlier_steps
                            .iter()
                            .map(super::super::playbook_runtime::PlaybookPassedStep::to_json)
                            .collect::<Vec<_>>(),
                    })
                })
                .collect::<Vec<_>>(),
        });
    }
    result
}
