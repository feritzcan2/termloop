# terminal-app

Thin React Native (Expo) client for TermLoop. The mobile app is a **paired
client** — the desktop app generates a pairing QR, this app scans it, claims
a token, and reconnects with that token on subsequent launches. Manual
host/port/password setup remains as a fallback for development and recovery.

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
> (raw TCP) and `expo-camera` — both require a development build, an EAS
> build, or `npx expo run:ios|android`. Expo Go's sandbox cannot open raw
> TCP sockets.

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
3. Scanning (or pasting, while the camera scanner is pending) parses the
   payload and calls `pairing.claim` with `{ token, device_name }`.
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
  termloop-client.ts       Typed RPC envelope + pairing/auth + MockTransport (tests only)
  tcp-transport.ts         Real transport: NDJSON over TCP via react-native-tcp-socket
  qr-scanner.ts            Scanner capability flag (live camera in scan screen)
  connections.ts           AsyncStorage-backed connection catalog
  session.ts               Module-scope active client (one connection at a time)
```

## Transport

Real connections use **newline-delimited JSON over TCP**:

- One UTF-8 JSON request object per line, terminated by `\n`.
- Responses are correlated to requests by `id`.
- Default request timeout 10s; default connect timeout 8s.

`MockTransport` in `lib/termloop-client.ts` is reserved for tests and is
**not used** by the normal app flow.

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
| `pairing.claim` | `{ token, device_name }` | `{ authenticated, device_id, device_name, access_token, server_name, capabilities }` |
| `auth.token` | `{ device_id, access_token }` | `{ authenticated, device_id, device_name, server_name, capabilities }` |
| `auth.login` | `{ password }` | `{ authenticated, server_name, capabilities }` |
| `project.list` | – | `ProjectSummary[]` |
| `project.current` | – | `ProjectSummary \| null` (returned directly, not wrapped) |
| `project.switch` | `{ project_id }` | `{ ok: true }` |
| `workspace.list` | – | `WorkspaceSummary[]` |
| `surface.list` | `{ workspace_id }` | `Surface[]` |
| `surface.read_text` | `{ workspace_id, surface_id? }` | `{ workspaceId, text, cursor?, rev? }` |
| `surface.send_text` | `{ workspace_id, text, surface_id? }` | `{ ok: true }` |
| `surface.send_key` | `{ workspace_id, key, surface_id? }` | `{ ok: true }` |

`surface.resize` does not exist on the backend yet — `client.resize()` is a
no-op until a real PTY resize API lands.

## Native modules

| Module | Why | Build impact |
|---|---|---|
| `react-native-tcp-socket` | Real NDJSON-over-TCP transport for backend | Dev build only — not Expo Go |
| `expo-camera` | Live QR scanner in pairing screen | Dev build only — not Expo Go |

Run `npx expo prebuild --clean` after install. Autolinking handles native
linking on both platforms.

## Pending backend / mobile work

- Live terminal event stream (incremental surface updates / cursor / dirty rows)
- Terminal PTY resize API (`client.resize()` is a no-op until then)
- Token storage hardening — currently AsyncStorage cleartext. **Move to
  `expo-secure-store` before any non-dev build.**
- Reconnect / backoff on socket drop
- ANSI/xterm parsing for the terminal view (currently a scrolling text view)

## Swapping the transport

`lib/session.ts → openSession` is the single place that picks the
transport. The default is `TcpTransport`. Anything implementing
`Transport.send(req): Promise<RpcResponse>` works as a drop-in.
