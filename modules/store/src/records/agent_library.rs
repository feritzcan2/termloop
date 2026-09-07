use termloop_domain::{AgentLibrary, PersonalAgent, SessionAgentProfile, SessionRecord};

use crate::{CoreWriteAuthority, CurrentState, Store, StoreError};

impl Store {
    pub fn agent_library(&self) -> &AgentLibrary {
        &self.state.agent_library
    }

    pub fn session_agent_profile(&self, session_id: &str) -> Option<&PersonalAgent> {
        self.state
            .session_agent_profiles
            .iter()
            .find(|entry| entry.session_id == session_id)
            .map(|entry| &entry.agent)
    }

    pub fn update_personal_agent(
        &mut self,
        _authority: &CoreWriteAuthority,
        agent: PersonalAgent,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        self.change_agent_library(expected_revision, |library| {
            if let Some(current) = library.agents.iter_mut().find(|entry| entry.id == agent.id) {
                if agent.version
                    != current
                        .version
                        .checked_add(1)
                        .ok_or(StoreError::ConstraintViolation)?
                {
                    return Err(StoreError::RevisionConflict);
                }
                *current = agent;
            } else {
                if termloop_domain::valid_personal_agent_id(&agent.id) && agent.version != 1 {
                    return Err(StoreError::NotFound);
                }
                library.agents.push(agent);
            }
            Ok(())
        })
    }

    pub fn delete_personal_agent(
        &mut self,
        _authority: &CoreWriteAuthority,
        id: &str,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        self.change_agent_library(expected_revision, |library| {
            let index = library
                .agents
                .iter()
                .position(|entry| entry.id == id)
                .ok_or(StoreError::NotFound)?;
            library.agents.remove(index);
            library.favorites.retain(|favorite| favorite != id);
            Ok(())
        })
    }

    pub fn favorite_agent_profile(
        &mut self,
        _authority: &CoreWriteAuthority,
        id: &str,
        favorite: bool,
        expected_revision: u64,
    ) -> Result<u64, StoreError> {
        self.change_agent_library(expected_revision, |library| {
            library.favorites.retain(|value| value != id);
            if favorite {
                library.favorites.push(id.to_owned());
            }
            Ok(())
        })
    }

    fn change_agent_library(
        &mut self,
        expected_revision: u64,
        change: impl FnOnce(&mut AgentLibrary) -> Result<(), StoreError>,
    ) -> Result<u64, StoreError> {
        if self.state.agent_library.revision != expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        let mut library = self.state.agent_library.clone();
        change(&mut library)?;
        if !library.is_valid() {
            return Err(StoreError::ConstraintViolation);
        }
        library.revision = library
            .revision
            .checked_add(1)
            .ok_or(StoreError::ConstraintViolation)?;
        let previous = self.state.clone();
        self.state.agent_library = library;
        self.commit_or_restore(previous)
    }

    pub fn insert_personal_agent_session(
        &mut self,
        authority: &CoreWriteAuthority,
        session: SessionRecord,
        agent: PersonalAgent,
        remember: bool,
    ) -> Result<u64, StoreError> {
        if !agent.is_valid()
            || self.session_agent_profile(&session.id).is_some()
            || session.process.template_ref.as_deref() != Some("builtin.agent.personal")
        {
            return Err(StoreError::ConstraintViolation);
        }
        let previous = self.state.clone();
        self.state.session_agent_profiles.push(SessionAgentProfile {
            session_id: session.id.clone(),
            agent,
        });
        let result = if remember {
            self.insert_session_and_remember_agent_launch(authority, session)
        } else {
            self.insert_session(authority, session)
        };
        if result.is_err() {
            self.state = previous;
        }
        result
    }
}

pub(crate) fn prune_session_profiles(state: &mut CurrentState) {
    if state.session_agent_profiles.is_empty() {
        return;
    }
    let ids: std::collections::HashSet<&str> = state
        .sessions
        .iter()
        .map(|session| session.id.as_str())
        .chain(
            state
                .deleted_sessions
                .iter()
                .map(|entry| entry.session.id.as_str()),
        )
        .collect();
    state
        .session_agent_profiles
        .retain(|entry| ids.contains(entry.session_id.as_str()));
}

pub(crate) fn session_profiles_are_invalid(state: &CurrentState) -> bool {
    state
        .session_agent_profiles
        .iter()
        .enumerate()
        .any(|(index, entry)| {
            !entry.agent.is_valid()
                || state.session_agent_profiles[index + 1..]
                    .iter()
                    .any(|other| other.session_id == entry.session_id)
                || !state
                    .sessions
                    .iter()
                    .chain(state.deleted_sessions.iter().map(|entry| &entry.session))
                    .any(|session| {
                        session.id == entry.session_id
                            && session.process.template_ref.as_deref()
                                == Some("builtin.agent.personal")
                    })
        })
        || state
            .sessions
            .iter()
            .chain(state.deleted_sessions.iter().map(|entry| &entry.session))
            .any(|session| {
                session.process.template_ref.as_deref() == Some("builtin.agent.personal")
                    && !state
                        .session_agent_profiles
                        .iter()
                        .any(|entry| entry.session_id == session.id)
            })
}
