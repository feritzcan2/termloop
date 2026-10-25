# @termloop/pm — TermLoop PM desktop app

Electron + React app for the TermLoop Project Manager. It runs against
`apps/pm-daemon` (`termloop-pm-daemon`) through the generated
`@termloop/pm-contract` client. It does not depend on `@termloop/contract`,
`modules/core`, or the TermLoop server.

## Commands

- `pnpm --filter @termloop/pm check` — builds the internal packages, then `tsc --noEmit`.
- `pnpm --filter @termloop/pm test` — builds, then runs vitest (`test/`).
- `pnpm --filter @termloop/pm build` — esbuild into `dist/`.
- `pnpm --filter @termloop/pm smoke` — builds and runs `electron . --smoke`: spawns
  the daemon in temporary runtime/state directories, calls `pm_system_version`
  through `window.pm`, checks a non-allowlisted method is refused, and exits 0.
- `pnpm --filter @termloop/pm start` or root `pnpm pm:dev` (also runs
  `cargo build -p termloop-pm-daemon`).

The daemon binary resolves from `TERMLOOP_PM_DAEMON`, then `resources/daemon/`
when packaged, then `<checkout>/$CARGO_TARGET_DIR|target/debug/`.

## Ownership

- `src/main.ts` — window, IPC registration, daemon/control/terminal wiring, smoke.
- `src/main/` — Electron-free main logic: `daemon-lifecycle.ts` (supervisor,
  discovery parsing), `control.ts` (generated client + event subscription
  socket), `terminal-bridge.ts` (terminal wire socket, credit backpressure),
  `ipc.ts` (renderer allowlist, sender and URL checks).
- `src/platform/` — the only place for `node:child_process`/`node:fs` and
  `process.platform` (daemon spawn, binary resolution, smoke directories).
- `src/preload.ts` + `src/pm-api.ts` — the `window.pm` surface and its types.
- `src/renderer/composition/` — the wiring seam: `PmController` (UI intents →
  `window.pm` calls → store) and `PmApp`.
- `src/renderer/state/presentation-store.ts` — the one Zustand store.
- `src/renderer/terminal/` — xterm adapter over `window.pm.terminal`.
- `src/renderer/ui/` — React components; contract types only.

## Invariants

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; window
  open and navigation are denied. Every IPC handler checks the sender is the
  PM window's main frame.
- The renderer reaches the daemon only through `window.pm.call`, restricted to
  `RENDERER_METHODS` in both preload and main (`pm_subscribe`/`pm_cancel` are
  main-only). Tokens and discovery stay in main; the terminal bridge relays
  frame payloads only.
- `renderer/ui` never imports transport, terminal, or the bridge; composition
  injects callbacks and `mountTerminal`.
- The Jira API token is write-only: the settings field is a password input that
  starts empty and clears after save; the controller sends it to
  `pm_credential_store` and passes only the handle to `pm_sources_set`.
- Agent output is a draft. Proposals change a ticket only on Accept
  (`pm_ticket_proposal_accept`); Jira is written only from the "Write to Jira"
  dialog's Apply with the token of the diff on screen. A `stale` result shows
  the new diff instead of retrying.
- Tier gating: stage/PR pills need tier ≥ `code`; "Where it runs is unknown"
  needs tier `deploy`. Deploy tracking has no switch; it is on when an
  environment or an approved probe exists.
