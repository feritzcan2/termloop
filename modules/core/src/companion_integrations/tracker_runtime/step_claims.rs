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
                self.tracker_runtime
                    .next_due_epoch_ms
                    .get(&routine.id)
                    .copied()
            })
            .min()
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
