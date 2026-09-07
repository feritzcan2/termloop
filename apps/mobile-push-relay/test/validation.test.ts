import { describe, expect, it } from "vitest";
import { pushRequestOf } from "../src/validation";

describe("push relay validation", () => {
  it("accepts only bounded TermLoop APNs deliveries", () => {
    expect(pushRequestOf(fixture())).toEqual({
      ...fixture(),
      devices: [{
        ...fixture().devices[0],
        payload: {
          ...fixture().devices[0].payload,
          body: {
            connectionId: "mac-0123456789abcdef",
            projectId: "project-1",
            sessionId: "session-1",
            attentionKind: "needsInput",
            cwd: null,
            runtimeEpoch: 1,
            chatProjectId: null,
            stewardMessageId: null,
            stewardMessageKind: null,
          },
        },
      }],
    });
    expect(pushRequestOf({ ...fixture(), installationId: "short" })).toBeUndefined();
    expect(pushRequestOf({
      ...fixture(),
      devices: [{ ...fixture().devices[0], bundleId: "example.attacker.app" }],
    })).toBeUndefined();
    expect(pushRequestOf({
      ...fixture(),
      devices: Array.from({ length: 9 }, () => fixture().devices[0]),
    })).toBeUndefined();
    expect(pushRequestOf({
      ...fixture(),
      devices: [{
        ...fixture().devices[0],
        payload: { ...fixture().devices[0].payload, stewardMessageKind: "update" },
      }],
    })).toBeDefined();
  });
});

export function fixture() {
  return {
    version: 1 as const,
    installationId: "a".repeat(32),
    devices: [{
      deviceToken: "b".repeat(64),
      environment: "development" as const,
      bundleId: "ai.termloop.mobile" as const,
      payload: {
        aps: {
          alert: { title: "Codex needs your input", body: "Waiting for your input." },
          sound: "default" as const,
          badge: 1 as const,
          category: "TERMLOOP_AGENT_ATTENTION",
          "thread-id": "session-1",
        },
        connectionId: "mac-0123456789abcdef",
        projectId: "project-1",
        sessionId: "session-1",
        attentionKind: "needsInput",
        cwd: null,
        runtimeEpoch: 1,
        chatProjectId: null,
        stewardMessageId: null,
        stewardMessageKind: null,
      },
    }],
  };
}
