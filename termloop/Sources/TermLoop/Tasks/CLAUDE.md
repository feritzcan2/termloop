# TermLoop Tasks (domain) — Agent Context

Domain layer for the project-scoped, vibe-kanban–style Tasks page. All `TaskRecord` ↔ workspace mutations happen here, never in views.

## Boundaries

- `TaskRecord` is a binder/projection over the existing `WorkspaceMetadataStore` truth, not a new authoritative store for git, PRs, agents, or branches. Keep it that way.
- Persistence: `<projectRoot>/.termloop/tasks.json` (`schemaVersion: 1`). Atomic rename + debounce. Lifecycle-critical mutations call `saveNow()`.
- `AgentRun` is **never** persisted here. Agent rows are projections from `TerminalAgentActivityStore` + `WorkspaceMetadataStore` rendered by UI.
- The type is named `TaskRecord` (not `Task`) to avoid colliding with Swift's `_Concurrency.Task`. The user-facing concept stays "Task" (UI strings, docs).

## Single writer

All mutations to `TaskRecord` records and to the `TaskRecord` ↔ workspace binding go through `TaskLifecycleCoordinator`. Views and other coordinators must not write directly. The lifecycle coordinator is the single bridge between `TaskBoardStore` and `WorkspaceMetadataStore`.

## Invariants

- `bindingGeneration` is monotonic; bumped on every bind/unbind. Stale async-bind completions whose generation no longer matches MUST be ignored — the cancel path (`cancelBinding(taskId:)`) bumps generation immediately so any in-flight `bindWorktree` can no-op on completion.
- Board column moves are pure user-driven moves. They must not implicitly provision worktrees; manual tasks can live in any column with `provisionState = .none`.
- Bind-failure auto-revert is the **only** auto column move. Explicit bind attempts (`bindWorktree`) return the card to its previous column on failure with `provisionState = .failed(reason)`.
- Reconcile is idempotent: running multiple times on the same startup leaves state unchanged.
- Import idempotency key is `(projectId, TaskPathNormalization.resolveDisplayAndKey(...).keyPath)`. Branches can be renamed; do not key on branch. Display paths come from the same helper via `.displayPath`.

## Cancel semantics

`cancelBinding(taskId:)` implements ignore-and-cleanup: bumps generation, reverts the task to `.todo`, then attempts asynchronous teardown of the underlying worktree if one was already created. True interrupt of `WorktreeCoordinator.create` is a v2 follow-up once a cancellation contract exists.

## Reconcile wiring

`TaskBoardReconcileHook.projectDidActivate(_:)` is called from `TermLoopHooks.swift`'s `.onChange(of: projectStore.activeProjectId)` handler. It looks up the per-project store via `TaskBoardStoreProvider.shared` (which lazily resolves the project root via `ProjectStore`) and starts the reconciler asynchronously if a workspace lister is registered. Git worktree listing must happen off the main actor; only store mutation/save returns to the main actor. Failure is silent (DEBUG-logged).
