import { describe, expect, it } from "vitest";

import { promptBodyError, promptImproveTarget, promptKind, type PromptAsset } from "../src/renderer/prompt-settings.js";

function asset(overrides: Partial<PromptAsset>): PromptAsset {
  return {
    id: "builtin.agent.interactive",
    title: "Interactive agent",
    category: "Agent",
    version: 1,
    canonicalBody: "body",
    effectiveBody: "body",
    customized: false,
    ...overrides,
  };
}

describe("Prompt catalog presentation", () => {
  it("names each entry by how TermLoop delivers it", () => {
    expect(promptKind(asset({ source: "builtIn", effectiveBody: "- delivery: `codexDeveloperInstructions`" })).label)
      .toBe("Built-in system prompt");
    expect(promptKind(asset({ source: "builtIn", effectiveBody: "- delivery: `terminalInput`" })).label)
      .toBe("Built-in runtime message");
    expect(promptKind(asset({ source: "builtIn" })).label).toBe("Built-in template");
    expect(promptKind(asset({ source: "routine", id: "routine.nightly.context" })).label).toBe("Routine context");
    expect(promptKind(asset({ source: "routine", id: "routine.nightly.step" })).label).toBe("Routine instruction");
    expect(promptKind(asset({ source: "provider" })).label).toBe("Unobservable provider prompt");
    expect(promptKind(asset({ source: "project", id: "worker.nightly.wake" })).label).toBe("Runtime message");
    expect(promptKind(asset({ source: "project", id: "runtime.steward.protected" })).label).toBe("System prompt");
  });

  it("routes each entry to the improver that owns it", () => {
    expect(promptImproveTarget(asset({ source: "builtIn", overridePath: "/profile/builtin.agent.interactive.md" })))
      .toEqual({
        kind: "settings",
        id: "builtin.agent.interactive",
        name: "Interactive agent",
        path: "/profile/builtin.agent.interactive.md",
        content: "body",
      });
    // A built-in with no file behind it has nothing for an agent to write.
    expect(promptImproveTarget(asset({ source: "builtIn" }))).toBeUndefined();
    expect(promptImproveTarget(asset({ source: "project", id: "runtime.steward.instructions" })))
      .toEqual({ kind: "assistant", surface: "stewardInstructions", ownerId: null });
    expect(promptImproveTarget(asset({ source: "worker", id: "runtime.worker.w-1.instructions" })))
      .toEqual({ kind: "assistant", surface: "workerInstructions", ownerId: "w-1" });
    expect(promptImproveTarget(asset({ source: "routine", id: "runtime.routine.r-9.instructions" })))
      .toEqual({ kind: "assistant", surface: "routineInstructions", ownerId: "r-9" });
    // Runtime projections and provider prompts are nobody's to rewrite.
    expect(promptImproveTarget(asset({ source: "project", id: "runtime.steward.protected" }))).toBeUndefined();
    expect(promptImproveTarget(asset({ source: "routine", id: "runtime.routine.r-9.context" }))).toBeUndefined();
  });

  it("rejects an empty prompt body", () => {
    expect(promptBodyError("   ")).toContain("empty");
    expect(promptBodyError("body")).toBeUndefined();
  });
});
