# terminal-app — Context

Thin React Native (Expo) client for TermLoop. Pairs with the desktop app
via QR, talks to it over newline-delimited JSON on a raw TCP socket.

## What lives here

| Path | Role |
|---|---|
| `app/_layout.tsx` | Expo Router stack + global header/back style |
| `app/index.tsx` | Connection list — primary CTA: Scan pairing QR |
| `app/connections/scan.tsx` | Live camera QR scanner + paste fallback |
| `app/connections/new.tsx` | Manual setup (fallback only) |
| `app/connected/index.tsx` | Server / current project / workspaces overview |
| `app/connected/terminal.tsx` | Workspace surface read/send |
| `lib/termloop-client.ts` | Typed RPC envelope, `TermLoopClient` interface, `parsePairingPayload`, `RpcCallError` |
| `lib/tcp-transport.ts` | `TcpTransport` — NDJSON over TCP via `react-native-tcp-socket` |
| `lib/session.ts` | Module-scope active session (one connection at a time) |
| `lib/connections.ts` | AsyncStorage-backed `SavedConnection` catalog |
| `lib/theme.ts` | Colors + mono font — single source for dark theme |

## Invariants (do not break)

1. **Scope is `terminal-app/` only.** Backend (`termloop/`) is owned by
   another track. If a fix needs a backend change, write it up here as a
   pending item and stop — do not edit `termloop/`.
2. **QR pairing is the primary flow.** Manual setup is fallback. Do not
   surface manual setup as the main CTA, do not promote it visually.
3. **Real transport only in normal flow.** `TcpTransport` is the single
   transport selected by `lib/session.ts → openSession`. There is no mock
   path in production code; do not reintroduce one. If a screen needs to
   work without a backend, write a test, don't ship a mock toggle.
4. **Protocol envelope is fixed.** `{ id, method, params }` request,
   `{ id, ok: true, result }` / `{ id, ok: false, error: { code, ... } }`
   response. No `jsonrpc: "2.0"` field. Error code is a string. Each
   envelope is one line ending with `\n`.
5. **Dev build only.** `react-native-tcp-socket` and `expo-camera` both
   need native code. The app does not run in Expo Go — `lib/tcp-transport.ts`
   intentionally throws a clear "development build required" error if the
   native module is missing. Don't add an Expo Go fallback.
6. **Theme through `lib/theme.ts`.** No new hex literals in screens.
   Add a token to `theme.ts` if a new color is needed.
7. **No half-finished features.** If you stub a method, mark it TODO on
   the `TermLoopClient` interface, not silently in the body. The
   `client.resize()` no-op is the only sanctioned exception until PTY
   resize lands backend-side.

## When adding code

- **New backend method** → add to `TermLoopClient` interface in
  `lib/termloop-client.ts` with proper params/result types. Wire it
  through the `call(...)` helper. Unwrap `result.X` shapes (see
  `listProjects` / `listWorkspaces` / `listSurfaces`).
- **New screen** → register in `app/_layout.tsx`, use theme tokens,
  follow the `SafeAreaView + KeyboardAvoidingView + ScrollView` shell
  used by `connections/scan.tsx` and `connections/new.tsx`.
- **New persisted field on a connection** → extend `SavedConnection` in
  `lib/connections.ts`. AsyncStorage version key is
  `termloop.connections.v1`; bump to `v2` if the shape changes
  incompatibly and write a one-shot migration in `load()`.
- **New transport-level concern** (timeouts, framing, backpressure) →
  `lib/tcp-transport.ts`. Don't bypass the transport from screens.
- **New active-session-derived state** → expose a getter from
  `lib/session.ts` (see `getActiveAuth`). Don't read from `active`
  directly outside `session.ts`.

## When NOT to add code

- **Backend logic.** Anything beyond input shaping for the wire — out of
  scope.
- **A second client instance.** `lib/session.ts` deliberately holds one
  active session in module scope. If multi-connection is ever needed,
  redesign that file; don't paper a second client onto a screen.
- **A new "auth state" store.** `auth` lives on `ActiveSession`; query
  via `getActiveAuth()`. Mirroring it into screen state is the wrong
  shape.
- **A workspace cache layer.** Lists are server-of-truth and small;
  refetch on focus rather than caching.

## Backend contract (for reference)

| Method | Params | Result |
|---|---|---|
| `system.ping` | – | `{ pong: true }` |
| `pairing.claim` | `{ token, device_name }` | `{ authenticated, device_id, device_name, access_token, server_name, capabilities }` |
| `auth.token` | `{ device_id, access_token }` | `{ authenticated, device_id, device_name, server_name, capabilities }` |
| `auth.login` | `{ password }` | `{ authenticated, server_name, capabilities }` |
| `project.list` | – | `{ projects: ProjectSummary[] }` |
| `project.current` | – | `ProjectSummary \| null` (returns directly; `not_found` mapped to `null` in client) |
| `project.switch` | `{ project_id }` | `{ ok: true }` |
| `workspace.list` | – | `{ workspaces: WorkspaceSummary[] }` |
| `surface.list` | `{ workspace_id }` | `{ surfaces: ... }` |
| `surface.read_text` | `{ workspace_id, surface_id? }` | `{ workspaceId, text, cursor?, rev? }` |
| `surface.send_text` | `{ workspace_id, text, surface_id? }` | `{ ok: true }` |
| `surface.send_key` | `{ workspace_id, key, surface_id? }` | `{ ok: true }` |

Pairing QR payload (validated by `parsePairingPayload`):
```json
{ "type": "termloop.pairing", "version": 1, "server_name": "...",
  "host": "...", "port": 7878, "token": "...", "expires_at": 1700000000 }
```

## Pending / known gaps

- Token storage is AsyncStorage cleartext. **Migrate to
  `expo-secure-store` before any non-developer build.**
- `client.resize()` is a no-op until backend exposes a PTY resize API.
- Live terminal event stream not yet wired (`terminal.tsx` reads on
  mount; no streaming updates).
- No reconnect/backoff on socket drop.
- ANSI/xterm not parsed; `terminal.tsx` is a scrolling text view with a
  64K char cap.

## Hard rules

- New files in `lib/` only for the 5 roles above. If your new file
  doesn't fit one, you're probably adding a layer — don't.
- `MockTransport` is deleted on purpose. Don't add it back "for tests"
  without a test that actually exercises it.
- `tsc --noEmit` must pass before claiming work is done. Run
  `npm run typecheck`.
- One commit per logical change. Don't bundle unrelated screen edits
  with transport / protocol changes.
- Never touch `termloop/` from this directory's tasks.
