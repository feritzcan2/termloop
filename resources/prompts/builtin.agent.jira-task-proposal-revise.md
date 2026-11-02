# Jira issue proposal feedback

- id: `builtin.agent.jira-task-proposal-revise`
- version: `1`
- binding: `feedback`

The user wants changes to your Jira issue proposal before TermLoop creates it.

User feedback:

{{feedback}}

Apply the feedback. Check any Jira project, issue type, or epic it names with
your Jira tools, then call `propose_jira_task` again with the complete
corrected proposal. Then stop and wait for the user.
