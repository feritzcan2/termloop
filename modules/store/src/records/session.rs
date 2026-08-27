use termloop_domain::{
    AgentConversationReadiness, AgentConversationReadinessRecord, ResumeFailureReason, ResumeRef,
    SavedAgentLaunchSelection, SessionKind, SessionRecord,
};

use crate::migration::provider_matches_agent;

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    /// Removes an assistant Session admission whose process never started,
    /// together with its exact current pointer.
    /// This is one current-state commit so a failed spawn cannot leave a
    /// partially rolled-back durable configuration.
    pub fn rollback_assistant_launch(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<u64, StoreError> {
        let session_index = self
            .state
            .sessions
            .iter()
            .position(|session| session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let is_steward = self
            .state
            .steward_configurations
            .iter()
            .any(|configuration| configuration.executor_session_id.as_deref() == Some(session_id));
        let is_worker = self
            .state
            .worker_configurations
            .iter()
            .any(|configuration| configuration.executor_session_id.as_deref() == Some(session_id));
        if !is_steward && !is_worker {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        if is_steward {
            let project_id = self.state.sessions[session_index].project_id.clone();
            let configuration = self
                .state
                .steward_configurations
                .iter_mut()
                .find(|configuration| {
                    configuration.project_id == project_id
                        && configuration.executor_session_id.as_deref() == Some(session_id)
                })
                .ok_or(StoreError::ConstraintViolation)?;
            configuration.executor_session_id = None;
        } else {
            let configuration = self
                .state
                .worker_configurations
                .iter_mut()
                .find(|configuration| {
                    configuration.executor_session_id.as_deref() == Some(session_id)
                })
                .ok_or(StoreError::ConstraintViolation)?;
            configuration.executor_session_id = None;
        }
        super::agent_plan::remove_agent_plans_for_sessions(&mut self.state, [session_id]);
        self.state.sessions.remove(session_index);
        remove_agent_conversation_readiness(&mut self.state, [session_id]);
        self.commit_or_restore(previous)
    }

    pub fn insert_session(
        &mut self,
        _authority: &CoreWriteAuthority,
        session: SessionRecord,
    ) -> Result<u64, StoreError> {
        if self
            .state
            .sessions
            .iter()
            .any(|value| value.id == session.id)
        {
            return Err(StoreError::AlreadyExists);
        }
        let previous = self.state.clone();
        if session.kind == SessionKind::Agent {
            self.state
                .agent_conversation_readiness
                .push(AgentConversationReadinessRecord {
                    session_id: session.id.clone(),
                    readiness: AgentConversationReadiness::Unconfirmed,
                });
        }
        self.state.sessions.push(session);
        self.commit_or_restore(previous)
    }

    pub fn insert_session_and_remember_agent_launch(
        &mut self,
        _authority: &CoreWriteAuthority,
        session: SessionRecord,
    ) -> Result<u64, StoreError> {
        if self
            .state
            .sessions
            .iter()
            .any(|value| value.id == session.id)
        {
            return Err(StoreError::AlreadyExists);
        }
        let agent_id = session
            .process
            .agent_id
            .as_deref()
            .ok_or(StoreError::ConstraintViolation)?;
        let preference = SavedAgentLaunchSelection::new(agent_id, session.launch_selection.clone());
        if session.kind != SessionKind::Agent || !preference.is_valid() {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.last_agent_launch_selection = Some(preference);
        self.state
            .agent_conversation_readiness
            .push(AgentConversationReadinessRecord {
                session_id: session.id.clone(),
                readiness: AgentConversationReadiness::Unconfirmed,
            });
        self.state.sessions.push(session);
        self.commit_or_restore(previous)
    }

    pub fn mark_agent_conversation_resumable(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<u64, StoreError> {
        let session = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let resume_ref = session
            .resume_ref
            .as_ref()
            .filter(|resume_ref| resume_ref.validate())
            .ok_or(StoreError::InvalidResumeRef)?;
        if session.kind != SessionKind::Agent
            || !provider_matches_agent(resume_ref.provider, session.process.agent_id.as_deref())
        {
            return Err(StoreError::ResumeProviderMismatch);
        }
        let readiness_index = self
            .state
            .agent_conversation_readiness
            .iter()
            .position(|record| record.session_id == session_id)
            .ok_or(StoreError::ConstraintViolation)?;
        if self.state.agent_conversation_readiness[readiness_index].readiness
            == AgentConversationReadiness::Resumable
        {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.agent_conversation_readiness[readiness_index].readiness =
            AgentConversationReadiness::Resumable;
        self.commit_or_restore(previous)
    }

    pub fn mark_session_exited(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let session_index = self
            .state
            .sessions
            .iter()
            .position(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let already_exited = self.state.sessions[session_index].lifecycle_state == "exited";
        let relocation_cleared = self
            .state
            .session_relocation_operations
            .iter()
            .any(|operation| operation.session_id == session_id);
        if already_exited && !relocation_cleared {
            return Ok(self.state.revision);
        }
        let session = &mut self.state.sessions[session_index];
        session.lifecycle_state = "exited".into();
        session.resume_failure = None;
        for configuration in &mut self.state.steward_configurations {
            if configuration.executor_session_id.as_deref() == Some(session_id) {
                configuration.executor_session_id = None;
            }
        }
        for configuration in &mut self.state.worker_configurations {
            if configuration.executor_session_id.as_deref() == Some(session_id) {
                configuration.executor_session_id = None;
            }
        }
        self.state
            .session_relocation_operations
            .retain(|operation| operation.session_id != session_id);
        let _ = remove_obsolete_assistant_sessions(&mut self.state);
        self.commit_or_restore(previous)
    }

    pub fn establish_session_resume_ref(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        resume_ref: ResumeRef,
    ) -> Result<u64, StoreError> {
        if !resume_ref.validate() {
            return Err(StoreError::InvalidResumeRef);
        }
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.kind != SessionKind::Agent
            || !provider_matches_agent(resume_ref.provider, session.process.agent_id.as_deref())
        {
            return Err(StoreError::ResumeProviderMismatch);
        }
        match session.resume_ref.as_ref() {
            Some(current) if current == &resume_ref => return Ok(self.state.revision),
            Some(_) => return Err(StoreError::ResumeRefReplacement),
            None => session.resume_ref = Some(resume_ref),
        }
        self.commit_or_restore(previous)
    }

    pub fn replace_running_session_resume_ref(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        expected_resume_ref: &ResumeRef,
        replacement: ResumeRef,
    ) -> Result<u64, StoreError> {
        if !expected_resume_ref.validate() || !replacement.validate() {
            return Err(StoreError::InvalidResumeRef);
        }
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.kind != SessionKind::Agent
            || expected_resume_ref.provider != replacement.provider
            || !provider_matches_agent(replacement.provider, session.process.agent_id.as_deref())
        {
            return Err(StoreError::ResumeProviderMismatch);
        }
        if session.lifecycle_state != "running"
            || session.resume_ref.as_ref() != Some(expected_resume_ref)
        {
            return Err(StoreError::ConstraintViolation);
        }
        if expected_resume_ref == &replacement {
            return Ok(self.state.revision);
        }
        session.resume_ref = Some(replacement);
        self.commit_or_restore(previous)
    }

    /// Replaces the selection of one exact live provider conversation. Both
    /// providers can move their own model, permission, or effort inside the
    /// running TUI, and a resume that reasserted the launch-time selection
    /// would silently undo that.
    pub fn update_running_agent_session_launch_selection(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        runtime_epoch: u64,
        expected_resume_ref: &ResumeRef,
        launch_selection: &termloop_domain::AgentLaunchSelection,
    ) -> Result<u64, StoreError> {
        if !expected_resume_ref.validate() {
            return Err(StoreError::InvalidResumeRef);
        }
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.kind != SessionKind::Agent
            || !provider_matches_agent(
                expected_resume_ref.provider,
                session.process.agent_id.as_deref(),
            )
            || session.lifecycle_state != "running"
            || session.runtime_epoch != runtime_epoch
            || session.resume_ref.as_ref() != Some(expected_resume_ref)
        {
            return Err(StoreError::ConstraintViolation);
        }
        if !launch_selection.is_well_formed() {
            return Err(StoreError::ConstraintViolation);
        }
        if session.launch_selection == *launch_selection {
            return Ok(self.state.revision);
        }
        session.launch_selection = launch_selection.clone();
        self.commit_or_restore(previous)
    }

    pub fn mark_session_resuming(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.lifecycle_state == "resuming" && session.resume_failure.is_none() {
            return Ok(self.state.revision);
        }
        if session.kind != SessionKind::Agent
            || session.resume_ref.as_ref().is_none_or(|v| !v.validate())
        {
            return Err(StoreError::InvalidResumeRef);
        }
        session.lifecycle_state = "resuming".into();
        session.resume_failure = None;
        self.commit_or_restore(previous)
    }

    pub fn complete_session_resume(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        expected_resume_ref: &ResumeRef,
        runtime_epoch: u64,
    ) -> Result<u64, StoreError> {
        let readiness_index = self
            .state
            .agent_conversation_readiness
            .iter()
            .position(|record| record.session_id == session_id)
            .ok_or(StoreError::ConstraintViolation)?;
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.lifecycle_state != "resuming"
            || session.resume_ref.as_ref() != Some(expected_resume_ref)
        {
            return Err(StoreError::ConstraintViolation);
        }
        session.lifecycle_state = "running".into();
        session.runtime_epoch = runtime_epoch;
        session.resume_failure = None;
        self.state.agent_conversation_readiness[readiness_index].readiness =
            AgentConversationReadiness::Resumable;
        self.state
            .session_relocation_receipts
            .retain(|receipt| receipt.session_id != session_id);
        self.commit_or_restore(previous)
    }

    pub fn mark_session_resume_failed(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        failure: ResumeFailureReason,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let relocation_pending = self
            .state
            .session_relocation_operations
            .iter()
            .any(|operation| operation.session_id == session_id);
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.lifecycle_state == "resumeFailed"
            && session.resume_failure == Some(failure)
            && !relocation_pending
        {
            return Ok(self.state.revision);
        }
        if session.kind != SessionKind::Agent {
            return Err(StoreError::ConstraintViolation);
        }
        session.lifecycle_state = "resumeFailed".into();
        session.resume_failure = Some(failure);
        // A persistent Steward/Worker binding is also the authority proof used
        // to re-derive its closed MCP role on Retry. Keep that exact binding
        // through a failed resume so recovery can only resume this provider
        // conversation; clearing it here would let the assistant scheduler
        // silently replace the conversation with a fresh Session.
        self.state
            .session_relocation_operations
            .retain(|operation| operation.session_id != session_id);
        self.commit_or_restore(previous)
    }

    pub fn mark_sessions_resume_failed(
        &mut self,
        _authority: &CoreWriteAuthority,
        failures: &[(String, ResumeFailureReason)],
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let mut changed = false;
        for (session_id, failure) in failures {
            let Some(session) = self
                .state
                .sessions
                .iter_mut()
                .find(|value| value.id == *session_id)
            else {
                continue;
            };
            if session.kind != SessionKind::Agent {
                continue;
            }
            if session.lifecycle_state != "resumeFailed" || session.resume_failure != Some(*failure)
            {
                session.lifecycle_state = "resumeFailed".into();
                session.resume_failure = Some(*failure);
                changed = true;
            }
        }
        let operation_count = self.state.session_relocation_operations.len();
        self.state
            .session_relocation_operations
            .retain(|operation| {
                !failures
                    .iter()
                    .any(|(session_id, _)| session_id == &operation.session_id)
            });
        changed |= operation_count != self.state.session_relocation_operations.len();
        if changed {
            self.commit_or_restore(previous)
        } else {
            Ok(self.state.revision)
        }
    }

    pub fn mark_startup_resume_overflow(
        &mut self,
        _authority: &CoreWriteAuthority,
        admitted_session_ids: &[String],
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let mut changed = false;
        let mut overflow_session_ids = Vec::new();
        for session in self.state.sessions.iter_mut().filter(|session| {
            session.kind == SessionKind::Agent
                && session.lifecycle_state == "resuming"
                && !admitted_session_ids
                    .iter()
                    .any(|session_id| session_id == &session.id)
        }) {
            session.lifecycle_state = "resumeFailed".into();
            session.resume_failure = Some(ResumeFailureReason::ResumeQueueFull);
            overflow_session_ids.push(session.id.clone());
            changed = true;
        }
        let operation_count = self.state.session_relocation_operations.len();
        self.state
            .session_relocation_operations
            .retain(|operation| {
                !overflow_session_ids
                    .iter()
                    .any(|session_id| session_id == &operation.session_id)
            });
        changed |= operation_count != self.state.session_relocation_operations.len();
        if changed {
            self.commit_or_restore(previous)
        } else {
            Ok(self.state.revision)
        }
    }

    pub fn delete_session_descriptor(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<SessionRecord, StoreError> {
        let index = self
            .state
            .sessions
            .iter()
            .position(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        let session = &self.state.sessions[index];
        let uncertain = matches!(
            session.resume_failure,
            Some(
                ResumeFailureReason::RuntimeOwnershipUncertain
                    | ResumeFailureReason::RuntimeConflict
            )
        );
        if !matches!(
            session.lifecycle_state.as_str(),
            "exited" | "stale" | "resumeFailed"
        ) || uncertain
        {
            return Err(StoreError::SessionNotClosable);
        }
        let previous = self.state.clone();
        clear_executor_session_references(&mut self.state, [session_id]);
        let _ = clear_ask_to_continuations_for_session(&mut self.state.sessions, session_id);
        self.state
            .session_relocation_receipts
            .retain(|receipt| receipt.session_id != session_id);
        super::agent_plan::remove_agent_plans_for_sessions(&mut self.state, [session_id]);
        let removed = self.state.sessions.remove(index);
        remove_agent_conversation_readiness(&mut self.state, [session_id]);
        self.commit_or_restore(previous)?;
        Ok(removed)
    }

    pub fn restore_archived_session_descriptor(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<SessionRecord, StoreError> {
        if let Some(operation) = self
            .state
            .session_archive_operations
            .iter()
            .find(|operation| operation.session_id == session_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if session.archived_at_epoch_ms.is_none() {
            return Ok(session.clone());
        }
        session.archived_at_epoch_ms = None;
        session.lifecycle_state = "exited".into();
        session.resume_failure = None;
        let restored = session.clone();
        self.commit_or_restore(previous)?;
        Ok(restored)
    }

    pub fn delete_archived_session_descriptor(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
    ) -> Result<SessionRecord, StoreError> {
        if let Some(operation) = self
            .state
            .session_archive_operations
            .iter()
            .find(|operation| operation.session_id == session_id)
        {
            return Err(StoreError::JournalConflict {
                operation_id: operation.operation_id.clone(),
            });
        }
        let index = self
            .state
            .sessions
            .iter()
            .position(|session| session.id == session_id)
            .ok_or(StoreError::NotFound)?;
        if self.state.sessions[index].archived_at_epoch_ms.is_none() {
            return Err(StoreError::SessionNotClosable);
        }
        let previous = self.state.clone();
        clear_executor_session_references(&mut self.state, [session_id]);
        let _ = clear_ask_to_continuations_for_session(&mut self.state.sessions, session_id);
        super::agent_plan::remove_agent_plans_for_sessions(&mut self.state, [session_id]);
        let removed = self.state.sessions.remove(index);
        remove_agent_conversation_readiness(&mut self.state, [session_id]);
        self.commit_or_restore(previous)?;
        Ok(removed)
    }

    pub fn rename_session(
        &mut self,
        _authority: &CoreWriteAuthority,
        session_id: &str,
        name: Option<String>,
    ) -> Result<SessionRecord, StoreError> {
        let previous = self.state.clone();
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|value| value.id == session_id)
            .ok_or(StoreError::NotFound)?;
        session.name = name;
        let updated = session.clone();
        self.commit_or_restore(previous)?;
        Ok(updated)
    }

    pub fn set_ask_to_current_request(
        &mut self,
        _authority: &CoreWriteAuthority,
        helper_session_id: &str,
        conversation_id: &str,
        request_id: Option<&str>,
    ) -> Result<u64, StoreError> {
        let helper_index = self
            .state
            .sessions
            .iter()
            .position(|session| session.id == helper_session_id)
            .ok_or(StoreError::NotFound)?;
        let helper = &self.state.sessions[helper_index];
        let source_session_id = helper
            .ask_to_source_session_id
            .as_deref()
            .filter(|_| {
                helper.lifecycle_state != "exited"
                    && helper.process.template_ref.as_deref() == Some("builtin.agent.ask-to-helper")
            })
            .ok_or(StoreError::ConstraintViolation)?;
        if !self.state.sessions.iter().any(|source| {
            source.id == source_session_id
                && source.kind == termloop_domain::SessionKind::Agent
                && source.project_id == helper.project_id
                && source.lifecycle_state != "exited"
        }) {
            return Err(StoreError::ConstraintViolation);
        }
        let continuation = helper
            .ask_to_continuation
            .as_ref()
            .filter(|continuation| continuation.conversation_id == conversation_id)
            .ok_or(StoreError::ConstraintViolation)?;
        let proposed = termloop_domain::AskToContinuation {
            conversation_id: continuation.conversation_id.clone(),
            current_request_id: request_id.map(str::to_owned),
        };
        if !proposed.is_well_formed() {
            return Err(StoreError::ConstraintViolation);
        }
        if continuation == &proposed {
            return Ok(self.state.revision);
        }
        let previous = self.state.clone();
        self.state.sessions[helper_index].ask_to_continuation = Some(proposed);
        self.commit_or_restore(previous)
    }

    pub fn reconcile_restart(&mut self, _authority: &CoreWriteAuthority) -> Result<(), StoreError> {
        let previous = self.state.clone();
        let mut changed = false;
        let conversation_readiness = self
            .state
            .agent_conversation_readiness
            .iter()
            .map(|record| (record.session_id.clone(), record.readiness))
            .collect::<std::collections::HashMap<_, _>>();
        let configured_assistant_session_ids = self
            .state
            .steward_configurations
            .iter()
            .filter_map(|configuration| configuration.executor_session_id.clone())
            .chain(
                self.state
                    .worker_configurations
                    .iter()
                    .filter_map(|configuration| configuration.executor_session_id.clone()),
            )
            .collect::<std::collections::HashSet<_>>();
        let mut obsolete_assistant_session_ids = Vec::new();
        let mut retired_run_session_ids = Vec::new();
        for session in &mut self.state.sessions {
            let configured_assistant = configured_assistant_session_ids.contains(&session.id);
            let retry_capability_probe = session.kind == SessionKind::Agent
                && session.lifecycle_state == "resumeFailed"
                && session.resume_failure == Some(ResumeFailureReason::ResumeCapabilityUnavailable);
            if !matches!(session.lifecycle_state.as_str(), "running" | "resuming")
                && !retry_capability_probe
            {
                continue;
            }
            changed = true;
            let legacy_assistant_template =
                session
                    .process
                    .template_ref
                    .as_deref()
                    .is_some_and(|template| {
                        template == "builtin.steward.executor"
                            || template == "builtin.worker.executor"
                    });
            if legacy_assistant_template && !configured_assistant {
                session.lifecycle_state = "exited".into();
                session.resume_failure = None;
                obsolete_assistant_session_ids.push(session.id.clone());
                continue;
            }
            if session.kind == SessionKind::Terminal {
                // A run owns no resumable context: its process, its PTY buffer,
                // and its runtime observation all ended with the daemon, and
                // its configuration can start a fresh one at any time. A shell
                // the user opened is different — its stale row is the only
                // record that it existed, so it stays.
                if session.run_configuration_id.is_some() {
                    retired_run_session_ids.push(session.id.clone());
                    continue;
                }
                session.lifecycle_state = "stale".into();
                session.resume_failure = None;
                continue;
            }
            if conversation_readiness.get(&session.id)
                == Some(&AgentConversationReadiness::Unconfirmed)
            {
                // Observation loss is not proof that the provider conversation
                // is absent. Avoid an automatic doomed resume while preserving
                // the exact ResumeRef for explicit Retry and Fork attempts.
                session.lifecycle_state = "exited".into();
                session.resume_failure = None;
                continue;
            }
            match session.resume_ref.as_ref() {
                None => {
                    session.lifecycle_state = "resumeFailed".into();
                    session.resume_failure = Some(ResumeFailureReason::ResumeRefMissing);
                }
                Some(value) if !value.validate() => {
                    session.resume_ref = None;
                    session.lifecycle_state = "resumeFailed".into();
                    session.resume_failure = Some(ResumeFailureReason::InvalidResumeRef);
                }
                Some(value)
                    if !provider_matches_agent(
                        value.provider,
                        session.process.agent_id.as_deref(),
                    ) =>
                {
                    session.lifecycle_state = "resumeFailed".into();
                    session.resume_failure = Some(ResumeFailureReason::ProviderMismatch);
                }
                Some(_) => {
                    session.lifecycle_state = "resuming".into();
                    session.resume_failure = None;
                }
            }
        }
        changed |=
            remove_exact_session_descriptors(&mut self.state, &obsolete_assistant_session_ids);
        changed |= remove_exact_session_descriptors(&mut self.state, &retired_run_session_ids);
        // A referenced failed or unconfirmed assistant Session is still the
        // current provider conversation. Preserve its pointer for explicit
        // Retry and prevent startup schedulers from creating a fresh thread.
        // Explicit exit/delete/config replacement paths clear the pointer at
        // the command boundary that owns that lifecycle transition.
        let current_session_ids = self
            .state
            .sessions
            .iter()
            .filter(|session| {
                matches!(session.lifecycle_state.as_str(), "running" | "resuming")
                    || configured_assistant_session_ids.contains(&session.id)
                        && session.kind == SessionKind::Agent
                        && matches!(
                            session.process.template_ref.as_deref(),
                            Some(
                                "builtin.assistant.activation"
                                    | "builtin.steward.executor"
                                    | "builtin.worker.executor"
                            )
                        )
            })
            .map(|session| session.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let stale_configuration_session_ids = self
            .state
            .steward_configurations
            .iter()
            .filter_map(|configuration| configuration.executor_session_id.as_ref())
            .chain(
                self.state
                    .worker_configurations
                    .iter()
                    .filter_map(|configuration| configuration.executor_session_id.as_ref()),
            )
            .filter(|session_id| !current_session_ids.contains(session_id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        changed |= clear_executor_session_references(
            &mut self.state,
            stale_configuration_session_ids.iter().map(String::as_str),
        );
        changed |= remove_obsolete_assistant_sessions(&mut self.state);
        if changed {
            self.commit_or_restore(previous)?;
        }
        Ok(())
    }
}

pub(super) fn clear_ask_to_continuations_for_session(
    sessions: &mut [SessionRecord],
    session_id: &str,
) -> bool {
    let mut changed = false;
    for session in sessions {
        if session.id == session_id
            || session.ask_to_source_session_id.as_deref() == Some(session_id)
        {
            changed |= session.ask_to_continuation.take().is_some();
        }
    }
    changed
}

/// Removes persistent Steward/Worker executor Session descriptors that no
/// configuration references anymore. TermLoop stores current assistant state,
/// not execution history: once the executor pointer moves to a replacement or
/// the configuration is disabled or deleted, the old descriptor is debris.
/// Ordinary Agent Sessions are never touched, and a resume failure whose
/// process ownership is uncertain is kept so the daemon-owned recovery and
/// reap path stays reachable.
pub(super) fn remove_obsolete_assistant_sessions(state: &mut crate::CurrentState) -> bool {
    let referenced = state
        .steward_configurations
        .iter()
        .filter_map(|configuration| configuration.executor_session_id.clone())
        .chain(
            state
                .worker_configurations
                .iter()
                .filter_map(|configuration| configuration.executor_session_id.clone()),
        )
        .collect::<std::collections::HashSet<_>>();
    let removed_session_ids = state
        .sessions
        .iter()
        .filter(|session| {
            session.kind == SessionKind::Agent
                && matches!(
                    session.process.template_ref.as_deref(),
                    Some("builtin.steward.executor" | "builtin.worker.executor")
                )
                && session.archived_at_epoch_ms.is_none()
                && !referenced.contains(&session.id)
                && !state
                    .session_archive_operations
                    .iter()
                    .any(|operation| operation.session_id == session.id)
                && match session.lifecycle_state.as_str() {
                    "exited" | "stale" => true,
                    "resumeFailed" => !matches!(
                        session.resume_failure,
                        Some(
                            ResumeFailureReason::RuntimeOwnershipUncertain
                                | ResumeFailureReason::RuntimeConflict
                        )
                    ),
                    _ => false,
                }
        })
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    remove_exact_session_descriptors(state, &removed_session_ids)
}

pub(super) fn remove_exact_session_descriptors(
    state: &mut crate::CurrentState,
    removed_session_ids: &[String],
) -> bool {
    if removed_session_ids.is_empty() {
        return false;
    }
    let before = state.sessions.len();
    state
        .sessions
        .retain(|session| !removed_session_ids.contains(&session.id));
    if state.sessions.len() == before {
        return false;
    }
    for session_id in removed_session_ids {
        let _ = clear_ask_to_continuations_for_session(&mut state.sessions, session_id);
    }
    state
        .session_relocation_receipts
        .retain(|receipt| !removed_session_ids.contains(&receipt.session_id));
    state
        .session_relocation_operations
        .retain(|operation| !removed_session_ids.contains(&operation.session_id));
    super::agent_plan::remove_agent_plans_for_sessions(state, removed_session_ids);
    remove_agent_conversation_readiness(state, removed_session_ids.iter().map(String::as_str));
    true
}

fn remove_agent_conversation_readiness<'a>(
    state: &mut crate::CurrentState,
    session_ids: impl IntoIterator<Item = &'a str>,
) {
    let session_ids = session_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    state
        .agent_conversation_readiness
        .retain(|record| !session_ids.contains(record.session_id.as_str()));
}

pub(super) fn clear_executor_session_references<'a>(
    state: &mut crate::CurrentState,
    session_ids: impl IntoIterator<Item = &'a str>,
) -> bool {
    let session_ids = session_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let mut changed = false;
    for configuration in &mut state.steward_configurations {
        if configuration
            .executor_session_id
            .as_deref()
            .is_some_and(|session_id| session_ids.contains(session_id))
        {
            configuration.executor_session_id = None;
            changed = true;
        }
    }
    for configuration in &mut state.worker_configurations {
        if configuration
            .executor_session_id
            .as_deref()
            .is_some_and(|session_id| session_ids.contains(session_id))
        {
            configuration.executor_session_id = None;
            changed = true;
        }
    }
    changed
}
