import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalWriteBatcher } from "../src/renderer/terminal/output-batcher.js";
import { TerminalOutputTail, continueReplay } from "../src/renderer/terminal/replay-continuity.js";
import { TerminalReplayBuffer } from "../src/renderer/terminal/replay-buffer.js";
import { InputReceiptLedger } from "../src/utility/input-receipts.js";
const encode = (text: string) => new TextEncoder().encode(text);
afterEach(() => vi.useRealTimers());
describe("terminal streaming", () => {
  it("renders the first write immediately and coalesces a burst with consumption callbacks", async () => {
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [], writes: Uint8Array[] = [];
    const batcher = new TerminalWriteBatcher((bytes, done) => { writes.push(bytes); callbacks.push(done); });
    const consumed = vi.fn();
    for (let i = 0; i < 1000; i++) batcher.push(new Uint8Array([i % 256]), consumed);
    expect(writes).toHaveLength(1);
    expect(consumed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8);
    expect(writes).toHaveLength(2);
    expect(writes.flatMap((bytes) => [...bytes])).toEqual(Array.from({ length: 1000 }, (_, i) => i % 256));
    callbacks.forEach((done) => done());
    expect(consumed).toHaveBeenCalledTimes(1000);
  });
  it("bounds the retained tail and keeps chronological order across wraparound", () => {
    const tail = new TerminalOutputTail();
    tail.append(new Uint8Array(1024 * 1024).fill(1));
    tail.append(new Uint8Array([2, 3]));
    expect(tail.snapshot()).toHaveLength(1024 * 1024);
    expect([...tail.snapshot().slice(-4)]).toEqual([1, 1, 2, 3]);
  });
  it("removes repeated replay bytes and refuses an unrelated history", () => {
    const previous = encode("a".repeat(80) + "last line\n");
    const replay = encode("a".repeat(70) + "last line\nnew line\n");
    expect(continueReplay(previous, replay)).toEqual({ continuous: true, bytes: encode("new line\n") });
    expect(continueReplay(previous, previous).bytes).toHaveLength(0);
    expect(continueReplay(previous, encode("unrelated")).continuous).toBe(false);
  });
  it("finishes a negotiated replay including gap frames and an empty ready terminal", () => {
    vi.useFakeTimers();
    const complete = vi.fn(), progress = vi.fn();
    const replay = new TerminalReplayBuffer(complete, progress);
    const metadata = new Uint8Array(12); metadata.set(encode("TLRA"));
    const view = new DataView(metadata.buffer); view.setUint32(4, 3); view.setUint32(8, 4);
    replay.begin(metadata);
    replay.accept(); replay.accept(encode("ab"));
    expect(complete).not.toHaveBeenCalled();
    replay.accept(encode("cd"));
    expect(complete).toHaveBeenCalledWith(encode("abcd"), true);
    expect(progress).toHaveBeenCalledWith(50);
    view.setUint32(4, 0); view.setUint32(8, 0); replay.begin(metadata);
    expect(complete).toHaveBeenLastCalledWith(new Uint8Array(), true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases receipt credit only on acknowledgement or explicit uncertainty", async () => {
    vi.useFakeTimers();
    const settled = vi.fn(); const ledger = new InputReceiptLedger(settled);
    ledger.expect(1n, 10); ledger.expect(2n, 20);
    expect(settled).not.toHaveBeenCalled();
    ledger.accept(2n); expect(settled).toHaveBeenCalledWith(30, true);
    ledger.expect(3n, 5); await vi.advanceTimersByTimeAsync(7000);
    expect(settled).toHaveBeenLastCalledWith(5, false);
    ledger.accept(3n); expect(settled).toHaveBeenCalledTimes(2);
  });
});
