# TermLoop Mobile

Expo/React Native thin client for TermLoop Next. Development uses deterministic
mock ports by default. Release builds select production adapters for
SecureStore-backed connection profiles, generated control reads, and the
existing binary terminal protocol.

The simple physical-phone path uses Tailscale on the Mac and iPhone. Start
TermLoop Next, connect Tailscale on both devices, then run on the Mac:

```text
pnpm --filter @termloop/mobile mobile-access
```

The command bundles a small gateway into the user's Application Support,
registers it from `~/Library/LaunchAgents`, enables a tailnet-only Tailscale
Serve reverse proxy, and copies one `TLMP1` code to Universal Clipboard without
printing its credentials. The installed gateway does not depend on this source
checkout remaining in place. On the iPhone, open **Pair a Mac**, paste, and
confirm. There is no SSH app, router port, daemon LAN listener, or public Funnel
setup.

Pairing is persistent. The gateway keeps the phone's saved credential stable
while resolving the current daemon loopback port and rotating read-only control
plus terminal credentials on every connection. Daemon restarts therefore do
not require running the command or pairing again. Manual SSH-forwarding remains
available through `pair-code`, but it is not the normal owner workflow. QR
scanning is not implemented.

The entitlement-enabled iOS build asks once for notification permission. Its
native APNs token is registered with the owner gateway; a new input request or
structured completed turn sends a bounded notification, and tapping it opens
the exact Agent Session. The gateway uses the existing owner APNs provider key
under `~/Library/Application Support/TermLoop/apns/`; it never copies that key
or sends terminal output in a notification.

For a signed local Release build on a connected development iPhone:

```text
pnpm --filter @termloop/mobile exec expo prebuild --platform ios
EXPO_NO_DOCTOR=1 pnpm --filter @termloop/mobile exec expo run:ios \
  --device <Xcode-device-UDID> --configuration Release
```

The development bundle id is `ai.termloop.next.mobile.dev`, so it can coexist
with the legacy `ai.termloop.mobile` app.

```text
pnpm --filter @termloop/mobile check
pnpm --filter @termloop/mobile test
pnpm --filter @termloop/mobile start
```

To exercise production runtime selection in a development build:

```text
EXPO_PUBLIC_TERMLOOP_RUNTIME=production pnpm --filter @termloop/mobile start
```

This flag selects adapters only; it contains no endpoint or credential.

Runtime boundaries live under `src/application`, `src/adapters`,
`src/composition`, and `src/platform`. Presentation stays under `src/app`,
`src/features`, `src/components`, `src/presentation`, and `src/theme`.
