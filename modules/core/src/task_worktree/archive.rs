use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use termloop_domain::{
    SessionKind, TaskArchiveOperation, TaskArchiveOperationState, TaskArchiveTarget,
};

use super::health::comparison_key;
use crate::{CoreError, CoreRuntime, required_string, store_error, terminal_error};

const ARCHIVE_PREVIEW_TTL: Duration = Duration::from_secs(30);
const ARCHIVE_PREVIEW_CAP: usize = 32;

#[derive(Clone)]
pub struct TaskArchiveRetirementPlan {
    task_id: String,
    operation_id: String,
    session_ids: Vec<String>,
}

impl TaskArchiveRetirementPlan {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn session_ids(&self) -> &[String] {
        &self.session_ids
    }
}

#[derive(Clone)]
pub(crate) struct TaskArchivePreviewTicket {
    task_updated_at_epoch_ms: u64,
    operation: TaskArchiveOperation,
    blockers: Vec<String>,
    blocker_session_ids: Vec<String>,
    deadline: termloop_platform::MonotonicDeadline,
}

impl TaskArchivePreviewTicket {
    pub(crate) fn task_id(&self) -> &str {
        &self.operation.task_id
    }
}

impl CoreRuntime {
    pub(crate) fn archived_task_cleanup_guard(
        &self,
        task_id: &str,
    ) -> Result<Option<(u64, Vec<String>)>, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let Some(archived_at_epoch_ms) = task.archived_at_epoch_ms else {
            return Ok(None);
        };
        if self
            .store
            .task_archive_operations()
            .iter()
            .any(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::InvalidParams(
                "archivedTaskDeleteInProgress".into(),
            ));
        }
        let mut declared_cohort = self
            .store
            .task_archive_suspensions()
            .iter()
            .filter(|suspension| suspension.task_id.as_deref() == Some(task_id))
            .map(|suspension| suspension.session_id.clone())
            .collect::<Vec<_>>();
        declared_cohort.sort();
        declared_cohort.dedup();
        let target_path = task.worktree.as_ref().map(|binding| binding.path.as_str());
        let Some(target_path) = target_path else {
            return Ok(Some((archived_at_epoch_ms, declared_cohort)));
        };
        let target_key = match comparison_key(Path::new(target_path)) {
            Ok(key) => key,
            Err(_error)
                if self.store.cleanup_operations().iter().any(|operation| {
                    operation.task_id == task_id
                        && matches!(
                            operation.stage,
                            termloop_domain::WorktreeCleanupStage::RemovePrepared
                                | termloop_domain::WorktreeCleanupStage::RemovalVerified
                                | termloop_domain::WorktreeCleanupStage::BindingCleared
                        )
                }) =>
            {
                return Ok(Some((archived_at_epoch_ms, declared_cohort)));
            }
            Err(error) => return Err(error),
        };
        let mut cohort = Vec::new();
        for suspension in self
            .store
            .task_archive_suspensions()
            .iter()
            .filter(|suspension| suspension.task_id.as_deref() == Some(task_id))
        {
            let Some(session) = self.store.sessions().iter().find(|session| {
                session.id == suspension.session_id && session.project_id == task.project_id
            }) else {
                continue;
            };
            let session_key = comparison_key(Path::new(&session.process.cwd))?;
            if target_key.contains_or_equals(&session_key) {
                cohort.push(session.id.clone());
            }
        }
        cohort.sort();
        cohort.dedup();
        let cohort_ids = cohort
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        for session in self
            .store
            .sessions()
            .iter()
            .filter(|session| session.project_id == task.project_id)
        {
            let session_key = comparison_key(Path::new(&session.process.cwd))?;
            if target_key.contains_or_equals(&session_key)
                && !cohort_ids.contains(session.id.as_str())
            {
                return Err(CoreError::InvalidParams("archivedTaskDeleteRefused".into()));
            }
        }
        Ok(Some((archived_at_epoch_ms, cohort)))
    }

    pub(crate) fn ensure_task_cleanup_allowed(
        &self,
        task_id: &str,
    ) -> Result<Option<u64>, CoreError> {
        self.archived_task_cleanup_guard(task_id)
            .map(|guard| guard.map(|(archived_at_epoch_ms, _)| archived_at_epoch_ms))
    }

    pub(crate) fn ensure_task_active(&self, task_id: &str) -> Result<(), CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if task.archived_at_epoch_ms.is_some() {
            Err(CoreError::TaskArchived {
                task_id: task_id.to_owned(),
            })
        } else {
            Ok(())
        }
    }

    pub(crate) fn reconcile_task_archive_operations(&mut self) {
        for operation in self.store.task_archive_operations().to_vec() {
            if operation.state == TaskArchiveOperationState::RecoveryAttention {
                continue;
            }
            let exact_task = self.store.tasks().iter().any(|task| {
                task.id == operation.task_id
                    && task.project_id == operation.project_id
                    && task.archived_at_epoch_ms.is_none()
                    && task.worktree.as_ref().map(|binding| binding.path.as_str())
                        == operation.worktree_path.as_deref()
                    && task.worktree_generation == operation.worktree_generation
            });
            let exact_sessions = operation.targets.iter().all(|target| {
                self.store.sessions().iter().any(|session| {
                    session.id == target.session_id
                        && session.project_id == operation.project_id
                        && session.runtime_epoch == target.runtime_epoch
                }) && self
                    .terminal
                    .contains_session(&target.session_id)
                    .is_ok_and(|live| !live)
            });
            if exact_task
                && exact_sessions
                && self
                    .store
                    .commit_task_archive(
                        &self.write_authority,
                        &operation.task_id,
                        &operation.operation_id,
                        termloop_platform::current_epoch_ms(),
                    )
                    .is_ok()
            {
                continue;
            }
            let _ = self.store.mark_task_archive_recovery_attention(
                &self.write_authority,
                &operation.task_id,
                &operation.operation_id,
            );
        }
    }

    pub(crate) fn inspect_task_archive(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if task.archived_at_epoch_ms.is_some() {
            return Err(CoreError::TaskArchived { task_id });
        }
        if let Some(operation) = self
            .store
            .task_archive_operations()
            .iter()
            .find(|operation| operation.task_id == task.id)
        {
            return Err(CoreError::ArchiveInProgress {
                task_id: task.id,
                operation_id: operation.operation_id.clone(),
            });
        }

        let mut blockers = Vec::new();
        let mut blocker_session_ids = Vec::new();
        let mut targets = Vec::new();
        let mut projected_sessions = Vec::new();
        let worktree_key = task
            .worktree
            .as_ref()
            .map(|binding| comparison_key(Path::new(&binding.path)))
            .transpose()?;

        for session in self.store.sessions().iter().filter(|session| {
            session.project_id == task.project_id && session.archived_at_epoch_ms.is_none()
        }) {
            let Some(worktree_key) = worktree_key.as_ref() else {
                continue;
            };
            let session_key = match comparison_key(Path::new(&session.process.cwd)) {
                Ok(key) => key,
                Err(_) => {
                    blockers.push("cwdIdentityUnavailable".to_owned());
                    blocker_session_ids.push(session.id.clone());
                    continue;
                }
            };
            if !worktree_key.contains_or_equals(&session_key) {
                continue;
            }
            if self
                .store
                .task_archive_suspensions()
                .iter()
                .any(|suspension| suspension.session_id == session.id)
            {
                blockers.push("alreadySuspended".to_owned());
                blocker_session_ids.push(session.id.clone());
                continue;
            }
            let protected_role = session.process.template_ref.as_deref()
                == Some("builtin.agent.ask-to-helper")
                || self
                    .store
                    .steward_configurations()
                    .iter()
                    .any(|configuration| {
                        configuration.executor_session_id.as_deref() == Some(&session.id)
                    })
                || self
                    .store
                    .worker_configurations()
                    .iter()
                    .any(|configuration| {
                        configuration.executor_session_id.as_deref() == Some(&session.id)
                    });
            let live = self
                .terminal
                .contains_session(&session.id)
                .map_err(terminal_error)?;
            let mut disposition = "willPreservePlaceholder";
            let mut blocker = None;
            if protected_role {
                blocker = Some("protectedAssistantRole");
            } else if self.resume_reservations.contains(&session.id)
                || self
                    .provider_history_repair_reservations
                    .contains(&session.id)
            {
                blocker = Some("lifecycleInProgress");
            } else if live && session.kind == SessionKind::Terminal {
                blocker = Some("runningGenericTerminal");
            } else if live
                && (session
                    .resume_ref
                    .as_ref()
                    .is_none_or(|resume_ref| !resume_ref.validate())
                    || session.process.agent_id.as_ref().is_none_or(|agent_id| {
                        self.observation_transport
                            .as_ref()
                            .is_none_or(|transport| !transport.resume_supported(agent_id))
                    }))
            {
                blocker = Some("agentNotResumable");
            } else if live && session.kind == SessionKind::Agent {
                disposition = "willParkAndResume";
            } else if session.lifecycle_state == "running" {
                blocker = Some("runtimeOwnershipUncertain");
            }
            if let Some(blocker) = blocker {
                blockers.push(blocker.to_owned());
                blocker_session_ids.push(session.id.clone());
                disposition = "blocksArchive";
            }
            projected_sessions.push(json!({
                "session_id": session.id,
                "name": session.name,
                "kind": session.kind,
                "agent_id": session.process.agent_id,
                "lifecycle_state": session.lifecycle_state,
                "disposition": disposition,
                "blocker": blocker,
            }));
            targets.push(TaskArchiveTarget {
                session_id: session.id.clone(),
                runtime_epoch: session.runtime_epoch,
                prior_lifecycle_state: session.lifecycle_state.clone(),
                prior_resume_failure: session.resume_failure,
                was_live_agent: live && session.kind == SessionKind::Agent && blocker.is_none(),
            });
        }
        blockers.sort();
        blockers.dedup();
        blocker_session_ids.sort();
        blocker_session_ids.dedup();

        for relocation in self
            .store
            .session_relocation_operations()
            .iter()
            .filter(|operation| operation.target_task_id == task.id)
        {
            blockers.push("lifecycleInProgress".into());
            blocker_session_ids.push(relocation.session_id.clone());
        }

        for operation in self
            .store
            .provisioning_operations()
            .iter()
            .filter(|operation| operation.task_id == task.id)
        {
            blockers.push("provisioningInProgress".into());
            let _ = operation;
        }
        if self
            .store
            .cleanup_operations()
            .iter()
            .any(|operation| operation.task_id == task.id)
        {
            blockers.push("cleanupInProgress".into());
        }
        if self
            .store
            .repair_operations()
            .iter()
            .any(|operation| operation.task_id == task.id)
        {
            blockers.push("repairInProgress".into());
        }
        if self
            .store
            .stale_resolution_operations()
            .iter()
            .any(|operation| operation.task_id == task.id)
        {
            blockers.push("staleResolutionInProgress".into());
        }
        blockers.sort();
        blockers.dedup();

        let operation = TaskArchiveOperation {
            operation_id: String::new(),
            task_id: task.id.clone(),
            project_id: task.project_id.clone(),
            worktree_path: task.worktree.as_ref().map(|binding| binding.path.clone()),
            worktree_generation: task.worktree_generation,
            targets,
            state: TaskArchiveOperationState::Prepared,
        };
        self.task_archive_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        if self.task_archive_previews.len() >= ARCHIVE_PREVIEW_CAP {
            self.task_archive_previews.pop_front();
        }
        let mut archive_ticket = termloop_platform::generate_opaque_runtime_token();
        while self
            .task_archive_previews
            .iter()
            .any(|(ticket, _)| ticket == &archive_ticket)
        {
            archive_ticket = termloop_platform::generate_opaque_runtime_token();
        }
        let deadline = termloop_platform::MonotonicDeadline::after(ARCHIVE_PREVIEW_TTL)
            .map_err(|error| CoreError::Terminal(error.to_string()))?;
        self.task_archive_previews.push_back((
            archive_ticket.clone(),
            TaskArchivePreviewTicket {
                task_updated_at_epoch_ms: task.updated_at_epoch_ms,
                operation,
                blockers: blockers.clone(),
                blocker_session_ids: blocker_session_ids.clone(),
                deadline,
            },
        ));
        Ok(json!({
            "task_id": task.id,
            "archive_ticket": archive_ticket,
            "expires_in_ms": 30_000,
            "sessions": projected_sessions,
            "blockers": blockers,
            "can_archive": blockers.is_empty(),
        }))
    }

    pub(crate) fn archive_task(&mut self, params: Value) -> Result<Value, CoreError> {
        let plan = self.prepare_task_archive(params)?;
        for session_id in plan.session_ids() {
            let result = self
                .terminal
                .contains_session(session_id)
                .map_err(terminal_error)
                .and_then(|live| {
                    if live {
                        self.terminal.terminate(session_id).map_err(terminal_error)
                    } else {
                        Ok(())
                    }
                });
            if result.is_err() {
                self.mark_task_archive_recovery_attention(&plan)?;
                return Err(CoreError::ArchiveRecoveryAttention {
                    task_id: plan.task_id.clone(),
                    operation_id: plan.operation_id.clone(),
                });
            }
        }
        self.complete_task_archive(plan)
    }

    pub fn prepare_task_archive(
        &mut self,
        params: Value,
    ) -> Result<TaskArchiveRetirementPlan, CoreError> {
        self.task_archive_previews
            .retain(|(_, preview)| preview.deadline.remaining().is_some());
        let task_id = required_string(&params, "taskId")?;
        let operation_id = required_string(&params, "operationId")?;
        let archive_ticket = required_string(&params, "archiveTicket")?;
        let position = self
            .task_archive_previews
            .iter()
            .position(|(ticket, _)| ticket == &archive_ticket)
            .ok_or_else(|| CoreError::ArchivePreviewStale {
                task_id: task_id.clone(),
            })?;
        let (_, mut preview) = self
            .task_archive_previews
            .remove(position)
            .expect("archive ticket position came from the same bounded queue");
        if preview.operation.task_id != task_id {
            return Err(CoreError::ArchivePreviewStale { task_id });
        }
        if !preview.blockers.is_empty() {
            return Err(CoreError::ArchiveRefused {
                task_id,
                blockers: preview.blockers,
                session_ids: preview.blocker_session_ids,
            });
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let current_sessions_match = preview.operation.targets.iter().all(|target| {
            let descriptor_matches = self.store.sessions().iter().any(|session| {
                session.id == target.session_id
                    && session.runtime_epoch == target.runtime_epoch
                    && session.lifecycle_state == target.prior_lifecycle_state
                    && session.resume_failure == target.prior_resume_failure
            });
            let live_matches = self
                .terminal
                .contains_session(&target.session_id)
                .is_ok_and(|live| live == target.was_live_agent);
            descriptor_matches
                && live_matches
                && !self.resume_reservations.contains(&target.session_id)
                && !self
                    .provider_history_repair_reservations
                    .contains(&target.session_id)
        });
        let current_cohort_matches = match preview.operation.worktree_path.as_deref() {
            None => preview.operation.targets.is_empty(),
            Some(path) => {
                let expected_key = comparison_key(Path::new(path));
                match expected_key {
                    Err(_) => false,
                    Ok(expected_key) => {
                        let mut current_ids = self
                            .store
                            .sessions()
                            .iter()
                            .filter(|session| {
                                session.project_id == preview.operation.project_id
                                    && session.archived_at_epoch_ms.is_none()
                            })
                            .filter_map(|session| {
                                comparison_key(Path::new(&session.process.cwd))
                                    .ok()
                                    .filter(|cwd| expected_key.contains_or_equals(cwd))
                                    .map(|_| session.id.clone())
                            })
                            .collect::<Vec<_>>();
                        let mut preview_ids = preview
                            .operation
                            .targets
                            .iter()
                            .map(|target| target.session_id.clone())
                            .collect::<Vec<_>>();
                        current_ids.sort();
                        preview_ids.sort();
                        current_ids == preview_ids
                    }
                }
            }
        };
        let conflicting_operation = self
            .store
            .provisioning_operations()
            .iter()
            .any(|value| value.task_id == task_id)
            || self
                .store
                .cleanup_operations()
                .iter()
                .any(|value| value.task_id == task_id)
            || self
                .store
                .repair_operations()
                .iter()
                .any(|value| value.task_id == task_id)
            || self
                .store
                .stale_resolution_operations()
                .iter()
                .any(|value| value.task_id == task_id)
            || self
                .store
                .session_relocation_operations()
                .iter()
                .any(|value| value.target_task_id == task_id);
        if task.updated_at_epoch_ms != preview.task_updated_at_epoch_ms
            || task.archived_at_epoch_ms.is_some()
            || task.worktree_generation != preview.operation.worktree_generation
            || !current_sessions_match
            || !current_cohort_matches
            || conflicting_operation
        {
            return Err(CoreError::ArchivePreviewStale { task_id });
        }
        preview.operation.operation_id = operation_id.clone();
        self.store
            .begin_task_archive(&self.write_authority, preview.operation.clone())
            .map_err(store_error)?;
        Ok(TaskArchiveRetirementPlan {
            task_id,
            operation_id,
            session_ids: preview
                .operation
                .targets
                .iter()
                .filter(|target| target.was_live_agent)
                .map(|target| target.session_id.clone())
                .collect(),
        })
    }

    pub fn mark_task_archive_recovery_attention(
        &mut self,
        plan: &TaskArchiveRetirementPlan,
    ) -> Result<(), CoreError> {
        self.store
            .mark_task_archive_recovery_attention(
                &self.write_authority,
                plan.task_id(),
                plan.operation_id(),
            )
            .map_err(store_error)?;
        Ok(())
    }

    pub fn detach_task_archive_runtimes(
        &mut self,
        plan: &TaskArchiveRetirementPlan,
    ) -> Vec<crate::CodexRuntime> {
        plan.session_ids
            .iter()
            .filter_map(|session_id| {
                self.agent_observations.remove(session_id);
                self.agent_conversation_activity.remove(session_id);
                self.resume_ready.remove(session_id);
                self.mcp_authorizer.remove(session_id);
                self.codex_runtimes.remove(session_id)
            })
            .collect()
    }

    pub fn complete_task_archive(
        &mut self,
        plan: TaskArchiveRetirementPlan,
    ) -> Result<Value, CoreError> {
        if plan.session_ids.iter().any(|session_id| {
            self.terminal
                .contains_session(session_id)
                .map_or(true, |live| live)
        }) {
            self.mark_task_archive_recovery_attention(&plan)?;
            return Err(CoreError::ArchiveRecoveryAttention {
                task_id: plan.task_id,
                operation_id: plan.operation_id,
            });
        }
        let task_id = plan.task_id;
        let operation_id = plan.operation_id;
        let targets = self
            .store
            .task_archive_operations()
            .iter()
            .find(|operation| {
                operation.task_id == task_id && operation.operation_id == operation_id
            })
            .map(|operation| operation.targets.clone())
            .ok_or(CoreError::NotFound)?;
        let archived_at_epoch_ms = termloop_platform::current_epoch_ms();
        self.store
            .commit_task_archive(
                &self.write_authority,
                &task_id,
                &operation_id,
                archived_at_epoch_ms,
            )
            .map_err(store_error)?;
        for target in &targets {
            self.agent_observations.remove(&target.session_id);
            self.agent_conversation_activity.remove(&target.session_id);
            self.resume_ready.remove(&target.session_id);
            self.codex_runtimes.remove(&target.session_id);
            self.mcp_authorizer.remove(&target.session_id);
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        Ok(json!({
            "task": self.task_projection(task)?,
            "archived_session_count": targets.len(),
        }))
    }

    pub(crate) fn abandon_task_archive(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let operation_id = required_string(&params, "operationId")?;
        self.store
            .abandon_task_archive(&self.write_authority, &task_id, &operation_id)
            .map_err(store_error)?;
        Ok(json!({ "task_id": task_id, "kept_active": true }))
    }

    pub(crate) fn restore_task(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let Some(archived_at) = task.archived_at_epoch_ms else {
            return Ok(json!({
                "task": self.task_projection(&task)?,
                "resume_session_ids": Vec::<String>::new(),
                "restored_session_count": 0,
            }));
        };
        let session_ids = self
            .store
            .task_archive_suspensions()
            .iter()
            .filter(|suspension| suspension.archived_at_epoch_ms == archived_at)
            .filter(|suspension| {
                suspension
                    .task_id
                    .as_ref()
                    .is_none_or(|suspension_task_id| suspension_task_id == &task_id)
            })
            .filter_map(|suspension| {
                self.store
                    .sessions()
                    .iter()
                    .find(|session| {
                        session.id == suspension.session_id
                            && session.project_id == task.project_id
                            && task.worktree.as_ref().is_some_and(|worktree| {
                                comparison_key(Path::new(&worktree.path))
                                    .ok()
                                    .zip(comparison_key(Path::new(&session.process.cwd)).ok())
                                    .is_some_and(|(root, cwd)| root.contains_or_equals(&cwd))
                            })
                    })
                    .map(|session| session.id.clone())
            })
            .collect::<Vec<_>>();
        let resume_session_ids = self
            .store
            .restore_task_archive(
                &self.write_authority,
                &task_id,
                &session_ids,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        Ok(json!({
            "task": self.task_projection(task)?,
            "resume_session_ids": resume_session_ids,
            "restored_session_count": session_ids.len(),
        }))
    }

    pub(crate) fn archived_task_context(&self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let archived_at = task
            .archived_at_epoch_ms
            .ok_or_else(|| CoreError::TaskNotArchived {
                task_id: task_id.clone(),
            })?;
        let sessions = self
            .store
            .task_archive_suspensions()
            .iter()
            .filter(|suspension| suspension.archived_at_epoch_ms == archived_at)
            .filter(|suspension| {
                suspension
                    .task_id
                    .as_ref()
                    .is_none_or(|suspension_task_id| suspension_task_id == &task_id)
            })
            .filter_map(|suspension| {
                self.store
                    .sessions()
                    .iter()
                    .find(|session| {
                        session.id == suspension.session_id
                            && session.project_id == task.project_id
                            && task.worktree.as_ref().is_some_and(|worktree| {
                                comparison_key(Path::new(&worktree.path))
                                    .ok()
                                    .zip(comparison_key(Path::new(&session.process.cwd)).ok())
                                    .is_some_and(|(root, cwd)| root.contains_or_equals(&cwd))
                            })
                    })
                    .map(|session| {
                        json!({
                            "session": self.project_session(session),
                            "prior_lifecycle_state": suspension.prior_lifecycle_state,
                            "will_resume": suspension.prior_lifecycle_state == "running",
                        })
                    })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "task_id": task_id, "sessions": sessions }))
    }

    pub(crate) fn delete_archived_task(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let Some((archived_at_epoch_ms, session_ids)) =
            self.archived_task_cleanup_guard(&task_id)?
        else {
            return Err(CoreError::TaskNotArchived { task_id });
        };
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if task.worktree.is_some() {
            return Err(CoreError::TaskWorktreeCleanupRequired { task_id });
        }
        self.store
            .delete_archived_task_with_sessions(
                &self.write_authority,
                &task_id,
                archived_at_epoch_ms,
                &session_ids,
            )
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&task_id);
        Ok(json!({ "taskId": task_id, "deleted": true }))
    }

    pub(crate) fn session_is_archive_suspended(&self, session_id: &str) -> bool {
        self.store
            .task_archive_suspensions()
            .iter()
            .any(|suspension| suspension.session_id == session_id)
    }
}
