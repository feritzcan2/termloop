# TermLoop Mobile

Thin React Native (Expo) client for TermLoop. The mobile app is a **paired
client** — the desktop app generates a pairing QR, this app scans it, claims
a token, and reconnects with that token on subsequent launches. Manual
host/port/password setup remains as a fallback for development and recovery.

## App identity

- Display name: `TermLoop Mobile`
- Expo slug: `termloop-mobile`
- URL scheme: `termloop-mobile`
- iOS bundle id / Android package: `ai.termloop.mobile`
- App icon / splash assets: `assets/icon.png`, `assets/adaptive-icon.png`,
  `assets/splash-icon.png`

## Run

```bash
cd terminal-app
npm install
npm run typecheck

# Dev build (required — see "Native modules" below)
npx expo prebuild --clean
npm run ios           # iOS simulator (or device)
npm run android       # Android emulator (or device)
```

> **Expo Go is not supported.** The app uses `react-native-tcp-socket`
> (raw TCP), `expo-camera`, and `expo-secure-store` — all require a
> development build, an EAS build, or `npx expo run:ios|android`. Expo
> Go's sandbox cannot open raw TCP sockets or access the platform
> keychain.

## Pairing flow (primary)

1. On the Mac, TermLoop shows a QR code containing a pairing payload:

   ```json
   {
     "type": "termloop.pairing",
     "version": 1,
     "server_name": "Ferit's MacBook",
     "host": "192.168.1.20",
     "port": 7878,
     "token": "temporary-random-token",
     "expires_at": 1760000000
   }
   ```

2. The mobile app's home screen has **Scan pairing QR** as the primary CTA.
3. Scanning or pasting parses the payload and calls `pairing.claim` with
   `{ token, device_name }`.
4. The backend returns `{ device_id, access_token, server_name, capabilities }`.
   The app saves a `SavedConnection` and uses `auth.token` on future
   connects.

Manual setup is the fallback. It collects name / host / port (default
`7878`) / password and uses `auth.login` with `{ password }`.

## Structure

```
app/
  _layout.tsx              Expo Router stack
  index.tsx                Connection list — primary CTA: Scan pairing QR
  connections/scan.tsx     QR pairing screen (live camera + paste fallback)
  connections/new.tsx      Manual setup (fallback)
  connected/index.tsx      Server + project + workspace overview
  connected/terminal.tsx   Terminal surface (read/send via client)
lib/
  termloop-client.ts       Typed RPC envelope + pairing/auth/client helpers
  tcp-transport.ts         Real transport: NDJSON over TCP via react-native-tcp-socket
  errors.ts                User-facing connection/pairing error messages
  connections.ts           AsyncStorage-backed connection catalog
  last-connection.ts       Last successful connection id for auto-connect
  last-terminal.ts         Last opened terminal per connection for resume
  connection-health.ts     Short-lived authenticated online/offline probe
  session.ts               Module-scope active client (one connection at a time)
  theme.ts                 Shared colors + fonts
```

## Transport

Real connections use **newline-delimited JSON over TCP**:

- One UTF-8 JSON request object per line, terminated by `\n`.
- Responses are correlated to requests by `id`.
- Default request timeout 10s; default connect timeout 8s.

There is no mock transport in the normal app flow. `lib/session.ts` always
uses `TcpTransport` for saved/scanned connections.

## Protocol envelope

```jsonc
// Request
{ "id": "...", "method": "...", "params": {} }

// Success
{ "id": "...", "ok": true,  "result": {} }

// Error
{ "id": "...", "ok": false, "error": { "code": "string", "message": "...", "data": {} } }
```

No `jsonrpc: "2.0"` field. Error code is a string. Each envelope is a
single line terminated by `\n`.

## Backend methods this client expects

| Method | Params | Result |
|---|---|---|
| `system.ping` | – | `{ pong: true }` |
| `pairing.claim` | `{ token, device_name, device_id? }` | `{ authenticated, device_id, device_name, access_token, server_name, capabilities }` |
| `auth.token` | `{ device_id, access_token }` | `{ authenticated, device_id, device_name, server_name, capabilities }` |
| `auth.login` | `{ password }` | `{ authenticated, server_name, capabilities }` |
| `project.list` | – | `{ projects: ProjectSummary[] }` |
| `project.current` | – | `ProjectSummary \| null` (returned directly, not wrapped) |
| `project.switch` | `{ project_id }` | `{ ok: true }` |
| `workspace.list` | – | `{ workspaces: WorkspaceSummary[] }` |
| `surface.list` | `{ workspace_id }` | `{ surfaces: SurfaceSummary[] }` |
| `surface.read_text` | `{ workspace_id, surface_id?, format?, history_lines? }` | `{ text, base64?, workspace_id, workspace_ref?, surface_id, surface_ref?, window_id?, window_ref? }` |
| `surface.send_text` | `{ workspace_id, text, surface_id? }` | `{ ok: true }` |
| `surface.send_key` | `{ workspace_id, key, surface_id? }` | `{ ok: true }` |
| `surface.subscribe` | `{ workspace_id, surface_id?, format?, history_lines? }` | `{ subscription_id, format?, history_lines? }` |
| `surface.unsubscribe` | `{ subscription_id }` | `{ ok: true }` |

`surface.resize` does not exist on the backend yet — `client.resize()` is a
no-op until a real PTY resize API lands.

The terminal Send button sends command text with `surface.send_text`, then
sends `surface.send_key` with `key: "enter"`; if the key call fails it falls
back to `surface.send_text` with `"\r"`.

Terminal streaming uses `surface.subscribe` with `format: "vt"` and
`history_lines: 500`. Server-pushed `surface.snapshot` replaces the buffer,
`surface.output` appends to it, and `surface.error` / subscribe failure falls
back to focused polling.

## Storage

| Field type | Where | Notes |
|---|---|---|
| Connection metadata | AsyncStorage `termloop.connections.v2` | id, name, host, port, deviceId, serverName, lastConnectedAt |
| Last successful connection | AsyncStorage `termloop.last_connection.v1` | connectionId + updatedAt only |
| Last terminal per connection | AsyncStorage `termloop.last_terminal.v1` | workspace/surface ids and display names only |
| Secrets (`accessToken`, `password`) | `expo-secure-store` (Keychain on iOS / EncryptedSharedPreferences on Android) | One key per connection: `termloop.access_token.<id>` and `termloop.password.<id>` |

Legacy v1 records (`termloop.connections.v1`) where secrets sat in
AsyncStorage are migrated lazily on first load and the v1 entry is
removed.

## Native modules

| Module | Why | Build impact |
|---|---|---|
| `react-native-tcp-socket` | Real NDJSON-over-TCP transport for backend | Dev build only — not Expo Go |
| `expo-camera` | Live QR scanner in pairing screen | Dev build only — not Expo Go; camera permission only |
| `expo-secure-store` | Hardware-backed storage for `accessToken` / `password` | Dev build only — not Expo Go |
| `expo-dev-client` | EAS development builds | Required for `developmentClient` profiles |
| `expo-updates` | OTA JS/assets updates by EAS channel | Required for `eas:update:*` scripts |

Run `npx expo prebuild --clean` after install. Autolinking handles native
linking on both platforms.

iOS also declares local-network access because the app connects to the
Mac-side TermLoop TCP bridge. The app does not need microphone permission.

## Deployment

EAS build profiles live in `eas.json`; operational notes live in
[`docs/deployment.md`](docs/deployment.md).

Common commands:

```bash
npm run eas:build:dev       # native dev build for iOS device
npm run eas:build:preview   # internal QA/ad hoc build
npm run eas:build:staging   # TestFlight + auto-submit
npm run eas:build:production
```

GitHub Actions runs `npm run typecheck` for mobile changes and has a manual
EAS build job that requires the `EXPO_TOKEN` secret.

## V1 smoke test

Use [`docs/v1-smoke.md`](docs/v1-smoke.md) before treating V1 as releasable.
It covers Mac pairing, secure token persistence, revoke/reauth, project
filtering, terminal read/send, and the current polling-based terminal update
behavior.

## Pending backend / mobile work

- Terminal PTY resize API (`client.resize()` is a no-op until then)
- Full terminal emulation for cursor-addressing TUIs (vim/top/htop) is out
  of scope for the current scrollback renderer.
- Polished terminal renderer/input model beyond the current accessory row

## Swapping the transport

`lib/session.ts → openSession` is the single place that picks the
transport. The default is `TcpTransport`. Anything implementing
`Transport.send(req): Promise<RpcResponse>` works as a drop-in.
