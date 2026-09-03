import { describe, expect, it } from "vitest";

import {
  createGatewayDiagnosticReporter,
  mobileDiagnosticContext,
} from "../scripts/mobile-access-diagnostics.mjs";

describe("mobile access diagnostics", () => {
  it("writes ordered JSON records for the bounded gateway log", () => {
    const lines = [];
    let now = 10_000;
    const diagnostics = createGatewayDiagnosticReporter(
      (line) => lines.push(line),
      { now: () => now, pid: 42 },
    );

    diagnostics.report("downstream", "accepted", { connectionId: 1, omitted: undefined });
    now += 250;
    diagnostics.report("upstream", "opened", { connectionId: 1 });

    expect(lines.map(JSON.parse)).toEqual([
      {
        atEpochMs: 10_000,
        elapsedMs: 0,
        sequence: 1,
        pid: 42,
        area: "downstream",
        event: "accepted",
        connectionId: 1,
      },
      {
        atEpochMs: 10_250,
        elapsedMs: 250,
        sequence: 2,
        pid: 42,
        area: "upstream",
        event: "opened",
        connectionId: 1,
      },
    ]);
  });

  it("accepts only bounded non-secret mobile correlation fields", () => {
    expect(mobileDiagnosticContext({
      mobileRunId: "mobile-mz4kh2o0",
      controlGeneration: 7,
      mobileAppState: "active",
      foregroundRevision: 3,
      backgroundDurationMs: 12_500,
      token: "must-not-be-copied",
    })).toEqual({
      mobileRunId: "mobile-mz4kh2o0",
      controlGeneration: 7,
      mobileAppState: "active",
      foregroundRevision: 3,
      backgroundDurationMs: 12_500,
    });
    expect(mobileDiagnosticContext({
      mobileRunId: "bad value with spaces",
      controlGeneration: -1,
      mobileAppState: "secret-state",
      foregroundRevision: -1,
      backgroundDurationMs: Number.MAX_SAFE_INTEGER,
    })).toEqual({
      mobileRunId: undefined,
      controlGeneration: undefined,
      mobileAppState: undefined,
      foregroundRevision: undefined,
      backgroundDurationMs: undefined,
    });
  });
});
