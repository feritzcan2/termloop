# Single-Agent-Per-Workspace

TermLoop binds every workspace to exactly one terminal-agent CLI (claude,
codex, opencode, aider). The agent CLI runs as the foreground process of
a dedicated pane; other panes in the same workspace get PATH-shim
protection so users can't silently launch a second agent.

## TerminalAgent vs AgentTemplate

Two distinct concepts live side by side:

| Concept | Purpose | Location |
|---|---|---|
| `AgentTemplate` / `AgentRunner` | Claude-prompt orchestration (detached runs, own log stream, frontmatter-driven). Surfaced by the AGENTS sidebar. | `Sources/TermLoop/Agents/` |
| `TerminalAgent` | A CLI executable (`claude`, `codex`, …) that runs as the foreground process of a workspace's agent pane. 4 built-in entries in v1. | `Sources/TermLoop/AgentTerminals/` |

`TerminalAgent` is intentionally minimal: `{ id, displayName, executableName, argv, icon }`.
No prompts, no permission mode, no run catalog. The spawn hook uses
`executableName` as the command; the same name populates the blocked-bin
denylist so it can't be invoked from a shell pane.

## Data model

- `Workspace.terminalAgentId` — stored in `WorkspaceMetadataStore.Metadata.terminalAgentId`
  (sidecar v4). Required post-migration; nil only transiently during
  v3 → v4 upgrade.
- `Project.defaultTerminalAgentId` — optional per-project fallback.
- `TermLoopSettings.defaultTerminalAgentId` — global fallback (`@AppStorage`).
- `PaneKind` — per-panel enum `.agent(terminalAgentId:)` / `.shell`,
  keyed by panel UUID in `WorkspaceMetadataStore.paneMetadata`.
- `TerminalAgentResolver.resolve(workspaceId:)` — precedence chain
  workspace override → project default → global default → first built-in
  (claude).

## Sidecar v4

`TermLoopSessionSnapshot.version = 4` adds `paneMetadataByPosition` —
a `[[[PaneMetadata]]]` aligned with window × workspace × sidebar-ordered
panel so pane kinds survive a relaunch without relying on panel UUIDs
(which don't round-trip through upstream's session snapshot). The
`AppDelegate.termLoopPaneMetadataByPosition()` helper mirrors the same
ordering used by `termLoopWorkspaceMetadataByPosition` / `…ClaudeSessionsByPosition`.

v3 installs opening v4 sidecars don't break (optional field); v4 installs
opening v3 sidecars rely on `WorkspaceAgentMigration.runIfNeeded()` to
assign the global default and queue a one-time toast per affected
workspace.

## Invariant enforcement

`AgentPaneCoordinator.shared` owns the invariant. Three public entry
points:

- `ensureAgentPane(in:)` — spawns the agent pane if missing. Called
  from `TabManager.selectedTabId.didSet` via
  `TermLoopHooks.workspaceSelectionChanged`. Idempotent.
- `spawnAgentPane(in:agentId:)` — throws `.alreadyHasAgentPane` on second
  attempt. Used by the create-workspace path.
- `restartAgentPane(in:)` / `changeTerminalAgent(in:to:)` — force-close
  the current agent pane and respawn with the (possibly new) binding.

Ghostty integration: `TermLoopHooks.surfaceSpawnOverrides(paneId:)` is
called from `GhosttyTerminalView.createSurface` (via
`MainActor.assumeIsolated`). For `.agent` panes it returns
`TerminalAgent.commandLine()` which replaces both the upstream
`initialCommand` and the base config's `command`. For `.shell` panes it
prefixes `PATH` with the blocked-bin shim dir.

## Blocked-bin shim (Phase B L1)

`BlockedBinShimGenerator` writes `/bin/sh` stubs under
`~/Library/Application Support/termloop/blocked-bin/<executableName>`. Each
stub prints a one-line message and exits 127. Generation is idempotent
(SHA-256 verified), foreign files are left untouched, and our-owned
stale files are removed when the denylist changes. The bootstrap hook
fires in `AppDelegate.applicationDidFinishLaunching`.

The PATH prefix only guards shell panes — agent panes bypass the shell
entirely (the CLI is spawned directly as the pane's foreground process),
so they see a pristine `$PATH`.

## FreePaneGuard (Phase B L2)

`FreePaneGuard` is the fallback when L1 is bypassed (absolute path,
`exec`, PATH override). Entry point:
`FreePaneGuard.shared.reportForeground(paneId:pid:exe:)`. On a denylist
match in a `.shell` pane it logs, invokes the banner presenter (Phase-B
stub logs via `os.Logger`; Phase-C replaces with an overlay), sends
`SIGTERM` to the process group, then escalates to `SIGKILL` after a
short grace period if the process is still alive. Debounced to 3
seconds; repeat hits inside the window fire SIGKILL immediately.

Production wiring of the ghostty foreground-process callback is
deferred — the guard is dormant until a caller invokes
`reportForeground`. Unit tests exercise it directly via the injectable
`killer` / `presenter` closures. Future work can wire in via ghostty
surface callbacks or a shell-integration `report_fg_process` socket
command.

## Socket surface

TermLoop socket methods (under `TermLoopSocketCommands.handle`):

| Method | Purpose |
|---|---|
| `termloop.list_terminal_agents` | Enumerate built-in registry. |
| `termloop.list_workspace_panes` | Per-surface breakdown with kind + agent id. |
| `termloop.change_workspace_agent` | Change binding + restart pane. |
| `termloop.restart_agent_pane` | Kill current agent, spawn fresh. |
| `termloop.set_project_default_agent` | Set/clear project default. |

Upstream `workspace.create` was extended with a `terminal_agent_id`
param (marker-wrapped hook in `TerminalController.v2WorkspaceCreate`);
the workspace-summary payload advertises `terminal_agent_id`.

## UI surfaces

- `NewWorkspaceSheet` — SwiftUI sheet with an agent picker (not yet
  wired to the File → New Workspace menu; callers present directly).
- `interceptUserClose(paneId:)` — `TabManager.closePanelWithConfirmation`
  routes through this hook; agent panes show a modal alert and refuse
  the close.
- Migration toast — first open of a legacy workspace posts
  `.termLoopMigrationToast` on `NotificationCenter.default` so any view
  can surface the banner. Flag is consumed once per workspace.

## Discipline

All new code lives under `Sources/TermLoop/AgentTerminals/`,
`Sources/TermLoop/Settings/`, `Sources/TermLoop/Hooks/`, or
`termloopTests/`. Upstream touches are single-line marker-wrapped calls
(see `docs/termloop/hooks-inventory.md`): `GhosttyTerminalView.swift`
(two hooks: spawn override lookup, env merge), `TabManager.swift`
(three hooks: workspace selection, create-time agent binding, close
interception), `TerminalController.swift` (workspace.create agent_id
param validation + bind), `AppDelegate.swift` (positional pane metadata
helper, blocked-bin bootstrap).

## Deferred (out of scope for v1)

- Multiple agent panes per workspace.
- User-defined `TerminalAgent` entries.
- Cross-workspace mutex on the same worktree.
- macOS sandbox-exec hard-sandboxing.
- Ghostty foreground-process callback wiring (L2 guard is ready but
  dormant until wired).
- ZDOTDIR-injected PATH re-prepend (`zshrcShellPaneAppend` hook exists
  but is not applied).
- Workspace menu UI items for Restart / Change template / New shell
  (socket + coordinator are ready).
- Agent-exited overlay UI (framework ready — surface process exit
  callback not wired).
- Tab accent color + icon decoration.
- Drag constraint on agent pane (requires bonsplit vendor changes).
