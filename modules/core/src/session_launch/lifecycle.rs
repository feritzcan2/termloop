use super::CodexRuntime;
use crate::{CoreError, CoreRuntime, required_string, store_error, terminal_error};
use serde_json::{Value, json};
use termloop_domain::{ResumeFailureReason, ResumeProvider, SessionKind, SessionRecord};

pub struct ReconciledSessionExits {
    pub state_revision: Option<u64>,
    pub exited_session_ids: Vec<String>,
    pub retired_runtimes: Vec<CodexRuntime>,
    pub changed_cwds: Vec<String>,
}

impl CoreRuntime {
    /// Stops and forgets the in-memory half of a persistent assistant Session
    /// whose owning configuration is about to be deleted atomically. Durable
    /// descriptor cleanup remains part of the owner-delete Store commit.
    pub(crate) fn retire_owned_assistant_runtime(
        &mut self,
        session_id: &str,
    ) -> Result<(), CoreError> {
        if self
            .terminal
            .contains_session(session_id)
            .map_err(terminal_error)?
        {
            self.terminal
                .terminate(session_id)
                .map_err(terminal_error)?;
        }
        self.agent_terminal_holds.remove(session_id);
        self.agent_observations.remove(session_id);
        self.forget_ask_to_session(session_id);
        self.retire_fork_relationship(session_id);
        self.agent_conversation_activity.remove(session_id);
        self.resume_ready.remove(session_id);
        self.resume_failure_reaps.remove(session_id);
        self.pending_agent_resume_refs.remove(session_id);
        self.codex_runtimes.remove(session_id);
        Ok(())
    }

    pub fn terminate_session(
        &mut self,
        params: Value,
    ) -> Result<(Value, Option<CodexRuntime>), CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        if self
            .provider_history_repair_reservations
            .contains(&session_id)
        {
            return Err(CoreError::ProviderHistoryRepairUnavailable {
                session_id,
                reason: crate::ProviderHistoryRepairUnavailableReason::RuntimeConflict,
            });
        }
        self.ensure_session_not_individually_archived(&session_id)?;
        if self.session_is_archive_suspended(&session_id) {
            return Err(CoreError::SessionSuspendedByTaskArchive { session_id });
        }
        let preparing_resume = self.resume_reservations.remove(&session_id);
        let has_terminal = self
            .terminal
            .contains_session(&session_id)
            .map_err(terminal_error)?;
        if has_terminal {
            self.terminal
                .terminate(&session_id)
                .map_err(terminal_error)?;
        } else if !preparing_resume {
            return Err(CoreError::NotFound);
        }
        self.agent_terminal_holds.remove(&session_id);
        self.store
            .mark_session_exited(&self.write_authority, &session_id)
            .map_err(store_error)?;
        self.agent_observations.remove(&session_id);
        // Termination retires only the current process. The Session descriptor
        // remains resumable, so keep its Ask-To routing and continuation until
        // an explicit close permanently removes the endpoint.
        self.suspend_ask_to_session_for_resume(&session_id);
        self.retire_fork_relationship(&session_id);
        self.agent_conversation_activity.remove(&session_id);
        self.resume_ready.remove(&session_id);
        self.resume_failure_reaps.remove(&session_id);
        self.pending_agent_resume_refs.remove(&session_id);
        let runtime = self.codex_runtimes.remove(&session_id);
        Ok((
            json!({ "sessionId": session_id, "lifecycleState": "exited" }),
            runtime,
        ))
    }
    pub fn close_session(&mut self, params: Value) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        if self
            .provider_history_repair_reservations
            .contains(&session_id)
        {
            return Err(CoreError::ProviderHistoryRepairUnavailable {
                session_id,
                reason: crate::ProviderHistoryRepairUnavailableReason::RuntimeConflict,
            });
        }
        self.ensure_session_not_individually_archived(&session_id)?;
        if self.session_is_archive_suspended(&session_id) {
            return Err(CoreError::SessionSuspendedByTaskArchive { session_id });
        }
        self.release_agent_terminal_hold(&session_id)?;
        if self.resume_reservations.contains(&session_id)
            || self
                .terminal
                .contains_session(&session_id)
                .map_err(terminal_error)?
            || self.codex_runtimes.contains_key(&session_id)
        {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        let session_kind = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| session.kind.clone())
            .ok_or(CoreError::NotFound)?;
        if session_kind == SessionKind::Agent {
            self.store
                .move_agent_session_to_deleted(
                    &self.write_authority,
                    &session_id,
                    termloop_platform::current_epoch_ms(),
                )
                .map_err(store_error)?;
        } else {
            self.store
                .delete_session_descriptor(&self.write_authority, &session_id)
                .map_err(store_error)?;
        }
        self.agent_observations.remove(&session_id);
        self.forget_ask_to_session(&session_id);
        self.retire_fork_relationship(&session_id);
        self.agent_conversation_activity.remove(&session_id);
        self.resume_failure_reaps.remove(&session_id);
        self.pending_agent_resume_refs.remove(&session_id);
        self.codex_runtimes.remove(&session_id);
        Ok(json!({ "sessionId": session_id, "closed": true }))
    }

    pub fn detach_agent_runtime_for_ownership_recovery(
        &mut self,
        session_id: &str,
    ) -> Option<crate::CodexRuntime> {
        self.agent_observations.remove(session_id);
        self.suspend_ask_to_session_for_resume(session_id);
        self.codex_runtimes.remove(session_id)
    }

    /// Reserves an explicit close intent while the server proves that a
    /// retryable ownership failure has no remaining managed process. The
    /// existing resume reservation is also the exclusion gate for Retry, so a
    /// concurrent resume cannot recreate the runtime while close is reaping it.
    pub fn reserve_retryable_session_termination(
        &mut self,
        session_id: &str,
    ) -> Result<Option<crate::CodexRuntime>, CoreError> {
        self.ensure_session_not_individually_archived(session_id)?;
        if self.session_is_archive_suspended(session_id) {
            return Err(CoreError::SessionSuspendedByTaskArchive {
                session_id: session_id.to_owned(),
            });
        }
        let eligible = self.store.sessions().iter().any(|session| {
            session.id == session_id
                && session.kind == SessionKind::Agent
                && session.lifecycle_state == "resumeFailed"
                && matches!(
                    session.resume_failure,
                    Some(
                        ResumeFailureReason::RuntimeOwnershipUncertain
                            | ResumeFailureReason::RuntimeConflict
                    )
                )
        });
        if !eligible || !self.resume_reservations.insert(session_id.to_owned()) {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        self.resume_ready.remove(session_id);
        Ok(self.detach_agent_runtime_for_ownership_recovery(session_id))
    }

    pub fn cancel_retryable_session_termination(&mut self, session_id: &str) {
        self.resume_reservations.remove(session_id);
        self.resume_ready.remove(session_id);
    }

    pub fn session_cwd(&self, session_id: &str) -> Option<String> {
        self.store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| session.process.cwd.clone())
    }

    pub fn session_resume_failure(&self, session_id: &str) -> Option<ResumeFailureReason> {
        self.store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .and_then(|session| session.resume_failure)
    }

    pub fn agent_fork_readiness(
        &self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<bool, crate::AgentForkUnavailableReason> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .ok_or(crate::AgentForkUnavailableReason::RuntimeConflict)?;
        if session.runtime_epoch != runtime_epoch || session.kind != SessionKind::Agent {
            return Err(crate::AgentForkUnavailableReason::RuntimeConflict);
        }
        match session.lifecycle_state.as_str() {
            "running" => Ok(session
                .resume_ref
                .as_ref()
                .is_some_and(|value| value.validate())),
            "exited" => Err(crate::AgentForkUnavailableReason::StartupExited),
            _ => Err(crate::AgentForkUnavailableReason::RuntimeConflict),
        }
    }

    pub fn confirm_agent_fork_conversation(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<(), CoreError> {
        let valid = self.store.sessions().iter().any(|session| {
            session.id == session_id
                && session.runtime_epoch == runtime_epoch
                && session.kind == SessionKind::Agent
                && session.lifecycle_state == "running"
                && session
                    .resume_ref
                    .as_ref()
                    .is_some_and(|value| value.validate())
        });
        if !valid {
            return Err(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::ConversationUnconfirmed,
            });
        }
        self.store
            .mark_agent_conversation_resumable(&self.write_authority, session_id)
            .map_err(store_error)?;
        self.agent_conversation_activity
            .insert(session_id.to_owned());
        self.pending_agent_forks.remove(session_id);
        Ok(())
    }

    pub fn retire_failed_agent_fork(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<Option<CodexRuntime>, CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id && session.runtime_epoch == runtime_epoch)
            .ok_or(CoreError::NotFound)?;
        if session.kind != SessionKind::Agent
            || !matches!(session.lifecycle_state.as_str(), "running" | "exited")
        {
            return Err(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::RuntimeConflict,
            });
        }
        if session.lifecycle_state == "running" {
            self.store
                .mark_session_exited(&self.write_authority, session_id)
                .map_err(store_error)?;
        }
        self.agent_observations.remove(session_id);
        self.suspend_ask_to_session_for_resume(session_id);
        self.retire_fork_relationship(session_id);
        self.agent_conversation_activity.remove(session_id);
        self.resume_ready.remove(session_id);
        self.pending_agent_forks.remove(session_id);
        self.agent_terminal_holds.remove(session_id);
        Ok(self.codex_runtimes.remove(session_id))
    }

    pub fn retain_failed_agent_fork(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<Option<CodexRuntime>, CoreError> {
        let runtime = self.retire_failed_agent_fork(session_id, runtime_epoch)?;
        self.spawn_agent_terminal_hold(session_id)?;
        Ok(runtime)
    }

    pub fn delete_failed_agent_fork_descriptor(
        &mut self,
        session_id: &str,
        runtime_epoch: u64,
    ) -> Result<(), CoreError> {
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id && session.runtime_epoch == runtime_epoch)
            .ok_or(CoreError::NotFound)?;
        if session.kind != SessionKind::Agent
            || session.lifecycle_state != "exited"
            || self
                .terminal
                .contains_session(session_id)
                .map_err(terminal_error)?
            || self.codex_runtimes.contains_key(session_id)
        {
            return Err(CoreError::AgentForkUnavailable {
                reason: crate::AgentForkUnavailableReason::RuntimeConflict,
            });
        }
        self.store
            .delete_session_descriptor(&self.write_authority, session_id)
            .map_err(store_error)?;
        self.forget_ask_to_session(session_id);
        self.retire_fork_relationship(session_id);
        Ok(())
    }

    fn retire_fork_relationship(&mut self, session_id: &str) {
        self.fork_source_session_ids.remove(session_id);
        self.fork_source_session_ids
            .retain(|_, source_id| source_id != session_id);
    }

    pub(crate) fn rename_session(&mut self, params: Value) -> Result<Value, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        self.ensure_session_not_individually_archived(&session_id)?;
        let name = match params.get("name") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => {
                let trimmed = value.trim();
                if trimmed.chars().count() > 80 {
                    return Err(CoreError::InvalidParams("name".into()));
                }
                (!trimmed.is_empty()).then(|| trimmed.to_owned())
            }
            _ => return Err(CoreError::InvalidParams("name".into())),
        };
        let session = self
            .store
            .rename_session(&self.write_authority, &session_id, name)
            .map_err(store_error)?;
        Ok(self.project_session(&session))
    }

    pub(crate) fn list_sessions(&self) -> Result<Value, CoreError> {
        Ok(Value::Array(
            self.store
                .sessions()
                .iter()
                .filter(|session| {
                    session.archived_at_epoch_ms.is_none()
                        && !self.session_is_archive_suspended(&session.id)
                        && !self.pending_agent_forks.contains(&session.id)
                })
                .map(|session| self.project_session(session))
                .collect(),
        ))
    }

    pub fn reconcile_exited_sessions(&mut self) -> Result<ReconciledSessionExits, CoreError> {
        let previous_revision = self.store.revision();
        let mut runtimes = Vec::new();
        let mut exited_session_ids = Vec::new();
        let mut changed_cwds = Vec::new();
        for exited_terminal in self.terminal.reap_exited().map_err(terminal_error)? {
            let session_id = exited_terminal.session_id;
            if self.resume_failure_reaps.contains(&session_id) {
                // The server is deliberately reaping this uncommitted resume
                // outside the Core lock. Its exact failure finalizer still owns
                // the reservation and durable lifecycle transition.
                continue;
            }
            self.record_run_exit(&session_id, exited_terminal.exit_code);
            if self.agent_terminal_holds.remove(&session_id) {
                // A continuation shell should be as durable as the opened
                // terminal surface. If the shell itself exits, replace it;
                // only an explicit terminate/close removes the hold first.
                self.spawn_agent_terminal_hold(&session_id)?;
                continue;
            }
            exited_session_ids.push(session_id.clone());
            if let Some(cwd) = self.session_cwd(&session_id) {
                changed_cwds.push(cwd);
            }
            let was_resuming = self.resume_reservations.remove(&session_id);
            let already_resume_failed = self.store.sessions().iter().any(|session| {
                session.id == session_id && session.lifecycle_state == "resumeFailed"
            });
            if was_resuming {
                self.resume_ready.remove(&session_id);
                self.store
                    .mark_session_resume_failed(
                        &self.write_authority,
                        &session_id,
                        ResumeFailureReason::ResumeRejected,
                    )
                    .map_err(store_error)?;
            } else if !already_resume_failed {
                // A failed resume can reap its PTY before a queued lifecycle
                // notification is reconciled. Keep the actionable failure and
                // its reason instead of letting that late exit flatten the
                // Session to a generic `exited` state.
                self.store
                    .mark_session_exited(&self.write_authority, &session_id)
                    .map_err(store_error)?;
            }
            self.agent_observations.remove(&session_id);
            self.pending_agent_resume_refs.remove(&session_id);
            // A provider process can exit and later resume as the same logical
            // Session. Revoke its live bearer without destroying Ask-To state;
            // explicit descriptor close remains the permanent retirement gate.
            self.suspend_ask_to_session_for_resume(&session_id);
            if !was_resuming {
                self.agent_conversation_activity.remove(&session_id);
            }
            if let Some(runtime) = self.codex_runtimes.remove(&session_id) {
                runtimes.push(runtime);
            }
            self.spawn_agent_terminal_hold(&session_id)?;
        }
        let revision = self.store.revision();
        Ok(ReconciledSessionExits {
            state_revision: (revision != previous_revision).then_some(revision),
            exited_session_ids,
            retired_runtimes: runtimes,
            changed_cwds,
        })
    }

    pub(crate) fn spawn_agent_terminal_hold(&mut self, session_id: &str) -> Result<(), CoreError> {
        if self.agent_terminal_holds.contains(session_id) {
            return Ok(());
        }
        // Archive retirement deliberately creates a short window where the
        // durable Session is not archived yet but its Agent/PTY is exiting.
        // The exit reconciler must not mistake that transition for an ordinary
        // stopped Agent and recreate the continuation shell underneath the
        // archive finalizer.
        if self
            .store
            .session_archive_operations()
            .iter()
            .any(|operation| operation.session_id == session_id)
            || self
                .store
                .task_archive_operations()
                .iter()
                .any(|operation| {
                    operation
                        .targets
                        .iter()
                        .any(|target| target.session_id == session_id)
                })
        {
            return Ok(());
        }
        // A failed persistent-assistant resume must remain a stopped provider
        // conversation, not turn into an ordinary shell under the same
        // Session id. The exact configuration binding is retained so Retry can
        // re-derive the Steward MCP role and resume that conversation.
        if self.session_is_persistent_assistant_executor(session_id) {
            return Ok(());
        }
        if self
            .terminal
            .contains_session(session_id)
            .map_err(terminal_error)?
        {
            self.agent_terminal_holds.insert(session_id.to_owned());
            return Ok(());
        }
        let session = self
            .store
            .sessions()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        if session.kind != SessionKind::Agent
            || session.archived_at_epoch_ms.is_some()
            || self.session_is_archive_suspended(session_id)
            || !matches!(session.lifecycle_state.as_str(), "exited" | "resumeFailed")
            || matches!(
                session.resume_failure,
                Some(
                    ResumeFailureReason::RuntimeOwnershipUncertain
                        | ResumeFailureReason::RuntimeConflict
                )
            )
        {
            return Ok(());
        }
        if termloop_platform::existing_directory_comparison_input(std::path::Path::new(
            &session.process.cwd,
        ))
        .is_err()
        {
            return Ok(());
        }
        let (program, args) = termloop_platform::default_shell();
        self.terminal
            .spawn(termloop_terminal::PtySpawnSpec {
                session_id: session.id.clone(),
                runtime_epoch: session.runtime_epoch,
                program,
                args,
                cwd: session.process.cwd,
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: true,
            })
            .map_err(terminal_error)?;
        self.agent_terminal_holds.insert(session.id);
        Ok(())
    }

    /// Recreates runtime-only continuation shells after daemon restart for
    /// every visible stopped Agent the user has not explicitly closed.
    /// Individual PTY failures stay isolated so one stale descriptor cannot
    /// prevent the daemon from starting.
    pub fn restore_agent_terminal_holds(&mut self) -> usize {
        let candidates = self
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.kind == SessionKind::Agent
                    && session.archived_at_epoch_ms.is_none()
                    && matches!(session.lifecycle_state.as_str(), "exited" | "resumeFailed")
            })
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let mut restored = 0;
        for session_id in candidates {
            if self.spawn_agent_terminal_hold(&session_id).is_ok()
                && self.agent_terminal_holds.contains(&session_id)
            {
                restored += 1;
            }
        }
        restored
    }

    pub(crate) fn release_agent_terminal_hold_for_resume(
        &mut self,
        session_id: &str,
    ) -> Result<(), CoreError> {
        self.release_agent_terminal_hold(session_id)
    }

    /// The hold set is a runtime-only hint and can briefly outlive its PTY when
    /// an exited-shell reap races a replacement or shutdown. Explicit close or
    /// resume intent treats an already-absent PTY as a completed release and
    /// heals the stale hint; every other terminal failure remains fail-closed.
    pub(crate) fn release_agent_terminal_hold(
        &mut self,
        session_id: &str,
    ) -> Result<(), CoreError> {
        if !self.agent_terminal_holds.contains(session_id) {
            return Ok(());
        }
        match self.terminal.terminate(session_id) {
            Ok(()) | Err(termloop_terminal::TerminalError::SessionNotFound) => {}
            Err(error) => return Err(terminal_error(error)),
        }
        self.agent_terminal_holds.remove(session_id);
        Ok(())
    }
}

impl CoreRuntime {
    pub(crate) fn project_session(&self, session: &SessionRecord) -> Value {
        // Fork is an Agent action, not a precomputed provider-capability gate.
        // The command attempts the provider operation and reports any concrete
        // runtime failure instead of disabling the user's intent in advance.
        let forkable = session.kind == SessionKind::Agent;
        let ask_to_source_session_id =
            session
                .ask_to_source_session_id
                .as_deref()
                .filter(|source_id| {
                    let source_id = *source_id;
                    source_id != session.id
                        && session.kind == SessionKind::Agent
                        && session.process.template_ref.as_deref()
                            == Some("builtin.agent.ask-to-helper")
                        && self.store.sessions().iter().any(|source| {
                            source.id == source_id
                                && source.project_id == session.project_id
                                && source.kind == SessionKind::Agent
                        })
                });
        let fork_source_session_id = self
            .fork_source_session_ids
            .get(&session.id)
            .map(String::as_str)
            .filter(|source_id| {
                *source_id != session.id
                    && session.kind == SessionKind::Agent
                    && self.store.sessions().iter().any(|source| {
                        source.id == *source_id
                            && source.project_id == session.project_id
                            && source.kind == SessionKind::Agent
                    })
            });
        let mut projection = session_projection(
            session,
            forkable,
            ask_to_source_session_id,
            fork_source_session_id,
        );
        // Durable relocation state keeps the source cwd until the replacement
        // process is proven ready, so a failed move can roll back without
        // reconstructing ownership. During that bounded attempt, project the
        // active operation's target cwd so clients place the resuming Agent in
        // its destination. Removing the operation on failure automatically
        // projects the unchanged source cwd again.
        if session.lifecycle_state == "resuming"
            && let Some(relocation) = self
                .store
                .session_relocation_operations()
                .iter()
                .find(|operation| operation.session_id == session.id)
        {
            projection["process"]["cwd"] = json!(relocation.target_cwd);
        }
        // A resume PTY is created with a fresh runtime generation before the
        // durable Session can commit that epoch. Project the reservation's
        // exact provisional epoch while it is resuming so clients can attach
        // to the real provider terminal and answer any startup prompt instead
        // of waiting behind an invisible TUI.
        if session.lifecycle_state == "resuming"
            && self.resume_reservations.contains(&session.id)
            && let Some(capability) = self.agent_observations.get(&session.id)
        {
            projection["runtime_epoch"] = json!(capability.runtime_epoch);
        }
        projection
    }
}

pub(super) fn session_projection(
    session: &SessionRecord,
    forkable: bool,
    ask_to_source_session_id: Option<&str>,
    fork_source_session_id: Option<&str>,
) -> Value {
    // `retryable` is the public user-action capability, not merely a report that
    // an automatic resume failed. A normal process exit preserves the exact
    // provider conversation reference, so explicit user intent can reopen it
    // through the same inspected resume path.
    let retryable = manual_agent_resume_available(session);
    let closable = matches!(
        session.lifecycle_state.as_str(),
        "exited" | "stale" | "resumeFailed"
    ) && !matches!(
        session.resume_failure,
        Some(ResumeFailureReason::RuntimeOwnershipUncertain | ResumeFailureReason::RuntimeConflict)
    );
    json!({
        "id": session.id,
        "project_id": session.project_id,
        "name": session.name,
        "kind": session.kind,
        "process": {
            "program": session.process.program,
            "args": if session.kind == SessionKind::Agent {
                Vec::<String>::new()
            } else {
                session.process.args.clone()
            },
            "cwd": session.process.cwd,
            "agent_id": session.process.agent_id,
            "template_ref": session.process.template_ref,
            "template_version": session.process.template_version,
        },
        "lifecycle_state": session.lifecycle_state,
        "runtime_epoch": session.runtime_epoch,
        "archived_at_epoch_ms": session.archived_at_epoch_ms,
        "resume_failure_reason": session.resume_failure,
        "retryable": retryable,
        "closable": closable,
        "forkable": forkable,
        "ask_to_source_session_id": ask_to_source_session_id,
        "fork_source_session_id": fork_source_session_id,
        "improver_target": session.improver_target.as_ref().map(|target| json!({
            "targetKind": match target.target_kind {
                termloop_domain::ImproverSessionTargetKind::StewardInstructions => "stewardInstructions",
                termloop_domain::ImproverSessionTargetKind::RoutineInstructions => "routineInstructions",
                termloop_domain::ImproverSessionTargetKind::RoutineBuilder => "routineBuilder",
                termloop_domain::ImproverSessionTargetKind::Playbook => "playbook",
                termloop_domain::ImproverSessionTargetKind::RunConfiguration => "runConfiguration",
                termloop_domain::ImproverSessionTargetKind::NewRunConfiguration => "newRunConfiguration",
                termloop_domain::ImproverSessionTargetKind::SettingsSkill => "settingsSkill",
                termloop_domain::ImproverSessionTargetKind::SettingsPrompt => "settingsPrompt",
                termloop_domain::ImproverSessionTargetKind::SettingsMcpTool => "settingsMcpTool",
            },
            "targetId": target.target_id,
        })),
        "run_configuration_id": session.run_configuration_id,
    })
}

pub(super) fn manual_agent_resume_available(session: &SessionRecord) -> bool {
    if session.kind != SessionKind::Agent
        || !matches!(session.lifecycle_state.as_str(), "exited" | "resumeFailed")
        || session.resume_failure == Some(ResumeFailureReason::ProviderHistoryDamaged)
    {
        return false;
    }
    let Some(resume_ref) = session.resume_ref.as_ref().filter(|value| value.validate()) else {
        return false;
    };
    matches!(
        (resume_ref.provider, session.process.agent_id.as_deref()),
        (ResumeProvider::Claude, Some("claude"))
            | (ResumeProvider::Codex, Some("codex"))
            | (ResumeProvider::Gemini, Some("gemini"))
    )
}

pub(super) fn resume_failure_retryable(failure: ResumeFailureReason) -> bool {
    failure.is_retryable()
}
