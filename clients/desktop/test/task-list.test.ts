import { describe, expect, it, vi } from "vitest";
import { TermLoopControlError, type TaskDto, type TaskListParams, type TaskPageDto } from "@termloop/contract/current";
import { readProjectTasks } from "../src/main/task-list.js";

function task(index: number, archived = false): TaskDto {
  return {
    id: `task-${index}`, project_id: "project", title: `Task ${index}`, brief: null,
    jira_url: null, status: "open", archived_at_epoch_ms: archived ? 100 : null,
    branch: null, worktree: null, rank: index, created_at_epoch_ms: 1, updated_at_epoch_ms: 1,
  };
}

describe("complete desktop Task lists", () => {
  it.each(["active", "archived", "all"] as const)("reads every page in the %s scope", async (archiveScope) => {
    const tasks = Array.from({ length: 251 }, (_, index) => task(index, archiveScope === "archived"));
    const read = vi.fn(async (params: TaskListParams): Promise<TaskPageDto> => {
      expect(params.projectId).toBe("project");
      expect(params.archiveScope).toBe(archiveScope);
      const start = Number(params.cursor ?? 0);
      const end = start + (params.limit ?? 50);
      return { items: tasks.slice(start, end), next_cursor: end < tasks.length ? String(end) : null };
    });
    expect(await readProjectTasks(read, { projectId: "project", archiveScope })).toEqual(tasks);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("keeps exact-ID reads free of pagination arguments, including an empty selection", async () => {
    const read = vi.fn(async (): Promise<TaskPageDto> => ({ items: [], next_cursor: null }));
    for (const taskIds of [[], ["task-1", "task-2"]]) {
      const selection = { projectId: "project", archiveScope: "all" as const, taskIds };
      await readProjectTasks(read, selection);
      expect(read).toHaveBeenLastCalledWith(selection);
    }
  });

  it("rejects repeated cursors instead of returning a partial list or looping", async () => {
    const read = vi.fn(async (): Promise<TaskPageDto> => ({ items: [task(1)], next_cursor: "again" }));
    await expect(readProjectTasks(read, { projectId: "project", archiveScope: "active" })).rejects.toThrow(/cursor repeated/);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails explicitly if a daemon never finishes pagination", async () => {
    let cursor = 0;
    const read = vi.fn(async (): Promise<TaskPageDto> => ({ items: [task(cursor)], next_cursor: String(++cursor) }));
    await expect(readProjectTasks(read, { projectId: "project", archiveScope: "active" })).rejects.toThrow(/list bound/);
    expect(read).toHaveBeenCalledTimes(128);
  });

  it("restarts a stale snapshot once without retaining old items", async () => {
    const read = vi.fn<(params: TaskListParams) => Promise<TaskPageDto>>()
      .mockResolvedValueOnce({ items: [task(1)], next_cursor: "old" })
      .mockRejectedValueOnce(new TermLoopControlError("cursor", "invalidMessage", undefined))
      .mockResolvedValueOnce({ items: [task(2)], next_cursor: "new" })
      .mockResolvedValueOnce({ items: [task(3)], next_cursor: null });
    expect(await readProjectTasks(read, { projectId: "project", archiveScope: "active" })).toEqual([task(2), task(3)]);
    expect(read.mock.calls.map(([params]) => params.cursor)).toEqual([undefined, "old", undefined, "new"]);
  });

  it("propagates repeated snapshot invalidation without unbounded retries", async () => {
    const stale = new TermLoopControlError("cursor", "invalidMessage", undefined);
    const read = vi.fn(async (params: TaskListParams): Promise<TaskPageDto> => {
      if (params.cursor) throw stale;
      return { items: [task(1)], next_cursor: "cursor" };
    });
    await expect(readProjectTasks(read, { projectId: "project", archiveScope: "active" })).rejects.toBe(stale);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("propagates a later transport failure without publishing the first page", async () => {
    const failure = new Error("connection closed");
    const read = vi.fn<(params: TaskListParams) => Promise<TaskPageDto>>()
      .mockResolvedValueOnce({ items: [task(1)], next_cursor: "next" })
      .mockRejectedValueOnce(failure);
    await expect(readProjectTasks(read, { projectId: "project", archiveScope: "active" })).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
