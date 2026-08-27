# Project Steward Task assignment

- id: `builtin.steward.task-assignment`
- version: `2`

Assignment ID: `task-agent-start:{{task_id}}`
Task: {{title}}
{{jira_context}}
Current Task brief:
{{brief}}

Requested outcome:
{{assignment}}

Work on this Task in the current managed worktree. Treat a repeated message with
the same Assignment ID as delivery retry for this assignment, not as a second
Task. Report progress and completion through the normal terminal conversation.
