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
| `lib/connections.ts` | Catalog: metadata in AsyncStorage, secrets in expo-secure-store |
| `lib/theme.ts` | Colors + mono font — single source for dark theme |
| `eas.json` | EAS Build profiles for development / preview / staging / production |
| `docs/deployment.md` | Mobile deployment runbook and release guardrails |

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
5. **Dev build only.** `react-native-tcp-socket`, `expo-camera`, and
   `expo-secure-store` all need native code. EAS development builds also
   require `expo-dev-client`; OTA channels require `expo-updates`. The app
   does not run in Expo Go — `lib/tcp-transport.ts` intentionally throws a
   clear "development build required" error if the native module is missing.
   Don't add an Expo Go fallback.
6. **Theme through `lib/theme.ts`.** No new hex literals in screens.
   Add a token to `theme.ts` if a new color is needed.
7. **No half-finished features.** If you stub a method, mark it TODO on
   the `TermLoopClient` interface, not silently in the body. The
   `client.resize()` no-op is the only sanctioned exception until PTY
   resize lands backend-side.
8. **Deployment profiles are intentional.** `development` and `preview`
   are internal builds; `staging` and `production` are store builds with
   auto-submit. Do not change channels/profile names without updating
   `docs/deployment.md` and `.github/workflows/mobile-app.yml`.

## When adding code

- **New backend method** → add to `TermLoopClient` interface in
  `lib/termloop-client.ts` with proper params/result types. Wire it
  through the `call(...)` helper. Unwrap `result.X` shapes (see
  `listProjects` / `listWorkspaces` / `listSurfaces`).
- **New screen** → register in `app/_layout.tsx`, use theme tokens,
  follow the `SafeAreaView + KeyboardAvoidingView + ScrollView` shell
  used by `connections/scan.tsx` and `connections/new.tsx`.
- **New persisted field on a connection** → extend `SavedConnection` in
  `lib/connections.ts`. Decide whether the field is sensitive:
  - **Secret** (token, password, key) → SecureStore via `writeSecret` /
    `readSecret`. Do not add to the persisted metadata shape.
  - **Metadata** (id, name, host, port, deviceId, server name, timestamps)
    → AsyncStorage. Current key is `termloop.connections.v2`; bump to
    `v3` and write a one-shot migration if the metadata shape changes
    incompatibly.
- **New transport-level concern** (timeouts, framing, backpressure) →
  `lib/tcp-transport.ts`. Don't bypass the transport from screens.
- **New active-session-derived state** → expose a getter from
  `lib/session.ts` (see `getActiveAuth`). Don't read from `active`
  directly outside `session.ts`.
- **New deployment behavior** → update `eas.json`, npm scripts, and
  `docs/deployment.md` together. Keep CI typecheck-only on PRs unless the
  workflow is manually dispatched.

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
| `surface.read_text` | `{ workspace_id, surface_id? }` | `{ text, base64?, workspace_id, workspace_ref?, surface_id, surface_ref?, window_id?, window_ref? }` |
| `surface.send_text` | `{ workspace_id, text, surface_id? }` | `{ ok: true }` |
| `surface.send_key` | `{ workspace_id, key, surface_id? }` | `{ ok: true }` |
| `surface.subscribe` | `{ workspace_id, surface_id? }` | `{ subscription_id }` |
| `surface.unsubscribe` | `{ subscription_id }` | `{ ok: true }` |

### Server-pushed events (V2 streaming)

Events arrive as separate NDJSON lines on the same socket. They have no
`id` / `ok` field; the transport demuxes by `type` and the client routes
by `subscription_id`.

| Event type | Payload | Mobile handling |
|---|---|---|
| `surface.snapshot` | `{ subscription_id, text }` | Replace buffer; mark stream `live` |
| `surface.output` | `{ subscription_id, text }` | Append to buffer; mark `live` |
| `surface.closed` | `{ subscription_id }` | Mark stream `closed`; show banner |
| `surface.error` | `{ subscription_id, message }` | Mark `degraded`; resume polling |

Polling is the fallback: terminal screen polls every 1800ms only when the
subscription has not been established or has degraded. While the
subscription is `live`, polling is off.

### Key names sent via `surface.send_key`

The terminal accessory row sends these `key` values. If the backend
rejects a name, the client falls back to the literal text where one is
defined; otherwise the call surfaces an inline error.

| Key | `key` value | Text fallback |
|---|---|---|
| Esc | `escape` | `\x1b` |
| Tab | `tab` | `\t` |
| Enter | `enter` | `\r` |
| Up arrow | `up` | – |
| Down arrow | `down` | – |
| Ctrl-C | `Ctrl-C` | `\x03` |
| Ctrl-D | `Ctrl-D` | `\x04` |

Pairing QR payload (validated by `parsePairingPayload`):
```json
{ "type": "termloop.pairing", "version": 1, "server_name": "...",
  "host": "...", "port": 7878, "token": "...", "expires_at": 1700000000 }
```

The terminal Send button sends command text with `surface.send_text`, then
sends `surface.send_key` with `key: "enter"`. If that key call fails, it
falls back to `surface.send_text` with `"\r"`. Do not collapse this back to
`line + "\n"` in one `surface.send_text` call; that can echo text without
submitting it on some terminal surfaces.

## V1 release boundary

V1 is considered the QR-paired thin-client baseline:

- Mac `Connect Mobile` enables TCP, shows QR, lists paired devices, and can revoke.
- Mobile scans QR, claims a device token, stores secrets in SecureStore, and reauths with `auth.token`.
- Connected screen loads current project, filters workspaces by active project, and opens terminal surfaces.
- Terminal screen supports read/send/key accessory row and focused polling only while mounted/focused.

Before calling V1 done, run the smoke checklist in `docs/v1-smoke.md`.

## Storage layout

| Field type | Where | Key shape |
|---|---|---|
| Connection metadata | AsyncStorage | `termloop.connections.v2` (single JSON list) |
| `accessToken` | SecureStore | `termloop.access_token.<id>` |
| `password` | SecureStore | `termloop.password.<id>` |

`listConnections()` hydrates secrets from SecureStore; never assume
metadata read from disk has them. `connectionNeedsReauth(conn)` is the
canonical predicate for the "Needs re-pairing" UI state.

Legacy `termloop.connections.v1` (where secrets sat alongside metadata
in AsyncStorage) is migrated lazily on first load.

### Re-pairing

QR pairing matches existing connections by `host:port` via
`findConnectionByEndpoint`. If a saved entry exists for that endpoint,
the new `device_id` / `access_token` overwrite it (preserving the user's
custom name and `lastConnectedAt`); password is cleared. This avoids
duplicate rows when a user re-pairs after the Mac revokes their token.

Manual setup does **not** dedupe by endpoint — running it again with the
same host:port creates a new entry. Users wanting to update manual
credentials should edit/delete the existing row.

## Pending / known gaps

- `client.resize()` is a no-op until backend exposes a PTY resize API.
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
