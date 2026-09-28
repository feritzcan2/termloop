import { generateKeyPairSync } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ACCESS_PROTOCOL_IDENTITY, CONTRACT_IDENTITY } from "@termloop/contract/current";
import {
  KIND_ATTACH, KIND_FOCUS, KIND_RESIZE, KIND_RESIZE_OWNERSHIP,
  decodeFrame, encodeFrame,
} from "../src/utility/terminal-frame.js";

const sessionId = "013e4567-e89b-42d3-a456-426614174000";
const parentPortDescriptor = Object.getOwnPropertyDescriptor(process, "parentPort");
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  if (parentPortDescriptor) Object.defineProperty(process, "parentPort", parentPortDescriptor);
  else Reflect.deleteProperty(process, "parentPort");
  vi.resetModules();
});

async function gateway(kind: "local" | "remote") {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const parentPort = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const port = Object.assign(new EventEmitter(), {
    start: vi.fn(), postMessage: vi.fn(), close: vi.fn(),
  });
  Object.defineProperty(process, "parentPort", { configurable: true, value: parentPort });
  const frames: ReturnType<typeof decodeFrame>[] = [];
  // The other client initially owns the PTY at a different size.
  let owner = false;
  let grid = { rows: 48, cols: 160 };
  server.on("connection", (socket) => {
    let authenticated = false;
    socket.on("message", (raw, binary) => {
      if (!binary) {
        socket.send(JSON.stringify({
          kind: "authenticated", protocolVersion: ACCESS_PROTOCOL_IDENTITY,
          connectionToken: "test-terminal-token",
        }));
        return;
      }
      if (!authenticated) {
        authenticated = true;
        socket.send(Buffer.from("TLOK"));
        return;
      }
      const frame = decodeFrame(new Uint8Array(raw as Buffer));
      frames.push(frame);
      if (frame.kind === KIND_ATTACH || frame.kind === KIND_FOCUS) {
        if (frame.kind === KIND_FOCUS) owner = true;
        socket.send(encodeFrame(sessionId, 1, 0n, KIND_RESIZE_OWNERSHIP, new Uint8Array([Number(owner)])));
      }
      if (frame.kind === KIND_RESIZE && owner) {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        grid = { rows: view.getUint16(0), cols: view.getUint16(2) };
      }
    });
    if (kind === "remote") socket.send(JSON.stringify({
      kind: "challenge", protocolVersion: ACCESS_PROTOCOL_IDENTITY,
      controlProtocolVersion: CONTRACT_IDENTITY, channel: "terminal",
      serverFingerprint: "test-fingerprint", nonce: "test-nonce",
    }));
  });
  cleanup = async () => {
    port.emit("message", { data: { type: "detach" } });
    const closed = once(server, "close");
    for (const client of server.clients) client.terminate();
    server.close();
    await closed;
    await vi.waitFor(() => expect(parentPort.postMessage).toHaveBeenCalledWith({ type: "state", state: "connectionLost" }));
  };
  await import("../src/utility/terminal-gateway.js");
  parentPort.emit("message", { data: {
    type: "configure", connectionKind: kind,
    terminalUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    terminalToken: "test-terminal-token",
    ...(kind === "remote" ? {
      accessProfileId: "test-profile",
      accessCredential: {
        deviceId: "test-device", serverFingerprint: "test-fingerprint",
        privateKey: generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
      },
    } : {}),
  } });
  parentPort.emit("message", { data: { type: "attach", sessionId, runtimeEpoch: 1 }, ports: [port] });
  await vi.waitFor(() => expect(frames.some((frame) => frame.kind === KIND_ATTACH)).toBe(true));
  return {
    frames,
    grid: () => grid,
    send: (data: object) => port.emit("message", { data }),
    loseOwnership: () => { owner = false; grid = { rows: 48, cols: 160 }; },
  };
}

describe("terminal gateway resize ownership", () => {
  it.each(["local", "remote"] as const)("applies the %s client's current grid when focus takes ownership", async (kind) => {
    const client = await gateway(kind);
    client.send({ type: "resize", rows: 35, cols: 90 });
    await vi.waitFor(() => expect(client.frames.some((frame) => frame.kind === KIND_RESIZE)).toBe(true));
    expect(client.grid()).toEqual({ rows: 48, cols: 160 });

    client.frames.length = 0;
    client.send({ type: "focus" });
    await vi.waitFor(() => expect(client.grid()).toEqual({ rows: 35, cols: 90 }));
    expect(client.frames.map((frame) => frame.kind)).toEqual([KIND_FOCUS, KIND_RESIZE]);

    // Switching back after another client took ownership must work without
    // requiring the user to resize this window first.
    client.loseOwnership();
    client.send({ type: "resize", rows: 39, cols: 100 });
    await vi.waitFor(() => expect(client.frames.filter((frame) => frame.kind === KIND_RESIZE)).toHaveLength(2));
    expect(client.grid()).toEqual({ rows: 48, cols: 160 });
    client.send({ type: "focus" });
    await vi.waitFor(() => expect(client.grid()).toEqual({ rows: 39, cols: 100 }));
  });

  it("does not invent a grid when focus arrives before the first measurement", async () => {
    const client = await gateway("local");
    client.send({ type: "focus" });
    await vi.waitFor(() => expect(client.frames.some((frame) => frame.kind === KIND_FOCUS)).toBe(true));
    expect(client.frames.some((frame) => frame.kind === KIND_RESIZE)).toBe(false);
    expect(client.grid()).toEqual({ rows: 48, cols: 160 });
    client.send({ type: "resize", rows: 35, cols: 90 });
    await vi.waitFor(() => expect(client.grid()).toEqual({ rows: 35, cols: 90 }));
  });
});
