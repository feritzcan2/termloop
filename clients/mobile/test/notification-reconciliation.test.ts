import { describe, expect, it } from "vitest";

import {
  attentionNotificationOf,
  staleAttentionNotifications,
  type AttentionScope,
  type PresentedAttentionNotification,
} from "../src/features/notifications/notification-reconciliation";

const DELIVERED_AT = 1_000;

function alert(
  attentionKind: PresentedAttentionNotification["attentionKind"],
  overrides: Partial<PresentedAttentionNotification> = {},
): PresentedAttentionNotification {
  return {
    identifier: `${attentionKind}-1`,
    deliveredAtEpochMs: DELIVERED_AT,
    connectionId: "mac-1",
    sessionId: "session-1",
    attentionKind,
    ...overrides,
  };
}

function scope(
  status: AttentionScope["agentStatuses"][number]["status"] | undefined,
  overrides: Partial<AttentionScope> = {},
): AttentionScope {
  return {
    connectionId: "mac-1",
    readAtEpochMs: DELIVERED_AT + 1,
    sessions: [{ id: "session-1", lifecycle_state: "running", archived_at_epoch_ms: null }],
    agentStatuses: status === undefined ? [] : [{ sessionId: "session-1", status }],
    ...overrides,
  };
}

describe("attention notification reconciliation", () => {
  it("retires an input request answered on the Mac", () => {
    expect(staleAttentionNotifications([alert("needsInput")], [scope("working")]))
      .toEqual(["needsInput-1"]);
    expect(staleAttentionNotifications([alert("needsInput")], [scope("idle")]))
      .toEqual(["needsInput-1"]);
  });

  it("keeps an input request while the agent still waits", () => {
    expect(staleAttentionNotifications([alert("needsInput")], [scope("awaitingInput")])).toEqual([]);
  });

  it("retires a review alert only once a new turn starts", () => {
    expect(staleAttentionNotifications([alert("needsReview")], [scope("idle")])).toEqual([]);
    expect(staleAttentionNotifications([alert("needsReview")], [scope("working")]))
      .toEqual(["needsReview-1"]);
    expect(staleAttentionNotifications([alert("needsReview")], [scope("awaitingInput")]))
      .toEqual(["needsReview-1"]);
  });

  it("never uses a read taken before the push arrived", () => {
    expect(staleAttentionNotifications(
      [alert("needsInput")],
      [scope("working", { readAtEpochMs: DELIVERED_AT })],
    )).toEqual([]);
  });

  it("keeps the alert without status evidence", () => {
    expect(staleAttentionNotifications([alert("needsInput")], [scope(undefined)])).toEqual([]);
    expect(staleAttentionNotifications([alert("needsInput")], [scope("unknown")])).toEqual([]);
    expect(staleAttentionNotifications([alert("needsInput")], [])).toEqual([]);
  });

  it("retires alerts for Sessions that stopped, were archived, or left their Mac", () => {
    expect(staleAttentionNotifications([alert("needsInput")], [scope("awaitingInput", {
      sessions: [{ id: "session-1", lifecycle_state: "exited", archived_at_epoch_ms: null }],
    })])).toEqual(["needsInput-1"]);
    expect(staleAttentionNotifications([alert("needsInput")], [scope("awaitingInput", {
      sessions: [{ id: "session-1", lifecycle_state: "running", archived_at_epoch_ms: 5 }],
    })])).toEqual(["needsInput-1"]);
    expect(staleAttentionNotifications([alert("needsInput")], [scope(undefined, { sessions: [] })]))
      .toEqual(["needsInput-1"]);
  });

  it("does not treat another Mac's read as evidence about a missing Session", () => {
    expect(staleAttentionNotifications(
      [alert("needsInput")],
      [scope(undefined, { connectionId: "mac-2", sessions: [] })],
    )).toEqual([]);
  });

  it("finds the owning Mac by Session even when the push hint is stale", () => {
    expect(staleAttentionNotifications(
      [alert("needsInput", { connectionId: "mac-old" })],
      [scope("working", { connectionId: "mac-2" })],
    )).toEqual(["needsInput-1"]);
  });
});

describe("attention notification parsing", () => {
  it("reads agent attention from Expo content data or the APNs trigger", () => {
    const data = { connectionId: "mac-1", sessionId: "session-1", attentionKind: "needsInput" };
    expect(attentionNotificationOf("a", DELIVERED_AT, data, null)).toEqual({
      identifier: "a",
      deliveredAtEpochMs: DELIVERED_AT,
      connectionId: "mac-1",
      sessionId: "session-1",
      attentionKind: "needsInput",
    });
    expect(attentionNotificationOf("a", DELIVERED_AT, undefined, { type: "push", payload: data }))
      ?.toMatchObject({ sessionId: "session-1" });
  });

  it("ignores Steward and malformed pushes", () => {
    expect(attentionNotificationOf("a", DELIVERED_AT, {
      sessionId: "steward-chat-project-1",
      attentionKind: "stewardReply",
      chatProjectId: "project-1",
    }, null)).toBeUndefined();
    expect(attentionNotificationOf("a", DELIVERED_AT, {
      sessionId: "session-1",
      attentionKind: "needsInput",
      chatProjectId: "project-1",
    }, null)).toBeUndefined();
    expect(attentionNotificationOf("a", DELIVERED_AT, { sessionId: "", attentionKind: "needsInput" }, null))
      .toBeUndefined();
    expect(attentionNotificationOf("a", Number.NaN, {
      sessionId: "session-1",
      attentionKind: "needsInput",
    }, null)).toBeUndefined();
  });
});
