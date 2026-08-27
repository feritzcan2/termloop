# Project Steward Task assignment

- id: `builtin.steward.task-assignment`
- version: `3`

Assignment ID: `task-agent-start:{{task_id}}`
Task: {{title}}
Steward Session ID: `{{steward_session_id}}`
{{jira_context}}
Current Task brief:
{{brief}}

Requested outcome:
{{assignment}}

Work on this Task in the current managed worktree. Treat a repeated message with
the same Assignment ID as delivery retry for this assignment, not as a second
Task. You are the developer for this Task; the Steward owns Project-management
decisions and Task state.

Before ending a turn that completes the assignment or leaves it blocked, report
through the normal terminal conversation and call `send_to_agent` once with the
exact Steward Session ID above. Send a concise decision-ready report containing
the exact Task ID, whether you consider it complete, the outcome, verification
commands and results, and any remaining work or blockers. This assignment
explicitly authorizes that one completion/blocker callback. It is one-way: do
not wait for, poll for, or claim a reply. Do not send routine progress chatter;
the Steward will send follow-up work if the finish condition is not met.
