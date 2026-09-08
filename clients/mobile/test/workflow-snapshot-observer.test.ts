import type { WorkflowConfigurationListResult } from "@termloop/contract/current";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWorkflowSnapshots } from "../src/features/workflows/workflow-snapshot-observer";

const snapshot = (stateRevision: number): WorkflowConfigurationListResult => ({ configurations: [], executions: [], stateRevision });
const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.useRealTimers(); });
function setup(read = vi.fn(async () => snapshot(1))) {
  let invalidate!: () => void;
  const unsubscribe = vi.fn(), publish = vi.fn(), loading = vi.fn(), failed = vi.fn();
  const observer = observeWorkflowSnapshots({ read, subscribe: (callback) => { invalidate = callback; return unsubscribe; }, minimumRevision: () => publish.mock.calls.at(-1)?.[0].stateRevision ?? -1, publish, loading, failed });
  stops.push(observer.stop);
  return { observer, invalidate: () => invalidate(), unsubscribe, read, publish, loading, failed };
}

describe("foreground workflow snapshot reader", () => {
  it("coalesces event bursts without cancelling a slow response and queues one follow-up", async () => {
    vi.useFakeTimers();
    let finish!: (value: WorkflowConfigurationListResult) => void;
    const read = vi.fn(() => new Promise<WorkflowConfigurationListResult>((resolve) => { finish = resolve; }));
    const h = setup(read);
    for (let index = 0; index < 10; index++) h.invalidate();
    await vi.advanceTimersByTimeAsync(200);
    expect(read).toHaveBeenCalledTimes(1);
    finish(snapshot(1)); await vi.advanceTimersByTimeAsync(0);
    expect(h.publish).toHaveBeenCalledWith(snapshot(1), expect.any(Number));
    expect(read).toHaveBeenCalledTimes(2);
    finish(snapshot(2)); await vi.advanceTimersByTimeAsync(0);
    expect(h.publish).toHaveBeenLastCalledWith(snapshot(2), expect.any(Number));
  });

  it("uses a bounded fallback read and manual refresh without replaying any commands", async () => {
    vi.useFakeTimers();
    const h = setup(); await vi.advanceTimersByTimeAsync(0);
    expect(h.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999); expect(h.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(2);
    h.observer.refresh(); await vi.advanceTimersByTimeAsync(0); expect(h.read).toHaveBeenCalledTimes(3);
  });

  it("keeps the last good snapshot on failure and rejects older revisions", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => snapshot(4));
    const h = setup(read); await vi.advanceTimersByTimeAsync(0);
    read.mockRejectedValueOnce(new Error("Mac offline"));
    h.observer.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(h.failed).toHaveBeenLastCalledWith("Mac offline"); expect(h.publish).toHaveBeenCalledOnce();
    read.mockResolvedValueOnce(snapshot(3)); h.observer.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(h.publish).toHaveBeenCalledOnce(); expect(h.failed).toHaveBeenLastCalledWith(expect.stringContaining("older"));
    read.mockResolvedValueOnce(snapshot(5)); h.observer.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(h.publish).toHaveBeenLastCalledWith(snapshot(5), expect.any(Number));
  });

  it("ignores in-flight results and stops timers/listeners after blur, background, or target change", async () => {
    vi.useFakeTimers();
    let finish!: (value: WorkflowConfigurationListResult) => void;
    const h = setup(vi.fn(() => new Promise<WorkflowConfigurationListResult>((resolve) => { finish = resolve; })));
    h.invalidate(); h.observer.stop();
    finish(snapshot(99)); await vi.advanceTimersByTimeAsync(120_000);
    h.invalidate(); h.observer.refresh();
    expect(h.read).toHaveBeenCalledOnce(); expect(h.publish).not.toHaveBeenCalled(); expect(h.failed).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
