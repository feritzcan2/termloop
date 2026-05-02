# TermLoop Mobile V1 Smoke Checklist

Run this before treating the mobile thin client as releasable. V1 is a
paired LAN/dev-build client: QR pairing, token auth, project/workspace
navigation, terminal read/send, live terminal updates, ANSI scrollback, and
polling fallback.

## Preconditions

- Build/run the mobile app as a development build, not Expo Go:

  ```bash
  cd terminal-app
  npm install
  npm run typecheck
  npm run ios
  ```

- Run the Mac TermLoop build that includes `Connect Mobile`.
- Put the phone/simulator and Mac on a reachable network path. For a real
  phone, the QR host must be a LAN/Tailscale address, not `127.0.0.1`.
- For release/preview builds, confirm the installed app name is
  `TermLoop Mobile` and the app icon/splash are not Expo defaults.

## Pairing

1. On Mac, click `Connect Mobile`.
2. Confirm the sheet shows:
   - QR code
   - `host:port`
   - countdown
   - `Paired Devices`
3. On mobile, tap `Scan pairing QR` and scan the QR.
4. Confirm mobile navigates directly to `Connected`.
5. Confirm the Mac sheet lists the new device within a few seconds.

Expected result: pairing succeeds without manual host/port entry.

## Reconnect

1. Fully close and reopen the mobile app.
2. Confirm the app attempts the last successful connection automatically.
3. If auto-connect is skipped or fails, tap the saved connection.
4. Confirm it authenticates with `auth.token`.
5. If the last terminal is still valid, confirm it resumes directly to that
   terminal; otherwise confirm it opens `Connected`.

Expected result: no QR scan is needed after the first pairing.

## Project And Workspace

1. Confirm `Current Project` matches the Mac active project.
2. Confirm the workspace list only shows workspaces for that active project.
3. Switch project from the mobile project picker if available.
4. Confirm workspace rows refresh and do not show workspaces from another project.

Expected result: Nucleus workspaces do not appear under a TermLoop current
project, and vice versa.

## Terminal

1. Tap a workspace with a terminal surface.
2. Confirm terminal text loads with recent history.
3. Send:

   ```text
   echo termloop-mobile-smoke
   ```

4. Confirm the command submits and output appears without pressing Refresh
   while the stream is live.
5. Test accessory keys:
   - `Enter`
   - `Tab`
   - `Ctrl-C`
   - `Up`
   - `Down`
6. Confirm colored/bold terminal text renders approximately like the Mac
   terminal for normal shell/agent output.
7. Tap Refresh and confirm it still works as a fallback.
8. Leave the terminal screen and confirm live subscription/polling stops by
   checking there is no visible UI churn or repeated errors on the overview
   screen.

Expected result: command text is not merely echoed; it executes.

## Live Stream Fallback

1. Open a terminal and confirm the status reads `Live`.
2. Temporarily disable `Connect Mobile` on the Mac or stop TermLoop.
3. Confirm mobile does not stay silently frozen. It should show a degraded /
   disconnected state or fail the next action clearly.
4. Re-enable `Connect Mobile`, reconnect, and confirm terminal updates resume.

Expected result: live stream is preferred, polling/manual refresh remains a
fallback, and socket drops are visible to the user.

## Revoke

1. On Mac, open `Connect Mobile`.
2. Click `Revoke` for the paired device.
3. On mobile, disconnect and try the saved connection again.

Expected result: auth is rejected, the saved row remains, secrets are
cleared, and the row shows a re-pair state.

## Re-Pair

1. From the re-pair state, scan a new QR from Mac.
2. Confirm the existing `host:port` connection is updated rather than
   duplicated.
3. Confirm the connection works again.

Expected result: the user does not need to delete stale rows manually.

## Known V1 Limits

- Terminal rendering is a lightweight scrollback renderer, not a full
  terminal emulator.
- `surface.resize` is intentionally a no-op until the backend exposes PTY
  resize.
- Cursor-addressing TUIs such as vim/top/htop are out of scope for V1.
- Reconnect/backoff after socket drop is intentionally minimal.
- Manual setup is fallback only and does not dedupe by endpoint.
