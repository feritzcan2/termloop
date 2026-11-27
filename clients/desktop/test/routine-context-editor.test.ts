// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineConfigurationDto } from "@termloop/contract/current";
import { RoutineContextEditor } from "../src/renderer/ui/StewardPanel.js";
import type { PromptImprovement } from "../src/renderer/ui/PromptImprovement.js";

function routine(id = "routine-1"): RoutineConfigurationDto {
  return {
    id, projectId: "project-1",
    triggerMode: "schedule", name: "Release memory", instructions: "Inspect the release.",
    whileWaiting: { mode: "off", instructions: "" }, enabled: true, scheduleIntervalSeconds: 300,
    generation: 1, contextMarkdown: "# Current\nKeep this until cleared.", contextRevision: 2,
    recentSourceKeys: ["custom:release:1"], relatedTaskIds: [],
    pendingRoutineFindings: [], lastCheckStartedAtEpochMs: null,
    lastAttemptAtEpochMs: null, lastSuccessfulReportAtEpochMs: null, updatedAtEpochMs: 1,
  };
}

function editorProps(improvement?: PromptImprovement) {
  return {
    routine: routine(), health: undefined, reports: [], busy: false,
    ...(improvement ? { improvement } : {}),
    setupImprovement: () => undefined,
    runNow: async () => undefined,
    save: async (_content: string) => undefined,
    saveInstructions: async () => undefined,
    saveStewardInstructions: async () => undefined,
    saveActionHandling: async () => undefined,
    reload: async () => undefined,
  };
}

describe("Routine next-run memory", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("clears only after the user accepts the scoped warning", async () => {
    const save = vi.fn(async () => undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => root.render(createElement(RoutineContextEditor, {
      ...editorProps(), save,
    })));
    const clear = [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Clear memory");
    expect(clear).not.toBeUndefined();

    await act(async () => clear!.click());
    expect(save).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => clear!.click());
    expect(save).toHaveBeenCalledWith("");
    expect(confirm.mock.calls[1]?.[0]).toContain("Session transcript");
    expect(confirm.mock.calls[1]?.[0]).toContain("scan/dedupe state will not be deleted");
  });

  it("shows no version history control", async () => {
    const improvement: PromptImprovement = { start: async () => undefined };

    await act(async () => {
      root.render(createElement(RoutineContextEditor, editorProps(improvement)));
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Configuration version"]')).toBeNull();
    expect(host.textContent).not.toContain("Agent activated");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Apply")).toBe(false);
  });
});
