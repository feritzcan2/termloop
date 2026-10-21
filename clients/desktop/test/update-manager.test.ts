import { describe, expect, it, vi } from "vitest";

import { DEFAULT_UPDATE_CHECK_INTERVAL_MS, UpdateManager } from "../src/main/update-manager.js";
import type { UpdateCheck, UpdateDriverListeners } from "../src/platform/auto-update.js";
import type { UpdateStatus } from "../src/update-status.js";

function harness(options: { confirm?: boolean; checkFailure?: boolean; update?: UpdateCheck } = {}) {
  let listeners: UpdateDriverListeners | undefined;
  const scheduled: Array<{ delayMs: number; task: () => void }> = [];
  const order: string[] = [];
  const driver = {
    listen(next: UpdateDriverListeners) { listeners = next; },
    check: vi.fn(async (): Promise<UpdateCheck | undefined> => {
      order.push("check");
      if (options.checkFailure) throw new Error("offline");
      return options.update;
    }),
    install: vi.fn(() => { order.push("install"); }),
  };
  const confirmRestart = vi.fn(async () => {
    order.push("confirm");
    return options.confirm ?? true;
  });
  const prepareForRestart = vi.fn(async () => { order.push("prepare"); });
  const statuses: UpdateStatus[] = [];
  const manager = new UpdateManager({
    driver,
    schedule(delayMs, task) { scheduled.push({ delayMs, task }); },
    confirmRestart,
    prepareForRestart,
    statusChanged(status) { statuses.push(status); },
    initialDelayMs: 10,
    checkIntervalMs: 20,
  });
  return { manager, driver, listeners: () => listeners, scheduled, confirmRestart, prepareForRestart, order, statuses };
}

describe("desktop update manager", () => {
  it("delays the first check and schedules the next bounded check", async () => {
    const test = harness();
    test.manager.start();
    expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([10]);

    test.scheduled.shift()?.task();
    await vi.waitFor(() => expect(test.driver.check).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([20]));
  });

  it("keeps checking after a transient failure without surfacing raw errors", async () => {
    const test = harness({ checkFailure: true });
    test.manager.start();
    test.scheduled.shift()?.task();

    await vi.waitFor(() => expect(test.driver.check).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([20]));
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

  it("offers a declined update again on the next tick without fetching it again", async () => {
    const test = harness({ confirm: false });
    test.manager.start();
    test.listeners()?.downloaded("0.2.0");
    await vi.waitFor(() => expect(test.confirmRestart).toHaveBeenCalledTimes(1));

    test.scheduled.shift()?.task();
    await vi.waitFor(() => expect(test.confirmRestart).toHaveBeenCalledTimes(2));
    expect(test.driver.check).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([20]));
    expect(test.driver.install).not.toHaveBeenCalled();
  });

  it("reports an up-to-date check", async () => {
    const test = harness();
    await test.manager.checkNow();

    expect(test.statuses).toEqual([{ state: "checking" }, { state: "current" }]);
    expect(test.scheduled).toEqual([]);
  });

  it("reports download progress until the update is ready", async () => {
    const test = harness({ confirm: false, update: { version: "0.2.0", download: new Promise(() => undefined) } });
    await test.manager.checkNow();
    test.listeners()?.progress(41.7);
    test.listeners()?.progress(41.9);
    test.listeners()?.downloaded("0.2.0");

    expect(test.statuses).toEqual([
      { state: "checking" },
      { state: "downloading", version: "0.2.0", percent: null },
      { state: "downloading", version: "0.2.0", percent: 41 },
      { state: "ready", version: "0.2.0" },
    ]);
    expect(test.manager.status()).toEqual({ state: "ready", version: "0.2.0" });
  });

  it("reports a failed download with its version so it can be retried", async () => {
    const test = harness({ update: { version: "0.2.0", download: Promise.reject(new Error("reset")) } });
    await test.manager.checkNow();

    await vi.waitFor(() => expect(test.manager.status()).toEqual({ state: "failed", version: "0.2.0" }));
  });

  it("reports a failed check without a version", async () => {
    const test = harness({ checkFailure: true });
    await test.manager.checkNow();

    expect(test.manager.status()).toEqual({ state: "failed", version: null });
  });

  it("does not open the restart dialog for a manual check of a downloaded update", async () => {
    const test = harness({ confirm: false });
    test.listeners()?.downloaded("0.2.0");
    await vi.waitFor(() => expect(test.confirmRestart).toHaveBeenCalledTimes(1));

    await test.manager.checkNow();
    expect(test.confirmRestart).toHaveBeenCalledTimes(1);
    expect(test.driver.check).not.toHaveBeenCalled();
  });

  it("installs a downloaded update from the user's restart click without asking again", async () => {
    const test = harness({ confirm: false });
    test.listeners()?.downloaded("0.2.0");
    await vi.waitFor(() => expect(test.confirmRestart).toHaveBeenCalledTimes(1));

    await test.manager.install();
    expect(test.order).toEqual(["confirm", "prepare", "install"]);
    expect(test.manager.status()).toEqual({ state: "installing", version: "0.2.0" });
  });

  it("ignores a restart click before any update is downloaded", async () => {
    const test = harness();
    await test.manager.install();

    expect(test.prepareForRestart).not.toHaveBeenCalled();
    expect(test.driver.install).not.toHaveBeenCalled();
  });

  it("checks hourly while the application is in use", () => {
    expect(DEFAULT_UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1_000);
  });
});
