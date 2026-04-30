# TermLoop Isolation Exceptions

This file records every approved deviation from the K/Y rules in
`isolation-rules.md`. Each entry MUST be paired with an
`termloop-exception: <reason>` trailer on the commit that introduces the
change.

When `/sync-upstream` pulls new commits, triage each entry here against the
incoming diff — upstream edits to listed declarations / regions can cause
conflicts the normal marker-block protection wouldn't have prevented.

## Entries

### 2026-04-20 — PortScanner per-workspace throttle in `Sources/PortScanner.swift`

**Commit trailer:** `termloop-exception: per-workspace throttle on PortScanner agent port scans`

**Rule touched:** Y3 (a marker-wrapped `guard ... else { return }` adds a new
branch inside upstream `refreshAgentPortsLocked`). K3 partially — the branch
itself is a single-line hook call, but the added control flow is the rule
touched.

**Why:** Profile sample with 20 agents + 2-3 actively used showed
`PortScanner.scanAgentPorts` + `refreshAgentPortsLocked` + `runLsof` +
`expandAgentProcessTree` + `runAllProcesses` totaling 8894 active samples in a
20-second window. Each agent click path — `registerTTY` → `refreshAgentPorts`
→ full `ps` + `lsof` fork+exec — was firing on every click, leading to burst
CPU saturation during rapid tab navigation. The throttle collapses repeat
calls against the same workspace within 1s into a single scan, while leaving
the periodic agent-scan timer untouched so genuinely new ports still surface
within the next tick.

**Files touched:**
- `Sources/PortScanner.swift` — one marker-wrapped `guard` immediately before
  the `scanAgentPorts(...)` call in `refreshAgentPortsLocked(...)`.
- `Sources/TermLoop/Core/TermLoopHooks.swift` — new `TermLoopPortScanThrottle`
  enum exposing `shouldScan(workspaceId:)` with a 1s cooldown per workspace.

**Sync-upstream triage:** Upstream changes to `refreshAgentPortsLocked` that
move or wrap the `scanAgentPorts` call will hit the marker block. Keep the
throttle semantics (skip-if-recent) unless upstream introduces its own
deduplication.

**Rollback path:** Revert the commit. The marker block and the helper enum
are removed atomically.

### 2026-04-20 — PortScanner burst cadence reduction in `Sources/PortScanner.swift`

**Commit trailer:** `termloop-exception: widen PortScanner burst and agent-rescan cadence`

**Rule touched:** K3 (constants in upstream file changed without a body
replacement). Marker block wraps just the two `static let` lines. No Y-rule
violated — constants renamed only in value, no new branches or members.

**Why:** `sample` profile showed `PortScanner.runLsof` + `runAllProcesses`
totaling 123+114 = 237 active leaf samples per 10s window in a 20-workspace
TermLoop session. The original burst schedule `[0.5, 1.5, 3, 5, 7.5, 10]s` +
2s agent rescan fires 6 full `ps`+`lsof` fork+exec cycles per kick plus a
background tick every 2s — effectively 1+ scans/sec continuously while agents
stream output. Narrowing to `[1, 3, 10]s` + 5s agent rescan halves the
fork+exec rate without degrading user-visible port detection latency past ~1s.

**Files touched:**
- `Sources/PortScanner.swift` — `burstOffsets` literal and `agentRescanInterval`
  literal changed in-place, wrapped in a single `// MARK: termloop-hook` block.

**Sync-upstream triage:** Upstream edits to these constants or to the burst
scheduler itself conflict on the two-line hook block. If upstream changes the
scheduler's semantics (e.g., introduces its own adaptive cadence), drop the
exception and re-evaluate whether the TermLoop tuning is still needed.

**Rollback path:** Revert the commit. Marker block is removed and original
literals `[0.5, 1.5, 3, 5, 7.5, 10]` / `2` restored.

### 2026-04-20 — GitStatusProvider shell-out delegated to TermLoop runner in `Sources/FileExplorerStore.swift`

**Commit trailer:** `termloop-exception: central GitCommandRunner for GitStatusProvider.runGit shell-out`

**Rule touched:** K3 (body of upstream `runGit` is replaced with a marker-wrapped
single-line hook call into TermLoop-owned git process infrastructure). No
Y-rule violated — the marker block is single-line, no new branches or stored
properties are introduced in the upstream file.

**Why:** `sample` profile of a multi-worktree TermLoop session showed repeated
`git status --porcelain` and `git rev-parse --show-toplevel` calls from the file
explorer and workspace git metadata paths. The first mitigation used a short TTL
cache; the current implementation retires that cache and routes the upstream
call site through `GitCommandRunner`, leaving freshness/caching responsibility to
the presentation stores that own the state.

**Files touched:**
- `Sources/FileExplorerStore.swift` — `runGit(in:arguments:)` body delegates via
  a single marker-wrapped `GitCommandRunner.runOptional(...)` call.
- `Sources/TermLoop/Git/GitCommandRunner.swift` — central process runner for
  timeout, telemetry, safe stdout/stderr draining, and mutation invalidation.

**Sync-upstream triage:** Upstream changes to the `runGit` signature or behavior
(extra arguments, different executable path, error handling) conflict exactly on
the single hook line. Apply upstream semantic changes to `GitCommandRunner` or
the hook call instead of reintroducing a `Process` block in the upstream file.

**Rollback path:** Revert the commit. The `runGit` body returns to the inline
`Process` block. No state to migrate.

### 2026-04-17 — OpenCode hook runtime in `CLI/cmux.swift` and Gemini integration copy in `Sources/cmuxApp.swift`

**Commit trailer:** `termloop-exception: upstream OpenCode hook runtime in CLI/cmux.swift and Gemini integration copy in Sources/cmuxApp.swift`

**Rule touched:** K3 (stray edits outside marker blocks in upstream files).

**Why:** This work adds OpenCode hook/runtime handling in `CLI/cmux.swift`, including session-store fallback resolution for hook events that arrive without a stable session id, plus a small copy update in `Sources/cmuxApp.swift` so the Gemini integration setting matches the current behavior. The CLI work currently lives in upstream CLI surfaces rather than a marker-wrapped hook seam, so the discipline checker flags the whole touched region as a K3 exception. While validating the same region, two call sites in the new OpenCode attention handling path also needed a no-op correctness fix from `sessionId.isEmpty ? nil : sessionId` to `sessionId`, because `sessionId` is already `String?`.

**Files touched:**
- `CLI/cmux.swift` — adds OpenCode hook command wiring, session resolution fallback, runtime definition, help text, and the optional-session correctness fix in the `permission` / `error` attention path.
- `Sources/cmuxApp.swift` — updates the Gemini integration note copy to say hooks are auto-installed on launch.

**Sync-upstream triage:** Upstream changes in the touched CLI command-dispatch / help-text / hook-runtime regions of `CLI/cmux.swift`, or in the Gemini settings card copy in `Sources/cmuxApp.swift`, need manual review on sync because they are not protected by marker blocks.

**Rollback path:** Revert the commit. That removes the OpenCode runtime wiring from `CLI/cmux.swift`, restores the previous Gemini note text in `Sources/cmuxApp.swift`, and drops the `sessionId` optional cleanup with the rest of the OpenCode changes.

### 2026-04-17 — Unblock TermLoop WIP: CLI `Int.init` ambiguity + AppDelegate access for WorkspaceRouting hook

**Commit trailer:** `termloop-exception: unblock pre-existing TermLoop WIP — CLI Int.init ambiguity and AppDelegate hook access for WorkspaceRouting`

**Rule touched:** K3 (stray edits outside marker blocks in upstream files).

**Why:** A fresh build (DerivedData wiped) exposed two pre-existing breakages in TermLoop-adjacent work that had been masked by incremental-build caches. Both had to be resolved before `./scripts/reload.sh --tag shared-folder-chip` could finish:

1. `CLI/cmux.swift` — five call sites did `Int?.map(Int.init)` where the source was already `Int?`. The redundant cast matched three Swift-stdlib `Int.init<T: BinaryInteger>` candidates and Swift refused to resolve them. Dropping `.map(Int.init)` and passing the `Int?` through directly is a no-op semantically and removes the ambiguity. The call sites feed `TermLoopCLICommands.reportAgentActivity(pid: Int?)` which already accepts `Int?`.
2. `Sources/AppDelegate.swift` — `mainWindowContexts`, `saveSessionSnapshot(includeScrollback:removeWhenEmpty:)`, and the nested `MainWindowContext` class were `private`. The existing `Sources/TermLoop/Hooks/AppDelegate+WorkspaceRouting.swift` extension reaches into both, and Swift extensions in different files cannot see `private` members — so the extension failed to compile on a fresh build. Widened each to module-internal (no access modifier). `MainWindowContext`'s nesting had to lose `private` too, otherwise the property type is less-accessible than the property itself.

**Files touched:**
- `CLI/cmux.swift` — five single-line edits removing `.map(Int.init)` on call sites that pass `pid: Int?` to `TermLoopCLICommands.reportAgentActivity(...)`.
- `Sources/AppDelegate.swift:2221` — `private final class MainWindowContext` → `final class MainWindowContext`.
- `Sources/AppDelegate.swift:2422` — `private var mainWindowContexts` → `var mainWindowContexts`.
- `Sources/AppDelegate.swift:4477` — `private func saveSessionSnapshot` → `func saveSessionSnapshot`.

**Sync-upstream triage:** If upstream renames or re-scopes any of `mainWindowContexts`, `saveSessionSnapshot`, or `MainWindowContext`, the merge will conflict exactly on those declaration lines. The CLI edits are inside TermLoop-specific CLI code, so upstream syncs are unlikely to touch them — but if the ambiguity reappears (an upstream CLI helper re-introduces `.map(Int.init)`), repeat the same no-op cleanup.

**Rollback path:** Revert the three `private` restorations on `AppDelegate.swift` and drop `AppDelegate+WorkspaceRouting.swift` until a marker-wrapped accessor hook can be introduced in `AppDelegate.swift` itself. Restore `.map(Int.init)` only if a caller changes `pid` to a non-`Int` integer type.

### 2026-04-16 — Feature→Folder rename touches interior of a multi-line hook block in TabManager.swift

**Commit trailer:** `termloop-exception: rename FeatureStore→FolderStore inside existing TabManager hook body`

**Rule touched:** K3b (stray-edit check flags the `+` hunk at
`Sources/TabManager.swift:3293` as outside a marker block). The line IS
inside an existing `// MARK: termloop-hook` / `// MARK: /termloop-hook`
pair (3289–3295), but the default unified=3 diff window puts the OPEN
marker just outside the visible context, so the checker's hunk-local
scan starts in the "outside" state.

**Why:** Part of the mechanical `Feature/Epic → Folder` rename. The call
site always was TermLoop-owned code (it was wrapped in marker tags in a
prior commit); only the type names on it change. No new upstream edits,
no Y-rule violations.

**Files touched:** `Sources/TabManager.swift` — single-line rename from
`FeatureStore.shared.activeFeatureId` to `FolderStore.shared.activeFolderId`
inside the pre-existing multi-line `addWorkspace(...)` hook at line 3293.

**Sync-upstream triage:** None needed — the marker block's body stays
TermLoop-owned. Upstream doesn't reference `FolderStore`.

**Rollback path:** Revert the commit; the marker block keeps its
structure so the revert is a clean line-level change.

### 2026-04-15 — Reorder `workspaceContextMenu` body, wrap upstream items in `termloop` submenu

**Commit trailer:** `termloop-exception: reorder workspace context menu with termloop submenu`

**Rule touched:** Y1 (multi-line upstream block rewrite) and implicitly K3
(the rearrangement shifts existing upstream statements, not just the TermLoop
marker-wrapped one-liners). Y2/Y3/Y4/K2/K4 unaffected — no renames, no new
branches inside upstream functions beyond what already existed (`if !activeProjectFeatures.isEmpty`
and remote-workspace conditionals were already upstream; we just repositioned
them), no new stored properties, no new upstream methods, no Localizable.xcstrings
additions (the new `contextMenu.cmuxSubmenu` key lives in `TermLoop.xcstrings`).

**Why:** Product decision to present TermLoop-first affordances (Agents,
Move to Feature, Worktree, Restore Claude Session, Close Workspace) at the
top level of the workspace row context menu and demote the upstream cmux
items into a single `cmux ▸` submenu. Keeping each upstream item as its own
top-level statement inside a marker-wrapped submenu block would have required
~20 additional marker pairs around statements that are still authored and
maintained upstream — visually worse than the single block rewrite. The
TermLoop marker pairs around the four TermLoop menu sections are preserved
unchanged.

**Files touched:**

- `Sources/ContentView.swift` — `workspaceContextMenu` body (line ~13218–13435):
  upstream menu items relocated into a `Menu("cmux")` wrapper; TermLoop
  hook blocks moved to the top; Close Workspace stays at top level; all
  existing upstream button/menu/divider logic reused verbatim inside the
  wrapper, so any upstream edits to these items will land as a normal
  merge inside the submenu block.
- `Sources/TermLoop/Core/TermLoopHooks.swift` — removed the leading
  `Divider()` from `workspaceContextMenuExtras(workspace:)` so the Agents
  submenu can be rendered at the top of the context menu without a leading
  separator. Callers now manage separators explicitly.

**Sync-upstream triage:** Upstream edits to workspace context menu items
(new buttons, reworded labels, new keyboard shortcuts) will merge cleanly
inside the `Menu("cmux") { … }` block. New upstream items appear in the
`termloop` submenu by default. If upstream adds a new menu item that should be
promoted to the top level, lift it out of the submenu in a follow-up commit.

**Rollback path:** Revert the commit. The TermLoop marker blocks remain
structurally identical to pre-rewrite, so rolling back restores the previous
flat ordering without additional cleanup.

### 2026-04-14 — Widen 15 sidebar private types to internal

**Commit trailer:** `termloop-exception: expose sidebar privates for TermLoopSidebar.Root takeover`

**Rule touched:** K3 (edits inside an upstream file beyond a single-line hook
call). No Y-rule is violated — this is purely an access-modifier widening on
existing declarations; no renames (Y2 safe), no new control-flow branches
(Y3 safe), no new stored properties on an upstream class body (Y4 safe), no
new function bodies (K2 safe).

**Why:** The sidebar redesign is large enough that keeping the current
fine-grained hook pattern (`Header`, `EpicTreeWorkspaceList`, `FooterButton`,
`projectFilteredTabs`, `handleActiveProjectDidChange`, `MoveToFeatureMenuItems`)
inside `VerticalTabsSidebar.body` would riddle upstream code with marker
blocks. Instead, `TermLoopSidebar.Root(...)` in `Sources/TermLoop/UI/` takes
over the whole body via a single hook call, which requires the sibling types
it composes to be visible from another file in the same module.

**Files touched:** `Sources/ContentView.swift` only. Declarations widened
from `private` to module-internal (no access modifier):

| Type | Approximate line | Kind |
|---|---|---|
| `SidebarTabItemSettingsSnapshot` | ~9960 | struct |
| `SidebarTabItemSettingsStore` | ~10053 | final class |
| `SidebarTabItemPresentationSnapshot` | ~10086 | struct |
| `SidebarDragFailsafeMonitor` | ~10908 | final class |
| `SidebarShortcutHintModifierMonitor` | ~11085 | final class |
| `SidebarFooter` | ~11244 | struct |
| `SidebarTopScrim` | ~12411 | struct |
| `SidebarScrollViewResolver` | ~12445 | struct |
| `SidebarScrollViewResolverView` | ~12460 | final class (forced by `SidebarScrollViewResolver.makeNSView`/`updateNSView` signatures) |
| `SidebarEmptyArea` | ~12481 | struct |
| `TabItemView` | ~12633 | struct |
| `SidebarDragAutoScrollController` | ~14760 | final class |
| `ClearScrollBackground` | ~15198 | struct (ViewModifier used by the sidebar ScrollView) |
| `SidebarTrailingBorder` | ~15627 | struct |
| `SidebarBackdrop` | ~15686 | struct |

**Sync-upstream triage:** If an incoming upstream commit renames, deletes, or
re-scopes any of the above, resolve manually — the widening commit's diff is
a pure `private` deletion at the declaration line, so any merge conflict will
land on exactly that line and is easy to spot.

**Rollback path:** `git revert` the widening commit and fold
`TermLoopSidebar.Root`'s contents back inline into `VerticalTabsSidebar.body`
(or re-introduce the fine-grained hook pattern). The `Root` view itself
lives under `Sources/TermLoop/UI/TermLoopSidebarRoot.swift` and is free to
delete without touching upstream code.
