# Desktop client agent rules

## Ownership

- Own the Electron shell, sandboxed renderer, xterm.js rendering, project/task
  views, local pane/layout state, generated control client, and binary terminal
  client.
- This is a thin projection and interaction surface, not a second domain model.
  Every fact (Git changes, Sessions, launch manifests, Jira context) comes from
  named generated reads; every mutation goes through named generated commands.

## Dependencies

- Internal dependencies: generated `contract` client and the renderer-only
  `terminal-surface` package.
- No Rust modules, direct database, Git, filesystem, or process access, daemon
  PTY ownership, provider secrets, or hidden prompts.
- Node filesystem/network/process APIs and OS branching live only in
  `src/platform/**` (CI: `CLIENT_PRIVILEGE`, `OS_CONDITIONAL_OWNER`).

## Invariants

- Keep `contextIsolation: true`, sandbox enabled, Node integration disabled, and
  a restrictive CSP.
- Preload exposes named, allowlisted operations only. The renderer never
  receives raw tokens or spawn authority.
- PTY bytes use the binary data plane. xterm.js renders; it does not own the PTY.
- `renderer/ui/**` renders props and raises intents only; it never imports
  `transport/` or `terminal/`. `renderer/composition/` is the single wiring
  seam (CI: `UI_TRANSPORT_SKIP`).
- Zustand only in `renderer/state/presentation-store.ts`, never for daemon
  projections, and no persist middleware.
- xterm imports live only in the xterm renderer adapter.
- Layout is client-local and caps at eight panes. Closing a pane detaches;
  layout restore never launches a process.
- Never infer relationships (Ask-To nesting, Session ownership) from cwd, names,
  order, or terminal output; render only what the daemon projects.

## Verification

- Run `pnpm --filter @termloop/desktop check`.
- Run `pnpm --filter @termloop/desktop test`.
