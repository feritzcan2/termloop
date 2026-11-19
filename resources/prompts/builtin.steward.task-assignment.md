# Project Steward Task assignment

- id: `builtin.steward.task-assignment`
- version: `4`

Assignment ID: `task-agent-start:{{task_id}}`
Task: {{title}}
{{jira_context}}
Current Task brief:
{{brief}}

What I need:
{{assignment}}

Work on this Task in the current managed worktree. If this message arrives again
with the same Assignment ID, it is a delivery retry of this assignment, not a
second Task. When you finish or get blocked, tell me the outcome, the
verification commands and their results, and any remaining work or blockers
here in this conversation.
