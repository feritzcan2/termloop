import { describe, expect, it, vi } from "vitest";
import type { TaskBranchCommitSummaryDto } from "@termloop/contract/current";
import { BranchCommitRefreshQueue } from "../src/renderer/composition/branch-commit-refresh.js";

const summary = (taskId: string): TaskBranchCommitSummaryDto => ({
  task_id: taskId,
  count: 1,
  base_ref: "refs/remotes/origin/main",
  not_in_base: {
    count: 1,
    base_ref: "refs/remotes/origin/main",
    freshness: "fresh",
    reason: null,
  },
  freshness: "fresh",
  reason: null,
});

describe("BranchCommitRefreshQueue", () => {
  it("coalesces an invalidation burst into one active request and one merged rerun", async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const load = vi.fn(async (_projectId: string, taskIds: readonly string[]) => {
      if (load.mock.calls.length === 1) await first;
      return taskIds.map(summary);
    });
    const apply = vi.fn();
    const reportError = vi.fn();
    const queue = new BranchCommitRefreshQueue(load, apply, reportError);

    const pending = queue.request("project", ["one"]);
    for (let index = 0; index < 100; index += 1) {
      void queue.request("project", ["one", `task-${index}`]);
    }
    releaseFirst?.();
    await pending;

    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[1]).toHaveLength(101);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("isolates a projection failure and continues with pending projects", async () => {
    const load = vi.fn(async (projectId: string, taskIds: readonly string[]) => {
      if (projectId === "broken") throw new Error("request timeout");
      return taskIds.map(summary);
    });
    const apply = vi.fn();
    const reportError = vi.fn();
    const queue = new BranchCommitRefreshQueue(load, apply, reportError);

    const first = queue.request("broken", ["one"]);
    void queue.request("healthy", ["two"]);
    await first;

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("healthy", ["two"], [summary("two")]);
  });
});
