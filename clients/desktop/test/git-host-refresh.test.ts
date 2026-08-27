import type { GitHostTaskProjectionDto } from "@termloop/contract/current";
import { describe, expect, it, vi } from "vitest";
import { GitHostRefreshCoordinator, requestGitHostProjectionBatches } from "../src/renderer/composition/git-host-refresh.js";

describe("Git host projection refresh", () => {
  it("requests all unique Task projections in one batch", async () => {
    const projections = [{ task_id: "one" }, { task_id: "two" }] as GitHostTaskProjectionDto[];
    const request = vi.fn().mockResolvedValue(projections);

    const result = await requestGitHostProjectionBatches(
      "project-one",
      ["one", "two", "one"],
      request,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("project-one", ["one", "two"]);
    expect(result).toEqual({ requestedTaskIds: ["one", "two"], projections });
  });

  it("requests oversized Task sets as sequential bounded batches", async () => {
    const taskIds = Array.from({ length: 41 }, (_, index) => `task-${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const request = vi.fn(async (_projectId: string, requestedTaskIds: string[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return requestedTaskIds.map((taskId) => ({ task_id: taskId } as GitHostTaskProjectionDto));
    });

    const result = await requestGitHostProjectionBatches("project-one", taskIds, request);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toEqual(taskIds.slice(0, 40));
    expect(request.mock.calls[1]?.[1]).toEqual(taskIds.slice(40));
    expect(maxInFlight).toBe(1);
    expect(result?.requestedTaskIds).toEqual(taskIds);
    expect(result?.projections).toHaveLength(41);
  });

  it("does not issue an empty batch request", async () => {
    const request = vi.fn();

    await expect(requestGitHostProjectionBatches("project-one", [], request)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("stops before a trailing batch when Project selection is cancelled", async () => {
    const taskIds = Array.from({ length: 41 }, (_, index) => `task-${index}`);
    let active = true;
    const request = vi.fn(async (_projectId: string, requestedTaskIds: string[]) => {
      active = false;
      return requestedTaskIds.map((taskId) => ({ task_id: taskId } as GitHostTaskProjectionDto));
    });

    await expect(requestGitHostProjectionBatches(
      "project-one",
      taskIds,
      request,
      () => active,
    )).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("single-flights overlapping Task refreshes for the selected Project", async () => {
    let release: (() => void) | undefined;
    const request = vi.fn(async (_projectId: string, taskIds: string[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return taskIds.map((taskId) => ({ task_id: taskId } as GitHostTaskProjectionDto));
    });
    const apply = vi.fn();
    const coordinator = new GitHostRefreshCoordinator(request, apply);
    coordinator.activateProject("project-one");

    const first = coordinator.request("project-one", ["one", "two"]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const duplicate = coordinator.request("project-one", ["two"]);
    release?.();
    await Promise.all([first, duplicate]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("drops obsolete responses and does not start their queued batches after a Project switch", async () => {
    let release: (() => void) | undefined;
    const request = vi.fn(async (_projectId: string, taskIds: string[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return taskIds.map((taskId) => ({ task_id: taskId } as GitHostTaskProjectionDto));
    });
    const apply = vi.fn();
    const coordinator = new GitHostRefreshCoordinator(request, apply);
    coordinator.activateProject("project-one");

    const obsolete = coordinator.request(
      "project-one",
      Array.from({ length: 41 }, (_, index) => `task-${index}`),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    coordinator.activateProject("project-two");
    release?.();
    await obsolete;

    expect(request).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
});
