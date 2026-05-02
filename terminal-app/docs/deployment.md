# Mobile Deployment

TermLoop Mobile uses native modules (`react-native-tcp-socket`,
`expo-camera`, `expo-secure-store`, `expo-dev-client`, `expo-updates`), so
real builds must be made with EAS or `expo run:*`. Expo Go is not a supported
runtime for the app.

## App Identity

| Field | Value |
|---|---|
| Display name | `TermLoop Mobile` |
| Expo slug | `termloop-mobile` |
| URL scheme | `termloop-mobile` |
| iOS bundle identifier | `ai.termloop.mobile` |
| Android package | `ai.termloop.mobile` |
| App icon | `assets/icon.png` |
| Splash icon | `assets/splash-icon.png` |

The app may keep accepting the legacy `termloop` URL scheme in native iOS
builds for local/dev compatibility, but new links should use
`termloop-mobile`.

## Permissions

| Platform | Permission | Why |
|---|---|---|
| iOS | Camera | Scan the pairing QR shown by TermLoop on the Mac |
| iOS | Local Network | Connect to the Mac-side TCP bridge on LAN/Tailscale |
| Android | Camera | Scan the pairing QR shown by TermLoop on the Mac |
| Android | Internet / network state | Open the TCP bridge and report reachability |

The app does not need microphone access. If native files are regenerated,
keep microphone permission out unless a real microphone feature is added.

## Build Profiles

| Profile | Audience | Command |
|---|---|---|
| `development` | device dev build with native TCP/camera | `npm run eas:build:dev` |
| `development-simulator` | iOS simulator dev build | `npm run eas:build:sim` |
| `preview` | internal QA/ad hoc build | `npm run eas:build:preview` |
| `staging` | TestFlight staging | `npm run eas:build:staging` |
| `production` | App Store release | `npm run eas:build:production` |

## One-Time Setup

Before CI can run EAS builds, link the Expo project and configure credentials
from a developer machine:

```bash
cd terminal-app
npx eas-cli login
npx eas-cli init
npx eas-cli build:configure
```

Then add the Expo access token to GitHub as `EXPO_TOKEN`.

## Local Development

```bash
cd terminal-app
npm install
npm run typecheck
npm run ios
```

`npm run ios` uses `expo run:ios`, which creates a native development build.
Use this for day-to-day simulator/device work.

## Internal QA

Use `preview` when QA needs an installable build and native code has changed:

```bash
npm run eas:build:preview
```

Use EAS Update only for JS/assets-only changes after a compatible native build
is already installed:

```bash
npm run eas:update:preview -- --message "terminal input polish"
```

Do not use EAS Update after changing native dependencies, `app.json` native
settings, permissions, bundle identifiers, or config plugins. Build a new
binary instead.

## Store Tracks

Staging goes to TestFlight:

```bash
npm run eas:build:staging
```

Production goes to App Store submission:

```bash
npm run eas:build:production
```

Both profiles use `--auto-submit`. Configure Apple credentials in EAS before
running them.

## GitHub Actions

The repository workflow `.github/workflows/mobile-app.yml` does two things:

- PR/push validation: install dependencies and run `npm run typecheck`.
- Automatic TestFlight release: on `master` pushes with changes under
  `terminal-app/`, run the `staging` EAS profile for iOS with
  `--auto-submit`.
- Manual EAS builds: run the workflow manually and choose
  `development`, `development-simulator`, `preview`, `staging`, or
  `production`.

Required GitHub secret:

- `EXPO_TOKEN`: Expo access token allowed to run EAS Build/Submit for the
  project.

EAS must also have iOS build credentials and App Store Connect submission
credentials configured for the `staging` profile. The automatic path uses
the same command as `npm run eas:build:staging`.

Optional manual input:

- `platform`: defaults to `ios`; use `all` once Android distribution is ready.

## Release Guardrails

- Secrets (`accessToken`, password) must stay in `expo-secure-store`.
- Metadata can stay in AsyncStorage.
- iOS `Info.plist` and `app.json` must agree on `TermLoop Mobile`,
  `ai.termloop.mobile`, camera, local-network, and encryption declarations.
- Android package id must stay `ai.termloop.mobile`.
- App icon must remain an opaque 1024x1024 PNG. Adaptive/splash images can
  keep transparency.
- `npm run typecheck` must pass before any build.
- Use `preview` for internal QA before `staging`.
- Use `staging`/TestFlight before `production`.
