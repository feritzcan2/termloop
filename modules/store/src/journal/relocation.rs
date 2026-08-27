use termloop_domain::{
    AgentConversationReadiness, ResumeFailureReason, ResumeLaunchGuard, SessionKind, SessionRecord,
    SessionRelocationOperation, SessionRelocationReceipt, SessionRelocationStage,
    SessionRelocationTarget, TaskStatus,
};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn begin_session_relocation(
        &mut self,
        _authority: &CoreWriteAuthority,
        operation: SessionRelocationOperation,
    ) -> Result<u64, StoreError> {
        if let Some(current) = self
            .state
            .session_relocation_operations
            .iter()
            .find(|current| current.operation_id == operation.operation_id)
        {
            return if current == &operation {
                Ok(self.state.revision)
            } else {
                Err(StoreError::OperationIdReused {
                    operation_id: operation.operation_id,
                })
            };
        }
        if self
            .state
            .session_relocation_receipts
            .iter()
            .any(|receipt| receipt.operation_id == operation.operation_id)
        {
            return Err(StoreError::OperationIdReused {
                operation_id: operation.operation_id,
            });
        }
        if super::super::operation_id_owned_anywhere(&self.state, &operation.operation_id) {
            return Err(StoreError::OperationIdReused {
                operation_id: operation.operation_id,
            });
        }
        let session = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == operation.session_id)
            .ok_or(StoreError::NotFound)?;
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == operation.target_task_id)
            .ok_or(StoreError::NotFound)?;
        let proof = self
            .state
            .managed_worktrees
            .iter()
            .find(|proof| proof.task_id == operation.target_task_id)
            .ok_or(StoreError::ConstraintViolation)?;
        let project = self
            .state
            .projects
            .iter()
            .find(|project| project.id == operation.project_id)
            .ok_or(StoreError::NotFound)?;
        let task_worktree_matches = task.worktree.as_ref().is_some_and(|binding| {
            binding.path == proof.registered_worktree_path
                && (operation.target == SessionRelocationTarget::TaskWorktree
                    && binding.path == operation.target_cwd
                    || operation.target == SessionRelocationTarget::ProjectRoot
                        && (binding.path == operation.source_cwd
                            || session.resume_launch_guard.as_ref().is_some_and(|guard| {
                                guard.task_id == task.id
                                    && guard.path == binding.path
                                    && guard.managed_worktree_operation_id == proof.operation_id
                                    && guard.worktree_generation == proof.worktree_generation
                            })))
        });
        let target_matches = match operation.target {
            SessionRelocationTarget::TaskWorktree => {
                task.status == TaskStatus::Open && operation.target_cwd != operation.source_cwd
            }
            SessionRelocationTarget::ProjectRoot => {
                project.folder_path == operation.target_cwd
                    && operation.target_cwd != operation.source_cwd
            }
        };
        let valid = !operation.operation_id.is_empty()
            && operation.operation_id.len() <= 64
            && operation.started_at_epoch_ms > 0
            && operation.updated_at_epoch_ms >= operation.started_at_epoch_ms
            && operation.stage == SessionRelocationStage::SourceRetiring
            && session.kind == SessionKind::Agent
            && session.project_id == operation.project_id
            && session.runtime_epoch == operation.source_runtime_epoch
            && session.process.cwd == operation.source_cwd
            && (session.lifecycle_state == "running"
                || (session.lifecycle_state == "resumeFailed"
                    && session
                        .resume_failure
                        .is_some_and(ResumeFailureReason::is_retryable)))
            && session.archived_at_epoch_ms.is_none()
            && session
                .resume_ref
                .as_ref()
                .is_some_and(|value| value.validate())
            && task.project_id == operation.project_id
            && task.archived_at_epoch_ms.is_none()
            && task.worktree_generation == operation.target_worktree_generation
            && task_worktree_matches
            && target_matches
            && proof.operation_id == operation.target_managed_worktree_operation_id
            && proof.worktree_generation == operation.target_worktree_generation
            && !self
                .state
                .session_relocation_operations
                .iter()
                .any(|current| current.session_id == operation.session_id)
            && !self
                .state
                .task_archive_operations
                .iter()
                .any(|current| current.task_id == operation.target_task_id)
            && !self
                .state
                .provisioning_operations
                .iter()
                .any(|current| current.task_id == operation.target_task_id)
            && !self
                .state
                .cleanup_operations
                .iter()
                .any(|current| current.task_id == operation.target_task_id)
            && !self
                .state
                .repair_operations
                .iter()
                .any(|current| current.task_id == operation.target_task_id)
            && !self
                .state
                .stale_resolution_operations
                .iter()
                .any(|current| current.task_id == operation.target_task_id)
            && !self
                .state
                .session_archive_operations
                .iter()
                .any(|current| current.session_id == operation.session_id);
        if !valid {
            return Err(StoreError::ConstraintViolation);
        }

        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|session| session.id == operation.session_id)
            .expect("validated Session remains");
        session.lifecycle_state = "resuming".into();
        session.resume_failure = None;
        self.state
            .session_relocation_receipts
            .retain(|receipt| receipt.session_id != operation.session_id);
        self.state.session_relocation_operations.push(operation);
        self.commit_or_restore(previous)
    }

    pub fn mark_session_relocation_target_starting(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        operation_id: &str,
        updated_at_epoch_ms: u64,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let operation = self
            .state
            .session_relocation_operations
            .iter_mut()
            .find(|operation| {
                operation.session_id == session_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        if operation.stage == SessionRelocationStage::TargetStarting {
            return Ok(self.state.revision);
        }
        if operation.stage != SessionRelocationStage::SourceRetiring
            || updated_at_epoch_ms < operation.updated_at_epoch_ms
        {
            return Err(StoreError::ConstraintViolation);
        }
        operation.stage = SessionRelocationStage::TargetStarting;
        operation.updated_at_epoch_ms = updated_at_epoch_ms;
        self.commit_or_restore(previous)
    }

    pub fn commit_session_relocation(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        operation_id: &str,
        runtime_epoch: u64,
        resume_ref: &termloop_domain::ResumeRef,
    ) -> Result<SessionRecord, StoreError> {
        let operation_index = self
            .state
            .session_relocation_operations
            .iter()
            .position(|operation| {
                operation.session_id == session_id && operation.operation_id == operation_id
            })
            .ok_or(StoreError::NotFound)?;
        let operation = self.state.session_relocation_operations[operation_index].clone();
        let session_index = self
            .state
            .sessions
            .iter()
            .position(|session| session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let readiness_index = self
            .state
            .agent_conversation_readiness
            .iter()
            .position(|record| record.session_id == session_id)
            .ok_or(StoreError::ConstraintViolation)?;
        let task = self
            .state
            .tasks
            .iter()
            .find(|task| task.id == operation.target_task_id)
            .ok_or(StoreError::NotFound)?;
        let proof = self
            .state
            .managed_worktrees
            .iter()
            .find(|proof| proof.task_id == operation.target_task_id)
            .ok_or(StoreError::ConstraintViolation)?;
        let project = self
            .state
            .projects
            .iter()
            .find(|project| project.id == operation.project_id)
            .ok_or(StoreError::NotFound)?;
        let session = &self.state.sessions[session_index];
        let task_worktree_matches = task.worktree.as_ref().is_some_and(|binding| {
            binding.path == proof.registered_worktree_path
                && (operation.target == SessionRelocationTarget::TaskWorktree
                    && binding.path == operation.target_cwd
                    || operation.target == SessionRelocationTarget::ProjectRoot
                        && (binding.path == operation.source_cwd
                            || session.resume_launch_guard.as_ref().is_some_and(|guard| {
                                guard.task_id == task.id
                                    && guard.path == binding.path
                                    && guard.managed_worktree_operation_id == proof.operation_id
                                    && guard.worktree_generation == proof.worktree_generation
                            })))
        });
        let target_matches = match operation.target {
            SessionRelocationTarget::TaskWorktree => task.status == TaskStatus::Open,
            SessionRelocationTarget::ProjectRoot => project.folder_path == operation.target_cwd,
        };
        let valid = operation.stage == SessionRelocationStage::TargetStarting
            && runtime_epoch != 0
            && runtime_epoch != operation.source_runtime_epoch
            && session.project_id == operation.project_id
            && session.runtime_epoch == operation.source_runtime_epoch
            && session.lifecycle_state == "resuming"
            && session.process.cwd == operation.source_cwd
            && session
                .resume_ref
                .as_ref()
                .is_some_and(|value| value.validate())
            && resume_ref.validate()
            && crate::migration::provider_matches_agent(
                resume_ref.provider,
                session.process.agent_id.as_deref(),
            )
            && task.project_id == operation.project_id
            && task.archived_at_epoch_ms.is_none()
            && task.worktree_generation == operation.target_worktree_generation
            && task_worktree_matches
            && target_matches
            && proof.operation_id == operation.target_managed_worktree_operation_id
            && proof.worktree_generation == operation.target_worktree_generation
            && operation.target_cwd != operation.source_cwd;
        if !valid {
            return Err(StoreError::ConstraintViolation);
        }

        let previous = self.state.clone();
        let session = &mut self.state.sessions[session_index];
        session.process.cwd = operation.target_cwd.clone();
        session.resume_launch_guard = match operation.target {
            SessionRelocationTarget::TaskWorktree => Some(ResumeLaunchGuard {
                task_id: operation.target_task_id.clone(),
                managed_worktree_operation_id: operation
                    .target_managed_worktree_operation_id
                    .clone(),
                worktree_generation: operation.target_worktree_generation,
                path: operation.target_cwd.clone(),
            }),
            SessionRelocationTarget::ProjectRoot => None,
        };
        session.lifecycle_state = "running".into();
        session.runtime_epoch = runtime_epoch;
        session.resume_ref = Some(resume_ref.clone());
        session.resume_failure = None;
        let relocated = session.clone();
        self.state.agent_conversation_readiness[readiness_index].readiness =
            AgentConversationReadiness::Resumable;
        self.state
            .session_relocation_operations
            .remove(operation_index);
        self.state
            .session_relocation_receipts
            .retain(|receipt| receipt.session_id != session_id);
        self.state
            .session_relocation_receipts
            .push(SessionRelocationReceipt {
                operation_id: operation.operation_id,
                session_id: operation.session_id,
                project_id: operation.project_id,
                target: operation.target,
                target_task_id: operation.target_task_id,
                target_cwd: operation.target_cwd,
                target_worktree_generation: operation.target_worktree_generation,
                target_managed_worktree_operation_id: operation
                    .target_managed_worktree_operation_id,
                runtime_epoch,
            });
        self.commit_or_restore(previous)?;
        Ok(relocated)
    }

    pub fn fail_session_relocation(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        operation_id: &str,
        failure: ResumeFailureReason,
    ) -> Result<SessionRecord, StoreError> {
        let Some(operation_index) =
            self.state
                .session_relocation_operations
                .iter()
                .position(|operation| {
                    operation.session_id == session_id && operation.operation_id == operation_id
                })
        else {
            let session = self
                .state
                .sessions
                .iter()
                .find(|session| session.id == session_id)
                .ok_or(StoreError::NotFound)?;
            return if session.lifecycle_state == "resumeFailed"
                && session.resume_failure == Some(failure)
            {
                Ok(session.clone())
            } else {
                Err(StoreError::NotFound)
            };
        };
        let operation = self.state.session_relocation_operations[operation_index].clone();
        let session_index = self
            .state
            .sessions
            .iter()
            .position(|session| session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let session = &self.state.sessions[session_index];
        if session.project_id != operation.project_id
            || session.process.cwd != operation.source_cwd
            || session.runtime_epoch != operation.source_runtime_epoch
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        let session = &mut self.state.sessions[session_index];
        session.lifecycle_state = "resumeFailed".into();
        session.resume_failure = Some(failure);
        let failed = session.clone();
        self.state
            .session_relocation_operations
            .remove(operation_index);
        self.commit_or_restore(previous)?;
        Ok(failed)
    }

    pub fn reconcile_session_relocations(
        &mut self,
        authority: &CoreWriteAuthority,
    ) -> Result<(), StoreError> {
        let operations = self.state.session_relocation_operations.clone();
        for operation in operations {
            self.fail_session_relocation(
                authority,
                &operation.session_id,
                &operation.operation_id,
                ResumeFailureReason::DaemonInterrupted,
            )?;
        }
        Ok(())
    }
}
