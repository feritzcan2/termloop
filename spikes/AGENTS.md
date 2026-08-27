# Spike agent rules

## Ownership

- Spikes are disposable experiments that answer one written risk question and
  produce reproducible raw evidence plus a derived report.

## Invariants

- Production modules, apps, and clients never depend on spike code.
- A spike does not establish or bypass a production API boundary.
- Record hardware, OS, dependency versions, headless/shown mode, measurement
  points, skipped scenarios, and known proxy limitations.
- Status is computed from the evidence. Do not hardcode `PASS`, `GO`, or hide an
  unmeasured exit criterion.

## Verification

- Run the spike's focused command; for R0 use `pnpm r0:full` for the
  reviewable local report and `pnpm r0:smoke` for CI smoke coverage.
