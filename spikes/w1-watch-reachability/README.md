# W1 watch-reachability spike

This disposable spike answers one risk question before any watch-app or
daemon remote-surface work is proposed:

> Can a standalone watchOS app's plain `URLSession` HTTP request reach a
> service bound on a Mac's LAN address, and under which iPhone-proximity
> conditions (same Wi-Fi, cellular-nearby, absent, Tailscale-on-phone)?

Apple TN3135 makes clear the watch simulator does **not** enforce the
platform's networking policy, so evidence is only valid from real hardware.
The spike therefore has two halves:

- `server.mjs` — a zero-dependency Node HTTP listener the Mac runs. It
  answers `GET /ping` and records every watch-submitted result to
  `evidence/watch-reports.jsonl` (plus a raw request log in
  `evidence/server-log.jsonl`).
- `WatchReach.xcodeproj` — a single-target watchOS app. You enter the Mac's
  IP and port, pick the scenario you are physically testing, and tap Run.
  The app fires 8 sequential `GET /ping` requests, measures latency, shows
  the outcome on the watch, and best-effort POSTs the result to the server
  so the evidence lands on the Mac even if some attempts failed.

## Run

1. On the Mac:

   ```sh
   node spikes/w1-watch-reachability/server.mjs
   ```

   It prints the LAN IPv4 addresses to type into the watch.

2. Open `spikes/w1-watch-reachability/WatchReach.xcodeproj` in Xcode, select
   your paired Apple Watch as the destination, set your development team if
   signing asks for one, and run. Repeat for each scenario in the matrix:

   | scenario id             | physical setup                                          |
   | ----------------------- | ------------------------------------------------------- |
   | `iphone-same-wifi`      | iPhone in BT range, on the same Wi-Fi as the Mac        |
   | `iphone-cellular-nearby`| iPhone in BT range with Wi-Fi off (cellular only)       |
   | `tailscale-on-phone`    | iPhone nearby, Tailscale active; target the tailnet IP  |
   | `tailscale-away-from-lan` | fully away from the Mac's LAN: iPhone on cellular with Tailscale active, watch on wrist; target the tailnet IP |

3. Derive the report (status is computed from evidence; untested scenarios
   are reported as UNMEASURED, never guessed):

   ```sh
   node spikes/w1-watch-reachability/derive-report.mjs
   ```

## Notes and limitations

- The spike app ships with `NSAllowsArbitraryLoads` because it talks plain
  HTTP to a raw IP. That is acceptable only because this is a disposable
  experiment; the production proposal is TLS with a pinned certificate.
- A scenario is marked PASS when a report shows at least 6 of 8 pings
  succeeded; anything reported below that is FAIL. Route information
  (Bluetooth-via-iPhone vs. watch Wi-Fi) is not directly observable from
  the app; the server records the client address seen per request, which
  distinguishes the iPhone's address from the watch's own.
- The spike is not a production API. Production code must not depend on it.
