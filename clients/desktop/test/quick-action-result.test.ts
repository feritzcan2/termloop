import { describe, expect, it } from "vitest";
import { requireQuickActionPreview, requireQuickActionSession } from "../src/renderer/quick-action-result.js";

describe("Quick Action IPC result guards", () => {
  it("rejects the typed-control envelope that previously became an undefined Session id", () => {
    expect(() => requireQuickActionPreview({ ok: true, result: { launch_ticket: "ticket", manifest: {} } }))
      .toThrow("invalidQuickActionPreviewResult");
    expect(() => requireQuickActionSession({ ok: true, result: { id: "session" } }, "project"))
      .toThrow("invalidQuickActionLaunchResult");
  });

  it("accepts direct preview and agent Session results", () => {
    const preview = { launch_ticket: "ticket", manifest: {} };
    expect(requireQuickActionPreview(preview)).toBe(preview);
    const session = { id: "session", project_id: "project", kind: "Agent" };
    expect(requireQuickActionSession(session, "project")).toBe(session);
  });
});
