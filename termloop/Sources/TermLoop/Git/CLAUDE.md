# Git infrastructure

Central git invocation, presentation stores, and invalidation pub/sub. UI
panels and feature code do not shell out to git themselves — they call
`GitCommandRunner` and read the presentation stores in this folder.

---

## Use GitCommandRunner

Call `GitCommandRunner.runThrowing(_:in:kind:caller:timeout:)` for reads or
`runMutation(_:in:kind:caller:invalidates:timeout:)` when the command writes.
Don't spawn git via `Process()` directly. Reasons:

- **Optional locks off for reads.** Read kinds (status, diff, branch,
  revParse, remote, history, genericRead) inject `GIT_OPTIONAL_LOCKS=0` and
  prepend `--no-optional-locks`. Read commands never contend with a concurrent
  `git add`/`commit`/PR script.
- **Bounded drains.** stdout/stderr drains have a per-call timeout (1–5s); a
  stuck child cannot freeze the app.
- **No terminationHandler race.** The handler is set before `process.run()`,
  so fast-exiting children never deadlock the wait.
- **Mutation invalidation.** `runMutation` broadcasts to
  `GitPresentationInvalidationCenter` with the right `GitInvalidationTarget`s
  so the UI refreshes without manual prodding.
- **Telemetry.** Every call carries a `caller` string used by the
  `com.termloop.git:*` log subsystems for triage.

Pick the right `CommandKind`. The runner classifies if you pass nil, but
explicit is better when you know.

## Pipe rules for raw `Process()`

Sometimes a non-git tool (`lsof`, `gh`, `az`, `git credential fill`) needs a
raw `Process()`. Follow these or you reintroduce the hangs we just paid
for:

- **Close parent write ends right after `try process.run()`.** Otherwise
  `readDataToEndOfFile` waits forever for an EOF that already happened on the
  child side. Same for stderr.
- **Use `FileHandle.nullDevice` for streams you don't read.** Don't attach a
  `Pipe()` you never drain — the 64 KB pipe buffer fills, the child blocks
  writing, your wait blocks reading.
- **Set `terminationHandler` BEFORE `run()`.** Foundation's `Process` will
  silently miss the handler if the child exits before you assign it, and your
  semaphore will never signal.
- **Bound every wait.** `semaphore.wait(timeout:)` or
  `group.wait(timeout:)` plus a fallback close. No bare `wait()`.

`GitHostAuthResolver.runCommand` is the canonical example following all four
rules. Copy that shape when `GitCommandRunner` doesn't fit.

## Never block the main thread on git

Restore, startup, terminal-surface creation, and SwiftUI body code must not
shell out to git, even via `GitCommandRunner`. A stuck git process freezes
the entire app for as long as the wait runs. We've shipped this regression
twice — don't ship it a third time.

For path resolution from the main actor:

- Use `WorkspaceMetadataStore.Metadata.worktreePath` as the physical checkout
  source. `WorktreeResolver.path(projectFolder:branch:)` +
  `FileManager.fileExists` is only the pure fallback for legacy metadata or
  new worktree creation. No subprocess.
- For "what branch is this checkout on?" read `.git/HEAD` directly.
  `TermLoopWorktreeBindingResolver.currentBranchWithoutGit` shows the shape
  — handles both `.git` directories and `.git` files with `gitdir:`
  redirects.

If you genuinely need git output for a UI decision, do it on a background
queue and update presentation state asynchronously. The presentation stores
in this folder already follow that pattern.

## Worktree path convention

Worktrees live at `<project>/.termloop-worktrees/<sanitized-branch>/`.
`WorktreeCoordinator` is the only writer. Once a workspace is attached,
persist the real path in `WorkspaceMetadataStore.Metadata.worktreePath` and
read that everywhere. Branch names are logical identity; they are not the
source of truth for reused folder names.

## Auth ladder

`GitHostAuthResolver` resolves credentials in order: `gitCredential` →
`azCLI` (ADO, 240s cache TTL, per-org scope) → `ghCLI` (GitHub, 300s cache
TTL) → PAT. Don't add new direct calls to `gh` / `az` / `git credential
fill` from feature code; route through the resolver so caching, timeouts,
and the `auth.*` log subsystem stay consistent.
