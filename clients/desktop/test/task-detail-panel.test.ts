// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { TaskDetailPanel } from "../src/renderer/ui/TaskDetailPanel.js";
import type { GitHostProjection, Task } from "../src/renderer/model.js";

const NOW = 1_700_000_000_000;

function health(
  overrides: Partial<NonNullable<Task["worktree_health"]>> = {},
): NonNullable<Task["worktree_health"]> {
  return {
    observation_sequence: 1,
    observed_at_epoch_ms: NOW,
    path_state: "present",
    registration_state: "matching",
    head_state: "matching",
    launch_ready: true,
    checked_out_branch: "task/detail-page",
    change_count: 0,
    tracked_state: "clean",
    staged_state: "clean",
    untracked_state: "absent",
    ignored_state: "absent",
    submodule_state: "absent",
    worktree_lock_state: "absent",
    index_lock_state: "absent",
    upstream_state: "inSync",
    summary: "healthy",
    ...overrides,
  };
}

function detailTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Ship the detail page",
    brief: null,
    jira_url: null,
    status: "open",
    archived_at_epoch_ms: null,
    branch: { repository_root: "/repository", name: "task/detail-page" },
    worktree: { path: "/worktrees/detail-page" },
    rank: 1,
    created_at_epoch_ms: NOW,
    updated_at_epoch_ms: NOW,
    ...overrides,
  } as Task;
}

function panelProps(overrides: Record<string, unknown> = {}) {
  return {
    task: detailTask(),
    sessions: [],
    statusesById: new Map(),
    reviewReadySessionIds: new Set<string>(),
    gitHostProjection: undefined,
    branchCommitSummary: undefined,
    close: () => {},
    selectSession: () => {},
    openChanges: () => {},
    openExternal: async () => {},
    ...overrides,
  } as never;
}

async function mount(overrides: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(TaskDetailPanel, panelProps(overrides))));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

describe("the Task detail page on screen", () => {
  it("heads the page with the sidebar's own meta line and shows no pipeline", async () => {
    const { container, unmount } = await mount();

    expect(container.querySelector(".td-header .task-meta-branch")?.textContent).toBe("task/detail-page");
    expect(container.querySelector(".td-status")).toBeNull();
    // The fixture's checkout is still being observed, so that is the one banner;
    // a healthy Task prints no reassurance line at all.
    expect(container.querySelectorAll(".td-now-item")).toHaveLength(1);
    expect(container.textContent).not.toContain("Ready to run agents");
    expect([...container.querySelectorAll(".td-card-head h2")].map((h) => h.textContent))
      .toEqual(["Sessions", "Changes", "Description"]);
    expect(container.textContent).not.toMatch(/pipeline/i);
    expect(container.querySelector(".td-step, .td-spine, .td-meter")).toBeNull();

    await unmount();
  });

  it("says so when the Task has no description, and renders one inside the scroll surface", async () => {
    const empty = await mount();
    expect(empty.container.querySelector(".td-description .td-note")?.textContent).toBe("This Task has no description.");
    await empty.unmount();

    const task = detailTask({ brief: Array.from({ length: 80 }, (_, index) => `Description line ${index + 1}`).join("\n") });
    const { container, unmount } = await mount({ task });
    const brief = container.querySelector(".td-brief")!;
    expect(container.querySelector(".td-header .td-brief")).toBeNull();
    expect(container.querySelector(".td-body")!.contains(brief)).toBe(true);
    expect(brief.closest(".td-description")).not.toBeNull();
    await unmount();
  });

  it("marks a closed Task with a status pill", async () => {
    const { container, unmount } = await mount({ task: detailTask({ status: "closed" }) });
    expect(container.querySelector(".td-status")?.textContent).toBe("Closed");
    await unmount();
  });

  it("shows the checked-out worktree branch as the effective branch", async () => {
    const task = detailTask({
      worktree_health: health({ checked_out_branch: "feature/live-checkout", head_state: "mismatch" }),
    });
    const { container, unmount } = await mount({ task });

    expect(container.querySelector(".td-effective-branch")?.textContent)
      .toBe("feature/live-checkout");
    expect(container.querySelector(".td-effective-branch")?.classList.contains("attention"))
      .toBe(true);
    expect(container.querySelector(".td-effective-branch")?.getAttribute("title"))
      .toContain("Task branch task/detail-page");

    await unmount();
  });

  it("lists every observed Task-worktree branch under its own heading and opens that branch", async () => {
    const opened: unknown[] = [];
    const branch = (overrides: Record<string, unknown>) => ({
      role: "associated",
      held_by_task_id: null,
      checked_out: false,
      base_ref: null,
      base_oid: "c".repeat(40),
      base_evidence: "worktreeReflog",
      first_observed_worktree_generation: 1,
      rollup_eligible: true,
      ...overrides,
    });
    const task = detailTask({
      branches: {
        primary_branch_id: "primary",
        checked_out_branch_id: "branch-2",
        evidence_truncated: false,
        items: [
          branch({ branch_id: "primary", name: "task/detail-page", role: "primary", base_ref: "develop" }),
          branch({ branch_id: "branch-2", name: "feature/api", checked_out: true, base_ref: "task/detail-page" }),
          branch({ branch_id: "branch-3", name: "feature/legacy-checkout" }),
        ],
      },
    } as never);
    const { container, unmount } = await mount({
      task,
      openChanges: (source: unknown) => opened.push(source),
    });

    const section = [...container.querySelectorAll(".td-subsection")]
      .find((candidate) => candidate.querySelector("h3")?.textContent === "Other branches")!;
    const buttons = [...section.querySelectorAll<HTMLButtonElement>(".td-fact-action")];
    expect(buttons.map((button) => button.textContent))
      .toEqual(["feature/api · base task/detail-page", "feature/legacy-checkout"]);
    expect(buttons[0]!.classList.contains("active")).toBe(true);
    expect(container.textContent).not.toContain("cccccccccccc");
    await act(async () => buttons[0]!.click());
    expect(opened).toEqual([{ kind: "commits", branchId: "branch-2" }]);

    await unmount();
  });

  it("gives pull requests their own subsection and opens one as a review", async () => {
    const opened: unknown[] = [];
    const projection = {
      task_id: "task-1",
      freshness: "fresh",
      freshness_generation: 4,
      repository_provider: "github",
      matches: [{
        provider: "github", host: "github.com", repository_owner: "acme", repository_project: null,
        repository_name: "app", number: 42, url: "https://github.com/acme/app/pull/42",
        title: "Detail page", state: "open", head_branch: "task/detail-page", base_branch: "develop",
      }],
    } as unknown as GitHostProjection;
    const { container, unmount } = await mount({
      gitHostProjection: projection,
      openChanges: (source: unknown) => opened.push(source),
    });

    const section = [...container.querySelectorAll(".td-subsection")]
      .find((candidate) => candidate.querySelector("h3")?.textContent === "Pull requests")!;
    const row = section.querySelector<HTMLButtonElement>(".task-pr")!;
    expect(row.textContent).toContain("#42");
    await act(async () => row.click());
    expect(opened).toEqual([expect.objectContaining({ kind: "pullRequest", freshnessGeneration: 4 })]);

    await unmount();
  });

  it("opens a Session's terminal from its row and offers launchers for a ready Task", async () => {
    const selected: string[] = [];
    const launched: string[] = [];
    const task = detailTask({ worktree_health: health() });
    const { container, unmount } = await mount({
      task,
      sessions: [{ id: "session-1", kind: "Terminal", name: "shell", process: { cwd: "/worktrees/detail-page" } }],
      selectSession: (id: string) => selected.push(id),
      launchTerminal: async (taskId: string) => { launched.push(`terminal:${taskId}`); },
    });

    expect(container.querySelector(".td-count")?.textContent).toBe("1");
    await act(async () => container.querySelector<HTMLButtonElement>(".td-agent")!.click());
    expect(selected).toEqual(["session-1"]);
    await act(async () => container.querySelector<HTMLButtonElement>(".td-launch .td-mini")!.click());
    expect(launched).toEqual(["terminal:task-1"]);

    await unmount();
  });
});
