# Desktop client agent rules

## Ownership

- Own the Electron shell, sandboxed renderer, xterm.js rendering, project/task
  views, local pane/layout state, generated control client, and binary terminal
  client.
- This is a thin projection and interaction surface, not a second domain model.
- Project checkout summaries, changed-file lists, diffs, and pre-images come
  only from named generated reads; renderer code never observes Git or the
  filesystem directly.

## Dependencies

- Internal dependency: generated `contract` client only.
- No Rust domain/core/store modules, direct database/Git/filesystem/process access,
  daemon PTY ownership, provider secrets, or hidden prompts.
- Node filesystem/network/process APIs and OS branching live only in
  `src/platform/**`; CI enforces this through `CLIENT_PRIVILEGE` and
  `OS_CONDITIONAL_OWNER`.

## Invariants

- Keep `contextIsolation: true`, sandbox enabled, Node integration disabled, and
  a restrictive CSP. Prove these on the running window, not only with source regex.
- Preload exposes named, allowlisted operations rather than arbitrary method
  forwarding. The renderer never receives raw tokens or arbitrary spawn authority.
- Terminal attachment credentials stay in main/utility-process code. Renderer
  ports are capability-scoped and their queues use explicit bounded backpressure.
- PTY bytes use the binary data plane. xterm.js renders; it does not own the PTY.
- React owns presentation composition only. Transport, terminal lifecycle,
  renderer adapters, and daemon projection stores remain React-free.
- `renderer/ui/**` renders props and raises intents only; it never opens a socket
  or imports `transport/` or `terminal/`. `renderer/composition/` is the single
  wiring seam, enforced by `UI_TRANSPORT_SKIP`.
- Read-only Git changes render only bounded generated-contract patches through
  the allowlisted `react-diff-view`; patches stay in memory and the
  overlay must not unmount terminal pane hosts.
- Full-file mode is an explicit user-requested addition to that surface, never a
  default. It expands the parsed patch only with pre-image content from the named
  generated worktree read, keeps content in memory, applies the same
  256 KiB/20,000-line bounds, and falls back to the change-focused diff with a
  stated reason on every refusal. The renderer's pre-image check catches only
  drift on lines the patch carries; it is not a freshness mechanism.
- Zustand imports are allowed only in `renderer/state/presentation-store.ts`.
  Daemon projections and transport state never use Zustand, and Zustand persist
  middleware is forbidden.
- xterm imports live only in the xterm renderer adapter. `TerminalPool` depends
  on a renderer-neutral surface contract so macOS Ghostty can be spiked later.
- Layout is client-local, references logical Session IDs, and caps at eight panes
  with one pane per Session. Closing a pane detaches; it never terminates.
- Layout restore never launches a process. Separately, one actual Electron
  process launch submits the accepted generated batch command on its first
  successful control subscription and retains that intent through initial
  connection failure; renderer reload/later reconnect must not create another.
  Missing Session references stay visible, and no screen restoration is
  promised.
- Task archive UI renders the daemon preview and dedicated archived list.
  Restore follows returned Session IDs through the existing inspected resume
  pipeline; it never infers Session ownership or starts a process from layout.
- Stale binding forget and separately acknowledged stale-folder disposal are
  composed only from named generated commands. UI renders typed gates and never
  gains direct filesystem authority.
- Combined Task/worktree delete is one bounded confirmation. Composition may
  retire Sessions and acknowledge the fresh exact core-declared content set
  without another prompt, but it never loosens hard/unknown core gates.
- Agent fork UI submits only the source logical Session ID and renders the
  core-owned `forkable` fact; it never receives provider conversation identity.
- Ask-To helpers may be nested visually only from the generated exact source
  Session projection, including after restart. Never infer that relation from
  cwd, names, order, templates, or terminal output, and never persist it as
  client layout ownership.
- Restart-safe Ask-To reply/follow-up routing remains daemon-owned. The desktop
  receives no continuation ID, request authority, bearer, or provider transcript.
- Agent launch inspectors render only the generated inspectable manifest. The
  client never reconstructs launch content, redacts a private payload, or
  independently derives argv/environment/delivery facts.
- MCP tool previews are reusable controlled presentation components. Description
  save/reset uses named generated operations; renderer state cannot widen tool
  identity, authority, schema, annotations, roles, or dispatch.
- Steward and Workers render as a Project Assistant hierarchy in the existing
  Shell. Their ordinary persistent Session terminals reuse TerminalPool and
  replace the stage in place; the renderer never launches a parallel assistant
  process or owns its MCP profile.
- Jira Task context is read-only generated projection data. The renderer may
  display it but cannot set, infer, replace, or treat it as Task authority.
- In a launcher-owned development profile, Electron main publishes only the
  invocation-supplied private runtime ready marker after the real BrowserWindow
  loads and removes it during graceful quit. The renderer receives neither the
  path nor filesystem authority; stale markers never establish readiness
  without the exact desktop PID/start-identity record.

## Verification

- Run `pnpm --filter @termloop/desktop check`.
- Run `pnpm --filter @termloop/desktop test`.
- For changes that affect the packaged application, run the relevant smoke
  command and manually verify terminal input, resize, focus, multi-terminal
  load, and daemon loss.
