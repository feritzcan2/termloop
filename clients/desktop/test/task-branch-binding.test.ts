import { describe, expect, it } from "vitest";
import { taskBindBranchFailureMessage } from "../src/renderer/transport/task-branch-binding.js";

describe("Task branch binding errors", () => {
  it("renders typed holder details without parsing the server message", () => {
    expect(taskBindBranchFailureMessage({
      ok: false,
      code: "conflict",
      details: { kind: "branchHeldByTask", taskId: "task-holder" },
      message: "opaque server message",
    })).toBe("Branch is already held by Task task-holder.");
  });

  it("falls back to the transport message when conflict details are absent", () => {
    expect(taskBindBranchFailureMessage({
      ok: false,
      code: "operationFailed",
      details: undefined,
      message: "Repository observation failed.",
    })).toBe("Repository observation failed.");
  });
});
