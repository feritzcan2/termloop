# Terminal App

Cross-platform SSH terminal for iOS & Android built with Expo + xterm.js. Designed for monitoring AI agents (Claude Code) on remote servers.

> For architecture, build commands, current status, and the open SSH-library blocker, see [CLAUDE.md](./CLAUDE.md).

## Quick start

```bash
npm install --legacy-peer-deps
npx expo prebuild --clean
npx expo run:ios           # or --device for a physical iPhone
```

For a physical device you also need Metro running in another terminal:

```bash
npx expo start --dev-client
```

## Tests

```bash
npx jest
```

## Known blocker

SSH against modern macOS `sshd` currently fails because NMSSH's bundled libssh2 is too old (1.8.0). See the "NMSSH/libssh2 Blocker" section in [CLAUDE.md](./CLAUDE.md) for details and the planned fix (switch to Citadel).
