# watch-app — Agent Notes

iPhone + Apple Watch companion for controlling TermLoop. Independent Xcode project, not part of `termloop/` or `terminal-app/`. Mac-side RPC handlers live in `termloop/Sources/TermLoop/Socket/WatchAgentSocketCommands.swift`.

## Layout

- `Shared/` — code compiled into both iOS and watchOS targets (`WatchBridgeProtocol`, `TermLoopRPC`).
- `iOS/` — iPhone-only: `TermLoopWatchApp` (entry + settings UI), `PhoneSessionDelegate` (WCSession→TCP bridge), `NotificationManager` (APNs + reply action), `Settings` (`WatchAppSettings`).
- `Watch/` — watchOS-only: `WatchAppMain`, `WatchSessionClient`.

## Project generation

`TermLoopWatch.xcodeproj` is **generated** from `project.yml` via xcodegen — do not hand-edit the `.xcodeproj`. To change targets/sources/capabilities, edit `project.yml` and rerun `./setup.sh` (or `xcodegen generate`).

Adding new Swift files: drop them into `Shared/`, `iOS/`, or `Watch/` — xcodegen picks them up by directory on the next regenerate.

## Bundle IDs

`project.yml` sets `com.termloop.watch` (iOS) and `com.termloop.watch.watchkitapp` (Watch). For real-device deploys without collisions, change both in `project.yml` plus `WKCompanionAppBundleIdentifier`, then regenerate.

## Wire protocol

- WCSession message keys: `WatchBridgeMessage.*` (Shared).
- Mac RPCs: `watch.launch_agent { prompt }`, `watch.send_prompt { workspace_id, text }`, plus existing `auth.login`, `push.register`. v2 NDJSON envelope, password-authenticated TCP on port 7878.
- APNs reply path uses `UNTextInputNotificationAction` with category `TERMLOOP_ATTENTION`; the Mac's `PushDispatcher` sends matching pushes.
