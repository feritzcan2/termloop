use termloop_domain::{
    AgentConversationReadiness, AgentConversationReadinessRecord, PersonalAgent,
    SavedAgentLaunchSelection, SessionAgentProfile, SessionKind, SessionRecord, WorkflowExecution,
};

use crate::{CurrentState, Store, StoreError};

/// Closed intents used only by the named Store writes. Core still chooses
/// whether an ordinary launch replaces the saved preference.
pub(super) enum FreshSessionAdmission<'a> {
    Standalone {
        remember_launch: bool,
    },
    PersonalAgent {
        agent: &'a PersonalAgent,
        remember_launch: bool,
    },
    Workflow {
        execution: &'a WorkflowExecution,
    },
    Steward {
        project_id: &'a str,
        generation: u64,
        updated_at_epoch_ms: u64,
    },
}

impl Store {
    /// Admit one fresh Session and all of its current sidecars with one
    /// snapshot/commit/rollback boundary. Restore and migration retain their
    /// existing readiness instead of using this fresh-conversation seed.
    pub(super) fn admit_fresh_session(
        &mut self,
        session: SessionRecord,
        admission: FreshSessionAdmission<'_>,
    ) -> Result<u64, StoreError> {
        let preference = match &admission {
            FreshSessionAdmission::Standalone { remember_launch } => {
                standalone_preference(&self.state, &session, *remember_launch)?
            }
            FreshSessionAdmission::PersonalAgent {
                agent,
                remember_launch,
            } => {
                super::agent_library::validate_personal_agent_session(
                    &self.state,
                    &session,
                    agent,
                )?;
                standalone_preference(&self.state, &session, *remember_launch)?
            }
            FreshSessionAdmission::Workflow { execution } => {
                Some(super::workflow::validate_workflow_coordinator_session(
                    &self.state,
                    &session,
                    execution,
                )?)
            }
            FreshSessionAdmission::Steward {
                project_id,
                generation,
                ..
            } => {
                super::steward::validate_steward_executor_session(
                    &self.state,
                    &session,
                    project_id,
                    *generation,
                )?;
                None
            }
        };

        let previous = self.state.clone();
        let session_id = session.id.clone();
        if session.kind == SessionKind::Agent {
            self.state
                .agent_conversation_readiness
                .push(AgentConversationReadinessRecord {
                    session_id: session_id.clone(),
                    readiness: AgentConversationReadiness::Unconfirmed,
                });
        }
        self.state.sessions.push(session);
        if let Some(preference) = preference {
            self.state.last_agent_launch_selection = Some(preference);
        }
        match admission {
            FreshSessionAdmission::Standalone { .. } => {}
            FreshSessionAdmission::PersonalAgent { agent, .. } => {
                self.state.session_agent_profiles.push(SessionAgentProfile {
                    session_id,
                    agent: agent.clone(),
                });
            }
            FreshSessionAdmission::Workflow { execution } => {
                super::workflow::apply_workflow_coordinator_execution(&mut self.state, execution);
            }
            FreshSessionAdmission::Steward {
                project_id,
                updated_at_epoch_ms,
                ..
            } => {
                super::steward::apply_steward_executor_session(
                    &mut self.state,
                    session_id,
                    project_id,
                    updated_at_epoch_ms,
                );
            }
        }
        self.commit_or_restore(previous)
    }
}

fn standalone_preference(
    state: &CurrentState,
    session: &SessionRecord,
    remember_launch: bool,
) -> Result<Option<SavedAgentLaunchSelection>, StoreError> {
    if state.sessions.iter().any(|value| value.id == session.id) {
        return Err(StoreError::AlreadyExists);
    }
    if !remember_launch {
        return Ok(None);
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
    Ok(Some(preference))
}
