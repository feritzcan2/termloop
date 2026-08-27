use termloop_domain::{
    AgentConversationReadiness, AgentConversationReadinessRecord, ImproverSessionTargetKind,
    ResumeRef, SessionKind, SessionRecord, StewardConfiguration,
};

use crate::migration::provider_matches_agent;

use super::super::{CoreWriteAuthority, Store, StoreError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectAssistantReset {
    pub session_ids: Vec<String>,
    pub deleted_workers: usize,
    pub deleted_routines: usize,
    pub deleted_messages: usize,
    pub playbook_deleted: bool,
}

impl Store {
    pub fn steward_configurations(&self) -> &[StewardConfiguration] {
        &self.state.steward_configurations
    }

    pub fn steward_conversation_ref(&self, project_id: &str) -> Option<&ResumeRef> {
        self.state
            .steward_conversation_refs
            .iter()
            .find(|conversation| conversation.project_id == project_id)
            .map(|conversation| &conversation.resume_ref)
    }

    pub fn clear_steward_conversation_ref(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        let before = self.state.steward_conversation_refs.len();
        self.state
            .steward_conversation_refs
            .retain(|conversation| conversation.project_id != project_id);
        if self.state.steward_conversation_refs.len() == before {
            Ok(self.state.revision)
        } else {
            self.commit_or_restore(previous)
        }
    }

    pub fn set_steward_configuration(
        &mut self,
        _authority: &CoreWriteAuthority,
        configuration: StewardConfiguration,
        expected_revision: u64,
    ) -> Result<StewardConfiguration, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !configuration.is_valid()
            || !self
                .state
                .projects
                .iter()
                .any(|project| project.id == configuration.project_id)
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
        if self
            .state
            .steward_configurations
            .iter()
            .find(|current| current.project_id == configuration.project_id)
            == Some(&configuration)
        {
            return Ok(configuration);
        }
        let previous = self.state.clone();
        let conversation_context_changed = self
            .state
            .steward_configurations
            .iter()
            .find(|current| current.project_id == configuration.project_id)
            .is_some_and(|current| {
                current.agent_id != configuration.agent_id
                    || current.system_prompt != configuration.system_prompt
            });
        if let Some(current) = self
            .state
            .steward_configurations
            .iter_mut()
            .find(|current| current.project_id == configuration.project_id)
        {
            *current = configuration.clone();
        } else {
            self.state
                .steward_configurations
                .push(configuration.clone());
        }
        super::configuration_version::record_steward_version(
            &mut self.state,
            &configuration,
            None,
            "Configuration saved",
        );
        if conversation_context_changed {
            self.state
                .steward_conversation_refs
                .retain(|conversation| conversation.project_id != configuration.project_id);
        }
        let _ = super::session::remove_obsolete_assistant_sessions(&mut self.state);
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    /// Deletes the Project Assistant as one current-state replacement. The
    /// Steward, Workers, Routines, Playbook, transcript, Task pipeline state,
    /// Steward-authored Task briefs, and assistant-owned Sessions disappear in
    /// the same commit, so no projection can observe a partially reset tree.
    pub fn reset_project_assistant(
        &mut self,
        _authority: &CoreWriteAuthority,
        project_id: &str,
        expected_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<ProjectAssistantReset, StoreError> {
        if expected_revision != self.state.revision {
            return Err(StoreError::RevisionConflict);
        }
        if !self
            .state
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(StoreError::NotFound);
        }
        if !self
            .state
            .steward_configurations
            .iter()
            .any(|configuration| configuration.project_id == project_id)
        {
            return Err(StoreError::NotFound);
        }

        let previous = self.state.clone();
        let mut next = previous.clone();
        let configured_session_ids = next
            .steward_configurations
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .filter_map(|configuration| configuration.executor_session_id.clone())
            .chain(
                next.worker_configurations
                    .iter()
                    .filter(|configuration| configuration.project_id == project_id)
                    .filter_map(|configuration| configuration.executor_session_id.clone()),
            )
            .collect::<std::collections::HashSet<_>>();
        let session_ids = next
            .sessions
            .iter()
            .filter(|session| {
                session.project_id == project_id
                    && (configured_session_ids.contains(&session.id)
                        || session_is_project_assistant(session))
            })
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let task_ids = next
            .tasks
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let deleted_workers = next
            .worker_configurations
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .count();
        let deleted_routines = next
            .tracker_configurations
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .count();
        let deleted_messages = next
            .companion_messages
            .iter()
            .filter(|message| message.project_id == project_id)
            .count();
        let playbook_deleted = next
            .playbook_configurations
            .iter()
            .any(|configuration| configuration.project_id == project_id);

        next.steward_configurations
            .retain(|configuration| configuration.project_id != project_id);
        next.steward_conversation_refs
            .retain(|conversation| conversation.project_id != project_id);
        next.worker_configurations
            .retain(|configuration| configuration.project_id != project_id);
        next.tracker_configurations
            .retain(|configuration| configuration.project_id != project_id);
        next.playbook_configurations
            .retain(|configuration| configuration.project_id != project_id);
        next.playbook_step_progress
            .retain(|progress| !task_ids.contains(&progress.task_id));
        next.companion_messages
            .retain(|message| message.project_id != project_id);
        for task in next
            .tasks
            .iter_mut()
            .filter(|task| task.project_id == project_id && !task.steward_brief_markdown.is_empty())
        {
            task.steward_brief_revision = task
                .steward_brief_revision
                .checked_add(1)
                .ok_or(StoreError::ConstraintViolation)?;
            task.steward_brief_markdown.clear();
            task.updated_at_epoch_ms = updated_at_epoch_ms.max(
                task.updated_at_epoch_ms
                    .checked_add(1)
                    .ok_or(StoreError::ConstraintViolation)?,
            );
        }
        next.configuration_versions.retain(|version| {
            version.project_id != project_id
                || matches!(
                    version.target.target_kind,
                    ImproverSessionTargetKind::RunConfiguration
                        | ImproverSessionTargetKind::NewRunConfiguration
                        | ImproverSessionTargetKind::SettingsSkill
                        | ImproverSessionTargetKind::SettingsPrompt
                        | ImproverSessionTargetKind::SettingsMcpTool
                )
        });
        next.configuration_version_selections.retain(|selection| {
            next.configuration_versions.iter().any(|version| {
                version.id == selection.version_id
                    && version.project_id == selection.project_id
                    && version.target == selection.target
            })
        });
        next.task_archive_suspensions
            .retain(|suspension| !session_ids.contains(&suspension.session_id));
        next.session_archive_operations
            .retain(|operation| !session_ids.contains(&operation.session_id));
        super::session::remove_exact_session_descriptors(&mut next, &session_ids);

        crate::validation::validate_current_state(&next)
            .map_err(|_| StoreError::ConstraintViolation)?;
        self.state = next;
        self.commit_or_restore(previous)?;
        Ok(ProjectAssistantReset {
            session_ids,
            deleted_workers,
            deleted_routines,
            deleted_messages,
            playbook_deleted,
        })
    }

    pub fn attach_steward_executor_session(
        &mut self,
        _authority: &CoreWriteAuthority,
        session: SessionRecord,
        project_id: &str,
        generation: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<StewardConfiguration, StoreError> {
        if session.project_id != project_id
            || session.kind != SessionKind::Agent
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
            .steward_configurations
            .iter()
            .find(|configuration| configuration.project_id == project_id)
            .cloned()
            .ok_or(StoreError::NotFound)?;
        if !configuration.enabled
            || configuration.generation != generation
            || configuration.executor_session_id.is_some()
            || session.process.agent_id.as_deref()
                != Some(match configuration.agent_id {
                    termloop_domain::StewardAgentId::Claude => "claude",
                    termloop_domain::StewardAgentId::Codex => "codex",
                })
            || session.resume_ref.as_ref().is_some_and(|conversation_ref| {
                !conversation_ref.validate()
                    || !provider_matches_agent(
                        conversation_ref.provider,
                        session.process.agent_id.as_deref(),
                    )
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
        self.state
            .steward_conversation_refs
            .retain(|conversation| conversation.project_id != project_id);
        let configuration = self
            .state
            .steward_configurations
            .iter_mut()
            .find(|configuration| configuration.project_id == project_id)
            .expect("configuration was proven above");
        configuration.executor_session_id = Some(session.id);
        configuration.updated_at_epoch_ms = updated_at_epoch_ms;
        let configuration = configuration.clone();
        let _ = super::session::remove_obsolete_assistant_sessions(&mut self.state);
        self.commit_or_restore(previous)?;
        Ok(configuration)
    }

    pub fn steward_project_for_executor_session(&self, session_id: &str) -> Option<&str> {
        self.state
            .steward_configurations
            .iter()
            .find(|configuration| configuration.executor_session_id.as_deref() == Some(session_id))
            .map(|configuration| configuration.project_id.as_str())
    }
}

fn session_is_project_assistant(session: &SessionRecord) -> bool {
    matches!(
        session.process.template_ref.as_deref(),
        Some(
            "builtin.assistant.activation"
                | "builtin.steward.executor"
                | "builtin.worker.executor"
                | "builtin.improver.steward-instructions"
                | "builtin.improver.worker-instructions"
                | "builtin.improver.routine-instructions"
                | "builtin.builder.routine"
                | "builtin.builder.playbook"
        )
    ) || session.improver_target.as_ref().is_some_and(|target| {
        matches!(
            target.target_kind,
            ImproverSessionTargetKind::StewardInstructions
                | ImproverSessionTargetKind::WorkerInstructions
                | ImproverSessionTargetKind::RoutineInstructions
                | ImproverSessionTargetKind::RoutineBuilder
                | ImproverSessionTargetKind::Playbook
        )
    })
}
