# Agent Project relocation

- id: `builtin.agent.project-relocation`
- version: `1`

TermLoop resumed this conversation in the Project checkout after removing it
from a Task worktree.

- Previous Task ID: `{{source_task_id}}`
- Previous Task title: {{source_task_title}}
- Previous working directory: `{{source_cwd}}`
- Current working directory: `{{target_cwd}}`

Continue the existing conversation in the current working directory. The
previous Task lifecycle no longer applies to this Session. Treat paths, Git
state, repository instructions, and conclusions recorded before this handoff
as potentially stale. Re-read the relevant files and instructions before
editing or running commands. Do not write to the previous worktree merely
because it appears in the conversation.
