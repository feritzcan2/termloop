# TerminalAgentRunner

Single entry point for "open a new cmux workspace and run a command in its
shell". The primary use case is starting an interactive `claude` agent
with an initial prompt pre-loaded; a generic shell variant handles
everything else (BMAD skills, custom one-offs, etc.).

## Why this exists

Starting `claude` and handing it an initial prompt inside a cmux terminal
panel seems straightforward but is surprisingly easy to get wrong. Every
call site that rolled its own approach ended up with the same three bugs.

### The old pattern (removed)

```swift
panel.sendText("claude --permission-mode bypassPermissions\n")  // 1
try? await Task.sleep(nanoseconds: 1_500_000_000)                // 2
panel.sendText(resolvedPrompt)                                   // 3
try? await Task.sleep(nanoseconds: 120_000_000)                  // 4
panel.sendText("\r")                                             // 5
```

What goes wrong:

1. **Race with claude's REPL boot.** The 1.5 s wait is a guess. On a slow
   machine or with a slow shell startup, claude hasn't attached to the
   tty yet when step 3 fires — the prompt bytes stream into the
   still-alive shell.
2. **Shell parsing.** If step 3's text ever touches the shell, markdown
   and YAML break it: `<` / `>` become redirections, backticks become
   command substitution, multi-line content triggers the zsh continuation
   prompt (`>....`).
3. **Silent failure.** There is no indicator in the UI that the prompt
   landed in shell instead of claude. The user sees scrolling garbage and
   assumes the feature is broken.
4. **Binary missing.** If `claude` is not on `PATH`, step 1 prints
   `command not found`, the shell returns to prompt, and the multi-line
   step-3 payload runs as a sequence of shell commands.

### The fix

Hand the shell **one** command line that both starts claude and provides
the initial prompt via claude's own CLI:

```
cd <quoted cwd> && claude --permission-mode bypassPermissions '<bootstrap>'
```

`claude`'s CLI takes a positional argument as the opening user turn in
interactive mode (`claude --help`: `Usage: claude [options] [command]
[prompt]`). So the sequence is:

1. Shell parses the line and execs `claude` with the expected flags.
2. `claude` initializes its REPL.
3. `claude` reads its own positional arg and treats it as the first user
   message.
4. The REPL stays open for the user's follow-up replies.

No sleep, no racing, no leaked prompt bytes. If `claude` is missing from
`PATH`, the shell prints a single "command not found" line and stops —
our markdown never reaches the shell parser.

## API

Defined in `termloop/Sources/TermLoop/Agents/TerminalAgentRunner.swift`.
`@MainActor enum` with static methods; no state.

### `spawnClaude`

```swift
try TerminalAgentRunner.spawnClaude(
    tabManager: tabManager,            // from @EnvironmentObject
    title: "ability-creator",          // optional tab title
    cwd: project.folderPath,           // optional; used in cd + addWorkspace
    permissionArg: "bypassPermissions",
    initialPrompt: creatorPromptMarkdown,
    bootstrapInstruction: { url in
        "Read the file at \(url.path) and follow its instructions exactly to help me create a new project ability."
    },
    featureId: FolderStore.shared.activeFolderId
)
```

What it does:

1. Writes `initialPrompt` to `/tmp/termloop-terminal-agents/prompt-<uuid>.md`.
2. Calls `bootstrapInstruction(url)` to produce a short sentence pointing
   claude at that file.
3. Builds `cd <cwd> && claude --permission-mode <arg> '<bootstrap>'`
   (both the cwd and the bootstrap are single-quoted via
   `TermLoopShell.quoteSingle`).
4. Creates a new workspace with `tabManager.addWorkspace(…
   eagerLoadTerminal: true …)`.
5. Polls `workspace.focusedTerminalPanel` every 100 ms for up to 5 s;
   sends the command once the panel is writable.

### `spawnShell`

Same mechanics, no claude-specific parts. Caller supplies a ready shell
command string.

```swift
TerminalAgentRunner.spawnShell(
    tabManager: tabManager,
    title: "bmad/design",
    cwd: project.folderPath,
    shellCommand: "claude /bmad-design",
    featureId: FolderStore.shared.activeFolderId
)
```

`spawnClaude` is implemented on top of `spawnShell` — one polling
implementation, one workspace-creation call site.

## Current callers

| Caller | Which method | Purpose |
|---|---|---|
| `AbilitiesPanel.spawnAgentWorkspace` | `spawnClaude` | ability-creator / -refiner interview |
| `AgentOneOffDialog.runInTerminal` | `spawnClaude` | one-off agent template in a live terminal |
| `TermLoopSidebar.Root.launchBMADWorkspace` | `spawnShell` | BMAD skill launch (`claude /<skill>`) |

## Why the tempfile

The bootstrap text the shell command carries is one line. The *real*
prompt (a creator meta-instruction, a full template body, etc.) can be
many kilobytes of markdown with YAML and backticks. Putting that on a
shell command line is both a quoting nightmare and a length-limit hazard.

So: write the full prompt to a temp file first. The bootstrap line tells
claude to read that file:

> Read the file at /tmp/termloop-terminal-agents/prompt-<uuid>.md and
> follow its instructions exactly as the opening user turn of this
> session.

The shell command is now bounded in length, safe to quote, and the large
prompt travels through the filesystem where it cannot be reinterpreted.

## Patterns catalog — where else does text go into a terminal?

`TerminalAgentRunner` covers only the "new workspace + first command"
case. Other text-injection patterns exist in the codebase; use the
pattern that matches the situation rather than reaching for `sendText`
directly.

### 1. New workspace + first shell command → `TerminalAgentRunner`

Canonical. See above.

### 2. Existing workspace, send text to already-mounted terminal → `AppDelegate.sendTextWhenReady`

`termloop/Sources/AppDelegate.swift:7737`.

More sophisticated than `TerminalAgentRunner`'s polling helper — it
registers NotificationCenter observers on
`.terminalSurfaceDidBecomeReady`, `.terminalPanelsDidChange`, and window
focus events, with polling as a fallback. Used by app-level flows like
the welcome command, seeded workspaces, and the React-grab pasteback.

Currently `private`, so TermLoop code can't call it. If/when visibility
opens up, migrate `TerminalAgentRunner.sendCommandWhenReady` (the
private static helper) to call the upstream helper and delete the copy.

### 3. Socket-origin text injection → direct `sendText` in the socket handler

Examples:
- `TerminalController.swift:5730` (`surface.send_text` v2 socket method)
- `TermLoopSocketCommands.swift:407`
  (`workspace.spawn_claude_session` — single command line, already
  quoted, session id validated via `isSafeSessionId`).

The socket caller gives us a live `workspace_id` and we look up the
panel synchronously. No polling needed because we refuse the call if the
panel is absent.

### 4. Event-driven text delivery on surface ready → NotificationCenter

`termloop/Sources/Workspace.swift:960-979`. Some features need to fire
the text at the exact moment a newly-attached surface becomes ready (not
when a panel exists). Those register an observer on
`.terminalSurfaceDidBecomeReady`, send on the notification, and set a
3 s timeout fallback that just drops the command with a log if the
notification never arrives. This is the right choice when the caller is
already observing surface lifecycle events.

### 5. Test harness / smoke scaffolding → raw `sendText`

`TabManager.swift:6019–6025` and similar call `sendText` with
deterministic payloads (`printf` + marker strings) to set up visible
content in newly-created split panels. Legitimate because the tests
control the entire timing — not patterns to copy into product code.

### Anti-pattern — do not use

- Multi-step `sendText("claude …\n")` + hardcoded `Task.sleep` +
  `sendText(prompt)` + `sendText("\r")`. Both previous call sites
  (`AbilitiesPanel`, `AgentOneOffDialog`) have been migrated to
  `TerminalAgentRunner.spawnClaude`. Future features should go through
  the runner.

## Known limitations

- **Requires `claude` on PATH** in the interactive shell cmux spawns.
  Login shells pick up `nvm`/`asdf` shims; non-login shells may not.
  Headless `AgentRunner` resolves claude explicitly
  (`termloop/Sources/TermLoop/Agents/AgentRunner.swift:38-70`); the
  interactive path currently trusts the shell to find it.
- **Depends on claude CLI keeping the positional-arg behavior.** If a
  future release drops this, the fallback is to send the bootstrap via a
  second `sendText` shortly after the panel is ready — but that
  reintroduces the race. A better fallback is to keep the bootstrap in
  the shell command and let claude parse it regardless of mode.
- **Workspace outlives claude.** When claude exits (user runs `/quit` or
  errors) the user stays at the shell prompt. This is intentional — the
  explicit guidance at
  `Sources/TermLoop/UI/TermLoopSidebarRoot.swift:440-446` warns against
  `initialTerminalCommand` because Ghostty execs it as PID 1 and
  auto-closes the workspace when the child exits.

## Related code

- `workspace.spawn_claude_session` socket command
  (`termloop/Sources/TermLoop/Socket/TermLoopSocketCommands.swift:401-407`)
  — the single-shell-line precedent (`cd && claude --resume <id>\n`).
  `isSafeSessionId` guards the splice.
- `AgentRunner.spawner.spawn(...)`
  (`termloop/Sources/TermLoop/Agents/AgentRunner.swift`) — the
  **headless** counterpart. Uses `Process()` with explicit argv, no
  shell. Use this when the agent should run in the background with
  structured output instead of a live REPL.
- `AppDelegate.sendTextWhenReady`
  (`termloop/Sources/AppDelegate.swift:7737`) — upstream helper for
  sending to an already-mounted terminal; see §Patterns catalog above.
