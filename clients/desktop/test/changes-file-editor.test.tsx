// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskWorktreeChangeEntryDto, TaskWorktreeChangeListResult, WorkspaceFileWriteResult } from "@termloop/contract/current";
import { FileEditor } from "../src/renderer/file-editor.js";
import type { LocalPreImageResult } from "../src/renderer/changes-local-recovery.js";
import { ChangesOverlay, type ChangesOverlayProps } from "../src/renderer/ui/ChangesOverlay.js";
import { editableChangePath } from "../src/renderer/ui/ChangesFileEditor.js";
import { fakeMonaco } from "./monaco-fixture.js";

const fake = vi.hoisted(() => ({ current: undefined as ReturnType<typeof import("./monaco-fixture.js").fakeMonaco> | undefined }));
vi.mock("../src/renderer/monaco-editor.js", () => ({ get monaco() { return fake.current!.monaco; } }));

function entry(entryId: string, displayPath: string, side: TaskWorktreeChangeEntryDto["side"], kind: TaskWorktreeChangeEntryDto["kind"] = "modified"): TaskWorktreeChangeEntryDto {
  return { entry_id: entryId, display_path: displayPath, original_display_path: null, path_encoding: "utf8", side, kind, render_state: "available" };
}

const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-x\n+y\n line 2\n";

const changeList = (observationId: string, entries: TaskWorktreeChangeEntryDto[]): TaskWorktreeChangeListResult =>
  ({ task_id: "task-1", observation_id: observationId, worktree_generation: 1, entries, truncated: false });

type PreImage = Pick<LocalPreImageResult, "state" | "content">;

describe("Editing local changes in their diff", () => {
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

  function Harness({ editor, list, preImage = { state: "content", content: "x\nline 2\n" } }: { editor: FileEditor; list: ChangesOverlayProps["list"]; preImage?: PreImage }) {
    const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
    return <ChangesOverlay
      subject={{ id: "task-1", title: "Task", kind: "task", hasWorktree: true, hasBranch: false }}
      initialSource={{ kind: "local" }}
      close={() => {}}
      list={list}
      diff={async (taskId, observationId, entryId) => ({ task_id: taskId, observation_id: observationId, entry_id: entryId, state: "patch", patch })}
      preImage={async (taskId, observationId, entryId) => ({ task_id: taskId, observation_id: observationId, entry_id: entryId, revision: "index", ...preImage })}
      listCommits={async () => { throw new Error("no branch"); }}
      listCommitChanges={async () => { throw new Error("no branch"); }}
      commitDiff={async () => { throw new Error("no branch"); }}
      commitPreImage={async () => { throw new Error("no branch"); }}
      gitHostProjection={undefined}
      listPullRequestChanges={async () => { throw new Error("no pull request"); }}
      pullRequestDiff={async () => { throw new Error("no pull request"); }}
      agentSessions={[]}
      sendReviewNotes={async () => undefined}
      editing={{ editor, snapshot, readOnly: false }}
    />;
  }
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); };
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label)!;

  it("edits an unstaged file in its diff and re-lists changes after each save", async () => {
    const editor = new FileEditor({ read, write: (path) => write(path) });
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1", [entry("a-1", "src/alpha.ts", "unstaged")]))
      .mockResolvedValueOnce(changeList("local-2", [entry("z-0", "src/zulu.ts", "unstaged"), entry("a-2", "src/alpha.ts", "unstaged")]));
    const createDiffEditor = vi.spyOn(fake.current!.monaco.editor, "createDiffEditor");
    await act(async () => root.render(<Harness editor={editor} list={list} />));
    await settle();

    const diff = fake.current!.state.diff!;
    expect(read).toHaveBeenCalledWith("src/alpha.ts");
    expect(container.querySelector(".changes-diff-scroll")).toBeNull();
    expect(container.querySelector(".changes-edit-toggle")).toBeNull();
    expect(diff.original.model?.value).toBe("x\nline 2\n");
    expect(diff.modified.model?.value).toBe("before");
    expect(diff.modified.readOnly).toBe(false);
    expect(diff.options).toMatchObject({ originalEditable: false, renderSideBySide: false, hideUnchangedRegions: { enabled: true } });

    await act(async () => { button("Split").click(); button("Full file").click(); });
    expect(diff.options).toMatchObject({ renderSideBySide: true, hideUnchangedRegions: { enabled: false } });

    await act(async () => fake.current!.typeInDiff("after"));
    await act(async () => fake.current!.saveDiff());
    await settle();
    expect(write).toHaveBeenCalledWith("src/alpha.ts");
    expect(list).toHaveBeenCalledTimes(2);
    // The edited file stays selected under its new entry ID, in the same diff view.
    expect(container.querySelector(".changes-file-heading strong")?.textContent).toBe("src/alpha.ts");
    expect(createDiffEditor).toHaveBeenCalledTimes(1);
    expect(diff.modified.model?.value).toBe("after");
  });

  it("compares an untracked file against an empty original", async () => {
    const editor = new FileEditor({ read, write: (path) => write(path) });
    const list = vi.fn<ChangesOverlayProps["list"]>(async () => changeList("local-1", [entry("n-1", "src/new.ts", "untracked", "untracked")]));
    await act(async () => root.render(<Harness editor={editor} list={list} preImage={{ state: "absent", content: null }} />));
    await settle();
    expect(fake.current!.state.diff?.original.model?.value).toBe("");
    expect(fake.current!.state.diff?.modified.model?.value).toBe("before");
  });

  it("keeps staged changes and refused pre-images in the read-only diff", async () => {
    const editor = new FileEditor({ read, write: (path) => write(path) });
    const staged = vi.fn<ChangesOverlayProps["list"]>(async () => changeList("local-1", [entry("s-1", "src/staged.ts", "staged")]));
    await act(async () => root.render(<Harness editor={editor} list={staged} />));
    await settle();
    expect(container.querySelector(".changes-diff-scroll")).not.toBeNull();
    expect(fake.current!.state.diff).toBeUndefined();
    expect(read).not.toHaveBeenCalled();

    const unstaged = vi.fn<ChangesOverlayProps["list"]>(async () => changeList("local-1", [entry("u-1", "src/big.ts", "unstaged")]));
    await act(async () => root.render(<Harness editor={editor} list={unstaged} preImage={{ state: "truncated", content: null }} />));
    await act(async () => button("Refresh").click());
    await settle();
    expect(container.querySelector(".changes-diff-scroll")).not.toBeNull();
    expect(fake.current!.state.diff).toBeUndefined();
    expect(container.querySelector(".changes-full-file-status")?.textContent).toMatch(/^Read-only here: The file exceeds the .*-byte safety limit\.$/);
  });

  it("comments on a diff line from the editor gutter and keeps the note across a save", async () => {
    const editor = new FileEditor({ read, write: (path) => write(path) });
    const list = vi.fn<ChangesOverlayProps["list"]>()
      .mockResolvedValueOnce(changeList("local-1", [entry("a-1", "src/alpha.ts", "unstaged")]))
      .mockResolvedValueOnce(changeList("local-2", [entry("a-2", "src/alpha.ts", "unstaged")]));
    await act(async () => root.render(<Harness editor={editor} list={list} />));
    await settle();
    const { modified } = fake.current!.state.diff!;

    await act(async () => modified.clickGutter(2));
    const zone = [...modified.zones.values()][0]!;
    expect(zone.afterLineNumber).toBe(2);
    const textarea = zone.domNode.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Rename this");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".changes-review-actions span")?.textContent).toBe("1 note");
    expect(modified.decorations.flat()).toContainEqual(expect.objectContaining({ range: expect.objectContaining({ startLineNumber: 2 }) }));

    await act(async () => fake.current!.typeInDiff("after"));
    await act(async () => fake.current!.saveDiff());
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect([...modified.zones.values()].map((candidate) => candidate.domNode.textContent)).toEqual([expect.stringContaining("Rename this")]);
    expect(container.querySelector(".changes-review-preview pre")?.textContent).toContain("src/alpha.ts:2 (new)");
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
