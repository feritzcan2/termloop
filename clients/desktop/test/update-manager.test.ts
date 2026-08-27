import { describe, expect, it, vi } from "vitest";

import { UpdateManager } from "../src/main/update-manager.js";
import type { UpdateDriverListeners } from "../src/platform/auto-update.js";

function harness(options: { confirm?: boolean; checkFailure?: boolean } = {}) {
  let listeners: UpdateDriverListeners | undefined;
  const scheduled: Array<{ delayMs: number; task: () => void }> = [];
  const order: string[] = [];
  const driver = {
    listen(next: UpdateDriverListeners) { listeners = next; },
    check: vi.fn(async () => {
      order.push("check");
      if (options.checkFailure) throw new Error("offline");
    }),
    install: vi.fn(() => { order.push("install"); }),
  };
  const confirmRestart = vi.fn(async () => {
    order.push("confirm");
    return options.confirm ?? true;
  });
  const prepareForRestart = vi.fn(async () => { order.push("prepare"); });
  const manager = new UpdateManager({
    driver,
    schedule(delayMs, task) { scheduled.push({ delayMs, task }); },
    confirmRestart,
    prepareForRestart,
    initialDelayMs: 10,
    checkIntervalMs: 20,
  });
  return { manager, driver, listeners: () => listeners, scheduled, confirmRestart, prepareForRestart, order };
}

describe("desktop update manager", () => {
  it("delays the first check and schedules the next bounded check", async () => {
    const test = harness();
    test.manager.start();
    expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([10]);

    test.scheduled.shift()?.task();
    await vi.waitFor(() => expect(test.driver.check).toHaveBeenCalledTimes(1));
    expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([20]);
  });

  it("keeps checking after a transient failure without surfacing raw errors", async () => {
    const test = harness({ checkFailure: true });
    test.manager.start();
    test.scheduled.shift()?.task();

    await vi.waitFor(() => expect(test.driver.check).toHaveBeenCalledTimes(1));
    expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([20]);
  });

  it("prepares the application before installing a downloaded update", async () => {
    const test = harness();
    test.listeners()?.downloaded("0.2.0");

    await vi.waitFor(() => expect(test.driver.install).toHaveBeenCalledTimes(1));
    expect(test.confirmRestart).toHaveBeenCalledWith("0.2.0");
    expect(test.order).toEqual(["confirm", "prepare", "install"]);
  });

  it("leaves the downloaded update pending when restart is declined", async () => {
    const test = harness({ confirm: false });
    test.listeners()?.downloaded("0.2.0");

    await vi.waitFor(() => expect(test.confirmRestart).toHaveBeenCalledTimes(1));
    expect(test.prepareForRestart).not.toHaveBeenCalled();
    expect(test.driver.install).not.toHaveBeenCalled();
  });
});
