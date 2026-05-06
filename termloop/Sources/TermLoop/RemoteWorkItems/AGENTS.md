# TermLoop RemoteWorkItems — Agent Context

This folder owns TermLoop's generic remote issue/work-item service for manual user actions. It is provider-neutral and currently supports Jira (`acli`), GitHub (`gh`), and GitLab (`glab`).

## Scope

- Model remote work items, references, create/list/status operations, and `task.md` materialization.
- Use CLI-authenticated providers only; do not store API tokens or add in-app auth here.
- Keep this independent from agents, MCP, sockets, and sidebar UI. Those layers may call this service, but they do not own provider behavior.
- Provider-specific quirks belong in provider implementations; public service APIs should stay generic.

## Rules

- Never run provider CLI work on the main actor. Use async service/provider calls and bounded command execution.
- Route all subprocess calls through `RemoteWorkItemCommandRunner` or its protocol seam.
- Prefer explicit provider/container references (`owner/repo`, `group/project`, Jira project key) over process cwd inference.
- Keep writes confirmation-friendly at call sites; this layer exposes capabilities but should not surprise-create or transition items from UI refresh paths.
- Refresh/read paths may fetch remote state; write paths are `create` and `updateStatus`.
- Keep smoke coverage in `scripts/smoke-remote-work-items.sh` when adding provider behavior.

## Verification

- Dry-run smoke: `./termloop/scripts/smoke-remote-work-items.sh --dry-run`
- Jira live read-only assigned list: `REMOTE_WORK_ITEM_JIRA_PROJECT=KAN ./termloop/scripts/smoke-remote-work-items.sh --live-jira-assigned`
- Full app build: from `termloop/`, `./scripts/reload.sh --tag remote-work-items`
