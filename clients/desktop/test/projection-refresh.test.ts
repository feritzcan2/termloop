import { describe, expect, it, vi } from "vitest";

import {
  createProjectionRefreshQueue,
  KeyedProjectionRefreshQueue,
} from "../src/renderer/state/projection-refresh.js";

describe("projection refresh queue", () => {
  it("completes each caller after its snapshot even while invalidations keep arriving", async () => {
    const releases: Array<() => void> = [];
    const completed: number[] = [];
    const refreshOnce = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const refresh = createProjectionRefreshQueue(refreshOnce, async () => {});

    const first = refresh().then(() => { completed.push(1); });
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(1));
    const second = refresh().then(() => { completed.push(2); });
    releases.shift()?.();
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(2));

    const third = refresh().then(() => { completed.push(3); });
    expect(completed).toEqual([1]);
    releases.shift()?.();
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(3));
    expect(completed).toEqual([1, 2]);

    releases.shift()?.();
    await Promise.all([first, second, third]);
    expect(completed).toEqual([1, 2, 3]);
  });

  it("serializes snapshots and coalesces overlap into one trailing refresh", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const refreshOnce = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    });
    const refresh = createProjectionRefreshQueue(refreshOnce, async () => {});

    const first = refresh();
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(1));
    const second = refresh();
    const third = refresh();
    releases.shift()?.();
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await Promise.all([first, second, third]);

    expect(maximumActive).toBe(1);
    expect(refreshOnce).toHaveBeenCalledTimes(2);
  });

  it("coalesces callers before the initial delay finishes into one fresh snapshot", async () => {
    let start!: () => void;
    const refreshOnce = vi.fn(async () => {});
    const refresh = createProjectionRefreshQueue(
      refreshOnce,
      () => new Promise<void>((resolve) => { start = resolve; }),
    );

    const first = refresh();
    const second = refresh();
    expect(refreshOnce).not.toHaveBeenCalled();
    start();
    await Promise.all([first, second]);
    expect(refreshOnce).toHaveBeenCalledOnce();
  });

  it("reports a failed round without discarding requests for the next snapshot", async () => {
    let fail!: (error: Error) => void;
    const refreshOnce = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue(undefined);
    const refresh = createProjectionRefreshQueue(refreshOnce, async () => {});

    const failed = expect(refresh()).rejects.toThrow("source unavailable");
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledOnce());
    const trailing = refresh();
    fail(new Error("source unavailable"));
    await Promise.all([failed, trailing]);
    expect(refreshOnce).toHaveBeenCalledTimes(2);

    await refresh();
    expect(refreshOnce).toHaveBeenCalledTimes(3);
  });

  it("does not report a later snapshot's failure to an already completed caller", async () => {
    let release!: () => void;
    const refreshOnce = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockRejectedValueOnce(new Error("later snapshot failed"));
    const refresh = createProjectionRefreshQueue(refreshOnce, async () => {});

    const first = refresh();
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledOnce());
    const failed = expect(refresh()).rejects.toThrow("later snapshot failed");
    release();
    await expect(first).resolves.toBeUndefined();
    await failed;
  });

  it("rejects callers when the initial delay fails and allows a new attempt", async () => {
    const beforeFirstRefresh = vi.fn()
      .mockRejectedValueOnce(new Error("delay failed"))
      .mockResolvedValue(undefined);
    const refreshOnce = vi.fn(async () => {});
    const refresh = createProjectionRefreshQueue(refreshOnce, beforeFirstRefresh);

    await Promise.all([
      expect(refresh()).rejects.toThrow("delay failed"),
      expect(refresh()).rejects.toThrow("delay failed"),
    ]);
    expect(refreshOnce).not.toHaveBeenCalled();
    await refresh();
    expect(refreshOnce).toHaveBeenCalledOnce();
  });

  it("isolates owners while coalescing each owner's overlap", async () => {
    const releases = new Map<string, Array<() => void>>();
    const calls: string[] = [];
    const queue = new KeyedProjectionRefreshQueue<string>(async (key) => {
      calls.push(key);
      await new Promise<void>((resolve) => {
        const pending = releases.get(key) ?? [];
        pending.push(resolve);
        releases.set(key, pending);
      });
    });

    const firstA = queue.request("a");
    const firstB = queue.request("b");
    await vi.waitFor(() => expect(calls).toEqual(["a", "b"]));
    const secondA = queue.request("a");

    releases.get("b")?.shift()?.();
    await firstB;
    expect(calls).toEqual(["a", "b"]);

    releases.get("a")?.shift()?.();
    await vi.waitFor(() => expect(calls).toEqual(["a", "b", "a"]));
    releases.get("a")?.shift()?.();
    await Promise.all([firstA, secondA]);

    expect(calls).toEqual(["a", "b", "a"]);
  });

  it("releases an inactive lane after its owner is no longer retained", async () => {
    const beforeFirstRefresh = vi.fn(async () => undefined);
    const queue = new KeyedProjectionRefreshQueue<string>(
      async () => undefined,
      beforeFirstRefresh,
    );

    await queue.request("remote-a");
    queue.retain(new Set());
    await queue.request("remote-a");

    expect(beforeFirstRefresh).toHaveBeenCalledTimes(2);
  });

  it("keeps an unretained lane serialized until its last pending round completes", async () => {
    const releases: Array<() => void> = [];
    const refreshOnce = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const queue = new KeyedProjectionRefreshQueue<string>(refreshOnce);

    const first = queue.request("remote");
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(1));
    const second = queue.request("remote");
    queue.retain(new Set());
    releases.shift()?.();
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(2));
    await first;

    const third = queue.request("remote");
    await Promise.resolve();
    expect(refreshOnce).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(refreshOnce).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await Promise.all([second, third]);
  });
});
