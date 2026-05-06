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
- Selecting a card drives sidebar drill-in/local selection and may auto-switch the inline terminal to that task's preferred visible agent workspace. If the selected task has no attached agent workspace, the inline terminal closes. Opening an agent from the sidebar uses the same inline terminal slot.

## Layout

```
TaskBoardRouteHost (per-window)
  └─ TaskBoardPage (board-only; HorizontalResizableSplit only while inline terminal is open)
       ├─ Top: TaskBoardCanvas → 5 × TaskBoardColumnView → TaskCardView
       └─ Bottom: inline terminal for selected/opened agent workspace; no task detail inspector
```

```
Sidebar (.tasks tab)
TaskSidebarRoot (per-window)
  └─ TaskSidebarRouter
       ├─ TaskSidebarTaskListView   (no selection)
       └─ TaskSidebarDrillInView    (selection set)
            ├─ TaskRepairBanner     (when .failed)
            ├─ TaskGitChangesSection
            ├─ TaskOpenPRsSection
            └─ TaskBranchesSection
```

## DI

- Per-project store: `TaskBoardStoreProvider.shared.store(for: projectId)` — lazy-resolves project root via `ProjectStore`.
- Per-window selection: `TaskSelectionStoreProvider.shared.store(for: windowId)` shares one `TaskSelectionStore` between `TaskBoardRouteHost` and `TaskSidebarRoot`; each host keeps a local fallback only while the window id is unavailable.
- Optional coordinator: passed through to children via constructor parameters; nil in v1 minimal renders (read-only).

## Route contract

`taskBoard(projectId:)` owns the Tasks board route and may embed selected workspace content inside its local bottom split. The inline terminal remains local per-window selection state, not a separate route. Renderer is in `Core/TermLoopHooks.swift` overlayMode switch.
