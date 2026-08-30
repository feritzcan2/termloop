// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import type { Project, Task } from "../src/renderer/model.js";
import { DeleteProjectDialog, type DeleteProjectDialogProps } from "../src/renderer/ui/project-dialogs/delete-project-dialog.js";

function project(): Project {
  return {
    id: "project-1",
    name: "TermloopNext",
    folder_path: "/projects/termloop-next",
  };
}

function task(id: string, title: string, path: string): Task {
  return {
    id,
    project_id: "project-1",
    title,
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: null,
    status: "closed",
    branch: { repository_root: "/projects/termloop-next", name: `task/${id}` },
    worktree: { path },
    worktree_generation: 1,
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
  };
}

function stalePreview(value: Task, forgetAvailable = true): TaskWorktreeCleanupPreviewDto {
  return {
    task_id: value.id,
    managed_worktree_operation_id: `managed-${value.id}`,
    worktree_generation: value.worktree_generation!,
    target_path: value.worktree!.path,
    decision: "unknown",
    blockers: ["repositoryUnavailable"],
    warnings: [],
    health: null,
    presence: null,
    destructive_cleanup: { status: "unavailable", eligible_blockers: [] },
    stale_resolution: {
      forget_status: forgetAvailable ? "available" : "unavailable",
      disposal_status: "unavailable",
      blockers: ["repositoryUnavailable"],
    },
  };
}

describe("Project delete stale worktrees", () => {
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

  async function render(overrides: Partial<DeleteProjectDialogProps> = {}) {
    const workflow = task("workflowss", "workflowss", "/projects/task-workflowss_worktree");
    const history = task("session-history", "SessionHistory", "/projects/task-sessionhistory_worktree");
    const previews = new Map([
      [workflow.id, stalePreview(workflow)],
      [history.id, stalePreview(history)],
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props: DeleteProjectDialogProps = {
      project: project(),
      tasks: [workflow, history],
      close: vi.fn(),
      deleteProject: vi.fn(async () => undefined),
      inspectTaskWorktreeCleanup: vi.fn(async (taskId) => previews.get(taskId)!),
      deleteBlockingTask: vi.fn(async () => ({ status: "completed" as const })),
      reviewTasks: vi.fn(),
      ...overrides,
    };
    mounted.push({ root, host });
    await act(async () => root.render(createElement(DeleteProjectDialog, props)));
    return { host, props, workflow, history, previews };
  }

  it("names every blocker and forgets reviewed stale bindings before deleting the Project", async () => {
    const { host, props, workflow, history, previews } = await render();

    expect(host.textContent).toContain("2 Task worktrees still block deletion");
    expect(host.textContent).toContain("workflowss");
    expect(host.textContent).toContain(workflow.worktree!.path);
    expect(host.textContent).toContain("SessionHistory");
    expect(host.textContent).toContain(history.worktree!.path);
    expect(host.textContent).toContain("without deleting folders");
    expect(host.textContent).toContain("Project deletion will still close the Project's Sessions");
    const submit = host.querySelector<HTMLButtonElement>("#confirm-delete-project")!;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toContain("Forget 2 stale bindings & delete");

    await act(async () => submit.click());

    expect(props.deleteBlockingTask).toHaveBeenNthCalledWith(1, workflow, {
      preview: previews.get(workflow.id),
      kind: "forgetStaleBinding",
    });
    expect(props.deleteBlockingTask).toHaveBeenNthCalledWith(2, history, {
      preview: previews.get(history.id),
      kind: "forgetStaleBinding",
    });
    expect(props.deleteProject).toHaveBeenCalledWith("project-1");
    expect(props.close).toHaveBeenCalledOnce();
  });

  it("keeps non-forgettable worktrees blocked and leads back to Tasks", async () => {
    const blocked = task("healthy", "Healthy checkout", "/projects/healthy");
    const preview = stalePreview(blocked, false);
    const reviewTasks = vi.fn();
    const { host, props } = await render({
      tasks: [blocked],
      inspectTaskWorktreeCleanup: vi.fn(async () => preview),
      reviewTasks,
    });

    const submit = host.querySelector<HTMLButtonElement>("#confirm-delete-project")!;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Worktree cleanup required");
    expect(host.textContent).toContain("Healthy checkout");
    expect(host.textContent).toContain("Needs cleanup");
    const review = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Review Tasks")!;
    await act(async () => review.click());
    expect(reviewTasks).toHaveBeenCalledOnce();
    expect(props.deleteBlockingTask).not.toHaveBeenCalled();
    expect(props.deleteProject).not.toHaveBeenCalled();
  });

  it("stops before Project deletion when a reviewed stale binding changes", async () => {
    const deleteBlockingTask = vi.fn(async () => ({
      status: "reviewRequired" as const,
      preview: stalePreview(task("changed", "Changed", "/projects/changed")),
      message: "The worktree changed. Review the fresh inspection before continuing.",
    }));
    const { host, props } = await render({ deleteBlockingTask });
    const submit = host.querySelector<HTMLButtonElement>("#confirm-delete-project")!;

    await act(async () => submit.click());

    expect(deleteBlockingTask).toHaveBeenCalledOnce();
    expect(props.deleteProject).not.toHaveBeenCalled();
    expect(host.textContent).toContain("The worktree changed. Review the fresh inspection before continuing.");
  });

  it("deletes directly when no Task retains a worktree", async () => {
    const { host, props } = await render({ tasks: [] });
    const submit = host.querySelector<HTMLButtonElement>("#confirm-delete-project")!;
    expect(submit.textContent).toContain("Delete Project");
    await act(async () => submit.click());
    expect(props.deleteBlockingTask).not.toHaveBeenCalled();
    expect(props.deleteProject).toHaveBeenCalledWith("project-1");
  });
});
