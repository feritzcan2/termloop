//! Task close retires the Task's live Agents and parks them for reopen.
//!
//! Close keeps its "no filesystem effect" rule: the checkout stays, only the
//! Agent processes running inside it stop. Their PTYs are terminated outside
//! the Core lock between `prepare_task_close` and `complete_task_close`.

use std::path::Path;

use serde_json::Value;
use termloop_domain::{
    SessionKind, TaskArchiveTarget, TaskBranchBinding, TaskStatus, TaskSuspensionReason,
};

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

/// What it takes to recreate a Task checkout that was removed, so the Agents
/// that worked in it come back inside the Task instead of at the Project root.
pub struct TaskWorktreeRecreationPlan {
    pub project_id: String,
    pub task_id: String,
    pub branch_name: String,
    pub worktree_leaf: String,
    /// The exact folder to recreate; absent means beside the repository root.
    pub destination_path: Option<String>,
    pub operation_id: String,
    pub base: TaskWorktreeRecreationBase,
}

/// Which branch a recreated checkout starts on.
pub enum TaskWorktreeRecreationBase {
    /// Check out `branch_name` again.
    ExistingBranch,
    /// Check out `branch_name` again so the Task keeps its branch and pull
    /// request. Only when that checkout cannot be made, release `branch_name`
    /// and start a fresh branch derived from it at the latest base: the
    /// configured Project base when one is set, otherwise the observed
    /// integration branch.
    ExistingElseFreshFromBase {
        released: TaskBranchBinding,
        configured_base_ref: Option<String>,
    },
}

/// Same leaf shape as managed checkouts: `prefix/slug` becomes
/// `prefix-slug_worktree`, `UKIE-931` becomes `UKIE-931_worktree`.
pub fn branch_worktree_leaf(branch_name: &str) -> String {
    format!("{}_worktree", branch_name.replace('/', "-"))
}

pub enum TaskClosePreparation {
    /// No live Agent had to stop; the Task is already closed.
    Closed(Value),
    /// These Agents must be terminated before `complete_task_close`.
    Retire(TaskClosePlan),
}

impl CoreRuntime {
    /// Present only for a closed Task whose checkout was removed at close while
    /// its branch binding and close-parked Agents remain.
    pub fn plan_task_reopen_worktree(&self, task_id: &str) -> Option<TaskWorktreeRecreationPlan> {
        let task = self.store.tasks().iter().find(|task| task.id == task_id)?;
        if task.status != TaskStatus::Closed
            || task.archived_at_epoch_ms.is_some()
            || task.worktree.is_some()
        {
            return None;
        }
        let branch = task.branch.as_ref()?;
        let parked = self
            .store
            .task_archive_suspensions()
            .iter()
            .any(|suspension| {
                suspension.task_id.as_deref() == Some(task_id)
                    && suspension.reason == TaskSuspensionReason::ClosedWorktreeRemoved
            });
        let provisioning = self
            .store
            .provisioning_operations()
            .iter()
            .any(|operation| operation.task_id == task_id);
        if !parked || provisioning {
            return None;
        }
        let configured_base_ref = self
            .store
            .project_task_automation_configurations()
            .iter()
            .find(|configuration| configuration.project_id == task.project_id)
            .and_then(|configuration| configuration.base_ref.clone());
        Some(TaskWorktreeRecreationPlan {
            project_id: task.project_id.clone(),
            task_id: task.id.clone(),
            branch_name: branch.name.clone(),
            worktree_leaf: branch_worktree_leaf(&branch.name),
            destination_path: None,
            operation_id: termloop_platform::generate_uuid_v4(),
            base: TaskWorktreeRecreationBase::ExistingElseFreshFromBase {
                released: branch.clone(),
                configured_base_ref,
            },
        })
    }

    /// Frees a closed Task's removed-checkout branch, which could not be
    /// checked out again, so its reopen checkout can start a fresh branch from
    /// the latest base.
    pub fn release_task_branch_for_fresh_checkout(
        &mut self,
        task_id: &str,
        expected: &TaskBranchBinding,
    ) -> Result<(), CoreError> {
        self.store
            .release_closed_task_branch(
                &self.write_authority,
                task_id,
                expected,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        Ok(())
    }

    /// Puts back the branch released for a fresh checkout that could not be
    /// created, so the Task keeps its original branch.
    pub fn rebind_task_branch_after_failed_fresh_checkout(
        &mut self,
        task_id: &str,
        binding: TaskBranchBinding,
    ) -> Result<(), CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if task.branch.is_some() {
            return Ok(());
        }
        self.store
            .bind_task_branch(
                &self.write_authority,
                task_id,
                binding,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        Ok(())
    }

    /// Present only when a deleted Agent's folder is exactly the checkout
    /// location of a non-archived Task that has no worktree now, so restore
    /// can recreate that checkout in place before reopening the Agent there.
    pub fn plan_deleted_session_worktree(
        &self,
        session_id: &str,
    ) -> Option<TaskWorktreeRecreationPlan> {
        let session = &self
            .store
            .deleted_sessions()
            .iter()
            .find(|deleted| deleted.session.id == session_id)?
            .session;
        let cwd = Path::new(&session.process.cwd);
        let project = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == session.project_id)?;
        // Pure path arithmetic under the lock: managed checkouts sit beside the
        // Project folder, which core stores canonically.
        let checkout_parent = Path::new(&project.folder_path).parent()?;
        let task = self.store.tasks().iter().find(|task| {
            task.project_id == session.project_id
                && task.archived_at_epoch_ms.is_none()
                && task.worktree.is_none()
                && task.branch.as_ref().is_some_and(|branch| {
                    checkout_parent.join(branch_worktree_leaf(&branch.name)) == cwd
                })
        })?;
        if self
            .store
            .provisioning_operations()
            .iter()
            .any(|operation| operation.task_id == task.id)
        {
            return None;
        }
        let branch = task.branch.as_ref()?;
        Some(TaskWorktreeRecreationPlan {
            project_id: task.project_id.clone(),
            task_id: task.id.clone(),
            branch_name: branch.name.clone(),
            worktree_leaf: branch_worktree_leaf(&branch.name),
            destination_path: Some(session.process.cwd.clone()),
            operation_id: termloop_platform::generate_uuid_v4(),
            base: TaskWorktreeRecreationBase::ExistingBranch,
        })
    }

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
