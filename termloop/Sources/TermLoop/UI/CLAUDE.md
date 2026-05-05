# TermLoop UI — Agent Context

This folder contains TermLoop-owned SwiftUI/AppKit UI layers that sit on top of the upstream terminal engine. Upstream `Sources/*.swift` files should only call into this folder through marker-wrapped hooks. If you are touching terminal-agent activity/presentation truth, start in `Sources/TermLoop/Core/CLAUDE.md` instead.

## Main-area presentation contract

`MainAreaPresentation.swift` is the canonical source of truth for the main content area: Work content, Agents, Abilities, Markdown, Git Changes, Context Bank, Settings, Project Empty, **Task Board**, and future full-page/overlay routes.

Rules:

- Use `MainAreaPresentationPolicy` to resolve routes and selected/retiring/priming workspace presentation. Do not add another route resolver in sidebar stores, hooks, or upstream `ContentView`.
- Use `MainAreaPresentationCoordinator` to apply snapshots. It is per-window, `Equatable`/diffed, and owns AppKit portal visibility, input activation, z-order, settings-close intent, and handoff completion.
- Terminal and browser portal mutations go through `Hooks/Workspace+MainAreaPortalVisibility.swift`; do not call `TerminalPanel`/`BrowserPanel` portal visibility directly from views.
- Same-project content handoff is allowed only on content routes and only without command palette/file-drop overlays. Cross-project switches and non-content routes hide retiring portals synchronously.
- Mount/unmount remains upstream `ContentView.reconcileMountedWorkspaceIds` territory. UI policy may not materialize or tear down workspaces directly.
- Browser `visible == true` is intentionally a no-op in the portal helper because `BrowserPanelView` owns showing/rebinding via its anchor. Revisit only with a full browser-host ownership redesign.
- `taskBoard(projectId:)` is a **non-content route**: `allowsSelectedWorkspaceContent == false`, `allowsRetiringWorkspaceHandoff == false`. Task detail is local selection state of `TaskBoardPage` (driven by per-window `TaskSelectionStore`) and must not be a route — selecting a card must NOT trigger `MainAreaPresentationCoordinator.apply`. Renderer lives in `Core/TermLoopHooks.swift` overlayMode switch alongside the other route renderers.

## Testing and debugging

- Policy changes require `termloopTests/MainAreaPresentationPolicyTests` coverage for route precedence, settings interactions, handoff eligibility, workspace close, and rapid switch generation.
- Runtime policy violations should log through `dlog`/`DebugEventLog` behind `#if DEBUG`; do not crash release builds for transient SwiftUI/AppKit ordering races.
- Keep portal appliers diffed. Avoid introducing repeated global loops over all tabs/windows in response to high-frequency SwiftUI ticks.
