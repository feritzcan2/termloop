import { describe, expect, it, vi } from "vitest";

import {
  createProjectionRefreshQueue,
  KeyedProjectionRefreshQueue,
} from "../src/renderer/state/projection-refresh.js";

describe("projection refresh queue", () => {
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
});
