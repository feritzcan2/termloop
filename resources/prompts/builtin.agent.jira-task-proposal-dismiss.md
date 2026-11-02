# Jira issue proposal dismissed

- id: `builtin.agent.jira-task-proposal-dismiss`
- version: `1`
- binding: `feedback`

The user dismissed your Jira issue proposal. TermLoop will not create a Jira
issue or Task for this work.

User note: {{feedback}}

Do not propose again unless the user asks. Continue the user's request in the
current working directory, or wait for the user if the request depended on the
issue.
