import { describe, expect, it } from "vitest";

import {
  notificationDestination,
  resolveNotificationConnectionId,
} from "../src/features/notifications/notification-navigation";

describe("notification navigation", () => {
  it("opens an ordinary notification on its exact Mac and Agent Session", () => {
    expect(notificationDestination({
      connectionId: "mac-2",
      sessionId: "session-codex",
      projectId: "project-1",
    })).toEqual({ kind: "session", connectionId: "mac-2", sessionId: "session-codex" });
  });

  it("keeps Steward chat on its Project instead of opening a synthetic Session", () => {
    expect(notificationDestination({
      connectionId: "mac-1",
      sessionId: "steward-chat-project-1",
      chatProjectId: "project-1",
    })).toEqual({ kind: "steward", connectionId: "mac-1", projectId: "project-1" });
  });

  it("rejects incomplete or malformed notification data", () => {
    expect(notificationDestination({ sessionId: "session-codex" }))
      .toEqual({ kind: "session", sessionId: "session-codex" });
    expect(notificationDestination({ connectionId: "mac-1", sessionId: "" })).toBeUndefined();
    expect(notificationDestination("session-codex")).toBeUndefined();
  });

  it("finds the owning Mac from the Session when the push hint is missing or stale", () => {
    const scopes = [
      { connectionId: "mac-1", sessionIds: ["session-claude"], projectIds: ["project-1"] },
      { connectionId: "mac-2", sessionIds: ["session-codex"], projectIds: ["project-2"] },
    ];
    expect(resolveNotificationConnectionId(
      { kind: "session", sessionId: "session-codex" },
      scopes,
    )).toBe("mac-2");
    expect(resolveNotificationConnectionId(
      { kind: "session", connectionId: "old-mac-id", sessionId: "session-codex" },
      scopes,
    )).toBe("mac-2");
  });

  it("uses the only paired Mac before its projection has loaded", () => {
    expect(resolveNotificationConnectionId(
      { kind: "session", sessionId: "session-codex" },
      [{ connectionId: "mac-1", sessionIds: [], projectIds: [] }],
    )).toBe("mac-1");
  });
});
