//! Visible prompts for the Quick Action "Create Jira issue and Task" flow: the
//! instruction appended to the user's first message, and the messages that
//! carry the user's answer to a proposal back to the Agent.

use crate::{AskToTerminalPrompt, InvocationError, PromptTemplate};

pub(super) const JIRA_TASK_INTAKE_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.quick-action.jira-task-intake",
    version: 2,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.quick-action.jira-task-intake.md"
    ),
};

pub(super) const JIRA_TASK_PROPOSAL_REVISE_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.jira-task-proposal-revise",
    version: 1,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.agent.jira-task-proposal-revise.md"
    ),
};

pub(super) const JIRA_TASK_PROPOSAL_DISMISS_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.jira-task-proposal-dismiss",
    version: 1,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.agent.jira-task-proposal-dismiss.md"
    ),
};

pub(super) const JIRA_TASK_PROPOSAL_CREATED_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.jira-task-proposal-created",
    version: 1,
    authored_body: include_str!(
        "../../../resources/prompts/builtin.agent.jira-task-proposal-created.md"
    ),
};

/// The longest user feedback carried back to the Agent.
pub const JIRA_TASK_PROPOSAL_FEEDBACK_MAX_CHARS: usize = 4_000;

/// The user's Quick Action prompt followed by the visible intake instruction.
/// The result is what the Agent receives as its first message, so the
/// inspected preview and the launch carry the same text.
pub fn jira_task_intake_prompt(prompt: &str) -> Result<String, InvocationError> {
    if prompt.trim().is_empty() {
        return Err(InvocationError::InvalidPrompt);
    }
    crate::assistant::validate_template_asset(&JIRA_TASK_INTAKE_TEMPLATE)?;
    crate::bind_ordered(
        JIRA_TASK_INTAKE_TEMPLATE.authored_body,
        &[("prompt", prompt)],
    )
}

/// How the user answered a pending proposal without approving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JiraTaskProposalAnswer {
    /// Propose again with the user's corrections.
    Revise,
    /// Continue without a Jira issue.
    Dismiss,
}

/// The visible message that tells the Agent how the user answered.
pub fn jira_task_proposal_answer_prompt(
    answer: JiraTaskProposalAnswer,
    feedback: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    let feedback = feedback.trim();
    if feedback.chars().count() > JIRA_TASK_PROPOSAL_FEEDBACK_MAX_CHARS
        || feedback
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        || (answer == JiraTaskProposalAnswer::Revise && feedback.is_empty())
    {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = match answer {
        JiraTaskProposalAnswer::Revise => &JIRA_TASK_PROPOSAL_REVISE_TEMPLATE,
        JiraTaskProposalAnswer::Dismiss => &JIRA_TASK_PROPOSAL_DISMISS_TEMPLATE,
    };
    crate::assistant::validate_template_asset(template)?;
    let feedback = if feedback.is_empty() {
        "(none)"
    } else {
        feedback
    };
    let delivered = crate::bind_ordered(template.authored_body, &[("feedback", feedback)])?;
    crate::terminal_prompt(
        template,
        vec![("feedback".to_owned(), feedback.to_owned())],
        delivered,
    )
}

/// The visible message that tells a proposing Agent which issue TermLoop
/// created when its conversation does not move into the issue's Task.
pub fn jira_task_proposal_created_prompt(
    issue_key: &str,
    issue_url: &str,
) -> Result<AskToTerminalPrompt, InvocationError> {
    if [issue_key, issue_url].iter().any(|value| {
        value.trim().is_empty() || value.len() > 2_048 || value.chars().any(char::is_control)
    }) {
        return Err(InvocationError::InvalidPromptBinding);
    }
    let template = &JIRA_TASK_PROPOSAL_CREATED_TEMPLATE;
    crate::assistant::validate_template_asset(template)?;
    let bindings = [("issue_key", issue_key), ("issue_url", issue_url)];
    let delivered = crate::bind_ordered(template.authored_body, &bindings)?;
    crate::terminal_prompt(
        template,
        bindings
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
        delivered,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intake_keeps_the_user_prompt_first_and_names_the_tool() {
        let delivered = jira_task_intake_prompt("Fix the {{retry}} timeout").unwrap();
        let user_at = delivered.find("Fix the {{retry}} timeout").unwrap();
        let tool_at = delivered.find("`propose_jira_task`").unwrap();
        assert!(user_at < tool_at);
        assert!(delivered.contains("which Jira tool to\n   install"));
        assert!(jira_task_intake_prompt("  ").is_err());
    }

    #[test]
    fn an_answer_carries_the_feedback_under_its_own_template() {
        let revise =
            jira_task_proposal_answer_prompt(JiraTaskProposalAnswer::Revise, " Use epic PAY-9 ")
                .unwrap();
        assert_eq!(
            revise.provenance().template_ref,
            "builtin.agent.jira-task-proposal-revise"
        );
        assert!(revise.delivered_prompt().contains("\nUse epic PAY-9\n"));
        let dismiss =
            jira_task_proposal_answer_prompt(JiraTaskProposalAnswer::Dismiss, "").unwrap();
        assert!(dismiss.delivered_prompt().contains("User note: (none)"));
        assert!(jira_task_proposal_answer_prompt(JiraTaskProposalAnswer::Revise, " ").is_err());
        assert!(
            jira_task_proposal_answer_prompt(JiraTaskProposalAnswer::Dismiss, "a\u{1b}b").is_err()
        );
    }

    #[test]
    fn the_created_notice_names_the_issue_and_keeps_the_conversation_in_place() {
        let created = jira_task_proposal_created_prompt(
            "PAY-42",
            "https://example.atlassian.net/browse/PAY-42",
        )
        .unwrap();
        assert_eq!(
            created.provenance().template_ref,
            "builtin.agent.jira-task-proposal-created"
        );
        assert!(
            created
                .delivered_prompt()
                .contains("TermLoop created\nPAY-42: https://example.atlassian.net/browse/PAY-42")
        );
        assert!(
            created
                .delivered_prompt()
                .contains("This conversation stays where it is.")
        );
        assert!(jira_task_proposal_created_prompt(" ", "https://x").is_err());
        assert!(jira_task_proposal_created_prompt("PAY-1", "a\nb").is_err());
    }
}
