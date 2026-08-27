use crate::agent_id_is_well_formed;

pub const PROJECT_TASK_AUTOMATION_KICKOFF_MESSAGE_MAX_BYTES: usize = 8_192;
pub const PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT: &str = "termloop";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectTaskAutomationConfiguration {
    pub project_id: String,
    pub create_worktree: bool,
    #[serde(default = "default_worktree_prefix")]
    pub worktree_prefix: String,
    pub agent_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub kickoff_message: Option<String>,
}

impl ProjectTaskAutomationConfiguration {
    pub fn is_valid(&self) -> bool {
        if self.project_id.trim().is_empty() || !valid_worktree_prefix(&self.worktree_prefix) {
            return false;
        }
        match (
            self.agent_id.as_deref(),
            self.model.as_deref(),
            self.permission.as_deref(),
            self.reasoning.as_deref(),
        ) {
            (None, None, None, None) => self.kickoff_message.is_none(),
            (Some(agent_id), Some(model), Some(permission), Some(reasoning)) => {
                self.create_worktree
                    && agent_id_is_well_formed(agent_id)
                    && valid_model(model)
                    && valid_permission(permission)
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

fn default_worktree_prefix() -> String {
    PROJECT_TASK_AUTOMATION_WORKTREE_PREFIX_DEFAULT.into()
}

fn valid_worktree_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some((first, rest)) = bytes.split_first() else {
        return false;
    };
    bytes.len() <= 32
        && first.is_ascii_lowercase()
        && rest
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !bytes.windows(2).any(|pair| pair == b"--")
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

fn valid_permission(value: &str) -> bool {
    matches!(
        value,
        "default" | "acceptEdits" | "plan" | "bypassPermissions"
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
            worktree_prefix: "termloop".into(),
            agent_id: Some("codex".into()),
            model: Some("gpt-5.6-sol".into()),
            permission: Some("bypassPermissions".into()),
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
        configuration.agent_id = Some("codex".into());
        configuration.worktree_prefix = "feature/team".into();
        assert!(!configuration.is_valid());
    }

    #[test]
    fn launch_selection_and_kickoff_are_all_or_nothing_with_the_agent() {
        let mut configuration = ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            worktree_prefix: "termloop".into(),
            agent_id: None,
            model: None,
            permission: None,
            reasoning: None,
            kickoff_message: None,
        };
        assert!(configuration.is_valid());
        configuration.kickoff_message = Some("Start without an agent".into());
        assert!(!configuration.is_valid());
        configuration.agent_id = Some("codex".into());
        configuration.model = Some("default".into());
        configuration.permission = Some("default".into());
        configuration.reasoning = Some("ultra".into());
        assert!(!configuration.is_valid());
        configuration.reasoning = Some("max".into());
        configuration.permission = Some("unrestricted".into());
        assert!(!configuration.is_valid());
        configuration.permission = Some("plan".into());
        configuration.kickoff_message = Some("unsafe\u{1b}message".into());
        assert!(!configuration.is_valid());
    }
}
