# Agent worktree relocation

- id: `builtin.agent.worktree-relocation`
- version: `1`

TermLoop resumed this conversation in a different working directory.

- Task ID: `{{task_id}}`
- Task title: {{task_title}}
- Previous working directory: `{{source_cwd}}`
- Current working directory: `{{target_cwd}}`

Continue the existing conversation in the current working directory. Treat
paths, Git state, repository instructions, and conclusions recorded before this
handoff as potentially stale. Re-read the relevant files and instructions from
the current worktree before editing or running commands. Do not write to the
previous working directory merely because it appears in the conversation.
