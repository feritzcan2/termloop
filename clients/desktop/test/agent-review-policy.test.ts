import { describe, expect, it } from "vitest";
import { newlyReviewReadySessions } from "../src/renderer/state/agent-review-policy.js";

describe("agent review policy", () => {
  it("marks only structured working to idle transitions as ready for review", () => {
    const current = [
      { sessionId: "claude", status: "idle", source: "hook", observedAtEpochMs: 2 },
      { sessionId: "codex", status: "idle", source: "appServer", observedAtEpochMs: 2 },
      { sessionId: "untrusted", status: "idle", source: "none", observedAtEpochMs: 2 },
      { sessionId: "still-working", status: "working", source: "hook", observedAtEpochMs: 2 },
    ] as const;
    const previous = new Map([
      ["claude", "working"],
      ["codex", "working"],
      ["untrusted", "working"],
      ["still-working", "working"],
    ]);

    expect(newlyReviewReadySessions(previous, current)).toEqual(["claude", "codex"]);
    expect(newlyReviewReadySessions(new Map(), current)).toEqual([]);
  });
});
