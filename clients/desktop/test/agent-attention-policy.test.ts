import { describe, expect, it } from "vitest";
import { newlyAwaitingSessions } from "../src/renderer/state/agent-attention-policy.js";

describe("agent attention policy", () => {
  it("notifies only once for a structured transition into awaiting input", () => {
    const current = [
      { sessionId: "hook", status: "awaitingInput", source: "hook", observedAtEpochMs: 1 },
      { sessionId: "unknown", status: "unknown", source: "none", observedAtEpochMs: 0 },
      { sessionId: "untrusted", status: "awaitingInput", source: "none", observedAtEpochMs: 1 },
    ] as const;
    expect(newlyAwaitingSessions(new Map(), current)).toEqual(["hook"]);
    expect(newlyAwaitingSessions(new Map([["hook", "awaitingInput"]]), current)).toEqual([]);
  });
});
