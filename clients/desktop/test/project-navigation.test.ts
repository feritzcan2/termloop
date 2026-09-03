import { describe, expect, it, vi } from "vitest";
import { selectProjectWithTerminalFocus } from "../src/renderer/composition/project-navigation.js";

describe("project navigation", () => {
  it("restores the destination Project's selected terminal focus", () => {
    const selectProject = vi.fn();
    const focusTerminal = vi.fn();

    selectProjectWithTerminalFocus({
      selectProject,
      selectedSessionByProject: { "project-b": "session-b" },
    }, "project-b", focusTerminal);

    expect(selectProject).toHaveBeenCalledWith("project-b");
    expect(focusTerminal).toHaveBeenCalledWith("session-b");
  });

  it("leaves focus in the renderer when the destination has no terminal", () => {
    const focusTerminal = vi.fn();

    selectProjectWithTerminalFocus({
      selectProject: vi.fn(),
      selectedSessionByProject: { "project-b": null },
    }, "project-b", focusTerminal);

    expect(focusTerminal).not.toHaveBeenCalled();
  });
});
