use termloop_domain::{
    AgentConversationReadiness, AgentConversationReadinessRecord, SessionKind, SessionRecord,
    StewardAgentId, WORKERS_PER_PROJECT_MAX, WorkerConfiguration,
};

use crate::migration::provider_matches_agent;

use super::super::{CoreWriteAuthority, Store, StoreError};

/// What one Worker deletion took with it. Core needs the Routine IDs to drop
/// the runtime schedules and health those Routines left behind.
impl Store {
    pub fn worker_configurations(&self) -> &[WorkerConfiguration] {
        &self.state.worker_configurations
    }

    pub fn worker_id_for_executor_session(&self, session_id: &str) -> Option<&str> {
        self.state
            .worker_configurations
            .iter()
            .find(|configuration| configuration.executor_session_id.as_deref() == Some(session_id))
            .map(|configuration| configuration.id.as_str())
    }

    pub fn set_worker_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration: WorkerConfiguration,
        expected_revision: u64,
    ) -> Result<WorkerConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let current_index = self
            .state
            .worker_configurations
            .iter()
            .position(|current| current.id == configuration.id);
        let project_count = self
            .state
            .worker_configurations
            .iter()
            .filter(|current| current.project_id == configuration.project_id)
            .count();
        if !configuration.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == configuration.project_id)
            || (current_index.is_none() && project_count >= WORKERS_PER_PROJECT_MAX)
            || current_index.is_some_and(|index| {
                self.state.worker_configurations[index].project_id != configuration.project_id
            })
            || configuration
                .executor_session_id
                .as_ref()
                .is_some_and(|session_id| {
                    !self.state.sessions.iter().any(|session| {
                        session.id == *session_id && session.project_id == configuration.project_id
                    })
                })
        {
            return Err(StoreError::ConstraintViolation);
        }
        if current_index.map(|index| &self.state.worker_configurations[index])
            == Some(&configuration)
        {
            return Ok(configuration);
        }
        let previous = self.state.clone();
        if let Some(index) = current_index {
            self.state.worker_configurations[index] = configuration.clone();
        } else {
            self.state.worker_configurations.push(configuration.clone());
        }
        super::configuration_version::record_worker_version(
            &mut self.state,
            &configuration,
            None,
            "Configuration saved",
        );
        let _ = super::session::remove_obsolete_assistant_sessions(&mut self.state);
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    /// Deletes one Worker and everything it owns in one durable commit. The
    /// confirmation happens at the command boundary; Store then removes the
    /// Worker's Routines, every active or kept Playbook reference to them, and
    /// the affected current step verdicts without exposing a broken midpoint.
    pub fn delete_worker_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        worker_id: &str,
        expected_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<WorkerConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        let index = self
            .state
            .worker_configurations
            .iter()
            .position(|configuration| configuration.id == worker_id)
            .ok_or(StoreError::NotFound)?;
        let executor_session_id = self.state.worker_configurations[index]
            .executor_session_id
            .clone();
        let previous = self.state.clone();
        let routine_ids = self
            .state
            .tracker_configurations
            .iter()
            .filter(|tracker| tracker.worker_id == worker_id)
            .map(|tracker| tracker.id.clone())
            .collect::<std::collections::HashSet<_>>();
        if self.state.playbook_configurations.iter().any(|playbook| {
            playbook.revision == u64::MAX
                && playbook
                    .all_milestones()
                    .any(|milestone| routine_ids.contains(&milestone.routine_id))
        }) {
            return Err(StoreError::RevisionConflict);
        }
        self.state
            .tracker_configurations
            .retain(|tracker| !routine_ids.contains(&tracker.id));
        for playbook in &mut self.state.playbook_configurations {
            let before = playbook.all_milestones().count();
            playbook
                .milestones
                .retain(|milestone| !routine_ids.contains(&milestone.routine_id));
            for pipeline in &mut playbook.saved_pipelines {
                pipeline
                    .milestones
                    .retain(|milestone| !routine_ids.contains(&milestone.routine_id));
            }
            if playbook.all_milestones().count() != before {
                playbook.revision += 1;
                playbook.updated_at_epoch_ms = updated_at_epoch_ms;
            }
        }
        self.state
            .playbook_step_progress
            .retain(|progress| !routine_ids.contains(&progress.routine_id));
        if let Some(session_id) = executor_session_id
            && let Some(session) = self
                .state
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
        {
            session.lifecycle_state = "exited".into();
            session.resume_failure = None;
        }
        let configuration = self.state.worker_configurations.remove(index);
        let worker_target = termloop_domain::ImproverSessionTarget {
            target_kind: termloop_domain::ImproverSessionTargetKind::WorkerInstructions,
            target_id: Some(worker_id.to_owned()),
        };
        super::configuration_version::remove_configuration_target_state(
            &mut self.state,
            &configuration.project_id,
            &worker_target,
        );
        for routine_id in &routine_ids {
            let target = termloop_domain::ImproverSessionTarget {
                target_kind: termloop_domain::ImproverSessionTargetKind::RoutineInstructions,
                target_id: Some(routine_id.clone()),
            };
            super::configuration_version::remove_configuration_target_state(
                &mut self.state,
                &configuration.project_id,
                &target,
            );
        }
        let changed_playbooks = self
            .state
            .playbook_configurations
            .iter()
            .filter(|playbook| playbook.project_id == configuration.project_id)
            .cloned()
            .collect::<Vec<_>>();
        for playbook in &changed_playbooks {
            super::configuration_version::record_playbook_version(
                &mut self.state,
                playbook,
                None,
                "Worker deleted",
            );
        }
        let _ = super::session::remove_obsolete_assistant_sessions(&mut self.state);
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    pub fn attach_worker_executor_session(
        &mut self,
        _authority: &CoreWriteAuthority,
        session: SessionRecord,
        worker_id: &str,
        generation: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<WorkerConfiguration, StoreError> {
        if session.kind != SessionKind::Agent
            || session.lifecycle_state != "running"
            || self
                .state
                .sessions
                .iter()
                .any(|candidate| candidate.id == session.id)
        {
            return Err(StoreError::ConstraintViolation);
        }
        let configuration = self
            .state
            .worker_configurations
            .iter()
            .find(|configuration| configuration.id == worker_id)
            .cloned()
            .ok_or(StoreError::NotFound)?;
        let agent_id = match configuration.agent_id {
            StewardAgentId::Claude => "claude",
            StewardAgentId::Codex => "codex",
        };
        if !configuration.enabled
            || configuration.generation != generation
            || configuration.executor_session_id.is_some()
            || session.project_id != configuration.project_id
            || session.process.agent_id.as_deref() != Some(agent_id)
            || session.resume_ref.as_ref().is_some_and(|conversation_ref| {
                !conversation_ref.validate()
                    || !provider_matches_agent(conversation_ref.provider, Some(agent_id))
            })
        {
            return Err(StoreError::RevisionConflict);
        }
        let previous = self.state.clone();
        self.state
            .agent_conversation_readiness
            .push(AgentConversationReadinessRecord {
                session_id: session.id.clone(),
                readiness: AgentConversationReadiness::Unconfirmed,
            });
        self.state.sessions.push(session.clone());
        let configuration = self
            .state
            .worker_configurations
            .iter_mut()
            .find(|configuration| configuration.id == worker_id)
            .expect("configuration was proven above");
        configuration.executor_session_id = Some(session.id);
        configuration.updated_at_epoch_ms = updated_at_epoch_ms;
        let configuration = configuration.clone();
        let _ = super::session::remove_obsolete_assistant_sessions(&mut self.state);
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }
}
