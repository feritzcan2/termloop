import { describe, expect, it } from "vitest";
import { taskLaunchFailureMessage } from "../src/renderer/transport/task-launch.js";

describe("Task launch typed failures", () => {
  it("renders required and queue-timeout details without parsing messages", () => {
    expect(taskLaunchFailureMessage({
      message: "opaque",
      details: { kind: "worktreeRequired", taskId: "task-1" },
    })).toContain("Create a worktree");
    expect(taskLaunchFailureMessage({
      message: "opaque",
      details: { kind: "worktreeUnavailable", taskId: "task-1", reason: "timeout" },
    })).toBe("Task worktree unavailable: timeout.");
  });
});
