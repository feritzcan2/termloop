import { describe, expect, it } from "vitest";

import { createMobileDiagnosticReporter, websocketEndpointLabel } from "../src/platform/mobile-diagnostics";

describe("mobile diagnostics", () => {
  it("writes ordered structured events without undefined fields", () => {
    const lines: string[] = [];
    let now = 1_786_617_480_000;
    const diagnostics = createMobileDiagnosticReporter(
      (line) => lines.push(line),
      { now: () => now },
    );

    diagnostics.report("lifecycle", "initialized", { nativeState: "active", ignored: undefined });
    now += 725;
    diagnostics.updateLifecycle({
      nativeState: "active",
      foregroundRevision: 4,
      backgroundDurationMs: 725,
    });
    diagnostics.report("control", "connection_opened", { generation: 2 });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!.replace("[termloop-mobile] ", ""))).toEqual({
      atEpochMs: 1_786_617_480_000,
      elapsedMs: 0,
      sequence: 1,
      runId: diagnostics.runId,
      area: "lifecycle",
      event: "initialized",
      nativeState: "active",
    });
    expect(JSON.parse(lines[1]!.replace("[termloop-mobile] ", ""))).toMatchObject({
      elapsedMs: 725,
      sequence: 2,
      event: "connection_opened",
      generation: 2,
    });
    expect(diagnostics.correlation()).toEqual({
      mobileRunId: diagnostics.runId,
      mobileAppState: "active",
      foregroundRevision: 4,
      backgroundDurationMs: 725,
    });
  });

  it("keeps endpoint labels credential-free", () => {
    expect(websocketEndpointLabel("wss://mac.example.ts.net/control"))
      .toBe("wss://mac.example.ts.net/control");
    expect(websocketEndpointLabel("not a websocket endpoint"))
      .toBe("invalid-websocket-endpoint");
  });
});
