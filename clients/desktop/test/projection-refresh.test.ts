import { describe, expect, it, vi } from "vitest";

import { createProjectionRefreshQueue } from "../src/renderer/state/projection-refresh.js";

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
});
