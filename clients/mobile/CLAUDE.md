# Mobile client agent rules

## Ownership

- Own the Expo/React Native mobile presentation, injected client ports, mobile
  connection state, and binary terminal adapter.
- This is a thin Project/Task/Session/Active Agent client, not a second domain
  model.

## Dependencies

- Internal dependency: generated `@termloop/contract/current` only.
- No server internals, Rust modules, database, Git, filesystem, process,
  provider, or invocation implementation imports.
- Platform-specific presentation and credential adapters live under
  `src/platform/**` when introduced.

## Invariants

- Routes and UI consume injected ports; they do not open sockets, read secrets,
  or select authentication policy.
- Project, Task, Session, and Agent facts use generated projection DTOs.
- Presentation fixtures remain explicit mocks and never become durable truth.
- Terminal input/output is `Uint8Array` on the client boundary and never
  JSON/base64. Detach does not terminate.
- The initial client sends no terminal resize.
- Connection metadata and navigation are client-local. Credentials use the
  platform secure store and never enter logs, URLs, fixture data, or ordinary
  local storage. The owner-generated paste bootstrap provisions current-daemon
  credentials through an injected port; presentation never reads the parsed
  values.
- Do not introduce Workspace, Run, Attempt, board columns, or stored Active
  Agent entities.

## Verification

- Run `pnpm --filter @termloop/mobile check`.
- Run `pnpm --filter @termloop/mobile test`.
- Run `pnpm --filter @termloop/mobile export:ios` for packaged-app changes.
- Run `pnpm architecture:boundaries` after changing adapters or dependencies.

## TestFlight build numbers

- Every new iOS build number must be unique and numerically greater than all
  previously uploaded App Store Connect builds for the same marketing version.
  Check the highest existing build number, including older builds; do not rely
  only on the local config or the most recent upload date.
- Preserve the 14-digit UTC timestamp format `YYYYMMDDHHMMSS`. Never shorten it
  to a 12-digit timestamp, which sorts below existing 14-digit builds.
- Before uploading, verify that the archived app and all extensions use the
  configured build number and that it exceeds the highest existing build number.
