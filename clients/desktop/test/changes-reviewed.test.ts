// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskWorktreeChangeEntryDto, TaskWorktreeChangeListResult } from "@termloop/contract/current";
import { ChangesOverlay, type ChangesOverlayProps } from "../src/renderer/ui/ChangesOverlay.js";

function entry(entryId: string, displayPath: string, side: TaskWorktreeChangeEntryDto["side"]): TaskWorktreeChangeEntryDto {
  return {
    entry_id: entryId,
    display_path: displayPath,
    original_display_path: null,
    path_encoding: "utf8",
    side,
    kind: side === "untracked" ? "untracked" : "modified",
    render_state: "available",
  };
}

const entries = [
  entry("entry-1", "src/alpha.ts", "unstaged"),
  entry("entry-2", "src/bravo.ts", "staged"),
  entry("entry-3", "notes.txt", "untracked"),
];

function changeList(observationId: string): TaskWorktreeChangeListResult {
  return {
    task_id: "task-1",
    observation_id: observationId,
    worktree_generation: 1,
    entries,
    truncated: false,
  };
}

function props(list: ChangesOverlayProps["list"]): ChangesOverlayProps {
  return {
    subject: { id: "task-1", title: "Review files", kind: "task", hasWorktree: true, hasBranch: false },
    initialSource: { kind: "local" },
    close: () => {},
    list,
    diff: async (subjectId, observationId, entryId) => ({
      task_id: subjectId,
      observation_id: observationId,
      entry_id: entryId,
      state: "binary",
      patch: null,
    }),
    preImage: async (subjectId, observationId, entryId) => ({
      task_id: subjectId,
      observation_id: observationId,
      entry_id: entryId,
      state: "notShown",
      revision: "head",
      content: null,
    }),
    listCommits: async (taskId) => ({ task_id: taskId, observation_id: "commits-1", branch_id: "primary", branch_name: "feature/task", branch_role: "primary", held_by_task_id: null, base_ref: "main", base_oid: null, base_evidence: null, commits: [], truncated: false }),
    listCommitChanges: async (taskId, observationId, commitId) => ({ task_id: taskId, observation_id: observationId, commit_id: commitId, state: "available", entries: [], truncated: false }),
    commitDiff: async (taskId, observationId, commitId, entryId) => ({ task_id: taskId, observation_id: observationId, commit_id: commitId, entry_id: entryId, state: "notShown", patch: null }),
    gitHostProjection: undefined,
    listPullRequestChanges: async (taskId, _generation, pullRequest) => ({ task_id: taskId, pull_request: pullRequest, state: "available", reason: null, observation_id: "pr-1", entries: [], truncated: false }),
    pullRequestDiff: async (taskId, observationId, entryId) => ({ task_id: taskId, observation_id: observationId, entry_id: entryId, state: "notShown", reason: null, patch: null }),
    agentSessions: [],
    sendReviewNotes: async () => undefined,
  };
}

async function renderEditor(editorProps: ChangesOverlayProps): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    root.render(createElement(ChangesOverlay, editorProps));
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

function sectionText(container: HTMLElement, title: string): string | undefined {
  return [...container.querySelectorAll<HTMLElement>(".changes-file-section")]
    .find((section) => section.querySelector("h2")?.textContent?.startsWith(title))
    ?.textContent ?? undefined;
}

describe("Changes reviewed files", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("moves checked files into Reviewed and supports mark-all and reset", async () => {
    ({ container, root } = await renderEditor(props(async () => changeList("local-1"))));
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("0/3 reviewed");

    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Mark src/alpha.ts as reviewed"]')!.click());
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");
    expect(sectionText(container, "Reviewed")).not.toContain("alpha.ts");
    await act(async () => container!.querySelector<HTMLButtonElement>(".changes-file-section-toggle")!.click());
    expect(sectionText(container, "Reviewed")).toContain("alpha.ts");
    expect(container.querySelector('[aria-label="Mark src/alpha.ts as unreviewed"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-change-entry-id="entry-2"]')?.getAttribute("aria-current")).toBe("true");

    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".changes-file-review-progress button")]
      .find((button) => button.textContent === "Mark all reviewed")!.click());
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("3/3 reviewed");
    expect(sectionText(container, "Reviewed")).toContain("bravo.ts");
    expect(sectionText(container, "Reviewed")).toContain("notes.txt");

    await act(async () => container!.querySelector<HTMLButtonElement>(".changes-file-review-progress button")!.click());
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("0/3 reviewed");
    expect(sectionText(container, "Reviewed")).toBeUndefined();
  });

  it("clears reviewed state when Refresh creates a new observation", async () => {
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1"))
      .mockResolvedValueOnce(changeList("local-2"));
    ({ container, root } = await renderEditor(props(list)));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Mark src/alpha.ts as reviewed"]')!.click());
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");

    await act(async () => {
      [...container!.querySelectorAll<HTMLButtonElement>(".changes-header-actions button")]
        .find((button) => button.textContent?.includes("Refresh"))!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("0/3 reviewed");
  });

  it("does not reload when composition rebuilds read adapters", async () => {
    const list = vi.fn<ChangesOverlayProps["list"]>(async () => changeList("local-1"));
    const editorProps = props(list);
    ({ container, root } = await renderEditor(editorProps));

    await act(async () => {
      root!.render(createElement(ChangesOverlay, {
        ...editorProps,
        initialSource: { kind: "local" },
        list: (...args) => list(...args),
      }));
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".changes-placeholder")?.textContent).not.toBe("Loading changes…");
  });

  it("opens the aggregate branch diff when branch changes are requested", async () => {
    const listCommitChanges = vi.fn<ChangesOverlayProps["listCommitChanges"]>(async (taskId, observationId, commitId) => ({
      task_id: taskId,
      observation_id: observationId,
      commit_id: commitId,
      state: "available",
      entries: [],
      truncated: false,
    }));
    const editorProps = props(async () => changeList("local-1"));
    editorProps.subject = { ...editorProps.subject, hasBranch: true };
    editorProps.initialSource = { kind: "commits", branchId: "branch-secondary" };
    const listCommits = vi.fn<ChangesOverlayProps["listCommits"]>(async (taskId) => ({
      task_id: taskId,
      observation_id: "commits-branch",
      branch_id: "branch-secondary",
      branch_name: "feature/api",
      branch_role: "associated",
      held_by_task_id: null,
      base_ref: "refs/heads/main",
      base_oid: null,
      base_evidence: null,
      commits: [{
        commit_id: "commit-0",
        branch_id: "branch-secondary",
        branch_name: "feature/api",
        short_oid: "0123456789ab",
        subject: "Ship the change",
        subject_encoding: "utf8",
        authored_at_epoch_ms: 1,
      }],
      truncated: false,
    }));
    editorProps.listCommits = listCommits;
    editorProps.listCommitChanges = listCommitChanges;

    ({ container, root } = await renderEditor(editorProps));
    expect(listCommits).toHaveBeenCalledWith("task-1", "branch-secondary");
    await vi.waitFor(() => expect(listCommitChanges).toHaveBeenCalledWith("task-1", "commits-branch", "all"));

    expect(container.querySelector(".changes-sources button.selected strong")?.textContent).toBe("feature/api");
    expect(container.querySelector(".changes-header p")?.textContent).toContain("Branch changes");
  });
});
