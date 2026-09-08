import { describe, expect, it, vi } from "vitest";
import type { TaskWorktreeChangeEntryDto, TaskWorktreeChangeListResult } from "@termloop/contract/current";
import { recoverLocalChange, type LocalChangeListResult } from "../src/renderer/changes-local-recovery.js";

const stale = new Error("worktree changed during inspection; inspect again");
const selected: TaskWorktreeChangeEntryDto = {
  entry_id: "entry-0", display_path: "new.txt", original_display_path: null,
  path_encoding: "utf8", side: "untracked", kind: "untracked", render_state: "available",
};
const previous: TaskWorktreeChangeListResult = {
  task_id: "task-1", observation_id: "old", worktree_generation: 1,
  entries: [selected], truncated: false,
};

function reads(changes: LocalChangeListResult = { ...previous, observation_id: "fresh" }) {
  return {
    list: vi.fn(async () => changes),
    diff: vi.fn(async (taskId: string, observationId: string, entryId: string) => ({
      task_id: taskId, observation_id: observationId, entry_id: entryId,
      state: "patch" as const, patch: "fresh patch",
    })),
    preImage: vi.fn(async (taskId: string, observationId: string, entryId: string) => ({
      task_id: taskId, observation_id: observationId, entry_id: entryId,
      state: "content" as const, revision: "index" as const, content: "fresh pre-image",
    })),
  };
}

describe("local change observation recovery", () => {
  it.each([
    ["removed", []],
    ["ID reused for another path", [{ ...selected, display_path: "other.txt" }]],
    ["moved to another side", [{ ...selected, side: "staged", kind: "added" }]],
    ["rename source changed", [{ ...selected, original_display_path: "other.txt" }]],
    ["lossy path", [{ ...selected, path_encoding: "lossy" }]],
    ["ambiguous path", [selected, { ...selected, entry_id: "entry-1" }]],
  ] as const)("refuses to substitute a change when %s", async (_label, entries) => {
    const api = reads({ ...previous, observation_id: "fresh", entries: [...entries] });
    await expect(recoverLocalChange(stale, api, "task-1", previous, selected, false, () => true))
      .rejects.toThrow("selected change is no longer available");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("does not follow a replaced Task worktree", async () => {
    const api = reads({ ...previous, observation_id: "fresh", worktree_generation: 2 });
    await expect(recoverLocalChange(stale, api, "task-1", previous, selected, false, () => true))
      .rejects.toBe(stale);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("keeps unrelated errors visible without retrying", async () => {
    const api = reads();
    const failure = new Error("permission denied");
    await expect(recoverLocalChange(failure, api, "task-1", previous, selected, false, () => true))
      .rejects.toBe(failure);
    expect(api.list).not.toHaveBeenCalled();
  });

  it("stops a cancelled selection before reading refreshed content", async () => {
    const api = reads();
    let active = true;
    api.list.mockImplementation(async () => {
      active = false;
      return { ...previous, observation_id: "fresh" };
    });
    expect(await recoverLocalChange(stale, api, "task-1", previous, selected, false, () => active)).toBeUndefined();
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("refreshes both the patch and pre-image for full-file recovery", async () => {
    const api = reads({ ...previous, observation_id: "fresh", entries: [{ ...selected, entry_id: "entry-7" }] });
    const result = await recoverLocalChange(stale, api, "task-1", previous, selected, true, () => true);
    expect(api.diff).toHaveBeenCalledExactlyOnceWith("task-1", "fresh", "entry-7");
    expect(api.preImage).toHaveBeenCalledExactlyOnceWith("task-1", "fresh", "entry-7");
    expect(result?.diff.patch).toBe("fresh patch");
    expect(result?.preImage?.content).toBe("fresh pre-image");
  });

  it("does not retry an unsuccessful full-file renewal", async () => {
    const api = reads();
    api.preImage.mockRejectedValue(stale);
    await expect(recoverLocalChange(stale, api, "task-1", previous, selected, true, () => true))
      .rejects.toBe(stale);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(api.preImage).toHaveBeenCalledTimes(1);
  });

  it("also renews expired Project checkout observations", async () => {
    const project: LocalChangeListResult = {
      project_id: "project-1", observation_id: "old", entries: [selected], truncated: false,
    };
    const api = reads({ ...project, observation_id: "fresh" });
    const result = await recoverLocalChange(new Error("repository is unavailable"), api, "project-1", project, selected, false, () => true);
    expect(result?.changes.observation_id).toBe("fresh");
    expect(api.diff).toHaveBeenCalledExactlyOnceWith("project-1", "fresh", "entry-0");
  });
});
