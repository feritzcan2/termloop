//! Task close retires the Task's live Agents and parks them for reopen.
//!
//! Close keeps its "no filesystem effect" rule: the checkout stays, only the
//! Agent processes running inside it stop. Their PTYs are terminated outside
//! the Core lock between `prepare_task_close` and `complete_task_close`.

use std::path::Path;

use serde_json::Value;
use termloop_domain::{SessionKind, TaskArchiveTarget, TaskStatus, TaskSuspensionReason};

use super::health::comparison_key;
use crate::{CoreError, CoreRuntime, required_string, store_error, terminal_error};

pub struct TaskClosePlan {
    task_id: String,
    targets: Vec<TaskArchiveTarget>,
}

impl TaskClosePlan {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn session_ids(&self) -> Vec<String> {
        self.targets
            .iter()
            .map(|target| target.session_id.clone())
            .collect()
    }
}

pub enum TaskClosePreparation {
    /// No live Agent had to stop; the Task is already closed.
    Closed(Value),
    /// These Agents must be terminated before `complete_task_close`.
    Retire(TaskClosePlan),
}

impl CoreRuntime {
    pub(crate) fn close_task(&mut self, params: Value) -> Result<Value, CoreError> {
        let plan = match self.prepare_task_close(params)? {
            TaskClosePreparation::Closed(result) => return Ok(result),
            TaskClosePreparation::Retire(plan) => plan,
        };
        drop(self.detach_task_close_runtimes(&plan));
        for session_id in plan.session_ids() {
            let retired = self
                .terminal
                .contains_session(&session_id)
                .map_err(terminal_error)
                .and_then(|live| {
                    if live {
                        self.terminal.terminate(&session_id).map_err(terminal_error)
                    } else {
                        Ok(())
                    }
                });
            if let Err(error) = retired {
                self.abandon_task_close(plan);
                return Err(error);
            }
        }
        self.complete_task_close(plan)
    }

    pub fn prepare_task_close(&mut self, params: Value) -> Result<TaskClosePreparation, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        if self.pending_task_closes.contains_key(&task_id) {
            return Err(CoreError::InvalidParams("taskCloseInProgress".into()));
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let targets = if task.status == TaskStatus::Open {
            self.task_close_targets(&task)?
        } else {
            Vec::new()
        };
        if targets.is_empty() {
            return self
                .change_task_status(params, TaskStatus::Closed)
                .map(TaskClosePreparation::Closed);
        }
        self.pending_task_closes.insert(
            task_id.clone(),
            targets
                .iter()
                .map(|target| target.session_id.clone())
                .collect(),
        );
        Ok(TaskClosePreparation::Retire(TaskClosePlan {
            task_id,
            targets,
        }))
    }

    /// The live Agents running in the Task's checkout. Assistant roles keep
    /// running: Ask-To helpers answer their asker, and Steward/Worker
    /// executors are Project-scoped.
    fn task_close_targets(
        &self,
        task: &termloop_domain::TaskRecord,
    ) -> Result<Vec<TaskArchiveTarget>, CoreError> {
        let Some(worktree) = task.worktree.as_ref() else {
            return Ok(Vec::new());
        };
        let Ok(worktree_key) = comparison_key(Path::new(&worktree.path)) else {
            return Ok(Vec::new());
        };
        let mut targets = Vec::new();
        for session in self.store.sessions().iter().filter(|session| {
            session.project_id == task.project_id
                && session.kind == SessionKind::Agent
                && session.archived_at_epoch_ms.is_none()
                && session.process.template_ref.as_deref() != Some("builtin.agent.ask-to-helper")
        }) {
            if self.session_is_archive_suspended(&session.id)
                || self.session_is_persistent_assistant_executor(&session.id)
                || self.agent_terminal_holds.contains(&session.id)
                || self.resume_reservations.contains(&session.id)
                || self
                    .provider_history_repair_reservations
                    .contains(&session.id)
            {
                continue;
            }
            let contained = comparison_key(Path::new(&session.process.cwd))
                .is_ok_and(|cwd| worktree_key.contains_or_equals(&cwd));
            if !contained
                || !self
                    .terminal
                    .contains_session(&session.id)
                    .map_err(terminal_error)?
            {
                continue;
            }
            targets.push(TaskArchiveTarget {
                session_id: session.id.clone(),
                runtime_epoch: session.runtime_epoch,
                prior_lifecycle_state: session.lifecycle_state.clone(),
                prior_resume_failure: session.resume_failure,
                was_live_agent: true,
            });
        }
        Ok(targets)
    }

    pub fn detach_task_close_runtimes(&mut self, plan: &TaskClosePlan) -> Vec<crate::CodexRuntime> {
        plan.targets
            .iter()
            .filter_map(|target| {
                self.agent_observations.remove(&target.session_id);
                self.agent_conversation_activity.remove(&target.session_id);
                self.resume_ready.remove(&target.session_id);
                self.mcp_authorizer.remove(&target.session_id);
                self.codex_runtimes.remove(&target.session_id)
            })
            .collect()
    }

    pub fn complete_task_close(&mut self, plan: TaskClosePlan) -> Result<Value, CoreError> {
        if plan.targets.iter().any(|target| {
            self.terminal
                .contains_session(&target.session_id)
                .map_or(true, |live| live)
        }) {
            self.abandon_task_close(plan);
            return Err(CoreError::Terminal(
                "Task Agents did not stop; the Task stays open".into(),
            ));
        }
        let closed = self.store.close_task_with_suspended_sessions(
            &self.write_authority,
            &plan.task_id,
            &plan.targets,
            termloop_platform::current_epoch_ms(),
        );
        let task = match closed {
            Ok(task) => task,
            Err(error) => {
                self.abandon_task_close(plan);
                return Err(store_error(error));
            }
        };
        self.pending_task_closes.remove(&plan.task_id);
        self.task_projection(&task)
    }

    /// Releases a close that could not park its Agents. Stopped Agents become
    /// ordinary exited Sessions with their continuation shell.
    pub fn abandon_task_close(&mut self, plan: TaskClosePlan) {
        self.pending_task_closes.remove(&plan.task_id);
        for target in &plan.targets {
            if self
                .terminal
                .contains_session(&target.session_id)
                .is_ok_and(|live| !live)
            {
                let _ = self.spawn_agent_terminal_hold(&target.session_id);
            }
        }
    }

    pub(crate) fn session_is_retiring_for_task_close(&self, session_id: &str) -> bool {
        self.pending_task_closes
            .values()
            .any(|session_ids| session_ids.iter().any(|id| id == session_id))
    }

    /// Agents parked by closing `task_id` stay with that Task, including
    /// while it is archived, and never join another archive cohort.
    pub(crate) fn session_is_parked_by_task_close(&self, task_id: &str, session_id: &str) -> bool {
        self.store
            .task_archive_suspensions()
            .iter()
            .any(|suspension| {
                suspension.session_id == session_id
                    && suspension.task_id.as_deref() == Some(task_id)
                    && suspension.reason == TaskSuspensionReason::Closed
            })
    }
}
