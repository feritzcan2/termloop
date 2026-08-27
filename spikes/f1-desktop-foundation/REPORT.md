# F1 Playwright Electron Spike

- Status: **GO**
- Recorded: 2026-08-09T04:38:44.035Z
- Host: darwin arm64 25.5.0
- Mode: shown development Electron window

## Checks

| Check | Result |
|---|---|
| xterm buffer readable | PASS |
| keyboard → PTY → xterm | PASS |
| projection refresh preserves mount/WebGL + buffer | PASS |
| five terminals preserved after creating sixth | PASS |
| Project A → B → A preserves buffer | PASS |
| daemon restart retires old epochs; no implicit PTY | 20/20 |
| utility transport p95 ≤ 3F+5 | PASS (17.60 ms ≤ 30.20 ms; no direct-path delta claimed) |
| reconnect runs | 20/20 |

## Latency interpretation

The accepted proxy proves the utility path is within budget; its two-frame floor does not distinguish utility from the prior direct path.

## Dependencies

```json
{
  "electron": "43.3.0",
  "chromium": "150.0.7871.212",
  "node": "24.18.1",
  "appVersion": "0.1.0",
  "playwright": "1.55.0",
  "xterm": "6.0.0",
  "shown": true
}
```

## Failures

None.
