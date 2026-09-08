import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeTerminalFrame, sendTerminalInput, validWatchReply } from "../scripts/mobile-access-terminal-input.mjs";

const reply = { sessionId: "11111111-2222-4333-8444-555555555555", runtimeEpoch: 17, text: "review this" };
const sockets = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); vi.useRealTimers(); });

function fixture(options = {}) {
  class Socket extends EventEmitter {
    writes = [];
    failKind = -1;
    constructor() { super(); sockets.push(this); }
    send(bytes, callback) {
      const frame = Buffer.from(bytes);
      if (frame[36] === this.failKind) throw new Error("socket write failed");
      this.writes.push(frame);
      callback?.(); // Network flush is deliberately immediate, before PTY ACKs.
    }
    close() { this.emit("close"); }
    terminate() { this.close(); }
  }
  const result = sendTerminalInput(Socket, "ws://fixture/terminal", "fixture-token", reply,
    { timeoutMs: 100, inputAckSupported: true, ...options });
  const socket = sockets.at(-1);
  socket.emit("open");
  socket.emit("message", Buffer.from("TLOK"));
  const receive = (kind, sequence, overrides = {}) => socket.emit("message", Buffer.from(encodeTerminalFrame(
    overrides.sessionId ?? reply.sessionId, overrides.runtimeEpoch ?? reply.runtimeEpoch,
    sequence, kind, overrides.payload ?? new Uint8Array(),
  )));
  const inputs = () => socket.writes.filter((bytes) => bytes.length >= 41 && bytes[36] === 1);
  return { socket, result, receive, inputs };
}

describe("Watch PTY input delivery", () => {
  it("waits for attach, paste and submit receipts and never replays duplicate acknowledgements", async () => {
    const f = fixture();
    let settled = false;
    void f.result.then(() => { settled = true; });
    expect(f.socket.writes.slice(1).map((bytes) => bytes[36])).toEqual([17, 10]);
    expect(f.inputs()).toHaveLength(0);
    f.receive(11, 1n);
    expect(f.inputs()).toHaveLength(1);
    expect(f.inputs()[0].subarray(41).toString()).toBe("\u001b[200~review this\u001b[201~");
    await Promise.resolve();
    expect(settled).toBe(false);
    f.receive(11, 1n);
    f.receive(16, 2n);
    expect(f.inputs()).toHaveLength(2);
    expect(f.inputs()[1].subarray(41)).toEqual(Buffer.from("\r"));
    f.receive(16, 2n);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.inputs()).toHaveLength(2);
    f.receive(16, 3n);
    await expect(f.result).resolves.toBe(true);
  });

  it.each(["attach", "paste", "submit"])("does not report delivery after a rejected %s", async (stage) => {
    const f = fixture();
    if (stage !== "attach") f.receive(11, 1n);
    if (stage === "submit") f.receive(16, 2n);
    f.receive(12, stage === "attach" ? 1n : stage === "paste" ? 2n : 3n,
      { payload: new TextEncoder().encode("session not found") });
    await expect(f.result).resolves.toBe(false);
    expect(f.inputs()).toHaveLength(stage === "attach" ? 0 : stage === "paste" ? 1 : 2);
  });

  it.each(["attach", "paste", "submit"])("times out without replay when the %s receipt is missing", async (stage) => {
    vi.useFakeTimers();
    const f = fixture();
    if (stage !== "attach") f.receive(11, 1n);
    if (stage === "submit") f.receive(16, 2n);
    const sent = f.inputs().length;
    await vi.advanceTimersByTimeAsync(101);
    await expect(f.result).resolves.toBe(false);
    expect(f.inputs()).toHaveLength(sent);
  });

  it("ignores receipts for another Session, epoch or write", async () => {
    const f = fixture();
    f.receive(11, 1n, { runtimeEpoch: 16 });
    f.receive(11, 1n, { sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    f.receive(16, 3n);
    expect(f.inputs()).toHaveLength(0);
    f.receive(11, 1n);
    f.receive(16, 3n);
    f.receive(16, 2n, { runtimeEpoch: 16 });
    expect(f.inputs()).toHaveLength(1);
    f.socket.close();
    await expect(f.result).resolves.toBe(false);
  });

  it("refuses unsupported daemons and invalid targets before connecting", async () => {
    let connections = 0;
    class Socket { constructor() { connections++; } }
    await expect(sendTerminalInput(Socket, "ws://fixture", "token", reply)).resolves.toBe(false);
    for (const invalid of [
      { ...reply, sessionId: "-".repeat(36) },
      { ...reply, runtimeEpoch: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(validWatchReply(invalid)).toBe(false);
      await expect(sendTerminalInput(Socket, "ws://fixture", "token", invalid, { inputAckSupported: true })).resolves.toBe(false);
    }
    expect(connections).toBe(0);
  });

  it("settles as unconfirmed when a socket write throws", async () => {
    const f = fixture();
    f.socket.failKind = 1;
    f.receive(11, 1n);
    await expect(f.result).resolves.toBe(false);
    expect(f.inputs()).toHaveLength(0);
  });
});
