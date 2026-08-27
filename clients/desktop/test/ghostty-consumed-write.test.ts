import { describe, expect, it, vi } from "vitest";
import { GhosttyConsumedWriteLedger } from "../src/main/ghostty-surfaces.js";

describe("GhosttyConsumedWriteLedger", () => {
  it("resolves writes in order only after every byte is consumed", async () => {
    const ledger = new GhosttyConsumedWriteLedger();
    const resolved: number[] = [];
    const first = ledger.enqueue(5);
    const second = ledger.enqueue(3);
    void first.promise.then(() => resolved.push(1));
    void second.promise.then(() => resolved.push(2));

    ledger.consume(4);
    await Promise.resolve();
    expect(resolved).toEqual([]);
    ledger.consume(2);
    await Promise.resolve();
    expect(resolved).toEqual([1]);
    ledger.consume(2);
    await Promise.resolve();
    expect(resolved).toEqual([1, 2]);
  });

  it("rejects all outstanding writes on teardown", async () => {
    const ledger = new GhosttyConsumedWriteLedger();
    const first = ledger.enqueue(2);
    const second = ledger.enqueue(2);
    const observeFirst = vi.fn();
    const observeSecond = vi.fn();
    void first.promise.catch(observeFirst);
    void second.promise.catch(observeSecond);
    ledger.rejectAll(new Error("closed"));
    await Promise.resolve();
    expect(observeFirst).toHaveBeenCalledOnce();
    expect(observeSecond).toHaveBeenCalledOnce();
  });
});
