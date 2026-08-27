// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import type { Task } from "../src/renderer/model.js";
import { DeleteTaskDialog } from "../src/renderer/ui/task-dialogs/delete-task-dialog.js";

function task(): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Stale checkout",
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: null,
    status: "open",
    branch: { repository_root: "/repo", name: "feature/stale" },
    worktree: { path: "/repo-stale" },
    worktree_generation: 2,
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
  };
}

function stalePreview(forgetAvailable: boolean): TaskWorktreeCleanupPreviewDto {
  return {
    task_id: "task-1",
    managed_worktree_operation_id: "managed-1",
    worktree_generation: 2,
    target_path: "/repo-stale",
    decision: "refused",
    blockers: ["pathRegistrationInconsistent", "orphanedManagedDirectory"],
    warnings: [],
    health: null,
    presence: {
      observation_sequence: 1,
      observed_at_epoch_ms: 1,
      attached_sessions: [],
      total_count: 0,
      terminal_count: 0,
      agent_count: 0,
      truncated: false,
    },
    destructive_cleanup: { status: "unavailable", eligible_blockers: [] },
    stale_resolution: {
      forget_status: forgetAvailable ? "available" : "unavailable",
      disposal_status: "available",
      blockers: [],
    },
  };
}

describe("Task stale delete confirmation", () => {
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

  async function render(preview: TaskWorktreeCleanupPreviewDto) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const close = vi.fn();
    const remove = vi.fn();
    mounted.push({ root, host });
    await act(async () => {
      root.render(createElement(DeleteTaskDialog, {
        task: task(),
        inspect: vi.fn(async () => preview),
        close,
        remove,
      }));
    });
    return { host, close, remove };
  }

  it("offers the record-only forget path and describes the folder as unverified", async () => {
    const preview = stalePreview(true);
    const { host, remove } = await render(preview);

    expect(host.textContent).toContain("Unverified stale folder");
    expect(host.textContent).toContain("cannot verify this folder's current contents or Git ownership");
    const radios = host.querySelectorAll<HTMLInputElement>('input[name="stale-delete-choice"]');
    expect(radios).toHaveLength(2);
    expect(radios[0]?.checked).toBe(true);
    const submit = host.querySelector<HTMLButtonElement>("button.danger-button")!;
    expect(submit.textContent).toContain("keep folder");

    await act(async () => submit.click());
    expect(remove).toHaveBeenCalledWith({ preview, kind: "forgetStaleBinding" });
  });

  it("requires an explicit choice before permanently deleting an unverified folder", async () => {
    const preview = stalePreview(false);
    const { host, remove } = await render(preview);
    const radio = host.querySelector<HTMLInputElement>('input[name="stale-delete-choice"]')!;
    const submit = host.querySelector<HTMLButtonElement>("button.danger-button")!;

    expect(radio.checked).toBe(false);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Choose folder action");
    expect(host.textContent).not.toContain("Deletion is blocked.");
    await act(async () => radio.click());
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toContain("Delete Task and folder");
    await act(async () => submit.click());
    expect(remove).toHaveBeenCalledWith({ preview, kind: "discardStaleDirectory" });
  });
});
