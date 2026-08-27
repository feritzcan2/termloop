# Visible Template — Worker Task

## Template identity

- id: `development.worker-task`
- version: `3`
- audience: implementation worker agent

## Bindings

- `contract_identity`
- `worktree_path`

## Delivered prompt

Read the repository root and nearest local `AGENTS.md`, then inspect only the code and tests relevant to the assignment.

Work inside `{{worktree_path}}` and only in paths needed by the assignment. Implement against current contract identity `{{contract_identity}}`. Preserve unrelated work. Do not create or update documentation, decision records, proposals, plans, dashboards, or Task packets unless the user explicitly requests one. If the assignment would require a material expansion of authority, security, data-loss, wire, or module scope, report that concrete blocker instead of creating a process artifact.

Implement the requested behavior, run focused verification, and return a concise handoff with changed paths, command results, and remaining risk. Do not claim unverified behavior.
