# Project Layer

A "Project" abstraction groups workspaces under named folders.
A project is `{ id, name, folderPath, createdAt }`. Multiple projects can be
open at once; each workspace is tagged with a `projectId`.

All code lives under `Sources/TermLoop/` per the isolation rules.
Upstream files only contain marker-wrapped hook calls.

## Data model

- `Sources/TermLoop/Projects/Project.swift` — `Project` struct (runtime) and
  `SessionProjectSnapshot` (Codable persistence mirror).
- `Sources/TermLoop/Projects/ProjectStore.swift` — `@MainActor`
  `ObservableObject` singleton (`ProjectStore.shared`). Holds `projects`,
  `activeProjectId`, `openProjectIds`. CRUD mutations call `onMutation` so the
  sidecar persistence coordinator can save. `bootstrap(from:)` is the entry
  point; if no projects were persisted it creates a "Default" project rooted
  at `$HOME` and returns its id so legacy workspaces can be tagged.
- `Sources/TermLoop/Core/WorkspaceMetadataStore.swift` — stores per-workspace
  `projectId` / `featureId` off-band. Upstream `Workspace` class is untouched;
  metadata is keyed by `workspace.id` and persisted via the sidecar snapshot.
- `Sources/TermLoop/Hooks/Workspace+TermLoop.swift` — adds a computed
  `projectId` on `Workspace` that reads from `WorkspaceMetadataStore`.

## Sidecar persistence

Projects and workspace metadata are persisted in a sidecar file alongside the
upstream session JSON:

- Upstream writes `session-<...>.json` (unchanged).
- TermLoop writes `termloop-<...>.json` next to it via
  `TermLoopHooks.saveSidecarSnapshot(alongside:)`.
- On launch, `TermLoopHooks.loadSidecarSnapshot(alongside:onStoreMutation:)`
  hydrates `ProjectStore.shared` and `WorkspaceMetadataStore.shared`.

Upstream `SessionPersistence.swift` and `Workspace.swift` stay pristine.

## Wiring (hook points)

All hooks are wrapped in `// MARK: termloop-hook` / `// MARK: /termloop-hook`.
See `hooks-inventory.md` for the full list. Project-layer-relevant hooks:

- `Sources/AppDelegate.swift`
  - Calls `TermLoopHooks.loadSidecarSnapshot(...)` during startup so
    `ProjectStore.bootstrap` runs before the UI mounts.
  - Calls `TermLoopHooks.saveSidecarSnapshot(...)` whenever upstream saves its
    session snapshot.
  - `reassignWorkspaces(fromProjectId:toProjectId:)` and
    `workspaceCount(forProjectId:)` live as extension helpers in
    `Sources/TermLoop/Hooks/AppDelegate+TermLoop.swift`, invoked from project
    delete flow.
- `Sources/TabManager.swift`
  - `addWorkspace(...)` has a marker-wrapped call to
    `TermLoopHooks.stampWorkspace(_:projectId:featureId:)` which routes to
    `WorkspaceMetadataStore`.
- `Sources/TerminalController.swift`
  - Socket dispatch hook routes unknown methods to
    `TermLoopSocketCommands.handle(method:params:)`.
  - `v2WorkspaceSummaryPayload` gets an additive merge via
    `TermLoopHooks.termLoopWorkspaceSummaryFields(for:)` so `project_id`
    appears on every workspace summary.
- `CLI/cmux.swift`
  - Top-level subcommand dispatch hook routes `project.*` / `list-projects` /
    etc. to `TermLoopCLICommands.handle(...)`.

## Socket API (v2, dot-notation)

All `project.*` methods are implemented in
`Sources/TermLoop/Socket/TermLoopSocketCommands.swift`.

| Method | Params | Success payload |
|---|---|---|
| `project.list` | — | `{ projects: [...], active_project_id, open_project_ids }` |
| `project.current` | — | project summary, or `not_found` error if no active |
| `project.create` | `name`, `folder_path` | project summary (becomes active) |
| `project.rename` | `project_id`, `name` | project summary |
| `project.update_folder` | `project_id`, `folder_path` | project summary |
| `project.delete` | `project_id`, optional `reassign_workspaces` (default true) | `{ project_id, workspaces_affected, workspaces_reassigned }` |
| `project.switch` | `project_id` | project summary |

Project summary shape: `{ id, name, folder_path, created_at, active, open }`.

`workspace.*` additive changes (merged via the summary-fields hook):

- `v2WorkspaceSummaryPayload` includes `project_id` (null if untagged).
- `workspace.create` accepts an optional `project_id` and forwards it through
  the `TabManager.addWorkspace` hook.

Error codes: `invalid_params`, `duplicate`, `invalid_folder`, `not_found`,
`cannot_delete_last`. Mapping lives in `projectStoreErrorToV2(_:)` inside
`TermLoopSocketCommands`.

## CLI (`CLI/TermLoop/TermLoopCLICommands.swift`)

Wraps the socket. Dispatched from `CLI/cmux.swift` via a single hook line.

- `cmux list-projects`
- `cmux current-project`
- `cmux new-project --name <name> --folder <path>`
- `cmux rename-project --project <id> --name <new>`
- `cmux set-project-folder --project <id> --folder <path>`
- `cmux delete-project --project <id> [--no-reassign]`
- `cmux switch-project --project <id>`

All commands honor `--json` and upstream's existing `--id-format` conventions.

## Migration behavior

1. Cold launch with pre-existing `session-*.json` and **no** sidecar →
   `ProjectStore.bootstrap` creates "Default" at `$HOME` and returns its id as
   fallback. Every restored workspace without metadata picks up that fallback
   via `WorkspaceMetadataStore`.
2. Cold launch with both files present → sidecar hydrates catalog +
   per-workspace metadata as-is; no fallback used.
3. Downgrade safety: older binaries simply ignore the sidecar file and keep
   writing upstream-shape JSON; upgrade path still works on re-launch.

## Manual smoke test

1. Launch cold → Default project exists, existing workspaces visible.
2. `cmux list-projects` → Default printed with `*`.
3. `cmux new-project --name Work --folder ~/code` → OK + new id.
4. `cmux switch-project --project <id>` → active.
5. `cmux new-workspace --cwd ~/code` → new workspace gets the active project_id.
6. `cmux list-workspaces --json` → workspaces include `project_id` field.
7. `cmux delete-project --project <id>` → workspaces reassigned to Default.

## Out of scope

- Sidebar filtering by `activeProjectId` (workspaces are tagged but not hidden).
- Desktop UI dialogs for create/rename/delete (socket/CLI surface is complete).
- Automated tests (deferred).
