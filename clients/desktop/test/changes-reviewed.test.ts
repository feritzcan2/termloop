// @vitest-environment jsdom

import { act, createElement } from "react";
import { webcrypto } from "node:crypto";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function patch(content = "after"): string {
  return `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before\n+${content}\n`;
}

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
      state: "patch",
      patch: patch(),
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
  await settleReview(container);
  return { container, root };
}

async function settleReview(container: HTMLElement): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector<HTMLButtonElement>(".changes-file-review-progress button")?.disabled).not.toBe(true);
  });
}

async function clickReview(container: HTMLElement, selector: string): Promise<void> {
  await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
  await settleReview(container);
}

function sectionText(container: HTMLElement, title: string): string | undefined {
  return [...container.querySelectorAll<HTMLElement>(".changes-file-section")]
    .find((section) => section.querySelector("h2")?.textContent?.startsWith(title))
    ?.textContent ?? undefined;
}

describe("Changes reviewed files", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function reopen(editorProps: ChangesOverlayProps): Promise<void> {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    ({ container, root } = await renderEditor(editorProps));
  }

  it.each(["task", "project"] as const)("restores %s review marks after reopening with a new observation and reordered entry IDs", async (kind) => {
    let observation = 0;
    const editorProps = props(async () => {
      observation += 1;
      const nextEntries = observation === 1 ? entries : [
        entry("entry-1", "new.txt", "untracked"),
        entry("entry-2", "src/alpha.ts", "unstaged"),
        entry("entry-3", "src/bravo.ts", "staged"),
        entry("entry-4", "notes.txt", "untracked"),
      ];
      return kind === "task"
        ? { ...changeList(`local-${observation}`), entries: nextEntries }
        : { project_id: "task-1", observation_id: `project-${observation}`, entries: nextEntries, truncated: false };
    });
    editorProps.subject = { ...editorProps.subject, kind };
    await reopen(editorProps);
    await clickReview(container!, '[aria-label="Mark src/alpha.ts as reviewed"]');

    await reopen(editorProps);
    expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("1/4 reviewed");
    await clickReview(container!, ".changes-file-section-toggle");
    expect(container!.querySelector('[aria-label="Mark src/alpha.ts as unreviewed"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container!.querySelector('[aria-label="Mark new.txt as reviewed"]')?.getAttribute("aria-pressed")).toBe("false");

    await clickReview(container!, '[aria-label="Mark src/alpha.ts as unreviewed"]');
    await reopen(editorProps);
    expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("0/4 reviewed");
  });

  it("persists mark-all and clear-all across editor remounts", async () => {
    const editorProps = props(async () => changeList("local-1"));
    await reopen(editorProps);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    await clickReview(container!, ".changes-file-review-progress button");
    expect(writes).toHaveBeenCalledTimes(1);
    await reopen(editorProps);
    expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("3/3 reviewed");
    await clickReview(container!, ".changes-file-review-progress button");
    await reopen(editorProps);
    expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("0/3 reviewed");
  });

  it.each(["reopen", "refresh"] as const)("drops only changed file reviews on %s and never revives their old marks", async (action) => {
    let observation = 0;
    const editorProps = props(async () => changeList(`local-${++observation}`));
    const readDiff = editorProps.diff;
    editorProps.diff = async (...args) => ({
      ...await readDiff(...args),
      patch: patch(args[1] === "local-2" && args[2] === "entry-1" ? "changed alpha" : "after"),
    });
    await reopen(editorProps);
    await clickReview(container!, ".changes-file-review-progress button");
    expect(container!.textContent).toContain("3/3 reviewed");
    if (action === "reopen") await reopen(editorProps);
    else {
      await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".changes-header-actions button")]
        .find((button) => button.textContent?.includes("Refresh"))!.click());
      await settleReview(container!);
    }
    expect(container!.textContent).toContain("2/3 reviewed");
    expect(container!.querySelector('[aria-label="Mark src/alpha.ts as reviewed"]')).not.toBeNull();
    expect(sectionText(container!, "Working tree")).toContain("alpha.ts");
    await reopen(editorProps);
    expect(container!.textContent).toContain("2/3 reviewed");
    expect(container!.querySelector('[aria-label="Mark src/alpha.ts as reviewed"]')).not.toBeNull();
    expect(window.localStorage.getItem("termloop.changesReviewed.v2")).not.toContain("diff --git");
  });

  it("reuses viewed diffs and per-observation digests without polling or reading unreviewed files", async () => {
    const editorProps = props(vi.fn(async () => changeList("local-1")));
    const readDiff = vi.fn(editorProps.diff);
    editorProps.diff = readDiff;
    const digest = vi.spyOn(crypto.subtle, "digest");
    await reopen(editorProps);
    const loadedId = readDiff.mock.calls[0]![2];
    const path = entries.find((entry) => entry.entry_id === loadedId)!.display_path;
    await clickReview(container!, `[aria-label="Mark ${path} as reviewed"]`);
    // The only new diff read is the next selected file, not another read for
    // the reviewed file. Re-renders must not revalidate the same observation.
    expect(readDiff.mock.calls.filter((args) => args[2] === loadedId)).toHaveLength(1);
    expect(digest).toHaveBeenCalledTimes(1);
    await act(async () => root!.render(createElement(ChangesOverlay, { ...editorProps, subject: { ...editorProps.subject, title: "Renamed task" } })));
    await settleReview(container!);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(editorProps.list).toHaveBeenCalledTimes(1);
    expect(readDiff.mock.calls.some((args) => args[2] === "entry-3")).toBe(false);
    await clickReview(container!, ".changes-file-section-toggle");
    await clickReview(container!, `[aria-label="Mark ${path} as unreviewed"]`);
    await clickReview(container!, `[aria-label="Mark ${path} as reviewed"]`);
    expect(digest).toHaveBeenCalledTimes(1);
    await reopen(editorProps);
    expect(digest).toHaveBeenCalledTimes(2);
    expect(readDiff.mock.calls.some((args) => args[2] === "entry-3")).toBe(false);
  });

  it("stops queued review reads and hashing when the editor closes", async () => {
    const manyEntries = Array.from({ length: 8 }, (_, index) => entry(`entry-${index}`, `file-${index}.ts`, "untracked"));
    const editorProps = props(async () => ({ ...changeList("local-1"), entries: manyEntries }));
    const readDiff = editorProps.diff;
    const pending: (() => void)[] = [];
    editorProps.diff = vi.fn<ChangesOverlayProps["diff"]>(async (...args) => {
      if (args[2] !== "entry-0") await new Promise<void>((resolve) => pending.push(resolve));
      return readDiff(...args);
    });
    const digest = vi.spyOn(crypto.subtle, "digest");
    await reopen(editorProps);
    await act(async () => container!.querySelector<HTMLButtonElement>(".changes-file-review-progress button")!.click());
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(pending.length).toBeGreaterThanOrEqual(2);
    });
    await act(async () => root!.unmount());
    root = undefined;
    const readsAtClose = vi.mocked(editorProps.diff).mock.calls.length;
    const digestsAtClose = digest.mock.calls.length;
    const persistedAtClose = window.localStorage.getItem("termloop.changesReviewed.v2");
    await act(async () => { for (const finish of pending) finish(); });
    expect(editorProps.diff).toHaveBeenCalledTimes(readsAtClose);
    expect(digest).toHaveBeenCalledTimes(digestsAtClose);
    expect(window.localStorage.getItem("termloop.changesReviewed.v2")).toBe(persistedAtClose);
    expect(readsAtClose).toBeLessThan(manyEntries.length);
    expect(readsAtClose).toBe(3); // One displayed diff plus two concurrent review reads.
  });

  it("does not restore marks for unreadable content", async () => {
    const editorProps = props(async () => changeList("local-1"));
    const readDiff = editorProps.diff;
    editorProps.diff = async (...args) => ({ ...await readDiff(...args), state: "binary", patch: null });
    await reopen(editorProps);
    await clickReview(container!, ".changes-file-review-progress button");
    expect(container!.textContent).toContain("3/3 reviewed");
    expect(container!.textContent).toContain("last until the next refresh");
    await reopen(editorProps);
    expect(container!.textContent).toContain("0/3 reviewed");
  });

  it.each([false, true])("prunes missing files only when the list is complete (truncated: %s)", async (truncated) => {
    let observation = 0;
    const editorProps = props(async () => {
      observation += 1;
      return { ...changeList(`local-${observation}`), entries: observation === 2 ? entries.slice(1) : entries,
        truncated: observation === 2 && truncated };
    });
    await reopen(editorProps);
    await clickReview(container!, '[aria-label="Mark src/alpha.ts as reviewed"]');
    await reopen(editorProps);
    expect(container!.textContent).toContain("0/2 reviewed");
    await reopen(editorProps);
    expect(container!.textContent).toContain(`${truncated ? 1 : 0}/3 reviewed`);
  });

  it("leaves failed verification pending and can retry it on the next refresh", async () => {
    let observation = 0;
    const editorProps = props(async () => changeList(`local-${++observation}`));
    const readDiff = editorProps.diff;
    editorProps.diff = async (...args) => {
      if (args[1] === "local-2" && args[2] === "entry-1") throw new Error("Temporarily unavailable");
      return readDiff(...args);
    };
    await reopen(editorProps);
    await clickReview(container!, ".changes-file-review-progress button");
    await reopen(editorProps);
    expect(container!.textContent).toContain("2/3 reviewed");
    expect(container!.textContent).toContain("Some review marks could not be checked");
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".changes-header-actions button")]
      .find((button) => button.textContent?.includes("Refresh"))!.click());
    await settleReview(container!);
    expect(container!.textContent).toContain("3/3 reviewed");
  });

  it("discards pending review capture when Refresh replaces its observation", async () => {
    let observation = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const editorProps = props(async () => changeList(`local-${++observation}`));
    const readDiff = editorProps.diff;
    editorProps.diff = async (...args) => {
      if (args[1] === "local-1" && args[2] === "entry-1") await pending;
      return readDiff(...args);
    };
    await reopen(editorProps);
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Mark src/alpha.ts as reviewed"]')!.click());
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".changes-header-actions button")]
      .find((button) => button.textContent?.includes("Refresh"))!.click());
    await settleReview(container!);
    await act(async () => finish());
    expect(container!.textContent).toContain("0/3 reviewed");
    await reopen(editorProps);
    expect(container!.textContent).toContain("0/3 reviewed");
  });

  it("isolates marks by subject and connection profile", async () => {
    const editorProps = props(async () => changeList("local-1"));
    await reopen(editorProps);
    await clickReview(container!, '[aria-label="Mark src/alpha.ts as reviewed"]');
    for (const otherProps of [
      { ...editorProps, subject: { ...editorProps.subject, id: "task-2" } },
      { ...editorProps, subject: { ...editorProps.subject, kind: "project" as const } },
      { ...editorProps, connectionProfileId: "remote" },
    ]) {
      await reopen(otherProps);
      expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("0/3 reviewed");
    }
    await reopen(editorProps);
    expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");
  });

  it("keeps review controls usable when preference storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    await reopen(props(async () => changeList("local-1")));
    await clickReview(container!, '[aria-label="Mark src/alpha.ts as reviewed"]');
    expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");
  });

  it("moves checked files into Reviewed and supports mark-all and reset", async () => {
    ({ container, root } = await renderEditor(props(async () => changeList("local-1"))));
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("0/3 reviewed");

    await clickReview(container!, '[aria-label="Mark src/alpha.ts as reviewed"]');
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");
    expect(sectionText(container, "Reviewed")).not.toContain("alpha.ts");
    await clickReview(container!, ".changes-file-section-toggle");
    expect(sectionText(container, "Reviewed")).toContain("alpha.ts");
    expect(container.querySelector('[aria-label="Mark src/alpha.ts as unreviewed"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-change-entry-id="entry-2"]')?.getAttribute("aria-current")).toBe("true");

    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".changes-file-review-progress button")]
      .find((button) => button.textContent === "Mark all reviewed")!.click());
    await settleReview(container!);
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("3/3 reviewed");
    expect(sectionText(container, "Reviewed")).toContain("bravo.ts");
    expect(sectionText(container, "Reviewed")).toContain("notes.txt");

    await clickReview(container!, ".changes-file-review-progress button");
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("0/3 reviewed");
    expect(sectionText(container, "Reviewed")).toBeUndefined();
  });

  it("preserves unchanged reviewed files when Refresh creates a new observation", async () => {
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1"))
      .mockResolvedValue(changeList("local-2"));
    ({ container, root } = await renderEditor(props(list)));
    await clickReview(container!, '[aria-label="Mark src/alpha.ts as reviewed"]');
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");

    await act(async () => {
      [...container!.querySelectorAll<HTMLButtonElement>(".changes-header-actions button")]
        .find((button) => button.textContent?.includes("Refresh"))!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settleReview(container!);
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");
    await reopen(props(list));
    expect(container!.querySelector(".changes-file-review-progress")?.textContent).toContain("1/3 reviewed");
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
    await clickReview(container!, '[aria-label="Mark src/alpha.ts as reviewed"]');
    await clickReview(container!, '[data-change-entry-id="entry-3"]');

    expect(list).toHaveBeenCalledTimes(2);
    expect(editorProps.diff).toHaveBeenCalledWith("task-1", "local-2", "entry-4");
    expect(container.querySelector('[data-change-entry-id="entry-4"]')?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelector(".changes-file-review-progress")?.textContent).toContain("1/4 reviewed");
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
