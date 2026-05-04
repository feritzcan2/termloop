# TermLoop Workspace — Agent Context

## Scope

This repository is the only working repo. `termloop/`, `termloop/ghostty/`, `termloop/homebrew-cmux/`, and `termloop/vendor/bonsplit/` are tracked as normal directories, not submodules.

TermLoop is a terminal editor with an agentic sidebar. Developers who use coding agents are the target users. We are developing TermLoop from inside TermLoop. Every feature should work across project types, not just this repository.
Any prompt we pass to agents must be visible to users under the prompt templates tab. No inline prompts in code.

Two sibling projects under one workspace, plus supporting material:

- `terminal-app/` — Expo/React Native mobile SSH terminal (iOS/Android). See its own `terminal-app/CLAUDE.md` for mobile stack details.
- `termloop/` — TermLoop, our AI-first macOS terminal product. Start with `termloop/CLAUDE.md`, then use the area docs in `termloop/Sources/TermLoop/` for narrower rules.
- `docs/` — public architecture notes, upstream provenance, and release documentation.

## Instruction hierarchy

- Root files (`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`) are workspace-wide.
- `termloop/CLAUDE.md` is the product-level hub for TermLoop-only workflow and fork discipline.
- Area-specific rules live next to the code they govern:
  - `termloop/Sources/TermLoop/Core/CLAUDE.md` — terminal-agent presentation and shared core state
  - `termloop/Sources/TermLoop/UI/CLAUDE.md` — main-area/page/portal policy
  - `termloop/Sources/TermLoop/UI/Agents/CLAUDE.md` — sidebar, worktree, and agent panels
  - `termloop/Sources/TermLoop/AgentInputs/CLAUDE.md` — agent launch/input composition
  - `termloop/Sources/TermLoop/Git/CLAUDE.md` — git command runner, stores, and invalidation
  - `termloop/Sources/TermLoop/AgentTerminals/CLAUDE.md` — lifecycle for terminal agents

## Upstream sync model

Treat the configured fork/upstream repos as read-only sync sources. To refresh vendored code, use `./scripts/sync-upstreams.sh` from the repo root; that script pulls the configured refs into the tracked directories and updates `upstreams.lock`.

`sync-upstreams.sh` refuses to overwrite dirty vendored directories unless `--force` is passed. Use `--force` only when intentionally discarding local vendor edits.

GhosttyKit prebuilts are keyed by the vendored Ghostty source tree (`GHOSTTY_TREE_KEY` in `upstreams.lock`), not only by the upstream commit SHA. If `termloop/ghostty/` changes in a way that can affect `libghostty.a` or the exported C API, run `termloop/scripts/publish-ghosttykit.sh` so the release asset, checksum file, and lock key stay together. Fresh clones should get the checksum-pinned prebuilt via `termloop/scripts/ensure-ghosttykit.sh`; local Zig is only the fallback. `termloop/ghostty/src/build/` and `termloop/ghostty/src/apprt/gtk/build/` are source directories and must be tracked. Generated `termloop/ghostty/zig-pkg/` stays ignored.

| Path | Discipline |
|---|---|
| `termloop/` | **K/Y rules apply** to vendored upstream Swift/CLI files. TermLoop code under `termloop/Sources/TermLoop/` and `termloop/CLI/TermLoop/` is ours to shape freely. |
| `termloop/ghostty/` | K/Y does NOT apply. Modifying the renderer's Zig/C is supported when Swift hits an opaque C API wall. Sync changes back upstream manually when needed. |
| `termloop/homebrew-cmux/` | Local Homebrew tap holding the TermLoop cask formula. Edit directly. |
| `termloop/vendor/bonsplit/` | Vendored dependency; free to modify, but keep upstream commit provenance in `upstreams.lock`. |

When designing: if Swift only sees an opaque C API and the feature needs more, check whether the source lives in `termloop/ghostty/`. If it does, modifying it is on the table. The working copy is local to this repo, so there is no nested remote to push from in-place.

The end goal: the mobile app connects to a running `termloop` session and drives it over the socket, with a "Project" layer on top for organizing workspaces by folder.

## TermLoop agent-input contract

For agent launch/input work under `termloop/Sources/TermLoop/AgentInputs/`, follow the local rules in:
- `termloop/Sources/TermLoop/AgentInputs/CLAUDE.md`
- `termloop/Sources/TermLoop/AgentInputs/AGENTS.md`

That folder owns the invocation input plane: catalog truth, composition, delivery preview, and Quick Action authoring rules.

## Mobile ↔ termloop TCP bridge (shipped)

iPhone can't reach Unix sockets, so `termloop` exposes a second listener (TCP, AF_INET, default `:7878`, bind `0.0.0.0`) that shares the same v2 NDJSON pipeline as the Unix socket. MVP methods on mobile: `project.list / current / switch`, `workspace.list`.

- Server: `termloop/Sources/TerminalController.swift` (`handleClient(isTcpClient:)` — TCP skips cmuxOnly ancestry check, requires password auth), `SocketControlSettings.resolvedTcpPort()` / `resolvedTcpBindHost()`.
- Mobile: `terminal-app/modules/expo-termloop` (iOS `NWConnection`, Android stub), `lib/termloop-client.ts` (RPC), `app/termloop/[id].tsx`, `app/connection/new-cmux.tsx`.
- Password file: `~/Library/Application Support/termloop/socket-control-password` (shared across all tagged builds; each build has its own UserDefaults).

## Worktrees

TermLoop owns worktree lifecycle in `termloop/` — `WorktreeCoordinator` creates them at `<project>/.termloop-worktrees/<sanitized-branch>/` and keeps `WorkspaceMetadataStore` in sync. Path is gitignored at `.gitignore:85`, so no ignore-verification step is needed. Don't run `git worktree add` by hand in `termloop/` unless you're debugging — go through the app/CLI so metadata stays consistent.

## Ability starter authoring

For customizer-based starters under `termloop/Sources/TermLoop/Core/Templates/starters/<id>/` (empty runtime + `prompt-customizer.md` that fills in project-specific content):

- The customizer must write to `.termloop/skills/<id>/SKILL.md`. That is the runtime "Project canonical" path; `.termloop/abilities/<id>/instructions.md` is silently ignored, even when an ability declares `instructionFile`.
- Set `activation: "listed"` in `ability.json`. `worktree` forces a pseudo-installed state where the UI exposes "Open agent" with nothing to launch into; `listed` gives the correct STARTER badge plus "Create with agent | Install" actions.
