use serde::{Deserialize, Serialize};

use crate::AgentLaunchSelection;

pub const PERSONAL_AGENTS_MAX: usize = 60;
pub const AGENT_INSTRUCTIONS_MAX: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalAgent {
    pub id: String,
    pub version: u32,
    pub name: String,
    pub description: String,
    pub category: String,
    pub instructions: String,
    pub agent_id: String,
    pub selection: AgentLaunchSelection,
}

impl PersonalAgent {
    pub fn is_valid(&self) -> bool {
        valid_personal_agent_id(&self.id)
            && self.version > 0
            && bounded_text(&self.name, 80)
            && bounded_text(&self.description, 240)
            && bounded_text(&self.category, 40)
            && bounded_text(&self.instructions, AGENT_INSTRUCTIONS_MAX)
            && self.instructions.len() <= AGENT_INSTRUCTIONS_MAX
            && matches!(self.agent_id.as_str(), "claude" | "codex")
            && self.selection.is_well_formed()
    }
}

pub fn valid_personal_agent_id(id: &str) -> bool {
    id.strip_prefix("custom.agent-profile.")
        .is_some_and(|slug| {
            id.len() <= 128
                && slug.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && slug.split('-').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                })
        })
}

fn bounded_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentLibrary {
    pub revision: u64,
    pub agents: Vec<PersonalAgent>,
    pub favorites: Vec<String>,
}

impl AgentLibrary {
    pub fn is_valid(&self) -> bool {
        self.agents.len() <= PERSONAL_AGENTS_MAX
            && self.agents.iter().enumerate().all(|(index, agent)| {
                agent.is_valid()
                    && !self.agents[index + 1..]
                        .iter()
                        .any(|other| other.id == agent.id)
            })
            && self.favorites.len() <= 64
            && self.favorites.iter().enumerate().all(|(index, id)| {
                id.len() <= 128
                    && (id.starts_with("builtin.agent-profile.")
                        || self.agents.iter().any(|agent| agent.id == *id))
                    && !self.favorites[index + 1..].contains(id)
            })
    }
}

/// Immutable instructions for the current logical Session, retained across
/// library edits and the existing Deleted Agent recycle bin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionAgentProfile {
    pub session_id: String,
    pub agent: PersonalAgent,
}
