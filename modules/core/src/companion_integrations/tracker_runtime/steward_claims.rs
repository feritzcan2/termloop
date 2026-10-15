//! Steward wake admission and Routine claims.

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
            let has_due_assignment = self.store.tracker_configurations().iter().any(|routine| {
                routine.enabled
                    && routine.project_id == steward.project_id
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
                            routine.enabled && routine.project_id == steward.project_id
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
        // Steward gets it back until it reports. Step checks run in their own
        // evaluation forks and are never handed back here.
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
        let step_checks = self.project_step_check_count(project_id);
        let selected = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|routine| routine.enabled && routine.project_id == project_id)
            .filter(|routine| {
                if routine.trigger_mode.is_scheduled() {
                    !self.tracker_runtime.tracker_is_active(&routine.id)
                } else {
                    step_checks < PROJECT_STEP_CHECKS_MAX
                }
            })
            .filter_map(|routine| {
                let due = self
                    .tracker_runtime
                    .next_due_epoch_ms
                    .get(&routine.id)
                    .copied()?;
                let explicitly_requested =
                    self.tracker_runtime.step_run_now.contains_key(&routine.id);
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
                .store
                .tracker_configurations()
                .iter()
                .filter(|routine| routine.enabled && routine.project_id == project_id)
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
        let step = (!routine.trigger_mode.is_scheduled())
            .then(|| self.playbook_step_assignment(&routine.id))
            .flatten();
        if !routine.trigger_mode.is_scheduled() && step.is_none() {
            return Ok(StewardRoutineClaim {
                capability: None,
                result: json!({"status": "idle", "nextWakeAtEpochMs": null}),
            });
        }
        self.tracker_runtime
            .health
            .entry(routine.id.clone())
            .or_default()
            .checks
            .push(ActiveTrackerCheck {
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
                project_id: capability.project_id.clone(),
                steward_generation: capability.steward_generation,
                steward_session_id: capability.steward_session_id.clone(),
            });
        Ok(StewardRoutineClaim {
            result: assigned_routine_result(&routine, &capability, now_epoch_ms, step.as_ref()),
            capability: Some(capability),
        })
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

fn assigned_routine_result(
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
    // A step Routine evaluates one stage for a named set of Tasks. It finishes
    // with verdicts rather than findings, so the assignment says so instead of
    // leaving the Steward to infer it from the trigger mode.
    if let Some(step) = step {
        result["step"] = json!({
            "milestoneId": step.milestone.id,
            "title": step.milestone.title,
            "gate": step.milestone.gate,
            "completeWhen": routine.prompt,
            "whileWaiting": {
                "mode": routine.action_handling,
                "instructions": routine.steward_instructions,
            },
            "approver": step.milestone.approver,
            "retryDelaySeconds": step.milestone.retry_delay_seconds,
            "finishWith": "steward_complete_assignment",
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
                        "lastEvidenceKind": "previousStewardVerdict",
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
