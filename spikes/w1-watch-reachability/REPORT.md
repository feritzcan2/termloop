# W1 watch-reachability spike report

Derived from 7 watch report(s) in `evidence/watch-reports.jsonl`.
Regenerate with `node spikes/w1-watch-reachability/derive-report.mjs`.

| scenario | status | best run | median latency (ms) | device | reports |
| --- | --- | --- | --- | --- | --- |
| iphone-same-wifi | PASS | 8/8 | 42 | Apple Watch watchOS 26.6 | 3 |
| iphone-cellular-nearby | UNMEASURED | — | — | — | 0 |
| tailscale-on-phone | UNMEASURED | — | — | — | 0 |
| tailscale-away-from-lan | PASS | 8/8 | 43 | Apple Watch watchOS 26.6 | 1 |
| other | PASS | 8/8 | 41 | Apple Watch watchOS 26.6 | 3 |

PASS requires at least 6 of 8 pings in a single run.
Route attribution: compare each report's `remoteAddress` (recorded by the
server) against the iPhone's and watch's own addresses to see whether the
request traversed the phone proxy or the watch's own Wi-Fi.

Unmeasured matrix scenarios: iphone-cellular-nearby, tailscale-on-phone.
