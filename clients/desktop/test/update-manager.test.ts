import { describe, expect, it, vi } from "vitest";

import { DEFAULT_UPDATE_CHECK_INTERVAL_MS, DEFAULT_UPDATE_RETRY_DELAYS_MS, UpdateManager } from "../src/main/update-manager.js";
import type { UpdateCheck, UpdateDriverListeners } from "../src/platform/auto-update.js";
import type { UpdateStatus } from "../src/update-status.js";

function harness(options: { confirm?: boolean; checkFailure?: boolean | (() => boolean); update?: UpdateCheck } = {}) {
  let listeners: UpdateDriverListeners | undefined;
  const scheduled: Array<{ delayMs: number; task: () => void }> = [];
  const order: string[] = [];
  const driver = {
    listen(next: UpdateDriverListeners) { listeners = next; },
    check: vi.fn(async (): Promise<UpdateCheck | undefined> => {
      order.push("check");
      const fail = typeof options.checkFailure === "function" ? options.checkFailure() : options.checkFailure;
      if (fail) throw Object.assign(new Error("https://updates.example/stable failed"), { code: "net::ERR_NAME_NOT_RESOLVED" });
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
    retryDelaysMs: [1, 2],
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

  it("retries a failed check on the short ladder, then falls back to the interval", async () => {
    const test = harness({ checkFailure: true });
    test.manager.start();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      test.scheduled.shift()?.task();
      await vi.waitFor(() => expect(test.driver.check).toHaveBeenCalledTimes(attempt));
      await vi.waitFor(() => expect(test.scheduled).toHaveLength(1));
      delays.push(test.scheduled[0]!.delayMs);
    }
    expect(delays).toEqual([1, 2, 20]);
  });

  it("returns to the interval once a retried check succeeds", async () => {
    let failing = true;
    const test = harness({ checkFailure: () => failing });
    test.manager.start();
    test.scheduled.shift()?.task();
    await vi.waitFor(() => expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([1]));

    failing = false;
    test.scheduled.shift()?.task();
    await vi.waitFor(() => expect(test.scheduled.map(({ delayMs }) => delayMs)).toEqual([20]));
    expect(test.manager.status()).toEqual({ state: "current" });
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

  it("reports a failed download with its version and code so it can be retried", async () => {
    const download = Promise.reject(Object.assign(new Error("reset"), { code: "ERR_UPDATER_ZIP_FILE_NOT_FOUND" }));
    const test = harness({ update: { version: "0.2.0", download } });
    await test.manager.checkNow();

    await vi.waitFor(() => expect(test.manager.status())
      .toEqual({ state: "failed", version: "0.2.0", reason: "ERR_UPDATER_ZIP_FILE_NOT_FOUND" }));
  });

  it("reports a failed check with its code but never the raw message", async () => {
    const test = harness({ checkFailure: true });
    await test.manager.checkNow();

    expect(test.manager.status()).toEqual({ state: "failed", version: null, reason: "net::ERR_NAME_NOT_RESOLVED" });
    expect(JSON.stringify(test.statuses)).not.toContain("updates.example");
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

  it("checks hourly while the application is in use and retries failures within minutes", () => {
    expect(DEFAULT_UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1_000);
    expect(DEFAULT_UPDATE_RETRY_DELAYS_MS).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
  });
});
