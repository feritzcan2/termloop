# TermLoop Git — Agent Context

This folder owns git command execution, project/worktree git state, and git-driven presentation invalidation for TermLoop.

## What lives here

| File | Role |
|---|---|
| `GitCommandRunner.swift` | Canonical async git subprocess runner. |
| `GitStateProvider.swift` | Reads repository/worktree state through the runner and safe filesystem fallbacks. |
| `GitProjectStore.swift` + `GitProjectStore+Queries.swift` | Project-level git truth and query helpers. |
| `GitWorktreePresentationStore.swift` + `GitWorktreePresentationStore+Queries.swift` | Worktree/branch presentation truth for sidebar/UI consumers. |
| `GitPresentationInvalidationWatcher.swift` | Broadcasts/coalesces invalidation when git mutations happen. |

## Hard rules

- Route git invocations through `GitCommandRunner`. Do not spawn raw `Process()` for git directly unless the runner cannot model the command; if you must, copy the bounded pipe-drain/timeout pattern from existing code.
- Never block the main thread on git. Startup, restore, SwiftUI body code, terminal-surface code, and socket telemetry must use cached metadata or pure-path fallbacks.
- Use `WorkspaceMetadataStore.Metadata.worktreePath` as the physical checkout source. Canonical helpers are `Workspace.agentLoopSpawnCwd()` and `Workspace.agentLoopPresentationCwd()`.
- Git reads should suppress optional locks and have bounded timeouts. Git writes must publish invalidation so the UI refreshes without manual prodding.
- Keep auth handling in the existing Git auth ladder. Do not add one-off environment variables, credential prompts, or `ssh` wrappers at call sites.
- If a new UI needs derived git data, add query helpers next to the owning store; do not re-read git from views or rows.
- Main-area Git Changes routing is owned by `MainAreaPresentationPolicy` in `Sources/TermLoop/UI/MainAreaPresentation.swift`. Do not hide/show terminal or browser portals from Git sidebar code.

## UI/presentation boundaries

- Stores in this folder provide truth and queryable snapshots only. SwiftUI layout belongs under `Sources/TermLoop/UI/`.
- `GitChangesMainAreaStore` and related sidebar actions may request route activation, but selected/retiring workspace visibility and portal hiding are handled by the main-area presentation coordinator.
- Avoid adding timers or polling loops for git freshness. Prefer invalidation events from `GitCommandRunner` mutations plus focused filesystem/state refreshes.

## Testing

- Prefer unit tests around stores/query helpers and command-runner behavior.
- Do not add source-grep tests. Exercise runtime behavior through a seam or harness.
- For main-area route interactions involving Git Changes, update `MainAreaPresentationPolicyTests` rather than testing Git UI files for implementation details.
