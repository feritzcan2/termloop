import type { GitHostTaskProjectionDto } from "@termloop/contract/current";
import { describe, expect, it, vi } from "vitest";
import { forwardDevelopmentRendererDiagnostics, isDevelopmentRendererDiagnostic } from "../src/main/renderer-diagnostics.js";
import { GitHostRefreshCoordinator, gitHostApplyDiagnostics } from "../src/renderer/composition/git-host-refresh.js";

function projection(taskId: string, numbers: number[], generation: number): GitHostTaskProjectionDto {
  return {
    task_id: taskId,
    matches: numbers.map((number) => ({ number })),
    freshness: "fresh",
    freshness_generation: generation,
    reason: null,
  } as unknown as GitHostTaskProjectionDto;
}

describe("Git host refresh diagnostics", () => {
  it("reports a Task whose PR count moved and stays quiet for an unchanged one", () => {
    const before = [projection("task-one-aaaa", [15410], 1), projection("task-two-bbbb", [1], 1)];
    const incoming = [projection("task-one-aaaa", [15418, 15410, 15408], 2), projection("task-two-bbbb", [1], 2)];

    expect(gitHostApplyDiagnostics(["task-one-aaaa", "task-two-bbbb"], incoming, before, incoming)).toEqual([{
      task: "task-one",
      previous: "1@1",
      incoming: "3@2",
      shown: "3@2",
      freshness: "fresh",
      reason: undefined,
      keptOlder: false,
    }]);
  });

  it("reports when the renderer keeps an older projection than the one received", () => {
    const shown = [projection("task-one", [15410], 5)];
    const incoming = [projection("task-one", [15418, 15410], 4)];

    expect(gitHostApplyDiagnostics(["task-one"], incoming, shown, shown)).toEqual([
      expect.objectContaining({ previous: "1@5", incoming: "2@4", shown: "1@5", keptOlder: true }),
    ]);
  });

  it("reports skipped, ignored, and dropped refreshes", async () => {
    const diagnose = vi.fn();
    let now = 0;
    const coordinator = new GitHostRefreshCoordinator(
      async (_projectId, taskIds) => taskIds.map((taskId) => projection(taskId, [], 1)),
      () => {},
      () => now,
      15_000,
      diagnose,
    );
    await coordinator.request("project-one", ["task"]);
    coordinator.activateProject("project-one");
    await coordinator.request("project-one", ["task"]);
    now = 1;
    await coordinator.request("project-one", ["task"]);

    expect(diagnose.mock.calls.map(([event, fields]) => [event, fields.reason ?? fields.source])).toEqual([
      ["requestIgnored", "inactiveProject"],
      ["request", "automatic"],
    ]);
    await coordinator.request("project-one", ["task"], { force: true });
    expect(diagnose).toHaveBeenLastCalledWith("request", expect.objectContaining({ source: "invalidation", queued: 1, skippedFresh: 0 }));

    let release!: () => void;
    const slow = new GitHostRefreshCoordinator(
      (_projectId, taskIds) => new Promise((resolve) => {
        release = () => resolve(taskIds.map((taskId) => projection(taskId, [], 1)));
      }),
      () => {},
      () => 0,
      15_000,
      diagnose,
    );
    slow.activateProject("project-one");
    const pending = slow.request("project-one", ["task"]);
    slow.activateProject("project-two");
    release();
    await pending;
    expect(diagnose).toHaveBeenLastCalledWith("resultDropped", expect.objectContaining({ tasks: 1 }));
  });

  it("relays only prefixed renderer diagnostics and only in development builds", () => {
    const listeners: Array<(details: { message?: unknown }) => void> = [];
    const contents = { on: (_event: string, listener: (details: { message?: unknown }) => void) => listeners.push(listener) };
    const write = vi.fn();

    forwardDevelopmentRendererDiagnostics(contents as never, true, write);
    expect(listeners).toHaveLength(0);

    forwardDevelopmentRendererDiagnostics(contents as never, false, write);
    listeners[0]!({ message: "[githost-diag] 2026-11-04T00:00:00.000Z applied task=one" });
    listeners[0]!({ message: "unrelated renderer output" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(isDevelopmentRendererDiagnostic("[githost-diag] x")).toBe(true);
    expect(isDevelopmentRendererDiagnostic(42)).toBe(false);
  });
});
