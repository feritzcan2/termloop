import { describe, expect, it } from "vitest";

import { connectionSnapshotRefresh } from "../src/renderer/composition/connection-refresh.js";

describe("connection snapshot refresh policy", () => {
  it("refreshes connected and legacy summaries", () => {
    expect(connectionSnapshotRefresh({ state: "connected" })).toEqual({ kind: "refresh" });
    expect(connectionSnapshotRefresh({})).toEqual({ kind: "refresh" });
  });

  it("retains unavailable sources for the subscription reconnect loop", () => {
    expect(connectionSnapshotRefresh({ state: "connecting" })).toEqual({
      kind: "retain",
      state: "connecting",
    });
    expect(connectionSnapshotRefresh({ state: "offline", message: "Connection lost; reconnecting" }))
      .toEqual({
        kind: "retain",
        state: "offline",
        message: "Connection lost; reconnecting",
      });
  });
});
