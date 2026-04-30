# TermLoops

TermLoops is the scheduled template rerun layer in TermLoop. It lets the app re-execute an existing agent template on a cadence without the user manually pressing Run each time.

This is not the same thing as AgentBridge:

- TermLoops reruns one template on a timer
- AgentBridge relays messages between two live workspaces

## Current Scope

The current implementation is intentionally small:

- interval trigger only
- one template per loop
- one active run per loop at a time
- loop definitions persisted on disk
- execution goes through the normal `AgentRunner`
- UI target modes are `Workspace` and `Root`

Important limitations:

- no cron syntax
- no `on_run_finish` or `on_workspace_close` loop trigger yet
- no multi-step workflow chain
- no explicit folder target picker
- folder-scoped templates are not first-class loop targets in the UI

## Why It Exists

The rest of TermLoop already knows how to run a template once. TermLoops adds scheduling and policy:

- rerun review templates while coding continues
- keep a documentation or save agent on a repeating cadence
- retry after failures with a chosen policy
- expose loop state separately from one-off runs

## Main Pieces

### TermLoop

`TermLoop` is the persisted model for one scheduled loop. It carries:

- id
- name
- template id
- repo root path
- optional workspace id
- enabled flag
- trigger
- interval seconds
- failure policy
- variable overrides
- timestamps for create / last run / last finish
- last status and last error
- consecutive failure count
- next run time

Current trigger enum:

- `interval`

Current failure policies:

- `continueRunning`
- `pauseOnFailure`
- `backoff`

### TermLoopStore

`TermLoopStore` is the durable loop registry.

What it does today:

- loads and saves loop definitions
- publishes the current loop list to SwiftUI
- supports upsert, delete, and in-place mutation

Persistence is real here, unlike AgentBridge. Loop definitions are stored at:

- `~/Library/Application Support/termloop/termloop/loops.json`

### TermLoopEngine

`TermLoopEngine` is the runtime scheduler. It:

- starts once at TermLoop bootstrap
- ticks every 1 second
- normalizes missing schedules for enabled interval loops
- dispatches a run when `nextRunAt <= now`
- tracks one in-flight run per loop
- listens to `AgentRunStore` for terminal status changes
- updates loop state after success or failure

This is process-local runtime state. The in-flight map is not persisted.

### TermLoopEditorSheet

`TermLoopEditorSheet` is the create/edit form. It exposes:

- loop name
- template picker
- target mode: `Workspace` or `Root`
- interval stepper
- failure policy
- enabled toggle
- non-auto-filled variable overrides

Validation it enforces:

- loop name cannot be empty
- workspace target requires a selected workspace
- workspace-scope templates cannot be saved as root loops
- repo root path cannot be empty
- required non-auto variables must be filled

### TermLoopsView

`TermLoopsView` is the sidebar subtab. It shows:

- saved loops
- `Run now`
- `Pause` / `Resume`
- `Edit`
- `Delete`
- starter loop presets

Current starter presets:

- `Review Sweep`
- `Edge-Case Sweep`
- `Feature Save`

### AgentWorkspacePage

When the user selects the `Agents` top-level sidebar tab, the terminal area is replaced by the main-area Agents page.

This page is the operational surface for loops:

- hero metrics
- `Loop Rail` at the top
- active loops
- live runs
- attached agents
- paused / failed loops

The page is shown through the same terminal-swap mechanism documented in `UILayout.md`, using `AgentWorkspacePageStore` plus shared terminal visibility refresh.

## User Flows

### 1. Create a custom loop

The user opens `Loops`, clicks `+ New loop`, picks a template, chooses a target, sets an interval, and saves.

If the loop is enabled, `nextRunAt` is initialized immediately from `now + interval`.

### 2. Add a starter loop

The user adds one of the built-in starter loops from `TermLoopsView`.

These presets are just prefilled loop definitions. After insertion they behave exactly like normal loops.

### 3. Observe and manage loops

The user can monitor loops from:

- the `Loops` sidebar subtab
- the main-area `AgentWorkspacePage`

The main page's `Loop Rail` is meant to answer the basic operational question:

- is the loop only enabled
- is it actually running right now
- when is the next tick
- what happened on the last run

## Runtime Flow

### 1. Bootstrap

`AgentEngine.bootstrap(...)` starts template watching, run-finish notifications, and the loop engine.

### 2. Schedule normalization

On startup and each tick, the engine checks enabled interval loops whose `nextRunAt` is missing and assigns:

- `Date() + intervalSeconds`

This matters after edit flows and after restart if a loop was persisted without a next tick.

### 3. Tick

Every second, the engine scans enabled interval loops:

- skip if a run is already in flight for that loop
- skip if `nextRunAt` is still in the future
- otherwise dispatch

### 4. Dispatch

Dispatch resolves the template, builds an `AgentRunRequest`, and starts a normal agent run through `AgentRunner`.

On successful dispatch:

- `lastRunId` is updated
- `lastRunAt` is updated
- `lastError` is cleared
- `nextRunAt` becomes `nil` while the run is active

### 5. Completion handling

The engine watches the run store and waits for terminal statuses:

- `succeeded`
- `failed`
- `killed`

On success:

- `consecutiveFailures = 0`
- `lastStatus = succeeded`
- `nextRunAt = finishedAt + interval`

On failure:

- `consecutiveFailures += 1`
- `lastStatus` is updated
- `lastError` is set
- failure policy decides the next state

## Failure Policies

### continueRunning

The loop stays enabled and schedules the next tick at:

- `finishedAt + interval`

### pauseOnFailure

The loop disables itself and clears `nextRunAt`.

### backoff

The loop stays enabled and schedules a delayed retry with a capped exponential multiplier:

- `1x`
- `2x`
- `4x`
- `8x`

The cap is `8x` the base interval.

## Target Resolution

### Workspace target

For workspace loops, the engine resolves:

- workspace id
- folder id from `WorkspaceMetadataStore.Metadata.featureId`
- spawn cwd from `workspace.termLoopSpawnCwd()`
- branch name from workspace metadata
- repo root path from the loop record

If `termLoopSpawnCwd()` returns nil, the engine falls back to the loop's repo root path.

### Root target

For root loops, the engine resolves:

- no workspace id
- no folder id
- cwd = repo root path
- no branch name

Workspace-scope templates are rejected for root loops.

Current caveat:

- the loop UI does not model folder targets directly
- folder-scoped templates therefore do not have a first-class loop-targeting flow today

## Variables

Loop runs go through `QuickActionRunResolver.resolve(...)` with an explicit resolved context.

These variables are auto-filled when the template declares them:

- `branch_name`
- `workspace_path`
- `repo_name`

Any remaining declared variables must come from loop overrides.

Important implication:

- variables such as `project_name` are not auto-filled by the resolver
- starter loops that need them must preseed them explicitly

## State Semantics

### Enabled is not the same as running

`enabled = true` means:

- the scheduler will consider the loop on future ticks

It does not mean a run is active right now.

A loop is effectively running only when:

- `lastRunId` points to a run
- that run is `queued`, `running`, or `waiting`

### nextRunAt semantics

- enabled + idle: future scheduled time
- active run: `nil`
- paused loop: `nil`

So `nextRunAt == nil` is not enough by itself to infer pause vs running.

### Persisted vs runtime-only fields

Persisted:

- loop definition
- enabled flag
- failure policy
- overrides
- last status metadata
- next run time

Runtime-only:

- in-flight loop-to-run map inside `TermLoopEngine`

## Restart Behavior

Loop definitions survive restart because the store is on disk.

Runtime execution state does not survive restart:

- an actively running loop is not restored as in-flight
- the run store reconciles orphan `running` / `queued` runs at launch
- the loop engine then normalizes schedules for enabled loops

So after restart the app resumes loop scheduling, not the exact in-memory scheduler state from before quit.

## UI Surfaces

### Sidebar `Loops` subtab

Best for:

- create / edit / delete
- quick pause / resume
- adding starter presets

### Main-area `AgentWorkspacePage`

Best for:

- always-visible loop status
- seeing enabled vs running vs failed clearly
- correlating loops with live runs
- operating loops without compressing them into the sidebar

## Related Files

- `termloop/Sources/TermLoop/Agents/Models/TermLoop.swift`
- `termloop/Sources/TermLoop/Agents/TermLoopStore.swift`
- `termloop/Sources/TermLoop/Agents/TermLoopEngine.swift`
- `termloop/Sources/TermLoop/Agents/AgentEngine.swift`
- `termloop/Sources/TermLoop/Agents/AgentPaths.swift`
- `termloop/Sources/TermLoop/UI/Agents/TermLoopEditorSheet.swift`
- `termloop/Sources/TermLoop/UI/Agents/TermLoopsView.swift`
- `termloop/Sources/TermLoop/UI/Agents/AgentWorkspacePage.swift`
- `termloop/Sources/TermLoop/UI/Agents/AgentWorkspacePageStore.swift`
- `termloop/Sources/TermLoop/UI/QuickAction/QuickActionRunResolver.swift`
- `.termloop/AgentSystem/UILayout.md`
