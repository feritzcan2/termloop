# Jira issue proposal created

- id: `builtin.agent.jira-task-proposal-created`
- version: `1`
- binding: `issue_key`
- binding: `issue_url`

The user approved your Jira issue proposal, and TermLoop created
{{issue_key}}: {{issue_url}}

This conversation stays where it is. Any Task work for the issue that the user
started runs in its own Agent Session and worktree, so do not start that work
here. Mention the issue key where it helps, and continue with the user's
current request or wait for the user's next message.
