# TermLoop Mobile V1 Smoke Checklist

Run this before treating the mobile thin client as releasable. V1 is a
paired LAN/dev-build client: QR pairing, token auth, project/workspace
navigation, terminal read/send, and polling updates.

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
2. Tap the saved connection.
3. Confirm it authenticates with `auth.token` and opens `Connected`.

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
2. Confirm terminal text loads.
3. Send:

   ```text
   echo termloop-mobile-smoke
   ```

4. Confirm the command submits and output appears after refresh/polling.
5. Test accessory keys:
   - `Enter`
   - `Tab`
   - `Ctrl-C`
   - `Up`
   - `Down`
6. Leave the terminal screen and confirm polling stops by checking there is
   no visible UI churn or repeated errors on the overview screen.

Expected result: command text is not merely echoed; it executes.

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

- Terminal output uses polling while the terminal screen is focused; there
  is no backend event stream yet.
- `surface.resize` is intentionally a no-op until the backend exposes PTY
  resize.
- Terminal rendering is plain text; ANSI/xterm rendering is not implemented.
- Reconnect/backoff after socket drop is minimal.
- Manual setup is fallback only and does not dedupe by endpoint.
