# TermLoop agent rules

These rules apply to the whole repository. Read this file and the nearest local
`AGENTS.md` before editing. Source code, schemas, tests, and these local rules
are the implementation authority. A nested file may narrow these rules for its
boundary; it may not weaken a root invariant.

## Product model

- Project is the durable top-level product scope.
- Task has `open | closed` status and may have zero or one worktree. Creating a
  Task does not imply provisioning a worktree.
- Session is Project-scoped. Task presence and Active Agents are projections;
  Sessions are not children of Tasks.
- `Workspace`, `Run`, `Attempt`, durable Task history, stored `blocked`, and a
  stored Active Agent entity are retired concepts. Do not recreate them under a
  new name.
- Users may launch multiple write-capable agents in one worktree. Engineering
  file ownership is not a product write lease: never add launch gating, file
  locking, or agent-git serialization to enforce developer coordination.
- Pull requests are best-effort projections discovered from Git remotes.
  Provider and issue links remain sidecars; they do not add remote fields to
  core Task state.

## Working instructions

- The user request defines scope. The nearest local `AGENTS.md` defines the
  affected code boundary and its focused verification.
- Repository documentation is intentionally not maintained. Agents do not need
  a documentation preflight before coding.
- Do not create decision records, proposals, implementation plans, Task packets,
  completion dashboards, handoff documents, or documentation-only follow-ups
  unless the user explicitly asks for that artifact.
- When documentation disagrees with code, schemas, tests, or `AGENTS.md`, follow
  the executable sources and mention the mismatch briefly; do not pause the
  requested implementation to repair documentation.

## Git integration rules

- When the user says to merge a branch or completed work into `main`, perform
  the integration in the designated local `main` checkout first, then push
  that exact local `main` commit to `origin/main`. Locate the checkout with
  `git worktree list`; do not assume the current feature worktree owns `main`.
- Fetch the remote, merge the completed feature branch and current
  `origin/main` into local `main`, resolve conflicts there, and run the
  proportionate verification from that integrated state before pushing.
- Never substitute a direct refspec push such as `HEAD:main` or
  `<feature>:main`, and never report success after updating only remote `main`
  while the designated local `main` remains divergent.
- If the checkout designated for local `main` integration is currently on any
  branch and contains uncommitted tracked or untracked work, stage all of it
  and commit it directly to the branch currently checked out, without asking.
  Use a change-describing commit message; do not create an artificial
  preservation commit on `main`. Then switch that checkout to `main` and
  continue the integration. Never stash, discard, overwrite, or omit those
  local changes. Dirty local work alone is not a reason to pause for direction.
- After pushing, fetch if necessary and verify that local `main` and
  `origin/main` resolve to the same commit and that the local `main` checkout
  is clean. If another Git operation is already in progress, complete it safely
  when its intent is clear; stop for direction only when it cannot be resolved
  without risking local work.

## Legacy TermLoop reference

- The legacy app is available at
  `/Users/feritzcan/Projects/bmadworkflowtest/termloop` as an optional,
  read-only reference for visual UI and existing feature discovery.
- Consult it only when useful or when the user asks for comparison. Its
  architecture and domain model are not authoritative for TermLoop.
- Do not modify it unless explicitly requested, and never make TermLoop
  code or tests depend on that local path.

## Dependency and ownership rules

- Work only in paths needed by the user request. Preserve unrelated or
  pre-existing changes; never reset or overwrite another agent's work.
- One implementation agent owns a module or declared `core` sub-boundary at a
  time. Coordinate a cross-module change as separately reviewable slices.
- Changes to module ownership or DAG direction; authentication, authorization,
  credentials, process/filesystem/Git/destructive-action/renderer authority;
  durable-state lifecycle, migration, data-loss semantics, product invariants;
  and wire strategy, identity, framing, contract selection, or fallback-decoding
  policy may proceed when they are explicitly within the current user request.
  Mention the affected boundary and impact in the final response. No separate
  proposal or documentation step is required.
- Ordinary pre-v1 evolution of the active schema includes additive methods, DTO
  or projection fields, typed errors, enum values, validation constraints, and
  fixes. It requires schema-first generation, exact server/client rollout, and
  drift and behavior tests.
- Do not create `common/`, `shared/`, or `utils/`. Pure shared concepts belong
  in `domain`; OS primitives belong in `platform`; otherwise keep code with its
  owner.
- Generated source is never hand-edited. Change its schema or generator and
  regenerate it.
- Production code cannot depend on `spikes/**`.

## Cross-cutting invariants

- `core` is the sole durable state writer. Mutations are named commands, not
  generic setters or repository access from clients.
- PTY bytes use the binary terminal data plane, never JSON or base64. Control
  messages use the generated current contract.
- The daemon owns PTYs and processes. The desktop renders bytes; it does not
  spawn processes or gain arbitrary control-plane authority.
- TermLoop-generated prompts are visible versioned assets under
  `resources/prompts/`, compose through `invocation`, and reach launch only as a
  provenance-bearing payload. Direct user terminal input is not a generated
  prompt.
- Every TermLoop-controlled Claude, Codex, or future agent launch—including
  Project, Quick Action, Task, resume/restart, Companion, and agent-to-agent
  paths—must first resolve one invocation-owned launch manifest. The inspector
  and private execution payload are projections of that same manifest; no later
  layer may append prompt/system instructions, argv, environment, generated
  files, or initial input. All TermLoop-delivered facts are inspectable, with
  secret/private values represented only by typed redaction. Provider-managed
  opaque prompts are explicitly labeled unobservable rather than inferred.
- Every TermLoop-generated terminal submission, now or in a future feature,
  must remain one immutable invocation-owned `GeneratedTerminalSubmission` and
  enter Core only through the shared `GeneratedInputDelivery` coordinator. This
  includes launch initial input, Project/Task/Quick Action and resume/restart
  input, Ask-To request/follow-up/final reply, handover and `send_to_agent`, Task
  assignment, Steward/Companion/Worker messages and wakes, and every equivalent
  future path. Feature handlers, server composition, clients, and provider
  adapters must never call terminal input-sequence or receipt-bearing atomic
  write primitives for generated content; only
  `core::runtime::generated_input_delivery` may orchestrate those primitives.
- Generated delivery is not fire-and-forget: paste write/flush receipt,
  terminal settlement, user-input-safe submit, and a newer same-runtime provider
  submission are separate evidence. Enqueue or transport receipt is never
  `delivered`. Do not restore fixed paste-to-Enter delays, content replay, or
  automatic Enter retry. Ambiguous outcomes remain visible and recoverable as
  unconfirmed states; delivery-dependent state clears only on attributed
  confirmation. Runtime delivery state and telemetry stay bounded, non-durable,
  epoch-scoped, and typed-redacted. Direct user terminal input and explicit
  headless terminal-protocol replies are not generated submissions.
- Daemon OS conditionals, process/filesystem primitives, path normalization,
  credentials, clocks, and randomness belong to `platform`. Disposable spikes
  are isolated exceptions.
- Every persistent Steward launch resolves invocation's visible
  `bypassPermissions` mode. Workers and ordinary Agents do not inherit it.
- Companion is a separate capability-scoped process. It reads projections and
  maintains conversation demand but has no direct domain, filesystem, Git,
  provider, credential, or mutation access. The authenticated persistent
  Steward Session is a distinct Project-scoped PM authority: its closed MCP
  profile may invoke the named Task commands, use the same-Project atomic Task
  Agent start (deterministic managed worktree, inspected launch or reuse, and
  assignment delivery), and send one
  invocation-composed visible message to an ordinary
  running Project Agent. It may also replace only its own
  Project-scoped editable instructions when Core proves the cited exact newest
  Companion message is user-authored. It must first read the complete current
  editable value, preserve every unaffected instruction, and submit that exact
  source value with the complete modified document; Core rejects a stale source.
  A real change retires the exact Steward Session and relaunches through the
  same inspected manifest path. Every
  replacement launch retains invocation's visible built-in
  runtime/safety layer so editable instructions cannot erase chat wake and reply
  behavior.
- Durable state is current state, not event sourcing or product history.
  Operational telemetry is bounded and disposable.
- Cleanup is explicit and fail-closed. Close, cleanup, stale resolution, and
  delete remain different commands. Never delete a checkout when ownership/path
  safety cannot be proven. The sole exception is an explicitly acknowledged
  stale-disposal command for either an exact Task-recorded orphaned
  directory with its managed tuple or a generation-zero legacy binding freshly
  proven to be the Task branch's exact registered checkout. Protected-path,
  repository-registration, Session, Task-tuple, and leaf-identity gates must
  pass; the UI must describe stale contents as unverified.
- Secrets never enter durable state, logs, reports, URLs, argv, renderer globals,
  or generated evidence.

## CROSS PLATFORM

- macOS, Linux, and Windows are release gates. A local build or cross-compile is
  not runtime proof; PTY, path, process, and packaging changes need native CI
  evidence on every affected host.
- Keep OS branching in `platform`. On Windows, persist comparable drive-form
  canonical paths, opt Git into long paths, and pass filesystem arguments
  through the platform subprocess-path helper; never compare raw verbatim
  (`\\?\`) paths with Git output.
- Headless terminal fixtures must emulate terminal protocols with bounded
  waits and answer `ESC[6n` with `ESC[1;1R`. Route generated paste bytes through
  the platform encoder: Windows ConPTY uses unframed content plus delayed Enter;
  Unix PTYs use `ESC[200~...ESC[201~` bracketed-paste framing.
- macOS release apps are universal: build both Rust targets, combine native
  binaries with `lipo`, build universal Ghostty, package with
  `package --universal`, and verify the final bundle with `codesign`.
- Build and publish from one immutable commit/tag only after all three native
  jobs pass. Keep CI intermediates short-lived; durable downloadable binaries
  belong to the GitHub Release, not Actions artifact storage.

## Change protocol

- Before extending a production file beyond roughly 1,000 non-test lines or
  adding a second independently changing responsibility, assess an intra-module
  split and record the outcome as a separate refactor slice rather than
  splitting inside the current behavior change. Keep cohesive state machines
  and invariant enforcement together, and never mix a mechanical split with
  behavior, schema, contract, ownership, or DAG changes.

1. Read the nearest local rules and inspect the affected code and tests.
2. Implement the requested change directly, within one module boundary when
   possible.
3. Add or update focused tests for the behavior and invariants touched.
4. Do not create or edit repository documentation unless the user explicitly
   requests documentation work.

## Verification and handoff

- Agents start persistent development app instances through
  `tools/dev/termloop-dev start --checkout <path> --tag <feature>`. Feature tags
  are branch-independent and keep agent restarts away from the human-owned
  `main` instance. Agents must never start, restart, or stop the `--main`
  profile, even when validating work intended for `main`; that profile is
  human-owned. Always run and validate through the agent's own stable
  `--tag <feature>` profile. The launcher owns isolated state/runtime/Electron
  profiles and scoped restart behavior.
  On macOS it hands process ownership to a profile-scoped LaunchAgent; never
  wrap it in `nohup`, keep an agent exec cell open, run Electron directly, or
  report success from the launcher's exit code alone. Confirm
  `tools/dev/termloop-dev status --checkout <path> --tag <feature>` reports
  `Supervisor: ready` and `Build: current`, then use the reported
  daemon/desktop PIDs as evidence. `start` waits for Electron's PID-bound ready
  marker after the real BrowserWindow loads and then attempts exact-window
  activation; missing macOS Accessibility permission is a visible warning, not
  a reason to destroy an otherwise healthy app.
  Use `restart` after rebuilding changed production code and `stop` only for the
  exact same checkout/tag profile.
  Multiple tags for one checkout are intentionally allowed and remain isolated;
  use one stable tag per Task/feature. For an unavailable/deleted checkout, use
  `tools/dev/termloop-dev list` and then
  `tools/dev/termloop-dev stop-profile --profile <exact-profile>`.

- For small changes confined to one module, do not run repository-wide
  `pnpm check` or `pnpm test`. Run only the checks required by the nearest
  local `AGENTS.md`, the directly affected tests, and the affected package's
  type-check when applicable.
- Run repository-wide checks only when the change affects multiple modules,
  schemas, generated code, platform behavior, or shared build configuration,
  or when the user explicitly requests them.
- The full suite is CI's responsibility before merge or release. If the full
  suite was not run locally, state that explicitly in the final response along
  with the narrower checks that were run.
- Do not rerun an unchanged broad check on the same commit unless files relevant
  to that check have changed since its successful result.
- Do not claim cross-platform, latency, security, or recovery behavior from a
  type-check or a hardcoded report label. Record skipped and unmeasured cases.
- The final response states changed paths, commands run, results, remaining
  risks, and material assumptions. "The agent says it works" is not evidence.
