import { describe, expect, it } from "vitest";

import {
  PROFILED_DESKTOP_OPERATIONS,
  isProfiledIpcChannel,
} from "../src/source-operations.js";
import { interactiveTaskCreateParams } from "../src/task-automation-transport.js";

/// The preload builds one bridge function per allowlist entry. Main and renderer
/// wiring are checked by the package type-check and exercised by the panel tests.
describe("Project Task automation transport", () => {
  it("allowlists the two Project automation operations as source-targeted channels", () => {
    expect(PROFILED_DESKTOP_OPERATIONS.projectTaskAutomationGet).toBe("termloop:project-task-automation-get");
    expect(PROFILED_DESKTOP_OPERATIONS.projectTaskAutomationSet).toBe("termloop:project-task-automation-set");
    expect(isProfiledIpcChannel("termloop:project-task-automation-get")).toBe(true);
    expect(isProfiledIpcChannel("termloop:project-task-automation-set")).toBe(true);
  });

  it("keeps interactive creation Task-only because the visible flow owns its resolved choices", () => {
    expect(interactiveTaskCreateParams("project-1", "Task", null)).toEqual({
      projectId: "project-1",
      title: "Task",
      brief: null,
      worktreeIntent: "none",
      worktreePrefix: null,
      baseRef: null,
      agentId: null,
      model: null,
      permission: null,
      reasoning: null,
      kickoffMessage: null,
    });
  });
});
