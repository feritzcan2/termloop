import { describe, expect, it, vi } from "vitest";

import { MobileConnectionCoordinator } from "../src/adapters/production/mobile-connection-coordinator";
import type { DataSocket } from "../src/adapters/production/data-socket";
import { GatewayReachabilityError } from "../src/adapters/production/gateway-compatibility";
import {
  KIND_ACK,
  KIND_ATTACH,
  KIND_ERROR,
  decodeFrame,
  encodeFrame,
} from "../src/adapters/production/terminal-frame";
import { createMobileDiagnosticReporter } from "../src/platform/mobile-diagnostics";
import type { SavedConnection } from "../src/platform/secure-connections";

const sessionId = "11111111-2222-4333-8444-555555555555";
const connection: SavedConnection = {
  id: "macbook",
  name: "MacBook",
  controlUrl: "ws://127.0.0.1:48100/control",
  controlToken: "control-token-1234567890",
  terminalUrl: "ws://127.0.0.1:48100/terminal",
  terminalToken: "terminal-token-1234567890",
  lastConnectedAtEpochMs: null,
  productVersion: null,
  contractIdentity: null,
};

describe("mobile connection coordinator", () => {
  it("retries a temporarily refused terminal attachment on the same transport", async () => {
    vi.useFakeTimers();
    try {
      const diagnosticLines: string[] = [];
      let attachAttempts = 0;
      const coordinator = new MobileConnectionCoordinator(
        connection,
        () => authenticatingSocket((socket, data) => {
          if (typeof data === "string") return;
          const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
          if (frame.kind !== KIND_ATTACH) return;
          attachAttempts += 1;
          const kind = attachAttempts < 3 ? KIND_ERROR : KIND_ACK;
          queueMicrotask(() => socket.onmessage?.({
            data: encodeFrame(frame.sessionId, frame.epoch, frame.sequence, kind),
          }));
        }),
        createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
      );

      const attaching = coordinator.attachTerminal(
        { id: sessionId, runtime_epoch: 7 },
        () => {},
      );
      await waitFor(() => attachAttempts === 1);
      await vi.advanceTimersByTimeAsync(100);
      await waitFor(() => attachAttempts === 2);
      await vi.advanceTimersByTimeAsync(200);
      const attachment = await attaching;

      expect(attachAttempts).toBe(3);
      expect(events(diagnosticLines).filter((event) => event === "attachment_refused"))
        .toHaveLength(2);
      expect(events(diagnosticLines)).not.toContain("attachment_failed");
      expect(events(diagnosticLines)).not.toContain("server_frame_error");

      await attachment.detach();
      coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reconnecting when an offline connection has only a status observer", async () => {
    vi.useFakeTimers();
    try {
      const diagnosticLines: string[] = [];
      const sockets: DataSocket[] = [];
      const coordinator = new MobileConnectionCoordinator(
        connection,
        () => {
          const socket = sockets.length === 0 ? authenticatingSocket() : silentSocket();
          sockets.push(socket);
          return socket;
        },
        createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
      );
      const unsubscribeStatus = coordinator.subscribeStatus(() => {});
      coordinator.resetTransport(true);
      await Promise.resolve();
      expect(sockets).toHaveLength(0);

      const unsubscribeInvalidations = coordinator.subscribeInvalidations(() => {});
      await waitFor(() => sockets.length === 1
        && events(diagnosticLines).includes("connection_ready"));
      sockets[0]!.onclose?.({ code: 1006, wasClean: false });
      await vi.advanceTimersByTimeAsync(12_000);
      const attemptsBeforeIdle = sockets.length;
      expect(attemptsBeforeIdle).toBeGreaterThan(1);
      unsubscribeInvalidations();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(sockets).toHaveLength(attemptsBeforeIdle);
      expect(events(diagnosticLines)).not.toContain("reconnect_stalled");

      unsubscribeStatus();
      coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a terminal-blocking preflight failure streak with safe transport state", async () => {
    const diagnosticLines: string[] = [];
    let preflightAttempts = 0;
    const coordinator = new MobileConnectionCoordinator(
      connection,
      () => authenticatingSocket((socket, data) => {
        if (typeof data === "string") return;
        const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (frame.kind !== KIND_ATTACH) return;
        queueMicrotask(() => socket.onmessage?.({
          data: encodeFrame(frame.sessionId, frame.epoch, frame.sequence, KIND_ACK),
        }));
      }),
      createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
      async () => {
        preflightAttempts += 1;
        if (preflightAttempts <= 3) {
          throw new GatewayReachabilityError("requestRejected", "TypeError");
        }
      },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(coordinator.attachTerminal(
        { id: sessionId, runtime_epoch: 7 },
        () => {},
      )).rejects.toThrow("not reachable");
    }

    const records = diagnosticLines.map(record);
    expect(preflightAttempts).toBe(3);
    expect(records.filter(({ event }) => event === "preflight_stalled")).toEqual([
      expect.objectContaining({
        preflightFailureReason: "requestRejected",
        requestCauseType: "TypeError",
        preflightFailuresSinceReady: 3,
        activeTerminalSubscriptions: 1,
        preflightsInFlight: 0,
        transportPhase: "preflight",
        routeKind: "loopback",
        attemptSuperseded: false,
      }),
    ]);
    expect(records.filter(({ event }) => event === "attachment_failed")).toHaveLength(3);

    const attachment = await coordinator.attachTerminal(
      { id: sessionId, runtime_epoch: 7 },
      () => {},
    );
    expect(preflightAttempts).toBe(4);
    expect(diagnosticLines.map(record)).toContainEqual(expect.objectContaining({
      event: "preflight_recovered",
      failedAttempts: 3,
      ready: true,
      transportPhase: "ready",
    }));

    await attachment.detach();
    coordinator.close();
  });

  it("observes whether a timed-out native request actually settles after abort", async () => {
    let settleRequest: ((value: { kind: "requestRejected"; causeType: string }) => void) | undefined;
    const lateSettlement = new Promise<{ kind: "requestRejected"; causeType: string }>((resolve) => {
      settleRequest = resolve;
    });
    const diagnosticLines: string[] = [];
    const coordinator = new MobileConnectionCoordinator(
      connection,
      () => { throw new Error("socket must not be created"); },
      createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
      async () => {
        throw new GatewayReachabilityError("timeout", undefined, undefined, lateSettlement);
      },
    );

    await expect(coordinator.attachTerminal(
      { id: sessionId, runtime_epoch: 7 },
      () => {},
    )).rejects.toThrow("not reachable");
    settleRequest?.({ kind: "requestRejected", causeType: "AbortError" });
    await waitFor(() => events(diagnosticLines).includes("preflight_request_settled_after_timeout"));

    expect(diagnosticLines.map(record)).toContainEqual(expect.objectContaining({
      event: "preflight_request_settled_after_timeout",
      lateSettlement: "requestRejected",
      requestCauseType: "AbortError",
      routeKind: "loopback",
    }));

    coordinator.close();
  });
});

function authenticatingSocket(
  onSend: (socket: DataSocket, data: string | ArrayBuffer | Uint8Array) => void = () => {},
): DataSocket {
  const socket: DataSocket = {
    binaryType: "blob",
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (typeof data === "string") {
        const message = JSON.parse(data) as { type?: string };
        if (message.type === "mobile.authenticate") {
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({
            event: "mobile.ready",
            mobileTransportVersion: 2,
          }) }));
        }
      }
      onSend(socket, data);
    },
    close() {},
  };
  queueMicrotask(() => socket.onopen?.());
  return socket;
}

function silentSocket(): DataSocket {
  const socket: DataSocket = {
    binaryType: "blob",
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send() {},
    close() {},
  };
  queueMicrotask(() => socket.onopen?.());
  return socket;
}

function events(lines: readonly string[]): string[] {
  return lines.map(record).map(({ event }) => String(event));
}

function record(line: string): Record<string, unknown> {
  return JSON.parse(line.replace("[termloop-mobile] ", "")) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}
