import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalEvent } from "../src/application/ports";
import type { DataSocket } from "../src/adapters/production/data-socket";
import { MobileConnectionCoordinator } from "../src/adapters/production/mobile-connection-coordinator";
import {
  KIND_ACK,
  KIND_ATTACH,
  KIND_INPUT,
  decodeFrame,
  encodeFrame,
} from "../src/adapters/production/terminal-frame";
import { createMobileDiagnosticReporter } from "../src/platform/mobile-diagnostics";
import type { SavedConnection } from "../src/platform/secure-connections";

const session = { id: "11111111-2222-4333-8444-555555555555", runtime_epoch: 7 };
const otherSession = { ...session, id: "22222222-2222-4333-8444-555555555555" };
const version = { product: "TermLoop", version: "2.0.4", protocolVersion: "test-contract" };
const connection: SavedConnection = {
  id: "macbook",
  name: "MacBook",
  controlUrl: "ws://127.0.0.1:48100/control",
  controlToken: "fake-control-token",
  terminalUrl: "ws://127.0.0.1:48100/terminal",
  terminalToken: "fake-terminal-token",
  lastConnectedAtEpochMs: null,
  productVersion: null,
  contractIdentity: null,
};
const coordinators: MobileConnectionCoordinator[] = [];

afterEach(() => {
  coordinators.splice(0).forEach((coordinator) => coordinator.close());
  vi.useRealTimers();
});

describe("multiplexed mobile transport recovery", () => {
  it("retries concurrent safe reads on one fresh physical socket after a silent request times out", async () => {
    vi.useFakeTimers();
    const { coordinator, sockets } = fixture();
    const results = Promise.all([
      coordinator.control.call("system.version"),
      coordinator.control.call("project.list"),
    ]);
    void results.catch(() => {});
    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.requests.map(({ method }) => method)).toEqual(["system.version", "project.list"]);

    // Delayed events from the retired native socket cannot retire its replacement.
    sockets[0]!.socket.onopen?.();
    sockets[0]!.socket.onclose?.();
    sockets[0]!.socket.onerror?.();
    sockets[1]!.reply(0, version);
    sockets[1]!.reply(1, []);
    await expect(results).resolves.toEqual([version, []]);
    expect(sockets[1]!.close).not.toHaveBeenCalled();
  });

  it("retires the physical socket on a command timeout without replaying the command", async () => {
    vi.useFakeTimers();
    const { coordinator, sockets } = fixture();
    const command = coordinator.control.call("session.close", { sessionId: session.id });
    const rejected = expect(command).rejects.toThrow("request timeout");
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.close).toHaveBeenCalledOnce();

    const read = coordinator.control.call("system.version");
    await flush();
    expect(sockets).toHaveLength(2);
    expect(sockets.flatMap(({ requests }) => requests.map(({ method }) => method))).toEqual([
      "session.close", "system.version",
    ]);
    sockets[1]!.reply(0, version);
    await expect(read).resolves.toEqual(version);
  });

  it.each(["detach", "abort", "replace"] as const)("preserves other terminals and pending control reads when an input-owning route leaves via %s", async (departure) => {
    const { coordinator, sockets } = fixture();
    const abort = new AbortController();
    const first = await coordinator.attachTerminal(session, () => {}, { signal: abort.signal });
    const otherEvents: TerminalEvent[] = [];
    await coordinator.attachTerminal(otherSession, (event) => otherEvents.push(event));
    const read = coordinator.control.call("system.version");
    const result = read.catch((cause: unknown) => cause);
    await flush();
    const input = first.input(new Uint8Array([65]));
    const rejected = expect(input).rejects.toThrow();

    if (departure === "detach") await first.detach();
    else if (departure === "abort") abort.abort();
    else await coordinator.attachTerminal(session, () => {});
    await rejected;

    expect(otherEvents).not.toContainEqual({ type: "state", state: "connectionLost" });
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    sockets[0]!.reply(0, version);
    await expect(result).resolves.toEqual(version);
  });

  it("still reconnects after a real input send failure without replaying the input", async () => {
    vi.useFakeTimers();
    const { coordinator, sockets } = fixture();
    const events: TerminalEvent[] = [];
    const attachment = await coordinator.attachTerminal(session, (event) => events.push(event));
    sockets[0]!.failInput = true;
    await expect(attachment.input(new Uint8Array([65]))).rejects.toThrow("Socket send failed.");
    expect(events).toContainEqual({ type: "inputDelivery", state: "uncertain" });
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.frames.map(({ kind }) => kind)).toEqual([KIND_ATTACH]);
  });

  it("does not open a replacement socket after background cancellation", async () => {
    vi.useFakeTimers();
    const { coordinator, sockets } = fixture();
    await coordinator.attachTerminal(session, () => {});
    const read = coordinator.control.call("system.version");
    const rejected = expect(read).rejects.toThrow("connection closed");
    await flush();
    coordinator.resetTransport(false);
    await rejected;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
  });
});

interface SocketFixture {
  socket: DataSocket;
  close: ReturnType<typeof vi.fn>;
  requests: { id: string; method: string }[];
  frames: ReturnType<typeof decodeFrame>[];
  failInput: boolean;
  reply(index: number, result: unknown): void;
}

function fixture() {
  const sockets: SocketFixture[] = [];
  const coordinator = new MobileConnectionCoordinator(connection, () => {
    const state: SocketFixture = {
      socket: {
        binaryType: "arraybuffer",
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send(data) {
          if (typeof data === "string") {
            const message = JSON.parse(data);
            if (message.type === "mobile.authenticate") {
              queueMicrotask(() => state.socket.onmessage?.({ data: JSON.stringify({
                event: "mobile.ready", mobileTransportVersion: 2, terminalInputAckVersion: 1,
              }) }));
            } else if (message.method) state.requests.push(message);
            return;
          }
          const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
          state.frames.push(frame);
          if (frame.kind === KIND_ATTACH) {
            queueMicrotask(() => state.socket.onmessage?.({ data: encodeFrame(frame.sessionId, frame.epoch, frame.sequence, KIND_ACK) }));
          } else if (frame.kind === KIND_INPUT && state.failInput) throw new Error("Socket send failed.");
        },
        // Native sockets may never emit close; recovery must settle without it.
        close() { state.close(); },
      },
      close: vi.fn(),
      requests: [],
      frames: [],
      failInput: false,
      reply(index, result) {
        state.socket.onmessage?.({ data: JSON.stringify({ id: state.requests[index]!.id, ok: true, result }) });
      },
    };
    sockets.push(state);
    queueMicrotask(() => state.socket.onopen?.());
    return state.socket;
  }, createMobileDiagnosticReporter(() => {}));
  coordinators.push(coordinator);
  return { coordinator, sockets };
}

async function flush() {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}
