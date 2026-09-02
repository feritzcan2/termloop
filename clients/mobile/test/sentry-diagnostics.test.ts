import { describe, expect, it } from "vitest";

import { mobileSentryDiagnostic } from "../src/platform/sentry-diagnostics";
import type { MobileDiagnosticEvent } from "../src/platform/mobile-diagnostics";

describe("mobile Sentry diagnostics", () => {
  it("keeps reconnect evidence while pseudonymizing identities and dropping endpoints", () => {
    const diagnostic = mobileSentryDiagnostic(event("connection", "reconnect_stalled", {
      connectionId: "macbook-ferit",
      sessionId: "session-private",
      endpoint: "wss://macbook.example.ts.net/mobile?token=secret",
      reconnectAttempt: 4,
      reconnectElapsedMs: 15_000,
      reason: "socketError",
    }));

    expect(diagnostic).toMatchObject({
      message: "mobile.connection.reconnect_stalled",
      level: "error",
      createsIssue: true,
      attributes: {
        reconnectAttempt: 4,
        reconnectElapsedMs: 15_000,
        reason: "socketError",
      },
    });
    expect(diagnostic?.attributes.connectionRef).toMatch(/^ref-/);
    expect(diagnostic?.attributes.sessionRef).toMatch(/^ref-/);
    expect(JSON.stringify(diagnostic)).not.toContain("macbook-ferit");
    expect(JSON.stringify(diagnostic)).not.toContain("example.ts.net");
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  it("suppresses routine successful control traffic but retains failures", () => {
    expect(mobileSentryDiagnostic(event("control", "request_started", { method: "project.list" })))
      .toBeUndefined();
    expect(mobileSentryDiagnostic(event("control", "request_completed", {
      method: "project.list",
      ok: true,
    }))).toBeUndefined();
    expect(mobileSentryDiagnostic(event("control", "request_completed", {
      method: "project.list",
      ok: false,
      errorCode: "unavailable",
    }))).toMatchObject({ level: "error" });
  });
});

function event(
  area: MobileDiagnosticEvent["area"],
  name: string,
  details: MobileDiagnosticEvent["details"],
): MobileDiagnosticEvent {
  return {
    atEpochMs: 1_788_300_000_000,
    elapsedMs: 3_000,
    sequence: 7,
    runId: "mobile-private-run",
    area,
    event: name,
    details,
  };
}
