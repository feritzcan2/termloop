import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlReadPort } from "../src/application/ports";
import { subscribeOverviewInvalidations } from "../src/features/overview/overview-invalidations";

type InvalidationListener = Parameters<ControlReadPort["subscribeInvalidations"]>[1];

function invalidationSource() {
  const listeners = new Map<string, InvalidationListener>();
  const unsubscribe = vi.fn();
  const control: Pick<ControlReadPort, "subscribeInvalidations"> = {
    subscribeInvalidations(connectionId, listener) {
      listeners.set(connectionId, listener);
      return () => {
        listeners.delete(connectionId);
        unsubscribe();
      };
    },
  };
  return {
    control,
    listeners,
    unsubscribe,
    emit(connectionId: string, observationSequence: number, stateRevision = 1) {
      listeners.get(connectionId)?.({ stateRevision, observationSequence, topics: ["agentStatus"] });
    },
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("overview invalidations", () => {
  it("refreshes during a sustained 100 ms daemon stream without waiting for silence", () => {
    vi.useFakeTimers();
    const source = invalidationSource();
    const refresh = vi.fn();
    const stop = subscribeOverviewInvalidations(source.control, "mac", refresh);

    for (let sequence = 1; sequence <= 10; sequence += 1) {
      source.emit("mac", sequence);
      vi.advanceTimersByTime(100);
      expect(refresh).toHaveBeenCalledTimes(Math.floor(sequence / 2));
    }

    expect(refresh).toHaveBeenCalledTimes(5);
    stop();
  });

  it("coalesces a burst from its first event and schedules the next change", () => {
    vi.useFakeTimers();
    const source = invalidationSource();
    const refresh = vi.fn();
    const stop = subscribeOverviewInvalidations(source.control, "mac", refresh);

    source.emit("mac", 1);
    vi.advanceTimersByTime(100);
    source.emit("mac", 2);
    source.emit("mac", 3);
    vi.advanceTimersByTime(19);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    source.emit("mac", 4);
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores exact redelivery but accepts changes to either counter and daemon resets", () => {
    vi.useFakeTimers();
    const source = invalidationSource();
    const refresh = vi.fn();
    const stop = subscribeOverviewInvalidations(source.control, "mac", refresh);

    source.emit("mac", 10, 5);
    vi.advanceTimersByTime(120);
    source.emit("mac", 10, 5);
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(1);

    source.emit("mac", 11, 5);
    vi.advanceTimersByTime(120);
    source.emit("mac", 11, 6);
    vi.advanceTimersByTime(120);
    source.emit("mac", 0, 0);
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
  });

  it("keeps refresh windows independent for each Mac", () => {
    vi.useFakeTimers();
    const source = invalidationSource();
    const refreshA = vi.fn();
    const refreshB = vi.fn();
    const stopA = subscribeOverviewInvalidations(source.control, "mac-a", refreshA);
    const stopB = subscribeOverviewInvalidations(source.control, "mac-b", refreshB);

    source.emit("mac-a", 1);
    vi.advanceTimersByTime(100);
    source.emit("mac-a", 2);
    source.emit("mac-b", 1);
    vi.advanceTimersByTime(20);
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).not.toHaveBeenCalled();
    stopA();
    vi.advanceTimersByTime(100);
    expect(refreshB).toHaveBeenCalledTimes(1);
    stopB();
  });

  it("cancels pending refreshes and fences late events when a subscription stops", () => {
    vi.useFakeTimers();
    const source = invalidationSource();
    const refresh = vi.fn();
    const stop = subscribeOverviewInvalidations(source.control, "mac", refresh);
    const lateListener = source.listeners.get("mac")!;

    source.emit("mac", 1);
    stop();
    lateListener({ stateRevision: 1, observationSequence: 2, topics: ["agentStatus"] });
    vi.advanceTimersByTime(120);
    expect(refresh).not.toHaveBeenCalled();
    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const stopResumed = subscribeOverviewInvalidations(source.control, "mac", refresh);
    source.emit("mac", 1);
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(1);
    stopResumed();
  });
});
