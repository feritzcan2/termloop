//! Routine runtime projection and explicit "Run now" requests.

use super::*;

impl CoreRuntime {
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
                // A step may run several independent Task checks. Its card
                // shows the one closest to its deadline.
                let active = current.and_then(|health| {
                    health
                        .checks
                        .iter()
                        .min_by_key(|check| check.deadline_epoch_ms)
                });
                json!({
                    "routineId": configuration.id,
                    "generation": configuration.generation,
                    "triggerMode": configuration.trigger_mode,
                    "name": configuration.name,
                    "contextMarkdown": configuration.context_markdown,
                    "contextRevision": configuration.context_revision,
                    "relatedTaskIds": configuration.related_task_ids,
                    "state": if current.is_some_and(|health| health.checks.iter().any(|check| check.ping_sent)) {
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
        let project_id = routine.project_id.clone();
        let on_demand = !routine.trigger_mode.is_scheduled();
        if task_id.is_some() && !on_demand {
            return Err(CoreError::InvalidParams("taskId".into()));
        }
        // Each Task's check is independent. Only that Task's own running
        // check makes a Task-specific "Run now" redundant.
        if let Some(task_id) = task_id
            && self
                .tracker_runtime
                .step_task_is_checked(routine_id, task_id)
        {
            return Ok(false);
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
        let already_pending = (!on_demand && self.tracker_runtime.tracker_is_active(routine_id))
            || self
                .tracker_runtime
                .next_due_epoch_ms
                .get(routine_id)
                .is_some_and(|due| *due <= now_epoch_ms);
        self.tracker_runtime
            .schedule_tracker_now(routine_id, now_epoch_ms);
        if on_demand {
            self.tracker_runtime.step_run_now.insert(
                routine_id.to_owned(),
                StepRunNow {
                    at_epoch_ms: now_epoch_ms,
                    task_id: task_id.map(str::to_owned),
                },
            );
            // "Run now" overrides the named Task's own wait, or every waiting
            // Task's when none is named.
            match task_id {
                Some(task_id) => {
                    self.tracker_runtime
                        .step_task_not_before
                        .remove(&(routine_id.to_owned(), task_id.to_owned()));
                }
                None => self
                    .tracker_runtime
                    .step_task_not_before
                    .retain(|(routine, _), _| routine != routine_id),
            }
        }
        if !on_demand && self.tracker_runtime.tracker_is_active(routine_id) {
            self.tracker_runtime
                .health
                .entry(routine_id.to_owned())
                .or_default()
                .pending_trigger = true;
        }
        if let Some(pending) = self
            .tracker_runtime
            .pending_steward_wakes
            .get_mut(&project_id)
        {
            pending.retry_at_epoch_ms = now_epoch_ms;
        }
        Ok(!already_pending)
    }
}
