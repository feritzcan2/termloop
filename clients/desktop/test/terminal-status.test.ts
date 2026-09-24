import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TerminalPresentation, TerminalPresentationPort } from "../src/renderer/terminal-presentation.js";
import { TerminalStatus } from "../src/renderer/ui/TerminalStatus.js";

function render(state?: TerminalPresentation) {
  const port: TerminalPresentationPort = {
    subscribe: () => () => {},
    snapshot: () => state,
    read: vi.fn(),
    recover: vi.fn(),
  };
  return renderToStaticMarkup(createElement(TerminalStatus, { sessionId: "session-1", port }));
}

describe("terminal status visibility", () => {
  it.each<TerminalPresentation | undefined>([
    undefined,
    { phase: "connecting" },
    { phase: "replaying", progress: 50 },
    { phase: "live" },
    { phase: "live", input: "sending" },
    { phase: "live", input: "confirmed" },
    { phase: "live", notice: "" },
    { phase: "exited" },
  ])("leaves no status bar during ordinary operation: %j", (state) => {
    expect(render(state)).toBe("");
  });

  it.each<[TerminalPresentation, string]>([
    [{ phase: "reconnecting" }, "Reconnecting"],
    [{ phase: "failed" }, "Terminal unavailable"],
    [{ phase: "live", input: "uncertain" }, "Delivery unconfirmed"],
    [{ phase: "live", notice: "Some earlier output is unavailable." }, "Some earlier output is unavailable."],
  ])("shows terminal problems: %j", (state, message) => {
    expect(render(state)).toContain(message);
    expect(render(state)).toContain('role="status"');
  });

  it("keeps the recovery action available after a failure", () => {
    expect(render({ phase: "failed" })).toContain("Reopen view");
  });

  it.each(["", "Captured output"])("keeps paused output and return to live accessible: %j", (reading) => {
    const markup = render({ phase: "live", reading, unread: true });
    expect(markup).toContain(reading || "No output yet.");
    expect(markup).toContain("Paused terminal output");
    expect(markup).toContain("Return to live");
  });
});
