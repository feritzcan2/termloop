import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { KIND_ACK, KIND_ATTACH, KIND_OUTPUT, KIND_RESIZE, decodeFrame, encodeFrame } from "@termloop/terminal-wire";
import { TerminalBridge, type TerminalSocket } from "../src/main/terminal-bridge.js";
import type { PmTerminalMessage } from "../src/pm-api.js";

const SESSION = "0d2c6c4e-58a4-4e0c-9a8c-1d4b1f0f7a11";
const EPOCH = 7;

class FakeSocket extends EventEmitter {
  binaryType = "nodebuffer";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  close(): void {
    this.readyState = 3;
  }
  /** Completes the open + TLOK handshake the bridge expects. */
  authenticate(): void {
    this.readyState = 1;
    this.emit("open");
    this.emit("message", Buffer.from("TLOK"), true);
  }
  frames() {
    return this.sent.slice(1).map((bytes) => decodeFrame(bytes));
  }
}

function bridge() {
  const socket = new FakeSocket();
  const messages: PmTerminalMessage[] = [];
  const instance = new TerminalBridge("ws://127.0.0.1:1/terminal", "token", EPOCH, (message) => messages.push(message),
    () => socket as unknown as TerminalSocket);
  return { socket, messages, instance };
}

function resizeOf(payload: Uint8Array): { rows: number; cols: number } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { rows: view.getUint16(0), cols: view.getUint16(2) };
}

describe("terminal bridge", () => {
  it("sends the renderer's measured grid as a Resize frame before the Attach frame", () => {
    const { socket, instance } = bridge();
    instance.attach(SESSION, 37, 58);
    socket.authenticate();
    const frames = socket.frames();
    expect(frames.map((frame) => frame.kind)).toEqual([KIND_RESIZE, KIND_ATTACH]);
    expect(frames[0]!.sessionId).toBe(SESSION);
    expect(resizeOf(frames[0]!.payload)).toEqual({ rows: 37, cols: 58 });
  });

  it("keeps rows and cols in order for live resizes and re-sends the latest grid on reconnect", () => {
    const { socket, instance } = bridge();
    instance.attach(SESSION, 24, 80);
    socket.authenticate();
    instance.resize(SESSION, 41, 132);
    const live = socket.frames().at(-1)!;
    expect(live.kind).toBe(KIND_RESIZE);
    expect(resizeOf(live.payload)).toEqual({ rows: 41, cols: 132 });
    instance.attach(SESSION, 41, 132);
    const again = socket.frames().slice(-2);
    expect(again.map((frame) => frame.kind)).toEqual([KIND_RESIZE, KIND_ATTACH]);
    expect(resizeOf(again[0]!.payload)).toEqual({ rows: 41, cols: 132 });
  });

  it("drops an invalid grid instead of sending it", () => {
    const { socket, instance } = bridge();
    instance.attach(SESSION, 0, 80);
    socket.authenticate();
    expect(socket.frames().map((frame) => frame.kind)).toEqual([KIND_ATTACH]);
  });

  it("relays the Ack payload and tags replay output", () => {
    const { socket, messages, instance } = bridge();
    instance.attach(SESSION, 24, 80);
    socket.authenticate();
    const ack = new Uint8Array([84, 76, 82, 65, 0, 0, 0, 1, 0, 0, 0, 2]);
    socket.emit("message", Buffer.from(encodeFrame(SESSION, EPOCH, 1n, KIND_ACK, ack)), true);
    socket.emit("message", Buffer.from(encodeFrame(SESSION, EPOCH, 2n, KIND_OUTPUT, new Uint8Array([104, 105]))), true);
    expect(messages).toContainEqual({ sessionId: SESSION, type: "attached", ack });
    expect(messages).toContainEqual({ sessionId: SESSION, type: "output", data: new Uint8Array([104, 105]), replay: false });
  });
});
