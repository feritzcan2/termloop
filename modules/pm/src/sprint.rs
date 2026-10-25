//! Sprints: named, goal-bearing time boxes of one PM project. A project has at
//! most one active sprint; a closed sprint is frozen.

use crate::validation::{valid_id, valid_label, valid_non_blank_text};

pub const SPRINT_NAME_MAX_CHARS: usize = 80;
pub const SPRINT_GOAL_MAX_CHARS: usize = 2_000;
/// Sprints of one project that are not closed yet.
pub const PROJECT_OPEN_SPRINTS_MAX: usize = 64;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SprintState {
    /// An idea for a sprint, not scheduled yet.
    Backlog,
    #[default]
    Planned,
    Active,
    Closed,
}

impl SprintState {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Planned => "planned",
            Self::Active => "active",
            Self::Closed => "closed",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "backlog" => Self::Backlog,
            "planned" => Self::Planned,
            "active" => Self::Active,
            "closed" => Self::Closed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Sprint {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub goal: Option<String>,
    pub state: SprintState,
    pub created_at_epoch_ms: u64,
    #[serde(default)]
    pub activated_at_epoch_ms: Option<u64>,
    #[serde(default)]
    pub closed_at_epoch_ms: Option<u64>,
    /// When the sprint is planned to end; risks look at it near the end.
    #[serde(default)]
    pub ends_at_epoch_ms: Option<u64>,
    /// The Jira sprint this sprint mirrors; Jira owns a mirrored sprint's
    /// name, end, and state.
    #[serde(default)]
    pub jira_sprint_id: Option<u64>,
    #[serde(default)]
    pub jira_board_id: Option<u64>,
    /// When a sprint read last saw the Jira sprint.
    #[serde(default)]
    pub jira_pulled_at_epoch_ms: Option<u64>,
}

impl Sprint {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.id)
            && valid_id(&self.project_id)
            && valid_sprint_name(&self.name)
            && self.goal.as_deref().is_none_or(valid_sprint_goal)
            && (self.state == SprintState::Closed) == self.closed_at_epoch_ms.is_some()
    }
}

pub fn valid_sprint_name(name: &str) -> bool {
    valid_label(name, SPRINT_NAME_MAX_CHARS)
}

pub fn valid_sprint_goal(goal: &str) -> bool {
    valid_non_blank_text(goal, SPRINT_GOAL_MAX_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_round_trip_through_their_stored_names() {
        for state in [
            SprintState::Backlog,
            SprintState::Planned,
            SprintState::Active,
            SprintState::Closed,
        ] {
            assert_eq!(SprintState::parse(state.as_str()), Some(state));
        }
        assert_eq!(SprintState::parse("done"), None);
    }

    #[test]
    fn a_sprint_is_closed_exactly_when_it_has_a_close_time() {
        let sprint = Sprint {
            id: "s1".into(),
            project_id: "p1".into(),
            name: "Sprint 1".into(),
            goal: Some("Ship login".into()),
            state: SprintState::Planned,
            created_at_epoch_ms: 1,
            activated_at_epoch_ms: None,
            closed_at_epoch_ms: None,
            ends_at_epoch_ms: Some(10),
            jira_sprint_id: None,
            jira_board_id: None,
            jira_pulled_at_epoch_ms: None,
        };
        assert!(sprint.is_valid());
        assert!(
            !Sprint {
                state: SprintState::Closed,
                ..sprint.clone()
            }
            .is_valid()
        );
        assert!(
            !Sprint {
                goal: Some("  ".into()),
                ..sprint
            }
            .is_valid()
        );
    }
}
