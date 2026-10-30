// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskWorktreeChangeEntryDto, TaskWorktreeChangeListResult, WorkspaceFileWriteResult } from "@termloop/contract/current";
import { FileEditor } from "../src/renderer/file-editor.js";
import { ChangesOverlay, type ChangesOverlayProps } from "../src/renderer/ui/ChangesOverlay.js";
import { editableChangePath } from "../src/renderer/ui/ChangesFileEditor.js";
import { fakeMonaco } from "./monaco-fixture.js";

const fake = vi.hoisted(() => ({ current: undefined as ReturnType<typeof import("./monaco-fixture.js").fakeMonaco> | undefined }));
vi.mock("../src/renderer/monaco-editor.js", () => ({ get monaco() { return fake.current!.monaco; } }));

function entry(entryId: string, displayPath: string, side: TaskWorktreeChangeEntryDto["side"], kind: TaskWorktreeChangeEntryDto["kind"] = "modified"): TaskWorktreeChangeEntryDto {
  return { entry_id: entryId, display_path: displayPath, original_display_path: null, path_encoding: "utf8", side, kind, render_state: "available" };
}

/// A one-line change followed by unchanged context, `lines` new-side lines long.
const longPatch = (lines: number) => `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,${lines} +1,${lines} @@\n-x\n+y\n${Array.from({ length: lines - 1 }, (_, index) => ` line ${index + 2}\n`).join("")}`;

const changeList = (observationId: string, entries: TaskWorktreeChangeEntryDto[]): TaskWorktreeChangeListResult =>
  ({ task_id: "task-1", observation_id: observationId, worktree_generation: 1, entries, truncated: false });

describe("Editing files from the Changes review", () => {
  let container: HTMLDivElement;
  let root: Root;
  const read = vi.fn(async (path: string) => ({ path, state: "text" as const, content: "before", version: "1".repeat(64) }));
  const write = vi.fn(async (path: string): Promise<WorkspaceFileWriteResult> => ({ path, state: "written", version: "2".repeat(64) }));

  beforeEach(() => {
    fake.current = fakeMonaco();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function Harness({ editor, list, lines = 1 }: { editor: FileEditor; list: ChangesOverlayProps["list"]; lines?: number }) {
    const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
    return <ChangesOverlay
      subject={{ id: "task-1", title: "Task", kind: "task", hasWorktree: true, hasBranch: false }}
      initialSource={{ kind: "local" }}
      close={() => {}}
      list={list}
      diff={async (taskId, observationId, entryId) => ({ task_id: taskId, observation_id: observationId, entry_id: entryId, state: "patch", patch: longPatch(lines) })}
      preImage={async (taskId, observationId, entryId) => ({ task_id: taskId, observation_id: observationId, entry_id: entryId, state: "notShown", revision: "head", content: null })}
      listCommits={async () => { throw new Error("no branch"); }}
      listCommitChanges={async () => { throw new Error("no branch"); }}
      commitDiff={async () => { throw new Error("no branch"); }}
      gitHostProjection={undefined}
      listPullRequestChanges={async () => { throw new Error("no pull request"); }}
      pullRequestDiff={async () => { throw new Error("no pull request"); }}
      agentSessions={[]}
      sendReviewNotes={async () => undefined}
      editing={{ editor, snapshot, readOnly: false }}
    />;
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };
  const toggle = (label: "Diff" | "Edit") => [...container.querySelectorAll<HTMLButtonElement>(".changes-edit-toggle button")].find((button) => button.textContent === label);

  it("edits the selected working-tree file in place of its diff and re-lists changes on return", async () => {
    const editor = new FileEditor({ read, write: (path) => write(path) });
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1", [entry("a-1", "src/alpha.ts", "unstaged")]))
      .mockResolvedValueOnce(changeList("local-2", [entry("z-0", "src/zulu.ts", "unstaged"), entry("a-2", "src/alpha.ts", "unstaged")]));
    await act(async () => root.render(<Harness editor={editor} list={list} />));
    await settle();
    expect(container.querySelector(".changes-diff-scroll")).not.toBeNull();

    await act(async () => toggle("Edit")!.click());
    await settle();
    expect(read).toHaveBeenCalledWith("src/alpha.ts");
    expect(container.querySelector(".changes-diff .file-editor-body")).not.toBeNull();
    expect(container.querySelector(".changes-diff-scroll")).toBeNull();

    await act(async () => fake.current!.type("after"));
    await act(async () => fake.current!.save());
    expect(write).toHaveBeenCalledWith("src/alpha.ts");

    await act(async () => toggle("Diff")!.click());
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".changes-diff .file-editor-body")).toBeNull();
    expect(container.querySelector(".changes-file-heading strong")?.textContent).toBe("src/alpha.ts");
  });

  it("keeps the reader on the same line when switching between the diff and the editor", async () => {
    // jsdom has no layout: each new-side line is 20px tall below its scroll container.
    const scrollTops = new WeakMap<Element, number>();
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) { return scrollTops.get(this) ?? 0; });
    vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value: number) { scrollTops.set(this, value); });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const line = this.dataset.newLine;
      const scroll = this.closest<HTMLElement>(".changes-diff-scroll");
      const top = line ? Number(line) * 20 - (scroll?.scrollTop ?? 0) : 0;
      return { top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    const editor = new FileEditor({ read, write: (path) => write(path) });
    const list = vi.fn<ChangesOverlayProps["list"]>(async () => changeList("local-1", [entry("a-1", "src/alpha.ts", "unstaged")]));
    await act(async () => root.render(<Harness editor={editor} list={list} lines={30} />));
    await settle();
    const scroll = () => container.querySelector<HTMLElement>(".changes-diff-scroll")!;
    scroll().scrollTop = 200;

    await act(async () => toggle("Edit")!.click());
    await settle();
    expect(fake.current!.state.topLine).toBe(10);

    await act(async () => fake.current!.scrollTo(20));
    await act(async () => toggle("Diff")!.click());
    await settle();
    expect(scroll().scrollTop).toBe(400);
  });

  it("offers editing only for local changes with a working-tree file", () => {
    expect(editableChangePath(entry("1", "a.ts", "unstaged"))).toBe("a.ts");
    expect(editableChangePath(entry("2", "b.ts", "staged"))).toBe("b.ts");
    expect(editableChangePath(entry("3", "c.ts", "untracked", "untracked"))).toBe("c.ts");
    expect(editableChangePath(entry("4", "d.ts", "unstaged", "deleted"))).toBeUndefined();
    expect(editableChangePath({ ...entry("5", "e.ts", "unstaged"), path_encoding: "lossy" })).toBeUndefined();
    expect(editableChangePath(undefined)).toBeUndefined();
  });
});
