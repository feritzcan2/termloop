//! Playbook step claims. TermLoop evaluates each step in its own evaluator,
//! so a step claim never waits on, belongs to, or is invalidated by the
//! Steward session. An enabled Steward only marks the Project's automation on.

use super::*;

impl CoreRuntime {
    fn playbook_steward(&self, project_id: &str) -> Option<termloop_domain::StewardConfiguration> {
        self.store
            .steward_configurations()
            .iter()
            .find(|steward| steward.project_id == project_id && steward.enabled)
            .cloned()
    }

    /// Whether this Project's Playbook automation is on. A step check stays
    /// valid across Steward relaunches, model changes, and busy turns.
    pub(super) fn playbook_automation_enabled(&self, project_id: &str) -> bool {
        self.playbook_steward(project_id).is_some()
    }

    /// When the active step `routine_id` evaluates is outside its hours at
    /// `at_epoch_ms`, the moment its window next opens. `None` while it is
    /// open, for a step without hours, and for a zone the database no longer
    /// knows, which fails open rather than stopping the pipeline.
    pub(super) fn step_closed_until(
        &self,
        project_id: &str,
        routine_id: &str,
        at_epoch_ms: u64,
    ) -> Option<u64> {
        let playbook = self.store.playbook_for_project(project_id)?;
        let milestone = playbook
            .milestones
            .iter()
            .find(|milestone| milestone.routine_id == routine_id)?;
        let hours = playbook.active_hours_for(milestone)?;
        let clock = termloop_platform::zoned_clock(at_epoch_ms, &hours.time_zone)?;
        let weekday =
            termloop_domain::PlaybookWeekday::from_monday_offset(u32::from(clock.days_from_monday));
        let wait_minutes = hours.minutes_until_open(weekday, clock.minute_of_day);
        (wait_minutes > 0).then(|| {
            at_epoch_ms
                .saturating_sub(clock.ms_into_minute)
                .saturating_add(u64::from(wait_minutes) * 60_000)
        })
    }

    fn due_step_routines(&self, project_id: &str, now_epoch_ms: u64) -> Vec<TrackerConfiguration> {
        let mut due = self
            .store
            .tracker_configurations()
            .iter()
            .filter(|routine| {
                routine.enabled
                    && routine.project_id == project_id
                    && !routine.trigger_mode.is_scheduled()
            })
            .filter_map(|routine| {
                let due = self
                    .tracker_runtime
                    .next_due_epoch_ms
                    .get(&routine.id)
                    .copied()?;
                let explicitly_requested =
                    self.tracker_runtime.step_run_now.contains_key(&routine.id);
                (due <= now_epoch_ms).then(|| (!explicitly_requested, due, routine.clone()))
            })
            .collect::<Vec<_>>();
        due.sort_by(|left, right| {
            (left.0, left.1, &left.2.id).cmp(&(right.0, right.1, &right.2.id))
        });
        due.into_iter().map(|(_, _, routine)| routine).collect()
    }

    /// Claims the next due step check of one Project for one Task, or `None`
    /// when no step is due or the Project's evaluation slots are full.
    pub fn claim_next_playbook_step(
        &mut self,
        project_id: &str,
        check_id: String,
        now_epoch_ms: u64,
    ) -> Result<Option<StewardRoutineClaim>, CoreError> {
        if check_id.trim().is_empty() || check_id.len() > 128 {
            return Err(CoreError::InvalidParams("checkId".into()));
        }
        let Some(steward) = self.playbook_steward(project_id) else {
            return Ok(None);
        };
        self.initialize_routine_schedules();
        if self.project_step_check_count(project_id) >= PROJECT_STEP_CHECKS_MAX {
            return Ok(None);
        }
        for routine in self.due_step_routines(project_id, now_epoch_ms) {
            let Some(step) = self.playbook_step_assignment(&routine.id) else {
                continue;
            };
            let Some(task_id) = step.waiting.first().map(|task| task.task_id.clone()) else {
                continue;
            };
            // "Run now" overrides exactly one Task's wait: the Task named in
            // Task details, or the first Task claimed for an unnamed request.
            // Every other Task at the step still waits for its own due time.
            let overrides_wait = match self.tracker_runtime.step_run_now.get_mut(&routine.id) {
                Some(run_now) if run_now.task_id.is_none() => {
                    run_now.task_id = Some(task_id);
                    true
                }
                Some(run_now) => run_now.task_id.as_deref() == Some(task_id.as_str()),
                None => false,
            };
            // Outside its hours a step waits for its window; only the user's
            // own "Run now" checks it anyway.
            if !overrides_wait
                && (step.due_at_epoch_ms > now_epoch_ms
                    || self
                        .step_closed_until(project_id, &routine.id, now_epoch_ms)
                        .is_some())
            {
                continue;
            }
            let capability = TrackerCheckCapability {
                project_id: project_id.to_owned(),
                tracker_id: routine.id.clone(),
                check_id,
                generation: routine.generation,
                claimed_at_epoch_ms: now_epoch_ms,
                deadline_epoch_ms: now_epoch_ms.saturating_add(CHECK_DEADLINE_MAX_MS),
                steward_generation: steward.generation,
                steward_session_id: steward.executor_session_id.clone().unwrap_or_default(),
            };
            self.hold_routine_check(&routine.id, &capability, Some(&step));
            return Ok(Some(StewardRoutineClaim {
                result: steward_claims::assigned_routine_result(
                    &routine,
                    &capability,
                    now_epoch_ms,
                    Some(&step),
                ),
                capability: Some(capability),
            }));
        }
        Ok(None)
    }

    /// Claims every due step check across Projects, bounded by each Project's
    /// evaluation slots. Each claim is for one Task and is routed to its own
    /// evaluator; none of them waits for the Steward.
    pub fn admit_due_playbook_steps(&mut self, now_epoch_ms: u64) -> Vec<StewardRoutineClaim> {
        let project_ids = self
            .store
            .steward_configurations()
            .iter()
            .filter(|steward| steward.enabled)
            .map(|steward| steward.project_id.clone())
            .collect::<Vec<_>>();
        let mut claims = Vec::new();
        for project_id in project_ids {
            while let Ok(Some(claim)) = self.claim_next_playbook_step(
                &project_id,
                termloop_platform::generate_opaque_id(),
                now_epoch_ms,
            ) {
                claims.push(claim);
            }
        }
        claims
    }

    /// The earliest moment a step check could be claimed. A Project whose
    /// evaluation slots are full contributes nothing: a finishing check
    /// wakes the supervisor itself.
    pub(super) fn next_playbook_step_epoch_ms(&self) -> Option<u64> {
        let now_epoch_ms = termloop_platform::current_epoch_ms();
        self.store
            .tracker_configurations()
            .iter()
            .filter(|routine| {
                routine.enabled
                    && !routine.trigger_mode.is_scheduled()
                    && self.playbook_automation_enabled(&routine.project_id)
                    && self.project_step_check_count(&routine.project_id) < PROJECT_STEP_CHECKS_MAX
            })
            .filter_map(|routine| {
                let due = self
                    .tracker_runtime
                    .next_due_epoch_ms
                    .get(&routine.id)
                    .copied()?;
                if self.tracker_runtime.step_run_now.contains_key(&routine.id) {
                    return Some(due);
                }
                // A step due while its window is shut wakes when it opens,
                // not at a due time already passed.
                Some(
                    self.step_closed_until(&routine.project_id, &routine.id, due.max(now_epoch_ms))
                        .unwrap_or(due),
                )
            })
            .min()
    }

    /// Who answers this exact step claim. A claim nobody marked is a Routine
    /// run with no deterministic fallback.
    pub(crate) fn claimed_step_evaluation(
        &self,
        capability: &TrackerCheckCapability,
    ) -> (
        termloop_domain::PlaybookStepEvaluator,
        Option<termloop_domain::PlaybookDeterministicFallback>,
    ) {
        self.claimed_check(capability).map_or(
            (termloop_domain::PlaybookStepEvaluator::Routine, None),
            |check| check.step_evaluation,
        )
    }

    /// Records who answers this exact step claim. Returns `false` when the
    /// claim is no longer the one Core holds.
    pub(crate) fn mark_step_evaluation(
        &mut self,
        capability: &TrackerCheckCapability,
        evaluator: termloop_domain::PlaybookStepEvaluator,
        fallback: Option<termloop_domain::PlaybookDeterministicFallback>,
    ) -> bool {
        let Some(check) = self
            .tracker_runtime
            .health
            .get_mut(&capability.tracker_id)
            .and_then(|health| {
                health
                    .checks
                    .iter_mut()
                    .find(|check| check.check_id == capability.check_id)
            })
            .filter(|check| check.step_task_id.is_some())
        else {
            return false;
        };
        check.step_evaluation = (evaluator, fallback);
        true
    }

    /// Hands back a step claim whose evaluator could not be routed and holds
    /// that Task back until `retry_at_epoch_ms`, so a failing route cannot
    /// spin. Other Tasks at the step are unaffected.
    pub fn postpone_playbook_step(
        &mut self,
        capability: &TrackerCheckCapability,
        retry_at_epoch_ms: u64,
    ) {
        let task_id = self.claimed_step_task_id(capability);
        if self.release_steward_routine_claim(capability)
            && let Some(task_id) = task_id
        {
            self.tracker_runtime
                .step_task_not_before
                .insert((capability.tracker_id.clone(), task_id), retry_at_epoch_ms);
        }
    }
}

#[cfg(test)]
impl CoreRuntime {
    /// A step claim shaped like a Steward claim: idle when nothing is due.
    pub(crate) fn claim_next_playbook_step_or_idle(
        &mut self,
        project_id: &str,
        check_id: String,
        now_epoch_ms: u64,
    ) -> Result<StewardRoutineClaim, CoreError> {
        Ok(self
            .claim_next_playbook_step(project_id, check_id, now_epoch_ms)?
            .unwrap_or_else(|| StewardRoutineClaim {
                capability: None,
                result: json!({"status": "idle", "nextWakeAtEpochMs": null}),
            }))
    }
}

#[cfg(test)]
mod tests {
    use crate::companion_integrations::playbook_runtime::tests::pipeline_runtime;
    use termloop_domain::{PlaybookActiveHours, PlaybookWeekday};

    /// 1970-01-01T00:16:40Z.
    const NOW: u64 = 1_000_000;
    const NINE_UTC: u64 = 9 * 60 * 60_000;

    fn set_hours(
        runtime: &mut crate::CoreRuntime,
        project_id: &str,
        playbook_hours: Option<(u16, u16)>,
        step_hours: Option<(u16, u16)>,
    ) {
        let window = |(start, end): (u16, u16)| PlaybookActiveHours {
            start_minute: start,
            end_minute: end,
            time_zone: "UTC".into(),
            weekdays: None,
        };
        let mut playbook = runtime
            .store
            .playbook_for_project(project_id)
            .unwrap()
            .clone();
        playbook.active_hours = playbook_hours.map(window);
        for milestone in &mut playbook.milestones {
            milestone.active_hours = step_hours.map(window);
        }
        let revision = runtime.state_revision();
        runtime
            .store
            .set_playbook_configuration(&runtime.write_authority, playbook, revision)
            .unwrap();
    }

    fn claims(runtime: &mut crate::CoreRuntime, project_id: &str, id: &str) -> bool {
        runtime
            .claim_next_playbook_step_or_idle(project_id, id.into(), NOW)
            .unwrap()
            .capability
            .is_some()
    }

    #[test]
    fn a_step_waits_for_the_next_day_its_window_opens_on() {
        let (mut runtime, _root, project_id) = pipeline_runtime();
        let mut playbook = runtime
            .store
            .playbook_for_project(&project_id)
            .unwrap()
            .clone();
        let routine_id = playbook.milestones[0].routine_id.clone();
        // NOW is Thursday 00:16 UTC; a Monday-only 09:00-17:00 window opens
        // four days and nine hours later.
        playbook.active_hours = Some(PlaybookActiveHours {
            start_minute: 9 * 60,
            end_minute: 17 * 60,
            time_zone: "UTC".into(),
            weekdays: Some(vec![PlaybookWeekday::Monday]),
        });
        let revision = runtime.state_revision();
        runtime
            .store
            .set_playbook_configuration(&runtime.write_authority, playbook, revision)
            .unwrap();
        assert_eq!(
            runtime.step_closed_until(&project_id, &routine_id, NOW),
            Some(4 * 24 * 60 * 60_000 + NINE_UTC)
        );
        assert!(!claims(&mut runtime, &project_id, "weekend"));
    }

    #[test]
    fn a_step_outside_its_hours_waits_for_its_window_to_open() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let routine_id = runtime
            .store
            .playbook_for_project(&project_id)
            .unwrap()
            .milestones[0]
            .routine_id
            .clone();
        // Office hours 09:00-17:00 UTC: closed at 00:16, opening at 09:00.
        set_hours(&mut runtime, &project_id, Some((9 * 60, 17 * 60)), None);
        assert_eq!(
            runtime.step_closed_until(&project_id, &routine_id, NOW),
            Some(NINE_UTC)
        );
        assert!(!claims(&mut runtime, &project_id, "closed"));

        // The step's own window replaces the Playbook's: open across midnight.
        set_hours(
            &mut runtime,
            &project_id,
            Some((9 * 60, 17 * 60)),
            Some((22 * 60, 6 * 60)),
        );
        assert_eq!(
            runtime.step_closed_until(&project_id, &routine_id, NOW),
            None
        );
        assert!(claims(&mut runtime, &project_id, "open"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn run_now_checks_a_step_outside_its_hours() {
        let (mut runtime, root, project_id) = pipeline_runtime();
        let routine_id = runtime
            .store
            .playbook_for_project(&project_id)
            .unwrap()
            .milestones[0]
            .routine_id
            .clone();
        set_hours(&mut runtime, &project_id, None, Some((9 * 60, 17 * 60)));
        assert!(!claims(&mut runtime, &project_id, "closed"));
        // Already due, so the request reports no newly scheduled run.
        runtime.run_routine_now(&routine_id, NOW).unwrap();
        assert!(claims(&mut runtime, &project_id, "run-now"));
        std::fs::remove_dir_all(root).ok();
    }
}
