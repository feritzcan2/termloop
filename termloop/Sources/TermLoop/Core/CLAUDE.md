# TermLoop Core — Agent Context

Shared truth and formatting for terminal-agent activity, presentation state, and workspace metadata. This folder is the Core-level source of truth for agent presence and terminal-agent display data.

## What lives here

| File | Role |
|---|---|
| `TerminalAgentActivityStore.swift` | source of truth for agent activity and presentation state |
| `TerminalAgentActivityStore+Queries.swift` | truth/query helpers over the store |
| `TerminalAgentDisplayFormatting.swift` | formatting only |
| `TerminalAgentStatusKeys.swift` | status-key lookup only |
| `TerminalAgentDisplayState.swift` | display-state model types |
| `TerminalAgentPresentationState.swift` | presentation snapshot model types |
| `WorkspaceMetadataStore.swift` | shared workspace metadata persistence |
| `TermLoopHooks.swift` | hook dispatcher / orchestration entry points |

## Rules

- Do not reintroduce `TerminalAgentActivityResolver` or any other resolver/facade layer.
- UI should read `presentation(forWorkspaceId:)`, `displayState(...)`, and query helpers, not raw activity state, `workspace.statusEntries`, `workspace.agentPIDs`, or ad-hoc metadata fallbacks.
- If logic changes truth or visibility, put it in the store/query layer. If it only changes labels, formatting, or icons, put it in formatting helpers.
- Keep selection state, elapsed timers, and other pure UI concerns outside the store.
- Keep Core free of main-area/page/portal routing rules; those live in `Sources/TermLoop/UI/CLAUDE.md`.
- Keep Core reusable across project types. Avoid baking in one repo's prompt or workspace names.

## When changing behavior

1. Add truth/query changes next to the store.
2. Add formatting-only changes next to formatting helpers.
3. Update the relevant UI or sidebar docs only if behavior crosses a boundary into views or route selection.
4. Add/adjust policy tests for any change that affects visible presentation.
