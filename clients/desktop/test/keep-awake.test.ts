// @vitest-environment jsdom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { KeepAwakeStatusResult } from "@termloop/contract/current";
import {
  KEEP_AWAKE_MODES,
  keepAwakeCountdown,
  keepAwakeDurationLabel,
  keepAwakeIsBlocked,
  keepAwakeIsEngaged,
  keepAwakeLimitationSentence,
  keepAwakeModeLabel,
  keepAwakeSummary,
} from "../src/renderer/keep-awake.js";
import { KeepAwakePanel } from "../src/renderer/ui/KeepAwakePanel.js";

function status(overrides: Partial<KeepAwakeStatusResult> = {}): KeepAwakeStatusResult {
  return {
    mode: "whileAgentsRun",
    keepDisplayAwake: false,
    state: "inactive",
    eligibleAgentCount: 0,
    reason: "noRunningAgents",
    expiresAtEpochMs: null,
    limitations: [],
    ...overrides,
  };
}

describe("keep-awake presentation", () => {
  it("covers every mode the contract defines", () => {
    expect(KEEP_AWAKE_MODES).toEqual(["off", "whileAgentsRun", "always"]);
    expect(KEEP_AWAKE_MODES.map(keepAwakeModeLabel)).toEqual([
      "Off",
      "While agents run",
      "Always",
    ]);
  });

  it("separates a deliberate off state from a platform problem", () => {
    expect(keepAwakeSummary(status({ mode: "off", reason: "modeOff" })))
      .toBe("Not holding this computer awake.");
    expect(keepAwakeSummary(status({ state: "unsupported", reason: "unsupportedPlatform" })))
      .toBe("Not available on this system.");
    expect(keepAwakeSummary(status({ state: "failed", reason: "platformError" })))
      .toBe("The system refused the request.");
    expect(keepAwakeIsBlocked(status({ mode: "off", reason: "modeOff" }))).toBe(false);
    expect(keepAwakeIsBlocked(status({ state: "failed", reason: "platformError" }))).toBe(true);
  });

  it("formats the timer for the trigger and reports when it has finished", () => {
    expect(keepAwakeCountdown(3_661_000, 0)).toBe("1 hr 02 min");
    expect(keepAwakeCountdown(61_000, 0)).toBe("2 min");
    expect(keepAwakeCountdown(1_000, 1_000)).toBeUndefined();
    expect(keepAwakeDurationLabel(3600)).toBe("1 hour");
    expect(keepAwakeDurationLabel(7200)).toBe("2 hours");
    expect(keepAwakeSummary(status({ reason: "timerExpired", expiresAtEpochMs: 1 })))
      .toBe("The keep-awake timer has finished.");
  });

  it("reports an enabled preference with no agents as waiting, not as active", () => {
    const waiting = status();
    expect(keepAwakeSummary(waiting)).toBe("Waiting for an agent to start.");
    expect(keepAwakeIsEngaged(waiting)).toBe(false);
  });

  it("counts the agents a live hold is being kept for", () => {
    expect(keepAwakeSummary(status({ state: "active", reason: null, eligibleAgentCount: 1 })))
      .toBe("Holding this computer awake for 1 agent.");
    expect(keepAwakeSummary(status({ state: "active", reason: null, eligibleAgentCount: 3 })))
      .toBe("Holding this computer awake for 3 agents.");
    expect(keepAwakeSummary(status({ mode: "always", state: "active", reason: null })))
      .toBe("Holding this computer awake.");
    expect(keepAwakeIsEngaged(status({ state: "active", reason: null }))).toBe(true);
  });

  it("states what the OS can still override, and stays silent when there is nothing to state", () => {
    expect(keepAwakeLimitationSentence([])).toBeUndefined();
    expect(keepAwakeLimitationSentence(["lidClose"]))
      .toBe("It can still sleep from closing the lid.");
    expect(keepAwakeLimitationSentence(["lidClose", "lowBattery", "thermalEmergency"]))
      .toBe("It can still sleep from closing the lid, critically low battery and a thermal emergency.");
  });

  it("renders a collapsed trigger that reveals the options only once opened", () => {
    const markup = renderToStaticMarkup(createElement(KeepAwakePanel, {
      load: () => Promise.resolve(status()),
      save: () => Promise.resolve(status()),
      refreshToken: 0,
    }));
    expect(markup).toContain("Keep Awake");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("While agents run");
  });

  it("clears the completed duration selection so the same timer can be started again", async () => {
    let current = status();
    const load = vi.fn(async () => current);
    const save = vi.fn(async () => {
      current = status({
        mode: "always",
        state: "active",
        reason: null,
        expiresAtEpochMs: Date.now() + 900_000,
      });
      return current;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => root.render(createElement(KeepAwakePanel, { load, save, refreshToken: 0 })));
      await act(async () => container.querySelector<HTMLButtonElement>(".keep-awake-trigger")!.click());
      const timer = container.querySelector<HTMLSelectElement>(".keep-awake-timer select")!;
      await act(async () => {
        timer.value = "900";
        timer.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(save).toHaveBeenCalledWith({
        mode: "always",
        keepDisplayAwake: false,
        durationSeconds: 900,
      });
      expect(timer.value).toBe("900");

      current = status({
        mode: "always",
        reason: "timerExpired",
        expiresAtEpochMs: Date.now() - 1,
      });
      await act(async () => root.render(createElement(KeepAwakePanel, { load, save, refreshToken: 1 })));

      expect(timer.value).toBe("none");
      await act(async () => {
        timer.value = "900";
        timer.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
