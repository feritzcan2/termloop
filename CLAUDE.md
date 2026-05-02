# bmadworkflowtest — Claude Context

## TermLoop
TermLoop is a terminal editor with agentic side bar. Developers are our target users who uses coding agents in termloop. 
You are also, running inside termloop now while we develop termloop. Everyfeature we develop, must target every possible project type. 

Two sibling projects under one workspace, plus supporting material:

- `terminal-app/` — Expo/React Native mobile SSH terminal (iOS/Android). See its own `terminal-app/CLAUDE.md` for mobile stack details.
- `termloop/` — **TermLoop**, our AI-first macOS terminal product built on top of `manaflow-ai/cmux`. All product code lives under `Sources/TermLoop/`; upstream termloop and nested dependencies are vendored into this repo and synced via `./scripts/sync-upstreams.sh`. See `termloop/CLAUDE.md` for fork discipline and `termloop/docs/termloop/` for deep-dive references.
- `docs/` — local notes.

## Upstream Sync Model

This repo is the only working repo. `termloop/`, `termloop/ghostty/`, `termloop/homebrew-cmux/`, and `termloop/vendor/bonsplit/` are tracked as normal directories, not submodules.

Treat the configured fork/upstream repos as read-only sync sources. To refresh vendored code, use `./scripts/sync-upstreams.sh` from the repo root; that script pulls the configured refs into the tracked directories and updates `upstreams.lock`.

| Path | Upstream source | Discipline |
|---|---|---|
| `termloop/` | `feritzcan2/cmux-fork` (integration fork over `manaflow-ai/cmux`) | **K/Y rules apply** to upstream termloop Swift/CLI files. TermLoop code under `termloop/Sources/TermLoop/` and `termloop/CLI/TermLoop/` is ours to shape freely. |
| `termloop/ghostty/` | `feritzcan2/ghostty` | K/Y does NOT apply. Modifying ghostty Zig/C is supported when Swift hits an opaque C API wall. Sync changes back upstream manually when needed. |
| `termloop/homebrew-cmux/` | `manaflow-ai/homebrew-cmux` | Vendored support repo; sync via the root script when required. |
| `termloop/vendor/bonsplit/` | `feritzcan2/bonsplit` | Vendored dependency; free to modify, but keep upstream commit provenance in `upstreams.lock`. |

When designing: if Swift only sees an opaque C API and the feature needs more, check whether the source lives in `termloop/ghostty/`. If it does, modifying it is on the table. The working copy is local to this repo, so there is no nested remote to push from in-place.

The end goal: the mobile app connects to a running `termloop` session and drives it over the socket, with a "Project" layer on top for organizing workspaces by folder.

## TermLoop terminal-agent presentation contract

For `termloop` / TermLoop work, terminal-agent UI state now follows one structure and should stay there:

- **Source of truth:** `TerminalAgentActivityStore`
- **Truth access / predicates:** `TerminalAgentActivityStore` + `TerminalAgentActivityStore+Queries`
- **Formatting only:** `TerminalAgentDisplayFormatting`
- **Status-key lookup only:** `TerminalAgentStatusKeys`
- **No resolver layer:** `TerminalAgentActivityResolver` was removed on purpose; do not reintroduce a replacement facade.

Rules:

- UI must read **presentation state** (`presentation(forWorkspaceId:)`, `displayState(...)`, query helpers), not raw activity state, `workspace.statusEntries`, `workspace.agentPIDs`, or ad-hoc metadata fallbacks for agent presentation.
- Panel-style consumers should prefer **parent-built snapshots** and pure row renderers.
- If you need new agent UI behavior, put it in the store/query layer if it changes truth, or in formatting helpers if it is display-only.Prefer using existing one over creating new store all time.
- Do not add a new "easy" wrapper namespace that hides the store as the real source of truth.

## TermLoop agent-input contract

For agent launch/input work under `termloop/Sources/TermLoop/AgentInputs/`,
follow the local rules in:
- `termloop/Sources/TermLoop/AgentInputs/CLAUDE.md`
- `termloop/Sources/TermLoop/AgentInputs/AGENTS.md`

That folder owns the invocation input plane: catalog truth, composition,
delivery preview, and Quick Action authoring rules.

## Mobile ↔ termloop TCP bridge (shipped)

iPhone can't reach Unix sockets, so `termloop` exposes a second listener (TCP, AF_INET, default `:7878`, bind `0.0.0.0`) that shares the same v2 NDJSON pipeline as the Unix socket. MVP methods on mobile: `project.list / current / switch`, `workspace.list`.

- Server: `termloop/Sources/TerminalController.swift` (`handleClient(isTcpClient:)` — TCP skips cmuxOnly ancestry check, requires password auth), `SocketControlSettings.resolvedTcpPort()` / `resolvedTcpBindHost()`.
- Mobile: `terminal-app/modules/expo-termloop` (iOS `NWConnection`, Android stub), `lib/termloop-client.ts` (RPC), `app/termloop/[id].tsx`, `app/connection/new-cmux.tsx`.
- Password file: `~/Library/Application Support/termloop/socket-control-password` (shared across all tagged builds; each build has its own UserDefaults).

## Worktrees

TermLoop owns worktree lifecycle in `termloop/` — `WorktreeCoordinator` creates them at `<project>/.termloop-worktrees/<sanitized-branch>/` and keeps `WorkspaceMetadataStore` in sync. Path is gitignored at `.gitignore:85`, so no ignore-verification step is needed. Don't run `git worktree add` by hand in `termloop/` unless you're debugging — go through the app/CLI so metadata stays consistent.

## TermLoop ability starter authoring

For customizer-based starters under `termloop/Sources/TermLoop/Core/Templates/starters/<id>/` (empty runtime + `prompt-customizer.md` that fills in project-specific content):

- The customizer must write to `.termloop/skills/<id>/SKILL.md`. That is the runtime "Project canonical" path; `.termloop/abilities/<id>/instructions.md` is silently ignored, even when an ability declares `instructionFile`.
- Set `activation: "listed"` in `ability.json`. `worktree` forces a pseudo-installed state where the UI exposes "Open agent" with nothing to launch into; `listed` gives the correct STARTER badge plus "Create with agent | Install" actions.
