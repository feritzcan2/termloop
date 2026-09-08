use serde::{Deserialize, Serialize};

use crate::AgentLaunchSelection;

pub const PERSONAL_AGENTS_MAX: usize = 60;
pub const AGENT_INSTRUCTIONS_MAX: usize = 32 * 1024;

/// User-owned settings for a custom agent or a built-in agent override.
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
        (valid_personal_agent_id(&self.id) || valid_profile_id(&self.id, "builtin.agent-profile."))
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
    valid_profile_id(id, "custom.agent-profile.")
}

pub fn valid_agent_profile_id(id: &str) -> bool {
    valid_personal_agent_id(id) || valid_profile_id(id, "builtin.agent-profile.")
}

fn valid_profile_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|slug| {
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
        self.agents.len() <= 64
            && self
                .agents
                .iter()
                .filter(|agent| valid_personal_agent_id(&agent.id))
                .count()
                <= PERSONAL_AGENTS_MAX
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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: String) -> PersonalAgent {
        PersonalAgent {
            id,
            version: 2,
            name: "Reviewer".into(),
            description: "Review changes".into(),
            category: "Quality".into(),
            instructions: "Inspect changes".into(),
            agent_id: "claude".into(),
            selection: AgentLaunchSelection::new("default", "acceptEdits", "high"),
        }
    }

    #[test]
    fn overrides_are_confined_to_agent_profile_namespaces() {
        assert!(profile("builtin.agent-profile.edge-case-hunter".into()).is_valid());
        for id in [
            "builtin.steward.executor",
            "builtin.agent-profile.",
            "builtin.agent-profile../helper",
        ] {
            assert!(!profile(id.into()).is_valid());
        }
    }

    #[test]
    fn overrides_do_not_consume_personal_slots_or_exceed_catalog_bounds() {
        let mut library = AgentLibrary {
            agents: (0..60)
                .map(|index| profile(format!("custom.agent-profile.agent-{index}")))
                .collect(),
            ..AgentLibrary::default()
        };
        library
            .agents
            .extend((0..4).map(|index| profile(format!("builtin.agent-profile.agent-{index}"))));
        assert!(library.is_valid());
        library
            .agents
            .push(profile("builtin.agent-profile.extra".into()));
        assert!(!library.is_valid());
        library.agents.pop();
        library.agents.pop();
        library
            .agents
            .push(profile("custom.agent-profile.extra".into()));
        assert!(!library.is_valid());
    }
}
