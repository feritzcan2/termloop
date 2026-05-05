# TermLoop UI/Tasks — Agent Context

UI for the project-scoped Tasks page. Stays a pure projection layer over `TaskBoardStore` snapshots and existing TermLoop stores.

## Rules

- Card and list views consume `TaskBoardStore.columnSnapshots` and `TaskBoardStore.selectedTaskDetailSnapshot`. They do NOT subscribe to a giant `@Published var tasks: [TaskRecord]`.
- Per-card `ObservableObject` is forbidden; per-row `ObservableObject` is allowed only for genuinely hot fields like provision-progress (none today).
- View bodies must NOT read raw `workspace.statusEntries` or other low-level telemetry. Use parent-level snapshot builders / projections.
- Agent / git / PR / branches sections are **read-only projections** of existing stores, scoped by `task.workspaceId`. They never mutate.
- Quick actions reuse existing Work-tab create-agent and Open-worktree entry points via `TaskQuickActionsBridge`. Inline prompt strings are forbidden — prompt selection lives in the AgentInputs plane (CLAUDE.md rule).
- `TaskSelectionStore` is **per-window** (no `static let shared`). Reviewers reject any singleton shortcut.
- All user-facing strings are localized via `String(localized: "key", defaultValue: "...", table: "TermLoop")`.
- The bottom detail panel is local selection state of `TaskBoardPage`, not a route. Selection changes must NOT trigger `MainAreaPresentationCoordinator.apply`.

## Layout

```
TaskBoardRouteHost (per-window)
  └─ TaskBoardPage (HorizontalResizableSplit)
       ├─ Top: TaskBoardCanvas → 5 × TaskBoardColumnView → TaskCardView
       └─ Bottom: TaskDetailPaneView (header, brief, actions, activity log)
```

```
Sidebar (.tasks tab)
TaskSidebarRoot (per-window)
  └─ TaskSidebarRouter
       ├─ TaskSidebarTaskListView   (no selection)
       └─ TaskSidebarDrillInView    (selection set)
            ├─ TaskRepairBanner     (when .failed)
            ├─ TaskAgentsSection
            ├─ TaskGitChangesSection
            ├─ TaskOpenPRsSection
            └─ TaskBranchesSection
```

## DI

- Per-project store: `TaskBoardStoreProvider.shared.store(for: projectId)` — lazy-resolves project root via `ProjectStore`.
- Per-window selection: `@StateObject TaskSelectionStore` instantiated by `TaskBoardRouteHost` and `TaskSidebarRoot`.
- Optional coordinator: passed through to children via constructor parameters; nil in v1 minimal renders (read-only).
- Activity log provider: `TaskActivityLogProviding`; defaults to `EmptyTaskActivityLogProvider`. Real provider wired in Task 24.

## Route contract

`taskBoard(projectId:)` is a non-content route: `allowsSelectedWorkspaceContent == false`, `allowsRetiringWorkspaceHandoff == false`. Switching into the Tasks tab synchronously hides any terminal/browser portal. Renderer is in `Core/TermLoopHooks.swift` overlayMode switch.
