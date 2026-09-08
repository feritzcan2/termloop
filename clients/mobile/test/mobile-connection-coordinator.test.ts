import { describe, expect, it, vi } from "vitest";

import type { TerminalEvent } from "../src/application/ports";
import { MobileConnectionCoordinator } from "../src/adapters/production/mobile-connection-coordinator";
import type { DataSocket } from "../src/adapters/production/data-socket";
import { GatewayReachabilityError } from "../src/adapters/production/gateway-compatibility";
import {
  KIND_ACK,
  KIND_ATTACH,
  KIND_ERROR,
  KIND_REPLAY_OUTPUT,
  KIND_OUTPUT,
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
  it("cancels a departed route during preflight without sending its attach later", async () => {
    let finishPreflight: (() => void) | undefined;
    let attaches = 0;
    const lines: string[] = [];
    const coordinator = new MobileConnectionCoordinator(connection, () => authenticatingSocket((_socket, data) => {
      if (typeof data !== "string" && decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data)).kind === KIND_ATTACH) attaches += 1;
    }), createMobileDiagnosticReporter((line) => lines.push(line)), () => new Promise<void>((resolve) => { finishPreflight = resolve; }));
    const route = new AbortController();
    const attaching = coordinator.attachTerminal({ id: sessionId, runtime_epoch: 7 }, () => {}, { signal: route.signal });
    const cancelled = expect(attaching).rejects.toThrow("cancelled");
    route.abort();
    await cancelled;
    finishPreflight!();
    await waitFor(() => events(lines).includes("connection_ready"));
    expect(attaches).toBe(0);
    coordinator.close();
  });

  it("cancels in-flight reads on background without retrying or allocating a socket", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      let requests = 0;
      let sockets = 0;
      const coordinator = new MobileConnectionCoordinator(connection, () => {
        sockets += 1;
        return authenticatingSocket((_socket, data) => {
          if (typeof data === "string" && JSON.parse(data).method) requests += 1;
        });
      }, createMobileDiagnosticReporter((line) => lines.push(line)));
      const reading = coordinator.control.call("system.version").catch((error: unknown) => error);
      await waitFor(() => requests === 1);
      coordinator.resetTransport(false);
      expect(await reading).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sockets).toBe(1);
      expect(requests).toBe(1);
      expect(events(lines)).not.toContain("request_retry");
      await expect(coordinator.control.call("system.version")).rejects.toThrow();
      expect(sockets).toBe(1);
      coordinator.resetTransport(true);
      const resumed = coordinator.control.call("system.version").catch((error: unknown) => error);
      await waitFor(() => requests === 2);
      expect(sockets).toBe(2);
      coordinator.close();
      await resumed;
    } finally { vi.useRealTimers(); }
  });

  it.each(["overlap", "miss", "empty"])("resumes with a small suffix and expands only when continuity fails (%s)", async (mode) => {
    const prior = new TextEncoder().encode("previous line\n".repeat(6000));
    const resumed = new TextEncoder().encode("previous line\n".repeat(4000) + "new output\n");
    const unrelated = new TextEncoder().encode("different output\n".repeat(3000));
    const limits: number[] = [];
    const terminalEvents: TerminalEvent[] = [];
    const coordinator = new MobileConnectionCoordinator(connection, () => authenticatingSocket((socket, data) => {
      if (typeof data === "string") return;
      const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
      if (frame.kind !== KIND_ATTACH) return;
      limits.push(new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(4));
      const output = limits.length === 1 && mode !== "overlap"
        ? mode === "empty" ? new Uint8Array() : unrelated : resumed;
      const metadata = new Uint8Array(12);
      metadata.set(new TextEncoder().encode("TLRA"));
      const view = new DataView(metadata.buffer);
      view.setUint32(4, output.byteLength === 0 ? 0 : 1);
      view.setUint32(8, output.byteLength);
      queueMicrotask(() => {
        socket.onmessage?.({ data: encodeFrame(sessionId, 7, frame.sequence, KIND_ACK, metadata) });
        if (output.byteLength > 0) socket.onmessage?.({ data: encodeFrame(sessionId, 7, 1n, KIND_REPLAY_OUTPUT, output) });
        socket.onmessage?.({ data: encodeFrame(sessionId, 7, 2n, KIND_OUTPUT, new Uint8Array([42])) });
      });
    }), createMobileDiagnosticReporter(() => {}));
    const attachment = await coordinator.attachTerminal({ id: sessionId, runtime_epoch: 7 }, (event) => terminalEvents.push(event), { previousOutputTail: prior });
    await waitFor(() => terminalEvents.some((event) => event.type === "live"));
    expect(limits).toEqual(mode === "overlap" ? [65536] : [65536, 1048576]);
    expect(terminalEvents.filter((event) => event.type === "replay")).toEqual([{ type: "replay", bytes: resumed }]);
    expect(terminalEvents.filter((event) => event.type === "live")).toEqual([{ type: "live", bytes: new Uint8Array([42]) }]);
    await attachment.detach();
    coordinator.close();
  });

  it("ignores a retired socket's Blob read when it completes after foreground recovery", async () => {
    const sockets: DataSocket[] = [];
    const delivered: TerminalEvent[] = [];
    const coordinator = new MobileConnectionCoordinator(connection, () => {
      const socket = authenticatingSocket((current, data) => {
        if (typeof data === "string") return;
        const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (frame.kind === KIND_ATTACH) queueMicrotask(() => current.onmessage?.({ data: encodeFrame(sessionId, 7, frame.sequence, KIND_ACK) }));
      });
      sockets.push(socket);
      return socket;
    }, createMobileDiagnosticReporter(() => {}));
    const attachment = await coordinator.attachTerminal({ id: sessionId, runtime_epoch: 7 }, (event) => delivered.push(event));
    let finish: ((bytes: ArrayBuffer) => void) | undefined;
    const delayed = new Blob();
    Object.defineProperty(delayed, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) });
    sockets[0]!.onmessage?.({ data: delayed });
    await waitFor(() => finish !== undefined);
    coordinator.resetTransport(false);
    coordinator.resetTransport(true);
    await waitFor(() => delivered.filter((event) => event.type === "state" && event.state === "connected").length === 2);
    finish!(encodeFrame(sessionId, 7, 100n, KIND_OUTPUT, new Uint8Array([99])));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(delivered.some((event) => event.type === "live")).toBe(false);
    sockets[1]!.onmessage?.({ data: encodeFrame(sessionId, 7, 1n, KIND_OUTPUT, new Uint8Array([42])) });
    await waitFor(() => delivered.some((event) => event.type === "live"));
    expect(delivered.filter((event) => event.type === "live")).toEqual([{ type: "live", bytes: new Uint8Array([42]) }]);
    await attachment.detach();
    coordinator.close();
  });

  it("samples retired-route frames instead of logging every queued output packet", async () => {
    const lines: string[] = [];
    let socket: DataSocket | undefined;
    const coordinator = new MobileConnectionCoordinator(connection, () => {
      socket = authenticatingSocket();
      return socket;
    }, createMobileDiagnosticReporter((line) => lines.push(line)));
    const unsubscribe = coordinator.subscribeInvalidations(() => {});
    await waitFor(() => events(lines).includes("connection_ready"));
    for (let i = 0; i < 100; i++) socket!.onmessage?.({ data: encodeFrame(sessionId, 7, BigInt(i + 1), KIND_OUTPUT) });
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(events(lines).filter((event) => event === "orphan_frame_ignored")).toHaveLength(1);
    unsubscribe();
    coordinator.close();
  });

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

  it("does not maintain a reconnect loop for overview invalidations alone", async () => {
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
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sockets).toHaveLength(1);
      expect(events(diagnosticLines)).not.toContain("reconnect_scheduled");
      expect(events(diagnosticLines)).not.toContain("reconnect_stalled");

      unsubscribeInvalidations();
      unsubscribeStatus();
      coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps reconnect backoff while a terminal is actively waiting", async () => {
    vi.useFakeTimers();
    try {
      const diagnosticLines: string[] = [];
      const sockets: DataSocket[] = [];
      let reachable = true;
      let preflightAttempts = 0;
      const coordinator = new MobileConnectionCoordinator(
        connection,
        () => {
          const socket = authenticatingSocket((current, data) => {
            if (typeof data === "string") return;
            const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
            if (frame.kind === KIND_ATTACH) {
              queueMicrotask(() => current.onmessage?.({
                data: encodeFrame(frame.sessionId, frame.epoch, frame.sequence, KIND_ACK),
              }));
            }
          });
          sockets.push(socket);
          return socket;
        },
        createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
        async () => {
          preflightAttempts += 1;
          if (!reachable) throw new GatewayReachabilityError("requestRejected", "TypeError");
        },
      );
      const attachment = await coordinator.attachTerminal(
        { id: sessionId, runtime_epoch: 7 },
        () => {},
      );

      reachable = false;
      sockets[0]!.onclose?.({ code: 1006, wasClean: false });
      for (const delay of [500, 1_000, 2_000, 4_000, 5_000, 5_000]) {
        await vi.advanceTimersByTimeAsync(delay);
      }

      const delays = diagnosticLines.map(record)
        .filter(({ event }) => event === "reconnect_scheduled")
        .map(({ delayMs }) => delayMs);
      expect(delays.slice(0, 6)).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);

      const attemptsBeforeRetry = preflightAttempts;
      const schedulesBeforeRetry = diagnosticLines.map(record)
        .filter(({ event }) => event === "reconnect_scheduled").length;
      void attachment.reconnect().catch(() => {});
      await waitFor(() => preflightAttempts > attemptsBeforeRetry);
      await waitFor(() => diagnosticLines.map(record)
        .filter(({ event }) => event === "reconnect_scheduled").length > schedulesBeforeRetry);
      const schedulesAfterRetry = diagnosticLines.map(record)
        .filter(({ event }) => event === "reconnect_scheduled");
      expect(schedulesAfterRetry.at(-1)?.delayMs).toBe(500);

      await attachment.detach();
      coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a terminal-blocking preflight failure streak with safe transport state", async () => {
    const diagnosticLines: string[] = [];
    const terminalEvents: TerminalEvent[] = [];
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
        (event) => terminalEvents.push(event),
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
    expect(terminalEvents).toContainEqual({
      type: "state",
      state: "connectionLost",
      issue: "gatewayUnreachable",
    });

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
