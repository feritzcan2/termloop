import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../src/renderer/model.js";
import {
  locallyAcknowledgedAttention,
  newlyReviewReadySessions,
} from "../src/renderer/state/agent-review-policy.js";

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

  it("does not raise review again for an observation another client already acknowledged", () => {
    const current: AgentStatus[] = [
      { sessionId: "seen", status: "idle", source: "hook", observedAtEpochMs: 5, attentionAcknowledgedAtEpochMs: 5 },
      { sessionId: "older-ack", status: "idle", source: "hook", observedAtEpochMs: 6, attentionAcknowledgedAtEpochMs: 5 },
    ];
    const previous = new Map([["seen", "working"], ["older-ack", "working"]]);

    expect(newlyReviewReadySessions(previous, current)).toEqual(["older-ack"]);
  });

  it("reports only local dismissals the daemon does not know yet", () => {
    const statuses: AgentStatus[] = [
      { sessionId: "reviewed", status: "idle", source: "hook", observedAtEpochMs: 10 },
      { sessionId: "back-to-work", status: "working", source: "hook", observedAtEpochMs: 11 },
      { sessionId: "already-known", status: "idle", source: "hook", observedAtEpochMs: 12, attentionAcknowledgedAtEpochMs: 12 },
      { sessionId: "interrupted", status: "interrupted", source: "hook", observedAtEpochMs: 13 },
      { sessionId: "stale-interrupt", status: "interrupted", source: "hook", observedAtEpochMs: 15 },
    ];
    const previous = {
      reviewReadySessionIds: new Set(["reviewed", "back-to-work", "already-known"]),
      acknowledgedInterruptedSessionObservations: new Map<string, number>(),
    };
    const next = {
      reviewReadySessionIds: new Set<string>(),
      acknowledgedInterruptedSessionObservations: new Map([["interrupted", 13], ["stale-interrupt", 14]]),
    };

    expect(locallyAcknowledgedAttention(previous, next, statuses).map(({ status, observedAtEpochMs }) =>
      [status.sessionId, observedAtEpochMs])).toEqual([["reviewed", 10], ["interrupted", 13]]);
    expect(locallyAcknowledgedAttention(next, next, statuses)).toEqual([]);
  });
});
