// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBranchCommitPreImageResult } from "@termloop/contract/current";
import { ChangesOverlay, type ChangesOverlayProps } from "../src/renderer/ui/ChangesOverlay.js";

const original = "alphaLine\nbravoLine\ncharlieLine\ndeltaLine\nechoLine\n";
const patch = "diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -3 +3 @@\n-charlieLine\n+CHARLIE_CHANGED\n";

describe("Full file for branch changes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label)!;

  function render(commitPreImage: ChangesOverlayProps["commitPreImage"]) {
    const props: ChangesOverlayProps = {
      subject: { id: "task-1", title: "Task", kind: "task", hasWorktree: false, hasBranch: true },
      initialSource: { kind: "commits" },
      close: () => {},
      list: async () => { throw new Error("no worktree"); },
      diff: async () => { throw new Error("no worktree"); },
      preImage: async () => { throw new Error("no worktree"); },
      listCommits: async (taskId) => ({
        task_id: taskId, observation_id: "commits-1", branch_id: "primary", branch_name: "feature/task", branch_role: "primary",
        held_by_task_id: null, base_ref: "main", base_oid: null, base_evidence: null, truncated: false,
        commits: [{ commit_id: "commit-0", branch_id: "primary", branch_name: "feature/task", short_oid: "0123456789ab", subject: "change", subject_encoding: "utf8", authored_at_epoch_ms: 1_000 }],
      }),
      listCommitChanges: async (taskId, observationId, commitId) => ({
        task_id: taskId, observation_id: observationId, commit_id: commitId, state: "available", truncated: false,
        entries: [{ entry_id: "entry-0", display_path: "src/file.ts", original_display_path: null, path_encoding: "utf8", kind: "modified", render_state: "available" }],
      }),
      commitDiff: async (taskId, observationId, commitId, entryId) => ({ task_id: taskId, observation_id: observationId, commit_id: commitId, entry_id: entryId, state: "patch", patch }),
      commitPreImage,
      gitHostProjection: undefined,
      listPullRequestChanges: async () => { throw new Error("no pull request"); },
      pullRequestDiff: async () => { throw new Error("no pull request"); },
      agentSessions: [],
      sendReviewNotes: async () => undefined,
    };
    return act(async () => root.render(<ChangesOverlay {...props} />));
  }

  it("expands the whole-branch diff with the branch's old side", async () => {
    const commitPreImage = vi.fn(async (taskId: string, observationId: string, commitId: string, entryId: string): Promise<TaskBranchCommitPreImageResult> =>
      ({ task_id: taskId, observation_id: observationId, commit_id: commitId, entry_id: entryId, state: "content", content: original }));
    await render(commitPreImage);
    await settle();
    expect(container.textContent).toContain("CHARLIE_CHANGED");
    expect(container.textContent).not.toContain("alphaLine");
    expect(button("Full file").disabled).toBe(false);
    expect(commitPreImage).not.toHaveBeenCalled();

    await act(async () => button("Full file").click());
    await settle();
    expect(commitPreImage).toHaveBeenCalledWith("task-1", "commits-1", "all", "entry-0");
    expect(container.textContent).toContain("alphaLine");
    expect(container.textContent).toContain("echoLine");
  });

  it("states why a branch change keeps its change-focused view", async () => {
    await render(async (taskId, observationId, commitId, entryId) =>
      ({ task_id: taskId, observation_id: observationId, commit_id: commitId, entry_id: entryId, state: "truncated", content: null }));
    await settle();
    await act(async () => button("Full file").click());
    await settle();
    expect(container.querySelector(".changes-full-file-status")?.textContent).toMatch(/safety limit/);
    expect(container.textContent).not.toContain("alphaLine");
  });
});
