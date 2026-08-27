import type { AgentStatusDto, AgentStatusSource } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import {
  reconcileReviewReadySessions,
  statusMap,
} from "../../src/presentation/agent-review-policy";

function status(sessionId: string, value: AgentStatusDto["status"], source: AgentStatusSource = "hook"): AgentStatusDto {
  return { sessionId, status: value, source, observedAtEpochMs: 1 };
}

describe("mobile review readiness", () => {
  it("marks a structured working to idle transition ready for review", () => {
    const previous = statusMap([status("ses_1", "working")]);
    expect([...reconcileReviewReadySessions(new Set(), previous, [status("ses_1", "idle")])])
      .toEqual(["ses_1"]);
  });

  it("does not invent review attention from a cold-start idle snapshot", () => {
    expect(reconcileReviewReadySessions(new Set(), new Map(), [status("ses_1", "idle")]).size)
      .toBe(0);
  });

  it("ignores a polling-only working to idle transition", () => {
    const previous = statusMap([status("ses_1", "working")]);
    expect(reconcileReviewReadySessions(new Set(), previous, [status("ses_1", "idle", "process")]).size)
      .toBe(0);
  });

  it("keeps review only while idle and clears it when work resumes", () => {
    const ready = new Set(["ses_1"]);
    expect(reconcileReviewReadySessions(ready, new Map(), [status("ses_1", "idle")]).has("ses_1")).toBe(true);
    expect(reconcileReviewReadySessions(ready, new Map(), [status("ses_1", "working")]).has("ses_1")).toBe(false);
  });
});
