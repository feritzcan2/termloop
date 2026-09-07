import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalAttachment, TerminalEvent } from "../src/application/ports";
import { TerminalOutputBatcher } from "../src/features/terminal/output-batcher";
import { submitTerminalTurn } from "../src/features/terminal/submit-terminal-turn";
import { terminalRowWindow } from "../src/presentation/terminal-window";
import { TerminalInputReceipts } from "../src/adapters/production/terminal-input-receipts";

afterEach(() => vi.useRealTimers());
describe("terminal stream UX", () => {
  it("coalesces a flood while preserving byte and EOF order", async () => {
    vi.useFakeTimers();
    const events: TerminalEvent[] = [];
    const batcher = new TerminalOutputBatcher((event) => events.push(event));
    for (let i = 0; i < 1000; i++) batcher.push({ type: "live", bytes: new Uint8Array([i % 256]) });
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(16);
    expect(events).toHaveLength(1);
    const output = events[0];
    expect(output?.type === "live" && [...output.bytes]).toEqual(Array.from({ length: 1000 }, (_, i) => i % 256));
    batcher.push({ type: "live", bytes: new Uint8Array([255]) });
    batcher.push({ type: "eof" });
    expect(events.map((event) => event.type)).toEqual(["live", "live", "eof"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("flushes at the byte bound without waiting for a frame", () => {
    vi.useFakeTimers();
    const events: TerminalEvent[] = [];
    const batcher = new TerminalOutputBatcher((event) => events.push(event));
    batcher.push({ type: "live", bytes: new Uint8Array(64 * 1024) });
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("mounts fewer than 100 rows from a 4800-row terminal and preserves total height", () => {
    const window = terminalRowWindow(4800, 10000, 600, 16);
    expect(window.end - window.start).toBeLessThan(100);
    expect(window.before + (window.end - window.start) * 16 + window.after).toBe(4800 * 16);
  });
  it("keeps the draft unconfirmed when Enter fails, without retrying", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = submitTerminalTurn({} as TerminalAttachment, new Uint8Array([120]), () => true, deliver);
    await vi.advanceTimersByTimeAsync(60);
    expect(await result).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect([...deliver.mock.calls[1]![1]]).toEqual([13]);
  });
  it("does not submit into a replacement attachment", async () => {
    vi.useFakeTimers();
    let current = true;
    const deliver = vi.fn(async () => true);
    const result = submitTerminalTurn({} as TerminalAttachment, new Uint8Array([120]), () => current, deliver);
    await Promise.resolve();
    current = false;
    await vi.advanceTimersByTimeAsync(60);
    expect(await result).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("settles cumulative receipts and rejects a lost connection without replay", async () => {
    vi.useFakeTimers();
    const ledger = new TerminalInputReceipts();
    const first = ledger.expect(1n), second = ledger.expect(2n);
    ledger.accept(2n);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    const lost = ledger.expect(3n);
    ledger.clear();
    await expect(lost).rejects.toThrow("Delivery unconfirmed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never turns a timed-out receipt into success", async () => {
    vi.useFakeTimers();
    const ledger = new TerminalInputReceipts();
    const input = ledger.expect(1n);
    await vi.advanceTimersByTimeAsync(7000);
    ledger.accept(1n);
    await expect(input).rejects.toThrow("Delivery unconfirmed");
  });
});
