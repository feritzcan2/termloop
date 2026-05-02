# Terminal-Agent Lifecycle — Context

Write-side orchestration for every terminal-agent create/launch/restore/relaunch/reopen flow. Read the code first (`TerminalAgentLifecycle.swift`, `TerminalAgentRunner.swift`) before touching write-path behavior here.

Read-side truth lives under `TermLoop/Core/` (`TerminalAgentActivityStore`). Don't mix the two.

---

## Ownership split

| Concern | Owner |
|---|---|
| Policy: restore vs fresh, backend selection, live-agent reject, eligibility predicate, agent-id resolution chain | `TerminalAgentLifecycle` |
| Ordering: `addWorkspace` → `markPendingRestore` → metadata bind → dispatch | `TerminalAgentLifecycle` |
| `saveCriticalAgentRestoreStateSync` pairing with persisted-session writes | `TerminalAgentLifecycle` |
| Composition: command build, env, launch plan | `TerminalAgentRunner.prepareLaunch` |
| Dispatch primitives: hook install, command send, fallback launch | `TerminalAgentRunner.dispatch*` / helpers |

**Runner has no orchestration entry points.** It only exposes `prepareLaunch`, `dispatchAgentLaunchCommand`, `dispatchRestoredAgentCommand`, `applyWorktreeBinding`, `dispatchFallbackLaunchIfNeeded`, `pendingPlaceholderState`, `writePromptFile`, `installAgentHooks`, plus low-level send/resolve helpers.

---

## Public API (Lifecycle)

- `createFreshWorkspace(...)` — fresh workspace + launch. Callers: NewWorkspaceSheet, QuickActionViewModel, AbilitiesPanel (spawn).
- `forkWorkspace(...)` — sibling/helper from a source workspace. Callers: BridgeKickoffSheet, Quick Action prefill fork flows, WorktreeAgentsPanel.
- `launchInExistingWorkspace(...) -> LaunchOutcome` — only entry for attaching an agent to an already-materialized workspace. Policy (`_decideExistingLaunch`) decides restore/fresh/hold/reject; callers don't branch.
- `restoreWorkspaces([Workspace], autoRestoreClaude:)` — batch restore. Caller: `TermLoopHooks.didRestoreWorkspaces` (boot) and `reopenHiddenWorkspace` internally.
- `relaunchAfterWorktreeMigration(...)` — worktree migration relaunch. Caller: `WorktreeCoordinator`. Bypasses live-agent reject; owns the persisted-session rewrite + critical-save + clear + markPending + delayed dispatch sequence.
- `reopenHiddenWorkspace(oldWorkspaceId:, tabManager:)` — hidden-workspace reopen. Caller: `SidebarCloseButtonHook.unhide`. Forces `autoRestoreClaude: true` (user-initiated).
- `resolveAgentId(explicit:, workspaceId:)` — resolution chain (explicit → resolver heuristic → default). The `bindTerminalAgentOnWorkspaceCreate` hook delegates here.
- `isEligibleForGenericRestoredLaunch(agentId:, persistedSession:)` — eligibility predicate for generic (non-Claude) restore.
- `persistMovedAgentSession(workspaceId:, toCwd:)` — atomic "move persisted session + flush critical state". Idle-move counterpart to `relaunchAfterWorktreeMigration`.

---

## Canonical orderings

Violating any of these re-introduces race bugs that phase-1/phase-2 closed. Don't drift.

**Fresh create / fork:** `prepareLaunch` → `addWorkspace(terminalAgentId: explicit)` → `markPendingRestore` → `applyWorktreeBinding` → `dispatchFallbackLaunchIfNeeded` → `schedulePersistedAgentSessionRecoveryIfNeeded`. All in `_createWorkspaceAndPrepareLaunch`.

**Native fork:** same sibling-workspace inheritance as the normal fork path,
but launch composition comes from `prepareNativeForkLaunch(...)` and the new
workspace records a pending native-fork guard before dispatch so parent-session
echoes do not bind restore state to the wrong conversation.

**Existing launch (fresh path):** `markPendingRestore` → `dispatchAgentLaunchCommand`.

**Batch / in-place restore:** `markPendingRestore` → backend dispatch. Backend comes from `_selectRestoreBackend` only — never write an ad-hoc `if agentId == claudeId` in a third place.

**Worktree relaunch:** `setPersistedAgentSession` → `saveCriticalAgentRestoreStateSync` → `clearClaudeSession` → `ActivityStore.clear` → `ActivityStore.markPendingRestore` → 0.5s-delayed backend dispatch. The 0.5s isn't cargo-cult; the freshly-mounted panel needs a tick or the send races the shell.

**Idle persisted-session move:** always via `persistMovedAgentSession`. Don't call `metadata.movePersistedAgentSession` + `saveCriticalAgentRestoreStateSync` as two separate statements.

---

## Hard rules

- **Never re-introduce orchestration on Runner.** If you need a new create/launch/restore path, add a Lifecycle method. Runner only gains composition or dispatch helpers.
- **Never write `markPendingRestore` outside Lifecycle** (except via the Runner backend helpers Lifecycle calls). The "pending is pre-dispatch" invariant depends on this.
- **Never branch on `agentId == TerminalAgent.claudeId` in a new site.** Route through `_selectRestoreBackend` or `isEligibleForGenericRestoredLaunch`.
- **`launchInExistingWorkspace` rejects when a live agent is attached.** If you truly need takeover semantics, add a new purpose-built method (don't weaken this policy).
- **Don't call `TerminalAgentActivityStore.clear(workspaceId:)` from UI or panel code.** Only Lifecycle's relaunch path calls it.
- **Agent-id resolution chain lives only in `Lifecycle.resolveAgentId`.** Hooks and helpers delegate there; don't re-implement the explicit → resolver → default fallback elsewhere.
- **Fork inheritance stays shared.** If native and handoff fork need the same
  title/cwd/worktree/project inheritance, extract the helper in Lifecycle;
  don't fork that logic into two drifting code paths.

---

## Known structural debt

- `bindTerminalAgentOnWorkspaceCreate` hook is still a 2-line delegation, not removed. ~15 upstream `addWorkspace` sites (AppDelegate/ContentView/AppleScript/SessionResume) don't pass `terminalAgentId` and rely on the default-agent fallback. Full removal needs those callers to move to a `Lifecycle.addBlankWorkspace`-style wrapper, or a TabManager-level default. Either is a separate project — not a free cleanup.
- `TermLoopHooks.restoredTerminalLauncher` closure seam exists for `TermLoopSidecarPositionalRestoreTests`. Default dispatches to `Runner.dispatchRestoredAgentCommand`. Dropping the closure means re-pointing that test at Lifecycle.
- `TermLoopHooks.shouldLaunchRestoredTerminalAgent` is a 2-line adapter over `Lifecycle.isEligibleForGenericRestoredLaunch`. Only `TermLoopSidecarPositionalRestoreTests` still references the old name; migrate the test and delete the adapter.

---

## When adding a new caller

1. Does an existing Lifecycle public API fit? Use it. Don't add a new one to mirror a call-site shape.
2. Need parameters not yet on the API? Extend the existing method's signature rather than introducing a parallel entry point.
3. Need a new policy branch? Put it inside `_decideExistingLaunch` / `_selectRestoreBackend` / `resolveAgentId` — not at the call site.
4. If you genuinely need a new public method (e.g., a new workspace-birth flavor), mirror the naming and ordering conventions above.
