# F1 desktop foundation — Playwright Electron spike

## Risk question

Can Playwright's experimental Electron driver inspect real xterm output, prove a
keyboard → PTY → terminal round trip, and survive twenty consecutive daemon
restart/reconnect cycles without a flaky run on the current stack?

## Pre-written decision rule

`GO` requires all three checks in one shown Electron run:

1. xterm's rendered buffer is readable from the running window;
2. keyboard input reaches a real daemon-owned PTY and echoed output is observed;
3. twenty consecutive daemon loss/restart cycles reconnect without restarting
   Electron and without a timeout.

Any missing or failed check is `NO-GO`; the bespoke running-window harness stays
the acceptance mechanism. This spike is disposable and production code does not
import it.

## Command

```text
pnpm f1:playwright-spike
pnpm f1:packaged-spike
```

The commands use isolated temporary runtime/state/project directories. The
development run writes machine-readable `evidence.json` plus `REPORT.md`; the
packaged `.app` run writes `evidence-packaged.json` plus `REPORT-packaged.md`.
