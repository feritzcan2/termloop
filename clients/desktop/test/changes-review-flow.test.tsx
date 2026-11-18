// @vitest-environment jsdom

import { act, createElement } from "react";
import { webcrypto } from "node:crypto";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskWorktreeChangeEntryDto } from "@termloop/contract/current";
import { ChangesOverlay, type ChangesOverlayProps } from "../src/renderer/ui/ChangesOverlay.js";
import { nextPendingEntry } from "../src/renderer/ui/ChangesReviewAids.js";

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
  entry("alpha", "services/Payments/src/Alpha.cs", "unstaged"),
  entry("bravo", "services/Payments/src/Bravo.cs", "unstaged"),
  entry("test", "services/Payments.Tests/AlphaTests.cs", "unstaged"),
];

const PATCHES: Record<string, string> = {
  alpha: "--- a/Alpha.cs\n+++ b/Alpha.cs\n@@ -1,3 +1,3 @@\n using A;\n-const value = 1;\n+const value = 2;\n end();\n",
  bravo: "--- a/Bravo.cs\n+++ b/Bravo.cs\n@@ -1,3 +1,3 @@\n using A;\n-\tindented();\n+    indented();\n end();\n",
  test: "--- a/AlphaTests.cs\n+++ b/AlphaTests.cs\n@@ -1 +1,2 @@\n keep();\n+added();\n",
};

function props(): ChangesOverlayProps {
  return {
    subject: { id: "task-1", title: "Review flow", kind: "task", hasWorktree: true, hasBranch: false },
    initialSource: { kind: "local" },
    close: () => {},
    list: async () => ({ task_id: "task-1", observation_id: "local-1", worktree_generation: 1, entries, truncated: false }),
    diff: async (subjectId, observationId, entryId) => ({ task_id: subjectId, observation_id: observationId, entry_id: entryId, state: "patch", patch: PATCHES[entryId]! }),
    preImage: async (subjectId, observationId, entryId) => ({ task_id: subjectId, observation_id: observationId, entry_id: entryId, state: "notShown", revision: "head", content: null }),
    listCommits: async (taskId) => ({ task_id: taskId, observation_id: "commits-1", branch_id: "primary", branch_name: "feature/task", branch_role: "primary", held_by_task_id: null, base_ref: "main", base_oid: null, base_evidence: null, commits: [], truncated: false }),
    listCommitChanges: async (taskId, observationId, commitId) => ({ task_id: taskId, observation_id: observationId, commit_id: commitId, state: "available", entries: [], truncated: false }),
    commitDiff: async (taskId, observationId, commitId, entryId) => ({ task_id: taskId, observation_id: observationId, commit_id: commitId, entry_id: entryId, state: "notShown", patch: null }),
    commitPreImage: async (taskId, observationId, commitId, entryId) => ({ task_id: taskId, observation_id: observationId, commit_id: commitId, entry_id: entryId, state: "notShown", content: null }),
    gitHostProjection: undefined,
    listPullRequestChanges: async (taskId, _generation, pullRequest) => ({ task_id: taskId, pull_request: pullRequest, state: "available", reason: null, observation_id: "pr-1", entries: [], truncated: false }),
    pullRequestDiff: async (taskId, observationId, entryId) => ({ task_id: taskId, observation_id: observationId, entry_id: entryId, state: "notShown", reason: null, patch: null }),
    agentSessions: [],
    sendReviewNotes: async () => undefined,
  };
}

async function settle(container: HTMLElement): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector<HTMLButtonElement>(".changes-file-review-progress button")?.disabled).toBe(false);
    expect(container.querySelector(".changes-diff-scroll")).not.toBeNull();
  });
}

const selectedEntry = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".changes-file-entry[aria-current='true']")?.dataset.changeEntryId;

async function press(container: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    container.querySelector(".changes-overlay")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle(container);
}

describe("Changes review flow", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  beforeEach(async () => {
    vi.stubGlobal("crypto", webcrypto);
    // jsdom has no CSS.escape; the overlay uses it to refocus the selected row.
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => { root!.render(createElement(ChangesOverlay, props())); });
    await settle(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("joins single-folder chains, tags test files and counts the opened file's changes", async () => {
    const folders = [...container!.querySelectorAll(".changes-folder-entry span")].map((node) => node.textContent);
    expect(folders).toEqual(["services", "Payments/src", "Payments.Tests"]);
    await press(container!, "j");
    await press(container!, "j");
    const testRow = container!.querySelector<HTMLElement>("[data-change-entry-id='test']")!;
    expect(testRow.querySelector(".changes-file-role")?.textContent).toBe("test");
    expect(testRow.querySelector("small")).toBeNull();
    expect(selectedEntry(container!)).toBe("test");
    expect(testRow.querySelector(".changes-file-meta")?.textContent).toBe("test+1−0");
    expect(container!.querySelector(".changes-file-heading-stats")?.textContent).toBe("+1−01 change");
  });

  it("shows every file's line counts without opening it", async () => {
    expect(selectedEntry(container!)).toBe("alpha");
    await vi.waitFor(() => {
      const counts = [...container!.querySelectorAll<HTMLElement>(".changes-file-entry")]
        .map((row) => [row.dataset.changeEntryId, row.querySelector(".changes-file-meta")?.textContent]);
      expect(counts).toEqual([["alpha", "+1−1"], ["bravo", "+1−1"], ["test", "test+1−0"]]);
    });
  });

  it("marks only the changed characters of a replaced line", () => {
    expect(selectedEntry(container!)).toBe("alpha");
    expect([...container!.querySelectorAll(".diff-code-edit")].map((node) => node.textContent)).toEqual(["1", "2"]);
  });

  it("marks the open file reviewed with R and opens the next file to review", async () => {
    expect(selectedEntry(container!)).toBe("alpha");
    await press(container!, "r");
    expect(selectedEntry(container!)).toBe("bravo");
    expect(container!.querySelector(".changes-file-review-progress strong")?.textContent).toBe("1/3");
    expect(container!.querySelector(".changes-review-meter")?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("hides whitespace-only changes with W", async () => {
    await press(container!, "j");
    expect(selectedEntry(container!)).toBe("bravo");
    expect(container!.querySelectorAll(".diff-code-insert").length).toBe(1);
    await press(container!, "w");
    expect(container!.querySelector(".changes-whitespace-toggle")?.getAttribute("aria-pressed")).toBe("true");
    expect(container!.querySelectorAll(".diff-code-insert, .diff-code-delete").length).toBe(0);
  });

  it("fills the window in focus mode and leaves it with Escape before closing", async () => {
    const overlay = () => container!.querySelector<HTMLElement>(".changes-overlay")!;
    expect(overlay().classList.contains("focus-mode")).toBe(false);
    await press(container!, "f");
    expect(overlay().classList.contains("focus-mode")).toBe(true);
    expect(container!.querySelector(".changes-focus-toggle")?.getAttribute("aria-pressed")).toBe("true");
    await press(container!, "Escape");
    expect(overlay().classList.contains("focus-mode")).toBe(false);
    await act(async () => container!.querySelector<HTMLButtonElement>(".changes-focus-toggle")!.click());
    expect(overlay().classList.contains("focus-mode")).toBe(true);
  });

  it("toggles the shortcut list with ?", async () => {
    await press(container!, "?");
    expect(container!.querySelector(".changes-shortcuts")?.textContent).toContain("Next change");
    await press(container!, "?");
    expect(container!.querySelector(".changes-shortcuts")).toBeNull();
  });
});

describe("next file to review", () => {
  const visible = ["a", "b", "c", "d"].map((entry_id) => ({ entry_id }));

  it("prefers the next pending file below, then the nearest above", () => {
    expect(nextPendingEntry(visible, "b", new Set(["c"]))).toBe("d");
    expect(nextPendingEntry(visible, "d", new Set(["c"]))).toBe("b");
    expect(nextPendingEntry(visible, "a", new Set(["b", "c", "d"]))).toBeUndefined();
  });
});
