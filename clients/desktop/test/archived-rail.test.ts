// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { Task, TaskDeleteWorktreeResult } from "../src/renderer/model.js";
import { ArchivedRail, archivedRailVisible } from "../src/renderer/ui/ArchivedRail.js";

function archivedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-archived",
    project_id: "project-1",
    title: "Consolidate the terminal attachment credentials path",
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: 1_700_000_000_000,
    status: "open",
    branch: { repository_root: "/repository", name: "feature/credentials" },
    worktree: { path: "/repository/.worktrees/credentials" },
    worktree_generation: 1,
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
    ...overrides,
  } as Task;
}

async function renderArchived(tasks: readonly Task[], options: { loading?: boolean; disabled?: boolean; expand?: boolean } = {}): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(ArchivedRail, {
    tasks,
    loading: options.loading ?? false,
    disabled: options.disabled ?? false,
    deletingTaskIds: new Set<string>(),
    restore: () => {},
    inspectTaskWorktreeCleanup: async () => { throw new Error("not inspected in rail test"); },
    deleteTask: async (): Promise<TaskDeleteWorktreeResult> => ({ status: "completed" }),
    overlayVisibilityChanged: () => {},
    overlayContainer: undefined,
  })));
  if (options.expand !== false) {
    const toggle = container.querySelector<HTMLButtonElement>(".rail-toggle");
    if (toggle) await act(async () => toggle.click());
  }
  const markup = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  return markup;
}

describe("Archived rail layout", () => {
  /// The exact shipped regression: the archived row reused `.task-row`, whose
  /// first grid track is a 14px disclosure column that only active Tasks fill.
  /// The title landed in that 14px track and rendered as a single character.
  it("never places an archived title inside the active row's 14px disclosure grid", async () => {
    const markup = await renderArchived([archivedTask()]);

    expect(markup).not.toContain("task-row");
    expect(markup).not.toContain("task-item");
    expect(markup).not.toContain("task-title");
    expect(markup).not.toContain("archived-task-row");
    /// The title is a direct child of the row's own compact grid, whose title
    /// track is `minmax(0,1fr)` rather than the active Task disclosure column.
    expect(markup).toContain('class="archived-row"');
    expect(markup).not.toContain('class="archived-copy"');
    expect(markup).toContain('class="archived-title"');
    expect(markup).toContain("Consolidate the terminal attachment credentials path");
  });

  it("keeps a text-labelled restore action visible rather than behind a hover-only icon row", async () => {
    const markup = await renderArchived([archivedTask()]);

    expect(markup).toContain('class="archived-restore"');
    expect(markup).toContain(">restore</button>");
    expect(markup).toContain('aria-label="Restore Consolidate the terminal attachment credentials path"');
    /// `.row-actions` is `opacity: 0` until `:hover`, which would hide the only
    /// action an archived Task has.
    expect(markup).not.toContain("row-actions");
  });

  it("keeps a destructive Task action immediately beside restore", async () => {
    const markup = await renderArchived([archivedTask()]);
    const restore = markup.indexOf('aria-label="Restore Consolidate the terminal attachment credentials path"');
    const remove = markup.indexOf('aria-label="Delete archived Task Consolidate the terminal attachment credentials path"');
    expect(restore).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(restore);
  });

  it("renders nothing at all when no Task is archived", async () => {
    expect(await renderArchived([])).toBe("");
    /// Even a pending refresh must not leave an empty header behind.
    expect(await renderArchived([], { loading: true })).toBe("");
  });

  it("starts collapsed with an accessible header and expands on demand", async () => {
    const tasks = [archivedTask(), archivedTask({ id: "task-archived-2", title: "Second" })];
    const collapsed = await renderArchived(tasks, { expand: false });

    expect(collapsed).toContain('aria-label="Archived items"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-label="Expand Archived items"');
    expect(collapsed).toContain("<h2>Archived</h2>");
    expect(collapsed).toContain('class="count-badge"');
    expect(collapsed).toContain(">2</span>");
    expect(collapsed).toContain('class="rail-glyph"');
    expect(collapsed).not.toContain('class="archived-list"');

    const expanded = await renderArchived(tasks);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('aria-label="Collapse Archived items"');
    expect(expanded).toContain('class="archived-list"');
  });

  it("keeps parked context detail in the compact row tooltip", async () => {
    expect(await renderArchived([archivedTask()])).toContain("Context parked · ");
    expect(await renderArchived([archivedTask({ archived_at_epoch_ms: null })])).toContain(" · Context parked\"");
  });

  it("disables restore while the rail is disabled", async () => {
    expect(await renderArchived([archivedTask()], { disabled: true })).toContain("disabled");
  });
});

describe("Archived rail visibility", () => {
  it("stays in Tasks because archived Agents live in Session History", () => {
    expect(archivedRailVisible(true, "overview")).toBe(true);
    expect(archivedRailVisible(true, "agents")).toBe(false);
    expect(archivedRailVisible(true, "steward")).toBe(false);
    expect(archivedRailVisible(false, "agents")).toBe(false);
  });
});
