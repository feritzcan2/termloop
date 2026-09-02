import { CONTRACT_IDENTITY, type SocketLike } from "@termloop/contract/current";
import { describe, expect, it, vi } from "vitest";

import type { TerminalEvent } from "../src/application/ports";
import { createProductionRuntime, type DataSocket } from "../src/adapters/production/production-runtime";
import { MOBILE_API_VERSION, MobileControlClient } from "../src/adapters/production/mobile-control-client";
import {
  KIND_ACK,
  KIND_ATTACH,
  KIND_DETACH,
  KIND_ERROR,
  KIND_GAP,
  KIND_INPUT,
  KIND_INPUT_ACK,
  KIND_OUTPUT,
  KIND_REPLAY_OUTPUT,
  MOBILE_REPLAY_BUDGET_BYTES,
  MOBILE_REPLAY_CHUNK_BYTES,
  decodeFrame,
  encodeFrame,
} from "../src/adapters/production/terminal-frame";
import {
  createSecureConnectionRepository,
  type SavedConnection,
  type SecretStore,
} from "../src/platform/secure-connections";
import { createMobileDiagnosticReporter } from "../src/platform/mobile-diagnostics";
import { createStewardVoiceReceiptStore } from "../src/platform/steward-voice-receipts";
import { createWatchTargetSettings } from "../src/platform/watch-target-settings";
import {
  fixtureAgentCapabilities,
  fixtureAgentStatuses,
  fixturePlaybook,
  fixturePlaybookRuntime,
  fixtureProjects,
  fixtureRoutines,
  fixtureSessions,
  fixtureStewardTranscript,
  fixtureTasks,
  fixtureTaskWorktreeChanges,
  fixtureTaskWorktreeDiffs,
  fixtureTaskWorktreePreImages,
} from "../src/fixtures/mobile-overview";

const sessionId = "11111111-2222-4333-8444-555555555555";
const daemonContractIdentity = `sha256:${"b".repeat(64)}`;

const saved: SavedConnection = {
  id: "macbook",
  name: "Ferit's MacBook",
  controlUrl: "ws://127.0.0.1:48100/control",
  controlToken: "control-token-1234567890",
  terminalUrl: "ws://127.0.0.1:48100/terminal",
  terminalToken: "terminal-token-1234567890",
  lastConnectedAtEpochMs: 1_786_617_480_000,
  productVersion: null,
  contractIdentity: CONTRACT_IDENTITY,
};

describe("secure connection repository", () => {
  it("round-trips credentials through only the injected secret store", async () => {
    const secretStore = memorySecretStore();
    const repository = createSecureConnectionRepository(secretStore);
    await repository.save(saved);

    expect(await repository.list()).toEqual([saved]);
    expect(await repository.get(saved.id)).toEqual(saved);
    expect([...secretStore.values.values()].join(" ")).toContain(saved.controlToken);

    await repository.remove(saved.id);
    expect(await repository.list()).toEqual([]);
  });

  it("refuses credentials embedded in an endpoint URL", async () => {
    const repository = createSecureConnectionRepository(memorySecretStore());
    await expect(repository.save({
      ...saved,
      controlUrl: "ws://token@127.0.0.1:48100/control",
    })).rejects.toThrow("credential-free");
  });

  it("ignores stored connection records with unsupported fields", async () => {
    const store = memorySecretStore();
    const repository = createSecureConnectionRepository(store);
    await repository.save(saved);
    const profileKey = [...store.values.keys()].find((key) => key.endsWith(saved.id));
    expect(profileKey).toBeDefined();
    store.values.set(profileKey!, JSON.stringify({ ...saved, unsupportedTransport: {} }));

    expect(await repository.get(saved.id)).toBeUndefined();
  });

  it("keeps a Watch destination per Mac without changing its connection record", async () => {
    const store = memorySecretStore();
    const repository = createSecureConnectionRepository(store);
    const settings = createWatchTargetSettings(store);
    await repository.save(saved);

    await settings.set(saved.id, "project-1");

    expect(await settings.get(saved.id)).toBe("project-1");
    expect(await repository.get(saved.id)).toEqual(saved);
  });

  it("persists only the Steward delivery receipt, not transcript content", async () => {
    const store = memorySecretStore();
    const receipts = createStewardVoiceReceiptStore(store);

    expect(await receipts.read("macbook", "project-1")).toEqual({
      initialized: false,
      acknowledgedSequence: 0,
      pendingUserSequence: null,
    });
    await receipts.write("macbook", "project-1", {
      initialized: true,
      acknowledgedSequence: 21,
      pendingUserSequence: 24,
    });

    expect(await receipts.read("macbook", "project-1")).toEqual({
      initialized: true,
      acknowledgedSequence: 21,
      pendingUserSequence: 24,
    });
    expect([...store.values.values()].join(" ")).not.toContain("Steward reply");
  });
});

describe("production control adapter", () => {
  it("uses one authenticated mobile socket for control and logical terminal subscriptions", async () => {
    const terminalKinds: number[] = [];
    const controlMethods: string[] = [];
    let socketCount = 0;
    let socketCloseCount = 0;
    let heartbeatPongs = 0;
    let mobileSocket: DataSocket | undefined;
    let inputFrame: ReturnType<typeof decodeFrame> | undefined;
    let attachFrame: ReturnType<typeof decodeFrame> | undefined;
    let endpoint = "";
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      multiplexSocketFactory(url) {
        socketCount += 1;
        endpoint = url;
        const socket: DataSocket = {
          binaryType: "blob",
          readyState: 1,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send(data) {
            if (typeof data === "string") {
              const message = JSON.parse(data) as {
                type?: string;
                id?: string;
                method?: string;
                controlToken?: string;
                terminalToken?: string;
                mobileHeartbeatVersion?: number;
                mobileInputReceiptVersion?: number;
                terminalInputAckVersion?: number;
              };
              if (message.type === "mobile.authenticate") {
                expect(message.controlToken).toBe(saved.controlToken);
                expect(message.terminalToken).toBe(saved.terminalToken);
                expect(message.mobileHeartbeatVersion).toBe(1);
                expect(message.mobileInputReceiptVersion).toBe(1);
                expect(message.terminalInputAckVersion).toBe(1);
                queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({
                  event: "mobile.ready",
                  mobileTransportVersion: 2,
                  terminalInputAckVersion: 1,
                }) }));
                return;
              }
              if (message.type === "mobile.pong") {
                heartbeatPongs += 1;
                return;
              }
              controlMethods.push(message.method ?? "");
              queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({
                id: message.id,
                ok: true,
                result: controlResult(message.method ?? ""),
              }) }));
              return;
            }
            const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
            terminalKinds.push(frame.kind);
            if (frame.kind === KIND_ATTACH) {
              attachFrame = frame;
              queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                frame.sessionId,
                frame.epoch,
                frame.sequence,
                KIND_ACK,
                replayAckPayload(2, 13),
              ) }));
            } else if (frame.kind === KIND_INPUT) {
              inputFrame = frame;
            }
          },
          close() { socketCloseCount += 1; },
        };
        mobileSocket = socket;
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      controlSocketFactory: () => { throw new Error("legacy control transport used"); },
      terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
    });

    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({ availability: "online" }),
    ]);
    mobileSocket?.onmessage?.({ data: JSON.stringify({ event: "mobile.ping" }) });
    await waitFor(() => heartbeatPongs === 1);
    const events: TerminalEvent[] = [];
    const attachment = await runtime.terminal.attach(
      saved.id,
      { id: sessionId, runtime_epoch: 7 },
      (event) => events.push(event),
    );
    expect(new TextDecoder().decode(attachFrame?.payload.slice(0, 4))).toBe("TLRQ");
    expect(new DataView(attachFrame!.payload.buffer).getUint32(4)).toBe(MOBILE_REPLAY_BUDGET_BYTES);
    expect(new DataView(attachFrame!.payload.buffer).getUint32(8)).toBe(MOBILE_REPLAY_CHUNK_BYTES);
    mobileSocket?.onmessage?.({ data: encodeFrame(
      sessionId, 7, 1n, KIND_REPLAY_OUTPUT, new TextEncoder().encode("older "),
    ) });
    mobileSocket?.onmessage?.({ data: encodeFrame(
      sessionId, 7, 2n, KIND_REPLAY_OUTPUT, new TextEncoder().encode("latest\n"),
    ) });
    await waitFor(() => events.some((event) => event.type === "replay"));
    const replay = events.find((event) => event.type === "replay");
    expect(replay?.type === "replay" ? new TextDecoder().decode(replay.bytes) : undefined)
      .toBe("older latest\n");
    let delivered = false;
    const input = attachment.input(new TextEncoder().encode("hello")).then(() => { delivered = true; });
    await waitFor(() => inputFrame !== undefined);
    expect(delivered).toBe(false);
    mobileSocket?.onmessage?.({ data: encodeFrame(
      inputFrame!.sessionId,
      inputFrame!.epoch,
      inputFrame!.sequence,
      KIND_INPUT_ACK,
    ) });
    await input;
    expect(delivered).toBe(true);
    await expect(attachment.input(new Uint8Array((128 * 16 * 1024) + 1)))
      .rejects.toThrow("Too much terminal input is awaiting delivery.");
    await attachment.detach();

    expect(socketCount).toBe(1);
    expect(endpoint).toBe("ws://127.0.0.1:48100/mobile");
    expect(controlMethods).toEqual(["system.version"]);
    expect(terminalKinds).toEqual([KIND_ATTACH, KIND_INPUT, KIND_DETACH]);
    expect(events).toContainEqual({ type: "state", state: "connected" });
    expect(socketCloseCount).toBe(0);
    expect(heartbeatPongs).toBe(1);
  });

  it("publishes a paced multiplex replay once after a full quiet window", async () => {
    vi.useFakeTimers();
    try {
      let mobileSocket: DataSocket | undefined;
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        multiplexSocketFactory() {
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
                return;
              }
              const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
              if (frame.kind === KIND_ATTACH) {
                queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                  frame.sessionId,
                  frame.epoch,
                  frame.sequence,
                  KIND_ACK,
                ) }));
              }
            },
            close() {},
          };
          mobileSocket = socket;
          queueMicrotask(() => socket.onopen?.());
          return socket;
        },
        controlSocketFactory: () => { throw new Error("legacy control transport used"); },
        terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
      });
      const events: TerminalEvent[] = [];
      const attachment = await runtime.terminal.attach(
        saved.id,
        { id: sessionId, runtime_epoch: 7 },
        (event) => events.push(event),
      );

      mobileSocket?.onmessage?.({ data: encodeFrame(
        sessionId, 7, 1n, KIND_REPLAY_OUTPUT, new TextEncoder().encode("older "),
      ) });
      await vi.advanceTimersByTimeAsync(600);
      mobileSocket?.onmessage?.({ data: encodeFrame(
        sessionId, 7, 2n, KIND_REPLAY_OUTPUT, new TextEncoder().encode("latest\n"),
      ) });
      await vi.advanceTimersByTimeAsync(999);
      expect(events.some((event) => event.type === "replay")).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const replays = events.filter((event) => event.type === "replay");
      expect(replays).toHaveLength(1);
      expect(replays[0]?.type === "replay" ? new TextDecoder().decode(replays[0].bytes) : undefined)
        .toBe("older latest\n");

      await attachment.detach();
      runtime.connections.resetTransports();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a newer route replace an attachment that is still awaiting its ACK", async () => {
    const terminalFrames: Array<ReturnType<typeof decodeFrame>> = [];
    let mobileSocket: DataSocket | undefined;
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      multiplexSocketFactory() {
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
              return;
            }
            terminalFrames.push(decodeFrame(
              data instanceof Uint8Array ? data : new Uint8Array(data),
            ));
          },
          close() {},
        };
        mobileSocket = socket;
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      controlSocketFactory: () => { throw new Error("legacy control transport used"); },
      terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
    });

    const first = runtime.terminal.attach(
      saved.id,
      { id: sessionId, runtime_epoch: 7 },
      () => {},
    );
    const firstRejection = expect(first).rejects.toThrow(
      "Terminal attachment was replaced by a newer view.",
    );
    await waitFor(() => terminalFrames.length === 1);
    const second = runtime.terminal.attach(
      saved.id,
      { id: sessionId, runtime_epoch: 7 },
      () => {},
    );
    await waitFor(() => terminalFrames.length === 3);
    await firstRejection;

    expect(terminalFrames.map(({ kind }) => kind)).toEqual([
      KIND_ATTACH,
      KIND_DETACH,
      KIND_ATTACH,
    ]);
    const currentAttach = terminalFrames[2]!;
    mobileSocket?.onmessage?.({ data: encodeFrame(
      currentAttach.sessionId,
      currentAttach.epoch,
      currentAttach.sequence,
      KIND_ACK,
    ) });
    const attachment = await second;
    await attachment.detach();
    runtime.connections.resetTransports();
  });

  it("settles a silent in-flight attach when lifecycle recovery retires its socket", async () => {
    let socketCount = 0;
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      multiplexSocketFactory() {
        socketCount += 1;
        return {
          binaryType: "blob",
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send() { throw new Error("silent socket is not open"); },
          // Deliberately emits no close callback, matching the suspended iOS
          // WebSocket that previously left the attach promise pending forever.
          close() {},
        } satisfies DataSocket;
      },
      controlSocketFactory: () => { throw new Error("legacy control transport used"); },
      terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
    });

    const attaching = runtime.terminal.attach(
      saved.id,
      { id: sessionId, runtime_epoch: 7 },
      () => {},
    );
    await waitFor(() => socketCount === 1);

    runtime.connections.resetTransports();

    await expect(attaching).rejects.toThrow("Mobile transport disconnected.");
  });

  it("preserves a terminal subscription while foreground recovery replaces its socket", async () => {
    const sockets: Array<DataSocket & { closed: boolean }> = [];
    const attachGenerations: number[] = [];
    const diagnosticLines: string[] = [];
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      diagnostics: createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
      multiplexSocketFactory() {
        const generation = sockets.length + 1;
        const socket: DataSocket & { closed: boolean } = {
          binaryType: "blob",
          readyState: 1,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          closed: false,
          send(data) {
            if (typeof data === "string") {
              const message = JSON.parse(data) as { type?: string; id?: string; method?: string };
              if (message.type === "mobile.authenticate") {
                queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({
                  event: "mobile.ready",
                  mobileTransportVersion: 2,
                }) }));
                return;
              }
              queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({
                id: message.id,
                ok: true,
                result: controlResult(message.method ?? ""),
              }) }));
              return;
            }
            const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
            if (frame.kind === KIND_ATTACH) {
              attachGenerations.push(generation);
              queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                frame.sessionId,
                frame.epoch,
                frame.sequence,
                KIND_ACK,
              ) }));
            }
          },
          // A native close callback is not required for recovery to finish.
          close() { socket.closed = true; },
        };
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      controlSocketFactory: () => { throw new Error("legacy control transport used"); },
      terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
    });
    const events: TerminalEvent[] = [];
    const attachment = await runtime.terminal.attach(
      saved.id,
      { id: sessionId, runtime_epoch: 7 },
      (event) => events.push(event),
    );

    let stalledReadStarted = false;
    const stalledMessage = new Blob([]);
    Object.defineProperty(stalledMessage, "arrayBuffer", {
      value: () => {
        stalledReadStarted = true;
        return new Promise<ArrayBuffer>(() => {});
      },
    });
    sockets[0]?.onmessage?.({ data: stalledMessage });
    await waitFor(() => stalledReadStarted);

    runtime.connections.resetTransports(false);
    expect(sockets[0]?.closed).toBe(true);
    expect(events.at(-1)).toEqual({ type: "state", state: "connectionLost" });
    expect(sockets).toHaveLength(1);
    expect(diagnosticLines.some((line) => line.includes('"event":"reconnect_cycle_started"')))
      .toBe(false);

    runtime.connections.resetTransports(true);
    await waitFor(() => events.filter((event) => (
      event.type === "state" && event.state === "connected"
    )).length === 2);

    expect(sockets).toHaveLength(2);
    expect(attachGenerations).toEqual([1, 2]);
    expect(diagnosticLines.some((line) => line.includes('"event":"reconnect_cycle_started"')))
      .toBe(true);
    await expect(attachment.input(new TextEncoder().encode("foreground recovered")))
      .resolves.toBeUndefined();

    await attachment.detach();
    runtime.connections.resetTransports();
  });

  it("reconnects instead of reporting success when an input receipt never arrives", async () => {
    vi.useFakeTimers();
    try {
      let socketClosed = false;
      const events: TerminalEvent[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        multiplexSocketFactory() {
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
                    mobileInputReceiptVersion: 1,
                  }) }));
                }
                return;
              }
              const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
              if (frame.kind === KIND_ATTACH) {
                queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                  frame.sessionId,
                  frame.epoch,
                  frame.sequence,
                  KIND_ACK,
                ) }));
              }
            },
            close() { socketClosed = true; },
          };
          queueMicrotask(() => socket.onopen?.());
          return socket;
        },
        controlSocketFactory: () => { throw new Error("legacy control transport used"); },
        terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
      });
      const attachment = await runtime.terminal.attach(
        saved.id,
        { id: sessionId, runtime_epoch: 7 },
        (event) => events.push(event),
      );

      const input = attachment.input(new TextEncoder().encode("unacknowledged"));
      const rejection = expect(input).rejects.toThrow("Terminal input delivery timed out.");
      await vi.advanceTimersByTimeAsync(7_000);
      await rejection;

      expect(socketClosed).toBe(true);
      expect(events.at(-1)).toEqual({ type: "state", state: "connectionLost" });
      runtime.connections.resetTransports();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a daemon-refused input without waiting for the receipt timeout", async () => {
    let inputFrame: ReturnType<typeof decodeFrame> | undefined;
    let mobileSocket: DataSocket | undefined;
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      multiplexSocketFactory() {
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
                  terminalInputAckVersion: 1,
                }) }));
              }
              return;
            }
            const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
            if (frame.kind === KIND_ATTACH) {
              queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                frame.sessionId,
                frame.epoch,
                frame.sequence,
                KIND_ACK,
              ) }));
            } else if (frame.kind === KIND_INPUT) {
              inputFrame = frame;
            }
          },
          close() {},
        };
        mobileSocket = socket;
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
      controlSocketFactory: () => { throw new Error("legacy control transport used"); },
      terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
    });
    const attachment = await runtime.terminal.attach(
      saved.id,
      { id: sessionId, runtime_epoch: 7 },
      () => {},
    );

    const input = attachment.input(new TextEncoder().encode("refused"));
    await waitFor(() => inputFrame !== undefined);
    mobileSocket?.onmessage?.({ data: encodeFrame(
      inputFrame!.sessionId,
      inputFrame!.epoch,
      inputFrame!.sequence,
      KIND_ERROR,
    ) });

    await expect(input).rejects.toThrow("The Mac refused this terminal input.");
    runtime.connections.resetTransports();
  });

  it("keeps a live terminal transport when one logical control request times out", async () => {
    vi.useFakeTimers();
    try {
      let mobileSocket: DataSocket | undefined;
      let socketClosed = false;
      let heartbeatPongs = 0;
      const events: TerminalEvent[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        multiplexSocketFactory() {
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
                } else if (message.type === "mobile.pong") {
                  heartbeatPongs += 1;
                }
                return;
              }
              const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
              if (frame.kind === KIND_ATTACH) {
                queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                  frame.sessionId,
                  frame.epoch,
                  frame.sequence,
                  KIND_ACK,
                ) }));
              }
            },
            close() { socketClosed = true; },
          };
          mobileSocket = socket;
          queueMicrotask(() => socket.onopen?.());
          return socket;
        },
        controlSocketFactory: () => { throw new Error("legacy control transport used"); },
        terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
      });
      const attachment = await runtime.terminal.attach(
        saved.id,
        { id: sessionId, runtime_epoch: 7 },
        (event) => events.push(event),
      );

      await expect(runtime.connections.list()).resolves.toEqual([
        expect.objectContaining({ availability: "online" }),
      ]);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(runtime.connections.list()).resolves.toEqual([
        expect.objectContaining({ availability: "online" }),
      ]);
      // The fresh authenticated activity must win over the older version probe
      // when that logical control request times out a moment later.
      mobileSocket?.onmessage?.({ data: JSON.stringify({ event: "mobile.ping" }) });
      await waitFor(() => heartbeatPongs === 1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(socketClosed).toBe(false);
      expect(events).not.toContainEqual({ type: "state", state: "connectionLost" });
      await expect(runtime.connections.list()).resolves.toEqual([
        expect.objectContaining({ availability: "online" }),
      ]);
      mobileSocket?.onmessage?.({ data: encodeFrame(
        sessionId,
        7,
        1n,
        KIND_OUTPUT,
        new TextEncoder().encode("still live"),
      ) });
      await waitFor(() => events.some((event) => event.type === "live"));

      await attachment.detach();
      runtime.connections.resetTransports();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds an authenticated transport that stops delivering inbound liveness", async () => {
    vi.useFakeTimers();
    try {
      let socketClosed = false;
      const events: TerminalEvent[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        multiplexSocketFactory() {
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
                return;
              }
              const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
              if (frame.kind === KIND_ATTACH) {
                queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                  frame.sessionId,
                  frame.epoch,
                  frame.sequence,
                  KIND_ACK,
                ) }));
              }
            },
            close() { socketClosed = true; },
          };
          queueMicrotask(() => socket.onopen?.());
          return socket;
        },
        controlSocketFactory: () => { throw new Error("legacy control transport used"); },
        terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
      });
      await runtime.terminal.attach(
        saved.id,
        { id: sessionId, runtime_epoch: 7 },
        (event) => events.push(event),
      );

      await vi.advanceTimersByTimeAsync(75_000);

      expect(socketClosed).toBe(true);
      expect(events.at(-1)).toEqual({ type: "state", state: "connectionLost" });
      runtime.connections.resetTransports();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reattaches multiplexed terminals after a transport fault and rejects stale output", async () => {
    vi.useFakeTimers();
    try {
      const sockets: DataSocket[] = [];
      const terminalFrames: Array<{ generation: number; kind: number }> = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        multiplexSocketFactory() {
          const generation = sockets.length + 1;
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
                return;
              }
              const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
              terminalFrames.push({ generation, kind: frame.kind });
              if (frame.kind === KIND_ATTACH) {
                queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                  frame.sessionId,
                  frame.epoch,
                  frame.sequence,
                  KIND_ACK,
                ) }));
              }
            },
            close() {},
          };
          sockets.push(socket);
          queueMicrotask(() => socket.onopen?.());
          return socket;
        },
        controlSocketFactory: () => { throw new Error("legacy control transport used"); },
        terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
      });
      const events: TerminalEvent[] = [];
      const attachment = await runtime.terminal.attach(
        saved.id,
        { id: sessionId, runtime_epoch: 7 },
        (event) => events.push(event),
      );
      const first = sockets[0]!;
      first.onmessage?.({ data: encodeFrame(
        sessionId, 7, 1n, KIND_OUTPUT, new TextEncoder().encode("one"),
      ) });
      first.onmessage?.({ data: encodeFrame(
        sessionId, 7, 1n, KIND_OUTPUT, new TextEncoder().encode("duplicate"),
      ) });
      first.onmessage?.({ data: encodeFrame(
        sessionId, 7, 3n, KIND_OUTPUT, new TextEncoder().encode("three"),
      ) });
      await waitFor(() => events.filter((event) => event.type === "live").length === 2);
      expect(events.filter((event) => event.type === "live").map((event) => (
        event.type === "live" ? new TextDecoder().decode(event.bytes) : ""
      ))).toEqual(["one", "three"]);
      expect(events).toContainEqual({ type: "gap", droppedFrames: 1 });

      first.onclose?.({ code: 1006, wasClean: false });
      expect(events.at(-1)).toEqual({ type: "state", state: "connectionLost" });
      await vi.advanceTimersByTimeAsync(500);
      await waitFor(() => sockets.length === 2
        && events.filter((event) => event.type === "state" && event.state === "connected").length === 2);
      expect(events).toContainEqual({ type: "reset" });
      expect(terminalFrames.filter((frame) => frame.kind === KIND_ATTACH)).toEqual([
        { generation: 1, kind: KIND_ATTACH },
        { generation: 2, kind: KIND_ATTACH },
      ]);

      sockets[1]!.onmessage?.({ data: encodeFrame(
        sessionId, 7, 1n, KIND_OUTPUT, new TextEncoder().encode("fresh"),
      ) });
      await waitFor(() => events.filter((event) => event.type === "live").length === 3);
      expect(events.at(-1)).toMatchObject({ type: "live" });

      await attachment.detach();
      runtime.connections.resetTransports();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a reconnect stall with attempts and elapsed time", async () => {
    vi.useFakeTimers();
    try {
      const sockets: DataSocket[] = [];
      const diagnosticLines: string[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        diagnostics: createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
        multiplexSocketFactory() {
          const socketIndex = sockets.length;
          const socket: DataSocket = {
            binaryType: "blob",
            readyState: 1,
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            send(data) {
              if (socketIndex !== 0) return;
              if (typeof data === "string") {
                const message = JSON.parse(data) as { type?: string };
                if (message.type === "mobile.authenticate") {
                  queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({
                    event: "mobile.ready",
                    mobileTransportVersion: 2,
                  }) }));
                }
                return;
              }
              const frame = decodeFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
              if (frame.kind === KIND_ATTACH) {
                queueMicrotask(() => socket.onmessage?.({ data: encodeFrame(
                  frame.sessionId,
                  frame.epoch,
                  frame.sequence,
                  KIND_ACK,
                ) }));
              }
            },
            close() {},
          };
          sockets.push(socket);
          queueMicrotask(() => socket.onopen?.());
          return socket;
        },
        controlSocketFactory: () => { throw new Error("legacy control transport used"); },
        terminalSocketFactory: () => { throw new Error("legacy terminal transport used"); },
      });
      const attachment = await runtime.terminal.attach(
        saved.id,
        { id: sessionId, runtime_epoch: 7 },
        () => {},
      );

      sockets[0]!.onclose?.({ code: 1006, wasClean: false });
      await vi.advanceTimersByTimeAsync(15_000);

      const records = diagnosticLines.map((line) => JSON.parse(
        line.replace("[termloop-mobile] ", ""),
      ) as Record<string, unknown>);
      expect(records).toContainEqual(expect.objectContaining({
        event: "reconnect_stalled",
        reconnectElapsedMs: 15_000,
        reconnectAttempt: expect.any(Number),
      }));
      expect(records.some(({ event }) => event === "reconnect_attempt_failed")).toBe(true);

      await attachment.detach();
      runtime.connections.resetTransports();
    } finally {
      vi.useRealTimers();
    }
  });

  it("correlates control requests with the current mobile run without logging request parameters", async () => {
    const diagnosticLines: string[] = [];
    const diagnostics = createMobileDiagnosticReporter((line) => diagnosticLines.push(line));
    diagnostics.updateLifecycle({
      nativeState: "active",
      foregroundRevision: 3,
      backgroundDurationMs: 2_500,
    });
    let sent: Record<string, unknown> | undefined;
    const client = new MobileControlClient(saved.controlUrl, saved.controlToken, () => {
      const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
      const emit = (type: string, event: { data?: string } = {}) => {
        for (const listener of listeners.get(type) ?? []) listener(event);
      };
      queueMicrotask(() => emit("open"));
      return {
        addEventListener(type, listener) {
          const current = listeners.get(type) ?? [];
          current.push(listener);
          listeners.set(type, current);
        },
        send(data) {
          sent = JSON.parse(data) as Record<string, unknown>;
          queueMicrotask(() => emit("message", { data: JSON.stringify({
            id: sent?.id,
            ok: true,
            result: controlResult("system.version"),
          }) }));
        },
        close() {},
      } satisfies SocketLike;
    }, diagnostics, saved.id);

    await expect(client.version()).resolves.toMatchObject({ product: "TermLoop" });

    expect(sent).toMatchObject({
      mobileRunId: diagnostics.runId,
      mobileAppState: "active",
      foregroundRevision: 3,
      backgroundDurationMs: 2_500,
      controlGeneration: 1,
      method: "system.version",
    });
    const records = diagnosticLines.map((line) => JSON.parse(line.replace("[termloop-mobile] ", "")));
    expect(records.map(({ event }) => event)).toEqual([
      "request_started",
      "connection_started",
      "connection_opened",
      "request_sent",
      "request_completed",
    ]);
    expect(diagnosticLines.join("\n")).not.toContain(saved.controlToken);
  });

  it("closes each still-connecting socket before retrying an unreachable Mac", async () => {
    vi.useFakeTimers();
    try {
      const sockets: Array<{ closed: boolean }> = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        controlSocketFactory() {
          const state = { closed: false };
          sockets.push(state);
          return {
            addEventListener() {},
            send() { throw new Error("socket never opened"); },
            close() { state.closed = true; },
          } satisfies SocketLike;
        },
        terminalSocketFactory: () => { throw new Error("terminal not used"); },
      });

      const probe = runtime.connections.list();
      await vi.advanceTimersByTimeAsync(250);

      await expect(probe).resolves.toEqual([
        expect.objectContaining({ availability: "reconnecting" }),
      ]);
      await vi.advanceTimersByTimeAsync(9_750);
      await expect(runtime.connections.list()).resolves.toEqual([
        expect.objectContaining({ availability: "offline" }),
      ]);
      expect(sockets).toHaveLength(2);
      expect(sockets.every(({ closed }) => closed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a safe read on a fresh socket after a foreground zombie times out", async () => {
    vi.useFakeTimers();
    try {
      let socketCount = 0;
      let firstClosed = false;
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        controlSocketFactory() {
          const socketNumber = ++socketCount;
          const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
          const emit = (type: string, event: { data?: string } = {}) => {
            for (const listener of listeners.get(type) ?? []) listener(event);
          };
          queueMicrotask(() => emit("open"));
          return {
            addEventListener(type, listener) {
              const current = listeners.get(type) ?? [];
              current.push(listener);
              listeners.set(type, current);
            },
            send(data) {
              if (socketNumber === 1) return;
              const request = JSON.parse(data) as { id: string };
              queueMicrotask(() => emit("message", {
                data: JSON.stringify({
                  id: request.id,
                  ok: true,
                  result: controlResult("system.version"),
                }),
              }));
            },
            close() {
              if (socketNumber === 1) firstClosed = true;
              emit("close");
            },
          } satisfies SocketLike;
        },
        terminalSocketFactory: () => { throw new Error("terminal not used"); },
      });

      const recoveredProbe = runtime.connections.list();
      await vi.advanceTimersByTimeAsync(250);
      await expect(recoveredProbe).resolves.toEqual([
        expect.objectContaining({ availability: "reconnecting" }),
      ]);
      await vi.advanceTimersByTimeAsync(4_750);
      await expect(runtime.connections.list()).resolves.toEqual([
        expect.objectContaining({ availability: "online" }),
      ]);
      expect(firstClosed).toBe(true);
      expect(socketCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a healthy Mac without waiting for another saved Mac's timeout", async () => {
    vi.useFakeTimers();
    try {
      const away: SavedConnection = {
        ...saved,
        id: "mac-pro",
        name: "Ferit's MacBook Pro",
        controlUrl: "ws://127.0.0.1:48200/control",
        terminalUrl: "ws://127.0.0.1:48200/terminal",
      };
      const healthySocket = controlSocketFactory([]);
      const runtime = createProductionRuntime({
        repository: {
          async list() { return [saved, away]; },
          async get(id) { return id === saved.id ? saved : id === away.id ? away : undefined; },
          async save() { throw new Error("not used"); },
          async remove() { throw new Error("not used"); },
        },
        controlSocketFactory(url) {
          if (url === away.controlUrl) {
            return {
              addEventListener() {},
              send() { throw new Error("socket never opened"); },
              close() {},
            } satisfies SocketLike;
          }
          return healthySocket();
        },
        terminalSocketFactory: () => { throw new Error("terminal not used"); },
      });

      const listing = runtime.connections.list();
      await vi.advanceTimersByTimeAsync(250);

      await expect(listing).resolves.toEqual([
        expect.objectContaining({ id: saved.id, availability: "online" }),
        expect.objectContaining({ id: away.id, availability: "reconnecting" }),
      ]);
      runtime.connections.resetTransports();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a command whose transport outcome is ambiguous", async () => {
    vi.useFakeTimers();
    try {
      let socketCount = 0;
      const client = new MobileControlClient(saved.controlUrl, saved.controlToken, () => {
        socketCount += 1;
        const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
        const emit = (type: string, event: { data?: string } = {}) => {
          for (const listener of listeners.get(type) ?? []) listener(event);
        };
        queueMicrotask(() => emit("open"));
        return {
          addEventListener(type, listener) {
            const current = listeners.get(type) ?? [];
            current.push(listener);
            listeners.set(type, current);
          },
          send() {},
          close() { emit("close"); },
        } satisfies SocketLike;
      });

      const command = client.call("session.rename", { sessionId, name: "Recovered" });
      const rejected = expect(command).rejects.toThrow("request timeout");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(socketCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses stable mobile API v1 across daemon identity changes and assembles overview projections", async () => {
    const repository = fixedRepository(saved);
    const methods: string[] = [];
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    let socketCount = 0;
    const createControlSocket = controlSocketFactory(methods, requests);
    const runtime = createProductionRuntime({
      repository,
      controlSocketFactory() {
        socketCount += 1;
        return createControlSocket();
      },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });

    const profiles = await runtime.connections.list();
    expect(profiles[0]).toMatchObject({
      availability: "online",
      productVersion: "0.4.1",
      contractIdentity: daemonContractIdentity,
    });

    const overview = await runtime.control.loadOverview(saved.id);
    expect(overview.projects).toEqual(fixtureProjects);
    expect(overview.stewardEnabledProjectIds).toEqual(fixtureProjects.map((project) => project.id));
    expect(overview.stewardExecutorSessionIds).toEqual({
      [fixtureProjects[0]!.id]: "steward-session",
    });
    expect(overview.tasks).toEqual(fixtureTasks);
    expect(overview.sessions).toEqual(fixtureSessions);
    expect(overview.agentStatuses).toEqual(fixtureAgentStatuses);
    expect(methods).toEqual(expect.arrayContaining([
      "system.version",
      "project.list",
      "task.list",
      "session.list",
      "agent.statusList",
      "steward.configurationGet",
    ]));
    expect(requests.find(({ method }) => method === "task.list")?.params).toEqual({
      projectId: fixtureProjects[0]?.id,
      archiveScope: "active",
      limit: 100,
    });
    expect(requests.every(({ mobileApiVersion }) => mobileApiVersion === MOBILE_API_VERSION)).toBe(true);
    expect(requests.every(({ protocolVersion }) => protocolVersion === undefined)).toBe(true);
    expect(socketCount).toBe(1);

    await runtime.connections.list();
    expect(methods.filter((method) => method === "system.version")).toHaveLength(1);
    runtime.connections.resetTransports();
    await runtime.connections.list();
    expect(methods.filter((method) => method === "system.version")).toHaveLength(2);
    expect(socketCount).toBe(2);
  });

  it("keeps a healthy profile cached when only saved display metadata changes", async () => {
    let current = saved;
    const renamedLastConnectedAtEpochMs = 1_786_617_481_000;
    const methods: string[] = [];
    const runtime = createProductionRuntime({
      repository: {
        async list() { return [current]; },
        async get(id) { return id === current.id ? current : undefined; },
        async save() { throw new Error("not used"); },
        async remove() { throw new Error("not used"); },
      },
      controlSocketFactory: controlSocketFactory(methods),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });

    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({ availability: "online", name: saved.name }),
    ]);
    current = {
      ...saved,
      name: "Renamed Mac",
      lastConnectedAtEpochMs: renamedLastConnectedAtEpochMs,
    };
    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({
        availability: "online",
        name: "Renamed Mac",
        lastConnectedAtEpochMs: renamedLastConnectedAtEpochMs,
      }),
    ]);
    expect(methods.filter((method) => method === "system.version")).toHaveLength(1);
  });

  it("keeps the overview usable when the optional Steward projection fails", async () => {
    const diagnosticLines: string[] = [];
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      diagnostics: createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
      controlSocketFactory: controlSocketFactory([], [], new Set(["steward.configurationGet"])),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });

    await expect(runtime.control.loadOverview(saved.id)).resolves.toMatchObject({
      projects: fixtureProjects,
      tasks: fixtureTasks,
      sessions: fixtureSessions,
      agentStatuses: fixtureAgentStatuses,
      stewardEnabledProjectIds: [],
      stewardExecutorSessionIds: {},
    });
    const records = diagnosticLines.map((line) => JSON.parse(line.replace("[termloop-mobile] ", "")));
    expect(records.filter(({ event }) => event === "optional_steward_read_failed")).toHaveLength(
      fixtureProjects.length,
    );
  });

  it("requires an app update only when the stable mobile API version is unsupported", async () => {
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: controlErrorSocketFactory("unsupportedMobileApi"),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });

    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({ availability: "updateRequired" }),
    ]);
  });

  it("classifies a reachable gateway without build identity as a Mac gateway update", async () => {
    const requested: string[] = [];
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      multiplexSocketFactory: unavailableDataSocketFactory(),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
      async fetch(input) {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/.well-known/termloop-mobile-access")) return new Response(null, { status: 404 });
        if (url.endsWith("/health")) return Response.json({ ready: true });
        return new Response(null, { status: 404 });
      },
    });

    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({ availability: "gatewayUpdateRequired" }),
    ]);
    expect(requested).toEqual([
      "http://127.0.0.1:48100/.well-known/termloop-mobile-access",
      "http://127.0.0.1:48100/health",
    ]);
  });

  it("keeps an unreachable gateway offline and does not confuse it with skew", async () => {
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: unavailableControlSocketFactory(),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
      async fetch() { throw new Error("tailnet unreachable"); },
    });

    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({ availability: "offline" }),
    ]);
  });

  it("directs a phone that is older than the reachable gateway to update the app", async () => {
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: unavailableControlSocketFactory(),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
      async fetch() {
        return Response.json({
          buildId: "gateway-newer-than-phone",
          compatibility: {
            mobileTransport: { min: 3, max: 3 },
            mobileApi: { min: 1, max: 1 },
          },
        });
      },
    });

    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({ availability: "updateRequired" }),
    ]);
  });

  it("does not mistake an authentication failure for a contract mismatch", async () => {
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: controlErrorSocketFactory("unauthenticated"),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });

    await expect(runtime.connections.list()).resolves.toEqual([
      expect.objectContaining({ availability: "revoked" }),
    ]);
  });

  it("persists an owner-generated pair code through the secure repository", async () => {
    const repository = createSecureConnectionRepository(memorySecretStore());
    const runtime = createProductionRuntime({
      repository,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });
    const payload = {
      version: 1,
      connectionId: saved.id,
      name: saved.name,
      protocolVersion: CONTRACT_IDENTITY,
      controlUrl: saved.controlUrl,
      controlToken: saved.controlToken,
      terminalUrl: saved.terminalUrl,
      terminalToken: saved.terminalToken,
    };

    await expect(runtime.connections.pair(`TLMP1:${JSON.stringify(payload)}`))
      .resolves.toBe(saved.id);
    expect(await repository.get(saved.id)).toEqual({
      ...saved,
      lastConnectedAtEpochMs: null,
    });
  });

  it("registers a native push token at the saved Mac without putting credentials in the URL", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ registered: true }), { status: 200 });
    };
    const runtime = createProductionRuntime({
      repository: fixedRepository({
        ...saved,
        controlUrl: "wss://mac.example.ts.net/control",
      }),
      fetch: request,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });
    await runtime.notifications.registerDevice(saved.id, {
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "ai.termloop.next.mobile.dev",
    });
    expect(calls).toHaveLength(1);
    const [url, options] = calls[0]!;
    expect(url).toBe("https://mac.example.ts.net/push/register");
    expect(url).not.toContain(saved.controlToken);
    expect(options?.headers).toMatchObject({ authorization: `Bearer ${saved.controlToken}` });
  });

  it("streams a selected image to the paired Mac without putting its credential in the URL", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      if (String(input) === "file:///photo.png") {
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
      return new Response(JSON.stringify({ uploaded: true, attachmentPath: ".termloop-runtime/mobile-attachments/image.png" }), {
        status: 201,
      });
    };
    const runtime = createProductionRuntime({
      repository: fixedRepository({ ...saved, controlUrl: "wss://mac.example.ts.net/control" }),
      fetch: request,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });

    await expect(runtime.images.upload(saved.id, sessionId, {
      uri: "file:///photo.png",
      mediaType: "image/png",
    })).resolves.toBe(".termloop-runtime/mobile-attachments/image.png");

    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.[0])).toBe(`https://mac.example.ts.net/session/image?sessionId=${sessionId}`);
    expect(String(calls[1]?.[0])).not.toContain(saved.controlToken);
    expect(calls[1]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${saved.controlToken}`,
      "content-type": "image/png",
    });
    expect(calls[1]?.[1]?.body).toBeInstanceOf(ArrayBuffer);
  });

  it("explains when the paired Mac still runs a gateway without image support", async () => {
    const request: typeof fetch = async (input) => {
      if (String(input) === "file:///photo.png") {
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
      }
      return new Response(null, { status: 404 });
    };
    const runtime = createProductionRuntime({
      repository: fixedRepository({ ...saved, controlUrl: "wss://mac.example.ts.net/control" }),
      fetch: request,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });

    await expect(runtime.images.upload(saved.id, sessionId, {
      uri: "file:///photo.png",
      mediaType: "image/png",
    })).rejects.toThrow("gateway needs an update");
  });

  it("provisions the paired watch with the gateway's watch credential", async () => {
    const delivered: unknown[] = [];
    const request: typeof fetch = async (input) => {
      expect(String(input)).toBe("https://mac.example.ts.net/watch/credential");
      return new Response(JSON.stringify({ paired: true, token: "w".repeat(64) }), { status: 200 });
    };
    const runtime = createProductionRuntime({
      repository: fixedRepository({
        ...saved,
        controlUrl: "wss://mac.example.ts.net/control",
      }),
      fetch: request,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
      watchBridge: {
        async syncCredentials(credentials, activeConnectionIds) {
          delivered.push({ credentials, activeConnectionIds });
          return true;
        },
      },
    });
    await expect(runtime.watch.sync()).resolves.toBe(true);
    expect(delivered).toEqual([{
      credentials: [{
        connectionId: saved.id,
        name: saved.name,
        host: "mac.example.ts.net",
        token: "w".repeat(64),
        targetProjectId: null,
      }],
      activeConnectionIds: [saved.id],
    }]);
  });

  it("persists a Watch target and includes it in the latest-state watch sync", async () => {
    const delivered: unknown[] = [];
    const request: typeof fetch = async () =>
      new Response(JSON.stringify({ paired: true, token: "w".repeat(64) }), { status: 200 });
    const runtime = createProductionRuntime({
      repository: fixedRepository({ ...saved, controlUrl: "wss://mac.example.ts.net/control" }),
      watchTargetSettings: createWatchTargetSettings(memorySecretStore()),
      fetch: request,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
      watchBridge: {
        async syncCredentials(credentials, activeConnectionIds) {
          delivered.push({ credentials, activeConnectionIds });
          return true;
        },
      },
    });

    await expect(runtime.watch.setTargetProject(saved.id, "project-1"))
      .resolves.toEqual({ synced: true });
    await expect(runtime.watch.targetProject(saved.id)).resolves.toBe("project-1");
    expect(delivered).toEqual([{
      credentials: [{
        connectionId: saved.id,
        name: saved.name,
        host: "mac.example.ts.net",
        token: "w".repeat(64),
        targetProjectId: "project-1",
      }],
      activeConnectionIds: [saved.id],
    }]);
  });

  it("reports the watch as unavailable when the gateway has no watch credential", async () => {
    const request: typeof fetch = async () =>
      new Response(JSON.stringify({ paired: false }), { status: 404 });
    const runtime = createProductionRuntime({
      repository: fixedRepository({
        ...saved,
        controlUrl: "wss://mac.example.ts.net/control",
      }),
      fetch: request,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
      watchBridge: {
        async syncCredentials(credentials, activeConnectionIds) {
          expect(credentials).toEqual([]);
          expect(activeConnectionIds).toEqual([saved.id]);
          return false;
        },
      },
    });
    await expect(runtime.watch.sync()).resolves.toBe(false);
  });
});

describe("production terminal adapter", () => {
  it("rejects a silent initial CONNECTING socket so foreground attach can retry", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeDataSocket[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        controlSocketFactory: () => { throw new Error("control not used"); },
        terminalSocketFactory: () => {
          const socket = new FakeDataSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const attaching = runtime.terminal.attach(
        saved.id,
        { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
        () => {},
      );
      const rejected = expect(attaching).rejects.toThrow("Terminal connection failed.");
      await waitFor(() => sockets.length === 1);

      await vi.advanceTimersByTimeAsync(5_000);

      await rejected;
      expect(sockets[0]!.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("authenticates, attaches, maps replay/gap/live, and sends binary input", async () => {
    const repository = fixedRepository(saved);
    const sockets: FakeDataSocket[] = [];
    const runtime = createProductionRuntime({
      repository,
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => {
        const socket = new FakeDataSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const events: TerminalEvent[] = [];
    const attaching = runtime.terminal.attach(
      saved.id,
      { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
      (event) => events.push(event),
    );
    await waitFor(() => sockets.length === 1);
    const socket = sockets[0]!;
    socket.open();
    expect(new TextDecoder().decode(socket.sent[0] as Uint8Array)).toBe(`TL01${saved.terminalToken}`);
    socket.message("TLOK");
    const attachment = await attaching;

    const attachFrame = decodeFrame(new Uint8Array(socket.sent[1] as ArrayBuffer));
    expect(attachFrame.kind).toBe(KIND_ATTACH);
    expect(attachFrame.sessionId).toBe(sessionId);
    expect(new TextDecoder().decode(attachFrame.payload.slice(0, 4))).toBe("TLRQ");
    expect(new DataView(attachFrame.payload.buffer).getUint32(4)).toBe(MOBILE_REPLAY_BUDGET_BYTES);
    expect(new DataView(attachFrame.payload.buffer).getUint32(8)).toBe(MOBILE_REPLAY_CHUNK_BYTES);

    socket.message(encodeFrame(
      sessionId,
      17,
      attachFrame.sequence,
      KIND_ACK,
      replayAckPayload(3, 14),
    ));
    socket.message(encodeFrame(sessionId, 17, 1n, KIND_GAP, gapPayload(3)));
    socket.message(encodeFrame(sessionId, 17, 2n, KIND_REPLAY_OUTPUT, new TextEncoder().encode("recent ")));
    socket.message(encodeFrame(sessionId, 17, 3n, KIND_REPLAY_OUTPUT, new TextEncoder().encode("screen\n")));
    socket.message(encodeFrame(sessionId, 17, 4n, KIND_OUTPUT, new TextEncoder().encode("live\n")));
    await waitFor(() => events.length === 5);
    expect(events.map((event) => event.type)).toEqual(["state", "state", "gap", "replay", "live"]);
    const replay = events.find((event) => event.type === "replay");
    expect(replay?.type === "replay" ? new TextDecoder().decode(replay.bytes) : undefined)
      .toBe("recent screen\n");

    await attachment.input(new TextEncoder().encode("continue\r"));
    const input = decodeFrame(new Uint8Array(socket.sent.at(-1) as ArrayBuffer));
    expect(input.kind).toBe(KIND_INPUT);
    expect(new TextDecoder().decode(input.payload)).toBe("continue\r");

    const beforeLargeInput = socket.sent.length;
    await attachment.input(new Uint8Array((16 * 1024) + 1).fill(0x61));
    const chunks = socket.sent.slice(beforeLargeInput).map((value) =>
      decodeFrame(new Uint8Array(value as ArrayBuffer))
    );
    expect(chunks.map((frame) => frame.kind)).toEqual([KIND_INPUT, KIND_INPUT]);
    expect(chunks.map((frame) => frame.payload.byteLength)).toEqual([16 * 1024, 1]);

    await attachment.detach();
    expect(socket.closed).toBe(true);
  });

  it("cleanly reattaches the same retained Session after visiting another route", async () => {
    const sockets: FakeDataSocket[] = [];
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => {
        const socket = new FakeDataSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const states: string[] = [];
    const attach = () => runtime.terminal.attach(
      saved.id,
      { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
      (event) => { if (event.type === "state") states.push(event.state); },
    );

    const firstAttaching = attach();
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.message("TLOK");
    const first = await firstAttaching;
    await first.detach();

    const secondAttaching = attach();
    await waitFor(() => sockets.length === 2);
    sockets[1]!.open();
    sockets[1]!.message("TLOK");
    const second = await secondAttaching;

    expect(states).toEqual(["connecting", "connected", "connecting", "connected"]);
    await expect(second.input(new TextEncoder().encode("returned"))).resolves.toBeUndefined();
    await second.detach();
  });

  it("publishes a paced legacy replay once after a full quiet window", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeDataSocket[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        controlSocketFactory: () => { throw new Error("control not used"); },
        terminalSocketFactory: () => {
          const socket = new FakeDataSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const events: TerminalEvent[] = [];
      const attaching = runtime.terminal.attach(
        saved.id,
        { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
        (event) => events.push(event),
      );
      await waitFor(() => sockets.length === 1);
      sockets[0]!.open();
      sockets[0]!.message("TLOK");
      const attachment = await attaching;

      sockets[0]!.message(encodeFrame(
        sessionId,
        17,
        1n,
        KIND_REPLAY_OUTPUT,
        new TextEncoder().encode("older "),
      ));
      await vi.advanceTimersByTimeAsync(600);
      sockets[0]!.message(encodeFrame(
        sessionId,
        17,
        2n,
        KIND_REPLAY_OUTPUT,
        new TextEncoder().encode("latest\n"),
      ));
      await vi.advanceTimersByTimeAsync(999);
      expect(events.map((event) => event.type)).toEqual(["state", "state"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(events.map((event) => event.type)).toEqual(["state", "state", "replay"]);
      const replay = events.at(-1);
      expect(replay?.type === "replay" ? new TextDecoder().decode(replay.bytes) : undefined)
        .toBe("older latest\n");

      await attachment.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects and resets stale presentation before requesting fresh replay", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeDataSocket[] = [];
      const diagnosticLines: string[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        diagnostics: createMobileDiagnosticReporter((line) => diagnosticLines.push(line)),
        controlSocketFactory: () => { throw new Error("control not used"); },
        terminalSocketFactory: () => {
          const socket = new FakeDataSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const events: string[] = [];
      const attaching = runtime.terminal.attach(
        saved.id,
        { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
        (event) => events.push(event.type === "state" ? `${event.type}:${event.state}` : event.type),
      );
      await waitFor(() => sockets.length === 1);
      sockets[0]!.open();
      sockets[0]!.message("TLOK");
      const attachment = await attaching;

      sockets[0]!.drop();
      expect(events.at(-1)).toBe("state:connectionLost");
      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      sockets[1]!.message("TLOK");
      await waitFor(() => events.includes("reset"));

      expect(events.slice(-3)).toEqual(["state:connecting", "reset", "state:connected"]);
      expect(decodeFrame(new Uint8Array(sockets[1]!.sent[1] as ArrayBuffer)).kind).toBe(KIND_ATTACH);
      await attachment.detach();
      const diagnosticEvents = diagnosticLines.map((line) =>
        (JSON.parse(line.replace("[termloop-mobile] ", "")) as { event: string }).event
      );
      expect(diagnosticEvents).toEqual(expect.arrayContaining([
        "attachment_started",
        "authenticated",
        "connection_closed",
        "reconnect_scheduled",
        "attachment_detached",
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off when authenticated sockets repeatedly flap before becoming stable", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeDataSocket[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        controlSocketFactory: () => { throw new Error("control not used"); },
        terminalSocketFactory: () => {
          const socket = new FakeDataSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const attaching = runtime.terminal.attach(
        saved.id,
        { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
        () => {},
      );
      await waitFor(() => sockets.length === 1);
      sockets[0]!.open();
      sockets[0]!.message("TLOK");
      const attachment = await attaching;

      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(500);
      sockets[1]!.open();
      sockets[1]!.message("TLOK");
      await Promise.resolve();
      sockets[1]!.drop();
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(3);

      await attachment.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a silent CONNECTING socket during automatic reconnect", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeDataSocket[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        controlSocketFactory: () => { throw new Error("control not used"); },
        terminalSocketFactory: () => {
          const socket = new FakeDataSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const events: string[] = [];
      const attaching = runtime.terminal.attach(
        saved.id,
        { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
        (event) => events.push(event.type === "state" ? `${event.type}:${event.state}` : event.type),
      );
      await waitFor(() => sockets.length === 1);
      sockets[0]!.open();
      sockets[0]!.message("TLOK");
      const attachment = await attaching;

      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(sockets[1]!.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(3);
      sockets[2]!.open();
      sockets[2]!.message("TLOK");
      await waitFor(() => events.at(-1) === "state:connected");

      await expect(attachment.input(new TextEncoder().encode("foreground recovered"))).resolves.toBeUndefined();
      expect(decodeFrame(new Uint8Array(sockets[2]!.sent.at(-1) as ArrayBuffer)).kind).toBe(KIND_INPUT);
      await attachment.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("proves a fresh authenticated terminal transport after a native upload", async () => {
    const sockets: FakeDataSocket[] = [];
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: () => { throw new Error("control not used"); },
      terminalSocketFactory: () => {
        const socket = new FakeDataSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const events: string[] = [];
    const attaching = runtime.terminal.attach(
      saved.id,
      { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
      (event) => events.push(event.type === "state" ? `${event.type}:${event.state}` : event.type),
    );
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.message("TLOK");
    const attachment = await attaching;

    let reconnected = false;
    const reconnecting = attachment.reconnect().then(() => { reconnected = true; });
    expect(sockets).toHaveLength(2);
    expect(events.slice(-2)).toEqual(["state:connectionLost", "state:connecting"]);
    sockets[1]!.open();
    await Promise.resolve();
    expect(reconnected).toBe(false);

    sockets[1]!.message("TLOK");
    await reconnecting;
    expect(reconnected).toBe(true);
    expect(events.slice(-2)).toEqual(["reset", "state:connected"]);
    await expect(attachment.input(new TextEncoder().encode("photo attached"))).resolves.toBeUndefined();
    expect(decodeFrame(new Uint8Array(sockets[1]!.sent.at(-1) as ArrayBuffer)).kind).toBe(KIND_INPUT);
    await attachment.detach();
  });

  it("reconnects after a socket write fails before the close event arrives", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeDataSocket[] = [];
      const runtime = createProductionRuntime({
        repository: fixedRepository(saved),
        controlSocketFactory: () => { throw new Error("control not used"); },
        terminalSocketFactory: () => {
          const socket = new FakeDataSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const events: string[] = [];
      const attaching = runtime.terminal.attach(
        saved.id,
        { ...fixtureSessions[0]!, id: sessionId, runtime_epoch: 17 },
        (event) => events.push(event.type === "state" ? `${event.type}:${event.state}` : event.type),
      );
      await waitFor(() => sockets.length === 1);
      sockets[0]!.open();
      sockets[0]!.message("TLOK");
      const attachment = await attaching;

      sockets[0]!.failNextSend = true;
      await expect(attachment.input(new TextEncoder().encode("continue")))
        .rejects.toThrow("socket write failed");
      expect(events.at(-1)).toBe("state:connectionLost");

      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      sockets[1]!.message("TLOK");
      await waitFor(() => events.at(-1) === "state:connected");
      await expect(attachment.input(new TextEncoder().encode("recovered"))).resolves.toBeUndefined();
      expect(decodeFrame(new Uint8Array(sockets[1]!.sent.at(-1) as ArrayBuffer)).kind).toBe(KIND_INPUT);

      await attachment.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("production pipeline, launch, and Steward adapters", () => {
  function runtimeWith(methods: string[], requests: Array<{
    method: string;
    params: Record<string, unknown>;
    mobileApiVersion: number | undefined;
    protocolVersion: string | undefined;
  }>) {
    return createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: controlSocketFactory(methods, requests),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
    });
  }

  it("reads a Task worktree snapshot, patch, and bounded pre-image from one observation", async () => {
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = runtimeWith([], requests);

    const changes = await runtime.worktreeChanges.listTask(saved.id, "task-mobile");
    const diff = await runtime.worktreeChanges.diffTask(
      saved.id, "task-mobile", changes.observation_id, changes.entries[0]!.entry_id,
    );
    const preImage = await runtime.worktreeChanges.preImageTask(
      saved.id, "task-mobile", changes.observation_id, changes.entries[0]!.entry_id,
    );

    expect(changes).toEqual(fixtureTaskWorktreeChanges);
    expect(diff).toEqual(fixtureTaskWorktreeDiffs[changes.entries[0]!.entry_id]);
    expect(preImage).toEqual(fixtureTaskWorktreePreImages[changes.entries[0]!.entry_id]);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "task.worktreeChangeList", params: { taskId: "task-mobile" } }),
      expect.objectContaining({
        method: "task.worktreeDiff",
        params: { taskId: "task-mobile", observationId: changes.observation_id, entryId: changes.entries[0]!.entry_id },
      }),
      expect.objectContaining({
        method: "task.worktreePreImage",
        params: { taskId: "task-mobile", observationId: changes.observation_id, entryId: changes.entries[0]!.entry_id },
      }),
    ]));
  });

  it("reads the pipeline as one projection and carries the newest revision a write must match", async () => {
    const methods: string[] = [];
    const runtime = runtimeWith(methods, []);

    const projection = await runtime.playbook.read(saved.id, fixtureProjects[0]!.id);

    expect(methods).toEqual(expect.arrayContaining([
      "playbook.get", "playbook.runtime", "routine.configurationList",
    ]));
    expect(projection.playbook).toEqual(fixturePlaybook);
    expect(projection.runtime).toEqual(fixturePlaybookRuntime);
    expect(projection.routines).toEqual(fixtureRoutines);
    // The three reads settle independently, so a later write has to present the
    // newest revision any of them saw — not whichever answered last.
    expect(projection.stateRevision).toBe(Math.max(11, fixturePlaybookRuntime.stateRevision, 14));
  });

  it("sends the exact revisions core will check when moving a Task", async () => {
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = runtimeWith([], requests);

    await runtime.playbook.setTaskPosition(saved.id, {
      projectId: fixtureProjects[0]!.id,
      taskId: "task-mobile",
      passedMilestoneCount: 2,
      expectedPlaybookRevision: 6,
      expectedRevision: 118,
    });

    expect(requests.find(({ method }) => method === "playbook.taskPositionSet")?.params).toEqual({
      projectId: fixtureProjects[0]!.id,
      taskId: "task-mobile",
      passedMilestoneCount: 2,
      expectedPlaybookRevision: 6,
      expectedRevision: 118,
    });
  });

  it("omits every default from a launch preview so the Mac supplies its own", async () => {
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = runtimeWith([], requests);

    await runtime.agentLaunch.preview(saved.id, "task-mobile", {
      agentId: "claude", model: "default", permission: "default", reasoning: "default",
    });
    expect(requests.at(-1)?.params).toEqual({ taskId: "task-mobile", agentId: "claude" });

    await runtime.agentLaunch.preview(saved.id, "task-mobile", {
      agentId: "claude", model: "sonnet", permission: "acceptEdits", reasoning: "high",
    });
    expect(requests.at(-1)?.params).toEqual({
      taskId: "task-mobile",
      agentId: "claude",
      model: "sonnet",
      permission: "acceptEdits",
      reasoning: "high",
    });
  });

  it("renders the inspected manifest in the Mac's own words and order", async () => {
    const runtime = runtimeWith([], []);

    const inspection = await runtime.agentLaunch.preview(saved.id, "task-mobile", {
      agentId: "claude", model: "sonnet", permission: "acceptEdits", reasoning: "high",
    });

    expect(inspection).toEqual({
      launchTicket: "ticket-1",
      program: "/usr/local/bin/claude",
      args: ["--model", "sonnet", "«redacted»"],
      cwd: "/Users/demo/Projects/termloop-mobile",
      model: "sonnet",
      permission: "acceptEdits",
      reasoning: "high",
    });
  });

  it("spends the previewed ticket and answers with the Session it started", async () => {
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = runtimeWith([], requests);

    const result = await runtime.agentLaunch.launch(
      saved.id, "task-mobile", { agentId: "claude" }, "ticket-1",
    );

    expect(result).toEqual({ sessionId, runtimeEpoch: 17, promptSubmitted: null });
    expect(requests.find(({ method }) => method === "task.launchAgent")?.params).toEqual({
      taskId: "task-mobile", agentId: "claude", launchTicket: "ticket-1",
    });
  });

  it("submits the first message to the launched Session as bracketed paste plus Enter", async () => {
    const sockets: FakeDataSocket[] = [];
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: controlSocketFactory([], requests),
      terminalSocketFactory() {
        const socket = new FakeDataSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const launching = runtime.agentLaunch.launch(
      saved.id,
      "task-mobile",
      { agentId: "claude" },
      "ticket-1",
      "  investigate\nthis\u0007 now  ",
    );
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.message("TLOK");

    await expect(launching).resolves.toEqual({ sessionId, runtimeEpoch: 17, promptSubmitted: true });
    expect(requests.find(({ method }) => method === "session.rename")?.params).toEqual({
      sessionId,
      name: "investigate",
    });
    const frames = sockets[0]!.sent
      .slice(1)
      .map((data) => decodeFrame(new Uint8Array(data as ArrayBuffer)));
    expect(frames.map((frame) => frame.kind)).toEqual([KIND_ATTACH, KIND_INPUT, KIND_INPUT]);
    expect(new TextDecoder().decode(frames[1]!.payload)).toBe("\u001b[200~investigate this now\u001b[201~");
    expect([...frames[2]!.payload]).toEqual([13]);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("uses the Project projection as the exact target for an unassigned Agent launch", async () => {
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = runtimeWith([], requests);
    const project = fixtureProjects[0]!;
    const inspection = await runtime.agentLaunch.previewProject(saved.id, project, {
      agentId: "codex", model: "gpt-5.6-sol", permission: "plan", reasoning: "high",
    });

    await runtime.agentLaunch.launchProject(saved.id, project, { agentId: "codex" }, inspection.launchTicket);

    expect(requests.find(({ method }) => method === "session.previewAgent")?.params).toEqual({
      projectId: project.id,
      cwd: project.folder_path,
      agentId: "codex",
      model: "gpt-5.6-sol",
      permission: "plan",
      reasoning: "high",
    });
    expect(requests.find(({ method }) => method === "session.launchAgent")?.params).toEqual({
      projectId: project.id,
      cwd: project.folder_path,
      agentId: "codex",
      launchTicket: "ticket-1",
    });
  });

  it("retries a stopped Agent with a freshly previewed resume ticket", async () => {
    const methods: string[] = [];
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = runtimeWith(methods, requests);

    await expect(runtime.sessionActions.retry(saved.id, sessionId)).resolves.toMatchObject({
      id: sessionId,
    });

    expect(methods).toEqual(["session.previewResumeAgent", "session.resumeAgent"]);
    expect(requests[0]?.params).toEqual({ sessionId });
    expect(requests[1]?.params).toEqual({ sessionId, launchTicket: "ticket-1" });
  });

  it("orders the Steward transcript oldest first, whatever order the daemon answers in", async () => {
    const runtime = runtimeWith([], []);

    const messages = await runtime.steward.transcript(saved.id, fixtureProjects[0]!.id);

    expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
  });

  it("re-reads the transcript after sending, so a Steward reply is not waited on blindly", async () => {
    const methods: string[] = [];
    const runtime = runtimeWith(methods, []);

    await runtime.steward.send(saved.id, fixtureProjects[0]!.id, "  where is this task?  ");

    expect(methods).toEqual(["companion.transcriptAppend", "companion.transcriptList"]);
  });

  it("refuses an empty or oversized message before it reaches the Mac", async () => {
    const methods: string[] = [];
    const runtime = runtimeWith(methods, []);

    await expect(runtime.steward.send(saved.id, fixtureProjects[0]!.id, "   "))
      .rejects.toThrow("Write a message");
    await expect(runtime.steward.send(saved.id, fixtureProjects[0]!.id, "x".repeat(8_193)))
      .rejects.toThrow("Write a message");
    expect(methods).toEqual([]);
  });

  it("previews voice, commits the corrected transcript, and downloads speech", async () => {
    const calls: Array<{ url: string; authorization: string | null; contentType: string | null; body: unknown }> = [];
    const methods: string[] = [];
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const request: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        contentType: headers.get("content-type"),
        body: init?.body,
      });
      if (url.endsWith("/steward/transcribe")) {
        return Response.json({ transcript: "  yanlış peynir  " });
      }
      if (url.endsWith("/steward/speech")) {
        return new Response(new Uint8Array([73, 68, 51]));
      }
      return new Response(null, { status: 404 });
    };
    const runtime = createProductionRuntime({
      repository: fixedRepository(saved),
      controlSocketFactory: controlSocketFactory(methods, requests),
      terminalSocketFactory: () => { throw new Error("terminal not used"); },
      fetch: request,
    });

    await expect(runtime.steward.transcribeVoice(saved.id, {
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mediaType: "audio/wav",
    })).resolves.toBe("yanlış peynir");
    await expect(runtime.steward.commitVoice(saved.id, fixtureProjects[0]!.id, "  doğru payment  "))
      .resolves.toEqual({ transcript: "doğru payment", userSequence: fixtureStewardTranscript[0]!.sequence });
    await expect(runtime.steward.speech(saved.id, fixtureProjects[0]!.id, 20))
      .resolves.toEqual(new Uint8Array([73, 68, 51]));

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:48100/steward/transcribe",
      authorization: `Bearer ${saved.controlToken}`,
      contentType: "audio/wav",
      body: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(calls[1]).toMatchObject({
      url: "http://127.0.0.1:48100/steward/speech",
      authorization: `Bearer ${saved.controlToken}`,
      contentType: "application/json",
    });
    expect(methods).toEqual(["companion.transcriptAppend"]);
    expect(requests[0]?.params).toEqual({
      projectId: fixtureProjects[0]!.id,
      inputMode: "voice",
      content: "doğru payment",
    });
  });

  it("answers a proposal and a suggestion through their own named commands", async () => {
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      mobileApiVersion: number | undefined;
      protocolVersion: string | undefined;
    }> = [];
    const runtime = runtimeWith([], requests);
    const projectId = fixtureProjects[0]!.id;

    await runtime.steward.respond(saved.id, projectId, "companion-3", "accept");
    expect(requests.find(({ method }) => method === "companion.suggestionAccept")?.params)
      .toEqual({ projectId, suggestionMessageId: "companion-3" });

    await runtime.steward.respond(saved.id, projectId, "companion-4", "decline");
    expect(requests.find(({ method }) => method === "companion.proposalRespond")?.params)
      .toEqual({ projectId, proposalMessageId: "companion-4", decision: "decline" });
  });
});

function memorySecretStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getItemAsync(key) { return values.get(key) ?? null; },
    async setItemAsync(key, value) { values.set(key, value); },
    async deleteItemAsync(key) { values.delete(key); },
  };
}

function fixedRepository(connection: SavedConnection) {
  return {
    async list() { return [connection]; },
    async get(id: string) { return id === connection.id ? connection : undefined; },
    async save() { throw new Error("not used"); },
    async remove() { throw new Error("not used"); },
  };
}

function controlSocketFactory(
  methods: string[],
  requests: Array<{
    method: string;
    params: Record<string, unknown>;
    mobileApiVersion: number | undefined;
    protocolVersion: string | undefined;
  }> = [],
  failedMethods: ReadonlySet<string> = new Set(),
) {
  return (): SocketLike => {
    const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    const emit = (type: string, event: { data?: string } = {}) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    queueMicrotask(() => emit("open"));
    return {
      addEventListener(type, listener) {
        const current = listeners.get(type) ?? [];
        current.push(listener);
        listeners.set(type, current);
      },
      send(data) {
        const request = JSON.parse(data) as {
          id: string;
          method: string;
          mobileApiVersion?: number;
          protocolVersion?: string;
          params: Record<string, unknown> & {
            projectId?: string;
            taskId?: string;
            observationId?: string;
            entryId?: string;
          };
        };
        methods.push(request.method);
        requests.push({
          method: request.method,
          params: request.params,
          mobileApiVersion: request.mobileApiVersion,
          protocolVersion: request.protocolVersion,
        });
        if (failedMethods.has(request.method)) {
          queueMicrotask(() => emit("message", { data: JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: "internal", message: "Optional projection failed." },
          }) }));
          return;
        }
        const result = controlResult(
          request.method,
          request.params.projectId,
          request.params.taskId,
          request.params.observationId,
          request.params.entryId,
        );
        queueMicrotask(() => emit("message", { data: JSON.stringify({ id: request.id, ok: true, result }) }));
      },
      close() {},
    };
  };
}

function controlErrorSocketFactory(code: string): () => SocketLike {
  return () => {
    const listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    const emit = (type: string, event: { data?: string } = {}) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    queueMicrotask(() => emit("open"));
    return {
      addEventListener(type, listener) {
        const current = listeners.get(type) ?? [];
        current.push(listener);
        listeners.set(type, current);
      },
      send(data) {
        const request = JSON.parse(data) as { id: string };
        queueMicrotask(() => emit("message", {
          data: JSON.stringify({
            id: request.id,
            ok: false,
            error: { code, message: "The gateway refused this request." },
          }),
        }));
      },
      close() {},
    };
  };
}

function unavailableControlSocketFactory(): () => SocketLike {
  return () => {
    const listeners = new Map<string, Array<(event: { type?: string }) => void>>();
    const emit = (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener({ type });
    };
    queueMicrotask(() => emit("error"));
    return {
      addEventListener(type, listener) {
        const current = listeners.get(type) ?? [];
        current.push(listener as (event: { type?: string }) => void);
        listeners.set(type, current);
      },
      send() {},
      close() {},
    };
  };
}

function unavailableDataSocketFactory(): () => DataSocket {
  return () => {
    const socket: DataSocket = {
      binaryType: "blob",
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send() {},
      close() {},
    };
    queueMicrotask(() => socket.onerror?.({}));
    return socket;
  };
}

function controlResult(
  method: string,
  projectId?: string,
  taskId?: string,
  observationId?: string,
  entryId?: string,
): unknown {
  if (method === "system.version") {
    return {
      product: "TermLoop",
      version: "0.4.1",
      protocolVersion: daemonContractIdentity,
      futureGatewayField: true,
    };
  }
  if (method === "project.list") return fixtureProjects;
  if (method === "task.list") {
    return {
      items: fixtureTasks.filter((task) => task.project_id === projectId),
      next_cursor: null,
    };
  }
  if (method === "task.worktreeChangeList") {
    if (taskId !== fixtureTaskWorktreeChanges.task_id) throw new Error("Unexpected Task worktree");
    return fixtureTaskWorktreeChanges;
  }
  if (method === "task.worktreeDiff") {
    if (taskId !== fixtureTaskWorktreeChanges.task_id || observationId !== fixtureTaskWorktreeChanges.observation_id
      || entryId === undefined || fixtureTaskWorktreeDiffs[entryId] === undefined) {
      throw new Error("Unexpected Task worktree diff");
    }
    return fixtureTaskWorktreeDiffs[entryId];
  }
  if (method === "task.worktreePreImage") {
    if (taskId !== fixtureTaskWorktreeChanges.task_id || observationId !== fixtureTaskWorktreeChanges.observation_id
      || entryId === undefined || fixtureTaskWorktreePreImages[entryId] === undefined) {
      throw new Error("Unexpected Task worktree pre-image");
    }
    return fixtureTaskWorktreePreImages[entryId];
  }
  if (method === "session.list") return fixtureSessions;
  if (method === "agent.statusList") return fixtureAgentStatuses;
  if (method === "agent.capabilityList") return fixtureAgentCapabilities;
  if (method === "steward.configurationGet") {
    return {
      configuration: {
        projectId,
        agentId: "codex",
        model: "default",
        permission: "default",
        reasoning: "default",
        enabled: true,
        executorSessionId: "steward-session",
        generation: 1,
        updatedAtEpochMs: 1,
        systemPrompt: "",
      },
      defaultSystemPrompt: "Steward",
      promptContext: {
        initialPrompt: "initial",
        instructionsPrompt: "instructions",
        instructionDelivery: "codexDeveloperInstructions",
        protectedPrompt: "protected",
        wakePrompt: "wake",
      },
      stateRevision: 1,
      supervisorAvailability: "available",
      presence: {
        lastActivityAtEpochMs: null,
        activeCommandLabel: null,
        pendingProposal: false,
      },
    };
  }
  if (method === "playbook.get") return { playbook: fixturePlaybook, stateRevision: 11 };
  if (method === "playbook.runtime") return fixturePlaybookRuntime;
  if (method === "routine.configurationList") {
    return {
      configurations: fixtureRoutines.map((routine) => ({
        ...routine,
        projectId: fixtureProjects[0]?.id,
        kind: "custom",
        triggerMode: "schedule",
      })),
      stateRevision: 14,
    };
  }
  if (method === "playbook.taskPositionSet") {
    return { taskId: "task-mobile", passedMilestoneCount: 1, stateRevision: 15 };
  }
  if (method === "routine.runNow") return { ok: true };
  if (method === "task.previewAgent"
    || method === "session.previewAgent"
    || method === "session.previewResumeAgent") {
    return {
      launch_ticket: "ticket-1",
      manifest: {
        target: {
          agent_id: "claude",
          executable: "/usr/local/bin/claude",
          model: "sonnet",
          permission: "acceptEdits",
          reasoning: "high",
          cwd: "/Users/demo/Projects/termloop-mobile",
          conversation: "fresh",
        },
        // Deliberately out of order, and carrying one redacted argument, so the
        // adapter is proven to sort by position and to pass redaction through.
        arguments: [
          { position: 2, display: "sonnet", visibility: "exact" },
          { position: 1, display: "--model", visibility: "exact" },
          { position: 3, display: "«redacted»", visibility: "redacted" },
        ],
      },
    };
  }
  if (method === "task.launchAgent"
    || method === "session.launchAgent"
    || method === "session.resumeAgent") {
    return { ...fixtureSessions[0], id: sessionId };
  }
  if (method === "session.rename") return { ...fixtureSessions[0], id: sessionId };
  if (method === "companion.transcriptList") {
    return {
      // Newest first, exactly as the daemon answers.
      messages: [...fixtureStewardTranscript].reverse(),
      nextBeforeSequence: null,
      usage: {},
      stateRevision: 20,
    };
  }
  if (method === "companion.transcriptAppend"
    || method === "companion.suggestionAccept"
    || method === "companion.proposalRespond") {
    return { message: fixtureStewardTranscript[0], usage: {}, stateRevision: 21 };
  }
  throw new Error(`Unexpected method ${method}`);
}

class FakeDataSocket implements DataSocket {
  binaryType = "";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  closed = false;
  failNextSend = false;

  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("socket write failed");
    }
    this.sent.push(data);
  }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

function gapPayload(count: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setBigUint64(0, BigInt(count));
  return payload;
}

function replayAckPayload(frameCount: number, outputBytes: number): Uint8Array {
  const payload = new Uint8Array(12);
  payload.set(new TextEncoder().encode("TLRA"));
  const view = new DataView(payload.buffer);
  view.setUint32(4, frameCount);
  view.setUint32(8, outputBytes);
  return payload;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}
