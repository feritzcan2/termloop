---
id: remote-task-handoff-agent
name: Remote Task Handoff
description: Continue a confirmed remote task in its TermLoop worktree
icon: T
scope: workspace
permissionMode: ask
lifecycle: app-bound
logging: history
triggers: [manual]
defaultAttach: false
model: default
cleanup: none
variables: [remote_key, remote_url, task_title, task_file_path, source_summary, worktree_path]
timeoutSeconds: 1200
---
Continue the confirmed remote task in this worktree.

Remote task: {{remote_key}}
URL: {{remote_url}}
Title: {{task_title}}
Task file: {{task_file_path}}
Worktree: {{worktree_path}}

Context from the source agent:

{{source_summary}}

Work only in this worktree. Keep the change focused on the remote task, verify it, and summarize the result.
