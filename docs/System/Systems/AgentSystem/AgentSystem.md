# AgentSystem

Project-level reference for every AI-agent-related subsystem TermLoop adds
on top of termloop. If you are adding a new feature that involves agents,
prompts, or terminal text injection, this is the doc to read first.

## 1. Abilities (project-specific AI instructions)

Markdown files under `<projectRoot>/.termloop/abilities/<slug>.md` with YAML
frontmatter. Each file tells the AI how to approach a class of task in this
repo. An `activation` field controls injection behavior.

### Data model

```markdown
---
name: Systematic Debugging
description: Use when chasing bugs, test failures, or unexpected behavior.
activation: listed
---

<body - project-specific rules, commands, conventions>
```

| Field | Values | Effect |
|---|---|---|
| `name` | string | Sidebar row title |
| `description` | string | Shown to the AI when an ability is `listed` |
| `activation` | `always` | Body injected on every run |
| | `worktree` | Body injected only for worktree-backed runs |
| | `listed` | Name + description shown so the AI can choose to read the file |
| | `off` | Hidden from the AI entirely |

The `id` is the filename without extension (kebab-case). Rename is a file
rename on disk.

### How it flows into an agent run

When any agent run starts on this project, `AbilityInjector.buildContext`
reads the current abilities, filters by activation and worktree-ness, and
returns a `<system-reminder>` block. `AgentRunner` prepends that block to
the first user prompt - ephemeral, not persisted, so toggling an
activation takes effect on the next run.

### Source layout

| Concern | Code |
|---|---|
| Data model + parser | `termloop/Sources/TermLoop/Core/Abilities/Ability.swift`, `AbilityFrontmatter.swift` |
| On-disk store + file watcher | `termloop/Sources/TermLoop/Core/Abilities/AbilityStore.swift` |
| Prompt context builder | `termloop/Sources/TermLoop/Core/Abilities/AbilityInjector.swift` |
| Agent run injection site | `termloop/Sources/TermLoop/Agents/AgentRunner.swift` |
| Sidebar panel UI | `termloop/Sources/TermLoop/UI/Abilities/AbilitiesPanel.swift`, `AbilityRow.swift` |
| Bundled creator / refiner prompts | `termloop/Sources/TermLoop/Core/Abilities/AbilityPrompts.swift` |

### Lifecycle

- **First run on a project** - `.termloop/abilities/` does not exist; the
  panel shows `Abilities (setup)` and a "Click to set up" CTA. Clicking
  creates the directory and launches the creator agent via
  `TerminalAgentRunner.spawnClaude` (see section 2).
- **Ongoing** - edits on disk are picked up by
  `DispatchSourceFileSystemObject`; the sidebar refreshes without an app
  restart.
- **Agent runs** - `AbilityInjector.buildContext` contributes a
  `<system-reminder>` block or nothing (if no eligible abilities).

## 2. Terminal agent runner (`TerminalAgentRunner`)

The one place the app uses for any pattern that spawns a new cmux workspace
and sends it a command - especially interactive `claude` sessions with an
initial prompt. Covered in detail in
[`TerminalAgentRunner.md`](TerminalAgentRunner.md).

Two public entry points:

- `TerminalAgentRunner.spawnClaude(tabManager:title:cwd:permissionArg:initialPrompt:bootstrapInstruction:featureId:)`
  - opens a workspace and runs `claude --permission-mode <arg>
  '<bootstrap>'`. The full `initialPrompt` is written to a temp file; the
  bootstrap sentence tells claude to read it.
- `TerminalAgentRunner.spawnShell(tabManager:title:cwd:shellCommand:featureId:)`
  - opens a workspace and runs any shell command. Used by the BMAD skill
  launcher (`claude /<skill>`) and anywhere else that wants "new
  workspace, run this command, leave the user at the shell prompt when
  the command exits".

Current callers:

| Caller | Entry point | Command |
|---|---|---|
| `AbilitiesPanel.spawnAgentWorkspace` | `spawnClaude` | `cd ... && claude --permission-mode bypassPermissions '<creator bootstrap>'` |
| `AgentOneOffDialog.runInTerminal` | `spawnClaude` | `cd ... && claude --permission-mode <tpl> '<template bootstrap>'` |
| `TermLoopSidebar.Root.launchBMADWorkspace` | `spawnShell` | `claude /<skill-id>` (BMAD skill) |

## 3. Headless agent runs (`AgentEngine` + `AgentRunner`)

Distinct from the terminal-agent runner. When an agent should run in the
background with structured output (not in a live REPL), the flow is:

- UI or socket caller builds an `AgentRunRequest` (template + override
  prompt + cwd + variable values + permission override).
- `AgentEngine.shared.runner.start(request)` resolves the prompt, runs
  `AbilityInjector.buildContext` to prepend the abilities block, then
  spawns `claude -p <prompt> --permission-mode <mode> --output-format
  stream-json --verbose` through `AgentSpawner` (`Process()` with explicit
  argv - no shell involvement).
- Output is parsed as stream-json and written to the run's log. The UI
  (AgentRun log viewer) follows live.
- The run is persisted in `AgentRunStore` and attached runs show up in
  the Active Agents panel.

Source: `termloop/Sources/TermLoop/Agents/AgentEngine.swift`,
`AgentRunner.swift`, `AgentSpawner.swift`, `TemplateRegistry.swift`,
`AgentSocketCommands.swift`.

Use this path when you want logs, no UI of a live terminal, and a
structured run record. Use `TerminalAgentRunner` when you want the user
to see and talk to claude live.

## 3a. Quick Action palette (Shift-Shift launcher)

Raycast-style palette for one-keystroke headless agent runs. See
[`QuickAction.md`](QuickAction.md) for full detail. Short version:

- Trigger: Shift twice within ~300 ms, respecting a per-app exclusion list.
- Builds an `AgentRunRequest` via `QuickActionRunResolver` and calls
  `AgentEngine.shared.runner.start(...)` - same code path as section 3 headless
  runs. Runs land in the existing `AgentsSidebarView` **Runs** tab.
- Default `permissionMode` is `bypassPermissions` - the palette is for
  "just do the thing" launches; advanced pane lets the user pick stricter
  per run.
- Free-prompt runs get `triggerReason = "quickAction.freePrompt"` so row
  UIs render the prompt snippet instead of the resolved template name
  (`AgentRunDisplay.primaryLabel(for:)`).
- Workspace layer hide-to-reveal viewer is documented in
  [`UILayout.md`](UILayout.md) - the Active Agents click path replaces the
  Ghostty surface with `AgentRunDetailView` using the same pattern as BMAD.

## 3b. Agent loops (scheduled template reruns)

Recurring headless template execution lives in
[`TermLoops.md`](TermLoops.md).

Short version:

- `TermLoopStore` persists loop definitions at
  `~/Library/Application Support/cmux/termloop/loops.json`.
- `TermLoopEngine` is the runtime scheduler. It ticks every second,
  dispatches eligible loops, and tracks one in-flight run per loop.
- Execution still goes through the normal headless path from section 3:
  loops resolve an `AgentRunRequest` and start through `AgentRunner`.
- Loop definitions persist across restart, but active in-flight runtime
  state does not.
- UI surfaces are split between the sidebar `Loops` tab and the main-area
  `AgentWorkspacePage` operational view.

Do not confuse this with [`AgentBridge.md`](AgentBridge.md):

- TermLoops reruns one template on a schedule
- AgentBridge relays messages between two live workspaces

## 4. Text-injection patterns (where do text bytes go into a terminal)

There is more than one way to send text into a cmux terminal surface.
Pick the right tool for the situation - see the catalog in
[`TerminalAgentRunner.md`](TerminalAgentRunner.md) under "Patterns
catalog".

Short version:

- New workspace + shell command -> `TerminalAgentRunner.spawnShell` /
  `spawnClaude`.
- Existing workspace + text -> upstream `AppDelegate.sendTextWhenReady`
  (NotificationCenter-driven with polling fallback; currently `private`,
  so TermLoop-side code duplicates a lighter polling helper until the
  visibility opens up).
- Socket-origin text injection (`surface.send_text`) -> raw `sendText`
  inside the socket handler; the caller guarantees the target panel is
  live.
- Never: multi-step `sendText("claude\n")` + hardcoded `Task.sleep` +
  `sendText(prompt)`. Use `TerminalAgentRunner.spawnClaude` instead.

## 5. Related infrastructure

- **Worktree rules** (`WorktreeRulesStore.swift`) - per-branch extra
  system-prompt injected as `--append-system-prompt` into headless runs.
- **Project metadata** (`ProjectStore`, `WorkspaceMetadataStore`,
  `FolderStore`) - identifies the active project / worktree / folder for
  any caller that needs it.
- **Shell quoting** (`TermLoopShell.quoteSingle`,
  `isSafeUnquotedIdentifier`) - use these whenever a user-supplied value
  is interpolated into a shell command.
- **UI layout / Ghostty swap** ([`UILayout.md`](UILayout.md)) - how the
  main content area swaps between Ghostty, BMAD overlay, Scratchpad
  editor, and the agent-run inline viewer. Read before adding any new
  full-bleed main-area view.

## Extending the system

- **New ability-like doc type** that AI agents should see automatically:
  copy the `AbilityStore + AbilityInjector` shape. Plain markdown with
  frontmatter under `.termloop/<yourdir>/`, a file-watching store, an
  injector that contributes to the first-prompt block.
- **New kind of interactive agent in a fresh workspace**: call
  `TerminalAgentRunner.spawnClaude` (for claude) or `spawnShell` (for
  anything else). Do not rebuild the polling/quoting logic.
- **New headless agent**: add a template to
  `Resources/TermLoop/BuiltinTemplates/` and spawn through
  `AgentEngine.shared.runner.start(...)`.
