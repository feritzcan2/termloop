# UILayout — main-area swap + hiding the Ghostty terminal

The termloop main window has a single "main content area" to the right of the
sidebar. Most of the time it hosts a Ghostty terminal, but several
features need to take that space over: BMAD artifact reader, Scratchpad
doc editor, AgentRun inline log viewer. This doc explains **how** that
swap works and — critically — **why a SwiftUI `.overlay` alone doesn't
work**.

If you are adding a new full-bleed view that should cover the terminal,
read this first. If you skip the Ghostty-hide trick you will ship a
broken UI where your view's header shows but the terminal draws on top
of the body.

## TL;DR

To fully cover the Ghostty terminal you must do **two** things:

1. **Remove the SwiftUI terminal anchor from the view tree** — don't
   render it on the branch where your overlay is active. Use
   `BMADOverlaySwap` in `TermLoopHooks.swift` (`termloop/Sources/
   TermLoop/Core/TermLoopHooks.swift`) as the single swap point.
2. **Actively hide every workspace's terminal NSView** by calling
   `workspace.bmadSetTerminalsVisible(false)` on every workspace in the
   active `TabManager`. Restore with `true` when you close your view.

Step 1 alone is not enough — the terminal portal sometimes keeps
drawing. Step 2 alone is not enough — the anchor is still measured, so
the portal may reposition your content. You need both.

## Why SwiftUI `.overlay` cannot cover Ghostty

Ghostty renders into a **window-level AppKit portal view**
(`WindowTerminalHostView` — see `termloop/Sources/
TerminalWindowPortal.swift`). That view sits above the main SwiftUI
hosting view in the NSWindow's view tree. Positioning tracks a SwiftUI
anchor view inside the content area, but the actual draw happens at
the window level — above any SwiftUI `.overlay`, any modal `.sheet`,
and any ZStack layer you might put in.

Consequences for anyone overlaying the terminal:

- `.overlay { MyView() }` on the terminal content: **doesn't cover**
  the terminal. MyView renders in SwiftUI; Ghostty renders above it.
- `.sheet(item: ...) { MyView() }`: same problem. The sheet window is
  a SwiftUI construct; the terminal portal draws over it.
- `.zIndex(999)`, backgrounds, any other SwiftUI layering: same
  problem.

The mechanism that DOES work: make the portal hide its own hosted view.
The portal tracks two signals:
`entry.visibleInUI` (managed by `TerminalWindowPortal.updateEntry
Visibility(...)`) and `isHiddenOrAncestorHidden(anchorView)` (NSView
hidden bit on the anchor or any ancestor). Either one going false hides
the Ghostty surface. `workspace.bmadSetTerminalsVisible(false)` trips
both.

## The swap point — `BMADOverlaySwap`

One SwiftUI container in `TermLoopHooks.swift` owns the swap:

```swift
private struct BMADOverlaySwap<Content: View>: View {
    @ObservedObject private var selection = BMADSelectionStore.shared
    @ObservedObject private var scratchpad = ScratchpadStore.shared
    @ObservedObject private var runViewer = AgentRunInlineViewerStore.shared
    @ViewBuilder let content: () -> Content

    var body: some View {
        if selection.showOverlay {
            BMADArtifactOverlay()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .layoutPriority(1)
        } else if scratchpad.showEditor, let url = scratchpad.selectedFileURL {
            DocEditorView(
                fileURL: url, folderName: scratchpad.folderName,
                displayTitle: scratchpad.displayTitle,
                onClose: { scratchpad.close() }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .layoutPriority(1)
        } else if let run = runViewer.run {
            AgentRunDetailView(run: run, onClose: { runViewer.close() })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .layoutPriority(1)
        } else {
            content()    // terminal anchor lives in here
        }
    }
}
```

Called from upstream `ContentView.swift` via a single-line marker block:

```swift
// MARK: termloop-hook
TermLoopHooks.bmadTerminalSwap {
    terminalContent
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .layoutPriority(1)
        .overlay { SidebarExternalDropOverlay(draggedTabId: sidebarDraggedTabId) }
}
// MARK: /termloop-hook
```

When any store's flag flips true, the closure is not called and the
terminal anchor is never constructed in this pass. This is the "remove
the anchor" step.

## The hide step — `setAllWorkspaceTerminalsVisible(_:)`

Each overlay store does the active hide:

```swift
static func setAllWorkspaceTerminalsVisible(_ visible: Bool) {
    guard let tabManager = AppDelegate.shared?.tabManager else { return }
    for workspace in tabManager.tabs {
        workspace.bmadSetTerminalsVisible(visible)
    }
}
```

Three callers today:

- `BMADSelectionStore.select(_:)` / `.close()`
- `ScratchpadStore.open(...)` / `.close()` (check source for exact names)
- `AgentRunInlineViewerStore.show(_:)` / `.close()`

`Workspace.bmadSetTerminalsVisible` is an TermLoop extension in
`termloop/Sources/TermLoop/Hooks/Workspace+TermLoop.swift`. It walks
every `TerminalPanel` under the workspace and sets their hosted
`GhosttySurfaceScrollView.isHidden` (or equivalent). The portal's
ancestor-hidden tracker picks this up on the next layout pass and
drops the Ghostty draw.

## Lifecycle

Opening an overlay (example: Active Agents tap → agent-run viewer):

```
user taps ActiveAgentsPanel row
  → AgentRunInlineViewerStore.show(run):
      self.run = run                             // @Published
      setAllWorkspaceTerminalsVisible(false)     // hide portal
  → SwiftUI diffs BMADOverlaySwap
  → runViewer.run != nil branch → AgentRunDetailView fills the slot
  → content() (terminalContent) is not called → anchor gone
  → portal sees anchor gone + NSView hidden → Ghostty draw drops
  → user sees log viewer full-bleed, no terminal bleed-through
```

Closing (Close button in viewer):

```
AgentRunDetailView.Close:
  → onClose closure: runViewer.close()
  → self.run = nil
  → setAllWorkspaceTerminalsVisible(true)        // unhide portal
  → SwiftUI diffs BMADOverlaySwap → falls to else → content()
  → terminalContent rebuilt, anchor reattached
  → portal unhides Ghostty, positions on the anchor frame
  → same session, no restart
```

App quit/restart: `bmadSetTerminalsVisible` flips NSView state only
(not persisted). On relaunch the workspaces are rebuilt and terminals
default to visible. If `runViewer.run` was set when you quit, it isn't
restored (`@Published var run: AgentRun?` is in-memory only).

## Agents page as a full-bleed surface

The `Agents` top-level sidebar entry now uses the same main-area swap
mechanism. When the user opens the dedicated Agents page, Ghostty is not
"under" the page in any meaningful sense; the terminal anchor is removed
from the active branch and workspace terminal NSViews are hidden just as
they are for BMAD, Scratchpad, and the inline run viewer.

This matters because the Agents page is operational, not decorative. It
can show:

- the main `AgentWorkspacePage`
- the top `Loop Rail` for enabled and active loops
- live runs and attached agents
- paused or failed loop status cards

Architecturally, treat it as another full-bleed overlay surface, not as
"sidebar content next to the terminal".

### Practical implications

- Selecting `Agents` in the sidebar can replace Ghostty in the main area.
- Loop visibility belongs on the Agents page itself, not only in a small
  sidebar subtab.
- Any child flow opened from the Agents page still has to cooperate with
  the shared terminal visibility state.
- If a run detail view opens from within the Agents page, closing it
  should return to the Agents page when that page is still active, not
  blindly fall back to Ghostty.

### Shared visibility state

The visibility decision is no longer owned by BMAD alone. It is derived
from shared TermLoop UI state so these surfaces compose correctly:

- BMAD artifact overlay
- Scratchpad editor
- Agent run inline viewer
- Agents main page

If you add another full-bleed agent-related page later, plug it into the
same swap and terminal-hide flow rather than building a one-off overlay.

## When adding a new overlay

If you want to replace the terminal with a new full-bleed view:

1. Create an `ObservableObject` store with a `@Published` flag (or an
   optional model) the view observes.
2. In the store's mutator, call
   `setAllWorkspaceTerminalsVisible(false)` when you become active,
   `true` when you go inactive. Copy the helper verbatim — there's no
   shared utility yet because the three call sites are tiny.
3. Add an `@ObservedObject` for your store to `BMADOverlaySwap` and a
   new `else if` branch before `else { content() }`. Mirror the
   `.frame(maxWidth: .infinity, maxHeight: .infinity).layoutPriority(1)`
   modifiers exactly; SwiftUI's HStack priority hand-off depends on
   them.
4. If your view has a Close button that normally uses `@Environment(\
   .dismiss)`, thread an optional `onClose: (() -> Void)?` through so
   the Close can be inline-aware. See
   `AgentRunDetailView.swift:4–16` for the pattern.

Do **not**:

- Use `.sheet(item:)`, `.popover(item:)`, or SwiftUI ZStack overlays to
  cover the terminal. All three are defeated by the portal draw.
- Reach into `TerminalWindowPortal` directly. Go through `Workspace.
  bmadSetTerminalsVisible` which encapsulates the correct NSView
  manipulation.
- Assume the close path runs on a clean workspace list. `tabManager.
  tabs` changes during the overlay's lifetime; always re-read inside
  the close mutator.

## The `.id(model.id)` identity trick — switching content inside the same overlay

When your overlay hosts a view that displays **different data based on a
model the user can swap** (e.g., `AgentRunInlineViewer` showing run A,
then run B after the user taps a different active agent row), SwiftUI's
default view identity is the enclosing `else if let` branch — same
branch, same view type, same identity. That means:

- `@State` values on the hosted view are **preserved** across the swap
  (stale `lines`, stale `polling` flag, stale selections).
- `.task { … }` modifiers **do not re-fire** — the launch-on-appear
  semantics don't re-trigger on a model change.
- Async captures made on first appear keep pointing at the old model.

Symptom: the inline log viewer keeps showing run A's log even after you
click run B. Header label updates (because `templateDisplay` is a
computed property re-read on every body pass), but the log-tail task is
still polling run A's `logPath`.

Two-layer fix:

1. **In the swap container**, pin the hosted view's identity to the
   model id:

   ```swift
   } else if let run = runViewer.run {
       AgentRunDetailView(run: run, onClose: { runViewer.close() })
           .id(run.id)                              // ← forces fresh identity
           .frame(maxWidth: .infinity, maxHeight: .infinity)
           .layoutPriority(1)
   }
   ```

   `.id(run.id)` makes SwiftUI treat run A's view and run B's view as
   **different** views. State is torn down and rebuilt.

2. **In the hosted view**, bind every long-lived task to the same id:

   ```swift
   .task(id: run.id) {
       lines = []
       polling = true
       while polling {
           lines = tailOfLog()
           try? await Task.sleep(nanoseconds: 300_000_000)
       }
   }
   ```

   `.task(id:)` cancels the previous task and starts a new one when the
   id changes. Resetting `lines = []` and `polling = true` inside the
   task body is belt-and-suspenders — if something bypasses the
   `.id(...)` above (e.g., a future parent that strips the modifier),
   the task still self-resets on id change.

Why both? The `.id(...)` in the container is the primary fix; the
`.task(id:)` in the hosted view is the safety net. If either one is
intact the swap works. Skipping both leaves stale state.

When to use this pattern beyond the inline viewer: any time your overlay
is bound to `@Published var something: ModelWithId?` and the user can
swap that model without closing the overlay. Running agent viewer,
session picker, artifact reader if multiple selectable artifacts share
one overlay. Not needed when the overlay has a single fixed model for
its lifetime (e.g., `DocEditorView` for one scratchpad file — it closes
and re-opens with a different file, not swaps live).

## Source pointers

| Concern | Code |
|---|---|
| Swap container | `termloop/Sources/TermLoop/Core/TermLoopHooks.swift` (search `BMADOverlaySwap`) |
| Marker hook call site | `termloop/Sources/ContentView.swift` (`terminalContentWithSidebarDropOverlay`) |
| Hide/show helper | `termloop/Sources/TermLoop/Hooks/Workspace+TermLoop.swift` → `bmadSetTerminalsVisible` |
| Portal anchor tracker | `termloop/Sources/TerminalWindowPortal.swift` (`isHiddenOrAncestorHidden`, `visibleInUI`) |
| BMAD store | `termloop/Sources/TermLoop/UI/BMAD/BMADSelectionStore.swift` |
| Scratchpad store | `termloop/Sources/TermLoop/Folders/ScratchpadStore.swift` |
| Agent-run inline store | `termloop/Sources/TermLoop/UI/Agents/AgentRunInlineViewer.swift` |
| Agent-run inline viewer (host view) | `termloop/Sources/TermLoop/UI/Agents/AgentRunDetailView.swift` (note the `onClose` parameter + `.task(id: run.id)`) |
| Identity-trick swap site | `BMADOverlaySwap` branch for `runViewer.run` — `.id(run.id)` forces fresh view when the user swaps active agents |

## Related UI notes

- **ActiveAgentsPanel tap pattern**: agent-run rows use
  `HStack + .contentShape(Rectangle()) + .onTapGesture` with a nested
  hover-revealed `Button` for the cancel ×. Mirrors `AbilityAgentRow`.
  Nested `Button` inside an outer `Button` wrapper breaks hit tests in
  SwiftUI — stick to the outer-`onTapGesture` form.
- **Free-prompt row labels**: row-rendering surfaces use
  `AgentRunDisplay.primaryLabel(for:)` so free-prompt runs show the
  user's typed prompt snippet instead of the resolved template name.
  If you add a new place that lists `AgentRun`s, call the helper, don't
  read `templateId` directly.

---

# SideMenuTreeLayout — sidebar tree with drag-drop + spacers

The sidebar renders a tree of three user-orderable kinds — **folders**,
**workspaces**, **spacers** — interleaved with synthetic rows (docs
header/file, worktree-group header, ungrouped header) that the user
doesn't reorder directly. Users drag any orderable row to any slot in
the tree (cross-parent allowed) and can insert blank spacer rows for
visual grouping.

This section explains **how** ordering is persisted, **why** two
drag-drop systems coexist (existing tab-reorder + new tree drag), and
where the seams live so new work can plug in without regressing the
context-menu-survives-Claude-turn discipline.

If you are adding a new orderable row kind, a new drop zone, or a new
render-time sort, read this before touching `TermLoopSidebarInjection.
swift` or `SidebarTreeDrag.swift`.

## TL;DR

- Layout data (folder / workspace positions + spacer list) lives in
  `<project>/.termloop/sidebar-layout.json`, owned by `SidebarLayoutStore`.
  **Not** in `folders.json`, **not** in `WorkspaceMetadataStore`.
- `SidebarLayoutStore` is deliberately **not** `ObservableObject`.
  Mutations tick narrow Combine subjects (`positionVersion`,
  `spacerVersion`); the sidebar subscribes via `.onReceive(...)` and
  bumps local `@State`. Same discipline as `WorkspaceMetadataStore.
  branchVersion` — keeps open context menus from dismissing on every
  edit.
- Two drag-drop systems coexist on workspace rows: upstream
  `SidebarTabDropDelegate` (flat tab reorder, `com.cmux.sidebar-tab-
  reorder` UTI) wins innermost; our `SidebarTreeDropDelegate` fires
  only when the first misses (folder headers, spacer rows). Cross-
  folder workspace moves route through a one-line marker hook
  (`TermLoopHooks.didReorderSidebarTab`) appended to the upstream
  delegate's `performDrop`.
- Positions use `Double` with midpoint bisection; first mutation per
  parent triggers a lazy reindex to `1000, 2000, 3000 …`. Precision
  collapse (gap < `reindexTolerance`) forces a fresh reindex.
- Folder reparent builds a new `Folder` (the `parentId` field is a
  `let`), clears `isPinned` when moving under a non-root parent, and
  rejects cycles + sibling name collisions.

## Data model

Three new types under `termloop/Sources/TermLoop/Folders/`:

| Type | File | Role |
|---|---|---|
| `SidebarSpacer` | `SidebarSpacer.swift` | The spacer row itself: `id`, `parentId`, `position`. Named `SidebarSpacer` (not `Spacer`) to avoid `SwiftUI.Spacer` collision. |
| `SidebarLayout` | `SidebarLayout.swift` | Persisted root: `folderPositions: [String: Double]`, `workspacePositions: [String: Double]`, `spacers: [SidebarSpacer]`, `reindexedParents: Set<String>`, `rootReindexed: Bool`. String-keyed so `JSONEncoder` emits a readable object. |
| `SidebarLayoutStore` | `SidebarLayoutStore.swift` | `@MainActor` singleton. Holds a `SidebarLayout` per activated project. Persists atomically (`Data.write(options: .atomic)`). |

Position data does not live on `Folder` or `WorkspaceMetadataStore.
Metadata`. The isolation is load-bearing: the sidebar deliberately
doesn't observe `WorkspaceMetadataStore` (`TermLoopSidebarInjection.
swift` — search `branchVersion`) because it churns on Claude session
events. Putting positions there would force either observing the
store (regresses the context-menu bug) or routing position writes
through a side channel. A dedicated store with narrow publishers is
cleaner.

## Observation model

`SidebarLayoutStore` exposes:

```swift
let positionVersion = CurrentValueSubject<Int, Never>(0)
let spacerVersion   = CurrentValueSubject<Int, Never>(0)
let bulkReload      = PassthroughSubject<UUID, Never>()
```

`FolderTreeWorkspaceList` subscribes:

```swift
.onReceive(SidebarLayoutStore.shared.positionVersion) { _ in positionTick &+= 1 }
.onReceive(SidebarLayoutStore.shared.spacerVersion)   { _ in spacerTick   &+= 1 }
.onReceive(SidebarLayoutStore.shared.bulkReload)      { _ in /* both */ }
.onChange(of: projectStore.activeProjectId) { /* activate() */ }
```

`let _ = positionTick` and `let _ = spacerTick` are read inside `body`
to force re-evaluation on tick. Same pattern the file already uses for
`branchTick` and `staleTick`.

**Do not** mark `SidebarLayoutStore` as `ObservableObject` with
`@Published` properties. Every write would fire `objectWillChange`,
which is exactly what this design avoids.

## Render pipeline

`buildTreeRows` (`TermLoopSidebarInjection.swift`) emits a flat
`[TreeRow]`. Cases:

```
.folderHeader / .subfolderHeader / .ungroupedHeader
.workspace / .worktreeGroup / .inlineCreate
.docsHeader / .docFile
.spacer(SidebarSpacer, depth: Int)   // new
```

Ordering rules, per parent bucket:

- **Root** — pinned root folders first (pinning outranks position),
  then unpinned root folders interleaved with root-level spacers by
  position via `mergeByPosition(folders:spacers:projectId:)`.
  Ungrouped workspaces stay in their own `.ungroupedHeader` bucket at
  the end.
- **Inside a folder** — docs rows first (unchanged), then direct
  workspaces (`appendWorkspaceRows`) preserving the position-sorted
  order the caller handed in, then subfolders interleaved with the
  folder's own spacers by position.
- Items with no position sink to the tail in input order.

Tabs are position-sorted in `FolderTreeWorkspaceList.body` **before**
the bubble-on-response and stale-sinking passes run. A user who never
drags anything sees no behavior change — all positions are nil, sort
is a no-op, the pre-existing flags still apply on top.

**Worktree-group** rows (≥ 2 workspaces sharing a branch in the same
folder) are not draggable as a unit in v1; the user expands the group
and drags individual tabs. Docs headers/files are synthetic, also
non-draggable.

## Two drag-drop systems

This is the part that surprises: the sidebar has **two** independent
drag-drop pipelines and they have to cooperate.

| System | UTI | Owner | Scope |
|---|---|---|---|
| Upstream tab-reorder | `com.termloop.sidebar-tab-reorder` | `SidebarTabDropDelegate` in `ContentView.swift` (attached to each `TabItemView` + the empty sidebar area) | Reorder within the flat `tabManager.tabs` list. Folder-blind on its own. |
| Tree drag | `com.termloop.sidebar-tree-item` | `SidebarTreeDropDelegate` in `SidebarTreeDrag.swift` (attached via `.sidebarTreeReorderable` to folder headers, subfolder headers, spacer rows, workspace rows) | Position / reparent folders, spacers, and workspaces. |

Both UTIs are declared in `Resources/Info.plist` with
`UTTypeConformsTo: public.data` and `visibility: .ownProcess` in the
provider.

### Why two systems

The upstream tab-reorder predates the tree: it handles `TabItemView`'s
`.onDrag` → `NSItemProvider` → `SidebarTabDropDelegate` end-to-end
inside `ContentView.swift`. We can't turn it off without breaking tab-
strip drag semantics, and we can't replace it because `ContentView` is
upstream (K/Y rules).

Instead:

- `SidebarTreeReorderable` takes a `dragEnabled: Bool` (default
  `true`). Folder headers and spacer rows pass `true`. **Workspace
  rows pass `false`** so the inner `TabItemView.onDrag` wins
  uncontested.
- `SidebarTreeDropDelegate` registers **both** UTIs. If the drop
  carries `termloopSidebarTreeItem` (folder or spacer drag) we decode
  it natively. Otherwise we decode the tab-reorder payload (format
  `"cmux.sidebar-tab.<uuid>"`) and synthesize a workspace payload.
  This is why dragging a workspace onto a folder header or spacer row
  works even though workspaces ship their own UTI.
- Workspace rows have `SidebarTabDropDelegate` **inside**
  `TabItemView` (innermost, always wins for tab-reorder UTI) and our
  tree drop **outside** (handles tree-item UTI from folder or spacer
  drags). Nested drop targets don't conflict because they match on
  different UTIs.

### Cross-folder workspace drops — the hook

Workspace → workspace drops fire `SidebarTabDropDelegate.performDrop`,
which only reorders the flat list. To make cross-folder work we
appended a single-line marker hook right after `tabManager.
reorderWorkspace`:

```swift
// MARK: termloop-hook
TermLoopHooks.didReorderSidebarTab(
    draggedTabId: draggedTabId,
    targetTabId: targetTabId,
    tabManager: tabManager
)
// MARK: /termloop-hook
```

`TermLoopHooks.didReorderSidebarTab`:

1. Compares `featureId` of source vs target; no-ops if equal.
2. Calls `WorkspaceMetadataStore.shared.setFeatureId(_:
   forWorkspaceId:)` — an id-based setter added alongside the
   instance-based one, mirroring `setBranch(_:forWorkspaceId:)`.
3. Reindexes the destination bucket (`SidebarLayoutStore.
   reindexParentIfNeeded`) so all siblings have numeric positions.
4. Slots the dragged tab at `target.position ± positionStep/4`, with
   the sign chosen by flat-list adjacency
   (upstream `reorderWorkspace` has already placed them next to each
   other). No target → append one step past the last sibling.
5. Ticks `positionVersion` so the sidebar rebuilds without routing
   through `WorkspaceMetadataStore.objectWillChange`.

This is why workspaces land next to the target tab consistently,
even though the upstream delegate only speaks "flat index" and doesn't
know folders exist.

## Drop delegate — single zone + live placement

`SidebarTreeDropDelegate` registers one drop zone per row (not two
stacked half-overlays — that produced flaky hit testing). Placement
is resolved live from `DropInfo.location.y` against the captured row
height:

```
folder target:  25 / 50 / 25 split  →  above / into / below
spacer target:  50 / 50             →  above / below
workspace tgt:  50 / 50             →  above / below
```

Row height is captured via a `PreferenceKey` on a
`.background(GeometryReader)` so the host row's layout is unchanged.

The ViewModifier paints a 2pt accent-colored indicator line at the
top or bottom edge (`.above` / `.below`) or a rounded accent border
around the whole row (`.into`). Cursor becomes `NSCursor.openHand` on
hover over draggable rows; `.onDisappear` pops defensively in case
the row tears down mid-hover.

## Position math

```swift
static func midpoint(between a: Double?, and b: Double?) -> Double? {
    switch (a, b) {
    case (nil, nil):       return positionStep
    case (let a?, nil):    return a + positionStep
    case (nil, let b?):    return b - positionStep
    case (let a?, let b?):
        if abs(a - b) < reindexTolerance { return nil }
        return (a + b) / 2
    }
}
```

- `positionStep = 1000` — initial reindex step.
- `reindexTolerance = 0.0001` — midpoint collapse trigger.
- **Lazy reindex** (`reindexParentIfNeeded`): first mutation in a
  parent bucket assigns numeric positions to all its orderable
  siblings in current render order. Flag stored in
  `SidebarLayout.reindexedParents: Set<String>` (non-nil parents) or
  `rootReindexed: Bool`. Idempotent.
- **Forced reindex** (`forceReindexSlot`): when `midpoint` returns
  `nil`, reshape the bucket to `1000, 2000, 3000 …` and return
  `targetSlot ± step/2` for the caller.

## Folder reparent

`FolderStore.reparent(id:to:)` constructs a new `Folder` (the
`parentId` field is a `let`) with:

- Unchanged `id`, `name`, `projectId`, `createdAt`.
- New `parentId`.
- `isPinned` cleared when `newParentId != nil` — pinning is a root-
  level presentation concept.

Rejects:

- `newParentId == id` or descendant of `id` → cycle.
- Sibling at destination already owns the folder's name
  (case-insensitive).
- No-op (same parent).

## Spacer lifecycle

- **Insert** — context menu on `FolderSectionHeader` /
  `SubfolderSectionHeader` has "Insert Spacer Above / Below" items.
  `SidebarSpacerInsertion.insertSpacerAbove/Below(folder:projectId:)`
  runs the lazy reindex if needed and places the spacer at the
  midpoint between the target folder and its neighbor on the insert
  side.
- **Delete** — context menu on the spacer row (`SpacerRow.swift`).
  `SidebarLayoutStore.removeSpacer(_:in:)`.
- **Orphan cleanup** — `FolderStore.delete` calls
  `SidebarLayoutStore.removeFolderSubtree` so spacers whose
  `parentId` == the deleted folder vanish too. Children of the
  deleted folder are reparented to the grandparent upstream of this
  call, so we pass empty descendants.

## Auto-expand on drop-into

After a successful `.into` drop, `SidebarTreeDrag.swift`:

```swift
if placement == .into, let dest = destParentId {
    FolderTreeState.shared.setExpanded(dest, true)
}
```

Without this, dropping a workspace into a collapsed folder looked
like the workspace vanished. One line, large UX win.

## Forced-open folders for live agents

The sidebar now treats folders containing a **non-idle terminal-agent
workspace** as effectively expanded even if the persisted
`FolderTreeState` says collapsed.

- Applies to any visible terminal-agent activity (`running`, waiting for
  input/notification, completion/error still surfaced in the agent
  activity pipeline).
- Applies transitively: a parent folder stays open if any descendant
  workspace under that subtree has visible agent activity.
- The disclosure triangle can still open such a folder explicitly, but a
  collapse attempt while agent activity is live is ignored.
- Once the agent returns to `idle`, the persisted expansion state takes
  over again.

This prevents an active agent from disappearing inside the side tree just
because its folder was previously collapsed.

## When adding a new orderable row kind

1. Extend `OrderableKind` with the new case. Update `SidebarLayoutStore.
   position(for:in:)`.
2. Extend `SidebarTreeDragPayload.Kind` + the `moveItem` switch in
   `commitSidebarTreeDrop`.
3. Extend `SidebarLayoutStore.Move.Target` if the new kind needs its
   own position bucket, or reuse `workspacePositions` / `folderPositions`
   / `spacers` if it fits.
4. Teach `SidebarSpacerInsertion.currentSiblingOrder` to include the
   new kind in the right sibling bucket so reindex covers it.
5. In the ForEach switch in `FolderTreeWorkspaceList.body`, render the
   new row + attach `.sidebarTreeReorderable(id:kind:parentId:
   projectId:dragEnabled:)`. Pick `dragEnabled: false` if an inner
   view already owns `.onDrag` (see the workspace-row rationale
   above).
6. If the row type can contain children, update `resolvePlacement` to
   switch on kind and include an `.into` zone.

Do **not**:

- Add `.onDrag` at an outer level when an inner view already has one.
  SwiftUI picks innermost; yours will be ignored and the inner
  payload will pollute your drop flow. Route through an TermLoop hook
  in the inner delegate instead (see `didReorderSidebarTab`).
- Observe `SidebarLayoutStore` via `@ObservedObject`. Use `.onReceive`
  on the narrow subjects.
- Store positions on `Folder`, `Workspace`, or `WorkspaceMetadataStore.
  Metadata`. Keep them in `SidebarLayoutStore`.
- Register a new UTType without scoping provider visibility to
  `.ownProcess` — sidebar payloads leak into foreign apps otherwise.

## Source pointers

| Concern | Code |
|---|---|
| Spacer type | `termloop/Sources/TermLoop/Folders/SidebarSpacer.swift` |
| Layout persistence | `termloop/Sources/TermLoop/Folders/SidebarLayout.swift` + `SidebarLayoutStore.swift` |
| Spacer insertion / sibling-order helper | `termloop/Sources/TermLoop/Folders/SidebarSpacerInsertion.swift` |
| Spacer row view | `termloop/Sources/TermLoop/UI/SpacerRow.swift` |
| Tree drag-drop (payload, delegate, modifier) | `termloop/Sources/TermLoop/UI/SidebarTreeDrag.swift` |
| Render pipeline + row switch + narrow tick subscription | `termloop/Sources/TermLoop/UI/TermLoopSidebarInjection.swift` (search `buildTreeRows`, `mergeByPosition`, `SidebarLayoutStore.shared.positionVersion`) |
| Folder reparent | `termloop/Sources/TermLoop/Folders/FolderStore.swift` (`reparent(id:to:)`) |
| Workspace id-based featureId setter + id→folder query | `termloop/Sources/TermLoop/Core/WorkspaceMetadataStore.swift` (`setFeatureId(_:forWorkspaceId:)`, `workspaceIds(inFolder:)`) |
| Cross-folder workspace hook | `termloop/Sources/TermLoop/Core/TermLoopHooks.swift` (`didReorderSidebarTab`) |
| Upstream marker insertion | `termloop/Sources/ContentView.swift` (inside `SidebarTabDropDelegate.performDrop`, right after `tabManager.reorderWorkspace`) |
| UTType declarations | `termloop/Resources/Info.plist` (`com.termloop.sidebar-tree-item`, `com.termloop.sidebar-tab-reorder`) |
| Localization keys | `termloop/Resources/TermLoop.xcstrings` (search `spacer.menu.*`) |
