import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { SessionTabStrip } from "../src/renderer/ui/SessionTabStrip.js";

function session(id: string, name: string, kind: "Terminal" | "Agent" = "Terminal"): Session {
  return {
    id,
    project_id: "project-1",
    task_id: null,
    name,
    kind,
    lifecycle_state: "running",
    runtime_epoch: 1,
    retryable: false,
    closable: false,
    process: { cwd: "/tmp/project", agent_id: kind === "Agent" ? "codex" : null, template_ref: null },
  } as unknown as Session;
}

describe("SessionTabStrip", () => {
  it("renders every Project Session and marks the selected tab", () => {
    const markup = renderToStaticMarkup(createElement(SessionTabStrip, {
      sessions: [session("one", "First"), session("two", "Second", "Agent")],
      selectedSessionId: "two",
      disabled: false,
      selectSession: vi.fn(),
      launchTerminal: vi.fn(async () => {}),
    }));

    expect(markup).toContain('aria-label="Project Sessions"');
    expect(markup).toContain("First");
    expect(markup).toContain("Second");
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-label="New terminal"');
  });
});
