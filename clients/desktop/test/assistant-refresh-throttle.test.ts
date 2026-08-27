import { describe, expect, it } from "vitest";
import {
  ASSISTANT_REFRESH_COALESCE_MS,
  AssistantRefreshThrottle,
} from "../src/renderer/composition/assistant-refresh-throttle.js";

function manualScheduler() {
  const scheduled: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
  return {
    scheduled,
    schedule: (run: () => void, delayMs: number) => {
      const entry = { run, delayMs, cancelled: false };
      scheduled.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    /** Closes the newest open window the way a fired timer would. */
    closeWindow: () => {
      const open = scheduled.filter((entry) => !entry.cancelled).at(-1);
      if (!open) throw new Error("no coalescing window is open");
      open.cancelled = true;
      open.run();
    },
  };
}

describe("assistant refresh coalescing", () => {
  it("refreshes on the leading edge so one discrete change is not delayed", () => {
    const timers = manualScheduler();
    let refreshes = 0;
    const throttle = new AssistantRefreshThrottle(() => { refreshes += 1; }, timers.schedule);

    throttle.request();

    expect(refreshes).toBe(1);
    expect(timers.scheduled[0]?.delayMs).toBe(ASSISTANT_REFRESH_COALESCE_MS);
  });

  it("collapses a streaming burst into one further round per window", () => {
    const timers = manualScheduler();
    let refreshes = 0;
    const throttle = new AssistantRefreshThrottle(() => { refreshes += 1; }, timers.schedule);

    // A streaming executor moves `session`/`agentStatus` many times per window.
    for (let index = 0; index < 40; index += 1) throttle.request();
    expect(refreshes).toBe(1);

    timers.closeWindow();
    expect(refreshes).toBe(2);

    for (let index = 0; index < 40; index += 1) throttle.request();
    expect(refreshes).toBe(2);
    timers.closeWindow();
    expect(refreshes).toBe(3);
  });

  it("stops opening windows once invalidations stop", () => {
    const timers = manualScheduler();
    let refreshes = 0;
    const throttle = new AssistantRefreshThrottle(() => { refreshes += 1; }, timers.schedule);

    throttle.request();
    timers.closeWindow();

    expect(refreshes).toBe(1);
    expect(timers.scheduled.filter((entry) => !entry.cancelled)).toEqual([]);

    throttle.request();
    expect(refreshes).toBe(2);
  });

  it("never refreshes after the subscription is torn down", () => {
    const timers = manualScheduler();
    let refreshes = 0;
    const throttle = new AssistantRefreshThrottle(() => { refreshes += 1; }, timers.schedule);

    throttle.request();
    throttle.request();
    throttle.dispose();

    expect(timers.scheduled.every((entry) => entry.cancelled)).toBe(true);
    expect(refreshes).toBe(1);
  });
});
