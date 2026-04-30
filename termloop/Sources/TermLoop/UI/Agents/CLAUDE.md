# Agent Rows & Panels — Context

This folder owns every sidebar row that represents an "agent running in a
workspace" (terminal agents, bridges, tickets, worktrees) plus the data layer
that feeds them. If you are about to change how a row renders, reads truth, or
subscribes to updates — start here.

Cross-cut references:
- Truth: `Sources/TermLoop/Core/TerminalAgentActivityStore.swift` (+ `+Queries`).
- Row data contract: `Sources/TermLoop/Core/TerminalAgentPresentationState.swift`.
- Bridge domain: `Sources/TermLoop/Bridge/`.
- Fork discipline (K/Y rules, upstream markers): `termloop/CLAUDE.md`.

---

## Single row renderer

`AgentRowCoreView` is the only agent-row renderer. Five consumers use it:

| Consumer | File | Dismiss | Trailing slot |
|---|---|---|---|
| ActiveAgents | `ActiveAgentsSessionRows.swift` | `.confirmClose` | `.collapseButton` |
| Worktree | `WorktreeAgentsPanel.workspaceRow` | `.none` | `.gitChangeBadgeExpandableWithCollapse` |
| Ticket | `TicketWorktreesPanelRows.workspaceRow` | `.none` | `.none` |
| Bridge (active) | `ActiveBridgeRowView.swift` | `.confirmClose` | `.none` |
| Bridge (extras) | `WorkspaceRowBridgeExtras.swift` | `.confirmClose` | `.none` |

Rules:

- Do **not** hand-roll a new row. Add a typed slot to `AgentRowTrailingSlot` or
  extend `AgentRowDismissBehavior` and route through `AgentRowCoreView`.
- Closures on the view (`onActivate`, `onTrailingSlotTap`, `onDismissLink`,
  `.confirmClose(onConfirm:)`) are **intentionally excluded from Equatable** —
  presence-only checks. Closure identity can churn per parent render;
  including it would defeat `.equatable()` memoization on the sidebar hot
  path.
- Activation gesture is attached to `mainRow` and the link-chip HStack only,
  **never the root VStack**. The link chip's own Button and the dismiss
  Button must consume their own taps without racing a root gesture.

---

## Snapshot contract

`AgentRowPresentationSnapshot` is the single data contract. Panels build it
via:

- `AgentRowSnapshotBuilder.build(workspace:branchLabel:policy:)` — normal path.
- `BridgeTargetRowSnapshotBuilder.build(bridge:rightTitle:rightWorkspace:)` —
  bridge right endpoint (real workspace or synthetic fallback).

When a panel needs field overrides, use `snapshot.with(title:branchLabel:since:)`
— hand-copying every field silently regresses when new fields are added.

Display-state policy:

- `.presentation` — honors sticky restore states (ActiveAgents, Bridge). After
  relaunch, a settled `completed`/`needsInput`/`error` must not flash to
  pendingRestore.
- `.livePreferred` — collapses sticky back to raw activity when raw is
  available (Worktree, Ticket).

---

## Dismiss semantics

The × in the row's popover is **ActiveAgents-style panel semantic** only.
Worktree and Ticket rows deliberately use `.none` — workspace closure there
flows through the tab context menu / sidebar header, not per-row ×.

Bridge rows: × = **full teardown**.
`BridgeCoordinator.dismissAndCloseRight(bridgeId:)`:

1. `dismiss(bridgeId:)` — force-closes askAgent hidden helper workspaces via
   `cleanupHelperWorkspaceIfNeeded`, then removes the bridge from the store.
2. `tabManager.closeWorkspaceFromSidebarPopover(rightWs)` — closes a
   non-helper right workspace through the hook-guarded path so
`TermLoopHooks.workspaceWillClose` still gets to confirm running-agent
shutdown.

Context-menu semantics are now intentionally split:
- **Fork Conversation** = provider-native same-agent conversation fork
  (currently Claude→Claude, Codex→Codex when a source session exists)
- **Handoff to New Agent** = transcript/context handoff into a fresh session
Do not collapse these labels back into a generic "Fork" unless the launch
semantics are also identical again.

---

## Subscription discipline

Row views must subscribe narrowly. In particular:

- **Do not** `@ObservedObject WorkspaceBridgeStore.shared` on a row view.
  `appendMessage` mutates `@Published var bridges` on every turn (no
  `overviewVersion` bump), which would re-render every bridge row on every
  transcript turn. Instead:
  - Hold a plain `let store = WorkspaceBridgeStore.shared`.
  - `@State private var overviewTick: Int` + `.onReceive(store.$overviewVersion)`
    with an equality guard.
  - Let `InlineBridgeTranscript(bridgeId:)` own its own `@ObservedObject`
    subscription — it is only mounted when expanded, so per-turn re-renders
    stay scoped there.

- **Do** observe `TerminalAgentActivityStore.shared` when the row reads
  presentation fields. `presentationVersion` is coalesced via
  `markPresentationDirty` / `flushPresentationIfNeeded`, so the frequency is
  safe. `WorkspaceRowBridgeExtras` specifically needs this because the right
  endpoint isn't in the parent panel's `allWorkspaceIds` subscription set.

- WorktreeAgentsPanel's per-workspace subscription block keys off
  `renderSnapshot.allWorkspaceIds` (precomputed on the snapshot). Do not
  recompute `groups.flatMap(\.workspaces).map(\.id)` inline in `.onChange(of:)`
  — it doubles the allocation per body eval.

---

## Performance instrumentation

`PanelRenderInstrumentation.measure(_:_:)` wraps snapshot builders. DEBUG logs
every 2s via `dlog`:

```
panel.render <id> total=N delta=M avg=Xus max=Yus window=2s
```

Greppable tag: `panel.render`. Panel IDs:
`PanelRenderID.{activeAgents, worktreeAgents, ticketWorktrees}`.

In Release, `measure` collapses to a direct passthrough — the closure is
non-escaping and inlines away. No guards at call sites.

When perf-tuning:

1. Start by reading real numbers from the tagged debug log — do **not**
   tighten memo signatures speculatively. Each signature input maps to a
   real content-change source; dropping one means stale UI.
2. Cheap precompute first (lookup maps, dedup, snapshot-side projections).
3. Subscription narrowing second (see the bridge-store case above).
4. Signature tightening last, and only with data.

---

## File map

Row renderers & snapshot plumbing:

- `AgentRowCoreView.swift` — the renderer.
- `AgentRowSnapshotBuilder.swift` — `(workspace, policy) → snapshot`.
- `ActiveAgentsSessionRows.swift` — terminal + ability rows.
- `ActiveBridgeRowView.swift` — bridge row (active panel).
- `TicketWorktreesPanelRows.swift` — ticket workspace rows.
- `WorktreeAgentsPanel.swift` — contains the worktree `workspaceRow` inline.

Panel data / subscriptions:

- `ActiveAgentsPanelData.swift`, `ActiveAgentsPanelView.swift`,
  `ActiveAgentsPanelInteractions.swift`, `ActiveAgentsPanelFormatting.swift`,
  `ActiveAgentsPanelSupport.swift`.
- `WorktreeAgentsPanel.swift` (panel + data in one file by design).
- `TicketWorktreesPanel.swift`, `TicketWorktreesPanelData.swift`.

Bridge-side presentation:

- `../../Bridge/BridgeTargetRowSnapshotBuilder.swift` — synthetic + real.
- `../../Bridge/WorkspaceRowBridgeExtras.swift` — extras below left endpoint.
- `../../Bridge/InlineBridgeTranscript.swift` — `@ObservedObject` store
  owner; mounted only when expanded.
- `../../Bridge/BridgeCoordinator.swift` — owns `dismissAndCloseRight`.

Shared:

- `../PanelRenderInstrumentation.swift` — render counter + duration sampler.
- `../TermLoopSidebarTheme.swift` — `iconName(for:)`, `color(for:)`,
  `elapsedLabel(since:)`. All row icons/colors/elapsed must route through
  these; do not re-add per-file switches.
