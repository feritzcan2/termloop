# TermLoop UI Agents — Agent Context

This folder owns the sidebar/panel UI for active agents, worktree agent groups, agent catalog rows, ticket/worktree panels, and agent-related context menus. It is not the mobile `terminal-app`.

## Ownership boundaries

| Concern | Owner |
|---|---|
| Terminal-agent presentation truth | `Sources/TermLoop/Core/TerminalAgentActivityStore.swift` + query helpers |
| Agent row labels/icons/status formatting | `TerminalAgentDisplayFormatting` / `TerminalAgentStatusKeys` |
| Active Agents sidebar data shaping | `ActiveAgentsPanelData.swift` and parent-built snapshots |
| Pure row rendering | `ActiveAgentsPanelRows.swift`, `ActiveAgentsSessionRows.swift`, `AgentRowCoreView.swift` |
| Interactions/context menus | `ActiveAgentsPanelInteractions.swift`, `ActiveAgentWorkspaceContextMenu.swift` |
| Worktree/ticket sidebar presentation | `WorktreeAgentsPanel*`, `TicketWorktreesPanel*`, `WorktreeChanges*` |
| Main-area route/portal visibility | `Sources/TermLoop/UI/MainAreaPresentation.swift` (outside this folder) |

## Hard rules

- Do not derive agent state from raw `workspace.statusEntries`, `workspace.agentPIDs`, or ad-hoc metadata chains in rows/views. Use `TerminalAgentActivityStore` presentation/query APIs or snapshots built by a parent.
- Do not reintroduce `TerminalAgentActivityResolver` or any new facade that hides the store as the source of truth.
- Keep rows pure. Build snapshots/data in `*Data`/builder helpers and pass value types into row views.
- Respect the sidebar performance contract: memoize grouped/sorted/filtered collections, keep row `Equatable` coverage accurate, and avoid store reads inside tight row bodies.
- Sidebar route clicks may request activation (Agents, workspace, Git Changes, ability detail, etc.), but they must not directly toggle terminal/browser portals. Main-area visibility/input/z-order is owned by `MainAreaPresentationPolicy` + coordinator.
- If a click opens a workspace belonging to another project, make the project/workspace intent explicit and let the main-area policy handle cross-project retiring behavior; do not special-case stale terminal/browser cleanup here.
- User-facing strings need localization through the TermLoop string table according to the parent `termloop/CLAUDE.md` rules.

## Worktree and Git panels

- Worktree repair/migration behavior belongs in `WorktreeRepairCoordinator` / worktree lifecycle owners; UI panels should request actions and render state.
- Git/worktree status truth comes from `Sources/TermLoop/Git/*` stores and query helpers. Do not run git commands from SwiftUI views.
- `WorktreeChangesPanes` can surface the Git Changes main-area route, but route precedence and portal suppression are policy tests in `MainAreaPresentationPolicyTests`.

## When adding UI here

1. Decide whether the new behavior changes truth, formatting, or interaction only.
2. Put truth/query changes in the owning store (`Core` or `Git`), formatting in formatting helpers, and row-only visuals in this folder.
3. Add/update snapshot-building tests or policy tests for behavioral changes; avoid grep/source-shape tests.
