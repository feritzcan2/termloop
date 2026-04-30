# Quick Action (Shift-Shift palette)

Raycast-style floating palette for one-keystroke headless agent launches.
All code lives under `termloop/Sources/TermLoop/UI/QuickAction/` (K1-
compliant); upstream integration is a single marker-wrapped hook call in
`AppDelegate.applicationDidFinishLaunching`.

## How to use

- **Open**: press Shift twice within ~300 ms. Respects an exclusion list
  so Rider / Xcode / VS Code native Shift-Shift keeps working (see
  `QuickActionSettings.defaultExcludedBundleIdentifiers`).
- **Run a template**: type to filter → ↑/↓ → Enter. Launches headless,
  appears in the Runs tab with `triggerReason = "quickAction"`.
- **Free prompt**: type your prompt → select the trailing "Run as free
  prompt" row → Enter. Launches against the LRU-remembered default
  template with `triggerReason = "quickAction.freePrompt"` and the
  user-typed text as `promptOverride`.
- **Advanced**: ⌘↵ or Tab opens the inline pane — permission picker,
  variable form, prompt editor. Tab again or Esc closes it; Esc with the
  pane closed hides the palette.

## Data flow (what Enter actually does)

1. `QuickActionView.onSubmit` → `QuickActionViewModel.submit()`.
2. ViewModel picks the selected row, computes the effective permission
   (`bypassPermissions` unless advanced is open), and calls
   `QuickActionRunResolver.resolve(template:targetWorkspaceId:...)`.
3. Resolver builds a fully-populated `AgentRunRequest` (all 11 fields
   `AgentRunner` reads). Its contract:
   - Workspace target → uses workspace's `termLoopSpawnCwd()`; falls back
     to the resolved `repoRootPath` if the workspace has no cwd of its
     own. `repoRootPath` priority: workspace metadata's `projectId` →
     `ProjectStore.activeProject.folderPath` → workspace cwd → process
     cwd.
   - Root target (No workspace) → `ProjectStore.activeProject.folderPath`
     as both `workspaceCwd` and `repoRootPath`. Throws
     `QuickActionError.noCurrentProject` when no project is active.
   - Auto-fills `branch_name` / `workspace_path` / `repo_name` for
     templates that declare them. Missing declared variables throw
     `QuickActionError.variablesRequired([names])` so the view auto-opens
     the advanced pane with a row for each.
4. `AgentEngine.shared.runner.start(request)` — same headless path as §3
   in `AgentSystem.md`. Run lands in `AgentRunStore`.
5. LRU updates: template moves to front of `templateOrder`; advanced
   memory (permission + variable values) persists per template id (or
   under `__free_prompt__` sentinel for free-prompt runs).

## Defaults worth knowing

| Concern | Default | Where |
|---|---|---|
| Permission mode | `bypassPermissions` (any template, any run) | `QuickActionViewModel.buildRequest` |
| Target workspace | Currently-selected tab at open time | `QuickActionController.present` |
| Project dir fallback | `ProjectStore.activeProject.folderPath` | `QuickActionRunResolver.resolveRepoRootPath` |
| Trigger reason (template row) | `"quickAction"` | `QuickActionRunResolver.freePromptTriggerReason`'s sibling constant |
| Trigger reason (free-prompt row) | `"quickAction.freePrompt"` | same file |
| Double-shift window | 300 ms (clamped 100–2000) | `QuickActionSettings.doubleShiftWindowMs` |

## Active Agents inline viewer

Clicking an active run in the sidebar (`ActiveAgentsPanel`) opens the
log in place of the Ghostty terminal — see
[`UILayout.md`](UILayout.md) for the swap mechanism. This replaces the
old `.sheet(item:)` behavior: the sheet used to render behind the
window-level terminal portal, leaving Ghostty on top.

## Settings

`termloop/Sources/TermLoop/UI/TermLoopSettingsView.swift` renders a
dedicated **Quick Action** section with:

- Enable/disable toggle (`quickAction.enabled`).
- Accessibility status + "Grant…" button. Without Accessibility,
  Double-Shift only fires when cmux is frontmost (local `NSEvent`
  monitor); with it, the global monitor catches events while other apps
  are frontmost.
- Default template for free prompts.
- Double-shift window (ms, stepper).
- Excluded bundles (read-only count; edit list via UserDefaults).
- Reset LRU button (`QuickActionLRUStore.resetAll`).

State lives in plain `UserDefaults` keys under `termloop.quickAction.*`
— deliberately **not** round-tripping through `settings.json` in v1
because `CmuxSettingsFileStore`'s parser is in an upstream file (K1/K2
rules forbid adding parse methods there). v2 would add an TermLoop-side
parser hook.

## Hotkey detection

`DoubleShiftDetector`:

- Installs `NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged)`
  only when `AXIsProcessTrusted()` is true. Otherwise falls back to the
  local monitor only.
- Pure state machine: idle → sawFirstDown(t0) → sawFirstUp(t0) → fire.
  Any non-shift modifier (⌘⌥⌃) appearing during the sequence resets.
- Never consumes events — local monitor returns the event unchanged so
  downstream views still receive modifier state.

## Source layout

```
termloop/Sources/TermLoop/UI/QuickAction/
├─ QuickActionController.swift        // singleton lifecycle + install
├─ QuickActionPanel.swift              // NSPanel: borderless, nonactivating, canBecomeKey = true
├─ QuickActionView.swift               // SwiftUI root
├─ QuickActionViewModel.swift          // filter / LRU / submit orchestration
├─ QuickActionRow.swift                // template + free-prompt row views
├─ QuickActionAdvancedPane.swift       // permission + variables form
├─ QuickActionRunResolver.swift        // AgentRunRequest builder (see §3 contract)
├─ QuickActionLRUStore.swift           // UserDefaults-backed LRU + advanced memory
├─ DoubleShiftDetector.swift           // global + local NSEvent monitor
└─ QuickActionSettings.swift           // UserDefaults keys + defaults
```

Shared helper:

- `termloop/Sources/TermLoop/UI/Agents/AgentRunDisplay.swift` —
  `primaryLabel(for: AgentRun)`: free-prompt runs render
  `"✏️ <prompt snippet>"`, other runs render the template name. Used by
  every row surface that previously read `templateId` directly.

Hook:

- `TermLoopHooks.installQuickActionHotkey()` — called from
  `AppDelegate.applicationDidFinishLaunching` inside a `// MARK:
  termloop-hook` marker block.

## Extending

- **New trigger type** (e.g., double-Space): extend
  `DoubleShiftDetector` to be a generic chord detector, add enum cases
  to a new `QuickActionSettings.trigger` key, switch on it in
  `QuickActionController.install`.
- **Terminal-mode launches from the palette**: spec §12 marks this
  deferred. Wire a `RunMode` segmented control into the advanced pane,
  persist it in `QuickActionAdvancedMemory`, and route `.terminal` to
  `TerminalAgentRunner.spawnClaude(...)` (see `TerminalAgentRunner.md`)
  instead of `AgentEngine.shared.runner.start(...)`.
- **Socket/CLI expose** (for mobile): add `quickAction.trigger`,
  `quickAction.lru.*` methods to the v2 socket NDJSON pipeline. No
  TermLoop-side state change needed; the resolver is already pure and
  headless-runs-compatible.

## Gotchas

- **Accessibility prompt timing**: we never call `AXIsProcessTrusted
  WithOptions(prompting:true)` automatically; only the Settings
  "Grant…" button opens System Settings. Auto-prompting on every cold
  start is obnoxious.
- **Root-scope template trap**: templates with `scope: .workspace`
  can't run with "No workspace (root)" target. Resolver throws
  `workspaceScopeRequiresTarget`; view disables those rows with a
  tooltip when the pill is on root.
- **LRU stale ids**: deleted templates stay in `templateOrder` until the
  next mutation. `QuickActionLRUStore.orderedTemplateIds(registered:)`
  filters against current registry on every read so UI stays clean.
