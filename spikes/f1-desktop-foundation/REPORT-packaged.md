# F1 Playwright Electron Spike

- Status: **GO**
- Recorded: 2026-08-08T16:30:28.777Z
- Host: darwin arm64 25.5.0
- Mode: shown packaged Electron window

## Checks

| Check | Result |
|---|---|
| xterm buffer readable | PASS |
| keyboard → PTY → xterm | PASS |
| projection refresh preserves mount/WebGL + buffer | PASS |
| five terminals preserved after creating sixth | PASS |
| Project A → B → A preserves buffer | PASS |
| daemon restart retires old epochs; no implicit PTY | 1/1 |
| utility transport p95 ≤ 3F+5 | PASS (17.50 ms ≤ 29.90 ms; no direct-path delta claimed) |
| reconnect runs | 1/1 |

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
