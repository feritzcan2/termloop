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

  it("recovers an expired local observation and keeps the selected file when entry IDs change", async () => {
    const nextList = { ...changeList("local-2"), entries: [
      entry("entry-1", "new.txt", "untracked"),
      entry("entry-2", "src/alpha.ts", "unstaged"),
      entry("entry-3", "src/bravo.ts", "staged"),
      entry("entry-4", "notes.txt", "untracked"),
    ] };
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1"))
      .mockResolvedValueOnce(nextList);
    const editorProps = props(list);
    const readDiff = editorProps.diff;
    editorProps.diff = vi.fn<ChangesOverlayProps["diff"]>(async (...args) => {
      if (args[1] === "local-1" && args[2] === "entry-3") {
        throw new Error("Error invoking remote method 'termloop:task-worktree-diff': TermLoopControlError: worktree changed during inspection; inspect again");
      }
      return readDiff(...args);
    });
    ({ container, root } = await renderEditor(editorProps));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Mark src/alpha.ts as reviewed"]')!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-change-entry-id="entry-3"]')!.click());

    expect(list).toHaveBeenCalledTimes(2);
    expect(editorProps.diff).toHaveBeenLastCalledWith("task-1", "local-2", "entry-4");
    expect(container.querySelector('[data-change-entry-id="entry-4"]')?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("0/4 reviewed");
    expect(container.textContent).not.toContain("The diff became stale");
  });

  it("stops after one stale observation recovery attempt", async () => {
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1"))
      .mockResolvedValue(changeList("local-2"));
    const editorProps = props(list);
    editorProps.diff = vi.fn<ChangesOverlayProps["diff"]>(async () => {
      throw new Error("worktree changed during inspection; inspect again");
    });
    ({ container, root } = await renderEditor(editorProps));

    expect(list).toHaveBeenCalledTimes(2);
    expect(editorProps.diff).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("The diff became stale");
  });

  it("renews the patch together with an expired full-file pre-image", async () => {
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce({ ...changeList("local-1"), entries: [entries[0]!] })
      .mockResolvedValueOnce({ ...changeList("local-2"), entries: [entries[0]!] });
    const editorProps = props(list);
    editorProps.diff = vi.fn<ChangesOverlayProps["diff"]>(async (taskId, observationId, entryId) => ({
      task_id: taskId, observation_id: observationId, entry_id: entryId, state: "patch",
      patch: `diff --git a/src/alpha.ts b/src/alpha.ts\n--- a/src/alpha.ts\n+++ b/src/alpha.ts\n@@ -1 +1 @@\n-before\n+${observationId === "local-1" ? "old preview" : "current preview"}\n`,
    }));
    editorProps.preImage = vi.fn<ChangesOverlayProps["preImage"]>(async (taskId, observationId, entryId) => {
      if (observationId === "local-1") throw new Error("worktree changed during inspection; inspect again");
      return { task_id: taskId, observation_id: observationId, entry_id: entryId, state: "content", revision: "index", content: "before\n" };
    });
    ({ container, root } = await renderEditor(editorProps));
    expect(container.textContent).toContain("old preview");
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".changes-header-actions button")]
      .find((button) => button.textContent === "Full file")!.click());

    expect(editorProps.diff).toHaveBeenLastCalledWith("task-1", "local-2", "entry-1");
    expect(editorProps.preImage).toHaveBeenLastCalledWith("task-1", "local-2", "entry-1");
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("current preview");
    expect(container.textContent).not.toContain("old preview");
    expect(container.textContent).not.toContain("could not be read");
  });

  it("discards an automatic recovery overtaken by a manual Refresh", async () => {
    let finishRecovery!: (value: TaskWorktreeChangeListResult) => void;
    const pendingRecovery = new Promise<TaskWorktreeChangeListResult>((resolve) => { finishRecovery = resolve; });
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1"))
      .mockImplementationOnce(() => pendingRecovery)
      .mockResolvedValueOnce(changeList("local-3"));
    const editorProps = props(list);
    const readDiff = editorProps.diff;
    editorProps.diff = vi.fn<ChangesOverlayProps["diff"]>(async (...args) => {
      if (args[1] === "local-1") throw new Error("worktree changed during inspection; inspect again");
      return readDiff(...args);
    });
    ({ container, root } = await renderEditor(editorProps));
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".changes-header-actions button")]
      .find((button) => button.textContent?.includes("Refresh"))!.click());
    await act(async () => finishRecovery(changeList("local-2")));

    expect(list).toHaveBeenCalledTimes(3);
    expect(editorProps.diff).toHaveBeenCalledTimes(2);
    expect(editorProps.diff).toHaveBeenLastCalledWith("task-1", "local-3", "entry-2");
    expect(container.textContent).not.toContain("The diff became stale");
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
