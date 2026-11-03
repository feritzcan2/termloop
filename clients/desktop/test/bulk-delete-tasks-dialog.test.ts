// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import type { Task, TaskDeleteWorktreeResult, TaskDeleteWorktreeReview } from "../src/renderer/model.js";
import {
  BulkDeleteTasksDialog,
  planTaskBulkDelete,
} from "../src/renderer/ui/task-dialogs/bulk-delete-tasks-dialog.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Archived work",
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: 1,
    status: "open",
    branch: { repository_root: "/repo", name: "feature/archived" },
    worktree: { path: "/repo/.worktrees/archived" },
    worktree_generation: 1,
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
    ...overrides,
  };
}

function preview(overrides: Partial<TaskWorktreeCleanupPreviewDto> = {}): TaskWorktreeCleanupPreviewDto {
  return {
    task_id: "task-1",
    managed_worktree_operation_id: "managed-1",
    worktree_generation: 1,
    target_path: "/repo/.worktrees/archived",
    decision: "allowed",
    blockers: [],
    warnings: [],
    health: null,
    presence: null,
    destructive_cleanup: { status: "unavailable", eligible_blockers: [] },
    stale_resolution: { forget_status: "unavailable", disposal_status: "unavailable", blockers: [] },
    ...overrides,
  };
}

describe("Task bulk delete plan", () => {
  it("deletes a Task without a worktree outright", () => {
    expect(planTaskBulkDelete(task({ worktree: null }), undefined))
      .toEqual({ kind: "delete", review: undefined, note: "No worktree" });
  });

  it("uses the reviewed cleanup for a clean worktree", () => {
    const value = preview();
    expect(planTaskBulkDelete(task(), value))
      .toEqual({ kind: "delete", review: { preview: value, kind: "cleanup" }, note: "Worktree removed" });
  });

  it("states that discardable checkout content is lost", () => {
    const value = preview({
      decision: "refused",
      blockers: ["trackedChanges"],
      destructive_cleanup: { status: "available", eligible_blockers: ["trackedChanges"] },
    });
    const plan = planTaskBulkDelete(task(), value);
    expect(plan).toMatchObject({ kind: "delete", review: { kind: "cleanup" } });
    expect(plan.kind === "delete" && plan.note).toContain("uncommitted changes discarded");
  });

  it("forgets a stale binding and keeps the folder, like the single-Task default", () => {
    const value = preview({
      decision: "refused",
      blockers: ["orphanedManagedDirectory"],
      stale_resolution: { forget_status: "available", disposal_status: "available", blockers: [] },
    });
    expect(planTaskBulkDelete(task(), value))
      .toMatchObject({ kind: "delete", review: { kind: "forgetStaleBinding" } });
  });

  it("never picks permanent unverified-folder deletion on the user's behalf", () => {
    const value = preview({
      decision: "refused",
      blockers: ["orphanedManagedDirectory"],
      stale_resolution: { forget_status: "unavailable", disposal_status: "available", blockers: [] },
    });
    expect(planTaskBulkDelete(task(), value).kind).toBe("skip");
  });

  it("skips a blocked worktree and a failed inspection", () => {
    const blocked = preview({
      decision: "refused",
      blockers: ["pathRegistrationInconsistent"],
    });
    expect(planTaskBulkDelete(task(), blocked).kind).toBe("skip");
    expect(planTaskBulkDelete(task(), undefined).kind).toBe("skip");
  });
});

describe("Bulk delete Tasks dialog", () => {
  const mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement }[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    for (const entry of mounted.splice(0)) {
      await act(async () => entry.root.unmount());
      entry.host.remove();
    }
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("deletes every eligible Task in order and keeps the ones needing review", async () => {
    const clean = task({ id: "clean", title: "Clean" });
    const plain = task({ id: "plain", title: "No worktree", worktree: null });
    const blocked = task({ id: "blocked", title: "Blocked" });
    const inspect = vi.fn(async (taskId: string) => taskId === "blocked"
      ? preview({ task_id: taskId, decision: "refused", blockers: ["pathRegistrationInconsistent"] })
      : preview({ task_id: taskId }));
    const remove = vi.fn(async (_task: Task, _review: TaskDeleteWorktreeReview | undefined): Promise<TaskDeleteWorktreeResult> => ({ status: "completed" }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => {
      root.render(createElement(BulkDeleteTasksDialog, { tasks: [clean, plain, blocked], inspect, remove, close: () => {} }));
    });

    const confirm = host.querySelector<HTMLButtonElement>(".danger-button")!;
    expect(confirm.textContent).toBe("Delete 2 Tasks");
    expect(host.textContent).toContain("Kept: ");
    await act(async () => confirm.click());

    expect(remove.mock.calls.map(([target]) => target.id)).toEqual(["clean", "plain"]);
    expect(remove.mock.calls[0]![1]).toMatchObject({ kind: "cleanup" });
    expect(remove.mock.calls[1]![1]).toBeUndefined();
    expect(host.textContent).toContain("2 deleted.");
    expect(host.querySelector(".secondary-button")!.textContent).toBe("Done");
  });
});
