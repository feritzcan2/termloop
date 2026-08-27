use crate::agent_id_is_well_formed;

pub const PROJECT_TASK_AUTOMATION_KICKOFF_MESSAGE_MAX_BYTES: usize = 8_192;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectTaskAutomationConfiguration {
    pub project_id: String,
    pub create_worktree: bool,
    pub agent_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub kickoff_message: Option<String>,
}

impl ProjectTaskAutomationConfiguration {
    pub fn is_valid(&self) -> bool {
        if self.project_id.trim().is_empty() {
            return false;
        }
        match (
            self.agent_id.as_deref(),
            self.model.as_deref(),
            self.reasoning.as_deref(),
        ) {
            (None, None, None) => self.kickoff_message.is_none(),
            (Some(agent_id), Some(model), Some(reasoning)) => {
                self.create_worktree
                    && agent_id_is_well_formed(agent_id)
                    && valid_model(model)
                    && valid_reasoning(reasoning)
                    && self
                        .kickoff_message
                        .as_deref()
                        .is_none_or(valid_kickoff_message)
            }
            _ => false,
        }
    }
}

fn valid_model(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && !value.chars().any(char::is_control)
}

fn valid_reasoning(value: &str) -> bool {
    matches!(
        value,
        "default" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn valid_kickoff_message(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= PROJECT_TASK_AUTOMATION_KICKOFF_MESSAGE_MAX_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_requires_a_worktree_and_a_bounded_identifier() {
        let mut configuration = ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            agent_id: Some("codex".into()),
            model: Some("gpt-5.6-sol".into()),
            reasoning: Some("high".into()),
            kickoff_message: Some("Implement the Task and run focused tests.".into()),
        };
        assert!(configuration.is_valid());
        configuration.create_worktree = false;
        assert!(!configuration.is_valid());
        configuration.create_worktree = true;
        configuration.agent_id = Some("x".repeat(65));
        assert!(!configuration.is_valid());
        configuration.agent_id = Some("Codex".into());
        assert!(!configuration.is_valid());
    }

    #[test]
    fn launch_selection_and_kickoff_are_all_or_nothing_with_the_agent() {
        let mut configuration = ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            agent_id: None,
            model: None,
            reasoning: None,
            kickoff_message: None,
        };
        assert!(configuration.is_valid());
        configuration.kickoff_message = Some("Start without an agent".into());
        assert!(!configuration.is_valid());
        configuration.agent_id = Some("codex".into());
        configuration.model = Some("default".into());
        configuration.reasoning = Some("ultra".into());
        assert!(!configuration.is_valid());
        configuration.reasoning = Some("max".into());
        configuration.kickoff_message = Some("unsafe\u{1b}message".into());
        assert!(!configuration.is_valid());
    }
}
